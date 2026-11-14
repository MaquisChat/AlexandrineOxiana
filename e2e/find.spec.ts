/**
 * Find and acquire, slice 1, end to end (Task F7; plan Amendments A2–A5; Rulings R130, R173, R249): the real
 * service, the real runner and the real screen, in Chromium and in WebKit.
 *
 * The search services are answered by the harness's recorded lookup answers (AO_LOOKUP_FIXTURES, honoured only
 * under NODE_ENV=test; R47, R130, R249): packages/library/tests/fixtures/lookup/answers.json names, for the exact
 * address the search code asks for each line typed here, a Crossref answer recorded from the service and an
 * OpenAlex answer built by hand from OpenAlex's own records of the work (`…-handbuilt.json`). An address without a
 * recorded answer fails and nothing is fetched: the entry then waits to be tried again and never completes, so a
 * missing answer shows here as a wrong state.
 *
 * The three typed lines and the clause of the rule "sure enough" (`decideMatch`, packages/library/src/find/search.ts)
 * that decides each, against the recorded answers:
 *  - SURE_A, Lamont and Molnár's article with its year: every condition holds on the whole title (all its words
 *    typed; "Lamont" a creator's family name; no word unexplained — "Molnar" is a creator's name, "and" a small
 *    word; the year 2002 matches; no other answer has a title close to it; the next best scores 0.7, more than
 *    0.2 below 1): the record is completed without asking.
 *  - CHOOSE_B, Geertz's essay without a year: the same essay is offered in five books and journals with different
 *    DOIs and ISBNs (rule 5, other editions: titles alike, the records not provably one work), so the app asks.
 *  - SURE_C, Vaisey's article with its year: sure as SURE_A (the next best scores 0.6).
 *
 * Every wait is for something the screen shows (a state in words, a count, a row) with a generous limit (R173):
 * lookups are paced by the product (Crossref one at a time) and the machine may be loaded.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR } from "./paths.js";

// ---------- what is typed, and what the recorded answers say ----------

const SURE_A = "Lamont and Molnar, The Study of Boundaries in the Social Sciences 2002";
const CHOOSE_B = "Geertz, Deep Play: Notes on the Balinese Cockfight";
const SURE_C = "Vaisey, Motivation and Justification: A Dual-Process Model of Culture in Action 2009";

/** The works, as Crossref's recorded answers give them. */
const WORK_A = { title: "The Study of Boundaries in the Social Sciences", doi: "10.1146/annurev.soc.28.110601.141107", families: ["Lamont", "Molnár"], given: ["Michèle", "Virág"], year: 2002, issued: "2002-08" };
const WORK_C = { title: "Motivation and Justification: A Dual‐Process Model of Culture in Action", doi: "10.1086/597179", families: ["Vaisey"], given: ["Stephen"], year: 2009, issued: "2009-05" };
/** The five works offered for CHOOSE_B, likeliest first (the one OpenAlex gave too is first among equals). */
const B_DOIS = ["10.1007/978-1-349-62397-6_10", "10.2307/jj.36106134.16", "10.4324/9781003578123-32", "10.1162/001152605774431563", "10.1525/9780520340343-007"];
/** The one chosen with the mouse: Daedalus's reprint of the essay (2005). */
const B_CHOSEN = { doi: "10.1162/001152605774431563", title: "Deep play: notes on the Balinese cockfight" };

/** Words typed here that also stand in the works' titles, looked for where they must never be. */
const TYPED_WORDS = ["Cockfight", "Balinese", "Boundaries", "Molnar"];

/** Rules of a project without identifiable data whose lookups are the defaults (Crossref and OpenAlex allowed). */
const LOOKUP_RULES = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n";
/** Kept out of titles and logs; a test fixture, not a secret of anyone's. */
const PASSPHRASE = "plain test passphrase for the second room";

/** Generous: lookups, record creation and the queue's reads run in the service on a machine that may be loaded. */
const STATE_TIMEOUT = 60_000;

// ---------- the screen's words (packages/ui/src/components/FindEntryRow.tsx, screens/FindAcquire.tsx, ChooseWorkDialog.tsx) ----------

const WORDS = {
  recordComplete: "Record complete",
  already: "Already in your library",
  matches: (k: number) => (k === 1 ? "1 possible match" : `${k} possible matches`),
  elsewhere: (name: string) => `Already in your project ${name}`,
  elsewhereLocked: "Already in another project that is locked now.",
  lockedCount: (k: number) => (k === 1 ? "1 locked project was not checked" : `${k} locked projects were not checked`),
};

/** A row control's accessible name: "<Act>: “<typed, cut at 80 characters + …>”" (FindEntryRow.tsx shortTyped). */
function act(text: string, typed: string): string {
  const chars = Array.from(typed);
  return `${text}: “${chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : typed}”`;
}

// ---------- shared ----------

interface SourceList {
  total: number;
  items: Array<{ id: string; title: string; creatorsText: string; issuedYear?: string | number | null; type: string }>;
}
interface StoredSource {
  source: {
    id: string;
    title: { variants: Array<{ value: string }> };
    identifiers?: { doi?: string };
    creators: Array<{ family?: string; given?: string }>;
    issued?: string;
    collectionIds: string[];
    provenance?: { captureMethod: string; identification?: { method: string } };
  };
}
interface QueueView {
  entries: Array<{ id: string; typed: string; state: string; updatedAt: string; sourceId?: string; duplicateOf?: string; elsewhere?: true; chosen?: string }>;
}

const queue = (page: Page) => page.getByRole("list", { name: "Queue" });
const rows = (page: Page) => queue(page).getByRole("listitem");
const stateOf = (page: Page, i: number) => rows(page).nth(i).locator(".ao-find__state");

/** The Find and acquire screen for a project (by its address, as the Library screen's link leads there). */
async function openFind(page: Page, projectId: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/find?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Find and acquire" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "References" })).toBeEnabled({ timeout: STATE_TIMEOUT });
}

/**
 * Types the lines into the box and presses "Add"; waits for what the screen shows once the add is answered: the box
 * emptied and one more row per line. (The polite status region says "Added N references." first, but a row's change
 * of state may replace it at once, so it is not what is waited for.)
 */
async function addLines(page: Page, lines: string[]): Promise<void> {
  const before = await rows(page).count();
  const box = page.getByRole("textbox", { name: "References" });
  await box.fill(lines.join("\n"));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(box).toHaveValue("", { timeout: STATE_TIMEOUT });
  await expect(rows(page)).toHaveCount(before + lines.length, { timeout: STATE_TIMEOUT });
}

async function sources(app: AppHarness, projectId: string, query = ""): Promise<SourceList> {
  const r = await app.api<SourceList>("GET", `/projects/${projectId}/sources?limit=500${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

async function stored(app: AppHarness, projectId: string, sourceId: string): Promise<StoredSource> {
  const r = await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${sourceId}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** The DOI of every source of the project (read from each stored record). */
async function doisOf(app: AppHarness, projectId: string): Promise<string[]> {
  const list = await sources(app, projectId);
  const out: string[] = [];
  for (const i of list.items) out.push((await stored(app, projectId, i.id)).source.identifiers?.doi ?? "");
  return out.sort();
}

/** What the queue shows, row by row: the entry's id, what was typed and the state in words. */
async function shownQueue(page: Page): Promise<Array<{ id: string; typed: string; state: string }>> {
  return rows(page).evaluateAll((lis) =>
    lis.map((li) => ({
      id: (li as HTMLElement).dataset.entryId ?? "",
      typed: li.querySelector("[data-entry-text]")?.textContent ?? "",
      state: li.querySelector(".ao-find__state")?.textContent ?? "",
    })),
  );
}

async function queueOf(app: AppHarness, projectId: string): Promise<QueueView> {
  const r = await app.api<QueueView>("GET", `/projects/${projectId}/find`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** The project's queue file as it is on disk (an unencrypted project: plain JSON lines). */
const queueFile = (libraryPath: string, projectFolder: string) => readFileSync(join(libraryPath, projectFolder, "find", "queue.jsonl"), "utf8");

/** The record shown in place on the Find screen (region "Record"): its title and fields. */
async function expectRecordShown(page: Page, w: { title: string; families: string[]; doi: string; issued: string }): Promise<void> {
  const detail = page.getByRole("region", { name: "Record" }).getByRole("region", { name: "Source details" });
  await expect(detail.getByRole("heading", { level: 2, name: w.title, exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
  for (const f of w.families) await expect(detail.getByRole("listitem").filter({ hasText: f })).toHaveCount(1);
  await expect(detail.getByText(w.issued, { exact: true })).toBeVisible();
  await expect(detail.getByText(w.doi, { exact: true })).toBeVisible();
}

/**
 * Plants works in a project of the library with the library's own code (as review-queue.spec.ts plants a source),
 * while the service is stopped: each a journal article with its true title, creators, date and DOI. An encrypted
 * project is unlocked with its passphrase in that process first. Returns the planted sources' ids.
 */
function plantWorks(app: AppHarness, o: { library: string; projectId: string; passphrase?: string; works: Array<typeof WORK_A> }): string[] {
  const code = [
    'import { KeyRing, createIndexSink, deviceDeps, openIndexChecked, openLibrary, openRepo } from "./src/index.ts";',
    "const o = JSON.parse(process.env.AO_E2E_PLANT);",
    "const lib = await openLibrary(o.library, deviceDeps(o.configDir));",
    "const checked = await openIndexChecked(lib.root);",
    "const ring = new KeyRing();",
    "const repo = await openRepo(lib, ring, { index: createIndexSink(checked.handle, { root: lib.root, keyRing: ring }) });",
    "if (process.env.AO_E2E_PLANT_SECRET) await repo.unlockProject(o.projectId, process.env.AO_E2E_PLANT_SECRET);",
    "const at = new Date().toISOString();",
    "const ids = [];",
    "for (const w of o.works) {",
    "  const made = await repo.createSource(o.projectId, {",
    "    projectIds: [], type: 'article-journal', title: { variants: [{ lang: 'en', kind: 'original', value: w.title }] },",
    "    creators: w.families.map((family, i) => ({ family, given: w.given[i], role: 'author' })), issued: w.issued, identifiers: { doi: w.doi },",
    "    caseAttributes: {}, availability: { status: 'available' }, collectionIds: [], tagIds: [], participantIds: [],",
    "  }, [], {",
    "    provenance: { captureMethod: 'manual_upload', capturedAt: at, tool: { name: 'e2e-plant', version: '1' }, fileHashes: {}, legal: { status: 'public' }, identifiable: false },",
    "    fieldEvidence: [],",
    "  });",
    "  ids.push(made.source.id);",
    "}",
    "checked.handle.close();",
    "await lib.close();",
    "process.stdout.write(JSON.stringify(ids));",
  ].join("\n");
  const env: NodeJS.ProcessEnv = { ...process.env, AO_E2E_PLANT: JSON.stringify({ library: o.library, projectId: o.projectId, configDir: app.configDir, works: o.works }) };
  if (o.passphrase) env.AO_E2E_PLANT_SECRET = o.passphrase;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: LIBRARY_DIR, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Planting the works failed (status ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as string[];
}

// ---------- the plan's first scenario ----------

test("add, choose, complete, already, survives a restart", async ({ page, app }) => {
  let projectId = "";
  let libraryPath = "";
  let projectFolder = "";
  let collectionId = "";

  await test.step("set-up: a library, a project with the default lookups and a collection (through the service)", async () => {
    ({ projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: "Reading library", project: "Boundary work", governanceYaml: LOOKUP_RULES }));
    const c = await app.api<{ id: string }>("POST", `/projects/${projectId}/collections`, { name: "To read" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    collectionId = c.body.id;
  });

  await test.step("from the library, the link “Find and acquire”; the collection “To read” chosen", async () => {
    await page.reload(); // the collection made through the service is listed on the next read
    await page.getByRole("link", { name: "Find and acquire", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Find and acquire" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(projectId);
    await page.getByRole("combobox", { name: "Collection" }).selectOption({ label: "To read" });
    await expect(page.getByRole("combobox", { name: "Collection" })).toHaveValue(collectionId);
  });

  await test.step("two references typed: one becomes a complete record by itself, the other asks to choose", async () => {
    await addLines(page, [SURE_A, CHOOSE_B]);
    await expect(rows(page)).toHaveCount(2);
    await expect(stateOf(page, 0)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(stateOf(page, 1)).toHaveText(WORDS.matches(5), { timeout: STATE_TIMEOUT });
    await expect(rows(page).nth(0).locator("[data-entry-text]")).toHaveText(SURE_A);
    await expect(rows(page).nth(1).locator("[data-entry-text]")).toHaveText(CHOOSE_B);
  });

  await test.step("the library holds the record: in the project and the collection, with its title, authors and year", async () => {
    const all = await sources(app, projectId);
    expect(all.items.map((i) => i.title)).toEqual([WORK_A.title]);
    const inCollection = await sources(app, projectId, `&collection=${collectionId}`);
    expect(inCollection.items.map((i) => i.id)).toEqual([all.items[0]!.id]);
    const s = await stored(app, projectId, all.items[0]!.id);
    expect(s.source.identifiers?.doi).toBe(WORK_A.doi);
    expect(s.source.creators.map((c) => c.family)).toEqual(WORK_A.families);
    expect(s.source.issued).toBe(WORK_A.issued);
    expect(s.source.collectionIds).toEqual([collectionId]);
    expect(s.source.provenance).toMatchObject({ captureMethod: "reference_lookup", identification: { method: "find-match" } });
  });

  await test.step("the row's “Open” shows the record in place", async () => {
    await page.getByRole("button", { name: act("Open", SURE_A) }).click();
    await expectRecordShown(page, WORK_A);
    await page.getByRole("region", { name: "Record" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("region", { name: "Record" })).toHaveCount(0);
  });

  await test.step("“Choose”: the five works offered, “None of these” last; one chosen with “Use this one”", async () => {
    await page.getByRole("button", { name: act("Choose", CHOOSE_B) }).click();
    const dialog = page.getByRole("dialog", { name: `Choose the work for “${CHOOSE_B}”` });
    await expect(dialog).toBeVisible();
    const radios = dialog.getByRole("radio");
    await expect(radios).toHaveCount(6);
    await expect(radios.nth(5)).toHaveAccessibleName("None of these");
    for (const [i, doi] of B_DOIS.entries()) await expect(radios.nth(i)).toHaveAccessibleDescription(new RegExp(doi.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
    await expect(dialog.getByRole("button", { name: "Use this one" })).toBeDisabled();
    await radios.nth(B_DOIS.indexOf(B_CHOSEN.doi)).check();
    await dialog.getByRole("button", { name: "Use this one" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(stateOf(page, 1)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
  });

  await test.step("after the choice: exactly one source for the chosen work and none for the others", async () => {
    const dois = await doisOf(app, projectId);
    expect(dois).toEqual([WORK_A.doi, B_CHOSEN.doi].sort());
    for (const other of B_DOIS.filter((d) => d !== B_CHOSEN.doi)) expect(dois).not.toContain(other);
    const chosen = (await sources(app, projectId)).items.find((i) => i.title === B_CHOSEN.title);
    expect(chosen, "the chosen work is listed with its own title").toBeTruthy();
    expect((await stored(app, projectId, chosen!.id)).source.provenance).toMatchObject({ captureMethod: "reference_lookup", identification: { method: "find-chosen" } });
  });

  await test.step("the first reference typed again: “Already in your library”, and still one source of it", async () => {
    await addLines(page, [SURE_A]);
    await expect(rows(page)).toHaveCount(3);
    await expect(stateOf(page, 2)).toHaveText(WORDS.already, { timeout: STATE_TIMEOUT });
    const dois = await doisOf(app, projectId);
    expect(dois.filter((d) => d === WORK_A.doi)).toHaveLength(1);
    expect(dois).toHaveLength(2);
  });

  await test.step("in the library's list: the two records with title, authors and year; opened from the row", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
    const table = page.getByRole("table", { name: "Sources" });
    await expect(table.getByRole("row")).toHaveCount(3, { timeout: STATE_TIMEOUT }); // the header and two sources
    const rowA = table.getByRole("row").filter({ has: page.getByRole("button", { name: WORK_A.title, exact: true }) });
    await expect(rowA).toContainText(WORK_A.families[0]!);
    await expect(rowA).toContainText(WORK_A.families[1]!);
    await expect(rowA.getByRole("cell").nth(2)).toHaveText(String(WORK_A.year));
    await rowA.getByRole("button", { name: WORK_A.title, exact: true }).click();
    const detail = page.getByRole("region", { name: "Source details" });
    await expect(detail.getByRole("heading", { level: 2, name: WORK_A.title, exact: true })).toBeVisible();
    await expect(detail.getByText(WORK_A.doi, { exact: true })).toBeVisible();
  });

  let before: Array<{ id: string; typed: string; state: string }> = [];
  let fileBefore = "";
  await test.step("quit and reopen the app: the queue shows the same entries, in the same order, in the same words", async () => {
    await openFind(page, projectId);
    await expect(stateOf(page, 2)).toHaveText(WORDS.already, { timeout: STATE_TIMEOUT });
    before = await shownQueue(page);
    expect(before.map((r) => r.state)).toEqual([WORDS.recordComplete, WORDS.recordComplete, WORDS.already]);
    fileBefore = queueFile(libraryPath, projectFolder);
    await app.restart();
    await openFind(page, projectId);
    await expect(rows(page)).toHaveCount(3, { timeout: STATE_TIMEOUT });
    await expect(stateOf(page, 2)).toHaveText(WORDS.already, { timeout: STATE_TIMEOUT });
    expect(await shownQueue(page)).toEqual(before);
  });

  await test.step("nothing was looked up again: the queue file is unchanged and the library holds the same two records", async () => {
    // Read the queue through the service once more. A read of the queue does not wait for the runner, so this step shows only that, some time after the
    // restart and the page's load, the queue file's bytes and the entries' stamps are unchanged; the later step in which a candidate is chosen after
    // the restart shows that the runner has acted since.
    expect((await queueOf(app, projectId)).entries.map((e) => e.state).sort()).toEqual(["already", "record-complete", "record-complete"]);
    expect(queueFile(libraryPath, projectFolder)).toBe(fileBefore);
    expect(await doisOf(app, projectId)).toEqual([WORK_A.doi, B_CHOSEN.doi].sort());
  });
});

// ---------- the plan's second scenario ----------

test("Check everything I have finds the other project", async ({ page, app }) => {
  const SECOND = "Second reading room";
  let projectId = "";
  let libraryPath = "";
  let projectFolder = "";
  let secondId = "";
  let planted: string[] = [];

  await test.step("set-up: a library, a project, and an encrypted second project holding the two works (planted while the service is stopped)", async () => {
    ({ projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: "Shared library", project: "First reading room", governanceYaml: LOOKUP_RULES }));
    const second = await app.api<{ project: { id: string } }>("POST", "/projects", { name: SECOND, governanceYaml: LOOKUP_RULES, encryption: { enabled: true, passphrase: PASSPHRASE } });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    secondId = second.body.project.id;
    await app.restart(async () => {
      planted = plantWorks(app, { library: libraryPath, projectId: secondId, passphrase: PASSPHRASE, works: [WORK_A, WORK_C] });
    });
    expect(planted).toHaveLength(2);
    // The relaunched app reopens the library when the page loads (as library.spec.ts's relaunch does).
    await page.goto(`${APP_ORIGIN}/`);
    await expect(page.getByRole("heading", { level: 1, name: "Shared library" })).toBeVisible({ timeout: STATE_TIMEOUT });
    const unlocked = await app.api("POST", `/projects/${secondId}/unlock`, { secret: PASSPHRASE });
    expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
    expect((await doisOf(app, secondId))).toEqual([WORK_A.doi, WORK_C.doi].sort());
  });

  await test.step("with the switch off, the first reference becomes a record in this project: the other project is not looked at", async () => {
    await openFind(page, projectId);
    const sw = page.getByRole("switch", { name: "Check everything I have" });
    await expect(sw).not.toBeChecked();
    await addLines(page, [SURE_A]);
    await expect(stateOf(page, 0)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    expect(await doisOf(app, projectId)).toEqual([WORK_A.doi]);
  });

  await test.step("with the switch on, the second reference is found in the other project, which the screen names", async () => {
    const sw = page.getByRole("switch", { name: "Check everything I have" });
    await sw.click();
    await expect(sw).toBeChecked();
    // The screen shows the switch checked at once; the service's runner judges duplicates with the stored value, so wait until the change is confirmed.
    await expect(sw).not.toHaveAttribute("aria-busy", "true");
    await addLines(page, [SURE_C]);
    await expect(stateOf(page, 1)).toHaveText(WORDS.elsewhere(SECOND), { timeout: STATE_TIMEOUT });
    await expect(page.getByRole("button", { name: act("Add it to this project as well", SURE_C) })).toBeVisible();
    // Nothing was made here for it.
    expect(await doisOf(app, projectId)).toEqual([WORK_A.doi]);
    // "Open it there" shows that project's record.
    await page.getByRole("button", { name: act("Open it there", SURE_C) }).click();
    await expectRecordShown(page, WORK_C);
  });

  await test.step("the other project locked: read again, the entry says it is in a project that is locked now", async () => {
    const locked = await app.api("POST", `/projects/${secondId}/lock`);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    await openFind(page, projectId);
    await expect(stateOf(page, 1)).toHaveText(WORDS.elsewhereLocked, { timeout: STATE_TIMEOUT });
    await expect(page.getByText(WORDS.lockedCount(1), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: act("Open it there", SURE_C) })).toHaveCount(0);
    await expect(stateOf(page, 0)).toHaveText(WORDS.recordComplete);
  });

  await test.step("nothing of the second project is written into the first project's queue", async () => {
    const file = queueFile(libraryPath, projectFolder);
    expect(file.length).toBeGreaterThan(0);
    expect(file.includes(secondId), "the second project's id is not in the first project's queue").toBe(false);
    for (const id of planted) expect(file.includes(id), `the planted source ${id} is not in the first project's queue`).toBe(false);
    expect(file.includes(SECOND)).toBe(false);
    const entry = (await queueOf(app, projectId)).entries.find((e) => e.typed === SURE_C);
    expect(entry).toMatchObject({ state: "already", elsewhere: true });
    expect(entry?.duplicateOf).toBeUndefined();
    expect(entry?.sourceId).toBeUndefined();
  });
});

// ---------- by keyboard only ----------

/** Tab (at most `max` times) until `target` holds focus. Fails if it never does. */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("by keyboard only: add, choose, use this one", async ({ page, app }) => {
  let projectId = "";
  await test.step("set-up: a library and a project (through the service); the screen opened by its address", async () => {
    ({ projectId } = await libraryWithProject(app, page, { library: "Keyboard library", project: "Keys only", governanceYaml: LOOKUP_RULES }));
    await openFind(page, projectId);
  });

  await test.step("Tab to the box, type two lines, Ctrl+Enter adds them", async () => {
    const box = page.getByRole("textbox", { name: "References" });
    await tabTo(page, box);
    await page.keyboard.type(SURE_A);
    await page.keyboard.press("Enter");
    await page.keyboard.type(CHOOSE_B);
    await expect(box).toHaveValue(`${SURE_A}\n${CHOOSE_B}`);
    await page.keyboard.press("Control+Enter");
    await expect(box).toHaveValue("", { timeout: STATE_TIMEOUT });
    await expect(rows(page)).toHaveCount(2, { timeout: STATE_TIMEOUT });
    await expect(box).toBeFocused();
    await expect(stateOf(page, 0)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(stateOf(page, 1)).toHaveText(WORDS.matches(5), { timeout: STATE_TIMEOUT });
  });

  await test.step("Tab to “Choose”, Enter opens the dialog with focus on the first work", async () => {
    await tabTo(page, page.getByRole("button", { name: act("Choose", CHOOSE_B) }));
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Choose the work for “${CHOOSE_B}”` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio").nth(0)).toBeFocused();
  });

  await test.step("the arrows move in the radio group; Tab reaches “Use this one”; Enter uses the first work", async () => {
    const dialog = page.getByRole("dialog", { name: `Choose the work for “${CHOOSE_B}”` });
    const radios = dialog.getByRole("radio");
    await page.keyboard.press("ArrowDown");
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).toBeChecked();
    await page.keyboard.press("ArrowUp");
    await expect(radios.nth(0)).toBeFocused();
    await expect(radios.nth(0)).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Use this one" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(stateOf(page, 1)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
  });

  await test.step("after the dialog closes, focus is on the row's next control (its “Open”), never the page", async () => {
    await expect(page.getByRole("button", { name: act("Open", CHOOSE_B) })).toBeFocused();
  });

  await test.step("the library holds the first work offered, once, and none of the others", async () => {
    const dois = await doisOf(app, projectId);
    expect(dois).toEqual([WORK_A.doi, B_DOIS[0]!].sort());
  });
});

// ---------- what was typed stays in request bodies ----------

// The scan covers every request's address, headers and body, and the service's log at its real level (info). It does NOT cover the service's
// debug-level lines (it logs at info, so they are never written) or the media worker's own output.
test("what was typed is in no address, header or log line", async ({ page, app }) => {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  const pending: Array<Promise<void>> = [];
  page.on("request", (r) => {
    pending.push(
      r.allHeaders().then(
        (headers) => void seen.push({ url: r.url(), method: r.method(), headers, body: r.postData() }),
        () => void seen.push({ url: r.url(), method: r.method(), headers: r.headers(), body: r.postData() }),
      ),
    );
  });
  let projectId = "";

  await test.step("set-up, then both references added and the choice made on the screen", async () => {
    ({ projectId } = await libraryWithProject(app, page, { library: "Quiet library", project: "Nothing said", governanceYaml: LOOKUP_RULES }));
    await openFind(page, projectId);
    await addLines(page, [SURE_A, CHOOSE_B]);
    await expect(stateOf(page, 0)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(stateOf(page, 1)).toHaveText(WORDS.matches(5), { timeout: STATE_TIMEOUT });
    await page.getByRole("button", { name: act("Choose", CHOOSE_B) }).click();
    const dialog = page.getByRole("dialog", { name: `Choose the work for “${CHOOSE_B}”` });
    await dialog.getByRole("radio").nth(0).check();
    await dialog.getByRole("button", { name: "Use this one" }).click();
    await expect(stateOf(page, 1)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await page.getByRole("button", { name: act("Open", SURE_A) }).click();
    await expectRecordShown(page, WORK_A);
  });

  await test.step("the typed words went in the add's request body", async () => {
    await Promise.all(pending);
    const adds = seen.filter((r) => r.method === "POST" && new URL(r.url).pathname === `/projects/${projectId}/find`);
    expect(adds).toHaveLength(1);
    expect(JSON.parse(adds[0]!.body ?? "{}")).toEqual({ lines: [SURE_A, CHOOSE_B] });
  });

  await test.step("no typed word in any address or header of any request the page made", async () => {
    await Promise.all(pending);
    expect(seen.length).toBeGreaterThan(5);
    for (const r of seen) {
      const url = decodeURIComponent(r.url).toLowerCase();
      const headers = JSON.stringify(r.headers).toLowerCase();
      for (const w of TYPED_WORDS) {
        expect(url.includes(w.toLowerCase()), `“${w}” is not in ${r.method} ${r.url}`).toBe(false);
        expect(headers.includes(w.toLowerCase()), `“${w}” is not in the headers of ${r.method} ${r.url}`).toBe(false);
      }
    }
  });

  await test.step("no typed word in the service's output (its standard output and error)", async () => {
    const log = app.log().toLowerCase();
    expect(log.length).toBeGreaterThan(0);
    for (const w of TYPED_WORDS) expect(log.includes(w.toLowerCase()), `“${w}” is not in the service's output`).toBe(false);
  });
});

// ---------- a restart in the middle ----------

test("after a restart nothing is looked up twice", async ({ page, app }) => {
  let projectId = "";
  let libraryPath = "";
  let projectFolder = "";
  let before: QueueView | undefined;
  let fileBefore = "";

  await test.step("set-up; both references added: one complete, one waiting for a choice", async () => {
    ({ projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: "Restart library", project: "Twice told", governanceYaml: LOOKUP_RULES }));
    await openFind(page, projectId);
    await addLines(page, [SURE_A, CHOOSE_B]);
    await expect(stateOf(page, 0)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(stateOf(page, 1)).toHaveText(WORDS.matches(5), { timeout: STATE_TIMEOUT });
    before = await queueOf(app, projectId);
    fileBefore = queueFile(libraryPath, projectFolder);
    expect(await doisOf(app, projectId)).toEqual([WORK_A.doi]);
  });

  await test.step("quit and reopen: the same entries in the same states, the same words; the queue file untouched", async () => {
    const shown = await shownQueue(page);
    await app.restart();
    await openFind(page, projectId);
    await expect(rows(page)).toHaveCount(2, { timeout: STATE_TIMEOUT });
    await expect(stateOf(page, 1)).toHaveText(WORDS.matches(5), { timeout: STATE_TIMEOUT });
    expect(await shownQueue(page)).toEqual(shown);
    const after = await queueOf(app, projectId);
    const key = (q: QueueView) => q.entries.map((e) => [e.id, e.state, e.updatedAt].join(" ")).sort();
    expect(key(after)).toEqual(key(before!));
    expect(queueFile(libraryPath, projectFolder)).toBe(fileBefore);
    expect(await doisOf(app, projectId)).toEqual([WORK_A.doi]);
  });

  await test.step("the entry left “Choose” can still be chosen after the restart", async () => {
    await page.getByRole("button", { name: act("Choose", CHOOSE_B) }).click();
    const dialog = page.getByRole("dialog", { name: `Choose the work for “${CHOOSE_B}”` });
    await dialog.getByRole("radio").nth(B_DOIS.indexOf(B_CHOSEN.doi)).check();
    await dialog.getByRole("button", { name: "Use this one" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(stateOf(page, 1)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    expect(await doisOf(app, projectId)).toEqual([WORK_A.doi, B_CHOSEN.doi].sort());
    // The first entry was not touched again.
    const a = (await queueOf(app, projectId)).entries.find((e) => e.typed === SURE_A)!;
    const a0 = before!.entries.find((e) => e.typed === SURE_A)!;
    expect([a.id, a.state, a.updatedAt]).toEqual([a0.id, "record-complete", a0.updatedAt]);
  });
});

// ---------- an author alone (Task F9; R267, R270, R271) ----------

/**
 * An author's name typed alone. The recorded answers (packages/library/tests/fixtures/lookup/answers.json) for the
 * addresses this line makes the app ask:
 *  - the works search: Crossref's answer recorded from the service (`crossref-find-stark.json`: five entries ABOUT
 *    people named David Stark, none a title the line covers) and OpenAlex's built by hand from five of the
 *    sociologist's works (`openalex-find-stark-handbuilt.json`) — no title covers 0.6 of the line, it holds no digit
 *    and two words, so the people search is asked (`peopleSearchWanted`);
 *  - the people search: built by hand from OpenAlex's own records of two real people of that name (the sociologist,
 *    A5055013655, and a historian of colonial Brazil, A5108208998; `openalex-find-stark-people-handbuilt.json`) — both
 *    names cover both typed words, so the app asks which person is meant (`decidePerson`: "several");
 *  - the sociologist's works, newest first: built by hand from OpenAlex's records of eighteen of his works, each read
 *    by its DOI (`openalex-find-stark-works-handbuilt.json`, one page, its count 18);
 *  - each work ticked: OpenAlex's single-work answer recorded from the service (`openalex-work-W….json`), whose DOI
 *    and title are those kept for choosing, so each record is made without asking (R271 M4).
 */
const AUTHOR = "David Stark";
/** What tells the sociologist from the other David Stark in the dialog: the first subject he works on. */
const PERSON_SUBJECT = "Post-Communist Economic and Political Transition";
const OTHER_SUBJECT = "Colonialism, slavery, and trade";
/** His works listed (all 18), and those from 2015 on (the filter "From year" used once). */
const STARK_LISTED = 18;
const STARK_FROM_2015 = 6;
/** The three works ticked, with the DOIs their records must carry. */
const STARK_TICKED = [
  { title: "Put to the test: For a new sociology of testing", doi: "10.1111/1468-4446.12746" },
  { title: "For What It’s Worth", doi: "10.1108/s0733-558x20170000052011" },
  { title: "Game Changer: The Topology of Creativity", doi: "10.1086/681213" },
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("an author alone, the person, three works", async ({ page, app }) => {
  let projectId = "";
  const authorRow = () => rows(page).filter({ has: page.locator("[data-entry-text]", { hasText: `Author: ${AUTHOR}` }) });
  const addedRows = () => rows(page).filter({ has: page.locator(".ao-find__origin", { hasText: `Added from “${AUTHOR}”` }) });

  await test.step("set-up: a library and a project with the default lookups; the screen opened", async () => {
    ({ projectId } = await libraryWithProject(app, page, { library: "Author library", project: "One person's works", governanceYaml: LOOKUP_RULES }));
    await openFind(page, projectId);
  });

  await test.step("the name typed alone: the row reads “Author: David Stark” and “2 people match”", async () => {
    await addLines(page, [AUTHOR]);
    await expect(authorRow()).toHaveCount(1);
    await expect(authorRow().locator(".ao-find__state")).toHaveText("2 people match", { timeout: STATE_TIMEOUT });
    // Nothing was made by itself.
    expect((await sources(app, projectId)).total).toBe(0);
  });

  await test.step("“Choose the person”: the two people, told apart by what they work on; the sociologist chosen", async () => {
    await page.getByRole("button", { name: act("Choose the person", AUTHOR) }).click();
    const dialog = page.getByRole("dialog", { name: `Choose the person for “${AUTHOR}”` });
    await expect(dialog).toBeVisible();
    const people = dialog.getByRole("radio", { name: AUTHOR, exact: true });
    await expect(people).toHaveCount(2, { timeout: STATE_TIMEOUT });
    await expect(people.nth(0)).toBeFocused();
    await expect(people.nth(0)).toHaveAccessibleDescription(new RegExp(escapeRe(`Works on: ${PERSON_SUBJECT}`)));
    await expect(people.nth(1)).toHaveAccessibleDescription(new RegExp(escapeRe(`Works on: ${OTHER_SUBJECT}`)));
    await expect(dialog.getByText("To choose another person later, remove this entry and type the name again.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "This is the person" })).toBeDisabled();
    await people.nth(0).check();
    await dialog.getByRole("button", { name: "This is the person" }).click();
    await expect(dialog).toHaveCount(0);
    // The works are fetched by the runner; the row says so when they have come.
    await expect(authorRow().locator(".ao-find__state")).toHaveText("Choose works", { timeout: STATE_TIMEOUT });
  });

  await test.step("“Choose works”: his 18 works newest first; “From year” 2015 narrows them to 6; three ticked and added", async () => {
    await page.getByRole("button", { name: act("Choose works", AUTHOR) }).click();
    const dialog = page.getByRole("dialog", { name: `Choose works by ${AUTHOR}` });
    await expect(dialog).toBeVisible();
    const works = dialog.getByRole("checkbox");
    await expect(works).toHaveCount(STARK_LISTED, { timeout: STATE_TIMEOUT });
    await expect(dialog.getByRole("status")).toHaveText(`${STARK_LISTED} of ${STARK_LISTED} works shown`);
    await expect(dialog.getByRole("textbox", { name: "From year" })).toBeFocused();
    await dialog.getByRole("textbox", { name: "From year" }).fill("2015");
    await expect(works).toHaveCount(STARK_FROM_2015);
    await expect(dialog.getByRole("status")).toHaveText(`${STARK_FROM_2015} of ${STARK_LISTED} works shown`);
    for (const w of STARK_TICKED) await dialog.getByRole("checkbox", { name: new RegExp(`^${escapeRe(w.title)}`) }).check();
    await dialog.getByRole("button", { name: "Add the chosen works (3)" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: act("Choose works", AUTHOR) })).toBeFocused();
  });

  await test.step("three rows that say where they came from, each reaching “Record complete”", async () => {
    await expect(addedRows()).toHaveCount(3, { timeout: STATE_TIMEOUT });
    for (let i = 0; i < 3; i++) await expect(addedRows().nth(i).locator(".ao-find__state")).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    const shown = (await addedRows().locator(".ao-find__match .ao-find__work").allTextContents()).sort();
    expect(shown).toEqual(STARK_TICKED.map((w) => w.title).sort());
  });

  await test.step("the three sources in the library, each with its work's DOI, made from the works chosen", async () => {
    expect(await doisOf(app, projectId)).toEqual(STARK_TICKED.map((w) => w.doi).sort());
    for (const item of (await sources(app, projectId)).items) {
      expect((await stored(app, projectId, item.id)).source.provenance).toMatchObject({ captureMethod: "reference_lookup", identification: { method: "find-chosen" } });
    }
  });

  await test.step("the author's row stays “Choose works”, with “3 added”, and can still be removed", async () => {
    await expect(authorRow().locator(".ao-find__state")).toHaveText("Choose works · 3 added");
    await expect(page.getByRole("button", { name: act("Remove from the queue", AUTHOR) })).toBeVisible();
    const q = await queueOf(app, projectId);
    expect(q.entries.find((e) => e.typed === AUTHOR)?.state).toBe("choose-works");
  });
});
