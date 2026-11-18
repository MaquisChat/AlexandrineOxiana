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
 *   POST   /projects/:id/find/:eid/author        no body → FindEntryView (F8b: "choose" with an `authorOffer` only; else
 *                                                409 CONFLICT, reason "no-author", FIND_ROUTE_TEXT.noAuthor)
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
export const FIND_REASON_CODES = [
  "not-allowed",
  "no-legal-basis",
  "switched-off",
  "unreachable",
  "locked",
  "queue-full",
  "budget",
  "unexpected",
  // F8b (R283 a): on a "choose" entry whose people search could not be had ("Try again" looks again).
  "people-unavailable",
  // F12 (R297 a, R308): the only record source switched on (and allowed) needs a key and none is available.
  "needs-key",
  // Task F11: the free copy. "copy-not-allowed" (the entry stays "record-complete"; looked at again when the rules
  // change, at the next open or unlock); "held-full" (R296 d: FIND_HELD_MAX files already wait; the entry waits
  // "record-complete" and goes on by itself after a decision on a waiting file, "Try again", opening or unlocking —
  // an older entry stored "failed" with it is still accepted by "Try again"); "not-this-file" ("no-open-copy"); on
  // "needs-check", what the file check said of the file that waits: why it did not clearly match, or (R296 b)
  // "file-looks-right" — advice only, the file still waits for the researcher.
  "copy-not-allowed",
  "held-full",
  "not-this-file",
  "file-other-doi",
  "file-title-absent",
  "file-no-text",
  "file-other-version",
  "file-other-kind",
  "file-looks-right",
  // R282 e: no offer, and some free-copy services could not be reached ("no-open-copy", with "Try again"). R282 g: the
  // record was removed from the library ("no-open-copy", removal only); the rules' STORE part (or a missing legal
  // basis) refused the file (the entry stays "record-complete", woken when the rules are saved, and "Try again").
  "copy-some-unreachable",
  // R379 (FR-A17): offers were found but none could be downloaded, at least one for a passing reason (a time-out, the
  // network, a 429 or a 5xx): tried again by itself like an unreachable lookup, then "no-open-copy" with "Try again".
  "copy-not-downloaded",
  "record-removed",
  "copy-store-not-allowed",
  "copy-no-legal-basis",
  // Task F15 (R324 b): an entry found "waiting-sign-in" at start-up with nothing kept to return to (a line written by
  // an older build, or damaged): "no-open-copy" with this reason, never a claim that no free copy exists.
  "library-unfinished",
] as const;
export type FindReasonCode = (typeof FIND_REASON_CODES)[number];
export type FindReason = { code: FindReasonCode; by?: "rules" | "settings" };

/**
 * Task F11, R296 d: at most this many files found for records wait for the researcher's check in one project; an
 * entry that finds the limit reached waits ("record-complete", reason "held-full") and asks nothing until then.
 */
export const FIND_HELD_MAX = 50;

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
  /** F8b (R283 a): on a "choose" entry whose people search could not be had; "Try again" is offered on it. */
  "people-unavailable": "People of this name could not be looked up just now. “Try again” looks again.",
  /** F12 (R297 a, R308): the only record source switched on (and allowed) needs a key (Elicit) and none is available — not saved, or the password store could not be read. "Try again" goes on once one is. */
  "needs-key": "The only search source switched on needs a key, and none is available. Add it in Search sources, then try again.",
  "copy-not-allowed": "This project's rules do not allow fetching free copies of works.",
  "held-full": `${FIND_HELD_MAX} files are already waiting for your check. This one goes on by itself when you have decided on some of them.`,
  "not-this-file": "You said the file found was not this work.",
  "file-other-doi": "The file names another DOI as its own.",
  "file-title-absent": "The file does not show this record's title with its author.",
  "file-no-text": "The file has no text that could be read (a scan, or a damaged file).",
  "file-other-version": "The file seems to be another volume, part or edition of this work.",
  "file-other-kind": "The file looks like another kind of document (a review, a reply, a correction or a supplement), not the work itself.",
  "file-looks-right": "This looks like the right file. Check it, then use it.",
  "copy-some-unreachable": "Some services could not be reached, so a free copy may still exist. “Try again” looks again.",
  "copy-not-downloaded": "A free copy was found, but it could not be downloaded just now. Try again later, or open one of the links.",
  "record-removed": "The record was removed from the library.",
  "copy-store-not-allowed": "This project's rules do not allow storing the file found for this record.",
  "copy-no-legal-basis": "This project's rules need a legal basis to store the file found for this record, and the record has none.",
  "library-unfinished": "A fetch in the app's window was not finished, and what this entry said before could not be read back. Nothing was added.",
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
  // R271 M9: a `personId` that is not OpenAlex's form; `workIds` that are not a list of 1 to 50 of OpenAlex's work ids.
  "person-id",
  "work-ids",
  // Task F8b (R279): "Show this author's works" on an entry that carries no author offer (any more).
  "no-author",
  // Task F15 (R324): a start "through my library" refused — the sentences are FIND_LIBRARY_TEXT and libraryReadyIn.
  "library-not-offered",
  "no-library",
  "library-busy",
  "library-pause",
  "library-held-full",
  // Task F18c (R345): "Open it here and fetch the PDF" refused — the sentences are FIND_LINK_TEXT.
  "link-not-offered",
  "link-not-a-place",
  // Task F20a (R348 d): "Get through my library in my own browser" with no browser extension paired.
  "browser-not-paired",
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
  /** Task F8b (R279): `POST …/:eid/author` on an entry that is not "choose" with an author offer (409); nothing changed. */
  noAuthor: "This entry has no author to show.",
  /** Task F8b (R285 b): a body sent to a route that takes none (400); the field is never repeated. */
  noBody: "This request takes no body. Nothing was changed.",
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
  /** Worked out from the queue's live entries made from this entry (R271 M5), never stored. */
  addedCount?: number;
  morePeople?: true;
  moreWorks?: true;
  /**
   * Task F8b (R279 c): on an entry in "choose" only, when what was typed may also be an author's name — a person's name
   * covers every typed word while a work's title is covered too. COUNTS only (no name): how many people fit, and
   * whether more exist than are listed. The people are listed only after `POST …/:eid/author` ("choose-person").
   * Such an entry carries neither `peopleCount` nor `morePeople` at the top.
   */
  authorOffer?: FindAuthorOffer;
  /**
   * F8: on an entry made from an author's entry (`parentId`), the OpenAlex id of the work it was made from. Its `typed`
   * was built by the app (title, family name), not typed: F9 says where it came from (R271 M7).
   */
  work?: string;
  /**
   * Task F15 (R324 a): whether "Get through my library" may start for this entry — worked out by the service, never
   * by the screen. Present only on an entry that would be offered it if a library were set: `{ canStart: true }`, or
   * `{ canStart: false, reason: "no-library" }` (the researcher's to mend: FIND_LIBRARY_TEXT.noLibrary). Absent on every
   * other entry. A start can still be refused at the press (another ticket open, the pause, the limit of waiting
   * files): the route says why.
   */
  library?: FindLibraryChance;
  /**
   * Task F18c (R345 b): `true` when "Open it here and fetch the PDF" may start at this entry's links (every link of its
   * `offers`) — worked out by the service, never by the screen: the entry rests as a library start needs it (its record
   * there, no file, none waiting for the check, not at work), its view carries links, and the rules allow fetching free
   * copies and keeping the file. No library need be set. Absent otherwise. A start can still be refused at the press
   * (another ticket open, the pause, the limit of waiting files): the route says why.
   */
  linkStart?: true;
  /**
   * Task F18c (R345 e): on an entry waiting in the sign-in window that was opened at one of its links, "link" — so that
   * the screen names that control, never the library. Absent for a start through the library, and when the service no
   * longer knows (tickets are in memory only; after a restart the entry returns at once).
   */
  windowStart?: "link";
  /**
   * Task F20a (R348 e): `true` when "Get through my library in my own browser" may start for this entry — the entry is
   * offered a library start (`library.canStart` is `true`) AND at least one browser extension is paired with the app.
   * Worked out by the service, never by the screen; absent otherwise.
   */
  browserStart?: true;
  /**
   * Task F20a (R348 e): on an entry "waiting-sign-in" whose open ticket (or file being taken) is the browser's,
   * "browser" — the work waits in the researcher's own browser, not in the sign-in window. Memory only, as
   * `windowStart`; absent for the window (a browser start is a library start: `windowStart` is absent too).
   */
  waitingIn?: "browser";
}

/** Task F8b (R279 c): an author of the typed name offered beside the works ("Show this author's works"). Counts only. */
export interface FindAuthorOffer {
  /** How many people's names cover every typed word (1 to FIND_PEOPLE_MAX). */
  peopleCount: number;
  /** More people of that name exist than are listed. */
  morePeople?: true;
}

/** Task F8: a person an author's name may mean (OpenAlex's author `A<digits>`). Every string is outside text. */
export type FindPersonCandidate = { id: string; name: string; affiliation?: string; worksCount: number; subjects: string[] };

/** Task F8 (R271 M6): the person whose works an entry in "choose-works" lists. Outside text. */
export type FindChosenPerson = { name: string; affiliation?: string; subjects: string[] };

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
  /** "choose-works": whose works these are (R271 M6). */
  person?: FindChosenPerson;
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

// ---------------------------------------------------------------------------------------------------------------
// Task F15 (R324): "Your library" — the address, "Where to get it", and starting a fetch through the library.
//
//   GET  /settings/your-library                   → YourLibraryResponse
//   PUT  /settings/your-library                   YourLibrary → YourLibraryResponse (400 naming the field; 409 newer)
//   POST /settings/your-library/derive            YourLibraryDeriveRequest → YourLibraryDeriveResponse (200, also
//                                                 when no address can be worked out: `access` null and the sentence)
//   POST /projects/:id/find/:eid/library/start    no body → FindLibraryStartResponse (409 with a `reason` of
//                                                 FIND_REFUSAL_REASONS "library-…"/"no-library"; 423; 404; 503)
//   POST /projects/:id/find/:eid/library/cancel   no body → FindEntryView (409 "entry-state" unless it is waiting)
//
// Every route is for the desktop app's token only. The pasted link is never stored, logged or repeated in an answer:
// only the address worked out from it (`LibraryAccess.base`) is kept, and that holds nothing of the link's query but
// the name of its target parameter. The service never fetches anything from the library: a start answers the
// library's address for the work and a one-time ticket, which the sign-in window (Task F16) opens. Neither is in any
// log line, audit entry, event, error or file. Every entry resting as R324 a names carries "Where to get it" in
// `offers` (the copy services' links first, then the publisher's page, the catalogue, Open Library and WorldCat).

/** How the researcher's library builds its links (the library's `LibraryAccess`). Only https addresses. */
export type LibraryAccess = { kind: "ezproxy-login"; base: string } | { kind: "openathens"; base: string } | { kind: "openurl"; base: string };
export const LIBRARY_ACCESS_KINDS = ["ezproxy-login", "openathens", "openurl"] as const;
export type LibraryAccessKind = (typeof LIBRARY_ACCESS_KINDS)[number];
/** The kind in words, for the screen and the derive sentence. */
export const LIBRARY_ACCESS_KIND_TEXT: Record<LibraryAccessKind, string> = { "ezproxy-login": "EZproxy", openathens: "OpenAthens", openurl: "link resolver" };

/** The settings (this computer's `your-library.json`). Not set: `access` null. */
export interface YourLibrary {
  /** "Your institution's name": at most 200 characters, no control characters ("" when not given). */
  name: string;
  access: LibraryAccess | null;
  /** The catalogue's search address: https, `{query}` exactly once after the host, no user name or password. */
  catalogueSearch?: string;
  /** Off unless the researcher turns it on (the shell honours it on a Mac only, F16). */
  staySignedIn: boolean;
}
export interface YourLibraryResponse extends YourLibrary {
  /**
   * R336 i: the service's own sentence for the stored address — the same words "derive" gives for it ("Your library's
   * address: <host> (EZproxy)"; a resolver: "<host><path>") — absent when no library is set. The screen makes none.
   */
  addressSentence?: string;
  /** The file could not be used: shown as not set ("unreadable", replaced by the next save) or read-only ("newer"). */
  problem?: { code: "unreadable" | "newer"; text: string };
}
export interface YourLibraryDeriveRequest {
  link: string;
}
export interface YourLibraryDeriveResponse {
  access: LibraryAccess | null;
  /** On success "Your library's address: <host> (<kind>)" (a resolver: "<host><path>"); otherwise why the link cannot be used. Never the link. */
  sentence: string;
}
/** `POST …/library/start`: the library's address for the work, and the one-time ticket (32 hex). */
export interface FindLibraryStartResponse {
  url: string;
  ticket: string;
}
/**
 * Task F18a (R334 b): `POST /settings/your-library/test` (no body) — the library's address for the one fixed, well-known
 * work `YOUR_LIBRARY_TEST_DOI`, by the stored access; nothing typed, nothing of a project. The page opens the sign-in
 * window there with a ticket of its own (no ticket of the service), so whatever the window might fetch is discarded.
 * Refused (409) with FIND_LIBRARY_TEXT.noLibrary (reason "no-library") when no library is set, and with
 * YOUR_LIBRARY_TEXT.unreadable / .newer when the settings file cannot be used. The address is in no log, audit,
 * event or error.
 */
export interface YourLibraryTestResponse {
  url: string;
}
/** The fixed work of "Test" (the same well-known DOI the Search sources' tests ask about). */
export const YOUR_LIBRARY_TEST_DOI = "10.1038/171737a0";
/** R324 a: on the entry's view (`FindEntryView.library`). */
export type FindLibraryChance = (
  | { canStart: true }
  | { canStart: false; reason: "no-library" }
  /** Task F17 (R329 g): no start is offered now; only with `lastFile` (otherwise the field is absent). */
  | { canStart: false; reason: "not-offered" }
) & {
  /**
   * Task F17 (R329 g): what became of the last file handed over for this entry when it could NOT be held — the entry
   * returned to exactly what it was. Kept by the service in memory only: gone at the entry's next start and at a
   * restart. Its sentence is FIND_LIBRARY_FILE_TEXT.
   */
  lastFile?: FindLibraryFileOutcome;
  /**
   * Task F18c (R345 e): with `lastFile`, "link" when that file was fetched at one of the entry's links (its sentence is
   * then FIND_LINK_FILE_TEXT, which names no library). Absent for a file through the library.
   */
  lastFileFrom?: "link" | "browser";
};

/** The longest link "derive" reads (a longer one is refused in words). */
export const YOUR_LIBRARY_LINK_MAX = 4096;
/** The longest institution's name kept. */
export const YOUR_LIBRARY_NAME_MAX = 200;
/** The longest catalogue search address kept. */
export const YOUR_LIBRARY_CATALOGUE_MAX = 2048;
/** The largest body these routes take. */
export const YOUR_LIBRARY_BODY_MAX_BYTES = 16_384;
/** At least this long between one hand-over and the next start (the plan's Running constraint). */
export const LIBRARY_PAUSE_MS = 20_000;
/** A ticket is good for this long, once. */
export const LIBRARY_TICKET_MS = 30 * 60_000;
/** "Where to get it" holds at most this many links, each address at most this long. */
export const WHERE_TO_GET_IT_MAX = 12;
export const WHERE_TO_GET_IT_URL_MAX = 2048;

/** Why a pasted link gives no address (the library's `DeriveRefusal`), each with its sentence. */
export const YOUR_LIBRARY_DERIVE_REFUSALS = ["not-https", "userinfo", "too-long", "unreadable", "bad-host", "not-library", "session-key"] as const;
export type YourLibraryDeriveRefusal = (typeof YOUR_LIBRARY_DERIVE_REFUSALS)[number];
export const YOUR_LIBRARY_DERIVE_TEXT: Record<YourLibraryDeriveRefusal, string> = {
  "not-https": "Only a link that starts with https:// can be used. Paste one you reached by signing in through your library.",
  userinfo: "That link holds a user name or a password, so it was not used. Paste a link without one.",
  "too-long": "That link is too long to be used (at most 4,096 characters).",
  unreadable: "That is not a link the app can read. Copy the whole address from your browser and paste it again.",
  "bad-host": "That link's address cannot be used: it needs a full host name, not a number or a single word.",
  "not-library": "That link does not go through a library. Paste one you reached by signing in through your library.",
  /** R328 b: a link resolver's path holding what looks like a session's key. */
  "session-key": "That link holds what looks like a session's key in its address. Paste the link of your library's own search page instead.",
};
/**
 * The derive sentence for an address worked out (the plan's F18 words): the host and the kind, never the link; for a
 * link resolver, whose address keeps its path, `host` is the host AND the path (R328 b).
 */
export const yourLibraryAddressSentence = (host: string, kind: LibraryAccessKind): string => `Your library's address: ${host} (${LIBRARY_ACCESS_KIND_TEXT[kind]})`;

/** The pause's refusal: "Ready in N seconds." in whole seconds, rounded up by the caller ("Ready in 1 second."). */
export const libraryReadyIn = (seconds: number): string => (seconds === 1 ? "Ready in 1 second." : `Ready in ${seconds} seconds.`);

/** The settings routes' sentences. A refusal names the field, never what was sent. */
export const YOUR_LIBRARY_TEXT = {
  uiOnly: "Your library is set from the desktop app.",
  fields: "Only name, access, catalogueSearch and staySignedIn can be saved.",
  name: "The institution's name must be at most 200 characters, with no control characters.",
  access: "The library's address is not one the app worked out. Use “Work out the address” again.",
  catalogueSearch: "The catalogue search address must start with https://, hold {query} exactly once after its host, and hold no user name or password.",
  staySignedIn: "“Stay signed in” must be on or off.",
  link: "Send the link to work out, and nothing else.",
  newer: "These Your library settings were written by a newer version of the app. Update the app to change them.",
  unreadable: "Your library settings could not be read, so no library is set. Saving them again replaces the file (the old one is kept beside it).",
  noBody: "This request takes no body. Nothing was changed.",
  /** F18a (R334 b): the stored address gives no address for the test's work (not expected: a stored access is checked). */
  testNoAddress: "No address for the test could be made from your library's settings. Use “Work out the address” again, then save.",
} as const;

/** A start through the library refused (its `reason` → its sentence; the pause's sentence is `libraryReadyIn`). */
export const FIND_LIBRARY_TEXT = {
  /** "library-not-offered": the entry is not one a start is offered for (R324 a). */
  notOffered: "This entry cannot be fetched through your library now. Nothing was changed.",
  /** "no-library": no library is set — the researcher's to mend. */
  noLibrary: "Your library is not set. Set it in Your library, then try again.",
  /** "library-busy": another ticket is open (one work waits at a time, in the sign-in window or in the browser; R348 b). */
  busy: "Another work is waiting for its file, in the sign-in window or in your browser. Finish or cancel it first.",
  /** "library-held-full" (R324 a): FIND_HELD_MAX files already wait for the researcher's check. */
  heldFull: `${FIND_HELD_MAX} files are already waiting for your check. Decide on some of them, then try again.`,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Task F17 (R329): the file handed over by the sign-in window (the shell writes it into its private inbox and names it
// on the service's standard input). By the owner's rule (R301) it is never attached by the app: it waits in the review
// queue for the researcher's check, as a found free copy does, and the entry says "Needs your check". When it cannot be
// held, the entry returns to what it was and its view's `library.lastFile` says why.

/** The largest file taken from the library (the plan's Limits). */
export const LIBRARY_FILE_MAX_BYTES = 200 * 1024 * 1024;

/** Why a file handed over through the library was not held. */
export const FIND_LIBRARY_FILE_OUTCOMES = ["not-pdf", "too-large", "unreadable", "rules-method", "rules-store", "rules-legal-basis"] as const;
export type FindLibraryFileOutcome = (typeof FIND_LIBRARY_FILE_OUTCOMES)[number];
/**
 * Task F20a (R348 g): why a handed-over file was not kept, in the words every not-kept sentence ends with — ONE source
 * for the library's, the link's and the browser's sentences, so that their causes cannot drift apart. The method's
 * cause depends on the method the start asked for (`library_access` for the library and the browser, `free_copy` for
 * a link); "unreadable" has a sentence of its own for each.
 */
export const FIND_FILE_NOT_KEPT_CAUSE = {
  "not-pdf": "it is not a PDF or EPUB.",
  "too-large": "it is larger than 200 MB.",
  "rules-store": "this project's rules do not allow storing the file for this record.",
  "rules-legal-basis": "this project's rules need a legal basis to store the file for this record, and the record has none.",
  /** The method `library_access` (the library's start, in the window or in the browser). */
  "rules-method-library": "this project's rules do not allow fetching works through your library.",
  /** The method `free_copy` (a link's start). */
  "rules-method-link": "this project's rules do not allow fetching free copies of works.",
} as const;

/** The not-kept sentences of one kind of start: `<prefix><cause>` for each cause, `unreadable` its own. */
const notKeptText = (prefix: string, method: "rules-method-library" | "rules-method-link", unreadable: string): Record<FindLibraryFileOutcome, string> => ({
  "not-pdf": `${prefix}${FIND_FILE_NOT_KEPT_CAUSE["not-pdf"]}`,
  "too-large": `${prefix}${FIND_FILE_NOT_KEPT_CAUSE["too-large"]}`,
  unreadable,
  "rules-method": `${prefix}${FIND_FILE_NOT_KEPT_CAUSE[method]}`,
  "rules-store": `${prefix}${FIND_FILE_NOT_KEPT_CAUSE["rules-store"]}`,
  "rules-legal-basis": `${prefix}${FIND_FILE_NOT_KEPT_CAUSE["rules-legal-basis"]}`,
});

export const FIND_LIBRARY_FILE_TEXT: Record<FindLibraryFileOutcome, string> = notKeptText(
  "The file from your library was not kept: ",
  "rules-method-library",
  "The file from your library could not be read, so it was not kept. Try again through your library.",
);

// ---------------------------------------------------------------------------------------------------------------
// Task F18c (R345): "Open it here and fetch the PDF" — one of an entry's own links opened in the sign-in window, on the
// researcher's press. The same ticket, waiting state, window and hand-over as a start through the library; the file it
// gives waits in the review queue for the researcher's check (R301), recorded as a free copy got in a signed-in window.
//
//   POST /projects/:id/find/:eid/link/start   FindLinkStartRequest → FindLibraryStartResponse (the link as the service
//                                             holds it, and the one-time ticket). Cancelled by `…/library/cancel`.

/** How the sign-in window was opened for an entry: through the library, or at one of the entry's links. */
export const FIND_WINDOW_STARTS = ["library", "link"] as const;
export type FindWindowStart = (typeof FIND_WINDOW_STARTS)[number];

/** The body of a link start: the link pressed (one of the entry's `offers`, as the view gave it), and nothing else. */
export interface FindLinkStartRequest {
  url: string;
}

/** A link start refused: its own sentences, where the library's would name the library untruly. */
export const FIND_LINK_TEXT = {
  /** 400: a body that is not `{ url }` with a string. */
  body: "Send the address to open, and nothing else. Nothing was changed.",
  /** "link-not-a-place": not one of the entry's own links as the service gives them now (400 when not https, with a user name or password, or too long). */
  notAPlace: "That address is not one of this entry's places. Nothing was changed.",
  /** "link-not-offered": the entry is not one a link start is offered for now. */
  notOffered: "A PDF cannot be fetched for this entry in the sign-in window now. Nothing was changed.",
} as const;

/** Why a file fetched at one of the entry's links was not held (the library's outcomes), in words that name no library. */
export const FIND_LINK_FILE_TEXT: Record<FindLibraryFileOutcome, string> = notKeptText(
  "The file fetched in the sign-in window was not kept: ",
  "rules-method-link",
  "The file fetched in the sign-in window could not be read, so it was not kept. Try again with “Open it here and fetch the PDF”.",
);

// ---------------------------------------------------------------------------------------------------------------
// Task F20a (R348): "Get through my library in my own browser" — the fallback for a library whose sign-in the app's
// window cannot do (a passkey, a security key, Google's sign-in). A third entry point into the one start: the same
// ticket (one work waits at a time, in the window OR in the browser), pause, limit, waiting state, cancel and ways
// back; what differs is kept with the ticket in memory: where the work waits. The paired browser extension sends the
// PDF of the researcher's tab; the file WAITS in the review queue for the researcher's check (R301), never added.
//
//   POST /projects/:id/find/:eid/browser/start   (the desktop app's token; no body) → FindBrowserStartResponse
//                                                (the library's address for the work, no ticket); cancelled by
//                                                `…/library/cancel`. Refusals: the library start's, and 409
//                                                "browser-not-paired" (FIND_BROWSER_TEXT.notPaired).
//   POST /find/browser/waiting                   (the extension's token and its paired Origin) FindBrowserWaitingRequest
//                                                → FindBrowserWaitingResponse
//   POST /find/browser/file/:ticket              (the extension's token and its paired Origin) the PDF's bytes,
//                                                `Content-Type: application/pdf`, header FIND_BROWSER_PAGE_HEADER (the
//                                                tab's address) → FindBrowserFileResponse; refusals FIND_BROWSER_REFUSALS.

/** Where a work waits for its file: in the app's sign-in window, or in the researcher's own browser. */
export const FIND_WAITING_PLACES = ["window", "browser"] as const;
export type FindWaitingIn = (typeof FIND_WAITING_PLACES)[number];

/** The app's start in the browser: the library's address for the work, and nothing else (never the ticket). */
export interface FindBrowserStartResponse {
  url: string;
}
/** The extension's list asked for: exactly `{}`. */
export type FindBrowserWaitingRequest = Record<string, never>;
/** A work waiting for a PDF from the browser, as the extension gets it: its ticket and its title cut, nothing else. */
export interface FindBrowserWaiting {
  ticket: string;
  /** The record's title, at most FIND_BROWSER_LABEL_MAX characters (code points); FIND_BROWSER_NO_TITLE without one. Text, never markup. */
  label: string;
}
/** Today none or one (one ticket for the whole service). */
export interface FindBrowserWaitingResponse {
  waiting: FindBrowserWaiting[];
}
/** How the hand-over of a file sent from the browser ended. */
export const FIND_BROWSER_FILE_ENDS = ["held", "not-kept", "gone"] as const;
export type FindBrowserFileEnd = (typeof FIND_BROWSER_FILE_ENDS)[number];
/** The answer once the file's path has ended (always 200): "held", "not-kept" (FIND_BROWSER_FILE_TEXT) or "gone". */
export interface FindBrowserFileResponse {
  outcome: FindBrowserFileEnd;
  sentence: string;
}
/** The longest label the list gives, in characters (code points). */
export const FIND_BROWSER_LABEL_MAX = 200;
/** The label of a record without a title. */
export const FIND_BROWSER_NO_TITLE = "(no title)";
/** The header that carries the tab's address, and its longest form. */
export const FIND_BROWSER_PAGE_HEADER = "x-ao-page";
export const FIND_BROWSER_PAGE_MAX = 2048;
/** No byte of the PDF for this long: cut off. */
export const FIND_BROWSER_STALL_MS = 120_000;
/** R353 a: the body ends within this long of the ticket's check (else cut off), beside the stall's end. */
export const FIND_BROWSER_TAKE_MS = 300_000;
/** The file route's refusals, in the order they are checked (each with its sentence in FIND_BROWSER_TEXT). */
export const FIND_BROWSER_REFUSALS = ["browser-not-waiting", "browser-page", "browser-busy", "browser-inbox", "browser-too-large", "browser-not-pdf", "browser-cut-off"] as const;
export type FindBrowserRefusal = (typeof FIND_BROWSER_REFUSALS)[number];
export const FIND_BROWSER_TEXT = {
  /** 409 "browser-not-paired" (the app's start). */
  notPaired: "No browser is paired with this app. Pair the browser extension first (Browser extension, in the settings). Nothing was changed.",
  /** 403: the extension's routes reached with the desktop app's token. */
  extensionOnly: "This is the browser extension's route.",
  /** 400: the list asked with anything but `{}`. */
  listBody: "This request takes an empty object ({}) and nothing else.",
  /** 404 "browser-not-waiting": the same answer for every wrong ticket. */
  notWaiting: "That work is no longer waiting for a PDF from your browser. Nothing was kept.",
  /** 400 "browser-page". */
  page: "This tab's address is not an https address, so the app does not take a file from it. The work is still waiting.",
  /** 409 "browser-busy". */
  busy: "A PDF from your browser is being taken in. Try again in a moment.",
  /** 503 "browser-inbox" (R353 g): the inbox is not a real folder of the service's user with mode 0700; nothing written. */
  inbox: "The app's folder for files from your browser cannot be used right now. Nothing was kept. The work is still waiting.",
  /** 413 "browser-too-large". */
  tooLarge: "That PDF is larger than 200 MB, so the app does not take it. The work is still waiting.",
  /** 400 "browser-not-pdf". */
  notPdf: "That tab's file is not a PDF. The work is still waiting.",
  /** 400 "browser-cut-off". */
  cutOff: "The PDF did not arrive whole. The work is still waiting. Try again.",
  /** 200 "held". */
  held: "Sent. The file waits for your check in the app's review queue.",
  /** 200 "gone": the entry or its record removed, the project locked, the record already has a file. */
  gone: "The file was not kept: the work is no longer waiting for it.",
} as const;
/** 200 "not-kept": the sentence the entry's row shows (by `library.lastFileFrom: "browser"`). */
export const FIND_BROWSER_FILE_TEXT: Record<FindLibraryFileOutcome, string> = notKeptText(
  "The file sent from your browser was not kept: ",
  "rules-method-library",
  "The file sent from your browser could not be read, so it was not kept. Try again with “Get through my library in my own browser”.",
);
