import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockService, PSEUDONYMISING_GOVERNANCE, REPORT, server, SUMMARY, type ServiceSetup } from "../../test/importService";
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
  await act(async () => m.emit("import.progress", { batchId: "b1", projectId: "p1", state: "finished", counts: REPORT.counts }));
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
    expect(m.bodies("POST /projects/p1/import/dry-run")).toEqual([{ adapter: { kind: "folder", path: "/data/papers" } }]);
    await toOptions(user);
    expect((screen.getByRole("radio", { name: "Copy into the library" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Folders become collections" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Merge into the existing source" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "OCR scanned PDFs" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Transcribe audio and video" }) as HTMLInputElement).checked).toBe(false);
    await runToReport(m, user);
    expect(m.bodies("POST /projects/p1/import")).toEqual([{ adapter: { kind: "folder", path: "/data/papers" }, options: DEFAULT_OPTIONS }]);
    expect(m.bodies("GET /imports/b1/report")).toHaveLength(1);
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
    await act(async () => m.emit("import.progress", { batchId: "b1", projectId: "p1", state: "running", done: 129, total: 1290 }));
    await act(async () => m.emit("import.progress", { batchId: "other", projectId: "p1", state: "running", done: 1, total: 2 }));
    const bar = await screen.findByRole("progressbar", { name: "Import progress" });
    await waitFor(() => expect(bar.getAttribute("value")).toBe("129"));
    expect(bar.getAttribute("max")).toBe("1290");
    expect(screen.getByText("129 of 1,290 items")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(m.bodies("POST /imports/b1/pause")).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(m.bodies("POST /imports/b1/resume")).toHaveLength(1));
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
    expect(m.bodies("POST /imports/b1/undo")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Undo import" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
    await waitFor(() => expect(m.bodies("POST /imports/b1/undo")).toHaveLength(1));
    expect(await screen.findByText(/Removed 1,284 sources and restored 3 merged sources\./)).toBeTruthy();
  });

  it("links the report to the review queue for this batch", async () => {
    const { m, user } = setup();
    await scanFolder(user);
    await toOptions(user);
    await runToReport(m, user);
    const link = screen.getByRole("link", { name: /Open the review queue/ });
    expect(link.getAttribute("href")).toBe("/import/review?project=p1&batch=b1");
  });

  describe("pseudonymised projects (R64)", () => {
    it("defaults structure to none and explains why", async () => {
      const { m, user } = setup({ governance: PSEUDONYMISING_GOVERNANCE });
      await scanFolder(user);
      await toOptions(user);
      expect((screen.getByRole("radio", { name: "Ignore folder structure" }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText(/folder names can carry participants' names/i)).toBeTruthy();
      await runToReport(m, user);
      expect((m.bodies("POST /projects/p1/import")[0] as { options: { structure: string } }).options.structure).toBe("none");
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
      await user.click(within(region).getByRole("checkbox", { name: "Approve every file in /home/u/Zotero/linked (2 files)" }));
      await user.click(within(region).getByRole("checkbox", { name: "Remember /home/u/Zotero/linked for later imports" }));
      await user.click(within(region).getByRole("checkbox", { name: "Approve /mnt/archive/lee.pdf (lee2021)" }));
      await toOptions(user);
      await runToReport(m, user);
      expect(m.bodies("POST /projects/p1/import")).toEqual([
        {
          adapter: { kind: "folder", path: "/data/papers" },
          options: {
            ...DEFAULT_OPTIONS,
            approveOutside: { folders: ["/home/u/Zotero/linked"], files: ["/mnt/archive/lee.pdf"], rememberFolders: ["/home/u/Zotero/linked"] },
          },
        },
      ]);
    });

    it("sends no approvals when the researcher approves nothing", async () => {
      const { m, user } = setup(outside);
      await scanFolder(user);
      expect(screen.getByText(/not approved.*imported without the file/i)).toBeTruthy();
      await toOptions(user);
      await runToReport(m, user);
      expect((m.bodies("POST /projects/p1/import")[0] as { options: object }).options).toEqual(DEFAULT_OPTIONS);
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
    expect(m.bodies("POST /projects/p1/import/dry-run")).toEqual([{ adapter: { kind: "zotero-web", libraryType: "group", libraryId: "123456" } }]);
  });

  it("reference files carry their format", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Reference file" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "RIS");
    await user.type(screen.getByRole("textbox", { name: "File path" }), "/data/export.ris");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(m.bodies("POST /projects/p1/import/dry-run")).toEqual([{ adapter: { kind: "ris", path: "/data/export.ris" } }]);
  });

  it("Zotero library uses the data folder", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Zotero library" }));
    expect(screen.getByText(/~\/Zotero/)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Zotero data folder" }), "/home/u/Zotero");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(m.bodies("POST /projects/p1/import/dry-run")).toEqual([{ adapter: { kind: "zotero-local", dataDir: "/home/u/Zotero" } }]);
  });

  it("refuses a relative path before calling the service", async () => {
    const { m, user } = setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(screen.getByText(/full path/i)).toBeTruthy();
    expect(m.bodies("POST /projects/p1/import/dry-run")).toHaveLength(0);
  });

  it("Camera or phone folder goes to device import with the session and participants", async () => {
    const { m, user } = setup({
      sessions: [{ id: "se1", projectId: "p1", date: "2026-10-02", place: "Herat", participantIds: ["pa1"] }],
      participants: [
        { id: "pa1", projectId: "p1", code: "P-014", consentIds: [] },
        { id: "pa2", projectId: "p1", code: "P-015", consentIds: [] },
      ],
    });
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Camera or phone folder" }));
    await user.type(screen.getByRole("textbox", { name: "Camera or phone folder" }), "/media/phone/DCIM");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Fieldwork session" }), "se1");
    await user.click(screen.getByRole("checkbox", { name: "P-015" }));
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    await toOptions(user);
    await runToReport(m, user);
    expect(m.bodies("POST /projects/p1/import")).toHaveLength(0);
    expect(m.bodies("POST /projects/p1/device-import")).toEqual([{ dir: "/media/phone/DCIM", sessionId: "se1", participantIds: ["pa2"], options: DEFAULT_OPTIONS }]);
  });

  it("shows a service error in plain words", async () => {
    const { http, HttpResponse } = await import("msw");
    const { user } = setup({
      extra: [http.post("http://127.0.0.1:4100/projects/:id/import/dry-run", () => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "Online lookup is not permitted in this project." } }, { status: 403 }))],
    });
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "/data/papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Online lookup is not permitted in this project."));
  });
});
