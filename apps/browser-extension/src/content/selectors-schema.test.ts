import { describe, expect, it } from "vitest";
import rawSelectors from "./selectors.json";
import { SelectorsError, validateSelectors } from "./selectors-schema.js";

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
