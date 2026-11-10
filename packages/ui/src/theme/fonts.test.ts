// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import lock from "../../scripts/fonts.lock.json";
import { DEFAULT_APPEARANCE } from "./appearance";
import { FONT_PRESETS, GOUDY_STACK, MONO_STACK, SCRIPT_FALLBACKS, fontStack } from "./fonts";

const FALLBACKS =
  "'Noto Serif', 'Noto Sans', 'Noto Naskh Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Serif CJK SC', 'Noto Serif CJK JP', 'Noto Serif CJK KR', 'Hiragino Mincho ProN', 'Songti SC', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Mincho', 'Malgun Gothic', 'Segoe UI Historic', serif";

describe("font stacks", () => {
  it("the per-script fallback chain is exactly the one in the brief", () => {
    expect(SCRIPT_FALLBACKS).toBe(FALLBACKS);
  });

  it("default interface, reading, transcript and notes typeface is the Goudy stack; mono is the system mono stack", () => {
    expect(GOUDY_STACK).toBe("'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif");
    expect(MONO_STACK).toBe("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    for (const slot of ["interface", "reading", "transcript", "notes"] as const) expect(DEFAULT_APPEARANCE.fonts[slot].family).toBe(GOUDY_STACK);
    expect(DEFAULT_APPEARANCE.fonts.mono).toEqual({ family: MONO_STACK, source: "system" });
  });

  it("fontStack keeps the chosen families first and appends the per-script fallbacks", () => {
    const s = fontStack({ family: GOUDY_STACK, source: "bundled" });
    expect(s.startsWith("'Goudy Old Style', 'Sorts Mill Goudy'")).toBe(true);
    expect(s).toBe(`'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, ${FALLBACKS}`);
    expect(s.match(/\bserif$/)).not.toBeNull();
    expect(s.split(", ").filter((f) => f === "serif")).toHaveLength(1); // the generic family comes last, once
  });

  it("quotes a single family name that needs it, and keeps a non-serif generic before the final serif", () => {
    expect(fontStack({ family: "Inter", source: "system" })).toBe(`Inter, ${FALLBACKS}`);
    expect(fontStack({ family: "Atkinson Hyperlegible", source: "bundled" })).toBe(`'Atkinson Hyperlegible', ${FALLBACKS}`);
    expect(fontStack({ family: "Bob's Font", source: "system" }).startsWith(`'Bob\\'s Font', `)).toBe(true);
    const mono = fontStack({ family: MONO_STACK, source: "system" });
    expect(mono.startsWith("ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Serif'")).toBe(true);
    expect(mono.endsWith("'Segoe UI Historic', monospace, serif")).toBe(true);
  });

  it("a user-file font uses the family name it registers under (the file itself is loaded by the desktop shell)", () => {
    expect(fontStack({ family: "My Thesis Font", source: "user-file", file: "fonts/thesis.otf" })).toBe(`'My Thesis Font', ${FALLBACKS}`);
  });

  it("refuses family names that could escape the font-family value", () => {
    for (const bad of ["x; color: red", "a{b}", "<script>", ""]) expect(() => fontStack({ family: bad, source: "system" })).toThrow(/font name/);
  });

  it("offers Atkinson Hyperlegible and OpenDyslexic (bundled) as readability presets", () => {
    const byLabel = new Map(FONT_PRESETS.map((p) => [p.family, p]));
    expect(byLabel.get("Atkinson Hyperlegible")?.source).toBe("bundled");
    expect(byLabel.get("OpenDyslexic")?.source).toBe("bundled");
    expect(byLabel.get(GOUDY_STACK)?.source).toBe("bundled");
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
