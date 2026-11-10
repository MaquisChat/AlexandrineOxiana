/**
 * Deletion records for imported items (R73): when a source that came from an incremental import
 * (provenance `externalKeys.zoteroKey`) is deleted in this app, the deletion is remembered, so a
 * later Zotero run does not bring it back. Batch undo is not a deletion and records nothing.
 *
 * `<Project>/imports/deleted-items.json` (`.enc`, sealed with the project key, in encrypted
 * projects; owner-only otherwise): a per-project random secret and, per kind, HMAC-SHA256(secret,
 * item key) — never the key itself. Written inside the governed change that deletes the source.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { SourceFile } from "@ao/core";
import { decryptBytes, readMaybe } from "./io.js";
import type { Tx } from "./mutate.js";
import type { ProjectState, RepoCore } from "./state.js";

const NAME = "deleted-items.json";
const MODE = 0o600;

export interface Tombstones {
  secret: string;
  /** HMACs of Zotero item keys. */
  zotero: string[];
}

const rel = (st: ProjectState, encrypted: boolean) => `${st.rel}/imports/${encrypted ? `${NAME}.enc` : NAME}`;

export const tombstoneHash = (secret: string, key: string) => createHmac("sha256", Buffer.from(secret, "hex")).update(`zotero:${key}`, "utf8").digest("hex");

/** The project's deletion records, or null when there are none (or they cannot be read). */
export async function readTombstones(core: RepoCore, st: ProjectState): Promise<Tombstones | null> {
  const encrypted = core.encrypted(st);
  const raw = await readMaybe(core.abs(rel(st, encrypted)));
  if (!raw) return null;
  try {
    let text: string;
    if (encrypted) {
      const { key, keyId } = core.key(st);
      text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
    } else text = raw.toString("utf8");
    const t = JSON.parse(text) as Partial<Tombstones>;
    if (typeof t.secret !== "string" || !/^[0-9a-f]{64}$/u.test(t.secret)) return null;
    return { secret: t.secret, zotero: Array.isArray(t.zotero) ? t.zotero.filter((h): h is string => typeof h === "string") : [] };
  } catch {
    return null;
  }
}

async function write(core: RepoCore, tx: Tx, t: Tombstones): Promise<void> {
  await tx.mkdir(`${tx.state.rel}/imports`);
  await tx.writeFile(rel(tx.state, tx.encrypted), JSON.stringify(t), { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: MODE }) });
}

/** Inside a deletion: records the source's Zotero item key, if it has one. */
export async function recordDeletion(core: RepoCore, tx: Tx, sf: SourceFile): Promise<void> {
  const key = sf.source.provenance.externalKeys?.zoteroKey;
  if (!key) return;
  const t = (await readTombstones(core, tx.state)) ?? { secret: randomBytes(32).toString("hex"), zotero: [] };
  const h = tombstoneHash(t.secret, key);
  if (t.zotero.includes(h)) return;
  t.zotero.push(h);
  await write(core, tx, t);
}

/** Clears the records of these Zotero item keys (re-imported with `includeDeleted`). */
export async function clearDeletions(core: RepoCore, tx: Tx, keys: string[]): Promise<number> {
  const t = await readTombstones(core, tx.state);
  if (!t) return 0;
  const drop = new Set(keys.map((k) => tombstoneHash(t.secret, k)));
  const kept = t.zotero.filter((h) => !drop.has(h));
  if (kept.length === t.zotero.length) return 0;
  await write(core, tx, { ...t, zotero: kept });
  return t.zotero.length - kept.length;
}
