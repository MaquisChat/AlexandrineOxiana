/**
 * What a project needs attention for after an action that was not undone (R28, R82: never silent;
 * Task 50, R154). Two kinds, each a small file `<Project>/attention/<id>.json` (owner-only, no
 * absolute paths, no secrets):
 *
 * - `audit-unrecorded`: an action happened (or may have happened) but its audit event could not be
 *   written: a library move, split, old-copy deletion, reconnect or relink, or a refusal of a move.
 *   Relink writes the record BEFORE it copies anything (`state: "intent"`, naming each file before
 *   its copy), so a crash between a copy and its audit event leaves the record; the others write it
 *   when the append fails (their own journals cover a crash before that).
 * - `permissions-not-set`: a file was restored to a source but its owner-only permissions could not
 *   be set. The record names the SOURCES only (ids): never a path or a mode (R154 c).
 *
 * Records are data from a folder anyone with access (or a sync tool) can write, so they never steer
 * a privileged action (R154 c): an unrecorded event may only name the actions this module records,
 * a refusal only for `move`, and no transaction, attention id or late-recording fields; a
 * permissions repair applies the code's own mode (owner read/write at most, never adding a bit) to
 * the files of the named sources as the project's own index places them, verifies the result and
 * audits what it did. A record that does not pass is never acted on, never removed by a repair, and
 * shown as `attention-unreadable`.
 *
 * Each writable open repairs what it can (`settleAttention`, only for a project whose audit log
 * verifies and that accepts writes): an unrecorded event is appended with `details.recordedLate`
 * (when it happened, why it was late, whether interrupted, and `by`: the device recording it now)
 * and `details.attentionId`, which makes the repair idempotent. A repair raises the open's warning
 * `audit-recorded-late`. What cannot be repaired keeps its record; the researcher can set it aside
 * (R154 d, `setAsideMark` in repo.ts).
 *
 * Device-local outbox (R154 e): a mark that belongs in a library this device does not hold the lock
 * for (or whose project folder cannot take it) is written to
 * `<appConfigDir>/attention-outbox/<libraryId>/<id>.json`, shown on this device (`audit-waiting`), and
 * delivered on this device's next writable open of that library: settled directly when the project
 * can be settled, else moved into the project's folder; the outbox file goes only after that.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { absPath, assertContained, readMaybe } from "./io.js";
import { parseProjectJson, type ProjectState, type RepoCore } from "./state.js";

export const ATTENTION_DIR = "attention";
export const AUDIT_UNRECORDED_WARNING = "audit-unrecorded";
export const AUDIT_UNRECORDED_BLOCKED_WARNING = "audit-unrecorded-blocked";
export const ATTENTION_UNREADABLE_WARNING = "attention-unreadable";
export const PERMISSIONS_NOT_SET_WARNING = "permissions-not-set";
export const AUDIT_WAITING_WARNING = "audit-waiting";
const MODE = 0o600;
/** The only permission bits a repair leaves: owner read and write (R154 c). */
export const RESTRICTED_MODE = 0o600;
const NAME = /^[0-9a-f]{16,64}\.json$/;
const OUTBOX = "attention-outbox";
const ID = /^[0-9A-Za-z_-]{1,64}$/;

/** The actions an `audit-unrecorded` record may name (R154 c, M3). `move` only as a refusal. */
export const RECORDABLE_ACTIONS = new Set(["library.move", "library.split", "library.old-copy-deleted", "library.reconnect", "library.relink", "move"]);
const RESERVED_DETAILS = ["txn", "attentionId", "recordedLate"];

export interface UnrecordedAudit {
  formatVersion: 1;
  id: string;
  kind: "audit-unrecorded";
  /** When the action happened (or, for `intent`, began). */
  occurredAt: string;
  actor: string;
  device: string;
  /** The audit event's action, e.g. `library.move`, or `move` for a refusal. */
  action: string;
  /** Present exactly for a refusal (`move`). */
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
  /** Sources a restored file belongs to; their files are restricted. No path, no mode. */
  sourceIds: string[];
  /** The restore that placed the files: `library.relink`. */
  action: "library.relink";
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

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A record this code wrote, or null: anything else is never acted on (R154 c). */
export function parseRecord(v: unknown, id: string): AttentionRecord | null {
  if (!isPlain(v)) return null;
  const o = v as Partial<AttentionRecord> & Record<string, unknown>;
  if (o.formatVersion !== 1 || o.id !== id) return null;
  if (typeof o.occurredAt !== "string" || typeof o.actor !== "string" || typeof o.device !== "string" || typeof o.action !== "string") return null;
  if (o.kind === "audit-unrecorded") {
    const u = o as Partial<UnrecordedAudit>;
    if (!isPlain(u.details) || (u.state !== "intent" && u.state !== "ready")) return null;
    if (!RECORDABLE_ACTIONS.has(u.action!)) return null;
    if (RESERVED_DETAILS.some((k) => Object.hasOwn(u.details!, k))) return null;
    // A refusal is exactly a `move` deny; nothing else carries a decision.
    if ((u.action === "move") !== (u.decision !== undefined)) return null;
    if (u.decision !== undefined && (u.decision.result !== "deny" || typeof u.decision.reason !== "string")) return null;
    if (u.reason !== undefined && (typeof u.reason !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(u.reason))) return null;
    return u as UnrecordedAudit;
  }
  if (o.kind === "permissions-not-set") {
    if ("files" in o || "mode" in o || o.action !== "library.relink") return null;
    const p = o as Partial<PermissionsNotSet>;
    if (!Array.isArray(p.sourceIds) || p.sourceIds.length === 0 || !p.sourceIds.every((s) => typeof s === "string" && ID.test(s))) return null;
    return p as PermissionsNotSet;
  }
  return null;
}

/** A file in the attention folder that is not a valid record, or the folder itself when it is not a folder. */
export interface UnreadableMark {
  /** The file's name in the attention folder; "" when `attention` itself is not a folder. */
  file: string;
}

/** The project's records, and what in its attention folder is not a valid record (kept, never acted on). */
export async function readAttention(root: string, projectRel: string): Promise<{ records: AttentionRecord[]; unreadable: UnreadableMark[] }> {
  let names: string[];
  try {
    names = await fsp.readdir(dirOf(root, projectRel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], unreadable: [] };
    return { records: [], unreadable: [{ file: "" }] };
  }
  const records: AttentionRecord[] = [];
  const unreadable: UnreadableMark[] = [];
  for (const n of names.sort()) {
    if (/\.tmp-[0-9a-f]+$/.test(n)) continue; // an interrupted atomic write: never a record
    let rec: AttentionRecord | null = null;
    if (NAME.test(n)) {
      try {
        const raw = await readMaybe(join(dirOf(root, projectRel), n));
        rec = raw ? parseRecord(JSON.parse(raw.toString("utf8")), n.slice(0, -5)) : null;
      } catch {
        rec = null;
      }
    }
    if (rec) records.push(rec);
    else unreadable.push({ file: n });
  }
  return { records, unreadable };
}

/**
 * The standing warnings, worded by cause: a readable unrecorded event that the next writable open
 * records (`audit-unrecorded`), one that cannot be recorded while the project's log does not verify
 * or it refuses writes (`audit-unrecorded-blocked`), anything not a valid record
 * (`attention-unreadable`), permissions not set (`permissions-not-set`).
 */
export async function attentionWarnings(root: string, projectRel: string, blocked: boolean): Promise<string[]> {
  const { records, unreadable } = await readAttention(root, projectRel);
  const out: string[] = [];
  if (records.some((r) => r.kind === "audit-unrecorded")) out.push(blocked ? AUDIT_UNRECORDED_BLOCKED_WARNING : AUDIT_UNRECORDED_WARNING);
  if (unreadable.length > 0) out.push(ATTENTION_UNREADABLE_WARNING);
  if (records.some((r) => r.kind === "permissions-not-set")) out.push(PERMISSIONS_NOT_SET_WARNING);
  return out;
}

// ---- device-local outbox (R154 e) ----------------------------------------------------------------

export interface OutboxEntry {
  libraryId: string;
  projectId: string;
  record: AttentionRecord;
}

const outboxDir = (appConfigDir: string, libraryId: string) => join(appConfigDir, OUTBOX, libraryId);

/** Keeps a mark on this device for a library it does not hold (or whose project folder cannot take it). */
export async function writeOutbox(appConfigDir: string, libraryId: string, projectId: string, record: AttentionRecord): Promise<void> {
  if (!ID.test(libraryId)) throw new Error("not a library id");
  const dir = outboxDir(appConfigDir, libraryId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const body: OutboxEntry = { libraryId, projectId, record };
  await writeFileAtomic(join(dir, `${record.id}.json`), JSON.stringify(body, null, 2), { mode: MODE });
}

/** This device's waiting marks for the library (unreadable entries are kept and skipped). */
export async function readOutbox(appConfigDir: string, libraryId: string): Promise<OutboxEntry[]> {
  if (!ID.test(libraryId)) return [];
  let names: string[];
  try {
    names = await fsp.readdir(outboxDir(appConfigDir, libraryId));
  } catch {
    return [];
  }
  const out: OutboxEntry[] = [];
  for (const n of names.sort()) {
    if (!NAME.test(n)) continue;
    try {
      const raw = await readMaybe(join(outboxDir(appConfigDir, libraryId), n));
      const e = raw ? (JSON.parse(raw.toString("utf8")) as Partial<OutboxEntry>) : null;
      const rec = e && typeof e.projectId === "string" ? parseRecord(e.record, n.slice(0, -5)) : null;
      if (rec && e!.libraryId === libraryId) out.push({ libraryId, projectId: e!.projectId!, record: rec });
    } catch {
      // unreadable: left in place
    }
  }
  return out;
}

async function removeOutbox(appConfigDir: string, libraryId: string, id: string): Promise<void> {
  await fsp.unlink(join(outboxDir(appConfigDir, libraryId), `${id}.json`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

// ---- library helpers ------------------------------------------------------------------------------

/**
 * The library-relative folder of project `projectId` in the library at `root`, read from each
 * `Projects/<n>/project.json` (for a library whose repo could not be opened). Null when not found.
 */
export async function projectFolderOf(root: string, projectId: string): Promise<string | null> {
  return (await projectFolders(root)).get(projectId) ?? null;
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

/** Test seam: makes setting permissions again on open fail (until cleared). */
export const attentionSeams: { failRestrict?: boolean } = {};

/**
 * Restricts every file of one source, as the project's own index places it, to owner read/write at
 * most (never adding a bit), without following links, and checks the result. Returns counts.
 */
async function restrictSource(core: RepoCore, st: ProjectState, sourceId: string): Promise<{ files: number; changed: number }> {
  const folder = st.sources.get(sourceId);
  if (!folder || !folder.startsWith(`${st.rel}/Sources/`)) return { files: 0, changed: 0 }; // gone: nothing to restrict
  const projectDir = core.abs(st.rel);
  let files = 0;
  let changed = 0;
  const visit = async (abs: string): Promise<void> => {
    await assertContained(projectDir, abs);
    const s = await fsp.lstat(abs);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const n of (await fsp.readdir(abs)).sort()) await visit(join(abs, n));
      return;
    }
    if (!s.isFile()) return;
    files++;
    if (process.platform === "win32") return;
    const cur = s.mode & 0o777;
    const next = cur & RESTRICTED_MODE;
    if (attentionSeams.failRestrict) throw Object.assign(new Error("permission change refused (simulated)"), { code: "EPERM" });
    if (next !== cur) {
      await fsp.chmod(abs, next);
      changed++;
    }
    if (((await fsp.lstat(abs)).mode & 0o777 & ~RESTRICTED_MODE) !== 0) throw Object.assign(new Error("permissions are still wider"), { code: "EPERM" });
  };
  await visit(core.abs(folder));
  return { files, changed };
}

/** Appends one record's event (once) or repairs its permissions; true when settled. Throws on a failed append. */
async function settleOne(core: RepoCore, st: ProjectState, rec: AttentionRecord, events: Array<AuditEvent | null>, at: string): Promise<boolean> {
  if (rec.kind === "audit-unrecorded") {
    const moveId = rec.details.moveId;
    // Recorded already: by an earlier repair, or (a move step run again) by the action itself.
    const already = events.some((e) => e?.details?.attentionId === rec.id || (moveId !== undefined && e?.action === rec.action && e.details?.moveId === moveId));
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
          recordedLate: {
            occurredAt: rec.occurredAt,
            ...(rec.reason ? { reason: rec.reason } : {}),
            ...(rec.state === "intent" ? { interrupted: true } : {}),
            by: core.device,
          },
        },
      });
    }
    return true;
  }
  let files = 0;
  let changed = 0;
  try {
    for (const id of rec.sourceIds) {
      const r = await restrictSource(core, st, id);
      files += r.files;
      changed += r.changed;
    }
  } catch {
    return false; // stays: the warning stands until it works, or the researcher sets it aside
  }
  if (!events.some((e) => e?.details?.attentionId === rec.id)) {
    await core.auditNow(st, {
      ...core.auditBase(st, at),
      action: "library.permissions-restricted",
      entity: { type: "project", id: st.project.id },
      decision: { result: "allow" },
      details: { attentionId: rec.id, sources: rec.sourceIds.length, files, changed, mode: RESTRICTED_MODE.toString(8), after: rec.action, occurredAt: rec.occurredAt },
    });
  }
  return true;
}

/**
 * On a writable open of a project whose log verifies and that accepts writes: settles each record
 * of the project and each of this device's outbox entries for it. Returns how many were settled.
 * An append failure throws (the caller blocks the project, R28).
 */
export async function settleAttention(core: RepoCore, st: ProjectState, events: Array<AuditEvent | null>, at: string): Promise<number> {
  let settled = 0;
  for (const e of await readOutbox(core.library.appConfigDir, core.library.id)) {
    if (e.projectId !== st.project.id) continue;
    if (await settleOne(core, st, e.record, events, at)) settled++;
    else await writeAttention(core.root, st.rel, e.record); // kept with the project from now on
    await removeOutbox(core.library.appConfigDir, core.library.id, e.record.id);
  }
  const { records } = await readAttention(core.root, st.rel);
  for (const rec of records) {
    if (!(await settleOne(core, st, rec, events, at))) continue;
    await removeAttention(core.root, st.rel, rec.id);
    settled++;
  }
  return settled;
}

/**
 * On a writable open of a project that cannot be settled now (its log does not verify, or it refuses
 * writes): this device's outbox entries for it move into the project's folder, where they are shown
 * and can be set aside. Failures leave them in the outbox.
 */
export async function moveOutboxIntoProject(core: RepoCore, st: ProjectState): Promise<void> {
  for (const e of await readOutbox(core.library.appConfigDir, core.library.id)) {
    if (e.projectId !== st.project.id) continue;
    try {
      await writeAttention(core.root, st.rel, e.record);
      await removeOutbox(core.library.appConfigDir, core.library.id, e.record.id);
    } catch {
      // stays in the outbox
    }
  }
}

/** One mark as the audit screen lists it (no paths, no messages). */
export interface AttentionMark {
  /** The record id, or for something that is not a valid record its file name ("-" when the attention folder itself is not a folder). */
  id: string;
  kind: "audit-unrecorded" | "permissions-not-set" | "unreadable" | "waiting";
  action?: string;
  occurredAt?: string;
  actor?: string;
  /** An error code or name. */
  reason?: string;
  interrupted?: boolean;
  refusal?: boolean;
  /** Can be set aside here (not for a mark waiting on this device for the library's lock). */
  canSetAside: boolean;
}

export async function listMarks(core: RepoCore, st: ProjectState): Promise<AttentionMark[]> {
  const { records, unreadable } = await readAttention(core.root, st.rel);
  const view = (r: AttentionRecord, waiting: boolean): AttentionMark => ({
    id: r.id,
    kind: waiting ? "waiting" : r.kind,
    action: r.action,
    occurredAt: r.occurredAt,
    actor: r.actor,
    ...(r.kind === "audit-unrecorded" && r.reason ? { reason: r.reason } : {}),
    ...(r.kind === "audit-unrecorded" && r.state === "intent" ? { interrupted: true } : {}),
    ...(r.kind === "audit-unrecorded" && r.decision ? { refusal: true } : {}),
    canSetAside: !waiting,
  });
  return [
    ...records.map((r) => view(r, false)),
    ...unreadable.map((u): AttentionMark => ({ id: u.file === "" ? "-" : u.file, kind: "unreadable", canSetAside: true })),
    ...(await readOutbox(core.library.appConfigDir, core.library.id)).filter((e) => e.projectId === st.project.id).map((e) => view(e.record, true)),
  ];
}

/** What a set-aside records about a mark, and how to remove it. */
export async function markForSetAside(
  core: RepoCore,
  st: ProjectState,
  id: string,
): Promise<{ summary: Record<string, unknown>; remove: () => Promise<void> } | null> {
  const projectDir = core.abs(st.rel);
  const { records, unreadable } = await readAttention(core.root, st.rel);
  const rec = records.find((r) => r.id === id);
  if (rec) return { summary: { kind: rec.kind, record: rec }, remove: () => removeAttention(core.root, st.rel, rec.id) };
  const u = unreadable.find((x) => (x.file === "" ? "-" : x.file) === id);
  if (!u) return null;
  const abs = u.file === "" ? dirOf(core.root, st.rel) : join(dirOf(core.root, st.rel), u.file);
  await assertContained(projectDir, abs);
  const s = await fsp.lstat(abs);
  if (!s.isFile()) return null; // a folder or link in the attention folder is not set aside here
  const raw = await fsp.readFile(abs);
  return {
    summary: { kind: "unreadable", file: u.file === "" ? ATTENTION_DIR : `${ATTENTION_DIR}/${u.file}`, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") },
    remove: async () => {
      await assertContained(projectDir, abs);
      await fsp.unlink(abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    },
  };
}
