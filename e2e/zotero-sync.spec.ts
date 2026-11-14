/**
 * Zotero account sync end to end (Task Z11; plan docs/superpowers/plans/2026-11-13-zotero-account-sync.md, Amendments
 * A8–A13; Ruling R289): the real service, the real sync engine and the real Zotero screen, in Chromium and WebKit,
 * against a stand-in for Zotero's servers on this computer.
 *
 * The stand-in (e2e/zotero-standin.ts) is the library tests' own fake Zotero behind a small server on 127.0.0.1 in
 * this process. The service reaches it through its three test-only switches, honoured only under NODE_ENV=test (which
 * the harness sets): AO_ZOTERO_API_ORIGIN (the stand-in is then Zotero's API and the only origin a file may come
 * from, so nothing here can reach a real Zotero server), AO_SECRETS=memory (the key is kept in the service's memory
 * only; a restart forgets it), and in one scenario AO_ZOTERO_TICK_MS (the scheduler's tick).
 *
 * The key is a made-up string in the shape the product accepts (24 letters and digits); it is never a real key.
 *
 * Every sentence asserted is copied from the screen (packages/ui/src/screens/ZoteroSync.tsx, ZoteroKeyField.tsx,
 * AvailabilityMark.tsx) or computed with the shared code that the service and the screen use
 * (packages/shared/src/api/zotero-sync.ts). Every wait is for something the screen or the service shows, with a
 * generous limit (R173); the one wait on the clock is the timed observation of "back-off holds automatic runs".
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { FakeZotero } from "../packages/library/tests/zotero/fake-zotero.js";
import { ZOTERO_SYNC_REASON_TEXT, zoteroKeySummary, zoteroNextSyncLine, zoteroSyncReasonText, zoteroSyncStatusLine, type ZoteroSyncRun, type ZoteroSyncStateResponse } from "../packages/shared/src/api/zotero-sync.js";
import { APP_ORIGIN, OPEN_RULES, expect, libraryWithProject, test as base, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR } from "./paths.js";
import { startZoteroStandIn, type ZoteroStandIn } from "./zotero-standin.js";

// ---------- the stand-in's account ----------

/** A made-up key in the shape the product accepts (24 letters and digits). Never a real key. */
const KEY = "ZoteroStandInKey0000Z011";
const USER_ID = 42;
const MY = `user:${USER_ID}`;
const GROUP_ID = 7;
const GROUP = `group:${GROUP_ID}`;
const GROUP_NAME = "Fieldwork reading group";
const MY_LIBRARY = "My library";

/** The words in the PDF, and the highlight Zotero holds on them. */
const PDF_LINE = "Informal markets feed the city.";
const QUOTE = "Informal markets";

interface Account {
  z: FakeZotero;
  /** Zotero item keys, by name. */
  keys: { okafor: string; pdf: string; highlight: string; souza: string; group: string };
}

/** Generous: a sync, its reads and the screen's reads run in the service on a machine that may be loaded. */
const STATE_TIMEOUT = 60_000;

type Fixtures = { zotero: Account & { standIn: ZoteroStandIn }; zoteroTick: number | undefined };

const test = base.extend<Fixtures>({
  /** The scheduler's tick for this test's service (AO_ZOTERO_TICK_MS); undefined: the product's 60 seconds. */
  zoteroTick: [undefined, { option: true }],
  zotero: async ({}, use) => {
    const account = await makeAccount();
    const standIn = await startZoteroStandIn(account.z);
    try {
      await use({ ...account, standIn });
    } finally {
      await standIn.close();
      await account.z.agent.close();
    }
  },
  // Started before the service: the service is given the stand-in's origin and the other switches.
  serviceEnv: async ({ zotero, zoteroTick }, use) => {
    await use({
      AO_SECRETS: "memory",
      AO_ZOTERO_API_ORIGIN: zotero.standIn.origin,
      ...(zoteroTick !== undefined ? { AO_ZOTERO_TICK_MS: String(zoteroTick) } : {}),
    });
  },
});

/** The account: two articles in the personal library (one with its PDF and a highlight), one in the group library. */
async function makeAccount(): Promise<Account> {
  const z = new FakeZotero({ key: KEY, userId: USER_ID });
  z.addGroup(GROUP_ID, GROUP_NAME);
  const okafor = z.addItem(MY, {
    itemType: "journalArticle",
    title: "Feeding the City: Informal Markets in Lagos",
    creators: [{ creatorType: "author", firstName: "Ngozi", lastName: "Okafor" }],
    date: "2019-05-02",
    publicationTitle: "Urban Studies",
  });
  const { bytes, rect } = await marketsPdf();
  const pdf = z.addItem(MY, { itemType: "attachment", contentType: "application/pdf", filename: "okafor-2019.pdf", title: "Full Text PDF" }, { parent: okafor, file: { bytes } });
  const highlight = z.addItem(
    MY,
    { itemType: "annotation", annotationType: "highlight", annotationText: QUOTE, annotationColor: "#ffd400", annotationPosition: JSON.stringify({ pageIndex: 0, rects: [rect] }), annotationSortIndex: "00000|000010|00050" },
    { parent: pdf },
  );
  const souza = z.addItem(MY, {
    itemType: "book",
    title: "Kinship and Exchange in Delta Fishing Villages",
    creators: [{ creatorType: "author", firstName: "Ana", lastName: "Souza" }],
    date: "2016",
    publisher: "Delta Press",
  });
  const group = z.addItem(GROUP, {
    itemType: "journalArticle",
    title: "Rivers and Memory in Upland Villages",
    creators: [{ creatorType: "author", firstName: "Tomás", lastName: "Herrera" }],
    date: "2021",
    publicationTitle: "Memory Studies",
  });
  return { z, keys: { okafor, pdf, highlight, souza, group } };
}

/** A one-page PDF with PDF_LINE in 12-point Helvetica; the rectangle [x1, y1, x2, y2] of QUOTE's words in it. */
async function marketsPdf(): Promise<{ bytes: Uint8Array; rect: [number, number, number, number] }> {
  const { PDFDocument, StandardFonts } = createRequire(join(LIBRARY_DIR, "package.json"))("pdf-lib") as {
    PDFDocument: { create(o: object): Promise<{ embedFont(f: string): Promise<Font>; addPage(s: [number, number]): { drawText(t: string, o: object): void }; save(o: object): Promise<Uint8Array> }> };
    StandardFonts: { Helvetica: string };
  };
  interface Font {
    widthOfTextAtSize(t: string, s: number): number;
  }
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const size = 12;
  page.drawText("Feeding the City", { x: 72, y: 780, size: 16, font });
  page.drawText(PDF_LINE, { x: 72, y: 700, size, font });
  const w = font.widthOfTextAtSize(QUOTE, size);
  // Helvetica's descent and ascent are about 0.207 and 0.718 of the size.
  return { bytes: await doc.save({ useObjectStreams: false }), rect: [72, 700 - 0.207 * size, 72 + w, 700 + 0.718 * size] };
}

// ---------- the screen ----------

const main = (page: Page) => page.getByRole("main");
const row = (page: Page, label: string) => page.getByRole("region", { name: label, exact: true });
const runButton = (page: Page) => page.getByRole("button", { name: /^(Sync with Zotero now|Stop syncing)$/ });
const history = (page: Page) => page.getByRole("list", { name: "Sync history" }).getByRole("listitem");

async function openZoteroScreen(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Zotero", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Zotero" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible({ timeout: STATE_TIMEOUT });
}

/** The service's state and history, read directly (as test checks). */
async function syncState(app: AppHarness): Promise<ZoteroSyncStateResponse> {
  const r = await app.api<ZoteroSyncStateResponse>("GET", "/zotero/sync");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function runs(app: AppHarness): Promise<ZoteroSyncRun[]> {
  const r = await app.api<{ runs: ZoteroSyncRun[] }>("GET", "/zotero/sync/history");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.runs;
}

/** Waits until the history holds `n` runs and no run is going; returns the history, newest first. */
async function settled(app: AppHarness, n: number): Promise<ZoteroSyncRun[]> {
  await expect.poll(async () => ((await syncState(app)).running ? -1 : (await runs(app)).length), { timeout: STATE_TIMEOUT }).toBe(n);
  return runs(app);
}

interface SourceRow {
  id: string;
  title: string;
  creatorsText: string;
  issuedYear?: string | number | null;
}
async function sourcesOf(app: AppHarness, projectId: string): Promise<SourceRow[]> {
  const r = await app.api<{ items: SourceRow[] }>("GET", `/projects/${projectId}/sources?limit=500`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.items;
}


/** The project's library screen, then the source with `title` opened from its row. */
async function openSource(page: Page, projectId: string, title: string): Promise<ReturnType<Page["getByRole"]>> {
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: title, exact: true }).click();
  const detail = page.getByRole("region", { name: "Source details" });
  await expect(detail.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
  return detail;
}

/** The researcher's own change of a title, through "Edit details" as a person would. */
async function retitle(page: Page, projectId: string, from: string, to: string): Promise<void> {
  const detail = await openSource(page, projectId, from);
  await detail.getByRole("button", { name: "Edit details" }).click();
  await detail.getByRole("textbox", { name: "Title" }).fill(to);
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await expect(detail.getByRole("heading", { level: 2, name: to, exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
}

/**
 * Set-up through the service (as `libraryWithProject` sets up a library): the key saved and checked, `refs` linked to
 * the project, one manual sync run to its end. The scenarios' own acts are on the screen.
 */
async function linkAndSync(app: AppHarness, projectId: string, refs: string[]): Promise<ZoteroSyncRun[]> {
  const before = (await runs(app)).length;
  expect((await app.api("PUT", "/secrets/zotero-api-key", { apiKey: KEY })).status).toBe(200);
  const checked = await app.api("POST", "/zotero/key-check");
  expect(checked.status, JSON.stringify(checked.body)).toBe(200);
  const saved = await app.api("PUT", "/zotero/sync/settings", { automatic: false, everyMinutes: 60, links: refs.map((ref) => ({ ref, projectId, structure: "collections", duplicates: "merge" })) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const started = await app.api("POST", "/zotero/sync/run", {});
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  return settled(app, before + refs.length);
}

/** Each library's row says its last run in the service's words, and the history shows the newest runs. */
async function expectServiceWords(page: Page, app: AppHarness, labels: Record<string, string>): Promise<void> {
  const now = new Date();
  const state = await syncState(app);
  const all = await runs(app);
  for (const link of state.links) {
    const label = labels[link.ref]!;
    // The state's line is the shared function's line for the link's last record.
    expect(link.status).toBe(zoteroSyncStatusLine(link.lastRun, now));
    await expect(row(page, label).getByText(link.status, { exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
  }
  const shown = all.slice(0, 20).map((r) => `${labels[r.ref]}: ${zoteroSyncStatusLine(r, now)}`);
  await expect(history(page)).toHaveText(shown, { timeout: STATE_TIMEOUT });
}

/** Each library's name on the screen after "Check the key" in this visit… */
const LABELS = { [MY]: MY_LIBRARY, [GROUP]: GROUP_NAME };
/** …and before it (the screen's own words, ZoteroSync.tsx `refLabel`: "until then, linked libraries are shown by their Zotero number"). */
const MY_BY_NUMBER = `Zotero library ${MY}`;
const GROUP_BY_NUMBER = `Zotero group ${GROUP_ID}`;
const LABELS_BY_NUMBER = { [MY]: MY_BY_NUMBER, [GROUP]: GROUP_BY_NUMBER };

/** The review entry's reason for a field changed in Zotero and here (packages/library/src/import/bulk/update.ts ZOTERO_CONFLICT_REASON). */
const ZOTERO_CONFLICT_REASON = "Zotero now has a different value; you changed it here.";

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** Presses Tab (at most `max` times) until `target` has the focus: the keyboard's own way there. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

// ---------- the scenarios ----------

test("a first sync brings items, files and highlights", async ({ page, app, zotero }) => {
  const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });

  await test.step("the Zotero screen, from the library's link", async () => {
    await openZoteroScreen(page);
    await expect(page.getByText("No Zotero key is stored on this computer.")).toBeVisible();
  });

  await test.step("the key is saved and checked: the service's sentence for the personal library and one group", async () => {
    await page.getByLabel("Zotero API key").fill(KEY);
    await page.getByRole("button", { name: "Store key" }).click();
    await expect(page.getByText("The key is stored in this computer's password store.")).toBeVisible();
    await expect(page.getByText("A Zotero key is stored on this computer.")).toBeVisible();
    await expect(page.getByLabel("Zotero API key")).toHaveValue("");
    await page.getByRole("button", { name: "Check the key", exact: true }).click();
    const summary = zoteroKeySummary({ userId: String(USER_ID), personal: { library: true, files: true, notes: true, write: false }, groups: [{ ref: GROUP, name: GROUP_NAME, write: false }] });
    expect(summary).toBe("This key can read your library and 1 group library.");
    await expect(page.getByTestId("zotero-key-result")).toHaveText(summary, { timeout: STATE_TIMEOUT });
  });

  await test.step("both libraries linked to the project and saved", async () => {
    for (const label of [MY_LIBRARY, GROUP_NAME]) {
      await row(page, label).getByRole("checkbox", { name: `Keep “${label}” in step` }).check();
      await row(page, label).getByRole("combobox", { name: `Into project for “${label}”` }).selectOption({ label: "Market studies" });
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("zotero-live")).toHaveText("Saved.", { timeout: STATE_TIMEOUT });
    expect((await syncState(app)).links.map((l) => [l.ref, l.projectId])).toEqual([
      [MY, projectId],
      [GROUP, projectId],
    ]);
  });

  let firstFiles: string[] = [];
  await test.step("“Sync with Zotero now”: both libraries run; each row and the history say so in the service's words", async () => {
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    const first = await settled(app, 2);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    expect(first.map((r) => [r.ref, r.outcome, r.trigger, r.counts?.new])).toEqual([
      [GROUP, "finished", "manual", 1],
      [MY, "finished", "manual", 2],
    ]);
    await expectServiceWords(page, app, LABELS);
    // In words, as the service's shared line has them.
    expect(zoteroSyncStatusLine(first[1], new Date())).toMatch(/^Last synced with Zotero at \d\d:\d\d today: 2 new\.$/u);
    firstFiles = zotero.standIn.requests().filter((r) => r.storage).map((r) => r.path);
    expect(firstFiles).toHaveLength(1);
  });

  let okaforId = "";
  await test.step("the library holds them: the three items in the project's list with their titles, authors and years", async () => {
    const list = await sourcesOf(app, projectId);
    expect(list.map((s) => s.title).sort()).toEqual(["Feeding the City: Informal Markets in Lagos", "Kinship and Exchange in Delta Fishing Villages", "Rivers and Memory in Upland Villages"]);
    okaforId = list.find((s) => s.title.startsWith("Feeding the City"))!.id;
    await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
    const table = page.getByRole("table", { name: "Sources" });
    await expect(table.getByRole("row")).toHaveCount(4, { timeout: STATE_TIMEOUT }); // the header and three sources
    for (const [title, family, year] of [
      ["Feeding the City: Informal Markets in Lagos", "Okafor", "2019"],
      ["Kinship and Exchange in Delta Fishing Villages", "Souza", "2016"],
      ["Rivers and Memory in Upland Villages", "Herrera", "2021"],
    ] as const) {
      const r = table.getByRole("row").filter({ has: page.getByRole("button", { name: title, exact: true }) });
      await expect(r).toContainText(family);
      await expect(r.getByRole("cell").nth(2)).toHaveText(year);
    }
  });

  await test.step("the PDF came in and opens in the reader: its page is drawn, with its words", async () => {
    const detail = await openSource(page, projectId, "Feeding the City: Informal Markets in Lagos");
    await detail.getByRole("link", { name: "Read the PDF" }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/reader?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(okaforId)}`);
    const page1 = page.locator('[data-page-number="1"][aria-label="Page 1 of 1"]');
    await expect(page1).toHaveAttribute("data-rendered", "", { timeout: STATE_TIMEOUT });
    await expect(page1.locator(".ao-reader-text-layer")).toContainText(PDF_LINE);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = document.querySelector<HTMLCanvasElement>('[data-page-number="1"] canvas');
          if (!c || c.width === 0) return false;
          const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 1]! < 100 && d[i + 2]! < 100 && d[i + 3]! > 0) return true;
          return false;
        }),
      )
      .toBe(true);
  });

  await test.step("its Zotero highlight is where the reader shows highlights: in the list, imported from Zotero, and drawn on page 1", async () => {
    const listed = await app.api<{ annotations: Array<{ id: string; kind: string; quote?: string; imported: boolean; colorName: string }> }>("GET", `/projects/${projectId}/sources/${okaforId}/annotations`);
    expect(listed.status).toBe(200);
    const hl = listed.body.annotations.find((a) => a.kind === "highlight");
    expect(hl).toMatchObject({ quote: QUOTE, imported: true, colorName: "yellow" });
    const list = page.getByRole("region", { name: /^Annotations \(/ });
    await expect(list.getByRole("heading", { level: 2 })).toHaveText("Annotations (1)");
    const entry = list.locator(`[data-entry="${hl!.id}"]`);
    await expect(entry).toContainText("Imported from Zotero");
    await expect(entry).toContainText(QUOTE);
    await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${hl!.id}"]`)).toHaveCount(1);
  });

  await test.step("a second “Sync with Zotero now” with nothing changed: “nothing has changed”, and no file downloaded twice", async () => {
    await page.goto(`${APP_ORIGIN}/settings/zotero`);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    const asked = zotero.standIn.requests().length;
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    const second = await settled(app, 4);
    expect(second.slice(0, 2).map((r) => [r.ref, r.outcome])).toEqual([
      [GROUP, "up-to-date"],
      [MY, "up-to-date"],
    ]);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await expectServiceWords(page, app, LABELS_BY_NUMBER);
    await expect(row(page, MY_BY_NUMBER).getByText(/^Checked Zotero at \d\d:\d\d today: nothing has changed since the last sync\.$/u)).toBeVisible();
    // Z4: the file was fetched once; the quiet run asked nothing of the storage, nor for the file's address.
    const log = zotero.standIn.requests();
    expect(log.filter((r) => r.storage).map((r) => r.path)).toEqual(firstFiles);
    expect(log.slice(asked).filter((r) => r.storage || /\/file(\?|$)/u.test(r.path))).toEqual([]);
    expect(log.every((r) => r.method === "GET")).toBe(true);
    expect(log.filter((r) => !r.storage).every((r) => r.keySent && r.keyExpected)).toBe(true);
    expect(log.filter((r) => r.storage).every((r) => !r.keySent)).toBe(true);
  });
});

test("a change on both sides asks the researcher", async ({ page, app, zotero }) => {
  const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });
  await linkAndSync(app, projectId, [MY, GROUP]);
  const OKAFOR = "Feeding the City: Informal Markets in Lagos";
  const OKAFOR_HERE = "Feeding the City (the researcher's title)";
  const OKAFOR_ZOTERO = "Feeding the City: Informal Markets in Lagos, 1990–2020";
  const SOUZA = "Kinship and Exchange in Delta Fishing Villages";
  const SOUZA_HERE = "Kinship and Exchange (changed here only)";
  const HERRERA_ZOTERO = "Rivers and Memories in Upland Villages";

  await test.step("the same title changed in Zotero and here; one title changed only in Zotero, one only here", async () => {
    zotero.z.editItem(MY, zotero.keys.okafor, { title: OKAFOR_ZOTERO });
    zotero.z.editItem(GROUP, zotero.keys.group, { title: HERRERA_ZOTERO });
    await retitle(page, projectId, OKAFOR, OKAFOR_HERE);
    await retitle(page, projectId, SOUZA, SOUZA_HERE);
  });

  await test.step("“Sync with Zotero now” on the Zotero screen", async () => {
    await page.goto(`${APP_ORIGIN}/settings/zotero`);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    const after = await settled(app, 4);
    expect(after.slice(0, 2).map((r) => [r.ref, r.outcome, r.counts?.conflicts, r.counts?.changed])).toEqual([
      [GROUP, "finished", 0, 1],
      [MY, "finished", 1, 0],
    ]);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await expectServiceWords(page, app, LABELS_BY_NUMBER);
  });

  await test.step("the library: the researcher's title is still in place; Zotero's own change came in; the change made here only is left alone", async () => {
    const titles = (await sourcesOf(app, projectId)).map((s) => s.title).sort();
    expect(titles).toEqual([OKAFOR_HERE, SOUZA_HERE, HERRERA_ZOTERO].sort());
  });

  await test.step("exactly one entry waits: “Review 1 waiting” leads to it, and it shows Zotero's value", async () => {
    const link = row(page, MY_BY_NUMBER).getByRole("link", { name: "Review 1 waiting in “Market studies”" });
    await expect(link).toBeVisible({ timeout: STATE_TIMEOUT });
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    await expect(page.getByText("1 entry is waiting in this project.", { exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
    const entries = page.getByRole("list", { name: "From captures (1)" }).getByRole("listitem");
    await expect(entries).toHaveCount(1);
    // The entry is the source, under the researcher's title, with the product's reason (bulk/update.ts ZOTERO_CONFLICT_REASON).
    await expect(entries.first()).toContainText(OKAFOR_HERE);
    await expect(entries.first()).toContainText(ZOTERO_CONFLICT_REASON);
    await page.getByRole("button", { name: `Show ${OKAFOR_HERE}` }).click();
    await expect(page.getByRole("region", { name: "Why it needs review" })).toContainText(ZOTERO_CONFLICT_REASON);
    // Zotero's value is there to choose; nothing is decided here.
    await page.getByRole("button", { name: "Title: Conflict" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: new RegExp(escapeRe(OKAFOR_ZOTERO)) })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: new RegExp(escapeRe(OKAFOR_HERE)) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await sourcesOf(app, projectId)).map((s) => s.title)).toContain(OKAFOR_HERE);
  });
});

test("a Zotero deletion shows the mark", async ({ page, app, zotero }) => {
  const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });
  await linkAndSync(app, projectId, [MY]);
  const SOUZA = "Kinship and Exchange in Delta Fishing Villages";
  const before = (await sourcesOf(app, projectId)).map((s) => s.id).sort();
  expect(before).toHaveLength(2);

  await test.step("the item is deleted in Zotero (and its bin emptied), then “Sync with Zotero now”", async () => {
    zotero.z.remove(MY, zotero.keys.souza);
    await page.goto(`${APP_ORIGIN}/settings/zotero`);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    const after = await settled(app, 2);
    expect([after[0]!.outcome, after[0]!.counts?.goneMarked]).toEqual(["finished", 1]);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await expectServiceWords(page, app, LABELS_BY_NUMBER);
    expect(zoteroSyncStatusLine(after[0], new Date())).toMatch(/^Last synced with Zotero at \d\d:\d\d today: 1 deleted or binned in Zotero \(kept here\)\.$/u);
  });

  await test.step("the source is still in the library, and its screen shows the mark in the product's words", async () => {
    expect((await sourcesOf(app, projectId)).map((s) => s.id).sort()).toEqual(before);
    const id = (await sourcesOf(app, projectId)).find((s) => s.title === SOUZA)!.id;
    const stored = await app.api<{ source: { availability: { status: string; zotero?: string; firstNoticedAt?: string } } }>("GET", `/projects/${projectId}/sources/${id}`);
    expect(stored.body.source.availability).toMatchObject({ status: "unavailable-on-platform", zotero: "deleted" });
    // AvailabilityMark.tsx: "No longer in your Zotero library, noticed on 12 March 2027".
    const mark = `No longer in your Zotero library, noticed on ${new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(new Date(stored.body.source.availability.firstNoticedAt!))}`;
    const detail = await openSource(page, projectId, SOUZA);
    await expect(detail.getByRole("note", { name: mark })).toHaveText(mark);
  });

  await test.step("nothing was deleted here, and nothing but GET reached Zotero", async () => {
    const okafor = (await sourcesOf(app, projectId)).find((s) => s.title.startsWith("Feeding the City"))!;
    const listed = await app.api<{ annotations: Array<{ kind: string }> }>("GET", `/projects/${projectId}/sources/${okafor.id}/annotations`);
    expect(listed.body.annotations.map((a) => a.kind)).toEqual(["highlight"]);
    expect(zotero.standIn.requests().every((r) => r.method === "GET")).toBe(true);
  });
});

test("offline reads as a failure", async ({ page, app, zotero }) => {
  const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });
  await linkAndSync(app, projectId, [MY]);
  await page.goto(`${APP_ORIGIN}/settings/zotero`);
  await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });

  await test.step("Zotero cannot be reached: “Sync with Zotero now” ends in the service's failure sentence", async () => {
    await zotero.standIn.close();
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    const after = await settled(app, 2);
    expect([after[0]!.outcome, after[0]!.reason]).toEqual(["failed", "offline"]);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await expectServiceWords(page, app, LABELS_BY_NUMBER);
    const line = zoteroSyncStatusLine(after[0], new Date());
    expect(line).toMatch(new RegExp(`^Could not sync with Zotero at \\d\\d:\\d\\d today: ${escapeRe(ZOTERO_SYNC_REASON_TEXT.offline)} Nothing here was changed\\.$`, "u"));
    // The row and the newest history row say it; the polite region said it when the run ended.
    await expect(row(page, MY_BY_NUMBER).getByText(line, { exact: true })).toBeVisible();
    await expect(history(page).first()).toHaveText(`${MY_BY_NUMBER}: ${line}`);
    await expect(page.getByTestId("zotero-live")).toHaveText(`${MY_BY_NUMBER}: ${line}`);
  });

  await test.step("nothing on the screen reads as success: no “nothing has changed”, no tick", async () => {
    const text = await main(page).innerText();
    expect(text).not.toMatch(/nothing has changed|up to date|✓|✔|☑/iu);
    // The row's line is the failure; the only success left on the screen is the older run's history row.
    await expect(row(page, MY_BY_NUMBER).getByText(/^(Last synced|Checked Zotero)/u)).toHaveCount(0);
    await expect(history(page)).toHaveCount(2);
    await expect(history(page).nth(1)).toContainText("Last synced with Zotero");
  });

  await test.step("Zotero is reachable again on the same address: the next sync recovers and says so", async () => {
    await zotero.standIn.reopen();
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    const after = await settled(app, 3);
    expect(after[0]!.outcome).toBe("up-to-date");
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await expectServiceWords(page, app, LABELS_BY_NUMBER);
    await expect(row(page, MY_BY_NUMBER).getByText(/^Checked Zotero at \d\d:\d\d today: nothing has changed since the last sync\.$/u)).toBeVisible();
  });
});

test("the whole flow by keyboard", async ({ page, app, zotero }) => {
  const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });
  const field = page.getByLabel("Zotero API key");
  const check = page.getByRole("button", { name: "Check the key", exact: true });
  const save = page.getByRole("button", { name: "Save", exact: true });

  await test.step("from the library, the link “Zotero” by Tab and Enter", async () => {
    const link = page.getByRole("link", { name: "Zotero", exact: true });
    await tabTo(page, link);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Zotero" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible({ timeout: STATE_TIMEOUT });
  });

  await test.step("the key typed and stored with Enter: focus stays in the emptied field", async () => {
    await expect(page.getByText("No Zotero key is stored on this computer.")).toBeVisible();
    await tabTo(page, field);
    await page.keyboard.type(KEY);
    await page.keyboard.press("Enter");
    await expect(page.getByText("The key is stored in this computer's password store.")).toBeVisible({ timeout: STATE_TIMEOUT });
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
  });

  await test.step("“Check the key” with Enter: the summary, and focus stays on the button", async () => {
    await tabTo(page, check);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("zotero-key-result")).toHaveText("This key can read your library and 1 group library.", { timeout: STATE_TIMEOUT });
    await expect(check).toBeFocused();
  });

  await test.step("each library kept in step with Space and given the project with the arrow keys", async () => {
    for (const label of [MY_LIBRARY, GROUP_NAME]) {
      const keep = row(page, label).getByRole("checkbox", { name: `Keep “${label}” in step` });
      await tabTo(page, keep);
      await page.keyboard.press("Space");
      await expect(keep).toBeChecked();
      await expect(keep).toBeFocused();
      const into = row(page, label).getByRole("combobox", { name: `Into project for “${label}”` });
      await tabTo(page, into);
      await page.keyboard.press("ArrowDown");
      await expect(into).toHaveValue(projectId);
      await expect(into).toBeFocused();
    }
  });

  await test.step("“Save” with Enter: “Saved.”, and focus stays on Save", async () => {
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("zotero-live")).toHaveText("Saved.", { timeout: STATE_TIMEOUT });
    await expect(save).toBeFocused();
    expect((await syncState(app)).links.map((l) => l.ref)).toEqual([MY, GROUP]);
  });

  await test.step("“Sync with Zotero now” with Enter: the button reads “Stop syncing” with focus on it; back on “Sync with Zotero now” when the run ends", async () => {
    // A slow Zotero, so that the run is seen going.
    zotero.standIn.hold();
    await tabTo(page, runButton(page));
    await expect(runButton(page)).toHaveText("Sync with Zotero now");
    await page.keyboard.press("Enter");
    await expect(runButton(page)).toHaveText("Stop syncing", { timeout: STATE_TIMEOUT });
    await expect(runButton(page)).toBeFocused();
    await expect.poll(() => zotero.standIn.held(), { timeout: STATE_TIMEOUT }).toBeGreaterThan(0);
    zotero.standIn.release();
    await settled(app, 2);
    await expect(runButton(page)).toHaveText("Sync with Zotero now", { timeout: STATE_TIMEOUT });
    await expect(runButton(page)).toBeFocused();
    await expectServiceWords(page, app, LABELS);
  });

  await test.step("the import report of the sync, opened by Tab and Enter", async () => {
    const link = row(page, MY_LIBRARY).getByRole("link", { name: `Import report for “${MY_LIBRARY}”` });
    await tabTo(page, link);
    const batchId = (await runs(app)).find((r) => r.ref === MY)!.batchId!;
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${APP_ORIGIN}/import?project=${encodeURIComponent(projectId)}&batch=${encodeURIComponent(batchId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Bulk import" })).toBeVisible();
    const report = page.getByRole("region", { name: "Report and undo" });
    await expect(report).toBeVisible({ timeout: STATE_TIMEOUT });
    await expect(report.getByRole("row", { name: "Created 2" })).toBeVisible();
  });
});

test("the key is nowhere it should not be", async ({ page, app, zotero }) => {
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
  const consoleLines: string[] = [];
  page.on("console", (m) => void consoleLines.push(m.text()));
  page.on("pageerror", (e) => void consoleLines.push(String(e)));
  const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });

  await test.step("the key saved and checked, both libraries linked, saved and synced, on the screen", async () => {
    await openZoteroScreen(page);
    await page.getByLabel("Zotero API key").fill(KEY);
    await page.getByRole("button", { name: "Store key" }).click();
    await expect(page.getByText("The key is stored in this computer's password store.")).toBeVisible();
    await page.getByRole("button", { name: "Check the key", exact: true }).click();
    await expect(page.getByTestId("zotero-key-result")).toHaveText("This key can read your library and 1 group library.", { timeout: STATE_TIMEOUT });
    for (const label of [MY_LIBRARY, GROUP_NAME]) {
      await row(page, label).getByRole("checkbox", { name: `Keep “${label}” in step` }).check();
      await row(page, label).getByRole("combobox", { name: `Into project for “${label}”` }).selectOption(projectId);
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("zotero-live")).toHaveText("Saved.", { timeout: STATE_TIMEOUT });
    await page.getByRole("button", { name: "Sync with Zotero now" }).click();
    await settled(app, 2);
    await expect(history(page)).toHaveCount(2, { timeout: STATE_TIMEOUT });
  });

  await test.step("in the page's requests: only in the body of the one secrets PUT", async () => {
    await Promise.all(pending);
    expect(seen.length).toBeGreaterThan(10);
    const carrying = seen.filter((r) => `${r.url} ${JSON.stringify(r.headers)} ${r.body ?? ""}`.includes(KEY));
    expect(carrying.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["PUT /secrets/zotero-api-key"]);
    expect(JSON.parse(carrying[0]!.body!)).toEqual({ apiKey: KEY });
    expect(`${carrying[0]!.url} ${JSON.stringify(carrying[0]!.headers)}`).not.toContain(KEY);
  });

  await test.step("not in the page, its fields, its storage or its console", async () => {
    expect(await page.content()).not.toContain(KEY);
    const values = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((e) => (e as HTMLInputElement).value));
    expect(values.join(" ")).not.toContain(KEY);
    const stored = await page.evaluate(() => {
      const dump = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join("\n");
      return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`;
    });
    expect(stored).not.toContain(KEY);
    expect(consoleLines.join("\n")).not.toContain(KEY);
  });

  await test.step("not in the service's output, nor in the stand-in's log (which says only whether it was sent and right)", async () => {
    const log = app.log();
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(KEY);
    const asked = zotero.standIn.requests();
    expect(JSON.stringify(asked)).not.toContain(KEY);
    expect(asked.filter((r) => !r.storage).every((r) => r.keySent && r.keyExpected)).toBe(true);
    expect(asked.filter((r) => r.storage).every((r) => !r.keySent)).toBe(true);
  });
});

// ---------- the scheduler, with a one-second tick ----------

test.describe("with the scheduler's tick at one second (AO_ZOTERO_TICK_MS=1000)", () => {
  test.use({ zoteroTick: 1000 });

  test("back-off holds automatic runs", async ({ page, app, zotero, browserName }) => {
    test.skip(browserName !== "chromium", "R289 b: this scenario proves the service's scheduler; it runs in Chromium only.");
    test.setTimeout(10 * 60_000);
    const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });
    // The library was opened (and the scheduler started, with its 2-minute rule) before this instant.
    const openedBy = Date.now();
    /** What Zotero asks for on the manual run's last API answer (seconds). */
    const BACKOFF_S = 150;

    await test.step("the key saved and checked; library A (the personal library) linked alone and saved; automatic off", async () => {
      await openZoteroScreen(page);
      await page.getByLabel("Zotero API key").fill(KEY);
      await page.getByRole("button", { name: "Store key" }).click();
      await expect(page.getByText("The key is stored in this computer's password store.")).toBeVisible();
      await page.getByRole("button", { name: "Check the key", exact: true }).click();
      await expect(page.getByTestId("zotero-key-result")).toHaveText("This key can read your library and 1 group library.", { timeout: STATE_TIMEOUT });
      await row(page, MY_LIBRARY).getByRole("checkbox", { name: `Keep “${MY_LIBRARY}” in step` }).check();
      await row(page, MY_LIBRARY).getByRole("combobox", { name: `Into project for “${MY_LIBRARY}”` }).selectOption(projectId);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("zotero-live")).toHaveText("Saved.", { timeout: STATE_TIMEOUT });
    });

    let askedAt = 0;
    let manualEnd = 0;
    let record: ZoteroSyncRun | undefined;
    await test.step(`A synced by hand; Zotero answers the run's last API request (the file's address) with “Backoff: ${BACKOFF_S}”`, async () => {
      zotero.standIn.backoffOn(/^\/users\/42\/items\/[^/?]+\/file/u, BACKOFF_S);
      await page.getByRole("button", { name: "Sync with Zotero now" }).click();
      record = (await settled(app, 1))[0]!;
      expect([record.ref, record.trigger, record.outcome]).toEqual([MY, "manual", "finished"]);
      const log = zotero.standIn.requests();
      askedAt = log.find((r) => /\/items\/[^/?]+\/file/u.test(r.path))!.at;
      manualEnd = log.at(-1)!.at;
      // The engine's rule (packages/library/src/import/zotero-sync.ts ZOTERO_SYNC_MIN_BACKOFF_MS; plan, Global Constraints
      // "Back-off"): after any Backoff, no run of any kind before the later of now + 60 minutes and Zotero's own wait.
      expect(Date.parse(record.backoffUntil!)).toBeGreaterThanOrEqual(askedAt + 60 * 60_000 - 5_000);
      expect(Date.parse(record.backoffUntil!)).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 5_000);
    });

    const zoteroEnd = () => askedAt + BACKOFF_S * 1000;
    await test.step("precondition: Zotero's own wait ends clearly (15 s or more) after “library opened + 2 minutes”, so it is the back-off that holds B", async () => {
      expect(zoteroEnd() - (openedBy + 120_000)).toBeGreaterThanOrEqual(15_000);
      expect(Date.now()).toBeLessThan(openedBy + 120_000);
    });

    let state: ZoteroSyncStateResponse | undefined;
    await test.step("library B (the group) linked, never synced; automatic sync on, every 30 minutes; saved", async () => {
      await row(page, GROUP_NAME).getByRole("checkbox", { name: `Keep “${GROUP_NAME}” in step` }).check();
      await row(page, GROUP_NAME).getByRole("combobox", { name: `Into project for “${GROUP_NAME}”` }).selectOption(projectId);
      await page.getByRole("checkbox", { name: "Sync automatically while the app is open" }).check();
      await page.getByRole("combobox", { name: "How often" }).selectOption({ label: "Every 30 minutes" });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("zotero-live")).toHaveText("Saved.", { timeout: STATE_TIMEOUT });
      state = await syncState(app);
      expect([state.automatic, state.everyMinutes, state.links.map((l) => l.ref)]).toEqual([true, 30, [MY, GROUP]]);
      expect(state.backoffUntil).toBe(record!.backoffUntil);
      // B would be due 2 minutes after opening; the back-off holds it, so the next automatic sync is the back-off's end.
      expect(state.nextRunAt).toBe(state.backoffUntil);
    });

    await test.step("the screen says the back-off's reason and “Next automatic sync: not before …” in the service's words", async () => {
      await expect(page.getByTestId("zotero-backoff")).toHaveText(zoteroSyncReasonText("backing-off", new Date(), state!.backoffUntil), { timeout: STATE_TIMEOUT });
      await expect(page.getByText(zoteroNextSyncLine(state!.nextRunAt!, new Date()), { exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
      await expect(runButton(page)).toHaveText("Sync with Zotero now");
      await expect(runButton(page)).toHaveAttribute("aria-disabled", "true");
    });

    await test.step("timed observation: from the end of the manual run until well past B's due time and Zotero's own wait, Zotero is asked nothing", async () => {
      // The one wait on the clock in this spec (R289 b): the log is read every half second until that instant.
      const until = Math.max(zoteroEnd(), openedBy + 120_000) + 20_000;
      while (Date.now() < until) {
        expect(zotero.standIn.requests().filter((r) => r.at > manualEnd)).toEqual([]);
        await page.waitForTimeout(500);
      }
      expect(zotero.standIn.requests().filter((r) => r.at > manualEnd)).toEqual([]);
      // Nothing ran and nothing was recorded for B; the screen still says when the next automatic sync may come.
      expect((await runs(app)).map((r) => r.ref)).toEqual([MY]);
      await expect(page.getByText(zoteroNextSyncLine(state!.nextRunAt!, new Date()), { exact: true })).toBeVisible();
    });

    // R289 b's last part — "then, within a generous limit, the stand-in is asked again and B's run is recorded as
    // automatic" — needs the back-off's end, which the product puts at least 60 minutes after Zotero's answer
    // (ZOTERO_SYNC_MIN_BACKOFF_MS; the 2-minute rule and this floor are not switchable). It is reported for the
    // coordinator's ruling, not waited for.
    test.info().annotations.push({ type: "not observed", description: `B's automatic run after the back-off: the back-off ends ${record!.backoffUntil}, at least 60 minutes after Zotero's answer (ZOTERO_SYNC_MIN_BACKOFF_MS).` });
    await test.step.skip("after the back-off ends, B runs automatically and A does not (not waited for: the back-off lasts at least an hour)", async () => {});
  });

  test("a restart forgets the key; the stored link stays, and an automatic run without a key is recorded once", async ({ page, app, zotero, browserName }) => {
    test.skip(browserName !== "chromium", "It proves the service's scheduler after a restart, as “back-off holds automatic runs” does: Chromium only.");
    test.setTimeout(10 * 60_000);
    const { projectId } = await libraryWithProject(app, page, { library: "Zotero library", project: "Market studies", governanceYaml: OPEN_RULES });

    await test.step("set-up through the service: the key saved and checked; A linked, automatic on every 30 minutes, never synced", async () => {
      expect((await app.api("PUT", "/secrets/zotero-api-key", { apiKey: KEY })).status).toBe(200);
      expect((await app.api("POST", "/zotero/key-check")).status).toBe(200);
      const saved = await app.api("PUT", "/zotero/sync/settings", { automatic: true, everyMinutes: 30, links: [{ ref: MY, projectId, structure: "collections", duplicates: "merge" }] });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    });

    let restartBegan = 0;
    let askedBefore = 0;
    await test.step("the app quits and starts again within the 2 minutes after opening (nothing has run)", async () => {
      expect(await runs(app)).toEqual([]);
      restartBegan = Date.now();
      askedBefore = zotero.standIn.requests().length;
      await app.restart();
    });

    await test.step("the screen: the stored link is shown and the key is asked for, in the screen's words", async () => {
      await page.goto(`${APP_ORIGIN}/settings/zotero`);
      await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible({ timeout: STATE_TIMEOUT });
      await expect(page.getByText("No Zotero key is stored on this computer.")).toBeVisible({ timeout: STATE_TIMEOUT });
      await expect(row(page, MY_BY_NUMBER).getByRole("checkbox", { name: `Keep “${MY_BY_NUMBER}” in step` })).toBeChecked();
      await expect(row(page, MY_BY_NUMBER).getByText(zoteroSyncStatusLine(undefined, new Date()), { exact: true })).toBeVisible();
      expect((await syncState(app)).keyStored).toBe(false);
    });

    let failed: ZoteroSyncRun | undefined;
    await test.step("2 minutes after the library opened again, the automatic run is recorded failed for want of a key, in the service's words", async () => {
      await expect.poll(async () => (await runs(app)).length, { timeout: 4 * 60_000, intervals: [1000] }).toBe(1);
      failed = (await runs(app))[0]!;
      expect([failed.ref, failed.trigger, failed.outcome, failed.reason]).toEqual([MY, "automatic", "failed", "key-missing"]);
      expect(Date.parse(failed.startedAt)).toBeGreaterThanOrEqual(restartBegan + 120_000);
      const line = zoteroSyncStatusLine(failed, new Date());
      expect(line).toMatch(new RegExp(`^Could not sync with Zotero at \\d\\d:\\d\\d today: ${escapeRe(ZOTERO_SYNC_REASON_TEXT["key-missing"])} Nothing here was changed\\.$`, "u"));
      await expect(history(page)).toHaveText([`${MY_BY_NUMBER}: ${line}`], { timeout: STATE_TIMEOUT });
      // No key, no request.
      expect(zotero.standIn.requests().length).toBe(askedBefore);
    });

    await test.step("at most once: the next automatic sync is not before the interval has passed since that record", async () => {
      const s = await syncState(app);
      expect(Date.parse(s.nextRunAt!)).toBeGreaterThanOrEqual(Date.parse(failed!.finishedAt ?? failed!.startedAt) + 30 * 60_000 - 1000);
      await expect(page.getByText(zoteroNextSyncLine(s.nextRunAt!, new Date()), { exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
      expect(await runs(app)).toHaveLength(1);
    });

    await test.step("the key saved again on the screen: “Sync with Zotero now” brings the library in", async () => {
      await page.getByLabel("Zotero API key").fill(KEY);
      await page.getByRole("button", { name: "Store key" }).click();
      await expect(page.getByText("The key is stored in this computer's password store.")).toBeVisible();
      await page.getByRole("button", { name: "Sync with Zotero now" }).click();
      const after = await settled(app, 2);
      expect([after[0]!.trigger, after[0]!.outcome, after[0]!.counts?.new]).toEqual(["manual", "finished", 2]);
      await expectServiceWords(page, app, LABELS_BY_NUMBER);
    });
  });
});
