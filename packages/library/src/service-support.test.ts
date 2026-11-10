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
import { GovernanceConflictError, GovernanceLooseningError } from "./repo/governance-edit.js";
import { InvalidInputError, NotFoundError, PolicyDeniedError } from "./repo/errors.js";
import { captureBrowserPage, stripHtmlSnapshot } from "./capture/browser-capture.js";
import { tinyPng } from "../../../tests/fixtures/generate.mjs";
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
    const base = (await kit.repo.getGovernance(p.id)).sha256;
    await expect(kit.repo.setGovernance(p.id, "encryption: { atRest: sometimes }", { baseSha256: base })).rejects.toBeInstanceOf(GovernanceParseError);
    const looser = OPEN_GOV.replace("captureMethods: [manual_upload, refman_import, downloader]", "captureMethods: [manual_upload, refman_import, downloader, browser_capture]");
    const err = await kit.repo.setGovernance(p.id, looser, { baseSha256: base }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceLooseningError);
    expect((err as GovernanceLooseningError).loosened).toEqual(["captureMethods"]);
    expect(await kit.repo.getGovernanceText(p.id)).toBe(OPEN_GOV);
    await kit.repo.setGovernance(p.id, looser, { baseSha256: base, reason: "IRB amendment 4 approves browser capture" });
    expect(await kit.repo.getGovernanceText(p.id)).toBe(looser);
    const ev = (await auditEvents(kit, p)).filter((e) => e.details?.op === "project.governance");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ reason: "IRB amendment 4 approves browser capture", loosened: ["captureMethods"] });
  });

  it("a stricter edit needs no reason", async () => {
    const stricter = OPEN_GOV.replace(", downloader]", "]");
    await kit.repo.setGovernance(p.id, stricter, { baseSha256: (await kit.repo.getGovernance(p.id)).sha256 });
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

describe("Task 30 review round 1 (R98, R99)", () => {
  it("setGovernance requires the base hash; of two edits from the same base one fails with a conflict", async () => {
    const { sha256 } = await kit.repo.getGovernance(p.id);
    await expect(kit.repo.setGovernance(p.id, OPEN_GOV, {} as never)).rejects.toBeInstanceOf(InvalidInputError);
    const a = OPEN_GOV.replace(", downloader]", "]");
    const b = OPEN_GOV.replace("refman_import, downloader]", "downloader]");
    const results = await Promise.allSettled([kit.repo.setGovernance(p.id, a, { baseSha256: sha256 }), kit.repo.setGovernance(p.id, b, { baseSha256: sha256 })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(GovernanceConflictError);
  });

  it("loosening is judged inside the change against the file as it is then", async () => {
    // Someone tightens the file; a later edit from the new base that re-adds downloader must give a reason.
    const tight = OPEN_GOV.replace(", downloader]", "]");
    await kit.repo.setGovernance(p.id, tight, { baseSha256: (await kit.repo.getGovernance(p.id)).sha256 });
    const base = (await kit.repo.getGovernance(p.id)).sha256;
    await expect(kit.repo.setGovernance(p.id, OPEN_GOV, { baseSha256: base })).rejects.toBeInstanceOf(GovernanceLooseningError);
  });

  it("an unreadable governance.yaml can be replaced, but only with a reason (everything counts as loosened)", async () => {
    const file = join(kit.lib.root, p.folder, "governance.yaml");
    await writeFile(file, "encryption: [this is: not valid");
    const { sha256, yaml } = await kit.repo.getGovernance(p.id);
    expect(yaml).toContain("not valid");
    const err = await kit.repo.setGovernance(p.id, OPEN_GOV, { baseSha256: sha256 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceLooseningError);
    expect((err as GovernanceLooseningError).loosened).toEqual(["(unreadable governance.yaml)"]);
    await kit.repo.setGovernance(p.id, OPEN_GOV, { baseSha256: sha256, reason: "repairing a damaged rules file" });
    expect(await readFile(file, "utf8")).toBe(OPEN_GOV);
    const ev = (await auditEvents(kit, p)).filter((e) => e.details?.op === "project.governance");
    expect(ev.at(-1)!.details).toMatchObject({ reason: "repairing a damaged rules file", repairedUnreadable: true });
  });

  it("tags can be renamed and deleted, collections renamed (governed); deleting a tag removes it from sources", async () => {
    const tag = await kit.repo.createTag(p.id, "kinship");
    const col = await kit.repo.createCollection(p.id, "Delta");
    const sf = await addSource(kit, p, { title: "Tagged", tagIds: [tag.id], collectionIds: [col.id] });
    expect((await kit.repo.renameTag(p.id, tag.id, "family", "#123456")).name).toBe("family");
    expect((await kit.repo.renameCollection(p.id, col.id, "River delta")).name).toBe("River delta");
    const { tags, collections } = await kit.repo.listCollectionsAndTags(p.id);
    expect(tags.map((t) => t.name)).toEqual(["family"]);
    expect(collections.map((c) => c.name)).toEqual(["River delta"]);
    await kit.repo.deleteTag(p.id, tag.id);
    expect((await kit.repo.listCollectionsAndTags(p.id)).tags).toEqual([]);
    expect((await kit.repo.getSource(p.id, sf.source.id)).source.tagIds).toEqual([]);
    await expect(kit.repo.deleteTag(p.id, tag.id)).rejects.toBeInstanceOf(NotFoundError);
    const ops = (await auditEvents(kit, p)).map((e) => e.details?.op);
    expect(ops).toEqual(expect.arrayContaining(["tag.rename", "tag.delete", "collection.rename"]));
  });

  it("updateSource checks collection and tag ids in the same change", async () => {
    const sf = await addSource(kit, p, { title: "Plain" });
    const col = await kit.repo.createCollection(p.id, "C");
    const next = await kit.repo.updateSource(p.id, sf.source.id, { collectionIds: [col.id], issued: "1999" });
    expect(next.source.collectionIds).toEqual([col.id]);
    expect(next.source.issued).toBe("1999");
    await expect(kit.repo.updateSource(p.id, sf.source.id, { tagIds: [newId()] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("browser capture strips scripts, handlers, tokens and signed URL queries, and evaluates the URL's platform", async () => {
    const html =
      '<html><head><meta name="csrf-token" content="SECRETCSRF"><script>var t="SECRETJS"</script></head>' +
      '<body onload="steal()"><img src="https://cdn.example/x.jpg?sig=SIGNED&exp=1"><a href="https://example.org/p?session=SECRETSESSION#f">x</a>' +
      '<input type="hidden" name="authenticity_token" value="SECRETFORM"><scrIpt src="a.js"></SCRIPT>after</body></html>';
    const out = await stripHtmlSnapshot(html);
    for (const bad of ["SECRETCSRF", "SECRETJS", "steal()", "SIGNED", "SECRETSESSION", "SECRETFORM", "a.js"]) expect(out).not.toContain(bad);
    expect(out).toContain("https://cdn.example/x.jpg");
    expect(out).toContain("after");
    // Unclosed script on a large input stays linear (and is dropped to the end).
    const t0 = Date.now();
    await expect(stripHtmlSnapshot("<script>".repeat(100_000))).rejects.toThrow(); // refused by the pre-scan (R104)
    expect(Date.now() - t0).toBeLessThan(10_000);

    const gov = `${OPEN_GOV.replace("downloader]", "downloader, browser_capture]")}protocol:\n  platforms: [youtube]\n`;
    const scoped = await makeProject(kit, gov);
    const input = { url: "https://example.org/article?utm=1", screenshotPng: tinyPng().toString("base64"), html };
    // A web page is platform "other": outside a protocol limited to YouTube.
    await expect(captureBrowserPage(kit.repo, scoped.id, input)).rejects.toBeInstanceOf(PolicyDeniedError);
    const open = await makeProject(kit, OPEN_GOV.replace("downloader]", "downloader, browser_capture]"));
    const r = await captureBrowserPage(kit.repo, open.id, { ...input, extracted: { caption: "Hello", canonicalUrl: "https://example.org/a?token=SECRETTOKEN" } });
    const sf = await kit.repo.getSource(open.id, r.sourceId);
    expect(sf.source.identifiers.platform).toBe("other");
    const page = sf.assets.find((a) => a.kind === "html-snapshot")!;
    const stored = await readFile(join(kit.lib.root, page.path), "utf8");
    expect(stored).not.toContain("SECRETJS");
    expect(JSON.stringify(sf)).not.toContain("SECRETTOKEN");
    await expect(captureBrowserPage(kit.repo, open.id, { url: "ftp://x" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("scrubPaths removes whole paths with spaces, non-ASCII letters and Windows forms", () => {
    expect(scrubPaths('could not open "/home/ana/My Research/interview 1.m4a"', [])).toBe('could not open "<path>"');
    expect(scrubPaths("could not open /Users/josé/Données de terrain/entrevista.wav", [])).toBe("could not open <path>");
    expect(scrubPaths("EACCES: C:\\Users\\Ana María\\Documents\\notas.docx", [])).toBe("EACCES: <path>");
    expect(scrubPaths("conflict on /title and /issued", [])).toBe("conflict on /title and /issued");
    expect(scrubPaths("see /lib/root/Projects/A b/x.pdf", ["/lib/root"])).toBe("see Projects/A b/x.pdf");
  });
});

describe("Task 30 review round 3 (R106)", () => {
  it("OCR jobs of a group are recorded in one governed change", async () => {
    const a = await pdfSource();
    const b = await pdfSource();
    const c = await pdfSource();
    const q = new OcrQueue({ repo: kit.repo });
    expect(await q.enqueueMany(p.id, [a.source.id, b.source.id, c.source.id])).toBe(3);
    const ev = (await auditEvents(kit, p)).filter((e) => e.details?.op === "asset.ocr-pending");
    expect(ev).toHaveLength(3); // one store decision per source …
    expect(new Set(ev.map((e) => e.details?.txn)).size).toBe(1); // … in one change
  });

  it("BatchRefusedError carries a kind", async () => {
    const { BatchRefusedError } = await import("./import/bulk/run.js");
    expect(new BatchRefusedError("x").kind).toBe("invalid");
    expect(new BatchRefusedError("x", true).kind).toBe("denied");
    expect(new BatchRefusedError("x", false, "running").kind).toBe("running");
  });
});
