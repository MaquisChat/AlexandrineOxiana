/**
 * Task 57: the routes the import wizard and the appearance settings lacked — the Zotero Web key in
 * the system password store (R78), where the Zotero data folder is, and a typeface from the
 * researcher's own file (R100). The review queue's preview reuses Task 34a's picture route.
 *
 * These are this device's settings, not library changes: they need no open library, and so no
 * project lock or read-only library applies to them (both cases are shown to make no difference).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { USER_FONT_MAX_BYTES } from "@ao/shared";
import { useMemorySecrets, useNoSecretStore } from "../../../packages/library/src/secrets-testing.js";
import { findZoteroDataFolders } from "./routes/zotero.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const KEY = "Zk7Qp2Lm9Xc4Vb8Nn1Rt6Yw3";

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService;

async function start(): Promise<void> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null });
}

type Inject = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean };
async function call(r: Inject) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...(r.noAuth ? {} : auth), ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body, raw: res.rawPayload, headers: res.headers };
}

async function extensionToken(): Promise<string> {
  const code = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
  return c.json().token as string;
}

/** Every way in that must be refused, for one route. */
async function expectGuarded(r: Inject): Promise<void> {
  expect((await call({ ...r, noAuth: true })).status, "no token").toBe(401);
  expect((await call({ ...r, headers: { ...r.headers, authorization: "Bearer wrong-token-wrong-token-wrong-token" } })).status, "wrong token").toBe(401);
  expect((await call({ ...r, headers: { ...r.headers, origin: "https://evil.example" } })).status, "foreign origin").toBe(403);
  expect((await call({ ...r, headers: { ...r.headers, origin: "http://127.0.0.1:5173" } })).status, "a page on this computer").toBe(403);
  const ext = await extensionToken();
  expect((await call({ ...r, noAuth: true, headers: { ...r.headers, authorization: `Bearer ${ext}`, origin: EXT } })).status, "extension token").toBe(403);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-t57-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------
describe("the Zotero Web key (R78)", () => {
  let secrets: ReturnType<typeof useMemorySecrets>;
  beforeEach(async () => {
    secrets = useMemorySecrets();
    await start();
  });
  afterEach(() => secrets.restore());

  it("is stored in the password store, never sent back, and can be removed", async () => {
    expect((await call({ url: "/secrets/zotero-api-key" })).json).toEqual({ stored: false });
    const put = await call({ method: "PUT", url: "/secrets/zotero-api-key", body: { apiKey: KEY } });
    expect(put.status, put.body).toBe(200);
    expect(put.json).toEqual({ stored: true });
    expect(secrets.values.get("zotero-api-key")).toBe(KEY);
    const got = await call({ url: "/secrets/zotero-api-key" });
    expect(got.json).toEqual({ stored: true });
    expect(got.body).not.toContain(KEY);
    // Replaced, not added to.
    await call({ method: "PUT", url: "/secrets/zotero-api-key", body: { apiKey: "A".repeat(24) } });
    expect(secrets.values.get("zotero-api-key")).toBe("A".repeat(24));
    const del = await call({ method: "DELETE", url: "/secrets/zotero-api-key" });
    expect(del.json).toEqual({ removed: true });
    expect(secrets.values.has("zotero-api-key")).toBe(false);
    expect((await call({ method: "DELETE", url: "/secrets/zotero-api-key" })).json).toEqual({ removed: false });
    expect((await call({ url: "/secrets/zotero-api-key" })).json).toEqual({ stored: false });
    // Nowhere in the device's settings folder, nor in any log line.
    for (const f of await readdir(deps.appConfigDir)) {
      const p = join(deps.appConfigDir, f);
      if ((await stat(p)).isFile()) expect(await readFile(p, "utf8"), f).not.toContain(KEY);
    }
    expect(logs).not.toContain(KEY);
  });

  it("refuses what is not a key, without echoing it, and stores nothing", async () => {
    for (const bad of [undefined, "", "short", "has spaces in it here", `${KEY}\n`, "x".repeat(65), 42]) {
      const r = await call({ method: "PUT", url: "/secrets/zotero-api-key", body: bad === undefined ? {} : { apiKey: bad } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
      if (typeof bad === "string" && bad) expect(r.body).not.toContain(bad.trim());
    }
    // Other fields are refused too (a typo never leaves the key unread and something else stored).
    expect((await call({ method: "PUT", url: "/secrets/zotero-api-key", body: { apiKey: KEY, extra: 1 } })).status).toBe(400);
    expect(secrets.values.size).toBe(0);
    expect(logs).not.toContain("has spaces in it here");
  });

  it("only the desktop app reaches it, and a key never goes in an address", async () => {
    await expectGuarded({ url: "/secrets/zotero-api-key" });
    await expectGuarded({ method: "PUT", url: "/secrets/zotero-api-key", body: { apiKey: KEY } });
    await expectGuarded({ method: "DELETE", url: "/secrets/zotero-api-key" });
    expect(secrets.values.size).toBe(0);
    // A key in the query string is refused before anything else (R96).
    const q = await call({ method: "PUT", url: `/secrets/zotero-api-key?apiKey=${KEY}`, body: { apiKey: KEY } });
    expect(q.status).toBe(401);
    expect(q.body).not.toContain(KEY);
    expect(secrets.values.size).toBe(0);
    expect(logs).not.toContain(KEY);
  });

  it("needs no open library: a locked project or a read-only library makes no difference", async () => {
    // No library is open in this service at all, and the routes still answer.
    expect((await call({ url: "/libraries" })).status).toBe(200);
    expect((await call({ method: "PUT", url: "/secrets/zotero-api-key", body: { apiKey: KEY } })).json).toEqual({ stored: true });
  });
});

describe("the Zotero Web key on a computer without a password store", () => {
  let none: ReturnType<typeof useNoSecretStore>;
  beforeEach(async () => {
    none = useNoSecretStore();
    await start();
  });
  afterEach(() => none.restore());

  it("says so in plain words and stores nothing anywhere else", async () => {
    const put = await call({ method: "PUT", url: "/secrets/zotero-api-key", body: { apiKey: KEY } });
    expect(put.status).toBe(503);
    expect(put.json.error.code).toBe("UNAVAILABLE");
    expect(put.json.error.message).toMatch(/password store|keychain|credential/i);
    expect(put.json.error.message).toMatch(/not saved/i);
    expect(put.body).not.toContain(KEY);
    const get = await call({ url: "/secrets/zotero-api-key" });
    expect(get.status).toBe(503);
    expect(get.json.error.message).toMatch(/password store|keychain|credential/i);
    expect(get.json.error.message).not.toMatch(/not saved/i);
    expect((await call({ method: "DELETE", url: "/secrets/zotero-api-key" })).status).toBe(503);
    for (const f of await readdir(deps.appConfigDir).catch(() => [])) {
      const p = join(deps.appConfigDir, f);
      if ((await stat(p)).isFile()) expect(await readFile(p, "utf8"), f).not.toContain(KEY);
    }
    expect(logs).not.toContain(KEY);
  });
});

// ------------------------------------------------------------------------------------------------
describe("where the Zotero data folder is", () => {
  const db = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "zotero.sqlite"), "SQLite format 3\u0000");
  };
  const prefs = async (profile: string, lines: string[]) => {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "prefs.js"), lines.join("\n"));
  };

  it("Linux: ~/Zotero, and the folder Zotero's own setting names", async () => {
    const home = join(tmp, "home");
    await db(join(home, "Zotero"));
    const moved = join(tmp, "elsewhere", "My \"Zotero\" data");
    await db(moved);
    await prefs(join(home, ".zotero", "zotero", "abcd.default"), [
      "// Mozilla User Preferences",
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(moved)});`,
      'user_pref("extensions.zotero.useDataDir", true);',
    ]);
    const found = await findZoteroDataFolders({ platform: "linux", home, env: {} });
    expect(found).toEqual([
      { path: moved, from: "zotero-setting" },
      { path: join(home, "Zotero"), from: "usual-place" },
    ]);
  });

  it("macOS and Windows profile places", async () => {
    const home = join(tmp, "home");
    const macMoved = join(tmp, "mac-data");
    await db(macMoved);
    await prefs(join(home, "Library", "Application Support", "Zotero", "Profiles", "x1.default"), [
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(macMoved)});`,
      'user_pref("extensions.zotero.useDataDir", true);',
    ]);
    expect(await findZoteroDataFolders({ platform: "darwin", home, env: {} })).toEqual([{ path: macMoved, from: "zotero-setting" }]);

    const appData = join(tmp, "AppData", "Roaming");
    const winMoved = join(tmp, "win-data");
    await db(winMoved);
    await db(join(home, "Zotero"));
    await prefs(join(appData, "Zotero", "Zotero", "Profiles", "y2.default"), [
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(winMoved)});`,
      'user_pref("extensions.zotero.useDataDir", true);',
    ]);
    expect(await findZoteroDataFolders({ platform: "win32", home, env: { APPDATA: appData } })).toEqual([
      { path: winMoved, from: "zotero-setting" },
      { path: join(home, "Zotero"), from: "usual-place" },
    ]);
  });

  it("offers only folders that hold a Zotero database, and ignores settings it should not follow", async () => {
    const home = join(tmp, "home");
    await mkdir(join(home, "Zotero"), { recursive: true }); // no zotero.sqlite
    const notUsed = join(tmp, "not-used");
    await db(notUsed);
    const relative = "relative/dir";
    await prefs(join(home, ".zotero", "zotero", "p1.default"), [
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(notUsed)});`,
      'user_pref("extensions.zotero.useDataDir", false);', // Zotero itself does not use it
    ]);
    await prefs(join(home, ".zotero", "zotero", "p2.default"), [`user_pref("extensions.zotero.dataDir", ${JSON.stringify(relative)});`, 'user_pref("extensions.zotero.useDataDir", true);']);
    // zotero.sqlite that is a folder, or a link to elsewhere: not recognised.
    const linkDir = join(tmp, "linked");
    await mkdir(join(linkDir, "zotero.sqlite"), { recursive: true });
    await prefs(join(home, ".zotero", "zotero", "p3.default"), [`user_pref("extensions.zotero.dataDir", ${JSON.stringify(linkDir)});`, 'user_pref("extensions.zotero.useDataDir", true);']);
    const linkFile = join(tmp, "linked-file");
    await mkdir(linkFile, { recursive: true });
    await writeFile(join(tmp, "target.sqlite"), "x");
    await symlink(join(tmp, "target.sqlite"), join(linkFile, "zotero.sqlite"));
    await prefs(join(home, ".zotero", "zotero", "p4.default"), [`user_pref("extensions.zotero.dataDir", ${JSON.stringify(linkFile)});`, 'user_pref("extensions.zotero.useDataDir", true);']);
    // A preferences file far larger than any real one is not read.
    const huge = join(tmp, "huge-target");
    await db(huge);
    await prefs(join(home, ".zotero", "zotero", "p5.default"), [`user_pref("extensions.zotero.dataDir", ${JSON.stringify(huge)});`, 'user_pref("extensions.zotero.useDataDir", true);', `// ${"x".repeat(5 * 1024 * 1024)}`]);
    expect(await findZoteroDataFolders({ platform: "linux", home, env: {} })).toEqual([]);
  });

  it("the same folder is offered once", async () => {
    const home = join(tmp, "home");
    await db(join(home, "Zotero"));
    await prefs(join(home, ".zotero", "zotero", "p.default"), [`user_pref("extensions.zotero.dataDir", ${JSON.stringify(join(home, "Zotero"))});`, 'user_pref("extensions.zotero.useDataDir", true);']);
    expect(await findZoteroDataFolders({ platform: "linux", home, env: {} })).toEqual([{ path: join(home, "Zotero"), from: "zotero-setting" }]);
  });

  it("the route lists them for this computer, behind the usual guards", async () => {
    const home = join(tmp, "home");
    await db(join(home, "Zotero"));
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      await start();
      const r = await call({ url: "/import/zotero-data-folders" });
      expect(r.status, r.body).toBe(200);
      if (process.platform === "linux" || process.platform === "darwin") expect(r.json).toEqual({ folders: [{ path: join(home, "Zotero"), from: "usual-place" }] });
      await expectGuarded({ url: "/import/zotero-data-folders" });
    } finally {
      process.env.HOME = was;
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe("a typeface from the researcher's own file (R100)", () => {
  beforeEach(() => start());

  const fontBytes = (tag: string, size = 2048) => {
    const b = Buffer.alloc(size, 7);
    b.write(tag, 0, "latin1");
    return b;
  };
  const fontFile = async (name: string, data: Buffer) => {
    const p = join(tmp, "fonts-in", name);
    await mkdir(join(tmp, "fonts-in"), { recursive: true });
    await writeFile(p, data);
    return p;
  };

  it("is registered, listed, served to the app as bytes, and removed", async () => {
    const data = fontBytes("wOF2");
    const p = await fontFile("Junicode-Regular.woff2", data);
    const add = await call({ method: "POST", url: "/settings/fonts", body: { path: p } });
    expect(add.status, add.body).toBe(200);
    expect(add.json).toMatchObject({ name: "Junicode-Regular", format: "woff2", size: data.length });
    expect(add.json.id).toMatch(/^[0-9a-f]{32}$/);
    expect(add.body).not.toContain(tmp); // the file's path is not kept or sent back
    const id = add.json.id as string;
    expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [add.json] });

    const got = await call({ url: `/settings/fonts/${id}` });
    expect(got.status).toBe(200);
    expect(Buffer.from(got.raw).equals(data)).toBe(true);
    expect(got.headers["content-type"]).toBe("font/woff2");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["cache-control"]).toBe("no-store");
    expect(got.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(got.headers["access-control-allow-origin"]).toBeUndefined();

    // The copy is kept with this device's settings; the original can go.
    await rm(p);
    expect((await call({ url: `/settings/fonts/${id}` })).status).toBe(200);

    // A name of the researcher's choosing; the same file again keeps one entry.
    const again = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("j.woff2", data), name: "Junicode" } });
    expect(again.json).toMatchObject({ id, name: "Junicode" });
    expect((await call({ url: "/settings/fonts" })).json.fonts).toHaveLength(1);

    expect((await call({ method: "DELETE", url: `/settings/fonts/${id}` })).json).toEqual({ removed: true });
    expect((await call({ url: `/settings/fonts/${id}` })).status).toBe(404);
    expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [] });
    expect((await call({ method: "DELETE", url: `/settings/fonts/${id}` })).status).toBe(404);
  });

  it("takes TrueType, OpenType and WOFF too", async () => {
    for (const [tag, format, ext] of [["\u0000\u0001\u0000\u0000", "ttf", "ttf"], ["true", "ttf", "ttf"], ["OTTO", "otf", "otf"], ["wOFF", "woff", "woff"]] as const) {
      const r = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile(`F${format}${tag.charCodeAt(0)}.${ext}`, fontBytes(tag, 1000 + tag.charCodeAt(0))) } });
      expect(r.status, r.body).toBe(200);
      expect(r.json.format).toBe(format);
    }
  });

  it("refuses what is not a font file, or too large, or not a file, in plain words", async () => {
    const cases: Array<[unknown, number]> = [
      [{}, 400],
      [{ path: "relative/font.ttf" }, 400],
      [{ path: join(tmp, "missing.ttf") }, 400],
      [{ path: tmp }, 400], // a folder
      [{ path: await fontFile("doc.ttf", Buffer.from("%PDF-1.7 not a font")) }, 400],
      [{ path: await fontFile("coll.ttc", fontBytes("ttcf")) }, 400],
      [{ path: await fontFile("empty.ttf", Buffer.alloc(0)) }, 400],
      [{ path: await fontFile("big.woff2", fontBytes("wOF2", USER_FONT_MAX_BYTES + 1)) }, 413],
      [{ path: await fontFile("ok.woff2", fontBytes("wOF2")), name: "Bad; name" }, 400],
      [{ path: await fontFile("ok2.woff2", fontBytes("wOF2")), name: "Two, Families" }, 400],
      [{ path: await fontFile("ok3.woff2", fontBytes("wOF2")), extra: true }, 400],
    ];
    for (const [body, status] of cases) {
      const r = await call({ method: "POST", url: "/settings/fonts", body });
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body).not.toContain(tmp);
      expect(r.json.error.message.length).toBeGreaterThan(10);
    }
    expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [] });
    for (const bad of ["../x", "0123456789ABCDEF0123456789ABCDEF", "nope"]) expect((await call({ url: `/settings/fonts/${encodeURIComponent(bad)}` })).status).toBe(404);
  });

  it("a file that is no longer a font where it is kept is not served", async () => {
    const add = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("a.otf", fontBytes("OTTO")) } });
    const id = add.json.id as string;
    const kept = (await readdir(join(deps.appConfigDir, "fonts"))).find((f) => f.startsWith(id))!;
    await writeFile(join(deps.appConfigDir, "fonts", kept), "<script>alert(1)</script>");
    const r = await call({ url: `/settings/fonts/${id}` });
    expect(r.status).toBe(409);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
  });

  it("only the desktop app reaches the font routes", async () => {
    const add = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("g.woff", fontBytes("wOFF")) } });
    const id = add.json.id as string;
    await expectGuarded({ url: "/settings/fonts" });
    await expectGuarded({ url: `/settings/fonts/${id}` });
    await expectGuarded({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("h.woff", fontBytes("wOFF", 3000)) } });
    await expectGuarded({ method: "DELETE", url: `/settings/fonts/${id}` });
    expect((await call({ url: "/settings/fonts" })).json.fonts).toHaveLength(1);
  });

  it("an appearance choice names the registered font by its id", async () => {
    const add = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("Brill.ttf", fontBytes("true")), name: "Brill" } });
    const put = await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { reading: { family: "Brill", source: "user-file", file: add.json.id, generic: "serif" } } } });
    expect(put.status, put.body).toBe(200);
    expect(put.json.fonts.reading).toEqual({ family: "Brill", source: "user-file", file: add.json.id, generic: "serif" });
  });
});
