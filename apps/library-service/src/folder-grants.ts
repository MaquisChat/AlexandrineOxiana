/**
 * Folder grants (Task W6, R207). A folder becomes approvable only through the desktop shell's own
 * native folder chooser: the shell writes the chosen path on the service's standard input as one
 * grant line, `{"type":"folder-grant","id":"<32 hex>","path":"<absolute>"}`, and gives the page only
 * the grant's id and the folder's name. The page never sees or sends a path; a route (Task W7)
 * exchanges the id for the path once, with `take`.
 *
 * The path is a secret from the page and from every log: nothing here logs, throws or echoes it.
 * A grant is used once, expires after FOLDER_GRANT_TTL_MS, and at most FOLDER_GRANTS_MAX are held
 * (the oldest is dropped). A taken, expired, dropped or cleared grant's path is forgotten at once:
 * each grant's own timer removes it when it expires, without waiting for anyone to ask.
 *
 * `parseGrantLine` accepts exactly the line the shell writes (grant.rs `grant_line`): the JSON text
 * of an object with the keys `type`, `id`, `path` in that order, no spaces, `type` exactly
 * "folder-grant", `id` 32 lowercase hexadecimal characters, `path` absolute, at most
 * GRANT_PATH_MAX_BYTES in UTF-8 and without NUL, the whole line at most GRANT_LINE_MAX_BYTES. The
 * text must be byte for byte what `JSON.stringify` makes of those three values (which is also what
 * serde_json makes), so a duplicated key, extra spaces, a leading byte-order mark or an unusual
 * escape is not a grant. The one tolerance is upstream: the line reader (startup-token.ts
 * `InputLines`) removes one `\r` before the line end, so `<grant>\r\n` is a grant. Every
 * other line is discarded, never interpreted (R98, R155, as changed by R207 for this one shape and by
 * ruling 1 of Find and acquire for one more: the file grant, file-grants.ts `parseFileGrantLine`, Task F17).
 */
import { isAbsolute } from "node:path";

/** How long a grant may wait to be used. */
export const FOLDER_GRANT_TTL_MS = 600_000;
/** How many grants are held at most; adding one more drops the oldest. */
export const FOLDER_GRANTS_MAX = 20;
/** The longest grant line, in bytes, without its line end. */
export const GRANT_LINE_MAX_BYTES = 8192;
/** The longest path a grant may carry, in bytes of UTF-8. */
export const GRANT_PATH_MAX_BYTES = 4096;

const GRANT_ID = /^[0-9a-f]{32}$/;
const GRANT_TYPE = "folder-grant";

function validPath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !path.includes("\u0000") && isAbsolute(path) && Buffer.byteLength(path, "utf8") <= GRANT_PATH_MAX_BYTES;
}

function validId(id: unknown): id is string {
  return typeof id === "string" && GRANT_ID.test(id);
}

/** The grant a line carries, or null for anything that is not exactly a grant line. */
export function parseGrantLine(line: string): { id: string; path: string } | null {
  if (typeof line !== "string" || !line.startsWith("{") || Buffer.byteLength(line, "utf8") > GRANT_LINE_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 3 || o.type !== GRANT_TYPE || !validId(o.id) || !validPath(o.path)) return null;
  // Exactly the shell's text: the keys in order, no spaces, the plain escapes, no duplicated key.
  if (JSON.stringify({ type: GRANT_TYPE, id: o.id, path: o.path }) !== line) return null;
  return { id: o.id, path: o.path };
}

interface Held {
  path: string;
  timer: ReturnType<typeof setTimeout>;
}

/** The grants the shell handed over and no route has used yet (in memory only, never written). */
export class FolderGrants {
  readonly #held = new Map<string, Held>();

  /** Keeps a grant. An invalid id or path, or an id already held, is ignored (the first grant stays). */
  add(id: string, path: string): void {
    if (!validId(id) || !validPath(path) || this.#held.has(id)) return;
    while (this.#held.size >= FOLDER_GRANTS_MAX) {
      const oldest = this.#held.keys().next().value as string;
      this.#forget(oldest);
    }
    const timer = setTimeout(() => this.#forget(id), FOLDER_GRANT_TTL_MS);
    timer.unref?.();
    this.#held.set(id, { path, timer });
  }

  /** The grant's path, once; null for an unknown, used, expired or dropped grant. */
  take(id: string): string | null {
    const g = this.#held.get(id);
    if (!g) return null;
    this.#forget(id);
    return g.path;
  }

  /** How many grants are held. */
  get size(): number {
    return this.#held.size;
  }

  /** Forgets every grant (the service is closing). */
  clear(): void {
    for (const id of [...this.#held.keys()]) this.#forget(id);
  }

  #forget(id: string): void {
    const g = this.#held.get(id);
    if (!g) return;
    clearTimeout(g.timer);
    this.#held.delete(id);
  }
}

/** What main.ts does with each line after the token: a grant line is kept, anything else is dropped unread. */
export function grantLineHandler(grants: FolderGrants): (line: string) => void {
  return (line) => {
    const g = parseGrantLine(line);
    if (g) grants.add(g.id, g.path);
  };
}
