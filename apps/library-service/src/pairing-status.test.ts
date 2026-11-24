/**
 * A pairing code's status (Task 46c): `GET /extension/pair/status` (the code most recently issued)
 * and `GET /extension/pair/status/:codeId` (the code with that non-secret id, returned when it was
 * issued). Never the code itself; the desktop app's own origin with the UI token only.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";

/** The pairings file write, held open or failed by a test (fix round 1, I1). */
const write = vi.hoisted(() => ({ before: undefined as undefined | (() => Promise<void>), release: undefined as undefined | (() => void), onCall: undefined as undefined | (() => void) }));
vi.mock("@ao/library", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ao/library")>();
  return {
    ...real,
    updateAppSettingStrict: async (...args: Parameters<typeof real.updateAppSettingStrict>) => {
      if (write.before) await write.before();
      const run = real.updateAppSettingStrict(...args);
      // FR-718: called once the write has taken its turn on the file (a write asked for now is queued after it).
      write.onCall?.();
      return run;
    },
  };
});
import type { PairingCodeIssued, PairingCodeStatus } from "@ao/shared";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const APP = "http://tauri.localhost";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_EXT = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ui = { authorization: `Bearer ${TOKEN}`, origin: APP };

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let logs = "";
let now = Date.parse("2026-11-11T10:00:00.000Z");

async function start(over: Partial<ServiceOptions> = {}): Promise<void> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _e, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, worker: null, logStream, pairing: { confirmPerMinute: 100, now: () => now }, ...over });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-pair-status-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  now = Date.parse("2026-11-11T10:00:00.000Z");
  await start();
});

afterEach(async () => {
  write.release?.(); // a held write never outlives its test, even a failed one
  write.before = undefined;
  write.release = undefined;
  write.onCall = undefined;
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function issue(): Promise<PairingCodeIssued> {
  const r = await svc.app.inject({ method: "POST", url: "/extension/pair", headers: ui });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as PairingCodeIssued;
}

async function status(codeId?: string, headers: Record<string, string> = ui): Promise<{ statusCode: number; body: string; json: PairingCodeStatus & { error?: { code: string; message: string } } }> {
  const r = await svc.app.inject({ method: "GET", url: codeId === undefined ? "/extension/pair/status" : `/extension/pair/status/${codeId}`, headers });
  return { statusCode: r.statusCode, body: r.body, json: r.json() };
}

const confirm = (code: string, origin = EXT) =>
  svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin, "content-type": "application/json" }, payload: JSON.stringify({ code }) });

const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");

describe("issuing a code", () => {
  it("returns a non-secret id and how long the code is valid, beside the code and its expiry", async () => {
    const c = await issue();
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c.codeId).toMatch(/^[0-9a-f]{16}$/);
    expect(c.codeId).not.toContain(c.code);
    expect(c.validForMs).toBe(5 * 60_000);
    expect(c.expiresAt).toBe(new Date(now + 5 * 60_000).toISOString());
    expect((await issue()).codeId).not.toBe(c.codeId);
  });
});

describe("GET /extension/pair/status", () => {
  it("none before any code was issued", async () => {
    const r = await status();
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ state: "none" });
  });

  it("active, with its expiry and the time left, and never the code", async () => {
    const c = await issue();
    now += 60_000;
    const r = await status();
    expect(r.json).toEqual({ state: "active", codeId: c.codeId, expiresAt: c.expiresAt, validForMs: 4 * 60_000 });
    expect(r.body).not.toContain(c.code);
    expect((await status(c.codeId)).json).toEqual(r.json);
  });

  it("used, with the time and the paired browser, once the extension confirmed it", async () => {
    const c = await issue();
    now += 10_000;
    expect((await confirm(c.code)).statusCode).toBe(200);
    const listed = (await svc.app.inject({ method: "GET", url: "/extension/pairings", headers: ui })).json().extensions as Array<{ id: string; origin: string }>;
    const r = await status(c.codeId);
    expect(r.json).toEqual({ state: "used", codeId: c.codeId, usedAt: new Date(now).toISOString(), browser: { id: listed[0]!.id, origin: EXT } });
    expect(r.body).not.toContain(c.code);
    expect(r.body).not.toMatch(/token/i);
    expect((await status()).json).toEqual(r.json);
    // Still used after much later: a used code never turns into "expired".
    now += 60 * 60_000;
    expect((await status(c.codeId)).json.state).toBe("used");
  });

  it("used only once the pairing is written: while the write is pending it says confirming, never used", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    write.release = release;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    write.before = async () => {
      entered();
      await held;
    };
    const c = await issue();
    const pending = confirm(c.code);
    await started;
    const during = await status(c.codeId);
    expect(during.json).toEqual({ state: "confirming", codeId: c.codeId });
    expect((await status()).json.state).toBe("confirming");
    // The code is already spent: a second try fails, and is not counted against the pending one.
    expect((await confirm(c.code, OTHER_EXT)).statusCode).toBe(401);
    // A new code issued meanwhile does not call the pending one replaced.
    const second = await issue();
    // Its time running out meanwhile does not call it expired either.
    now += 10 * 60_000;
    expect((await status(c.codeId)).json.state).toBe("confirming");
    release();
    expect((await pending).statusCode).toBe(200);
    const listed = (await svc.app.inject({ method: "GET", url: "/extension/pairings", headers: ui })).json().extensions as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    expect((await status(c.codeId)).json).toMatchObject({ state: "used", browser: { id: listed[0]!.id, origin: EXT } });
    expect((await status(second.codeId)).json.state).toBe("expired");
  });

  it("a pairing that could not be written ends the code as invalidated, saying why, and is never reported as used", async () => {
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let fail!: () => void;
    const failing = new Promise<void>((_, rej) => (fail = () => rej(new Error("disk full"))));
    write.release = () => fail();
    write.before = async () => {
      entered();
      await failing;
    };
    const c = await issue();
    const pending = confirm(c.code);
    await started;
    expect((await status(c.codeId)).json.state).toBe("confirming");
    fail();
    const r = await pending;
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain(c.code);
    const after = await status(c.codeId);
    expect(after.json).toEqual({ state: "invalidated", codeId: c.codeId, invalidatedAt: new Date(now).toISOString(), reason: "not-saved" });
    expect((await svc.app.inject({ method: "GET", url: "/extension/pairings", headers: ui })).json().extensions).toEqual([]);
    // Still spent: it never works a second time.
    write.before = undefined;
    expect((await confirm(c.code)).statusCode).toBe(401);
    expect(logs).not.toContain(c.code);
  });

  it("five wrong tries say so as the reason", async () => {
    const c = await issue();
    for (let i = 0; i < 5; i++) await confirm(wrongOf(c.code));
    expect((await status(c.codeId)).json).toMatchObject({ state: "invalidated", reason: "wrong-tries" });
  });

  it("the time left never exceeds the code's lifetime, even when the service's clock steps back", async () => {
    const c = await issue();
    now -= 60 * 60_000;
    expect((await status(c.codeId)).json).toMatchObject({ state: "active", validForMs: 5 * 60_000 });
  });

  it("expired once its time is up, whether or not anyone tried it", async () => {
    const c = await issue();
    now += 5 * 60_000 + 1;
    expect((await status(c.codeId)).json).toEqual({ state: "expired", codeId: c.codeId, expiredAt: c.expiresAt });
    // A late confirm does not change that.
    expect((await confirm(c.code)).statusCode).toBe(401);
    expect((await status()).json.state).toBe("expired");
  });

  it("invalidated after 5 wrong tries", async () => {
    const c = await issue();
    for (let i = 0; i < 4; i++) expect((await confirm(wrongOf(c.code))).statusCode).toBe(401);
    expect((await status(c.codeId)).json.state).toBe("active");
    now += 1000;
    expect((await confirm(wrongOf(c.code))).statusCode).toBe(401);
    expect((await status(c.codeId)).json).toEqual({ state: "invalidated", codeId: c.codeId, invalidatedAt: new Date(now).toISOString(), reason: "wrong-tries" });
    expect((await confirm(c.code)).statusCode).toBe(401);
    expect((await status(c.codeId)).json.state).toBe("invalidated");
  });

  it("replaced when a newer code was issued; the newest is what the plain route reports", async () => {
    const first = await issue();
    now += 2000;
    const second = await issue();
    expect((await status(first.codeId)).json).toEqual({ state: "replaced", codeId: first.codeId, replacedAt: new Date(now).toISOString() });
    expect((await status()).json).toMatchObject({ state: "active", codeId: second.codeId });
    // The replaced code no longer works.
    expect((await confirm(first.code)).statusCode).toBe(401);
  });

  it("a code that had expired, or was used, before a newer one was issued keeps that state", async () => {
    const used = await issue();
    expect((await confirm(used.code)).statusCode).toBe(200);
    const expired = await issue();
    now += 6 * 60_000;
    await issue();
    expect((await status(used.codeId)).json.state).toBe("used");
    expect((await status(expired.codeId)).json.state).toBe("expired");
  });

  it("none for an id it never issued, or after the service restarted", async () => {
    const c = await issue();
    expect((await status("0123456789abcdef")).json).toEqual({ state: "none" });
    await svc.close();
    await start();
    expect((await status(c.codeId)).json).toEqual({ state: "none" });
    expect((await status()).json).toEqual({ state: "none" });
  });

  it("an id that is not one in form is refused plainly", async () => {
    const r = await status("not-an-id");
    expect(r.statusCode).toBe(400);
    expect(r.json.error?.code).toBe("VALIDATION");
  });

  it("the code never reaches the log, and the status adds nothing secret to it", async () => {
    const c = await issue();
    await status(c.codeId);
    await confirm(c.code);
    await status(c.codeId);
    expect(logs).not.toContain(c.code);
  });
});

describe("FR-718: the pairing's save has a time limit, and a save that lands after it is taken back", () => {
  /** Holds the next pairings write until `release()` (released when the test ends, whatever its end). */
  function holdWrite() {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    write.release = release;
    onTestFinished(() => release());
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    write.before = async () => {
      write.before = undefined; // only the confirm's own write is held
      entered();
      await held;
    };
    return { release, started };
  }
  const projectsWith = (token: string) => svc.app.inject({ method: "GET", url: "/projects", headers: { authorization: `Bearer ${token}`, origin: EXT } });
  const savedOrigins = async () => {
    const f = JSON.parse(await readFile(join(deps.appConfigDir, "extension-pairings.json"), "utf8")) as { extensions: Array<{ origin: string }> };
    return f.extensions.map((e) => e.origin);
  };

  it("a save that lands before the limit pairs the browser", async () => {
    await svc.close();
    await start({ pairing: { confirmPerMinute: 100, now: () => now, saveLimitMs: 60_000 } });
    const { release, started } = holdWrite();
    const c = await issue();
    const pending = confirm(c.code);
    await started;
    release();
    const r = await pending;
    expect(r.statusCode, r.body).toBe(200);
    expect((await status(c.codeId)).json.state).toBe("used");
    expect((await projectsWith(r.json().token as string)).statusCode).not.toBe(401);
  });

  it("past the limit the extension is told plainly that it is not paired; the save that lands later is taken back and its token refused", async () => {
    await svc.close();
    await start({ pairing: { confirmPerMinute: 100, now: () => now, saveLimitMs: 50 } });
    const { release, started } = holdWrite();
    const c = await issue();
    const pending = confirm(c.code);
    await started;
    const r = await pending;
    expect([r.statusCode, r.json()]).toEqual([
      503,
      { error: { code: "UNAVAILABLE", message: "This app could not save the pairing in time, so the browser is not paired. Show a new code in the desktop app and pair again." } },
    ]);
    expect(r.body).not.toContain(c.code);
    expect((await status(c.codeId)).json).toMatchObject({ state: "invalidated", reason: "not-saved" });
    expect((await svc.app.inject({ method: "GET", url: "/extension/pairings", headers: ui })).json().extensions).toEqual([]);

    // The write lands now, after the extension was told it failed: the pairing is taken back.
    release();
    await svc.pairing.idle();
    expect(await savedOrigins()).toEqual([]);
    expect((await svc.app.inject({ method: "GET", url: "/extension/pairings", headers: ui })).json().extensions).toEqual([]);
    expect(svc.pairing.isPairedOrigin(EXT)).toBe(false);
    expect((await status(c.codeId)).json).toMatchObject({ state: "invalidated", reason: "not-saved" });
    // A pairing made afterwards is kept, and the taken-back one stays gone after a restart.
    const again = await issue();
    const ok = await confirm(again.code);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await savedOrigins()).toEqual([EXT]);
    await svc.close();
    await start();
    expect((await projectsWith(ok.json().token as string)).statusCode).not.toBe(401);
    expect((await svc.app.inject({ method: "GET", url: "/extension/pairings", headers: ui })).json().extensions).toHaveLength(1);
  });

  it("another write that reads the late save before it is taken back never makes it usable", async () => {
    await svc.close();
    await start({ pairing: { confirmPerMinute: 100, now: () => now, saveLimitMs: 50 } });
    const { release, started } = holdWrite();
    const c = await issue();
    const pending = confirm(c.code);
    await started;
    expect((await pending).statusCode).toBe(503);
    // As the late save takes its turn on the file, another write (an unpairing of a browser that is not paired) is
    // queued right behind it: it reads the late pairing before the taking back can.
    const other = new Promise<boolean>((resolve, reject) => {
      write.onCall = () => {
        write.onCall = undefined;
        svc.pairing.unpair("0000000000000000").then(resolve, reject);
      };
    });
    release();
    await other;
    expect(svc.pairing.isPairedOrigin(EXT)).toBe(false);
    expect(svc.pairing.list()).toEqual([]);
    await svc.pairing.idle();
    expect(await savedOrigins()).toEqual([]);
    expect(svc.pairing.list()).toEqual([]);
  });
});

describe("FR-718 (R508 M2): the service's orderly stop waits for a pairing's taking back no longer than for a request in flight", () => {
  it("a save that never lands does not hold the stop for ever; the pairing stays unusable", async () => {
    await svc.close();
    await start({ pairing: { confirmPerMinute: 100, now: () => now, saveLimitMs: 50 }, inFlightWaitMs: 200 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    write.release = release;
    onTestFinished(() => release());
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    write.before = async () => {
      write.before = undefined;
      entered();
      await held; // never released before the stop
    };
    const c = await issue();
    const pending = confirm(c.code);
    await started;
    expect((await pending).statusCode).toBe(503);
    // A guard so that a stop that never ends fails the test rather than hanging it (far past the 200 ms bound).
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([svc.close().then(() => "closed"), new Promise<string>((r) => (guard = setTimeout(() => r("still closing"), 10_000)))]);
    clearTimeout(guard);
    expect(outcome).toBe("closed");
    expect(svc.pairing.isPairedOrigin(EXT)).toBe(false);
    expect(svc.pairing.list()).toEqual([]);
  });
});

describe("who may read a code's status (R96)", () => {
  async function pairedToken(): Promise<string> {
    const c = await issue();
    const r = await confirm(c.code);
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("the desktop app's origin with the UI token: both shell origins", async () => {
    expect((await status(undefined, { authorization: `Bearer ${TOKEN}`, origin: "tauri://localhost" })).statusCode).toBe(200);
    expect((await status(undefined, { authorization: `Bearer ${TOKEN}`, origin: "http://tauri.localhost" })).statusCode).toBe(200);
  });

  it("refused without a token, or with a wrong one", async () => {
    const none = await status(undefined, { origin: APP });
    expect(none.statusCode).toBe(401);
    expect(none.json.error?.code).toBe("UNAUTHORIZED");
    expect((await status(undefined, { authorization: `Bearer ${"x".repeat(44)}`, origin: APP })).statusCode).toBe(401);
  });

  it("refused with the UI token but no Origin at all (the app's own page always sends one)", async () => {
    const r = await status(undefined, { authorization: `Bearer ${TOKEN}` });
    expect(r.statusCode).toBe(403);
    expect(r.json.error?.code).toBe("FORBIDDEN");
  });

  it("refused with the UI token from another origin: a web page, an unpaired or a paired extension", async () => {
    for (const origin of ["https://evil.example", OTHER_EXT]) {
      const r = await status(undefined, { authorization: `Bearer ${TOKEN}`, origin });
      expect(r.statusCode, origin).toBe(403);
    }
    await pairedToken(); // EXT is now a paired origin, which the service otherwise lets through
    const r = await status(undefined, { authorization: `Bearer ${TOKEN}`, origin: EXT });
    expect(r.statusCode).toBe(403);
    expect(r.json.error?.code).toBe("FORBIDDEN");
  });

  it("refused with a paired extension's token, from its own origin, with or without an id", async () => {
    const token = await pairedToken();
    const c = await issue();
    for (const id of [undefined, c.codeId]) {
      const r = await status(id, { authorization: `Bearer ${token}`, origin: EXT });
      expect(r.statusCode).toBe(403);
      expect(r.json.error?.code).toBe("FORBIDDEN");
      expect(r.body).not.toContain(c.code);
      expect((await status(id, { authorization: `Bearer ${token}` })).statusCode).toBe(403);
    }
  });

  it("refused with a Host that is not the service's own (DNS rebinding), even with the UI token and the app's origin", async () => {
    for (const host of ["evil.example", "attacker.localhost", "127.0.0.2"]) {
      const r = await svc.app.inject({ method: "GET", url: "/extension/pair/status", headers: { ...ui, host } });
      expect(r.statusCode, host).toBe(403);
      expect(r.json().error.code).toBe("FORBIDDEN");
    }
  });

  it("refused when the token is in the query string", async () => {
    const r = await svc.app.inject({ method: "GET", url: `/extension/pair/status?token=${TOKEN}`, headers: { origin: APP } });
    expect(r.statusCode).toBe(401);
  });

  it("refusals are in the service's error shape, in plain words, with no path", async () => {
    const r = await status(undefined, { authorization: `Bearer ${TOKEN}` });
    expect(Object.keys(r.json)).toEqual(["error"]);
    expect(r.json.error?.message).toMatch(/desktop app/i);
    expect(r.body).not.toContain(tmp);
  });
});
