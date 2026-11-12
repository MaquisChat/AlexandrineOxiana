/**
 * The project's whole review queue (Task 67, D14, R172) against the real service and worker.
 *
 *  - A file attached by drag and drop that needs review: its library row carries "Needs review"; the
 *    badge leads to the review queue at that source; the entry is decided there; back in the library
 *    (in the app, no reload) the badge is gone.
 *  - Scenario 11's queue step: a planted DOI and title conflict (planted with the library's own code
 *    while the service is stopped, the only way to plant one) appears in the review queue under
 *    "From captures" with conflict badges; choosing a value shows "Confirmed by you".
 *
 * Elements are found by role and accessible name, as a keyboard or screen-reader user finds them.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR } from "./paths.js";

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
    await decide.getByRole("button", { name: "Accept" }).click();
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
    "  reviewItem: { fields: { '/title': 'conflict', '/identifiers/doi': 'conflict' }, reasons: ['The page and the platform data disagree on the title and the DOI.'] },",
    "});",
    "checked.handle.close();",
    "await lib.close();",
  ].join("\n");
  const env = { ...process.env, AO_E2E_PLANT: JSON.stringify({ library: o.library, projectId: o.projectId, configDir: app.configDir }) };
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: LIBRARY_DIR, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Planting the conflict failed (status ${r.status}): ${r.stderr}`);
}

test("scenario 11 (the review queue step): a planted DOI and title conflict appears in the review queue with conflict badges; choosing a value shows confirmed by you", async ({ page, app }) => {
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

  await test.step("choosing the title's value shows Confirmed by you", async () => {
    await page.getByRole("button", { name: "Title: Conflict" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Rivers and Memories in Upland Villages/ }).check();
    await dialog.getByRole("button", { name: "Confirm this value" }).click();
    await expect(page.getByRole("button", { name: "Title: Confirmed by you" })).toBeVisible();
  });

  await test.step("the confirmations are the researcher's own evidence in the stored record", async () => {
    const sources = (await app.api<{ items: Array<{ id: string }> }>("GET", `/projects/${projectId}/sources`)).body.items;
    const stored = (await app.api<{ source: { identifiers: { doi?: string } }; fields: Array<{ field: string; status: string }> }>("GET", `/projects/${projectId}/sources/${sources[0]!.id}`)).body;
    expect(stored.source.identifiers.doi).toBe("10.5555/rivers.2");
    expect(stored.fields.filter((f) => f.field === "/title" || f.field === "/identifiers/doi").map((f) => f.status)).toEqual(["user-confirmed", "user-confirmed"]);
  });
});
