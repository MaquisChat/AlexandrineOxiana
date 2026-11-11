/**
 * Scenarios 6 and 8 (Task 37's list; PLAN Task 45) against the real service and worker.
 *
 *  6. Move the library to another folder through the Move screen (plan, progress, verification,
 *     deleting the old copy); then rename the library folder outside the app, relaunch (the harness
 *     restarts the service on the same settings), find it with Search on "Library not found" and
 *     reconnect.
 *  8. Source titles in Arabic, Hebrew, Chinese, Japanese, Korean, Devanagari, Greek and Cyrillic in
 *     the library list and on the source screen: right to left for Arabic and Hebrew (the computed
 *     direction), left to right for the others; screenshots at device scale 2 in reports/screens/ for
 *     a human to look at.
 *
 * Elements are found by role and accessible name. Steps the product cannot do yet are
 * `blockedBy(<defect>)` (fixtures.ts), described in the Task 45 report.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, blockedBy, DEFECT_TIMEOUT, expect, expectDefect, libraryWithProject, test, type AppHarness, type Defect, type Page } from "./fixtures.js";
import { REPO_ROOT } from "./paths.js";

interface Libraries {
  libraries: Array<{ libraryId: string; name: string; lastKnownPaths: string[] }>;
  current?: { libraryId: string; name: string; mode: string };
}

const D5: Defect = { id: "D5", title: "on relaunch the app shows “Library not found” for the library that was open (spec 4.5)" };
const D6: Defect = { id: "D6", title: "the app's fonts finish loading in WebKit (no face left in error, document.fonts settles)" };

/** Every file under `dir`, relative to it ("/"-separated). */
function filesUnder(dir: string): string[] {
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

// ---------- scenario 6 ----------

const LIBRARY = "Estuary library";
const PROJECT = "Tide-line interviews";

test("scenario 6: move the library, verify, delete the old copy; rename it outside the app, relaunch, find it with Search and reconnect", async ({ page, app }) => {
  let libraryPath = "";
  let projectId = "";
  let libraryId = "";
  const dest = join(app.root, "elsewhere", LIBRARY);
  const renamed = join(app.root, "elsewhere", `${LIBRARY} (renamed)`);
  let planned = 0;

  await test.step("set-up: a library with a project and one attached PDF (through the service)", async () => {
    ({ libraryPath, projectId } = await libraryWithProject(app, page, { library: LIBRARY, project: PROJECT }));
    mkdirSync(join(app.root, "sources"), { recursive: true });
    const pdf = join(app.root, "sources", "tide-notes.pdf");
    writeFileSync(pdf, await buildPdf({ title: "Tide notes", extra: "tide" }));
    const r = await app.api<{ items: Array<{ outcome: string }> }>("POST", `/projects/${projectId}/attach`, { paths: [pdf] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    libraryId = (await app.api<Libraries>("GET", "/libraries")).body.current!.libraryId;
    await page.reload();
    await expect(page.getByRole("table", { name: "Sources" }).getByRole("button", { name: "Tide notes" })).toBeVisible();
  });

  await test.step("the Move screen is reached from the library", async () => {
    await page.getByRole("link", { name: "Governance and records" }).click();
    await page.getByRole("navigation", { name: "Governance and library" }).getByRole("link", { name: "Move library" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Move library" })).toBeVisible();
  });

  await test.step("the plan: the destination checked, the project allowed to go there", async () => {
    await page.getByRole("textbox", { name: "Destination folder" }).fill(dest);
    await page.getByRole("button", { name: "Check destination" }).click();
    const plan = page.getByRole("region", { name: "Move plan" });
    await expect(plan).toBeVisible();
    await expect(plan.getByRole("row", { name: `${PROJECT} Allowed` })).toBeVisible();
    const text = (await plan.getByText(/files, .* MB, to a destination of kind/).textContent()) ?? "";
    planned = Number(/^([\d,]+) files/.exec(text)?.[1]?.replace(/,/g, ""));
    expect(planned, text).toBeGreaterThan(0);
    expect(existsSync(dest), "nothing is copied by the plan").toBe(false);
  });

  await test.step("the move: progress streamed, every file verified, the app switched to the new place", async () => {
    // What the service streams is recorded on its way to the page (a browser keeps no copy of a
    // streamed body). The page gets the same answer, whole: with a library this small the move
    // takes well under a second, so its live progress bar is not what this step watches.
    let streamed = "";
    const isMove = (url: URL) => url.origin === app.baseUrl && url.pathname === "/libraries/move";
    await page.route(
      isMove,
      async (route) => {
        // As long as the verification wait below: a hung move fails here, not two minutes later.
        const response = await route.fetch({ timeout: 60_000 });
        streamed = await response.text();
        await route.fulfill({ response, body: streamed });
      },
    );
    await page.getByRole("region", { name: "Move plan" }).getByRole("button", { name: "Move library" }).click();
    const verification = page.getByRole("status", { name: "Verification" });
    // Copy and verify run in the service: a generous, explicit wait on a busy machine.
    await expect(verification).toContainText(`All ${planned} files were copied and verified.`, { timeout: 60_000 });
    await expect(verification).toContainText(`The library now opens from ${dest}.`);
    // What the service streamed: progress through copying and verifying, then the verified result.
    await page.unroute(isMove);
    const lines = streamed
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { progress?: { phase: string; filesDone: number; fileCount: number }; done?: boolean; result?: { fileCount: number; newRoot: string } });
    const phases = new Set(lines.flatMap((l) => (l.progress ? [l.progress.phase] : [])));
    expect([...phases], JSON.stringify(lines)).toEqual(expect.arrayContaining(["copy", "verify"]));
    expect(lines.at(-1)).toMatchObject({ done: true, result: { fileCount: planned, newRoot: dest } });
    // What the service persisted: the library at the new place, open there, and the old copy still kept.
    expect(JSON.parse(readFileSync(join(dest, "library.json"), "utf8"))).toMatchObject({ name: LIBRARY });
    const libs = (await app.api<Libraries>("GET", "/libraries")).body;
    expect(libs.current).toMatchObject({ libraryId, mode: "read-write" });
    expect(libs.libraries[0]!.lastKnownPaths[0]).toBe(dest);
    expect(existsSync(join(libraryPath, "library.json")), "the old copy stays until its deletion is confirmed").toBe(true);
  });

  await test.step("checked independently before deleting anything: every file of the old copy is at the new place, byte for byte", async () => {
    // Two differences are by design: the old copy alone carries MOVED.json (the marker "this library
    // was moved from here" that Search reports), and an audit log (append-only .jsonl) at the new
    // place may already have lines added since the move, so the old one must be its exact beginning.
    const old = filesUnder(libraryPath).filter((f) => f !== "MOVED.json");
    expect(old.length).toBeGreaterThan(0);
    expect(existsSync(join(dest, "MOVED.json")), "the moved-from marker is only in the old copy").toBe(false);
    const different = old.filter((f) => {
      if (!existsSync(join(dest, f))) return true;
      const [was, now] = [readFileSync(join(libraryPath, f)), readFileSync(join(dest, f))];
      return /\/audit\/[^/]+\.jsonl$/u.test(f) ? !now.subarray(0, was.length).equals(was) : !now.equals(was);
    });
    expect(different, "files of the old copy missing or different at the new place").toEqual([]);
  });

  await test.step("delete the old copy, after a typed confirmation", async () => {
    await page.getByRole("button", { name: "Delete old copy" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete old copy" });
    await expect(dialog.getByRole("button", { name: "Delete the old copy" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Type delete to confirm" }).fill("delete");
    await dialog.getByRole("button", { name: "Delete the old copy" }).click();
    await expect(page.getByRole("status").filter({ hasText: "The old copy was deleted." })).toBeVisible();
    expect(existsSync(libraryPath), "the old copy is gone").toBe(false);
    expect(existsSync(join(dest, "library.json")), "the moved copy stays").toBe(true);
  });

  await test.step("the library works at its new place", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
    await expect(page.getByRole("heading", { level: 1, name: LIBRARY })).toBeVisible();
    await expect(page.getByRole("table", { name: "Sources" }).getByRole("button", { name: "Tide notes" })).toBeVisible();
  });

  await test.step("rename the library folder outside the app and relaunch", async () => {
    await app.restart(async () => renameSync(dest, renamed));
    await page.goto(`${APP_ORIGIN}/`);
  });

  await blockedBy(D5);

  await test.step("the chooser lists the library at its last place; opening it shows “Library not found”", async () => {
    await page.goto(`${APP_ORIGIN}/`); // D5: start again from the screen the app shows on launch
    await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
    const entry = page.getByRole("list", { name: "Libraries" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: LIBRARY }) });
    await expect(entry.getByText(dest, { exact: true })).toBeVisible();
    await entry.getByRole("button", { name: `Open ${LIBRARY}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Library not found: ${LIBRARY}` })).toBeVisible();
    await expect(page.getByText(`Last seen at ${dest}`)).toBeVisible();
    expect((await app.api<Libraries>("GET", "/libraries")).body.current).toBeUndefined();
  });

  await test.step("Search finds the renamed folder", async () => {
    await page.getByRole("group", { name: "What to do" }).getByRole("button", { name: "Search for library" }).click();
    const results = page.getByRole("region", { name: "Search results" });
    await expect(results.getByText("Search finished.", { exact: true })).toBeVisible({ timeout: 60_000 });
    const found = results.getByRole("list", { name: "Libraries found" }).getByRole("listitem");
    await expect(found).toHaveCount(1);
    await expect(found.getByRole("button", { name: `Use this library at ${renamed}` })).toBeVisible();
  });

  await test.step("reconnect: the library opens from the renamed folder, with its source", async () => {
    await page.getByRole("button", { name: `Use this library at ${renamed}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: LIBRARY })).toBeVisible();
    await expect(page.getByRole("table", { name: "Sources" }).getByRole("button", { name: "Tide notes" })).toBeVisible();
    const libs = (await app.api<Libraries>("GET", "/libraries")).body;
    expect(libs.current).toMatchObject({ libraryId, mode: "read-write" });
    expect(libs.libraries).toHaveLength(1);
    expect(libs.libraries[0]!.lastKnownPaths[0]).toBe(renamed);
    expect((await app.api<{ total: number }>("GET", `/projects/${projectId}/sources`)).body.total).toBe(1);
  });
});

// ---------- scenario 8 ----------

/** One title per script; `rtl` where the text runs right to left. */
const TITLES: Array<{ script: string; title: string; rtl: boolean }> = [
  { script: "Arabic", title: "الأسواق غير الرسمية في القاهرة", rtl: true },
  { script: "Hebrew", title: "שווקים וזיכרון בירושלים", rtl: true },
  { script: "Chinese", title: "上海的街头市场与城市记忆", rtl: false },
  { script: "Japanese", title: "東京の市場と記憶", rtl: false },
  { script: "Korean", title: "서울의 전통 시장과 기억", rtl: false },
  { script: "Devanagari", title: "दिल्ली के बाज़ार और स्मृति", rtl: false },
  { script: "Greek", title: "Οι αγορές της Αθήνας", rtl: false },
  { script: "Cyrillic", title: "Рынки Москвы и память города", rtl: false },
];

const SCREENS = join(REPO_ROOT, "reports", "screens");

/**
 * The computed direction of the source text (UserText, dir=auto): `el` itself when it carries `dir`,
 * else the element inside it that does. There must be one: without it the answer would be the
 * page's own direction, which says nothing about the text.
 */
const directionOf = (el: ReturnType<Page["getByRole"]>) =>
  el.evaluate((e) => {
    const text = e.matches("[dir]") ? e : e.querySelector("[dir]");
    if (!text) throw new Error(`No element with dir in ${e.outerHTML.slice(0, 200)}`);
    return getComputedStyle(text).direction;
  });

/** Sources with these titles, imported through the service from a CSL-JSON file; the page reloaded. */
async function importTitles(app: AppHarness, page: Page, titles: typeof TITLES): Promise<void> {
  const { projectId } = await libraryWithProject(app, page, { library: "Scripts library", project: "Markets in eight scripts" });
  const file = join(app.root, "sources", "titles.json");
  mkdirSync(join(app.root, "sources"), { recursive: true });
  writeFileSync(file, JSON.stringify(titles.map((t, i) => ({ id: `t${i}`, type: "book", title: t.title, issued: { "date-parts": [[2020 + i]] } }))));
  const started = await app.api<{ batchId: string }>("POST", `/projects/${projectId}/import`, { adapter: { kind: "csl-json", path: file }, options: {} });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await expect
    .poll(async () => (await app.api<{ batches: Array<{ batchId: string; state: string }> }>("GET", `/projects/${projectId}/imports`)).body.batches.find((b) => b.batchId === started.body.batchId)?.state, { timeout: 60_000 })
    .toBe("finished");
  const listed = (await app.api<{ items: Array<{ title: string }> }>("GET", `/projects/${projectId}/sources?limit=50`)).body.items.map((i) => i.title);
  expect(listed.sort()).toEqual(titles.map((t) => t.title).sort());
  await page.reload();
}

/** The app's fonts have all loaded, none in error. */
async function fontsSettle(page: Page, timeout = 10_000): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.fonts.status), { timeout }).toBe("loaded");
  expect(await page.evaluate(() => [...document.fonts].filter((f) => f.status === "error").map((f) => `${f.family} ${f.style} ${f.unicodeRange}`))).toEqual([]);
}

/**
 * Before a screenshot in WebKit: D6 leaves a font face of the app in "error" and document.fonts
 * "loading" for good, and a screenshot waits for the fonts. Loading the failed faces again settles
 * them (the files themselves load), so a human still gets WebKit screenshots. The defect itself is
 * the blocked step "the app's fonts finish loading".
 */
async function settleFontsForScreenshot(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all([...document.fonts].filter((f) => f.status === "error").map((f) => f.load().catch(() => undefined))));
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loaded");
}

test.describe("scenario 8", () => {
  // Screenshots for a human to look at: at device scale 2, so the scripts can be read closely.
  test.use({ deviceScaleFactor: 2 });

  test("titles in eight scripts render in the library list and on the source screen, right to left for Arabic and Hebrew", async ({ page, app, browserName }) => {
    await test.step("set-up: eight sources imported from a CSL-JSON file (through the service)", async () => {
      await importTitles(app, page, TITLES);
    });

    await test.step("every title is in the library list, with its computed direction", async () => {
      const table = page.getByRole("table", { name: "Sources" });
      await expect(page.getByText("8 sources", { exact: true })).toBeVisible();
      for (const t of TITLES) {
        const button = table.getByRole("button", { name: t.title, exact: true });
        await expect(button, t.script).toBeVisible();
        expect(await directionOf(button), `${t.script} in the list`).toBe(t.rtl ? "rtl" : "ltr");
      }
      // The interface itself stays left to right.
      expect(await table.evaluate((e) => getComputedStyle(e).direction)).toBe("ltr");
    });

    if (browserName === "webkit") await blockedBy(D6);
    else await test.step("the app's fonts finish loading", () => fontsSettle(page));

    await test.step("screenshot of the list", async () => {
      mkdirSync(SCREENS, { recursive: true });
      await settleFontsForScreenshot(page);
      await page.screenshot({ path: join(SCREENS, `scenario-8-library-list-${browserName}.png`), fullPage: true });
    });

    await test.step("each source screen shows its title in its direction", async () => {
      const table = page.getByRole("table", { name: "Sources" });
      for (const t of TITLES) {
        await table.getByRole("button", { name: t.title, exact: true }).click();
        const heading = page.getByRole("region", { name: "Source details" }).getByRole("heading", { level: 2, name: t.title, exact: true });
        await expect(heading, t.script).toBeVisible();
        expect(await directionOf(heading), `${t.script} on the source screen`).toBe(t.rtl ? "rtl" : "ltr");
      }
    });

    await test.step("each source screen's heading block is itself laid out in its title's direction, not only its inline text (D7)", async () => {
      const table = page.getByRole("table", { name: "Sources" });
      for (const t of TITLES) {
        await table.getByRole("button", { name: t.title, exact: true }).click();
        const heading = page.getByRole("region", { name: "Source details" }).getByRole("heading", { level: 2, name: t.title, exact: true });
        await expect(heading, t.script).toBeVisible();
        expect(await heading.evaluate((e) => getComputedStyle(e).direction), `${t.script} heading block`).toBe(t.rtl ? "rtl" : "ltr");
      }
    });

    await test.step("screenshot of a right-to-left source", async () => {
      const arabic = TITLES[0]!;
      await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: arabic.title, exact: true }).click();
      const detail = page.getByRole("region", { name: "Source details" });
      await expect(detail.getByRole("heading", { level: 2, name: arabic.title, exact: true })).toBeVisible();
      await settleFontsForScreenshot(page);
      await detail.screenshot({ path: join(SCREENS, `scenario-8-rtl-source-arabic-${browserName}.png`) });
    });
  });
});

// ---------- the steps scenarios 6 and 8 cannot do yet, each on its own (expected to fail while the defect reproduces) ----------

test(`${D5.id}: ${D5.title}`, async ({ page, app }) => {
  const { libraryPath } = await libraryWithProject(app, page, { library: LIBRARY, project: PROJECT });
  await app.restart(async () => renameSync(libraryPath, `${libraryPath} (renamed)`));
  await page.goto(`${APP_ORIGIN}/`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expectDefect(D5);
  await expect(page.getByRole("heading", { level: 1, name: `Library not found: ${LIBRARY}` })).toBeVisible({ timeout: DEFECT_TIMEOUT });
});

test(`${D6.id}: ${D6.title}`, async ({ page, browserName }) => {
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
  // Chromium loads every face: there this is an ordinary passing test.
  if (browserName === "webkit") expectDefect(D6);
  await fontsSettle(page, DEFECT_TIMEOUT);
});
