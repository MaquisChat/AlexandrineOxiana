// @vitest-environment node
// R105 (I2): colours are written only in tokens.css. Stylelint guards the CSS; this scan guards the
// TypeScript: no colour literals in .ts/.tsx (tests and the token tooling excepted) and no style
// props that set a colour. Run on its own with `pnpm --filter @ao/ui lint:colours`.
import { describe, expect, it } from "vitest";
import { scanFiles, scanSource } from "../../scripts/colour-scan.mjs";

const rulesOf = (code: string, file = "src/screens/X.tsx") => scanSource(code, file).map((f) => f.rule);

describe("colour scan of .ts/.tsx", () => {
  it("the package's sources are clean", () => {
    const findings = scanFiles(new URL("../../", import.meta.url));
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.text}`)).toEqual([]);
  });

  it("refuses colour literals (reviewer bypasses)", () => {
    for (const code of [
      `const c = "#fff";`,
      `const c = '#1C1B19';`,
      "const c = `#abcd`;",
      `const c = "#11223344";`,
      `const c = "rgb(0 0 0)";`,
      `const c = "RGBA(0,0,0,.5)";`,
      `const c = "Hsl(10 20% 30%)";`,
      `const c = "hwb(0 0% 0%)";`,
      `const c = "lab(50% 40 59)";`,
      `const c = "LCH(50% 40 59)";`,
      `const c = "oklab(0.6 0.1 0.1)";`,
      `const c = "oklch(60% 0.1 200)";`,
      `const c = "color(display-p3 1 0 0)";`,
      `const c = "device-cmyk(0 1 1 0)";`,
      `const c = "color-mix(in srgb, red 50%, blue)";`,
      `el.style.setProperty("--x", "#ff0000");`,
      "const c = `rgb(${r} ${g} ${b})`;",
      `const svg = "data:image/svg+xml,<svg fill='%23ff0000'/>";`,
    ]) {
      expect(rulesOf(code), code).toContain("colour-literal");
    }
  });

  it("refuses style props that set a colour, whatever the value (reviewer bypasses)", () => {
    for (const code of [
      `<div style={{ color: "var(--ink)" }} />`,
      `<div style={{ backgroundColor: x }} />`,
      `<div style={{ background: x }} />`,
      `<div style={{ "border-color": x }} />`,
      `<div style={{ borderColor: x }} />`,
      `<div style={{ fill: x }} />`,
      `<div style={{ stroke: x }} />`,
      `<div style={{ outlineColor: x }} />`,
      `<div style={{ caretColor: x }} />`,
      `<div style={{ boxShadow: x }} />`,
      `<div style={{\n  margin: 0,\n  color: x,\n}} />`,
      `const s = { color: x }; <div style={s} />`,
      `<div style={styles} />`,
      `React.createElement("div", { style: { color: x } })`,
      `el.setAttribute("style", "color: var(--ink)")`,
      `el.style.color = x;`,
      `el.style.backgroundColor = x;`,
      `el.style.cssText = "color: red";`,
    ]) {
      expect(rulesOf(code), code).toContain("colour-style");
    }
  });

  it("catches the round-2 gaps (R109): shorthands, SVG paint attributes, setProperty, computed keys, named colours, multi-line templates, constructable sheets, canvas", () => {
    const cases: string[] = [
      // shorthand keys in style objects
      `<div style={{ border: x }} />`,
      `<div style={{ borderTop: "1px solid var(--line)" }} />`,
      `<div style={{ outline: x }} />`,
      `<div style={{ "box-shadow": x }} />`,
      `<div style={{ textShadow: x }} />`,
      `<div style={{ fill: x, stroke: y }} />`,
      // SVG fill/stroke attributes that are not none/currentColor/var(--…)
      `<path fill="red" />`,
      `<path stroke="tomato" />`,
      `<path fill={colour} />`,
      `<circle stroke={props.c} />`,
      `<path fill={"rebeccapurple"} />`,
      // style.setProperty on a real property, or with a name that cannot be checked
      `el.style.setProperty("color", x);`,
      `el.style.setProperty("background", "var(--ink)");`,
      `el.style.setProperty(name, x);`,
      // computed keys in style objects
      `<div style={{ [key]: x }} />`,
      `<div style={{ ["color"]: x }} />`,
      // named colours as values
      `<div style={{ margin: 0, borderTop: "1px solid red" }} />`,
      `el.style.cssText = "border: 1px solid navy";`,
      `const css = "a { color: gold }";`,
      // multi-line template literals
      "const css = `\n  .x {\n    color: #ff0000;\n  }\n`;",
      "const css = `\n  .x { border: 1px solid\n    red; }\n`;",
      // constructable stylesheets
      `sheet.replaceSync(css);`,
      `sheet.insertRule(rule);`,
      // canvas
      `ctx.fillStyle = c;`,
      `ctx.strokeStyle = "var(--ink)";`,
      `ctx.shadowColor = c;`,
    ];
    for (const code of cases) expect(rulesOf(code).length, code).toBeGreaterThan(0);
  });

  it("allows tokens through CSS classes, SVG attributes with var(), hashes that are not colours, and the token tooling", () => {
    for (const code of [
      `<path fill={\`var(--code-\${n})\`} />`,
      `<path fill="none" stroke="currentColor" />`,
      `<path fill="var(--code-1)" />`,
      `<svg style={{ "--ao-swatch-fill": fill }} />`,
      `root.style.setProperty(\`--font-\${slot}\`, stack);`,
      `ctx.fillStyle = readToken("code-3");`,
      `const families = ["red", "orange", "gold"];`,
      `{ name: "teal", light: x }`,
      "const msg = `Code ${name} is gold-ish`;",
      `<a href="#section-1">x</a>`,
      `const id = "#root";`,
      `document.getElementById("root");`,
      `root.style.setProperty("--font-interface", stack);`,
      `<div className="ao-warning" />`,
      `const sha = "sha256:9f86d081";`,
    ]) {
      expect(rulesOf(code), code).toEqual([]);
    }
    expect(rulesOf(`const c = "#fff";`, "src/theme/contrast.test.ts")).toEqual([]);
    expect(rulesOf(`const c = "#fff";`, "src/test/media.ts")).toEqual([]);
  });
});
