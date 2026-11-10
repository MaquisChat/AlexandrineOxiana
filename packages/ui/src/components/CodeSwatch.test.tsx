import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CODE_PALETTE_SIZE } from "../theme/themes";
import { CODE_GLYPHS } from "./codeGlyphs";
import { CodeSwatch } from "./CodeSwatch";

describe("CODE_GLYPHS", () => {
  it("has one distinct, named shape per code colour, as SVG path data", () => {
    expect(CODE_GLYPHS).toHaveLength(CODE_PALETTE_SIZE);
    expect(new Set(CODE_GLYPHS.map((g) => g.name)).size).toBe(12);
    expect(new Set(CODE_GLYPHS.map((g) => g.d)).size).toBe(12);
    for (const g of CODE_GLYPHS) expect(g.d).toMatch(/^M[0-9 .LHVZAa-]+/);
  });
});

describe("<CodeSwatch>", () => {
  it("shows the code's colour token, its shape and its name (never colour alone)", () => {
    render(<CodeSwatch index={3} name="Distrust of institutions" />);
    const sw = screen.getByTestId("code-swatch");
    const svg = sw.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const path = svg.querySelector("path")!;
    expect(path.getAttribute("d")).toBe(CODE_GLYPHS[2]!.d);
    expect(path.getAttribute("fill")).toBe("var(--code-3)");
    const name = screen.getByText("Distrust of institutions");
    expect(name.getAttribute("dir")).toBe("auto");
    // The shape is named for screen readers alongside the code name.
    expect(sw.textContent).toContain(CODE_GLYPHS[2]!.name);
  });

  it("wraps around after 12 codes, and uses a custom colour when the user set one", () => {
    render(<CodeSwatch index={13} name="Thirteenth" color="#7A1F5C" />);
    const path = screen.getByTestId("code-swatch").querySelector("path")!;
    expect(path.getAttribute("d")).toBe(CODE_GLYPHS[0]!.d);
    expect(path.getAttribute("fill")).toBe("#7A1F5C");
  });

  it("refuses an index below 1", () => {
    expect(() => render(<CodeSwatch index={0} name="x" />)).toThrow(/index/);
  });
});
