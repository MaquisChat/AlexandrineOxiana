/**
 * The import review queue (spec 5.4): items an import could not identify with confidence. The
 * selected item is shown next to its candidate matches; per item: Accept, Edit, Merge, Skip, Keep
 * both (and accept one of the candidates); for a selection: Set type, Add tag, Move to collection.
 * Every review request names the project in its body (R97).
 *
 * The preview is the record's details and its files' names, and the file under review where it is
 * a picture (FilePreview: the service's picture route, shown through a blob: address, R135 1).
 *
 * In projects that pseudonymise names, titles taken from file names, and collections and tags the
 * batch made from folder names, are flagged (R64): they can carry participants' names. What the
 * batch made is what the service reports it created (BatchSummary.created, R118).
 *
 * The list shows the titles the service sends with the items (R118); a record is fetched for the
 * item shown, and — as a fallback for items sent without a title — for those items, a pool of
 * SOURCE_POOL requests at a time, the shown item first (R115 I4). The records loaded are kept in a
 * small store outside React state that each row reads for itself, so an answer re-renders only the
 * rows it changes, not the whole queue (a queue of thousands would otherwise be rebuilt per answer).
 *
 * Without a batch it is the project's whole queue (Task 67, R172): every pending entry of every kind,
 * read a page at a time, grouped so a person can tell them apart — by import, "Added by hand" (drag
 * and drop), "From captures", "After a consent withdrawal" — and, opened from a library row's badge,
 * only that source's entries. Each entry is decided by the library's own decision for its kind: an
 * import entry (with or without a batch) as in a batch's queue; a capture's conflicting field by
 * choosing a value through the source screen's own badge and confirm (FieldCheck, R149). A locked
 * project's entries are neither listed nor decided, and nothing about them is shown; answers for
 * another project, after a lock or after the screen closed are dropped.
 *
 * "Files found for records" (Find and acquire, F11; R296, R301, R303): every file found for a record is held in the
 * project and waits for the researcher, the app's check only advice. Each waiting file is shown in full in its own
 * place — the record it was found for (title, creators, year), the entry's own sentence (`reasons[0]`), what the app's
 * check says (HELD_FILE_WHY_TEXT) and the file's facts, all outside text through UserText — with its own "Use this
 * file" and "Not this file": one request per press, one file per request; nothing decides several files at once
 * (R303 a). The files that look right are gathered first ("Files that look right (N)"), the others after them ("Other
 * files found (N)"); a group with no file is not shown. One file's decision under way leaves the others usable.
 * R319: nothing moves under the pointer — a decided file keeps its card in its place, saying what was decided, without
 * controls; files that arrive are counted on a line and come in only by "Show them". After a decision focus goes to
 * the next waiting card's heading (R313 a), else to the section's heading, or to the message that nothing is waiting.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import { ApiClientError, type ApiClient } from "../../api/client";
import {
  importApi,
  type BatchSummary,
  type Candidate,
  type Collection,
  type Creator,
  type ImportPolicy,
  type ReviewDecision,
  type ReviewGroup,
  type ReviewItem,
  type ReviewLookUp,
  type ReviewLookUpOutcome,
  type ReviewPatch,
  type SourceFile,
  type SourceListItem,
  type Tag,
} from "../../api/import";
import {
  HELD_FILE_WHY_TEXT,
  LOOKUP_WAITING_TEXT,
  LOOK_UP_AGAIN_TEXT,
  PROJECT_REVIEW_PAGE_MAX,
  lookUpAgainAfter,
  lookUpGaveUpText,
  reviewGroup,
  type HeldFileDecision,
  type HeldFileRefusalReason,
  type HeldFileDecisionRequest,
  type HeldFileDecisionResponse,
  type ReviewHeldFile,
} from "@ao/shared";
import { isProjectLocked, libraryApi } from "../../api/library";
import { verificationApi, type FieldReview } from "../../api/verification";
import { yearOf } from "../../api/find";
import { CodeSwatch } from "../../components/CodeSwatch";
import { readerApi, heldFileRanges, type ReaderApi } from "../../api/reader";
import { DialogShell } from "../../components/ReasonDialog";
import { UserText } from "../../components/UserText";
import { FieldCheck } from "../../components/VerificationBadge";
import { inAppLink, PATHS } from "../../navigation";
import { ReaderScreen, type LookOnly } from "../Reader";
import { FIELD_LABELS } from "../SourceDetail";
import { UnlockProject } from "../UnlockProject";
import { assetName, FilePreview, NO_PREVIEW } from "./FilePreview";
import { count, ErrorNote, errorText, fmt, reportHref, Section, SOURCE_TYPES, typeLabel } from "./shared";
import {
  PRESS_SHOWN_TEXT,
  PRESS_SHOWN_TEXT_ENTRY,
  pressVerdict,
  usePointing,
  usePressGuard,
  useQuiet,
  type GuardedHandlers,
  type Pointing,
  type PressCheck,
  type PressNotice,
} from "./pressGuard";
import "./import.css";

export { DECIDE_SETTLE_MS, PRESS_PLACE_TOLERANCE_PX, PRESS_SHOWN_TEXT, PRESS_SHOWN_TEXT_ENTRY, SCROLL_SETTLE_MS, type PressCheck, type PressNotice } from "./pressGuard";

/** Batch kinds whose collections are made from folder names. */
const FOLDER_KINDS = new Set(["folder", "zip", "device"]);

const titleOf = (sf: SourceFile | undefined): string => {
  const v = sf?.source.title.variants;
  return (v?.find((x) => x.kind === "original") ?? v?.[0])?.value ?? "";
};

const creatorName = (c: Creator): string => c.literal ?? [c.given, c.family].filter(Boolean).join(" ");

const creatorsText = (cs: Creator[]): string => cs.map(creatorName).filter(Boolean).join("; ");

/** The title came from the file name (field evidence, or the identification method). */
export function titleFromFileName(item: ReviewItem, sf: SourceFile | undefined): boolean {
  if (item.method?.startsWith("filename")) return true;
  return !!sf?.fieldEvidence.some((e) => e.field === "/title" && e.source.kind === "filename");
}

/** The source records loaded so far, by source id; a change tells only its readers (useRecord). */
interface RecordStore {
  get(sid: string | undefined): SourceFile | undefined;
  /** Moves on with every change (read by a list that names many records at once). */
  version(): number;
  set(entries: Iterable<[string, SourceFile]>): void;
  subscribe(listener: () => void): () => void;
}

function recordStore(): RecordStore {
  const map = new Map<string, SourceFile>();
  const listeners = new Set<() => void>();
  let v = 0;
  return {
    get: (sid) => (sid ? map.get(sid) : undefined),
    version: () => v,
    set(entries) {
      v++;
      for (const [k, val] of entries) map.set(k, val);
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** One source's record; the component re-renders when that record changes, and only then. */
function useRecord(store: RecordStore, sid: string | undefined): SourceFile | undefined {
  return useSyncExternalStore(store.subscribe, () => store.get(sid));
}

export interface ReviewQueueProps {
  client: ApiClient;
  projectId: string;
  /** One import's items; without it, the project's whole queue (Task 67). */
  batchId?: string;
  /** The project's queue, only this source's entries (opened from a library row's badge). */
  sourceId?: string;
  /** Entries per page of the project's queue (tests shorten it). */
  pageSize?: number;
}

/** Source requests in flight at once (R115 I4). */
export const SOURCE_POOL = 6;


/** R313 e: a decision on a waiting file with no answer in this long is given up (its late answer only reads the queue again). */
export const HELD_DECISION_TIMEOUT_MS = 60_000;
/** R313 e: said on the card when a decision was given up. */
export const HELD_NO_ANSWER_TEXT = "The service did not answer. Look at the queue again before deciding.";
/**
 * R470 b (FR-490): looking at a held file before deciding — the card's control, the line the look-only reader shows, and
 * what it says when the held file cannot be shown (R487 c: one sentence true of a file no longer waiting and of one gone
 * from disk while its entry still waits — the route's one "not found" answers both).
 */
export const LOOK_TEXT = "Look at the file";
export const LOOK_ONLY_NOTICE = "This file has not been added to your library. Use this file, or Not this file, in the review queue.";
export const LOOK_GONE = "This file can no longer be shown. It is no longer waiting for your decision, or it can no longer be found on this computer.";

/** R487 a: the focus target that means a card's own "Look at the file" (followed by the card's id). */
const LOOK_BACK = "look:";

/** What a look at held file `reviewId` reads with: the reader's calls (none made in a look) and the file's own ranges. */
type LookFor = (reviewId: string) => { api: ReaderApi; range: LookOnly["range"] };

/** A waiting file's two controls: their words at rest, and while that decision is out (R318 a). */
export const HELD_DECIDE_WORDS: Readonly<Record<HeldFileDecision, { idle: string; working: string }>> = {
  attach: { idle: "Use this file", working: "Using this file…" },
  discard: { idle: "Not this file", working: "Removing this file…" },
};

/** What became of a file decided in this visit (R319 a, b): attached, discarded, or found already decided. */
type FileEnd = HeldFileDecision | "already";
/** R319: the found files' section as laid out — its cards in their places — and what became of those decided here. */
interface FileLayout {
  items: HeldItem[];
  ended: Readonly<Record<string, FileEnd>>;
}

/** Entries per page when the project's whole queue is read. */
export const PROJECT_PAGE = 500;

/**
 * What the batch made from folder names (R64): the collections and tags it reports it created (R118). The warning fails
 * closed (FR-157) once the list of imports is known: an entry from a batch not in it, or from a folder batch that reports
 * nothing of what it created (an older service), has every collection and tag flagged. Until the list is known (still
 * being read, or refused, as in a read-only library) nothing is flagged, never every entry (R463 M1).
 */
function madeByBatch(id: string, batchId: string | undefined, batch: BatchSummary | undefined, known: boolean): FolderFlag {
  if (!batchId || !known) return false;
  if (!batch) return "unrecorded";
  if (!FOLDER_KINDS.has(batch.kind)) return false;
  if (!batch.created) return "unrecorded";
  return batch.created.collectionIds.includes(id) || batch.created.tagIds.includes(id) ? "made" : false;
}

/**
 * Why a collection or tag is flagged (R465 a): "made", the import reports it made it from a folder name; "unrecorded",
 * the app has no record of what the import made (an older import, or one the screen cannot find), so it may have.
 */
type FolderFlag = "made" | "unrecorded" | false;

/** The strongest flag among these ids: "made" is said for those; otherwise the hedged sentence. */
const folderFlagOf = (ids: readonly string[], flag: (id: string) => FolderFlag): FolderFlag => {
  const flags = ids.map(flag);
  return flags.includes("made") ? "made" : flags.includes("unrecorded") ? "unrecorded" : false;
};

/** The group an entry is listed under in the project's queue. */
/** The group an entry is listed under: the service's, from the library's cause (R176 3); never guessed here from fields. */
const groupOf = (i: ReviewItem): ReviewGroup => i.group ?? reviewGroup(i);

const GROUP_TITLES: Record<Exclude<ReviewGroup, "import">, string> = {
  attach: "Added by hand",
  capture: "From captures",
  "found-file": "Files found for records",
  withdrawal: "After a consent withdrawal",
};

/** An entry of the project's queue as the service sends it, with what the check found about a held file (F11). */
type HeldItem = ReviewItem & { heldFile?: ReviewHeldFile };

/** A waiting file is listed in its own section, not in the list beside the panel (R303 b). */
const isFound = (i: ReviewItem): boolean => groupOf(i) === "found-file";
/** The app's check says the file looks right (R296 b): advice only — it still waits for the researcher. */
const looksRight = (i: ReviewItem): boolean => (i as HeldItem).heldFile?.why === "looks-right";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/**
 * Decision 31 (c): the service's named time as the researcher reads times — their own time zone and their own format
 * (the browser's locale, as the pairing screen writes a time), with the date, since the time may be on another day.
 */
const lookUpTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** What the polite region says after a look-up: the state's own sentence (R577 4), or the button's "after {time}". */
function lookUpSaid(outcome: ReviewLookUpOutcome, lookUp: ReviewLookUp | undefined): string {
  if (outcome.kind === "not-yet") return lookUpAgainAfter(lookUpTime(outcome.notBefore));
  switch (lookUp?.state) {
    case "waiting":
      return LOOKUP_WAITING_TEXT;
    case "found":
      return LOOK_UP_AGAIN_TEXT.found;
    case "nothing":
      return LOOK_UP_AGAIN_TEXT.nothing;
    case "not-allowed":
      return LOOK_UP_AGAIN_TEXT.notAllowed;
    case "gave-up":
      return lookUpGaveUpText(lookUp.tries);
    case "failed":
      return LOOK_UP_AGAIN_TEXT.notLookedUpFailed;
    default:
      return "";
  }
}

function importTitle(batchId: string | undefined, batches: BatchSummary[]): string {
  const b = batches.find((x) => x.batchId === batchId);
  if (!b) return "An import";
  const when = Number.isNaN(Date.parse(b.startedAt)) ? "" : `, ${DATE.format(new Date(b.startedAt))}`;
  return `Import ${fmt(b.number)} — ${b.kind}${when}`;
}

interface Group {
  key: string;
  title: string;
  items: Array<{ item: ReviewItem; n: number }>;
}

/** The project's entries in groups: each import (in the order first seen), then by hand, captures, withdrawals. */
function groupsOf(items: ReviewItem[], batches: BatchSummary[]): Group[] {
  const imports = new Map<string, Group>();
  const rest: Record<Exclude<ReviewGroup, "import">, Group> = {
    attach: { key: "attach", title: GROUP_TITLES.attach, items: [] },
    capture: { key: "capture", title: GROUP_TITLES.capture, items: [] },
    "found-file": { key: "found-file", title: GROUP_TITLES["found-file"], items: [] },
    withdrawal: { key: "withdrawal", title: GROUP_TITLES.withdrawal, items: [] },
  };
  items.forEach((item, at) => {
    const g = groupOf(item);
    if (g === "import") {
      const key = `import:${item.batchId ?? ""}`;
      let grp = imports.get(key);
      if (!grp) imports.set(key, (grp = { key, title: importTitle(item.batchId, batches), items: [] }));
      grp.items.push({ item, n: at + 1 });
    } else rest[g].items.push({ item, n: at + 1 });
  });
  return [...imports.values(), rest.attach, rest.capture, rest["found-file"], rest.withdrawal].filter((g) => g.items.length > 0);
}

export function ReviewQueue({ client, projectId, batchId, sourceId, pageSize = PROJECT_PAGE }: ReviewQueueProps) {
  const api = useMemo(() => importApi(client), [client]);
  /** R470 b: a look at a held file reads the file's own ranges (the reader's other calls are never made in a look). */
  const lookFor = useMemo<LookFor>(() => {
    const reader = readerApi(client);
    return (rid) => ({ api: reader, range: heldFileRanges(client, projectId, rid) });
  }, [client, projectId]);
  const projectWide = !batchId;
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [store, setStore] = useState(recordStore);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  /** Read by each answer: clearing a failure that is not there would re-render the whole queue. */
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  /** The list of imports has been read for this project (R463 M1). */
  const [batchesKnown, setBatchesKnown] = useState(false);
  const batch = batchId ? batches.find((b) => b.batchId === batchId) : undefined;
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The polite region's messages; each is its own node, so the same words twice are said twice (R313 g). R319 e: a new
   * message never takes the place of one not yet shown — those already shown give way, those not yet shown stay before
   * it (a decision's result set in the same moment as the notice of a press not taken is said, then the notice).
   */
  const [said, setSaid] = useState<{ msgs: ReadonlyArray<{ text: string; n: number }>; n: number }>({ msgs: [], n: 0 });
  /** The `n` of the last message shown. */
  const saidShown = useRef(0);
  useEffect(() => {
    saidShown.current = said.n;
  }, [said]);
  const setStatus = useCallback(
    (text: string) =>
      setSaid((cur) => {
        const n = cur.n + 1;
        return { n, msgs: text ? [...cur.msgs.filter((m) => m.n > saidShown.current), { text, n }] : [] };
      }),
    [],
  );
  const [focusId, setFocusId] = useState<{ id: string | null } | null>(null);
  /** Waiting files (F11, R303): the decision under way on each, the service's sentence for a refused one, where focus goes after one. */
  const [heldBusy, setHeldBusy] = useState<Readonly<Record<string, HeldFileDecision>>>({});
  const heldBusyRef = useRef(new Set<string>());
  /**
   * R478: each card's decision request given up at HELD_DECISION_TIMEOUT_MS and still open (FR-529 leaves it open for
   * its late answer). A card holds at most one: its next decision cancels it first; leaving the queue cancels them all.
   */
  const givenUp = useRef(new Map<string, AbortController>());
  /** R486 e: every decision request still open (inside its 60 seconds or given up), with its give-up timer. */
  const outstanding = useRef(new Map<AbortController, ReturnType<typeof setTimeout>>());
  const [heldErrors, setHeldErrors] = useState<Readonly<Record<string, string>>>({});
  const [fileFocus, setFileFocus] = useState<{ to: string } | null>(null);
  /** R470 b, R487 a: the waiting file being looked at, and the title its dialog shows (null when none is). */
  const [lookAt, setLookAt] = useState<{ item: HeldItem; title: string } | null>(null);
  const openLook = useCallback((item: HeldItem, title: string) => setLookAt({ item, title }), []);
  /**
   * R319: the found files' section as laid out (null until the queue is first read; again after a lock or for another
   * project). Its cards stay in their places for the whole visit: a decided file keeps its card, a file the service no
   * longer lists keeps its card, and files that arrive are not slid in — only "Show them" lays it out afresh.
   */
  const [laid, setLaid] = useState<FileLayout | null>(null);
  const laidRef = useRef(laid);
  /** The project (and source) the section was laid out for. */
  const laidFor = useRef<string | null>(null);
  const putLayout = useCallback((l: FileLayout | null) => {
    laidRef.current = l;
    setLaid(l);
  }, []);
  /** The found files' section's heading: focus goes there after "Show them", and after the last waiting file. */
  const foundHead = useRef<HTMLHeadingElement>(null);
  /** R323 b: a press not taken, shown on its card. */
  const [heldNotices, setHeldNotices] = useState<Readonly<Record<string, PressNotice>>>({});
  /** R323 a: the pointer's real movements and the scrolls (see Pointing). */
  const pointing = usePointing();
  /** The line each card shows now (a ref, so a press knows at once whether its sentence is already there). */
  const noticesRef = useRef<Readonly<Record<string, PressNotice>>>({});
  const notice = useCallback((id: string, n: PressNotice | null) => {
    const { [id]: _was, ...others } = noticesRef.current;
    noticesRef.current = n ? { ...others, [id]: n } : others;
    setHeldNotices((cur) => {
      if ((cur[id] ?? null) === n) return cur;
      const { [id]: _drop, ...rest } = cur;
      return n ? { ...rest, [id]: n } : rest;
    });
  }, []);

  /** The project's queue is locked (PROJECT_LOCKED): nothing of it is shown until it is unlocked here. */
  const [locked, setLocked] = useState(false);
  const [projectName, setProjectName] = useState("This project");
  /** Moved on by an unlock: the queue is read again. */
  const [readKey, setReadKey] = useState(0);
  /** Moved on by another project, a lock and unmounting: answers of an older generation are dropped. */
  const gen = useRef(0);
  const showButtons = useRef(new Map<string, HTMLButtonElement>());
  /**
   * R362 d: the headings of the entry the panel shows — its record's title once read, and the panel's own heading (kept
   * focusable, so focus put there while the record is read is not lost when the title comes and moves on to it).
   */
  const panelHead = useRef<HTMLHeadingElement | null>(null);
  const panelSectionHead = useRef<HTMLHeadingElement | null>(null);
  const panelHeadRef = useCallback((el: HTMLHeadingElement | null) => {
    panelHead.current = el;
    if (el && document.activeElement === panelSectionHead.current && el.closest(".ao-review__panel")?.contains(panelSectionHead.current)) el.focus();
  }, []);
  const panelSectionRef = useCallback((el: HTMLHeadingElement | null) => {
    panelSectionHead.current = el;
  }, []);
  const title = useRef<HTMLHeadingElement>(null);
  /** Each waiting file's heading (R313 a: focus goes there after a decision) and its card. */
  const fileHeads = useRef(new Map<string, HTMLHeadingElement>());
  const fileCards = useRef(new Map<string, HTMLElement>());
  /**
   * R313 c, R318 b, R319 d: the found files' quiet. Since R319 a decided file's card stays in its place and no card takes
   * it (nothing moves under the pointer); the quiet is kept for the moments the section's cards DO appear where they were
   * not. It runs for DECIDE_SETTLE_MS from the LATEST of these moments:
   *  - the section laid out: at the screen's opening, and afresh by "Show them" (R319 c);
   *  - the section shown again after the queue was read again during the visit (it is gone while the queue is read);
   *  - an entry of another kind left the list above it (R322 b);
   *  - a press on a deciding control that is not taken: on a card whose own decision is out (that card is still
   *    working), or a press swallowed by the quiet itself.
   * A decision answered starts none (its card stays where it was, without controls). A press that is taken (a card at
   * rest, no quiet in force) starts none either: one file's wait does not hold back a deliberate decision on another.
   */
  const filesQuiet = useQuiet();
  const holdQuiet = filesQuiet.hold;
  /**
   * R362 d: the panel's quiet (the panel for the queue's other kinds of entry). After a decision the next entry is shown
   * in the panel in the place of the one decided, so it runs for DECIDE_SETTLE_MS from: an entry leaving the list, the
   * queue read again during the visit, and a press on the panel not taken because of it.
   */
  const panelQuiet = useQuiet();
  /** The queue has been read once in this visit: a later read changes the list under the panel. */
  const readBefore = useRef(false);
  /** R313 e: after a decision was given up and the queue read again, focus goes back to that file's heading. */
  const refocusAfterRead = useRef<string | null>(null);
  /**
   * R513 (I1): when focus went somewhere at once and is to move again once the read lands (a look closed during the
   * read), the element the first move put it on. The second move happens only if focus is still there, or on the page
   * body (R513 N1): focus is never taken from where the researcher has put it meanwhile (a control inside the screen, or anything outside it). Null when
   * the move after the read is R313 e's own (a given-up decision, whose focus was judged when it was recorded).
   */
  const refocusOnlyFrom = useRef<Element | null>(null);
  /** The message that nothing is waiting: focus goes there after the last decision. */
  const emptyNote = useRef<HTMLParagraphElement>(null);

  // ---- source loading: a queue served by SOURCE_POOL workers, the current item first ----
  const pool = useRef({ queue: [] as string[], active: 0, live: true, asked: new Set<string>() });
  // Answers are applied as they arrive, gathered over a frame so a long queue does not re-render
  // once per answer; the shown item's answer is applied at once.
  const arrived = useRef(new Map<string, SourceFile>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownSid = useRef<string | undefined>(undefined);
  const flush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (!arrived.current.size) return;
    const got = arrived.current;
    arrived.current = new Map();
    store.set(got);
  }, [store]);
  const pump = useCallback(() => {
    const p = pool.current;
    while (p.live && p.active < SOURCE_POOL && p.queue.length) {
      const sid = p.queue.shift()!;
      p.asked.add(sid);
      p.active++;
      api
        .source(projectId, sid)
        .then(
          (sf) => {
            if (!p.live) return;
            arrived.current.set(sid, sf);
            if (sid === shownSid.current) flush();
            else flushTimer.current ??= setTimeout(flush, 16);
            if (failedRef.current.has(sid)) setFailed((cur) => new Set([...cur].filter((x) => x !== sid)));
          },
          () => {
            p.asked.delete(sid); // a retry may ask again
            if (p.live) setFailed((cur) => new Set(cur).add(sid));
          },
        )
        .finally(() => {
          p.active--;
          pump();
        });
    }
  }, [api, projectId, flush]);
  /** Loads these sources next (ahead of what is already queued); one already asked for is not asked again. */
  const loadFirst = useCallback(
    (sids: string[]) => {
      const p = pool.current;
      const fresh = sids.filter((x) => !p.asked.has(x));
      p.queue = [...fresh, ...p.queue.filter((x) => !fresh.includes(x))];
      pump();
    },
    [pump],
  );

  /** The unlock form's place (its field takes focus when a lock found during the visit leaves focus nowhere, FR-739 4). */
  const unlockRef = useRef<HTMLDivElement>(null);
  /** Moved on when a lock is found after the queue was shown in this visit. */
  const [lockFound, setLockFound] = useState(0);
  /** The project was locked: everything read from it is forgotten, and the unlock form shown. */
  const forget = useCallback(() => {
    if (readBefore.current) setLockFound((n) => n + 1);
    gen.current++;
    pool.current.live = false;
    arrived.current = new Map();
    setItems(null);
    setCurrent(null);
    setSelected([]);
    setStatus("");
    setError(null);
    setHeldBusy({});
    setHeldErrors({});
    noticesRef.current = {};
    setHeldNotices({});
    // Nothing of the found files' section outlives a lock: unlocked, it is laid out afresh (and a look is closed).
    putLayout(null);
    setLookAt(null);
    setStore(recordStore());
    setLocked(true);
  }, []);

  useEffect(() => {
    if (locked) return;
    const g = ++gen.current;
    const p = { queue: [] as string[], active: 0, live: true, asked: new Set<string>() };
    pool.current = p;
    let live = true;
    const ok = () => live && g === gen.current;
    // R319: the section's layout belongs to one project (and source); another one is laid out afresh.
    const layoutKey = `${projectId}\n${sourceId ?? ""}\n${batchId ?? ""}`;
    if (laidFor.current !== layoutKey) {
      laidFor.current = layoutKey;
      putLayout(null);
      setLookAt(null);
    }
    setError(null);
    setItems(null);
    /** Every page of the project's queue, oldest first; a page for an older generation stops the read. */
    const readAll = async (): Promise<ReviewItem[]> => {
      const out: ReviewItem[] = [];
      for (let offset = 0; ok(); ) {
        const page = await api.projectReview(projectId, { offset, limit: pageSize, ...(sourceId ? { source: sourceId } : {}) });
        out.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) break;
      }
      return out;
    };
    (batchId ? api.review(batchId) : readAll()).then(
      (list) => {
        if (!ok()) return;
        const shown = laidRef.current;
        if (!shown) {
          // R319 d: the screen's opening lays the section out; its cards appear, so the quiet holds.
          const files = list.filter(isFound) as HeldItem[];
          putLayout({ items: files, ended: {} });
          if (files.length) holdQuiet(Date.now());
        } else {
          // Read again during the visit: the cards stay as laid out (a file no longer listed keeps its card, R319 b; one
          // that arrived is only counted, R319 c). The section was gone while the queue was read and is shown again,
          // in the same order, and what is above it may have changed: the quiet holds (R313 c, R322 b: any re-read).
          holdQuiet(Date.now());
        }
        // R362 d: read again during the visit, the panel may show another entry where the last one stood.
        if (readBefore.current) panelQuiet.hold(Date.now());
        readBefore.current = true;
        setItems(list);
        const back = refocusAfterRead.current;
        const from = refocusOnlyFrom.current;
        refocusAfterRead.current = null;
        refocusOnlyFrom.current = null;
        // R313 e: back to that file's heading; its card is still in its place (R319 b), whether or not it still waits.
        // R513 (I1, N1): after a look closed during the read, only if focus is still where that close put it, or on the
        // page (nowhere: never left there, FR-739 2) — never taken from any other element the researcher put it on.
        const active = document.activeElement;
        if (back && (!from || active === from || !active || active === document.body)) setFileFocus({ to: laidRef.current?.items.some((i) => i.id === back) ? back : ":title" });
        // A waiting file is shown in full in its own section; the panel shows the first of the others.
        setCurrent(list.find((i) => !isFound(i))?.id ?? null);
        // Titles come with the items; only items sent without one need their record for the list. A waiting file's
        // record is read for its creators and year (the record it was found for, R303).
        p.queue = list.flatMap((i) => (i.sourceId && (!i.title || isFound(i)) ? [i.sourceId] : []));
        pump();
      },
      (e: unknown) => {
        if (!ok()) return;
        if (isProjectLocked(e)) forget();
        else setError(errorText(e));
      },
    );
    api.policy(projectId).then((x) => ok() && setPolicy(x), () => ok() && setPolicy({ pseudonymizeNames: true, encryptionRequired: true }));
    api.collections(projectId).then((c) => ok() && setCollections(c), () => {});
    api.tags(projectId).then((t) => ok() && setTags(t), () => {});
    setBatchesKnown(false);
    api.batches(projectId).then(
      (b) => {
        if (!ok()) return;
        setBatches(b);
        setBatchesKnown(true);
      },
      () => {},
    );
    return () => {
      live = false;
      p.live = false;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      arrived.current = new Map();
    };
  }, [api, projectId, batchId, sourceId, pageSize, pump, locked, readKey, forget, holdQuiet, putLayout, panelQuiet]);
  // Unmounting moves the generation on: a decision answered after the screen closed changes nothing.
  useEffect(() => () => void gen.current++, []);
  // R478, R486 e: leaving the queue (unmount, or another project shown) cancels every decision request still open —
  // given up or still inside its 60 seconds — and clears its give-up timer. The service has the decision already; its
  // record shows at the next read. A cancelled request's answer or failure changes nothing.
  useEffect(() => {
    const open = outstanding.current;
    const up = givenUp.current;
    return () => {
      for (const [c, t] of open) {
        clearTimeout(t);
        c.abort();
      }
      open.clear();
      up.clear();
    };
  }, [projectId]);

  /**
   * FR-739 (4): a lock found during the visit (a read, a decision, with or without a look open) takes away what had focus:
   * focus goes to what the screen now offers, the unlock's field (as Find and acquire does, R262 N5 a, R281 b) — never the
   * page. A researcher whose focus is still on something there (the screen's heading, a link) keeps it.
   */
  useEffect(() => {
    if (!lockFound) return;
    const active = document.activeElement;
    if (!active || active === document.body) unlockRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [lockFound]);

  // The project's name, for the unlock form.
  useEffect(() => {
    if (!locked) return;
    let live = true;
    api.projects().then((list) => live && setProjectName(list.find((x) => x.id === projectId)?.name ?? "This project"), () => {});
    return () => {
      live = false;
    };
  }, [api, locked, projectId]);

  // The item shown is loaded (its full record, for the preview) before the rest of the queue.
  const currentItem = items?.find((i) => i.id === current);
  shownSid.current = currentItem?.sourceId;
  const shownSource = useRecord(store, currentItem?.sourceId);
  useEffect(() => {
    const sid = currentItem?.sourceId;
    if (sid) loadFirst([sid]);
  }, [currentItem?.sourceId, loadFirst]);

  /**
   * R362 d (R313 a): after a decision in the panel focus goes to the next entry's heading, never to a control that
   * decides; with no entry left beside the panel, where the found files' section sends it — the section's heading while
   * files wait, else the message that nothing is waiting.
   */
  useEffect(() => {
    if (!focusId) return;
    const el = focusId.id ? (panelHead.current ?? panelSectionHead.current) : (itemsRef.current ?? []).length ? foundHead.current : emptyNote.current;
    (el ?? title.current)?.focus();
  }, [focusId]);

  /** The title the list shows for an item (read now, for the status line after a decision). */
  const titleFor = (i: ReviewItem, n: number) => titleOf(store.get(i.sourceId)) || i.title || `item ${fmt(n)}`;

  const retry = useCallback(
    (sid: string) => {
      setFailed((cur) => new Set([...cur].filter((x) => x !== sid)));
      loadFirst([sid]);
    },
    [loadFirst],
  );
  const toggle = useCallback((id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id))), []);
  const showRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) showButtons.current.set(id, el);
    else showButtons.current.delete(id);
  }, []);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  /** The items as rendered last (read by answers, which may arrive after other changes). */
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const currentRef = useRef(current);
  currentRef.current = current;
  /**
   * Entries that left the queue: removed from the view; when the one shown is among them, the next
   * entry is shown and focused (the heading when none is left), and `said` goes on the status line.
   */
  const leave = (ids: string[], said: (n: number) => string) => {
    const list = itemsRef.current ?? [];
    const gone = new Set(ids);
    const at = list.findIndex((x) => gone.has(x.id));
    if (at < 0) return;
    const rest = list.filter((x) => !gone.has(x.id));
    const shown = currentRef.current;
    const shownGone = !!shown && gone.has(shown);
    // The next entry beside the panel (a waiting file is not shown there).
    const listed = list.filter((x) => !isFound(x));
    const restListed = listed.filter((x) => !gone.has(x.id));
    const lat = Math.max(0, listed.findIndex((x) => gone.has(x.id)));
    const next = shownGone ? (restListed[Math.min(lat, restListed.length - 1)]?.id ?? null) : shown;
    itemsRef.current = rest;
    currentRef.current = next;
    // R322 b: an entry of another kind left the list above the found files: the section may have moved; the quiet holds.
    holdQuiet(Date.now());
    // R362 d: the panel shows the next entry where the one that left stood: its quiet holds too.
    panelQuiet.hold(Date.now());
    setItems(rest);
    setCurrent(next);
    setSelected((s) => s.filter((x) => !gone.has(x)));
    setStatus(said(at + 1));
    if (shownGone) setFocusId({ id: next });
  };

  const decide = async (item: ReviewItem, decision: ReviewDecision, done: string) => {
    // One request per decision, however often it is pressed.
    if (busyRef.current) return;
    busyRef.current = true;
    const g = gen.current;
    setBusy(true);
    setError(null);
    try {
      await api.decide(projectId, item.id, decision);
      if (g !== gen.current) return;
      leave([item.id], (n) => `${done}: ${titleFor(item, n)}`);
    } catch (e) {
      if (g !== gen.current) return;
      if (isProjectLocked(e)) forget();
      else setError(errorText(e));
    } finally {
      busyRef.current = false;
      if (g === gen.current) setBusy(false);
    }
  };

  /**
   * Decision 31 (c), "Look up again" (R577 i, iii): one request per press, while nothing else of the queue is under way
   * (the usual busy state). Answered, the entry is shown as the service lists it now — its new matches after the earlier
   * ones, its reasons with the state's sentence — and the result is said in the polite region. Locked meanwhile: the queue
   * is forgotten (as for a decision); decided meanwhile (another window): it leaves the view.
   */
  const [lookingUp, setLookingUp] = useState<string | null>(null);
  const lookUpAgain = async (item: ReviewItem): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    const g = gen.current;
    setBusy(true);
    setLookingUp(item.id);
    setError(null);
    try {
      const { outcome, entry } = await api.lookUpAgain(projectId, item.id);
      if (g !== gen.current) return;
      setItems((cur) => cur && cur.map((x) => (x.id === item.id ? entry : x)));
      // R585 (3): a look-up of this entry was already under way: it still shows "Looking this up again…", with no second
      // press, until the queue lists the entry changed (read again now and then, a bounded number of times).
      const answered = outcome.kind === "under-way" ? await afterUnderWay(entry, g) : entry;
      if (g !== gen.current || !answered) return;
      const words = outcome.kind === "under-way" ? (answered === entry ? "" : lookUpSaid({ kind: "nothing" }, answered.lookUp)) : lookUpSaid(outcome, entry.lookUp);
      if (words) setStatus(words);
    } catch (e) {
      if (g !== gen.current) return;
      if (isProjectLocked(e)) forget();
      else if (e instanceof ApiClientError && e.code === "CONFLICT") leave([item.id], (n) => `This entry had already been reviewed, so it left the queue: ${titleFor(item, n)}`);
      else setError(errorText(e));
    } finally {
      busyRef.current = false;
      if (g === gen.current) {
        setBusy(false);
        setLookingUp(null);
      }
    }
  };

  /**
   * R585 (3): while another look-up of the entry is under way, the entry is read again every LOOK_UP_RECHECK_MS (at most
   * LOOK_UP_RECHECKS times) until the queue lists it changed; that entry is shown. Undefined when the view moved on or the
   * entry left the queue (decided meanwhile: it leaves the view).
   */
  const afterUnderWay = async (entry: ReviewItem, g: number): Promise<ReviewItem | undefined> => {
    const same = JSON.stringify(entry);
    for (let i = 0; i < LOOK_UP_RECHECKS; i++) {
      await new Promise((r) => setTimeout(r, LOOK_UP_RECHECK_MS));
      if (g !== gen.current) return undefined;
      const page = await api.projectReview(projectId, { source: entry.sourceId!, limit: PROJECT_REVIEW_PAGE_MAX }).catch(() => null);
      if (g !== gen.current) return undefined;
      if (!page) continue;
      const now = page.items.find((x) => x.id === entry.id);
      if (!now) {
        leave([entry.id], (n) => `This entry had already been reviewed, so it left the queue: ${titleFor(entry, n)}`);
        return undefined;
      }
      if (JSON.stringify(now) !== same) {
        setItems((cur) => cur && cur.map((x) => (x.id === entry.id ? now : x)));
        return now;
      }
    }
    return entry;
  };

  /**
   * A field confirmed through the source screen's confirm (R149): the record it answers replaces the
   * one shown. In the project's queue, the service is then asked which of that source's entries are
   * left: the confirm that settles a capture entry's last field resolves it in the library (R176 1),
   * and the entry leaves the view.
   */
  const verification = useMemo(() => verificationApi(client), [client]);
  const confirmField = async (item: ReviewItem, field: string, value: unknown) => {
    const g = gen.current;
    const sid = item.sourceId;
    if (!sid) return;
    try {
      const after = await verification.confirmField(projectId, sid, field, value);
      if (g !== gen.current) return;
      store.set([[sid, after as unknown as SourceFile]]);
      setStatus(`Confirmed: ${FIELD_LABELS[field] ?? field}`);
      if (projectWide && item.kind === "verification") void entriesLeft(item, g);
    } catch (e) {
      if (g !== gen.current) return;
      if (isProjectLocked(e)) {
        forget();
        return;
      }
      throw new Error(errorText(e));
    }
  };

  /** After a confirm: the source's entries the service still lists; the others left the queue. */
  const entriesLeft = async (item: ReviewItem, g: number) => {
    const sid = item.sourceId!;
    try {
      const page = await api.projectReview(projectId, { source: sid, limit: PROJECT_REVIEW_PAGE_MAX });
      if (g !== gen.current) return;
      const still = new Set(page.items.map((x) => x.id));
      const gone = (itemsRef.current ?? []).filter((x) => x.sourceId === sid && !still.has(x.id)).map((x) => x.id);
      if (gone.length) leave(gone, (n) => `Every field is confirmed; the entry left the queue: ${titleFor(item, n)}`);
    } catch (e) {
      if (g !== gen.current) return;
      if (isProjectLocked(e)) forget();
      // Otherwise the entry stays shown; the next reading of the queue settles it.
    }
  };

  /**
   * "Reviewed after the withdrawal" (R176 2): the library's own decision, with the researcher's
   * reason as typed. Resolves true when recorded (or when the view moved on); false when another
   * action was still running (nothing sent); throws a plain-language message when not recorded.
   */
  const reviewWithdrawal = async (item: ReviewItem, reason: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    const g = gen.current;
    setBusy(true);
    try {
      await api.reviewedAfterWithdrawal(projectId, item.id, reason);
      if (g !== gen.current) return true;
      leave([item.id], (n) => `Recorded as reviewed after the withdrawal: ${titleFor(item, n)}`);
      return true;
    } catch (e) {
      if (g !== gen.current) return true;
      if (isProjectLocked(e)) {
        forget();
        return true;
      }
      // Decided meanwhile (another window): it is no longer waiting, so it leaves the view (fix round 1, M2).
      if (e instanceof ApiClientError && e.code === "CONFLICT") {
        leave([item.id], (n) => `This entry had already been reviewed, so it left the queue: ${titleFor(item, n)}`);
        return true;
      }
      throw new Error(errorText(e));
    } finally {
      busyRef.current = false;
      if (g === gen.current) setBusy(false);
    }
  };

  /**
   * "Use this file" / "Not this file" on a waiting file (F11; R303): one request per press, one file per request. Each
   * file has its own decision under way: its two buttons are busy while it is out, and the other files stay usable.
   * Decided, the file leaves the view and focus goes to the next waiting file (R303 b). A refusal is said in the
   * service's own sentence beside that file and the entry stays, focus where it was; only a refusal the service says
   * was already decided takes it away (R282 d).
   */
  const withoutKey = <T,>(rec: Readonly<Record<string, T>>, id: string): Record<string, T> => {
    const { [id]: _drop, ...rest } = rec;
    return rest;
  };
  /**
   * A waiting file left the queue (decided here, or found already decided). R319 a: its card stays where it is, without
   * controls, saying what became of it; nothing moves, so no quiet starts. Focus goes to the next WAITING card's heading
   * (the next in its group, else the one before it, else the first waiting card of the other group; decided and departed
   * cards are skipped), else to the section's heading while other entries wait, else to the message that nothing waits.
   */
  /**
   * The next WAITING card after `item` as laid out (the next in its group, else the one before it, else the first of the
   * other group), by `waiting`; none when no other card waits.
   */
  const nextWaiting = (item: ReviewItem, waiting: (x: ReviewItem) => boolean): ReviewItem | undefined => {
    const laidOut = laidRef.current?.items ?? [];
    const mine = laidOut.filter((x) => looksRight(x) === looksRight(item));
    const k = mine.findIndex((x) => x.id === item.id);
    return mine.slice(k + 1).find(waiting) ?? mine.slice(0, Math.max(0, k)).reverse().find(waiting) ?? laidOut.filter((x) => looksRight(x) !== looksRight(item)).find(waiting);
  };
  /**
   * Where focus goes once `item`'s card has ended, with `list` the queue (as last read) and `ended` the ended cards: the
   * next waiting card's heading, else the section's heading while other entries wait, else the note that nothing waits.
   * `fileLeft`'s rule, and a closed look's whose card ended (R492 b).
   */
  const focusAfterLeft = (item: ReviewItem, list: readonly ReviewItem[], ended: Readonly<Record<string, unknown>>): string => {
    const rest = list.filter((x) => x.id !== item.id);
    const still = new Set(rest.map((x) => x.id));
    const next = nextWaiting(item, (x) => still.has(x.id) && !ended[x.id]);
    return next ? next.id : rest.length ? ":section" : ":empty";
  };
  const fileLeft = (item: ReviewItem, end: FileEnd, said: (n: number) => string) => {
    const list = itemsRef.current ?? [];
    const at = list.findIndex((x) => x.id === item.id);
    if (at < 0) return;
    // Focus moves only when it was on this file (or nowhere): a researcher already at another file keeps their place.
    const active = document.activeElement;
    const card = fileCards.current.get(item.id);
    const hadFocus = !active || active === document.body || (!!card && card.contains(active));
    const rest = list.filter((x) => x.id !== item.id);
    const layout = laidRef.current;
    const ended = { ...(layout?.ended ?? {}), [item.id]: end };
    const to = focusAfterLeft(item, list, ended);
    itemsRef.current = rest;
    if (layout) putLayout({ ...layout, ended });
    setItems(rest);
    setSelected((s) => s.filter((x) => x !== item.id));
    setHeldErrors((cur) => withoutKey(cur, item.id));
    setStatus(said(at + 1));
    if (hadFocus) setFileFocus({ to });
  };
  /**
   * R319 c: "Show them" — the section laid out afresh from the queue as last read: decided and departed cards go, the
   * files that arrived come in, each in its group. Focus goes to the section's heading, it is said once, and the quiet
   * holds (the cards have moved, as the researcher asked).
   */
  const layOutAgain = () => {
    const list = itemsRef.current ?? [];
    putLayout({ items: list.filter(isFound) as HeldItem[], ended: {} });
    holdQuiet(Date.now());
    setStatus(FOUND_FILES_TEXT.laidOut);
    setFileFocus({ to: ":section" });
  };
  useEffect(() => {
    if (!fileFocus) return;
    const t = fileFocus.to;
    // R313 a: a waiting file's heading, never a control that decides.
    // R487 a: back to a card's own "Look at the file" (the control as it is now; never the stand-in, which has none).
    const lookBack = t.startsWith(LOOK_BACK) ? fileCards.current.get(t.slice(LOOK_BACK.length))?.querySelector<HTMLElement>(".ao-review__file-look button:not([tabindex])") : undefined;
    if (t.startsWith(LOOK_BACK)) {
      // FR-739 (2): the control not there at this moment (the queue being read again): the card's heading, else the
      // screen's heading — as for any target that is gone — never the page.
      if (lookBack) {
        if (lookBack !== document.activeElement) lookBack.focus();
      } else (fileHeads.current.get(t.slice(LOOK_BACK.length)) ?? title.current)?.focus();
      // R513 (I1): a move still to come once the read lands happens only from where this one put focus.
      if (refocusAfterRead.current === t.slice(LOOK_BACK.length) && refocusOnlyFrom.current) refocusOnlyFrom.current = document.activeElement;
      return;
    }
    const el =
      t === ":empty" ? emptyNote.current : t === ":title" ? title.current : t === ":section" ? (foundHead.current ?? title.current) : (fileHeads.current.get(t) ?? title.current);
    el?.focus();
  }, [fileFocus]);
  /** R327 c: a press was not taken: its sentence on the card, and in the polite region if the card's line was not that already. */
  const refuse = (id: string, n: PressNotice, words: Readonly<Record<PressNotice, string>> = PRESS_SHOWN_TEXT) => {
    if (noticesRef.current[id] !== n) setStatus(words[n]);
    notice(id, n);
  };
  /**
   * R362 d: a press on one of the panel's deciding controls — taken (true) or not (false, said on the panel and in the
   * polite region, in the panel's words: "entry" where the cards say "file"). The found files' rules: a mouse press only
   * where the pointer moved over the control, a tap only on a control that stood still, and none inside the panel's quiet
   * (which such a press starts again). The decision itself goes on as built (one request at a time).
   */
  const admitPanel = (item: ReviewItem, how: PressCheck): boolean => {
    const not = pressVerdict(how, Date.now(), panelQuiet);
    if (not) {
      refuse(item.id, not, PRESS_SHOWN_TEXT_ENTRY);
      return false;
    }
    notice(item.id, null);
    return true;
  };
  const decideHeld = async (item: ReviewItem, decision: HeldFileDecision, how: PressCheck = "ok") => {
    // R319 a: a file decided here, or no longer listed, has no control that decides; nothing may decide it again.
    if (laidRef.current?.ended[item.id] || !(itemsRef.current ?? []).some((x) => x.id === item.id)) return;
    const now = Date.now();
    // R318 b: a press on a card whose own decision is out is not taken, and starts the quiet again from this press; it
    // says nothing more (its button already says it is working).
    if (heldBusyRef.current.has(item.id)) {
      holdQuiet(now);
      return;
    }
    // R322 a, R327 a, c: a pointer press on a control that is not where the researcher pointed at it (it moved under the
    // pointer, a scroll was just now, or the pointer never moved over it): not taken. It starts no quiet (the place check
    // stands by itself). R313 c, R318 b, c, R327 c: inside the quiet a press does nothing but start the quiet again from
    // this press. Either way its sentence is shown on the card and said when it appears there, not again while it stays.
    const not = pressVerdict(how, now, filesQuiet);
    if (not) {
      refuse(item.id, not);
      return;
    }
    heldBusyRef.current.add(item.id);
    notice(item.id, null);
    // R478: this card's earlier given-up request is cancelled first; its late answer then changes nothing.
    givenUp.current.get(item.id)?.abort();
    givenUp.current.delete(item.id);
    const cancel = new AbortController();
    const g = gen.current;
    setHeldBusy((cur) => ({ ...cur, [item.id]: decision }));
    setHeldErrors((cur) => withoutKey(cur, item.id));
    // R313 e: no answer in HELD_DECISION_TIMEOUT_MS: the decision is given up — the card usable again and saying so, and
    // the queue read again (the decision may or may not have been recorded). The request is left to finish: its late
    // answer decides nothing here, but the queue is read once more then, so a late record by the service shows at once
    // (FR-529) — while the file is still listed here (not after a lock, or once another project is shown). It is kept
    // as the card's given-up request until it answers (R478).
    let late = false;
    const readLate = () => {
      if ((itemsRef.current ?? []).some((x) => x.id === item.id)) setReadKey((k) => k + 1);
    };
    const timer = setTimeout(() => {
      late = true;
      givenUp.current.set(item.id, cancel);
      heldBusyRef.current.delete(item.id);
      setHeldBusy((cur) => withoutKey(cur, item.id));
      setHeldErrors((cur) => ({ ...cur, [item.id]: HELD_NO_ANSWER_TEXT }));
      const active = document.activeElement;
      const card = fileCards.current.get(item.id);
      if (!active || active === document.body || (!!card && card.contains(active))) {
        refocusAfterRead.current = item.id;
        refocusOnlyFrom.current = null;
      }
      setReadKey((k) => k + 1);
    }, HELD_DECISION_TIMEOUT_MS);
    outstanding.current.set(cancel, timer);
    try {
      const body: HeldFileDecisionRequest = { projectId, decision };
      await client.request<HeldFileDecisionResponse>("POST", `/review/${encodeURIComponent(item.id)}/held-file`, { body, signal: cancel.signal });
      if (cancel.signal.aborted) return;
      if (late) readLate();
      if (late || g !== gen.current) return;
      fileLeft(item, decision, (n) => `${FOUND_FILES_TEXT.result[decision]}: ${titleFor(item, n)}`);
    } catch (e) {
      if (cancel.signal.aborted) return;
      if (late) readLate();
      if (late || g !== gen.current) return;
      if (isProjectLocked(e)) {
        forget();
        return;
      }
      // R282 d: the entry leaves only when the service says it was already decided; any other refusal (paused, the
      // record gone, …) is said in the service's sentence and the entry stays.
      if (e instanceof ApiClientError && e.code === "CONFLICT" && e.reason === ("already-decided" satisfies HeldFileRefusalReason)) {
        fileLeft(item, "already", (n) => `${FOUND_FILES_TEXT.result.already}: ${titleFor(item, n)}`);
        return;
      }
      setHeldErrors((cur) => ({ ...cur, [item.id]: e instanceof ApiClientError && e.message ? e.message : errorText(e) }));
    } finally {
      clearTimeout(timer);
      outstanding.current.delete(cancel);
      if (givenUp.current.get(item.id) === cancel) givenUp.current.delete(item.id);
      if (!late) {
        heldBusyRef.current.delete(item.id);
        if (g === gen.current) setHeldBusy((cur) => withoutKey(cur, item.id));
      }
    }
  };
  const headRefFor = useCallback((id: string, el: HTMLHeadingElement | null) => {
    if (el) fileHeads.current.set(id, el);
    else fileHeads.current.delete(id);
  }, []);
  const cardRefFor = useCallback((id: string, el: HTMLElement | null) => {
    if (el) fileCards.current.set(id, el);
    else fileCards.current.delete(id);
  }, []);

  const bulk = async (patch: ReviewPatch, done: string) => {
    if (!selected.length || busyRef.current) return;
    busyRef.current = true;
    const g = gen.current;
    setBusy(true);
    setError(null);
    const chosen = items?.filter((i) => selected.includes(i.id)) ?? [];
    try {
      const r = await api.bulkEdit(
        projectId,
        chosen.map((i) => i.id),
        patch,
      );
      if (g !== gen.current) return;
      setStatus(`${done} ${count(r.edited, "item")}.`);
      // The service applied the patch; the loaded records are updated in place (no refetch).
      const sids = new Set(chosen.flatMap((i) => (i.sourceId ? [i.sourceId] : [])));
      const edited: Array<[string, SourceFile]> = [];
      for (const sid of sids) {
        const sf = store.get(sid);
        if (!sf) continue;
        const s = { ...sf.source };
        if (patch.type) s.type = patch.type;
        if (patch.tagIds) s.tagIds = [...new Set([...s.tagIds, ...patch.tagIds])];
        if (patch.collectionId) s.collectionIds = [...new Set([...s.collectionIds, patch.collectionId])];
        edited.push([sid, { ...sf, source: s }]);
      }
      store.set(edited);
    } catch (e) {
      if (g !== gen.current) return;
      if (isProjectLocked(e)) forget();
      else setError(errorText(e));
    } finally {
      busyRef.current = false;
      if (g === gen.current) setBusy(false);
    }
  };

  const item = currentItem;
  /** The entries listed beside the panel, and the waiting files, shown in their own section (R303 b). */
  const listed = useMemo(() => (projectWide ? (items ?? []).filter((i) => !isFound(i)) : (items ?? [])), [items, projectWide]);
  /** R319: the waiting files the service lists now (by id); those not laid out have arrived during the visit. */
  const waitingIds = useMemo(() => new Set((items ?? []).filter(isFound).map((i) => i.id)), [items]);
  /**
   * R487 a (ii): the file looked at no longer waits — decided here, found decided, or no longer listed by the queue as
   * last read (while the queue is being read again, it is not known yet).
   */
  const lookGone = !!lookAt && (!!laid?.ended[lookAt.item.id] || (items !== null && !waitingIds.has(lookAt.item.id)));
  /**
   * The look closed (its button or Escape). R492 c: while the card still waits — also after a "not found" in the look (the
   * held file gone from disk; nothing reads the queue again on it), its controls are still there — focus goes back on its
   * "Look at the file" (the dialog's own restore does the same, unless the queue was read again meanwhile and the control
   * is a new one). R492 b: the card ended (decided, or no longer listed by the queue as last read): focus goes by
   * `fileLeft`'s own rule, as after that card's decision — never the inert stand-in that took the control's place (R319).
   */
  const closeLook = () => {
    const at = lookAt;
    setLookAt(null);
    if (!at) return;
    const list = itemsRef.current;
    const ended = laidRef.current?.ended ?? {};
    if (!ended[at.item.id] && (!list || list.some((x) => x.id === at.item.id))) {
      // FR-739 (2): the queue is being read again (its card is not there meanwhile): once the read lands, focus goes to
      // that card's heading, as after a given-up decision (R313 e); until then to the screen's heading (below).
      // R513 (I1): that second move only if focus is still where this close puts it (set when it is put there, below).
      if (!list) {
        refocusAfterRead.current = at.item.id;
        refocusOnlyFrom.current = title.current;
      }
      setFileFocus({ to: `${LOOK_BACK}${at.item.id}` });
      return;
    }
    setFileFocus({ to: focusAfterLeft(at.item, list ?? laidRef.current?.items ?? [], ended) });
  };
  const arrivedCount = useMemo(() => {
    const laidIds = new Set(laid?.items.map((i) => i.id));
    let k = 0;
    for (const id of waitingIds) if (!laidIds.has(id)) k++;
    return k;
  }, [laid, waitingIds]);
  const flagging = policy?.pseudonymizeNames === true;
  /** Only import entries can be edited together (the library's bulk edit takes import items). */
  const selectable = useMemo(() => listed.filter((i) => i.kind === "import"), [listed]);
  const libApi = useMemo(() => libraryApi(client), [client]);
  const itemBatch = (i: ReviewItem) => (batchId ? batch : batches.find((b) => b.batchId === i.batchId));

  const row = (i: ReviewItem, n: number) => (
    <Row
      key={i.id}
      id={i.id}
      sourceId={i.sourceId}
      n={n}
      store={store}
      fallbackTitle={i.title || `item ${fmt(n)}`}
      reason={i.reasons[0] ?? ""}
      current={i.id === current}
      selectable={i.kind === "import"}
      selected={selectedSet.has(i.id)}
      broken={!!i.sourceId && failed.has(i.sourceId)}
      onToggle={toggle}
      onShow={setCurrent}
      onRetry={retry}
      showRef={showRef}
    />
  );

  return (
    <main className="ao-import ao-review" aria-labelledby="ao-review-title">
      <h1 id="ao-review-title" ref={title} tabIndex={-1}>
        Review queue
      </h1>
      {batchId ? (
        <p>
          <a href={reportHref(projectId, batchId)} onClick={inAppLink}>
            Back to the import's report and undo
          </a>
        </p>
      ) : sourceId ? (
        <p>
          <a href={projectQueueHref(projectId)} onClick={inAppLink}>
            Show every entry waiting in this project
          </a>
        </p>
      ) : null}
      <ErrorNote error={error} />
      <div className="ao-visually-hidden" role="status">
        {said.msgs.map((m) => (
          <p key={m.n}>{m.text}</p>
        ))}
      </div>
      {locked && (
        <div ref={unlockRef}>
          <UnlockProject
            api={libApi}
            project={{ id: projectId, name: projectName }}
            onUnlocked={() => {
              setLocked(false);
              setReadKey((k) => k + 1);
            }}
          />
        </div>
      )}
      {!locked && items === null && !error && <p role="status">Loading…</p>}
      {!locked && items !== null && items.length === 0 && (
        <p ref={emptyNote} tabIndex={-1}>
          {batchId ? "Nothing is waiting for review in this import." : sourceId ? "Nothing is waiting for review for this source." : "Nothing is waiting for review in this project."}
        </p>
      )}
      {!locked && items !== null && items.length > 0 && projectWide && (
        <p>
          {items.length === 1 ? "1 entry is waiting" : `${fmt(items.length)} entries are waiting`} in this project{sourceId ? " for this source" : ""}.
        </p>
      )}
      {!locked && items !== null && listed.length > 0 && (
        <div className="ao-review__layout">
          <div className="ao-review__list-col">
            <BulkBar count={selected.length} collections={collections} tags={tags} busy={busy} onBulk={(p, d) => void bulk(p, d)} />
            {selectable.length > 0 && (
              <label className="ao-import__choice">
                <input
                  type="checkbox"
                  checked={selected.length === selectable.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.length > 0 && selected.length < selectable.length;
                  }}
                  onChange={(e) => setSelected(e.target.checked ? selectable.map((i) => i.id) : [])}
                />
                <span>{projectWide && selectable.length < items.length ? "Select every import item" : "Select all"}</span>
              </label>
            )}
            {projectWide ? (
              groupsOf(listed, batches).map((g) => (
                <section key={g.key} className="ao-review__group" aria-labelledby={`ao-review-g-${g.key}`}>
                  <h2 id={`ao-review-g-${g.key}`} className="ao-review__group-title">
                    {g.title}
                  </h2>
                  <ul className="ao-review__list" aria-label={`${g.title} (${fmt(g.items.length)})`}>
                    {g.items.map(({ item: i, n }) => row(i, n))}
                  </ul>
                </section>
              ))
            ) : (
              <ul className="ao-review__list" aria-label={`Items waiting for review (${fmt(items.length)})`}>
                {items.map((i, at) => row(i, at + 1))}
              </ul>
            )}
          </div>
          {item && item.kind === "import" && (
            <ItemPanel
              key={item.id}
              api={api}
              projectId={projectId}
              item={item}
              source={shownSource}
              loadFailed={!!item.sourceId && failed.has(item.sourceId)}
              onRetry={() => item.sourceId && retry(item.sourceId)}
              collections={collections}
              tags={tags}
              flagTitle={flagging && titleFromFileName(item, shownSource)}
              flagFolderNames={flagging ? (id: string) => madeByBatch(id, batchId ?? item.batchId, itemBatch(item), batchesKnown) : () => false as const}
              busy={busy}
              onDecide={(d, done) => void decide(item, d, done)}
              lookingUp={lookingUp === item.id}
              onLookUpAgain={() => lookUpAgain(item)}
              onConfirm={(field, value) => confirmField(item, field, value)}
              pointing={pointing}
              epoch={items}
              notice={heldNotices[item.id]}
              onPointedAt={() => notice(item.id, null)}
              admit={(how) => admitPanel(item, how)}
              headRef={panelHeadRef}
              sectionRef={panelSectionRef}
            />
          )}
          {item && item.kind !== "import" && !isFound(item) && (
            <VerificationPanel
              key={item.id}
              item={item}
              source={shownSource}
              loadFailed={!!item.sourceId && failed.has(item.sourceId)}
              onRetry={() => item.sourceId && retry(item.sourceId)}
              onConfirm={(field, value) => confirmField(item, field, value)}
              onReview={(reason) => reviewWithdrawal(item, reason)}
              busy={busy}
              headRef={panelHeadRef}
              sectionRef={panelSectionRef}
            />
          )}
        </div>
      )}
      {!locked && items !== null && projectWide && laid && (laid.items.length > 0 || arrivedCount > 0) && (
        <FoundFiles
          items={laid.items}
          waiting={waitingIds}
          ended={laid.ended}
          arrived={arrivedCount}
          store={store}
          busy={heldBusy}
          errors={heldErrors}
          sectionRef={foundHead}
          headRef={headRefFor}
          cardRef={cardRefFor}
          failed={failed}
          notices={heldNotices}
          pointing={pointing}
          onPointedAt={(id) => notice(id, null)}
          onDecide={(i, d, how) => void decideHeld(i, d, how)}
          onShowArrived={layOutAgain}
          onLook={openLook}
        />
      )}
      {/*
       * R470 b, R487 a: the look is the screen's, not the card's: the found files' section is gone while the queue is read
       * again, and the look must outlive that read to see what it says of the file.
       */}
      {!locked && lookAt && (
        <LookDialog
          key={lookAt.item.id}
          title={lookAt.title}
          projectId={projectId}
          sourceId={lookAt.item.sourceId ?? ""}
          lookFor={lookFor}
          reviewId={lookAt.item.id}
          gone={lookGone}
          onClose={closeLook}
        />
      )}
    </main>
  );
}

/** The project's whole queue (Task 67). */
export const projectQueueHref = (projectId: string, sourceId?: string): string =>
  `${PATHS.reviewQueue}?project=${encodeURIComponent(projectId)}${sourceId ? `&source=${encodeURIComponent(sourceId)}` : ""}`;

/** The value a JSON pointer names in the source ("/identifiers/doi"). */
function valueAt(src: Record<string, unknown>, pointer: string): unknown {
  let cur: unknown = src;
  for (const part of pointer.split("/").slice(1)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

/**
 * The fields of an entry that need checking, each with its verification badge and evidence dialog:
 * the source screen's own FieldCheck and confirm (R149), never a second implementation.
 */
function FieldsToCheck({ item, source, pointers, onConfirm, children }: { item: ReviewItem; source: SourceFile; pointers: string[]; onConfirm(field: string, value: unknown): Promise<void>; children?: (allConfirmed: boolean) => ReactNode }) {
  if (!pointers.length) return null;
  const reviews = new Map<string, FieldReview>(((source as { fields?: FieldReview[] }).fields ?? []).map((r) => [r.field, r]));
  return (
    <Section title="Fields to check" level={3}>
      <p className="ao-import__hint">Choose the right value for each field: open its badge to see the evidence and confirm a value.</p>
      <ul className="ao-review__plain-list">
        {pointers.map((pointer) => {
          const label = FIELD_LABELS[pointer] ?? pointer.replace(/^\//, "").replace(/\//g, " ");
          const review: FieldReview = reviews.get(pointer) ?? { field: pointer, status: (item.fields[pointer] ?? "none") as FieldReview["status"], checks: [], evidence: [] };
          return (
            <li key={pointer}>
              <span>{label} </span>
              <FieldCheck review={review} label={label} value={valueAt(source.source as unknown as Record<string, unknown>, pointer)} readOnly={false} onConfirm={onConfirm} />
            </li>
          );
        })}
      </ul>
      {children?.(pointers.every((p) => reviews.get(p)?.status === "user-confirmed"))}
    </Section>
  );
}

interface VerificationPanelProps {
  item: ReviewItem;
  source: SourceFile | undefined;
  loadFailed: boolean;
  onRetry(): void;
  onConfirm(field: string, value: unknown): Promise<void>;
  /** "Reviewed after the withdrawal" with the reason as typed: true when recorded; throws a plain message when not. */
  onReview(reason: string): Promise<boolean>;
  busy: boolean;
  /** R362 d: the entry's heading, where focus comes after a decision on the entry before it. */
  headRef(el: HTMLHeadingElement | null): void;
  /** R362 d: the panel's own heading, where focus comes while the entry's record is being read. */
  sectionRef(el: HTMLHeadingElement | null): void;
}

/**
 * A verification entry (R176): a capture saved with fields to check (each field's badge and its
 * evidence dialog, the source screen's own confirm, R149; confirming the last one resolves the entry
 * in the library), or a source flagged after a consent withdrawal ("Reviewed after the withdrawal",
 * with a reason).
 */
function VerificationPanel({ item, source, loadFailed, onRetry, onConfirm, onReview, busy, headRef, sectionRef }: VerificationPanelProps) {
  const s = source?.source;
  const withdrawal = groupOf(item) === "withdrawal";
  const [reviewing, setReviewing] = useState(false);
  return (
    <div className="ao-review__panel">
      <Section title={withdrawal ? "Flagged source" : "Captured source"} level={2} className="ao-review__record" headingRef={sectionRef}>
        {!source && !loadFailed && <p role="status">Loading…</p>}
        {!source && loadFailed && (
          <div className="ao-import__error" role="alert">
            <p>This source's record could not be loaded.</p>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {source && s && (
          <>
            <h3 className="ao-review__title" tabIndex={-1} ref={headRef}>
              <UserText>{titleOf(source) || "Untitled"}</UserText>
            </h3>
            <dl className="ao-review__fields">
              <dt>Type</dt>
              <dd>{typeLabel(s.type)}</dd>
              {s.creators.length > 0 && (
                <>
                  <dt>Creators</dt>
                  <dd>
                    <UserText>{creatorsText(s.creators)}</UserText>
                  </dd>
                </>
              )}
            </dl>
          </>
        )}
        <Section title="Why it needs review" level={3}>
          <ul>
            {item.reasons.map((r, i) => (
              <li key={`${i}:${r}`}>
                <UserText>{r}</UserText>
              </li>
            ))}
          </ul>
        </Section>
        {!withdrawal && source && <FieldsToCheck item={item} source={source} pointers={Object.keys(item.fields)} onConfirm={onConfirm} />}
        {!withdrawal && Object.keys(item.fields).length > 0 && (
          <p className="ao-import__hint">Keeping the value shown is confirming it. Once every field here is confirmed, the entry leaves the queue.</p>
        )}
        {withdrawal && (
          <Section title="Your decision" level={3}>
            <p>
              Nothing has been deleted. Recording “Reviewed after the withdrawal” says that you have reviewed this source, with your reason, and changes nothing else about the source.
            </p>
            <p className="ao-import__hint">
              To remove the source, destroy its files or leave it out of an export, use the tools for those: they are not part of this decision.
            </p>
            <div className="ao-import__actions">
              <button type="button" className="ao-import__primary" disabled={busy} onClick={() => setReviewing(true)}>
                Reviewed after the withdrawal…
              </button>
            </div>
            {reviewing && <WithdrawalReviewDialog onCancel={() => setReviewing(false)} onRecord={async (reason) => {
                  const done = await onReview(reason);
                  if (done) setReviewing(false);
                  return done;
                }} />}
          </Section>
        )}
      </Section>
    </div>
  );
}

/** A file's size in words: "2.3 MB", "640 KB". */
function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const FOUND_FILES_TEXT = {
  section: "Files found for records",
  right: (k: number) => `Files that look right (${fmt(k)})`,
  other: (k: number) => `Other files found (${fmt(k)})`,
  intro: "Each file waits for your decision. “Use this file” adds it to its record; “Not this file” removes it.",
  /** What became of a file, said in the polite region (with the record's title) and on its card (as a sentence, R319 a). */
  result: {
    attach: "File added to its record",
    discard: "File removed; the record keeps no file",
    already: "This entry had already been decided, so it left the queue",
  } satisfies Record<FileEnd, string>,
  /** R319 a: the label on a card decided in this visit. */
  decided: "Decided",
  /** R319 b: a card whose file the service no longer lists. */
  gone: "No longer waiting.",
  /** R319 c: the line that counts the files that arrived during the visit, and its control. */
  arrived: (k: number) => (k === 1 ? "1 more file has arrived since this list was opened." : `${fmt(k)} more files have arrived since this list was opened.`),
  showThem: "Show them",
  /** R319 c: said once after "Show them". */
  laidOut: "The list was laid out again.",
} as const;

interface FoundFilesProps {
  /** The cards as laid out (R319): they stay in their places for the visit. */
  items: HeldItem[];
  /** The waiting files the service lists now. */
  waiting: ReadonlySet<string>;
  /** What became of the files decided in this visit. */
  ended: Readonly<Record<string, FileEnd>>;
  /** Waiting files that arrived during the visit, not laid out (R319 c). */
  arrived: number;
  store: RecordStore;
  busy: Readonly<Record<string, HeldFileDecision>>;
  errors: Readonly<Record<string, string>>;
  headRef(id: string, el: HTMLHeadingElement | null): void;
  cardRef(id: string, el: HTMLElement | null): void;
  sectionRef: Ref<HTMLHeadingElement>;
  /** Sources whose record could not be read. */
  failed: ReadonlySet<string>;
  /** R323 b: presses not taken, shown on their cards. */
  notices: Readonly<Record<string, PressNotice>>;
  pointing: Pointing;
  /** R323 b: the pointer moved over a card that shows a press not taken. */
  onPointedAt(id: string): void;
  onDecide(item: HeldItem, decision: HeldFileDecision, how: PressCheck): void;
  onShowArrived(): void;
  /** R470 b: "Look at the file" pressed on a card. */
  onLook(item: HeldItem, title: string): void;
}

/** What the app's check says of a file, in the app's own words; nothing for a `why` it does not have (R313 f). */
const adviceOf = (h: ReviewHeldFile | undefined): string | undefined =>
  h && typeof h.why === "string" && Object.hasOwn(HELD_FILE_WHY_TEXT, h.why) ? HELD_FILE_WHY_TEXT[h.why] : undefined;

/** The record a waiting file was found for, as its two controls name it: its title, then its first creator's family name and its year. */
function describeRecord(item: HeldItem, record: SourceFile | undefined): string {
  const title = titleOf(record) || item.title || "this record";
  const first = record?.source.creators[0];
  const family = first ? (first.family ?? first.literal ?? "") : "";
  const year = typeof record?.source.issued === "string" ? yearOf(record.source.issued) : undefined;
  const more = [family, year].filter(Boolean).join(", ");
  return more ? `${title} (${more})` : title;
}

/**
 * The waiting files (F11; R296 b, R303): those the app's check says look right gathered first, the others after them,
 * each group under its heading with its number; a group with no file is not shown. No control here decides more than
 * one file. R313 g: each file's controls are named so that two files can be told apart — the record's title, first
 * creator and year, and "file k of n" where two would still be named alike.
 *
 * R319: nothing moves under the pointer. The cards are those laid out; each stays in its place for the visit — a file
 * decided here keeps its card with what was decided in words and no control, a file the service no longer lists keeps
 * its card saying it no longer waits — and a group's number counts the files still waiting (a group all decided shows 0
 * and stays). Files that arrive are only counted, on a line in a place kept for it above the groups (laid out whether
 * or not it says anything, so its appearing moves nothing); "Show them" lays the section out afresh.
 */
function FoundFiles({ items, waiting, ended, arrived, store, busy, errors, sectionRef, failed, notices, pointing, onPointedAt, headRef, cardRef, onDecide, onShowArrived, onLook }: FoundFilesProps) {
  // Re-rendered when a record is read: the names depend on every waiting file's record.
  useSyncExternalStore(store.subscribe, store.version);
  const right = items.filter(looksRight);
  const other = items.filter((i) => !looksRight(i));
  const ordered = [...right, ...other];
  const base = new Map(ordered.map((i) => [i.id, describeRecord(i, store.get(i.sourceId))]));
  const names = new Map<string, string>();
  for (const i of ordered) {
    const b = base.get(i.id)!;
    const same = ordered.filter((x) => base.get(x.id) === b);
    if (same.length < 2) names.set(i.id, b);
    else {
      const k = `file ${same.findIndex((x) => x.id === i.id) + 1} of ${same.length}`;
      names.set(i.id, b.endsWith(")") ? `${b.slice(0, -1)}, ${k})` : `${b} (${k})`);
    }
  }
  const id = useId();
  /** A card still waiting: listed by the service now, and not decided here (R319 a: only these are counted). */
  const isWaiting = (i: HeldItem) => waiting.has(i.id) && !ended[i.id];
  const group = (key: string, heading: string, list: HeldItem[]) =>
    list.length > 0 && (
      <section className="ao-review__group" aria-labelledby={`${id}-${key}`}>
        <h3 id={`${id}-${key}`} className="ao-review__group-title">
          {heading}
        </h3>
        <ul className="ao-review__files" aria-label={heading}>
          {list.map((i) => (
            <FileCard
              key={i.id}
              item={i}
              store={store}
              named={names.get(i.id)!}
              end={ended[i.id] ?? (waiting.has(i.id) ? undefined : "gone")}
              unread={!!i.sourceId && failed.has(i.sourceId)}
              notice={notices[i.id]}
              pointing={pointing}
              onPointedAt={onPointedAt}
              epoch={waiting}
              busy={busy[i.id]}
              error={errors[i.id]}
              headRef={headRef}
              cardRef={cardRef}
              onDecide={onDecide}
              onLook={onLook}
            />
          ))}
        </ul>
      </section>
    );
  return (
    <section className="ao-review__found" aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} ref={sectionRef} tabIndex={-1} className="ao-review__found-title">
        {FOUND_FILES_TEXT.section}
      </h2>
      <p className="ao-import__hint">{FOUND_FILES_TEXT.intro}</p>
      {/*
       * R319 c: the place kept for the line about files that arrived. Its height is set by a stand-in of the line that is
       * always laid out and never seen (hidden, inert, out of the accessibility tree), stacked in one grid cell with the
       * line itself: the line's appearing and going changes nothing below it.
       */}
      <div className="ao-review__arrivals">
        <p className="ao-review__ghost" aria-hidden="true" inert>
          <span>{FOUND_FILES_TEXT.arrived(99)}</span>
          <button type="button" tabIndex={-1}>
            {FOUND_FILES_TEXT.showThem}
          </button>
        </p>
        {arrived > 0 && (
          <p>
            <span>{FOUND_FILES_TEXT.arrived(arrived)}</span>
            <button type="button" onClick={onShowArrived}>
              {FOUND_FILES_TEXT.showThem}
            </button>
          </p>
        )}
      </div>
      {group("right", FOUND_FILES_TEXT.right(right.filter(isWaiting).length), right)}
      {group("other", FOUND_FILES_TEXT.other(other.filter(isWaiting).length), other)}
    </section>
  );
}

interface FileCardProps {
  item: HeldItem;
  store: RecordStore;
  /** How its controls name the record (R313 g). */
  named: string;
  /** The decision under way on this file. */
  busy: HeldFileDecision | undefined;
  /** The service's sentence when the last decision on this file was refused, or HELD_NO_ANSWER_TEXT. */
  error: string | undefined;
  /** R319: what became of this file — decided here, found already decided, or no longer listed; undefined while it waits. */
  end: FileEnd | "gone" | undefined;
  /** R322 b: its record could not be read. */
  unread: boolean;
  /** R323 b: a press on it that was not taken, shown under its controls. */
  notice: PressNotice | undefined;
  pointing: Pointing;
  onPointedAt(id: string): void;
  /** R322 a: new at every change of the queue the screen knows of (a re-render, so the card measures where it stands). */
  epoch: unknown;
  headRef(id: string, el: HTMLHeadingElement | null): void;
  cardRef(id: string, el: HTMLElement | null): void;
  onDecide(item: HeldItem, decision: HeldFileDecision, how: PressCheck): void;
  /** R470 b: "Look at the file" pressed (with the title its dialog shows). */
  onLook(item: HeldItem, title: string): void;
}

/** R322 b: the Creators and Year rows before the record is read, when it has none, and when it could not be read. */
export const RECORD_ROW_TEXT = { reading: "…", none: "—", unread: "This source's record could not be loaded." } as const;

/**
 * One waiting file: the record it was found for (title, creators, year — its source's, once read), the entry's own
 * sentence, what the app's check says (the service's words for its `why`; nothing when this build does not have it),
 * and the file's facts. Everything from the record, the file or the service is outside text (UserText). Its heading is
 * focusable (R313 a: focus comes here after a decision). Its two buttons: while its decision is out they are busy
 * (never disabled, so focus stays) and a press decides nothing (R318 a: the one pressed says "Using this file…" or
 * "Removing this file…" and looks busy, the other looks unavailable; R318 b: the press renews the quiet); R313 b — a key held down never decides: a repeated keydown
 * (Enter or Space) is cancelled, and so is the click a browser makes of it.
 */
const FileCard = memo(function FileCard({ item, store, named, end, unread, notice, pointing, onPointedAt, epoch, busy, error, headRef, cardRef, onDecide, onLook }: FileCardProps) {
  const h = item.heldFile;
  const record = useRecord(store, item.sourceId);
  const s = record?.source;
  const recordTitle = titleOf(record) || item.title || "";
  const creators = s ? creatorsText(s.creators) : "";
  const year = typeof s?.issued === "string" ? yearOf(s.issued) : undefined;
  const advice = adviceOf(h);
  /** R313 b, R322 a, R323 a, R327 b: the guards of its two controls (pressGuard.ts, shared with the panel, R362 d). */
  const guard = usePressGuard<HeldFileDecision>(pointing);
  // Re-rendered at every change of the queue the screen knows of (`epoch`), so the guard measures where it stands.
  void epoch;
  /** R323 b: the pointer moving over the card takes away the line saying a press was not taken. */
  const onCardPointerMove = (e: PointerEvent<HTMLLIElement>) => {
    if (notice && pointing.moved.has(e.nativeEvent)) onPointedAt(item.id);
  };
  const noticeId = `${useId()}-not-taken`;
  const describedBy = notice ? noticeId : undefined;
  // Every press goes to the screen, also while this file's decision is out: one that is not taken renews the quiet (R318 b).
  const press = (d: HeldFileDecision) => (e: MouseEvent<HTMLButtonElement>) => {
    const how = guard.check(d, e);
    if (how !== null) onDecide(item, d, how);
  };
  /** R318 a: the pressed control says it is working; its name still says which file. */
  const words = (d: HeldFileDecision) => (busy === d ? HELD_DECIDE_WORDS[d].working : HELD_DECIDE_WORDS[d].idle);
  return (
    <li className={end ? "ao-review__file ao-review__file--ended" : "ao-review__file"} ref={(el) => cardRef(item.id, el)} onPointerMove={onCardPointerMove}>
      <h4 className="ao-review__title ao-review__file-title" tabIndex={-1} ref={(el) => headRef(item.id, el)}>
        <UserText>{recordTitle || "Untitled"}</UserText>
      </h4>
      {/* R322 b: the rows have their place from the first showing: "…" while the record is being read (not known yet),
          "—" when the record has none, and the screen's sentence when it could not be read. */}
      <dl className="ao-review__fields">
        <dt>Creators</dt>
        <dd>{record ? creators ? <UserText>{creators}</UserText> : RECORD_ROW_TEXT.none : !item.sourceId ? RECORD_ROW_TEXT.none : unread ? RECORD_ROW_TEXT.unread : RECORD_ROW_TEXT.reading}</dd>
        <dt>Year</dt>
        <dd>{record ? year ? <UserText>{year}</UserText> : RECORD_ROW_TEXT.none : !item.sourceId || unread ? RECORD_ROW_TEXT.none : RECORD_ROW_TEXT.reading}</dd>
      </dl>
      {item.reasons[0] && <UserText as="p">{item.reasons[0]}</UserText>}
      <dl className="ao-review__fields">
        {advice && (
          <>
            <dt>What the app's check says</dt>
            <dd>{advice}</dd>
          </>
        )}
        {h?.fileDoi && (
          <>
            <dt>DOI the file names</dt>
            <dd>
              <UserText>{h.fileDoi}</UserText>
            </dd>
          </>
        )}
        {h?.embeddedTitle && (
          <>
            <dt>Title in the file</dt>
            <dd>
              <UserText>{h.embeddedTitle}</UserText>
            </dd>
          </>
        )}
        {h?.textStart && (
          <>
            <dt>Start of the file's text</dt>
            <dd>
              <UserText>{h.textStart}</UserText>
            </dd>
          </>
        )}
        {h && (
          <>
            <dt>File</dt>
            <dd>{`${h.kind === "epub" ? "EPUB" : "PDF"}, ${sizeText(h.bytes)}`}</dd>
          </>
        )}
      </dl>
      {end ? (
        // R319 a, b: the controls are replaced by what became of the file, in words, in the same place. A stand-in of
        // the two controls (hidden, inert, out of the accessibility tree, with no action) shares the grid cell, so the
        // card keeps its height and nothing below it moves.
        <div className="ao-review__file-act">
          <div className="ao-import__actions ao-review__ghost" aria-hidden="true" inert>
            <button type="button" className="ao-import__primary" tabIndex={-1}>
              {HELD_DECIDE_WORDS.attach.idle}
            </button>
            <button type="button" tabIndex={-1}>
              {HELD_DECIDE_WORDS.discard.idle}
            </button>
          </div>
          <p className="ao-review__file-outcome">
            {end === "gone" ? (
              FOUND_FILES_TEXT.gone
            ) : end === "already" ? (
              `${FOUND_FILES_TEXT.result.already}.`
            ) : (
              <>
                <span className="ao-review__file-mark">{FOUND_FILES_TEXT.decided}</span> {`${FOUND_FILES_TEXT.result[end]}.`}
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="ao-import__actions">
            <button
              type="button"
              className="ao-import__primary"
              aria-label={`${words("attach")} for ${named}`}
              aria-disabled={busy ? true : undefined}
              aria-busy={busy === "attach" || undefined}
              aria-describedby={describedBy}
              {...guard.bind("attach")}
              onClick={press("attach")}
            >
              {words("attach")}
            </button>
            <button
              type="button"
              aria-label={`${words("discard")} for ${named}`}
              aria-disabled={busy ? true : undefined}
              aria-busy={busy === "discard" || undefined}
              aria-describedby={describedBy}
              {...guard.bind("discard")}
              onClick={press("discard")}
            >
              {words("discard")}
            </button>
          </div>
        </>
      )}
      {/*
       * R470 b (FR-490): a found PDF can be looked at before the decision (its control after the two deciding ones, so that Tab from the card's heading still reaches “Use this file” first, R303 b), in the reader's look-only mode; an EPUB (the
       * reader shows PDFs only) says no preview can be shown. The line keeps its place once the file no longer waits (a
       * stand-in of the control, never seen), so nothing below it moves (R319).
       */}
      {h && (
        <div className="ao-review__file-look">
          {h.kind !== "pdf" ? (
            <p className="ao-import__hint">{NO_PREVIEW}</p>
          ) : end ? (
            <p className="ao-review__ghost" aria-hidden="true" inert>
              <button type="button" tabIndex={-1}>
                {LOOK_TEXT}
              </button>
            </p>
          ) : (
            <p>
              {/* R487 a (i): while this file's own decision is out, busy as its two deciding controls are (aria-disabled,
                  never disabled, so focus stays), and a press opens nothing. */}
              <button type="button" aria-label={`${LOOK_TEXT} for ${named}`} aria-disabled={busy ? true : undefined} onClick={() => busy || onLook(item, recordTitle || "Untitled")}>
                {LOOK_TEXT}
              </button>
            </p>
          )}
        </div>
      )}
      {/*
       * R322 b, R323 c: the line under the two controls — a refusal's or a give-up's sentence, and a press not taken
       * (R323 b: not an alert; the control is described by it while it is shown). Its place is kept on every card from
       * its first showing (two lines of the theme's text), so a sentence shown there moves nothing; a longer one may
       * still grow the card.
       */}
      <div className="ao-review__file-note">
        {!end && error && (
          <p role="alert" className="ao-error">
            {error === HELD_NO_ANSWER_TEXT ? (
              HELD_NO_ANSWER_TEXT
            ) : (
              <>
                The decision was not recorded. <UserText>{error}</UserText>
              </>
            )}
          </p>
        )}
        {!end && notice && (
          <p id={noticeId} className="ao-review__not-taken">
            {PRESS_SHOWN_TEXT[notice]}
          </p>
        )}
      </div>
    </li>
  );
});

/**
 * R470 b (FR-490): the held file in the app's reader, LOOK-ONLY, over the screen (the shared dialog shell: focus moves in
 * — to its heading, so the key that opened it decides nothing — is kept inside, and goes back to "Look at the file" when
 * it closes; the rest of the screen is inert). The reader reads the held file's own ranges and nothing else: no
 * highlight, no note, no annotation list, nothing remembered, nothing attached. Its line says what the file is.
 *
 * R487 a (ii): once the file no longer waits (`gone`: the queue says so) or is not found (the reader's "not found", at
 * once or in mid-look), the file is no longer shown — the reader goes, and with it every read of a range — and the line
 * says LOOK_GONE instead, said once: focus moves to it (as the reader moves focus to a changed state's heading; no live
 * region), and Shift+Tab from it is kept inside as from the heading. `onClose` is told whether the file had gone.
 */
function LookDialog({ title, projectId, sourceId, lookFor, reviewId, gone, onClose }: { title: string; projectId: string; sourceId: string; lookFor: LookFor; reviewId: string; gone: boolean; onClose(): void }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const [notFound, setNotFound] = useState(false);
  const ended = gone || notFound;
  const look = useMemo(() => lookFor(reviewId), [lookFor, reviewId]);
  const lookOnly = useMemo<LookOnly>(() => ({ range: look.range, onGone: () => setNotFound(true) }), [look]);
  useEffect(() => {
    if (ended) note.current?.focus();
  }, [ended]);
  const close = () => onClose();
  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={close} className="ao-review__look" initialFocus={ended ? note : heading}>
      <h2 id={`${id}-t`} ref={heading} tabIndex={-1}>
        {`${LOOK_TEXT}: `}
        <UserText>{title}</UserText>
      </h2>
      <p id={`${id}-d`} ref={note} tabIndex={ended ? -1 : undefined} className="ao-review__look-note">
        {ended ? LOOK_GONE : LOOK_ONLY_NOTICE}
      </p>
      {!ended && (
        <div className="ao-review__look-reader">
          <ReaderScreen api={look.api} projectId={projectId} sourceId={sourceId} readOnly look={lookOnly} />
        </div>
      )}
      <div className="ao-actions">
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * The reason for "Reviewed after the withdrawal" (R176 2) on the shared dialog shell (R145: focus in,
 * Tab and Shift+Tab kept inside, Escape closes when not saving, focus restored to the opener). The
 * reason is required and sent exactly as typed; a refusal is said in plain words and the dialog stays
 * open with the text.
 */
function WithdrawalReviewDialog({ onRecord, onCancel }: { onRecord(reason: string): Promise<boolean>; onCancel(): void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const savingRef = useRef(false);
  const ok = reason.trim() !== "" && !saving;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      // False: another action was still running and nothing was sent (fix round 1, M7).
      if (!(await onRecord(reason))) setError("Another action is still running, so this was not sent. Try again in a moment.");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The library service did not answer.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onCancel} busy={saving}>
      <h2 id={`${id}-t`}>Reviewed after the withdrawal</h2>
      <p id={`${id}-d`}>Record that you have reviewed this source after the participant's consent was withdrawn. This changes nothing else about the source.</p>
      <form onSubmit={(e) => void submit(e)}>
        <label className="ao-stack">
          Your reason (required; kept exactly as you type it)
          <textarea dir="auto" rows={4} value={reason} disabled={saving} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="ao-error">
            The decision was not recorded. {error}
          </p>
        )}
        <div className="ao-actions">
          <button type="submit" disabled={!ok} aria-busy={saving || undefined}>
            Record the decision
          </button>
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

interface RowProps {
  id: string;
  sourceId: string | undefined;
  n: number;
  store: RecordStore;
  /** The title when the record has none (or is not loaded): the one sent with the item, else "item n". */
  fallbackTitle: string;
  reason: string;
  current: boolean;
  /** Import entries can be selected for a bulk edit; verification entries cannot. */
  selectable: boolean;
  selected: boolean;
  broken: boolean;
  onToggle(id: string, on: boolean): void;
  onShow(id: string): void;
  onRetry(sourceId: string): void;
  showRef(id: string, el: HTMLButtonElement | null): void;
}

/** One queue row; re-renders only when its own props or its own record change (queues can hold thousands). */
const Row = memo(function Row({ id, sourceId, n, store, fallbackTitle, reason, current, selectable, selected, broken, onToggle, onShow, onRetry, showRef }: RowProps) {
  const t = titleOf(useRecord(store, sourceId)) || fallbackTitle;
  return (
    <li className={current ? "ao-review__row ao-review__row--current" : "ao-review__row"}>
      {selectable ? <input type="checkbox" aria-label={`Select ${t}`} checked={selected} onChange={(e) => onToggle(id, e.target.checked)} /> : <span className="ao-review__no-select" aria-hidden="true" />}
      <button type="button" className="ao-review__show" aria-label={`Show ${t}`} aria-pressed={current} ref={(el) => showRef(id, el)} onClick={() => onShow(id)}>
        <UserText className="ao-review__row-title">{t}</UserText>
        {broken ? <span className="ao-import__hint">Could not be loaded.</span> : <UserText className="ao-import__hint">{reason}</UserText>}
      </button>
      {broken && sourceId && (
        <button type="button" aria-label={`Retry loading item ${fmt(n)}`} onClick={() => onRetry(sourceId)}>
          Retry
        </button>
      )}
    </li>
  );
});

function BulkBar({ count: n, collections, tags, busy, onBulk }: { count: number; collections: Collection[]; tags: Tag[]; busy: boolean; onBulk(p: ReviewPatch, done: string): void }) {
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [collection, setCollection] = useState("");
  const off = busy || n === 0;
  const items = count(n, "item");
  return (
    <fieldset className="ao-review__bulk">
      <legend>{n ? `For the ${items} selected` : "Select items to edit them together"}</legend>
      <div className="ao-review__bulk-row">
        <label className="ao-import__field">
          <span>Set type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose a type</option>
            {SOURCE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={off || !type} onClick={() => onBulk({ type }, "Type set for")}>
          Apply type to {items}
        </button>
      </div>
      <div className="ao-review__bulk-row">
        <label className="ao-import__field">
          <span>Add tag</span>
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Choose a tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={off || !tag} onClick={() => onBulk({ tagIds: [tag] }, "Tag added to")}>
          Add tag to {items}
        </button>
      </div>
      <div className="ao-review__bulk-row">
        <label className="ao-import__field">
          <span>Move to collection</span>
          <select value={collection} onChange={(e) => setCollection(e.target.value)}>
            <option value="">Choose a collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={off || !collection} onClick={() => onBulk({ collectionId: collection }, "Moved")}>
          Move {items}
        </button>
      </div>
    </fieldset>
  );
}

interface ItemPanelProps {
  api: ReturnType<typeof importApi>;
  projectId: string;
  item: ReviewItem;
  source: SourceFile | undefined;
  loadFailed: boolean;
  onRetry(): void;
  collections: Collection[];
  tags: Tag[];
  flagTitle: boolean;
  /** True for a collection or tag id the batch made from a folder name (R64). */
  flagFolderNames(id: string): FolderFlag;
  busy: boolean;
  onDecide(d: ReviewDecision, done: string): void;
  /** Decision 31 (c): "Look up again" is under way for this entry. */
  lookingUp: boolean;
  /** Decision 31 (c): "Look up again" pressed; settles once the entry is shown as answered. */
  onLookUpAgain(): Promise<void>;
  /** A conflicting field's value chosen through the source screen's confirm (R149). */
  onConfirm(field: string, value: unknown): Promise<void>;
  pointing: Pointing;
  /** R362 d: new at every change of the list: the places the pointer was seen over the controls are forgotten. */
  epoch: unknown;
  /** R362 d: a press on a deciding control that was not taken, shown under the controls. */
  notice: PressNotice | undefined;
  /** R323 b: the pointer moved over the panel while it shows a press not taken. */
  onPointedAt(): void;
  /** R362 d: whether a press that reached a deciding control is taken (false: not taken, and said). */
  admit(how: PressCheck): boolean;
  /** R362 d: the entry's heading, where focus comes after a decision on the entry before it. */
  headRef(el: HTMLHeadingElement | null): void;
  /** R362 d: the panel's own heading, where focus comes while the entry's record is being read. */
  sectionRef(el: HTMLHeadingElement | null): void;
}

/** R362 d: what a deciding control of the panel is given: the guards' handlers, its description, its click. */
type Guarded = (key: string, act: () => void) => GuardedHandlers & { "aria-describedby": string | undefined; onClick(e: MouseEvent<HTMLButtonElement>): void };

/**
 * An import entry (an import's doubts, a field changed on both sides, a file added by hand). R362 d (D28): after a
 * decision the next entry is shown here in the place of the one decided, so every control that decides an entry —
 * Accept, Skip, Keep both, Merge into the likely duplicate, each candidate's Use this match, Save and accept, each
 * search result's Merge into — has the found files' guards (pressGuard.ts): a press by mouse only where the pointer
 * moved over the control since the list last changed, a tap only on a control that stood still, a held key never, and
 * none in the panel's quiet; a press not taken is said under the controls. A key press on a focused control (Tab, then
 * Enter or Space) decides as before, once per press.
 */
function ItemPanel({ api, projectId, item, source, loadFailed, onRetry, collections, tags, flagTitle, flagFolderNames, busy, onDecide, lookingUp, onLookUpAgain, onConfirm, pointing, epoch, notice, onPointedAt, admit, headRef, sectionRef }: ItemPanelProps) {
  const [mode, setMode] = useState<"view" | "edit" | "merge">("view");
  const lookUp = useLookUpOffer(item.lookUp);
  const lookUpRef = useRef<HTMLButtonElement>(null);
  const matchesHead = useRef<HTMLHeadingElement>(null);
  const [lookedUp, setLookedUp] = useState(0);
  // Answered, and the button has gone (nothing is left to look up): focus goes to the matches' heading, where the answer
  // is, never to the page. While the button stays (off, or ready again) focus stays on it.
  useEffect(() => {
    if (!lookedUp || lookUpRef.current) return;
    if (document.activeElement === null || document.activeElement === document.body) matchesHead.current?.focus();
  }, [lookedUp]);
  const pressLookUp = () => {
    if (!lookUp.ready || lookingUp || busy) return;
    void onLookUpAgain().then(() => setLookedUp((n) => n + 1));
  };
  const empty = !item.candidates?.length;
  const lookUpState = item.lookUp?.state;
  const guard = usePressGuard<string>(pointing, epoch);
  const noticeId = `${useId()}-not-taken`;
  const guarded: Guarded = (key, act) => ({
    ...guard.bind(key),
    "aria-describedby": notice ? noticeId : undefined,
    onClick: (e) => {
      const how = guard.check(key, e);
      // A held key's click, or a press not taken: nothing is decided (and a form is not sent).
      if (how === null || !admit(how)) {
        e.preventDefault();
        return;
      }
      act();
    },
  });
  const s = source?.source;
  const title = titleOf(source);
  const inCollections = (s?.collectionIds ?? []).map((id) => collections.find((c) => c.id === id)?.name ?? id);
  const itsTags = (s?.tagIds ?? []).map((id) => ({ id, index: tags.findIndex((t) => t.id === id) + 1, tag: tags.find((t) => t.id === id) }));
  const folderCollections = folderFlagOf(s?.collectionIds ?? [], flagFolderNames);
  const folderTags = folderFlagOf(s?.tagIds ?? [], flagFolderNames);

  return (
    <div className="ao-review__panel" onPointerMove={(e) => notice && pointing.moved.has(e.nativeEvent) && onPointedAt()}>
      <div className="ao-review__side-by-side">
        <Section title="Imported record" level={2} className="ao-review__record" headingRef={sectionRef}>
          {!source && !loadFailed && <p role="status">Loading…</p>}
          {!source && loadFailed && (
            <div className="ao-import__error" role="alert">
              <p>This item's record could not be loaded.</p>
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {source && s && (
            <>
              <h3 className="ao-review__title" tabIndex={-1} ref={headRef}>
                <UserText>{title || "Untitled"}</UserText>
              </h3>
              {flagTitle && (
                <p className="ao-import__warning">
                  This title was taken from the file name. File names can carry participants' names: check it before accepting, and edit it if it names someone.
                </p>
              )}
              <dl className="ao-review__fields">
                <dt>Type</dt>
                <dd>{typeLabel(s.type)}</dd>
                {s.creators.length > 0 && (
                  <>
                    <dt>Creators</dt>
                    <dd>
                      <UserText>{creatorsText(s.creators)}</UserText>
                    </dd>
                  </>
                )}
                {s.issued && (
                  <>
                    <dt>Date</dt>
                    <dd>{s.issued}</dd>
                  </>
                )}
                {s.publisher && (
                  <>
                    <dt>Publisher</dt>
                    <dd>
                      <UserText>{s.publisher}</UserText>
                    </dd>
                  </>
                )}
                {source.assets.length > 0 && (
                  <>
                    <dt>Files</dt>
                    <dd>
                      <ul className="ao-review__plain-list">
                        {source.assets.map((a) => (
                          <li key={a.id}>
                            <UserText>{assetName(a)}</UserText>
                            {(a.mime ?? a.mediaType) ? <span className="ao-import__hint"> ({a.mime ?? a.mediaType})</span> : null}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {inCollections.length > 0 && (
                  <>
                    <dt>Collections</dt>
                    <dd>
                      <ul className="ao-review__plain-list">
                        {inCollections.map((n, i) => (
                          <li key={`${n}-${i}`}>
                            <UserText>{n}</UserText>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {itsTags.length > 0 && (
                  <>
                    <dt>Tags</dt>
                    <dd>
                      <ul className="ao-review__plain-list ao-review__tags">
                        {itsTags.map((t) => (
                          <li key={t.id}>
                            <CodeSwatch index={t.index} name={t.tag?.name ?? t.id} {...(t.tag?.color ? { color: t.tag.color } : {})} />
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
              </dl>
              {folderCollections === "made" && (
                <p className="ao-import__warning">
                  These collection names come from folder names, which can carry participants' names. Check them, and rename the collection or move the item if one names someone.
                </p>
              )}
              {folderCollections === "unrecorded" && (
                <p className="ao-import__warning">
                  The app has no record of which collections this import made, so these collection names may come from folder names, which can carry participants' names. Check them, and rename the
                  collection or move the item if one names someone.
                </p>
              )}
              {folderTags === "made" && (
                <p className="ao-import__warning">
                  These tag names come from folder names, which can carry participants' names. Check them, and rename or remove a tag that names someone.
                </p>
              )}
              {folderTags === "unrecorded" && (
                <p className="ao-import__warning">
                  The app has no record of which tags this import made, so these tag names may come from folder names, which can carry participants' names. Check them, and rename or remove a tag that
                  names someone.
                </p>
              )}
              <FilePreview api={api} projectId={projectId} source={source} />
              <FieldsToCheck item={item} source={source} pointers={Object.keys(item.fields).filter((p) => item.fields[p] === "conflict")} onConfirm={onConfirm} />
            </>
          )}
          <Section title="Why it needs review" level={3}>
            <ul>
              {item.reasons.map((r, i) => (
                <li key={`${i}:${r}`}>
                  <UserText>{r}</UserText>
                </li>
              ))}
            </ul>
            {item.confidence !== undefined && (
              <p className="ao-import__hint">
                Confidence {Math.round(item.confidence * 100)}%{item.method ? `, from ${item.method}` : ""}
              </p>
            )}
            {item.hints && item.hints.length > 0 && (
              <p className="ao-import__hint">
                Found in the file but not confirmed:{" "}
                {item.hints.map((h, i) => (
                  <span key={`${i}:${h}`}>
                    {i > 0 ? ", " : ""}
                    <UserText>{h}</UserText>
                  </span>
                ))}
              </p>
            )}
            {item.duplicateOf && (
              <>
                <p>
                  May duplicate a source you already have: <UserText>{item.duplicateOf.reason}</UserText>
                </p>
                <button type="button" disabled={busy} {...guarded("duplicate", () => onDecide({ action: "merge", sourceId: item.duplicateOf!.sourceId }, "Merged"))}>
                  Merge into the likely duplicate
                </button>
              </>
            )}
            {/* Decision 31 (c): after the entry's reasons, before the candidates' accept buttons. Off (and still focusable,
                so focus is never lost) before the service's named time and while it runs. */}
            {lookUp.offered && (
              <p>
                <button
                  type="button"
                  ref={lookUpRef}
                  aria-disabled={!lookUp.ready || lookingUp || busy ? true : undefined}
                  aria-busy={lookingUp || undefined}
                  onClick={pressLookUp}
                >
                  {lookingUp ? LOOK_UP_AGAIN_TEXT.looking : lookUp.ready ? LOOK_UP_AGAIN_TEXT.act : lookUpAgainAfter(lookUpTime(lookUp.notBefore!))}
                </button>
              </p>
            )}
          </Section>
        </Section>

        <Section title="Candidate matches" level={2} className="ao-review__candidates" headingRef={matchesHead}>
          {/* R566 (8): "No candidate matches were found." only where a look-up was made and found nothing. */}
          {empty && (lookUpState === "waiting" || lookUpState === "gave-up") && <p className="ao-import__hint">{LOOK_UP_AGAIN_TEXT.notLookedUpYet}</p>}
          {empty && lookUpState === "failed" && <p className="ao-import__hint">{LOOK_UP_AGAIN_TEXT.notLookedUpFailed}</p>}
          {empty && (lookUpState === undefined || lookUpState === "nothing" || lookUpState === "found") && <p className="ao-import__hint">No candidate matches were found.</p>}
          {item.candidates && item.candidates.length > 0 && (
            <ol className="ao-review__candidate-list">
              {item.candidates.map((c, i) => (
                <CandidateRow key={i} c={c} busy={busy} guarded={guarded(`candidate:${i}`, () => onDecide({ action: "accept-candidate", index: i }, "Accepted the match"))} />
              ))}
            </ol>
          )}
        </Section>
      </div>

      <div className="ao-import__actions" role="group" aria-label="Decide this item">
        <button type="button" className="ao-import__primary" disabled={busy || !source} {...guarded("accept", () => onDecide({ action: "accept" }, "Accepted"))}>
          Accept
        </button>
        <button type="button" disabled={busy || !source} aria-expanded={mode === "edit"} onClick={() => setMode(mode === "edit" ? "view" : "edit")}>
          Edit
        </button>
        <button type="button" disabled={busy} aria-expanded={mode === "merge"} onClick={() => setMode(mode === "merge" ? "view" : "merge")}>
          Merge
        </button>
        <button type="button" disabled={busy} {...guarded("skip", () => onDecide({ action: "skip" }, "Skipped"))}>
          Skip
        </button>
        <button type="button" disabled={busy} {...guarded("keep-both", () => onDecide({ action: "keep-both" }, "Kept both"))}>
          Keep both
        </button>
      </div>
      {/* R362 d (R323 b, R322 b): a press not taken, said under the controls; its place is kept, so its coming moves nothing. */}
      <div className="ao-review__file-note">
        {notice && (
          <p id={noticeId} className="ao-review__not-taken">
            {PRESS_SHOWN_TEXT_ENTRY[notice]}
          </p>
        )}
      </div>

      {mode === "edit" && source && <EditForm source={source} busy={busy} guarded={guarded("save", () => {})} onCancel={() => setMode("view")} onSave={(d) => onDecide(d, "Saved and accepted")} />}
      {mode === "merge" && <MergeForm api={api} projectId={projectId} item={item} busy={busy} guarded={guarded} onMerge={(sid) => onDecide({ action: "merge", sourceId: sid }, "Merged")} />}
    </div>
  );
}

/** R585 (3): how often, and how many times, an entry another look-up is working on is read again. */
export const LOOK_UP_RECHECK_MS = 1_000;
const LOOK_UP_RECHECKS = 30;

/** The longest wait a timer can be given (about 24.8 days); a later time is looked at again then. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Decision 31 (c): whether "Look up again" is offered for an entry and whether it may be pressed now. Offered while some
 * lookup is left to ask (now, or from its time on); ready when the service says the act may send now, or once the time it
 * named has come (the button turns ready by itself then).
 */
function useLookUpOffer(l: ReviewLookUp | undefined): { offered: boolean; ready: boolean; notBefore?: string } {
  const [now, setNow] = useState(() => Date.now());
  const at = l?.notBefore ? Date.parse(l.notBefore) : Number.NaN;
  const waiting = !!l && !l.canLookUpNow && at > now;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now()) + 50));
    return () => clearTimeout(t);
  }, [waiting, at, now]);
  if (!l || (!l.canLookUpNow && !l.notBefore)) return { offered: false, ready: false };
  return { offered: true, ready: !waiting, ...(l.notBefore ? { notBefore: l.notBefore } : {}) };
}

function CandidateRow({ c, busy, guarded }: { c: Candidate; busy: boolean; guarded: ReturnType<Guarded> }) {
  const ids = [c.identifiers?.doi ? `DOI ${c.identifiers.doi}` : "", ...(c.identifiers?.isbn ?? []).map((i) => `ISBN ${i}`), c.identifiers?.issn ? `ISSN ${c.identifiers.issn}` : ""].filter(Boolean);
  return (
    <li className="ao-review__candidate">
      <UserText as="p" className="ao-review__title">
        {c.title}
      </UserText>
      <p className="ao-import__hint">
        {[c.creators.length ? creatorsText(c.creators) : "", c.issued ?? "", c.container ?? c.publisher ?? "", typeLabel(c.type)].filter(Boolean).map((x, i) => (
          <span key={i}>
            {i > 0 ? " · " : ""}
            <UserText>{x}</UserText>
          </span>
        ))}
      </p>
      {ids.length > 0 && <p className="ao-import__hint">{ids.join(" · ")}</p>}
      <p className="ao-import__hint">From {c.provider}</p>
      <button type="button" disabled={busy} {...guarded}>
        Use this match<span className="ao-visually-hidden">: {c.title}</span>
      </button>
    </li>
  );
}

function EditForm({ source, busy, guarded, onCancel, onSave }: { source: SourceFile; busy: boolean; guarded: ReturnType<Guarded>; onCancel(): void; onSave(d: ReviewDecision): void }) {
  const s = source.source;
  const variants = s.title.variants;
  const at = Math.max(0, variants.findIndex((v) => v.kind === "original"));
  const [title, setTitle] = useState(variants[at]?.value ?? "");
  const [type, setType] = useState(s.type);
  const save = () => {
    const next = variants.length ? variants.map((v, i) => (i === at ? { ...v, value: title } : v)) : [{ lang: "und", kind: "original" as const, value: title }];
    onSave({ action: "accept", draft: { type, title: { variants: next } } });
  };
  return (
    <form
      className="ao-review__form"
      aria-label="Edit before accepting"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="ao-import__field ao-import__field--wide">
        <span>Title</span>
        <input type="text" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="ao-import__field">
        <span>Type</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {SOURCE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="ao-import__actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {/* R362 d: its click (also the one Enter in the title makes) is guarded; a press not taken does not send the form. */}
        <button type="submit" className="ao-import__primary" disabled={busy || !title.trim()} {...guarded}>
          Save and accept
        </button>
      </div>
    </form>
  );
}

function MergeForm({ api, projectId, item, busy, guarded, onMerge }: { api: ReturnType<typeof importApi>; projectId: string; item: ReviewItem; busy: boolean; guarded: Guarded; onMerge(sourceId: string): void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<SourceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  /** Only the answer to the latest search is shown, whatever order the answers arrive in. */
  const search = async () => {
    const n = ++latest.current;
    setError(null);
    try {
      const found = (await api.searchSources(projectId, text.trim())).filter((r) => r.id !== item.sourceId);
      if (n === latest.current) setResults(found);
    } catch (e) {
      if (n === latest.current) setError(errorText(e));
    }
  };
  return (
    <div className="ao-review__form">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="ao-import__field ao-import__field--wide">
          <span>Find the source to merge into</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="submit" disabled={!text.trim()}>
          Search
        </button>
      </form>
      <ErrorNote error={error} />
      {results && results.length === 0 && <p>No sources match.</p>}
      {results && results.length > 0 && (
        <ul className="ao-review__plain-list">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" disabled={busy} {...guarded(`merge:${r.id}`, () => onMerge(r.id))}>
                Merge into <UserText>{r.title}</UserText>
              </button>
              <span className="ao-import__hint"> ({typeLabel(r.type)})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
