import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { CAPTURE_METHODS } from "@ao/core/src/governance/schema";
import { GovernanceSettings } from "./GovernanceSettings";
import { CAPTURE_LABEL, DEFAULTS } from "./governanceModel";

useMsw();

const PID = "0190f0f0-0000-7000-8000-000000000001";
const SHA = "a".repeat(64);
const YAML = `# Rules reviewed by the IRB office
encryption:
  atRest: optional
protocol:
  number: IRB-2026-114
`;

interface Captured {
  puts: Array<{ body: any; ifMatch: string | null }>;
}

function serve(opts: { yaml?: string; put?: (body: any) => Response | undefined; violations?: unknown[] } = {}): Captured {
  const cap: Captured = { puts: [] };
  server.use(
    http.get(url(`/projects/${PID}/governance`), () => HttpResponse.json({ yaml: opts.yaml ?? YAML, sha256: SHA, violations: opts.violations ?? [] })),
    http.put(url(`/projects/${PID}/governance`), async ({ request }) => {
      const body = await request.json();
      cap.puts.push({ body, ifMatch: request.headers.get("if-match") });
      return opts.put?.(body) ?? HttpResponse.json({ violations: [], loosened: [], sha256: "b".repeat(64) });
    }),
    http.get(url(`/projects/${PID}/protocol/documents`), () => HttpResponse.json({ documents: [] })),
    http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: null, due: [] })),
  );
  return cap;
}

const card = (name: string) => screen.getByRole("region", { name });

async function loaded() {
  await screen.findByRole("region", { name: "Encryption" });
}

describe("Governance settings", () => {
  it("refuses a governance.yaml over 64 KB without parsing it (R117 I7)", async () => {
    serve({ yaml: `# ${"x".repeat(70 * 1024)}\nencryption:\n  atRest: optional\n` });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/larger than 64 KB/);
  });

  it("refuses YAML that expands many aliases (R117 I7)", async () => {
    const bomb = `a: &a [x, x, x, x]\nb: &b [*a, *a, *a, *a]\nc: &c [*b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c]\n`;
    serve({ yaml: bomb });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be read/);
  });

  it("shows the Funder DMP section, and what HIPAA and GDPR require of vendors and cloud folders", async () => {
    serve({ yaml: "profiles: [hipaa, gdpr, dmp]\ndmp:\n  repository: Zenodo\n  formats: [csv, pdf]\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const dmp = card("Data management plan");
    expect((within(dmp).getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe("Zenodo");
    expect((within(dmp).getByRole("textbox", { name: "Formats" }) as HTMLInputElement).value).toBe("csv, pdf");
    expect(within(dmp).getAllByText(/Required by Funder DMP/).length).toBeGreaterThan(0);
    const proc = card("Processing location");
    expect(proc.textContent).toMatch(/HIPAA: every outside vendor needs a signed business associate agreement \(BAA\)/);
    expect(proc.textContent).toMatch(/GDPR: every outside vendor needs a data processing agreement \(DPA\)/);
    expect(card("Data residency").textContent).toMatch(/HIPAA: approved cloud-synced folders count only when at least one is listed/);
  });


  it("shows one card per control (9), each with its value", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    for (const name of [
      "Data residency",
      "Processing location",
      "Identifiability",
      "Consent and provenance",
      "Retention and destruction",
      "Audit log",
      "Encryption",
      "Sharing and export",
      "Protocol record",
    ]) {
      expect(card(name)).toBeTruthy();
    }
    expect((within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement).value).toBe("optional");
    expect((within(card("Protocol record")).getByRole("textbox", { name: "Protocol number" }) as HTMLInputElement).value).toBe("IRB-2026-114");
  });

  it("toggling HIPAA shows encryption forced to required with \"Required by HIPAA\"", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "HIPAA" }));
    const enc = card("Encryption");
    expect((within(enc).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement).value).toBe("required");
    expect(within(enc).getByText("Required by HIPAA")).toBeTruthy();
    expect(within(card("Audit log")).getByText(/Required by .*HIPAA/)).toBeTruthy();
  });

  it("setting encryption Optional under HIPAA asks for a reason, and the PUT carries the exception, the reason and the base version", async () => {
    const cap = serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "HIPAA" }));
    await user.selectOptions(within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }), "optional");
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    const save = within(dialog).getByRole("button", { name: "Record reason" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Laptop has full-disk encryption (IRB amendment 7)");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(save);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement).value).toBe("optional");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(cap.puts).toHaveLength(1));
    const { body } = cap.puts[0]!;
    expect(body.baseSha256).toBe(SHA);
    expect(body.reason).toMatch(/full-disk encryption/);
    const saved = parse(body.yaml);
    expect(saved.profiles).toEqual(["hipaa"]);
    expect(saved.encryption.atRest).toBe("optional");
    expect(saved.exceptions).toEqual([
      { control: "encryption.atRest", value: "optional", reason: "Laptop has full-disk encryption (IRB amendment 7)", by: "Dr Ana Souza", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) },
    ]);
    // Comments in the file are kept.
    expect(body.yaml).toContain("# Rules reviewed by the IRB office");
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("cancelling the reason leaves the stricter value", async () => {
    serve({ yaml: "profiles: [hipaa]\nencryption:\n  atRest: required\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.selectOptions(within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }), "off");
    await user.click(within(screen.getByRole("dialog", { name: "Record a reason" })).getByRole("button", { name: "Cancel" }));
    expect((within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement).value).toBe("required");
  });

  it("a 409 says the rules changed elsewhere, offers a reload, and keeps the edits", async () => {
    serve({ put: () => HttpResponse.json({ error: { code: "CONFLICT", message: "The rules changed since you opened them." } }, { status: 409 }) });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    const num = within(card("Protocol record")).getByRole("textbox", { name: "Protocol number" });
    await user.clear(num);
    await user.type(num, "IRB-2026-200");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed elsewhere — reload/);
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeTruthy();
    expect((within(card("Protocol record")).getByRole("textbox", { name: "Protocol number" }) as HTMLInputElement).value).toBe("IRB-2026-200");
  });

  it("shows violations from the save inline on their control's card", async () => {
    serve({ put: () => HttpResponse.json({ violations: [{ control: "sharing.locationMetadata", required: "strip", actual: "keep", profile: "hipaa" }], loosened: [], sha256: "c".repeat(64) }) });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.selectOptions(within(card("Sharing and export")).getByRole("combobox", { name: "Location metadata in shared copies" }), "strip");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await within(card("Sharing and export")).findByText(/HIPAA requires "strip"/)).toBeTruthy();
  });

  it("a refusal that needs a reason (raw edit) opens the reason dialog and saves with it", async () => {
    const cap = serve({
      put: (b) => (b.reason ? undefined : HttpResponse.json({ error: { code: "VALIDATION", message: "This change loosens the project's rules, so it needs a reason: audit.enabled is looser than before" } }, { status: 400 })),
    });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "View governance.yaml" }));
    const raw = screen.getByRole("textbox", { name: "governance.yaml" }) as HTMLTextAreaElement;
    expect(raw.value).toBe(YAML);
    fireEvent.change(raw, { target: { value: `${YAML}audit:\n  enabled: false\n` } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Record a reason" });
    expect(dialog.textContent).toMatch(/audit.enabled is looser than before/);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Pilot without participants");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Ana");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    await waitFor(() => expect(cap.puts).toHaveLength(2));
    expect(cap.puts[1]!.body.reason).toMatch(/Pilot without participants/);
    expect(cap.puts[1]!.body.yaml).toContain("enabled: false");
  });

  it("shows a result for each dropped protocol document, including the refused ones", async () => {
    serve();
    server.use(
      http.post(url(`/projects/${PID}/protocol/documents`), () =>
        HttpResponse.json({
          results: [
            { file: "letter.pdf", outcome: "added", document: { name: "letter.pdf", bytes: 10, encrypted: false } },
            { file: "tool.exe", outcome: "failed", reason: "Only a PDF, Word, OpenDocument, plain text or an image can be added as a protocol document." },
          ],
          documents: [{ name: "letter.pdf", bytes: 10, encrypted: false }],
        }),
      ),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const f = (n: string) => Object.assign(new File(["x"], n), { path: `/Users/ana/${n}` });
    fireEvent.drop(within(card("Protocol record")).getByText(/Drop approval documents here/), { dataTransfer: { files: [f("letter.pdf"), f("tool.exe")], types: ["Files"] } });
    const results = await within(card("Protocol record")).findByRole("list", { name: "Results of the last drop" });
    expect(results.textContent).toMatch(/letter\.pdf: added/);
    expect(results.textContent).toMatch(/tool\.exe: not added — Only a PDF/);
  });

  it("attaches protocol approval documents dropped on the protocol record", async () => {
    serve();
    let posted: any;
    server.use(
      http.post(url(`/projects/${PID}/protocol/documents`), async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({
          results: [{ file: "IRB approval letter.pdf", outcome: "added", document: { name: "IRB approval letter.pdf", bytes: 2048, encrypted: true } }],
          documents: [{ name: "IRB approval letter.pdf", bytes: 2048, encrypted: true }],
        });
      }),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const zone = within(card("Protocol record")).getByText(/Drop approval documents here/);
    const file = Object.assign(new File(["%PDF"], "IRB approval letter.pdf"), { path: "/Users/ana/IRB approval letter.pdf" });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    expect((await within(card("Protocol record")).findAllByText("IRB approval letter.pdf")).length).toBe(2);
    expect(posted).toEqual({ paths: ["/Users/ana/IRB approval letter.pdf"] });
    expect(within(card("Protocol record")).getByText(/encrypted/)).toBeTruthy();
  });

  it("retention: lists what is due; Destroy raw data needs the typed confirmation, then shows the certificate", async () => {
    serve();
    let destroyed: any;
    server.use(
      http.get(url(`/projects/${PID}/retention`), () =>
        HttpResponse.json({ destroyAfter: "2026-01-01", due: [{ sourceId: "s1", title: "Interview with the harbour master", assetIds: ["a1", "a2"] }] }),
      ),
      http.post(url(`/projects/${PID}/retention/destroy`), async ({ request }) => {
        destroyed = await request.json();
        return HttpResponse.json({
          certificateFile: "Projects/Field/retention/destruction-2026-11-11 0930.json",
          certificate: { kind: "destruction-certificate", at: "2026-11-11T09:30:00.000Z", actor: "ana", assets: [{ assetId: "a1" }, { assetId: "a2" }], backups: { status: "none", containing: [], deleted: [] }, notice: "Each file was overwritten with zeros and then deleted." },
        });
      }),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const ret = card("Retention and destruction");
    expect(await within(ret).findByText("Interview with the harbour master")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(ret).getByRole("button", { name: "Destroy raw data" }));
    const dialog = screen.getByRole("dialog", { name: "Destroy raw data" });
    const go = within(dialog).getByRole("button", { name: "Destroy permanently" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(within(dialog).getByRole("textbox", { name: /Type destroy to confirm/ }), "destro");
    expect(go.disabled).toBe(true);
    await user.type(within(dialog).getByRole("textbox", { name: /Type destroy to confirm/ }), "y");
    expect(go.disabled).toBe(false);
    await user.click(go);
    expect(destroyed).toEqual({ assetIds: ["a1", "a2"], confirm: true });
    const cert = await screen.findByRole("region", { name: "Destruction certificate" });
    expect(cert.textContent).toMatch(/2 files destroyed/);
    expect(cert.textContent).toMatch(/overwritten with zeros/);
    expect(cert.textContent).toMatch(/destruction-2026-11-11 0930\.json/);
  });

  it("the project's time zone (R93, R160): defaults explained, set once per click, refused in plain words tied to the field, cleared", async () => {
    serve();
    const sent: any[] = [];
    let release: (() => void) | undefined;
    let stored: string | null = null;
    server.use(
      http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: "2026-12-01", timeZone: stored, due: [] })),
      http.put(url(`/projects/${PID}/time-zone`), async ({ request }) => {
        const body = (await request.json()) as { timeZone: string | null };
        sent.push(body);
        if (body.timeZone === "Mars/Olympus") {
          return HttpResponse.json({ error: { code: "VALIDATION", message: "That is not a time zone name (for example Europe/Berlin or America/New_York)." } }, { status: 400 });
        }
        if (body.timeZone === "Asia/Tokyo") await new Promise<void>((r) => (release = r));
        stored = body.timeZone;
        return HttpResponse.json({ timeZone: stored });
      }),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const ret = card("Retention and destruction");
    const field = (await within(ret).findByRole("textbox", { name: "The project's time zone (protocol and retention dates)" })) as HTMLInputElement;
    expect(field.value).toBe("");
    // What applies when it is empty, and what a change does (R160 as amended, M5).
    expect(ret.textContent).toMatch(/Empty: protocol dates follow this computer's time zone, and the retention date is read in UTC/);
    expect(ret.textContent).toMatch(/Changing the time zone moves the moment the retention date takes effect, by up to a day/);
    expect(within(ret).getByRole("status").textContent).toMatch(/protocol dates in this computer's time zone, the retention date in UTC/);
    const user = userEvent.setup();
    const save = within(ret).getByRole("button", { name: "Save time zone" }) as HTMLButtonElement;

    await user.type(field, "Mars/Olympus");
    await user.click(save);
    const alert = await within(ret).findByRole("alert");
    expect(alert.textContent).toMatch(/not a time zone name/);
    // The error belongs to the field (M5).
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);

    await user.clear(field);
    await user.type(field, "Asia/Tokyo");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    // Two clicks in the same tick (before React re-renders the button disabled) send one request (M9).
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    release?.();
    await waitFor(() => expect(within(ret).getByRole("status").textContent).toMatch(/Saved/));
    expect(sent.filter((b) => b.timeZone === "Asia/Tokyo")).toHaveLength(1);
    expect(field.value).toBe("Asia/Tokyo");

    expect(within(ret).getByRole("status").textContent).toMatch(/Saved\. The project's dates are read in Asia\/Tokyo/);

    await user.clear(field);
    await user.click(save);
    await waitFor(() => expect(sent.at(-1)).toEqual({ timeZone: null }));
    await waitFor(() => expect(within(ret).getByRole("status").textContent).toMatch(/retention date in UTC/));
  });

  it("drops a time-zone answer that arrives after the project changed (M9)", async () => {
    const OTHER = "0190f0f0-0000-7000-8000-000000000002";
    serve();
    let release: (() => void) | undefined;
    server.use(
      http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: null, timeZone: null, due: [] })),
      http.put(url(`/projects/${PID}/time-zone`), async () => {
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json({ timeZone: "Asia/Tokyo" });
      }),
      http.get(url(`/projects/${OTHER}/governance`), () => HttpResponse.json({ yaml: YAML, sha256: SHA, violations: [] })),
      http.get(url(`/projects/${OTHER}/protocol/documents`), () => HttpResponse.json({ documents: [] })),
      http.get(url(`/projects/${OTHER}/retention`), () => HttpResponse.json({ destroyAfter: null, timeZone: "Europe/Oslo", due: [] })),
    );
    const api = makeApi();
    const { rerender } = render(<GovernanceSettings api={api} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    const name = "The project's time zone (protocol and retention dates)";
    await user.type(await within(card("Retention and destruction")).findByRole("textbox", { name }), "Asia/Tokyo");
    await user.click(within(card("Retention and destruction")).getByRole("button", { name: "Save time zone" }));
    await waitFor(() => expect(release).toBeDefined());
    rerender(<GovernanceSettings api={api} projectId={OTHER} />);
    await waitFor(() => expect((within(card("Retention and destruction")).getByRole("textbox", { name }) as HTMLInputElement).value).toBe("Europe/Oslo"));
    release!();
    await new Promise((r) => setTimeout(r, 50));
    expect((within(card("Retention and destruction")).getByRole("textbox", { name }) as HTMLInputElement).value).toBe("Europe/Oslo");
    expect(within(card("Retention and destruction")).getByRole("status").textContent).not.toMatch(/Saved|Tokyo/);
  });
});

describe("capture methods (D11)", () => {
  const methods = () => within(card("Capture methods"));
  const box = (name: RegExp | string) => methods().getByRole("checkbox", { name }) as HTMLInputElement;
  const NOTE = /What a capture from the web also needs/;

  it("lists every capture method the rules know, in plain words, ticked as the rules say (a new project: the imports, not the web)", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const boxes = methods().getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(CAPTURE_METHODS.length);
    for (const m of CAPTURE_METHODS) expect(box(CAPTURE_LABEL[m]).checked, m).toBe((DEFAULTS.captureMethods as string[]).includes(m));
    expect(box(CAPTURE_LABEL.browser_capture).checked).toBe(false);
    expect(box(CAPTURE_LABEL.downloader).checked).toBe(false);
    expect(box(CAPTURE_LABEL.zotero_import).checked).toBe(true);
    // Plain words, not the rules file's names.
    expect(card("Capture methods").textContent).not.toMatch(/browser_capture|manual_upload|zotero_import/);
    expect(CAPTURE_LABEL.browser_capture).toMatch(/browser extension/);
    expect(CAPTURE_LABEL.downloader).toMatch(/Capture screen/);
  });

  it("allowing browser capture and the downloader is one governed change: a reason, then one PUT with the methods, the reason and the base version", async () => {
    const cap = serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(box(CAPTURE_LABEL.browser_capture));
    let dialog = screen.getByRole("dialog", { name: "Record a reason" });
    expect(dialog.textContent).toMatch(/loosens the project's rules/);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Fieldwork on public pages");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    expect(box(CAPTURE_LABEL.browser_capture).checked).toBe(true);
    await user.click(box(CAPTURE_LABEL.downloader));
    dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Videos of public hearings");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    expect(cap.puts).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(cap.puts).toHaveLength(1);
    const put = cap.puts[0]!;
    expect(put.body.baseSha256).toBe(SHA);
    expect(put.body.reason).toBe("Fieldwork on public pages (Dr Ana Souza); Videos of public hearings (Dr Ana Souza)");
    const saved = parse(put.body.yaml);
    expect(saved.captureMethods).toEqual(CAPTURE_METHODS.filter((m) => [...DEFAULTS.captureMethods, "browser_capture", "downloader"].includes(m)));
    // The rest of the file, comments included, is kept.
    expect(put.body.yaml).toMatch(/^# Rules reviewed by the IRB office/);
    expect(saved.protocol.number).toBe("IRB-2026-114");
  });

  it("turning a method off is stricter: no reason asked", async () => {
    const cap = serve({ yaml: "captureMethods: [manual_upload, browser_capture]\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    expect(box(CAPTURE_LABEL.browser_capture).checked).toBe(true);
    await user.click(box(CAPTURE_LABEL.browser_capture));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(parse(cap.puts[0]!.body.yaml).captureMethods).toEqual(["manual_upload"]);
  });

  it("says, next to the web methods, what else a capture needs before it runs (R41): a legal basis, a protocol number", async () => {
    serve({ yaml: "protocol:\n  requireBeforeCapture: true\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const note = methods().getByRole("note", { name: NOTE });
    expect(note.textContent).toMatch(/legal basis/);
    expect(note.textContent).toMatch(/identifiable/);
    expect(note.textContent).toMatch(/protocol number/);
    for (const m of ["browser_capture", "downloader", "official_api"] as const) {
      expect(box(CAPTURE_LABEL[m]).getAttribute("aria-describedby")?.split(" ")).toContain(note.id);
    }
    expect(box(CAPTURE_LABEL.zotero_import).getAttribute("aria-describedby")).toBeNull();
  });

  it("with no identifiable data and no protocol required, the note says nothing else is needed", async () => {
    serve({ yaml: "identifiability:\n  containsIdentifiable: false\n  pseudonymizeFileNames: false\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const note = methods().getByRole("note", { name: NOTE });
    expect(note.textContent).toMatch(/Nothing else/);
    expect(note.textContent).not.toMatch(/legal basis/);
  });

  it("a default legal basis for captures from the web is set in the form (a governed loosening); the note then no longer asks for one", async () => {
    const cap = serve({ yaml: "captureMethods: [manual_upload, browser_capture]\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    const field = methods().getByRole("textbox", { name: /Default legal basis for captures from the web/ });
    await user.type(field, "Public task, GDPR Art. 6(1)(e)");
    expect(screen.queryByRole("dialog")).toBeNull(); // not one dialog per keystroke
    await user.tab();
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Approved by the DPO");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "R. Haddad");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    expect(methods().getByRole("note", { name: NOTE }).textContent).not.toMatch(/legal basis/);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(parse(cap.puts[0]!.body.yaml).consent.defaultLegalBasis).toEqual({ "social-media": "Public task, GDPR Art. 6(1)(e)" });
  });

  it("a locked or read-only project shows the methods but cannot change them, and says why", async () => {
    const cap = serve({ yaml: "captureMethods: [manual_upload, browser_capture]\n" });
    const why = "This project is locked. Unlock it in the library to change its rules.";
    render(<GovernanceSettings api={makeApi()} projectId={PID} readOnlyReason={why} />);
    await loaded();
    expect(box(CAPTURE_LABEL.browser_capture).checked).toBe(true);
    for (const b of methods().getAllByRole("checkbox") as HTMLInputElement[]) expect(b.disabled).toBe(true);
    expect((methods().getByRole("textbox", { name: /Default legal basis/ }) as HTMLInputElement).disabled).toBe(true);
    const reason = screen.getByText(why);
    const group = methods().getByRole("group", { name: /from the web/ });
    expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(reason.id);
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    // The other controls are read-only too.
    expect((within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement).disabled).toBe(true);
    expect(cap.puts).toHaveLength(0);
  });
});

describe("a locked project or a read-only library: nothing on the screen offers a change (Task 64 review M1)", () => {
  const REASONS = ["This project is locked. Unlock it in the library to change its rules.", "This library is open read-only here, so its rules cannot be changed."];
  it.each(REASONS)("“%s”: approval documents, time zone and destruction are off, the reason is shown once, and no request is sent", async (why) => {
    const sent: string[] = [];
    serve();
    server.use(
      http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: "2026-01-01", timeZone: "Europe/Oslo", due: [{ sourceId: "s1", title: "Interview", assetIds: ["a1"] }] })),
      http.post(url(`/projects/${PID}/protocol/documents`), () => {
        sent.push("documents");
        return HttpResponse.json({ results: [], documents: [] });
      }),
      http.put(url(`/projects/${PID}/time-zone`), () => {
        sent.push("time-zone");
        return HttpResponse.json({ timeZone: null });
      }),
      http.post(url(`/projects/${PID}/retention/destroy`), () => {
        sent.push("destroy");
        return HttpResponse.json({});
      }),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} readOnlyReason={why} />);
    await loaded();
    expect(screen.getAllByText(why)).toHaveLength(1);
    const reasonId = screen.getByText(why).id;
    const protocol = card("Protocol record");
    expect((within(protocol).getByRole("textbox", { name: "Or add a document by its full path" }) as HTMLInputElement).disabled).toBe(true);
    expect((within(protocol).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    const ret = card("Retention and destruction");
    const tz = (await within(ret).findByRole("textbox", { name: /time zone/ })) as HTMLInputElement;
    expect(tz.value).toBe("Europe/Oslo");
    expect(tz.disabled).toBe(true);
    const saveZone = within(ret).getByRole("button", { name: "Save time zone" }) as HTMLButtonElement;
    expect(saveZone.disabled).toBe(true);
    expect(saveZone.getAttribute("aria-describedby")?.split(" ")).toContain(reasonId);
    // What is due is still listed, but cannot be destroyed.
    expect(within(ret).getByText("Interview")).toBeTruthy();
    const destroy = within(ret).getByRole("button", { name: "Destroy raw data" }) as HTMLButtonElement;
    expect(destroy.disabled).toBe(true);
    expect(destroy.getAttribute("aria-describedby")?.split(" ")).toContain(reasonId);
    fireEvent.click(saveZone);
    fireEvent.click(destroy);
    expect(screen.queryByRole("dialog")).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
  });
});

describe("Save changes: one request per action (Task 64 review M10)", () => {
  /** A stricter change (no reason asked), and a PUT that waits until released; later PUTs answer 409. */
  async function ready() {
    let release!: () => void;
    const cap: Captured = { puts: [] };
    serve();
    server.use(
      http.put(url(`/projects/${PID}/governance`), async ({ request }) => {
        cap.puts.push({ body: await request.json(), ifMatch: null });
        if (cap.puts.length > 1) return HttpResponse.json({ error: { code: "CONFLICT", message: "changed" } }, { status: 409 });
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json({ violations: [], loosened: [], sha256: "b".repeat(64) });
      }),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(within(card("Protocol record")).getByRole("checkbox", { name: "A protocol record is required before capture" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    return { cap, user, release: () => release(), save: screen.getByRole("button", { name: "Save changes" }) };
  }

  it("two clicks send one PUT, and Saved. stays", async () => {
    const { cap, save, release } = await ready();
    // Both clicks before React renders again (as a fast double click can land).
    act(() => {
      save.click();
      save.click();
    });
    await waitFor(() => expect(cap.puts).toHaveLength(1));
    release();
    expect(await screen.findByText("Saved.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(cap.puts).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Enter held on the focused button sends one PUT", async () => {
    const { cap, save, user, release } = await ready();
    save.focus();
    // Key repeats can land before the button is re-rendered as busy: two in one go, then held.
    act(() => {
      save.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      save.click();
      save.click();
    });
    await user.keyboard("{Enter>5/}");
    await waitFor(() => expect(cap.puts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(cap.puts).toHaveLength(1);
    release();
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });
});

describe("capture methods, smaller points (Task 64 review)", () => {
  it("a default legal basis whose reason is cancelled goes back to the saved value (M2)", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.type(within(card("Capture methods")).getByRole("textbox", { name: /Default legal basis/ }), "Public task");
    await user.tab();
    await user.click(within(screen.getByRole("dialog", { name: "Record a reason" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect((within(card("Capture methods")).getByRole("textbox", { name: /Default legal basis/ }) as HTMLInputElement).value).toBe(""));
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the reason dialog shows the typed legal basis as the person's own text, with its own direction (M7)", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.type(within(card("Capture methods")).getByRole("textbox", { name: /Default legal basis/ }), "مهمة عامة");
    await user.tab();
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    expect(within(dialog).getByText("مهمة عامة").getAttribute("dir")).toBe("auto");
  });

  it("the note names the protocol's platform scope when it has one (M6)", async () => {
    serve({ yaml: "identifiability:\n  containsIdentifiable: false\n  pseudonymizeFileNames: false\nprotocol:\n  platforms: [youtube]\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const note = within(card("Capture methods")).getByRole("note", { name: /What a capture from the web also needs/ });
    expect(note.textContent).toMatch(/platforms the protocol approves/);
    expect(note.textContent).not.toMatch(/Nothing else/);
  });
});
