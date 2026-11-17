/**
 * The purposes of the files a project keeps as sealed lines (one JSON envelope per line, sealed under the
 * project key with AAD `<purpose>|<projectId>`), declared in ONE place. A restore of a backup opens every sealed
 * line of an encrypted project and seals it again under the new project id (`restore.ts`), so it must know every
 * purpose: a new line-sealed file adds its constant here and to `SEALED_LINE_PURPOSES`, and
 * `restore-sealed-purposes.test.ts` fails if a purpose appears in the source and is not declared here.
 * (R226 a: the find queue and the watch register had been forgotten, and a backup of an encrypted project holding
 * either could not be restored.)
 */

/** The change log (`changes/*.jsonl`). */
export const PURPOSE_CHANGES = "ao-changes";
/** The review queue (`review/pending.jsonl`). */
export const PURPOSE_REVIEW = "ao-review";
/** The import journal of a bulk import batch. */
export const PURPOSE_IMPORT_JOURNAL = "ao-import-journal";
/** The register of a watched folder (`watched/<id>.jsonl`). */
export const PURPOSE_WATCH_REGISTER = "ao-watch-register";
/** The Find and acquire queue (`find/queue.jsonl`). */
export const PURPOSE_FIND_QUEUE = "ao-find-queue";
/** The sealed store of reasons the audit log names only by SHA-256 (`audit-reasons.jsonl`, R362 b). */
export const PURPOSE_AUDIT_REASONS = "ao-audit-reasons";

/**
 * Not a sealed line's purpose: the purpose a key is derived for (HKDF-SHA-256 from the project's data key). The key
 * of the keyed digest an audit entry records of a reason typed into an encrypted project (R369 b): only who can
 * unlock the project can test a text against it. Not `PURPOSE_*`: a restore has no line of it to re-seal.
 */
export const KEY_PURPOSE_AUDIT_REASON_MAC = "ao-audit-reason-mac";

/** Every purpose a line of a project's files can be sealed with: what a restore tries on a sealed line. */
export const SEALED_LINE_PURPOSES: readonly string[] = [PURPOSE_CHANGES, PURPOSE_REVIEW, PURPOSE_IMPORT_JOURNAL, PURPOSE_WATCH_REGISTER, PURPOSE_FIND_QUEUE, PURPOSE_AUDIT_REASONS];
