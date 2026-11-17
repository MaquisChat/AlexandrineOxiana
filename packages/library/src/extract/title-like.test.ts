/**
 * R394 (a, b): a file's embedded title is evidence only when it looks like a title; an embedded author that is a
 * program's or a computer's stock name is no author. One rule, used by every extractor that reads an embedded title.
 */
import { describe, expect, it } from "vitest";
import { isStockAuthor, keepCreators, looksLikeTitle } from "./title-like.js";

/** [embedded title, kept?, file name (optional)] */
const TITLES: Array<[string, boolean, string?]> = [
  // The owner's case, and other codes with no word made only of letters.
  ["S0003598X20000800jra 900..915", false],
  ["JQE-2020-0041.R1", false],
  ["12345", false],
  ["doc1", false],
  ["  S0003598X20000800jra\t 900..915  ", false],
  ["ms_2019_04_v3", false],
  ["1984", false], // digits only: dropped as an embedded title (the reference manager or the file name names the work)
  ["2001", false],
  // Identifiers.
  ["10.1017/S0003598X20000800", false],
  ["doi:10.1016/j.cell.2020.01.001", false],
  ["https://doi.org/10.1093/oxfordhb/9780199569304.013.0001", false],
  ["978-0-262-03384-8", false],
  ["ISBN 0-306-40615-2", false],
  ["ISSN 0003-598X", false],
  ["0003-598X", false],
  ["arXiv:2401.12345v2", false],
  ["2401.12345", false],
  ["hep-th/9901001", false],
  ["S0003598X20000800", false],
  ["B9780128001234000012", false],
  ["123e4567-e89b-12d3-a456-426614174000", false],
  ["deadbeefcafebabe0123", false],
  ["a1b2c3d4e5f6a7b8c9d0", false],
  ["manuscript2019final", false],
  // File names and paths, and the file's own name.
  ["chapter3.pdf", false],
  ["Final Draft.docx", false],
  ["thesis_final_v2.tex", false],
  ["report.indd", false],
  ["notes.odt", false],
  ["slides.pptx", false],
  ["C:\\Users\\jane\\Documents\\draft", false],
  ["/Users/jane/Documents/draft", false],
  ["Okafor Lagos Markets", false, "okafor lagos markets.pdf"],
  ["LAGOS-MARKETS", false, "lagos-markets.pdf"],
  // Stock texts programs leave there.
  ["Untitled", false],
  ["untitled", false],
  ["Untitled 3", false],
  ["Document", false],
  ["Document1", false],
  ["New Document", false],
  ["Presentation", false],
  ["PowerPoint Presentation", false],
  ["Slide 1", false],
  ["Title", false],
  ["Layout 1", false],
  ["Blank", false],
  ["Scan", false],
  ["Scanned Document", false],
  ["Print", false],
  ["Full Text", false],
  ["Front Matter", false],
  ["Back Matter", false],
  ["Cover", false],
  ["Table of Contents", false],
  ["Index", false],
  ["Microsoft Word - draft3", false],
  ["Microsoft Word - Chapter 2 Markets and Memory", false],
  ["Microsoft PowerPoint - lecture 4", false],
  ["Adobe Photoshop PDF", false],
  // R410 c: section and template words, sites and services, addresses, dates, "untitled" in other languages.
  ["Original Article", false],
  ["Research Article", false],
  ["Review Article", false],
  ["ARTICLE", false],
  ["Article 3", false],
  ["Manuscript", false],
  ["Author Manuscript", false],
  ["Accepted Manuscript", false],
  ["Abstract", false],
  ["Introduction", false],
  ["Chapter 1", false],
  ["Chapter 12", false],
  ["Page 1", false],
  ["Template", false],
  ["Paper Title", false],
  ["Paper Title (use style: paper title)", false],
  ["Insert title here", false],
  ["Your Title Here", false],
  ["Title of the paper", false],
  ["Document title", false],
  ["Proof", false],
  ["Preview", false],
  ["Word", false],
  ["Blank Page", false],
  ["Front Cover", false],
  ["Cover page", false],
  ["Title page", false],
  ["Frontmatter", false],
  ["No title", false],
  ["Unknown", false],
  ["Unknown Title", false],
  ["eBook", false],
  ["Calibre", false],
  ["Running head: MARKETS AND MEMORY", false],
  ["Running Head: Subsistence and persistence", false],
  ["www.annualreviews.org", false],
  ["www.cambridge.org/core", false],
  ["http://example.org/article/123", false],
  ["https://www.jstor.org/stable/12345", false],
  ["Downloaded from https://academic.oup.com/ajs on 12 May 2021", false],
  ["downloaded from www.annualreviews.org", false],
  ["jane.doe@example.org", false],
  ["15 January 2020", false],
  ["January 2020", false],
  ["Jan. 15, 2020", false],
  ["2020-01-15", false],
  ["01/15/2020", false],
  ["(Microsoft Word - draft.doc)", false],
  ["JSTOR", false],
  ["IEEE Xplore", false],
  ["ScienceDirect", false],
  ["SpringerLink", false],
  ["ProQuest", false],
  ["ACS Paragon Plus Environment", false],
  ["Sans titre", false],
  ["Sin título", false],
  ["Sin titulo", false],
  ["Senza titolo", false],
  ["Unbenannt", false],
  ["Ohne Titel", false],
  ["Titel", false],
  ["Sem título", false],
  ["Без названия", false],
  ["無題", false],
  ["无标题", false],
  ["제목 없음", false],
  // R410 c: true signs of a wrong file, and real titles that begin with a stock word, stay titles.
  ["Book Review", true],
  ["Erratum", true],
  ["Corrigendum", true],
  ["Contents", true],
  ["Supplementary material", true],
  ["Appendix", true],
  ["Introduction to Sociology", true],
  ["The Manuscript of Ages", true],
  ["Unknown Pleasures", true],
  ["Article 19 and the Right to Information", true],
  ["Running Heads and Page Design", true],
  ["Downloaded Culture", true],
  ["May Day in Lagos, 1968", true],
  // R410 d: two Hangul syllables are a word; a run of digits counts once in the share of digits and punctuation.
  ["토지", true],
  ["광장", true],
  ["ISO 9001:2015", true],
  ["RFC 2616", true],
  ["900..915", false],
  ["12345", false],
  ["토", false],
  // R425 b: scanner stamps.
  ["CamScanner", false],
  ["CamScanner 01-02-2020", false],
  ["CamScanner 01-02-2020 14.33", false],
  ["CamScanner 2020-01-02 14:33:05", false],
  ["Scanned with CamScanner", false],
  ["Scanned by CamScanner", false],
  ["CamScanner and the Paperless Office", true],
  // More than half digits and punctuation.
  ["Vol. 12, No. 3, pp. 45-67 (2019)", false],
  ["pp 1-20 / 2019 / ed 2", false],
  // Real titles, kept.
  ["Persuasion", true],
  ["Middlemarch", true],
  ["On Liberty", true],
  ["Catch-22", true],
  ["Fahrenheit 451", true],
  ["20,000 Leagues Under the Sea", true],
  ["2001: A Space Odyssey", true],
  ["100 Years of Solitude", true],
  ["Subsistence and persistence: agriculture in the Central Plains of China through the Neolithic to Bronze Age transition", true],
  ["Feeding the City: Informal Markets in Lagos", true],
  ["THE PROTESTANT ETHIC AND THE SPIRIT OF CAPITALISM", true],
  ["红楼梦", true],
  ["雪国", true],
  ["ノルウェイの森", true],
  ["こころ", true],
  ["الحرب والسلم", true],
  ["Война и мир", true],
  ["Преступление и наказание", true],
  ["Either/Or", true],
  ["Replication data for 10.1017/S0003598X20000800: radiocarbon dates from the Central Plains", true],
  ["The Index of Middle English Verse", true],
  ["Documenting the Undocumented", true],
  ["Title IX and the Politics of Sport", true],
  ["Scanning the Horizon", true],
  ["War", true],
  ["Persuasion", true, "okafor2019.pdf"],
];

describe("looksLikeTitle (R394 a)", () => {
  it("has at least sixty cases", () => {
    expect(TITLES.length).toBeGreaterThanOrEqual(60);
  });
  it.each(TITLES)("%j → kept: %s", (title, kept, fileName) => {
    expect(looksLikeTitle(title, fileName)).toBe(kept);
  });
  it("the file's own name is compared without its extension and without regard to case", () => {
    expect(looksLikeTitle("Field Notes", "FIELD NOTES.PDF")).toBe(false);
    expect(looksLikeTitle("Field Notes", "field notes on market days.pdf")).toBe(true);
    expect(looksLikeTitle("Field Notes")).toBe(true);
  });
  it("a hostile 2 MB text is examined in bounded time", () => {
    const t0 = performance.now();
    for (const s of ["<dc:title>".repeat(200_000), "word ".repeat(400_000), "x.".repeat(1_000_000)]) looksLikeTitle(s, "f.pdf");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  it("R410 f: only the first 1,000 characters of a 2 MB title or author are ever read (the work is counted, not timed)", () => {
    const big = `${"word ".repeat(400_000)}.pdf`;
    /** A string stand-in that allows only slice, and records how many characters each slice reads. */
    const counted = (s: string) => {
      const reads: number[] = [];
      const proxy = new Proxy(Object(s) as object, {
        get(target, key) {
          if (key === "slice")
            return (a?: number, b?: number) => {
              const out = s.slice(a, b);
              reads.push(out.length);
              return out;
            };
          throw new Error(`the whole text was used (${String(key)})`);
        },
      });
      return { value: proxy as unknown as string, reads };
    };
    const t = counted(big);
    looksLikeTitle(t.value, "f.pdf");
    expect(t.reads.length).toBeGreaterThan(0);
    expect(Math.max(...t.reads)).toBeLessThanOrEqual(1000);
    const a = counted(`Administrator ${"x".repeat(2_000_000)}`);
    isStockAuthor(a.value);
    expect(Math.max(...a.reads)).toBeLessThanOrEqual(1000);
  });
  it("an empty or blank text is no title", () => {
    expect(looksLikeTitle("")).toBe(false);
    expect(looksLikeTitle("   ")).toBe(false);
  });
});

describe("stock authors (R394 b)", () => {
  it.each(["Administrator", "admin", "User", "Owner", "Author", "Unknown", "CamScanner", "Adobe InDesign", "LaTeX with hyperref", "Microsoft Office User", "TeX", "DELL-PC", "JohnsLaptop"])(
    "%j is a stock name",
    (name) => expect(isStockAuthor(name)).toBe(true),
  );
  // R410 e: program and machine names the review found kept (exact words, a version after a program's name, a Windows machine's default name).
  it.each([
    "user1",
    "DELL",
    "HP",
    "Lenovo",
    "IT Department",
    "Canon",
    "Xerox",
    "ABBYY",
    "Acrobat",
    "Adobe Acrobat Pro",
    "pdfTeX-1.40.21",
    "Word",
    "InDesign",
    "Adobe InDesign CS6 (Macintosh)",
    "calibre",
    "Preview",
    "DESKTOP-ABC123",
    "SPi",
    "Aptara",
    "Arbortext",
  ])("%j is a stock name (R410 e)", (name) => expect(isStockAuthor(name)).toBe(true));
  it.each(["Maria Lopez", "User Friendly Press", "Okafor, Ngozi", "World Health Organization", "Anonymous Four Collective", "Tex Avery", "Anonymous", "Will Owner", "Anne Unknown", "Dorothy Pc", "Desktop Publishing Group"])("%j is a person's or a body's name", (name) =>
    expect(isStockAuthor(name)).toBe(false),
  );
  // R425 c: a parenthesis is stripped only when it names a platform; the DESKTOP- machine code needs a digit.
  it.each(["Adobe InDesign CS6 (Macintosh)", "Acrobat (Windows)", "pdfTeX-1.40.21", "DESKTOP-ABC123"])("%j is still a stock name (R425 c)", (name) =>
    expect(isStockAuthor(name)).toBe(true),
  );
  it.each(["IT Department (University of Oslo)", "Owner (ed.)", "Unknown (2019)", "Admin (IT)", "DESKTOP-PUBLISHING", "Desktop-Team", "Mary Word", "Jane Canon", "Michael Dell", "Anonymous"])(
    "%j is kept (R425 c)",
    (name) => expect(isStockAuthor(name)).toBe(false),
  );
  it("keepCreators drops parsed stock names and keeps real ones", () => {
    expect(
      keepCreators([
        { literal: "Administrator", role: "author" },
        { given: "Microsoft Office", family: "User", role: "author" },
        { given: "Adobe", family: "InDesign", role: "author" },
        { given: "Maria", family: "Lopez", role: "author" },
        { given: "User Friendly", family: "Press", role: "author" },
        { family: "Okafor", given: "Ngozi", role: "author" },
      ]),
    ).toEqual([
      { given: "Maria", family: "Lopez", role: "author" },
      { given: "User Friendly", family: "Press", role: "author" },
      { family: "Okafor", given: "Ngozi", role: "author" },
    ]);
  });
});
