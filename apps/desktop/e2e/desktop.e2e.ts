/**
 * The desktop app end to end on Linux (Task 37h): the built app (the debug build `build:linux`
 * makes), started by WebDriver (tauri-driver → WebKitWebDriver) on a private virtual display, with
 * its home, settings and data folders and a place for libraries all under one temporary folder
 * (desktop.ts). One scenario, as a person would go through it:
 *
 *   the window shows the library chooser → a library is created → a project is created in the New
 *   project dialog → a PDF is attached with "Choose files…" through the native file dialog → the
 *   library lists the source → what the service persisted is on disk (the stored copy, the original
 *   untouched, the audit entry) → the window is closed → no process of the app is left.
 *
 * What is real and what is stood in for:
 *  - Real: the app's own window and web view (WebKitGTK), its tauri://localhost origin and
 *    content-security policy, the connection the shell hands the page, the library service and the
 *    media worker the shell starts (with their own fresh token, which this test never sees), the
 *    page's clicks and key presses (WebDriver input events in the web view), and the native file
 *    dialog: the "Choose files…" button → the bridge (packages/ui/src/desktopShell.ts) → the dialog
 *    plugin's `open` command through Tauri's IPC and the window's capability check → rfd → the GTK
 *    file chooser, a real window on the display, whose answer goes back the same way to the page
 *    and from there to the service.
 *  - Stood in for: the person's hand in that dialog. WebDriver cannot reach a native window, so the
 *    test finds it on the display by its title and types the file's path into it with xdotool
 *    (Ctrl+L, the path, Return), as a person may. No test double exists in the shell or the bridge.
 *  - Not covered: a file dropped onto the window from another program (an OS drag and drop cannot be
 *    made under Xvfb; the drop path is covered by the bridge's unit tests), and the macOS app (there
 *    is no WebDriver for the Mac web view; this test catches what Linux and macOS share).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { cmdline, readAuditLines, running, startDesktop, until, type Desktop } from "./desktop.js";

const LIBRARY = "Estuary fieldwork";
const PROJECT = "Tide-line interviews";
const PDF_TITLE = "Notes from the tide-line interviews";
const PDF_NAME = "tide-line-notes.pdf";

/** Every file under `dir`, relative to it ("/"-separated). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A process's parent pid (-1 when it is gone). */
function parentOf(pid: number): number {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return -1;
  }
}

test("the built Linux app: create a library and a project, attach a file through the native file dialog, close with nothing left running", async ({}, testInfo) => {
  let app: Desktop | undefined;
  try {
    await test.step("launch the built app under WebDriver on a private display", async () => {
      app = await startDesktop();
    });
    const d = app!;
    const s = d.session;

    await test.step("the window shows the library chooser, in the app's own origin", async () => {
      expect(await s.execute<string>("return window.location.origin")).toBe("tauri://localhost");
      expect(await s.title()).toBe("Alexandrine Oxiana");
      await d.byRole("heading", "Choose a library", { level: 1 });
      // The bridge sees the shell: the native picker buttons are there.
      await d.byRole("button", "Choose folder…");
    });

    await test.step("the first-use Optional tools dialog opens over it (the worker answered); “Not now”", async () => {
      // On a new settings folder the app asks once which optional tools to fetch, once the worker
      // reports what is installed. A person would answer it before anything else.
      const tools = await d.byRole("dialog", "Optional tools", { timeoutMs: 60_000 });
      await s.click(await d.byRole("button", "Not now", { within: tools }));
      await until("the dialog to close and the page behind to be usable again", 30_000, async () => (await d.countByRole("dialog", "Optional tools")) === 0 && (await s.execute<boolean>("return !document.querySelector('[inert]')")));
    });

    const libraryPath = join(d.librariesDir, "Estuary fieldwork library");
    await test.step("create a library at a typed folder", async () => {
      await s.sendKeys(await d.byRole("textbox", "Library folder"), libraryPath);
      await s.sendKeys(await d.byRole("textbox", "New library name"), LIBRARY);
      await s.click(await d.byRole("button", "Create a new library in that folder"));
      await d.byRole("heading", LIBRARY, { level: 1, timeoutMs: 60_000 });
      expect(JSON.parse(readFileSync(join(libraryPath, "library.json"), "utf8"))).toMatchObject({ name: LIBRARY });
      // Registered in the app's own settings folder (R159), under the run's temporary data folder.
      const settings = join(d.appDataDir, "settings");
      expect(filesUnder(settings).some((f) => readFileSync(join(settings, f), "utf8").includes(LIBRARY)), `the library is registered under ${settings}`).toBe(true);
      // Opening the library started the real media worker under the service.
      await until("the media worker to run under the service", 60_000, () => d.helpers().some((p) => /ao[-_]worker/.test(cmdline(p))));
    });

    await test.step("create a project in the New project dialog", async () => {
      await s.click(await d.byRole("button", "New project"));
      const dialog = await d.byRole("dialog", "New project");
      await s.sendKeys(await d.byRole("textbox", "Project name", { within: dialog }), PROJECT);
      // Rules without identifiable data, where encryption is a choice, left unencrypted.
      await s.click(await d.byRole("checkbox", "This project holds identifiable information about people", { within: dialog }));
      const encrypt = await d.byRole("checkbox", "Encrypt this project", { within: dialog });
      await until("encryption to become a choice", 10_000, async () => (await s.property(encrypt, "disabled")) === false);
      await s.click(encrypt);
      expect(await s.property(encrypt, "checked")).toBe(false);
      await s.click(await d.byRole("button", "Create project", { within: dialog }));
      await until("the dialog to close", 30_000, async () => (await d.countByRole("dialog", "New project")) === 0);
      const projects = await d.byRole("navigation", "Projects");
      const listed = await d.byRole("button", PROJECT, { within: projects });
      await until("the new project to be selected", 10_000, async () => (await s.execute<string | null>("return arguments[0].getAttribute('aria-current')", [s.element(listed)])) === "true");
    });

    const pdf = join(d.filesDir, PDF_NAME);
    let original: Buffer = Buffer.alloc(0);
    await test.step("attach a PDF with “Choose files…” through the native file dialog", async () => {
      original = await buildPdf({ title: PDF_TITLE, extra: "task-37h" });
      writeFileSync(pdf, original);
      const zone = await d.byRole("region", `Attach files to ${PROJECT}`);
      await s.click(await d.byRole("button", "Choose files…", { within: zone }));
      // The real GTK file chooser, titled by the page's request (DropZone: "Attach files to <project>").
      await d.pickInFileDialog(`Attach files to ${PROJECT}`, pdf);
      const outcomes = await d.byRole("list", "Attached files", { timeoutMs: 60_000 });
      const items = await until("one attach outcome", 60_000, async () => {
        const t = await d.textsByRole("listitem", { within: outcomes });
        return t.length === 1 ? t : undefined;
      });
      expect(items[0]).toContain(PDF_NAME);
      expect(items[0]).not.toMatch(/failed/i);
    });

    await test.step("the library lists the source", async () => {
      const table = await d.byRole("table", "Sources", { timeoutMs: 30_000 });
      await d.byRole("button", PDF_TITLE, { within: table, timeoutMs: 30_000 });
      expect(await d.countByRole("alert", null)).toBe(0);
    });

    await test.step("what the service persisted: the stored copy, the original untouched, the audit entry", async () => {
      // The original is never modified.
      expect(sha256(readFileSync(pdf))).toBe(sha256(original));
      // An identical copy is stored inside the library, and nothing of the original's folder is referenced.
      const files = filesUnder(libraryPath);
      const copies = files.filter((f) => f.endsWith(".pdf") && sha256(readFileSync(join(libraryPath, f))) === sha256(original));
      expect(copies, files.join("\n")).toHaveLength(1);
      const stored = files.filter((f) => !/\.(pdf|sqlite|sqlite-wal|sqlite-shm)$/.test(f) && !f.includes("/audit/"));
      for (const f of stored) expect(readFileSync(join(libraryPath, f), "utf8"), `${f} stores no absolute path`).not.toContain(d.filesDir);
      // The audit log records the new source.
      const logs = files.filter((f) => /(^|\/)audit\/[^/]+\.jsonl$/.test(f));
      expect(logs.length, files.join("\n")).toBeGreaterThan(0);
      const entries = logs.flatMap((f) => {
        const { entries: e, unreadable } = readAuditLines(readFileSync(join(libraryPath, f), "utf8"));
        expect(unreadable, `${f}: every line is an audit entry`).toEqual([]);
        return e as Array<{ action?: string; details?: { op?: string }; entity?: { type?: string; id?: string } }>;
      });
      // One new source: its creation is audited once per governed request (the capture, then the
      // store), each naming that source.
      const created = entries.filter((e) => e.details?.op === "source.create");
      const why = JSON.stringify(created);
      expect(created.length, why).toBeGreaterThan(0);
      expect(new Set(created.map((e) => `${e.entity?.type}:${e.entity?.id}`)).size, why).toBe(1);
      expect(created[0]!.entity?.type, why).toBe("source");
      expect(created.map((e) => e.action), why).toContain("store");
    });

    await test.step("close the window: the shell stops its helpers and exits, and no process of the app is left", async () => {
      const helpers = d.helpers();
      expect(helpers.length, "the service and the worker run before closing").toBeGreaterThanOrEqual(2);
      // While closing, the service must never be left behind by the shell: the shell waits for it
      // (and the worker under it) to be gone before it exits itself. Watched every 20 ms.
      const { shellPid, servicePid } = d.shell;
      const orphaned: string[] = [];
      const watch = setInterval(() => {
        if (running(servicePid) && parentOf(servicePid) !== shellPid) orphaned.push(`the service (${servicePid}) ran on with parent ${parentOf(servicePid)} while the shell was ${running(shellPid) ? "running" : "gone"}`);
      }, 20);
      try {
        await d.closeWithCloseButton();
        await until("the shell to exit by itself", 120_000, () => !running(shellPid));
      } finally {
        clearInterval(watch);
      }
      expect(orphaned.slice(0, 3), "the shell stopped the service before it exited").toEqual([]);
      // The orderly path (R155): the shell closed the service's standard input, and the service shut
      // down for that reason by itself (its log line, passed on by the shell); nothing was forced.
      expect(d.shellLog(), "the service shut down because the shell closed its standard input").toMatchObject({ serviceStop: "end of standard input", forced: false });
      expect(helpers.filter(running), "the service and the worker are gone").toEqual([]);
      const left = await until("no process of the app to be left", 30_000, () => d.appProcesses().length === 0).catch(() => d.appProcesses());
      expect(left === true ? [] : (left as number[]).map((p) => `${p} ${cmdline(p)}`)).toEqual([]);
    });
  } catch (err) {
    if (app) await testInfo.attach("shell-output", { body: app.log(), contentType: "text/plain" });
    if (app) writeFileSync(testInfo.outputPath("shell-output.txt"), app.log());
    throw err;
  } finally {
    await app?.dispose();
  }
});
