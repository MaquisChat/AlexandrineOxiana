/**
 * What a project needs attention for after an action that was not undone (R28, R82: never silent;
 * Task 50). Two kinds, each a small file `<Project>/attention/<id>.json` (owner-only, no absolute
 * paths, no secrets):
 *
 * - `audit-unrecorded`: an action happened (or may have happened) but its audit event could not be
 *   written: a library move, split, old-copy deletion, reconnect or relink, or a refusal of a move.
 *   Relink writes the record BEFORE it copies anything (`state: "intent"`), so a crash between the
 *   copy and its audit event leaves the record; the others write it when the append fails (their
 *   own journals cover a crash before that). The project shows the standing warning
 *   `audit-unrecorded` while a record exists.
 * - `permissions-not-set`: a file was restored to the library but its owner-only permissions could
 *   not be set. The file stays; the warning `permissions-not-set` stands until they are set.
 *
 * Each writable open repairs what it can (`settleAttention`): an unrecorded event is appended to
 * the project's audit log with `details.recordedLate` (when it happened, why it was late, whether
 * the action was interrupted) and `details.attentionId`, which makes the repair idempotent (a crash
 * between the append and removing the record does not record it twice); permissions are set again
 * and recorded as `library.permissions-restricted`. A repair raises the open's warning
 * `audit-recorded-late`. What cannot be repaired keeps its record and its warning. A record that
 * cannot be read is never removed and counts as `audit-unrecorded`.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { absPath, assertContained, readMaybe } from "./io.js";
import { parseProjectJson, type ProjectState, type RepoCore } from "./state.js";

export const ATTENTION_DIR = "attention";
export const AUDIT_UNRECORDED_WARNING = "audit-unrecorded";
export const PERMISSIONS_NOT_SET_WARNING = "permissions-not-set";
const MODE = 0o600;
const NAME = /^[0-9a-f]{16,64}\.json$/;

export interface UnrecordedAudit {
  formatVersion: 1;
  id: string;
  kind: "audit-unrecorded";
  /** When the action happened (or, for `intent`, began). */
  occurredAt: string;
  actor: string;
  device: string;
  /** The audit event's action, e.g. `library.move`, or the policy action of a refusal (`move`). */
  action: string;
  /** Present for a refusal. */
  decision?: { result: "deny"; reason: string };
  details: Record<string, unknown>;
  /** `intent`: written before the action; it may not have finished. `ready`: the action finished. */
  state: "intent" | "ready";
  /** Why the event could not be written: an error code or name, never a message (it may hold paths). */
  reason?: string;
}

export interface PermissionsNotSet {
  formatVersion: 1;
  id: string;
  kind: "permissions-not-set";
  occurredAt: string;
  actor: string;
  device: string;
  /** Library-relative files whose permissions must be `mode`. */
  files: string[];
  mode: number;
  /** The audit action of the restore that placed them, e.g. `library.relink`. */
  action: string;
}

export type AttentionRecord = UnrecordedAudit | PermissionsNotSet;

export const newAttentionId = () => randomBytes(16).toString("hex");

/** An error code or name for a record: never the message, which can name absolute paths. */
export function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)) return code;
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z]{1,64}$/.test(name) ? name : "Error";
}

const dirOf = (root: string, projectRel: string) => absPath(root, `${projectRel}/${ATTENTION_DIR}`);

/** Writes (or replaces) one record in `<root>/<projectRel>/attention/`. */
export async function writeAttention(root: string, projectRel: string, rec: AttentionRecord): Promise<void> {
  const dir = dirOf(root, projectRel);
  const file = join(dir, `${rec.id}.json`);
  const projectDir = absPath(root, projectRel);
  await assertContained(projectDir, file);
  await fsp.mkdir(dir, { recursive: true });
  await assertContained(projectDir, file);
  await writeFileAtomic(file, JSON.stringify(rec, null, 2), { mode: MODE });
}

export async function removeAttention(root: string, projectRel: string, id: string): Promise<void> {
  const file = join(dirOf(root, projectRel), `${id}.json`);
  await assertContained(absPath(root, projectRel), file);
  await fsp.unlink(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

function parseRecord(v: unknown, id: string): AttentionRecord | null {
  const o = v as Partial<AttentionRecord> | null;
  if (!o || typeof o !== "object" || o.formatVersion !== 1 || o.id !== id) return null;
  if (typeof o.occurredAt !== "string" || typeof o.actor !== "string" || typeof o.device !== "string" || typeof o.action !== "string") return null;
  if (o.kind === "audit-unrecorded") {
    const u = o as Partial<UnrecordedAudit>;
    if (!u.details || typeof u.details !== "object" || Array.isArray(u.details) || (u.state !== "intent" && u.state !== "ready")) return null;
    if (u.decision !== undefined && (u.decision?.result !== "deny" || typeof u.decision.reason !== "string")) return null;
    return o as UnrecordedAudit;
  }
  if (o.kind === "permissions-not-set") {
    const p = o as Partial<PermissionsNotSet>;
    if (!Array.isArray(p.files) || !p.files.every((f) => typeof f === "string") || !Number.isInteger(p.mode)) return null;
    return o as PermissionsNotSet;
  }
  return null;
}

/** The project's records; `unreadable` counts files that are not valid records (kept, never removed). */
export async function readAttention(root: string, projectRel: string): Promise<{ records: AttentionRecord[]; unreadable: number }> {
  let names: string[];
  try {
    names = await fsp.readdir(dirOf(root, projectRel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], unreadable: 0 };
    return { records: [], unreadable: 1 };
  }
  const records: AttentionRecord[] = [];
  let unreadable = 0;
  for (const n of names.sort()) {
    if (n.includes(".tmp-")) continue; // an interrupted atomic write: never a record
    if (!NAME.test(n)) {
      unreadable++;
      continue;
    }
    let rec: AttentionRecord | null = null;
    try {
      const raw = await readMaybe(join(dirOf(root, projectRel), n));
      rec = raw ? parseRecord(JSON.parse(raw.toString("utf8")), n.slice(0, -5)) : null;
    } catch {
      rec = null;
    }
    if (rec) records.push(rec);
    else unreadable++;
  }
  return { records, unreadable };
}

/** The standing warnings the project's records raise. */
export async function attentionWarnings(root: string, projectRel: string): Promise<string[]> {
  const { records, unreadable } = await readAttention(root, projectRel);
  const out: string[] = [];
  if (unreadable > 0 || records.some((r) => r.kind === "audit-unrecorded")) out.push(AUDIT_UNRECORDED_WARNING);
  if (records.some((r) => r.kind === "permissions-not-set")) out.push(PERMISSIONS_NOT_SET_WARNING);
  return out;
}

/**
 * The library-relative folder of project `projectId` in the library at `root`, read from each
 * `Projects/<n>/project.json` (for a library whose repo could not be opened). Null when not found.
 */
export async function projectFolderOf(root: string, projectId: string): Promise<string | null> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(join(root, "Projects"));
  } catch {
    return null;
  }
  for (const n of names.sort()) {
    if (n.startsWith(".")) continue;
    try {
      const raw = await readMaybe(join(root, "Projects", n, "project.json"));
      if (raw && parseProjectJson(JSON.parse(raw.toString("utf8"))).project.id === projectId) return `Projects/${n}`;
    } catch {
      // not a readable project
    }
  }
  return null;
}

/** Library-relative project folders by project id, for every readable project in the library at `root`. */
export async function projectFolders(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = await fsp.readdir(join(root, "Projects"));
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    if (n.startsWith(".")) continue;
    try {
      const raw = await readMaybe(join(root, "Projects", n, "project.json"));
      if (raw) out.set(parseProjectJson(JSON.parse(raw.toString("utf8"))).project.id, `Projects/${n}`);
    } catch {
      // not a readable project
    }
  }
  return out;
}

/** Sets `mode` on one library-relative file, never through a symbolic link or outside the project. */
async function restrict(core: RepoCore, st: ProjectState, rel: string, mode: number): Promise<void> {
  if (!rel.startsWith(`${st.rel}/`)) throw new Error("outside the project");
  const p = core.abs(rel);
  await assertContained(core.abs(st.rel), p);
  const s = await fsp.lstat(p);
  if (!s.isFile()) throw new Error("not a file");
  if (process.platform !== "win32") await fsp.chmod(p, mode);
}

/** Test seam: makes setting permissions again on open fail (until cleared). */
export const attentionSeams: { failRestrict?: boolean } = {};

/**
 * On a writable open of a project that accepts writes: appends each unrecorded event (once) and
 * sets each file's permissions again; removes what is settled. Returns how many records were
 * settled. An append failure throws (the caller blocks the project, R28).
 */
export async function settleAttention(core: RepoCore, st: ProjectState, events: Array<AuditEvent | null>, at: string): Promise<number> {
  const { records } = await readAttention(core.root, st.rel);
  let settled = 0;
  for (const rec of records) {
    if (rec.kind === "audit-unrecorded") {
      const moveId = rec.details.moveId;
      // Recorded already: by an earlier repair, or (a move step run again) by the action itself.
      const already = events.some(
        (e) => e?.details?.attentionId === rec.id || (moveId !== undefined && e?.action === rec.action && e.details?.moveId === moveId),
      );
      if (!already) {
        await core.auditNow(st, {
          at,
          actor: rec.actor,
          device: rec.device,
          projectId: st.project.id,
          action: rec.action,
          entity: { type: "project", id: st.project.id },
          decision: rec.decision ?? { result: "allow" },
          details: {
            ...rec.details,
            attentionId: rec.id,
            recordedLate: { occurredAt: rec.occurredAt, ...(rec.reason ? { reason: rec.reason } : {}), ...(rec.state === "intent" ? { interrupted: true } : {}) },
          },
        });
      }
      await removeAttention(core.root, st.rel, rec.id);
      settled++;
      continue;
    }
    try {
      if (attentionSeams.failRestrict) throw Object.assign(new Error("permission change refused (simulated)"), { code: "EPERM" });
      for (const f of rec.files) await restrict(core, st, f, rec.mode);
    } catch {
      continue; // stays: the warning stands until it works
    }
    if (!events.some((e) => e?.details?.attentionId === rec.id)) {
      await core.auditNow(st, {
        ...core.auditBase(st, at),
        action: "library.permissions-restricted",
        entity: { type: "project", id: st.project.id },
        decision: { result: "allow" },
        details: { attentionId: rec.id, files: rec.files.length, mode: rec.mode.toString(8), after: rec.action, occurredAt: rec.occurredAt },
      });
    }
    await removeAttention(core.root, st.rel, rec.id);
    settled++;
  }
  return settled;
}
