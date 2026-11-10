/**
 * Citation engine (spec 8.1, Task 28, R86).
 *
 * SNAPSHOTS ARE PENDING HUMAN REVIEW against the style guides (APA 7, Chicago 18 author-date,
 * MLA 9, ASA 7, Harvard Cite Them Right). The brief asks for a human to check every entry in
 * `__snapshots__/*.txt` against the published guides before they are relied on; that could not
 * happen in the session that wrote them, so each file carries a "PENDING HUMAN REVIEW" header.
 * Once reviewed, remove the header line from SNAPSHOT_HEADER and update the snapshots (`-u`).
 *
 * The render tests need the CSL bundle built by `pnpm fetch-csl` (scripts/fetch-csl.mjs). Without
 * it they skip locally; in CI (CI=true) a missing bundle fails the suite.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Anchor } from "../model/anchor.js";
import type { Creator, SourceFile, SourceType } from "../model/source.js";
import type { MultiText } from "../model/text.js";
import type { Participant } from "../model/fieldwork.js";
import { newId } from "../ids.js";
import {
  ParticipantCodeMissingError,
  UnknownStyleError,
  listStyles,
  loadStyle,
  locatorFromAnchor,
  renderBibliography,
  renderCitation,
  setCslLoader,
  toCslItem,
  zipCslLoader,
  type CslItem,
  type CslLoader,
  type ToCslOptions,
} from "./index.js";

const CSL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "csl");
const HAVE_BUNDLE = existsSync(join(CSL_DIR, "styles.zip")) && existsSync(join(CSL_DIR, "locales", "locales-en-US.xml"));
if (!HAVE_BUNDLE && process.env.CI === "true") throw new Error("CSL bundle missing: run `pnpm fetch-csl` (scripts/fetch-csl.mjs)");

function bundleLoader(): CslLoader {
  return zipCslLoader(new Uint8Array(readFileSync(join(CSL_DIR, "styles.zip"))), (name) => {
    if (!/^locales(-[A-Za-z0-9-]+\.xml|\.json)$/.test(name)) return undefined;
    const p = join(CSL_DIR, "locales", name);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  });
}

// ------------------------------------------------------------------------------------------
// Fixtures

const AT = "2026-11-01T10:00:00.000Z";
const mt = (...variants: Array<[lang: string, kind: "original" | "romanized" | "translated", value: string]>): MultiText => ({
  variants: variants.map(([lang, kind, value]) => ({ lang, kind, value })),
});

function source(
  type: SourceType,
  title: MultiText,
  creators: Creator[],
  extra: Partial<SourceFile["source"]> = {},
): SourceFile {
  return {
    formatVersion: 1,
    source: {
      id: newId(),
      projectIds: [newId()],
      type,
      title,
      creators,
      identifiers: {},
      citationKey: "key",
      caseAttributes: {},
      provenance: {
        captureMethod: "manual_upload",
        capturedAt: AT,
        tool: { name: "test", version: "0" },
        fileHashes: {},
        legal: { status: "public" },
        identifiable: false,
      },
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
      createdAt: AT,
      createdBy: "tester",
      modifiedAt: AT,
      modifiedBy: "tester",
      folder: "Projects/P/Sources/x",
      ...extra,
    },
    assets: [],
    annotations: [],
    fieldEvidence: [],
    verification: {},
  };
}

/** The participant behind the Instagram reel: identifying details that must never be rendered. */
const PARTICIPANT: Participant = {
  id: newId(),
  projectId: newId(),
  code: "P-014",
  details: { fullName: "Lucía Fernández Ruiz", phone: "+34 600 123 456", village: "Allariz" },
  consentIds: [],
};
/** The project's pseudonym map (spec 4.4): handle or name → participant code. */
const PSEUDONYMS = new Map([["@lucia.cocina", "P-014"]]);

const FIXTURES = {
  journalArticle: source(
    "article-journal",
    mt(["en", "original", "Fermentation and food sovereignty in the Andes"]),
    [
      { role: "author", given: "María José", family: "Quispe" },
      { role: "author", given: "Daniel K.", family: "Ortega" },
    ],
    {
      container: mt(["en", "original", "Journal of Ethnobiology"]),
      volume: "41",
      issue: "2",
      page: "115–134",
      issued: "2021-06",
      identifiers: { doi: "10.5555/joe.2021.0042", issn: "0278-0771" },
    },
  ),
  book: source("book", mt(["en", "original", "The art of fermentation"]), [{ role: "author", given: "Sandor Ellix", family: "Katz" }], {
    publisher: "Chelsea Green Publishing",
    publisherPlace: "White River Junction, VT",
    issued: "2012",
    identifiers: { isbn: ["9781603582865"] },
  }),
  chapter: source(
    "chapter",
    mt(["en", "original", "Kitchen ferments as household knowledge"]),
    [
      { role: "author", given: "Aiko", family: "Tanaka" },
      { role: "editor", given: "Ruth", family: "Mendel" },
      { role: "editor", given: "Omar", family: "Haddad" },
    ],
    { container: mt(["en", "original", "Ferment and society"]), publisher: "Routledge", publisherPlace: "London", page: "45–67", issued: "2019" },
  ),
  youtubeVideo: source(
    "video",
    mt(["en", "original", "How to start a sourdough culture"]),
    [{ role: "channel", literal: "Fermentology Lab", handle: "@fermentologylab" }],
    {
      issued: "2023-05-01",
      accessed: "2026-11-01T09:30:00.000Z",
      identifiers: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", platform: "youtube", platformPostId: "dQw4w9WgXcQ" },
    },
  ),
  instagramReel: source(
    "social-post",
    mt(["es", "original", "Receta de la abuela, sin filtros"], ["en", "translated", "Grandma's recipe, no filters"]),
    [{ role: "uploader", given: "Lucía", family: "Fernández Ruiz", handle: "@lucia.cocina" }],
    {
      issued: "2024-03-02",
      accessed: "2026-10-30T12:00:00.000Z",
      identifiers: { url: "https://www.instagram.com/reel/C4abc123XyZ/", platform: "instagram", platformPostId: "C4abc123XyZ" },
      participantIds: [PARTICIPANT.id],
      provenance: {
        captureMethod: "browser_capture",
        capturedAt: AT,
        tool: { name: "test", version: "0" },
        fileHashes: {},
        legal: { status: "consented" },
        identifiable: true,
      },
    },
  ),
  // (the reel's original video asset is added below)
  fieldPhoto: source("field-photo", mt(["en", "original", "Clay fermentation jars at a market stall"]), [{ role: "photographer", given: "Ana", family: "Castillo" }], {
    issued: "2025-08-14",
  }),
} satisfies Record<string, SourceFile>;

/** An original asset of `kind`/`mime` on a source (what capture stores). */
function withAsset(sf: SourceFile, kind: string, mime: string): SourceFile {
  return {
    ...sf,
    assets: [
      { id: newId(), sourceId: sf.source.id, role: "original", kind, path: `${sf.source.folder}/original/a`, encrypted: false, sha256: "0".repeat(64), bytes: 1, mime },
    ],
  };
}
FIXTURES.instagramReel = withAsset(FIXTURES.instagramReel, "video", "video/mp4");

const OPTS: ToCslOptions = { citationLanguage: "en", translatedTitles: "append", script: "original", pseudonyms: PSEUDONYMS };
const STYLES = ["apa", "chicago-author-date", "modern-language-association", "american-sociological-association", "harvard-cite-them-right"] as const;

// ------------------------------------------------------------------------------------------
// Mapping (no bundle needed)

describe("toCslItem", () => {
  it("maps every source type per the brief's table", () => {
    const expected: Record<SourceType, { type: string; genre?: string; medium?: string }> = {
      book: { type: "book" },
      chapter: { type: "chapter" },
      "article-journal": { type: "article-journal" },
      preprint: { type: "article", genre: "Preprint" },
      report: { type: "report" },
      thesis: { type: "thesis" },
      webpage: { type: "webpage" },
      "social-post": { type: "post" },
      video: { type: "motion_picture", medium: "Video" },
      audio: { type: "song", medium: "Audio" },
      image: { type: "graphic" },
      dataset: { type: "dataset" },
      "field-photo": { type: "graphic", genre: "Field photograph" },
      "field-video": { type: "motion_picture", genre: "Field video" },
      "field-recording": { type: "document", genre: "Field recording" },
      interview: { type: "interview" },
      manuscript: { type: "manuscript" },
      presentation: { type: "speech" },
      other: { type: "document" },
    };
    for (const [t, want] of Object.entries(expected)) {
      const item = toCslItem(source(t as SourceType, mt(["en", "original", "T"]), []), OPTS);
      expect({ type: item.type, genre: item.genre, medium: item.medium }, t).toEqual({ type: want.type, genre: want.genre, medium: want.medium });
    }
    // A field recording with an interviewee is an interview.
    const rec = source("field-recording", mt(["en", "original", "T"]), [
      { role: "interviewee", literal: "P-002" },
      { role: "interviewer", given: "Ana", family: "Castillo" },
    ]);
    const item = toCslItem(rec, OPTS);
    expect(item.type).toBe("interview");
    expect(item.genre).toBe("Field recording");
    expect(item.author).toEqual([{ literal: "P-002" }]);
    expect(item.interviewer).toEqual([{ family: "Castillo", given: "Ana" }]);
  });

  it("maps creators by role, identifiers, dates and the platform as container", () => {
    const yt = toCslItem(FIXTURES.youtubeVideo, OPTS);
    expect(yt.author).toEqual([{ literal: "Fermentology Lab" }]);
    expect(yt.URL).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(yt.issued).toEqual({ "date-parts": [[2023, 5, 1]] });
    expect(yt.accessed).toEqual({ "date-parts": [[2026, 11, 1]] });

    const article = toCslItem(FIXTURES.journalArticle, OPTS);
    expect(article.author).toEqual([
      { family: "Quispe", given: "María José" },
      { family: "Ortega", given: "Daniel K." },
    ]);
    expect(article.DOI).toBe("10.5555/joe.2021.0042");
    expect(article.ISSN).toBe("0278-0771");
    expect(article["container-title"]).toBe("Journal of Ethnobiology");
    expect(article.issued).toEqual({ "date-parts": [[2021, 6]] });

    const book = toCslItem(FIXTURES.book, OPTS);
    expect(book.ISBN).toBe("9781603582865");
    expect(book.publisher).toBe("Chelsea Green Publishing");

    const chapter = toCslItem(FIXTURES.chapter, OPTS);
    expect(chapter.editor).toEqual([
      { family: "Mendel", given: "Ruth" },
      { family: "Haddad", given: "Omar" },
    ]);

    const photo = toCslItem(FIXTURES.fieldPhoto, OPTS);
    expect(photo.author).toEqual([{ family: "Castillo", given: "Ana" }]);

    // Uploader with only a handle: the handle is the literal name.
    const handleOnly = toCslItem(source("social-post", mt(["en", "original", "T"]), [{ role: "uploader", handle: "@someone" }]), OPTS);
    expect(handleOnly.author).toEqual([{ literal: "@someone" }]);
  });

  it("maps the bibliographic fields (R87) and lets genre and medium overrides win", () => {
    const article = toCslItem(FIXTURES.journalArticle, OPTS);
    expect([article.volume, article.issue, article.page]).toEqual(["41", "2", "115–134"]);
    const all = toCslItem(
      source("book", mt(["en", "original", "T"]), [], {
        volume: "3", issue: "1", page: "9", edition: "2nd", numberOfPages: "312", publisherPlace: "London",
        collectionTitle: "Studies in Food", collectionNumber: "7", genre: "Cookbook", medium: "Print",
      }),
      OPTS,
    );
    expect(all).toMatchObject({
      volume: "3", issue: "1", page: "9", edition: "2nd", "number-of-pages": "312", "publisher-place": "London",
      "collection-title": "Studies in Food", "collection-number": "7", genre: "Cookbook", medium: "Print",
    });
    // Overrides beat the type map's genre/medium.
    const photo = toCslItem(source("field-photo", mt(["en", "original", "T"]), [], { genre: "Photograph" }), OPTS);
    expect(photo.genre).toBe("Photograph");
    const video = toCslItem(source("video", mt(["en", "original", "T"]), [], { medium: "Streaming video" }), OPTS);
    expect(video.medium).toBe("Streaming video");
  });

  it("puts the platform in publisher for videos, in container-title for social posts; video posts get genre Video", () => {
    const yt = toCslItem(FIXTURES.youtubeVideo, OPTS);
    expect(yt.publisher).toBe("YouTube");
    expect(yt["container-title"]).toBeUndefined();
    const reel = toCslItem(FIXTURES.instagramReel, OPTS);
    expect(reel["container-title"]).toBe("Instagram");
    expect(reel.publisher).toBeUndefined();
    expect(reel.genre).toBe("Video");
    // A photo post is not a video.
    const photoPost = withAsset(source("social-post", mt(["en", "original", "T"]), [], { identifiers: { platform: "instagram" } }), "image", "image/jpeg");
    expect(toCslItem(photoPost, OPTS).genre).toBeUndefined();
    // TikTok posts are videos even before their file is stored; an override wins.
    const tiktok = source("social-post", mt(["en", "original", "T"]), [], { identifiers: { platform: "tiktok" } });
    expect(toCslItem(tiktok, OPTS).genre).toBe("Video");
    expect(toCslItem({ ...tiktok, source: { ...tiktok.source, genre: "Short video" } }, OPTS).genre).toBe("Short video");
  });

  it("appends the translated title when the original language differs from the citation language", () => {
    expect(toCslItem(FIXTURES.instagramReel, OPTS).title).toBe("Receta de la abuela, sin filtros [Grandma's recipe, no filters]");
    expect(toCslItem(FIXTURES.instagramReel, { ...OPTS, translatedTitles: "off" }).title).toBe("Receta de la abuela, sin filtros");
    // Citing in Spanish: the original is already in the citation language.
    expect(toCslItem(FIXTURES.instagramReel, { ...OPTS, citationLanguage: "es" }).title).toBe("Receta de la abuela, sin filtros");
    // Citing in German: no German translation exists, so nothing is appended.
    expect(toCslItem(FIXTURES.instagramReel, { ...OPTS, citationLanguage: "de" }).title).toBe("Receta de la abuela, sin filtros");
    // Region subtags match by language: en-GB citation, en translation.
    expect(toCslItem(FIXTURES.instagramReel, { ...OPTS, citationLanguage: "en-GB" }).title).toBe(
      "Receta de la abuela, sin filtros [Grandma's recipe, no filters]",
    );
    expect(toCslItem(FIXTURES.instagramReel, OPTS).language).toBe("es");
  });

  it("uses the romanized variant when asked (Russian title)", () => {
    const tolstoy = source(
      "book",
      mt(["ru", "original", "Война и мир"], ["ru-Latn", "romanized", "Voĭna i mir"], ["en", "translated", "War and peace"]),
      [{ role: "author", given: "Lev", family: "Tolstoĭ" }],
      { issued: "1869" },
    );
    expect(toCslItem(tolstoy, { ...OPTS, script: "original", translatedTitles: "off" }).title).toBe("Война и мир");
    expect(toCslItem(tolstoy, { ...OPTS, script: "romanized", translatedTitles: "off" }).title).toBe("Voĭna i mir");
    expect(toCslItem(tolstoy, { ...OPTS, script: "romanized" }).title).toBe("Voĭna i mir [War and peace]");
    expect(toCslItem(tolstoy, { ...OPTS, script: "original" }).title).toBe("Война и мир [War and peace]");
    expect(toCslItem(tolstoy, { ...OPTS, script: "romanized" }).language).toBe("ru");
    // No romanized variant: the original is used.
    expect(toCslItem(FIXTURES.book, { ...OPTS, script: "romanized" }).title).toBe("The art of fermentation");
  });

  it("renders participant-coded creators as the code only, never names or details", () => {
    const item = toCslItem(FIXTURES.instagramReel, OPTS);
    expect(item.author).toEqual([{ literal: "P-014" }]);
    const json = JSON.stringify(item);
    for (const s of ["Lucía", "Fernández", "lucia.cocina", ...Object.values(PARTICIPANT.details!)]) expect(json).not.toContain(s);
  });

  it("pseudonymizes names in titles and drops a URL that carries a participant's name", () => {
    const tiktok = source("social-post", mt(["es", "original", "Lucía cocina con @lucia.cocina"]), [{ role: "uploader", given: "Lucía", family: "Fernández Ruiz", handle: "@lucia.cocina" }], {
      identifiers: { url: "https://www.tiktok.com/@lucia.cocina/video/7300000000000000000", platform: "tiktok" },
    });
    const item = toCslItem(tiktok, OPTS);
    expect(item.title).toBe("P-014 cocina con P-014");
    expect(item.URL).toBeUndefined();
    expect(JSON.stringify(item)).not.toMatch(/luc[ií]a/i);
  });

  it("fails closed when every creator must be coded and one has no code", () => {
    const s = source("interview", mt(["en", "original", "T"]), [{ role: "interviewee", given: "Jane", family: "Doe" }]);
    expect(() => toCslItem(s, { ...OPTS, requireParticipantCodes: true })).toThrow(ParticipantCodeMissingError);
    // The interviewer is the researcher, never a participant.
    const ok = source("interview", mt(["en", "original", "T"]), [{ role: "interviewer", given: "Ana", family: "Castillo" }]);
    expect(toCslItem(ok, { ...OPTS, requireParticipantCodes: true }).interviewer).toEqual([{ family: "Castillo", given: "Ana" }]);
  });
});

describe("locatorFromAnchor", () => {
  const base = { id: newId(), assetId: newId() };
  const tr = (startMs: number, endMs: number): Anchor => ({ kind: "time-range", ...base, startMs, endMs });

  it("pdf anchors give a 1-based page", () => {
    expect(locatorFromAnchor({ kind: "pdf", ...base, page: 12, rects: [{ x: 0, y: 0, w: 1, h: 1 }] })).toEqual({ locator: "12", label: "page" });
  });

  it("time ranges give m:ss–m:ss, or h:mm:ss over an hour, labelled timestamp", () => {
    expect(locatorFromAnchor(tr(38_000, 46_000))).toEqual({ locator: "0:38–0:46", label: "timestamp" });
    expect(locatorFromAnchor(tr(754_000, 782_500))).toEqual({ locator: "12:34–13:02", label: "timestamp" });
    expect(locatorFromAnchor(tr(3_590_000, 3_725_000))).toEqual({ locator: "0:59:50–1:02:05", label: "timestamp" });
    expect(locatorFromAnchor(tr(5_000, 5_000))).toEqual({ locator: "0:05", label: "timestamp" });
  });

  it("refuses negative, NaN and reversed ranges", () => {
    expect(locatorFromAnchor(tr(-1, 5_000))).toBeUndefined();
    expect(locatorFromAnchor(tr(Number.NaN, 5_000))).toBeUndefined();
    expect(locatorFromAnchor(tr(0, Number.POSITIVE_INFINITY))).toBeUndefined();
    expect(locatorFromAnchor(tr(9_000, 5_000))).toBeUndefined();
    expect(locatorFromAnchor({ kind: "pdf", ...base, page: 0, rects: [{ x: 0, y: 0, w: 1, h: 1 }] })).toBeUndefined();
    expect(locatorFromAnchor({ kind: "text-range", ...base, start: 0, end: 4, quote: "abcd", prefix: "", suffix: "" })).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------
// Rendering (needs the bundle)

const SNAPSHOT_HEADER = [
  "PENDING HUMAN REVIEW against the style guides (APA 7, Chicago author-date, MLA 9, ASA, Harvard Cite Them Right).",
  "Generated by packages/core/src/citation/citation.test.ts from the six fixture sources; review every entry before relying on it.",
].join("\n");

describe.skipIf(!HAVE_BUNDLE)("rendering with the bundled styles", () => {
  let items: Record<keyof typeof FIXTURES, CslItem>;
  beforeAll(() => {
    setCslLoader(bundleLoader());
    items = Object.fromEntries(Object.entries(FIXTURES).map(([k, sf]) => [k, toCslItem(sf, OPTS)])) as typeof items;
  });

  it("lists the bundled styles, with search", () => {
    expect(listStyles().length).toBeGreaterThan(5000);
    const chicago = listStyles("chicago");
    expect(chicago.length).toBeGreaterThan(3);
    expect(chicago.map((s) => s.id)).toContain("chicago-author-date");
    for (const s of chicago) expect(`${s.id} ${s.title}`.toLowerCase()).toContain("chicago");
    for (const id of STYLES) expect(loadStyle(id)).toContain("http://purl.org/net/xbiblio/csl");
    expect(() => loadStyle("no-such-style")).toThrow(UnknownStyleError);
  });

  it("loads dependent styles through their independent parent", () => {
    const dep = listStyles().find((s) => s.parent === "apa");
    expect(dep).toBeDefined();
    const xml = loadStyle(dep!.id);
    expect(xml).toContain("<citation");
    expect(renderBibliography([items.book], dep!.id, "text")).toContain("Katz, S. E. (2012). The art of fermentation.");
  });

  it("APA bibliography of the reel has the appended translation and the platform", () => {
    const bib = renderBibliography([items.instagramReel], "apa", "text");
    expect(bib).toContain("Receta de la abuela, sin filtros [Grandma’s recipe, no filters]");
    expect(bib).toContain("Instagram");
    expect(bib).toContain("P-014");
  });

  it("journal articles with volume, issue and pages are not taken for advance or preprint versions (R87)", () => {
    const chicago = renderBibliography([items.journalArticle], "chicago-author-date", "text");
    expect(chicago).not.toContain("ahead of print");
    expect(chicago).toContain("41 (2): 115–34");
    const harvard = renderBibliography([items.journalArticle], "harvard-cite-them-right", "text");
    expect(harvard).not.toContain("[Preprint]");
    expect(harvard).toContain("41(2), pp. 115–134");
    expect(renderBibliography([items.journalArticle], "apa", "text")).toContain("Journal of Ethnobiology, 41(2), 115–134.");
  });

  it("APA cites a YouTube video as \"[Video]. YouTube.\" and a reel as \"[Video]. Instagram.\"", () => {
    const yt = renderBibliography([items.youtubeVideo], "apa", "text");
    expect(yt).toContain("How to start a sourdough culture [Video]. YouTube. https://www.youtube.com/");
    expect(yt).not.toContain("In YouTube");
    expect(renderBibliography([items.instagramReel], "apa", "text")).toContain("[Grandma’s recipe, no filters] [Video]. Instagram.");
  });

  it("puts a timestamp locator into the citation", () => {
    const loc = locatorFromAnchor({ kind: "time-range", id: newId(), assetId: newId(), startMs: 38_000, endMs: 46_000 })!;
    expect(renderCitation([{ item: items.youtubeVideo, ...loc }], "apa", "text")).toBe("(Fermentology Lab, 2023, 0:38–0:46)");
    expect(renderCitation([{ item: items.book, locator: "12", label: "page" }], "apa", "text")).toBe("(Katz, 2012, p. 12)");
  });

  it("renders a romanized Russian title", () => {
    const tolstoy = source("book", mt(["ru", "original", "Война и мир"], ["ru-Latn", "romanized", "Voĭna i mir"], ["en", "translated", "War and peace"]), [{ role: "author", given: "Lev", family: "Tolstoĭ" }], { issued: "1869" });
    const bib = renderBibliography([toCslItem(tolstoy, { ...OPTS, script: "romanized" })], "apa", "text");
    expect(bib).toContain("Voĭna i mir [War and peace]");
    expect(bib).not.toContain("Война");
  });

  it("never renders a participant's name or details, in any style, format, citation or bibliography", () => {
    const forbidden = ["Lucía", "Lucia", "Fernández", "Fernandez", "lucia.cocina", ...Object.values(PARTICIPANT.details!)];
    for (const style of STYLES) {
      for (const format of ["text", "html", "rtf"] as const) {
        const out = [
          renderCitation([{ item: items.instagramReel, locator: "0:38–0:46", label: "timestamp" }], style, format),
          renderBibliography(Object.values(items), style, format),
        ].join("\n");
        expect(out, `${style}/${format}`).toContain("P-014");
        for (const s of forbidden) expect(out.toLowerCase(), `${style}/${format}: ${s}`).not.toContain(s.toLowerCase());
        // RTF escapes non-ASCII letters (\uN); check the escaped forms too.
        if (format === "rtf") expect(out).not.toMatch(/Luc\\u237/);
      }
    }
  });

  it("escapes HTML in html output (a title with <script>)", () => {
    const evil = toCslItem(
      source("webpage", mt(["en", "original", `Bad <script>alert("x")</script> & <img src=x onerror=alert(1)> title`]), [{ role: "author", literal: "<b onmouseover=alert(1)>Mallory</b>" }], {
        identifiers: { url: `https://example.org/?q="><script>alert(2)</script>` },
        issued: "2024",
      }),
      OPTS,
    );
    for (const style of STYLES) {
      const html = renderBibliography([evil], style, "html") + renderCitation([{ item: evil }], style, "html");
      // The only tags are citeproc's own formatting tags; every field value arrives escaped.
      const tags = html.match(/<[^>]*>/g) ?? [];
      for (const t of tags) expect(t, style).toMatch(/^<\/?(div|i|b|span|sup|sub)( class="csl-[a-z-]+"| style="[a-z:;\- ]+")?>$/);
      expect(html, style).not.toMatch(/<script|<img|<b /i);
      expect(html, style).toContain("&#60;script&#62;");
      expect(html.toLowerCase(), style).toContain("&#60;img src=x onerror=alert(1)&#62;");
    }
  });

  it("produces RTF with braces and backslashes escaped", () => {
    const item = toCslItem(source("book", mt(["en", "original", "Braces {x} and \\par injection"]), [{ role: "author", given: "A", family: "B" }], { issued: "2020" }), OPTS);
    const rtf = renderBibliography([item], "apa", "rtf");
    // The backslash is escaped (\\par), so no RTF control word \par reaches the reader.
    expect(rtf).toContain("\\\\par injection");
    expect(rtf).not.toMatch(/(?<!\\)\\par injection/);
    expect(rtf).toMatch(/\\\{x\\\}/);
  });

  it("honours the lang parameter", () => {
    // APA's own date order (year, month day), with the German month name.
    expect(renderBibliography([items.youtubeVideo], "apa", "text", "de-DE")).toContain("(2023, Mai 1)");
    expect(renderBibliography([items.youtubeVideo], "apa", "text", "en-US")).toContain("(2023, May 1)");
    // A bare language maps to its primary dialect (de → de-DE: German quotation marks in MLA).
    const mlaDe = renderBibliography([items.journalArticle], "modern-language-association", "text", "de");
    expect(mlaDe).toBe(renderBibliography([items.journalArticle], "modern-language-association", "text", "de-DE"));
    expect(mlaDe).toContain("„Fermentation and Food Sovereignty in the Andes“");
    // A locale the bundle lacks falls back to en-US.
    expect(renderBibliography([items.youtubeVideo], "apa", "text", "xx-XX")).toContain("(2023, May 1)");
  });

  it.each(STYLES)("matches the reviewed snapshot for %s", async (style) => {
    const parts: string[] = [SNAPSHOT_HEADER, `style: ${style}`, ""];
    for (const [name, item] of Object.entries(items)) {
      parts.push(`## ${name}`);
      parts.push(`citation:     ${renderCitation([{ item }], style, "text")}`);
      const loc = name === "youtubeVideo" || name === "instagramReel" ? { locator: "0:38–0:46", label: "timestamp" as const } : { locator: "12", label: "page" as const };
      if (name !== "fieldPhoto") parts.push(`with locator: ${renderCitation([{ item, ...loc }], style, "text")}`);
      parts.push(`bibliography: ${renderBibliography([item], style, "text").trim()}`);
      parts.push(`html:         ${renderBibliography([item], style, "html").trim()}`);
      parts.push("");
    }
    parts.push("## all six, one bibliography");
    parts.push(renderBibliography(Object.values(items), style, "text").trim());
    parts.push("");
    await expect(parts.join("\n")).toMatchFileSnapshot(`./__snapshots__/${style}.txt`);
  });
});
