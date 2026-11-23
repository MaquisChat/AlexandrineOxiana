import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { CAPTURE_METHODS } from "@ao/core/governance/schema";
import { GovernanceSettings } from "./GovernanceSettings";
import { CAPTURE_LABEL, DEFAULTS } from "./governanceModel";
import { ACQUIRE_LABEL } from "./governanceModel";

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

  it("FR-156: a profile toggled at once after a raw edit works from the text as typed, not from the rules parsed before it", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "View governance.yaml" }));
    const raw = screen.getByRole("textbox", { name: "governance.yaml" }) as HTMLTextAreaElement;
    // Typed in the editor, then HIPAA ticked before the editor's text is parsed again (300 ms).
    fireEvent.change(raw, { target: { value: `profiles: [gdpr]\n${YAML}` } });
    fireEvent.click(screen.getByRole("checkbox", { name: "HIPAA" }));
    const now = parse(raw.value);
    expect(now.profiles).toEqual(["gdpr", "hipaa"]);
    expect(now.encryption.atRest).toBe("required");
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

  describe("an exception's reason and approver are kept in the rules file, which an encrypted project does not seal (R369 a)", () => {
    const NOTE = "In an encrypted project this reason and the approver's name are kept in the project's rules file, which can be read without the passphrase. Do not put a participant's name in them.";
    const exceptionDialog = async (encrypted: boolean | undefined) => {
      serve();
      render(<GovernanceSettings api={makeApi()} projectId={PID} {...(encrypted === undefined ? {} : { encrypted })} />);
      await loaded();
      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: "HIPAA" }));
      await user.selectOptions(within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }), "optional");
      return screen.getByRole("dialog", { name: "Record a reason" });
    };

    it("encrypted: the dialog for an exception says so, tied to its reason and approver fields", async () => {
      const dialog = await exceptionDialog(true);
      const note = within(dialog).getByText(NOTE);
      expect(note.textContent).toBe(NOTE);
      expect(note.id).not.toBe("");
      for (const name of ["Reason", "Approved by"]) expect(within(dialog).getByRole("textbox", { name }).getAttribute("aria-describedby")?.split(" ")).toContain(note.id);
    });

    it.each([
      ["not encrypted", false],
      ["encryption not known", undefined],
    ])("%s: nothing is said", async (_what, encrypted) => {
      const dialog = await exceptionDialog(encrypted);
      expect(within(dialog).queryByText(NOTE)).toBeNull();
      expect(dialog.textContent).not.toMatch(/passphrase/);
      for (const name of ["Reason", "Approved by"]) expect(within(dialog).getByRole("textbox", { name }).getAttribute("aria-describedby")).toBeNull();
    });

    it("encrypted: a loosening that is not an exception writes no reason into the rules file, so the note is not shown", async () => {
      serve();
      render(<GovernanceSettings api={makeApi()} projectId={PID} encrypted />);
      await loaded();
      const user = userEvent.setup();
      await user.click(within(card("Capture methods")).getByRole("checkbox", { name: CAPTURE_LABEL.browser_capture }));
      const dialog = screen.getByRole("dialog", { name: "Record a reason" });
      expect(dialog.textContent).toMatch(/loosens the project's rules/);
      expect(within(dialog).queryByText(NOTE)).toBeNull();
    });
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

describe("How Find and acquire may get works (Find and acquire Task F13; R301, R302 b; plan Amendment A3)", () => {
  const FIND = "How Find and acquire may get works";
  const ELICIT = "Elicit (a commercial service; it receives the words you type and nothing about this project)";
  const findCard = () => within(card(FIND));
  const way = (label: string) => findCard().getByRole("checkbox", { name: label }) as HTMLInputElement;
  const lookups = () => within(card("Processing location")).getByRole("textbox", { name: "Metadata lookups" }) as HTMLInputElement;
  const reason = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), text);
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
  };

  it("the three ways, ticked by default, and the one line R301 fixed for good", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    for (const m of ["reference_lookup", "free_copy", "library_access"] as const) expect(way(ACQUIRE_LABEL[m]).checked, m).toBe(true);
    expect(card(FIND).textContent).toContain("A file found for a record is never added without your confirmation.");
    expect(way(ELICIT).checked).toBe(false);
    expect(card(FIND).textContent).not.toMatch(/free_copy|reference_lookup|library_access/);
  });

  it("unticking free copies writes acquireMethods without free_copy, with no reason asked", async () => {
    const cap = serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(way(ACQUIRE_LABEL.free_copy));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(way(ACQUIRE_LABEL.free_copy).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const saved = parse(cap.puts[0]!.body.yaml);
    expect(saved.acquireMethods).toEqual(["reference_lookup", "library_access"]);
    expect(cap.puts[0]!.body.reason).toBeUndefined();
    expect(cap.puts[0]!.body.yaml).toMatch(/^# Rules reviewed by the IRB office/);
  });

  it("ticking it asks for a reason, as the other loosenings do, and the PUT carries it", async () => {
    const cap = serve({ yaml: "acquireMethods: [reference_lookup, library_access]\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    expect(way(ACQUIRE_LABEL.free_copy).checked).toBe(false);
    await user.click(way(ACQUIRE_LABEL.free_copy));
    expect(screen.getByRole("dialog", { name: "Record a reason" }).textContent).toMatch(/loosens the project's rules/);
    await reason(user, "Open-access copies are fine here");
    expect(way(ACQUIRE_LABEL.free_copy).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(parse(cap.puts[0]!.body.yaml).acquireMethods).toEqual(["reference_lookup", "free_copy", "library_access"]);
    expect(cap.puts[0]!.body.reason).toBe("Open-access copies are fine here (Dr Ana Souza)");
  });

  it("the Elicit box and the vendors field agree both ways; ticking asks for a reason and declares the vendor", async () => {
    const cap = serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    // Tick the box: the field shows it.
    await user.click(way(ELICIT));
    await reason(user, "Elicit is in the protocol");
    expect(way(ELICIT).checked).toBe(true);
    expect(lookups().value).toBe("crossref, openalex, openlibrary, loc, elicit");
    // Edit the field: the box follows.
    await user.clear(lookups());
    await user.type(lookups(), "crossref, openalex");
    await user.tab();
    expect(way(ELICIT).checked).toBe(false);
    await user.clear(lookups());
    await user.type(lookups(), "crossref, elicit");
    await user.tab();
    // Through the field it is the same loosening, with the same reason asked.
    await reason(user, "Elicit is in the protocol");
    expect(way(ELICIT).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const saved = parse(cap.puts[0]!.body.yaml);
    expect(saved.processing.metadata_lookup).toEqual(["crossref", "elicit"]);
    expect(saved.vendors).toEqual([{ id: "elicit" }]);
  });

  it("unticking Elicit removes it from metadata lookups and nothing else; the vendors stay byte for byte; no reason asked", async () => {
    const vendors = "vendors:\n  - id: deepl # translation, DPA signed 2026-03\n    dpa: true\n  - id: elicit\n    dpa: true\n";
    const yaml = `${YAML}processing:\n  metadata_lookup: [crossref, elicit, openalex]\n  translation: [deepl]\n${vendors}`;
    const cap = serve({ yaml });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    expect(way(ELICIT).checked).toBe(true);
    await user.click(way(ELICIT));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lookups().value).toBe("crossref, openalex");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const text: string = cap.puts[0]!.body.yaml;
    expect(parse(text).processing).toEqual({ metadata_lookup: ["crossref", "openalex"], translation: ["deepl"] });
    expect(text).toContain(vendors);
  });

  it("ticking Elicit where a vendor of that name is already declared keeps its declaration as it is", async () => {
    const vendors = "vendors:\n  - id: elicit # DPA signed\n    dpa: true\n";
    const cap = serve({ yaml: `${YAML}${vendors}` });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(way(ELICIT));
    await reason(user, "Approved");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const text: string = cap.puts[0]!.body.yaml;
    expect(text).toContain(vendors);
    expect(parse(text).vendors).toEqual([{ id: "elicit", dpa: true }]);
    expect(parse(text).processing.metadata_lookup).toEqual(["crossref", "openalex", "openlibrary", "loc", "elicit"]);
  });

  it("the reference-lookup legal basis is there: set in the form (a governed loosening) and written under its category", async () => {
    const cap = serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    const field = findCard().getByRole("textbox", { name: /Default legal basis for records made from typed references/ });
    const hint = document.getElementById(field.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/For records made from references you type into Find and acquire/);
    await user.type(field, "Legitimate interest, GDPR Art. 6(1)(f)");
    await user.tab();
    await reason(user, "Bibliographic records only");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(parse(cap.puts[0]!.body.yaml).consent.defaultLegalBasis).toEqual({ "reference-lookup": "Legitimate interest, GDPR Art. 6(1)(f)" });
  });

  it("a locked project shows the boxes but cannot change them", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} readOnlyReason="This project is locked. Unlock it in the library to change its rules." />);
    await loaded();
    for (const b of findCard().getAllByRole("checkbox") as HTMLInputElement[]) expect(b.disabled).toBe(true);
    expect((findCard().getByRole("textbox", { name: /Default legal basis/ }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe("The Elicit box says what the rules in force say (R314 a, e, f)", () => {
  const FIND = "How Find and acquire may get works";
  const ELICIT = "Elicit (a commercial service; it receives the words you type and nothing about this project)";
  const findCard = () => within(card(FIND));
  const elicitBox = () => findCard().getByRole("checkbox", { name: ELICIT }) as HTMLInputElement;
  const described = (el: HTMLElement) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" | ");
  const DEFAULT_LOOKUPS = ["crossref", "openalex", "openlibrary", "loc"];
  /** The service's own violation for a vendor dropped by a profile (core merge.ts), as GET /governance gives it. */
  const dropped = (profile: "gdpr" | "hipaa") => ({ control: "processing.metadata_lookup", required: DEFAULT_LOOKUPS, actual: [...DEFAULT_LOOKUPS, "elicit"], profile });
  const file = (profile: string, agreement: string) =>
    `profiles: [${profile}]\nprocessing:\n  metadata_lookup: [crossref, openalex, openlibrary, loc, elicit]\nvendors:\n  - id: elicit\n${agreement}`;
  const NOT_ALLOWED = /Named, but NOT allowed:/;
  const ALLOWED = "Allowed by this project's rules.";

  it("GDPR, Elicit named without dpa: ticked, Named, but NOT allowed, with the reason, tied to the box; the violation is on this card too", async () => {
    serve({ yaml: file("gdpr", ""), violations: [dropped("gdpr")] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(elicitBox().checked).toBe(true);
    const said = described(elicitBox());
    expect(said).toMatch(NOT_ALLOWED);
    expect(said).toContain("Named, but NOT allowed: under GDPR, a data processing agreement must be recorded for Elicit under vendors (dpa: true).");
    expect(said).not.toContain(ALLOWED);
    expect(card(FIND).textContent).toMatch(/processing\.metadata_lookup: GDPR requires/);
  });

  it("GDPR with dpa: true: Allowed by this project's rules.", async () => {
    serve({ yaml: file("gdpr", "    dpa: true\n"), violations: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain(ALLOWED);
    expect(described(elicitBox())).not.toMatch(NOT_ALLOWED);
  });

  it("HIPAA without baa: not allowed, with its reason; with baa: true: allowed", async () => {
    serve({ yaml: file("hipaa", ""), violations: [dropped("hipaa")] });
    const view = render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain("Named, but NOT allowed: under HIPAA, a business associate agreement must be recorded for Elicit under vendors (baa: true).");
    view.unmount();
    serve({ yaml: file("hipaa", "    baa: true\n"), violations: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain(ALLOWED);
  });

  it("no profile: allowed; unticked: neither sentence", async () => {
    serve({ yaml: file("", ""), violations: [] });
    const view = render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain(ALLOWED);
    view.unmount();
    serve({ violations: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(elicitBox().checked).toBe(false);
    expect(card(FIND).textContent).not.toContain(ALLOWED);
    expect(card(FIND).textContent).not.toMatch(NOT_ALLOWED);
  });

  it("R314 e: ticking then unticking in one draft removes the vendor entry the draft added; one the saved file had stays byte for byte", async () => {
    const cap = serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(elicitBox());
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Trying");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    await user.click(elicitBox());
    await user.click(within(card("Protocol record")).getByRole("checkbox", { name: "A protocol record is required before capture" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const saved = parse(cap.puts[0]!.body.yaml);
    expect(saved.vendors).toBeUndefined();
    expect(saved.processing.metadata_lookup).not.toContain("elicit");
  });

  it("R316 a: a violation with no profile, or one the screen has no words for, says only that the rules in force do not allow it; the GDPR and HIPAA reasons are as built", async () => {
    const bare = { control: "processing.metadata_lookup", required: DEFAULT_LOOKUPS, actual: [...DEFAULT_LOOKUPS, "elicit"] };
    serve({ yaml: file("", ""), violations: [bare] });
    const view = render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain("Named, but NOT allowed by the rules in force.");
    expect(described(elicitBox())).not.toMatch(/undefined|profile/);
    expect(described(elicitBox())).not.toContain(ALLOWED);
    view.unmount();
    serve({ yaml: file("", ""), violations: [{ ...bare, profile: "ferpa" }] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain("Named, but NOT allowed by the rules in force.");
    expect(described(elicitBox())).not.toMatch(/ferpa|profile does not allow/);
  });

  it("R316 b: ticked while the project may not look references up: says Elicit is not asked, tied to the box; with looking up allowed: Allowed", async () => {
    const NOT_ASKED = "Named, but Find and acquire may not look references up in this project, so Elicit is not asked.";
    serve({ yaml: `acquireMethods: [free_copy, library_access]\nprocessing:\n  metadata_lookup: [crossref, elicit]\nvendors:\n  - id: elicit\n`, violations: [] });
    const view = render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(elicitBox().checked).toBe(true);
    expect(described(elicitBox())).toContain(NOT_ASKED);
    expect(described(elicitBox())).not.toContain(ALLOWED);
    view.unmount();
    serve({ yaml: `acquireMethods: [reference_lookup]\nprocessing:\n  metadata_lookup: [crossref, elicit]\nvendors:\n  - id: elicit\n`, violations: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain(ALLOWED);
    expect(described(elicitBox())).not.toContain(NOT_ASKED);
  });

  it("R316 b: a violation still comes first when lookups are not allowed either", async () => {
    serve({ yaml: `profiles: [gdpr]\nacquireMethods: [free_copy]\nprocessing:\n  metadata_lookup: [crossref, openalex, openlibrary, loc, elicit]\nvendors:\n  - id: elicit\n`, violations: [dropped("gdpr")] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(described(elicitBox())).toContain("Named, but NOT allowed: under GDPR");
    expect(described(elicitBox())).not.toContain(ALLOWED);
  });

  it("R316 b: ticked but not yet saved, the sentence says it will be said once the changes are saved", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(elicitBox());
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Trying");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    expect(elicitBox().checked).toBe(true);
    expect(described(elicitBox())).toContain("What this project's rules allow for Elicit is said here once the changes are saved.");
    expect(described(elicitBox())).not.toContain(ALLOWED);
  });

  it("R316 c: an entry the researcher typed for Elicit in the same draft (an agreement, a comment) stays when the box is unticked; nothing typed: nothing left of the box's entry", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(elicitBox());
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Trying");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    await user.click(screen.getByRole("button", { name: "View governance.yaml" }));
    const raw = screen.getByRole("textbox", { name: "governance.yaml" }) as HTMLTextAreaElement;
    expect(raw.value).toContain("- id: elicit\n");
    fireEvent.change(raw, { target: { value: raw.value.replace("- id: elicit\n", "- id: elicit # DPA signed 2026-10\n    dpa: true\n") } });
    await user.click(elicitBox());
    expect(elicitBox().checked).toBe(false);
    const text = (screen.getByRole("textbox", { name: "governance.yaml" }) as HTMLTextAreaElement).value;
    expect(text).toContain("vendors:");
    expect(text).toContain("- id: elicit # DPA signed 2026-10\n    dpa: true\n");
    expect(parse(text).vendors).toEqual([{ id: "elicit", dpa: true }]);
    expect(parse(text).processing.metadata_lookup).not.toContain("elicit");
  });

  it("R316 c: a comment alone on the box's entry also keeps it", async () => {
    serve();
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(elicitBox());
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Trying");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    await user.click(screen.getByRole("button", { name: "View governance.yaml" }));
    const raw = screen.getByRole("textbox", { name: "governance.yaml" }) as HTMLTextAreaElement;
    fireEvent.change(raw, { target: { value: raw.value.replace("- id: elicit\n", "- id: elicit # to be agreed\n") } });
    await user.click(elicitBox());
    const text = (screen.getByRole("textbox", { name: "governance.yaml" }) as HTMLTextAreaElement).value;
    expect(text).toContain("# to be agreed");
    expect(parse(text).vendors).toEqual([{ id: "elicit" }]);
  });

  it("R314 f: ways the rules file names that this version does not know are kept as written when a box is ticked or unticked", async () => {
    const cap = serve({ yaml: "acquireMethods: [reference_lookup, a_later_way]\n" });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const user = userEvent.setup();
    await user.click(findCard().getByRole("checkbox", { name: ACQUIRE_LABEL.reference_lookup }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(findCard().getByRole("checkbox", { name: ACQUIRE_LABEL.library_access }));
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Library access agreed");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Dr Ana Souza");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(parse(cap.puts[0]!.body.yaml).acquireMethods).toEqual(["library_access", "a_later_way"]);
  });
});

describe("rules the engine cannot read are said (R379 FR-A18, R58)", () => {
  const PROBE = "encryption: {atRest: optional}\nresidencey: {allowed: [local]}\n";
  const FIXED = "encryption: {atRest: optional}\nresidency: {allowed: [device]}\n";
  const ALERT = "The app cannot read this project's rules. Until they are corrected it refuses every capture, import, change and export in this project.";

  function serveRead(get: Record<string, unknown>, put?: Record<string, unknown>) {
    const puts: any[] = [];
    server.use(
      http.get(url(`/projects/${PID}/governance`), () => HttpResponse.json({ sha256: SHA, violations: [], ...get })),
      http.put(url(`/projects/${PID}/governance`), async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json({ violations: [], loosened: [], sha256: "b".repeat(64), readable: true, issues: [], warnings: [], ...put });
      }),
      http.get(url(`/projects/${PID}/protocol/documents`), () => HttpResponse.json({ documents: [] })),
      http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    return puts;
  }

  it("readable false: the alert and the issues; the cards still render; a corrected text saves and the alert goes; focus is not moved", async () => {
    const puts = serveRead({ yaml: PROBE, readable: false, issues: ["residencey: unknown key (check spelling) in governance.yaml"], warnings: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const alert = screen.getAllByRole("alert").find((a) => a.textContent?.includes(ALERT))!;
    expect(alert).toBeTruthy();
    expect(alert.className).toContain("ao-warning");
    expect(within(alert).getByRole("listitem").textContent).toBe("residencey: unknown key (check spelling) in governance.yaml");
    expect(document.activeElement).toBe(document.body);
    // The cards still show what the file says, so it can be corrected.
    expect((within(card("Encryption")).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement).value).toBe("optional");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "View governance.yaml" }));
    fireEvent.change(screen.getByRole("textbox", { name: "governance.yaml" }), { target: { value: FIXED } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(puts[0].yaml).toBe(FIXED);
    expect(screen.queryByText(ALERT)).toBeNull();
    expect(screen.queryByText(/residencey: unknown key/)).toBeNull();
  });

  it("readable with warnings: a note (not an alert) and the list; gone after a save that has none", async () => {
    const w = 'consent.defaultLegalBasis.manual_upload: ignored, "manual-upload" is set (the old spelling of the same category)';
    serveRead({ yaml: YAML, readable: true, issues: [], warnings: [w] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const lead = screen.getByText("The rules were read, with these notes:");
    const note = lead.closest("div")!;
    expect(note.getAttribute("role")).not.toBe("alert");
    expect(within(note).getByRole("listitem").textContent).toBe(w);
    expect(screen.queryByText(ALERT)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "View governance.yaml" }));
    fireEvent.change(screen.getByRole("textbox", { name: "governance.yaml" }), { target: { value: `${YAML}audit:\n  enabled: true\n` } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(screen.queryByText("The rules were read, with these notes:")).toBeNull();
  });

  it("R397 a: a missing file: the alert with its issue; a save asks for a reason and an approver, then puts the rules back", async () => {
    const MISSING = "The rules file (governance.yaml) is missing from this project's folder.";
    const puts: any[] = [];
    server.use(
      http.get(url(`/projects/${PID}/governance`), () => HttpResponse.json({ yaml: "", sha256: SHA, violations: [], readable: false, issues: [MISSING], warnings: [] })),
      http.put(url(`/projects/${PID}/governance`), async ({ request }) => {
        const b = (await request.json()) as { reason?: string };
        puts.push(b);
        if (!b.reason) return HttpResponse.json({ error: { code: "VALIDATION", message: "The project's rules file is missing, so putting rules back needs a reason: audit.enabled is looser than the strictest rules" } }, { status: 400 });
        return HttpResponse.json({ violations: [], loosened: [], sha256: "b".repeat(64), readable: true, issues: [], warnings: [] });
      }),
      http.get(url(`/projects/${PID}/protocol/documents`), () => HttpResponse.json({ documents: [] })),
      http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const alert = screen.getAllByRole("alert").find((a) => a.textContent?.includes(ALERT))!;
    expect(within(alert).getByRole("listitem").textContent).toBe(MISSING);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "View governance.yaml" }));
    fireEvent.change(screen.getByRole("textbox", { name: "governance.yaml" }), { target: { value: FIXED } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Record a reason" });
    expect(dialog.textContent).toMatch(/is missing, so putting rules back needs a reason/);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Putting the rules back");
    await user.type(within(dialog).getByRole("textbox", { name: "Approved by" }), "Ana");
    await user.click(within(dialog).getByRole("button", { name: "Record reason" }));
    await screen.findByText("Saved.");
    expect(puts).toHaveLength(2);
    expect(puts[1].reason).toBe("Putting the rules back (Ana)");
    expect(puts[1].yaml).toBe(FIXED);
    expect(screen.queryByText(ALERT)).toBeNull();
  });

  it("R397 d: an issue quoting markup is shown as text, never as markup", async () => {
    const issue = "<img src=x onerror=alert(1)>: unknown key (check spelling) in governance.yaml";
    serveRead({ yaml: PROBE, readable: false, issues: [issue], warnings: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    const alert = screen.getAllByRole("alert").find((a) => a.textContent?.includes(ALERT))!;
    expect(within(alert).getByRole("listitem").textContent).toBe(issue);
    expect(document.querySelector("img")).toBeNull();
  });

  it("readable without warnings: nothing new is shown", async () => {
    serveRead({ yaml: YAML, readable: true, issues: [], warnings: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await loaded();
    expect(screen.queryByText(ALERT)).toBeNull();
    expect(screen.queryByText("The rules were read, with these notes:")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});
