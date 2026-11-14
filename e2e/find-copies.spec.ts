/**
 * Find and acquire, slice 3, end to end (Task F14; Rulings R301, R303, R317, R319, R322, R323): a typed reference
 * becomes a record, a free copy is found and downloaded — and, by the owner's rule, the app NEVER attaches it: the
 * file waits in the review queue for the researcher, with the app's check as advice, and each file is approved or
 * refused by its own act. The project's rules and the "Search sources" settings decide what may be asked and fetched.
 * The real service, the real runner and the real screens, in Chromium and in WebKit.
 *
 * **How a file reaches the app here (R317).** The harness's one switch, the recorded lookup answers
 * (AO_LOOKUP_FIXTURES, honoured only under NODE_ENV=test; R47, R130, R249), also answers FILE downloads:
 * packages/library/tests/fixtures/lookup/answers.json has, beside its lookups (`answers`), a `files` map — for an exact
 * file address, a file of that folder served as the download, or a redirect to another recorded address. The download
 * runs the product's own code from the first byte on (the host rule on every address and redirect, the limits, the type
 * decided by the bytes, the checksum, the part file); an address with no recorded answer ends as "The service did not
 * send the file." and nothing is fetched. With the switch on, nothing of the download reaches the network.
 *
 * **Everything here is made up, and every answer is built by hand (R313 j; brief point 3).** Four works that do not
 * exist — a title, an author, a year and a DOI under the test prefix 10.5555 (WORKS below) — and every recorded answer
 * that gives them, each file named `…-handbuilt.…`:
 *  - the record lookup for each typed line: a Crossref answer listing the one made-up work
 *    (`crossref-find-f14-<work>-handbuilt.json`) and an empty OpenAlex answer (`openalex-search-empty-handbuilt.json`);
 *  - the copy services, for each work, in the services' own shapes: OpenAlex by DOI 404; arXiv by first author and
 *    title an empty feed (`arxiv-query-empty-handbuilt.xml`, already there); Europe PMC by DOI an empty result
 *    (`europepmc-search-empty-handbuilt.json`, already there) — except for RIGHT, an open-access result with a made-up
 *    PMC id, PMC955550001 — made up, and far beyond the range of real ids (in the code's own nine-digit limit,
 *    `^PMC\d{1,9}$`), so that the recorded address is no real article's (R332 e)
 *    (`europepmc-search-f14-right-handbuilt.json`); Semantic Scholar by DOI 404 — except for WRONG, PAIR_A and
 *    PAIR_B, an open-access PDF on arxiv.org under a made-up identifier (`semanticscholar-f14-<work>-handbuilt.json`);
 *  - the files (`files`): RIGHT's Europe PMC address redirects (302) to a made-up address on www.ncbi.nlm.nih.gov,
 *    which serves `f14-right-handbuilt.pdf`; arxiv.org/pdf/5555.01402–01404 serve `f14-wrong-handbuilt.pdf`,
 *    `f14-pair-a-handbuilt.pdf`, `f14-pair-b-handbuilt.pdf`.
 * The four PDFs are one page each, built by the tests' own PDF builder (`buildPdf`, tests/fixtures/generate.mjs) from
 * the definitions in FILES below, and COMMITTED: the service checks at start that every file its answers name is in the
 * folder, and a file written into a committed folder while the spec runs would dirty the checkout. The first test here
 * builds them again and compares the bytes (the builder is deterministic), so the committed files are exactly these
 * made-up pages and nothing else. RIGHT, PAIR_A and PAIR_B show the record's title with its author directly below (the
 * check says "looks right"); WRONG's file shows another made-up title by another made-up author (the check doubts it:
 * "title-absent"). DOAB and the Internet Archive are asked for books only, and these works are articles; Unpaywall is
 * off without an e-mail (the default). So for every typed line every service asked has an answer: a missing one would
 * show as "Some services could not be reached…" or as the engine's waits (60, 300, 900 s), which no scenario waits on.
 *
 * **Waits (R173).** Every wait is for something the SCREEN shows (a state in words, a card, a label, a count) with a
 * generous limit, except scenario 6's timed presses (a rhythm is what it proves: `waitForTimeout(700)` between presses
 * at one spot) and, only after a card has SAID a press was not taken because the list had just changed, a 700 ms wait
 * before pressing again (the product's 600 ms quiet, which the screen does not show ending: `decide`). What the service holds (a source's files, the queue) and what is on disk is read only AFTER the screen
 * has shown the state it follows.
 *
 * **Pressing a found file's control by mouse (R322, R323, R327).** The screen takes a mouse press only where the pointer
 * really moved over that control and the control still stands there (the first movement the page sees does not count,
 * nor one reporting the same place, and a scroll forgets it), and (R327 b) not when it begins within 250 ms
 * (SCROLL_SETTLE_MS) after a scroll of the page: `pressByMouse` scrolls first, waits until the page is at rest — the
 * control at the same place on two looks in a row and the page's own last scroll event more than that behind (read from
 * the page, not a fixed time) — then moves beside the control and onto it, then presses. A press not taken for its place
 * would show "Not taken. Look at the file, then move the pointer and press again." on the card; `decide` accepts only
 * the quiet's sentence as a reason to press again, so that one fails the scenario.
 *
 * **"Not asked" (R332 c).** That a copy service was not asked is read from what the service already writes: its lookup
 * cache, where every answer a lookup of a project without identifiable data gets is kept under the hash of the request's
 * cache key (`copyServicesAsked`). The rules scenario and the Search sources scenario assert there is no copy service's
 * answer for the work while the rules or the settings stop it, and — as the control that the look sees an ask — that
 * the answers of the services then asked are there. The library's unit test of the same rule is runner.test.ts's
 * "nothing is asked and nothing downloaded when the rules do not allow free_copy, and the entry says so in words".
 *
 * **Search sources (R326, R330 c).** A save of "Search sources" wakes the entries those settings had stopped, and
 * "Try again" is offered on them. Scenario 7 proves it end to end: with every copy service off the row rests "Record
 * complete" with "Switched off in Search sources." and "Try again"; "Try again" while they are still off leaves it so,
 * with nothing asked; Europe PMC switched on and saved, the entry goes on with no further press and its file waits.
 *
 * **"Where to get it" on a resting row (Task F15; R324 a, R339 b).** The service's answer for the queue gives each
 * resting entry its `offers`: any link a free-copy service offered, then for a work with a DOI the publisher's page at
 * `https://doi.org/<doi>`, the library's catalogue when one is set (none here), and for a book or a work with an ISBN
 * Open Library and WorldCat (these works are articles). A row resting "No open copy" (after "Not this file"; when the one
 * service asked has no copy) shows them under "Where to get it" as links "<label> (<host>)": `expectWhereToGetIt` reads
 * the entry's offers from the service's own answer and checks that the row shows exactly those, in the service's order,
 * each named by the host parsed here from its address and opening that address, with the publisher's page at
 * `https://doi.org/` + the work's made-up DOI among them (the DOI is the only thing written into the spec). A row resting
 * "Record complete" — by the project's rules, or with every copy service off — is given the same offers by the service,
 * but the screen shows "Where to get it" only on "No open copy" (FindEntryRow), so there `expectOffersNotShown` checks
 * that the service gives them and that the row shows no "Where to get it" and no link.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseGovernance } from "../packages/core/src/governance/schema.js";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LOOKUP_FIXTURES } from "./paths.js";

// ---------- the made-up works, what is typed, and the made-up files ----------

interface Work {
  title: string;
  given: string;
  family: string;
  year: number;
  doi: string;
  journal: string;
  /** The line typed: the author, the full title and the year (sure by the rule as built, A2). */
  typed: string;
}
const work = (w: Omit<Work, "typed">): Work => ({ ...w, typed: `${w.family}, ${w.title} ${w.year}` });
const WORKS = {
  RIGHT: work({ title: "Tidewater Ledgers and the Memory of Small Harbours", given: "Orla", family: "Penhallow", year: 2019, doi: "10.5555/ao.f14.right", journal: "Journal of Invented Coastal Studies" }),
  WRONG: work({ title: "Salt Roads and Seasonal Labour in Upland Parishes", given: "Idris", family: "Calloway", year: 2017, doi: "10.5555/ao.f14.wrong", journal: "Journal of Invented Rural History" }),
  PAIR_A: work({ title: "Lamplight Schools and Evening Reading in Mill Towns", given: "Bettany", family: "Quorn", year: 2015, doi: "10.5555/ao.f14.pair-a", journal: "Journal of Invented Education History" }),
  PAIR_B: work({ title: "Ferry Timetables as Records of Rural Mobility", given: "Cass", family: "Wendle", year: 2021, doi: "10.5555/ao.f14.pair-b", journal: "Journal of Invented Transport Studies" }),
} as const;
const { RIGHT, WRONG, PAIR_A, PAIR_B } = WORKS;

/** Ordinary text, so that each page has the readable text the file check asks for (200 characters). */
const PAGE_TEXT = [
  "The study follows how the people of a few invented places kept their accounts over many years, drawing on",
  "letters and notebooks kept in family hands, and argues that the forms they used shaped what they were able",
  "to remember of the work they had done and of the places they had lived in. Every name here is made up.",
];
/** A first page that shows the record's title with its author directly below: the check says it looks right. */
const goodPdf = (w: Work) =>
  buildPdf({
    title: w.title,
    author: `${w.given} ${w.family}`,
    lines: [`${w.journal} 3 (${w.year})`, w.title, `${w.given} ${w.family}`, `doi:${w.doi}`, "Abstract. A made-up article for the tests of this application; it describes no real work.", ...PAGE_TEXT],
  });
/** WRONG's file: another made-up title by another made-up author. The check doubts it ("title-absent"). */
const OTHER_TITLE = "A Ledger of Other Shores";
const otherPdf = () =>
  buildPdf({
    title: OTHER_TITLE,
    author: "Mirren Ashdown",
    lines: ["Journal of Invented Rural History 9 (2017)", OTHER_TITLE, "Mirren Ashdown", "Abstract. Another made-up article, which is not the work of the record it was offered for.", ...PAGE_TEXT],
  });
/** The committed files (in the recorded answers' folder) and how each is built. */
const FILES: Record<"RIGHT" | "WRONG" | "PAIR_A" | "PAIR_B", { file: string; build: () => Promise<Buffer> }> = {
  RIGHT: { file: "f14-right-handbuilt.pdf", build: () => goodPdf(RIGHT) },
  WRONG: { file: "f14-wrong-handbuilt.pdf", build: otherPdf },
  PAIR_A: { file: "f14-pair-a-handbuilt.pdf", build: () => goodPdf(PAIR_A) },
  PAIR_B: { file: "f14-pair-b-handbuilt.pdf", build: () => goodPdf(PAIR_B) },
};
const fileBytes = (k: keyof typeof FILES) => readFileSync(join(LOOKUP_FIXTURES, FILES[k].file));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Words typed here, looked for where they must never be (an address, a header, the service's output). */
const TYPED_WORDS = ["Tidewater", "Harbours", "Penhallow", "Calloway", "Parishes", "Lamplight", "Quorn", "Wendle", "Timetables"];

/** Rules of a project without identifiable data whose lookups are the defaults; every way of acquiring allowed (the default). */
const LOOKUP_RULES = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n";

/** Generous: lookups, the download, the file check and the queue's reads run in the service on a machine that may be loaded. */
const STATE_TIMEOUT = 60_000;

// ---------- the screens' words (FindEntryRow.tsx, ReviewQueue.tsx, SourceDetail.tsx, GovernanceSettings.tsx, SearchSources.tsx; @ao/shared find.ts, review.ts) ----------

const WORDS = {
  needsCheck: "Needs your check",
  inLibrary: "In your library",
  noOpenCopy: "No open copy",
  recordComplete: "Record complete",
  checkFile: "Check the file",
  tryAgain: "Try again",
  whereToGetIt: "Where to get it",
  /** FIND_REASON_TEXT */
  looksRight: "This looks like the right file. Check it, then use it.",
  notThisWork: "You said the file found was not this work.",
  titleAbsent: "The file does not show this record's title with its author.",
  copyNotAllowed: "This project's rules do not allow fetching free copies of works.",
  switchedOff: "Switched off in Search sources.",
  /** HELD_FILE_LOOKS_RIGHT_TEXT, HELD_FILE_REVIEW_TEXT (the review entry's reason) */
  reviewLooksRight: "A file was found for this record. It looks like the right file: its first page shows the record's title with the author directly below.",
  reviewDoubted: "A file was found for this record, but it did not clearly match.",
  /** FOUND_FILES_TEXT */
  section: "Files found for records",
  right: (k: number) => `Files that look right (${k})`,
  other: (k: number) => `Other files found (${k})`,
  decided: "Decided",
  attached: "File added to its record.",
  discarded: "File removed; the record keeps no file.",
  use: "Use this file",
  notThis: "Not this file",
  notTaken: "Not taken:",
  /** SourceDetail */
  noFiles: "No files attached.",
  readPdf: "Read the PDF",
  /** GovernanceSettings: the card, and ACQUIRE_LABEL.free_copy */
  findCard: "How Find and acquire may get works",
  freeCopies: "Free legal copies (arXiv, Europe PMC, Semantic Scholar, open-access books, the Internet Archive, Unpaywall)",
  neverWithout: "A file found for a record is never added without your confirmation.",
  /** SearchSources */
  copiesGroup: "Finding a free copy",
  copyServices: ["OpenAlex", "Unpaywall", "arXiv", "Europe PMC", "Semantic Scholar", "Directory of Open Access Books", "Internet Archive"],
};

/** A row control's accessible name: "<Act>: “<typed, cut at 80 characters + …>”" (FindEntryRow.tsx shortTyped). */
function act(text: string, typed: string): string {
  const chars = Array.from(typed);
  return `${text}: “${chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : typed}”`;
}
/** How the review queue names a found file's record in its controls (ReviewQueue.tsx describeRecord): "Title (Family, Year)". */
const named = (w: Work) => `${w.title} (${w.family}, ${w.year})`;

// ---------- the Find and acquire screen ----------

const queue = (page: Page) => page.getByRole("list", { name: "Queue" });
const rows = (page: Page) => queue(page).locator(":scope > li");
/** The row of a typed line (each line is typed once per test). */
const rowOf = (page: Page, w: Work) => rows(page).filter({ has: page.locator("[data-entry-text]", { hasText: w.typed }) });
const stateOfRow = (page: Page, w: Work) => rowOf(page, w).locator(".ao-find__state");
const reasonOfRow = (page: Page, w: Work) => rowOf(page, w).locator(".ao-find__reason");

async function openFind(page: Page, projectId: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/find?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Find and acquire" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "References" })).toBeEnabled({ timeout: STATE_TIMEOUT });
}

/**
 * Types the lines and presses "Add"; waits for the box emptied and a row for each line (each line is typed once per
 * test, so its row is found by what was typed — the queue's earlier rows may still be arriving when the screen opens).
 */
async function addLines(page: Page, lines: string[]): Promise<void> {
  const box = page.getByRole("textbox", { name: "References" });
  await box.fill(lines.join("\n"));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(box).toHaveValue("", { timeout: STATE_TIMEOUT });
  for (const line of lines) await expect(rows(page).filter({ has: page.locator("[data-entry-text]", { hasText: line }) })).toHaveCount(1, { timeout: STATE_TIMEOUT });
}

/** A row that rests "Needs your check" with the service's sentence and the link "Check the file". */
async function expectWaiting(page: Page, w: Work, sentence: string): Promise<void> {
  await expect(stateOfRow(page, w)).toHaveText(WORDS.needsCheck, { timeout: STATE_TIMEOUT });
  await expect(reasonOfRow(page, w)).toHaveText(sentence);
  await expect(rowOf(page, w).getByRole("link", { name: act(WORDS.checkFile, w.typed) })).toBeVisible();
}

// ---------- the review queue ----------

const foundSection = (page: Page) => page.getByRole("region", { name: WORDS.section });
/** A found file's card: the list item under its group whose heading is the record's title. */
const cardOf = (page: Page, w: Work) => foundSection(page).getByRole("listitem").filter({ has: page.getByRole("heading", { level: 4, name: w.title, exact: true }) });
/** A fact on a card: the value beside its label ("Creators", "Year", "What the app's check says", "File", …). */
const fact = (card: ReturnType<Page["locator"]>, label: string) => card.locator(`dt:text-is("${label}") + dd`);
const useButton = (page: Page, w: Work) => page.getByRole("button", { name: `${WORDS.use} for ${named(w)}`, exact: true });
const notThisButton = (page: Page, w: Work) => page.getByRole("button", { name: `${WORDS.notThis} for ${named(w)}`, exact: true });

async function openReviewQueue(page: Page, projectId: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/import/review?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: WORDS.section })).toBeVisible({ timeout: STATE_TIMEOUT });
}

/** ReviewQueue.tsx SCROLL_SETTLE_MS (R327 b): a mouse press that begins this soon after a scroll of the page is not taken. */
const SCROLL_SETTLE_MS = 250;

/**
 * A press by mouse as a researcher makes it (R322, R323, R327 b): the control brought into view first (a scroll forgets
 * where controls stood), then — once the page has come to rest: the control stands at the same place on two looks in a
 * row and the page's own last scroll event is more than SCROLL_SETTLE_MS behind (both read from the page, not a fixed
 * time) — the pointer moved beside it and onto it (two movements at different places), then pressed.
 */
async function pressByMouse(page: Page, control: ReturnType<Page["getByRole"]>): Promise<{ x: number; y: number }> {
  // The page's last scroll event, as the screen sees it (window, capture phase); installed once per page.
  await page.evaluate(() => {
    const w = window as unknown as { __aoLastScroll?: number };
    if (w.__aoLastScroll !== undefined) return;
    w.__aoLastScroll = Number.NEGATIVE_INFINITY;
    window.addEventListener("scroll", () => void (w.__aoLastScroll = performance.now()), true);
  });
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  let last = "";
  await expect
    .poll(
      async () => {
        const b = await control.boundingBox();
        const at = JSON.stringify(b && [Math.round(b.x), Math.round(b.y)]);
        const sinceScroll = await page.evaluate(() => performance.now() - (window as unknown as { __aoLastScroll: number }).__aoLastScroll);
        const settled = b !== null && at === last && sinceScroll > SCROLL_SETTLE_MS + 50;
        last = at;
        return settled;
      },
      { timeout: STATE_TIMEOUT, intervals: [100] },
    )
    .toBe(true);
  const box = (await control.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(Math.max(1, box.x - 30), y + 40);
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  return { x, y };
}

/**
 * The product's quiet (R313 c, R318 b, R319 d): for 600 ms after the found files' section is laid out (at the screen's
 * opening, and after any re-read that moves it) no "Use this file" or "Not this file" acts, and a press then is not
 * taken — the card says so ("Not taken: the list had just changed. Look at the file, then press again.") and the press
 * renews the quiet. The screen shows nothing when the quiet ENDS, so after the card has said a press was not taken the
 * scenario does what the sentence asks: it waits 700 ms ("look at the file") and presses again. This is the one timed
 * wait besides scenario 6's rhythm, and it is taken only when the screen has shown the sentence. `press` makes the act
 * (by mouse or by key); it returns when the card shows either the decision or the sentence. Returns how many presses
 * were not taken (kept as an annotation of the test).
 */
async function decide(page: Page, w: Work, result: string, press: () => Promise<void>): Promise<number> {
  const card = cardOf(page, w);
  const outcome = card.locator(".ao-review__file-outcome");
  const notTaken = card.locator(".ao-review__not-taken");
  for (let refused = 0; refused < 5; refused++) {
    await press();
    await expect(outcome.or(notTaken).first()).toBeVisible({ timeout: STATE_TIMEOUT });
    if (await outcome.isVisible()) {
      await expectDecided(page, w, result);
      if (refused) test.info().annotations.push({ type: "presses not taken (the quiet)", description: `${w.title}: ${refused}` });
      return refused;
    }
    await expect(notTaken).toHaveText(/^Not taken: the list had just changed\./);
    await page.waitForTimeout(700); // the product's 600 ms quiet, shown by the card's sentence (see above)
    // The sentence stays until the pointer moves over the card (R323 b): moved over its heading (no press), it goes, so
    // the next press's answer is not mistaken for this one's.
    const head = (await card.getByRole("heading", { level: 4 }).boundingBox())!;
    await page.mouse.move(head.x + 5, head.y + head.height / 2);
    await page.mouse.move(head.x + 25, head.y + head.height / 2, { steps: 2 });
    await expect(notTaken).toHaveCount(0);
  }
  throw new Error(`five presses on “${w.title}” were not taken`);
}

/** A decided card: in its place, marked "Decided", the result in words, and no control that decides. */
async function expectDecided(page: Page, w: Work, result: string): Promise<void> {
  const card = cardOf(page, w);
  await expect(card.locator(".ao-review__file-outcome")).toHaveText(`${WORDS.decided} ${result}`, { timeout: STATE_TIMEOUT });
  await expect(card.getByRole("button", { name: new RegExp(`^(${WORDS.use}|${WORDS.notThis}) for`) })).toHaveCount(0);
  await expect(card).not.toContainText(WORDS.notTaken);
}

// ---------- through the service, and on disk ----------

interface StoredAsset {
  role: string;
  kind: string;
  mime: string;
  sha256: string;
  bytes: number;
  status?: string;
  acquired?: { method: string; via: string; service?: string; address: string; access: string; tool: { name: string }; check?: { result: string; by?: string; why?: string } };
}
interface StoredSource {
  source: { id: string; identifiers?: { doi?: string }; provenance?: { captureMethod: string } };
  assets: StoredAsset[];
}
interface QueueView {
  entries: Array<{ id: string; typed: string; state: string; updatedAt: string; sourceId?: string; reason?: { code: string; by?: string }; offers?: Array<{ label: string; url: string; host: string }> }>;
}

async function queueOf(app: AppHarness, projectId: string): Promise<QueueView> {
  const r = await app.api<QueueView>("GET", `/projects/${projectId}/find`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function entryOf(app: AppHarness, projectId: string, w: Work) {
  const e = (await queueOf(app, projectId)).entries.find((x) => x.typed === w.typed);
  expect(e, `the queue holds an entry for “${w.typed}”`).toBeTruthy();
  return e!;
}
async function stored(app: AppHarness, projectId: string, sourceId: string): Promise<StoredSource> {
  const r = await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${sourceId}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
/**
 * The links the service gives for `w`'s entry (its answer for the queue), checked to hold the publisher's page at
 * `https://doi.org/<w's DOI>` exactly once; the entry must rest in `state`.
 */
async function offersOf(app: AppHarness, projectId: string, w: Work, state: string): Promise<Array<{ label: string; url: string }>> {
  const e = await entryOf(app, projectId, w);
  expect(e.state, `the service's answer holds “${w.typed}” resting in ${state}`).toBe(state);
  const offers = e.offers ?? [];
  expect(offers.length, "the service gives at least one place to get the work").toBeGreaterThan(0);
  expect(offers.filter((o) => o.label === "Publisher's page").map((o) => o.url)).toEqual([`https://doi.org/${w.doi}`]);
  return offers;
}

/**
 * A row resting "No open copy" (R339 b): under "Where to get it" EXACTLY the links the service gives for its entry, in
 * the service's order, each shown as "<label> (<host>)" — the host parsed here from the address, not taken from the
 * service — with that address as its `href`, and no other link there. Called once the screen shows the state.
 */
async function expectWhereToGetIt(page: Page, app: AppHarness, projectId: string, w: Work): Promise<void> {
  const row = rowOf(page, w);
  await expect(row.locator(".ao-find__state")).toHaveText(WORDS.noOpenCopy, { timeout: STATE_TIMEOUT });
  const offers = await offersOf(app, projectId, w, "no-open-copy");
  await expect(row.locator(".ao-find__where-title")).toHaveText(WORDS.whereToGetIt);
  const where = row.getByRole("list", { name: /^Where to get it/ });
  await expect(where).toBeVisible();
  const links = where.getByRole("link");
  await expect(links).toHaveCount(offers.length);
  await expect(row.locator(".ao-find__where a")).toHaveCount(offers.length);
  for (const [i, o] of offers.entries()) {
    await expect(links.nth(i)).toHaveText(`${o.label} (${new URL(o.url).host})`);
    await expect(links.nth(i)).toHaveAttribute("href", o.url);
  }
  test.info().annotations.push({ type: "where-to-get-it", description: `${w.doi} (no open copy): ${offers.map((o) => `${o.label} (${new URL(o.url).host})`).join("; ")}` });
}

/**
 * A row resting "Record complete" by the rules or the settings: the service gives its entry the same kind of offers
 * (the publisher's page among them), but the screen shows "Where to get it" only on "No open copy", so the row shows no
 * "Where to get it" and no link at all.
 */
async function expectOffersNotShown(page: Page, app: AppHarness, projectId: string, w: Work): Promise<void> {
  const row = rowOf(page, w);
  await expect(row.locator(".ao-find__state")).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
  const offers = await offersOf(app, projectId, w, "record-complete");
  await expect(row.locator(".ao-find__where")).toHaveCount(0);
  await expect(row.getByText(WORDS.whereToGetIt)).toHaveCount(0);
  await expect(row.getByRole("link")).toHaveCount(0);
  test.info().annotations.push({ type: "where-to-get-it", description: `${w.doi} (record complete, given but not shown): ${offers.map((o) => `${o.label} (${new URL(o.url).host})`).join("; ")}` });
}

/** The live original files of the record made for `w`. */
async function filesOfRecord(app: AppHarness, projectId: string, w: Work): Promise<StoredAsset[]> {
  const e = await entryOf(app, projectId, w);
  expect(e.sourceId, `a record was made for “${w.typed}”`).toBeTruthy();
  return (await stored(app, projectId, e.sourceId!)).assets.filter((a) => a.role === "original" && a.status !== "destroyed");
}

/** Every file under `dir` (relative paths, "/" separated). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}
/** Where in `dir` a file with exactly these bytes lies (by SHA-256). */
const placesOf = (dir: string, bytes: Buffer) => filesUnder(dir).filter((f) => sha256(readFileSync(join(dir, f))) === sha256(bytes));

// ---------- kept for a failing run (as find.spec.ts): the page's requests with their answers, and the service's log ----------

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}
const seenBy = new WeakMap<Page, { seen: Seen[]; notes: string[]; pending: Array<Promise<void>>; t0: number }>();

test.beforeEach(async ({ page }) => {
  const rec = { seen: [] as Seen[], notes: [] as string[], pending: [] as Array<Promise<void>>, t0: Date.now() };
  seenBy.set(page, rec);
  page.on("request", (r) => {
    rec.notes.push(`${String(Date.now() - rec.t0).padStart(7)} ms → ${r.method()} ${r.url()}`);
    rec.pending.push(
      r.allHeaders().then(
        (headers) => void rec.seen.push({ url: r.url(), method: r.method(), headers, body: r.postDataBuffer() }),
        () => void rec.seen.push({ url: r.url(), method: r.method(), headers: r.headers(), body: r.postDataBuffer() }),
      ),
    );
  });
  page.on("requestfinished", (r) => void r.response().then((res) => rec.notes.push(`${String(Date.now() - rec.t0).padStart(7)} ms ← ${res?.status() ?? 0} ${r.method()} ${r.url()}`), () => {}));
  page.on("requestfailed", (r) => rec.notes.push(`${String(Date.now() - rec.t0).padStart(7)} ms ✗ ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`));
});

/**
 * Point 9, over every scenario of the spec: no typed word in any address or header the page requested, nor in the
 * service's output; no byte of a found file in any request the page made. (A failing run keeps the requests and log.)
 */
test.afterEach(async ({ page, app }, testInfo) => {
  const rec = seenBy.get(page);
  if (testInfo.status !== testInfo.expectedStatus) {
    const requests = testInfo.outputPath("page-requests.txt");
    writeFileSync(requests, (rec?.notes ?? []).join("\n"));
    await testInfo.attach("page-requests", { path: requests, contentType: "text/plain" });
    const log = testInfo.outputPath("service-log.txt");
    writeFileSync(log, app.log());
    await testInfo.attach("service-log-file", { path: log, contentType: "text/plain" });
    return;
  }
  if (!rec || rec.seen.length === 0) return;
  await Promise.all(rec.pending);
  const pdfs = (Object.keys(FILES) as Array<keyof typeof FILES>).map(fileBytes);
  for (const r of rec.seen) {
    const url = decodeURIComponent(r.url).toLowerCase();
    const headers = JSON.stringify(r.headers).toLowerCase();
    for (const w of TYPED_WORDS) {
      expect(url.includes(w.toLowerCase()), `“${w}” is not in ${r.method} ${r.url}`).toBe(false);
      expect(headers.includes(w.toLowerCase()), `“${w}” is not in the headers of ${r.method} ${r.url}`).toBe(false);
    }
    if (r.body) {
      expect(r.body.includes("%PDF-"), `no PDF goes out in ${r.method} ${r.url}`).toBe(false);
      for (const b of pdfs) expect(r.body.includes(b.subarray(0, 512)), `no found file's bytes go out in ${r.method} ${r.url}`).toBe(false);
    }
  }
  const log = app.log().toLowerCase();
  for (const w of TYPED_WORDS) expect(log.includes(w.toLowerCase()), `“${w}” is not in the service's output`).toBe(false);
});

// ---------- the files are made up here ----------

test("the hand-built files are exactly the made-up pages this spec builds", async () => {
  for (const [k, f] of Object.entries(FILES)) {
    const committed = fileBytes(k as keyof typeof FILES);
    expect(committed.equals(await f.build()), `${f.file} is what this spec's ${k} definition builds`).toBe(true);
  }
});

// ---------- point 4 ----------

test("a found file waits for the researcher and is used", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let projectRoot = "";
  const bytes = fileBytes("RIGHT");

  await test.step("set-up: a library and a project with the default lookups and every way of acquiring (through the service)", async () => {
    const made = await libraryWithProject(app, page, { library: "Harbour library", project: "Small harbours", governanceYaml: LOOKUP_RULES });
    projectId = made.projectId;
    projectRoot = join(made.libraryPath, made.projectFolder);
    await openFind(page, projectId);
  });

  await test.step("the reference typed: the record is made, a copy is found and downloaded, and the row says it needs your check", async () => {
    await addLines(page, [RIGHT.typed]);
    await expectWaiting(page, RIGHT, WORDS.looksRight);
  });

  await test.step("before the researcher acts the source holds NO file: the record opened shows none", async () => {
    await page.getByRole("button", { name: act("Open", RIGHT.typed) }).click();
    const detail = page.getByRole("region", { name: "Record" }).getByRole("region", { name: "Source details" });
    await expect(detail.getByRole("heading", { level: 2, name: RIGHT.title, exact: true })).toBeVisible({ timeout: STATE_TIMEOUT });
    await expect(detail.getByText(WORDS.noFiles, { exact: true })).toBeVisible();
    await expect(detail.getByRole("link", { name: WORDS.readPdf })).toHaveCount(0);
    await page.getByRole("region", { name: "Record" }).getByRole("button", { name: "Close", exact: true }).click();
    expect(await filesOfRecord(app, projectId, RIGHT)).toEqual([]);
  });

  let entryId = "";
  await test.step("on disk, the file is only in the project's folder of waiting files", async () => {
    const e = await entryOf(app, projectId, RIGHT);
    entryId = e.id;
    expect(e).toMatchObject({ state: "needs-check", reason: { code: "file-looks-right" } });
    expect(placesOf(projectRoot, bytes)).toEqual([`find/held/${entryId}.pdf`]);
  });

  await test.step("“Check the file” leads to the review queue: the file on its own card under “Files that look right (1)”, with the record, the advice and the file's facts", async () => {
    await rowOf(page, RIGHT).getByRole("link", { name: act(WORDS.checkFile, RIGHT.typed) }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.right(1) })).toBeVisible({ timeout: STATE_TIMEOUT });
    await expect(foundSection(page).getByRole("heading", { level: 3, name: /^Other files found/ })).toHaveCount(0);
    const card = cardOf(page, RIGHT);
    await expect(card).toHaveCount(1);
    await expect(foundSection(page).getByRole("list", { name: WORDS.right(1) }).getByRole("listitem")).toHaveCount(1);
    await expect(fact(card, "Creators")).toContainText(RIGHT.family, { timeout: STATE_TIMEOUT });
    await expect(fact(card, "Year")).toHaveText(String(RIGHT.year));
    await expect(card).toContainText(WORDS.reviewLooksRight);
    await expect(fact(card, "What the app's check says")).toHaveText(WORDS.looksRight);
    await expect(fact(card, "Title in the file")).toHaveText(RIGHT.title);
    await expect(fact(card, "File")).toHaveText("PDF, 2 KB");
    await expect(useButton(page, RIGHT)).toBeVisible();
    await expect(notThisButton(page, RIGHT)).toBeVisible();
  });

  await test.step("“Use this file” (by mouse): the card stays in its place, marked “Decided”, with the result in words", async () => {
    const card = cardOf(page, RIGHT);
    // Where the card stands in the page (scrolling left out: the press scrolls the control into view first).
    const pageTop = () => card.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const before = await pageTop();
    await decide(page, RIGHT, WORDS.attached, async () => void (await pressByMouse(page, useButton(page, RIGHT))));
    expect(Math.abs((await pageTop()) - before)).toBeLessThanOrEqual(1);
    await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.right(0) })).toBeVisible();
  });

  await test.step("the row on the Find and acquire screen says “In your library”", async () => {
    await openFind(page, projectId);
    await expect(stateOfRow(page, RIGHT)).toHaveText(WORDS.inLibrary, { timeout: STATE_TIMEOUT });
    await expect(rowOf(page, RIGHT).getByRole("link", { name: act(WORDS.checkFile, RIGHT.typed) })).toHaveCount(0);
  });

  await test.step("the source holds the file — the same bytes, how it was got recorded with it — and nothing waits any more", async () => {
    const files = await filesOfRecord(app, projectId, RIGHT);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      kind: "pdf",
      mime: "application/pdf",
      sha256: sha256(bytes),
      bytes: bytes.length,
      acquired: {
        method: "free_copy",
        via: "service",
        service: "europepmc",
        // The address the copy was offered at, without its query (cleanAcquiredAddress), not the redirect's target.
        address: "https://europepmc.org/articles/PMC955550001",
        access: "public",
        check: { result: "match", by: "title" },
      },
    });
    const places = placesOf(projectRoot, bytes);
    expect(places).toHaveLength(1);
    expect(places[0]!.startsWith("find/")).toBe(false);
    expect(filesUnder(join(projectRoot, "find", "held"))).toEqual([]);
    expect((await entryOf(app, projectId, RIGHT)).state).toBe("in-library");
  });

  await test.step("the reader renders the file's first page, from the record's “Read the PDF”", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
    await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: RIGHT.title, exact: true }).click();
    const detail = page.getByRole("region", { name: "Source details" });
    await expect(detail.getByText(WORDS.noFiles, { exact: true })).toHaveCount(0);
    await detail.getByRole("link", { name: WORDS.readPdf }).click();
    await expect(page.getByRole("heading", { level: 1, name: RIGHT.title })).toBeVisible({ timeout: STATE_TIMEOUT });
    const first = page.locator('[data-page-number="1"][aria-label="Page 1 of 1"]');
    await expect(first.locator(".ao-reader-text-layer")).toContainText(RIGHT.title, { timeout: STATE_TIMEOUT });
    await expect(first.locator(".ao-reader-text-layer")).toContainText(`${RIGHT.given} ${RIGHT.family}`);
  });
});

// ---------- point 5 ----------

test("a wrong file waits with its reason and is removed", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let projectRoot = "";
  let libraryPath = "";
  const bytes = fileBytes("WRONG");

  await test.step("set-up, and the reference typed: the record is made and the file found waits with the check's reason", async () => {
    const made = await libraryWithProject(app, page, { library: "Parish library", project: "Upland parishes", governanceYaml: LOOKUP_RULES });
    projectId = made.projectId;
    libraryPath = made.libraryPath;
    projectRoot = join(made.libraryPath, made.projectFolder);
    await openFind(page, projectId);
    await addLines(page, [WRONG.typed]);
    await expectWaiting(page, WRONG, WORDS.titleAbsent);
    const e = await entryOf(app, projectId, WRONG);
    expect(e).toMatchObject({ state: "needs-check", reason: { code: "file-title-absent" } });
    expect(placesOf(projectRoot, bytes)).toEqual([`find/held/${e.id}.pdf`]);
    expect(await filesOfRecord(app, projectId, WRONG)).toEqual([]);
  });

  await test.step("in the review queue it stands under “Other files found (1)” with its reason, never a word of approval", async () => {
    await rowOf(page, WRONG).getByRole("link", { name: act(WORDS.checkFile, WRONG.typed) }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.other(1) })).toBeVisible({ timeout: STATE_TIMEOUT });
    await expect(foundSection(page).getByRole("heading", { level: 3, name: /^Files that look right/ })).toHaveCount(0);
    const card = cardOf(page, WRONG);
    await expect(card).toContainText(WORDS.reviewDoubted);
    await expect(fact(card, "What the app's check says")).toHaveText(WORDS.titleAbsent);
    await expect(fact(card, "Title in the file")).toHaveText(OTHER_TITLE);
    for (const approving of ["looks like the right file", "looks right", "the right file"]) await expect(card).not.toContainText(approving);
  });

  await test.step("“Not this file” (by mouse): the card stays, marked “Decided”", async () => {
    await decide(page, WRONG, WORDS.discarded, async () => void (await pressByMouse(page, notThisButton(page, WRONG))));
    await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.other(0) })).toBeVisible();
  });

  await test.step("the row says “No open copy” with the service's sentence for a file you refused, and where to get the work", async () => {
    await openFind(page, projectId);
    await expect(stateOfRow(page, WRONG)).toHaveText(WORDS.noOpenCopy, { timeout: STATE_TIMEOUT });
    await expect(reasonOfRow(page, WRONG)).toHaveText(WORDS.notThisWork);
    await expect(rowOf(page, WRONG).getByRole("button", { name: act(WORDS.tryAgain, WRONG.typed) })).toHaveCount(0);
    // And where the work can be got: exactly the links the service gives for the entry (R339 b).
    await expectWhereToGetIt(page, app, projectId, WRONG);
  });

  await test.step("the file is gone from the project's folder and the library's, and the source has no file", async () => {
    expect(placesOf(projectRoot, bytes)).toEqual([]);
    expect(placesOf(libraryPath, bytes)).toEqual([]);
    expect(await filesOfRecord(app, projectId, WRONG)).toEqual([]);
    expect((await entryOf(app, projectId, WRONG)).state).toBe("no-open-copy");
  });
});

// ---------- point 6 ----------

/** Adds both PAIR references and waits until both files wait; returns the review queue opened on the project. */
async function twoWaiting(page: Page, app: AppHarness, library: string): Promise<{ projectId: string }> {
  const { projectId } = await libraryWithProject(app, page, { library, project: "Evening reading", governanceYaml: LOOKUP_RULES });
  await openFind(page, projectId);
  await addLines(page, [PAIR_A.typed, PAIR_B.typed]);
  await expectWaiting(page, PAIR_A, WORDS.looksRight);
  await expectWaiting(page, PAIR_B, WORDS.looksRight);
  await openReviewQueue(page, projectId);
  await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.right(2) })).toBeVisible({ timeout: STATE_TIMEOUT });
  return { projectId };
}
/** The two cards in the order the screen lays them out. */
async function cardOrder(page: Page): Promise<[Work, Work]> {
  const titles = await foundSection(page).getByRole("list", { name: WORDS.right(2) }).getByRole("heading", { level: 4 }).allTextContents();
  expect([...titles].sort()).toEqual([PAIR_A.title, PAIR_B.title].sort());
  return titles[0] === PAIR_A.title ? [PAIR_A, PAIR_B] : [PAIR_B, PAIR_A];
}
async function fileCounts(app: AppHarness, projectId: string): Promise<{ a: number; b: number }> {
  return { a: (await filesOfRecord(app, projectId, PAIR_A)).length, b: (await filesOfRecord(app, projectId, PAIR_B)).length };
}

test("two found files are each decided by their own act (the mouse left where it was)", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let first: Work = PAIR_A;
  let second: Work = PAIR_B;

  await test.step("two references, two files waiting under “Files that look right (2)”", async () => {
    ({ projectId } = await twoWaiting(page, app, "Mill library"));
    [first, second] = await cardOrder(page);
  });

  await test.step("one press on the first card's “Use this file”, then six more at the same place, about 700 ms apart, without moving: ONE file decided", async () => {
    let spot = { x: 0, y: 0 };
    await decide(page, first, WORDS.attached, async () => void (spot = await pressByMouse(page, useButton(page, first))));
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(700); // the rhythm is what is proved (R173's one exception here)
      await page.mouse.move(spot.x, spot.y); // the same place: no movement
      await page.mouse.down();
      await page.mouse.up();
    }
    // The second file still waits with both its controls; through the service: one record has its file, the other none.
    await expect(useButton(page, second)).toBeVisible();
    await expect(notThisButton(page, second)).toBeVisible();
    await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.right(1) })).toBeVisible();
    const counts = await fileCounts(app, projectId);
    expect(first === PAIR_A ? counts : { a: counts.b, b: counts.a }).toEqual({ a: 1, b: 0 });
    expect((await entryOf(app, projectId, second)).state).toBe("needs-check");
  });

  await test.step("the pointer moved onto the second card's control and pressed: it is decided", async () => {
    await decide(page, second, WORDS.attached, async () => void (await pressByMouse(page, useButton(page, second))));
    await expect(foundSection(page).getByRole("heading", { level: 3, name: WORDS.right(0) })).toBeVisible();
    expect(await fileCounts(app, projectId)).toEqual({ a: 1, b: 1 });
  });
});

test("two found files are each decided by their own act (by keyboard)", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let first: Work = PAIR_A;
  let second: Work = PAIR_B;

  await test.step("two references, two files waiting", async () => {
    ({ projectId } = await twoWaiting(page, app, "Keyboard mill library"));
    [first, second] = await cardOrder(page);
  });

  await test.step("Enter on the first “Use this file”, Enter again at once: ONE file decided, focus on the next waiting card's heading", async () => {
    await decide(page, first, WORDS.attached, async () => {
      await useButton(page, first).focus();
      await expect(useButton(page, first)).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    });
    await expect(cardOf(page, second).getByRole("heading", { level: 4, name: second.title, exact: true })).toBeFocused();
    await expect(useButton(page, second)).toBeVisible();
    const counts = await fileCounts(app, projectId);
    expect(first === PAIR_A ? counts : { a: counts.b, b: counts.a }).toEqual({ a: 1, b: 0 });
  });

  await test.step("Tab, then Enter: the second file is decided", async () => {
    await page.keyboard.press("Tab");
    await expect(useButton(page, second)).toBeFocused();
    await decide(page, second, WORDS.attached, async () => {
      await expect(useButton(page, second)).toBeFocused();
      await page.keyboard.press("Enter");
    });
    expect(await fileCounts(app, projectId)).toEqual({ a: 1, b: 1 });
  });
});

// ---------- point 7 ----------

/**
 * "Save changes" on the Governance screen, then what the screen shows once the save is answered: the button disabled
 * (nothing left to save). "Saved." is shown too, but the screen's re-read of the rules after the save clears it, so on a
 * loaded machine it can come and go between two looks (seen once in WebKit). What the service holds is then read as
 * data (R332 d): the project's rules parsed by the product's own parser (`parseGovernance`, @ao/core), whose
 * `acquireMethods` holds `free_copy` or lacks it. Each save flips it from what it was (the set-up's rules name no list,
 * which is every way), so the poll is answered only by the save itself.
 */
async function saveRules(page: Page, app: AppHarness, projectId: string, freeCopies: boolean): Promise<void> {
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled({ timeout: STATE_TIMEOUT });
  await expect(page.getByRole("alert").filter({ hasText: /could not be saved|changed elsewhere/ })).toHaveCount(0);
  await expect
    .poll(async () => {
      const yaml = (await app.api<{ yaml: string }>("GET", `/projects/${projectId}/governance`)).body.yaml;
      // The rules as data, read by the product's own parser (a project whose rules name no list has every way).
      return parseGovernance(yaml).acquireMethods.includes("free_copy");
    }, { timeout: STATE_TIMEOUT })
    .toBe(freeCopies);
}

/**
 * R332 c (M5): which copy services were ASKED for a work, by what the service already writes — its lookup cache. For a
 * project without identifiable data (these rules) every answer a lookup gets is written to the library's
 * `.cache/lookups/<sha256 of the request's cache key>.json` (lookup/http.ts `get`, `writeCache`), a not-found answer
 * included; the copy services' keys are free-copy.ts's own: `openalex:doi:<doi>`, `free-copy:europepmc:<doi>`,
 * `free-copy:semanticscholar:<doi>` (the DOI in lower case). True for each service whose answer is there.
 */
function copyServicesAsked(libraryPath: string, w: Work): { openalex: boolean; europepmc: boolean; semanticscholar: boolean } {
  const cached = (key: string) => existsSync(join(libraryPath, ".cache", "lookups", `${sha256(Buffer.from(key, "utf8"))}.json`));
  const doi = w.doi.toLowerCase();
  return { openalex: cached(`openalex:doi:${doi}`), europepmc: cached(`free-copy:europepmc:${doi}`), semanticscholar: cached(`free-copy:semanticscholar:${doi}`) };
}
const NONE_ASKED = { openalex: false, europepmc: false, semanticscholar: false };

test("the project's rules switch free copies off", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let projectRoot = "";
  let libraryPath = "";
  const card = () => page.getByRole("region", { name: WORDS.findCard });
  const box = () => card().getByRole("checkbox", { name: WORDS.freeCopies });

  await test.step("set-up; on the Governance screen's card, free copies unticked (no reason asked) and saved", async () => {
    const made = await libraryWithProject(app, page, { library: "Rules library", project: "Rules first", governanceYaml: LOOKUP_RULES });
    projectId = made.projectId;
    libraryPath = made.libraryPath;
    projectRoot = join(made.libraryPath, made.projectFolder);
    await page.getByRole("link", { name: "Governance and records" }).click();
    await expect(card()).toBeVisible({ timeout: STATE_TIMEOUT });
    await expect(card()).toContainText(WORDS.neverWithout);
    await expect(box()).toBeChecked();
    await box().click();
    await expect(page.getByRole("dialog", { name: "Record a reason" })).toHaveCount(0);
    await expect(box()).not.toBeChecked();
    await saveRules(page, app, projectId, false);
  });

  await test.step("the next reference rests “Record complete” with the sentence that the rules do not allow it; no copy service asked, nothing downloaded, nothing waits", async () => {
    await openFind(page, projectId);
    await addLines(page, [PAIR_A.typed]);
    await expect(stateOfRow(page, PAIR_A)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(reasonOfRow(page, PAIR_A)).toHaveText(WORDS.copyNotAllowed, { timeout: STATE_TIMEOUT });
    await expect(rowOf(page, PAIR_A).getByRole("button", { name: act(WORDS.tryAgain, PAIR_A.typed) })).toBeVisible();
    expect(await entryOf(app, projectId, PAIR_A)).toMatchObject({ state: "record-complete", reason: { code: "copy-not-allowed" } });
    await expectOffersNotShown(page, app, projectId, PAIR_A);
    expect(placesOf(libraryPath, fileBytes("PAIR_A"))).toEqual([]);
    expect(filesUnder(join(projectRoot, "find", "held"))).toEqual([]);
    expect(filesUnder(join(libraryPath, ".tmp")).filter((f) => f.startsWith("find-"))).toEqual([]);
    // Nothing asked of a copy service: the lookup cache holds the record's lookups, but no copy service's answer.
    expect(filesUnder(join(libraryPath, ".cache", "lookups")).length).toBeGreaterThan(0);
    expect(copyServicesAsked(libraryPath, PAIR_A)).toEqual(NONE_ASKED);
  });

  await test.step("“Try again” under the same rules: still not allowed, still nothing asked or downloaded", async () => {
    const before = (await entryOf(app, projectId, PAIR_A)).updatedAt;
    const retry = rowOf(page, PAIR_A).getByRole("button", { name: act(WORDS.tryAgain, PAIR_A.typed) });
    await retry.click();
    // The act answered: the button no longer says "Trying again…".
    await expect(retry).toHaveText(WORDS.tryAgain, { timeout: STATE_TIMEOUT });
    // Through the service: the entry was taken up again (written anew) and rests again for the same reason.
    await expect
      .poll(async () => {
        const e = await entryOf(app, projectId, PAIR_A);
        return e.updatedAt !== before && e.state === "record-complete" ? e.reason?.code : null;
      }, { timeout: STATE_TIMEOUT })
      .toBe("copy-not-allowed");
    await expect(reasonOfRow(page, PAIR_A)).toHaveText(WORDS.copyNotAllowed, { timeout: STATE_TIMEOUT });
    await expect(stateOfRow(page, PAIR_A)).toHaveText(WORDS.recordComplete);
    expect(placesOf(libraryPath, fileBytes("PAIR_A"))).toEqual([]);
    expect(copyServicesAsked(libraryPath, PAIR_A)).toEqual(NONE_ASKED);
  });

  await test.step("free copies ticked again (the reason asked and given) and saved: the entry is looked at again and the file found waits", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
    await page.getByRole("link", { name: "Governance and records" }).click();
    await expect(box()).not.toBeChecked({ timeout: STATE_TIMEOUT });
    await box().click();
    const dialog = page.getByRole("dialog", { name: "Record a reason" });
    await dialog.getByRole("textbox", { name: "Reason" }).fill("Open-access copies of the readings are wanted after all");
    await dialog.getByRole("textbox", { name: "Approved by" }).fill("The project lead");
    await dialog.getByRole("button", { name: "Record reason" }).click();
    await expect(dialog).toBeHidden();
    await expect(box()).toBeChecked();
    await saveRules(page, app, projectId, true);
    // A save of the rules looks again at the entries the rules had stopped (R282 f): no "Try again" is needed.
    await openFind(page, projectId);
    await expectWaiting(page, PAIR_A, WORDS.looksRight);
    expect(await filesOfRecord(app, projectId, PAIR_A)).toEqual([]);
    const e = await entryOf(app, projectId, PAIR_A);
    expect(placesOf(projectRoot, fileBytes("PAIR_A"))).toEqual([`find/held/${e.id}.pdf`]);
    // The control: now that the copy services were asked, their answers are in the cache (so the look above sees an ask).
    expect(copyServicesAsked(libraryPath, PAIR_A)).toEqual({ openalex: true, europepmc: true, semanticscholar: true });
  });
});

// ---------- point 8 (R326, R330 c) ----------

test("a copy service switched off in Search sources is not asked; switched on again, the entry it stopped goes on by itself", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let projectRoot = "";
  let libraryPath = "";
  const group = () => page.getByRole("region", { name: WORDS.copiesGroup });

  /** On the Search sources screen (opened for the project), exactly the copy services named ticked, then saved. */
  async function copiesOn(on: string[]): Promise<void> {
    await page.goto(`${APP_ORIGIN}/settings/search-sources?project=${encodeURIComponent(projectId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Search sources" })).toBeVisible();
    await expect(group().getByRole("checkbox", { name: "Europe PMC", exact: true })).toBeEnabled({ timeout: STATE_TIMEOUT });
    for (const name of WORDS.copyServices) {
      const b = group().getByRole("checkbox", { name, exact: true });
      if ((await b.isChecked()) !== on.includes(name)) await b.click();
      await expect(b).toBeChecked({ checked: on.includes(name) });
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // "Saved." is said in the screen's polite region, which the next message may replace at once: the save is known
    // to be answered when "Save" is usable again; what the service holds is then read, and the screen read again below.
    await expect(page.getByRole("button", { name: "Save", exact: true })).not.toHaveAttribute("aria-disabled", "true", { timeout: STATE_TIMEOUT });
    await expect
      .poll(async () => (await app.api<{ copies: Array<{ id: string; on: boolean }> }>("GET", "/settings/search-sources")).body.copies.filter((c) => c.on).length, { timeout: STATE_TIMEOUT })
      .toBe(on.length);
    // Read again: the screen shows what the service now holds.
    await page.reload();
    for (const name of WORDS.copyServices) await expect(group().getByRole("checkbox", { name, exact: true })).toBeChecked({ checked: on.includes(name), timeout: STATE_TIMEOUT });
  }
  /**
   * Nothing of RIGHT's file anywhere in the library, no other file waiting than PAIR_B's (found before), no download's
   * part file, and no copy service's answer for it in the lookup cache: no copy service was asked for it.
   */
  async function nothingFetched(): Promise<void> {
    expect(placesOf(libraryPath, fileBytes("RIGHT"))).toEqual([]);
    expect(filesUnder(join(projectRoot, "find", "held"))).toEqual([`${(await entryOf(app, projectId, PAIR_B)).id}.pdf`]);
    expect(copyServicesAsked(libraryPath, RIGHT)).toEqual(NONE_ASKED);
    expect(filesUnder(join(libraryPath, ".tmp")).filter((f) => f.startsWith("find-"))).toEqual([]);
  }
  const retryOf = (w: Work) => rowOf(page, w).getByRole("button", { name: act(WORDS.tryAgain, w.typed) });

  await test.step("set-up; in Search sources every copy service off but Europe PMC, which has no copy of the next work", async () => {
    const made = await libraryWithProject(app, page, { library: "Switch library", project: "Switched", governanceYaml: LOOKUP_RULES });
    projectId = made.projectId;
    libraryPath = made.libraryPath;
    projectRoot = join(made.libraryPath, made.projectFolder);
    await copiesOn(["Europe PMC"]);
  });

  await test.step("a reference whose only copy is at Semantic Scholar (switched off) ends “No open copy”, with where to get it: nothing downloaded", async () => {
    await openFind(page, projectId);
    await addLines(page, [WRONG.typed]);
    await expect(stateOfRow(page, WRONG)).toHaveText(WORDS.noOpenCopy, { timeout: STATE_TIMEOUT });
    await expect(reasonOfRow(page, WRONG)).toHaveCount(0);
    // "Try again" is not offered on "No open copy" when every service asked answered (FindEntryRow, F11).
    await expect(retryOf(WRONG)).toHaveCount(0);
    expect(placesOf(libraryPath, fileBytes("WRONG"))).toEqual([]);
    // By the lookup cache (see copyServicesAsked): Europe PMC, on, was asked; Semantic Scholar and OpenAlex, off, were not.
    expect(copyServicesAsked(libraryPath, WRONG)).toEqual({ openalex: false, europepmc: true, semanticscholar: false });
    // Where the work can be got: exactly the links the service gives for the entry (R339 b).
    await expectWhereToGetIt(page, app, projectId, WRONG);
  });

  await test.step("Semantic Scholar switched on and saved; a new reference whose copy is there: the file is found and waits", async () => {
    await copiesOn(["Europe PMC", "Semantic Scholar"]);
    await openFind(page, projectId);
    await addLines(page, [PAIR_B.typed]);
    await expectWaiting(page, PAIR_B, WORDS.looksRight);
    // The save woke nothing that did not rest for the settings: the first entry still has no open copy.
    await expect(stateOfRow(page, WRONG)).toHaveText(WORDS.noOpenCopy);
  });

  await test.step("with EVERY copy service off, the next reference rests “Record complete”, switched off in Search sources, and “Try again” is offered", async () => {
    await copiesOn([]);
    await openFind(page, projectId);
    await addLines(page, [RIGHT.typed]);
    await expect(stateOfRow(page, RIGHT)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(reasonOfRow(page, RIGHT)).toHaveText(WORDS.switchedOff, { timeout: STATE_TIMEOUT });
    await expect(retryOf(RIGHT)).toBeVisible();
    expect(await entryOf(app, projectId, RIGHT)).toMatchObject({ state: "record-complete", reason: { code: "switched-off", by: "settings" } });
    await expectOffersNotShown(page, app, projectId, RIGHT);
    await nothingFetched();
  });

  await test.step("“Try again” while they are still off: the settings are looked at again and the entry rests as it was; nothing asked, nothing downloaded", async () => {
    const before = (await entryOf(app, projectId, RIGHT)).updatedAt;
    await retryOf(RIGHT).click();
    // The act answered: the button no longer says "Trying again…".
    await expect(retryOf(RIGHT)).toHaveText(WORDS.tryAgain, { timeout: STATE_TIMEOUT });
    // Through the service: the entry was taken up again (written anew) and has come back to rest for the same reason.
    await expect
      .poll(async () => {
        const e = await entryOf(app, projectId, RIGHT);
        return e.updatedAt !== before && e.state === "record-complete" ? e.reason : null;
      }, { timeout: STATE_TIMEOUT })
      .toEqual({ code: "switched-off", by: "settings" });
    await expect(stateOfRow(page, RIGHT)).toHaveText(WORDS.recordComplete, { timeout: STATE_TIMEOUT });
    await expect(reasonOfRow(page, RIGHT)).toHaveText(WORDS.switchedOff, { timeout: STATE_TIMEOUT });
    await expect(retryOf(RIGHT)).toBeVisible();
    await nothingFetched();
  });

  await test.step("Europe PMC — the one service with its copy — switched on and saved: with no further press the entry goes on, and its file waits", async () => {
    await copiesOn(["Europe PMC"]);
    await openFind(page, projectId);
    // No press on the row: the save of Search sources woke the entry it had stopped (R326 a).
    await expectWaiting(page, RIGHT, WORDS.looksRight);
    const e = await entryOf(app, projectId, RIGHT);
    expect(e).toMatchObject({ state: "needs-check", reason: { code: "file-looks-right" } });
    expect(placesOf(projectRoot, fileBytes("RIGHT"))).toEqual([`find/held/${e.id}.pdf`]);
    expect(await filesOfRecord(app, projectId, RIGHT)).toEqual([]);
    expect(copyServicesAsked(libraryPath, RIGHT)).toEqual({ openalex: false, europepmc: true, semanticscholar: false });
    // The others are as they were: the first still has no open copy, PAIR_B's file still waits.
    await expect(stateOfRow(page, WRONG)).toHaveText(WORDS.noOpenCopy);
    await expectWhereToGetIt(page, app, projectId, WRONG);
    await expect(stateOfRow(page, PAIR_B)).toHaveText(WORDS.needsCheck);
  });
});

// ---------- point 9 ----------

test("what was typed and what was found stay where they belong", async ({ page, app }) => {
  test.setTimeout(240_000);
  let projectId = "";
  let otherId = "";
  let libraryPath = "";
  let projectFolder = "";
  let otherFolder = "";

  await test.step("set-up: a library with two projects; the reference typed in the first; its file waits there", async () => {
    const made = await libraryWithProject(app, page, { library: "Two rooms", project: "First room", governanceYaml: LOOKUP_RULES });
    ({ projectId, libraryPath, projectFolder } = made);
    const other = await app.api<{ project: { id: string; folder: string } }>("POST", "/projects", { name: "Second room", governanceYaml: LOOKUP_RULES, encryption: { enabled: false } });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    otherId = other.body.project.id;
    otherFolder = other.body.project.folder;
    await openFind(page, projectId);
    await addLines(page, [RIGHT.typed]);
    await expectWaiting(page, RIGHT, WORDS.looksRight);
  });

  await test.step("the typed words went in the add's request body only", async () => {
    const rec = seenBy.get(page)!;
    await Promise.all(rec.pending);
    const adds = rec.seen.filter((r) => r.method === "POST" && new URL(r.url).pathname === `/projects/${projectId}/find`);
    expect(adds).toHaveLength(1);
    expect(JSON.parse(adds[0]!.body?.toString("utf8") ?? "{}")).toEqual({ lines: [RIGHT.typed] });
  });

  await test.step("nothing of the first project is in the second's folder, nor in its queue or review queue", async () => {
    const e = await entryOf(app, projectId, RIGHT);
    const secondRoot = join(libraryPath, otherFolder);
    expect(placesOf(secondRoot, fileBytes("RIGHT"))).toEqual([]);
    for (const f of filesUnder(secondRoot)) {
      const text = readFileSync(join(secondRoot, f)).toString("latin1");
      for (const needle of [projectId, e.id, e.sourceId!, projectFolder, ...TYPED_WORDS, RIGHT.doi]) expect(text.includes(needle), `${needle} is not in the second project's ${f}`).toBe(false);
    }
    expect((await queueOf(app, otherId)).entries).toEqual([]);
    const review = await app.api<{ items?: unknown[]; entries?: unknown[] }>("GET", `/projects/${otherId}/review`);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(JSON.stringify(review.body)).not.toContain(RIGHT.title);
    // And the file waits only in the first project's folder of waiting files.
    expect(placesOf(libraryPath, fileBytes("RIGHT"))).toEqual([`${projectFolder}/find/held/${e.id}.pdf`]);
  });
});
