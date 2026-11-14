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
 * Slice 1 only: the states of later slices are said in words, with "Remove from the queue" (and "Open" when the
 * entry has a record), and no control of a later slice.
 */
import { FIND_REASON_CODES, FIND_REASON_TEXT, type FindEntryView, type FindReasonCode, type FindWorkCandidate } from "@ao/shared";
import { Component, memo, type ReactNode } from "react";
import { creatorsText, isKnownState, kindWords, usableCandidates, yearOf } from "../api/find";
import { UserText } from "./UserText";

export type FindActKind = "choose" | "open" | "open-there" | "add-here" | "same" | "different" | "retry" | "remove";

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
} as const;

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
const MARKS: Partial<Record<string, string>> = { "looking-up": "●", choose: "?", "maybe-duplicate": "≈", "record-complete": "✓", already: "=", "not-found": "∅", failed: "!" };

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
      if (k === 0) return [FIND_TEXT.noMatches];
      return [k === 1 ? "1 possible match" : `${k} possible matches`];
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

/** The acts a row offers, in order. Slice 1 only. */
export function actionsOf(e: FindEntryView, place?: FindPlace): FindActKind[] {
  if (!entryKnown(e)) return ["remove"];
  const out: FindActKind[] = [];
  switch (e.state) {
    case "choose":
      // Nothing to choose from: no dialog (R258 M5).
      if (candidatesOf(e).length > 0) out.push("choose");
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
    case "not-found":
    case "failed":
      out.push("retry");
      break;
    default:
      if (e.sourceId) out.push("open");
  }
  out.push("remove");
  return out;
}

const ACT_TEXT: Record<FindActKind, string> = {
  choose: "Choose",
  open: "Open",
  "open-there": "Open it there",
  "add-here": "Add it to this project as well",
  same: "It is the same work",
  different: "It is a different work",
  retry: "Try again",
  remove: "Remove from the queue",
};
const BUSY_TEXT: Partial<Record<FindActKind, string>> = { choose: "Choosing…", "add-here": "Adding…", same: "Saving…", different: "Saving…", retry: "Trying again…", remove: "Removing…", "open-there": "Opening…" };
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

function FindEntryRowImpl({ entry: e, onAction, place, busy, readOnly = false, stopped = false, error }: FindEntryRowProps) {
  const short = shortTyped(e.typed);
  const known = entryKnown(e);
  const words = stateWords(e, { stopped, place });
  const work = known ? matchedWork(e) : undefined;
  const reason = known && e.state !== "failed" ? reasonSentence(e) : undefined;
  const mark = known ? MARKS[e.state] : undefined;
  return (
    <li className="ao-find__entry" data-entry-id={e.id}>
      <p className="ao-find__typed">
        <span tabIndex={-1} data-entry-text="" className="ao-find__typed-text">
          {typeof e.typed === "string" && <UserText>{e.typed}</UserText>}
        </span>
      </p>
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
      {reason && <p className="ao-find__reason">{reason}</p>}
      {error && (
        <p role="alert" className="ao-error">
          <UserText>{error}</UserText>
        </p>
      )}
      <div className="ao-actions ao-find__actions">
        {actionsOf(e, place).map((kind) => {
          const working = busy === kind;
          const waiting = !!busy && !working;
          const text = working ? (BUSY_TEXT[kind] ?? ACT_TEXT[kind]) : ACT_TEXT[kind];
          return (
            <button
              key={kind}
              type="button"
              className={kind === "remove" ? "ao-find__remove" : undefined}
              aria-label={short ? `${text}: “${short}”` : text}
              disabled={readOnly && !READS.has(kind)}
              aria-disabled={working || waiting || undefined}
              aria-busy={working || undefined}
              onClick={() => {
                if (working || waiting) return;
                onAction({ kind, entry: e });
              }}
            >
              {text}
            </button>
          );
        })}
      </div>
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
