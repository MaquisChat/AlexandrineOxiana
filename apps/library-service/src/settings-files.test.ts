/**
 * Settings writers never write what they did not read (Task 68, defect D16), and the way out for a
 * settings file that stays unreadable (Task 66's M8): the fonts index, the appearance settings and
 * the pairings, through the service's routes.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const APP = "http://tauri.localhost";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ui = { authorization: `Bearer ${TOKEN}`, origin: APP };

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let logs = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-settings-files-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  for (const n of ["fonts.json", "appearance.json", "extension-pairings.json"]) await chmod(join(deps.appConfigDir, n), 0o600).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await svc?.close();
  logs = "";
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (c, _e, cb) => ((logs += c.toString()), cb()) }), pairing: { confirmPerMinute: 100 } });
}

async function call(r: { method?: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string> }) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...ui, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

const cfg = (n: string) => join(deps.appConfigDir, n);
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Each way a settings file can be there and not be readable as itself (`n` is its name). */
const breakers = (n: string): Array<[string, () => Promise<void>]> => [
  ["invalid JSON", () => writeFile(cfg(n), "garbage{")],
  ["a truncated file", async () => writeFile(cfg(n), (await readFile(cfg(n), "utf8").catch(() => '{"x": [1, 2, 3]}')).slice(0, 12))],
  ["a directory in its place", async () => (await rm(cfg(n), { force: true }), mkdir(cfg(n)))],
  ["a link that cannot be followed (stands in for no permission when the tests run as root)", async () => (await rm(cfg(n), { force: true }), symlink(cfg(n), cfg(n)))],
];

/** What is in the settings folder: names, and the bytes of each regular file. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, pre: string) => {
    for (const n of (await readdir(d)).sort()) {
      const st = await lstat(join(d, n));
      if (st.isDirectory()) await walk(join(d, n), `${pre}${n}/`);
      else out[`${pre}${n}`] = st.isFile() ? (await readFile(join(d, n))).toString("base64") : "<link>";
    }
  };
  await walk(deps.appConfigDir, "");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fonts

const fontBytes = (tag = "wOF2", size = 600) => Buffer.concat([Buffer.from(tag, "latin1"), Buffer.alloc(size - 4, 7)]);
let fontN = 0;
async function fontFile(name: string, data = fontBytes("wOF2", 600 + ++fontN)): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, data);
  return p;
}
const addFont = async (name: string) => call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile(`${name}.woff2`), name } });

describe("the fonts index (D16)", () => {
  for (const [what, breakIt] of breakers("fonts.json")) {
    it(`unreadable at the moment of a change (${what}): the add and the remove are refused in plain words; nothing is written or deleted`, async () => {
      await start();
      const a = await addFont("Alpha");
      const b = await addFont("Beta");
      expect(a.status, a.body).toBe(200);
      expect(b.status, b.body).toBe(200);
      await breakIt();
      const before = await snapshot();
      const add = await addFont("Gamma");
      expect(add.status).toBe(503);
      expect(add.json.error).toMatchObject({ code: "UNAVAILABLE", reason: "fonts", message: "The list of added fonts could not be read, so it was not changed." });
      expect(add.body).not.toContain(tmp);
      const del = await call({ method: "DELETE", url: `/settings/fonts/${a.json.id as string}` });
      expect(del.status).toBe(503);
      expect(del.json.error.reason).toBe("fonts");
      // Nothing written, nothing deleted: no font file left behind without its entry, none removed.
      expect(await snapshot()).toEqual(before);
      // The list says so too, so the screen can offer the way out.
      const list = await call({ url: "/settings/fonts" });
      expect(list.status).toBe(503);
      expect(list.json.error.reason).toBe("fonts");
    });
  }

  it.skipIf(asRoot)("an index it has no permission to read: refused, nothing written", async () => {
    await start();
    await addFont("Alpha");
    await chmod(cfg("fonts.json"), 0o000);
    const before = await snapshot();
    expect((await addFont("Gamma")).status).toBe(503);
    expect(await snapshot()).toEqual(before);
  });

  it("missing on a fresh folder: no fonts yet, and an add works", async () => {
    await start();
    expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [] });
    expect((await addFont("Alpha")).status).toBe(200);
  });

  it("entries this app cannot use are kept in the file as they are by an add and a remove (only listed ones change)", async () => {
    await start();
    const a = await addFont("Alpha");
    const raw = JSON.parse(await readFile(cfg("fonts.json"), "utf8")) as { fonts: unknown[] };
    const odd = { id: "not-an-id", name: "From a newer version", format: "ttc" };
    await writeFile(cfg("fonts.json"), JSON.stringify({ ...raw, fonts: [...raw.fonts, odd] }));
    expect((await call({ url: "/settings/fonts" })).json.fonts).toHaveLength(1);
    const b = await addFont("Beta");
    expect((await call({ method: "DELETE", url: `/settings/fonts/${a.json.id as string}` })).status).toBe(200);
    const after = JSON.parse(await readFile(cfg("fonts.json"), "utf8")) as { fonts: Array<{ id: string }> };
    expect(after.fonts).toEqual([odd, b.json]);
  });

  it("two adds at once both land", async () => {
    await start();
    const [x, y] = await Promise.all([addFont("Alpha"), addFont("Beta")]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(((await call({ url: "/settings/fonts" })).json.fonts as Array<{ name: string }>).map((f) => f.name).sort()).toEqual(["Alpha", "Beta"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Appearance

describe("the appearance settings (D16)", () => {
  for (const [what, breakIt] of [...breakers("appearance.json"), ["a value this app refuses", () => writeFile(cfg("appearance.json"), JSON.stringify({ theme: "neon" }))] as [string, () => Promise<void>]]) {
    it(`unreadable at the moment of a change (${what}): the change is refused; the other settings are not reset; the app still shows the defaults`, async () => {
      await start();
      expect((await call({ method: "PUT", url: "/settings/appearance", body: { theme: "dark", textScale: 1.25 } })).status).toBe(200);
      await breakIt();
      const before = await snapshot();
      const put = await call({ method: "PUT", url: "/settings/appearance", body: { density: "compact" } });
      expect(put.status).toBe(503);
      expect(put.json.error).toMatchObject({ code: "UNAVAILABLE", reason: "appearance", message: "The appearance settings could not be read, so they were not changed." });
      expect(await snapshot()).toEqual(before);
      // Reading still works (the app must draw itself): the defaults, nothing written.
      expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "system" });
      expect(await snapshot()).toEqual(before);
    });
  }

  it("missing on a fresh folder: the defaults, and a change works", async () => {
    await start();
    expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "system" });
    expect((await call({ method: "PUT", url: "/settings/appearance", body: { theme: "dark" } })).status).toBe(200);
  });

  it("two changes at once both land", async () => {
    await start();
    await Promise.all([call({ method: "PUT", url: "/settings/appearance", body: { theme: "dark" } }), call({ method: "PUT", url: "/settings/appearance", body: { density: "compact" } })]);
    expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "dark", density: "compact" });
  });
});

// ---------------------------------------------------------------------------------------------
// The pairings (M8)

async function pair(origin = EXT): Promise<string> {
  const code = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
  return c.json().token as string;
}

describe("an unreadable pairings file never makes a browser forget its pairing (fix round 1, M5)", () => {
  const extGet = (token: string) => svc!.app.inject({ method: "GET", url: "/projects", headers: { authorization: `Bearer ${token}` } });
  const extPost = (token: string, origin = EXT) =>
    svc!.app.inject({ method: "POST", url: "/capture/browser/links", headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" }, payload: JSON.stringify({ projectId: "p", urls: ["https://www.youtube.com/watch?v=aoTest00001"] }) });

  it("while the file cannot be read, EVERY extension-token request gets the same 503 in the service's shape, never 401; it heals when the file reads again", async () => {
    await start();
    const token = await pair();
    const saved = await readFile(cfg("extension-pairings.json"), "utf8");
    await writeFile(cfg("extension-pairings.json"), "garbage{");
    await start();
    const answers = [await extGet(token), await extGet("not-a-paired-token-0123456789abcdef"), await extPost(token), await extPost("not-a-paired-token-0123456789abcdef", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")];
    for (const r of answers) {
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: { code: "UNAVAILABLE", message: "This computer's list of paired browsers cannot be read right now. Your browser stays paired; try again in a moment, or open the desktop app's “Browser extension” page." } });
    }
    // The desktop app's own token is not affected.
    expect((await call({ url: "/extension/pairings" })).status).toBe(200);
    // The file reads again: the same token works without pairing again.
    await writeFile(cfg("extension-pairings.json"), saved);
    expect((await extGet(token)).statusCode).not.toBe(401);
    expect([200, 503]).toContain((await extGet(token)).statusCode);
    expect((await extGet(token)).json().error?.code).not.toBe("UNAVAILABLE");
  });

  it("after the file heals, the FIRST request carrying the extension's Origin passes (review round 2, Rm1)", async () => {
    await start();
    const token = await pair();
    const saved = await readFile(cfg("extension-pairings.json"), "utf8");
    await writeFile(cfg("extension-pairings.json"), "garbage{");
    await start();
    expect((await extPost(token)).statusCode).toBe(503);
    await writeFile(cfg("extension-pairings.json"), saved);
    const first = await extPost(token);
    expect(first.statusCode).not.toBe(403);
    expect(first.statusCode).not.toBe(401);
    // Past authentication: what answers now is the route (no library is open in this test).
    expect(first.json().error?.code).toBe("LIBRARY_OFFLINE");
  });

  it("with the file readable, an unknown token is still 401 (nothing changes there)", async () => {
    await start();
    await pair();
    expect((await extGet("not-a-paired-token-0123456789abcdef")).statusCode).toBe(401);
  });
});

describe("the pairings file that stays unreadable (Task 66 M8)", () => {
  it("at start: no browser is paired, the list says the file cannot be read, pairing is refused", async () => {
    await start();
    await pair();
    await writeFile(cfg("extension-pairings.json"), "garbage{");
    await start();
    const l = await call({ url: "/extension/pairings" });
    expect(l.status).toBe(200);
    expect(l.json).toMatchObject({ extensions: [], unreadable: true });
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    expect(c.statusCode).toBe(503);
    expect(c.json().error.reason).toBe("extension-pairings");
    expect(await readFile(cfg("extension-pairings.json"), "utf8")).toBe("garbage{");
  });

  it("a passing read error heals: once the file reads again, the list takes it up", async () => {
    await start();
    await pair();
    const saved = await readFile(cfg("extension-pairings.json"), "utf8");
    await rm(cfg("extension-pairings.json"));
    await mkdir(cfg("extension-pairings.json"));
    await start();
    expect((await call({ url: "/extension/pairings" })).json.unreadable).toBe(true);
    await rm(cfg("extension-pairings.json"), { recursive: true });
    await writeFile(cfg("extension-pairings.json"), saved);
    const l = await call({ url: "/extension/pairings" });
    expect(l.json.unreadable).toBeUndefined();
    expect(l.json.extensions).toHaveLength(1);
  });

  it("nothing is said while the file can be read", async () => {
    await start();
    await pair();
    expect((await call({ url: "/extension/pairings" })).json.unreadable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The reset

describe("POST /settings/reset (Task 68)", () => {
  const files = [
    {
      file: "extension-pairings",
      name: "extension-pairings.json",
      prepare: async () => void (await pair()),
      works: async () => {
        expect((await call({ url: "/extension/pairings" })).json).toMatchObject({ extensions: [] });
        expect((await call({ url: "/extension/pairings" })).json.unreadable).toBeUndefined();
        expect(await pair()).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        expect((await call({ url: "/extension/pairings" })).json.extensions).toHaveLength(1);
      },
    },
    {
      file: "fonts",
      name: "fonts.json",
      prepare: async () => void (await addFont("Alpha")),
      works: async () => {
        expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [] });
        expect((await addFont("Beta")).status).toBe(200);
        // The kept copy of the font from before stays in the fonts folder (not deleted by the reset).
        expect((await readdir(cfg("fonts"))).length).toBe(2);
      },
    },
    {
      file: "appearance",
      name: "appearance.json",
      prepare: async () => void (await call({ method: "PUT", url: "/settings/appearance", body: { theme: "dark" } })),
      works: async () => {
        expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "system" });
        expect((await call({ method: "PUT", url: "/settings/appearance", body: { density: "compact" } })).status).toBe(200);
      },
    },
  ] as const;

  for (const f of files) {
    it(`${f.file}: refused without confirmation and while the file can be read; with it, the damaged file is kept aside and the feature works again`, async () => {
      await start();
      await f.prepare();
      // Readable: nothing to reset.
      const readable = await call({ method: "POST", url: "/settings/reset", body: { file: f.file, confirm: true } });
      expect(readable.status).toBe(409);
      await writeFile(cfg(f.name), "garbage{");
      // No confirmation: refused, nothing changed.
      for (const body of [{ file: f.file }, { file: f.file, confirm: "yes" }, { file: f.file, confirm: false }]) {
        expect((await call({ method: "POST", url: "/settings/reset", body })).status).toBe(400);
      }
      expect(await readFile(cfg(f.name), "utf8")).toBe("garbage{");
      const r = await call({ method: "POST", url: "/settings/reset", body: { file: f.file, confirm: true } });
      expect(r.status, r.body).toBe(200);
      expect(r.json.reset).toBe(true);
      expect(r.json.keptAs).toMatch(new RegExp(`^${f.name.replace(".", "\\.")}\\.unreadable-\\d{8}-\\d{6}(-\\d+)?$`));
      expect(r.body).not.toContain(tmp);
      // Kept aside, not destroyed.
      expect(await readFile(cfg(r.json.keptAs as string), "utf8")).toBe("garbage{");
      await f.works();
    });
  }

  it("only the desktop app: the extension's token is refused, so is no token, a wrong Host or a foreign Origin", async () => {
    await start();
    const ext = await pair();
    await writeFile(cfg("appearance.json"), "garbage{");
    const body = JSON.stringify({ file: "appearance", confirm: true });
    const send = (headers: Record<string, string>) => svc!.app.inject({ method: "POST", url: "/settings/reset", headers: { "content-type": "application/json", ...headers }, payload: body });
    expect((await send({ authorization: `Bearer ${ext}`, origin: EXT })).statusCode).toBe(403);
    expect((await send({ authorization: `Bearer ${ext}` })).statusCode).toBe(403);
    expect((await send({})).statusCode).toBe(401);
    expect((await send({ ...ui, host: "evil.example" })).statusCode).toBe(403);
    expect((await send({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).statusCode).toBe(403);
    expect(await readFile(cfg("appearance.json"), "utf8")).toBe("garbage{");
  });

  it("a reset of a file that is not there says so truthfully (review round 1, M7)", async () => {
    await start();
    const r = await call({ method: "POST", url: "/settings/reset", body: { file: "appearance", confirm: true } });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("The appearance settings are not there, so there is nothing to reset.");
    await writeFile(cfg("fonts.json"), JSON.stringify({ fonts: [] }));
    expect((await call({ method: "POST", url: "/settings/reset", body: { file: "fonts", confirm: true } })).json.error.message).toBe("The list of added fonts can be read, so nothing was reset.");
  });

  it("an unknown file name or another field is refused", async () => {
    await start();
    expect((await call({ method: "POST", url: "/settings/reset", body: { file: "libraries", confirm: true } })).status).toBe(400);
    expect((await call({ method: "POST", url: "/settings/reset", body: { file: "../x", confirm: true } })).status).toBe(400);
    expect((await call({ method: "POST", url: "/settings/reset", body: { file: "fonts", confirm: true, also: 1 } })).status).toBe(400);
  });
});
