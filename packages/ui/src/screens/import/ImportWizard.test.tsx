import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockService, PSEUDONYMISING_GOVERNANCE, REPORT, server, SUMMARY, type ServiceSetup, B1, P1 } from "../../test/importService";
import { ImportWizard } from "./ImportWizard";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const DEFAULT_OPTIONS = { fileHandling: "copy", structure: "collections", duplicates: "merge", ocr: true, transcribe: false };

function setup(o: ServiceSetup = {}) {
  const m = mockService(o);
  const user = userEvent.setup();
  render(<ImportWizard client={m.client} />);
  return { m, user };
}

/** Source step with a folder, then the dry run. */
async function scanFolder(user: ReturnType<typeof userEvent.setup>, path = "/data/papers") {
  await screen.findByRole("option", { name: "Thesis" });
  await user.click(screen.getByRole("radio", { name: "Folder" }));
  await user.type(screen.getByRole("textbox", { name: "Folder path" }), path);
  await user.click(screen.getByRole("button", { name: "Scan" }));
  await screen.findByRole("heading", { name: "Scan results" });
}

async function toOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Review" });
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Options" });
}

/** From Options: start, finish the run through events, land on the report. */
async function runToReport(m: ReturnType<typeof mockService>, user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await screen.findByRole("heading", { name: "Run" });
  await waitFor(() => expect(m.calls.some((c) => c.path === "/events")).toBe(true));
  await act(async () => m.emit("import.progress", { batchId: B1, projectId: P1, state: "finished", counts: REPORT.counts }));
  await screen.findByRole("heading", { name: "Report and undo" });
}

describe("Bulk Import wizard", () => {
  it("shows the seven steps, Identify running inside Scan and Run", async () => {
    setup();
    const steps = await screen.findByRole("list", { name: "Import steps" });
    const names = within(steps).getAllByRole("listitem").map((li) => li.textContent);
    expect(names).toHaveLength(7);
    expect(names.map((n) => n?.split(" — ")[0])).toEqual(["Source", "Scan", "Identify", "Review", "Options", "Run", "Report and undo"]);
    expect(within(steps).getByText(/runs during Scan and Run/)).toBeTruthy();
  });

  it("offers every source the spec lists", async () => {
    setup();
    await screen.findByRole("option", { name: "Thesis" });
    for (const name of ["Folder", "ZIP archive", "Zotero library", "Zotero (web)", "Reference file", "Calibre library", "Camera or phone folder"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  it("walks every step and posts the expected bodies with the default options", async () => {
    const { m, user } = setup();
    await scanFolder(user);
    expect(m.bodies(`POST /projects/${P1}/import/dry-run`)).toEqual([{ adapter: { kind: "folder", path: "/data/papers" } }]);
    await toOptions(user);
    expect((screen.getByRole("radio", { name: "Copy into the library" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Folders become collections" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Merge into the existing source" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "OCR scanned PDFs" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Transcribe audio and video" }) as HTMLInputElement).checked).toBe(false);
    await runToReport(m, user);
    expect(m.bodies(`POST /projects/${P1}/import`)).toEqual([{ adapter: { kind: "folder", path: "/data/papers" }, options: DEFAULT_OPTIONS }]);
    expect(m.bodies(`GET /imports/${B1}/report`)).toHaveLength(1);
    expect(screen.getByText("1,280")).toBeTruthy();
  });

  it("renders the dry-run summary with the four counts", async () => {
    const { user } = setup();
    await scanFolder(user);
    const summary = screen.getByRole("region", { name: "Scan results" });
    expect(within(summary).getByText("1,290")).toBeTruthy(); // items
    expect(within(summary).getByText("14")).toBeTruthy(); // likely duplicates
    expect(within(summary).getByText("7")).toBeTruthy(); // already imported
    expect(within(summary).getByText("1")).toBeTruthy(); // unreadable
    expect(within(summary).getByText("broken/locked.pdf")).toBeTruthy();
    expect(within(summary).getByText("2 empty records were skipped.")).toBeTruthy();
  });

  it("link in place shows the flag warning", async () => {
    const { user } = setup();
    await scanFolder(user);
    await toOptions(user);
    expect(screen.queryByText("Linked files are outside encryption and retention control and will be flagged in reports.")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Link in place" }));
    expect(screen.getByText("Linked files are outside encryption and retention control and will be flagged in reports.")).toBeTruthy();
  });

  it("refuses link in place when the project requires encryption", async () => {
    const { user } = setup({ governance: "encryption:\n  atRest: required\n" });
    await scanFolder(user);
    await toOptions(user);
    expect((screen.getByRole("radio", { name: "Link in place" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("Pause and Resume call the routes, and progress follows import.progress events", async () => {
    const { m, user } = setup();
    await scanFolder(user);
    await toOptions(user);
    await user.click(screen.getByRole("button", { name: "Start import" }));
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(m.calls.some((c) => c.path === "/events")).toBe(true));
    await act(async () => m.emit("import.progress", { batchId: B1, projectId: P1, state: "running", done: 129, total: 1290 }));
    await act(async () => m.emit("import.progress", { batchId: "other", projectId: P1, state: "running", done: 1, total: 2 }));
    const bar = await screen.findByRole("progressbar", { name: "Import progress" });
    await waitFor(() => expect(bar.getAttribute("value")).toBe("129"));
    expect(bar.getAttribute("max")).toBe("1290");
    expect(screen.getByText("129 of 1,290 items")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(m.bodies(`POST /imports/${B1}/pause`)).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(m.bodies(`POST /imports/${B1}/resume`)).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("Undo asks with the real counts and calls undo on confirm", async () => {
    const { m, user } = setup();
    await scanFolder(user);
    await toOptions(user);
    await runToReport(m, user);
    await user.click(screen.getByRole("button", { name: "Undo import" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Remove 1,284 imported sources and restore 3 merged sources?")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(m.bodies(`POST /imports/${B1}/undo`)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Undo import" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
    await waitFor(() => expect(m.bodies(`POST /imports/${B1}/undo`)).toHaveLength(1));
    expect(await screen.findByText(/Removed 1,284 sources and restored 3 sources that had been merged or updated\./)).toBeTruthy();
  });

  it("links the report to the review queue for this batch", async () => {
    const { m, user } = setup();
    await scanFolder(user);
    await toOptions(user);
    await runToReport(m, user);
    const link = screen.getByRole("link", { name: /Open the review queue/ });
    expect(link.getAttribute("href")).toBe(`/import/review?project=${P1}&batch=${B1}`);
  });

  describe("pseudonymised projects (R64)", () => {
    it("defaults structure to none and explains why", async () => {
      const { m, user } = setup({ governance: PSEUDONYMISING_GOVERNANCE });
      await scanFolder(user);
      await toOptions(user);
      expect((screen.getByRole("radio", { name: "Ignore folder structure" }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText(/folder names can carry participants' names/i)).toBeTruthy();
      await runToReport(m, user);
      expect((m.bodies(`POST /projects/${P1}/import`)[0] as { options: { structure: string } }).options.structure).toBe("none");
    });
  });

  describe("files outside the source's folders (R67)", () => {
    const outside: ServiceSetup = {
      summary: {
        ...SUMMARY,
        outsideFiles: [
          { item: "smith2020", folder: "/home/u/Zotero/linked", file: "/home/u/Zotero/linked/smith.pdf" },
          { item: "jones2019", folder: "/home/u/Zotero/linked", file: "/home/u/Zotero/linked/jones.pdf" },
          { item: "lee2021", folder: "/mnt/archive", file: "/mnt/archive/lee.pdf" },
        ],
      },
    };

    it("lists the folders and sends approvals per folder and per file with the start request", async () => {
      const { m, user } = setup(outside);
      await scanFolder(user);
      const region = screen.getByRole("region", { name: "Files outside the source folder" });
      expect(within(region).getByRole("group", { name: "/home/u/Zotero/linked" })).toBeTruthy();
      expect(within(region).getByRole("group", { name: "/mnt/archive" })).toBeTruthy();
      const linked = within(region).getByRole("group", { name: "/home/u/Zotero/linked" });
      expect(within(linked).getByText(/2 files/)).toBeTruthy();
      await user.click(within(linked).getByRole("checkbox", { name: "Approve this folder and its subfolders" }));
      await user.click(within(region).getByRole("checkbox", { name: "Remember /home/u/Zotero/linked for later imports" }));
      await user.click(within(region).getByRole("checkbox", { name: "Approve /mnt/archive/lee.pdf (lee2021)" }));
      await toOptions(user);
      await runToReport(m, user);
      expect(m.bodies(`POST /projects/${P1}/import`)).toEqual([
        {
          adapter: { kind: "folder", path: "/data/papers" },
          options: {
            ...DEFAULT_OPTIONS,
            approveOutside: { folders: ["/home/u/Zotero/linked"], files: ["/mnt/archive/lee.pdf"], rememberFolders: ["/home/u/Zotero/linked"] },
          },
        },
      ]);
    });

    it("approving a folder covers its subfolders", async () => {
      const { m, user } = setup({
        summary: {
          ...SUMMARY,
          outsideFiles: [
            { item: "a", folder: "/data", file: "/data/a.pdf" },
            { item: "b", folder: "/data/sub", file: "/data/sub/b.pdf" },
            { item: "c", folder: "/database", file: "/database/c.pdf" },
          ],
        },
      });
      await scanFolder(user, "/papers");
      const region = screen.getByRole("region", { name: "Files outside the source folder" });
      const data = within(region).getByRole("group", { name: "/data" });
      const sub = within(region).getByRole("group", { name: "/data/sub" });
      const database = within(region).getByRole("group", { name: "/database" });
      expect(within(sub).queryByText(/covered by/)).toBeNull();
      await user.click(within(data).getByRole("checkbox", { name: "Approve this folder and its subfolders" }));
      expect(within(sub).getByText((_, el) => el?.tagName === "P" && el.textContent === "covered by /data (including its subfolders)")).toBeTruthy();
      expect((within(sub).getByRole("checkbox", { name: "Approve this folder and its subfolders" }) as HTMLInputElement).disabled).toBe(true);
      expect((within(sub).getByRole("checkbox", { name: "Approve /data/sub/b.pdf (b)" }) as HTMLInputElement).checked).toBe(true);
      expect(within(database).queryByText(/covered by/)).toBeNull(); // a sibling with the same prefix is not inside
      await toOptions(user);
      await runToReport(m, user);
      expect((m.bodies(`POST /projects/${P1}/import`)[0] as { options: { approveOutside: unknown } }).options.approveOutside).toEqual({ folders: ["/data"], files: [], rememberFolders: [] });
    });

    it("sends no approvals when the researcher approves nothing", async () => {
      const { m, user } = setup(outside);
      await scanFolder(user);
      expect(screen.getByText(/not approved.*imported without the file/i)).toBeTruthy();
      await toOptions(user);
      await runToReport(m, user);
      expect((m.bodies(`POST /projects/${P1}/import`)[0] as { options: object }).options).toEqual(DEFAULT_OPTIONS);
    });
  });

  it("Zotero web uses the library id and explains how the key is stored", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Zotero (web)" }));
    await user.click(screen.getByRole("radio", { name: "Group library" }));
    await user.type(screen.getByRole("textbox", { name: "Library ID" }), "123456");
    expect(screen.getByText(/ao secrets set zotero-api-key/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(m.bodies(`POST /projects/${P1}/import/dry-run`)).toEqual([{ adapter: { kind: "zotero-web", libraryType: "group", libraryId: "123456" } }]);
  });

  it("reference files carry their format", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Reference file" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "RIS");
    await user.type(screen.getByRole("textbox", { name: "File path" }), "/data/export.ris");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(m.bodies(`POST /projects/${P1}/import/dry-run`)).toEqual([{ adapter: { kind: "ris", path: "/data/export.ris" } }]);
  });

  it("Zotero library uses the data folder", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Zotero library" }));
    expect(screen.getByText(/~\/Zotero/)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Zotero data folder" }), "/home/u/Zotero");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(m.bodies(`POST /projects/${P1}/import/dry-run`)).toEqual([{ adapter: { kind: "zotero-local", dataDir: "/home/u/Zotero" } }]);
  });

  it("refuses a relative path before calling the service", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(screen.getByText(/full path/i)).toBeTruthy();
    expect(m.bodies(`POST /projects/${P1}/import/dry-run`)).toHaveLength(0);
  });

  it("Camera or phone folder goes to device import with the session and participants", async () => {
    const { m, user } = setup({
      sessions: [{ id: "se1", projectId: P1, date: "2026-10-02", place: "Herat", participantIds: ["pa1", "pa2"] }],
      participants: [
        { id: "pa1", projectId: P1, code: "P-014", consentIds: [] },
        { id: "pa2", projectId: P1, code: "P-015", consentIds: [] },
        { id: "pa3", projectId: P1, code: "P-016", consentIds: [] },
      ],
    });
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Camera or phone folder" }));
    await user.type(screen.getByRole("textbox", { name: "Camera or phone folder" }), "/media/phone/DCIM");
    await user.click(await screen.findByRole("checkbox", { name: "P-016" }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Fieldwork session" }), "se1");
    // Only the session's participants are offered; a choice outside it is dropped.
    expect(screen.queryByRole("checkbox", { name: "P-016" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "P-015" }));
    await user.type(screen.getByRole("textbox", { name: "Researcher name" }), "A. Researcher");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(screen.getByText(/pairing.*approximate/i)).toBeTruthy();
    await toOptions(user);
    await runToReport(m, user);
    expect(m.bodies(`POST /projects/${P1}/import`)).toHaveLength(0);
    expect(m.bodies(`POST /projects/${P1}/device-import`)).toEqual([{ dir: "/media/phone/DCIM", sessionId: "se1", participantIds: ["pa2"], options: { ...DEFAULT_OPTIONS, researcherName: "A. Researcher" } }]);
  });

  it("shows a service error in plain words", async () => {
    const { http, HttpResponse } = await import("msw");
    const { user } = setup({
      extra: [http.post("http://127.0.0.1:4100/projects/:id/import/dry-run", () => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "Online lookup is not permitted in this project.", reason: "governance: lookups.online = never" } }, { status: 403 }))],
    });
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "/data/papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The project's rules do not allow this.");
    expect(alert.textContent).toContain("Online lookup is not permitted in this project.");
    expect(alert.textContent).toContain("governance: lookups.online = never");
  });

  describe("the scanned choice (R115 I2)", () => {
    it("source inputs are disabled while the scan runs", async () => {
      const { user } = setup({ dryRunDelayMs: 150 });
      await screen.findByRole("option", { name: "Thesis" });
      await user.click(screen.getByRole("radio", { name: "Folder" }));
      await user.type(screen.getByRole("textbox", { name: "Folder path" }), "/a");
      await user.click(screen.getByRole("button", { name: "Scan" }));
      expect((screen.getByRole("textbox", { name: "Folder path" }) as HTMLInputElement).matches(":disabled")).toBe(true);
      expect((screen.getByRole("radio", { name: "ZIP archive" }) as HTMLInputElement).matches(":disabled")).toBe(true);
      expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).matches(":disabled")).toBe(true);
      await screen.findByRole("heading", { name: "Scan results" });
    });

    it("an edit after the scan clears it and its approvals; start uses what was scanned", async () => {
      const { m, user } = setup({ summary: { ...SUMMARY, outsideFiles: [{ item: "x", folder: "/elsewhere", file: "/elsewhere/x.pdf" }] } });
      await scanFolder(user, "/a");
      await user.click(screen.getByRole("checkbox", { name: "Approve this folder and its subfolders" }));
      await user.click(screen.getByRole("button", { name: "Back" }));
      const path = screen.getByRole("textbox", { name: "Folder path" });
      await user.clear(path);
      await user.type(path, "/b");
      expect(screen.queryByRole("button", { name: "Next" })).toBeNull(); // the scan of /a is gone
      await user.click(screen.getByRole("button", { name: "Scan" }));
      await screen.findByRole("heading", { name: "Scan results" });
      expect((screen.getByRole("checkbox", { name: "Approve this folder and its subfolders" }) as HTMLInputElement).checked).toBe(false);
      await toOptions(user);
      await runToReport(m, user);
      expect(m.bodies(`POST /projects/${P1}/import`)).toEqual([{ adapter: { kind: "folder", path: "/b" }, options: DEFAULT_OPTIONS }]);
    });

    it("going back without an edit keeps the scan", async () => {
      const { user } = setup();
      await scanFolder(user, "/a");
      await user.click(screen.getByRole("button", { name: "Back" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { name: "Scan results" })).toBeTruthy();
    });
  });

  it("options follow the project's rules when they arrive late, unless the researcher changed them", async () => {
    const { user } = setup({ governanceDelayMs: 200 });
    await scanFolder(user);
    await toOptions(user);
    await waitFor(() => expect((screen.getByRole("radio", { name: "Folders become collections" }) as HTMLInputElement).checked).toBe(true), { timeout: 1000 });
  });

  it("keeps the researcher's own options when the rules arrive", async () => {
    const { user } = setup({ governanceDelayMs: 300 });
    await scanFolder(user);
    await toOptions(user);
    await user.click(screen.getByRole("radio", { name: "Folders become tags" }));
    await new Promise((r) => setTimeout(r, 400));
    expect((screen.getByRole("radio", { name: "Folders become tags" }) as HTMLInputElement).checked).toBe(true);
  });

  describe("run screen (R115 I5)", () => {
    it("a stream that closes after connecting does not leave the screen on Starting…", async () => {
      const { m, user } = setup({ events: "close" });
      await scanFolder(user);
      await toOptions(user);
      m.setBatches([{ batchId: B1, number: 4, kind: "folder", state: "running", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 0, merged: 0, skipped: 0, failed: 0, needsReview: 0 } }]);
      await user.click(screen.getByRole("button", { name: "Start import" }));
      expect(await screen.findByText(/progress updates are not available/i, undefined, { timeout: 3000 })).toBeTruthy();
      expect(m.bodies("GET /events").length).toBeGreaterThan(1); // it reconnected
      // The batch finished meanwhile: checking again finds it and shows the report.
      m.setBatches([{ batchId: B1, number: 4, kind: "folder", state: "finished", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 1, merged: 0, skipped: 0, failed: 0, needsReview: 0 } }]);
      await user.click(screen.getByRole("button", { name: "Check again" }));
      await screen.findByRole("heading", { name: "Report and undo" });
    });

    it("a batch that ended before the stream opened goes to the report", async () => {
      const { m, user } = setup({ events: "close" });
      await scanFolder(user);
      await toOptions(user);
      m.setBatches([{ batchId: B1, number: 4, kind: "folder", state: "finished", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 1, merged: 0, skipped: 0, failed: 0, needsReview: 0 } }]);
      await user.click(screen.getByRole("button", { name: "Start import" }));
      await screen.findByRole("heading", { name: "Report and undo" });
    });

    it("shows a paused batch as paused on arrival", async () => {
      const { m, user } = setup();
      await scanFolder(user);
      await toOptions(user);
      m.setBatches([{ batchId: B1, number: 4, kind: "folder", state: "paused", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 0, merged: 0, skipped: 0, failed: 0, needsReview: 0 } }]);
      await user.click(screen.getByRole("button", { name: "Start import" }));
      expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    });
  });

  describe("undo dialog (R115 I6)", () => {
    async function openUndo(o: ServiceSetup = {}) {
      const r = setup(o);
      await scanFolder(r.user);
      await toOptions(r.user);
      await runToReport(r.m, r.user);
      await r.user.click(screen.getByRole("button", { name: "Undo import" }));
      return r;
    }

    it("traps focus, makes the background inert, and Escape returns focus to Undo", async () => {
      const { user } = await openUndo();
      const dialog = screen.getByRole("alertdialog");
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      const confirm = within(dialog).getByRole("button", { name: "Undo import" });
      expect(document.activeElement).toBe(cancel);
      await user.tab();
      expect(document.activeElement).toBe(confirm);
      await user.tab();
      expect(document.activeElement).toBe(cancel);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(confirm);
      const heading = screen.getByRole("heading", { name: "Report and undo", hidden: true });
      expect(heading.closest("[inert]")).not.toBeNull();
      expect(dialog.closest("[inert]")).toBeNull();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(document.querySelector("[inert]")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo import" }));
    });

    it("after undoing, focus goes to the report heading", async () => {
      const { user } = await openUndo();
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
      await screen.findByText(/Removed 1,284 sources/);
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Report and undo" }));
    });

    it("a failed undo is announced inside the dialog and focused there, not behind it in the inert page (41b1 I2)", async () => {
      const { http, HttpResponse } = await import("msw");
      const { user } = await openUndo({
        extra: [http.post("http://127.0.0.1:4100/imports/:batchId/undo", () => HttpResponse.json({ error: { code: "CONFLICT", message: "The import is still running." } }, { status: 409 }))],
      });
      const dialog = screen.getByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Undo import" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toMatch(/The import is still running\./);
      expect(document.activeElement).toBe(alert);
      expect(dialog.getAttribute("aria-describedby")).toContain(alert.id);
      // Nothing about the failure sits in the inert page behind the dialog.
      for (const el of Array.from(document.querySelectorAll("[inert] [role=alert]"))) expect(el.textContent).not.toMatch(/still running/);
      // Cancel is reachable again; after closing, the message stays on the page.
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByRole("alert").textContent).toMatch(/The import is still running\./);
    });

    it("Escape does not close the dialog while the undo is running, and focus stays in the dialog (41b1 M1)", async () => {
      const { http, HttpResponse } = await import("msw");
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const { user } = await openUndo({
        extra: [
          http.post("http://127.0.0.1:4100/imports/:batchId/undo", async () => {
            await gate;
            return HttpResponse.json({ removedSources: 1284, revertedMerges: 3, kept: [] });
          }),
        ],
      });
      const dialog = screen.getByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Undo import" }));
      const status = await within(dialog).findByRole("status");
      expect(status.textContent).toMatch(/Undoing/);
      expect(document.activeElement).toBe(status);
      await user.keyboard("{Escape}");
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      release();
      await screen.findByText(/Removed 1,284 sources/);
    });

    it("names updated sources apart from merged ones", async () => {
      await openUndo({ report: { ...REPORT, counts: { ...REPORT.counts, updated: 2 } } });
      expect(within(screen.getByRole("alertdialog")).getByText("Remove 1,284 imported sources, restore 3 merged sources and revert 2 updated sources?")).toBeTruthy();
    });
  });

  describe("Zotero's linked files with “Copy into the library” (R136, D4)", () => {
    const linked: ServiceSetup = { summary: { ...SUMMARY, linkedFiles: 2 } };

    it("copies them by default: the choice to keep them as links is separate, shown only when the scan found some", async () => {
      const { m, user } = setup(linked);
      await scanFolder(user);
      await toOptions(user);
      const keep = screen.getByRole("checkbox", { name: "Keep the 2 files Zotero links to where they are, as links" }) as HTMLInputElement;
      expect(keep.checked).toBe(false);
      await runToReport(m, user);
      expect((m.bodies(`POST /projects/${P1}/import`)[0] as { options: object }).options).toEqual({ ...DEFAULT_OPTIONS, linkedFiles: "copy" });
    });

    it("keeping them as links is an explicit choice, with the warning", async () => {
      const { m, user } = setup(linked);
      await scanFolder(user);
      await toOptions(user);
      await user.click(screen.getByRole("checkbox", { name: "Keep the 2 files Zotero links to where they are, as links" }));
      expect(screen.getByText(/outside encryption and retention control/)).toBeTruthy();
      await runToReport(m, user);
      expect((m.bodies(`POST /projects/${P1}/import`)[0] as { options: { linkedFiles: string } }).options.linkedFiles).toBe("link");
    });

    it("is never offered where the project's rules require encryption", async () => {
      const { m, user } = setup({ ...linked, governance: "encryption:\n  atRest: required\n" });
      await scanFolder(user);
      await toOptions(user);
      expect(screen.queryByRole("checkbox", { name: /where they are, as links/ })).toBeNull();
      await runToReport(m, user);
      expect((m.bodies(`POST /projects/${P1}/import`)[0] as { options: { linkedFiles: string } }).options.linkedFiles).toBe("copy");
    });

    it("is not shown when the scan found no linked files", async () => {
      const { user } = setup();
      await scanFolder(user);
      await toOptions(user);
      expect(screen.queryByRole("checkbox", { name: /where they are, as links/ })).toBeNull();
    });

    it("the report gives the number of files copied and the number left as links", async () => {
      const { m, user } = setup({ ...linked, report: { ...REPORT, files: { copied: 1290, linked: 0 } } });
      await scanFolder(user);
      await toOptions(user);
      await runToReport(m, user);
      const table = await screen.findByRole("table", { name: "Items by outcome" });
      expect(within(table).getByRole("row", { name: "Files copied into the library 1,290" })).toBeTruthy();
      expect(within(table).getByRole("row", { name: "Files left as links 0" })).toBeTruthy();
    });
  });
});
