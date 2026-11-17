/**
 * R447 c (Task FR-A23): the two routes "Choose a library" asks before a library is open — the suggested folder for a
 * new library, and the free room on the disk under a folder (the path in the body). Behind the token and the Host and
 * Origin checks; not the browser extension's; they create nothing, list nothing and name no path in an error.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceDeps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { "content-type": "application/json" };

/** Every name under `dir`, recursively, sorted. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) out.push(join(e.parentPath, e.name));
  return out.sort();
}

describe("R447: the suggested folder and the free room, for the library chooser", () => {
  let tmp: string;
  let home: string;
  let svc: LibraryService;
  let extToken: string;
  const oldHome = process.env.HOME;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ao-place-svc-"));
    home = join(tmp, "home");
    await mkdir(home);
    // os.homedir() reads HOME on macOS and Linux: the service's home folder is the temporary one.
    process.env.HOME = home;
    svc = await createService({ token: TOKEN, deps: { ...deviceDeps(join(tmp, "config")), settleMs: 0 }, worker: null, logLevel: "silent" });
    const code = await svc.app.inject({ method: "POST", url: "/extension/pair", headers: auth });
    expect(code.statusCode, code.body).toBe(200);
    const confirmed = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, ...json }, payload: JSON.stringify({ code: code.json().code }) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    extToken = confirmed.json().token as string;
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    await svc?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const suggest = (headers: Record<string, string> = auth) => svc.app.inject({ method: "GET", url: "/libraries/suggested-folder", headers });
  const room = (body: unknown, headers: Record<string, string> = auth) => svc.app.inject({ method: "POST", url: "/libraries/folder-room", headers: { ...headers, ...json }, payload: JSON.stringify(body) });

  it("the suggestion: no library open, no Documents: the home folder's; with Documents: Documents'; a used one: ' 2'; nothing created", async () => {
    let before = await tree(home);
    let res = await suggest();
    expect([res.statusCode, res.json()]).toEqual([200, { folder: join(home, "Alexandrine Oxiana") }]);
    expect(await tree(home)).toEqual(before);

    await mkdir(join(home, "Documents", "Alexandrine Oxiana"), { recursive: true });
    await writeFile(join(home, "Documents", "Alexandrine Oxiana", "notes.txt"), "x");
    before = await tree(home);
    res = await suggest();
    expect([res.statusCode, res.json()]).toEqual([200, { folder: join(home, "Documents", "Alexandrine Oxiana 2") }]);
    expect(await tree(home)).toEqual(before);
    await rm(join(home, "Documents"), { recursive: true });
  });

  it("every name taken: an answer with no folder", async () => {
    const base = join(home, "Alexandrine Oxiana");
    for (const n of ["", " 2", " 3", " 4", " 5", " 6", " 7", " 8", " 9"]) {
      await mkdir(`${base}${n}`, { recursive: true });
      await writeFile(join(`${base}${n}`, "x"), "x");
    }
    try {
      const res = await suggest();
      expect([res.statusCode, res.json()]).toEqual([200, {}]);
    } finally {
      for (const n of ["", " 2", " 3", " 4", " 5", " 6", " 7", " 8", " 9"]) await rm(`${base}${n}`, { recursive: true });
    }
  });

  it("the room: a number for a folder that exists and for one that does not yet; nothing created", async () => {
    const before = await tree(home);
    for (const p of [home, join(home, "Research", "New library")]) {
      const res = await room({ path: p });
      expect(res.statusCode, res.body).toBe(200);
      expect(Object.keys(res.json())).toEqual(["freeBytes"]);
      expect(res.json().freeBytes).toBeGreaterThan(0);
    }
    expect(await tree(home)).toEqual(before);
  });

  it("the room refuses a path that is not a full local one, in plain words that name no path", async () => {
    const huge = `/${"a".repeat(5000)}`;
    for (const body of [{ path: "Research/New library" }, { path: 42 }, { path: "" }, {}, { path: huge }, { path: "/a\0b" }]) {
      const res = await room(body);
      expect(res.statusCode, res.body).toBe(400);
      const error = res.json().error as { code: string; message: string };
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toMatch(/^"path" (must be an absolute path|is required \(text\)|is too long)\.$/);
      expect(error.message).not.toMatch(/Research|aaaa/);
    }
  });

  it("the path travels in the body: an address with the path in its query is not read", async () => {
    const res = await svc.app.inject({ method: "POST", url: `/libraries/folder-room?path=${encodeURIComponent(home)}`, headers: { ...auth, ...json }, payload: "{}" });
    expect(res.statusCode).toBe(400);
  });

  it("without the token: refused", async () => {
    expect((await suggest({})).statusCode).toBe(401);
    expect((await room({ path: home }, {})).statusCode).toBe(401);
    expect((await suggest({ authorization: "Bearer not-the-token-0123456789abcdefghijklmnop" })).statusCode).toBe(401);
  });

  it("from a foreign origin or host: refused", async () => {
    expect((await suggest({ ...auth, origin: "https://example.com" })).statusCode).toBe(403);
    expect((await room({ path: home }, { ...auth, host: "evil.example:80" })).statusCode).toBe(403);
  });

  it("the browser extension, paired, with its own token and origin: refused", async () => {
    const ext = { authorization: `Bearer ${extToken}`, origin: EXT };
    for (const res of [await suggest(ext), await room({ path: home }, ext)]) {
      expect([res.statusCode, res.json()]).toEqual([403, { error: { code: "FORBIDDEN", message: "The browser extension cannot use this." } }]);
    }
  });
});
