/**
 * Per-project hash-chained audit log (`<Project>/audit/NNNN.jsonl`, one sealed
 * event per line, a new segment every 10,000 events) plus the external anchor
 * (R12): the latest head {seq, hash} of every project, kept in
 * `<appConfigDir>/audit-anchors.json`, outside the library folder, so that a
 * rewrite or truncation of the log inside the library is noticed on open.
 */
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { sealEvent, verifyChain, type AuditEvent, type AuditVerifyResult } from "@ao/core";
import { renameWithRetry, writeFileAtomic, writeSmallFileAtomic } from "../fs/atomic.js";
import { SimulatedCrash, seams } from "./seams.js";
import { appendDurable, assertContained, readMaybe, stripUndefined, undoAppend, type AppendUndo } from "./io.js";

export const AUDIT_SEGMENT_SIZE = 10_000;
const SEGMENT = /^(\d{4,})\.jsonl$/;

export type Head = { seq: number; hash: string };
export type AuditInput = Omit<AuditEvent, "hash" | "prevHash" | "seq">;

export interface IntegrityWarning {
  /** A project id, or "*" for library-level problems (e.g. an unreadable anchors file). */
  projectId: string;
  kind:
    | "chain-broken"
    /** The sealed list of protocol document names cannot be read (R119); the documents are kept. */
    | "protocol-manifest-unreadable"
    | "head-mismatch"
    | "truncated"
    | "empty"
    | "anchor-missing"
    | "anchors-unreadable"
    | "rolled-back-incomplete-write"
    | "invalid-txn-marker"
    | "incomplete-write-pending"
    | "txn-recovery-skipped-audit-unverifiable"
    /** An incomplete last line (cut off by a crash) was removed from an audit segment or change log (R28). */
    | "trimmed-incomplete-audit-line"
    /** Such a line was found but left in place: read-only library, or an unresolved interrupted change. */
    | "incomplete-audit-line-pending"
    /** An audit event could not be appended while opening; the project refuses writes until reopened. */
    | "audit-append-failed-at-open"
    /** Actions whose audit entry (or file permissions) could not be written at the time were recorded on this open (Task 50). */
    | "audit-recorded-late"
    /** A refusal could not be recorded in the library's audit log (Task 50). */
    | "audit-unrecorded"
    /** The project's record of sources deleted here could not be read; set aside (R74 I2). */
    | "deleted-records-unreadable"
    /** A source's annotations file is missing or damaged; the source is read without annotations (R77). */
    | "annotations-unreadable"
    /** A source's annotations file does not match its recorded hash; read as it is (R77). */
    | "annotations-hash-mismatch"
    /** Files destroyed under the retention rule could not be overwritten yet; retried on each open (R94). */
    | "destroy-incomplete"
    /** A staged recovery-code key file that is not the committed one was removed, not activated (R148). */
    | "recovery-staging-discarded"
    /** A staged recovery-code key file was left in place, not activated: the audit log does not verify (R148). */
    | "recovery-staging-unverifiable";
  detail: string;
  /** Library-relative file, for the two incomplete-line kinds. */
  file?: string;
  /** Size of the incomplete line in bytes, for the two incomplete-line kinds. */
  bytes?: number;
}

/** Segment file names in `dir`, oldest first (empty when the folder is missing). */
export async function auditSegments(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => SEGMENT.test(n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.sort((a, b) => Number(SEGMENT.exec(a)![1]) - Number(SEGMENT.exec(b)![1]));
}

export class AuditStore {
  constructor(
    public dir: string,
    public head: Head | null,
    private readonly segmentSize: number = AUDIT_SEGMENT_SIZE,
  ) {}

  /**
   * Reads every segment in order. Unparseable lines become `null` (which verifyChain rejects).
   * An incomplete last line of the last segment (no newline: cut off by a crash) is not an event
   * and is left out (R28); openRepo reports it and, when it may, trims it.
   */
  static async read(dir: string): Promise<Array<AuditEvent | null>> {
    const names = await auditSegments(dir);
    const out: Array<AuditEvent | null> = [];
    for (const [i, n] of names.entries()) {
      const lines = (await fsp.readFile(join(dir, n), "utf8")).split("\n");
      // After a final newline the last piece is ""; anything else there is an incomplete line.
      if (i === names.length - 1) lines.pop();
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          out.push(JSON.parse(line) as AuditEvent);
        } catch {
          out.push(null);
        }
      }
    }
    return out;
  }

  /** Opens the log: returns the store (appending after the last readable event) and the chain check. */
  static async load(
    dir: string,
    segmentSize = AUDIT_SEGMENT_SIZE,
  ): Promise<{ store: AuditStore; events: Array<AuditEvent | null>; verify: AuditVerifyResult }> {
    const events = await AuditStore.read(dir);
    const verify = verifyChain(events as AuditEvent[]);
    let head: Head | null = null;
    for (let i = events.length - 1; i >= 0 && head === null; i--) {
      const e = events[i];
      if (e && typeof e.seq === "number" && typeof e.hash === "string") head = { seq: e.seq, hash: e.hash };
    }
    return { store: new AuditStore(dir, head, segmentSize), events, verify };
  }

  segmentName(seq: number): string {
    return `${String(Math.ceil(seq / this.segmentSize)).padStart(4, "0")}.jsonl`;
  }

  /** Seals and durably appends one event. Returns an undo that removes it again. */
  async append(
    input: AuditInput,
    onPlan?: (u: AppendUndo) => Promise<void>,
  ): Promise<{ event: AuditEvent; undo: () => Promise<void> }> {
    const event = sealEvent(stripUndefined(input), this.head);
    if (seams.failAuditAppendFor !== undefined && seams.failAuditAppendFor === input.projectId) {
      throw new Error("simulated audit append failure");
    }
    // The audit folder and segment must really be inside the project folder: an event must never
    // be written through a symbolic link, whether or not a transaction is running.
    const path = join(this.dir, this.segmentName(event.seq));
    await assertContained(dirname(this.dir), path);
    await fsp.mkdir(this.dir, { recursive: true });
    const prevHead = this.head;
    if (seams.crashAt === "torn-audit") {
      // Test seam: the process dies halfway through writing this event's line.
      seams.crashAt = undefined;
      const line = JSON.stringify(event);
      await appendDurable(path, line.slice(0, line.length >> 1), undefined, onPlan);
      throw new SimulatedCrash("simulated crash while writing an audit line");
    }
    const u = await appendDurable(path, `${JSON.stringify(event)}\n`, undefined, onPlan);
    this.head = { seq: event.seq, hash: event.hash };
    return {
      event,
      undo: async () => {
        await undoAppend(u);
        this.head = prevHead;
      },
    };
  }
}

export type AnchorProblemKind = "chain-broken" | "head-mismatch" | "truncated" | "empty" | "anchor-missing";

/**
 * Compares a project's log with its recorded anchor. `null` means consistent (or nothing to compare).
 *
 * R82: a log with no events is never valid (every project's log starts with its creation). With no
 * anchor for the project on this computer, a log holding any event written by this device
 * (`deviceId`) is 'anchor-missing': this computer anchored it before, so the anchor was removed or
 * lost and a truncation could hide behind it. A log this device never wrote to has nothing to be
 * compared with here (unverified, not a problem).
 *
 * Known limit: rolling the anchors file back to an older head together with a matching truncation
 * of the log is not detectable (no anchor history is kept).
 */
export function checkAnchor(
  events: Array<AuditEvent | null>,
  verify: AuditVerifyResult,
  anchor: Head | undefined,
  deviceId?: string,
): { kind: AnchorProblemKind; detail: string } | null {
  if (!verify.ok) {
    return { kind: "chain-broken", detail: `audit chain breaks at event ${verify.brokenAt + 1} (${verify.reason}); the audit log changed outside the app` };
  }
  if (events.length === 0) return { kind: "empty", detail: "the audit log is empty; the audit log changed outside the app" };
  if (!anchor) {
    if (deviceId !== undefined && events.some((e) => e?.device === deviceId)) {
      return { kind: "anchor-missing", detail: "this computer wrote to the audit log but its record of the log's head is missing; the audit log may have changed outside the app" };
    }
    return null;
  }
  const seq = verify.head?.seq ?? 0;
  if (seq < anchor.seq) {
    return { kind: "truncated", detail: `audit log ends at event ${seq} but event ${anchor.seq} was recorded; the audit log changed outside the app` };
  }
  // The chain verified, so events[i] has seq i + 1. Later events may come from another device.
  if (events[anchor.seq - 1]?.hash !== anchor.hash) {
    return { kind: "head-mismatch", detail: `audit event ${anchor.seq} differs from the recorded head; the audit log changed outside the app` };
  }
  return null;
}

interface AnchorsJson {
  formatVersion: 1;
  anchors: Record<string, Head & { at: string }>;
}

/** The anchors file exists but cannot be parsed or has the wrong shape. */
export class AnchorsUnreadableError extends Error {
  override name = "AnchorsUnreadableError";
}

type Anchors = AnchorsJson["anchors"];

function validAnchors(v: unknown): v is AnchorsJson {
  if (!v || typeof v !== "object") return false;
  const a = (v as Partial<AnchorsJson>).anchors;
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  return Object.values(a).every(
    (h) => !!h && typeof h === "object" && Number.isSafeInteger((h as Head).seq) && typeof (h as Head).hash === "string",
  );
}

/** `<appConfigDir>/audit-anchors.json`, keyed by `libraryId/projectId`. */
export class AnchorStore {
  constructor(readonly path: string) {}

  static forConfigDir(appConfigDir: string): AnchorStore {
    return new AnchorStore(join(appConfigDir, "audit-anchors.json"));
  }

  /** Throws AnchorsUnreadableError when the file exists but is unparseable or the wrong shape. */
  async readAll(): Promise<Anchors> {
    const raw = await readMaybe(this.path);
    if (!raw) return {};
    let j: unknown;
    try {
      j = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AnchorsUnreadableError("audit-anchors.json is not valid JSON");
    }
    if (!validAnchors(j)) throw new AnchorsUnreadableError("audit-anchors.json has an unexpected shape");
    return j.anchors;
  }

  /** Moves an unreadable anchors file aside (never deleted: it is evidence). Returns the new path. */
  async moveAside(stamp: string): Promise<string> {
    const to = `${this.path}.corrupt-${stamp.replace(/[:.]/g, "-")}`;
    await renameWithRetry(this.path, to);
    return to;
  }

  /** Records a head. Refuses (throws) rather than overwrite an unreadable file. */
  async set(key: string, head: Head, at: string): Promise<void> {
    const anchors = await this.readAll();
    anchors[key] = { seq: head.seq, hash: head.hash, at };
    await fsp.mkdir(join(this.path, ".."), { recursive: true });
    const body: AnchorsJson = { formatVersion: 1, anchors };
    await writeSmallFileAtomic(this.path, JSON.stringify(body, null, 2), { mode: 0o600 });
  }
}
