/**
 * R404 (FR-A13, round 3): every way of reading an encrypted project, with a lock landing at its Nth opening.
 *
 * A seam in the opening primitives (`openingSeam`: `decryptStream`, `openDecryptedHandle`, `openLine`) counts the
 * openings a reading makes and, at the Nth, locks the project (`lockProject`, not awaited) just before that opening
 * happens. One rich encrypted, pseudonymising project is read by every reading in ROWS: first unlocked (its result
 * and its K openings), then once for each N in 1 … K (at most 40 values, evenly spread). Each outcome must be EITHER
 * the unlocked result (or, for the readings that say so, the result the same reading gives with the project locked
 * from the start) OR a rejection as locked (`ProjectLockedError`, `KeyNotAvailableError`); and no trace is left: the
 * project's integrity warnings unchanged, no file of the library changed (audit, attention, review entries, kept
 * files: the folder is hashed before and after), and after an unlock the same reading gives the unlocked result
 * again (no kept copy, no index row poisoned).
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { newId, type Project, type SourceFile } from "@ao/core";
import { MockAgent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProtocolDocuments, listProtocolDocuments } from "../protocol-docs.js";
import { attachConsentDocument } from "../consent-docs.js";
import { KeyNotAvailableError } from "../crypto/format.js";
import { exportBibliography, citeSources } from "../export/bibliography.js";
import { backupProject } from "../export/backup.js";
import { exportProjectOpenFormats } from "../export/project-export.js";
import { buildExport, exportRefman } from "../export/refman-export.js";
import { PASS, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import type { FindEntry } from "../find/types.js";
import { IndexHandle } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { createIndexSink, indexUnlockedProject } from "../index/sink.js";
import { createBulkImport, type BulkImport } from "../import/bulk/index.js";
import { findBatch, readJournal } from "../import/bulk/batch.js";
import { bibtexAdapter } from "../import/refman.js";
import { appendJobRecords, readJobJournal, refreshJobRows, type JobRecord } from "../job-journal.js";
import { HttpClient } from "../lookup/index.js";
import { checkIntegrity, relinkMissing } from "../reconnect.js";
import { readAssetText, transcriptVersions } from "../source-actions.js";
import { openAssetContent } from "../asset-content.js";
import { readTranscript } from "../transcript-segments.js";
import { TRANSCRIBE_KIND, transcriptionRecords } from "../transcription-jobs.js";
import { ProjectLockedError } from "./errors.js";
import { encryptBytes } from "./io.js";
import { readPlain } from "../destruction-record.js";
import { newAttentionId } from "./attention.js";
import {
  deletedHere,
  deletedRecordsTrouble,
  heldWaitingCountIn,
  projectDataKey,
  projectPseudonymMap,
  projectReviewEntries,
  readFindQueueDetailedIn,
  readFindQueueIn,
  appendFindEntriesIn,
} from "./repo.js";
import { openingSeam } from "./testing.js";
import type { WatchRegisterEntry } from "./watch-register.js";

/** The harness's own time limit per row (the machine is shared and heavily loaded). */
const ROW_MS = 30 * 60_000;
/** At most this many lock points per row, evenly spread over its openings. */
const CAP = 40;

const GOV = PSEUDO_GOV.replace("captureMethods: [manual_upload, refman_import, downloader]", "captureMethods: [manual_upload, refman_import, downloader]\nprocessing:\n  metadata_lookup: []");
/** The same with one more capture method: a loosening, which needs a reason (sealed in an encrypted project). */
const LOOSER = GOV.replace("captureMethods: [manual_upload, refman_import, downloader]", "captureMethods: [manual_upload, refman_import, downloader, zotero_import]");

const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the market.\n\n00:00:02.000 --> 00:00:04.500\nObrigado.\n";
const PDF = (n: number) => `%PDF-1.4\n% document ${n}\n${"x".repeat(2000 + n)}\n%%EOF\n`;
const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });

interface Ctx {
  kit: Kit;
  p: Project;
  handle: IndexHandle;
  bulk: BulkImport;
  /** Sources by role. */
  sources: SourceFile[];
  pdf: SourceFile;
  talk: SourceFile;
  paper1: string;
  paper2: string;
  batchId: string;
  batchDir: string;
  watchId: string;
  /** An encrypted original whose file is removed before the relink row and a copy of it found in `relinkDir`. */
  relinkTarget: string;
  relinkCopy: string;
  relinkDir: string;
  exportsDir: string;
  /** The project's audit events below this seq are the ones the audit rows read (unlocks append more). */
  auditSeq: number;
}

interface Row {
  name: string;
  /** Where the reading is (file:line), for the report. */
  where: string;
  run(c: Ctx): Promise<unknown>;
  /** The reading with the project locked from the start: also a right outcome when the lock lands mid-way. */
  locked?: boolean;
  /** The reading writes on success (an export's audit entry, a backup, a relink): files are compared only when it did not succeed. */
  writes?: boolean;
  prepare?(c: Ctx): Promise<void>;
  /**
   * The governed decision (this audit op) is audited BEFORE the reading starts, as every decision is: when the
   * reading is then cut short by the lock, that entry is the one change allowed (it records the decision, nothing
   * read under the wiped key).
   */
  decisionAudited?: string;
}

let c: Ctx;

/** Comparable form: Maps and Sets as sorted arrays, bytes as their SHA-256, errors as name and message. */
function norm(v: unknown): unknown {
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [norm(k), norm(x)]).sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1));
  if (v instanceof Set) return [...v].map(norm).sort();
  if (v instanceof Uint8Array) return `sha256:${createHash("sha256").update(v).digest("hex")}`;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { error: v.name, message: v.message };
  if (typeof v === "function") return "[function]";
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}

/** Every file under `dir`: relative path → SHA-256 (the index's database and its journals left out: the index is checked by reading). */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !e.name.startsWith("library.sqlite") && e.name !== "library.lock") out.set(relative(dir, p), createHash("sha256").update(await readFile(p)).digest("hex"));
    }
  };
  await walk(dir);
  return out;
}

function treeDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) out.push(b.has(k) ? `changed ${k}` : `removed ${k}`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`added ${k}`);
  return out;
}

const isLocked = (e: unknown) => e instanceof ProjectLockedError || e instanceof KeyNotAvailableError;

/** The index's rows of the project (persistent and in memory). */
function indexRows(): unknown {
  const db = c.handle.db;
  return {
    sources: db.prepare("SELECT id, project_id FROM main.sources WHERE project_id = ? ORDER BY id").all(c.p.id),
    memory: db.prepare("SELECT id FROM temp.t_sources WHERE project_id = ? ORDER BY id").all(c.p.id),
  };
}

async function relock(): Promise<void> {
  await c.kit.repo.lockProject(c.p.id);
  await c.kit.repo.unlockProject(c.p.id, PASS);
}

/** Runs `row` once, cold (the project locked and unlocked first: nothing kept), counting its openings. */
async function cold(row: Row, lockAt?: number): Promise<{ outcome: { ok: unknown } | { err: unknown }; openings: number; lock?: Promise<void> }> {
  await relock();
  await row.prepare?.(c);
  let openings = 0;
  let lock: Promise<void> | undefined;
  openingSeam.onOpen = () => {
    openings++;
    if (openings === lockAt) {
      lock = c.kit.repo.lockProject(c.p.id);
      lock.catch(() => {});
    }
  };
  let outcome: { ok: unknown } | { err: unknown };
  try {
    outcome = { ok: norm(await row.run(c)) };
  } catch (err) {
    outcome = { err };
  } finally {
    openingSeam.onOpen = undefined;
  }
  return lock ? { outcome, openings, lock } : { outcome, openings };
}

function lockPoints(k: number): number[] {
  if (k <= CAP) return Array.from({ length: k }, (_, i) => i + 1);
  const out = new Set<number>();
  for (let i = 0; i < CAP; i++) out.add(1 + Math.round((i * (k - 1)) / (CAP - 1)));
  return [...out];
}

async function exercise(row: Row): Promise<void> {
  const base = await cold(row);
  if ("err" in base.outcome) throw new Error(`${row.name}: the unlocked reading failed: ${String((base.outcome as { err: unknown }).err)}`);
  const want = base.outcome.ok;
  expect(base.openings, `${row.name} makes no opening with the key`).toBeGreaterThan(0);
  let lockedWant: unknown;
  if (row.locked) {
    await c.kit.repo.lockProject(c.p.id);
    await row.prepare?.(c);
    try {
      lockedWant = norm(await row.run(c));
    } catch (err) {
      lockedWant = { lockedRunFailed: String(err) };
    }
    await c.kit.repo.unlockProject(c.p.id, PASS);
  }
  await relock();
  const rowsWant = indexRows();
  const problems: string[] = [];
  for (const n of lockPoints(base.openings)) {
    await relock();
    await row.prepare?.(c);
    const warnings = JSON.stringify(c.kit.repo.integrityWarnings);
    const before = await tree(c.kit.lib.root);
    const eventsBefore = (await auditEvents(c.kit, c.p)).length;
    let openings = 0;
    let lock: Promise<void> | undefined;
    openingSeam.onOpen = () => {
      openings++;
      if (openings === n) {
        lock = c.kit.repo.lockProject(c.p.id);
        lock.catch(() => {});
      }
    };
    let outcome: { ok: unknown } | { err: unknown };
    try {
      outcome = { ok: norm(await row.run(c)) };
    } catch (err) {
      outcome = { err };
    } finally {
      openingSeam.onOpen = undefined;
    }
    await lock?.catch(() => {});
    const tag = `${row.name} @${n}/${base.openings}`;
    let succeeded = false;
    if ("err" in outcome) {
      if (!isLocked(outcome.err)) problems.push(`${tag}: rejected with ${(outcome.err as Error)?.name}: ${(outcome.err as Error)?.message}`);
    } else if (JSON.stringify(outcome.ok) === JSON.stringify(want)) {
      succeeded = true;
    } else if (!(row.locked && JSON.stringify(outcome.ok) === JSON.stringify(lockedWant))) {
      problems.push(`${tag}: a different result: ${JSON.stringify(outcome.ok).slice(0, 600)}`);
    }
    if (JSON.stringify(c.kit.repo.integrityWarnings) !== warnings) problems.push(`${tag}: an integrity warning was left: ${JSON.stringify(c.kit.repo.integrityWarnings.slice(-1))}`);
    if (!(row.writes && succeeded)) {
      let diff = treeDiff(before, await tree(c.kit.lib.root));
      if (row.decisionAudited) {
        const added = (await auditEvents(c.kit, c.p)).slice(eventsBefore);
        if (added.every((e) => e.details?.op === row.decisionAudited)) diff = diff.filter((d) => !/^changed Projects\/[^/]+\/audit\/\d+\.jsonl$/.test(d));
        else problems.push(`${tag}: audit entries added: ${added.map((e) => `${e.action}/${String(e.details?.op)}`).join(", ")}`);
      }
      if (diff.length) problems.push(`${tag}: files changed: ${diff.join(", ")}`);
    }
    // After an unlock the same reading gives the full right result; the index holds the same rows.
    await c.kit.repo.unlockProject(c.p.id, PASS);
    await row.prepare?.(c);
    try {
      const again = norm(await row.run(c));
      if (JSON.stringify(again) !== JSON.stringify(want)) problems.push(`${tag}: after the unlock, a different result: ${JSON.stringify(again).slice(0, 600)}`);
    } catch (err) {
      problems.push(`${tag}: after the unlock, rejected with ${(err as Error)?.name}: ${(err as Error)?.message}`);
    }
    await relock();
    if (JSON.stringify(indexRows()) !== JSON.stringify(rowsWant)) problems.push(`${tag}: the index's rows changed: ${JSON.stringify(indexRows()).slice(0, 400)}`);
  }
  if (problems.length) throw new Error(`${row.name}: ${problems.length} problem(s):\n${problems.join("\n")}`);
}

const reg = (i: number, sourceId: string): WatchRegisterEntry => ({
  key: `f-${i}.pdf`,
  file: `f-${i}.pdf`,
  sourceId,
  sha256: "a".repeat(64),
  size: 10,
  mtimeNs: "1763000000123456789",
  state: "in-library",
  at: "2026-11-10T09:30:00.000Z",
});

async function build(): Promise<Ctx> {
  const kit = await makeKit("ao-lock-mid-read-");
  const handle = new IndexHandle(kit.lib.root);
  await kit.reopen({ index: createIndexSink(handle, { root: kit.lib.root, keyRing: kit.ring }) });
  const p = await makeProject(kit, GOV, true, "Rich");
  const sources: SourceFile[] = [];
  // Sources with stored files (PDFs); one is identifiable (its creators pseudonymised).
  for (let i = 0; i < 3; i++) {
    const f = await scratchFile(kit, `paper-${i}.pdf`, PDF(i));
    sources.push(
      await addSource(kit, p, {
        title: `Paper ${i}`,
        creators: [{ family: `Hollis${i}`, given: "Maria", role: "author" }],
        issued: `202${i}`,
        identifiable: i === 0,
        files: [{ path: f, role: "original", handling: "copy" }],
      }),
    );
  }
  const pdf = sources[0]!;
  // Annotations on the first PDF.
  for (let i = 0; i < 2; i++) {
    await kit.repo.createAnnotation(p.id, pdf.source.id, { kind: "highlight", assetId: pdf.assets[0]!.id, anchors: [{ page: i + 1, rects: [{ x: 72, y: 600, w: 200, h: 12 }] }], quote: `quote ${i}`, colorName: "yellow" });
  }
  // A recording with a machine transcript.
  const audio = await scratchFile(kit, "talk.mp3", Buffer.alloc(64, 1));
  const talk0 = await addSource(kit, p, { type: "interview", title: "Talk", files: [{ path: audio, role: "original", handling: "copy" }] });
  const out = await mkdtemp(join(kit.tmp, "vtt-"));
  await writeFile(join(out, "transcript.vtt"), VTT);
  await kit.repo.addDerivedAsset(p.id, talk0.source.id, {
    fromPath: join(out, "transcript.vtt"),
    kind: "transcript",
    lang: "en",
    tool: "whisper-small",
    ext: "vtt",
    metadata: {},
    derivation: { parents: [talk0.assets[0]!.id], operation: "transcribe", provider: "faster-whisper", model: "small", ranAt: "local", params: { model: "small" }, at: "2026-11-10T09:30:00.000Z", triggeredBy: "user" },
  });
  const talk = await kit.repo.getSource(p.id, talk0.source.id);
  sources.push(talk);
  // A source waiting for review (verification), and one flagged by a withdrawal.
  await kit.repo.createSource(
    p.id,
    { projectIds: [], type: "webpage", title: mt("A page"), creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [],
    {
      provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
      reviewItem: { kind: "verification", fields: {}, reasons: ["Check the date."] },
    },
  );
  // A source deleted here that stood for a Zotero item: the sealed record of deletions.
  const gone = await kit.repo.createSource(
    p.id,
    { projectIds: [], type: "book", title: mt("Gone"), creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [],
    { provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false, externalKeys: { zoteroKey: "ABCD1234" } } },
  );
  await kit.repo.deleteSource(p.id, gone.source.id);
  // Fieldwork: a participant with details, a session, consents (one with its signed form, one detached with a reason).
  const part = await kit.repo.createParticipant(p.id, { details: { name: "Maria Hollis", phone: "555-0100" }, legalBasis: "consent" });
  await kit.repo.createSession(p.id, { date: "2026-03-14", place: "The market", participantIds: [part.id], notes: "Rainy", legalBasis: "consent" });
  const form = join(kit.tmp, "form.pdf");
  await writeFile(form, "%PDF-1.7\nconsent form\n%%EOF\n");
  const kept = await kit.repo.createConsent(p.id, { participantId: part.id, scope: "audio", date: "2026-03-14" });
  await attachConsentDocument(kit.repo, p.id, kept.id, form);
  const detached = await kit.repo.createConsent(p.id, { participantId: part.id, scope: "video", date: "2026-03-15" });
  const form2 = join(kit.tmp, "form2.pdf");
  await writeFile(form2, "%PDF-1.7\nsecond consent form\n%%EOF\n");
  await attachConsentDocument(kit.repo, p.id, detached.id, form2);
  await kit.repo.updateConsent(p.id, detached.id, { documentAssetId: null, detachReason: "Zebrafinch: at Maria Hollis's request" });
  await kit.repo.linkSourceToFieldwork(p.id, talk.source.id, { participantIds: [part.id] });
  // Protocol documents.
  const proto = [await scratchFile(kit, "approval.txt", "Approved by the board.\n"), await scratchFile(kit, "amendment.txt", "Amended.\n")];
  expect((await addProtocolDocuments(kit.repo, p.id, proto)).map((r) => r.outcome)).toEqual(["added", "added"]);
  // Sealed audit reasons: a mark set aside, a rules edit (the detach above is the third).
  const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "attention");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${newAttentionId()}.json`), "{ damaged");
  const markId = (await kit.repo.attentionMarks(p.id))[0]!.id;
  await kit.repo.setAsideMark(p.id, markId, "Zebrafinch: checked by hand");
  const g = await kit.repo.getGovernance(p.id);
  await kit.repo.setGovernance(p.id, LOOSER, { baseSha256: g.sha256, reason: "Zebrafinch: the board allowed it" });
  // The Find queue.
  const entries: FindEntry[] = Array.from({ length: 3 }, (_, i) => ({
    id: newId(),
    projectId: p.id,
    typed: `Quillfeather ${i}, Zorblatt Grammar`,
    state: "looking-up",
    createdAt: "2026-11-10T09:30:00.000Z",
    updatedAt: "2026-11-10T09:30:00.000Z",
    attempts: 0,
  }));
  await appendFindEntriesIn(kit.repo, p.id, entries, "add");
  // A watched folder's register.
  const watchId = newId();
  await kit.repo.recordWatchedFiles(p.id, watchId, [reg(0, sources[1]!.source.id), reg(1, sources[2]!.source.id), reg(2, newId())]);
  // Pending worker jobs in the journal.
  const key = projectDataKey(kit.repo, p.id)!;
  const job = (i: number, status: JobRecord["status"]): JobRecord => ({
    v: 1,
    id: newId(),
    projectId: p.id,
    kind: TRANSCRIBE_KIND,
    status,
    createdAt: `2026-11-10T09:3${i}:00.000Z`,
    updatedAt: `2026-11-10T09:3${i}:00.000Z`,
    about: { sourceId: talk.source.id, model: "small" },
    ...(status === "queued" ? { job: { type: "audio.transcribe" as const, input: "x", output: "y", params: { model: "small" } } } : { error: "FAILED" }),
  });
  await appendJobRecords(kit.lib.root, kit.repo.getProject(p.id).folder, key, [job(0, "queued"), job(1, "failed"), job(2, "queued")]);
  // An import batch (its record, journal, snapshots and report) from a reference manager's export.
  const agent = new MockAgent();
  agent.disableNetConnect();
  const bulk = createBulkImport({ repo: kit.repo, http: new HttpClient({ libraryRoot: kit.lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
  const bib = join(import.meta.dirname, "..", "..", "tests", "fixtures", "refman", "sample.bib");
  const h = await bulk.startBatch(p.id, bibtexAdapter(bib));
  await h.done;
  const batch = (await bulk.listBatches(p.id))[0]!;
  const batchRec = await findBatch(kit.repo, p.id, batch.batchId);
  expect(batchRec).toBeDefined();
  // A sealed file in the retention folder (what a destruction certificate is), read by readPlain.
  const retention = join(kit.lib.root, kit.repo.getProject(p.id).folder, "retention");
  await mkdir(retention, { recursive: true });
  await writeFile(join(retention, "probe.json.enc"), await encryptBytes(key.key, key.keyId, JSON.stringify({ probe: true })));
  // A backup.
  await backupProject(kit.repo, p.id);
  // An encrypted original to relink: a copy of it in a search folder; the original is removed by the relink row.
  const relinkTarget = join(kit.lib.root, ...sources[2]!.assets[0]!.path.split("/"));
  const relinkDir = await mkdtemp(join(kit.tmp, "relink-"));
  const relinkCopy = join(relinkDir, "kept-copy.enc");
  await copyFile(relinkTarget, relinkCopy);
  const exportsDir = await mkdtemp(join(kit.tmp, "exports-"));
  const ctx: Ctx = {
    kit,
    p,
    handle,
    bulk,
    sources: kit.repo.listSourceIds(p.id).map((id) => ({ id }) as unknown as SourceFile),
    pdf,
    talk,
    paper1: sources[1]!.source.id,
    paper2: sources[2]!.source.id,
    batchId: batch.batchId,
    batchDir: "",
    watchId,
    relinkTarget,
    relinkCopy,
    relinkDir,
    exportsDir,
    auditSeq: 0,
  };
  ctx.sources = [];
  for (const id of kit.repo.listSourceIds(p.id).sort()) ctx.sources.push(await kit.repo.getSource(p.id, id));
  const { events } = await kit.repo.readAudit(p.id, { limit: 1 });
  ctx.auditSeq = (events[0]?.seq ?? 0) + 1;
  await agent.close();
  return ctx;
}

const ids = () => c.sources.map((s) => s.source.id);
/** Two sources not identifiable (an identifiable one cannot be cited without a participant code). */
const plainIds = () => [c.paper1, c.paper2];
const fresh = async () => mkdtemp(join(c.exportsDir, "x-"));
async function treeOf(dir: string): Promise<unknown> {
  return [...(await tree(dir)).entries()].sort();
}

const ROWS: Row[] = [
  // ---- sources and their files ----
  { name: "getSource (every source)", where: "repo/repo.ts:254 → repo/sources.ts:133", run: async () => Promise.all(ids().map((id) => c.kit.repo.getSource(c.p.id, id))) },
  { name: "getSourceRecord (every source)", where: "repo/repo.ts:258 → repo/sources.ts:165", run: async () => Promise.all(ids().map((id) => c.kit.repo.getSourceRecord(c.p.id, id))) },
  { name: "getSourceRecordWithAssets (every source)", where: "repo/repo.ts:262 → repo/sources.ts:206", run: async () => Promise.all(ids().map((id) => c.kit.repo.getSourceRecordWithAssets(c.p.id, id))) },
  { name: "listAnnotations", where: "repo/repo.ts:290 → repo/annotations.ts", run: async () => c.kit.repo.listAnnotations(c.p.id, c.pdf.source.id) },
  { name: "readTranscript", where: "transcript-segments.ts:305", run: async () => readTranscript(c.kit.repo, c.p.id, c.talk.source.id, transcriptVersions(c.talk)[0]!.id) },
  { name: "readAssetText (the transcript)", where: "source-actions.ts:122 (decrypt :132)", run: async () => readAssetText(c.kit.repo, c.p.id, c.talk.source.id, transcriptVersions(c.talk)[0]!.id) },
  {
    name: "openAssetContent (a whole stored PDF)",
    where: "asset-content.ts:58 (open :100)",
    run: async () => {
      const a = await openAssetContent(c.kit.repo, c.p.id, c.pdf.source.id, c.pdf.assets[0]!.id, () => true);
      try {
        return await a.read(0, a.size);
      } finally {
        await a.close();
      }
    },
  },
  // ---- fieldwork, review, queues, registers, journals ----
  { name: "getFieldwork", where: "repo/repo.ts:475 → repo/fieldwork.ts:159", run: async () => c.kit.repo.getFieldwork(c.p.id) },
  { name: "projectPseudonymMap", where: "repo/repo.ts:1562 → repo/pseudonyms.ts:22", run: async () => projectPseudonymMap(c.kit.repo, c.p.id) },
  { name: "projectReviewEntries", where: "repo/repo.ts:1113 → repo/review.ts:438", run: async () => projectReviewEntries(c.kit.repo, c.p.id) },
  { name: "bulk.listProjectReview", where: "import/bulk/review.ts (listProjectReview)", run: async () => c.bulk.listProjectReview(c.p.id) },
  { name: "readFindQueueIn", where: "repo/repo.ts:1321 → find/queue-store.ts:331", run: async () => readFindQueueIn(c.kit.repo, c.p.id) },
  { name: "readFindQueueDetailedIn", where: "repo/repo.ts:1326 → find/queue-store.ts", run: async () => readFindQueueDetailedIn(c.kit.repo, c.p.id) },
  { name: "heldWaitingCountIn", where: "repo/repo.ts:1344 → repo/review.ts:560", run: async () => heldWaitingCountIn(c.kit.repo, c.p.id) },
  { name: "watchRegister", where: "repo/repo.ts:423 → repo/watch-register.ts:131", run: async () => c.kit.repo.watchRegister(c.p.id, c.watchId) },
  { name: "watchOrigins", where: "repo/repo.ts:431 → repo/watch-register.ts", run: async () => c.kit.repo.watchOrigins(c.p.id, c.sources[1]!.source.id) },
  {
    name: "readJobJournal (key taken before the read, as its callers do)",
    where: "job-journal.ts:172 (open :157)",
    run: async () => readJobJournal(c.kit.lib.root, c.kit.repo.getProject(c.p.id).folder, c.p.id, projectDataKey(c.kit.repo, c.p.id)),
  },
  {
    name: "refreshJobRows (resumePending's and the index's read of the journal)",
    where: "job-journal.ts:349; worker-client.ts:321; index/sink.ts:66",
    run: async () => {
      const writes: unknown[] = [];
      const db = () => ({ prepare: (sql: string) => ({ run: (...a: unknown[]) => writes.push([sql, a]), all: () => [], get: () => undefined }), transaction: (fn: () => void) => fn }) as never;
      const j = await refreshJobRows(db, c.kit.lib.root, c.kit.repo.getProject(c.p.id).folder, c.p.id, projectDataKey(c.kit.repo, c.p.id));
      return { records: j.records, writes: writes.length };
    },
  },
  { name: "transcriptionRecords", where: "transcription-jobs.ts:112", run: async () => transcriptionRecords(c.kit.repo, c.p.id) },
  // ---- import batches ----
  { name: "bulk.listBatches", where: "import/bulk/batch.ts:221 (readProjectText :206)", run: async () => c.bulk.listBatches(c.p.id) },
  { name: "bulk.listReview (the batch)", where: "import/bulk/review.ts", run: async () => c.bulk.listReview(c.p.id, c.batchId) },
  { name: "bulk.batchReport", where: "import/bulk/report.ts", run: async () => c.bulk.batchReport(c.p.id, c.batchId) },
  {
    name: "findBatch and readJournal",
    where: "import/bulk/batch.ts:239, :273 (open :282)",
    run: async () => {
      const rec = await findBatch(c.kit.repo, c.p.id, c.batchId);
      return { rec, journal: await readJournal(c.kit.repo, c.p.id, (rec as { dir?: string } | undefined)?.dir ?? "") };
    },
  },
  // ---- protocol and consent documents, attention, warnings ----
  { name: "listProtocolDocuments", where: "protocol-docs.ts:139 (readManifest :68)", run: async () => listProtocolDocuments(c.kit.repo, c.p.id) },
  {
    name: "deletedHere and deletedRecordsTrouble",
    where: "repo/repo.ts:1140, :1151 → repo/tombstones.ts:62",
    run: async () => ({ here: (await deletedHere(c.kit.repo, c.p.id))?.("ABCD1234") ?? "unreadable", other: (await deletedHere(c.kit.repo, c.p.id))?.("ZZZZ0000") ?? "unreadable", trouble: await deletedRecordsTrouble(c.kit.repo, c.p.id) }),
  },
  { name: "listCollectionsAndTags", where: "repo/repo.ts:480", run: async () => c.kit.repo.listCollectionsAndTags(c.p.id) },
  // ---- the audit log and its sealed reasons ----
  {
    name: "readAudit (sealed reasons shown)",
    where: "repo/repo.ts:349 (withProjectReasons :1626) → repo/audit-reasons.ts:108",
    run: async () => (await c.kit.repo.readAudit(c.p.id, { limit: 1000, beforeSeq: c.auditSeq })).events,
  },
  // ---- retention ----
  {
    name: "readPlain (a sealed retention file: certificates, destruction records)",
    where: "destruction-record.ts:145 (decrypt :157); retention.ts:457, :465, :558, :972; restore-record.ts:71",
    run: async () => readPlain(c.kit.repo, c.p.id, `${c.kit.repo.getProject(c.p.id).folder}/retention/probe.json.enc`),
  },
  // ---- exports and backups ----
  { name: "buildExport (BibTeX)", where: "export/refman-export.ts:301", run: async () => buildExport(c.kit.repo, c.p.id, ids(), "bibtex") },
  { name: "exportRefman (RIS, audited)", where: "export/refman-export.ts:356", writes: true, run: async () => exportRefman(c.kit.repo, c.p.id, ids(), "ris") },
  { name: "exportBibliography", where: "export/bibliography.ts:226", writes: true, run: async () => {
    const { path: _written, ...r } = await exportBibliography(c.kit.repo, c.p.id, { sourceIds: plainIds() }, "apa", "text");
    return r; // the file written gets a new name each time
  } },
  { name: "citeSources", where: "export/bibliography.ts:159", writes: true, run: async () => citeSources(c.kit.repo, c.p.id, [{ sourceId: c.sources[1]!.source.id }], "apa", "text") },
  {
    name: "exportProjectOpenFormats",
    where: "export/project-export.ts:248 (decryptStream :377, :412)",
    writes: true,
    run: async () => {
      const d = await fresh();
      const r = await exportProjectOpenFormats(c.kit.repo, c.p.id, d);
      void r;
      return treeOf(d);
    },
  },
  { name: "backupProject (a backup made)", where: "export/backup.ts:1038", writes: true, decisionAudited: "backup.create", run: async () => ((await backupProject(c.kit.repo, c.p.id, { prune: false })) ? "made" : "none") },
  // ---- integrity, relinking, the index ----
  { name: "checkIntegrity (quick)", where: "reconnect.ts:469 (expectedFiles :428)", locked: true, run: async () => checkIntegrity(c.kit.lib, 0.05, { keyRing: c.kit.ring }) },
  { name: "checkIntegrity (full)", where: "reconnect.ts:469 (hashStream :512)", locked: true, run: async () => checkIntegrity(c.kit.lib, "full", { keyRing: c.kit.ring }) },
  {
    name: "rebuildIndex",
    where: "index/rebuild.ts:83 (populate :274)",
    locked: true,
    run: async () => {
      const r = await rebuildIndex(c.handle, c.kit.ring, c.kit.lib);
      return { result: r, rows: indexRows() };
    },
  },
  {
    name: "indexUnlockedProject",
    where: "index/sink.ts:18",
    locked: true,
    run: async () => {
      const r = await indexUnlockedProject(c.handle.db, c.kit.lib.root, c.kit.ring, c.p.id);
      return { result: r, rows: indexRows() };
    },
  },
  {
    name: "relinkMissing (an encrypted original)",
    where: "reconnect.ts:823 (hashOf :857, verify :961)",
    locked: true,
    writes: true,
    prepare: async (x) => {
      await rm(x.relinkTarget, { force: true });
    },
    run: async () => {
      const r = await relinkMissing(c.kit.lib, c.relinkDir, c.kit.repo, { keyRing: c.kit.ring });
      return r;
    },
  },
];

beforeAll(async () => {
  c = await build();
}, ROW_MS);

afterAll(async () => {
  openingSeam.onOpen = undefined;
  // The relinked original back in place (for nothing else here; the folder goes).
  await copyFile(c.relinkCopy, c.relinkTarget).catch(() => {});
  c.handle.close();
  await c.kit.close();
});

describe("R404: a lock at the Nth opening of every reading of an encrypted project", () => {
  it("the seam counts openings and the lock lands at the one asked for", async () => {
    const row = ROWS[0]!;
    const base = await cold(row);
    expect(base.openings).toBeGreaterThan(1);
    const at1 = await cold(row, 1);
    await at1.lock;
    expect("err" in at1.outcome && isLocked(at1.outcome.err)).toBe(true);
    expect(c.kit.repo.isUnlocked(c.p.id)).toBe(false);
    await c.kit.repo.unlockProject(c.p.id, PASS);
  }, ROW_MS);

  for (const row of ROWS) {
    it(`${row.name} — ${row.where}`, async () => {
      await exercise(row);
    }, ROW_MS);
  }
});
