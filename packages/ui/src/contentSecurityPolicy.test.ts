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
  // R192 (b), Task R6: 'self' so that pdf.js (useWorkerFetch: false) reads its bundled character
  // maps and standard fonts from the app's own files (/pdfjs/) with fetch. Nothing else is added.
  "connect-src": ["'self'", "http://127.0.0.1:*", "http://localhost:*"],
  "frame-src": ["blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
};

/** The policy the desktop shell sets (apps/desktop/src-tauri/tauri.conf.json, app.security.csp). */
function shellPolicy(): string {
  const conf = JSON.parse(readFileSync(join(here, "..", "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")) as { app?: { security?: { csp?: unknown } } };
  const csp = conf.app?.security?.csp;
  if (typeof csp !== "string") throw new Error("tauri.conf.json has no app.security.csp string");
  return csp;
}

describe("the shell's policy and the page's policy", () => {
  it("index.html and tauri.conf.json carry the same policy", () => {
    const html = readFileSync(join(here, "..", "index.html"), "utf8");
    const tags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi)];
    expect(tags).toHaveLength(1);
    // Character for character: the shell's header and the page's tag must never drift apart.
    expect(shellPolicy()).toBe(tags[0]![1]);
  });
});

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

/**
 * Whether `address` is allowed by a directive's source list, as CSP Level 3 matches the source forms
 * this policy uses: 'self', 'none', a scheme (`blob:`, `data:`) and `scheme://host[:port|:*]`. Any
 * other form (`*`, `https:`, `*.host`, a nonce...) throws, so a widening cannot pass unexamined.
 */
function allows(sources: string[], address: string, self: string): boolean {
  const url = new URL(address);
  const defaultPort = (scheme: string) => (scheme === "https:" ? "443" : "80");
  return sources.some((src) => {
    if (src === "'none'") return false;
    if (src === "'self'") return url.origin !== "null" && url.origin === new URL(self).origin;
    if (/^(blob|data):$/i.test(src)) return url.protocol === src.toLowerCase();
    const m = /^(https?):\/\/([a-z0-9.-]+)(?::(\d+|\*))?$/i.exec(src);
    if (!m) throw new Error(`a source this check does not know: ${src}`);
    const scheme = `${m[1]!.toLowerCase()}:`;
    if (url.protocol !== scheme || url.hostname !== m[2]!.toLowerCase()) return false;
    return m[3] === "*" || (url.port || defaultPort(scheme)) === (m[3] ?? defaultPort(scheme));
  });
}

describe("media-src: recordings come only from the service on this computer (FR-227, FR-228)", () => {
  const page = policyOf(readFileSync(join(here, "..", "index.html"), "utf8"));
  const shell = policyOf(`<meta http-equiv="Content-Security-Policy" content="${shellPolicy()}" />`);
  /** The app's own origin in the shell and under a browser: neither is a source of media. */
  const SELVES = ["tauri://localhost", "http://localhost:5173"];
  /** Addresses of other origins: a recording or a picture from any of them is refused. */
  const ELSEWHERE = [
    "https://media.example.org/interview.mp3",
    "http://example.org/clip.mp4",
    "http://192.168.1.20:4100/media/tk_abc",
    "http://10.0.0.5/video.webm",
    "http://127.0.0.1.example.org:4100/media/tk_abc",
    "http://localhost.example.org/media/tk_abc",
    "https://127.0.0.1.nip.io/media/tk_abc",
    "http://[::1]:4100/media/tk_abc",
  ];

  for (const [where, policy] of [
    ["the page (index.html)", page],
    ["the shell (tauri.conf.json)", shell],
  ] as const) {
    const media = policy.get("media-src")!;

    it(`${where}: media-src is exactly http://127.0.0.1:* http://localhost:* blob:`, () => {
      expect(media).toEqual(["blob:", "http://127.0.0.1:*", "http://localhost:*"]);
    });

    it(`${where}: a media ticket from the service on loopback, and a blob:, are allowed`, () => {
      for (const self of SELVES) {
        expect(allows(media, "http://127.0.0.1:4100/media/tk_abc", self)).toBe(true);
        expect(allows(media, "http://localhost:51234/media/tk_abc", self)).toBe(true);
        expect(allows(media, "blob:tauri://localhost/5f0c-11aa", self)).toBe(true);
      }
    });

    it(`${where}: a recording or a picture from any other origin is refused`, () => {
      for (const self of SELVES) {
        for (const address of ELSEWHERE) {
          expect(allows(media, address, self), `media-src must refuse ${address}`).toBe(false);
          expect(allows(policy.get("img-src")!, address, self), `img-src must refuse ${address}`).toBe(false);
        }
        // Media has no data:: only the service's tickets and blob: copies play.
        expect(allows(media, "data:audio/mpeg;base64,SUQz", self)).toBe(false);
      }
      // Nor 'self': in the shell, the app's own files are not a source of media.
      expect(allows(media, "tauri://localhost/assets/clip.mp3", "tauri://localhost")).toBe(false);
    });
  }

  it("the check itself refuses a source form it does not know, such as a wildcard", () => {
    expect(() => allows(["*"], "https://example.org/a.mp3", "tauri://localhost")).toThrow(/does not know/);
    expect(() => allows(["https:"], "https://example.org/a.mp3", "tauri://localhost")).toThrow(/does not know/);
    expect(allows(["http://127.0.0.1:4100"], "http://127.0.0.1:4101/m", "tauri://localhost")).toBe(false);
    expect(allows(["http://127.0.0.1:4100"], "http://127.0.0.1:4100/m", "tauri://localhost")).toBe(true);
  });
});
