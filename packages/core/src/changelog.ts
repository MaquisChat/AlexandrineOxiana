import { newId } from "./ids.js";

export type EntityType =
  | "source"
  | "asset"
  | "annotation"
  | "collection"
  | "tag"
  | "participant"
  | "session"
  | "consent"
  | "project";

export interface Change {
  /** UUIDv7; sortable by creation time. */
  id: string;
  /** UTC ISO 8601 with milliseconds and `Z` (`Date.toISOString()` form); compared as a string. */
  at: string;
  author: string;
  device: string;
  projectId: string;
  entity: { type: EntityType; id: string };
  op: "create" | "update" | "delete";
  /** RFC 6901 JSON pointer; absent for create and delete. */
  field?: string;
  value?: unknown;
  prev?: unknown;
  /** The key at `field` was removed. Explicit because `undefined` does not survive JSON. */
  removed?: boolean;
}

export type ChangeMeta = Omit<Change, "id" | "op" | "field" | "value" | "prev" | "removed">;

export interface MergeConflict {
  /** JSON pointer, or `*` for whole-entity conflicts (delete vs update, create vs create). */
  field: string;
  entity: Change["entity"];
  local: Change;
  remote: Change;
  /** Create/create only: every other change to the entity, none of which is applied. */
  dropped?: Change[];
}

/** Rich-text pointers: concurrent edits are never auto-merged. Also matches as a pointer prefix. */
export const RICH_TEXT_FIELDS: ReadonlySet<string> = new Set(["/body", "/notes", "/details"]);

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

/**
 * Turns a before/after pair into changes: `create` when `before` is null,
 * `delete` when `after` is null, otherwise one `update` per changed leaf.
 * Arrays are leaves; plain objects are recursed into.
 */
export function diffToChanges(
  before: object | null,
  after: object | null,
  meta: ChangeMeta,
): Change[] {
  if (!AT_PATTERN.test(meta.at) || Number.isNaN(Date.parse(meta.at))) {
    throw new RangeError(`diffToChanges: "at" must be UTC ISO like 2026-11-09T10:00:00.000Z: ${meta.at}`);
  }
  if (before === null && after === null) return [];
  if (before === null) return [{ ...meta, id: newId(), op: "create", value: after }];
  if (after === null) return [{ ...meta, id: newId(), op: "delete", prev: before }];
  const out: Change[] = [];
  walk(before as Record<string, unknown>, after as Record<string, unknown>, "", meta, out);
  return out;
}

function walk(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  base: string,
  meta: ChangeMeta,
  out: Change[],
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const field = `${base}/${escapeToken(key)}`;
    const inBefore = key in before && before[key] !== undefined;
    const inAfter = key in after && after[key] !== undefined;
    if (inBefore && inAfter) {
      const b = before[key];
      const a = after[key];
      if (isPlainObject(b) && isPlainObject(a)) {
        walk(b, a, field, meta, out);
      } else if (!deepEqual(b, a)) {
        out.push({ ...meta, id: newId(), op: "update", field, prev: b, value: a });
      }
    } else if (inAfter) {
      out.push({ ...meta, id: newId(), op: "update", field, value: after[key] });
    } else if (inBefore) {
      out.push({ ...meta, id: newId(), op: "update", field, prev: before[key], removed: true });
    }
  }
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order: (at, device, id). */
function compareChanges(a: Change, b: Change): number {
  return cmpStr(a.at, b.at) || cmpStr(a.device, b.device) || cmpStr(a.id, b.id);
}

/** Pointers overlap when equal or one is an ancestor of the other. */
function overlaps(f: string, g: string): boolean {
  return f === g || g.startsWith(`${f}/`) || f.startsWith(`${g}/`);
}

function compareConflicts(a: MergeConflict, b: MergeConflict): number {
  const pair = (c: MergeConflict) => [c.local.id, c.remote.id].sort().join("|");
  return (
    cmpStr(a.entity.type, b.entity.type) ||
    cmpStr(a.entity.id, b.entity.id) ||
    cmpStr(a.field, b.field) ||
    cmpStr(pair(a), pair(b))
  );
}

function isRichText(field: string): boolean {
  for (const rf of RICH_TEXT_FIELDS) {
    if (field === rf || field.startsWith(`${rf}/`)) return true;
  }
  return false;
}

function latest(changes: Change[]): Change {
  return changes.reduce((m, c) => (compareChanges(c, m) > 0 ? c : m));
}

interface EntityGroup {
  entity: Change["entity"];
  local: Change[];
  remote: Change[];
}

/**
 * Merges the two change lists made since the common ancestor.
 *
 * Per entity and field: last writer wins by (at, device) (greater device wins a
 * tie; id is the final tiebreak). Rich-text fields conflict instead, applying
 * neither side. A delete beats any update on the same entity; a create on both
 * sides is a conflict. The result is independent of argument order (apart from
 * which side is reported as `local`/`remote`).
 */
export function mergeConcurrent(
  local: Change[],
  remote: Change[],
): { applied: Change[]; conflicts: MergeConflict[] } {
  const groups = new Map<string, EntityGroup>();
  const add = (side: "local" | "remote", c: Change): void => {
    const key = `${c.entity.type}\u0000${c.entity.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { entity: c.entity, local: [], remote: [] };
      groups.set(key, g);
    }
    g[side].push(c);
  };
  local.forEach((c) => add("local", c));
  remote.forEach((c) => add("remote", c));

  const applied: Change[] = [];
  const conflicts: MergeConflict[] = [];

  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    const all = [...g.local, ...g.remote];
    const deletes = all.filter((c) => c.op === "delete");

    if (deletes.length > 0) {
      // Delete wins. Same-side changes are subsumed; opposite-side ones are reported.
      applied.push(latest(deletes));
      const localDeletes = g.local.filter((c) => c.op === "delete");
      const remoteDeletes = g.remote.filter((c) => c.op === "delete");
      if (localDeletes.length > 0) {
        const d = latest(localDeletes);
        for (const r of g.remote) {
          if (r.op !== "delete") conflicts.push({ field: "*", entity: g.entity, local: d, remote: r });
        }
      }
      if (remoteDeletes.length > 0) {
        const d = latest(remoteDeletes);
        for (const l of g.local) {
          if (l.op !== "delete") conflicts.push({ field: "*", entity: g.entity, local: l, remote: d });
        }
      }
      continue;
    }

    const lCreates = g.local.filter((c) => c.op === "create");
    const rCreates = g.remote.filter((c) => c.op === "create");
    if (lCreates.length > 0 && rCreates.length > 0) {
      // Neither create established the entity: drop everything for it.
      const l = latest(lCreates);
      const r = latest(rCreates);
      const dropped = all.filter((c) => c !== l && c !== r).sort(compareChanges);
      conflicts.push({
        field: "*",
        entity: g.entity,
        local: l,
        remote: r,
        ...(dropped.length > 0 ? { dropped } : {}),
      });
      continue;
    }

    // Cluster overlapping pointers (one is a prefix of the other) and resolve each as a unit.
    const fieldChanges = new Map<string, { local: Change[]; remote: Change[] }>();
    const slot = (f: string) => {
      let s = fieldChanges.get(f);
      if (!s) fieldChanges.set(f, (s = { local: [], remote: [] }));
      return s;
    };
    for (const c of g.local) {
      if (c.field === undefined) applied.push(c);
      else slot(c.field).local.push(c);
    }
    for (const c of g.remote) {
      if (c.field === undefined) applied.push(c);
      else slot(c.field).remote.push(c);
    }
    const fields = [...fieldChanges.keys()].sort();
    const parent = new Map(fields.map((f) => [f, f]));
    const find = (f: string): string => {
      let r = f;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        if (overlaps(fields[i]!, fields[j]!)) parent.set(find(fields[j]!), find(fields[i]!));
      }
    }
    const clusters = new Map<string, string[]>();
    for (const f of fields) {
      const root = find(f);
      clusters.set(root, [...(clusters.get(root) ?? []), f]);
    }
    for (const members of clusters.values()) {
      const lc = members.flatMap((f) => fieldChanges.get(f)!.local);
      const rc = members.flatMap((f) => fieldChanges.get(f)!.remote);
      if (lc.length === 0 || rc.length === 0) {
        applied.push(...lc, ...rc);
        continue;
      }
      const rich = members.filter(isRichText).sort((x, y) => x.length - y.length || cmpStr(x, y));
      if (rich.length > 0) {
        conflicts.push({ field: rich[0]!, entity: g.entity, local: latest(lc), remote: latest(rc) });
      } else {
        applied.push(...(compareChanges(latest(lc), latest(rc)) > 0 ? lc : rc));
      }
    }
  }

  conflicts.sort(compareConflicts);
  applied.sort(compareChanges);
  return { applied, conflicts };
}
