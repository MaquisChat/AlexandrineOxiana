/**
 * Whole-channel capture (R668, R669): a download run and its videos are written to the project's job journal
 * (R31) as `capture.run` and `capture.item` records, sealed in an encrypted project, read back after a restart.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import { FAST, OPEN_GOV, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { compactJobJournal, journalPath, readJobJournal } from "../job-journal.js";
import { openLibrary } from "../library.js";
import { ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { projectDataKey } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import {
  createRun, discardRun, readRun, readRunItems, readRuns, recordRunItem, requeueFailedItems, setRunItems, setRunState,
} from "./run-journal.js";

const MARKER = "zebra-channel-7f3a9c";
const base = {
  url: `https://www.youtube.com/@${MARKER}`, title: `Channel ${MARKER}`, platform: "youtube" as const,
  options: { quality: "720p", transcribe: true }, startedBy: "desktop" as const,
};
const items = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ postId: `v${from + i}`, url: `https://www.youtube.com/watch?v=${MARKER}${from + i}`, title: `Video ${from + i}`, durationSec: 60 * (from + i + 1) }));

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-run-journal-");
});
afterEach(async () => {
  await kit.close();
});

describe("download runs in the job journal", () => {
  it("a run and its items are written sealed in an encrypted project and read back", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const created = await createRun(kit.repo, p.id, "run-1", base);
    expect(created.runId).toBe("run-1");
    expect(created.record).toMatchObject({ id: "run-1", kind: "capture.run", status: "queued", run: { ...base, state: "queued", total: 0, done: 0, failed: 0 } });
    await setRunItems(kit.repo, p.id, "run-1", items(2));
    await setRunState(kit.repo, p.id, "run-1", "downloading");
    const raw = await readFile(journalPath(kit.lib.root, kit.repo.getProject(p.id).folder));
    expect(raw.includes(MARKER)).toBe(false);
    expect(raw.includes("youtube")).toBe(false);
    const repo = await kit.reopen();
    const back = await readRun(repo, p.id, "run-1");
    expect(back?.record).toMatchObject({ status: "running", run: { url: base.url, title: base.title, state: "downloading", total: 2, done: 0, failed: 0 } });
    const its = await readRunItems(repo, p.id, "run-1");
    expect(its.map((i) => [i.id, i.status, i.item.postId, i.item.index, i.item.durationSec])).toEqual([
      ["run-1/0", "queued", "v0", 0, 60],
      ["run-1/1", "queued", "v1", 1, 120],
    ]);
    expect((await readRuns(repo, p.id)).map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("setRunItems keeps the record of an item already listed", async () => {
    const p = await makeProject(kit);
    await createRun(kit.repo, p.id, "r", base);
    await setRunItems(kit.repo, p.id, "r", items(2));
    await recordRunItem(kit.repo, p.id, "r", "v0", { status: "done", sourceId: "src-0" });
    const v = await setRunItems(kit.repo, p.id, "r", [...items(2), ...items(1, 2)].map((i) => ({ ...i, title: `changed ${i.postId}` })));
    expect(v.record.run).toMatchObject({ total: 3, done: 1, failed: 0 });
    const its = await readRunItems(kit.repo, p.id, "r");
    expect(its.map((i) => [i.id, i.status, i.item.title, i.item.sourceId])).toEqual([
      ["r/0", "done", "Video 0", "src-0"],
      ["r/1", "queued", "Video 1", undefined],
      ["r/2", "queued", "changed v2", undefined],
    ]);
  });

  it("recordRunItem moves the counters", async () => {
    const p = await makeProject(kit);
    await createRun(kit.repo, p.id, "r", base);
    await setRunItems(kit.repo, p.id, "r", items(4));
    await recordRunItem(kit.repo, p.id, "r", "v0", { status: "running" });
    expect((await readRunItems(kit.repo, p.id, "r"))[0]!.status).toBe("running");
    await recordRunItem(kit.repo, p.id, "r", "v0", { status: "done", sourceId: "s0" });
    await recordRunItem(kit.repo, p.id, "r", "v1", { status: "done" });
    const v = await recordRunItem(kit.repo, p.id, "r", "v2", { status: "failed", errorCode: "PRIVATE", platformReason: "Private video" });
    expect(v.record.run).toMatchObject({ total: 4, done: 2, failed: 1 });
    const failed = (await readRunItems(kit.repo, p.id, "r"))[2]!;
    expect(failed).toMatchObject({ status: "failed", item: { errorCode: "PRIVATE", platformReason: "Private video" } });
    // An item put back is no longer failed.
    const back = await recordRunItem(kit.repo, p.id, "r", "v2", { status: "queued" });
    expect(back.record.run).toMatchObject({ done: 2, failed: 0 });
    expect((await readRunItems(kit.repo, p.id, "r"))[2]!.item.errorCode).toBeUndefined();
  });

  it("requeueFailedItems puts failed items back and sets failed to 0", async () => {
    const p = await makeProject(kit);
    await createRun(kit.repo, p.id, "r", base);
    await setRunItems(kit.repo, p.id, "r", items(3));
    await recordRunItem(kit.repo, p.id, "r", "v0", { status: "failed", errorCode: "NETWORK_LOST" });
    await recordRunItem(kit.repo, p.id, "r", "v1", { status: "done" });
    await recordRunItem(kit.repo, p.id, "r", "v2", { status: "failed", errorCode: "PRIVATE" });
    const v = await requeueFailedItems(kit.repo, p.id, "r");
    expect(v.record.run).toMatchObject({ total: 3, done: 1, failed: 0 });
    expect((await readRunItems(kit.repo, p.id, "r")).map((i) => [i.status, i.item.errorCode])).toEqual([
      ["queued", undefined],
      ["done", undefined],
      ["queued", undefined],
    ]);
  });

  it("setRunState maps the job status", async () => {
    const p = await makeProject(kit);
    await createRun(kit.repo, p.id, "r", base);
    await setRunItems(kit.repo, p.id, "r", items(3));
    expect((await setRunState(kit.repo, p.id, "r", "downloading")).record.status).toBe("running");
    const w = await setRunState(kit.repo, p.id, "r", "waiting", { wait: { ms: 60_000, why: "rate-limited" } });
    expect(w.record).toMatchObject({ status: "running", run: { state: "waiting", wait: { ms: 60_000, why: "rate-limited" } } });
    // The wait is gone once the run downloads again.
    expect((await setRunState(kit.repo, p.id, "r", "downloading")).record.run.wait).toBeUndefined();
    const t = await setRunState(kit.repo, p.id, "r", "paused-tool", { tool: "ffmpeg" });
    expect(t.record).toMatchObject({ status: "queued", run: { state: "paused-tool", tool: "ffmpeg" } });
    const f = await setRunState(kit.repo, p.id, "r", "failed", { errorCode: "WORKER_UNAVAILABLE", reason: "The media helper is not running." });
    expect(f.record).toMatchObject({ status: "queued", run: { state: "failed", errorCode: "WORKER_UNAVAILABLE", reason: "The media helper is not running." } });
    for (const id of ["v0", "v1", "v2"]) await recordRunItem(kit.repo, p.id, "r", id, { status: "done" });
    expect((await setRunState(kit.repo, p.id, "r", "finished")).record.status).toBe("done");
    await createRun(kit.repo, p.id, "r2", base);
    await setRunItems(kit.repo, p.id, "r2", items(3));
    await recordRunItem(kit.repo, p.id, "r2", "v0", { status: "failed", errorCode: "PRIVATE" });
    await recordRunItem(kit.repo, p.id, "r2", "v1", { status: "failed", errorCode: "PRIVATE" });
    await recordRunItem(kit.repo, p.id, "r2", "v2", { status: "done" });
    const r2 = await setRunState(kit.repo, p.id, "r2", "finished");
    expect(r2.record).toMatchObject({ status: "queued", run: { state: "finished", failed: 2 } });
    expect((await setRunState(kit.repo, p.id, "r2", "queued")).record.status).toBe("queued");
    // Newest first.
    expect((await readRuns(kit.repo, p.id)).map((r) => r.runId)).toEqual(["r2", "r"]);
  });

  it("discardRun hides the run from readRuns and its items are dropped at compaction", async () => {
    const p = await makeProject(kit);
    await createRun(kit.repo, p.id, "keep", base);
    await createRun(kit.repo, p.id, "r", base);
    await setRunItems(kit.repo, p.id, "r", items(2));
    expect(await discardRun(kit.repo, p.id, "r")).toBe(true);
    expect(await discardRun(kit.repo, p.id, "r")).toBe(false);
    expect(await discardRun(kit.repo, p.id, "unknown")).toBe(false);
    expect((await readRuns(kit.repo, p.id)).map((r) => r.runId)).toEqual(["keep"]);
    expect(await readRun(kit.repo, p.id, "r")).toBeUndefined();
    const folder = kit.repo.getProject(p.id).folder;
    await compactJobJournal(kit.lib.root, folder, p.id, null, 0);
    const recs = (await readJobJournal(kit.lib.root, folder, p.id, null)).records;
    expect(recs.get("r")).toMatchObject({ status: "cancelled", error: "DISCARDED" });
    expect(recs.has("r/0")).toBe(false);
    expect(recs.has("r/1")).toBe(false);
  });

  it("a read-only library refuses every write with ReadOnlyLibraryError", async () => {
    const p = await makeProject(kit);
    await createRun(kit.repo, p.id, "r", base);
    await setRunItems(kit.repo, p.id, "r", items(1));
    const folder = kit.repo.getProject(p.id).folder;
    const before = await readFile(journalPath(kit.lib.root, folder));
    const ro = await openLibrary(kit.lib.root, {
      clock: () => kit.clock.now, deviceId: "dev-B", hostname: "host-B", pid: process.pid, isPidAlive: () => true,
      appConfigDir: join(kit.tmp, "config-B"), settleMs: 0, setInterval: () => ({}), clearInterval: () => {},
    });
    onTestFinished(() => ro.close());
    expect(ro.mode).toBe("read-only");
    const repo = await openTestRepo(ro, new KeyRing(), { clock: () => kit.clock.now, tz: "UTC", actor: "tester", scryptN: FAST });
    const writes = [
      () => createRun(repo, p.id, "r2", base),
      () => setRunItems(repo, p.id, "r", items(2)),
      () => recordRunItem(repo, p.id, "r", "v0", { status: "done" }),
      () => requeueFailedItems(repo, p.id, "r"),
      () => setRunState(repo, p.id, "r", "paused"),
      () => discardRun(repo, p.id, "r"),
    ];
    for (const w of writes) await expect(w()).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(await readFile(journalPath(kit.lib.root, folder))).toEqual(before);
    expect((await readRuns(repo, p.id)).map((r) => r.runId)).toEqual(["r"]); // reading still works
  });

  it("a locked project refuses with ProjectLockedError", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    await createRun(kit.repo, p.id, "r", base);
    await kit.repo.lockProject(p.id);
    await expect(readRuns(kit.repo, p.id)).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(readRun(kit.repo, p.id, "r")).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(readRunItems(kit.repo, p.id, "r")).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(createRun(kit.repo, p.id, "r2", base)).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(setRunState(kit.repo, p.id, "r", "paused")).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(discardRun(kit.repo, p.id, "r")).rejects.toBeInstanceOf(ProjectLockedError);
  });

  it("assertNoSecrets refuses options naming a cookie value", async () => {
    const p = await makeProject(kit);
    await expect(createRun(kit.repo, p.id, "r", { ...base, options: { browser: { cookieValue: "abc" } } })).rejects.toBeInstanceOf(TypeError);
    expect(await readRuns(kit.repo, p.id)).toEqual([]);
    expect(projectDataKey(kit.repo, p.id)).toBeNull();
  });
});
