/**
 * The review queue's file record (R31): `<Project>/review/pending.jsonl`, one entry per line,
 * append-only. A later line with the same id supersedes an earlier one (e.g. `status: resolved`).
 * In encrypted projects every line is sealed with the project key (like the change log), so field
 * reasons, which quote titles and names, never sit in plaintext. The index's `review_items` table
 * is a cache of this file; for encrypted projects it holds only field names and statuses.
 */
import { newId } from "@ao/core";
import { openLine, sealLine } from "./io.js";
import { CHANGE_LOG_MODE, type Tx } from "./mutate.js";
import type { RepoCore } from "./state.js";

export const REVIEW_FILE = "review/pending.jsonl";
const PURPOSE = "ao-review";

export interface ReviewEntry {
  id: string;
  projectId: string;
  sourceId?: string;
  kind: "verification" | "import";
  status: "pending" | "resolved";
  createdAt: string;
  /** JSON pointer → verification status of each field that needs review. */
  fields: Record<string, string>;
  /** Plain-language reasons (may quote titles and names). */
  reasons: string[];
}

/** A `review_items` row; `payload` is safe for the persistent index (nothing identifying when `encrypted`). */
export interface ReviewItemRow {
  id: string;
  projectId: string;
  sourceId?: string;
  batchId?: string;
  kind: ReviewEntry["kind"];
  status: ReviewEntry["status"];
  payload: Record<string, unknown>;
  createdAt: string;
}

export function reviewRow(e: ReviewEntry, encrypted: boolean): ReviewItemRow {
  return {
    id: e.id,
    projectId: e.projectId,
    ...(e.sourceId ? { sourceId: e.sourceId } : {}),
    kind: e.kind,
    status: e.status,
    payload: encrypted ? { fields: e.fields } : { fields: e.fields, reasons: e.reasons },
    createdAt: e.createdAt,
  };
}

/** Appends a new pending entry inside a running mutation and indexes it after commit. */
export async function appendReviewEntry(
  core: RepoCore,
  tx: Tx,
  input: { sourceId?: string; kind?: ReviewEntry["kind"]; fields: Record<string, string>; reasons: string[] },
): Promise<ReviewEntry> {
  const st = tx.state;
  const entry: ReviewEntry = {
    id: newId(),
    projectId: st.project.id,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    kind: input.kind ?? "verification",
    status: "pending",
    createdAt: tx.at,
    fields: input.fields,
    reasons: input.reasons,
  };
  const json = JSON.stringify(entry);
  const encrypted = core.encrypted(st);
  if (encrypted) {
    const { key, keyId } = core.key(st);
    await tx.appendLine(`${st.rel}/${REVIEW_FILE}`, sealLine(key, keyId, st.project.id, json, PURPOSE));
  } else {
    await tx.appendLine(`${st.rel}/${REVIEW_FILE}`, json, { mode: CHANGE_LOG_MODE });
  }
  const row = reviewRow(entry, encrypted);
  tx.index((sink) => sink.indexReviewItem?.(row));
  return entry;
}

/**
 * Reads a review file's text: the newest entry per id. `key` opens sealed lines (encrypted
 * projects); unreadable lines are skipped and counted.
 */
export function parseReviewFile(text: string, projectId: string, key: Uint8Array | null): { entries: ReviewEntry[]; skipped: number } {
  const byId = new Map<string, ReviewEntry>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const json = key ? openLine(key, projectId, line, PURPOSE) : line;
      const e = JSON.parse(json) as ReviewEntry;
      if (typeof e?.id !== "string" || e.projectId !== projectId) throw new Error("not a review entry of this project");
      byId.set(e.id, e);
    } catch {
      skipped++;
    }
  }
  return { entries: [...byId.values()], skipped };
}
