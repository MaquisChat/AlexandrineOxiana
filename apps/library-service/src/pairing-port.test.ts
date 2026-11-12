/**
 * A pairing across a relaunch (R171, defect D13): the token stays valid whatever the port; each
 * pairing keeps the port its browser last reached the service on, and `GET /extension/pairings`
 * says the service's port now, so the desktop app can tell "the port changed since this browser was
 * paired" without a new route.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import type { PairedBrowsers } from "@ao/shared";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const APP = "http://tauri.localhost";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let logs = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-pair-port-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});

afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(tmp, { recursive: true, force: true });
});

/** A service on this settings folder, listening on `port` (0: any). */
async function launch(port = 0): Promise<number> {
  await svc?.close();
  logs = "";
  const logStream = new Writable({
    write(chunk, _e, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, worker: null, logStream });
  return svc.listen(port);
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const ui = { authorization: `Bearer ${TOKEN}`, origin: APP };

async function pairOn(port: number, origin = EXT): Promise<string> {
  const code = (await (await fetch(`http://127.0.0.1:${port}/extension/pair`, { method: "POST", headers: ui })).json()) as { code: string };
  const r = await fetch(`http://127.0.0.1:${port}/extension/pair/confirm`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

async function listed(port: number): Promise<PairedBrowsers> {
  const r = await fetch(`http://127.0.0.1:${port}/extension/pairings`, { headers: ui });
  expect(r.status).toBe(200);
  return (await r.json()) as PairedBrowsers;
}

/** The extension's own check: GET /projects with its token and no Origin (Chrome omits it, R111). */
const projects = (port: number, token: string) => fetch(`http://127.0.0.1:${port}/projects`, { headers: { authorization: `Bearer ${token}` } });
/** The token was accepted: the answer is the list, or, with no library open, 503 LIBRARY_OFFLINE (asked after the token check). */
async function accepted(r: Response): Promise<boolean> {
  if (r.status === 200) return true;
  const body = (await r.json()) as { error?: { code?: string } };
  return r.status === 503 && body.error?.code === "LIBRARY_OFFLINE";
}

describe("pairings and the service's port (R171)", () => {
  it("a pairing keeps the port it was made on, and the list says the service's port now", async () => {
    const port = await launch();
    const token = await pairOn(port);
    const l = await listed(port);
    expect(l.port).toBe(port);
    expect(l.extensions).toHaveLength(1);
    expect(l.extensions[0]!.port).toBe(port);
    expect(l.extensions[0]!.origin).toBe(EXT);
    // Never the token, nor its hash.
    expect(JSON.stringify(l)).not.toContain(token);
    expect(JSON.stringify(l)).not.toMatch(/tokenSha256/);
  });

  it("after a relaunch on the same port, the pairing works without any action and nothing differs", async () => {
    const port = await launch();
    const token = await pairOn(port);
    await launch(port);
    expect(await accepted(await projects(port, token))).toBe(true);
    const l = await listed(port);
    expect(l.port).toBe(port);
    expect(l.extensions[0]!.port).toBe(port);
  });

  it("after a relaunch on another port: the list shows the difference; the same token works on the new port, and then the pairing carries the new port, durably", async () => {
    const first = await launch();
    const token = await pairOn(first);
    const second = await launch(await freePort());
    expect(second).not.toBe(first);
    let l = await listed(second);
    expect(l.port).toBe(second);
    expect(l.extensions[0]!.port).toBe(first);
    // The token stays valid: the extension, given the new port, is answered.
    expect(await accepted(await projects(second, token))).toBe(true);
    l = await listed(second);
    expect(l.extensions[0]!.port).toBe(second);
    // Kept in the pairings file (only the hash of the token there, as before).
    const file = JSON.parse(await readFile(join(deps.appConfigDir, "extension-pairings.json"), "utf8")) as { extensions: Array<{ port?: number; tokenSha256: string }> };
    expect(file.extensions[0]!.port).toBe(second);
    expect(JSON.stringify(file)).not.toContain(token);
    const third = await launch(second);
    expect((await listed(third)).extensions[0]!.port).toBe(second);
  });

  it("a request that is refused (wrong token, or another origin) does not change the pairing's port", async () => {
    const first = await launch();
    const token = await pairOn(first);
    const second = await launch(await freePort());
    expect((await fetch(`http://127.0.0.1:${second}/projects`, { headers: { authorization: "Bearer not-the-token-0123456789abcdefghijkl" } })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${second}/projects`, { headers: { authorization: `Bearer ${token}`, origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${second}/libraries`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await listed(second)).extensions[0]!.port).toBe(first);
  });

  it("a pairing saved before ports were kept is listed without a port, and gains one when its browser next reaches the service", async () => {
    const port = await launch();
    const token = await pairOn(port);
    const file = join(deps.appConfigDir, "extension-pairings.json");
    const f = JSON.parse(await readFile(file, "utf8")) as { extensions: Array<Record<string, unknown>> };
    delete f.extensions[0]!.port;
    await writeFile(file, JSON.stringify(f));
    await launch(port);
    expect((await listed(port)).extensions[0]!.port).toBeUndefined();
    expect(await accepted(await projects(port, token))).toBe(true);
    expect((await listed(port)).extensions[0]!.port).toBe(port);
  });

  it("a pairings file that cannot be written does not fail the browser's request; the log says so without a path", async () => {
    const first = await launch();
    const token = await pairOn(first);
    const second = await launch(await freePort());
    const file = join(deps.appConfigDir, "extension-pairings.json");
    const saved = await readFile(file, "utf8");
    // Replace the file by a folder: it cannot be replaced atomically any more (works as root too).
    await rm(file);
    await mkdir(file);
    expect(await accepted(await projects(second, token))).toBe(true);
    expect(logs).toMatch(/port .*could not be saved/i);
    expect(logs).not.toContain(tmp);
    await rm(file, { recursive: true });
    await writeFile(file, saved);
  });

  it("a wrong Host (forged, or the old port) is refused and does not change the pairing's port (review M7)", async () => {
    const first = await launch();
    const token = await pairOn(first);
    const second = await launch(await freePort());
    for (const host of ["evil.example", `127.0.0.1:${first}`]) {
      const r = await svc!.app.inject({ method: "GET", url: "/projects", headers: { host, authorization: `Bearer ${token}` } });
      expect(r.statusCode, host).toBe(403);
    }
    expect((await listed(second)).extensions[0]!.port).toBe(first);
  });
});

describe("recording a port never writes what it did not read (fix round 1, I1)", () => {
  const OTHER = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const file = () => join(deps.appConfigDir, "extension-pairings.json");

  /** Two paired browsers, then a relaunch on another port: both hold the old port. */
  async function twoBrowsersOnAnOldPort(): Promise<{ first: number; second: number; a: string; b: string; saved: string }> {
    const first = await launch();
    const a = await pairOn(first);
    const b = await pairOn(first, OTHER);
    const second = await launch(await freePort());
    return { first, second, a, b, saved: await readFile(file(), "utf8") };
  }

  const breakers: Array<[string, () => Promise<void>]> = [
    ["invalid JSON", () => writeFile(file(), "garbage{")],
    ["a truncated file", async () => writeFile(file(), (await readFile(file(), "utf8")).slice(0, 40))],
    ["a directory in its place", async () => (await rm(file()), mkdir(file()))],
    ["a link that cannot be followed (stands in for a read refused by permissions)", async () => (await rm(file()), symlink(file(), file()))],
    ["the wrong shape", () => writeFile(file(), JSON.stringify({ v: 1, extensions: "no" }))],
  ];

  for (const [what, breakFile] of breakers) {
    it(`the pairings file unreadable at the moment of the save (${what}): nothing is written, nothing is lost, the request is answered; a later save works`, async () => {
      const { first, second, a, b, saved } = await twoBrowsersOnAnOldPort();
      await breakFile();
      const brokenStat = await lstat(file());
      const brokenBytes = brokenStat.isFile() ? await readFile(file(), "utf8") : undefined;
      expect(await accepted(await projects(second, a))).toBe(true);
      // On disk: exactly what was there (not an empty list); in memory: both pairings, unchanged.
      const after = await lstat(file());
      expect(after.ino).toBe(brokenStat.ino);
      if (brokenBytes !== undefined) expect(await readFile(file(), "utf8")).toBe(brokenBytes);
      const l = await listed(second);
      expect(l.extensions.map((e) => [e.origin, e.port])).toEqual([
        [EXT, first],
        [OTHER, first],
      ]);
      // Both browsers still get in.
      expect(await accepted(await projects(second, b))).toBe(true);
      expect(await accepted(await projects(second, a))).toBe(true);
      // The file readable again: the next accepted request records the port.
      await rm(file(), { recursive: true, force: true });
      await writeFile(file(), saved);
      expect(await accepted(await projects(second, a))).toBe(true);
      const disk = JSON.parse(await readFile(file(), "utf8")) as { extensions: Array<{ origin: string; port?: number; tokenSha256: string }> };
      expect(disk.extensions.map((e) => [e.origin, e.port])).toEqual([
        [EXT, second],
        [OTHER, first],
      ]);
      // No other field changed.
      const before = JSON.parse(saved) as { extensions: Array<Record<string, unknown>> };
      expect(disk.extensions.map(({ port: _p, ...e }) => e)).toEqual(before.extensions.map(({ port: _p, ...e }) => e));
    });
  }

  it("two browsers recording at once: both ports recorded, both pairings kept", async () => {
    const { first, second, a, b } = await twoBrowsersOnAnOldPort();
    const rs = await Promise.all([projects(second, a), projects(second, b), projects(second, a), projects(second, b)]);
    for (const r of rs) expect(await accepted(r)).toBe(true);
    const disk = JSON.parse(await readFile(file(), "utf8")) as { extensions: Array<{ origin: string; port?: number }> };
    expect(disk.extensions.map((e) => [e.origin, e.port])).toEqual([
      [EXT, second],
      [OTHER, second],
    ]);
    expect((await listed(second)).extensions.map((e) => e.port)).toEqual([second, second]);
    expect(first).not.toBe(second);
  });

  it("pairing a browser while the pairings file is unreadable fails without wiping the others", async () => {
    const { second, b } = await twoBrowsersOnAnOldPort();
    await writeFile(file(), "garbage{");
    const code = (await (await fetch(`http://127.0.0.1:${second}/extension/pair`, { method: "POST", headers: ui })).json()) as { code: string };
    const r = await fetch(`http://127.0.0.1:${second}/extension/pair/confirm`, { method: "POST", headers: { origin: "chrome-extension://cccccccccccccccccccccccccccccccc", "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    expect(r.status).toBe(503);
    expect(await readFile(file(), "utf8")).toBe("garbage{");
    expect((await listed(second)).extensions).toHaveLength(2);
    expect(await accepted(await projects(second, b))).toBe(true);
  });

  it("unpairing while the pairings file is unreadable fails without wiping the others", async () => {
    const { second, b } = await twoBrowsersOnAnOldPort();
    const id = (await listed(second)).extensions[0]!.id;
    await writeFile(file(), "garbage{");
    const r = await fetch(`http://127.0.0.1:${second}/extension/pairings/${id}`, { method: "DELETE", headers: ui });
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain(tmp);
    expect(await readFile(file(), "utf8")).toBe("garbage{");
    expect((await listed(second)).extensions).toHaveLength(2);
    expect(await accepted(await projects(second, b))).toBe(true);
  });
});
