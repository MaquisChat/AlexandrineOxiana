// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("../../", import.meta.url));
const configFile = `${pkg}stylelint.config.mjs`;

async function lintCode(code: string, file: string) {
  const res = await stylelint.lint({ code, codeFilename: `${pkg}${file}`, configFile });
  return res.results[0]!.warnings.map((w) => w.rule);
}

describe("no hard-coded colours outside tokens.css (stylelint)", () => {
  it("the package's CSS passes `pnpm lint:css`", () => {
    // Runs the same command CI and developers run; throws (non-zero exit) on any violation.
    execFileSync(process.execPath, [`${pkg}node_modules/stylelint/bin/stylelint.mjs`, "src/**/*.css"], { cwd: pkg, stdio: "pipe" });
  });

  it("flags a hex colour, a named colour or a colour function in a component stylesheet", async () => {
    expect(await lintCode(".x { color: #fff; }", "src/screens/x.css")).toContain("color-no-hex");
    expect(await lintCode(".x { background: red; }", "src/screens/x.css")).toContain("color-named");
    expect(await lintCode(".x { border-color: rgb(0 0 0); }", "src/screens/x.css")).toContain("function-disallowed-list");
    expect(await lintCode(".x { color: oklch(50% 0.1 200); }", "src/screens/x.css")).toContain("function-disallowed-list");
  });

  it("flags every colour bypass the review found (R105 I2)", async () => {
    const bypasses = [
      ".x { color: RGB(0 0 0); }",
      ".x { color: Rgba(0, 0, 0, 0.5); }",
      ".x { color: HSL(0 0% 0%); }",
      ".x { color: hwb(0 0% 0%); }",
      ".x { color: LAB(50% 40 59); }",
      ".x { color: lch(50% 40 59); }",
      ".x { color: OKLab(0.6 0.1 0.1); }",
      ".x { color: OKLCH(60% 0.1 200); }",
      ".x { color: color(display-p3 1 0 0); }",
      ".x { color: Color(srgb 1 0 0); }",
      ".x { color: device-cmyk(0 1 1 0); }",
      ".x { color: color-mix(in srgb, var(--ink) 50%, white); }",
      ".x { color: Canvas; }",
      ".x { background: ButtonFace; }",
      ".x { color: canvastext; }",
      ".x { border-color: AccentColor; }",
      ".x { color: Highlight; }",
      ".x { color: GrayText; }",
      ".x { color: WindowText; }",
      ".x { outline: 1px solid -webkit-focus-ring-color; }",
      ".x { background: url(\"data:image/svg+xml,%3Csvg fill='%23ff0000'/%3E\"); }",
      ".x { background: url(data:image/svg+xml;utf8,<svg%20fill=%23f00/>); }",
      ".x { background-image: URL('data:image/svg+xml,%23abc'); }",
      ".x { color: #FFF; }",
      ".x { --mine: #123456; }",
    ];
    for (const code of bypasses) expect((await lintCode(code, "src/screens/x.css")).length, code).toBeGreaterThan(0);
  });

  it("flags the round-2 gaps (R109): system colours in any property, data: URIs with named colours or base64 images, color-mix with a non-token argument", async () => {
    const bypasses = [
      ".x { background-image: linear-gradient(Canvas, transparent); }",
      ".x { background-image: linear-gradient(to right, ButtonText 0%, transparent); }",
      ".x { filter: drop-shadow(0 0 2px CanvasText); }",
      ".x { -webkit-text-fill-color: Canvas; }",
      ".x { -webkit-text-stroke: 1px ButtonText; }",
      ".x { -webkit-text-stroke-color: highlight; }",
      ".x { mask-image: radial-gradient(Field, transparent); }",
      ".x { border-image: linear-gradient(GrayText, transparent) 1; }",
      ".x { list-style-image: linear-gradient(Mark, Mark); }",
      ".x { box-shadow: 0 0 0 2px Highlight; }",
      ".x { background: url(\"data:image/svg+xml,<svg fill='red'/>\"); }",
      ".x { background: url(data:image/svg+xml;utf8,<svg%20stroke=navy/>); }",
      ".x { background-image: url(\"data:image/png;base64,iVBORw0KGgo=\"); }",
      ".x { list-style-image: url('data:image/gif;base64,R0lGOD'); }",
      ".x { color: color-mix(in srgb, var(--ink) 50%, #fff); }",
      ".x { color: color-mix(in srgb, var(--ink), red); }",
      ".x { color: COLOR-MIX(in oklab, var(--ink) 40%, rgb(0 0 0)); }",
      ".x { color: color-mix(in srgb, var(--ink, red), var(--accent)); }",
      ".x { color: color-mix(in srgb, var(--ink) 50%, Canvas); }",
    ];
    for (const code of bypasses) expect((await lintCode(code, "src/screens/x.css")).length, code).toBeGreaterThan(0);
  });

  it("allows color-mix() when every colour is a token, and ordinary words that only look like system colours", async () => {
    for (const code of [
      ".x { color: color-mix(in srgb, var(--ink) 40%, var(--surface)); }",
      ".x { background: color-mix(in oklab, var(--accent), var(--bg) 20%); }",
      ".x { transition: background 0.2s, color 0.2s; }",
      ".x { will-change: background; }",
      ".x { background: url(\"/img/menu.svg\"); }",
      ".x { grid-template-areas: \"menu main\"; }",
    ]) {
      expect(await lintCode(code, "src/screens/x.css"), code).toEqual([]);
    }
  });

  it("allows tokens everywhere and literal colours only in src/theme/tokens.css", async () => {
    expect(await lintCode(".x { color: currentColor; background: transparent; border-color: inherit; }", "src/screens/x.css")).toEqual([]);
    expect(await lintCode(".x { background: url(\"/fonts/x.woff2\"); }", "src/screens/x.css")).toEqual([]);
    expect(await lintCode(".x { color: var(--ink); background: var(--surface); }", "src/screens/x.css")).toEqual([]);
    expect(await lintCode(":root { --ink: #1C1B19; }", "src/theme/tokens.css")).toEqual([]);
    expect(await lintCode(":root { --ink: #1C1B19; }", "src/theme/fonts.css")).toContain("color-no-hex");
  });
});
