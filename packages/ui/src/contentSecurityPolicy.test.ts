/**
 * The app's content-security policy, exactly (R105, R109, R135 4, R140): every directive and
 * every source of each, so that any addition, removal or widening fails here and has to be
 * decided, not slipped in. Beside serviceConnection.test.ts, which checks parts of the same tag.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** The policy of index.html's meta tag as directive → sorted sources; a repeated directive throws. */
function policyOf(html: string): Map<string, string[]> {
  const tags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi)];
  if (tags.length !== 1) throw new Error(`expected exactly one policy tag, found ${tags.length}`);
  const out = new Map<string, string[]>();
  for (const part of tags[0]![1]!.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    if (out.has(key)) throw new Error(`directive ${key} appears twice`);
    out.set(key, sources.sort());
  }
  return out;
}

const EXPECTED: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "blob:", "data:"],
  // R135 (4): the same loopback reach as connect-src, plus blob:, for media tickets.
  "media-src": ["blob:", "http://127.0.0.1:*", "http://localhost:*"],
  "font-src": ["'self'"],
  "connect-src": ["http://127.0.0.1:*", "http://localhost:*"],
  "frame-src": ["blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
};

describe("index.html content-security policy (exact)", () => {
  const policy = policyOf(readFileSync(join(here, "..", "index.html"), "utf8"));

  it("has exactly the expected directives", () => {
    expect([...policy.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [directive, sources] of Object.entries(EXPECTED)) {
    it(`${directive}: exactly ${sources.join(" ")}`, () => {
      expect(policy.get(directive)).toEqual([...sources].sort());
    });
  }

  it("the parser itself refuses a second tag or a repeated directive", () => {
    const tag = (c: string) => `<meta http-equiv="Content-Security-Policy" content="${c}" />`;
    expect(() => policyOf(tag("a 'self'") + tag("b 'self'"))).toThrow(/exactly one/);
    expect(() => policyOf(tag("media-src blob:; media-src *"))).toThrow(/twice/);
    expect(policyOf(tag("media-src http://localhost:* blob:")).get("media-src")).toEqual(["blob:", "http://localhost:*"]);
  });
});
