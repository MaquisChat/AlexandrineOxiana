/**
 * Incomplete last lines in audit segments and change logs (R28).
 *
 * An event or change exists only once its whole line and newline are durably
 * written (and the external anchor only moves after a successful append). A
 * crash during an append outside a transaction (a deny event, an unlock, an
 * integrity event written at open) can leave a last line without its newline
 * and no write-ahead marker. Such a line is not a committed record.
 *
 * `scanIncompleteLines` finds them in a project's last audit segment and in
 * each of its change-log files, its review queue file and its job journal (or in the workspace change log), and with
 * `trim` cuts each file back to just after its last newline. The caller
 * decides whether trimming is allowed (writable library, no unresolved marker
 * for the project) and reports and audits the result.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { auditSegments } from "./audit-store.js";
import { assertContained, incompleteTail, truncateDurable } from "./io.js";

export interface IncompleteLine {
  /** Library-relative path (`/` separators). */
  file: string;
  /** Size of the incomplete line. */
  bytes: number;
  /** SHA-256 (hex) of the incomplete line's bytes. */
  sha256: string;
  /** True when the file was cut back; false when the line is still there. */
  trimmed: boolean;
  /** Why trimming was attempted but failed. */
  error?: string;
}

const CHANGE_LOG = /^\d{4}-\d{2}\.jsonl$/;

/**
 * `folder` is library-relative: a project folder (`Projects/<name>`), or ""
 * for the library root (the workspace change log and the library's audit log). Files reached through a
 * symbolic link are never read or changed.
 */
export async function scanIncompleteLines(root: string, folder: string, trim: boolean): Promise<IncompleteLine[]> {
  const base = folder ? join(root, ...folder.split("/")) : root;
  const rel = (...parts: string[]) => [...(folder ? [folder] : []), ...parts].join("/");
  const files: Array<{ abs: string; file: string }> = [];
  // A project's audit log, or at the library root the library's own (refusals with no project, Task 50).
  const last = (await auditSegments(join(base, "audit")).catch(() => [])).at(-1);
  if (last) files.push({ abs: join(base, "audit", last), file: rel("audit", last) });
  const logs = await fsp.readdir(join(base, "changes")).catch(() => [] as string[]);
  for (const n of logs.filter((x) => CHANGE_LOG.test(x)).sort()) files.push({ abs: join(base, "changes", n), file: rel("changes", n) });
  if (folder && (await fsp.stat(join(base, "review", "pending.jsonl")).catch(() => null))?.isFile()) {
    files.push({ abs: join(base, "review", "pending.jsonl"), file: rel("review", "pending.jsonl") });
  }
  if (folder && (await fsp.stat(join(base, "jobs", "journal.jsonl")).catch(() => null))?.isFile()) {
    files.push({ abs: join(base, "jobs", "journal.jsonl"), file: rel("jobs", "journal.jsonl") });
  }

  const out: IncompleteLine[] = [];
  for (const { abs, file } of files) {
    try {
      await assertContained(base, abs);
    } catch {
      continue; // not really inside this folder: appends there are refused anyway (PathEscapeError)
    }
    let found: Awaited<ReturnType<typeof incompleteTail>>;
    try {
      found = await incompleteTail(abs);
    } catch {
      continue; // unreadable: nothing is known and nothing is changed
    }
    if (!found) continue;
    const line: IncompleteLine = {
      file,
      bytes: found.tail.length,
      sha256: createHash("sha256").update(found.tail).digest("hex"),
      trimmed: false,
    };
    if (trim) {
      try {
        await truncateDurable(abs, found.keep);
        line.trimmed = true;
      } catch (err) {
        line.error = err instanceof Error ? err.message : String(err);
      }
    }
    out.push(line);
  }
  return out;
}
