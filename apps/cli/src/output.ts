import { basename } from "node:path";
import type { CaptureOutcome, ProfileCaptureReport } from "@ao/library";
import type { SourceFile } from "@ao/core";
import { classifyUrl } from "@ao/library";
import { editsNotCheckedText } from "@ao/shared";

export interface Out {
  json: boolean;
  /** Human text (or the single JSON document at the end) to stdout. */
  line(text?: string): void;
  /** Progress and hints to stderr. */
  progress(text: string): void;
  /** Emits the machine document (only in --json mode). */
  data(value: unknown): void;
}

export function createOut(json: boolean): Out {
  return {
    json,
    line(text = "") {
      if (!json) process.stdout.write(`${text}\n`);
    },
    progress(text) {
      process.stderr.write(`${text}\n`);
    },
    data(value) {
      if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/** `Projects/<P>/Sources/<folder>` -> `<folder>` (the readable label of a source). */
export const folderLabel = (folder: string): string => basename(folder);

/** A link without tracking parameters or credentials: safe to print and to put in machine output. */
export function safeUrl(url: string): string {
  return classifyUrl(url).canonicalUrl;
}

export interface ItemView {
  url: string;
  status: CaptureOutcome["status"];
  sourceId?: string;
  folder?: string;
  title?: string;
  reason?: string;
  errorCode?: string;
}

/** An outcome plus where its source lives (library-relative) and its readable title. */
/** The library's "Use my browser session" wording, as this tool says it. */
export const loginHint = (reason: string): string => reason.replace("'Use my browser session'", "--cookies-from-browser <browser> (chrome, firefox, safari, edge or brave)");

export function itemView(o: CaptureOutcome, sf?: SourceFile): ItemView {
  return {
    url: safeUrl(o.url),
    status: o.status,
    ...(o.sourceId ? { sourceId: o.sourceId } : {}),
    ...(sf ? { folder: sf.source.folder, title: folderLabel(sf.source.folder) } : {}),
    ...(o.reason ? { reason: loginHint(o.reason) } : {}),
    ...(o.errorCode ? { errorCode: o.errorCode } : {}),
  };
}

const pad = (s: string) => s.padEnd(12);

/** One human line per item, plus the reason (if any) on an indented line. */
export function itemLines(v: ItemView): string[] {
  const where = v.folder ? `${v.title}  →  ${v.folder}` : v.url;
  const lines = [`${pad(v.status)}${where}`];
  if (v.reason) lines.push(`${" ".repeat(12)}${v.reason}`);
  return lines;
}

export function profileLines(r: ProfileCaptureReport): string[] {
  const head =
    r.status === "completed" ? "Profile capture finished." : r.status === "paused-rate-limited" ? "Profile capture paused." : "Profile capture did not finish.";
  const lines = [head];
  if (r.reason) lines.push(loginHint(r.reason));
  lines.push(
    `  saved ${r.created}, already had ${r.duplicates}, partly saved ${r.incomplete}, failed ${r.failed}`,
    `  edited since last time ${r.edited}, no longer on the platform ${r.newlyUnavailable}, back again ${r.reappeared}`,
  );
  // FR-106: posts that look edited but whose own data could not be fetched to check.
  if (r.editsNotChecked) lines.push(`  ${editsNotCheckedText(r.editsNotChecked)}`);
  if (r.status === "completed" && !r.listComplete) lines.push("  The list was filtered or cut short, so removed posts were not checked.");
  if (r.status === "paused-rate-limited") lines.push("  Run the same command later: it continues where it stopped.");
  return lines;
}
