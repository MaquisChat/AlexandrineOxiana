/**
 * FR-729 (R503 e): the warnings recovery raises about what it did to an interrupted change are kept WITH THE LIBRARY
 * until the researcher dismisses them: a change undone completely when the library opened, and a change closed as it
 * was (R509). They are the library's own bookkeeping, written as the transaction markers are (atomically, whole), not a
 * governed change of a project: the recovery they report is already audited.
 *
 * - `<Library>/recovery-warnings.json` (R527: at the library's root, beside `library.json` and the library's own audit
 *   log, which a move of the library copies, whole or split, and a copy or backup of the library folder carries; never in
 *   `.tmp/`, the work folder a move leaves behind):
 *   `{ "formatVersion": 1, "warnings": [{ id, kind, projectId, at, rollback? }] }`. Nothing of a
 *   project is in it but its id (not a secret): no name, no title, no path, so a locked project's warning hides nothing
 *   its lock hides (its name is shown, as for every warning, from the project as the library lists it).
 * - Shown again at every opening until dismissed; dismissed, gone for good. A library open read-only shows them and
 *   writes nothing (no dismissal there).
 * - A file that cannot be read or does not hold a list never stops the library from opening: in a writable library it is
 *   set aside under a name that cannot collide (`recovery-warnings.damaged-<time>-<random>.json`, moved into `.tmp/`, the
 *   library's work folder) and one warning says so; read-only, it is left as it is and the same warning is raised.
 * - An older build ignores the file: nothing of it reads the library's root but `library.json`, the library's audit log
 *   and the folders it knows; its integrity check, like this one, reads only the files the library records (read at
 *   `main`), so neither ever reports this one.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { isId, newId } from "@ao/core";
import { renameWithRetry, writeSmallFileAtomic } from "../fs/atomic.js";
import type { IntegrityWarning } from "./audit-store.js";
import { NotFoundError } from "./errors.js";
import type { RepoCore } from "./state.js";

export const KEPT_WARNINGS_FILE = "recovery-warnings.json";
/** The kinds kept until dismissed (an undo completed at the opening carries no `rollback` state). */
export const KEPT_KINDS: ReadonlySet<IntegrityWarning["kind"]> = new Set(["rolled-back-incomplete-write", "interrupted-change-closed"]);
/** What a kept warning says as its detail (the screens say the kind's own sentence; the command line prints this). */
const KEPT_DETAIL: Partial<Record<IntegrityWarning["kind"], string>> = {
  "rolled-back-incomplete-write": "a change interrupted before it was audited was rolled back when the library was opened",
  "interrupted-change-closed": "an interrupted change was closed as it was; a file it had removed could not be put back",
};

export interface KeptWarning {
  id: string;
  kind: IntegrityWarning["kind"];
  projectId: string;
  /** When recovery raised it (ISO). */
  at: string;
  /**
   * R527, a closed change only: "unconfirmed" where something stood at every place whose file could not be put back (its
   * sentence then never says the file is lost). An older reader of this file is this build's own (it was never released).
   */
  rollback?: "unconfirmed";
}

const pathOf = (root: string) => join(root, KEPT_WARNINGS_FILE);

/** The kept warnings; "damaged" when the file is there but cannot be read as a list of them. */
export async function readKeptWarnings(root: string): Promise<KeptWarning[] | "damaged"> {
  let raw: string;
  try {
    raw = await fsp.readFile(pathOf(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    return "damaged";
  }
  try {
    const f = JSON.parse(raw) as { formatVersion?: unknown; warnings?: unknown };
    if (f.formatVersion !== 1 || !Array.isArray(f.warnings)) return "damaged";
    const out: KeptWarning[] = [];
    for (const w of f.warnings as Array<Partial<KeptWarning> | null>) {
      if (!w || typeof w.id !== "string" || !isId(w.id) || !KEPT_KINDS.has(w.kind!) || typeof w.projectId !== "string" || !isId(w.projectId) || typeof w.at !== "string") return "damaged";
      if (w.rollback !== undefined && (w.rollback !== "unconfirmed" || w.kind !== "interrupted-change-closed")) return "damaged";
      out.push({ id: w.id, kind: w.kind!, projectId: w.projectId, at: w.at, ...(w.rollback ? { rollback: w.rollback } : {}) });
    }
    return out;
  } catch {
    return "damaged";
  }
}

async function writeKeptWarnings(root: string, list: KeptWarning[]): Promise<void> {
  await writeSmallFileAtomic(pathOf(root), JSON.stringify({ formatVersion: 1, warnings: list }), { mode: 0o600 });
}

/** The integrity warning a kept one is shown as. */
const shown = (w: KeptWarning): IntegrityWarning => ({ projectId: w.projectId, kind: w.kind, detail: KEPT_DETAIL[w.kind] ?? "", keptId: w.id, ...(w.rollback ? { rollback: w.rollback } : {}) });

/**
 * At an opening, after recovery: the warnings kept from earlier openings are shown again, and those this opening's
 * recovery raised that are kept until dismissed are added to the file (writable only) and given their id. A damaged file
 * is set aside (writable) and said once; read-only, nothing is written.
 */
export async function keepRecoveryWarnings(core: RepoCore, writable: boolean, raised: IntegrityWarning[]): Promise<void> {
  const kept = await readKeptWarnings(core.root);
  let list: KeptWarning[] = [];
  if (kept === "damaged") {
    let detail = "the record of earlier warnings about interrupted changes could not be read";
    if (writable) {
      const stamp = core.clock().toISOString().replace(/[:.]/g, "-");
      try {
        await fsp.mkdir(join(core.root, ".tmp"), { recursive: true });
        await renameWithRetry(pathOf(core.root), join(core.root, ".tmp", `recovery-warnings.damaged-${stamp}-${randomBytes(4).toString("hex")}.json`));
        detail += "; it was set aside in the library's work folder and a new record was started";
      } catch {
        detail += "; it could not be set aside and is left in place";
      }
    } else detail += "; it is left as it is (the library is open read-only)";
    core.integrityWarnings.unshift({ projectId: "*", kind: "recovery-warnings-set-aside", detail });
    // Nothing more is written over a file that could not be set aside.
    if (writable && (await fsp.access(pathOf(core.root)).then(() => true, () => false))) return;
  } else list = kept;
  // Earlier openings' first, in the order they were raised.
  core.integrityWarnings.unshift(...list.map(shown));
  if (!writable) return;
  const fresh = raised.filter((w) => KEPT_KINDS.has(w.kind) && w.rollback === undefined && w.keptId === undefined);
  if (!fresh.length) return;
  const at = core.clock().toISOString();
  const added = fresh.map((w) => ({ w, k: { id: newId(), kind: w.kind, projectId: w.projectId, at } satisfies KeptWarning }));
  try {
    await writeKeptWarnings(core.root, [...list, ...added.map((a) => a.k)]);
    for (const a of added) a.w.keptId = a.k.id;
  } catch {
    // Not kept this time: shown for this session, as before FR-729; the recovery itself is in the audit log.
  }
}

/** A warning raised while the library is open (a change closed, R509), kept until dismissed. Best effort: shown regardless. */
export async function keepWarning(core: RepoCore, w: IntegrityWarning): Promise<void> {
  core.integrityWarnings.push(w);
  const kept = await readKeptWarnings(core.root);
  if (kept === "damaged") return;
  const k: KeptWarning = { id: newId(), kind: w.kind, projectId: w.projectId, at: core.clock().toISOString(), ...(w.rollback === "unconfirmed" ? { rollback: w.rollback } : {}) };
  try {
    await writeKeptWarnings(core.root, [...kept, k]);
    w.keptId = k.id;
  } catch {
    // Shown for this session only.
  }
}

/** Dismisses a kept warning for good (writable libraries only): out of the file, then out of what is shown. */
export async function dismissKeptWarning(core: RepoCore, id: string): Promise<void> {
  core.assertWritable();
  await core.serial(async () => {
    core.assertWritable();
    const kept = await readKeptWarnings(core.root);
    const list = kept === "damaged" ? [] : kept;
    if (typeof id !== "string" || !list.some((w) => w.id === id)) throw new NotFoundError("Warning", String(id));
    await writeKeptWarnings(core.root, list.filter((w) => w.id !== id));
    for (let k = core.integrityWarnings.length - 1; k >= 0; k--) if (core.integrityWarnings[k]!.keptId === id) core.integrityWarnings.splice(k, 1);
  });
}
