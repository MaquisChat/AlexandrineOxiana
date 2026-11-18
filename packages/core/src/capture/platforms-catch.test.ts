/**
 * R391 f (review M6): the catch-all of classifyUrl never stores the address as given. The inner
 * classifier is made to throw through the secret-name rule it calls (a stub of ./secret-names.js).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ throws: 0 }));
vi.mock("./secret-names.js", async (orig) => {
  const real = await orig<typeof import("./secret-names.js")>();
  return {
    ...real,
    secretName: (name: string, value?: string) => {
      if (state.throws > 0) {
        state.throws--;
        throw new Error("unexpected");
      }
      return real.secretName(name, value);
    },
  };
});

const { classifyUrl, cleanAddress } = await import("./platforms.js");
const PROBE = "https://ana:hunter2@portal.example.org/case/7;jsessionid=JSESS?id=7&access_token=SECRETTOKEN#frag";

afterEach(() => {
  state.throws = 0;
});

describe("classifyUrl's catch-all stores the cleaned address, or one cut short, never the address as given (R391 f)", () => {
  it("when the input can be cleaned, the cleaned form", () => {
    state.throws = 1; // the classifier throws; the cleaner, called again, works
    expect(classifyUrl(PROBE)).toEqual({ platform: "other", kind: "unknown", canonicalUrl: "https://portal.example.org/case/7?id=7" });
  });

  it("when it cannot be cleaned either: everything from the first ? # or ; removed, and the user name and password", () => {
    state.throws = 1_000;
    const c = classifyUrl(PROBE);
    expect(c).toEqual({ platform: "other", kind: "unknown", canonicalUrl: "https://portal.example.org/case/7" });
    for (const bad of ["ana", "hunter2", "JSESS", "SECRETTOKEN", "frag"]) expect(c.canonicalUrl).not.toContain(bad);
    expect(cleanAddress("http://u@h.example/a#x")).toBe("http://h.example/a");
    expect(cleanAddress("https://a:b;c@h.example/p?x=1")).toBe("https://h.example/p");
    expect(cleanAddress("https://h.example/p?mail=a@b.example")).toBe("https://h.example/p");
  });
});
