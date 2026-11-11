/**
 * Scenarios 1, 2, 5 and 7 (Task 37's list; PLAN Task 44) against the real service and worker.
 *
 *  1. A library created at a typed folder; an IRB + GDPR project with encryption through the New
 *     project dialog; the recovery code shown once and not to be left before "I have saved it"
 *     (R134); the project encrypted on disk and its creation audited; locked, then unlocked with the
 *     passphrase and, separately, with the recovery code captured from the page.
 *  2. A PDF carrying a DOI attached by typing its path into the drop area; the source titled from the
 *     recorded Crossref answer; an APA citation copied from the cite panel equals what POST /cite
 *     returns; the stored source's evidence says where the title came from.
 *  5. Dark theme and another interface typeface survive a reload, stored in the app's settings
 *     folder and not in the library.
 *  7. With a few sources, the service stopped, library.sqlite (and its -wal and -shm) deleted, the
 *     service started again on the same library: the index is rebuilt, search finds a source by a
 *     word of its title, and nothing on disk was lost.
 *
 * Elements are found by role and accessible name. Steps the product cannot do yet are
 * `blockedBy(<defect>)` (fixtures.ts), each also run as its own expected-failure test at the end of
 * this file, and described in the Task 44 report.
 *
 * The recovery code and the passphrase are secrets: kept in variables, never logged, never in a
 * test or step title, never attached to the report.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildDoiPdf, buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, blockedBy, DEFECT_TIMEOUT, expect, expectDefect, libraryWithProject, test, type AppHarness, type Defect, type Page } from "./fixtures.js";

// ---------- shared ----------

interface ProjectList {
  projects: Array<{ id: string; name: string; folder: string; encrypted: boolean; unlocked: boolean }>;
}
interface SourceList {
  total: number;
  items: Array<{ id: string; title: string }>;
}
/** source.json as GET /projects/:id/sources/:sid returns it (the parts read here). */
interface StoredSource {
  source: { id: string; title: { variants: Array<{ value: string }> }; identifiers?: { doi?: string } };
  fieldEvidence: Array<{ field: string; value: unknown; source: { kind: string; provider?: string; ref?: string } }>;
}

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

/** Rules for a project without identifiable data, encryption optional, the default (public) metadata lookups. */
const LOOKUP_RULES = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n";

/** Types paths into the drop area ("Attach files…") and waits for the attach outcome list. */
async function attachByTyping(page: Page, paths: string[]): Promise<void> {
  await page.getByRole("button", { name: "Attach files…" }).click();
  await page.getByRole("textbox", { name: "File paths, one per line" }).fill(paths.join("\n"));
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  // Attach hashes, extracts and looks up in the service (the worker on a cold library): a generous, explicit wait.
  await expect(page.getByRole("list", { name: "Attached files" }).getByRole("listitem")).toHaveCount(paths.length, { timeout: 60_000 });
}

// ---------- scenario 1 ----------

const S1_LIBRARY = "Fieldwork library";
const S1_PROJECT = "Riverbank oral histories";
/** Kept out of titles and logs; a test fixture, not a secret of anyone's. */
const PASSPHRASE = "correct horse battery staple river";
/** As the library formats it (crypto/keys.ts formatRecoveryCode): eight groups of four Crockford base32 characters. */
const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){7}$/;

/** The chooser: a new library at a typed folder. */
async function createLibraryInChooser(app: AppHarness, page: Page, name: string): Promise<string> {
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
  const folder = join(app.librariesDir, name);
  await page.getByRole("textbox", { name: "Library folder" }).fill(folder);
  await page.getByRole("textbox", { name: "New library name" }).fill(name);
  await page.getByRole("button", { name: "Create a new library in that folder" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return folder;
}

test("scenario 1: a library and an IRB + GDPR project with encryption; the recovery code shown once; lock, unlock with the passphrase and with the recovery code", async ({ page, app }) => {
  let libraryPath = "";
  let recoveryCode = "";
  let project: ProjectList["projects"][number] | undefined;
  let projectRoot = "";

  await test.step("create a library at a typed folder", async () => {
    libraryPath = await createLibraryInChooser(app, page, S1_LIBRARY);
    expect(JSON.parse(readFileSync(join(libraryPath, "library.json"), "utf8"))).toMatchObject({ name: S1_LIBRARY });
  });

  await test.step("the New project dialog: IRB and GDPR on, identifiable data, encryption required, the passphrase twice", async () => {
    await page.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByRole("textbox", { name: "Project name" }).fill(S1_PROJECT);
    await dialog.getByRole("checkbox", { name: "University IRB" }).check();
    await dialog.getByRole("checkbox", { name: "GDPR" }).check();
    await expect(dialog.getByRole("checkbox", { name: "This project holds identifiable information about people" })).toBeChecked();
    const encrypt = dialog.getByRole("checkbox", { name: "Encrypt this project" });
    await expect(encrypt).toBeChecked();
    await expect(encrypt).toBeDisabled();
    await dialog.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel("Passphrase again", { exact: true }).fill(PASSPHRASE);
    await dialog.getByRole("button", { name: "Create project" }).click();
  });

  await test.step("the recovery code is shown once, and is captured from the page", async () => {
    const dialog = page.getByRole("dialog", { name: "Save the recovery code" });
    // scrypt key wrapping (passphrase and recovery code) runs in the service: a generous, explicit wait.
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("This is the only time it is shown", { exact: false })).toBeVisible();
    const code = dialog.getByText(RECOVERY_CODE);
    await expect(code).toHaveCount(1);
    recoveryCode = ((await code.textContent()) ?? "").trim();
    expect(RECOVERY_CODE.test(recoveryCode), "a recovery code in the library's format").toBe(true);
  });

  await test.step("the dialog cannot be left before “I have saved the recovery code” (R134)", async () => {
    const dialog = page.getByRole("dialog", { name: "Save the recovery code" });
    const done = dialog.getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    // Escape does not close it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    // Back is refused, with a plain message, and the code stays on screen.
    await page.goBack();
    await expect(dialog.getByRole("alert")).toContainText("Save the recovery code first.");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(RECOVERY_CODE)).toHaveCount(1);
    // Tab stays inside the dialog: the page behind cannot be reached from the keyboard.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `focus is still in the dialog after ${i + 1} Tab presses`).toBe(true);
    }
    await expect(done).toBeDisabled();
  });

  await test.step("“I have saved the recovery code”, then Done: the project is listed and selected, the code gone from the page", async () => {
    const dialog = page.getByRole("dialog", { name: "Save the recovery code" });
    await dialog.getByRole("checkbox", { name: "I have saved the recovery code" }).check();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    const projects = page.getByRole("navigation", { name: "Projects" });
    await expect(projects.getByRole("button", { name: S1_PROJECT })).toHaveAttribute("aria-current", "true");
    await expect(page.getByText(recoveryCode)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Lock project" })).toBeVisible();
  });

  await test.step("what the service persisted: an encrypted, unlocked project with the IRB and GDPR rules", async () => {
    const listed = (await app.api<ProjectList>("GET", "/projects")).body.projects;
    expect(listed.map((p) => p.name)).toEqual([S1_PROJECT]);
    project = listed[0]!;
    expect(project).toMatchObject({ encrypted: true, unlocked: true });
    projectRoot = join(libraryPath, project.folder);
    const rules = (await app.api<{ yaml: string }>("GET", `/projects/${project.id}/governance`)).body.yaml;
    // What the governance screen writes when a profile is turned on (governanceModel.ts profileOnEntries).
    expect(rules).toMatch(/\birb\b/i);
    expect(rules).toMatch(/\bgdpr\b/i);
  });

  await test.step("on disk: the key file wraps the key with the passphrase and the recovery code; the change log is sealed; only project.json names the project", async () => {
    const keyFile = JSON.parse(readFileSync(join(projectRoot, "keys", "project-key.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(keyFile).sort()).toEqual(["keyId", "passphrase", "recovery"]);
    expect(keyFile.passphrase).toEqual(expect.objectContaining({}));
    expect(keyFile.recovery).toEqual(expect.objectContaining({}));
    // The project record is readable and says it is encrypted, with that key.
    const projectJson = JSON.parse(readFileSync(join(projectRoot, "project.json"), "utf8")) as { project: { name: string; encryption: { enabled: boolean; keyId?: string } } };
    expect(projectJson.project.encryption).toEqual({ enabled: true, keyId: keyFile.keyId });
    // The structure stays readable (spec 4.3): an unencrypted manifest, with no sources yet.
    expect(JSON.parse(readFileSync(join(projectRoot, "manifest.json"), "utf8"))).toEqual({ formatVersion: 1, sources: [] });
    // The change log exists and is sealed: nothing in it names the project.
    const files = filesUnder(projectRoot);
    expect(files.filter((f) => f.startsWith("changes/")).length, files.join("\n")).toBeGreaterThan(0);
    // Neither the recovery code nor the passphrase is anywhere in the project folder, and the only
    // file that names the project in plain text is project.json (the project record itself; the
    // folder is named after the project too, by design: spec 4.1).
    const naming: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(projectRoot, f)).toString("latin1");
      expect(text.includes(recoveryCode), `the recovery code is not in ${f}`).toBe(false);
      expect(text.includes(PASSPHRASE), `the passphrase is not in ${f}`).toBe(false);
      if (text.includes(S1_PROJECT)) naming.push(f);
    }
    expect(naming).toEqual(["project.json"]);
  });

  await test.step("the audit log records the creation, encrypted", async () => {
    const audit = (await app.api<{ events: Array<{ action: string; entity?: { type: string; id: string }; details?: Record<string, unknown> }> }>("GET", `/projects/${project!.id}/audit?limit=1000`)).body;
    const created = audit.events.filter((e) => e.details?.op === "project.create");
    expect(created, JSON.stringify(audit.events.map((e) => e.details?.op))).toHaveLength(1);
    expect(created[0]).toMatchObject({ action: "store", entity: { type: "project", id: project!.id }, details: { op: "project.create", encrypted: true } });
    const verified = await app.api<{ ok: boolean }>("GET", `/projects/${project!.id}/audit/verify`);
    expect(verified.body, JSON.stringify(verified.body)).toMatchObject({ ok: true });
  });

  const unlockScreen = () => page.getByRole("region", { name: `${S1_PROJECT} is locked` });
  const lock = async () => {
    await page.getByRole("button", { name: "Lock project" }).click();
    await expect(unlockScreen()).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search sources" })).toHaveCount(0);
    expect((await app.api<ProjectList>("GET", "/projects")).body.projects[0]).toMatchObject({ encrypted: true, unlocked: false });
  };
  const unlockWith = async (secret: string) => {
    await unlockScreen().getByLabel("Passphrase or recovery code").fill(secret);
    await unlockScreen().getByRole("button", { name: "Unlock" }).click();
    // Unwrapping the key (scrypt) runs in the service: a generous, explicit wait.
    await expect(unlockScreen()).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("searchbox", { name: "Search sources" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect((await app.api<ProjectList>("GET", "/projects")).body.projects[0]).toMatchObject({ encrypted: true, unlocked: true });
  };

  await test.step("lock the project: the unlock screen takes the place of its sources", lock);

  await test.step("a wrong passphrase changes nothing, and says so", async () => {
    await unlockScreen().getByLabel("Passphrase or recovery code").fill("not the passphrase");
    await unlockScreen().getByRole("button", { name: "Unlock" }).click();
    await expect(unlockScreen().getByRole("alert")).toHaveText("That passphrase didn't unlock this project. Nothing was changed.", { timeout: 30_000 });
    expect((await app.api<ProjectList>("GET", "/projects")).body.projects[0]).toMatchObject({ unlocked: false });
  });

  await test.step("unlock with the passphrase", () => unlockWith(PASSPHRASE));

  await test.step("lock again", lock);

  await test.step("unlock with the recovery code captured from the page", () => unlockWith(recoveryCode));
});

// ---------- scenario 2 ----------

const S2_LIBRARY = "Upland library";
const S2_PROJECT = "River memory";
/** The fixture DOI article (tests/fixtures/generate.mjs) and its recorded Crossref answer (packages/library/tests/fixtures/lookup). */
const DOI = "10.5555/ao.fixture.2021.001";
const CROSSREF_TITLE = "Rivers and Memory in Upland Villages";

test("scenario 2: attach a PDF with a DOI by typing its path; the title from the recorded Crossref answer; copy an APA citation", async ({ page, app, browserName }) => {
  let projectId = "";
  let sourceId = "";
  const pdf = join(app.root, "sources", "doi-article.pdf");
  /** Whether the browser lets the page read the clipboard back (see the clipboard step). */
  let canReadClipboard = false;

  await test.step("set-up: a library and a project with the default metadata lookups (through the service); the PDF on disk", async () => {
    if (browserName === "chromium") {
      // Chromium: explicit permissions, for the app's origin only.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_ORIGIN });
      canReadClipboard = true;
    }
    ({ projectId } = await libraryWithProject(app, page, { library: S2_LIBRARY, project: S2_PROJECT, governanceYaml: LOOKUP_RULES }));
    mkdirSync(join(app.root, "sources"), { recursive: true });
    writeFileSync(pdf, await buildDoiPdf());
  });

  await test.step("attach it by typing its path into the drop area", async () => {
    await expect(page.getByRole("region", { name: `Attach files to ${S2_PROJECT}` })).toBeVisible();
    await attachByTyping(page, [pdf]);
    const outcome = page.getByRole("list", { name: "Attached files" }).getByRole("listitem");
    await expect(outcome).toContainText("doi-article.pdf");
    await expect(outcome).not.toContainText(/failed/i);
  });

  await test.step("the source appears titled from the recorded Crossref answer", async () => {
    const table = page.getByRole("table", { name: "Sources" });
    await expect(table.getByRole("button", { name: CROSSREF_TITLE, exact: true })).toBeVisible();
    const listed = (await app.api<SourceList>("GET", `/projects/${projectId}/sources`)).body;
    expect(listed.items.map((i) => i.title)).toEqual([CROSSREF_TITLE]);
    sourceId = listed.items[0]!.id;
  });

  await test.step("the stored source says where its title came from: the Crossref lookup of its DOI", async () => {
    const stored = (await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${sourceId}`)).body;
    expect(stored.source.identifiers?.doi).toBe(DOI);
    const title = stored.fieldEvidence.filter((e) => e.field === "/title");
    expect(title, JSON.stringify(stored.fieldEvidence)).toEqual(expect.arrayContaining([expect.objectContaining({ value: CROSSREF_TITLE, source: expect.objectContaining({ kind: "lookup", provider: "crossref" }) })]));
  });

  await test.step("open it", async () => {
    await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: CROSSREF_TITLE, exact: true }).click();
    const detail = page.getByRole("region", { name: "Source details" });
    await expect(detail.getByRole("heading", { level: 2, name: CROSSREF_TITLE })).toBeVisible();
  });

  let copiedText = "";
  let sent: unknown;
  await test.step("copy an APA citation with the cite panel", async () => {
    const cite = page.getByRole("region", { name: "Source details" }).getByRole("region", { name: "Cite" });
    await expect(cite.getByText("Using: American Psychological Association 7th edition")).toBeVisible();
    const answered = page.waitForResponse((r) => r.url() === `${app.baseUrl}/cite` && r.request().method() === "POST");
    await cite.getByRole("button", { name: "Copy citation" }).click();
    const response = await answered;
    expect(response.status()).toBe(200);
    sent = response.request().postDataJSON();
    copiedText = ((await response.json()) as { text: string }).text;
    expect(sent).toEqual({ projectId, refs: [{ sourceId }], style: "apa", format: "text" });
    // The page shows the citation it copied, as text.
    await expect(cite.getByText(copiedText, { exact: true })).toBeVisible();
  });

  await test.step("the copied text equals what POST /cite returns for that source", async () => {
    const direct = await app.api<{ text: string }>("POST", "/cite", sent);
    expect(direct.status).toBe(200);
    expect(copiedText).toBe(direct.body.text);
    // The cite panel copies an in-text citation: APA's author-date form, from the Crossref authors and year.
    expect(copiedText).toBe("(Okafor & Lindqvist, 2021)");
    const cite = page.getByRole("region", { name: "Source details" }).getByRole("region", { name: "Cite" });
    if (canReadClipboard) {
      await expect(cite.getByText("Copied.", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(direct.body.text);
    } else {
      // WebKit: Playwright grants no clipboard permissions there, so the page's own report and the
      // request the UI sent stand in for reading the clipboard back. Either the copy succeeded, or the
      // page says plainly that copying is not available and shows the citation to select.
      const copied = cite.getByText("Copied.", { exact: true });
      const refused = cite.getByRole("alert").filter({ hasText: "Copying is not available here." });
      await expect(copied.or(refused)).toBeVisible();
    }
  });
});

// ---------- scenario 5 ----------

const INTERFACE_FACE = "Atkinson Hyperlegible";

test("scenario 5: dark theme and another interface typeface survive a reload, stored in the app's settings folder, not in the library", async ({ page, app }) => {
  let libraryPath = "";
  const html = () => page.locator("html");
  const interfaceFont = () => page.evaluate(() => getComputedStyle(document.body).fontFamily);

  await test.step("set-up: a library with a project (through the service); Appearance opened from the library", async () => {
    ({ libraryPath } = await libraryWithProject(app, page, { library: "Appearance library", project: "Any project" }));
    expect(await interfaceFont()).not.toMatch(new RegExp(`^["']?${INTERFACE_FACE}`));
    await page.getByRole("link", { name: "Appearance" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
  });

  await test.step("choose the dark theme and the Atkinson Hyperlegible interface typeface", async () => {
    const saved = () => page.waitForResponse((r) => r.url() === `${app.baseUrl}/settings/appearance` && r.request().method() === "PUT" && r.ok());
    let s = saved();
    await page.getByRole("group", { name: "Color theme" }).getByRole("radio", { name: "Dark" }).check();
    await s;
    await expect(html()).toHaveAttribute("data-theme", "dark");
    s = saved();
    await page.getByRole("combobox", { name: "Interface typeface" }).selectOption({ label: "Atkinson Hyperlegible (bundled, readability)" });
    await s;
    expect(await interfaceFont()).toMatch(new RegExp(`^["']?${INTERFACE_FACE}["']?,`));
  });

  await test.step("reload: both persist", async () => {
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
    await expect(html()).toHaveAttribute("data-theme", "dark");
    await expect.poll(interfaceFont).toMatch(new RegExp(`^["']?${INTERFACE_FACE}["']?,`));
    await expect(page.getByRole("group", { name: "Color theme" }).getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Interface typeface" })).toHaveValue(INTERFACE_FACE);
  });

  await test.step("stored in the app's settings folder (appearance.json), not in the library", async () => {
    const file = join(app.configDir, "appearance.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { theme: string; fonts: { interface: { family: string; source: string } } };
    expect(stored.theme).toBe("dark");
    expect(stored.fonts.interface).toMatchObject({ family: INTERFACE_FACE, source: "bundled" });
    const inLibrary = filesUnder(libraryPath).filter((f) => /appearance/i.test(f) || readFileSync(join(libraryPath, f)).toString("latin1").includes(INTERFACE_FACE));
    expect(inLibrary).toEqual([]);
  });
});

// ---------- scenario 7 ----------

const S7_LIBRARY = "Coastal library";
const S7_PROJECT = "Harbour records";
const S7_TITLES = ["Tide notes from the estuary", "Harbour ledger of 1932", "Salt marsh survey"];

/** library.sqlite and its SQLite side files. */
const INDEX_FILES = ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"];

/**
 * Files whose content may change across a relaunch by design: the lock and the index. An audit
 * log (append-only .jsonl) may gain lines, so the old one must be its exact beginning.
 */
const VOLATILE = (f: string) => INDEX_FILES.includes(f) || f.startsWith("library.sqlite") || f === ".lock" || f.endsWith("/.lock") || f.startsWith(".tmp") || f.startsWith(".ao-");

/** Reads every file of the library except the index and the lock. */
function snapshot(root: string): Map<string, Buffer> {
  return new Map(filesUnder(root).filter((f) => !VOLATILE(f)).map((f) => [f, readFileSync(join(root, f))]));
}

/** Files of `before` missing or changed in `root` now. */
function lostOrChanged(root: string, before: Map<string, Buffer>): string[] {
  return [...before].flatMap(([f, was]) => {
    if (!existsSync(join(root, f))) return [`${f}: missing`];
    const now = readFileSync(join(root, f));
    const same = /(^|\/)audit\/[^/]+\.jsonl$/u.test(f) ? now.subarray(0, was.length).equals(was) : now.equals(was);
    return same ? [] : [`${f}: changed`];
  });
}

/** A library with a project and three attached PDFs, shown in the library list. */
async function threeSources(app: AppHarness, page: Page) {
  const made = await libraryWithProject(app, page, { library: S7_LIBRARY, project: S7_PROJECT });
  mkdirSync(join(app.root, "sources"), { recursive: true });
  const paths = [];
  for (const [i, title] of S7_TITLES.entries()) {
    const p = join(app.root, "sources", `source-${i + 1}.pdf`);
    writeFileSync(p, await buildPdf({ title, extra: `s7-${i}` }));
    paths.push(p);
  }
  await attachByTyping(page, paths);
  const table = page.getByRole("table", { name: "Sources" });
  for (const t of S7_TITLES) await expect(table.getByRole("button", { name: t, exact: true })).toBeVisible();
  return made;
}

/** Stops the service, deletes the index while it is stopped, and starts it again on the same settings. */
async function relaunchWithoutIndex(app: AppHarness, libraryPath: string): Promise<Map<string, Buffer>> {
  let before = new Map<string, Buffer>();
  await app.restart(async () => {
    expect(existsSync(join(libraryPath, "library.sqlite")), "the index exists before it is deleted").toBe(true);
    before = snapshot(libraryPath);
    for (const f of INDEX_FILES) rmSync(join(libraryPath, f), { force: true });
    expect(INDEX_FILES.filter((f) => existsSync(join(libraryPath, f)))).toEqual([]);
  });
  return before;
}

/** After a relaunch: opens the library from the chooser (D5: the app does not reopen it by itself). */
async function openFromChooser(page: Page, name: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

const D8: Defect = { id: "D8", title: "opening a library whose library.sqlite was deleted rebuilds the index from the files, so its sources are listed and found by search (spec 4.3, 9)" };

test("scenario 7: delete library.sqlite while the service is stopped, start it again: the index is rebuilt, search works, nothing on disk is lost", async ({ page, app }) => {
  let libraryPath = "";
  let projectId = "";
  let before = new Map<string, Buffer>();

  await test.step("set-up: a library with a project (through the service); three PDFs attached by typing their paths", async () => {
    ({ libraryPath, projectId } = await threeSources(app, page));
    expect((await app.api<SourceList>("GET", `/projects/${projectId}/sources`)).body.total).toBe(3);
  });

  await test.step("stop the service, delete library.sqlite and its -wal and -shm, start the service again", async () => {
    before = await relaunchWithoutIndex(app, libraryPath);
    expect(before.size).toBeGreaterThan(0);
  });

  await test.step("open the library again from the chooser", async () => {
    await openFromChooser(page, S7_LIBRARY);
    expect(existsSync(join(libraryPath, "library.sqlite")), "a new index file").toBe(true);
  });

  await test.step("nothing on disk was lost: every file but the index is still there, unchanged", async () => {
    expect(lostOrChanged(libraryPath, before)).toEqual([]);
  });

  await blockedBy(D8);

  await test.step("D8: the index rebuilt through the service instead (POST /libraries/rebuild-index; the app has no control for it)", async () => {
    const rebuilt = await app.api<{ indexed: number; lockedProjects: number; errors: number }>("POST", "/libraries/rebuild-index");
    expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
    expect(rebuilt.body).toMatchObject({ indexed: 3, errors: 0 });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: S7_LIBRARY })).toBeVisible();
  });

  await test.step("the index is rebuilt: the project's three sources are listed again", async () => {
    await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: S7_PROJECT }).click();
    const table = page.getByRole("table", { name: "Sources" });
    for (const t of S7_TITLES) await expect(table.getByRole("button", { name: t, exact: true })).toBeVisible();
    // No rebuild banner is left once it has finished.
    await expect(page.getByText(/Index rebuilding/)).toHaveCount(0);
  });

  await test.step("search finds a source by a word in its title", async () => {
    await page.getByRole("searchbox", { name: "Search sources" }).fill("ledger");
    const table = page.getByRole("table", { name: "Sources" });
    await expect(table.getByRole("button", { name: "Harbour ledger of 1932", exact: true })).toBeVisible();
    await expect(table.getByRole("button", { name: "Salt marsh survey", exact: true })).toHaveCount(0);
    const found = (await app.api<SourceList>("GET", `/projects/${projectId}/sources?text=ledger`)).body;
    expect(found.items.map((i) => i.title)).toEqual(["Harbour ledger of 1932"]);
  });
});

// ---------- the steps the scenarios cannot do yet, each on its own (expected to fail while the defect reproduces) ----------

test(`${D8.id}: ${D8.title}`, async ({ page, app }) => {
  const { libraryPath, projectId } = await threeSources(app, page);
  await relaunchWithoutIndex(app, libraryPath);
  await openFromChooser(page, S7_LIBRARY);
  expectDefect(D8);
  expect((await app.api<SourceList>("GET", `/projects/${projectId}/sources`)).body.total, "the three sources listed after the reopen").toBe(3);
  const found = (await app.api<SourceList>("GET", `/projects/${projectId}/sources?text=ledger`)).body;
  expect(found.items.map((i) => i.title)).toEqual(["Harbour ledger of 1932"]);
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: S7_PROJECT }).click();
  await page.getByRole("searchbox", { name: "Search sources" }).fill("ledger");
  await expect(page.getByRole("table", { name: "Sources" }).getByRole("button", { name: "Harbour ledger of 1932", exact: true })).toBeVisible({ timeout: DEFECT_TIMEOUT });
});
