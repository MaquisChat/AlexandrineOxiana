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
  normName,
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
        collectionTitle: "Studies in Food", collectionNumber: "7", genre: "Cookbook", medium: "Print", number: "WP-17",
      }),
      OPTS,
    );
    expect(all.number).toBe("WP-17");
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
    expect(item.title).toBe("P-014 con P-014"); // "Lucía cocina" is also the handle's words (lucia.cocina)
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

describe("review round 1 (R88 I1, I2): participant names are matched however they are written", () => {
  const reel = (creator: Creator, extra: Partial<SourceFile["source"]> = {}) =>
    source("social-post", mt(["es", "original", "Receta"]), [creator], { participantIds: [PARTICIPANT.id], ...extra });
  const LUCIA: Creator = { role: "uploader", given: "Lucía", family: "Fernández Ruiz", handle: "@lucia.cocina" };

  it("probe 1: a map key with '@' and capitals matches a handle without them", () => {
    const item = toCslItem(reel({ role: "uploader", handle: "lucia.cocina" }), { ...OPTS, pseudonyms: new Map([["@Lucia.Cocina", "P-014"]]) });
    expect(item.author).toEqual([{ literal: "P-014" }]);
  });

  it("probe 2: accents, decomposed (NFD) and full-width forms match the map", () => {
    const map = new Map([["Lucía Fernández Ruiz", "P-014"]]);
    expect(toCslItem(reel({ role: "uploader", given: "Lucia", family: "Fernandez Ruiz" }), { ...OPTS, pseudonyms: map }).author).toEqual([{ literal: "P-014" }]);
    expect(toCslItem(reel({ role: "uploader", given: "Luci\u0301a", family: "Ferna\u0301ndez Ruiz" }), { ...OPTS, pseudonyms: map }).author).toEqual([{ literal: "P-014" }]);
    expect(toCslItem(reel({ role: "uploader", literal: "ＬＵＣＩＡ ＦＥＲＮＡＮＤＥＺ ＲＵＩＺ" }), { ...OPTS, pseudonyms: map }).author).toEqual([{ literal: "P-014" }]);
  });

  it("probe 3: titles, container and publisher are scrubbed of every pseudonym-map entry, also people who are not creators here", () => {
    const map = new Map([["@lucia.cocina", "P-014"], ["Marta Pérez", "P-020"]]);
    const sf = reel(LUCIA, {
      title: mt(["es", "original", "Cocinando con MARTA PEREZ y @lucia.cocina"]),
      container: mt(["es", "original", "Las recetas de Marta Pérez"]),
      publisher: "Ediciones marta perez",
    });
    const item = toCslItem({ ...sf, source: { ...sf.source, type: "book" } }, { ...OPTS, pseudonyms: map });
    expect(item.title).toBe("Cocinando con P-020 y P-014");
    expect(item["container-title"]).toBe("Las recetas de P-020");
    expect(item.publisher).toBe("Ediciones P-020");
  });

  it("probe 4: a URL with the name in any slug form (joined, -, ., _) is left out", () => {
    for (const slug of ["luciafernandezruiz", "lucia-fernandez", "lucia.fernandez.ruiz", "lucia_fernandez", "Lucía-Fernández", "fernandez-ruiz"]) {
      const item = toCslItem(reel(LUCIA, { identifiers: { url: `https://www.instagram.com/${slug}/reel/C4/`, platform: "instagram" } }), OPTS);
      expect(item.URL, slug).toBeUndefined();
    }
    const ok = toCslItem(reel(LUCIA, { identifiers: { url: "https://www.instagram.com/reel/C4abc/", platform: "instagram" } }), OPTS);
    expect(ok.URL).toBe("https://www.instagram.com/reel/C4abc/");
  });

  it("probe 5: no length floor for URLs: a two-letter handle in the URL drops it, but not as part of a longer word", () => {
    const li = reel({ role: "uploader", handle: "@li" }, { identifiers: { url: "https://www.tiktok.com/@li/video/7300", platform: "tiktok" } });
    const map = new Map([["@li", "P-031"]]);
    expect(toCslItem(li, { ...OPTS, pseudonyms: map }).URL).toBeUndefined();
    const other = reel({ role: "uploader", handle: "@li" }, { identifiers: { url: "https://www.linkedin.com/posts/7300", platform: "other" } });
    expect(toCslItem(other, { ...OPTS, pseudonyms: map }).URL).toBe("https://www.linkedin.com/posts/7300");
  });

  it("probe 6: the citation key is not copied when the source has participants", () => {
    const sf = reel(LUCIA, { citationKey: "fernandezruiz2024receta" });
    expect(toCslItem(sf, OPTS)["citation-key"]).toBeUndefined();
    expect(toCslItem(FIXTURES.book, OPTS)["citation-key"]).toBe("key");
  });

  it("probe 7: names in the title are matched across case, accents and an '@' prefix", () => {
    const sf = reel(LUCIA, { title: mt(["es", "original", "LUCIA FERNANDEZ RUIZ cocina; sigue a @Lucia.Cocina"]) });
    expect(toCslItem(sf, OPTS).title).toBe("P-014 cocina; sigue a P-014");
  });

  it("Rose gardens: a bare given or family name is replaced when it has 4+ letters or stands next to the other part (fail-safe over-scrubbing, short names only with their partner)", () => {
    const rose: Creator = { role: "interviewee", given: "Rose", family: "Li" };
    const map = new Map([["Rose Li", "P-040"]]);
    const t = (title: string) =>
      toCslItem(source("interview", mt(["en", "original", title]), [rose], { participantIds: [PARTICIPANT.id] }), { ...OPTS, pseudonyms: map }).title;
    expect(t("Rose gardens on the Li river")).toBe("P-040 gardens on the Li river"); // "Rose" (4) replaced; bare "Li" (2) kept
    expect(t("Talking with Rose Li about Li Bai")).toBe("Talking with P-040 about Li Bai");
    expect(t("Li, Rose: an oral history")).toBe("P-040: an oral history");
    expect(t("Primrose and Roseanne")).toBe("Primrose and Roseanne"); // whole words only
  });

  it("I2: a source with participants fails closed when a creator other than the interviewer has no code", () => {
    const s = source("interview", mt(["en", "original", "T"]), [{ role: "interviewee", given: "Jane", family: "Doe" }], { participantIds: [PARTICIPANT.id] });
    expect(() => toCslItem(s, { ...OPTS, pseudonyms: new Map() })).toThrow(ParticipantCodeMissingError);
    expect(() => toCslItem(s, { citationLanguage: "en", translatedTitles: "off", script: "original" })).toThrow(ParticipantCodeMissingError);
    const researcher = source("interview", mt(["en", "original", "T"]), [{ role: "interviewer", given: "Ana", family: "Castillo" }], { participantIds: [PARTICIPANT.id] });
    expect(toCslItem(researcher, { ...OPTS, pseudonyms: new Map([["@someone", "P-001"]]) }).interviewer).toEqual([{ family: "Castillo", given: "Ana" }]);
  });

  it("R89: a source with participants and no pseudonym map fails closed, even without creators", () => {
    const none = source("interview", mt(["en", "original", "T"]), [], { participantIds: [PARTICIPANT.id] });
    expect(() => toCslItem(none, { ...OPTS, pseudonyms: new Map() })).toThrow(ParticipantCodeMissingError);
    expect(() => toCslItem(none, { citationLanguage: "en", translatedTitles: "off", script: "original" })).toThrow(ParticipantCodeMissingError);
    const researcher = source("interview", mt(["en", "original", "T"]), [{ role: "interviewer", given: "Ana", family: "Castillo" }], { participantIds: [PARTICIPANT.id] });
    expect(() => toCslItem(researcher, { ...OPTS, pseudonyms: new Map() })).toThrow(ParticipantCodeMissingError);
  });

  it("R89: letters NFKD does not decompose (ł ø đ ß æ œ þ ı) are transliterated before folding: Łukasz Wałęsa", () => {
    const map = new Map([["Lukasz Walesa", "P-050"]]);
    const sf = source("interview", mt(["pl", "original", "Rozmowa: ŁUKASZ WAŁĘSA w Gdańsku"]), [{ role: "interviewee", given: "Łukasz", family: "Wałęsa" }], {
      participantIds: [PARTICIPANT.id],
      identifiers: { url: "https://example.org/archiwum/lukasz-walesa/1" },
    });
    const item = toCslItem(sf, { ...OPTS, pseudonyms: map });
    expect(item.author).toEqual([{ literal: "P-050" }]);
    expect(item.title).toBe("Rozmowa: P-050 w Gdańsku");
    expect(item.URL).toBeUndefined();
    expect(normName("Øster Þór Æbelø Straße Œuvre Iıl Đorđe")).toBe("oster thor aebelo strasse oeuvre iil dorde");
  });

  it("R89: joined name forms are found in titles too (marialopez)", () => {
    const sf = source("social-post", mt(["es", "original", "Recetas de marialopez y de MariaLopez"]), [{ role: "uploader", given: "María", family: "López" }], { participantIds: [PARTICIPANT.id] });
    expect(toCslItem(sf, { ...OPTS, pseudonyms: new Map([["María López", "P-060"]]) }).title).toBe("Recetas de P-060 y de P-060");
  });
});

describe("the participant-name rule shared with folder names (R378 a, FR-A10)", () => {
  const interview = (title: string, creators: Creator[], extra: Partial<SourceFile["source"]> = {}) =>
    source("interview", mt(["und", "original", title]), creators, { participantIds: [PARTICIPANT.id], ...extra });

  it("C1: a creator's name written without spaces is replaced in the title too (王小明访谈录, 山田太郎さんへのインタビュー)", () => {
    const item = toCslItem(interview("王小明访谈录", [{ role: "interviewee", literal: "王小明" }]), { ...OPTS, pseudonyms: new Map([["王小明", "P-001"]]) });
    expect(item.author).toEqual([{ literal: "P-001" }]);
    expect(item.title).toBe("P-001访谈录");
    const yamada = toCslItem(interview("山田太郎さんへのインタビュー", [{ role: "interviewee", family: "山田", given: "太郎" }]), { ...OPTS, pseudonyms: new Map([["山田太郎", "P-005"]]) });
    expect(yamada.author).toEqual([{ literal: "P-005" }]);
    expect(yamada.title).toBe("P-005さんへのインタビュー");
  });

  it("C1: a map entry written without spaces is replaced in the title of a source by someone else", () => {
    const sf = source("article-journal", mt(["zh", "original", "关于王小明的报道"]), [{ role: "author", given: "Wei", family: "Chen" }]);
    expect(toCslItem(sf, { ...OPTS, pseudonyms: new Map([["王小明", "P-001"]]) }).title).toBe("关于P-001的报道");
  });

  it("C1: a one-character name of such a script is replaced only as a whole run", () => {
    const sf = (t: string) => source("article-journal", mt(["zh", "original", t]), [{ role: "author", given: "Wei", family: "Chen" }]);
    const map = new Map([["明", "P-007"]]);
    expect(toCslItem(sf("王小明访谈录"), { ...OPTS, pseudonyms: map }).title).toBe("王小明访谈录");
    expect(toCslItem(sf("Interview 明"), { ...OPTS, pseudonyms: map }).title).toBe("Interview P-007");
  });

  it("I1: the folding is the one folder names use (accents, width, '_' as a separator)", () => {
    const map = new Map([["Lucía", "P-002"], ["Fernández", "P-002"], ["Lucía Fernández", "P-002"], ["lucia.cocina", "P-002"]]);
    const t = (title: string) => toCslItem(source("article-journal", mt(["es", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }]), { ...OPTS, pseudonyms: map }).title;
    expect(t("Entrevista a Lucia Fernandez")).toBe("Entrevista a P-002");
    expect(t("ＬＵＣÍＡ talks")).toBe("P-002 talks");
    expect(t("lucia_cocina video")).toBe("P-002 video");
  });

  it("negative cases: a Latin name is not matched inside a longer word", () => {
    const t = (title: string, key: string) =>
      toCslItem(source("article-journal", mt(["en", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }]), { ...OPTS, pseudonyms: new Map([[key, "P-010"]]) }).title;
    expect(t("Annual report", "Ann")).toBe("Annual report");
    expect(t("Marianne at home", "Maria")).toBe("Marianne at home");
    expect(t("Ann's annual report", "Ann")).toBe("P-010's annual report");
  });
});

describe("I2 (R378 a, FR-A10): a participant who is not a creator, in any word order and in any address form", () => {
  const MAP = new Map([["Maria Lopez", "P-003"]]);
  const story = (title: string, url?: string) =>
    source("article-journal", mt(["en", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }], url ? { identifiers: { url } } : {});

  it("the title: reversed, 'Family, Given' and upper case with accents are replaced", () => {
    expect(toCslItem(story("Lopez, Maria: her life; and LÓPEZ MARIA"), { ...OPTS, pseudonyms: MAP }).title).toBe("P-003: her life; and P-003");
    expect(toCslItem(story("lopezmaria and Maria  Lopez"), { ...OPTS, pseudonyms: MAP }).title).toBe("P-003 and P-003");
    const three = new Map([["Lucía Fernández Ruiz", "P-014"]]);
    expect(toCslItem(story("Fernández Ruiz, Lucía; Ruiz Fernández Lucía"), { ...OPTS, pseudonyms: three }).title).toBe("P-014; P-014");
  });

  it("the address: %20, '+', reversed and any separator drop the URL", () => {
    for (const url of [
      "https://news.example/Maria%20Lopez/story",
      "https://news.example/search?q=maria+lopez",
      "https://news.example/lopez-maria",
      "https://news.example/lopez_maria",
      "https://news.example/lopezmaria2024",
      "https://news.example/Mar%C3%ADa%2BL%C3%B3pez",
      "https://news.example/Maria%2520Lopez",
    ]) {
      expect(toCslItem(story("A story", url), { ...OPTS, pseudonyms: MAP }).URL, url).toBeUndefined();
    }
    expect(toCslItem(story("A story", "https://news.example/marianne-lopezia"), { ...OPTS, pseudonyms: MAP }).URL).toBe("https://news.example/marianne-lopezia");
  });

  it("a malformed escape in the address does not throw, and the name around it is still found", () => {
    expect(() => toCslItem(story("A story", "https://news.example/%E0%A4%A/x"), { ...OPTS, pseudonyms: MAP })).not.toThrow();
    expect(toCslItem(story("A story", "https://news.example/%E0%A4%A/x"), { ...OPTS, pseudonyms: MAP }).URL).toBe("https://news.example/%E0%A4%A/x");
    expect(toCslItem(story("A story", "https://news.example/%ZZ/Maria%20Lopez/%E0%A4"), { ...OPTS, pseudonyms: MAP }).URL).toBeUndefined();
  });

  it("an address with a no-space-script name joined to other characters is dropped", () => {
    const item = toCslItem(story("A story", "https://news.example/%E7%8E%8B%E5%B0%8F%E6%98%8E%E8%AE%BF%E8%B0%88"), { ...OPTS, pseudonyms: new Map([["王小明", "P-001"]]) });
    expect(item.URL).toBeUndefined();
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

  it("R89: a bundled-only loader says explicitly that no style is imported", () => {
    expect(bundleLoader().isCustom("apa")).toBe(false);
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

  it("R88 C1: a second render after an edit shows the new data (no stale engine state), text and html", () => {
    const id = newId();
    const before: CslItem = { id, type: "book", title: "First title by Lucía", author: [{ family: "Fernández Ruiz", given: "Lucía" }], issued: { "date-parts": [[2024]] } };
    const after: CslItem = { id, type: "book", title: "Second title", author: [{ literal: "P-014" }], issued: { "date-parts": [[2024]] } };
    for (const style of STYLES) {
      for (const format of ["text", "html"] as const) {
        renderBibliography([before], style, format);
        renderCitation([{ item: before }], style, format);
        const out = renderBibliography([after], style, format) + renderCitation([{ item: after }], style, format);
        expect(out, `${style}/${format}`).toContain("P-014");
        expect(out, `${style}/${format}`).toMatch(/Second title/iu);
        expect(out, `${style}/${format}`).not.toMatch(/Luc[ií]a|Fern[aá]ndez|First title/iu);
      }
    }
  });

  it("R88 I4: a locator is never markup (html and rtf)", () => {
    for (const format of ["html", "rtf", "text"] as const) {
      const out = renderCitation([{ item: items.book, locator: "<i>3</i>", label: "page" }], "apa", format);
      expect(out, format).toContain("p. 3");
      expect(out, format).not.toMatch(/<i>3|\\i 3|\{\\i/u);
    }
    expect(renderCitation([{ item: items.book, locator: "{\\b 3}", label: "page" }], "apa", "rtf")).toContain("p. b 3");
  });

  it("R88 minor: an invalid lang falls back to en-US", () => {
    const en = renderBibliography([items.youtubeVideo], "apa", "text", "en-US");
    for (const bad of ["", "../../etc/passwd", "en_US<script>", "x".repeat(200)]) expect(renderBibliography([items.youtubeVideo], "apa", "text", bad), bad).toBe(en);
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

describe("R380: a Korean name with a particle or honorific joined to it", () => {
  const t = (title: string, key = "김민수") =>
    toCslItem(source("article-journal", mt(["ko", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }]), { ...OPTS, pseudonyms: new Map([[key, "P-001"]]) }).title;

  it("is replaced at the start of a run of Hangul; the particle stays", () => {
    expect(t("김민수의 인터뷰")).toBe("P-001의 인터뷰");
    expect(t("김민수씨와의 대화")).toBe("P-001씨와의 대화");
  });

  it("is not replaced in the middle or at the end of a longer run; one syllable only alone; Latin unchanged", () => {
    expect(t("박김민수 인터뷰")).toBe("박김민수 인터뷰");
    expect(t("민수의 인터뷰", "민")).toBe("민수의 인터뷰");
    expect(t("Marianne", "Maria")).toBe("Marianne");
  });

  it("in a creator's own title, and in an address that holds Hangul", () => {
    const sf = source("interview", mt(["ko", "original", "김민수씨와의 대화"]), [{ role: "interviewee", literal: "김민수" }], {
      participantIds: [PARTICIPANT.id],
      identifiers: { url: "https://news.example/%EA%B9%80%EB%AF%BC%EC%88%98%EC%9D%98-%EC%9D%B4%EC%95%BC%EA%B8%B0" },
    });
    const item = toCslItem(sf, { ...OPTS, pseudonyms: new Map([["김민수", "P-001"]]) });
    expect(item.title).toBe("P-001씨와의 대화");
    expect(item.URL).toBeUndefined();
  });
});

describe("toCslItem: linear in the title (FR-A10)", () => {
  it("a 100,000-character title with a map of 500 names is scrubbed in well under a second", () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 500; i++) map.set(i % 5 === 0 ? `王${String.fromCodePoint(0x4e00 + i)}明` : `Given${i} Family${i}`, `P-${String(i).padStart(3, "0")}`);
    const chunk = "Lopez maria and Given7 the 王小明访谈录 FAMILY12, given12 annual ";
    const title = chunk.repeat(Math.ceil(100_000 / chunk.length)).slice(0, 100_000);
    const sf = source("article-journal", mt(["en", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }], {
      identifiers: { url: `https://news.example/${"a-".repeat(50_000)}` },
    });
    const t = performance.now();
    const item = toCslItem(sf, { ...OPTS, pseudonyms: map });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(item.title).not.toMatch(/family12/iu);
    expect(item.URL).toBeDefined();
  });
});

describe("R387 (a): a name with an invisible character inside it (C1 of the FR-A10 review)", () => {
  const LUCIA = new Map([["Lucía", "P-002"], ["Fernández", "P-002"], ["Lucía Fernández", "P-002"]]);
  const story = (title: string, url?: string) =>
    source("article-journal", mt(["es", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }], url ? { identifiers: { url } } : {});
  const title = (t: string, map: ReadonlyMap<string, string>) => toCslItem(story(t), { ...OPTS, pseudonyms: map }).title;

  it("bidi controls, a mark and a soft hyphen inside the name, in the title", () => {
    expect(title("Entrevista a Lu‪cía Fer⁦nández", LUCIA)).toBe("Entrevista a P-002");
    expect(title("Entrevista a Luc‎ía Fernández", LUCIA)).toBe("Entrevista a P-002");
    expect(title("Entrevista a Luc­ía Fernández", LUCIA)).toBe("Entrevista a P-002");
    const map = new Map([["Maria", "P-001"]]);
    for (const m of ["Ma­ria", "Ma​ria", "Ma‍ria", "Ma⁠ria", "Mar‎ia"]) expect(title(`Interview with ${m} today`, map), JSON.stringify(m)).toBe("Interview with P-001 today");
    expect(title("Interview with ‮airaM‬ today", map)).not.toMatch(/aira/iu);
  });

  it("a creator whose name holds an invisible character is coded, and the title too", () => {
    const sf = source("interview", mt(["es", "original", "Entrevista a Luc­ía Fernández"]), [{ role: "interviewee", given: "Luc­ía", family: "Fernández" }], { participantIds: [PARTICIPANT.id] });
    const item = toCslItem(sf, { ...OPTS, pseudonyms: new Map([["Lucía Fernández", "P-002"]]) });
    expect(item.author).toEqual([{ literal: "P-002" }]);
    expect(item.title).toBe("Entrevista a P-002");
  });

  it("the address with a soft hyphen (Ma%C2%ADria-Lopez) is dropped", () => {
    expect(toCslItem(story("A story", "https://news.example/Ma%C2%ADria-Lopez"), { ...OPTS, pseudonyms: new Map([["Maria Lopez", "P-003"]]) }).URL).toBeUndefined();
  });

  it("Devanagari with a ZWJ, Persian with a ZWNJ against the entry without it, a bidi-wrapped handle", () => {
    expect(title("क्‍षमा का साक्षात्कार", new Map([["क्षमा", "P-003"]]))).toBe("P-003 का साक्षात्कार");
    expect(title("گفتگو با علی‌رضا", new Map([["علیرضا", "P-004"]]))).toBe("گفتگو با P-004");
    // The isolates at the edges of the handle stay around the code (R403 a).
    expect(title("Video by ⁨@maria.cocina⁩", new Map([["@maria.cocina", "P-005"]]))).toBe("Video by ⁨P-005⁩");
  });
});

describe("R403 (a): an invisible character is both nothing and a boundary (C1 of the FR-A10 second review)", () => {
  const story = (title: string, url?: string) =>
    source("article-journal", mt(["es", "original", title]), [{ role: "author", given: "Wei", family: "Chen" }], url ? { identifiers: { url } } : {});
  const title = (t: string, map: ReadonlyMap<string, string>) => toCslItem(story(t), { ...OPTS, pseudonyms: map }).title;
  const table: Array<[string, string, string]> = [
    ["Lucía", "Lucía\u200Bhabla", "P-001\u200Bhabla"],
    ["Maria Lopez", "Maria\u200BLopez\u200Bhabla", "P-001\u200Bhabla"],
    ["Ana", "Ana\u200BLuis", "P-001\u200BLuis"],
    ["Maria", "Maria\u200Eשלום", "P-001\u200Eשלום"],
    ["Maria", "#Maria\u2060Day", "#P-001\u2060Day"],
    ["Maria", "\u2068Maria\u2069\u2068Lopez\u2069", "\u2068P-001\u2069\u2068Lopez\u2069"],
  ];
  it.each(table)("%s in %j is replaced in the title", (entry, text, expected) => {
    expect(title(text, new Map([[entry, "P-001"]]))).toBe(expected);
  });

  it("a creator's own name glued to the next word by a zero-width space is replaced in the title", () => {
    const sf = source("interview", mt(["es", "original", "Lucía\u200Bhabla"]), [{ role: "interviewee", given: "Lucía", family: "Fernández" }], { participantIds: [PARTICIPANT.id] });
    expect(toCslItem(sf, { ...OPTS, pseudonyms: new Map([["Lucía Fernández", "P-002"]]) }).title).toBe("P-002\u200Bhabla");
  });

  it("the address Luc%C3%ADa%E2%80%8Bhabla is dropped", () => {
    expect(toCslItem(story("A story", "https://news.example/Luc%C3%ADa%E2%80%8Bhabla"), { ...OPTS, pseudonyms: new Map([["Lucía", "P-001"]]) }).URL).toBeUndefined();
  });

  it("'Ana\u200Bbel': the longer entry wins; 'Ana' alone leaves 'bel' (the price of the boundary); 'Marianne' is kept", () => {
    expect(title("Ana\u200Bbel habla", new Map([["Ana", "P-002"], ["Anabel", "P-001"]]))).toBe("P-001 habla");
    expect(title("Ana\u200Bbel habla", new Map([["Ana", "P-002"]]))).toBe("P-002\u200Bbel habla");
    expect(title("Marianne habla", new Map([["Maria", "P-001"]]))).toBe("Marianne habla");
  });
});

describe("R403 (c): a part of a name stands for the name only when it could be a name by itself (I2, M1 of the FR-A10 second review)", () => {
  const story = (t: string) => source("article-journal", mt(["es", "original", t]), [{ role: "author", given: "Wei", family: "Chen" }]);
  const title = (t: string, map: ReadonlyMap<string, string>) => toCslItem(story(t), { ...OPTS, pseudonyms: map }).title;
  const own = (t: string, c: Omit<Creator, "role">, key: string) =>
    toCslItem(source("interview", mt(["es", "original", t]), [{ ...c, role: "interviewee" }], { participantIds: [PARTICIPANT.id] }), { ...OPTS, pseudonyms: new Map([[key, "P-001"]]) }).title;

  it("runs of a map entry: only those with two words that stand alone", () => {
    for (const [entry, text] of [
      ["Maria de Lopez", "Ave Maria de Guadalupe"],
      ["Maria de Lopez", "Calle de Lopez"],
      ["Juan de la Cruz", "la Cruz Roja"],
      ["Juan de la Cruz", "San Juan de Dios"],
      ["Jan van der Berg", "Der Berg ruft"],
    ] as const) {
      expect(title(text, new Map([[entry, "P-001"]])), `${entry} / ${text}`).toBe(text);
    }
    const lucia = new Map([["Lucía Fernández Ruiz", "P-001"]]);
    expect(title("Entrevista a Lucía Fernández", lucia)).toBe("Entrevista a P-001");
    expect(title("Fernández Ruiz habla", lucia)).toBe("P-001 habla");
  });

  it("a creator's family words: 'de', 'la', 'van', 'der' stay; 'Cruz', 'Berg', 'Fernández', 'Ruiz' are replaced", () => {
    expect(own("Historia de la ciudad y la Cruz Roja", { given: "Juan", family: "de la Cruz" }, "Juan de la Cruz")).toBe("Historia de la ciudad y la P-001 Roja");
    expect(own("Der Berg ruft van Gogh", { given: "Jan", family: "van der Berg" }, "Jan van der Berg")).toBe("Der P-001 ruft van Gogh");
    expect(own("Fernández habla y Ruiz calla", { given: "Lucía", family: "Fernández Ruiz" }, "Lucía Fernández Ruiz")).toBe("P-001 habla y P-001 calla");
  });
});

describe("R387 (b): one function makes a name's forms (I1 of the FR-A10 review)", () => {
  const title = (t: string, map: ReadonlyMap<string, string>) =>
    toCslItem(source("article-journal", mt(["ja", "original", t]), [{ role: "author", given: "Wei", family: "Chen" }]), { ...OPTS, pseudonyms: map }).title;

  it("a map entry written apart in a no-space script matches in either order, as the folder name does", () => {
    expect(title("太郎山田さん", new Map([["山田 太郎", "P-001"]]))).toBe("P-001さん");
    expect(title("山田太郎さん", new Map([["山田 太郎", "P-001"]]))).toBe("P-001さん");
    expect(title("小明王的故事", new Map([["王 小明", "P-002"]]))).toBe("P-002的故事");
    expect(title("山田太郎さん", new Map([["太郎 山田", "P-003"]]))).toBe("P-003さん");
  });
});

describe("R387 (c): R88's floor for a lone name, measured by script (I2 of the FR-A10 review)", () => {
  const cite = (t: string, creator: Omit<Creator, "role">, key: string, code: string) =>
    toCslItem(source("interview", mt(["und", "original", t]), [{ role: "interviewee", ...creator }], { participantIds: [PARTICIPANT.id] }), { ...OPTS, pseudonyms: new Map([[key, code]]) });

  it("a lone given name of two or more characters in a no-space script is replaced, as in the folder name", () => {
    expect(cite("小明的故事", { family: "王", given: "小明" }, "王小明", "P-001").title).toBe("P-001的故事");
    expect(cite("王老师和小明", { family: "王", given: "小明" }, "王小明", "P-001").title).toBe("王老师和P-001");
    expect(cite("太郎の話", { family: "山田", given: "太郎" }, "山田太郎", "P-002").title).toBe("P-002の話");
  });

  it("a one-character Han family name alone is still not matched, inside a run or alone", () => {
    expect(cite("王老师的课", { family: "王", given: "小明" }, "王小明", "P-001").title).toBe("王老师的课");
  });

  it("a Hangul name alone counts from two syllables", () => {
    expect(cite("민수의 이야기", { family: "김", given: "민수" }, "김 민수", "P-004").title).toBe("P-004의 이야기");
    expect(cite("민 이야기", { family: "박", given: "민" }, "박 민", "P-005").title).toBe("민 이야기");
  });

  it("Latin script keeps four letters: 'Li family history' is kept in the citation (as ruled)", () => {
    expect(cite("Li family history", { family: "Li", given: "Rose" }, "Rose Li", "P-003").title).toBe("Li family history");
    expect(cite("Rose Li family history", { family: "Li", given: "Rose" }, "Rose Li", "P-003").title).toBe("P-003 family history");
  });
});

describe("R387 (e): partial names (I4 of the FR-A10 review)", () => {
  const story = (t: string) => source("article-journal", mt(["es", "original", t]), [{ role: "author", given: "Wei", family: "Chen" }]);

  it("a map entry of three words: a run of two of its words in order is replaced", () => {
    const map = new Map([["Lucía Fernández Ruiz", "P-001"]]);
    expect(toCslItem(story("Entrevista a Lucía Fernández"), { ...OPTS, pseudonyms: map }).title).toBe("Entrevista a P-001");
    expect(toCslItem(story("Fernández Ruiz habla"), { ...OPTS, pseudonyms: map }).title).toBe("P-001 habla");
  });

  it("a creator with a family name of two words: no 'P-001 Fernández', and each family word counts as a lone family name", () => {
    const sf = (t: string) =>
      source("interview", mt(["es", "original", t]), [{ role: "interviewee", given: "Lucía", family: "Fernández Ruiz" }], { participantIds: [PARTICIPANT.id] });
    const opts = { ...OPTS, pseudonyms: new Map([["Lucía Fernández Ruiz", "P-001"]]) };
    expect(toCslItem(sf("Entrevista a Lucía Fernández"), opts).title).toBe("Entrevista a P-001");
    expect(toCslItem(sf("Fernández habla; Ruiz también"), opts).title).toBe("P-001 habla; P-001 también");
    // Under R88's floor: a short family word alone is kept in a citation.
    const li = source("interview", mt(["en", "original", "The Li family; Wang Li"]), [{ role: "interviewee", given: "Mei", family: "Wang Li" }], { participantIds: [PARTICIPANT.id] });
    expect(toCslItem(li, { ...OPTS, pseudonyms: new Map([["Mei Wang Li", "P-002"]]) }).title).toBe("The Li family; P-002");
  });
});

describe("R387 (f): minor points of the FR-A10 review", () => {
  const story = (t: string, url?: string) =>
    source("article-journal", mt(["en", "original", t]), [{ role: "author", given: "Wei", family: "Chen" }], url ? { identifiers: { url } } : {});

  it("M1: a name's own exact form wins, whatever the map's order; a creator's code and the title agree", () => {
    for (const map of [
      new Map([["Maria Lopez", "P-001"], ["Lopez Maria", "P-002"]]),
      new Map([["Lopez Maria", "P-002"], ["Maria Lopez", "P-001"]]),
    ]) {
      expect(toCslItem(story("Maria Lopez; Lopez Maria"), { ...OPTS, pseudonyms: map }).title).toBe("P-001; P-002");
      const sf = source("interview", mt(["en", "original", "Lopez Maria talks"]), [{ role: "interviewee", literal: "Lopez Maria" }], { participantIds: [PARTICIPANT.id] });
      const item = toCslItem(sf, { ...OPTS, pseudonyms: map });
      expect(item.author).toEqual([{ literal: "P-002" }]);
      expect(item.title).toBe("P-002 talks");
    }
    for (const map of [new Map([["Ann Marie", "P-001"], ["Annmarie", "P-002"]]), new Map([["Annmarie", "P-002"], ["Ann Marie", "P-001"]])]) {
      expect(toCslItem(story("Annmarie and Ann Marie"), { ...OPTS, pseudonyms: map }).title).toBe("P-002 and P-001");
    }
  });

  it("M2: the forms of a map are built once: 200 citations with a map of 5,000 three-word names", () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 5_000; i++) map.set(`Given${i} Middle${i} Family${i}`, `P-${i}`);
    toCslItem(story("warm up"), { ...OPTS, pseudonyms: map });
    const t = performance.now();
    for (let i = 0; i < 200; i++) expect(toCslItem(story(`About Family${i}, Middle${i}`), { ...OPTS, pseudonyms: map }).title).toBe(`About P-${i}`);
    expect(performance.now() - t).toBeLessThan(3000);
    // The time limit covers the one build of the map's forms (the warm-up), timed apart from the calls.
  }, 120_000);

  it("M3: an NFD title: the combining mark after a name goes with it", () => {
    expect(toCslItem(story("Habla Luciá"), { ...OPTS, pseudonyms: new Map([["Lucía", "P-002"]]) }).title).toBe("Habla P-002");
  });

  it("M3: a malformed escape run: its ASCII escapes are still decoded and the name found", () => {
    expect(toCslItem(story("A story", "https://news.example/%4D%61%72%69%61%E0%A4"), { ...OPTS, pseudonyms: new Map([["Maria", "P-001"]]) }).URL).toBeUndefined();
  });

  it("M6: a Korean creator written as family and given finds the map key written together, and is coded", () => {
    const sf = source("interview", mt(["ko", "original", "김민수의 인터뷰"]), [{ role: "interviewee", family: "김", given: "민수" }], { participantIds: [PARTICIPANT.id] });
    const item = toCslItem(sf, { ...OPTS, pseudonyms: new Map([["김민수", "P-001"]]) });
    expect(item.author).toEqual([{ literal: "P-001" }]);
    expect(item.title).toBe("P-001의 인터뷰");
  });

  it("M5: tatweel and kana through the citation", () => {
    expect(toCslItem(story("مقابلة مـحـمـد"), { ...OPTS, pseudonyms: new Map([["محمد", "P-001"]]) }).title).toBe("مقابلة P-001");
    expect(toCslItem(story("ヤマダタロウの話"), { ...OPTS, pseudonyms: new Map([["やまだ たろう", "P-002"]]) }).title).toBe("P-002の話");
  });
});
