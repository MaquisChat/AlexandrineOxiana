/**
 * The device-level notice through the service (Task 68, R154, R178): carried in `library.state`
 * (the event the status banner reads, sent at connection and on every change), dismissed only by the
 * desktop app's "Got it" (`POST /settings/notices/dismiss`), and gone for good after that.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, deviceNoticesIdle, raiseDeviceNotice, type Deps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const APP = "http://tauri.localhost";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ui = { authorization: `Bearer ${TOKEN}`, origin: APP };

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let logs = "";
const at = new Date("2026-11-12T10:15:30.000Z");

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-svc-notices-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(tmp, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await svc?.close();
  logs = "";
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (c, _e, cb) => ((logs += c.toString()), cb()) }), pairing: { confirmPerMinute: 100 } });
}

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown; headers?: Record<string, string> }) {
  const res = await svc!.app.inject({ method: r.method ?? "GET", url: r.url, headers: { ...ui, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers }, ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}) });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

/** Creates the library the first time, opens it after that. */
async function openLibrary(): Promise<void> {
  const made = await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } });
  if (made.status === 200) return;
  const opened = await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } });
  expect(opened.status, opened.body).toBe(200);
}

/** The library state the banner reads (the same object `library.state` sends). */
async function stateNow(): Promise<{ notices?: Array<{ kind: string; at: string }> }> {
  await svc!.state.refreshNotices();
  return svc!.state.libraryState() as { notices?: Array<{ kind: string; at: string }> };
}

describe("device-level notices in the library state", () => {
  it("no notice when nothing was set aside", async () => {
    await start();
    await openLibrary();
    expect((await stateNow()).notices).toEqual([]);
  });

  it("a notice is served, dismissed by the desktop app, and stays dismissed across a restart", async () => {
    await raiseDeviceNotice(deps.appConfigDir, "old-copies-list-set-aside", at);
    await start();
    await openLibrary();
    expect((await stateNow()).notices).toEqual([{ kind: "old-copies-list-set-aside", at: at.toISOString() }]);
    const d = await call({ method: "POST", url: "/settings/notices/dismiss", body: { kind: "old-copies-list-set-aside" } });
    expect(d.status, d.body).toBe(200);
    expect(d.json).toEqual({ notices: [] });
    expect((await stateNow()).notices).toEqual([]);
    await start();
    await openLibrary();
    expect((await stateNow()).notices).toEqual([]);
  });

  it("a damaged device identity at start raises its notice, served from the first state", async () => {
    await writeFile(join(deps.appConfigDir, "device.json"), "garbage{");
    deps = { ...deviceDeps(deps.appConfigDir), settleMs: 0 };
    await deviceNoticesIdle();
    await start();
    await openLibrary();
    expect((await stateNow()).notices?.map((n) => n.kind)).toEqual(["device-identity-renewed"]);
  });

  it("dismiss: only the desktop app; a kind it does not know, or another field, is refused", async () => {
    await raiseDeviceNotice(deps.appConfigDir, "device-identity-renewed", at);
    await start();
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const ext = c.json().token as string;
    const body = JSON.stringify({ kind: "device-identity-renewed" });
    const send = (headers: Record<string, string>) => svc!.app.inject({ method: "POST", url: "/settings/notices/dismiss", headers: { "content-type": "application/json", ...headers }, payload: body });
    expect((await send({ authorization: `Bearer ${ext}`, origin: EXT })).statusCode).toBe(403);
    expect((await send({ authorization: `Bearer ${ext}` })).statusCode).toBe(403);
    expect((await send({})).statusCode).toBe(401);
    expect((await send({ ...ui, host: "evil.example" })).statusCode).toBe(403);
    expect((await send({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/settings/notices/dismiss", body: { kind: "something-else" } })).status).toBe(400);
    expect((await call({ method: "POST", url: "/settings/notices/dismiss", body: { kind: "device-identity-renewed", at: "x" } })).status).toBe(400);
    await openLibrary();
    expect((await stateNow()).notices?.map((n) => n.kind)).toEqual(["device-identity-renewed"]);
  });

  it("a notices file that cannot be read: no notices served, a plain log line without a path; the app goes on", async () => {
    await mkdir(join(deps.appConfigDir, "notices.json"));
    await start();
    await openLibrary();
    expect((await stateNow()).notices).toEqual([]);
    expect(logs).toMatch(/notices .*could not be read/i);
    expect(logs).not.toContain(tmp);
    const d = await call({ method: "POST", url: "/settings/notices/dismiss", body: { kind: "device-identity-renewed" } });
    expect(d.status).toBe(503);
    expect(d.body).not.toContain(tmp);
  });
});
