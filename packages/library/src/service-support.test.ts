/**
 * Library support for the local service (Task 30, R96): proxy-job retries with backoff and their
 * failures surfaced, the OCR queue (persisted, resumable, retried), queue disposal, governance edits
 * (loosening needs a reason, audited), field confirmation, transcript versions, capture preflight,
 * app settings and path scrubbing.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GovernanceParseError, newId, type PendingProxy, type Project } from "@ao/core";
import { readAppSetting, scrubPaths, updateAppSetting } from "./app-settings.js";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { OcrQueue, disposeOcrQueue, ocrQueueFor } from "./import/ocr.js";
import { ProxyQueue, disposeProxyQueue, proxyQueueFor } from "./import/proxies.js";
import { GovernanceLooseningError } from "./repo/governance-edit.js";
import { PolicyDeniedError } from "./repo/errors.js";
import { addTranscriptVersion, checkCaptureAllowed, confirmField, readAssetText, transcriptVersions } from "./source-actions.js";
import { WorkerJobError, type JobResult, type WorkerClient, type WorkerJob } from "./worker-client.js";

let kit: Kit;
let p: Project;
beforeEach(async () => {
  kit = await makeKit("ao-svc-support-");
  p = await makeProject(kit, OPEN_GOV);
});
afterEach(async () => {
  await kit.close();
});

/** A media worker stand-in: `fail` failures first (WorkerJobError), then success via `ok`. */
function fakeWorker(opts: { fail: number; code?: string; ok?: (job: WorkerJob) => Promise<JobResult> }): { worker: WorkerClient; calls: WorkerJob[] } {
  const calls: WorkerJob[] = [];
  const worker = {
    async submit(_projectId: string, job: WorkerJob): Promise<JobResult> {
      calls.push(job);
      if (calls.length <= opts.fail) throw new WorkerJobError(opts.code ?? "TOOL_FAILED", "the tool failed");
      if (!opts.ok) throw new Error("no success configured");
      return opts.ok(job);
    },
  } as unknown as WorkerClient;
  return { worker, calls };
}

async function pdfSource() {
  const pdf = await scratchFile(kit, "scan.pdf", "%PDF-1.4 scanned page");
  return addSource(kit, p, { title: "Scanned report", files: [{ path: pdf, role: "original", handling: "copy" }] });
}

async function photoWithPendingProxy() {
  const jpg = await scratchFile(kit, "photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const sf = await addSource(kit, p, { title: "Photo", type: "image" as never, files: [{ path: jpg, role: "original", handling: "copy" }] });
  const { editPendingProxies } = await import("./repo/repo.js");
  const job: PendingProxy = { id: newId(), type: "image.proxy", assetId: sf.assets[0]!.id, location: "keep", queuedAt: new Date().toISOString() };
  await editPendingProxies(kit.repo, p.id, sf.source.id, () => [job]);
  return { sf, job };
}

describe("ProxyQueue retries (R96)", () => {
  it("retries a transient worker failure with backoff, max 3 attempts, then records and surfaces it", async () => {
    const { sf } = await photoWithPendingProxy();
    const { worker, calls } = fakeWorker({ fail: 99 });
    const waits: number[] = [];
    const q = new ProxyQueue({ repo: kit.repo, worker, backoffMs: 10, sleep: async (ms) => void waits.push(ms) });
    const seen: string[] = [];
    q.onResult((r) => seen.push(r.code ?? "ok"));
    const results = await q.resumePending(p.id);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([10, 40]);
    expect(results).toEqual([expect.objectContaining({ ok: false, code: "TOOL_FAILED" })]);
    expect(seen).toEqual(["TOOL_FAILED"]);
    const failures = await q.failures(p.id);
    expect(failures).toEqual([expect.objectContaining({ sourceId: sf.source.id, code: "TOOL_FAILED", attempts: 3, type: "image.proxy" })]);
    // A recorded failure is not run again by resumePending, but retryFailed clears it and runs it.
    await q.resumePending(p.id);
    expect(calls).toHaveLength(3);
    await q.retryFailed(p.id);
    expect(calls).toHaveLength(6);
  });

  it("does not retry a failure another attempt cannot fix", async () => {
    await photoWithPendingProxy();
    const { worker, calls } = fakeWorker({ fail: 99, code: "CANCELLED" });
    const q = new ProxyQueue({ repo: kit.repo, worker, sleep: async () => {} });
    await q.resumePending(p.id);
    expect(calls).toHaveLength(1);
  });

  it("is disposed of on library close: a new queue afterwards, and the old one takes no work", async () => {
    const q = proxyQueueFor(kit.repo);
    await disposeProxyQueue(kit.repo);
    expect(proxyQueueFor(kit.repo)).not.toBe(q);
    const { worker, calls } = fakeWorker({ fail: 99 });
    q.setWorker(worker);
    expect(q.available).toBe(false);
    await photoWithPendingProxy();
    expect(calls).toHaveLength(0);
  });
});

describe("OcrQueue", () => {
  const okOcr = async (job: WorkerJob): Promise<JobResult> => {
    const txt = `${job.output}.txt`;
    await mkdir(dirname(txt), { recursive: true });
    await writeFile(txt, "Recognised text of the scanned page");
    return { id: "j", type: "pdf.ocr", output: job.output, files: [job.output, txt], meta: {}, encrypted: false };
  };

  it("persists a job with no worker, resumes it later and records the text as a derived asset", async () => {
    const sf = await pdfSource();
    const q = new OcrQueue({ repo: kit.repo });
    expect(await q.enqueue(p.id, sf.source.id)).toBe(1);
    expect(await q.enqueue(p.id, sf.source.id)).toBe(0); // already queued
    expect((await kit.repo.getSource(p.id, sf.source.id)).pendingOcr).toHaveLength(1);
    // A later session (another queue) with a worker picks it up.
    const { worker, calls } = fakeWorker({ fail: 1, ok: okOcr });
    const later = new OcrQueue({ repo: kit.repo, worker, sleep: async () => {} });
    const r = await later.resumePending(p.id);
    expect(calls).toHaveLength(2); // one transient failure, then success
    expect(r).toEqual([expect.objectContaining({ ok: true })]);
    const after = await kit.repo.getSource(p.id, sf.source.id);
    expect(after.pendingOcr).toBeUndefined();
    const ocr = after.assets.find((a) => a.kind === "ocr-text")!;
    expect(ocr.derivation?.parents).toEqual([sf.assets[0]!.id]);
    expect(await readAssetText(kit.repo, p.id, sf.source.id, ocr.id)).toBe("Recognised text of the scanned page");
    // Done: enqueueing again adds nothing.
    expect(await later.enqueue(p.id, sf.source.id)).toBe(0);
  });

  it("records a job failed after 3 attempts and lists it", async () => {
    const sf = await pdfSource();
    const { worker, calls } = fakeWorker({ fail: 99 });
    const q = new OcrQueue({ repo: kit.repo, worker, sleep: async () => {} });
    await q.enqueue(p.id, sf.source.id);
    await q.idle();
    expect(calls).toHaveLength(3);
    expect(await q.failures(p.id)).toEqual([expect.objectContaining({ sourceId: sf.source.id, attempts: 3, code: "TOOL_FAILED" })]);
  });

  it("one queue per library, disposed on close", async () => {
    const q = ocrQueueFor(kit.repo);
    expect(ocrQueueFor(kit.repo)).toBe(q);
    await disposeOcrQueue(kit.repo);
    expect(ocrQueueFor(kit.repo)).not.toBe(q);
  });
});

describe("setGovernance", () => {
  it("rejects invalid YAML, requires a reason for loosening and audits it", async () => {
    await expect(kit.repo.setGovernance(p.id, "encryption: { atRest: sometimes }")).rejects.toBeInstanceOf(GovernanceParseError);
    const looser = OPEN_GOV.replace("captureMethods: [manual_upload, refman_import, downloader]", "captureMethods: [manual_upload, refman_import, downloader, browser_capture]");
    const err = await kit.repo.setGovernance(p.id, looser).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceLooseningError);
    expect((err as GovernanceLooseningError).loosened).toEqual(["captureMethods"]);
    expect(await kit.repo.getGovernanceText(p.id)).toBe(OPEN_GOV);
    await kit.repo.setGovernance(p.id, looser, { reason: "IRB amendment 4 approves browser capture" });
    expect(await kit.repo.getGovernanceText(p.id)).toBe(looser);
    const ev = (await auditEvents(kit, p)).filter((e) => e.details?.op === "project.governance");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ reason: "IRB amendment 4 approves browser capture", loosened: ["captureMethods"] });
  });

  it("a stricter edit needs no reason", async () => {
    const stricter = OPEN_GOV.replace(", downloader]", "]");
    await kit.repo.setGovernance(p.id, stricter);
    expect(await kit.repo.getGovernanceText(p.id)).toBe(stricter);
  });
});

describe("source actions", () => {
  it("confirmField records user evidence and the field becomes user-confirmed", async () => {
    const sf = await addSource(kit, p, { title: "A study", issued: "2001" });
    const next = await confirmField(kit.repo, p.id, sf.source.id, "/issued", "2001");
    expect(next.fieldEvidence.some((e) => e.field === "/issued" && e.source.kind === "user")).toBe(true);
    expect(next.verification["/issued"]?.status).toBe("user-confirmed");
    await expect(confirmField(kit.repo, p.id, sf.source.id, "/provenance", {})).rejects.toThrow(/not a field/);
  });

  it("addTranscriptVersion stores a human-edited version next to the machine one", async () => {
    const sf = await addSource(kit, p, { title: "Interview" });
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n", format: "vtt" });
    const b = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello there\n", format: "vtt", basedOn: a.id });
    const versions = transcriptVersions(await kit.repo.getSource(p.id, sf.source.id));
    expect(versions.map((v) => v.id)).toEqual([a.id, b.id]);
    expect(b.derivation?.params).toEqual({ basedOn: a.id });
    expect(await readAssetText(kit.repo, p.id, sf.source.id, b.id)).toContain("Hello there");
    await expect(addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: "no header", format: "vtt" })).rejects.toThrow(/WEBVTT/);
  });

  it("checkCaptureAllowed refuses (and audits) a capture method the project does not allow", async () => {
    const strict = await makeProject(kit, OPEN_GOV.replace(", downloader]", "]"));
    await expect(checkCaptureAllowed(kit.repo, strict.id, ["https://www.youtube.com/watch?v=abcdefghijk"])).rejects.toBeInstanceOf(PolicyDeniedError);
    expect((await auditEvents(kit, strict)).some((e) => e.decision?.result === "deny" && e.details?.op === "capture.preflight")).toBe(true);
    await checkCaptureAllowed(kit.repo, p.id, ["https://www.youtube.com/watch?v=abcdefghijk"]);
  });
});

describe("app settings and scrubbing", () => {
  it("settings files are owner-only and read back", async () => {
    const dir = join(kit.tmp, "cfg");
    await updateAppSetting<{ n: number }>(dir, "appearance.json", (cur) => ({ n: (cur?.n ?? 0) + 1 }));
    await updateAppSetting<{ n: number }>(dir, "appearance.json", (cur) => ({ n: (cur?.n ?? 0) + 1 }));
    expect(await readAppSetting(dir, "appearance.json")).toEqual({ n: 2 });
    if (process.platform !== "win32") expect((await stat(join(dir, "appearance.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, "appearance.json"), "utf8"))).toEqual({ n: 2 });
    await expect(readAppSetting(dir, "../x.json")).rejects.toThrow();
  });

  it("scrubPaths removes absolute paths but keeps links and library-relative paths", () => {
    expect(scrubPaths("cannot read /home/ana/secret/file.pdf now", [])).toBe("cannot read <path> now");
    expect(scrubPaths("see /lib/root/Projects/A/x.pdf", ["/lib/root"])).toBe("see Projects/A/x.pdf");
    expect(scrubPaths("at https://example.org/a/b", [])).toBe("at https://example.org/a/b");
    expect(scrubPaths("C:\\Users\\ana\\x.pdf failed", [])).toBe("<path> failed");
  });
});
