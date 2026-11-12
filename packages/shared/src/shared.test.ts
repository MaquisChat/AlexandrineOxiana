import { describe, expect, it } from "vitest";
import { CREDENTIAL_QUERY_KEYS, GENERIC_FAMILIES, MEDIA_TICKET_PATH, isMediaTicketPath, inferGenericFamily, isCredentialQueryKey, isGenericFamily, isUsableFontFamily, splitFontFamilies, isZoteroApiKeyShape, sniffFontFormat, USER_FONT_MIME, isUserFontId, reservedFontName, CSS_WIDE_KEYWORDS, GENERIC_FONT_KEYWORDS, BUNDLED_FONT_FAMILIES, reviewGroup } from "./index.js";

describe("@ao/shared", () => {
  it("credential query keys (R96/R98), any case", () => {
    expect([...CREDENTIAL_QUERY_KEYS].sort()).toEqual(["access_token", "api_key", "apikey", "auth", "authorization", "bearer", "code", "key", "passphrase", "password", "secret", "token"]);
    expect(isCredentialQueryKey("Access_Token")).toBe(true);
    expect(isCredentialQueryKey("text")).toBe(false);
  });

  it("font family names: no rule-breaking or control characters", () => {
    expect(isUsableFontFamily("'Goudy Old Style', serif")).toBe(true);
    // R108: C1 controls, bidi controls, zero-width characters and line/paragraph separators too.
    for (const cp of [0x80, 0x9f, 0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2028, 0x2029]) {
      expect(isUsableFontFamily(`Font${String.fromCodePoint(cp)}Name`), cp.toString(16)).toBe(false);
    }
    expect(isUsableFontFamily("Noto Sans العربية")).toBe(true);
    for (const bad of ["", "  ", "a;b", "a{b", "a}b", "<x>", "a\\b", "a\nb", "a\u0000b", "a\u007fb", "x".repeat(301)]) expect(isUsableFontFamily(bad), JSON.stringify(bad)).toBe(false);
  });

  it("generic families (R105, R109): the keyword that ends the list, else a known face, else undefined", () => {
    expect([...GENERIC_FAMILIES]).toEqual(["serif", "sans-serif", "monospace"]);
    expect(isGenericFamily("monospace")).toBe(true);
    expect(isGenericFamily("cursive")).toBe(false);
    expect(isGenericFamily(undefined)).toBe(false);
    expect(inferGenericFamily("'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif")).toBe("serif");
    expect(inferGenericFamily("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace")).toBe("monospace");
    expect(inferGenericFamily("system-ui, sans-serif")).toBe("sans-serif");
    expect(inferGenericFamily("Inter")).toBe("sans-serif");
    expect(inferGenericFamily("'Atkinson Hyperlegible'")).toBe("sans-serif");
    expect(inferGenericFamily("Consolas")).toBe("monospace");
    expect(inferGenericFamily("Some Unknown Face")).toBeUndefined();
    expect(splitFontFamilies("'A, B', \"C\", D")).toEqual(["'A, B'", '"C"', "D"]);
  });

  it("media ticket addresses (R135): /media/ and 43 base64url characters, nothing else", () => {
    const t = "A".repeat(42) + "_";
    expect(isMediaTicketPath(`/media/${t}`)).toBe(true);
    expect(MEDIA_TICKET_PATH.test(`/media/${t}`)).toBe(true);
    for (const bad of [`/media/${t}?x=1`, `/media/${t}#f`, `/media/${t}/`, `/media/${t}A`, `/media/${"A".repeat(42)}`, `/media/${"A".repeat(42)}=`, `//media/${t}`, `http://127.0.0.1:1/media/${t}`, `/media/../${t}`]) {
      expect(isMediaTicketPath(bad), bad).toBe(false);
    }
  });
});

describe("Task 57: Zotero key, user fonts", () => {
  it("a Zotero API key: letters and digits only, 16 to 64 of them", () => {
    expect(isZoteroApiKeyShape("abcdEFGH12345678abcdEFGH")).toBe(true);
    for (const bad of ["", "short", "a".repeat(65), "abcd efgh 1234 5678", "abcdEFGH12345678abcdEFG\n", "ключключключключключ"]) expect(isZoteroApiKeyShape(bad), JSON.stringify(bad)).toBe(false);
  });

  it("a font file is recognised by its first four bytes only", () => {
    const head = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0]);
    expect(sniffFontFormat(head(0x00, 0x01, 0x00, 0x00))).toBe("ttf");
    expect(sniffFontFormat(head(0x74, 0x72, 0x75, 0x65))).toBe("ttf"); // 'true'
    expect(sniffFontFormat(head(0x4f, 0x54, 0x54, 0x4f))).toBe("otf"); // 'OTTO'
    expect(sniffFontFormat(head(0x77, 0x4f, 0x46, 0x46))).toBe("woff"); // 'wOFF'
    expect(sniffFontFormat(head(0x77, 0x4f, 0x46, 0x32))).toBe("woff2"); // 'wOF2'
    expect(sniffFontFormat(head(0x74, 0x74, 0x63, 0x66))).toBeNull(); // 'ttcf': collections are not taken
    expect(sniffFontFormat(head(0x25, 0x50, 0x44, 0x46))).toBeNull(); // %PDF
    expect(sniffFontFormat(new Uint8Array([0x00, 0x01]))).toBeNull();
    expect(USER_FONT_MIME).toEqual({ ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" });
  });

  it("font ids are 32 lowercase hex characters", () => {
    expect(isUserFontId("0123456789abcdef0123456789abcdef")).toBe(true);
    for (const bad of ["", "../x", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde"]) expect(isUserFontId(bad)).toBe(false);
  });
});

describe("speech models (R158): one definition", () => {
  it("the accepted models, the default among them, and one speech tool per model", async () => {
    const { SPEECH_MODELS, DEFAULT_SPEECH_MODEL, TOOL_IDS, speechToolId, isSpeechModel } = await import("./index.js");
    expect([...SPEECH_MODELS]).toEqual(["tiny", "small", "medium", "large-v3"]);
    expect(DEFAULT_SPEECH_MODEL).toBe("medium");
    expect(isSpeechModel("medium")).toBe(true);
    expect(isSpeechModel("huge")).toBe(false);
    const speechTools = TOOL_IDS.filter((t) => t.startsWith("speech-"));
    expect(speechTools.sort()).toEqual(SPEECH_MODELS.map((m) => speechToolId(m)).sort());
  });
});

describe("font names a researcher's own file cannot take (Task 57 M5): one list", () => {
  it("CSS-wide keywords, generic families and bundled faces, in any case", () => {
    expect([...CSS_WIDE_KEYWORDS]).toEqual(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);
    expect([...GENERIC_FONT_KEYWORDS].sort()).toEqual(
      ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"].sort(),
    );
    expect([...BUNDLED_FONT_FAMILIES].sort()).toEqual(["Atkinson Hyperlegible", "OpenDyslexic", "Sorts Mill Goudy"]);
    for (const n of ["inherit", "Initial", "UNSET", "revert-layer", "Default"]) expect(reservedFontName(n), n).toBe("css-keyword");
    for (const n of ["serif", "Sans-Serif", "MONOSPACE", "system-ui", "ui-rounded", "Emoji", "math", "fangsong"]) expect(reservedFontName(n), n).toBe("generic-family");
    for (const n of ["Sorts Mill Goudy", "sorts mill goudy", "ATKINSON HYPERLEGIBLE", "opendyslexic", " OpenDyslexic "]) expect(reservedFontName(n), n).toBe("bundled-face");
    for (const n of ["Junicode", "Brill", "Serif Pro", "Goudy", "revert2"]) expect(reservedFontName(n), n).toBeNull();
  });

  it("review queue groups (Task 67): import with a batch, import without one, verification with fields, verification without", () => {
    expect(reviewGroup({ kind: "import", batchId: "b1", fields: {} })).toBe("import");
    expect(reviewGroup({ kind: "import", fields: { "/title": "unverified" } })).toBe("attach");
    expect(reviewGroup({ kind: "verification", fields: { "/identifiers/doi": "conflict" } })).toBe("capture");
    expect(reviewGroup({ kind: "verification", fields: {} })).toBe("withdrawal");
  });
});
