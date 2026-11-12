/**
 * Task 57: the routes the import wizard and the appearance settings lacked — the Zotero Web key in
 * the system password store (R78), where the Zotero data folder is, and a typeface from the
 * researcher's own file (R100). The review queue's preview reuses Task 34a's picture route.
 *
 * These are this device's settings, not library changes: they need no open library, and so no
 * project lock or read-only library applies to them (both cases are shown to make no difference).
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix as posixPath, win32 as winPath } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { USER_FONTS_MAX, USER_FONT_MAX_BYTES } from "@ao/shared";
import { useMemorySecrets, useNoSecretStore } from "../../../packages/library/src/secrets-testing.js";
import { readSmallRegularFile } from "./routes/safe-file.js";
import { dataDirFromPrefs, findZoteroDataFolders, localDataDir } from "./routes/zotero.js";
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
  expect((await call({ ...r, headers: { ...r.headers, host: "evil.example" } })).status, "wrong Host").toBe(403);
  expect((await call({ ...r, headers: { ...r.headers, host: "attacker.test:8080" } })).status, "wrong Host and port").toBe(403);
  const ext = await extensionToken();
  expect((await call({ ...r, noAuth: true, headers: { ...r.headers, authorization: `Bearer ${ext}`, origin: EXT } })).status, "extension token").toBe(403);
}

/** Resolves with the promise, or rejects when it has not settled within `ms` (a hang detector). */
async function promptly<T>(p: Promise<T>, ms = 5000): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(t);
  }
}

const IS_WINDOWS = process.platform === "win32";
/** A named pipe (FIFO) at `p`: opening it for reading blocks until a writer comes. */
const mkfifo = (p: string) => execFileSync("mkfifo", [p]);
/** Lets a reader blocked on the FIFO go (a test that failed must not leave a file thread held). */
function releaseFifo(p: string): void {
  try {
    closeSync(openSync(p, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
  } catch {
    // nobody is reading it
  }
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

  it.skipIf(IS_WINDOWS)("a pipe or a link in place of prefs.js is refused at once (M4)", async () => {
    const home = join(tmp, "home");
    const viaPipe = join(tmp, "via-pipe");
    await db(viaPipe);
    const p1 = join(home, ".zotero", "zotero", "p1.default");
    await mkdir(p1, { recursive: true });
    mkfifo(join(p1, "prefs.js"));
    const viaLink = join(tmp, "via-link");
    await db(viaLink);
    const elsewhere = join(tmp, "elsewhere-prefs.js");
    await writeFile(elsewhere, [`user_pref("extensions.zotero.dataDir", ${JSON.stringify(viaLink)});`, 'user_pref("extensions.zotero.useDataDir", true);'].join("\n"));
    const p2 = join(home, ".zotero", "zotero", "p2.default");
    await mkdir(p2, { recursive: true });
    await symlink(elsewhere, join(p2, "prefs.js"));
    try {
      expect(await promptly(findZoteroDataFolders({ platform: "linux", home, env: {} }))).toEqual([]);
    } finally {
      releaseFifo(join(p1, "prefs.js"));
    }
  });

  it.skipIf(IS_WINDOWS)("a small file is read only through one handle that never waits and never follows a link (M4)", async () => {
    const fifo = join(tmp, "pipe");
    mkfifo(fifo);
    const file = join(tmp, "small.js");
    await writeFile(file, "hello");
    const link = join(tmp, "link.js");
    await symlink(file, link);
    try {
      expect(await promptly(readSmallRegularFile(fifo, 1024))).toBeNull();
    } finally {
      releaseFifo(fifo);
    }
    expect(await readSmallRegularFile(link, 1024)).toBeNull();
    expect(await readSmallRegularFile(tmp, 1024)).toBeNull(); // a folder
    expect(await readSmallRegularFile(join(tmp, "missing"), 1024)).toBeNull();
    expect(await readSmallRegularFile(file, 4)).toBeNull(); // larger than the limit
    expect(await readSmallRegularFile(file, 5)).toBe("hello");
  });

  it("when prefs.js repeats a setting, the last one counts, as in Zotero itself (M3)", async () => {
    const pref = (k: string, v: unknown) => `user_pref("extensions.zotero.${k}", ${JSON.stringify(v)});`;
    expect(dataDirFromPrefs([pref("dataDir", "/first"), pref("dataDir", "/second"), pref("useDataDir", true)].join("\n"), posixPath)).toBe("/second");
    expect(dataDirFromPrefs([pref("dataDir", "/d"), pref("useDataDir", true), pref("useDataDir", false)].join("\n"), posixPath)).toBeNull();
    expect(dataDirFromPrefs([pref("dataDir", "/d"), pref("useDataDir", false), pref("useDataDir", true)].join("\n"), posixPath)).toBe("/d");
  });

  it("only an absolute local path is followed, normalised; network and device paths never touch the disk (M2)", () => {
    // Windows, decided with Windows path rules on any system.
    for (const bad of [
      "\\\\server\\share\\Zotero",
      "//server/share/Zotero",
      "\\\\?\\C:\\Zotero",
      "\\\\?\\UNC\\server\\share",
      "\\\\.\\pipe\\zotero",
      "//./C:/Zotero",
      "//?/C:/Zotero",
      "\\Zotero", // the root of whichever drive is current
      "C:Zotero", // relative to the drive's current folder
      "Zotero",
      "",
      "C:\\Zo\u0000tero",
    ]) expect(localDataDir(bad, winPath), JSON.stringify(bad)).toBeNull();
    expect(localDataDir("C:\\Users\\u\\..\\v\\Zotero", winPath)).toBe("C:\\Users\\v\\Zotero");
    expect(localDataDir("d:/Data/Zotero/", winPath)).toBe("d:\\Data\\Zotero");
    // POSIX.
    expect(localDataDir("/home/u/../../etc", posixPath)).toBe("/etc");
    expect(localDataDir("/home/u/Zotero/", posixPath)).toBe("/home/u/Zotero");
    expect(localDataDir("//server/share", posixPath)).toBeNull();
    for (const bad of ["relative/dir", "~/Zotero", "", "/a\u0000b"]) expect(localDataDir(bad, posixPath), JSON.stringify(bad)).toBeNull();
    // And through prefs.js.
    const prefsText = (v: string) => `user_pref("extensions.zotero.dataDir", ${JSON.stringify(v)});\nuser_pref("extensions.zotero.useDataDir", true);`;
    expect(dataDirFromPrefs(prefsText("\\\\server\\share\\Zotero"), winPath)).toBeNull();
    expect(dataDirFromPrefs(prefsText("C:\\Users\\u\\Zotero"), winPath)).toBe("C:\\Users\\u\\Zotero");
    expect(dataDirFromPrefs(prefsText("/home/u/../v/Zotero"), posixPath)).toBe("/home/v/Zotero");
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

  it.skipIf(IS_WINDOWS)("a pipe given as the font file is refused at once, as not a file (M1)", async () => {
    const fifo = join(tmp, "pipe.ttf");
    mkfifo(fifo);
    try {
      const r = await promptly(call({ method: "POST", url: "/settings/fonts", body: { path: fifo } }));
      expect(r.status).toBe(400);
      expect(r.json.error.message).toBe("That is not a file. Choose the font file itself.");
      expect(r.body).not.toContain(tmp);
    } finally {
      releaseFifo(fifo);
    }
    expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [] });
  });

  it("refuses CSS keywords, generic families and bundled faces as a font's name, in any case (M5)", async () => {
    const p = await fontFile("ok.woff2", fontBytes("wOF2"));
    for (const name of ["inherit", "Initial", "UNSET", "revert", "revert-layer", "default", "serif", "Sans-Serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "Sorts Mill Goudy", "atkinson hyperlegible", "OPENDYSLEXIC"]) {
      const r = await call({ method: "POST", url: "/settings/fonts", body: { path: p, name } });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
      expect(r.json.error.message, name).toMatch(/name/i);
      expect(r.json.error.message).not.toMatch(/\/|\\/);
    }
    // A file named after one is refused too, unless the researcher gives it another name.
    const named = await fontFile("Serif.woff2", fontBytes("wOF2", 2100));
    const r = await call({ method: "POST", url: "/settings/fonts", body: { path: named } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Give the font a name/);
    expect((await call({ url: "/settings/fonts" })).json).toEqual({ fonts: [] });
    expect((await call({ method: "POST", url: "/settings/fonts", body: { path: named, name: "Serif Pro" } })).status).toBe(200);
  });

  it("adding the same file again without a name keeps the name the researcher chose (M7)", async () => {
    const data = fontBytes("OTTO");
    const first = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("file-name.otf", data), name: "Chosen" } });
    expect(first.json.name).toBe("Chosen");
    const again = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("file-name.otf", data) } });
    expect(again.status, again.body).toBe(200);
    expect(again.json).toMatchObject({ id: first.json.id, name: "Chosen" });
    expect((await call({ url: "/settings/fonts" })).json.fonts).toEqual([expect.objectContaining({ name: "Chosen" })]);
    // A name sent with it still replaces it.
    expect((await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile("file-name.otf", data), name: "Renamed" } })).json.name).toBe("Renamed");
  });

  it("adding and removing the same file at once never leave an entry without its file, or a file without its entry (M6)", async () => {
    const data = fontBytes("wOFF", 4096);
    const p = await fontFile("race.woff", data);
    const keptDir = join(deps.appConfigDir, "fonts");
    const add = () => call({ method: "POST", url: "/settings/fonts", body: { path: p } });
    const id = (await add()).json.id as string;
    const remove = () => call({ method: "DELETE", url: `/settings/fonts/${id}` });
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const later = async <T>(n: number, f: () => Promise<T>) => {
      for (let i = 0; i < n; i++) await tick();
      return f();
    };
    for (let round = 0; round < 24; round++) {
      // Make sure it is there, then race a remove against another add, with varied head starts.
      await add();
      const n = round % 6;
      await Promise.all(round % 2 ? [later(n, add), remove()] : [add(), later(n, remove)]);
      const listed = ((await call({ url: "/settings/fonts" })).json.fonts as Array<{ id: string }>).map((f) => f.id);
      const files = (await readdir(keptDir)).filter((f) => !f.startsWith(".")).map((f) => f.split(".")[0]);
      expect(files.sort(), `round ${round}: the files kept are those listed`).toEqual(listed.sort());
      if (listed.includes(id)) expect((await call({ url: `/settings/fonts/${id}` })).status, `round ${round}`).toBe(200);
    }
  });

  it("adds at once cannot keep more fonts than the limit (M6)", async () => {
    for (let i = 0; i < USER_FONTS_MAX - 1; i++) {
      const r = await call({ method: "POST", url: "/settings/fonts", body: { path: await fontFile(`f${i}.woff2`, fontBytes("wOF2", 1000 + i)) } });
      expect(r.status, r.body).toBe(200);
    }
    const paths = await Promise.all([0, 1, 2, 3, 4].map((i) => fontFile(`late${i}.woff2`, fontBytes("wOF2", 5000 + i))));
    const answers = await Promise.all(paths.map((path) => call({ method: "POST", url: "/settings/fonts", body: { path } })));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 409)).toHaveLength(4);
    expect((await call({ url: "/settings/fonts" })).json.fonts).toHaveLength(USER_FONTS_MAX);
    expect((await readdir(join(deps.appConfigDir, "fonts"))).filter((f) => !f.startsWith("."))).toHaveLength(USER_FONTS_MAX);
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
