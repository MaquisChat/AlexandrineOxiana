/**
 * Per-project hash-chained audit log (`<Project>/audit/NNNN.jsonl`, one sealed
 * event per line, a new segment every 10,000 events) plus the external anchor
 * (R12): the latest head {seq, hash} of every project, kept in
 * `<appConfigDir>/audit-anchors.json`, outside the library folder, so that a
 * rewrite or truncation of the log inside the library is noticed on open.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { sealEvent, verifyChain, type AuditEvent, type AuditVerifyResult } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { appendDurable, readMaybe, stripUndefined, undoAppend } from "./io.js";

export const AUDIT_SEGMENT_SIZE = 10_000;
const SEGMENT = /^(\d{4,})\.jsonl$/;

export type Head = { seq: number; hash: string };
export type AuditInput = Omit<AuditEvent, "hash" | "prevHash" | "seq">;

export interface IntegrityWarning {
  projectId: string;
  kind: "chain-broken" | "head-mismatch" | "truncated";
  detail: string;
}

export class AuditStore {
  constructor(
    public dir: string,
    public head: Head | null,
    private readonly segmentSize: number = AUDIT_SEGMENT_SIZE,
  ) {}

  /** Reads every segment in order. Unparseable lines become `null` (which verifyChain rejects). */
  static async read(dir: string): Promise<Array<AuditEvent | null>> {
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).filter((n) => SEGMENT.test(n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    names.sort((a, b) => Number(SEGMENT.exec(a)![1]) - Number(SEGMENT.exec(b)![1]));
    const out: Array<AuditEvent | null> = [];
    for (const n of names) {
      for (const line of (await fsp.readFile(join(dir, n), "utf8")).split("\n")) {
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
  async append(input: AuditInput): Promise<{ event: AuditEvent; undo: () => Promise<void> }> {
    const event = sealEvent(stripUndefined(input), this.head);
    await fsp.mkdir(this.dir, { recursive: true });
    const prevHead = this.head;
    const u = await appendDurable(join(this.dir, this.segmentName(event.seq)), `${JSON.stringify(event)}\n`);
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

/** Compares a project's log with its recorded anchor. `null` means consistent (or nothing to compare). */
export function checkAnchor(
  events: Array<AuditEvent | null>,
  verify: AuditVerifyResult,
  anchor: Head | undefined,
): { kind: IntegrityWarning["kind"]; detail: string } | null {
  if (!verify.ok) {
    return { kind: "chain-broken", detail: `audit chain breaks at event ${verify.brokenAt + 1} (${verify.reason}); the audit log changed outside the app` };
  }
  if (!anchor) return null;
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

/** `<appConfigDir>/audit-anchors.json`, keyed by `libraryId/projectId`. */
export class AnchorStore {
  constructor(private readonly path: string) {}

  static forConfigDir(appConfigDir: string): AnchorStore {
    return new AnchorStore(join(appConfigDir, "audit-anchors.json"));
  }

  async readAll(): Promise<AnchorsJson["anchors"]> {
    const raw = await readMaybe(this.path);
    if (!raw) return {};
    try {
      const j = JSON.parse(raw.toString("utf8")) as Partial<AnchorsJson>;
      return j && typeof j.anchors === "object" && j.anchors !== null ? j.anchors : {};
    } catch {
      return {};
    }
  }

  async set(key: string, head: Head, at: string): Promise<void> {
    const anchors = await this.readAll();
    anchors[key] = { seq: head.seq, hash: head.hash, at };
    await fsp.mkdir(join(this.path, ".."), { recursive: true });
    const body: AnchorsJson = { formatVersion: 1, anchors };
    await writeFileAtomic(this.path, JSON.stringify(body, null, 2), { mode: 0o600 });
  }
}
