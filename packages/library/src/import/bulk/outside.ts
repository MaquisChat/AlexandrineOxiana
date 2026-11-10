/**
 * Files outside the expected places (R67, the user's decision): each adapter declares its roots
 * (the export file's folder, the Calibre library, the scanned folder; the batch's own work folder
 * always counts). A file whose real path — symbolic links followed — lies outside every root and
 * outside the library's approved folders is attached only when the batch's options approve it
 * (`approveOutside`: folders and/or single files); otherwise it is left out with the file note
 * OUTSIDE_NOTE and the item imports without it. The dry run lists such files for the wizard.
 *
 * The batch record never holds the approved paths in plaintext: `startBatch` turns each approved
 * folder or file into HMAC-SHA256(batch secret, "outside:" + real path) (`outsideApprovals`), and a
 * file is approved when its own real path or one of its parent folders hashes to one of them, so a
 * resumed batch honours the same approvals.
 */
import * as fsp from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { itemKeyHash } from "./batch.js";

export const OUTSIDE_NOTE = "attached file is outside the export's folder and was not approved";
export const OUTSIDE_REASON = "The file is outside the imported folder and was not approved, so it was not imported.";

export interface ApproveOutside {
  folders?: string[];
  files?: string[];
}

const real = (p: string) => fsp.realpath(p).catch(() => resolve(p));

const within = (folder: string, p: string) => {
  if (p === folder) return true;
  const rel = relative(folder, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const approvalHash = (secret: string, path: string) => itemKeyHash(secret, `outside:${path}`);

/** The approvals as HMACs of real paths (what the batch record keeps). */
export async function approvalHashes(secret: string, a: ApproveOutside | undefined): Promise<string[]> {
  const out = new Set<string>();
  for (const p of [...(a?.folders ?? []), ...(a?.files ?? [])]) out.add(approvalHash(secret, await real(p)));
  return [...out];
}

export class OutsidePolicy {
  private constructor(
    private readonly folders: string[],
    private readonly hashes: Set<string>,
    private readonly secret: string | undefined,
  ) {}

  /**
   * `roots` undefined: the adapter declares none (a test or foreign adapter) and nothing is checked.
   * `allowed` are further folders (the work folder, the library's approved folders).
   */
  static async create(roots: string[] | undefined, allowed: string[], secret?: string, hashes: string[] = []): Promise<OutsidePolicy | undefined> {
    if (!roots) return undefined;
    const folders = await Promise.all([...roots, ...allowed].map(real));
    return new OutsidePolicy(folders, new Set(hashes), secret);
  }

  /** The file's real path, and whether it may be attached. */
  async check(path: string): Promise<{ real: string; ok: boolean }> {
    const r = await real(path);
    if (this.folders.some((f) => within(f, r))) return { real: r, ok: true };
    if (this.secret && this.hashes.size) {
      for (let p = r; ; p = dirname(p)) {
        if (this.hashes.has(approvalHash(this.secret, p))) return { real: r, ok: true };
        if (dirname(p) === p) break;
      }
    }
    return { real: r, ok: false };
  }
}
