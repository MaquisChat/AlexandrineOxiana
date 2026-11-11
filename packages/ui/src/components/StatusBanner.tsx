/**
 * The library's status, in plain language (spec 4.5; R113): read-only (locked by <hostname>,
 * newer format, other reasons), offline until the drive returns, the index rebuilding, and the
 * library's integrity warnings and projects' standing warnings. Warning codes are never shown as
 * such; an unknown one shows the service's own (path-scrubbed) detail.
 */
import type { IntegrityWarning, LibraryState } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";

export type BannerVariant =
  | { kind: "read-only-locked"; hostname?: string }
  | { kind: "read-only-newer-format" }
  | { kind: "read-only"; reason?: string }
  | { kind: "offline"; volume: string }
  | { kind: "index-rebuilding"; done: number; total: number }
  /** `detail` is accepted for the record but never shown (R114 I1). */
  | { kind: "warning"; warning: string; project: string; detail?: string };

const READ_ONLY_REASONS: Record<string, string> = {
  "not-writable": "this folder cannot be written to",
  moved: "this is the old copy of a library that was moved",
  "move-incomplete": "a move into this folder has not finished",
};

/**
 * Plain-language text for every warning the service raises (R114 I1): the library's integrity
 * warnings (packages/library/src/repo/audit-store.ts IntegrityWarning kinds) and the projects'
 * standing warnings. `p` is the project's name ("library" for library-wide ones). The service's
 * detail is never shown: it can carry ids, paths and transaction names.
 */
const WARNINGS: Record<string, (p: string) => string> = {
  "chain-broken": (p) => `The audit log of ${p} does not hold together: an entry was changed or removed outside the app. Your sources are unchanged; check the verification report.`,
  "head-mismatch": (p) => `The audit log of ${p} does not match the record this computer keeps of it. It may have been changed outside the app; check the verification report.`,
  truncated: (p) => `The audit log of ${p} is shorter than this computer's record of it: recent entries may have been removed outside the app.`,
  empty: (p) => `The audit log of ${p} is empty although this computer has a record of it. It may have been replaced outside the app.`,
  "anchor-missing": (p) => `The audit log may have been changed outside the app (${p}): this computer has no record to check it against. It is checked from now on.`,
  "anchors-unreadable": () => "This computer's record of the audit logs could not be read, so they could not be checked this time. Nothing in the library was changed.",
  "rolled-back-incomplete-write": (p) => `An interrupted change in ${p} was undone when the library opened, so nothing half-saved was kept.`,
  "invalid-txn-marker": (p) => `A note left by an interrupted change in ${p} could not be read. It was kept aside and nothing was changed.`,
  "incomplete-write-pending": (p) => `An interrupted change in ${p} could not be finished or undone yet. It is tried again when the library is next opened with write access.`,
  "txn-recovery-skipped-audit-unverifiable": (p) => `An interrupted change in ${p} was left as it is, because its audit log could not be checked first. It is tried again on the next open.`,
  "trimmed-incomplete-audit-line": (p) => `The last entry of an audit log in ${p} was cut off by a crash and has been removed. The removal is recorded.`,
  "incomplete-audit-line-pending": (p) => `The last entry of an audit log in ${p} was cut off by a crash. It is tidied up when the library is next opened with write access.`,
  "audit-append-failed-at-open": (p) => `A check made while opening ${p} could not be recorded in the audit log, so changes to ${p} are off until the library is opened again.`,
  "backup-failed": (p) => `The last automatic backup of ${p} failed. Your sources are unchanged; the backup is tried again tomorrow, or make one now from the project's settings.`,
  "deleted-records-unreadable": (p) =>
    `The record of deleted items in ${p} could not be read. It was set aside; deleting still works, but re-importing from Zotero is paused until the record is reset.`,
  "annotations-unreadable": (p) => `Some annotations in ${p} could not be read. The sources still open; the annotations that could not be read are not shown.`,
  "annotations-hash-mismatch": (p) => `Some annotations in ${p} were changed outside the app. They are shown as they are now.`,
  "destroy-incomplete": (p) =>
    `A destruction of raw data in ${p} did not finish: some files could not be overwritten yet. They are kept out of the project and overwriting is tried again each time the library opens.`,
  "protocol-manifest-unreadable": (p) => `The sealed list of protocol document names in ${p} could not be read. The documents themselves are unchanged; check the verification report.`,
  "recovery-code-unshown": (p) =>
    `A new recovery code for ${p} was issued, but the app stopped before it could be shown, so no one has it. The earlier recovery code no longer works; the passphrase still does. Unlock ${p} and choose “New recovery code…” to get one you can save.`,
  "retention-due": (p) => `${p} has reached its retention date. Review which raw data must now be destroyed or kept.`,
};

/** The sentence for a warning kind; an unknown kind gets a generic sentence (never the detail). */
export function warningText(kind: string, project: string): string {
  const known = Object.hasOwn(WARNINGS, kind) ? WARNINGS[kind] : undefined;
  return known ? known(project) : `Something in ${project} needs attention. Open the verification report for details.`;
}

function text(v: BannerVariant): string {
  switch (v.kind) {
    case "read-only-locked":
      return `Read-only (locked by ${v.hostname ?? "another device"}). Changes are off until the library is closed there.`;
    case "read-only-newer-format":
      return "Read-only — newer format. This library was saved by a newer version of the app; update the app to make changes.";
    case "read-only":
      return `Read-only${v.reason && READ_ONLY_REASONS[v.reason] ? ` — ${READ_ONLY_REASONS[v.reason]}` : ""}. Changes are off.`;
    case "offline":
      return `Offline — reconnecting when ${v.volume} returns. Nothing can be changed until then; nothing is lost.`;
    case "index-rebuilding":
      return `Index rebuilding ${v.done}/${v.total}. Search results may be incomplete until it finishes.`;
    case "warning":
      return warningText(v.warning, v.project);
  }
}

const TONE: Record<BannerVariant["kind"], string> = {
  "read-only-locked": "warn",
  "read-only-newer-format": "warn",
  "read-only": "warn",
  offline: "warn",
  "index-rebuilding": "info",
  warning: "warn",
};

/** Warnings about an interrupted change the researcher can resolve by hand (R27). */
export const RESOLVABLE_WARNINGS: ReadonlySet<string> = new Set(["incomplete-write-pending", "invalid-txn-marker", "txn-recovery-skipped-audit-unverifiable"]);

export function StatusBanner({ variant, onResolve }: { variant: BannerVariant; onResolve?: () => void }) {
  const resolvable = !!onResolve && variant.kind === "warning" && RESOLVABLE_WARNINGS.has(variant.warning);
  // Project names and service details are user text: shown with dir=auto inside the sentence.
  return (
    <div role="status" className={`ao-banner ao-banner--${TONE[variant.kind]}`}>
      <UserText>{text(variant)}</UserText>
      {resolvable && (
        <>
          {" "}
          <button type="button" className="ao-small" aria-label={`Resolve the interrupted change in ${variant.project}…`} onClick={onResolve}>
            Resolve…
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The drive or share a library path lives on, for "reconnecting when <volume> returns":
 * /Volumes/<name>, /media/<user>/<name>, /run/media/<user>/<name>, /mnt/<name>, a Windows drive
 * letter or a UNC share; otherwise "the drive holding <folder>".
 */
export function volumeOf(path: string): string {
  let m = /^\/Volumes\/([^/]+)/.exec(path) ?? /^\/(?:run\/)?media\/[^/]+\/([^/]+)/.exec(path) ?? /^\/mnt\/([^/]+)/.exec(path);
  if (m) return m[1]!;
  m = /^([A-Za-z]:)[\\/]/.exec(path);
  if (m) return m[1]!.toUpperCase();
  m = /^(\\\\[^\\]+\\[^\\]+)/.exec(path);
  if (m) return m[1]!;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return `the drive holding ${parts.at(-1) ?? "the library"}`;
}

export interface BannerContext {
  projectNames?: Record<string, string>;
  index?: { done: number; total: number } | undefined;
  volume?: string;
  hostname?: string;
}

/** Banners for the library's state, in order: access, index progress, integrity warnings, project warnings. */
export function bannersFor(state: Pick<LibraryState, "mode" | "readOnlyReason" | "integrityWarnings" | "projectWarnings">, ctx: BannerContext = {}): BannerVariant[] {
  const out: BannerVariant[] = [];
  if (state.mode === "read-only") {
    const r = state.readOnlyReason;
    if (r === "locked-by-other-device") out.push(ctx.hostname ? { kind: "read-only-locked", hostname: ctx.hostname } : { kind: "read-only-locked" });
    else if (r === "newer-format") out.push({ kind: "read-only-newer-format" });
    else if (r === "offline") out.push({ kind: "offline", volume: ctx.volume ?? "the library's drive" });
    else out.push(r ? { kind: "read-only", reason: r } : { kind: "read-only" });
  }
  if (ctx.index && ctx.index.done < ctx.index.total) out.push({ kind: "index-rebuilding", ...ctx.index });
  for (const w of state.integrityWarnings ?? ([] as IntegrityWarning[])) out.push({ kind: "warning", warning: w.kind, project: w.project, detail: w.detail });
  for (const [pid, list] of Object.entries(state.projectWarnings ?? {})) {
    for (const w of list) out.push({ kind: "warning", warning: w, project: ctx.projectNames?.[pid] ?? "a project" });
  }
  return out;
}
