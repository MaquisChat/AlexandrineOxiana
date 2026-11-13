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

/** Task F8: a person the author's name might mean. */
export type PersonCandidate = { id: string; name: string; affiliation?: string; worksCount: number; sampleTitles: string[] };

/** Tasks F10 and F15: a link under "Where to get it". */
export type OfferLink = {
  label: "Publisher's page" | "Your library's catalogue" | "Open Library" | "WorldCat" | "A free copy may be at";
  url: string;
  host: string;
};

/** Task F5: why an entry could not go on (the sentences are `FIND_REASON_TEXT` in the shared package). */
export type FindReasonCode = "not-allowed" | "switched-off" | "unreachable" | "locked" | "queue-full" | "budget";

export type FindReason = { code: FindReasonCode; by?: "rules" | "settings" };

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
  attempts: number;
  nextTryAt?: string;
  parentId?: string;
  offers?: OfferLink[];
  /** Only ever on the line that takes an entry out of the queue (written by the "remove" operation). */
  removed?: true;
}

/** Each project has at most this many entries that are not removed. */
export const FIND_QUEUE_MAX = 500;
/** A queue line (the entry as JSON, before it is sealed) is at most this many bytes. */
export const FIND_LINE_MAX_BYTES = 65_536;
/** The longest line a researcher can type. */
export const FIND_TYPED_MAX = 500;

export const FIND_QUEUE_OPS = {
  add: "project.find.add",
  update: "project.find.update",
  remove: "project.find.remove",
  compact: "project.find.compact",
} as const;
