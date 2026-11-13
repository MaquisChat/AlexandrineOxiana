/**
 * Watched folders at scale (Task W2, Review Focus 1): a shared drive of 40,000 files of which 200 are on this
 * computer. The first scan opens exactly those 200, counts the rest with their total size, keeps memory
 * bounded and pushes its status at most once a second. Not part of `pnpm test`: run with
 * `pnpm test:scale -- watch.scale` (its own Vitest config, its own process).
 *
 * Linux stands in for macOS here: a sparse file (size > 0, no blocks) is "not downloaded" (watch-local.ts).
 * The attach is a stand-in that stores nothing and reads nothing, so every open counted is the engine's own.
 */
import fs, { closeSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { newId } from "@ao/core";
import { MockAgent } from "undici";
import { afterAll, describe, expect, it, vi } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import { createLibrary } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import { openTestRepo } from "../repo/testing.js";
import type { Attach } from "./attach.js";
import { WATCH_PROBLEMS_MAX, WATCH_REASONS, WATCH_STATUS_INTERVAL_MS, watchFolder, type WatchStatus } from "./watch.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
const N_ONLINE = 40_000;
const N_LOCAL = 200;

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("watched folders at scale", () => {
  it("a scan of 40,000 not-downloaded files opens none of them; status counts not-downloaded files and their bytes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ao-watch-scale-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const ring = new KeyRing();
    const lib = await createLibrary(join(tmp, "Lib"), "Lib", {
      clock: () => new Date(),
      deviceId: "dev-A",
      hostname: "host-A",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(tmp, "config"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    cleanups.push(() => lib.close());
    const repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
    const agent = new MockAgent();
    agent.disableNetConnect();
    cleanups.push(() => agent.close());
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
    const { project: p } = await repo.createProject({ name: "Scale", governanceYaml: GOV, encryption: { enabled: false } });

    // The drive: 40,000 online-only files (sparse, sizes 1,000 + i bytes) and 200 downloaded ones.
    const drive = join(tmp, "Drive");
    mkdirSync(drive);
    let expectedBytes = 0;
    for (let i = 0; i < N_ONLINE; i++) {
      const size = 1000 + i;
      const fd = openSync(join(drive, `online-${String(i).padStart(5, "0")}.pdf`), "w");
      ftruncateSync(fd, size);
      closeSync(fd);
      expectedBytes += size;
    }
    for (let i = 0; i < N_LOCAL; i++) writeFileSync(join(drive, `local-${String(i).padStart(3, "0")}.pdf`), `local file ${i}`);
    const real = await realpath(drive);

    // Every way a file's bytes can be opened or read, through each module's own binding.
    const spies = [
      vi.spyOn(fsp, "open"),
      vi.spyOn(fsp, "readFile"),
      vi.spyOn(fsp, "copyFile"),
      vi.spyOn(fs, "createReadStream"),
      vi.spyOn(fs, "open"),
      vi.spyOn(fs, "readFile"),
      vi.spyOn(fs, "openSync"),
      vi.spyOn(fs, "readFileSync"),
    ];
    syncBuiltinESMExports();
    const openedInDrive = () => spies.flatMap((s) => s.mock.calls as unknown[][]).map((a) => String(a[0])).filter((q) => q.startsWith(`${real}/`));

    const stored: string[] = [];
    const attach: Attach = { attachFiles: async (_p, ps) => ps.map((path) => (stored.push(path), { path, outcome: "created" as const, sourceId: newId() })) };
    const statuses: Array<WatchStatus & { at: number }> = [];

    const before = heap();
    const t0 = Date.now();
    // A real watch id: the register is written as in the service (A8; review M9).
    const watchId = newId();
    const w = watchFolder({ repo, http, lib, attach, onStatus: (s) => statuses.push({ ...structuredClone(s), at: Date.now() }) }, p.id, drive, {}, watchId);
    cleanups.push(() => w.stop());
    await w.ready;
    const done = () => {
      const s = w.status();
      return s.counts.notDownloaded === N_ONLINE && s.counts.cameIn === N_LOCAL && s.counts.waiting === 0 && !s.scanning;
    };
    while (!done()) {
      if (Date.now() - t0 > 60_000) throw new Error(`not done: ${JSON.stringify(w.status())}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const elapsed = Date.now() - t0;
    const growth = heap() - before;
    console.log(`watch scale: ${N_ONLINE + N_LOCAL} files in ${elapsed} ms; heap growth ${(growth / 1048576).toFixed(1)} MB (${Math.round(growth / (N_ONLINE + N_LOCAL))} bytes per file); ${statuses.length} status pushes`);

    // Opened: exactly the 200 local files, once each (the engine's hash); none of the 40,000.
    const opened = openedInDrive();
    expect(opened.filter((q) => q.includes("/online-"))).toEqual([]);
    expect(new Set(opened).size).toBe(N_LOCAL);
    expect(opened).toHaveLength(N_LOCAL);
    expect(stored).toHaveLength(N_LOCAL);

    // The counts and their bytes; the list is capped, newest first.
    expect(w.status()).toMatchObject({ watchId, state: "watching", provider: null, counts: { notDownloaded: N_ONLINE, notDownloadedBytes: expectedBytes, cameIn: N_LOCAL, didNotComeIn: 0 } });
    const page = w.problems({ kind: "not-downloaded", offset: 0, limit: 200 });
    expect(page.total).toBe(WATCH_PROBLEMS_MAX);
    expect(page.items).toHaveLength(200);
    expect(page.items[0]).toEqual({ file: expect.stringMatching(/^online-\d{5}\.pdf$/u), kind: "not-downloaded", reason: WATCH_REASONS.notDownloaded, bytes: expect.any(Number) });
    expect(page.items[0]!.file > page.items[199]!.file).toBe(true); // newest (last judged) first

    // Time, memory and the status rate.
    expect(elapsed).toBeLessThan(20_000);
    expect(growth).toBeLessThan(64 * 1024 * 1024);
    for (let i = 1; i < statuses.length; i++) {
      // The engine keeps the interval by its own clock (N6); the stamps here are taken in the listener, after a clone, so
      // they may lag by the time a busy turn of the event loop takes (about 50 ms under load). The count below is the rate bound.
      if (statuses[i]!.state === statuses[i - 1]!.state) expect(statuses[i]!.at - statuses[i - 1]!.at).toBeGreaterThanOrEqual(WATCH_STATUS_INTERVAL_MS - 50);
    }
    expect(statuses.length).toBeLessThanOrEqual(Math.ceil(elapsed / WATCH_STATUS_INTERVAL_MS) + 3);

    // Nothing is opened afterwards either (polls re-check the not-downloaded files).
    await new Promise((r) => setTimeout(r, 3000));
    expect(openedInDrive()).toHaveLength(N_LOCAL);
    await w.stop();
  });
});
