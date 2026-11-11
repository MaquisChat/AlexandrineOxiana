import { describe, expect, it } from "vitest";
import rawSelectors from "./selectors.json";
import { SelectorsError, unsafePatternReason, validateSelectors } from "./selectors-schema.js";
import { MAX_PATTERN_INPUT } from "./extractors/engine.js";

const clone = (): any => JSON.parse(JSON.stringify(rawSelectors));

describe("selectors.json schema", () => {
  it("accepts the shipped selectors.json", () => {
    const s = validateSelectors(rawSelectors);
    expect(Object.keys(s.platforms).sort()).toEqual(["generic", "instagram", "tiktok", "youtube"]);
  });

  it("refuses a wrong version", () => {
    const s = clone();
    s.version = 2;
    expect(() => validateSelectors(s)).toThrow(SelectorsError);
  });

  it("refuses unknown keys (typos are not silently ignored)", () => {
    const s = clone();
    s.platforms.instagram.pages.post.fields.captoin = s.platforms.instagram.pages.post.fields.caption;
    expect(() => validateSelectors(s)).toThrow(/captoin/);
    const t = clone();
    t.platforms.instagram.extra = true;
    expect(() => validateSelectors(t)).toThrow(/extra/);
  });

  it("refuses a selector that is not valid CSS", () => {
    const s = clone();
    s.platforms.instagram.pages.post.fields.caption[0].css = "article >>> h1[";
    expect(() => validateSelectors(s)).toThrow(/css/);
  });

  it("refuses reading anything but text or a safe attribute", () => {
    for (const read of ["html", "attr:onclick", "attr:innerHTML", "attr:style", ""]) {
      const s = clone();
      s.platforms.instagram.pages.post.fields.caption[0].read = read;
      expect(() => validateSelectors(s), read).toThrow(SelectorsError);
    }
  });

  it("refuses a pattern that is not a valid regular expression or has no capture group", () => {
    const s = clone();
    s.platforms.instagram.pages.post.fields.handle[0].pattern = "^/([a-z+/$";
    expect(() => validateSelectors(s)).toThrow(/pattern/);
    const t = clone();
    t.platforms.instagram.pages.post.fields.handle[0].pattern = "^/[a-z]+/$";
    expect(() => validateSelectors(t)).toThrow(/capture group/);
  });

  it("refuses patterns that can backtrack badly: nested quantifiers and backreferences", () => {
    for (const pattern of ["^((a+)+)$", "^(a*)*b$", "^((?:ab|a)+)+$", "^(a{1,5})+$", "^(?:([a-z]+)*)$", "^(a)\\1$", "^(?<x>a)\\k<x>$"]) {
      const s = clone();
      s.platforms.instagram.pages.post.fields.handle[0].pattern = pattern;
      expect(() => validateSelectors(s), pattern).toThrow(/pattern/);
    }
    // Ordinary patterns stay allowed, including a quantified group with no quantifier inside.
    for (const pattern of ["^/([A-Za-z0-9._]{1,30})/?$", "^(?:ab){1,8}([0-9]+)$", "^([0-9][0-9,.]*) people$", "^\\(([a-z]+)\\){1,3}$", "^([+*]+)$"]) {
      const s = clone();
      s.platforms.instagram.pages.post.fields.handle[0].pattern = pattern;
      expect(() => validateSelectors(s), pattern).not.toThrow();
    }
  });

  it("R116: refuses quantified groups with alternation and adjacent unbounded quantifiers over overlapping classes", () => {
    for (const pattern of ["(?:a|aa)+$", "(a|aa)+$", "(\\w|\\d)+$", "(.|\\s)*$", "(a|a?)+$", "^(a?){25}a{25}$", "\\s*\\s*\\s*$", "\\s*\\s*"]) {
      expect(unsafePatternReason(pattern), pattern).toBeDefined();
      const s = clone();
      s.platforms.instagram.pages.post.fields.handle[0].pattern = pattern.includes("(") && !pattern.startsWith("(?:") ? pattern : `(${pattern})`;
      expect(() => validateSelectors(s), pattern).toThrow(/pattern.*not allowed/);
    }
  });

  it("41a I4: polynomial backtracking shapes are refused, and every pattern the validator lets through runs within a small budget on a long hostile string", () => {
    const hostile = ["a".repeat(MAX_PATTERN_INPUT - 1) + "#", "1".repeat(MAX_PATTERN_INPUT - 1) + "!", " ".repeat(MAX_PATTERN_INPUT - 1) + "x"];
    const candidates = [
      // The reviewer's three (O(n^4) on 121 characters, about 2 s each).
      "a*b?a*b?a*b?a*$",
      "a*(?:)a*(?:)a*(?:)a*$",
      "[a-z]*[0-9]?[a-z]*[0-9]?[a-z]*[0-9]?[a-z]*!$",
      // Cousins: nullable separators of other kinds, quantifiers hidden in groups or lookarounds,
      // unanchored single quantifiers (O(n^2) over every start), many optional atoms (exponential).
      "^(a*)(?:a*)(?:a*)!$",
      "^a*(?:b|)a*!$",
      "^(?=a*a*a*!)(a)",
      "[a-z]*([a-z])!$",
      "^(a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?)aaaaaaaaaaaaaaaaaaaa!$",
      "^\\s*(\\d+)\\s*$",
      "^(?:a|b)*(x)|(y)$",
      // Allowed shapes: start-anchored, one unbounded quantifier, few bounded choices.
      "^a{0,15}a{0,15}([a-z]*)!$",
      "^([0-9][0-9,.]*) people$",
      "^/([A-Za-z0-9._]{1,30})/?$",
    ];
    // Refusals first: the shapes above would not finish on the hostile strings.
    for (const p of candidates.slice(0, 10)) expect(unsafePatternReason(p), p).toMatch(/not allowed/);
    let allowed = 0;
    for (const pattern of candidates) {
      if (unsafePatternReason(pattern) !== undefined) continue;
      allowed++;
      const re = new RegExp(pattern);
      for (const s of hostile) {
        const t0 = performance.now();
        re.exec(s.slice(0, MAX_PATTERN_INPUT));
        expect(performance.now() - t0, `${pattern} on ${s.slice(0, 3)}…`).toBeLessThan(250);
      }
    }
    expect(allowed).toBe(3);
  });

  it("R116: the patterns shipped in selectors.json still pass", () => {
    const shipped: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "pattern" && typeof x === "string" ? shipped.push(x) : walk(x));
    };
    walk(clone());
    expect(shipped).toHaveLength(3);
    for (const pattern of shipped) expect(unsafePatternReason(pattern), pattern).toBeUndefined();
    expect(() => validateSelectors(clone())).not.toThrow();
  });

  it("refuses a field with no alternatives or a non-array", () => {
    const s = clone();
    s.platforms.instagram.pages.post.fields.caption = [];
    expect(() => validateSelectors(s)).toThrow(SelectorsError);
    const t = clone();
    t.platforms.instagram.pages.post.fields.caption = { css: "h1" };
    expect(() => validateSelectors(t)).toThrow(SelectorsError);
  });

  it("refuses a missing generic section and non-objects", () => {
    const s = clone();
    delete s.platforms.generic;
    expect(() => validateSelectors(s)).toThrow(/generic/);
    expect(() => validateSelectors(null)).toThrow(SelectorsError);
    expect(() => validateSelectors("{}")).toThrow(SelectorsError);
  });
});
