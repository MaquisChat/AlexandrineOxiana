import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CODE_PALETTE_SIZE } from "../theme/themes";
import { CODE_GLYPHS } from "./codeGlyphs";
import { CodeSwatch } from "./CodeSwatch";
import { UserText } from "./UserText";

/** The colour a swatch paints its glyph with (a custom property on the svg; CodeSwatch.css uses it). */
const fillOf = (sw: Element) => (sw.querySelector("svg") as SVGElement).style.getPropertyValue("--ao-swatch-fill");

type Pt = [number, number];

/** Vertices of a path made only of straight segments (M/L/H/V/Z), or null if it has curves. */
function polygon(d: string): Pt[] | null {
  if (/[AaCcQqSsTt]/.test(d)) return null;
  const pts: Pt[] = [];
  let x = 0;
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
    const n = args!.trim() ? args!.trim().split(/[ ,]+/).map(Number) : [];
    if (cmd === "M" || cmd === "L") for (let i = 0; i < n.length; i += 2) pts.push([(x = n[i]!), (y = n[i + 1]!)]);
    else if (cmd === "H") pts.push([(x = n[0]!), y]);
    else if (cmd === "V") pts.push([x, (y = n[0]!)]);
  }
  return pts;
}

/** Normalised shape: centred on its centroid and scaled to unit size, as a sorted vertex list. */
function normal(pts: Pt[]): Pt[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const r = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
  return pts.map(([px, py]) => [(px - cx) / r, (py - cy) / r] as Pt);
}

function sameSet(a: Pt[], b: Pt[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p) => b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.06));
}

/** Whether b is a rotation (any angle in 1° steps) or mirror image of a. */
function congruent(a: Pt[], b: Pt[]): boolean {
  const na = normal(a);
  const nb = normal(b);
  for (const mirror of [1, -1]) {
    for (let deg = 0; deg < 360; deg += 1) {
      const t = (deg * Math.PI) / 180;
      const rot = na.map(([x, y]) => [mirror * x * Math.cos(t) - y * Math.sin(t), mirror * x * Math.sin(t) + y * Math.cos(t)] as Pt);
      if (sameSet(rot, nb)) return true;
    }
  }
  return false;
}

describe("CODE_GLYPHS", () => {
  it("has one distinct, named shape per code colour, as SVG path data", () => {
    expect(CODE_GLYPHS).toHaveLength(CODE_PALETTE_SIZE);
    expect(new Set(CODE_GLYPHS.map((g) => g.name)).size).toBe(12);
    expect(new Set(CODE_GLYPHS.map((g) => g.d)).size).toBe(12);
    for (const g of CODE_GLYPHS) expect(g.d).toMatch(/^M[0-9 .MLHVZAa-]+$/);
  });

  it("no shape is a rotated or mirrored copy of another (R105)", () => {
    const polys = CODE_GLYPHS.map((g) => [g.name, polygon(g.d)] as const).filter((x): x is readonly [string, Pt[]] => x[1] !== null);
    expect(polys.length).toBeGreaterThan(6);
    const pairs: string[] = [];
    for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) if (congruent(polys[i]![1], polys[j]![1])) pairs.push(`${polys[i]![0]} ~ ${polys[j]![0]}`);
    expect(pairs).toEqual([]);
    // The test itself catches a rotated pair.
    expect(congruent(polygon("M3 3H13V13H3Z")!, polygon("M8 1L15 8L8 15L1 8Z")!)).toBe(true);
    expect(congruent(polygon("M8 2L14 13H2Z")!, polygon("M2 3H14L8 14Z")!)).toBe(true);
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
    expect(fillOf(sw)).toBe("var(--code-3)");
    expect(path.getAttribute("fill")).toBeNull(); // no paint attribute: the colour comes through CSS
    const name = screen.getByText("Distrust of institutions");
    expect(name.getAttribute("dir")).toBe("auto");
    expect(sw.textContent).toContain(CODE_GLYPHS[2]!.name);
    expect(sw.querySelector("[data-testid=code-badge]")).toBeNull();
  });

  it("after 12 codes the shapes repeat with a number badge, so code 13 is not mistaken for code 1", () => {
    render(<CodeSwatch index={13} name="Thirteenth" />);
    const sw = screen.getByTestId("code-swatch");
    expect(sw.querySelector("path")!.getAttribute("d")).toBe(CODE_GLYPHS[0]!.d);
    expect(sw.querySelector("[data-testid=code-badge]")!.textContent).toBe("13");
  });

  it("uses a valid custom colour the user set, and ignores anything else", () => {
    const { unmount } = render(<CodeSwatch index={2} name="Custom" color="#7A1F5C" />);
    expect(fillOf(screen.getByTestId("code-swatch"))).toBe("#7A1F5C");
    unmount();
    render(<CodeSwatch index={2} name="Bad" color="red; background: url(x)" />);
    expect(fillOf(screen.getByTestId("code-swatch"))).toBe("var(--code-2)");
  });

  it("never throws: a bad index shows a neutral swatch with the name", () => {
    for (const index of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const { unmount } = render(<CodeSwatch index={index} name={`code ${index}`} />);
      const sw = screen.getByTestId("code-swatch");
      expect(fillOf(sw)).toBe("var(--muted)");
      expect(screen.getByText(`code ${index}`)).toBeTruthy();
      unmount();
    }
  });

  it("takes no free style (colours come from tokens)", () => {
    const props = { index: 1, name: "n", style: { color: "red" } } as unknown as Parameters<typeof CodeSwatch>[0];
    render(<CodeSwatch {...props} />);
    expect(screen.getByTestId("code-swatch").getAttribute("style")).toBeNull();
  });
});

describe("<UserText>", () => {
  it("takes no free style prop", () => {
    const props = { children: "x", style: { color: "red" } } as unknown as Parameters<typeof UserText>[0];
    render(<UserText {...props} />);
    expect(screen.getByText("x").getAttribute("style")).toBeNull();
  });
});
