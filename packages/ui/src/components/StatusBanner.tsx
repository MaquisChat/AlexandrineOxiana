/**
 * The library's status, in plain language (spec 4.5; R113): read-only (locked by <hostname>,
 * newer format, other reasons), offline until the drive returns, the index rebuilding, and the
 * library's integrity warnings and projects' standing warnings. Warning codes are never shown as
 * such; an unknown one shows the service's own (path-scrubbed) detail.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  DESTRUCTION_OLD_COPIES_PENDING_WARNING,
  INCOMPLETE_ROLLBACK_BANNER,
  ZOTERO_SYNC_SENTENCES,
  isDeviceNoticeKind,
  oldCopiesPendingText,
  type DeviceNoticeKind,
  type IncompleteRollback,
} from "@ao/shared";
import { errorText, type IntegrityWarning, type LibraryState } from "../api/library";
import { inAppLink, PATHS } from "../navigation";
import { UserText } from "./UserText";
import "./library.css";

export type BannerVariant =
  | { kind: "read-only-locked"; hostname?: string }
  | { kind: "read-only-newer-format" }
  | { kind: "read-only"; reason?: string }
  | { kind: "offline"; volume: string }
  /** `total` 0: the rebuild has started but not counted the sources yet. */
  | { kind: "index-rebuilding"; done: number; total: number }
  /** The index could not be rebuilt (D8); the service's reason is not shown (it can name files). */
  | { kind: "index-failed" }
  /**
   * `detail` is accepted for the record but never shown (R114 I1). `oldCopies`: for
   * `destruction-old-copies-pending`, the sentence that fits and the old copies' places, shown under
   * it (R409 d). `count`: how many warnings of this kind in this project the banner stands for (R484 f). `state`: an
   * interrupted change whose undo is not complete, by its state (FR-736): its sentence, and "Resolve…".
   */
  | {
      kind: "warning";
      warning: string;
      project: string;
      detail?: string;
      oldCopies?: { text: string; places: string[] };
      count?: number;
      state?: IncompleteRollback;
      /** FR-729: kept with the library until dismissed ("Dismiss"). */
      keptId?: string;
    }
  /** This computer's own notice (Task 68, R154, R178): fixed words by kind; goes by "Got it". */
  | { kind: "notice"; notice: DeviceNoticeKind };

/**
 * The words of each device-level notice (Task 68). Only what is true (R181 b, d): a renewed identity
 * leaves the libraries unchanged; only when a new program happens to reuse the old one's process
 * number can a library stay read-only until its old lock is 2 minutes stale (packages/library
 * lock.ts); changes from now on are recorded under the new identity. No notice names a screen that
 * does not exist: there is no watched-folders screen yet, so that notice says only what happened.
 */
export const NOTICE_TEXT: Record<DeviceNoticeKind, string> = {
  "device-identity-renewed":
    "This computer's identity for the app could not be read and had to be renewed. Your libraries and what is in them are unchanged. A library that was open when the app last stopped may show as read-only for up to 2 minutes; open it again after that. The changes you make from now on are recorded under this computer's new identity. The damaged identity file is kept beside the app's settings.",
  "old-copies-list-set-aside":
    "The list of old library copies awaiting deletion was damaged and was set aside. Some old copies of moved libraries may still be on this computer without being offered for deletion here, and a move that had not finished may not be able to finish from here. The damaged list is kept beside the app's settings.",
  "watched-folders-list-set-aside":
    "This computer's list of watched folders was damaged and was set aside, so some watched folders on this computer may have stopped: files put in those folders are not imported. The damaged list is kept beside the app's settings.",
  "libraries-list-set-aside":
    "This computer's list of libraries was damaged and was set aside. Any libraries it could still read are listed as before. Your libraries themselves are untouched. A library missing from the list can be opened again from its folder with “Open library”. The damaged list is kept beside the app's settings.",
  "approved-folders-list-set-aside":
    "This computer's list of folders approved for imports was damaged and was set aside. An import will ask again before it uses files from a folder outside the one you import from. The damaged list is kept beside the app's settings.",
  "watched-folder-choices-set-aside":
    "This computer's choices for its watched folders were damaged and were set aside. Folders whose choices could not be kept went back to the defaults: they are watched, not paused, and files that are not downloaded to this Mac are left alone. The damaged file is kept beside the app's settings.",
  "zotero-sync-settings-set-aside": ZOTERO_SYNC_SENTENCES.settingsSetAside,
  "zotero-sync-settings-newer":
    "These sync settings were written by a newer version of the app. Update the app to change them. Until then, automatic sync with Zotero is off on this computer. Nothing in your library has changed.",
};

const READ_ONLY_REASONS: Record<string, string> = {
  "not-writable": "this folder cannot be written to",
  moved: "this is the old copy of a library that was moved",
  "move-incomplete": "a move into this folder has not finished",
};

/**
 * Plain-language text for every warning the service raises (R114 I1): the library's integrity
 * warnings (packages/library/src/repo/audit-store.ts IntegrityWarning kinds) and the projects'
 * standing warnings. `p` is the project's name ("library" for library-wide ones); `n`, for the kinds shown once
 * per project, how many there are. The service's detail is never shown: it can carry ids, paths and transaction names.
 */
const WARNINGS: Record<string, (p: string, n: number) => string> = {
  "chain-broken": (p) => `The audit log of ${p} does not hold together: an entry was changed or removed outside the app. Your sources are unchanged; check the verification report.`,
  "head-mismatch": (p) => `The audit log of ${p} does not match the record this computer keeps of it. It may have been changed outside the app; check the verification report.`,
  truncated: (p) => `The audit log of ${p} is shorter than this computer's record of it: recent entries may have been removed outside the app.`,
  empty: (p) => `The audit log of ${p} is empty although this computer has a record of it. It may have been replaced outside the app.`,
  "anchor-missing": (p) => `The audit log may have been changed outside the app (${p}): this computer has no record to check it against. It is checked from now on.`,
  "anchors-unreadable": () => "This computer's record of the audit logs could not be read, so they could not be checked this time. Nothing in the library was changed.",
  // For this session only (Task 68 round 2, Rm4): the service could not read this computer's watched folders at open.
  // Said of the opening (R465 b), so it stays true when a folder added or retried later does run.
  "watched-folders-unreadable": () =>
    "This computer's list of watched folders could not be read when this library was opened, so its watched folders were not started then. Files put in them are not imported until they run. Open the library again to start them all.",
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
  // R473 I1, R484 f: sources whose change did not finish and whose roll-back failed, for as long as the roll-back
  // waits; one banner per project ("this source" is said only for the source itself, in the library's own sentence).
  // FR-736: never "close the library and open it again", which cannot help while a file is in the way: the list says.
  // R528 M5: never "yet", untrue of a change that can never be undone completely.
  "source-change-unfinished": (p, n) =>
    n === 1
      ? `A change to a source in ${p} did not finish and could not be undone. Choose “Resolve…” to see what can be done.`
      : `Changes to ${n} sources in ${p} did not finish and could not be undone. Choose “Resolve…” to see what can be done.`,
  "source-change-unfinished-read-only": (p, n) =>
    n === 1
      ? `A change to a source in ${p} did not finish and could not be undone. It can be put back only when the library is opened for changes.`
      : `Changes to ${n} sources in ${p} did not finish and could not be undone. They can be put back only when the library is opened for changes.`,
  // R509: an interrupted change closed as it was, by the researcher's choice; the path is in the audit log only (R503 d).
  "interrupted-change-closed": (p) =>
    `An interrupted change in ${p} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone: that file is lost. The closing is recorded in the audit log of ${p}.`,
  // FR-729: the record of recovery's warnings kept until dismissed could not be read (set aside when writable).
  "recovery-warnings-set-aside": () =>
    "The library's record of earlier warnings about interrupted changes could not be read, so some of those warnings may not be shown again. The damaged record is kept in the library's work folder.",
  "destroy-incomplete": (p) =>
    `A destruction of raw data in ${p} did not finish: some files could not be overwritten yet. They are kept out of the project and overwriting is tried again each time the library opens.`,
  "protocol-manifest-unreadable": (p) => `The sealed list of protocol document names in ${p} could not be read. The documents themselves are unchanged; check the verification report.`,
  "recovery-code-unshown": (p) =>
    `A new recovery code for ${p} was issued, but the app stopped before it could be shown, so no one has it. The earlier recovery code no longer works; the passphrase still does. Unlock ${p} and choose “New recovery code…” to get one you can save.`,
  "recovery-staging-discarded": (p) =>
    `A key file waiting to be put in place in ${p} was not the one recorded when its recovery code was issued, so it was removed and not used. ${p}'s recovery code and passphrase are unchanged.`,
  "recovery-staging-unverifiable": (p) =>
    `A new recovery code for ${p} is waiting to be put in place, but ${p}'s audit log does not verify, so the app cannot tell whether it was really issued. Nothing was changed: the current recovery code and the passphrase still work. Open the verification report for details.`,
  "audit-unrecorded": (p) =>
    `A change to ${p} is not recorded in its audit log yet. The change was kept; it is recorded the next time the library is opened with write access. You can review it on the audit screen.`,
  "audit-unrecorded-blocked": (p) =>
    `A change to ${p} is not recorded in its audit log, and it cannot be while that log does not verify or a problem reported for ${p} is unresolved. The change was kept. Review it on the audit screen, where you can set it aside with a reason.`,
  "attention-unreadable": (p) =>
    `An unrecognised item is in the attention folder of ${p}. It is kept and never opened. Review it on the audit screen, where you can set it aside with a reason.`,
  "audit-waiting": (p) =>
    `A change to ${p} made here is kept on this computer because another computer had the library open. It is recorded when this computer next opens the library with write access.`,
  "permissions-not-set": (p) =>
    `A file restored to ${p} could not be made private to you on this disk. The file was kept; making it private is tried again each time the library opens. If this disk cannot do it, set it aside on the audit screen with a reason.`,
  "audit-recorded-late": (p) =>
    `Changes to ${p} that could not be recorded at the time were recorded in the audit log of ${p} now. They are marked as recorded late.`,
  "refusal-unrecorded": () => "A refused request could not be recorded in the library's audit log. Nothing was changed.",
  "retention-due": (p) => `${p} has reached its retention date. Review which raw data must now be destroyed or kept.`,
  // Only until what stands behind it arrives: then the sentence that fits, from @ao/shared (R409 d).
  [DESTRUCTION_OLD_COPIES_PENDING_WARNING]: () => "Old copies of this library, left by a move, still hold data that was destroyed here.",
};

/** R527: a change closed as it was, where something stood at each place whose file could not be put back. */
const CLOSED_UNCONFIRMED = (p: string) =>
  `An interrupted change in ${p} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone; the app could not confirm that what is at its place is that file. The closing is recorded in the audit log of ${p}.`;

/** The kinds that stand for an interrupted change whose undo may be incomplete; with a `state`, it is (FR-736). */
const ROLLBACK_KINDS: ReadonlySet<string> = new Set(["rolled-back-incomplete-write", "incomplete-write-pending"]);

/** The sentence for a warning kind; an unknown kind gets a generic sentence (never the detail). */
export function warningText(kind: string, project: string, count = 1, state?: IncompleteRollback): string {
  // FR-736: an undo that is not complete says its state, in the library's shared sentence.
  if (state && ROLLBACK_KINDS.has(kind) && Object.hasOwn(INCOMPLETE_ROLLBACK_BANNER, state)) return INCOMPLETE_ROLLBACK_BANNER[state](project);
  // R527: a change closed where something stood at the place: never "that file is lost".
  if (kind === "interrupted-change-closed" && state === "unconfirmed") return CLOSED_UNCONFIRMED(project);
  const known = Object.hasOwn(WARNINGS, kind) ? WARNINGS[kind] : undefined;
  return known ? known(project, count) : `Something in ${project} needs attention. Open the verification report for details.`;
}

/**
 * A warning's sentence with only the project's name laid out by its own direction (FR-158): a right-to-left name at the
 * start of the sentence no longer turns the whole English sentence round. Each place the name stands is isolated.
 * `count`: how many warnings of this kind in this project the sentence stands for (R484 f).
 */
function warningSentence(kind: string, project: string, count = 1, state?: IncompleteRollback): ReactNode {
  const mark = "\u0000";
  return warningText(kind, mark, count, state)
    .split(mark)
    .flatMap((part, i) => (i === 0 ? [part] : [<UserText key={i}>{project}</UserText>, part]));
}

/** Kinds the library records once per source folder, shown once per project with their number (R484 f). */
const PER_PROJECT: ReadonlySet<string> = new Set(["source-change-unfinished", "source-change-unfinished-read-only"]);

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
      return v.total > 0 ? `Index rebuilding ${v.done}/${v.total}. Search results may be incomplete until it finishes.` : "Index rebuilding. Search results may be incomplete until it finishes.";
    case "index-failed":
      return "The library's search index could not be rebuilt, so sources and search may be incomplete. Your sources are safe in the library folder.";
    case "warning":
      return v.oldCopies?.text ?? warningText(v.warning, v.project, v.count, v.state);
    case "notice":
      return NOTICE_TEXT[v.notice];
  }
}

const TONE: Record<BannerVariant["kind"], string> = {
  "read-only-locked": "warn",
  "read-only-newer-format": "warn",
  "read-only": "warn",
  offline: "warn",
  "index-rebuilding": "info",
  "index-failed": "warn",
  warning: "warn",
  notice: "warn",
};

/**
 * The researcher's "Got it" for this computer's notices (Task 68), shared by the library's banner
 * area and the chooser: one request per notice (a second click while it runs does nothing), then
 * `onGone(kind)`; a refusal is kept in `error`, in plain words.
 */
export function useNoticeDismiss(dismiss: (kind: DeviceNoticeKind) => Promise<unknown>, onGone: (kind: DeviceNoticeKind) => void): { onDismiss: (kind: DeviceNoticeKind) => void; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const running = useRef(new Set<string>());
  const onDismiss = (kind: DeviceNoticeKind) => {
    if (running.current.has(kind)) return;
    running.current.add(kind);
    setError(null);
    dismiss(kind).then(
      () => {
        running.current.delete(kind);
        onGone(kind);
      },
      (err: unknown) => {
        running.current.delete(kind);
        setError(errorText(err, "The notice could not be removed."));
      },
    );
  };
  return { onDismiss, error };
}

/** This computer's notices as banners with "Got it", for a page without a library's banners (the chooser). */
export function DeviceNoticeBanners({ notices, onDismiss, error }: { notices: LibraryState["notices"]; onDismiss: (kind: DeviceNoticeKind) => void; error: string | null }) {
  const banners = bannersFor({ notices });
  if (!banners.length && !error) return null;
  return (
    <div className="ao-library__banners" role="region" aria-label="Notices">
      {banners.map((b) => (b.kind === "notice" ? <StatusBanner key={`notice-${b.notice}`} variant={b} onDismiss={onDismiss} /> : null))}
      {error && (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Warnings about an interrupted change the researcher can resolve by hand (R27); also, by FR-736, a source whose change
 * did not finish, and any interrupted change whose undo is not complete (a `state`).
 */
export const RESOLVABLE_WARNINGS: ReadonlySet<string> = new Set(["incomplete-write-pending", "invalid-txn-marker", "txn-recovery-skipped-audit-unverifiable", "source-change-unfinished"]);

export function StatusBanner({
  variant,
  onResolve,
  onDismiss,
  onDismissWarning,
}: {
  variant: BannerVariant;
  onResolve?: () => void;
  onDismiss?: (notice: DeviceNoticeKind) => void;
  /** FR-729: dismisses a warning kept with the library; not given in a read-only library, which writes nothing. */
  onDismissWarning?: (keptId: string) => void;
}) {
  const resolvable = !!onResolve && variant.kind === "warning" && (RESOLVABLE_WARNINGS.has(variant.warning) || (variant.state !== undefined && ROLLBACK_KINDS.has(variant.warning)));
  // Project names and service details are user text, shown with dir=auto; in a warning only the project's name (FR-158).
  return (
    <div role="status" className={`ao-banner ao-banner--${TONE[variant.kind]}`}>
      {variant.kind === "warning" && !variant.oldCopies ? <span>{warningSentence(variant.warning, variant.project, variant.count, variant.state)}</span> : <UserText>{text(variant)}</UserText>}
      {variant.kind === "warning" && !!variant.oldCopies?.places.length && (
        <ul>
          {variant.oldCopies.places.map((p) => (
            <li key={p}>
              <UserText>{p}</UserText>
            </li>
          ))}
        </ul>
      )}
      {variant.kind === "index-failed" && (
        <>
          {" "}
          <a href={PATHS.missingFiles} onClick={inAppLink}>
            Rebuild library from folder
          </a>
        </>
      )}
      {variant.kind === "notice" && onDismiss && (
        <>
          {" "}
          <button type="button" className="ao-small" onClick={() => onDismiss(variant.notice)}>
            Got it
          </button>
        </>
      )}
      {resolvable && (
        <>
          {" "}
          <button type="button" className="ao-small" aria-label={`Resolve the interrupted change in ${variant.project}…`} onClick={onResolve}>
            Resolve…
          </button>
        </>
      )}
      {variant.kind === "warning" && variant.keptId !== undefined && onDismissWarning && (
        <>
          {" "}
          <button type="button" className="ao-small" aria-label={`Dismiss this warning about ${variant.project}`} onClick={() => onDismissWarning(variant.keptId!)}>
            Dismiss
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
export function bannersFor(state: Partial<Pick<LibraryState, "mode" | "readOnlyReason" | "integrityWarnings" | "projectWarnings" | "index" | "notices" | "destructionOldCopiesPending">>, ctx: BannerContext = {}): BannerVariant[] {
  const out: BannerVariant[] = [];
  if (state.mode === "read-only") {
    const r = state.readOnlyReason;
    if (r === "locked-by-other-device") out.push(ctx.hostname ? { kind: "read-only-locked", hostname: ctx.hostname } : { kind: "read-only-locked" });
    else if (r === "newer-format") out.push({ kind: "read-only-newer-format" });
    else if (r === "offline") out.push({ kind: "offline", volume: ctx.volume ?? "the library's drive" });
    else out.push(r ? { kind: "read-only", reason: r } : { kind: "read-only" });
  }
  // The library's state says a rebuild runs (D8) even before progress arrives; progress events say how far.
  const idx = state.index;
  if (idx?.state === "rebuilding") {
    const p = ctx.index && ctx.index.done < ctx.index.total ? ctx.index : { done: idx.done, total: idx.total };
    out.push({ kind: "index-rebuilding", ...p });
  } else if (idx?.state === "failed") out.push({ kind: "index-failed" });
  else if (ctx.index && ctx.index.done < ctx.index.total) out.push({ kind: "index-rebuilding", ...ctx.index });
  /** The banner standing for each project's warnings of a kind shown once per project (R484 f), by project and kind. */
  const grouped = new Map<string, { count: number }>();
  for (const w of state.integrityWarnings ?? ([] as IntegrityWarning[])) {
    if (!PER_PROJECT.has(w.kind)) {
      out.push({ kind: "warning", warning: w.kind, project: w.project, detail: w.detail, ...(w.state ? { state: w.state } : {}), ...(w.keptId ? { keptId: w.keptId } : {}) });
      continue;
    }
    const key = JSON.stringify([w.projectId, w.kind]);
    const seen = grouped.get(key);
    if (seen) seen.count += 1;
    else {
      const b = { kind: "warning" as const, warning: w.kind, project: w.project, count: 1 };
      grouped.set(key, b);
      out.push(b);
    }
  }
  for (const [pid, list] of Object.entries(state.projectWarnings ?? {})) {
    for (const w of list) {
      const project = ctx.projectNames?.[pid] ?? "a project";
      // The old copies behind the warning (R409 d): every sentence that applies, and each known place,
      // also under "could not be checked" (R429 f).
      const copies = w === DESTRUCTION_OLD_COPIES_PENDING_WARNING ? state.destructionOldCopiesPending?.[pid] : undefined;
      if (copies && Array.isArray(copies.oldCopies)) {
        const places = [...new Set(copies.oldCopies.flatMap((c) => (typeof c.place === "string" ? [c.place] : [])))];
        out.push({ kind: "warning", warning: w, project, oldCopies: { text: oldCopiesPendingText(copies), places } });
      } else out.push({ kind: "warning", warning: w, project });
    }
  }
  // This computer's own notices (Task 68): known kinds only, once each.
  const seen = new Set<string>();
  for (const n of state.notices ?? []) {
    if (!isDeviceNoticeKind(n?.kind) || seen.has(n.kind)) continue;
    seen.add(n.kind);
    out.push({ kind: "notice", notice: n.kind });
  }
  return out;
}
