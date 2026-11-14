/**
 * The types of Find and acquire that every part shares (Task F3). Types that other tasks build on are declared
 * here once, exactly as those tasks' Interfaces give them, so that the later tasks import them from here:
 * `PersonCandidate` (Task F8), `OfferLink` (Tasks F10 and F15) and `FindReasonCode` (Task F5).
 * `WorkCandidate` is Task F2's, in `./candidates.ts`.
 */
import type { WorkCandidate } from "./candidates.js";

export type { WorkCandidate } from "./candidates.js";

/** Where an entry of the queue stands, every state written out in words on the screen. */
export type FindState =
  | "looking-up"
  | "choose"
  | "choose-person"
  | "choose-works"
  | "maybe-duplicate"
  | "record-complete"
  | "looking-for-copy"
  | "fetching"
  | "in-library"
  | "already"
  | "no-open-copy"
  | "waiting-sign-in"
  | "needs-check"
  | "not-found"
  | "failed";

export const FIND_STATES: readonly FindState[] = [
  "looking-up",
  "choose",
  "choose-person",
  "choose-works",
  "maybe-duplicate",
  "record-complete",
  "looking-for-copy",
  "fetching",
  "in-library",
  "already",
  "no-open-copy",
  "waiting-sign-in",
  "needs-check",
  "not-found",
  "failed",
];

/**
 * Task F8: a person the author's name might mean (OpenAlex's author `A<digits>`): name and affiliation at most 200
 * characters each, at most 3 sample titles. For choosing only: shown through UserText, never audited.
 */
export type PersonCandidate = { id: string; name: string; affiliation?: string; worksCount: number; sampleTitles: string[] };

/** Tasks F10 and F15: a link under "Where to get it". */
export type OfferLink = {
  label: "Publisher's page" | "Your library's catalogue" | "Open Library" | "WorldCat" | "A free copy may be at";
  url: string;
  host: string;
};

/** Task F5: why an entry could not go on (the sentences are `FIND_REASON_TEXT` in the shared package). */
export type FindReasonCode = "not-allowed" | "no-legal-basis" | "switched-off" | "unreachable" | "locked" | "queue-full" | "budget" | "unexpected";

export type FindReason = { code: FindReasonCode; by?: "rules" | "settings" };

/** How a work was matched (R237 M3): "find-match" with the rule's score when the app was sure; "find-chosen" when the researcher chose. */
export type FindMatch = { method: "find-match" | "find-chosen"; confidence: number };

/** The longest DOI a candidate, the queue and a record keep: one bound for F2, the runner and the store (R237 M2). */
export const FIND_DOI_MAX = 300;

export interface FindEntry {
  id: string;
  projectId: string;
  collectionId?: string;
  /** What the researcher typed (2–500 characters). */
  typed: string;
  state: FindState;
  createdAt: string;
  updatedAt: string;
  candidates?: WorkCandidate[];
  people?: PersonCandidate[];
  works?: WorkCandidate[];
  chosen?: string;
  sourceId?: string;
  duplicateOf?: string;
  elsewhere?: true;
  reason?: FindReason;
  /** How the work was matched, once it was; the record made later (after a duplicate question, or "here as well") says the same. */
  match?: FindMatch;
  attempts: number;
  nextTryAt?: string;
  parentId?: string;
  offers?: OfferLink[];
  /** Task F8 (R267): OpenAlex reported more people of this name than the 20 kept ("More people have this name …"). */
  morePeople?: true;
  /** Task F8 (R267): the person has more works than those kept for choosing (at most 200, fewer if the line would not fit). */
  moreWorks?: true;
  /** Task F8 (R267): the works (their `works` ids) already added from this entry as entries of their own, in the order added. */
  added?: string[];
  /** Only ever on the line that takes an entry out of the queue (written by the "remove" operation). */
  removed?: true;
}

/** Each project has at most this many entries that are not removed. */
export const FIND_QUEUE_MAX = 500;
/** A queue line (the entry as JSON, before it is sealed) is at most this many bytes. */
export const FIND_LINE_MAX_BYTES = 65_536;
/** The longest line a researcher can type. */
export const FIND_TYPED_MAX = 500;

/**
 * Task F12's "Search sources" settings, as F4 needs them (F12 adds `copies`, `crossrefEmail` and `unpaywallEmail`
 * with the free copies). `record` lists the services that find a work and its record, in the order asked; a source
 * that is `on: false` is never asked. Settings can only narrow what a project's rules allow.
 */
export type RecordSearchSource = "crossref" | "openalex" | "openlibrary" | "loc" | "elicit";
export type SearchSettings = { record: Array<{ id: RecordSearchSource; on: boolean }> };

/** The settings until the researcher changes them (F12 keeps them in `search-sources.json`): every source on but Elicit. */
export const DEFAULT_SEARCH_SETTINGS: Readonly<SearchSettings> = Object.freeze({
  record: Object.freeze([
    Object.freeze({ id: "crossref" as const, on: true }),
    Object.freeze({ id: "openalex" as const, on: true }),
    Object.freeze({ id: "openlibrary" as const, on: true }),
    Object.freeze({ id: "loc" as const, on: true }),
    Object.freeze({ id: "elicit" as const, on: false }),
  ]) as SearchSettings["record"],
});

export const FIND_QUEUE_OPS = {
  add: "project.find.add",
  update: "project.find.update",
  remove: "project.find.remove",
  compact: "project.find.compact",
} as const;
