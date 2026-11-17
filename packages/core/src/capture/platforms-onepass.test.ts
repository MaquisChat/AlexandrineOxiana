/**
 * R391 b, R415 f (FR-A11 review 2 M6): the query cleaner makes one pass. It is held by counting work, not
 * seconds: every parameter is judged by the secret-name rule exactly once, and the text handed to the
 * rule grows as the query does (twice the parameters, exactly twice the calls and the characters).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const work = vi.hoisted(() => ({ calls: 0, chars: 0 }));
vi.mock("./secret-names.js", async (orig) => {
  const real = await orig<typeof import("./secret-names.js")>();
  return {
    ...real,
    secretName: (name: string, value?: string) => {
      work.calls++;
      work.chars += name.length + (value?.length ?? 0);
      return real.secretName(name, value);
    },
  };
});

const { classifyUrl } = await import("./platforms.js");
const KEY = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY";

afterEach(() => {
  work.calls = 0;
  work.chars = 0;
});

/** The work for a query of `n` parameters (half dropped as tracking, half as secret), and its result. */
function measure(n: number): { calls: number; chars: number; url: string } {
  work.calls = 0;
  work.chars = 0;
  const q = Array.from({ length: n }, (_, i) => (i % 2 ? `p${i % 10}_token=${KEY}` : `utm_x${i % 10}=1`)).join("&");
  const url = classifyUrl(`https://ex.example.org/p?keep=1&${q}`).canonicalUrl;
  return { calls: work.calls, chars: work.chars, url };
}

describe("the query is cleaned in one pass: work counted, not timed (R391 b, R415 f)", () => {
  it("10,000 and 20,000 parameters: each judged once, twice the parameters exactly twice the work", () => {
    const a = measure(10_000);
    const b = measure(20_000);
    expect(a.url).toBe("https://ex.example.org/p?keep=1");
    expect(b.url).toBe("https://ex.example.org/p?keep=1");
    // Tracking parameters are dropped before the rule is asked; the secret ones and `keep` reach it once each.
    expect(a.calls).toBe(5_000 + 1);
    expect(b.calls).toBe(10_000 + 1);
    // `keep=1` gives 5 characters; the rest doubles exactly.
    expect(b.chars - 5).toBe(2 * (a.chars - 5));
  });
});
