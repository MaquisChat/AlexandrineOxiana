/**
 * One entry of the Find and acquire queue (Task F6): what was typed, the work it was matched to, and where it
 * stands — always in words (A2, A3, A4). A symbol beside the state is decoration only (`aria-hidden`); nothing is
 * told by colour or symbol alone. A reason is always the service's sentence from FIND_REASON_TEXT, never a code;
 * a state this build does not know (written by a later version) is "This entry needs a newer version of the app."
 * with only "Remove from the queue".
 *
 * Every action is a button whose accessible name includes what was typed (cut at 80 characters with an ellipsis,
 * in the NAME only: the row shows it all). A button whose act is under way shows it, keeps focus and ignores a
 * second press; the row's other acts wait. While the library is read-only every act that would change it is
 * disabled ("Open" stays). Everything typed or sent by a service is shown through UserText.
 *
 * An author alone (Task F9; R267, R270, R271): an author's entry reads "Author: <typed>" with "N people match" and
 * "Choose the person", or "Choose works" (and "N added" once works were added from it; it stays so until removed).
 * An entry made from an author's entry says where it came from — "Added from “<what was typed for the author>”", or
 * "Added from an author's works" when that entry is gone — so a line the app built is never shown as typed alone.
 *
 * The copy part (Task F11; R282, R296, R301, R303): "Try again" where the engine takes it (a record whose copy the
 * rules or the waiting files' limit stopped; no open copy because some services could not be reached; a copy wait);
 * "Needs your check" offers the link "Check the file" to that record's entry in the review queue — the app never
 * attaches a found file by itself; a record removed from the library offers only "Remove from the queue".
 *
 * The states of later slices are said in words, with "Remove from the queue" (and "Open" when the entry has a
 * record), and no control of a later slice.
 *
 * Through the researcher's library (Task F18b; R340, R301): "Get through my library" is on a row exactly when its view
 * says a start is offered (`library.canStart === true`) — the row works out nothing; a view saying no library is set
 * gives the service's sentence and a link to "Your library"; the view's `lastFile` gives the service's sentence for a
 * file that was not kept (none for a code this build does not know). A row waiting in the sign-in window has "Add the
 * PDF showing in the sign-in window" and "Cancel". Outside the desktop app the two controls that need the shell are
 * shown unavailable ("Only in the desktop app"), stay reachable by keyboard, and a press does nothing. What the shell
 * reported for the row is the screen's `note`. "Where to get it" is WhereToGetIt, on every row whose view carries links
 * (never on a record removed from the library).
 */
import { FIND_LIBRARY_FILE_OUTCOMES, FIND_LIBRARY_FILE_TEXT, FIND_LIBRARY_TEXT, FIND_MORE_PEOPLE_TEXT, FIND_REASON_CODES, FIND_REASON_TEXT, type FindEntryView, type FindLibraryFileOutcome, type FindReasonCode, type FindWorkCandidate } from "@ao/shared";
import { Component, memo, useId, type ReactNode } from "react";
import { creatorsText, isKnownState, kindWords, usableCandidates, yearOf } from "../api/find";
import { inDesktopShell } from "../desktopShell";
import { inAppLink, PATHS } from "../navigation";
import { UserText } from "./UserText";
import { WhereToGetIt } from "./WhereToGetIt";

export type FindActKind =
  | "choose"
  | "choose-person"
  | "choose-works"
  | "open"
  | "open-there"
  | "add-here"
  | "same"
  | "different"
  | "retry"
  | "remove"
  // Task F18b (R340): through the researcher's library.
  | "library"
  | "library-take"
  | "library-cancel";

/** What the researcher pressed on a row. */
export interface FindAction {
  kind: FindActKind;
  entry: FindEntryView;
}

/** Where a match in another project is, as the service said at request time (never stored). */
export type FindPlace = { status: "loading" } | { status: "known"; projectName: string } | { status: "locked" };

/** Text with the parts that are outside text marked: shown through UserText, said as they are. */
export type Words = Array<string | { user: string }>;

export const wordsText = (w: Words): string => w.map((p) => (typeof p === "string" ? p : p.user)).join("");

export function WordsView({ words }: { words: Words }) {
  return (
    <>
      {words.map((p, i) => (typeof p === "string" ? <span key={i}>{p}</span> : <UserText key={i}>{p.user}</UserText>))}
    </>
  );
}

export const FIND_TEXT = {
  newerVersion: "This entry needs a newer version of the app.",
  notNow: "Not being looked up now",
  elsewhereLoading: "Already in another of your projects",
  elsewhereLocked: "Already in another project that is locked now.",
  maybeElsewhereLocked: "Possibly already in another project that is locked now.",
  noMatches: "No possible matches.",
  // Task F9 (R267, R271): an author alone.
  authorLead: "Author: ",
  /** R281 a: an entry made from an author's entry is a work the app added, not a line typed. */
  workLead: "Work: ",
  /** The plan's words (FIND_MORE_PEOPLE_TEXT), as a sentence. */
  morePeople: `${FIND_MORE_PEOPLE_TEXT}.`,
  noWorks: "No works are listed for this person.",
  /** An entry made from an author's entry whose parent is no longer in the queue (R271 M7). */
  originGone: "Added from an author's works",
  // Task F11: the copy part.
  checkFile: "Check the file",
  // Task F18b (R340): through the researcher's library. None of these says or implies that the app adds a file (R301).
  yourLibrary: "Your library",
  onlyDesktop: "Only in the desktop app",
  windowNotOpened: "The sign-in window could not be opened. Nothing was changed.",
  windowClosed: "The sign-in window was closed.",
  fetching: "Fetching the PDF…",
  notAPdf: "That page is not a PDF. Open the PDF in the sign-in window and the app will fetch it for you to check.",
  fetchPause: "The sign-in window rests for a few seconds between files. Try again shortly.",
  fetchBusy: "The PDF is already being fetched.",
  fetchFailed: "The PDF could not be fetched. Try again in the sign-in window.",
  handedOver: "The file was fetched and is being checked.",
  appSilent: "The app did not answer. Try again.",
} as const;

/** Reasons on "record-complete" that "Try again" takes (F11: the rules, the store part, the waiting files' limit; R326 adds "switched off" by the settings in `actionsOf`). */
const COPY_RETRY_REASONS: ReadonlySet<string> = new Set<FindReasonCode>(["copy-not-allowed", "copy-store-not-allowed", "copy-no-legal-basis", "held-full"]);

/** The record's entry in the project's review queue (the queue opened at that record's entries). */
export const reviewEntryHref = (e: FindEntryView): string =>
  `${PATHS.reviewQueue}?project=${encodeURIComponent(e.projectId)}${typeof e.sourceId === "string" ? `&source=${encodeURIComponent(e.sourceId)}` : ""}`;

/** The view's library part, read defensively (a later build's shape is no part). */
const libraryOf = (e: FindEntryView): Record<string, unknown> | undefined => {
  const l: unknown = e.library;
  return l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : undefined;
};
/** R340 a: the service says a start is offered — exactly `canStart: true`. */
export const libraryOffered = (e: FindEntryView): boolean => libraryOf(e)?.canStart === true;
/** R340 a: the service says no library is set. */
const noLibrarySet = (e: FindEntryView): boolean => {
  const l = libraryOf(e);
  return l?.canStart === false && l.reason === "no-library";
};
/** R340 c: the service's code for a file from the library that was not kept, when this build knows it. */
const lastFileOf = (e: FindEntryView): FindLibraryFileOutcome | undefined => {
  const f = libraryOf(e)?.lastFile;
  return typeof f === "string" && (FIND_LIBRARY_FILE_OUTCOMES as readonly string[]).includes(f) ? (f as FindLibraryFileOutcome) : undefined;
};
/** The acts that need the desktop shell: outside it they are shown unavailable and do nothing (R340 a). */
const SHELL_ACTS: ReadonlySet<FindActKind> = new Set(["library", "library-take"]);

/** A record removed from the library: its entry offers only its removal (R282 g). */
const recordRemoved = (e: FindEntryView): boolean => e.reason?.code === "record-removed";

/** A count from the service, or undefined when it is not a whole number of at least 0. */
const countOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/**
 * An author's entry (F8, R267): one that holds people or works — its counts say so — or asks for a person or works.
 * It stays one after the person is chosen (while the works are fetched, and after works were added from it).
 */
export const isAuthorEntry = (e: FindEntryView): boolean =>
  e.state === "choose-person" || e.state === "choose-works" || (e.state !== "choose" && (countOf(e.peopleCount) !== undefined || countOf(e.worksCount) !== undefined));

/**
 * R279 (F8b's contract, built against the ruling): an entry in "choose" whose words may also name an author carries
 * `authorOffer`. Read defensively: a later build's shape that is not this one counts as no offer.
 */
export type FindAuthorOffer = { peopleCount: number; morePeople?: true };
export function authorOfferOf(e: FindEntryView): FindAuthorOffer | undefined {
  const o: unknown = e.authorOffer;
  if (e.state !== "choose" || !o || typeof o !== "object") return undefined;
  const k = countOf((o as Record<string, unknown>).peopleCount);
  if (k === undefined) return undefined;
  return { peopleCount: k, ...((o as Record<string, unknown>).morePeople === true ? { morePeople: true as const } : {}) };
}

/**
 * How an entry is named in a button's name and in the status region (R281 a). What the researcher typed is in
 * quotation marks ("“Bourdieu, Distinction”"); an entry made from an author's entry is named by the line the app built
 * for it, WITHOUT those marks, and where it came from: "Game Changer, Vaan (added from “David Stark”)", or "… (added
 * from an author's works)" when that entry is gone. `origin`: undefined for an ordinary entry; the author's typed text,
 * or null, for an added one. `max`: cut the entry's own line to this many characters (names: 80).
 */
export function entryLabel(e: FindEntryView, origin: string | null | undefined, max?: number): Words {
  const own = typeof e.typed === "string" ? (max === undefined ? e.typed : shortTyped(e.typed)) : "";
  if (origin === undefined || typeof e.parentId !== "string") return own ? ["“", { user: own }, "”"] : [];
  const from: Words = typeof origin === "string" ? [" (added from “", { user: max === undefined ? origin : shortTyped(origin) }, "”)"] : [" (added from an author's works)"];
  return own ? [{ user: own }, ...from] : from;
}

/** An entry this build can show: a known state and text that was typed (else "needs a newer version", R258 M6). */
export const entryKnown = (e: FindEntryView): boolean => isKnownState(e.state) && typeof e.typed === "string";
const candidatesOf = (e: FindEntryView) => usableCandidates(e);

/** The plan's words for each state (Accept 3), and the design's for the states of later slices. */
const STATE_WORDS = {
  "looking-up": "Looking it up",
  "choose-person": "Choose the person",
  "choose-works": "Choose works",
  "maybe-duplicate": "Possibly already in your library",
  "record-complete": "Record complete",
  "looking-for-copy": "Looking for a copy",
  fetching: "Fetching",
  "in-library": "In your library",
  already: "Already in your library",
  "no-open-copy": "No open copy",
  "waiting-sign-in": "Waiting for you in the sign-in window",
  "needs-check": "Needs your check",
  "not-found": "Not found",
} as const;

/** Decoration beside the state (the design's mock-up); hidden from screen readers. */
const MARKS: Partial<Record<string, string>> = { "looking-up": "●", choose: "?", "choose-person": "?", "choose-works": "?", "maybe-duplicate": "≈", "record-complete": "✓", already: "=", "not-found": "∅", failed: "!" };

const knownReason = (code: unknown): code is FindReasonCode => typeof code === "string" && (FIND_REASON_CODES as readonly string[]).includes(code);

/** The service's sentence for an entry's reason, or undefined (no reason, or a code this build does not know). */
export const reasonSentence = (e: FindEntryView): string | undefined => (knownReason(e.reason?.code) ? FIND_REASON_TEXT[e.reason!.code] : undefined);

/** Where the entry stands, in words. `stopped`: nothing is looked up for the project now (said once above). */
export function stateWords(e: FindEntryView, ctx: { stopped?: boolean; place?: FindPlace | undefined } = {}): Words {
  if (!entryKnown(e)) return [FIND_TEXT.newerVersion];
  switch (e.state) {
    case "looking-up":
      return [ctx.stopped ? FIND_TEXT.notNow : STATE_WORDS["looking-up"]];
    case "choose": {
      const k = candidatesOf(e).length;
      // R279 d: the words may also name an author.
      if (authorOfferOf(e)) return [`${k === 1 ? "1 possible match" : `${k} possible matches`}, or an author of this name`];
      if (k === 0) return [FIND_TEXT.noMatches];
      return [k === 1 ? "1 possible match" : `${k} possible matches`];
    }
    case "choose-person": {
      const k = countOf(e.peopleCount);
      if (k === undefined) return [STATE_WORDS["choose-person"]];
      return [k === 1 ? "1 person matches" : `${k} people match`];
    }
    case "choose-works": {
      if (countOf(e.worksCount) === 0) return [FIND_TEXT.noWorks];
      const added = countOf(e.addedCount);
      return [added ? `${STATE_WORDS["choose-works"]} · ${added} added` : STATE_WORDS["choose-works"]];
    }
    case "failed": {
      const why = reasonSentence(e);
      return [why ? `Could not be done: ${why}` : "Could not be done."];
    }
    case "already":
    case "maybe-duplicate": {
      if (!e.elsewhere) return [STATE_WORDS[e.state]];
      const lead = e.state === "already" ? "Already in your project " : "Possibly already in your project ";
      if (ctx.place?.status === "known") return [lead, { user: ctx.place.projectName }];
      if (ctx.place?.status === "locked") return [e.state === "already" ? FIND_TEXT.elsewhereLocked : FIND_TEXT.maybeElsewhereLocked];
      return [e.state === "already" ? FIND_TEXT.elsewhereLoading : "Possibly already in another of your projects"];
    }
    default:
      return [STATE_WORDS[e.state]];
  }
}

/** The name's form of what was typed: at most 80 characters, then an ellipsis. */
export function shortTyped(typed: unknown): string {
  if (typeof typed !== "string") return "";
  const chars = Array.from(typed);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : typed;
}

/** The candidate the entry was matched to, if any. */
export const matchedWork = (e: FindEntryView): FindWorkCandidate | undefined => (e.chosen ? candidatesOf(e).find((c) => c.id === e.chosen) : undefined);

/** The acts a row offers, in order. */
export function actionsOf(e: FindEntryView, place?: FindPlace): FindActKind[] {
  if (!entryKnown(e)) return ["remove"];
  const out: FindActKind[] = [];
  switch (e.state) {
    case "choose":
      // Nothing to choose from: no dialog (R258 M5).
      if (candidatesOf(e).length > 0 || authorOfferOf(e)) out.push("choose");
      // R283 a, R287 c: the people of this name could not be looked up — "Try again" looks again.
      if (e.reason?.code === "people-unavailable") out.push("retry");
      break;
    case "maybe-duplicate":
      out.push("same", "different");
      if (!e.elsewhere && e.duplicateOf) out.push("open");
      if (e.elsewhere && place?.status === "known") out.push("open-there");
      break;
    case "already":
      if (e.elsewhere) {
        if (place?.status === "known") out.push("open-there");
        out.push("add-here");
      } else if (e.duplicateOf ?? e.sourceId) out.push("open");
      break;
    case "looking-up":
      if (e.nextTryAt) out.push("retry");
      break;
    case "choose-person":
      out.push("choose-person");
      break;
    case "choose-works":
      // Nothing to choose from: no dialog.
      if (countOf(e.worksCount) !== 0) out.push("choose-works");
      break;
    case "not-found":
    case "failed":
      out.push("retry");
      break;
    case "record-complete":
      // R326: also an entry the "Search sources" settings switched off (they are looked at again).
      if (COPY_RETRY_REASONS.has(String(e.reason?.code)) || (e.reason?.code === "switched-off" && e.reason.by === "settings")) out.push("retry");
      if (e.sourceId) out.push("open");
      break;
    case "looking-for-copy":
      if (e.nextTryAt) out.push("retry");
      if (e.sourceId) out.push("open");
      break;
    case "no-open-copy":
      if (recordRemoved(e)) break;
      if (e.reason?.code === "copy-some-unreachable") out.push("retry");
      if (e.sourceId) out.push("open");
      break;
    case "waiting-sign-in":
      // R340 b: the shell's take, the service's cancel; "Open" and removal as before.
      out.push("library-take", "library-cancel");
      if (e.sourceId && !recordRemoved(e)) out.push("open");
      break;
    default:
      if (e.sourceId && !recordRemoved(e)) out.push("open");
  }
  // R340 a: "Get through my library" exactly where the service offers a start (it decides; the row works out nothing),
  // after "Try again" and before the acts that open or remove.
  if (libraryOffered(e) && e.state !== "waiting-sign-in") {
    const at = out.findIndex((k) => k === "open" || k === "open-there");
    out.splice(at === -1 ? out.length : at, 0, "library");
  }
  out.push("remove");
  return out;
}

/** "Needs your check": the link to the file waiting in the review queue (shown before the row's buttons). */
const offersCheck = (e: FindEntryView): boolean => entryKnown(e) && e.state === "needs-check" && !recordRemoved(e);

const ACT_TEXT: Record<FindActKind, string> = {
  choose: "Choose",
  "choose-person": "Choose the person",
  "choose-works": "Choose works",
  open: "Open",
  "open-there": "Open it there",
  "add-here": "Add it to this project as well",
  same: "It is the same work",
  different: "It is a different work",
  retry: "Try again",
  remove: "Remove from the queue",
  library: "Get through my library",
  "library-take": "Add the PDF showing in the sign-in window",
  "library-cancel": "Cancel",
};
const BUSY_TEXT: Partial<Record<FindActKind, string>> = {
  choose: "Choosing…",
  "add-here": "Adding…",
  same: "Saving…",
  different: "Saving…",
  retry: "Trying again…",
  remove: "Removing…",
  "open-there": "Opening…",
  library: "Opening the sign-in window…",
  "library-take": "Asking the sign-in window…",
  "library-cancel": "Cancelling…",
};
/** Acts that only read: allowed in a read-only library. */
const READS: ReadonlySet<FindActKind> = new Set(["open", "open-there"]);

export interface FindEntryRowProps {
  entry: FindEntryView;
  onAction(a: FindAction): void;
  /** Where the match in another project is (only for an entry with `elsewhere`). */
  place?: FindPlace | undefined;
  /** The act under way on this entry. */
  busy?: FindActKind | undefined;
  /** The library is read-only (or the project cannot be changed): acts that change it are disabled. */
  readOnly?: boolean;
  /** Nothing is looked up for the project now (said once above the queue). */
  stopped?: boolean;
  /** The service's sentence for this entry's last refused act. */
  error?: string | undefined;
  /**
   * For an entry made from an author's entry (`parentId`): what was typed for that author, or null when that entry is
   * no longer in the queue (R271 M7). Undefined for any other entry.
   */
  origin?: string | null | undefined;
  /** What the sign-in window reported for this row, or what became of its start, in the screen's words (R340 b). */
  note?: string | undefined;
}

function Matched({ c }: { c: FindWorkCandidate }) {
  const people = creatorsText(c.creators, 3);
  const year = yearOf(c.issued);
  const kind = kindWords(c.type);
  return (
    <p className="ao-find__match">
      <UserText className="ao-find__work">{c.title}</UserText>
      {people && (
        <>
          {" — "}
          <UserText>{people}</UserText>
        </>
      )}
      {year && (
        <>
          {", "}
          <UserText>{year}</UserText>
        </>
      )}
      {kind && ` (${kind.toLowerCase()})`}
    </p>
  );
}

function FindEntryRowImpl({ entry: e, onAction, place, busy, readOnly = false, stopped = false, error, origin, note }: FindEntryRowProps) {
  const unavailableId = useId();
  const short = shortTyped(e.typed);
  /** An entry made from an author's entry (R281 a): named as a work, with where it came from. */
  const added = typeof e.parentId === "string" && origin !== undefined;
  const label = wordsText(entryLabel(e, origin, 80));
  const known = entryKnown(e);
  const words = stateWords(e, { stopped, place });
  const work = known ? matchedWork(e) : undefined;
  const reason = known && e.state !== "failed" ? reasonSentence(e) : undefined;
  const mark = known ? MARKS[e.state] : undefined;
  const author = known && isAuthorEntry(e);
  const morePeople = known && e.state === "choose-person" && e.morePeople === true;
  const actions = actionsOf(e, place);
  // "Where to get it" (R340 d): wherever the view carries links — never on a record removed from the library (R282 g).
  const showOffers = known && !recordRemoved(e) && Array.isArray(e.offers);
  // R340 a, c: the service's sentences for the library part of the view (never one of the row's own).
  const lastFile = known ? lastFileOf(e) : undefined;
  const noLibrary = known && noLibrarySet(e);
  // Outside the desktop app the acts that need the shell are shown unavailable, with why (R340 a).
  const desktop = inDesktopShell();
  const unavailable = !desktop && actions.some((k) => SHELL_ACTS.has(k));
  const button = (kind: FindActKind) => {
    const working = busy === kind;
    const waiting = !!busy && !working;
    const noShell = !desktop && SHELL_ACTS.has(kind);
    const text = working ? (BUSY_TEXT[kind] ?? ACT_TEXT[kind]) : ACT_TEXT[kind];
    return (
      <button
        key={kind}
        type="button"
        className={kind === "remove" ? "ao-find__remove" : noShell ? "ao-find__unavailable-act" : undefined}
        data-act={kind}
        aria-label={short ? `${text}: ${label}` : text}
        disabled={readOnly && !READS.has(kind)}
        aria-disabled={working || waiting || noShell || undefined}
        aria-busy={working || undefined}
        aria-describedby={noShell ? unavailableId : undefined}
        onClick={() => {
          // Outside the desktop app the press does nothing: no request, no call (R340 a).
          if (working || waiting || noShell) return;
          onAction({ kind, entry: e });
        }}
      >
        {text}
      </button>
    );
  };
  return (
    <li className="ao-find__entry" data-entry-id={e.id}>
      <p className="ao-find__typed">
        <span tabIndex={-1} data-entry-text="" className="ao-find__typed-text">
          {author && <span className="ao-find__lead">{FIND_TEXT.authorLead}</span>}
          {known && added && !author && <span className="ao-find__lead">{FIND_TEXT.workLead}</span>}
          {typeof e.typed === "string" && <UserText>{e.typed}</UserText>}
        </span>
      </p>
      {known && typeof e.parentId === "string" && origin !== undefined && (
        <p className="ao-find__origin">
          {typeof origin === "string" ? (
            <>
              Added from “<UserText>{origin}</UserText>”
            </>
          ) : (
            FIND_TEXT.originGone
          )}
        </p>
      )}
      {work && <Matched c={work} />}
      <p className="ao-find__status">
        {mark && (
          <span className="ao-find__mark" aria-hidden="true">
            {mark}{" "}
          </span>
        )}
        <span className="ao-find__state">
          <WordsView words={words} />
        </span>
      </p>
      {morePeople && <p className="ao-find__reason">{FIND_TEXT.morePeople}</p>}
      {reason && <p className="ao-find__reason">{reason}</p>}
      {lastFile && (
        <p className="ao-find__library">
          <span className="ao-find__library-text">{FIND_LIBRARY_FILE_TEXT[lastFile]}</span>
        </p>
      )}
      {noLibrary && (
        <p className="ao-find__library">
          <span className="ao-find__library-text">{FIND_LIBRARY_TEXT.noLibrary}</span>{" "}
          <a href={PATHS.yourLibrary} onClick={inAppLink} data-act="your-library" aria-label={short ? `${FIND_TEXT.yourLibrary}: ${label}` : FIND_TEXT.yourLibrary}>
            {FIND_TEXT.yourLibrary}
          </a>
        </p>
      )}
      {note && <p className="ao-find__library-note">{note}</p>}
      {error && (
        <p role="alert" className="ao-error">
          <UserText>{error}</UserText>
        </p>
      )}
      {showOffers && <WhereToGetIt offers={e.offers} {...(short ? { name: label } : {})} />}
      <div className="ao-actions ao-find__actions">
        {offersCheck(e) && (
          <a href={reviewEntryHref(e)} onClick={inAppLink} data-act="check" aria-label={short ? `${FIND_TEXT.checkFile}: ${label}` : FIND_TEXT.checkFile}>
            {FIND_TEXT.checkFile}
          </a>
        )}
        {actions.map(button)}
      </div>
      {unavailable && (
        <p id={unavailableId} className="ao-find__unavailable">
          {FIND_TEXT.onlyDesktop}
        </p>
      )}
    </li>
  );
}

/**
 * A row that fails to render (a later build's entry this one cannot read) is shown as needing a newer version, with
 * "Remove from the queue": one entry never blanks the screen (R258 M6).
 */
class RowGuard extends Component<FindEntryRowProps & { children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    const { entry, onAction, readOnly } = this.props;
    return (
      <li className="ao-find__entry" data-entry-id={typeof entry.id === "string" ? entry.id : undefined}>
        <p className="ao-find__status">
          <span className="ao-find__state">{FIND_TEXT.newerVersion}</span>
        </p>
        <div className="ao-actions ao-find__actions">
          <button type="button" className="ao-find__remove" aria-label="Remove from the queue" disabled={readOnly} onClick={() => onAction({ kind: "remove", entry })}>
            Remove from the queue
          </button>
        </div>
      </li>
    );
  }
}

function GuardedRow(props: FindEntryRowProps) {
  return (
    <RowGuard {...props}>
      <FindEntryRowImpl {...props} />
    </RowGuard>
  );
}

/** A row re-renders only when its own props change (a 500-entry queue stays responsive). */
export const FindEntryRow = memo(GuardedRow);
