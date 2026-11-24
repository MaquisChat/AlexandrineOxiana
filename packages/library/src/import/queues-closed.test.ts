/**
 * FR-749, R562 (R546 1, R247 c): the viewing-proxy queue and the OCR queue take no job and start none once their library
 * is closed, even when a caller did not dispose of them: nothing is made under the library (no `.tmp/worker-…` scratch
 * folder, the worker never asked), a job waiting in the queue ends without a record (it stays pending for the next
 * opening), and nothing rejects unhandled.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { newId } from "@ao/core";
import { addSource, makeKit, makeProject, scratchFile, walk, type Kit } from "../export/test-kit.js";
import { editPendingOcr, editPendingProxies } from "../repo/repo.js";
import type { WorkerClient } from "../worker-client.js";
import { OcrQueue } from "./ocr.js";
import { ProxyQueue } from "./proxies.js";

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.close().catch(() => {});
  kit = undefined;
});

/** Every file under the library with its bytes' digest (folders by name). */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${rel} ${digest}`);
  }
  return out;
}

/** Every name that appears in the library's `.tmp` folder while the test runs (watched as it happens, not only at the end). */
async function watchTmp(root: string): Promise<string[]> {
  const dir = join(root, ".tmp");
  await mkdir(dir, { recursive: true });
  const seen: string[] = [];
  const w: FSWatcher = watch(dir, (_e, name) => {
    if (name) seen.push(String(name));
  });
  onTestFinished(() => w.close());
  return seen;
}

/** A worker stub that counts the jobs it is given (and would write its output into the scratch folder). */
function countingWorker(): { worker: WorkerClient; calls: () => number } {
  let n = 0;
  const worker = {
    async submit() {
      n++;
      throw new Error("the worker must not be asked after the library was closed");
    },
  } as unknown as WorkerClient;
  return { worker, calls: () => n };
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => void unhandled.push(e));

describe("the media queues once their library is closed (FR-749, R562)", () => {
  it("the viewing-proxy queue, not disposed of: a job enqueued after close() resolved makes nothing under the library and records nothing", async () => {
    kit = await makeKit("ao-queues-closed-proxy-");
    const p = await makeProject(kit);
    const jpg = await scratchFile(kit, "photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(64, 1), 0xff, 0xd9]));
    const sf = await addSource(kit, p, { type: "image", title: "Photo", files: [{ path: jpg, role: "original", handling: "copy" }] });
    const job = { id: newId(), type: "image.proxy" as const, assetId: sf.assets[0]!.id, location: "keep" as const, queuedAt: "2026-11-10T09:30:00.000Z" };
    await editPendingProxies(kit.repo, p.id, sf.source.id, () => [job]);
    const w = countingWorker();
    const q = new ProxyQueue({ repo: kit.repo, worker: w.worker, sleep: async () => {} });
    const seen = await watchTmp(kit.lib.root);
    await kit.lib.close();
    const after = await snapshot(kit.lib.root);
    unhandled.length = 0;

    q.enqueue(p.id, sf.source.id);
    const waited = await q.idle();
    const resumed = await q.resumePending(p.id);
    const retried = await q.retryFailed(p.id, sf.source.id);
    await new Promise((r) => setImmediate(r));

    expect(w.calls()).toBe(0);
    expect(seen.filter((n) => n.startsWith("worker-"))).toEqual([]);
    expect(await snapshot(kit.lib.root)).toEqual(after);
    // Nothing recorded: the job stays pending, as it was.
    expect([...waited, ...resumed, ...retried].filter((r) => r.code !== "PENDING")).toEqual([]);
    expect((await kit.repo.getSource(p.id, sf.source.id)).pendingProxies).toEqual([job]);
    expect(unhandled).toEqual([]);
    await q.dispose();
  });

  it("the OCR queue, not disposed of: a job asked for after close() resolved makes nothing under the library and records nothing", async () => {
    kit = await makeKit("ao-queues-closed-ocr-");
    const p = await makeProject(kit);
    const pdf = await scratchFile(kit, "scan.pdf", "%PDF-1.7\nscan\n%%EOF\n");
    const sf = await addSource(kit, p, { title: "Scan", files: [{ path: pdf, role: "original", handling: "copy" }] });
    const job = { id: newId(), assetId: sf.assets[0]!.id, queuedAt: "2026-11-10T09:30:00.000Z" };
    await editPendingOcr(kit.repo, p.id, sf.source.id, () => [job]);
    const w = countingWorker();
    const q = new OcrQueue({ repo: kit.repo, worker: w.worker, sleep: async () => {} });
    const seen = await watchTmp(kit.lib.root);
    await kit.lib.close();
    const after = await snapshot(kit.lib.root);
    unhandled.length = 0;

    const added = await q.enqueue(p.id, sf.source.id).catch((e: unknown) => e);
    const resumed = await q.resumePending(p.id);
    await q.idle();
    await new Promise((r) => setImmediate(r));

    expect(added === 0 || (added instanceof Error && added.name === "LibraryClosedError")).toBe(true);
    expect(w.calls()).toBe(0);
    expect(seen.filter((n) => n.startsWith("worker-"))).toEqual([]);
    expect(await snapshot(kit.lib.root)).toEqual(after);
    expect(resumed.filter((r) => r.code !== "PENDING")).toEqual([]);
    expect((await kit.repo.getSource(p.id, sf.source.id)).pendingOcr).toEqual([job]);
    expect(unhandled).toEqual([]);
    await q.dispose();
  });
});
