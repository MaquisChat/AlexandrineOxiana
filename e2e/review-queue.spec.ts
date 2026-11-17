/**
 * The project's whole review queue (Task 67, D14, R172) against the real service and worker.
 *
 *  - A file attached by drag and drop that needs review: its library row carries "Needs review"; the
 *    badge leads to the review queue at that source; the entry is decided there; back in the library
 *    (in the app, no reload) the badge is gone.
 *  - Scenario 11's queue step: a planted DOI and title conflict (planted with the library's own code
 *    while the service is stopped, the only way to plant one) appears in the review queue under
 *    "From captures" with conflict badges; choosing a value shows "Confirmed by you"; confirming the
 *    last field resolves the entry (R176 1): it leaves the queue, and the row's badge is gone.
 *
 * Elements are found by role and accessible name, as a keyboard or screen-reader user finds them.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR } from "./paths.js";
import { pressByMouse } from "./press.js";

/** Types paths into the drop area ("Attach files…") and waits for the attach outcome list. */
async function attachByTyping(page: Page, paths: string[]): Promise<void> {
  await page.getByRole("button", { name: "Attach files…" }).click();
  await page.getByRole("textbox", { name: "File paths, one per line" }).fill(paths.join("\n"));
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  // Attach hashes, extracts and looks up in the service (the worker on a cold library): a generous, explicit wait.
  await expect(page.getByRole("list", { name: "Attached files" }).getByRole("listitem")).toHaveCount(paths.length, { timeout: 60_000 });
}

/** Marks the page so that a reload (which would clear it) can be told from in-app navigation. */
const markPage = (page: Page) => page.evaluate(() => ((window as unknown as { __aoNoReload?: boolean }).__aoNoReload = true));
const stillSamePage = (page: Page) => page.evaluate(() => (window as unknown as { __aoNoReload?: boolean }).__aoNoReload === true);

test("a file attached by drag and drop that needs review: the badge leads to the review queue, the entry is decided there, and the badge is gone without a reload", async ({ page, app }) => {
  const title = "Kinship and Exchange in Delta Fishing Villages";
  await test.step("set-up: a library and a project without lookups (through the service); a PDF on disk", async () => {
    await libraryWithProject(app, page, { library: "Queue library", project: "Delta study" });
    mkdirSync(join(app.root, "sources"), { recursive: true });
    writeFileSync(join(app.root, "sources", "delta.pdf"), await buildPdf({ title, author: "Ana Souza", lines: ["Kinship and exchange in the delta."] }));
  });

  await test.step("attach it by typing its path into the drop area: it needs review", async () => {
    await attachByTyping(page, [join(app.root, "sources", "delta.pdf")]);
    await expect(page.getByRole("list", { name: "Attached files" }).getByRole("link", { name: /needs review/i })).toBeVisible();
  });

  const row = () => page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ hasText: title });
  await test.step("its row carries the Needs review badge, and the project's review queue link counts it", async () => {
    await expect(row().getByRole("link", { name: /^Needs review/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review queue (1 waiting)" })).toBeVisible();
  });

  await test.step("the badge leads to the review queue at that source, under Added by hand", async () => {
    await markPage(page);
    await row().getByRole("link", { name: /^Needs review/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Added by hand" })).toBeVisible();
    await expect(page.getByRole("list", { name: /^Added by hand/ }).getByRole("button", { name: `Show ${title}` })).toBeVisible();
  });

  await test.step("decide it (Accept): it leaves the queue", async () => {
    const decide = page.getByRole("group", { name: "Decide this item" });
    await expect(decide.getByRole("button", { name: "Accept" })).toBeEnabled({ timeout: 30_000 });
    // R362 d: the panel takes a mouse press only where the pointer really moved over the control (as a researcher's does).
    await pressByMouse(page, decide.getByRole("button", { name: "Accept" }));
    await expect(page.getByText("Nothing is waiting for review for this source.")).toBeVisible();
  });

  await test.step("back in the library, in the app (no reload), the badge is gone", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
    await expect(row().getByRole("button", { name: title, exact: true })).toBeVisible();
    await expect(row().getByRole("link", { name: /^Needs review/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Review queue", exact: true })).toBeVisible();
    expect(await stillSamePage(page), "the page was not reloaded").toBe(true);
  });
});

/**
 * Plants a captured source whose DOI and title conflict, with its review entry, as link and profile
 * capture queue one (createSource's reviewItem), using the library's own code from packages/library
 * while the service is stopped. The index is updated through the library's own index sink.
 */
function plantConflict(app: AppHarness, o: { library: string; projectId: string }): void {
  const code = [
    'import { KeyRing, createIndexSink, deviceDeps, openIndexChecked, openLibrary, openRepo } from "./src/index.ts";',
    "const o = JSON.parse(process.env.AO_E2E_PLANT);",
    "const lib = await openLibrary(o.library, deviceDeps(o.configDir));",
    "const checked = await openIndexChecked(lib.root);",
    "const ring = new KeyRing();",
    "const repo = await openRepo(lib, ring, { index: createIndexSink(checked.handle, { root: lib.root, keyRing: ring }) });",
    "const at = new Date().toISOString();",
    "const mt = (value) => ({ variants: [{ lang: 'en', kind: 'original', value }] });",
    "const page = { kind: 'page-dom' }; const platform = { kind: 'platform-json' };",
    "await repo.createSource(o.projectId, {",
    "  projectIds: [], type: 'webpage', title: mt('Rivers and Memory'), creators: [], identifiers: { doi: '10.5555/rivers.1' },",
    "  caseAttributes: {}, availability: { status: 'available' }, collectionIds: [], tagIds: [], participantIds: [],",
    "}, [], {",
    "  provenance: { captureMethod: 'manual_upload', capturedAt: at, tool: { name: 'e2e-plant', version: '1' }, fileHashes: {}, legal: { status: 'public' }, identifiable: false },",
    "  fieldEvidence: [",
    "    { field: '/title', value: 'Rivers and Memory', source: page, at }, { field: '/title', value: 'Rivers and Memories in Upland Villages', source: platform, at },",
    "    { field: '/identifiers/doi', value: '10.5555/rivers.1', source: page, at }, { field: '/identifiers/doi', value: '10.5555/rivers.2', source: platform, at },",
    "  ],",
    "  verification: {",
    "    '/title': { status: 'conflict', checks: ['sources-agree'], reason: 'The page and the platform data give different titles.', current: 'Rivers and Memory', values: [{ value: 'Rivers and Memory', source: page }, { value: 'Rivers and Memories in Upland Villages', source: platform }] },",
    "    '/identifiers/doi': { status: 'conflict', checks: ['sources-agree'], reason: 'The page and the platform data give different DOIs.', current: '10.5555/rivers.1', values: [{ value: '10.5555/rivers.1', source: page }, { value: '10.5555/rivers.2', source: platform }] },",
    "  },",
    "  reviewItem: { fields: { '/title': 'conflict', '/identifiers/doi': 'conflict' }, reasons: ['The page and the platform data disagree on the title and the DOI.'], cause: { kind: 'capture-conflict' } },",
    "});",
    "checked.handle.close();",
    "await lib.close();",
  ].join("\n");
  const env = { ...process.env, AO_E2E_PLANT: JSON.stringify({ library: o.library, projectId: o.projectId, configDir: app.configDir }) };
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: LIBRARY_DIR, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Planting the conflict failed (status ${r.status}): ${r.stderr}`);
}

test("scenario 11 (the review queue step): a planted DOI and title conflict appears in the review queue with conflict badges; choosing a value shows confirmed by you; the last one clears the entry and the badge", async ({ page, app }) => {
  let projectId = "";
  let libraryPath = "";
  await test.step("set-up: a library and a project; with the service stopped, a captured source whose DOI and title conflict is planted with the library's own code", async () => {
    ({ projectId, libraryPath } = await libraryWithProject(app, page, { library: "Conflict library", project: "Upland study" }));
    await app.restart(async () => plantConflict(app, { library: libraryPath, projectId }));
    await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Conflict library" })).toBeVisible();
  });

  await test.step("the row carries Needs review; the project's review queue link leads to the entry, under From captures", async () => {
    const row = page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ hasText: "Rivers and Memory" });
    await expect(row.getByRole("link", { name: /^Needs review/ })).toBeVisible();
    await page.getByRole("link", { name: "Review queue (1 waiting)" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "From captures" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Why it needs review" })).toContainText("disagree on the title and the DOI");
  });

  await test.step("the DOI and the title carry conflict badges", async () => {
    await expect(page.getByRole("button", { name: "DOI: Conflict" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Title: Conflict" })).toBeVisible();
  });

  await test.step("choosing the DOI's value shows Confirmed by you", async () => {
    await page.getByRole("button", { name: "DOI: Conflict" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /10\.5555\/rivers\.2/ }).check();
    await dialog.getByRole("button", { name: "Confirm this value" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "DOI: Confirmed by you" })).toBeVisible();
    await expect(page.getByRole("button", { name: "DOI: Confirmed by you" })).toBeFocused();
  });

  await test.step("choosing the title's value, the last field in conflict, resolves the entry: it leaves the queue (R176 1)", async () => {
    await markPage(page);
    await page.getByRole("button", { name: "Title: Conflict" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Rivers and Memories in Upland Villages/ }).check();
    await dialog.getByRole("button", { name: "Confirm this value" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Nothing is waiting for review in this project.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "From captures" })).toHaveCount(0);
  });

  await test.step("back in the library, in the app (no reload), the row's badge is gone", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
    const row = page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ hasText: "Rivers and Memories in Upland Villages" });
    await expect(row.getByRole("button", { name: "Rivers and Memories in Upland Villages", exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: /^Needs review/ })).toHaveCount(0);
    expect(await stillSamePage(page), "the page was not reloaded").toBe(true);
  });

  await test.step("the confirmations are the researcher's own evidence in the stored record", async () => {
    const sources = (await app.api<{ items: Array<{ id: string }> }>("GET", `/projects/${projectId}/sources`)).body.items;
    const stored = (await app.api<{ source: { identifiers: { doi?: string } }; fields: Array<{ field: string; status: string }> }>("GET", `/projects/${projectId}/sources/${sources[0]!.id}`)).body;
    expect(stored.source.identifiers.doi).toBe("10.5555/rivers.2");
    expect(stored.fields.filter((f) => f.field === "/title" || f.field === "/identifiers/doi").map((f) => f.status)).toEqual(["user-confirmed", "user-confirmed"]);
  });
});

/**
 * Plants an existing source whose stored evidence now disagrees on the title, as data a later check
 * added (a browser capture with the downloader ticked adds the platform's values), with no review
 * entry and no conflict in its stored report yet; with the library's own code, while the service is
 * stopped. No capture through the fake tools gives a page and a platform that disagree.
 */
function plantLaterEvidence(app: AppHarness, o: { library: string; projectId: string }): void {
  const code = [
    'import { KeyRing, createIndexSink, deviceDeps, openIndexChecked, openLibrary, openRepo } from "./src/index.ts";',
    "const o = JSON.parse(process.env.AO_E2E_PLANT);",
    "const lib = await openLibrary(o.library, deviceDeps(o.configDir));",
    "const checked = await openIndexChecked(lib.root);",
    "const ring = new KeyRing();",
    "const repo = await openRepo(lib, ring, { index: createIndexSink(checked.handle, { root: lib.root, keyRing: ring }) });",
    "const at = new Date().toISOString();",
    "await repo.createSource(o.projectId, {",
    "  projectIds: [], type: 'webpage', title: { variants: [{ lang: 'en', kind: 'original', value: 'Harbour Songs' }] }, creators: [], identifiers: {},",
    "  caseAttributes: {}, availability: { status: 'available' }, collectionIds: [], tagIds: [], participantIds: [],",
    "}, [], {",
    "  provenance: { captureMethod: 'manual_upload', capturedAt: at, tool: { name: 'e2e-plant', version: '1' }, fileHashes: {}, legal: { status: 'public' }, identifiable: false },",
    "  fieldEvidence: [{ field: '/title', value: 'Harbour Songs', source: { kind: 'page-dom' }, at }, { field: '/title', value: 'Harbour Songs of the North Coast', source: { kind: 'platform-json' }, at }],",
    "});",
    "checked.handle.close();",
    "await lib.close();",
  ].join("\n");
  const env = { ...process.env, AO_E2E_PLANT: JSON.stringify({ library: o.library, projectId: o.projectId, configDir: app.configDir }) };
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: LIBRARY_DIR, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Planting the evidence failed (status ${r.status}): ${r.stderr}`);
}

test("D19 (R190): a conflict a later check finds on an existing source puts it in the review queue: the row needs review, the entry is under From captures", async ({ page, app }) => {
  await test.step("set-up: an existing source whose stored evidence now disagrees on the title, with no entry", async () => {
    const { projectId, libraryPath } = await libraryWithProject(app, page, { library: "Later library", project: "Coast study" });
    await app.restart(async () => plantLaterEvidence(app, { library: libraryPath, projectId }));
    await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Later library" })).toBeVisible();
  });

  const row = () => page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ hasText: "Harbour Songs" });
  await test.step("before the check, the row does not need review", async () => {
    await expect(row().getByRole("button", { name: "Harbour Songs", exact: true })).toBeVisible();
    await expect(row().getByRole("link", { name: /^Needs review/ })).toHaveCount(0);
  });

  await test.step("the source's Recheck finds the conflict: the title shows Conflict and the row now needs review", async () => {
    await row().getByRole("button", { name: "Harbour Songs", exact: true }).click();
    await page.getByRole("button", { name: "Recheck", exact: true }).click();
    await expect(page.getByRole("button", { name: "Title: Conflict" })).toBeVisible();
    await expect(row().getByRole("link", { name: /^Needs review/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review queue (1 waiting)" })).toBeVisible();
  });

  await test.step("the queue holds the entry under From captures", async () => {
    await page.getByRole("link", { name: "Review queue (1 waiting)" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "From captures" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Title: Conflict" })).toBeVisible();
  });
});

/**
 * D28 (R362 d; R313, R318, R319, R322): in the queue's panel for its other kinds of entry, a decision never lands on an
 * entry the researcher has not seen. After a decision the next entry is shown in the place of the one decided, so its
 * "Accept" stands where the last one stood: a second press at the same spot — a double click, a steady rhythm without
 * moving the pointer, a held Enter, Enter pressed again quickly — must not decide it. Each rhythm runs on its own queue
 * of four entries attached by hand (each needs review in a project without lookups); after the rhythm exactly ONE entry
 * is decided — the one shown when the first press came — and the other three still wait, read from the service.
 *
 * The rhythms are what is proved, so they are timed (R173's exception, as find-copies.spec.ts's scenario 6): a press at
 * one spot every 150, 400 and 700 ms for about three seconds. The first press of each is a researcher's (`pressByMouse`:
 * the pointer moved onto the control at rest, or the control focused for a key).
 */
const PANEL_TITLES = ["Salt Roads of the Upper Delta", "Ferry Songs at Low Water", "Market Days in Reed Villages", "Weirs and Their Keepers"];

/** Four entries waiting, attached by hand through the service; the queue opened. Returns the project and the entries' ids in queue order. */
async function fourWaiting(page: Page, app: AppHarness, library: string): Promise<{ projectId: string; ids: string[] }> {
  const { projectId } = await libraryWithProject(app, page, { library, project: "Delta study" });
  mkdirSync(join(app.root, "sources"), { recursive: true });
  const paths: string[] = [];
  for (const [k, title] of PANEL_TITLES.entries()) {
    const p = join(app.root, "sources", `panel-${k}.pdf`);
    writeFileSync(p, await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
    paths.push(p);
  }
  const attached = await app.api("POST", `/projects/${encodeURIComponent(projectId)}/attach`, { paths });
  expect(attached.status, JSON.stringify(attached.body)).toBe(200);
  const ids = await waitingIds(app, projectId);
  expect(ids).toHaveLength(4);
  await page.goto(`${APP_ORIGIN}/import/review?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
  await expect(page.getByText("4 entries are waiting in this project.")).toBeVisible({ timeout: 60_000 });
  await expect(accept(page)).toBeEnabled({ timeout: 60_000 });
  return { projectId, ids };
}

/** The ids of the entries the service lists as waiting, in its order. */
async function waitingIds(app: AppHarness, projectId: string): Promise<string[]> {
  const r = await app.api<{ items: Array<{ id: string }> }>("GET", `/projects/${encodeURIComponent(projectId)}/review?limit=50`);
  expect(r.status).toBe(200);
  return r.body.items.map((i) => i.id);
}

const accept = (page: Page) => page.getByRole("group", { name: "Decide this item" }).getByRole("button", { name: "Accept" });

/** Presses at one spot, without moving the pointer, every `ms` for about three seconds. */
async function steady(page: Page, at: { x: number; y: number }, ms: number): Promise<void> {
  const n = Math.max(4, Math.round(3000 / ms));
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(ms); // the rhythm is what is proved
    await page.mouse.down();
    await page.mouse.up();
  }
}

const RHYTHMS: Array<{ name: string; press(page: Page): Promise<void> }> = [
  {
    name: "a double click on Accept",
    press: async (page) => {
      await pressByMouse(page, accept(page));
      // The second press of a double click, at once, at the same place.
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
    },
  },
  { name: "a click every 150 ms without moving the pointer", press: async (page) => steady(page, await pressByMouse(page, accept(page)), 150) },
  { name: "a click every 400 ms without moving the pointer", press: async (page) => steady(page, await pressByMouse(page, accept(page)), 400) },
  { name: "a click every 700 ms without moving the pointer", press: async (page) => steady(page, await pressByMouse(page, accept(page)), 700) },
  {
    name: "Enter held for a second",
    press: async (page) => {
      await accept(page).focus();
      await expect(accept(page)).toBeFocused();
      await page.keyboard.down("Enter");
      // Held: the key repeats (keydown with repeat set) about thirty times a second.
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(33);
        await page.keyboard.down("Enter");
      }
      await page.keyboard.up("Enter");
    },
  },
  {
    name: "Enter pressed three times quickly",
    press: async (page) => {
      await accept(page).focus();
      await expect(accept(page)).toBeFocused();
      for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
    },
  },
];

for (const [k, rhythm] of RHYTHMS.entries()) {
  test(`D28 (R362 d): in the queue's panel, ${rhythm.name} decides exactly ONE entry; the others still wait`, async ({ page, app }) => {
    test.setTimeout(180_000);
    let projectId = "";
    let ids: string[] = [];
    await test.step("set-up: four entries attached by hand wait in the queue; the panel shows the first", async () => {
      ({ projectId, ids } = await fourWaiting(page, app, `Panel library ${k + 1}`));
    });

    await test.step(rhythm.name, async () => {
      await rhythm.press(page);
      // The screen has shown the decision (the next entry in the panel), then any press still in flight has landed.
      await expect(page.getByText("4 entries are waiting in this project.")).toHaveCount(0, { timeout: 60_000 });
      await page.waitForTimeout(1500);
    });

    await test.step("exactly one entry is decided — the one shown at the first press — and the other three still wait (the service's state)", async () => {
      expect(await waitingIds(app, projectId)).toEqual(ids.slice(1));
      await expect(page.getByText("3 entries are waiting in this project.")).toBeVisible();
      // By key, focus went to the next entry's heading, never to a control that decides (R313 a).
      if (rhythm.name.startsWith("Enter")) await expect(page.locator(".ao-review__panel h3.ao-review__title")).toBeFocused();
    });

    await test.step("the pointer moved onto the next entry's Accept and pressed (the quiet long past): that entry is decided", async () => {
      await pressByMouse(page, accept(page));
      await expect(page.getByText("2 entries are waiting in this project.")).toBeVisible({ timeout: 60_000 });
      expect(await waitingIds(app, projectId)).toEqual(ids.slice(2));
    });
  });
}
