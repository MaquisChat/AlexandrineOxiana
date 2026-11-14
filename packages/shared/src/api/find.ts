/**
 * Find and acquire, slice 1 (Task F5; Rulings R225, R226, R237; plan Amendments A2, A3): the service's routes,
 * declared once for the service and the interface. Every route is for the desktop app's token only: the browser
 * extension's token gets 403 on every one, reads included. Bodies are at most FIND_BODY_MAX_BYTES.
 *
 *   GET    /projects/:id/find                    → FindQueueResponse (409 with the store's sentence when the queue cannot be read at all)
 *   POST   /projects/:id/find                    FindAddRequest → FindAddResponse
 *   POST   /projects/:id/find/:eid/choose        FindChooseRequest → FindEntryView
 *   POST   /projects/:id/find/:eid/duplicate     FindDuplicateRequest → FindEntryView
 *   POST   /projects/:id/find/:eid/add-here      → FindEntryView
 *   POST   /projects/:id/find/:eid/retry         → FindEntryView
 *   DELETE /projects/:id/find/:eid               → FindRemoveResponse
 *   GET    /projects/:id/find/:eid/elsewhere     → FindElsewhereResponse (null: not known, or that project is locked now)
 *   GET    /projects/:id/find/:eid/options       → FindOptionsResponse (F8: the entry's lists, for its dialog)
 *   POST   /projects/:id/find/:eid/person        FindPersonRequest → FindEntryView (F8: "choose-person" only)
 *   POST   /projects/:id/find/:eid/works         FindWorksRequest → FindWorksResponse (F8: "choose-works" only)
 *   GET    /find/screen                          → FindScreenSettings
 *   PUT    /find/screen                          FindScreenSettings → FindScreenSettings
 *
 * Refusals (`{ error: { code, message, reason } }`, the message always a plain sentence, `reason` one of
 * FIND_REFUSAL_REASONS where the screen may act on it): 400 VALIDATION (a malformed body or id; a line outside the
 * bounds — the WHOLE add is refused and the line is named by its number, never by its text; an unknown candidate),
 * 403 FORBIDDEN (not the desktop app), 404 NOT_FOUND (an unknown project; an entry id the project's queue does not
 * hold — never there, another project's, or removed by anyone: "That entry is no longer in the queue.", R245),
 * 409 READ_ONLY (a read-only library, on every changing route), 409 CONFLICT (the queue is full; the entry is not
 * waiting for that; the queue cannot be read; the index is being prepared; the project's queue is paused, reason
 * "stopped"), 423 PROJECT_LOCKED, 503 UNAVAILABLE
 * (Find and acquire has stopped for the library: it is closing or being moved).
 *
 * Live updates: the server-sent event `find.progress` with a FindProgressEvent and nothing else.
 *
 * What was typed is the researcher's text: it reaches nothing but the library (never a log line, an error, an
 * audit entry or an event). Everything in an entry that came from a search service is outside text: shown only
 * through UserText.
 */

/** Where an entry of the queue stands (the library's FindState). */
export const FIND_STATES = [
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
] as const;
export type FindState = (typeof FIND_STATES)[number];

/** Why an entry could not go on (the library's FindReasonCode). */
export const FIND_REASON_CODES = ["not-allowed", "no-legal-basis", "switched-off", "unreachable", "locked", "queue-full", "budget", "unexpected"] as const;
export type FindReasonCode = (typeof FIND_REASON_CODES)[number];
export type FindReason = { code: FindReasonCode; by?: "rules" | "settings" };

/** The one sentence for each reason: the only place the screen takes them from. */
export const FIND_REASON_TEXT: Record<FindReasonCode, string> = {
  "not-allowed": "This project's rules do not allow this.",
  "no-legal-basis": "This project's rules need a legal basis for records made from typed references. Record one in the project's Governance settings.",
  "switched-off": "Switched off in Search sources.",
  unreachable: "The search services could not be reached. Try again later.",
  locked: "The project is locked. Unlock it, and the queue goes on.",
  "queue-full": "The queue holds 500 entries. Remove some finished ones first.",
  budget: "OpenAlex's free daily allowance is used up; searching Crossref only until tomorrow.",
  unexpected: "Something went wrong while looking this up. Try again.",
};

/** Why nothing is done for a project's queue now (the library's FindStoppedFor). */
export const FIND_STOPPED_CODES = ["rules-unreadable", "queue-unreadable", "read-only", "recovery-pending", "index-not-ready", "index-needs-rebuild", "unexpected"] as const;
export type FindStoppedCode = (typeof FIND_STOPPED_CODES)[number];

/** The one sentence for each, shown once above the queue. `queue-unreadable` is the queue store's own sentence. */
export const FIND_STOPPED_TEXT: Record<FindStoppedCode, string> = {
  "rules-unreadable": "This project's rules could not be read, so nothing is looked up.",
  "queue-unreadable": "The Find and acquire queue of this project could not be read. Nothing has been changed.",
  "read-only": "This library is open read-only, so nothing is looked up.",
  "recovery-pending": "This project is waiting for the library to be reopened before anything can be written.",
  /** Only while a rebuild is really running (R247 b). */
  "index-not-ready": "The library's index is being rebuilt. Looking up starts when it is ready.",
  /** The index cannot be trusted and no rebuild is running (a change could not be indexed; a rebuild failed). R247 b. */
  "index-needs-rebuild":
    "The library's index is out of date, so nothing is looked up until it is rebuilt. Use “Rebuild library from folder” (on the Missing files screen, under Search index), then looking up goes on.",
  unexpected: "The queue could not be started. Close and reopen the library, and it tries again.",
};

/** The `reason` of the refusals the screen may act on. */
export const FIND_REFUSAL_REASONS = [
  "read-only",
  "locked",
  "queue-full",
  "queue-unreadable",
  "entry-state",
  "index-not-ready",
  "closed",
  "stopped",
  "unknown-candidate",
  "line",
  // Task F8 (R267): a person or a work not among the entry's own; a work already added from the entry.
  "unknown-person",
  "unknown-work",
  "already-added",
] as const;
export type FindRefusalReason = (typeof FIND_REFUSAL_REASONS)[number];

/** The routes' own sentences (besides FIND_REASON_TEXT and FIND_STOPPED_TEXT). */
export const FIND_ROUTE_TEXT = {
  readOnly: "This library is open read-only, so nothing can be added.",
  locked: "The project is locked. Unlock it, and the queue goes on.",
  queueFull: "The queue holds 500 entries. Remove some finished ones first.",
  entryState: "This entry is no longer waiting for that. Nothing was changed.",
  /** A press that would make a record while the index is not ready (R247 a). */
  indexNotReady: "Nothing was changed: the library's index is not ready. Try again when it is.",
  closed: "Find and acquire has stopped for this library. Nothing was changed.",
  unknownCandidate: "That is not one of the works offered for this entry. Nothing was changed.",
  /** Any act on an id the queue does not hold (never there, or removed by anyone): 404 (R245). */
  entryNotFound: "That entry is no longer in the queue.",
  /** Find and acquire is stopped for the project (unlocked, but not yet resumed). */
  projectStopped: "Find and acquire is paused for this project. Try again in a moment. Nothing was changed.",
  noLines: "Type at least one reference.",
  tooManyLines: "At most 50 lines can be added at once. Nothing was added.",
  /** Elsewhere: the other project was locked meanwhile (the screen's sentence). */
  elsewhereLocked: "Already in another project that is locked now.",
  // Task F8 (R267): an author alone.
  /** The person pressed is not one of the people offered for THIS entry (400). */
  unknownPerson: "That is not one of the people offered for this entry. Nothing was changed.",
  /** A work ticked is not one of the works offered for THIS entry (400). */
  unknownWork: "That is not one of the works offered for this entry. Nothing was added.",
  /** `personId` is not OpenAlex's form of a person's id (400). */
  personId: "That is not a person's id that OpenAlex gives. Nothing was changed.",
  noWorks: "Tick at least one work. Nothing was added.",
  tooManyWorks: "At most 50 works can be added at once. Nothing was added.",
} as const;

/** Work `n` (counting from 1, in the request) was already added from this entry: the whole tick is refused (409). Never its title. */
export const findAlreadyAddedRefusal = (n: number): string => `Work ${n} was already added from this entry. Nothing was added.`;
/** Work `n` (counting from 1, in the request) is not in OpenAlex's form of a work's id (400). */
export const findWorkIdRefusal = (n: number): string => `Work ${n} is not a work's id that OpenAlex gives. Nothing was added.`;

/** Task F8: at most this many people are kept and listed for an entry. */
export const FIND_PEOPLE_MAX = 20;
/** Task F8: at most this many works of a person are kept for choosing (fewer when they would not fit the queue's line). */
export const FIND_PERSON_WORKS_MAX = 200;
/** Task F8: one tick adds at most this many works. */
export const FIND_CHOOSE_WORKS_MAX = 50;
/** Task F8: said under "Choose the person" when `morePeople` is set (the plan's words). */
export const FIND_MORE_PEOPLE_TEXT = "More people have this name; add a word from a title to narrow it";
/** Task F8: said under "Choose works" when `moreWorks` is set. */
export const FIND_MORE_WORKS_TEXT = "Only this person's newest works are listed; add a word from a title to find an older one.";

/** Line `n` (counting from 1) is outside the bounds: the whole add is refused. Never the line's text. */
export const findLineRefusal = (n: number): string => `Line ${n} must be 2 to 500 characters (after spaces at either end are left out). Nothing was added.`;

/** Bounds of an add. */
export const FIND_ADD_LINES_MAX = 50;
export const FIND_LINE_MIN_CHARS = 2;
export const FIND_LINE_MAX_CHARS = 500;
/** The largest body a find route takes (64 KiB). */
export const FIND_BODY_MAX_BYTES = 65_536;
/** Each project's queue holds at most this many entries that are not removed. */
export const FIND_QUEUE_MAX = 500;
/** At most this many candidates are sent per entry. */
export const FIND_CANDIDATES_SENT = 10;

/** A name of a person, as a candidate gives it (outside text). */
export type FindCreator = {
  family?: string;
  given?: string;
  literal?: string;
  role: "author" | "editor" | "translator" | "uploader" | "channel" | "photographer" | "interviewer" | "interviewee" | "contributor";
  handle?: string;
};

/** What kind of work a candidate is (the library's SourceType). */
export type FindSourceType =
  | "book"
  | "chapter"
  | "article-journal"
  | "preprint"
  | "report"
  | "thesis"
  | "webpage"
  | "social-post"
  | "video"
  | "audio"
  | "image"
  | "dataset"
  | "field-photo"
  | "field-video"
  | "field-recording"
  | "interview"
  | "manuscript"
  | "presentation"
  | "other";

/** A work a search service offered (the library's WorkCandidate). Every string is outside text. */
export type FindWorkCandidate = {
  id: string;
  title: string;
  creators: FindCreator[];
  issued?: string;
  type: FindSourceType;
  container?: string;
  publisher?: string;
  identifiers: { doi?: string; isbn?: string[] };
  providers: string[];
};

/** A link under "Where to get it" (Tasks F10, F15). */
export type FindOfferLink = {
  label: "Publisher's page" | "Your library's catalogue" | "Open Library" | "WorldCat" | "A free copy may be at";
  url: string;
  host: string;
};

export type FindMatch = { method: "find-match" | "find-chosen"; confidence: number };

/**
 * An entry as the screen gets it: the library's FindEntry without `people`, `works` and `added` (their counts instead,
 * F8), at most 10 candidates.
 */
export interface FindEntryView {
  id: string;
  projectId: string;
  collectionId?: string;
  /** What the researcher typed: shown only through UserText. */
  typed: string;
  state: FindState;
  createdAt: string;
  updatedAt: string;
  candidates?: FindWorkCandidate[];
  chosen?: string;
  sourceId?: string;
  duplicateOf?: string;
  elsewhere?: true;
  reason?: FindReason;
  match?: FindMatch;
  attempts: number;
  nextTryAt?: string;
  parentId?: string;
  offers?: FindOfferLink[];
  /**
   * Task F8 (R267): an author's entry carries COUNTS, never its lists (those come from `GET …/:eid/options`): how many
   * people ("choose-person"), how many works and how many of them were added ("choose-works"), and whether more exist
   * than are kept. Absent when the entry holds no such list.
   */
  peopleCount?: number;
  worksCount?: number;
  addedCount?: number;
  morePeople?: true;
  moreWorks?: true;
}

/** Task F8: a person an author's name may mean (OpenAlex's author `A<digits>`). Every string is outside text. */
export type FindPersonCandidate = { id: string; name: string; affiliation?: string; worksCount: number; sampleTitles: string[] };

/** Task F8: a work of the chosen person, as kept for choosing; `added` when this entry already made an entry of it. */
export type FindPersonWork = FindWorkCandidate & { added?: true };

/** Task F8: `GET /projects/:id/find/:eid/options` — the entry's lists, for the dialog that opens on it. */
export interface FindOptionsResponse {
  /** "choose": the works offered (at most 10). */
  candidates?: FindWorkCandidate[];
  /** "choose-person": the people (at most 20). */
  people?: FindPersonCandidate[];
  /** "choose-works": the person's works, newest first (at most 200). */
  works?: FindPersonWork[];
}

/** Task F8: `POST /projects/:id/find/:eid/person`. */
export interface FindPersonRequest {
  personId: string;
}

/** Task F8: `POST /projects/:id/find/:eid/works` (1 to 50 ids). */
export interface FindWorksRequest {
  workIds: string[];
}

/** Task F8: the entries made, one per work, and the author's entry as it now is (still "choose-works"). */
export interface FindWorksResponse {
  added: FindEntryView[];
  entry: FindEntryView;
}

export interface FindQueueResponse {
  entries: FindEntryView[];
  /** "Check everything I have", as remembered on this computer. */
  checkEverything: boolean;
  /** How many projects of the library are locked and so were not checked: 0 while the switch is off. */
  lockedProjectsNotChecked: number;
  readOnly: boolean;
  /** Lines of the queue that could not be read and are kept (A2): "N lines of the queue could not be read and are kept." */
  unreadableLines: number;
  /** Why nothing is done for this queue now, said once above it; absent while it runs. */
  stopped?: { code: FindStoppedCode; text: string };
}

export interface FindAddRequest {
  lines: string[];
  collectionId?: string;
}

export interface FindAddResponse {
  added: FindEntryView[];
  /** Lines that were the same as another line of this add and were added once. */
  mergedLines: number;
}

export interface FindChooseRequest {
  /** null: "None of these". */
  candidateId: string | null;
}

export interface FindDuplicateRequest {
  /** true: the same work (Already in your library); false: not the same work (the record is made). */
  same: boolean;
}

export interface FindRemoveResponse {
  removed: true;
}

/** Where a match in another project is, worked out at request time and never stored; null when not known now. */
export type FindElsewhereResponse = { projectId: string; projectName: string; sourceId: string } | null;

/** The Find and acquire screen's remembered settings (this computer's `find-screen.json`). */
export interface FindScreenSettings {
  checkEverything: boolean;
  projectId?: string;
  collectionId?: string;
}

/** The server-sent event `find.progress`: exactly these three fields. */
export interface FindProgressEvent {
  projectId: string;
  entryId: string;
  state: FindState;
}
