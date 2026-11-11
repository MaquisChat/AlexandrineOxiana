// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import lock from "../../scripts/fonts.lock.json";
import { DEFAULT_APPEARANCE } from "./appearance";
import { FALLBACKS_BY_GENERIC, FONT_PRESETS, GOUDY_STACK, MONO_STACK, SCRIPT_FALLBACKS, fontStack, genericOf, isUsableFamily } from "./fonts";

const FALLBACKS =
  "'Noto Serif', 'Noto Sans', 'Noto Naskh Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Serif CJK SC', 'Noto Serif CJK JP', 'Noto Serif CJK KR', 'Hiragino Mincho ProN', 'Songti SC', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Mincho', 'Malgun Gothic', 'Segoe UI Historic', serif";

const SERIF_WORDS = /Serif|Mincho|Songti|^serif$|Garamond|Georgia|Goudy/;
const families = (stack: string) => stack.split(", ");

describe("font stacks", () => {
  it("the serif per-script fallback chain is exactly the one in the brief", () => {
    expect(SCRIPT_FALLBACKS).toBe(FALLBACKS);
    expect(FALLBACKS_BY_GENERIC.serif).toBe(FALLBACKS);
    expect(FALLBACKS_BY_GENERIC["sans-serif"].endsWith(", sans-serif")).toBe(true);
    expect(FALLBACKS_BY_GENERIC.monospace.endsWith(", monospace")).toBe(true);
  });

  it("default interface, reading, transcript and notes typeface is the Goudy stack (serif); mono is the system mono stack (monospace)", () => {
    expect(GOUDY_STACK).toBe("'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif");
    expect(MONO_STACK).toBe("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    for (const slot of ["interface", "reading", "transcript", "notes"] as const) expect(DEFAULT_APPEARANCE.fonts[slot]).toEqual({ family: GOUDY_STACK, source: "bundled", generic: "serif" });
    expect(DEFAULT_APPEARANCE.fonts.mono).toEqual({ family: MONO_STACK, source: "system", generic: "monospace" });
  });

  it("fontStack keeps the chosen families first and appends the serif fallbacks for a serif choice", () => {
    const s = fontStack({ family: GOUDY_STACK, source: "bundled", generic: "serif" });
    expect(s.startsWith("'Goudy Old Style', 'Sorts Mill Goudy'")).toBe(true);
    expect(s).toBe(`'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, ${FALLBACKS}`);
    expect(families(s).filter((f) => f === "serif")).toHaveLength(1); // the generic family comes last, once
  });

  it("the mono stack never falls back to a serif font and ends with monospace", () => {
    const mono = fontStack(DEFAULT_APPEARANCE.fonts.mono);
    expect(mono.startsWith("ui-monospace, SFMono-Regular, Menlo, Consolas, ")).toBe(true);
    expect(families(mono).filter((f) => SERIF_WORDS.test(f))).toEqual([]);
    expect(mono.endsWith(", monospace")).toBe(true);
    // Also when the stored choice lost its generic (the service keeps family/source/file only).
    expect(fontStack({ family: MONO_STACK, source: "system" })).toBe(mono);
  });

  it('"Inter" falls back to sans-serif fonts, also without an explicit generic', () => {
    const inter = fontStack({ family: "Inter", source: "system", generic: "sans-serif" });
    expect(inter).toBe(`Inter, ${FALLBACKS_BY_GENERIC["sans-serif"]}`);
    expect(families(inter).filter((f) => SERIF_WORDS.test(f))).toEqual([]);
    expect(fontStack({ family: "Inter", source: "system" })).toBe(inter);
    expect(genericOf({ family: "Atkinson Hyperlegible", source: "bundled" })).toBe("sans-serif");
    expect(genericOf({ family: "OpenDyslexic", source: "bundled" })).toBe("sans-serif");
    expect(genericOf({ family: "system-ui, sans-serif", source: "system" })).toBe("sans-serif");
    expect(genericOf({ family: "Some Unknown Face", source: "system" })).toBe("serif");
  });

  it("quotes a single family name that needs it", () => {
    expect(fontStack({ family: "Atkinson Hyperlegible", source: "bundled", generic: "sans-serif" })).toBe(`'Atkinson Hyperlegible', ${FALLBACKS_BY_GENERIC["sans-serif"]}`);
    expect(fontStack({ family: "Bob's Font", source: "system" }).startsWith(`'Bob\\'s Font', `)).toBe(true);
  });

  it("a user-file font uses the family name it registers under (the file itself is loaded by the desktop shell)", () => {
    expect(fontStack({ family: "My Thesis Font", source: "user-file", file: "fonts/thesis.otf", generic: "serif" })).toBe(`'My Thesis Font', ${FALLBACKS}`);
  });

  it("refuses family names that could escape the font-family value, including control characters", () => {
    for (const bad of ["x; color: red", "a{b}", "<script>", "", "a\\b", "Times\nNew", "x\u0000y", "x\u007fy"]) expect(() => fontStack({ family: bad, source: "system" }), JSON.stringify(bad)).toThrow(/font name/);
    for (const bad of ["Times\nNew", "x\u0000y"]) expect(isUsableFamily(bad)).toBe(false);
    expect(isUsableFamily("Charter")).toBe(true);
  });

  it("offers Atkinson Hyperlegible and OpenDyslexic (bundled, sans-serif) as readability presets", () => {
    const byLabel = new Map(FONT_PRESETS.map((p) => [p.family, p]));
    expect(byLabel.get("Atkinson Hyperlegible")).toMatchObject({ source: "bundled", generic: "sans-serif" });
    expect(byLabel.get("OpenDyslexic")).toMatchObject({ source: "bundled", generic: "sans-serif" });
    expect(byLabel.get(GOUDY_STACK)).toMatchObject({ source: "bundled", generic: "serif" });
    expect(byLabel.get("Inter")).toMatchObject({ source: "system", generic: "sans-serif" });
    expect(byLabel.get(MONO_STACK)).toMatchObject({ generic: "monospace" });
  });
});

describe("bundled fonts", () => {
  const fontsCss = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");
  const pub = new URL("../../public/fonts/", import.meta.url);
  const outputs = lock.sources.flatMap((s) => s.files.map((f) => f.to));

  it("declares @font-face for Sorts Mill Goudy (regular and italic), Atkinson Hyperlegible and OpenDyslexic, but not Goudy Old Style (proprietary: the installed copy is used)", () => {
    for (const fam of ["Sorts Mill Goudy", "Atkinson Hyperlegible", "OpenDyslexic"]) expect(fontsCss).toContain(`font-family: "${fam}"`);
    expect(fontsCss).toMatch(/font-family: "Sorts Mill Goudy";[^}]*font-style: italic/);
    expect(fontsCss).not.toMatch(/font-family: "Goudy Old Style"/);
    // An installed copy of each bundled font is preferred over the bundled file.
    expect(fontsCss).toContain('local("Sorts Mill Goudy")');
  });

  it("every font file fonts.css loads is pinned in scripts/fonts.lock.json", () => {
    const urls = [...fontsCss.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(outputs, u).toContain(u);
  });

  it("every pinned file has a sha256 and comes from a pinned version or commit", () => {
    for (const s of lock.sources) {
      expect(s.kind === "npm" ? s.version : s.commit).toMatch(/^([0-9]+\.[0-9]+\.[0-9]+|[0-9a-f]{40})$/);
      if (s.kind === "npm") expect(s.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
      for (const f of s.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the OFL licence text of each bundled font is committed and names its copyright holder", () => {
    const want: [string, RegExp][] = [
      ["OFL-SortsMillGoudy.txt", /Barry Schwartz/],
      ["OFL-AtkinsonHyperlegible.txt", /Braille Institute/],
      ["OFL-OpenDyslexic.txt", /Abbie Gonzalez/],
    ];
    for (const [file, holder] of want) {
      const text = readFileSync(new URL(file, pub), "utf8");
      expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
      expect(text).toMatch(holder);
    }
  });

  it("font binaries that are present match their pinned sha256 (the binaries are optional for the tests)", () => {
    for (const s of lock.sources) {
      for (const f of s.files) {
        const p = new URL(f.to, pub);
        if (!existsSync(p)) continue;
        expect(createHash("sha256").update(readFileSync(p)).digest("hex"), f.to).toBe(f.sha256);
      }
    }
  });
});
