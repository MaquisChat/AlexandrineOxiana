import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { GovernanceSettings } from "./GovernanceSettings";

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
});
