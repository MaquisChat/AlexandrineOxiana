/**
 * Whole channels (Task 7): keeping the Mac awake while downloads or transcriptions run, with macOS's own
 * `/usr/bin/caffeinate -i -w <service pid>`. No real process is ever started here: `spawn` and the platform are
 * injected.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { spawn } from "node:child_process";
import { deviceDeps } from "@ao/library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepAwake } from "./keep-awake.js";
import { createService, type LibraryService } from "./server.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

class FakeChild extends EventEmitter {
  killed: string[] = [];
  unref = vi.fn();
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const fn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    return c;
  }) as unknown as typeof spawn;
  return { fn, children, calls };
}

describe("KeepAwake", () => {
  it("starts caffeinate -i -w <pid> once on macOS while wanted, kills it when not wanted, and does nothing elsewhere", () => {
    const sp = fakeSpawn();
    const k = new KeepAwake({ platform: "darwin", spawn: sp.fn, pid: 4242 });
    k.update(true);
    k.update(true);
    expect(sp.calls).toEqual([{ cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "4242"] }]);
    expect(sp.children[0]!.unref).toHaveBeenCalled(); // never keeps the service from exiting
    k.update(false);
    expect(sp.children[0]!.killed).toEqual(["SIGTERM"]);
    k.update(false);
    expect(sp.children[0]!.killed).toEqual(["SIGTERM"]);
    // Wanted again: one new process.
    k.update(true);
    expect(sp.calls).toHaveLength(2);
    // It ended by itself (killed from outside): the next update starts one again, never two.
    sp.children[1]!.emit("exit", 0, null);
    k.update(true);
    k.update(true);
    expect(sp.calls).toHaveLength(3);
    // A spawn that fails is not thrown and not left behind.
    sp.children[2]!.emit("error", new Error("ENOENT"));
    k.update(true);
    expect(sp.calls).toHaveLength(4);
    k.stop();
    expect(sp.children[3]!.killed).toEqual(["SIGTERM"]);
    k.stop();
    expect(sp.children[3]!.killed).toEqual(["SIGTERM"]);

    const other = fakeSpawn();
    const linux = new KeepAwake({ platform: "linux", spawn: other.fn, pid: 4242 });
    linux.update(true);
    linux.stop();
    expect(other.calls).toHaveLength(0);
  });
});

describe("keeping awake in the service", () => {
  let tmp: string;
  let svc: LibraryService | undefined;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ao-keep-awake-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await svc?.close();
    svc = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeping awake follows the lists and the setting", async () => {
    const sp = fakeSpawn();
    svc = await createService({
      token: "ui-token-0123456789abcdefghijklmnopqrstuvwxyz",
      deps: { ...deviceDeps(join(tmp, "config")), settleMs: 0 },
      worker: null,
      logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      pairing: { confirmPerMinute: 100 },
      keepAwake: { platform: "darwin", spawn: sp.fn, pid: 777 },
    });
    const auth = { authorization: "Bearer ui-token-0123456789abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" };
    const call = (method: "POST" | "PUT", url: string, body: unknown) => svc!.app.inject({ method, url, headers: auth, payload: JSON.stringify(body) });
    expect((await call("POST", "/libraries", { path: join(tmp, "Lib"), name: "Lib" })).statusCode).toBe(200);
    const pid = (await call("POST", "/projects", { name: "Study", governanceYaml: GOV, encryption: { enabled: false } })).json().project.id as string;
    const state = svc.state;
    const downloads = vi.spyOn(state.downloads, "active").mockReturnValue(false);
    const transcriptions = vi.spyOn(state.transcriptionList, "active").mockReturnValue(false);

    // Told through every background.progress event.
    state.publishBackground(pid, {});
    expect(sp.calls).toHaveLength(0);
    downloads.mockReturnValue(true);
    state.publishBackground(pid, {});
    state.publishBackground(pid, {});
    expect(sp.calls).toEqual([{ cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "777"] }]);
    downloads.mockReturnValue(false);
    transcriptions.mockReturnValue(true);
    state.publishBackground(pid, {});
    expect(sp.calls).toHaveLength(1); // still wanted: the same process
    transcriptions.mockReturnValue(false);
    state.publishBackground(pid, {});
    expect(sp.children[0]!.killed).toEqual(["SIGTERM"]);

    // The setting: turned off, the process ends at once; turned on, it starts again while a list runs.
    transcriptions.mockReturnValue(true);
    state.publishBackground(pid, {});
    expect(sp.calls).toHaveLength(2);
    expect((await call("PUT", "/settings/background", { keepAwake: false })).statusCode).toBe(200);
    expect(sp.children[1]!.killed).toEqual(["SIGTERM"]);
    state.publishBackground(pid, {});
    expect(sp.calls).toHaveLength(2);
    expect((await call("PUT", "/settings/background", { keepAwake: true })).statusCode).toBe(200);
    expect(sp.calls).toHaveLength(3);

    // The service's close ends it.
    await svc.close();
    svc = undefined;
    expect(sp.children[2]!.killed).toEqual(["SIGTERM"]);
    expect(sp.calls).toHaveLength(3);
  });
});
