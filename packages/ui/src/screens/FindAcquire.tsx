/**
 * "Find and acquire", slice 1 (Task F6; plan Amendments A1–A4; R145, R225, R237, R245, R247): the researcher types
 * references — a title and author, one per line — into one box; each becomes a queue entry that says in words where
 * it stands and offers what can be done next. The contract is F5's (apps/library-service/src/routes/find.ts and
 * @ao/shared api/find.ts).
 *
 * The service is the authority, and the screen never shows something older than it knows:
 *   - A row is what the service last said. `find.progress` carries only `{ projectId, entryId, state }`: an event
 *     means "read the queue again", coalesced — while a read is out, further events ask for ONE more read after it,
 *     so a burst of fifty events makes one or two reads.
 *   - Which version of an entry is shown is decided by the SERVICE's stamp (`updatedAt`, R262 N1): whenever a read or
 *     an act's answer holds an entry already shown, the later stamp is kept; with equal stamps, what arrived later,
 *     except that of two reads the one STARTED later wins. A row missing from a read goes only if that read started
 *     after the last act's answer naming the row (and after the read that last gave it); otherwise it stays and one
 *     fresh read is made at once. A row removed here never comes back. The status says a row's change only when
 *     what is shown changed. After every act the queue is read once more. While events keep coming, coalesced reads
 *     start at least 400 ms apart (R258 M7).
 *   - The queue is keyed by its project and by the library: changing the project drops the old rows, and another
 *     library opening forgets everything of the old one (rows, lists, settings, dialog, answers still out; R258 I1).
 *   - The remembered settings are written one PUT at a time, each from the last confirmed answer (M2).
 *   - While an add is out the box is read-only, so nothing typed is lost (I2).
 *   - One request per press: the pressed control shows it is working and ignores a second press.
 *
 * What was typed is the researcher's text: it goes to the service in a request BODY only (never into the address,
 * the document's title, the console or an error built here) and is shown only through UserText, as is everything a
 * search service returned. One polite status region says the results of the researcher's own acts and a row's
 * change of state; a read that changes several rows says how many changed, not each event.
 *
 * Focus: after "Remove from the queue" focus goes to the next row's text (the previous one's for the last; the box
 * when the queue is empty). When any other control the researcher used goes away (its state passed, the dialog
 * closed on a row that changed), focus goes to that row's next control, else its text; when the row itself has gone,
 * to the next row, else the box — never to the page.
 *
 * An author alone (Task F9; R267, R270–R272): "Choose the person" and "Choose works" open their dialogs; the lists
 * are read from the entry's `options` when a dialog opens (the queue's answer carries counts only), are dropped with
 * the dialog, and are forgotten with everything else when another library opens. "This is the person" and "Add the
 * chosen works" are acts like the others: their answers take their place in the order (R262, R263).
 *   - R272 a: while a change of "Check everything I have" is out, an add is not sent; it is sent as soon as the
 *     change is confirmed, or — if the change fails — not at all, the text kept and the failure said.
 *   - R291 a: a change with no answer in SWITCH_TIMEOUT_MS may still have been stored (only its answer was lost): the
 *     screen then reads the settings (`GET /find/screen`) before anything else, the switch and "Add" busy meanwhile;
 *     the switch shows what the service holds, and a waiting add is sent only if that is the position asked for. If
 *     that read fails too, the settings are unreadable (M3: the queue's answer says what is stored) and nothing is added.
 *   - R291 b: an event about the library already held never resets the screen; it reads again only what has not been
 *     read successfully. The full reset is for another library, or when nothing has been read yet.
 *   - R272 b: the result of the researcher's own act ("Added 2 references.", "Added 3 works.", "Removed …") is said
 *     first and stays for ACT_SAID_MS; rows' changes arriving meanwhile are said after it — each row's latest as
 *     shown then, never the same change twice.
 *
 * "Open it here and fetch the PDF" (Task F18c; R345): a press on that control of one of a row's links is the SAME press
 * as "Get through my library" (`startWindow`, one function for both) with the link's start in place of the library's:
 * ONE `POST …/link/start` with `{ url }` (that link, as the row's "Where to get it" parsed it), then the same open, the
 * same retry, the same cancel when the window does not open, the same busy state; the waiting row, the shell's events,
 * the closing and the hand-over do not know which start it was — only the words that would name the library untruly
 * (the shell's "no ticket") are chosen by the view's `windowStart`.
 *
 * "Get through my library in my own browser" (Task F20c; R348 h): the same press once more, `startWindow` with a third
 * kind — ONE `POST …/browser/start` (no body), whose answer is the library's address and nothing else; the shell opens
 * that address in the researcher's own browser (`openInBrowser`, as "Open in my browser" does), the paired extension
 * sends the PDF back to the service. No window of the app opens and no ticket reaches the page, so the page holds none
 * (`libTicket`, `heldATicket` untouched): the shell's window events are never such a row's, "Cancel" closes no window,
 * and nothing closes or cancels by itself when the row stops waiting. A browser the shell could not open: the wait is
 * cancelled (ONE cancel) and the row says so. Where the work waits is the view's word (`waitingIn`).
 *
 * Through the researcher's library (Task F18b; R340, R301; F15's start and cancel, F16's shell, F17's outcome):
 *   - Every library step is the researcher's press on that row: nothing is started on focus, on hover, on a timer, on
 *     an event or when the screen opens. "Get through my library" is ONE `POST …/library/start` (no body); with its
 *     answer the shell opens the sign-in window (`openLibraryWindow(ticket, url, from)`; R347 a). If the shell does not take it
 *     (anything but `true`, or no answer in LIBRARY_SHELL_TIMEOUT_MS), the start is cancelled at the service and the
 *     row says so. A refusal is the service's sentence on the row (said once, as every act's refusal is).
 *   - **The ticket and the address go to the shell and nowhere else**: they live in the press's own variables; the
 *     ticket alone is kept, in memory (a ref, never a state, the page's address, storage, an element or the console),
 *     for as long as the row waits, to know which of the shell's events are this row's. An event is the row's when it
 *     carries that ticket — or, when the screen holds none (the page was loaded afresh), when the row is the one row
 *     that waits; any other event changes nothing.
 *   - What the shell reports is shown on the row and said once (R340 b); the row's state itself is always what the
 *     service says. The window closed while the entry still waits: the start is cancelled at the service (a 409 because
 *     it no longer waits is not an error: the file is being checked). "Cancel" is the service's cancel, then the
 *     window is closed. "Add the PDF showing in the sign-in window" is the shell's take: the shell fetches the PDF and
 *     hands it to the service, where it waits in the review queue for the researcher's check.
 *   - R342 a: the window never outlives the wait it was opened for. When the row this page opened it for stops waiting
 *     by any way but the hand-over (Cancel, its removal here, the service returning it), the window is closed, once;
 *     an open the page gave up on is closed if the shell then answers that it opened it. Such a ticket is kept as
 *     "ended" until the shell reports its window closed, and none of its events is any row's.
 *   - R342 b: a window left over from before never blocks a start: if the shell refuses the open (exactly `false`), the
 *     page closes the window, waits for the shell's next `closed` (at most LIBRARY_CLOSE_WAIT_MS) and asks once more,
 *     within the same press; only if that fails too is the start cancelled and said.
 *   - R342 c: after a start the focus goes to the row's own words, never onto a control that acts.
 *   - R342 d, f: an event without the page's own ticket counts for the one waiting row only on a page that has held no
 *     ticket since it was loaded; an event with the page's own ticket counts for its row even before a read shows it
 *     waiting.
 */
import {
  FIND_ROUTE_TEXT,
  type FindAddResponse,
  type FindChosenPerson,
  type FindBrowserStartResponse,
  type FindEntryView,
  type FindLibraryStartResponse,
  type FindLinkStartRequest,
  type FindPersonCandidate,
  type FindPersonWork,
  type FindQueueResponse,
  type FindScreenSettings,
} from "@ao/shared";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ApiClientError, SERVICE_NO_ANSWER, SERVICE_UNREACHABLE, STREAM_OPEN_TIMEOUT_MS, STREAM_QUIET_TIMEOUT_MS, type ApiClient, type ServiceEvent } from "../api/client";
import { findApi, findHref, findProgressOf, type FindApi } from "../api/find";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, readWithin } from "../api/firstRead";
import { isValidId } from "../api/import";
import { isProjectLocked, libraryApi, type Collection, type LibraryApi, type LibraryState, type ProjectSummary } from "../api/library";
import { ChoosePersonDialog } from "../components/ChoosePersonDialog";
import { ChooseWorkDialog } from "../components/ChooseWorkDialog";
import { ChooseWorksDialog } from "../components/ChooseWorksDialog";
import { authorOfferOf, entryLabel, FIND_TEXT, FindEntryRow, stateWords, waitsInBrowser, wordsText, WordsView, type FindAction, type FindActKind, type FindPlace, type Words } from "../components/FindEntryRow";
import { UserText } from "../components/UserText";
import { desktopShell, type LibraryWindowEvent, type LibraryWindowFrom } from "../desktopShell";
import "../components/library.css";
import { inAppLink, navigate, projectInQuery, type AppLocation } from "../navigation";
import { searchSourcesHref } from "./SearchSources";
import { SourceDetail } from "./SourceDetail";
import { UnlockProject } from "./UnlockProject";
import "./FindAcquire.css";

export const FIND_SCREEN_TEXT = {
  hint: "One reference per line: a title and author, or an author alone.",
  empty: "Nothing is in the queue yet.",
  loading: "Reading the queue…",
  noProject: "This library has no project yet. Create one in the library, then come back here.",
  noLibrary: "No library is open. Open one from the library to use Find and acquire.",
  projectsUnreadable: "The projects could not be read.",
  screenUnreadable: "This computer's Find and acquire settings could not be read.",
  addTimedOut: "The service did not answer. Nothing was added that the queue does not show.",
  /** R272 a: an add waits for a change of the switch; that change failed, so the add is not sent. */
  addSwitchFailed: "Nothing was added, because “Check everything I have” could not be changed. The text is kept: press “Add” to add it with the switch as it is now.",
  optionsUnreadable: "The list could not be read. Close this and try again.",
  /**
   * R291 a: an add waited for a change of the switch that got no answer, and the settings read afterwards shows another
   * position than the one asked for, or cannot be read: the add is not sent.
   */
  addSwitchNoAnswer: "Nothing was added. The text is kept: press “Add” to add it with the switch as it is now.",
} as const;

/** R291 a: beside the switch after a change with no answer, once the settings were read again: what the service holds. */
export const switchReadText = (on: boolean) => `The service did not answer in time. “Check everything I have” is ${on ? "on" : "off"}.`;

/** The result of the researcher's own act stays in the status region at least this long before rows' changes are said (R272 b). */
export const ACT_SAID_MS = 1000;
/** Up to this many rows' changes are said one by one in one message; more are counted. */
const ROWS_SAID_MAX = 3;

const addedWorksText = (k: number) => (k === 1 ? "Added 1 work." : `Added ${k} works.`);

const RECONNECT_MS = 2000;
/** At most this many "where is it" questions out at once. */
const PLACE_CONCURRENCY = 4;
/** Events that arrive this close together make one read. */
const EVENT_COALESCE_MS = 50;
/** While events keep coming, coalesced reads of the queue start at least this far apart (R258 M7). */
const READ_GAP_MS = 400;
/** An add with no answer for this long is given up (R262 N5). */
const ADD_TIMEOUT_MS = 60_000;
/** A change of the switch with no answer for this long is given up (R281 c). */
export const SWITCH_TIMEOUT_MS = 60_000;
/** A call to the desktop shell with no answer for this long is given up (the house's limit, as on Your library). */
export const LIBRARY_SHELL_TIMEOUT_MS = 60_000;
/** R342 b: how long a start waits for the shell to report a leftover window closed before it asks the shell once more. */
export const LIBRARY_CLOSE_WAIT_MS = 5_000;
/**
 * FR-558: a read of the queue is waited for at most this long by what waits on it (a row's control, the next read asked
 * for); a read that never answers then keeps no control busy and holds no later read back. It is cancelled then (R472):
 * a late answer is not taken, and the next read shows what it would have.
 */
export const QUEUE_READ_WAIT_MS = 60_000;

/**
 * F15's start and cancel (apps/library-service/src/routes/your-library.ts), as their handlers take them: no body. Ids
 * are checked before they go into a path, as every find route's are.
 */
export function findLibraryApi(client: ApiClient) {
  const path = (pid: string, eid: string, act: "start" | "cancel") => {
    if (!isValidId(pid) || !isValidId(eid)) throw new Error("That is not a valid id.");
    return `/projects/${encodeURIComponent(pid)}/find/${encodeURIComponent(eid)}/library/${act}`;
  };
  return {
    /** The library's address for the work and a one-time ticket: handed to the shell, and nowhere else. */
    start: (pid: string, eid: string) => client.request<FindLibraryStartResponse>("POST", path(pid, eid, "start")),
    /**
     * F18c (R345): "Open it here and fetch the PDF" — the start at one of the entry's links, the link alone in the body.
     * The answer is the link as the service holds it and a one-time ticket: handed to the shell, and nowhere else.
     */
    linkStart: (pid: string, eid: string, url: string) => {
      if (!isValidId(pid) || !isValidId(eid)) throw new Error("That is not a valid id.");
      return client.request<FindLibraryStartResponse>("POST", `/projects/${encodeURIComponent(pid)}/find/${encodeURIComponent(eid)}/link/start`, { body: { url } satisfies FindLinkStartRequest });
    },
    /**
     * F20c (R348 d): "Get through my library in my own browser" — no body; the answer is the library's address for the
     * work and nothing else (no ticket: the paired extension sends the file).
     */
    browserStart: (pid: string, eid: string) => {
      if (!isValidId(pid) || !isValidId(eid)) throw new Error("That is not a valid id.");
      return client.request<FindBrowserStartResponse>("POST", `/projects/${encodeURIComponent(pid)}/find/${encodeURIComponent(eid)}/browser/start`);
    },
    /** The entry back to what it was; 409 "entry-state" when it no longer waits (the one cancel serves every kind). */
    cancel: (pid: string, eid: string) => client.request<FindEntryView>("POST", path(pid, eid, "cancel")),
  };
}
export type FindLibraryApi = ReturnType<typeof findLibraryApi>;

/** What came of a call to the shell given at most `ms`: its answer, "threw", or "gave-up" (its late answer is ignored here). */
function shellWithin<V>(p: Promise<V>, ms = LIBRARY_SHELL_TIMEOUT_MS): Promise<V | "threw" | "gave-up"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("gave-up"), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve("threw");
      },
    );
  });
}

/**
 * R340 b: what the shell reports for the row, in words (said once each). `opened` and `closed` have their own handling.
 * F18c (R345 e): the one sentence that names the control to use again names the one the row was started by.
 */
function windowSentence(e: LibraryWindowEvent, v: FindEntryView): string | undefined {
  switch (e.state) {
    case "fetching":
      return FIND_TEXT.fetching;
    case "not-a-pdf":
      // R347 d: the true reason when the shell refused the page; "not a PDF" only when it looked and found none.
      return e.reason === "sign-in-address" ? FIND_TEXT.notAPdfSignIn : e.reason === "not-https" ? FIND_TEXT.notAPdfNotHttps : FIND_TEXT.notAPdf;
    case "failed":
      // R342 e: no ticket is open in the shell — no window for this work.
      if (e.reason === "no-ticket") return v.windowStart === "link" ? FIND_TEXT.noWindowLink : FIND_TEXT.noWindow;
      return e.reason === "pause" ? FIND_TEXT.fetchPause : e.reason === "busy" ? FIND_TEXT.fetchBusy : FIND_TEXT.fetchFailed;
    case "handed-over":
      return FIND_TEXT.handedOver;
    default:
      return undefined;
  }
}

/**
 * The three kinds of start of one press (`startWindow`): the library's and a link's in the app's sign-in window (with a
 * ticket), and F20c's (R348 h) in the researcher's own browser (no ticket, no window of the app).
 */
type StartHow = { kind: "library" } | { kind: "link"; url: string } | { kind: "browser" };

/** A sentence shown on a row about its fetch through the library: `whileWaiting` ones go when the row stops waiting. */
interface LibraryNote {
  text: string;
  whileWaiting: boolean;
}

/**
 * How a change of the switch ended, for an add that waited for it (R272 a, R281 c, R291 a): "ok" — the service holds the
 * position asked for (confirmed, or read after a change with no answer); "failed" — refused; "not-stored" — no answer,
 * and the settings read afterwards show the other position (`note`: the sentence beside the switch); "unknown" — no
 * answer, and the settings could not be read either.
 */
export type SwitchOutcome = "ok" | "failed" | "not-stored" | "unknown";
export interface SwitchResult {
  outcome: SwitchOutcome;
  note?: string;
}

/** -1, 0 or 1: which of two entries the service stamped later (`updatedAt`); 0 when equal or not comparable. */
function stampOrder(a: FindEntryView, b: FindEntryView): number {
  const ta = typeof a.updatedAt === "string" ? Date.parse(a.updatedAt) : NaN;
  const tb = typeof b.updatedAt === "string" ? Date.parse(b.updatedAt) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb ? 1 : -1;
  if (typeof a.updatedAt === "string" && typeof b.updatedAt === "string" && a.updatedAt !== b.updatedAt && !Number.isFinite(ta + tb)) return a.updatedAt > b.updatedAt ? 1 : -1;
  return 0;
}

/** The service's own sentence for a refusal (plain words, never what was typed), or a fallback. */
const sentenceOf = (err: unknown, fallback: string): string => (err instanceof ApiClientError && err.message ? err.message : fallback);

const lockedCountText = (k: number) => (k === 1 ? "1 locked project was not checked" : `${k} locked projects were not checked`);
const unreadableText = (k: number) => (k === 1 ? "1 line of the queue could not be read and is kept." : `${k} lines of the queue could not be read and are kept.`);
const addedText = (r: FindAddResponse): string => {
  const k = r.added.length;
  const lead = k === 1 ? "Added 1 reference." : `Added ${k} references.`;
  const m = r.mergedLines;
  if (!m) return lead;
  return `${lead} ${m === 1 ? "1 line was the same as another and was added once." : `${m} lines were the same as another and were added once.`}`;
};

/** Something said in the polite region: a new `n` is a new node, so the same words again are said again. */
interface Said {
  words: Words;
  n: number;
}

/** What is said about one entry's state: “typed”: words. */
const saidOf = (v: FindEntryView, stopped: boolean, origin: string | null | undefined): Words => [...entryLabel(v, origin), ": ", ...stateWords(v, { stopped }), "."];

const byCreated = (a: FindEntryView, b: FindEntryView) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const same = (a: FindEntryView, b: FindEntryView) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isElsewhere = (e: FindEntryView) => !!e.elsewhere && (e.state === "already" || e.state === "maybe-duplicate");

// ---------------------------------------------------------------------------------------------
// The screen: project, collection, the switch; the queue of the chosen project below

/** What the screen passes on to the queue from the one event stream it listens to. */
type QueueSignal = { kind: "event"; ev: ServiceEvent } | { kind: "refresh" } | { kind: "say"; words: Words } | { kind: "retry" };
interface QueueBus {
  subscribe(fn: (s: QueueSignal) => void): () => void;
}

/**
 * `firstReadMs` (FR-750, R579): how long a read of the projects, of the remembered settings or of the queue is waited for
 * before it is given up as a read that got no answer (FIRST_READ_TIMEOUT_MS; smaller in tests).
 * `streamOpenMs` (FR-756 C, R597): how long the event stream is waited for to open before it is closed and tried afresh
 * after the screen's pause (STREAM_OPEN_TIMEOUT_MS; smaller in tests); an open stream is never ended by it.
 */
export function FindAcquire({ client, loc, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS, streamQuietMs = STREAM_QUIET_TIMEOUT_MS }: { client: ApiClient; loc: AppLocation; firstReadMs?: number; streamOpenMs?: number; streamQuietMs?: number }) {
  const api = useMemo(() => findApi(client), [client]);
  const libApi = useMemo(() => findLibraryApi(client), [client]);
  const lib = useMemo(() => libraryApi(client), [client]);
  const ids = useId();
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [projectsError, setProjectsError] = useState<string | undefined>();
  /** FR-750: the last read of the projects, or of the remembered settings, got no answer: "Try again" is offered. */
  const [projectsUnreachable, setProjectsUnreachable] = useState(false);
  const [screenUnreachable, setScreenUnreachable] = useState(false);
  /** What this computer remembers, as the service last confirmed it (the controls show this). */
  const [remembered, setRemembered] = useState<FindScreenSettings | undefined>();
  /** The remembered settings could not be read: the service's sentence, said once (R258 M3). */
  const [screenError, setScreenError] = useState<string | undefined>();
  /** The switch while its change is being sent. */
  const [checkSending, setCheckSending] = useState<boolean | undefined>();
  const [switchError, setSwitchError] = useState<string | undefined>();
  /** R291 a: what the service holds, read after a change of the switch that got no answer (beside the switch). */
  const [switchNote, setSwitchNote] = useState<string | undefined>();
  const [settingsError, setSettingsError] = useState<string | undefined>();
  /** The project the researcher chose on this screen (else the address's, else the remembered one). */
  const [chosen, setChosen] = useState<string | undefined>();
  const [collections, setCollections] = useState<Collection[] | undefined>();
  const [collectionId, setCollectionId] = useState("");
  /**
   * R586 M3: the chosen project's collections could not be read (the sentence, and whether "Try again" may help); the
   * remembered collection is chosen only once a read has answered. `collectionsTry` moves on with "Try again".
   */
  const [collectionsError, setCollectionsError] = useState<string | undefined>();
  const [collectionsUnreachable, setCollectionsUnreachable] = useState(false);
  const [collectionsTry, setCollectionsTry] = useState(0);
  /** What is in the box: the researcher's, kept when the project or the library changes. */
  const [text, setText] = useState("");
  /** Bumped after the switch changed: the queue is read again (its locked count, its matches elsewhere). */
  const [switchVersion, setSwitchVersion] = useState(0);
  /** Moves on when another library opens: everything below starts afresh (R258 I1). */
  const [epoch, setEpoch] = useState(0);
  const [noLibrary, setNoLibrary] = useState(false);
  const alive = useRef(true);
  const switchBusy = useRef(false);
  /** The last answer of the service about the remembered settings; every PUT is built from it plus its own change (R258 M2). */
  const confirmed = useRef<FindScreenSettings>({ checkEverything: false });
  /** The time limits of PUTs and settings reads still out (cleared on unmount and when the library goes). */
  const putTimers = useRef(new Set<ReturnType<typeof setTimeout> | undefined>());
  /** Their requests, aborted when the library goes. */
  const putAborts = useRef(new Set<AbortController>());
  /** The PUTs, one at a time. */
  const putChain = useRef<Promise<void>>(Promise.resolve());
  /**
   * A change of the switch still out (R272 a): an add waits for it — true once the service confirmed it, false when it
   * failed or the library went.
   */
  const switchWait = useRef<{ p: Promise<SwitchResult>; resolve: (r: SwitchResult) => void; taken: boolean } | null>(null);
  /** The first reads of this library (projects, remembered settings) have both answered (R281 e). */
  const projectsRead_ok = useRef(false);
  const screenRead_ok = useRef(false);
  const waitForSwitch = useCallback(() => {
    const w = switchWait.current;
    if (!w) return undefined;
    w.taken = true;
    return w.p;
  }, []);
  /** GET /find/screen failed and nothing has been confirmed since: the queue's answer says what is stored (M3). */
  const screenUnread = useRef(false);
  /** Moves on with the library: an answer about the library that went is dropped. */
  const libGen = useRef(0);
  const listeners = useRef(new Set<(s: QueueSignal) => void>());
  const bus = useMemo<QueueBus>(
    () => ({
      subscribe(fn) {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
    }),
    [],
  );
  const emit = (s: QueueSignal) => {
    for (const fn of [...listeners.current]) fn(s);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * FR-750 (R579): the times the event stream failed or dropped, and the times it opened. A read records both when it
   * starts: at an opening, a read still out that began before the stream last failed is made again (it may never
   * settle), and the library's state delivered on that opening does not make again a read begun at it.
   */
  const streamDrops = useRef(0);
  const streamOpenings = useRef(0);
  /** The project list, read again when the service says the library changed; one read at a time, one more after it. */
  const projectsRead = useRef<{ again: boolean; drops: number; opening: number; ac: AbortController } | null>(null);
  /**
   * `restart` (FR-750): a read still out is given up (cancelled) and a new one made at once, in place of one more after it.
   * Every read is given up after `firstReadMs` as a read that got no answer.
   */
  const readProjects = useCallback(
    (o: { restart?: boolean } = {}) => {
      if (projectsRead.current) {
        if (!o.restart) {
          projectsRead.current.again = true;
          return;
        }
        projectsRead.current.ac.abort();
      }
      const mark = { again: false, drops: streamDrops.current, opening: streamOpenings.current, ac: new AbortController() };
      projectsRead.current = mark;
      const g = libGen.current;
      const mine = () => alive.current && g === libGen.current && projectsRead.current === mark;
      void (async () => {
        try {
          do {
            mark.again = false;
            try {
              const r = await readWithin((signal) => lib.projects.list({ signal }), firstReadMs, mark.ac.signal);
              if (!mine()) return;
              setProjects(r.projects);
              setProjectsError(undefined);
              setProjectsUnreachable(false);
              projectsRead_ok.current = true;
            } catch (err) {
              if (!mine()) return;
              setProjects((cur) => cur ?? []);
              setProjectsError(sentenceOf(err, FIND_SCREEN_TEXT.projectsUnreadable));
              setProjectsUnreachable(isUnreachable(err));
            }
          } while (mark.again && mine());
        } finally {
          if (projectsRead.current === mark) projectsRead.current = null;
        }
      })();
    },
    [lib, firstReadMs],
  );

  /**
   * One read of the remembered settings (`timeoutMs`: given up after that long, as a failure). Its answer is the new
   * confirmed one; a failure is the state for settings that cannot be read (M3: the queue's answer says what is stored).
   * "gone": the screen or the library went meanwhile, and nothing was changed.
   */
  const screenOnce = useCallback(
    async (timeoutMs?: number, first?: { ac: AbortController }): Promise<"ok" | "failed" | "gone"> => {
      const g = libGen.current;
      const ac = first?.ac ?? new AbortController();
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => ac.abort(), timeoutMs);
      putTimers.current.add(timer);
      putAborts.current.add(ac);
      // FR-750: a read of what is not yet read is given up after `firstReadMs`, as a read that got no answer; it is
      // "gone" when it was given up for a new one (`first.ac` aborted at an opening of the stream).
      const superseded = () => !!first && ac.signal.aborted;
      try {
        const s = first ? await readWithin((signal) => api.screen({ signal }), firstReadMs, ac.signal) : await api.screen({ signal: ac.signal });
        if (!alive.current || g !== libGen.current || superseded()) return "gone";
        confirmed.current = { ...s };
        screenUnread.current = false;
        screenRead_ok.current = true;
        setScreenError(undefined);
        setScreenUnreachable(false);
        setRemembered(s);
        return "ok";
      } catch (err) {
        if (!alive.current || g !== libGen.current || superseded()) return "gone";
        screenUnread.current = true;
        setScreenError(sentenceOf(err, FIND_SCREEN_TEXT.screenUnreadable));
        setScreenUnreachable(!!first && isUnreachable(err));
        setRemembered((cur) => cur ?? { ...confirmed.current });
        return "failed";
      } finally {
        clearTimeout(timer);
        putTimers.current.delete(timer);
        putAborts.current.delete(ac);
      }
    },
    [api, firstReadMs],
  );
  /**
   * A read of the settings not yet read, in the order of the PUTs (an older answer never wins over a newer one); one at a
   * time. `restart` (FR-750): one still out is given up (cancelled) and a new one made.
   */
  const screenReading = useRef<{ drops: number; opening: number; ac: AbortController } | null>(null);
  const readScreen = useCallback(
    (o: { restart?: boolean } = {}) => {
      if (screenReading.current) {
        if (!o.restart) return;
        screenReading.current.ac.abort();
      }
      const mark = { drops: streamDrops.current, opening: streamOpenings.current, ac: new AbortController() };
      screenReading.current = mark;
      const g = libGen.current;
      const run = async () => {
        try {
          if (alive.current && g === libGen.current && !mark.ac.signal.aborted) await screenOnce(undefined, mark);
        } finally {
          if (screenReading.current === mark) screenReading.current = null;
        }
      };
      putChain.current = putChain.current.then(run, run);
    },
    [screenOnce],
  );

  // ---- at load, and afresh for each library ----
  useEffect(() => {
    readProjects();
    readScreen();
  }, [readScreen, readProjects, epoch]);

  /** Another library (or none): nothing of the old one is kept — lists, settings, answers still out (R258 I1). */
  const forgetLibrary = useCallback(() => {
    libGen.current++;
    projectsRead.current?.ac.abort();
    projectsRead.current = null;
    putChain.current = Promise.resolve();
    screenReading.current?.ac.abort();
    screenReading.current = null;
    // What is still out about the old library is given up, and its time limits cleared.
    for (const t of putTimers.current) clearTimeout(t);
    putTimers.current.clear();
    for (const ac of putAborts.current) ac.abort();
    putAborts.current.clear();
    switchBusy.current = false;
    switchWait.current?.resolve({ outcome: "failed" });
    switchWait.current = null;
    projectsRead_ok.current = false;
    screenRead_ok.current = false;
    confirmed.current = { checkEverything: false };
    screenUnread.current = false;
    setProjects(undefined);
    setProjectsError(undefined);
    setProjectsUnreachable(false);
    setRemembered(undefined);
    setScreenError(undefined);
    setScreenUnreachable(false);
    setCheckSending(undefined);
    setSwitchError(undefined);
    setSwitchNote(undefined);
    setSettingsError(undefined);
    setChosen(undefined);
    setCollections(undefined);
    setCollectionId("");
    setEpoch((e) => e + 1);
  }, []);

  // ---- the one event stream: the library's state here, the queue's events passed on ----
  const noLibraryRef = useRef(false);
  noLibraryRef.current = noLibrary;
  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let opened = false;
    let known: string | undefined;
    const listen = async () => {
      try {
        const onOpen = () => {
          streamOpenings.current++;
          // FR-750 (R579): at each opening after the stream failed or dropped, without waiting for an event on it, what
          // has not been read is read again — a read that failed, or one still out that began before the stream last
          // failed (it may never settle). A read that succeeded, or one begun since, is not made again. (The first
          // opening at load, with the first reads still out or just failed, reads nothing more, as before.)
          const anew = streamDrops.current > 0;
          const stale = (m: { drops: number } | null) => anew && (!m || m.drops < streamDrops.current);
          const projectsAgain = !projectsRead_ok.current && stale(projectsRead.current);
          if (projectsAgain) readProjects({ restart: true });
          if (!screenRead_ok.current && stale(screenReading.current)) readScreen({ restart: true });
          // After a lost stream, what happened meanwhile is read.
          if (opened) {
            if (!projectsAgain) readProjects();
            emit({ kind: "refresh" });
          }
          opened = true;
        };
        for await (const ev of client.events({ signal: ac.signal, onOpen, openWithinMs: streamOpenMs, quietWithinMs: streamQuietMs })) {
          if (!alive.current) return;
          if (ev.type === "library.state" && ev.data && typeof ev.data === "object") {
            const d = ev.data as LibraryState;
            if (d.open === false) {
              known = undefined;
              forgetLibrary();
              setNoLibrary(true);
              continue;
            }
            if (d.libraryId && known !== undefined && d.libraryId !== known) {
              // Another library opened in its place, as on the Watched folders screen.
              known = d.libraryId;
              forgetLibrary();
              setNoLibrary(false);
              continue;
            }
            // The library is open, and nothing the screen read of it has succeeded (it was loaded while the service was
            // still reopening the library, say): everything is read again (R281 e). When something was read, only what
            // has not been read successfully is read again — the screen is not reset: dialogs, focus and what is typed
            // stay (R291 b).
            // FR-750: a read made again at this stream's opening (above) is about the library as it is now, so it is not
            // made a third time here: nothing read and both such reads out is not a reason to start afresh.
            const freshProjects = !!projectsRead.current && projectsRead.current.opening === streamOpenings.current;
            const freshScreen = !!screenReading.current && screenReading.current.opening === streamOpenings.current;
            const nothingRead = !projectsRead_ok.current && !screenRead_ok.current && !(freshProjects && freshScreen);
            const rereadMissing = () => {
              if (!projectsRead_ok.current && !freshProjects) readProjects();
              if (!screenRead_ok.current) readScreen();
            };
            if (d.libraryId && known === undefined) {
              known = d.libraryId;
              if (noLibraryRef.current || nothingRead) {
                forgetLibrary();
                setNoLibrary(false);
              } else rereadMissing();
              continue;
            }
            if (d.open === true && nothingRead) {
              forgetLibrary();
              setNoLibrary(false);
              continue;
            }
            // The same library: a project may have been locked, unlocked, created or removed, or the mode changed (M8).
            if (!screenRead_ok.current) readScreen();
            if (projectsRead_ok.current || !freshProjects) readProjects();
            emit({ kind: "refresh" });
            continue;
          }
          emit({ kind: "event", ev });
        }
      } catch {
        // the stream dropped: listen again shortly
      }
      if (!ac.signal.aborted) {
        streamDrops.current++;
        retry = setTimeout(() => void listen(), RECONNECT_MS);
      }
    };
    void listen();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, readProjects, readScreen, forgetLibrary, streamOpenMs, streamQuietMs]);

  const asked = projectInQuery(loc.search);
  // A project named in the address again (a link) takes over from the one chosen here.
  useEffect(() => setChosen(undefined), [asked]);
  const list = projects ?? [];
  const holds = (p: string | undefined): p is string => !!p && isValidId(p) && list.some((x) => x.id === p);
  const projectId =
    projects && remembered ? (holds(chosen) ? chosen : holds(asked) ? asked : holds(remembered.projectId) ? remembered.projectId : (list.find((p) => p.unlocked)?.id ?? list[0]?.id)) : undefined;
  const project = list.find((p) => p.id === projectId);
  // The project shown never changes without the researcher's act (R262 N3): once shown, it is pinned.
  useEffect(() => {
    if (projectId && chosen === undefined) setChosen(projectId);
  }, [projectId, chosen]);

  // N4: after a change of library, focus goes to the heading (never the page body).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstEpoch = useRef(true);
  useEffect(() => {
    if (firstEpoch.current) {
      firstEpoch.current = false;
      return;
    }
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected) headingRef.current?.focus();
  }, [epoch, noLibrary]);

  // The chosen project's collections; the remembered collection only if it is one of them.
  // R586 M3: a read that got no answer (or none in time) says so, with "Try again"; it leaves the collections unread
  // (not an empty list), so the remembered collection is still chosen when a later read answers.
  useEffect(() => {
    setCollections(undefined);
    setCollectionId("");
    setCollectionsError(undefined);
    setCollectionsUnreachable(false);
    if (!projectId) return;
    let live = true;
    const ac = new AbortController();
    readWithin((signal) => lib.collections.list(projectId, { signal }), firstReadMs, ac.signal).then(
      (r) => {
        if (!live) return;
        setCollections(r.collections);
        const want = confirmed.current.projectId === projectId ? confirmed.current.collectionId : undefined;
        if (want && r.collections.some((c) => c.id === want)) setCollectionId(want);
      },
      (err: unknown) => {
        if (!live) return;
        // An answer the screen handles (a locked project, say) leaves the list empty, as before; a read that got no
        // answer says so, with "Try again".
        if (!isUnreachable(err)) {
          setCollections([]);
          return;
        }
        setCollectionsError(sentenceOf(err, SERVICE_UNREACHABLE));
        setCollectionsUnreachable(true);
      },
    );
    return () => {
      live = false;
      ac.abort();
    };
  }, [lib, projectId, epoch, firstReadMs, collectionsTry]);

  /**
   * One PUT of the remembered settings, after those before it: built from the last CONFIRMED answer plus its own
   * change. On success that answer is the new confirmed one; on a failure the controls show the confirmed one (M2).
   */
  const put = (
    change: (base: FindScreenSettings) => FindScreenSettings,
    h: {
      done?: (s: FindScreenSettings) => void;
      failed: (err: unknown, timedOut: boolean) => void;
      /** R291 a: no answer in `timeoutMs` — run in place of `failed`, still in the order of the PUTs, before `always`. */
      noAnswer?: () => Promise<void>;
      always?: () => void;
    },
    timeoutMs?: number,
  ) => {
    const g = libGen.current;
    const run = async () => {
      if (!alive.current || g !== libGen.current) return;
      // R281 c: a PUT with no answer for `timeoutMs` is given up (aborted): the controls go back to what is confirmed.
      const ac = new AbortController();
      let timedOut = false;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      putTimers.current.add(timer);
      putAborts.current.add(ac);
      try {
        const s = await api.putScreen(change(confirmed.current), { signal: ac.signal });
        if (!alive.current || g !== libGen.current) return;
        confirmed.current = { ...s };
        screenUnread.current = false;
        setRemembered(s);
        h.done?.(s);
      } catch (err) {
        if (!alive.current || g !== libGen.current) return;
        clearTimeout(timer);
        putTimers.current.delete(timer);
        putAborts.current.delete(ac);
        if (timedOut && h.noAnswer) {
          await h.noAnswer();
          return;
        }
        setRemembered({ ...confirmed.current });
        h.failed(err, timedOut);
      } finally {
        clearTimeout(timer);
        putTimers.current.delete(timer);
        putAborts.current.delete(ac);
        if (alive.current && g === libGen.current) h.always?.();
      }
    };
    putChain.current = putChain.current.then(run, run);
  };

  /**
   * After a refused change of a select: the selects and the address show what the service last confirmed or, with
   * nothing confirmed, what was shown before the change (R262 N2).
   */
  const selectsBack = (before: { projectId: string | undefined; collectionId: string }) => {
    const c = confirmed.current;
    const pid = c.projectId && holds(c.projectId) ? c.projectId : before.projectId;
    setChosen(pid);
    navigate(findHref(pid), { replace: true });
    const cid = c.projectId === pid && c.collectionId ? c.collectionId : pid === before.projectId ? before.collectionId : "";
    setCollectionId(cid);
  };
  const rememberFailed = (before: { projectId: string | undefined; collectionId: string }) => (err: unknown) => {
    setSettingsError(`This computer could not remember the choice. ${sentenceOf(err, "")}`.trim());
    selectsBack(before);
  };

  const pickProject = (pid: string) => {
    if (!holds(pid) || pid === projectId) return;
    const before = { projectId, collectionId };
    setChosen(pid);
    setSettingsError(undefined);
    navigate(findHref(pid), { replace: true });
    put((b) => ({ checkEverything: b.checkEverything, projectId: pid }), { failed: rememberFailed(before) });
  };
  const pickCollection = (cid: string) => {
    const before = { projectId, collectionId };
    setCollectionId(cid);
    setSettingsError(undefined);
    const pid = projectId;
    put((b) => ({ checkEverything: b.checkEverything, ...(pid ? { projectId: pid } : {}), ...(cid ? { collectionId: cid } : {}) }), { failed: rememberFailed(before) });
  };

  useEffect(
    () => () => {
      for (const t of putTimers.current) clearTimeout(t);
    },
    [],
  );

  const confirmedCheck = remembered?.checkEverything ?? false;
  const shownCheck = checkSending ?? confirmedCheck;
  const toggle = () => {
    if (switchBusy.current || !remembered) return;
    switchBusy.current = true;
    const next = !shownCheck;
    const g = libGen.current;
    setCheckSending(next);
    setSwitchError(undefined);
    setSwitchNote(undefined);
    let resolve!: (r: SwitchResult) => void;
    const wait = { p: new Promise<SwitchResult>((r) => (resolve = r)), resolve: (r: SwitchResult) => resolve(r), taken: false };
    switchWait.current = wait;
    put(
      (b) => ({ ...b, checkEverything: next }),
      {
        done: () => {
          setSwitchVersion((v) => v + 1);
          wait.resolve({ outcome: "ok" });
        },
        // Refused: back to what the service stores, and why.
        failed: (err) => {
          setSwitchError(`“Check everything I have” could not be changed. ${sentenceOf(err, "")}`.trim());
          wait.resolve({ outcome: "failed" });
        },
        // R291 a: no answer in time — the change may have been stored. What the service holds is read before anything
        // else; the switch and "Add" stay busy until it answers.
        noAnswer: async () => {
          const before = confirmed.current.checkEverything;
          const r = await screenOnce(SWITCH_TIMEOUT_MS);
          if (r === "gone" || !alive.current || g !== libGen.current) return;
          if (r === "failed") {
            // The state for settings that cannot be read: the queue is read, and its answer says what is stored (M3).
            setSwitchVersion((v) => v + 1);
            wait.resolve({ outcome: "unknown" });
            return;
          }
          const on = confirmed.current.checkEverything;
          const note = switchReadText(on);
          setSwitchNote(note);
          if (on !== before) setSwitchVersion((v) => v + 1);
          const outcome: SwitchOutcome = on === next ? "ok" : "not-stored";
          // Said once: by a waiting add, at the head of its own result (one message, so neither replaces the other
          // unheard); else here.
          if (!wait.taken) emit({ kind: "say", words: [note] });
          wait.resolve({ outcome, note });
        },
        always: () => {
          switchBusy.current = false;
          setCheckSending(undefined);
          if (switchWait.current === wait) switchWait.current = null;
        },
      },
      SWITCH_TIMEOUT_MS,
    );
  };

  /** The queue's answer says what is stored; used only while the remembered settings could not be read (M3). */
  const onStoredCheck = useCallback((v: boolean) => {
    if (!screenUnread.current || confirmed.current.checkEverything === v) return;
    confirmed.current = { ...confirmed.current, checkEverything: v };
    setRemembered((r) => (r ? { ...r, checkEverything: v } : r));
  }, []);

  // ---- FR-750: "Try again" after a read that got no answer: what has not been read is read again ----
  const showTryAgain = (projectsUnreachable && !!projectsError) || (screenUnreachable && !!screenError) || (collectionsUnreachable && !!collectionsError);
  /** The queue's own read got no answer: its sentence (it says it itself unless the screen says one above). */
  const [queueNoAnswer, setQueueNoAnswer] = useState<string | undefined>();
  /**
   * R602 M1: one sentence at a time. Of the reads that got no answer, one that could not be made at all explains one that
   * got none in time: "could not be reached" is said alone where any failed so, "did not answer in time" where every one
   * was given up. Each such read's sentence is shown as this one (said once: equal sentences are not repeated).
   */
  const noAnswers = [projectsUnreachable && projectsError, screenUnreachable && screenError, collectionsUnreachable && collectionsError, showTryAgain && queueNoAnswer].filter((t): t is string => !!t);
  const noAnswerSaid = noAnswers.find((t) => t !== SERVICE_NO_ANSWER) ?? SERVICE_NO_ANSWER;
  const shownScreenError = screenUnreachable && screenError ? noAnswerSaid : screenError;
  const shownProjectsError = projectsUnreachable && projectsError ? noAnswerSaid : projectsError;
  const shownCollectionsError = collectionsUnreachable && collectionsError ? noAnswerSaid : collectionsError;
  const triedAgain = useRef(false);
  const tryAgain = () => {
    triedAgain.current = true;
    if (!projectsRead_ok.current || projectsUnreachable) readProjects();
    if (!screenRead_ok.current) readScreen();
    if (collectionsError) setCollectionsTry((n) => n + 1);
    // The queue's own read, when it got no answer either (its sentence may be said here only, FR-576).
    emit({ kind: "retry" });
  };
  // The button pressed has gone (everything was read): focus goes to the heading, never the page.
  useEffect(() => {
    if (showTryAgain || !triedAgain.current) return;
    triedAgain.current = false;
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected) headingRef.current?.focus();
  }, [showTryAgain]);

  if (noLibrary) {
    return (
      <main className="ao-page ao-find" aria-labelledby={`${ids}-h`}>
        <h1 id={`${ids}-h`} ref={headingRef} tabIndex={-1}>
          Find and acquire
        </h1>
        <p role="status">{FIND_SCREEN_TEXT.noLibrary}</p>
      </main>
    );
  }

  return (
    <main className="ao-page ao-find" aria-labelledby={`${ids}-h`}>
      <h1 id={`${ids}-h`} ref={headingRef} tabIndex={-1}>
        Find and acquire
      </h1>
      <div className="ao-find__bar">
        <label className="ao-find__field">
          Project
          <select value={projectId ?? ""} onChange={(e) => pickProject(e.target.value)} disabled={!projects?.length}>
            {!projectId && <option value="">{projects ? "No project" : "Reading the projects…"}</option>}
            {list.map((p) => (
              <option key={p.id} value={p.id} dir="auto">
                {/* An <option> holds no element: the name is isolated with U+2068 FIRST STRONG ISOLATE and U+2069 POP
                    DIRECTIONAL ISOLATE, so a right-to-left name does not flip " (locked)" (as R463 M7 does elsewhere). */}
                {p.unlocked ? p.name : `\u2068${p.name}\u2069 (locked)`}
              </option>
            ))}
          </select>
        </label>
        <label className="ao-find__field">
          Collection
          <select value={collectionId} onChange={(e) => pickCollection(e.target.value)} disabled={!projectId}>
            <option value="">(none)</option>
            {(collections ?? []).map((c) => (
              <option key={c.id} value={c.id} dir="auto">
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ao-find__switch">
          <input
            type="checkbox"
            role="switch"
            checked={shownCheck}
            aria-busy={checkSending !== undefined || undefined}
            aria-disabled={checkSending !== undefined || !remembered || undefined}
            aria-describedby={switchNote ? `${ids}-swnote` : undefined}
            onChange={toggle}
          />
          Check everything I have
        </label>
      </div>
      <p><a href={searchSourcesHref(projectId)} onClick={inAppLink}>Search sources</a></p>
      {switchNote && (
        <p id={`${ids}-swnote`} className="ao-find__note">
          {switchNote}
        </p>
      )}
      {shownScreenError && (
        <p role="alert" className="ao-error">
          <UserText>{shownScreenError}</UserText>
        </p>
      )}
      {switchError && (
        <p role="alert" className="ao-error">
          <UserText>{switchError}</UserText>
        </p>
      )}
      {settingsError && (
        <p role="alert" className="ao-error">
          <UserText>{settingsError}</UserText>
        </p>
      )}
      {/* The same sentence (the service cannot be reached) is said once, not for the settings and again for the projects. */}
      {shownProjectsError && shownProjectsError !== shownScreenError && (
        <p role="alert" className="ao-error">
          <UserText>{shownProjectsError}</UserText>
        </p>
      )}
      {shownCollectionsError && shownCollectionsError !== shownScreenError && shownCollectionsError !== shownProjectsError && (
        <p role="alert" className="ao-error">
          <UserText>{shownCollectionsError}</UserText>
        </p>
      )}
      {/* FR-750 (R579): a read that got no answer (or none in time) is offered again; an answer the screen handles is not. */}
      {showTryAgain && (
        <p>
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
        </p>
      )}
      {projects && remembered && !projectId && !projectsError && <p>{FIND_SCREEN_TEXT.noProject}</p>}
      {projectId && project && (
        <ProjectQueue
          key={`${epoch}\u0000${projectId}`}
          bus={bus}
          api={api}
          libApi={libApi}
          lib={lib}
          project={project}
          collectionId={collectionId}
          text={text}
          setText={setText}
          checkEverything={confirmedCheck}
          switchVersion={switchVersion}
          onStoredCheck={onStoredCheck}
          onUnlocked={readProjects}
          waitForSwitch={waitForSwitch}
          saidAbove={showTryAgain && queueNoAnswer ? queueNoAnswer : screenError}
          screenSays={showTryAgain}
          onNoAnswer={setQueueNoAnswer}
          firstReadMs={firstReadMs}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// One project's box and queue

interface Held {
  view: FindEntryView;
  /** Taken from a read (its start number) or an act's answer (its arrival number). */
  from: "read" | "act";
  n: number;
}

interface Meta {
  readOnly: boolean;
  stopped?: FindQueueResponse["stopped"];
  unreadableLines: number;
  lockedProjectsNotChecked: number;
}

/** The dialog open on a row: "Choose", or an author's two (their lists read from `options` when it opened). */
type DialogState =
  | { kind: "choose"; entry: FindEntryView; busy: boolean; busyAuthor?: boolean; error?: string | undefined; noAuthor?: boolean }
  | { kind: "person"; token: number; entry: FindEntryView; busy: boolean; busyAuthor?: boolean; error?: string | undefined; people?: FindPersonCandidate[]; loadError?: string }
  | { kind: "works"; token: number; entry: FindEntryView; busy: boolean; busyAuthor?: boolean; error?: string | undefined; works?: FindPersonWork[]; person?: FindChosenPerson; loadError?: string };

function LiveRegion({ said }: { said: Said }) {
  return (
    <p className="ao-visually-hidden" role="status" aria-live="polite" data-testid="find-live">
      {said.words.length > 0 && (
        <span key={said.n}>
          <WordsView words={said.words} />
        </span>
      )}
    </p>
  );
}

const Rows = memo(function Rows(props: {
  entries: FindEntryView[];
  places: Record<string, FindPlace>;
  busy: Record<string, FindActKind>;
  errors: Record<string, string>;
  notes: Record<string, LibraryNote>;
  readOnly: boolean;
  stopped: boolean;
  onAction: (a: FindAction) => void;
}) {
  const { entries, places, busy, errors, notes, readOnly, stopped, onAction } = props;
  /** A note about the window is shown while the row waits; one about how the start ended, until the next press. */
  const noteOf = (e: FindEntryView): string | undefined => {
    const n = notes[e.id];
    return n && (!n.whileWaiting || e.state === "waiting-sign-in") ? n.text : undefined;
  };
  // An entry made from an author's entry says where it came from (R271 M7): that entry's typed text, or null when gone.
  const typedOf = new Map(entries.map((e) => [e.id, e.typed] as const));
  const originOf = (e: FindEntryView): string | null | undefined => {
    if (typeof e.parentId !== "string") return undefined;
    const t = typedOf.get(e.parentId);
    return typeof t === "string" ? t : null;
  };
  return (
    <>
      {entries.map((e) => (
        <FindEntryRow key={e.id} entry={e} onAction={onAction} place={places[e.id]} busy={busy[e.id]} readOnly={readOnly} stopped={stopped} error={errors[e.id]} origin={originOf(e)} note={noteOf(e)} />
      ))}
    </>
  );
});

function ProjectQueue(props: {
  bus: QueueBus;
  api: FindApi;
  libApi: FindLibraryApi;
  lib: LibraryApi;
  project: ProjectSummary;
  collectionId: string;
  text: string;
  setText: (t: string) => void;
  checkEverything: boolean;
  switchVersion: number;
  /** The queue's answer says what is stored for the switch. */
  onStoredCheck: (v: boolean) => void;
  /** The project was unlocked here: the project list is read again. */
  onUnlocked: () => void;
  /** A change of "Check everything I have" still out: an add waits for it (R272 a). */
  waitForSwitch: () => Promise<SwitchResult> | undefined;
  /** FR-576: the sentence the screen already says above the queue (its settings could not be read), not said again. */
  saidAbove?: string | undefined;
  /** R602 M1: the queue's read got no answer (its sentence), or did again (undefined), so the screen says one sentence. */
  onNoAnswer?: (sentence: string | undefined) => void;
  /**
   * R609 N1: the screen says its one no-answer sentence (with its "Try again"): a no-answer of the queue's own is said by
   * it, so the queue never shows its own alert for it, not even before the screen has heard of it.
   */
  screenSays?: boolean;
  /** FR-750: how long a read of the queue asked for at once (at load, after the switch, an unlock, "Try again") is waited for. */
  firstReadMs: number;
}) {
  const { bus, api, libApi, lib, project, collectionId, text, setText, checkEverything, switchVersion, onStoredCheck, onUnlocked, waitForSwitch, saidAbove, onNoAnswer, screenSays, firstReadMs } = props;
  /** The desktop shell's bridge (F16); undefined outside the desktop app. */
  const shell = useMemo(() => desktopShell(), []);
  const projectId = project.id;
  const ids = useId();

  const [entries, setEntries] = useState<FindEntryView[] | undefined>();
  const [meta, setMeta] = useState<Meta | undefined>();
  const [locked, setLocked] = useState(false);
  /** The queue cannot be read at all (409): the service's sentence in its place. */
  const [unreadable, setUnreadable] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  /** FR-750: the last read failed for want of any answer (or of one in time): "Try again" is offered. */
  const [loadUnreachable, setLoadUnreachable] = useState(false);
  const loadUnreachableRef = useRef(false);
  loadUnreachableRef.current = loadUnreachable;
  /** The library cannot be reached (503 LIBRARY_OFFLINE): the service's sentence (R258 M4). */
  const [offline, setOffline] = useState<string | undefined>();
  const [busy, setBusyState] = useState<Record<string, FindActKind>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, LibraryNote>>({});
  const [places, setPlaces] = useState<Record<string, FindPlace>>({});
  const [dialog, setDialogState] = useState<DialogState | null>(null);
  const [openSource, setOpenSource] = useState<{ projectId: string; sourceId: string; from: HTMLElement | null } | null>(null);
  const [said, setSaid] = useState<Said>({ words: [], n: 0 });
  const [addBusy, setAddBusyState] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const [focusTarget, setFocusTarget] = useState<{ to: string; n: number; control?: string } | null>(null);
  const [focusUnlock, setFocusUnlock] = useState(0);
  const unlockRef = useRef<HTMLDivElement>(null);

  const alive = useRef(true);
  /** Moves on at a lock or when the library goes: every answer of the time before is dropped. */
  const gen = useRef(0);
  /** The order of what the screen took from the service (see the header). */
  const clock = useRef(0);
  const held = useRef(new Map<string, Held>());
  /** For each row, the number at which the screen last received an act's answer naming it (R262 N1). */
  const ackAt = useRef(new Map<string, number>());
  /** Entries known gone, with the number of what said so. */
  const gone = useRef(new Map<string, number>());
  const metaSeq = useRef(0);
  const firstRead = useRef(true);
  const busyRef = useRef<Record<string, FindActKind>>({});
  const acting = useRef(new Set<string>());
  const dialogRef = useRef<DialogState | null>(null);
  /** R272 b: until when the result of an act holds the status region (Date.now() time). */
  const actHold = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Rows whose change waits to be said (after the act's result, or after the dialog closes). */
  const pendingRows = useRef(new Set<string>());
  /** The result of an act made while a dialog was open (said when it closes). */
  const pendingAct = useRef<Words | null>(null);
  /** What was last said of each row: the same change is never said twice. */
  const lastSaid = useRef(new Map<string, string>());
  const stoppedRef = useRef(false);
  /** Each dialog opened on an author's entry: an answer of `options` for an earlier one is dropped. */
  const dialogToken = useRef(0);
  const soon = useRef<{ again: boolean } | null>(null);
  const addBusyRef = useRef(false);
  const placeKeys = useRef(new Map<string, string>());
  const placeQueue = useRef<Array<{ id: string; key: string }>>([]);
  const placeRunning = useRef(0);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastFocus = useRef<{ el: HTMLElement; entryId: string | undefined; entry?: FindEntryView | undefined } | null>(null);
  const sourceRef = useRef<HTMLElement>(null);
  /** The latest `readOnce`, for a fresh read asked from inside applyQueue. */
  const readOnceRef = useRef<() => Promise<void>>(async () => {});
  /** When the last coalesced read started (R258 M7). */
  const lastSoon = useRef(0);
  /**
   * R340 a, b: the ticket of the window this page opened, for the row that waits in it — in memory only, while it waits.
   * `handedOver`: the shell handed the file over (its ticket ended there; a later close is not a cancel). `seen`: the
   * row has been seen waiting — from then on its leaving the wait ends the ticket here (R342 a: the window is closed
   * unless the file was handed over). `after` (R356 b): the read clock when the shell said the window opened (after the
   * start's answer) — a read started later that shows the row not waiting ends the ticket too, seen or not; an older
   * read arriving late never does.
   */
  const libTicket = useRef<{ entryId: string; ticket: string; handedOver?: boolean; seen?: boolean; after?: number } | null>(null);
  /**
   * R342 a, d: tickets whose window this page closed (or gave up on) while the shell may still hold them — kept, in
   * memory only, until the shell reports that window closed, so that none of its events is taken for another row.
   */
  const endedTickets = useRef(new Set<string>());
  /** R342 d: this page has held a ticket since it was loaded (set at the first start's answer, never cleared). */
  const heldATicket = useRef(false);
  /** R342 b: a start waiting for the shell's next `closed` (any ticket or none). */
  const closedWaiters = useRef(new Set<() => void>());
  /** Rows whose file the shell handed over while the page held no ticket (loaded afresh): a later close is not a cancel. */
  const handedOverRows = useRef(new Set<string>());
  /** What each row's note last said (a note is said once; the same words again are not said again). */
  const notesRef = useRef<Record<string, LibraryNote>>({});

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setDialog = useCallback((d: DialogState | null | ((cur: DialogState | null) => DialogState | null)) => {
    dialogRef.current = typeof d === "function" ? d(dialogRef.current) : d;
    setDialogState(dialogRef.current);
  }, []);
  const setBusyFor = (id: string, kind: FindActKind | undefined) => {
    const next = { ...busyRef.current };
    if (kind) next[id] = kind;
    else delete next[id];
    busyRef.current = next;
    setBusyState(next);
  };
  const setErrorFor = (id: string, msg: string | undefined) =>
    setErrors((cur) => {
      if (!msg && !(id in cur)) return cur;
      const next = { ...cur };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });

  const speak = useCallback((words: Words) => setSaid((x) => ({ words, n: x.n + 1 })), []);
  /** Where an entry made from an author's entry came from (R281 a): that entry's typed text, null when gone. */
  const originOf = useCallback((v: FindEntryView): string | null | undefined => {
    if (typeof v.parentId !== "string") return undefined;
    const t = held.current.get(v.parentId)?.view.typed;
    return typeof t === "string" ? t : null;
  }, []);
  const saidFor = (v: FindEntryView) => saidOf(v, !!meta?.stopped, originOf(v));

  /**
   * Rows' changes waiting to be said: each row's state AS SHOWN NOW (never an older one), unless it is what was last
   * said of that row. Nothing while a dialog is open (the page is inert) or while the result of an act holds the region
   * (R272 b): they are said when it closes, or when the act's result has stood for ACT_SAID_MS.
   */
  const flushRows = useCallback(() => {
    if (dialogRef.current || Date.now() < actHold.current) return;
    const ids = [...pendingRows.current];
    pendingRows.current.clear();
    const fresh: Words[] = [];
    for (const id of ids) {
      const v = held.current.get(id)?.view;
      if (!v) continue;
      const w = saidOf(v, stoppedRef.current, originOf(v));
      const t = wordsText(w);
      if (lastSaid.current.get(id) === t) continue;
      lastSaid.current.set(id, t);
      fresh.push(w);
    }
    if (fresh.length === 0) return;
    if (fresh.length <= ROWS_SAID_MAX) speak(fresh.flatMap((w, i) => (i > 0 ? [" ", ...w] : w)));
    else speak([`${fresh.length} entries in the queue changed.`]);
  }, [speak, originOf]);

  /**
   * The result of the researcher's own act (R272 b): said first, and it holds the region for ACT_SAID_MS; then the rows'
   * changes that arrived meanwhile. While a dialog is open it waits for it to close. `rowId`: the row the words are about.
   */
  const sayAct = useCallback(
    (words: Words, rowId?: string) => {
      if (rowId) {
        lastSaid.current.set(rowId, wordsText(words));
        pendingRows.current.delete(rowId);
      }
      if (dialogRef.current) {
        pendingAct.current = words;
        return;
      }
      speak(words);
      actHold.current = Date.now() + ACT_SAID_MS;
      clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => {
        if (alive.current) flushRows();
      }, ACT_SAID_MS);
    },
    [speak, flushRows],
  );

  /** Rows whose shown state changed (a read): said now, or after the act's result or the dialog. */
  const sayRows = useCallback(
    (ids: string[]) => {
      for (const id of ids) pendingRows.current.add(id);
      flushRows();
    },
    [flushRows],
  );

  useEffect(() => {
    if (dialog) return;
    const w = pendingAct.current;
    if (w) {
      pendingAct.current = null;
      sayAct(w);
      return;
    }
    flushRows();
  }, [dialog, sayAct, flushRows]);
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  const commit = useCallback(() => {
    setEntries([...held.current.values()].map((h) => h.view).sort(byCreated));
  }, []);

  // ---- where a match in another project is: asked at request time, never stored, a few at a time ----
  const pumpPlaces = useCallback(() => {
    while (placeRunning.current < PLACE_CONCURRENCY && placeQueue.current.length) {
      const job = placeQueue.current.shift()!;
      if (placeKeys.current.get(job.id) !== job.key) continue;
      placeRunning.current++;
      const g = gen.current;
      api
        .elsewhere(projectId, job.id)
        .then(
          (r) => {
            if (!alive.current || g !== gen.current || placeKeys.current.get(job.id) !== job.key) return;
            setPlaces((cur) => ({ ...cur, [job.id]: r ? { status: "known", projectName: r.projectName } : { status: "locked" } }));
          },
          () => {},
        )
        .finally(() => {
          placeRunning.current--;
          if (alive.current) pumpPlaces();
        });
    }
  }, [api, projectId]);
  const askPlaces = useCallback(
    (views: FindEntryView[], force = false) => {
      for (const e of views) {
        if (!isElsewhere(e)) continue;
        const key = `${e.updatedAt}\u0000${e.state}`;
        if (!force && placeKeys.current.get(e.id) === key) continue;
        placeKeys.current.set(e.id, key);
        placeQueue.current.push({ id: e.id, key });
      }
      pumpPlaces();
    },
    [pumpPlaces],
  );

  /**
   * Keeps one version of an entry. A read that started after the last act's answer naming the row (or for a row no act
   * named) is taken as it is, the later-started read winning; otherwise the SERVICE's stamp (`updatedAt`) decides, equal
   * stamps taking what came in except a read started before the read that gave what is shown (R262 N1, R263).
   * True when what is shown changed.
   */
  const keep = useCallback((v: FindEntryView, from: Held["from"], n: number): boolean => {
    const cur = held.current.get(v.id);
    if (cur) {
      const ack = ackAt.current.get(v.id);
      if (from === "read" && (ack === undefined || n > ack)) {
        // A read for a row no act's answer ever named, or one started after the last such answer, is taken as it is
        // whatever the stamps say; of two such reads the later-started wins (R263).
        if (cur.from === "read" && n < cur.n) return false;
      } else {
        const o = stampOrder(v, cur.view);
        if (o < 0) return false;
        if (o === 0 && from === "read" && cur.from === "read" && n < cur.n) return false;
      }
      const unchanged = same(cur.view, v);
      held.current.set(v.id, { view: unchanged ? cur.view : v, from, n });
      return !unchanged;
    }
    held.current.set(v.id, { view: v, from, n });
    return true;
  }, []);

  /** One entry from an act's answer: kept if the service stamped it no earlier than what is shown. Returns the entry shown. */
  const takeOne = useCallback(
    (v: FindEntryView): { shown: FindEntryView; changed: boolean } => {
      const n = ++clock.current;
      ackAt.current.set(v.id, n);
      if (gone.current.get(v.id) === Infinity) return { shown: v, changed: false };
      gone.current.delete(v.id);
      const before = held.current.get(v.id)?.view;
      keep(v, "act", n);
      const shown = held.current.get(v.id)!.view;
      commit();
      askPlaces([shown]);
      const changed = !before || wordsText(stateWords(before)) !== wordsText(stateWords(shown));
      return { shown, changed };
    },
    [commit, askPlaces, keep],
  );

  /** A whole queue, read from `start`: it replaces or drops only what was taken from something older. */
  const applyQueue = useCallback(
    (r: FindQueueResponse, start: number) => {
      const before = new Map([...held.current].map(([id, h]) => [id, h.view] as const));
      const present = new Set<string>();
      for (const v of r.entries) {
        if (!v || typeof v !== "object" || typeof v.id !== "string") continue;
        present.add(v.id);
        if ((gone.current.get(v.id) ?? -1) >= start) continue;
        gone.current.delete(v.id);
        keep(v, "read", start);
      }
      // A row missing from this read goes only if the read started after the last act's answer naming it (and after
      // the read that last gave it); otherwise it stays and one fresh read is made at once (R262 N1).
      let fresh = false;
      for (const [id, h] of [...held.current]) {
        if (present.has(id) || (h.from === "read" && h.n > start)) continue;
        if (start > (ackAt.current.get(id) ?? -1)) {
          held.current.delete(id);
          gone.current.set(id, start);
        } else fresh = true;
      }
      if (start > metaSeq.current) {
        metaSeq.current = start;
        setMeta({ readOnly: r.readOnly, ...(r.stopped ? { stopped: r.stopped } : {}), unreadableLines: r.unreadableLines, lockedProjectsNotChecked: r.lockedProjectsNotChecked });
        if (typeof r.checkEverything === "boolean") onStoredCheck(r.checkEverything);
        setOffline(undefined);
        setUnreadable(undefined);
        setLoadError(undefined);
        setLoadUnreachable(false);
        setLocked(false);
      }
      commit();
      const now = [...held.current.values()].map((h) => h.view);
      askPlaces(now);
      if (fresh) void readOnceRef.current();
      // A row's change of state is said; several at once are counted, not each one.
      if (firstRead.current) {
        firstRead.current = false;
        return;
      }
      const changed = now.filter((v) => {
        const b = before.get(v.id);
        return b && b !== v && wordsText(stateWords(b)) !== wordsText(stateWords(v)) && !acting.current.has(v.id);
      });
      stoppedRef.current = !!r.stopped;
      if (changed.length > 0) sayRows(changed.map((v) => v.id));
    },
    [commit, askPlaces, sayRows, onStoredCheck, keep],
  );

  const markLocked = useCallback(() => {
    gen.current++;
    soon.current = null;
    held.current.clear();
    gone.current.clear();
    placeKeys.current.clear();
    placeQueue.current = [];
    setDialog(null);
    setOpenSource(null);
    setEntries(undefined);
    setLocked(true);
  }, [setDialog]);

  /** One read of the queue (it may overlap another; the numbers keep the order). A read cancelled by `signal` changes nothing. */
  const readOnce = useCallback(async (signal?: AbortSignal, limitMs?: number): Promise<void> => {
    const start = ++clock.current;
    const g = gen.current;
    try {
      const r = limitMs === undefined ? await api.queue(projectId, signal ? { signal } : {}) : await readWithin((s) => api.queue(projectId, { signal: s }), limitMs, signal);
      if (!alive.current || g !== gen.current || signal?.aborted) return;
      applyQueue(r, start);
    } catch (err) {
      if (!alive.current || g !== gen.current || signal?.aborted || start < metaSeq.current) return;
      metaSeq.current = start;
      if (isProjectLocked(err)) {
        markLocked();
        return;
      }
      if (err instanceof ApiClientError && err.status === 409 && err.reason === "queue-unreadable") {
        held.current.clear();
        setEntries(undefined);
        setUnreadable(err.message);
        return;
      }
      if (err instanceof ApiClientError && err.code === "LIBRARY_OFFLINE") {
        setOffline(sentenceOf(err, FIND_SCREEN_TEXT.noLibrary));
        return;
      }
      setLoadError(sentenceOf(err, "The queue could not be read."));
      setLoadUnreachable(isUnreachable(err));
    }
  }, [api, projectId, applyQueue, markLocked]);

  readOnceRef.current = readOnce;
  // R602 M1: the queue's read that got no answer is told to the screen, which then says one sentence for all.
  const reportNoAnswer = useRef(onNoAnswer);
  reportNoAnswer.current = onNoAnswer;
  const noAnswerHere = loadUnreachable && loadError && !entries?.length ? loadError : undefined;
  // Told before the page is painted (R609 N1), so the screen's one sentence is right when it is first seen.
  useLayoutEffect(() => reportNoAnswer.current?.(noAnswerHere), [noAnswerHere]);
  useEffect(() => () => reportNoAnswer.current?.(undefined), []);
  /**
   * One read, waited for at most QUEUE_READ_WAIT_MS (FR-558). A read given up then is cancelled (R472), so that reads
   * that never answer do not pile up against the web view's few connections to the service; the next read shows what
   * it would have.
   */
  const readWaited = useCallback(async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = new AbortController();
    try {
      await Promise.race([
        readOnce(cancel.signal),
        new Promise<void>((r) => {
          timer = setTimeout(() => {
            cancel.abort();
            r();
          }, QUEUE_READ_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, [readOnce]);
  // FR-750: a read asked for at once is given up after `firstReadMs` (a read that never settles would leave "Reading the queue…").
  const readNow = useCallback(() => void readOnce(undefined, firstReadMs), [readOnce, firstReadMs]);
  /**
   * A read asked for by an event (or after an act), coalesced: it starts EVENT_COALESCE_MS after the first ask (asks
   * meanwhile join it), and asks while it is out make ONE more read after it — however many asks. While asks keep
   * coming, reads start at least READ_GAP_MS apart (R258 M7); the last ask is always followed by a read.
   */
  const readSoon = useCallback(() => {
    if (soon.current) {
      soon.current.again = true;
      return;
    }
    const mark = { again: false };
    soon.current = mark;
    const g = gen.current;
    void (async () => {
      try {
        do {
          const wait = Math.max(EVENT_COALESCE_MS, lastSoon.current + READ_GAP_MS - Date.now());
          await new Promise((r) => setTimeout(r, wait));
          if (!alive.current || g !== gen.current || soon.current !== mark) return;
          mark.again = false;
          lastSoon.current = Date.now();
          await readWaited();
        } while (mark.again && alive.current && g === gen.current && soon.current === mark);
      } finally {
        if (soon.current === mark) soon.current = null;
      }
    })();
  }, [readWaited]);

  // ---- at load, and when the switch changed: read now (where matches elsewhere are is asked again) ----
  const firstSwitch = useRef(true);
  useEffect(() => {
    if (firstSwitch.current) {
      firstSwitch.current = false;
      readNow();
      return;
    }
    placeKeys.current.clear();
    readNow();
  }, [readNow, switchVersion]);

  // ---- live updates: the screen's one stream passes on the queue's events and asks to read again ----
  useEffect(
    () =>
      bus.subscribe((sig) => {
        if (!alive.current) return;
        if (sig.kind === "say") sayAct(sig.words);
        else if (sig.kind === "retry") {
          if (loadUnreachableRef.current) readNow();
        } else if (sig.kind === "refresh" || findProgressOf(sig.ev, projectId)) readSoon();
      }),
    [bus, projectId, readSoon, readNow, sayAct],
  );
  useEffect(() => {
    if (openSource) sourceRef.current?.focus();
  }, [openSource]);

  // ---- focus ----
  useEffect(() => {
    if (focusUnlock > 0) unlockRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [focusUnlock]);
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.to === "box") {
      boxRef.current?.focus();
      return;
    }
    const rowEl = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focusTarget.to)}"]`);
    const control = focusTarget.control ? rowEl?.querySelector<HTMLElement>(`button[data-act="${CSS.escape(focusTarget.control)}"]:not([disabled])`) : null;
    (control ?? rowEl?.querySelector<HTMLElement>("[data-entry-text]"))?.focus();
  }, [focusTarget]);
  // When the control the researcher used has gone, focus goes to its row's next control (else its text, else the box).
  useEffect(() => {
    const lf = lastFocus.current;
    const now = document.activeElement;
    if (!lf || lf.el.isConnected || (now && now !== document.body && now.isConnected)) return;
    const rowEl = lf.entryId ? listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(lf.entryId)}"]`) : null;
    let target = rowEl?.querySelector<HTMLElement>(".ao-find__actions button:not([disabled])") ?? rowEl?.querySelector<HTMLElement>("[data-entry-text]") ?? null;
    if (!target && !rowEl && lf.entry) {
      // The row itself has gone (removed elsewhere while a dialog was open on it): the next row, in the queue's order.
      const gone = lf.entry;
      const next = [...held.current.values()].map((h) => h.view).sort(byCreated).find((v) => byCreated(v, gone) > 0);
      if (next) target = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(next.id)}"] [data-entry-text]`) ?? null;
    }
    (target ?? boxRef.current)?.focus();
  });
  const noteFocus = (e: FocusEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const inDialog = el.closest('[role="dialog"]');
    const entryId = inDialog ? dialogRef.current?.entry.id : el.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
    const entry = inDialog ? dialogRef.current?.entry : entryId ? held.current.get(entryId)?.view : undefined;
    lastFocus.current = { el, entryId, entry };
  };

  // ---- acts ----
  const readOnly = !!meta?.readOnly;
  const boxDisabled = readOnly || locked || !!unreadable || !!offline;

  /** A refusal of an act: locked → the unlock; gone or changed → the queue again. */
  const refused = (err: unknown): boolean => {
    if (isProjectLocked(err)) {
      markLocked();
      return true;
    }
    if (err instanceof ApiClientError && (err.status === 404 || err.status === 409)) readSoon();
    return false;
  };

  const run = async (e: FindEntryView, kind: FindActKind, call: () => Promise<FindEntryView>) => {
    if (busyRef.current[e.id] || readOnly) return;
    setBusyFor(e.id, kind);
    acting.current.add(e.id);
    setErrorFor(e.id, undefined);
    const g = gen.current;
    try {
      const v = await call();
      if (!alive.current || g !== gen.current) return;
      const t = takeOne(v);
      if (t.changed) sayAct(saidFor(t.shown), e.id);
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setErrorFor(e.id, sentenceOf(err, "That could not be done. Try again."));
    } finally {
      acting.current.delete(e.id);
      if (alive.current) setBusyFor(e.id, undefined);
    }
  };

  const remove = async (e: FindEntryView) => {
    if (busyRef.current[e.id] || readOnly) return;
    setBusyFor(e.id, "remove");
    setErrorFor(e.id, undefined);
    const g = gen.current;
    try {
      await api.remove(projectId, e.id);
      if (!alive.current || g !== gen.current) return;
      const order = [...held.current.values()].map((h) => h.view).sort(byCreated);
      const i = order.findIndex((x) => x.id === e.id);
      const next = order[i + 1] ?? order[i - 1];
      held.current.delete(e.id);
      gone.current.set(e.id, Infinity);
      commit();
      lastSaid.current.delete(e.id);
      pendingRows.current.delete(e.id);
      sayAct(["Removed ", ...entryLabel(e, originOf(e)), " from the queue."]);
      setFocusTarget((f) => ({ to: next && next.id !== e.id ? next.id : "box", n: (f?.n ?? 0) + 1 }));
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setErrorFor(e.id, sentenceOf(err, "That could not be removed. Try again."));
    } finally {
      if (alive.current) setBusyFor(e.id, undefined);
    }
  };

  const openThere = async (e: FindEntryView, from: HTMLElement | null) => {
    if (busyRef.current[e.id]) return;
    setBusyFor(e.id, "open-there");
    const g = gen.current;
    try {
      // Where it is is asked afresh at the press (it is never stored): locked meanwhile, it says so.
      const r = await api.elsewhere(projectId, e.id);
      if (!alive.current || g !== gen.current) return;
      setPlaces((cur) => ({ ...cur, [e.id]: r ? { status: "known", projectName: r.projectName } : { status: "locked" } }));
      if (r) setOpenSource({ projectId: r.projectId, sourceId: r.sourceId, from });
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setErrorFor(e.id, sentenceOf(err, "That could not be opened. Try again."));
    } finally {
      if (alive.current) setBusyFor(e.id, undefined);
    }
  };

  // ---- through the researcher's library (R340): every step a press on that row ----

  /** A row's note: shown on the row, and said once — words the row already shows are not said again. */
  const setNoteFor = (id: string, n: LibraryNote | undefined) => {
    const before = notesRef.current[id];
    const next = { ...notesRef.current };
    if (n) next[id] = n;
    else delete next[id];
    notesRef.current = next;
    setNotes(next);
    if (!n || before?.text === n.text) return;
    const v = held.current.get(id)?.view;
    sayAct([...(v ? [...entryLabel(v, originOf(v)), ": "] : []), n.text]);
  };
  /** The page no longer follows the window of this row (the shell ended its ticket): the ticket is forgotten. */
  const endTicketOf = (id: string) => {
    if (libTicket.current?.entryId === id) libTicket.current = null;
  };
  /**
   * R342 a: the page ends the window it opened for `ticket` — closed once, and the ticket kept as ended until the shell
   * reports the close (its events are then no row's).
   */
  const endWindow = (ticket: string) => {
    if (libTicket.current?.ticket === ticket) libTicket.current = null;
    if (endedTickets.current.has(ticket)) return;
    endedTickets.current.add(ticket);
    // R477 b: the close carries the ticket of the open that made the window, so it never closes a newer one.
    if (shell) void shellWithin(shell.closeLibraryWindow(ticket));
  };
  // The ticket is held only while its row waits. Once the row was seen waiting and no longer does (the service returned
  // it: the ticket's end, a lock, a save of the rules), or it is gone (removed here), the window is closed — unless the
  // shell handed the file over, which ended the ticket there (R342 a). R356 b: a row never seen waiting is left alone
  // only until a read started after the window opened shows it: if that read shows it not waiting, the same holds.
  useEffect(() => {
    const t = libTicket.current;
    if (!t) return;
    const h = held.current.get(t.entryId);
    const v = h?.view;
    if (v?.state === "waiting-sign-in") {
      t.seen = true;
      return;
    }
    if (v && !t.seen && !(t.after !== undefined && h!.from === "read" && h!.n > t.after)) return;
    if (t.handedOver) endTicketOf(t.entryId);
    else endWindow(t.ticket);
  });

  /** R342 b: true when the shell reports a window closed (any ticket or none) within `ms`, false otherwise. */
  const nextClosed = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        closedWaiters.current.delete(heard);
        resolve(v);
      };
      const heard = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      closedWaiters.current.add(heard);
    });

  /**
   * The shell asked to open the sign-in window for `ticket`; true when it did. R342 b: refused (exactly `false`) — a
   * window left over from before holds the shell's one ticket — the page closes that window, waits for the shell to
   * report it closed (at most LIBRARY_CLOSE_WAIT_MS) and asks ONCE more, all within the same press. R342 a: an open the
   * page gave up on (no answer in time) may still be carried out by the shell: its ticket is ended here, and if the
   * shell then answers that it opened the window, the window is closed.
   */
  const openWindow = async (ticket: string, address: string, from: LibraryWindowFrom, live: () => boolean): Promise<boolean> => {
    if (!shell) return false;
    const ask = async (): Promise<boolean | "refused"> => {
      const p = shell.openLibraryWindow(ticket, address, from);
      const r = await shellWithin(p);
      if (r === "gave-up") {
        endedTickets.current.add(ticket);
        if (libTicket.current?.ticket === ticket) libTicket.current = null;
        p.then(
          (late) => {
            // FR-561 (R472, R477 b): the shell is the guard — the close carries THIS open's ticket, and the shell closes
            // a sign-in window only on behalf of the open that made it, so a late answer never ends a newer window's
            // wait (one started here, after the screen was left and opened again, or by "Test" on Your library). The
            // page keeps no second guard of its own: one would only keep this open's window standing whenever the page
            // held a newer ticket, and the shell refuses the close for an older ticket by itself.
            if (late === true) void shellWithin(shell.closeLibraryWindow(ticket));
          },
          () => {},
        );
        return false;
      }
      return r === true ? true : r === false ? "refused" : false;
    };
    const first = await ask();
    if (first !== "refused") return first;
    if (!live()) return false;
    const closed = nextClosed(LIBRARY_CLOSE_WAIT_MS);
    // The leftover's ticket is not the page's to know: this close carries none (R477 b).
    void shellWithin(shell.closeLibraryWindow());
    if (!(await closed) || !live()) return false;
    return (await ask()) === true;
  };

  /**
   * "Get through my library" — and, F18c (R345), "Open it here and fetch the PDF" on one of the row's links (`how`):
   * ONE start at the service (the library's, or the link's with that link); with its answer, the sign-in window opened
   * by the shell. The ticket and the address live only in this press's variables and the one call to the shell (the
   * ticket also in `libTicket` while the row waits). A window that did not open leaves nothing waiting: the start is
   * cancelled (the one cancel route serves both kinds).
   */
  const startWindow = async (e: FindEntryView, how: StartHow) => {
    // R342 i: outside the desktop app a press says why, once, and asks nothing.
    if (!shell) {
      sayAct([FIND_TEXT.onlyDesktop]);
      return;
    }
    if (busyRef.current[e.id] || readOnly) return;
    setBusyFor(e.id, how.kind);
    acting.current.add(e.id);
    setErrorFor(e.id, undefined);
    setNoteFor(e.id, undefined);
    handedOverRows.current.delete(e.id);
    const g = gen.current;
    const live = () => alive.current && g === gen.current;
    try {
      let got: Partial<FindLibraryStartResponse> | FindBrowserStartResponse;
      try {
        got = how.kind === "link" ? await libApi.linkStart(projectId, e.id, how.url) : how.kind === "browser" ? await libApi.browserStart(projectId, e.id) : await libApi.start(projectId, e.id);
      } catch (err) {
        if (!live() || refused(err)) return;
        setErrorFor(e.id, sentenceOf(err, "That could not be done. Try again."));
        return;
      }
      const address = typeof got?.url === "string" ? got.url : "";
      let ticket = "";
      let opened = false;
      if (how.kind === "browser") {
        // R348 c, h: the browser's start gives the page no ticket, so it holds none — `heldATicket` and `libTicket` are
        // the window's, and stay as they were (no window event can then be taken for this row). The screen left (or the
        // library changed) meanwhile: the browser is not opened, and the start is cancelled below.
        if (live() && address) opened = (await shellWithin(shell.openInBrowser(address))) === true;
      } else {
        // R342 d: from the first start's answer on, this page has held a ticket.
        heldATicket.current = true;
        ticket = "ticket" in got && typeof got.ticket === "string" ? got.ticket : "";
        // The screen was left (or the library changed) meanwhile: no window is opened, and the start is cancelled below.
        if (live() && ticket && address) {
          libTicket.current = { entryId: e.id, ticket };
          opened = await openWindow(ticket, address, how.kind, live);
          if (opened && !live()) {
            // FR-734 (2), R503 i: the row left the screen (the screen was left, the project or the library changed)
            // while the shell was opening the window; the window the shell then opened is nobody's here, so it is
            // closed — with THIS open's ticket, so that the shell never closes a newer window (R477 b, R489).
            endedTickets.current.add(ticket);
            if (libTicket.current?.ticket === ticket) libTicket.current = null;
            void shellWithin(shell.closeLibraryWindow(ticket));
            // R510 I1: and the start is cancelled at the service, as for a window that did not open (below, also when
            // the screen is gone): otherwise the runner's one sign-in ticket stays held and every start is refused.
            opened = false;
          }
          // R356 b: from here on, a read started now or later is one asked after the start's answer.
          if (opened && libTicket.current?.ticket === ticket) libTicket.current.after = clock.current;
        }
      }
      if (opened) {
        // R342 c: the focus goes to the row's own words — never onto a control that acts (the start's control goes).
        const at = document.activeElement;
        const rowEl = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(e.id)}"]`);
        if (!at || at === document.body || rowEl?.contains(at)) rowEl?.querySelector<HTMLElement>("[data-entry-state]")?.focus();
        // The start's answer is no view of the entry: the control stays busy until the queue is read again, so a second
        // press of a double click finds the row waiting and sends nothing.
        // The row's change that read shows is said as any row's change is.
        acting.current.delete(e.id);
        if (live()) await readWaited();
        return;
      }
      // Not opened (refused twice, failed, or no answer in time): the page forgets the ticket, and the entry goes back.
      if (ticket && libTicket.current?.ticket === ticket) libTicket.current = null;
      try {
        const back = await libApi.cancel(projectId, e.id);
        if (!live()) return;
        const t = takeOne(back);
        setNoteFor(e.id, { text: how.kind === "browser" ? FIND_TEXT.browserNotOpened : FIND_TEXT.windowNotOpened, whileWaiting: false });
        if (t.changed) sayRows([e.id]);
        readSoon();
      } catch (err) {
        // The cancel itself failed: the row shows what the service then says of the entry.
        if (!live() || refused(err)) return;
        readSoon();
        // R356 c: the browser did not open and its wait is still there — the row says so, and its "Cancel" ends it (the
        // note goes when the row leaves the wait). Not when the service says the entry no longer waits, or is gone.
        const ended = err instanceof ApiClientError && (err.status === 404 || (err.status === 409 && err.reason === "entry-state"));
        if (how.kind === "browser" && !ended) setNoteFor(e.id, { text: FIND_TEXT.browserNotOpenedStillWaiting, whileWaiting: true });
      }
    } finally {
      acting.current.delete(e.id);
      if (alive.current) setBusyFor(e.id, undefined);
    }
  };

  /** "Add the PDF showing in the sign-in window": the shell's take (what came of it, the shell's events say). */
  const takePdf = async (e: FindEntryView) => {
    // R342 i: outside the desktop app a press says why, once, and asks nothing.
    if (!shell) {
      sayAct([FIND_TEXT.onlyDesktop]);
      return;
    }
    if (busyRef.current[e.id] || readOnly) return;
    setBusyFor(e.id, "library-take");
    setErrorFor(e.id, undefined);
    setNoteFor(e.id, undefined);
    const r = await shellWithin(shell.libraryWindowTakePdf());
    if (!alive.current) return;
    setBusyFor(e.id, undefined);
    if (r === "gave-up") setNoteFor(e.id, { text: FIND_TEXT.appSilent, whileWaiting: true });
  };

  /** "Cancel": the service's cancel; when it has answered, the window is closed. */
  const cancelLibrary = async (e: FindEntryView) => {
    if (busyRef.current[e.id] || readOnly) return;
    setBusyFor(e.id, "library-cancel");
    acting.current.add(e.id);
    setErrorFor(e.id, undefined);
    const g = gen.current;
    // The window this page opened for the row is ended as R342 a says (closed once); one it did not open (a page loaded
    // afresh) is closed as before. R348 h: a row waiting in the researcher's own browser has no window — none is closed
    // (a window open now is another's: a leftover, or the settings screen's Test).
    const inBrowser = waitsInBrowser(e);
    const closeWindow = () => {
      if (inBrowser) return;
      const t = libTicket.current;
      if (t?.entryId === e.id) endWindow(t.ticket);
      else if (shell) void shellWithin(shell.closeLibraryWindow());
    };
    try {
      const v = await libApi.cancel(projectId, e.id);
      if (!alive.current || g !== gen.current) return;
      setNoteFor(e.id, undefined);
      const t = takeOne(v);
      if (t.changed) sayAct(saidFor(t.shown), e.id);
      closeWindow();
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setErrorFor(e.id, sentenceOf(err, "That could not be done. Try again."));
      // It no longer waits (its file is being checked, or it went back): the window has nothing left to do.
      if (err instanceof ApiClientError && err.status === 409 && err.reason === "entry-state") closeWindow();
    } finally {
      acting.current.delete(e.id);
      if (alive.current) setBusyFor(e.id, undefined);
    }
  };

  /** The window was closed while the entry still waits: the start is cancelled, so that the entry returns. */
  const windowClosed = async (v: FindEntryView) => {
    const g = gen.current;
    setNoteFor(v.id, { text: FIND_TEXT.windowClosed, whileWaiting: false });
    try {
      const back = await libApi.cancel(projectId, v.id);
      if (!alive.current || g !== gen.current) return;
      if (takeOne(back).changed) sayRows([v.id]);
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      if (isProjectLocked(err)) {
        markLocked();
        return;
      }
      readSoon();
      // R342 i: only "the entry is no longer waiting" is not an error (the file is being checked); any other refusal is
      // shown on the row as the service says it.
      if (!(err instanceof ApiClientError && err.status === 409 && err.reason === "entry-state")) setErrorFor(v.id, sentenceOf(err, "That could not be done. Try again."));
    }
  };

  /**
   * The shell's `library-window` events: only this page's window's, or — on a page that has held no ticket since it was
   * loaded (R342 d) — the one waiting row's. An event of a ticket this page ended is no row's (its close is noted).
   */
  const onWindowRef = useRef<(ev: LibraryWindowEvent) => void>(() => {});
  onWindowRef.current = (ev: LibraryWindowEvent) => {
    if (ev.state === "closed") for (const w of [...closedWaiters.current]) w();
    if (ev.ticket !== null && endedTickets.current.has(ev.ticket)) {
      if (ev.state === "closed") endedTickets.current.delete(ev.ticket);
      return;
    }
    const mine = libTicket.current;
    let id: string;
    if (mine) {
      // After the hand-over the shell's ticket has ended: the window's close then comes without one.
      if (ev.ticket === mine.ticket || (mine.handedOver && ev.ticket === null && ev.state === "closed")) id = mine.entryId;
      else return;
    } else {
      if (heldATicket.current) return;
      // R348 h: a row waiting in the researcher's own browser is never the window's row.
      const waitingNow = [...held.current.values()].map((h) => h.view).filter((v) => v.state === "waiting-sign-in" && !waitsInBrowser(v));
      if (waitingNow.length !== 1) return;
      id = waitingNow[0]!.id;
    }
    const v = held.current.get(id)?.view;
    // R348 h: and no window event counts for a row the service says waits in the browser (the page's own ticket's row
    // that now waits there could only be a later start's: its window has nothing to do with it).
    if (!v || ev.state === "opened" || waitsInBrowser(v)) return;
    if (ev.state === "closed") {
      const handed = !!mine?.handedOver || handedOverRows.current.has(id);
      if (mine) endTicketOf(id);
      handedOverRows.current.delete(id);
      // Not handed over: the start is cancelled. R342 f: an event with the page's own ticket counts for its row even
      // before a read shows the row waiting; a row taken without a ticket is the one that waits. (The former second
      // condition — the row shown waiting — could no longer be false here, and is out: R342 j.)
      if (!handed) void windowClosed(v);
      return;
    }
    const text = windowSentence(ev, v);
    if (!text) return;
    if (ev.state === "handed-over") {
      if (mine) libTicket.current = { ...mine, handedOver: true };
      else handedOverRows.current.add(id);
      readSoon();
    }
    setNoteFor(id, { text, whileWaiting: true });
  };
  useEffect(() => {
    if (!shell) return;
    let on = true;
    let stop: (() => void) | undefined;
    void shell
      .onLibraryWindow((ev) => {
        if (on && alive.current) onWindowRef.current(ev);
      })
      .then((s) => {
        if (on) stop = s;
        else s();
      });
    return () => {
      on = false;
      stop?.();
    };
  }, [shell]);

  // Stable for the memoised rows: reads what it needs from refs and the latest closure.
  const actRef = useRef<(a: FindAction) => void>(() => {});
  actRef.current = (a: FindAction) => {
    const e = a.entry;
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    switch (a.kind) {
      case "choose":
        if (readOnly || dialogRef.current || busyRef.current[e.id]) return;
        setDialog({ kind: "choose", entry: e, busy: false });
        return;
      case "choose-person":
        openAuthorDialog("person", e);
        return;
      case "choose-works":
        openAuthorDialog("works", e);
        return;
      case "open": {
        const sid = e.state === "record-complete" ? e.sourceId : (e.duplicateOf ?? e.sourceId);
        if (sid) setOpenSource({ projectId, sourceId: sid, from });
        return;
      }
      case "open-there":
        void openThere(e, from);
        return;
      case "add-here":
        void run(e, "add-here", () => api.addHere(projectId, e.id));
        return;
      case "same":
        void run(e, "same", () => api.duplicate(projectId, e.id, true));
        return;
      case "different":
        void run(e, "different", () => api.duplicate(projectId, e.id, false));
        return;
      case "retry":
        void run(e, "retry", () => api.retry(projectId, e.id));
        return;
      case "get-copy":
        void run(e, "get-copy", () => api.getCopy(projectId, e.id));
        return;
      case "remove":
        void remove(e);
        return;
      case "library":
        void startWindow(e, { kind: "library" });
        return;
      case "link":
        // F18c (R345): the link pressed, as the row's "Where to get it" parsed it from the view.
        if (typeof a.url === "string" && a.url) void startWindow(e, { kind: "link", url: a.url });
        return;
      case "browser":
        // F20c (R348 h): the same press, in the researcher's own browser.
        void startWindow(e, { kind: "browser" });
        return;
      case "library-take":
        void takePdf(e);
        return;
      case "library-cancel":
        void cancelLibrary(e);
        return;
    }
  };
  const onAction = useCallback((a: FindAction) => actRef.current(a), []);

  /**
   * An author's dialog: opened at once (it says the list is being read), its list read from the entry's `options`
   * (R267 b) — never from the queue's answer, never kept after it closes. A read that fails, or an entry that no longer
   * holds that list, is the service's sentence in the dialog; nothing else changes.
   */
  /**
   * A locked project met in a dialog (R281 b): the dialog closes with the rows, and focus goes to what the screen now
   * offers — the unlock's field — never the page.
   */
  const lockedInDialog = () => {
    markLocked();
    setFocusUnlock((n) => n + 1);
  };

  /** The list of an author's dialog (`token`), read from `options`; an answer for an earlier dialog is dropped (M4). */
  const loadOptions = (kind: "person" | "works", token: number, e: FindEntryView) => {
    const g = gen.current;
    const mine = (cur: DialogState | null): cur is Extract<DialogState, { kind: "person" | "works" }> => !!cur && cur.kind === kind && "token" in cur && cur.token === token;
    api.options(projectId, e.id).then(
      (r) => {
        if (!alive.current || g !== gen.current) return;
        setDialog((cur) => {
          if (!mine(cur)) return cur;
          const o = r && typeof r === "object" ? r : {};
          if (cur.kind === "person") return Array.isArray(o.people) ? { ...cur, people: o.people } : { ...cur, loadError: FIND_ROUTE_TEXT.entryState };
          if (!Array.isArray(o.works)) return { ...cur, loadError: FIND_ROUTE_TEXT.entryState };
          return { ...cur, works: o.works, ...(o.person && typeof o.person === "object" ? { person: o.person } : {}) };
        });
      },
      (err: unknown) => {
        if (!alive.current || g !== gen.current) return;
        if (isProjectLocked(err)) {
          if (mine(dialogRef.current)) lockedInDialog();
          return;
        }
        setDialog((cur) => (mine(cur) ? { ...cur, loadError: sentenceOf(err, FIND_SCREEN_TEXT.optionsUnreadable) } : cur));
        if (err instanceof ApiClientError && (err.status === 404 || err.status === 409)) readSoon();
      },
    );
  };

  /**
   * An author's dialog: opened at once (it says the list is being read), its list read from the entry's `options`
   * (R267 b) — never from the queue's answer, never kept after it closes. A read that fails, or an entry that no longer
   * holds that list, is the service's sentence in the dialog; nothing else changes.
   */
  const openAuthorDialog = (kind: "person" | "works", e: FindEntryView) => {
    if (readOnly || dialogRef.current || busyRef.current[e.id]) return;
    const token = ++dialogToken.current;
    setDialog({ kind, token, entry: e, busy: false });
    loadOptions(kind, token, e);
  };

  /**
   * An act pressed in a dialog: one request; its answer takes its place in the order like any act's (R262, R263). A
   * refusal is the service's sentence in the dialog and nothing changes; a locked project closes it and offers the unlock.
   */
  const dialogAct = async <T,>(kind: DialogState["kind"], call: (e: FindEntryView) => Promise<T>, done: (r: T, e: FindEntryView) => void, fallback: string, author = false) => {
    const d = dialogRef.current;
    if (!d || d.kind !== kind || d.busy || readOnly) return;
    const e = d.entry;
    setDialog({ ...d, busy: true, busyAuthor: author, error: undefined });
    acting.current.add(e.id);
    const g = gen.current;
    try {
      const r = await call(e);
      if (!alive.current || g !== gen.current) return;
      done(r, e);
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      if (isProjectLocked(err)) {
        lockedInDialog();
        return;
      }
      // The service's sentence, in the dialog; nothing is changed here — except that after "This entry has no author to
      // show." the dialog no longer offers the author (R291 d).
      const noAuthor = kind === "choose" && err instanceof ApiClientError && err.reason === "no-author";
      setDialog((cur) => (cur && cur.kind === kind ? { ...cur, busy: false, busyAuthor: false, error: sentenceOf(err, fallback), ...(noAuthor ? { noAuthor: true } : {}) } : cur));
      // "Already added" (M6): the works' marks are read again, so the dialog shows what the queue now holds.
      const cur = dialogRef.current;
      if (cur?.kind === "works" && err instanceof ApiClientError && err.reason === "already-added") loadOptions("works", cur.token, cur.entry);
      if (err instanceof ApiClientError && (err.status === 404 || err.status === 409)) readSoon();
    } finally {
      acting.current.delete(e.id);
    }
  };

  const choose = (candidateId: string | null) =>
    dialogAct(
      "choose",
      (e) => api.choose(projectId, e.id, candidateId),
      (v, e) => {
        const t = takeOne(v);
        setDialog(null);
        if (t.changed) sayAct(saidFor(t.shown), e.id);
      },
      "The choice could not be made. Try again.",
    );

  /**
   * "Show this author's works" (R279 d): the entry is turned into the author's flow; its answer ("choose-person", or
   * "looking-up" then "choose-works") takes its place like any act's. Focus: the row's next control, else its text.
   */
  const showAuthor = () =>
    dialogAct(
      "choose",
      (e) => api.author(projectId, e.id),
      (v, e) => {
        const t = takeOne(v);
        setDialog(null);
        if (t.changed) sayAct(saidFor(t.shown), e.id);
      },
      "That could not be done. Try again.",
      true,
    );

  /** "This is the person": answered at once with the entry "looking-up"; "Choose works" follows by an event. */
  const choosePerson = (personId: string) =>
    dialogAct(
      "person",
      (e) => api.person(projectId, e.id, personId),
      (v, e) => {
        const t = takeOne(v);
        setDialog(null);
        if (t.changed) sayAct(saidFor(t.shown), e.id);
      },
      "The choice could not be made. Try again.",
    );

  /** "Add the chosen works": an entry for each, and the author's entry as it now is; focus back on its "Choose works". */
  const chooseWorks = (workIds: string[]) =>
    dialogAct(
      "works",
      (e) => api.works(projectId, e.id, workIds),
      (r, e) => {
        const made = Array.isArray(r?.added) ? r.added.filter((v) => v && typeof v === "object" && typeof v.id === "string") : [];
        for (const v of made) takeOne(v);
        if (r?.entry && typeof r.entry === "object" && typeof r.entry.id === "string") takeOne(r.entry);
        setDialog(null);
        sayAct([addedWorksText(made.length)]);
        setFocusTarget((f) => ({ to: e.id, control: "choose-works", n: (f?.n ?? 0) + 1 }));
      },
      "The works could not be added. Try again.",
    );

  // ---- adding ----
  const submit = async () => {
    if (addBusyRef.current || boxDisabled) return;
    const kept = text
      .split(/\r\n|\r|\n/)
      .map((line, i) => ({ line, at: i + 1 }))
      .filter((x) => x.line.trim() !== "");
    if (kept.length === 0) return;
    addBusyRef.current = true;
    setAddBusyState(true);
    setAddError(undefined);
    const g = gen.current;
    // R272 a: a change of "Check everything I have" still out — the add waits for it, and is not sent if it fails (the
    // service must hold the switch's new position before a reference is judged). The box stays read-only meanwhile.
    const pendingSwitch = waitForSwitch();
    /** R291 a: what the service holds, read after a change with no answer: said at the head of this add's result. */
    let switchLead: string | undefined;
    const lead = (w: string): Words => [switchLead ? `${switchLead} ${w}` : w];
    if (pendingSwitch) {
      const { outcome, note } = await pendingSwitch;
      if (outcome === "ok" && note) switchLead = note;
      if (!alive.current) return;
      if (g !== gen.current || outcome !== "ok") {
        addBusyRef.current = false;
        setAddBusyState(false);
        if (g === gen.current) {
          // Not sent; the text kept; why, beside the box and once in the status region (R272 a, R281 c, R291 a) — after
          // a change with no answer, with what the service holds first.
          const why = outcome === "failed" ? FIND_SCREEN_TEXT.addSwitchFailed : FIND_SCREEN_TEXT.addSwitchNoAnswer;
          setAddError(why);
          sayAct([outcome === "not-stored" && note ? `${note} ${why}` : why]);
          boxRef.current?.focus();
        }
        return;
      }
    }
    // No answer within ADD_TIMEOUT_MS: the add is given up, the text kept, and the queue read (R262 N5 b).
    const ac = new AbortController();
    let timedOut = false;
    let lockedNow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, ADD_TIMEOUT_MS);
    try {
      const r = await api.add(projectId, { lines: kept.map((k) => k.line), ...(collectionId ? { collectionId } : {}) }, { signal: ac.signal });
      if (!alive.current || g !== gen.current) return;
      for (const v of r.added) takeOne(v);
      // The box was read-only while the add was out, so it holds exactly what was sent (R258 I2).
      setText("");
      boxRef.current?.focus();
      sayAct(lead(addedText(r)));
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      if (timedOut) {
        sayAct(lead(FIND_SCREEN_TEXT.addTimedOut));
        setAddError(FIND_SCREEN_TEXT.addTimedOut);
        readNow();
        return;
      }
      if (switchLead) sayAct([switchLead]);
      if (isProjectLocked(err)) {
        lockedNow = true;
        markLocked();
        // Focus goes to what the screen now offers: the unlock's field (R262 N5 a).
        setFocusUnlock((n) => n + 1);
        return;
      }
      let msg = sentenceOf(err, "The references could not be added.");
      // The service counts the lines it was sent; blank lines were not sent, so say which line of the box it is.
      const m = err instanceof ApiClientError && err.reason === "line" ? /^Line (\d+) /.exec(err.message) : null;
      const at = m ? kept[Number(m[1]) - 1]?.at : undefined;
      if (m && at !== undefined && at !== Number(m[1])) msg = `${msg} Empty lines are not counted: that is line ${at} in the box.`;
      setAddError(msg);
      if (err instanceof ApiClientError && err.code === "READ_ONLY") readSoon();
    } finally {
      clearTimeout(timer);
      addBusyRef.current = false;
      if (alive.current) {
        setAddBusyState(false);
        if (!lockedNow) boxRef.current?.focus();
      }
    }
  };
  const onBoxKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  /** Cancel or Escape: closed without a request (not while its act is out); its lists go with it. */
  const closeDialog = () => {
    if (!dialogRef.current?.busy) setDialog(null);
  };

  // ---- the page ----
  const stopped = meta?.stopped;
  const reasonId = `${ids}-reason`;
  const reasonText = locked ? FIND_ROUTE_TEXT.locked : unreadable ? unreadable : offline ? offline : readOnly ? (stopped?.text ?? FIND_ROUTE_TEXT.readOnly) : undefined;
  const describedBy = [`${ids}-hint`, boxDisabled && reasonText ? reasonId : undefined, addError ? `${ids}-adderr` : undefined].filter(Boolean).join(" ");
  const showLocked = checkEverything && !!meta && meta.lockedProjectsNotChecked > 0 && !locked && !unreadable;
  /** The sentence above the queue: why nothing runs now (once), unless it is the box's reason already. */
  const stoppedLine = stopped && !locked && !unreadable && !offline ? stopped.text : undefined;
  /** Read-only: the service's stopped sentence is the box's reason too, said once. */
  const reasonIsStopped = readOnly && !!stoppedLine;

  return (
    <div className="ao-find__project" onFocus={noteFocus}>
      <section aria-labelledby={`${ids}-add`} className="ao-find__add">
        <h2 id={`${ids}-add`} className="ao-visually-hidden">
          Add references
        </h2>
        <label htmlFor={`${ids}-box`} className="ao-find__label">
          References
        </label>
        <textarea
          id={`${ids}-box`}
          ref={boxRef}
          rows={4}
          dir="auto"
          className="ao-find__box"
          value={text}
          disabled={boxDisabled}
          readOnly={addBusy}
          aria-busy={addBusy || undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            if (!addBusyRef.current) setText(e.target.value);
          }}
          onKeyDown={onBoxKey}
        />
        <p id={`${ids}-hint`} className="ao-muted">
          {FIND_SCREEN_TEXT.hint}
        </p>
        {addError && (
          <p id={`${ids}-adderr`} role="alert" className="ao-error">
            <UserText>{addError}</UserText>
          </p>
        )}
        <p>
          <button type="button" disabled={boxDisabled} aria-disabled={addBusy || undefined} aria-busy={addBusy || undefined} onClick={() => void submit()}>
            {addBusy ? "Adding…" : "Add"}
          </button>
        </p>
      </section>

      <LiveRegion said={said} />

      {reasonText && boxDisabled && !reasonIsStopped && (
        <p id={reasonId} className="ao-find__note">
          <UserText>{reasonText}</UserText>
        </p>
      )}
      {showLocked && <p className="ao-find__note">{lockedCountText(meta.lockedProjectsNotChecked)}</p>}
      {stoppedLine && (
        <p {...(reasonIsStopped ? { id: reasonId } : {})} className="ao-find__note">
          <UserText>{stoppedLine}</UserText>
        </p>
      )}
      {meta && meta.unreadableLines > 0 && !unreadable && <p className="ao-find__note">{unreadableText(meta.unreadableLines)}</p>}

      {locked && (
        <div ref={unlockRef}>
        <UnlockProject
          api={lib}
          project={project}
          onUnlocked={() => {
            setLocked(false);
            readNow();
            onUnlocked();
          }}
        />
        </div>
      )}

      <h2 id={`${ids}-queue`}>Queue</h2>
      {/* FR-576: the same sentence (the service cannot be reached) is said once, not by the screen and again here. */}
      {loadError && loadError !== saidAbove && !entries?.length && !(loadUnreachable && screenSays) && (
        <>
          <p role="alert" className="ao-error">
            <UserText>{loadError}</UserText>
          </p>
          {/* FR-750 (R579): a read that got no answer (or none in time) is offered again. */}
          {loadUnreachable && (
            <p>
              <button type="button" onClick={readNow}>
                Try again
              </button>
            </p>
          )}
        </>
      )}
      {!locked && !unreadable && !offline && (
        <>
          {!entries && !loadError && <p>{FIND_SCREEN_TEXT.loading}</p>}
          <ul ref={listRef} className="ao-find__queue" aria-labelledby={`${ids}-queue`} data-count={entries?.length ?? 0}>
            {entries && <Rows entries={entries} places={places} busy={busy} errors={errors} notes={notes} readOnly={readOnly} stopped={!!stopped} onAction={onAction} />}
          </ul>
          {entries && entries.length === 0 && <p>{FIND_SCREEN_TEXT.empty}</p>}
        </>
      )}

      {openSource && (
        <section tabIndex={-1} aria-label="Record" className="ao-find__source" ref={sourceRef}>
          <SourceDetail
            api={lib}
            projectId={openSource.projectId}
            sourceId={openSource.sourceId}
            readOnly={readOnly || openSource.projectId !== projectId}
            onLocked={() => (openSource.projectId === projectId ? markLocked() : setOpenSource(null))}
            onClose={() => {
              const from = openSource.from;
              setOpenSource(null);
              if (from?.isConnected) from.focus();
            }}
          />
        </section>
      )}

      {dialog?.kind === "choose" && (
        <ChooseWorkDialog
          entry={dialog.entry}
          busy={dialog.busy}
          {...(dialog.error ? { error: dialog.error } : {})}
          onChoose={(id) => void choose(id)}
          {...(authorOfferOf(dialog.entry) && !dialog.noAuthor ? { onShowAuthor: () => void showAuthor(), busyAuthor: !!dialog.busyAuthor } : {})}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "person" && (
        <ChoosePersonDialog
          entry={dialog.entry}
          {...(dialog.people ? { people: dialog.people } : {})}
          {...(dialog.loadError ? { loadError: dialog.loadError } : {})}
          busy={dialog.busy}
          {...(dialog.error ? { error: dialog.error } : {})}
          onChoose={(personId) => void choosePerson(personId)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "works" && (
        <ChooseWorksDialog
          entry={dialog.entry}
          {...(dialog.works ? { works: dialog.works } : {})}
          {...(dialog.person ? { person: dialog.person } : {})}
          {...(dialog.loadError ? { loadError: dialog.loadError } : {})}
          busy={dialog.busy}
          {...(dialog.error ? { error: dialog.error } : {})}
          onAdd={(ids) => void chooseWorks(ids)}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
