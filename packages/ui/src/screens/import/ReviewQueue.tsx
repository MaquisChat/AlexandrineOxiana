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
 * files found (N)"); a group with no file is not shown. One file's decision under way leaves the others usable. After
 * a decision focus goes to the next waiting file's "Use this file" (in the same group, else the first of the other
 * group), else to the queue's heading, or to the message that nothing is waiting.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
  type ReviewPatch,
  type SourceFile,
  type SourceListItem,
  type Tag,
} from "../../api/import";
import {
  HELD_FILE_WHY_TEXT,
  PROJECT_REVIEW_PAGE_MAX,
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
import { DialogShell } from "../../components/ReasonDialog";
import { UserText } from "../../components/UserText";
import { FieldCheck } from "../../components/VerificationBadge";
import { inAppLink, PATHS } from "../../navigation";
import { FIELD_LABELS } from "../SourceDetail";
import { UnlockProject } from "../UnlockProject";
import { assetName, FilePreview } from "./FilePreview";
import { count, ErrorNote, errorText, fmt, reportHref, Section, SOURCE_TYPES, typeLabel } from "./shared";
import "./import.css";

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

/**
 * R313 c: for this long after a waiting file leaves the list (or the list is read again and its cards move), no
 * "Use this file" or "Not this file" acts — by key or by pointer. The card that takes a decided file's place lies under
 * the same pointer, and a second press meant for the file that has just gone would otherwise fall on one the
 * researcher has not looked at. Long enough for a double click or a quick second key press; short enough not to slow
 * deliberate work. The controls are not shown disabled for it: they simply do not act.
 */
export const DECIDE_SETTLE_MS = 600;

/** R313 e: a decision on a waiting file with no answer in this long is given up (the request aborted). */
export const HELD_DECISION_TIMEOUT_MS = 60_000;
/** R313 e: said on the card when a decision was given up. */
export const HELD_NO_ANSWER_TEXT = "The service did not answer. Look at the queue again before deciding.";

/** Entries per page when the project's whole queue is read. */
export const PROJECT_PAGE = 500;

/** What the batch made from folder names (R64): the collections and tags it reports it created (R118). */
function madeByBatch(id: string, batch: BatchSummary | undefined): boolean {
  if (!batch?.created || !FOLDER_KINDS.has(batch.kind)) return false;
  return batch.created.collectionIds.includes(id) || batch.created.tagIds.includes(id);
}

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
  const projectWide = !batchId;
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [store, setStore] = useState(recordStore);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  /** Read by each answer: clearing a failure that is not there would re-render the whole queue. */
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const batch = batchId ? batches.find((b) => b.batchId === batchId) : undefined;
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** The polite region's words; a new `n` is a new node, so the same words twice are said twice (R313 g). */
  const [said, setSaid] = useState({ text: "", n: 0 });
  const setStatus = useCallback((text: string) => setSaid((cur) => ({ text, n: cur.n + 1 })), []);
  const [focusId, setFocusId] = useState<{ id: string | null } | null>(null);
  /** Waiting files (F11, R303): the decision under way on each, the service's sentence for a refused one, where focus goes after one. */
  const [heldBusy, setHeldBusy] = useState<Readonly<Record<string, HeldFileDecision>>>({});
  const heldBusyRef = useRef(new Set<string>());
  const [heldErrors, setHeldErrors] = useState<Readonly<Record<string, string>>>({});
  const [fileFocus, setFileFocus] = useState<{ to: string } | null>(null);

  /** The project's queue is locked (PROJECT_LOCKED): nothing of it is shown until it is unlocked here. */
  const [locked, setLocked] = useState(false);
  const [projectName, setProjectName] = useState("This project");
  /** Moved on by an unlock: the queue is read again. */
  const [readKey, setReadKey] = useState(0);
  /** Moved on by another project, a lock and unmounting: answers of an older generation are dropped. */
  const gen = useRef(0);
  const showButtons = useRef(new Map<string, HTMLButtonElement>());
  const title = useRef<HTMLHeadingElement>(null);
  /** Each waiting file's heading (R313 a: focus goes there after a decision) and its card. */
  const fileHeads = useRef(new Map<string, HTMLHeadingElement>());
  const fileCards = useRef(new Map<string, HTMLElement>());
  /** R313 c: until this time (Date.now()) no deciding control acts. */
  const quietUntil = useRef(0);
  /** R313 e: after a decision was given up and the queue read again, focus goes back to that file's heading. */
  const refocusAfterRead = useRef<string | null>(null);
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

  /** The project was locked: everything read from it is forgotten, and the unlock form shown. */
  const forget = useCallback(() => {
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
    // R313 c: a list read again moves its cards; the first read only shows them.
    const reread = !!itemsRef.current?.some(isFound);
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
        if (reread && list.some(isFound)) quietUntil.current = Date.now() + DECIDE_SETTLE_MS;
        setItems(list);
        const back = refocusAfterRead.current;
        refocusAfterRead.current = null;
        if (back) setFileFocus({ to: list.some((i) => i.id === back) ? back : ":title" });
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
    api.batches(projectId).then((b) => ok() && setBatches(b), () => {});
    return () => {
      live = false;
      p.live = false;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      arrived.current = new Map();
    };
  }, [api, projectId, batchId, sourceId, pageSize, pump, locked, readKey, forget]);
  // Unmounting moves the generation on: a decision answered after the screen closed changes nothing.
  useEffect(() => () => void gen.current++, []);

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

  // After a decision, focus moves to the next item's row (or the heading when none is left).
  useEffect(() => {
    if (!focusId) return;
    const el = focusId.id ? showButtons.current.get(focusId.id) : undefined;
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
  /** A waiting file left the queue: the next waiting file (the same group, else the other), else the heading or the empty message. */
  const fileLeft = (item: ReviewItem, said: (n: number) => string) => {
    const list = itemsRef.current ?? [];
    const at = list.findIndex((x) => x.id === item.id);
    if (at < 0) return;
    // Focus moves only when it was on this file (or nowhere): a researcher already at another file keeps their place.
    const active = document.activeElement;
    const card = fileCards.current.get(item.id);
    const hadFocus = !active || active === document.body || (!!card && card.contains(active));
    const found = list.filter(isFound);
    const mine = found.filter((x) => looksRight(x) === looksRight(item));
    const theirs = found.filter((x) => looksRight(x) !== looksRight(item));
    const k = mine.findIndex((x) => x.id === item.id);
    const restMine = mine.filter((x) => x.id !== item.id);
    const next = restMine[Math.min(k, restMine.length - 1)] ?? theirs[0];
    const rest = list.filter((x) => x.id !== item.id);
    itemsRef.current = rest;
    // R313 c: the next card now lies where this one was; a press meant for this one must not fall on it.
    quietUntil.current = Date.now() + DECIDE_SETTLE_MS;
    setItems(rest);
    setSelected((s) => s.filter((x) => x !== item.id));
    setStatus(said(at + 1));
    if (hadFocus) setFileFocus({ to: next ? next.id : rest.length ? ":title" : ":empty" });
  };
  useEffect(() => {
    if (!fileFocus) return;
    const t = fileFocus.to;
    // R313 a: a waiting file's heading, never a control that decides.
    const el = t === ":empty" ? emptyNote.current : t === ":title" ? title.current : (fileHeads.current.get(t) ?? title.current);
    el?.focus();
  }, [fileFocus]);
  const decideHeld = async (item: ReviewItem, decision: HeldFileDecision) => {
    // R313 c: just after a file left (or the list was read again) a press does nothing at all.
    if (Date.now() < quietUntil.current) return;
    if (heldBusyRef.current.has(item.id)) return;
    heldBusyRef.current.add(item.id);
    const g = gen.current;
    setHeldBusy((cur) => ({ ...cur, [item.id]: decision }));
    setHeldErrors((cur) => withoutKey(cur, item.id));
    // R313 e: no answer in HELD_DECISION_TIMEOUT_MS: the request is aborted, the card usable again and saying so, and
    // the queue read again (the decision may or may not have been recorded); its late answer changes nothing.
    const abort = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      abort.abort();
      heldBusyRef.current.delete(item.id);
      setHeldBusy((cur) => withoutKey(cur, item.id));
      setHeldErrors((cur) => ({ ...cur, [item.id]: HELD_NO_ANSWER_TEXT }));
      const active = document.activeElement;
      const card = fileCards.current.get(item.id);
      if (!active || active === document.body || (!!card && card.contains(active))) refocusAfterRead.current = item.id;
      setReadKey((k) => k + 1);
    }, HELD_DECISION_TIMEOUT_MS);
    try {
      const body: HeldFileDecisionRequest = { projectId, decision };
      await client.request<HeldFileDecisionResponse>("POST", `/review/${encodeURIComponent(item.id)}/held-file`, { body, signal: abort.signal });
      if (late || g !== gen.current) return;
      fileLeft(item, (n) => `${decision === "attach" ? "File added to its record" : "File removed; the record keeps no file"}: ${titleFor(item, n)}`);
    } catch (e) {
      if (late || g !== gen.current) return;
      if (isProjectLocked(e)) {
        forget();
        return;
      }
      // R282 d: the entry leaves only when the service says it was already decided; any other refusal (paused, the
      // record gone, …) is said in the service's sentence and the entry stays.
      if (e instanceof ApiClientError && e.code === "CONFLICT" && e.reason === ("already-decided" satisfies HeldFileRefusalReason)) {
        fileLeft(item, (n) => `This entry had already been decided, so it left the queue: ${titleFor(item, n)}`);
        return;
      }
      setHeldErrors((cur) => ({ ...cur, [item.id]: e instanceof ApiClientError && e.message ? e.message : errorText(e) }));
    } finally {
      clearTimeout(timer);
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
  const found = useMemo(() => (projectWide ? ((items ?? []).filter(isFound) as HeldItem[]) : []), [items, projectWide]);
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
      <p className="ao-visually-hidden" role="status">
        {said.text && <span key={said.n}>{said.text}</span>}
      </p>
      {locked && (
        <UnlockProject
          api={libApi}
          project={{ id: projectId, name: projectName }}
          onUnlocked={() => {
            setLocked(false);
            setReadKey((k) => k + 1);
          }}
        />
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
              flagFolderNames={flagging ? (id: string) => madeByBatch(id, itemBatch(item)) : () => false}
              busy={busy}
              onDecide={(d, done) => void decide(item, d, done)}
              onConfirm={(field, value) => confirmField(item, field, value)}
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
            />
          )}
        </div>
      )}
      {!locked && items !== null && found.length > 0 && (
        <FoundFiles items={found} store={store} busy={heldBusy} errors={heldErrors} headRef={headRefFor} cardRef={cardRefFor} onDecide={(i, d) => void decideHeld(i, d)} />
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
}

/**
 * A verification entry (R176): a capture saved with fields to check (each field's badge and its
 * evidence dialog, the source screen's own confirm, R149; confirming the last one resolves the entry
 * in the library), or a source flagged after a consent withdrawal ("Reviewed after the withdrawal",
 * with a reason).
 */
function VerificationPanel({ item, source, loadFailed, onRetry, onConfirm, onReview, busy }: VerificationPanelProps) {
  const s = source?.source;
  const withdrawal = groupOf(item) === "withdrawal";
  const [reviewing, setReviewing] = useState(false);
  return (
    <div className="ao-review__panel">
      <Section title={withdrawal ? "Flagged source" : "Captured source"} level={2} className="ao-review__record">
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
            <UserText as="p" className="ao-review__title">
              {titleOf(source) || "Untitled"}
            </UserText>
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
} as const;

interface FoundFilesProps {
  items: HeldItem[];
  store: RecordStore;
  busy: Readonly<Record<string, HeldFileDecision>>;
  errors: Readonly<Record<string, string>>;
  headRef(id: string, el: HTMLHeadingElement | null): void;
  cardRef(id: string, el: HTMLElement | null): void;
  onDecide(item: HeldItem, decision: HeldFileDecision): void;
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
 */
function FoundFiles({ items, store, busy, errors, headRef, cardRef, onDecide }: FoundFilesProps) {
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
  const group = (key: string, heading: string, list: HeldItem[]) =>
    list.length > 0 && (
      <section className="ao-review__group" aria-labelledby={`${id}-${key}`}>
        <h3 id={`${id}-${key}`} className="ao-review__group-title">
          {heading}
        </h3>
        <ul className="ao-review__files" aria-label={heading}>
          {list.map((i) => (
            <FileCard key={i.id} item={i} store={store} named={names.get(i.id)!} busy={busy[i.id]} error={errors[i.id]} headRef={headRef} cardRef={cardRef} onDecide={onDecide} />
          ))}
        </ul>
      </section>
    );
  return (
    <section className="ao-review__found" aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`}>{FOUND_FILES_TEXT.section}</h2>
      <p className="ao-import__hint">{FOUND_FILES_TEXT.intro}</p>
      {group("right", FOUND_FILES_TEXT.right(right.length), right)}
      {group("other", FOUND_FILES_TEXT.other(other.length), other)}
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
  headRef(id: string, el: HTMLHeadingElement | null): void;
  cardRef(id: string, el: HTMLElement | null): void;
  onDecide(item: HeldItem, decision: HeldFileDecision): void;
}

/**
 * One waiting file: the record it was found for (title, creators, year — its source's, once read), the entry's own
 * sentence, what the app's check says (the service's words for its `why`; nothing when this build does not have it),
 * and the file's facts. Everything from the record, the file or the service is outside text (UserText). Its heading is
 * focusable (R313 a: focus comes here after a decision). Its two buttons: while its decision is out they are busy
 * (never disabled, so focus stays) and a press does nothing; R313 b — a key held down never decides: a repeated keydown
 * (Enter or Space) is cancelled, and so is the click a browser makes of it.
 */
const FileCard = memo(function FileCard({ item, store, named, busy, error, headRef, cardRef, onDecide }: FileCardProps) {
  const h = item.heldFile;
  const record = useRecord(store, item.sourceId);
  const s = record?.source;
  const recordTitle = titleOf(record) || item.title || "";
  const creators = s ? creatorsText(s.creators) : "";
  const year = typeof s?.issued === "string" ? yearOf(s.issued) : undefined;
  const advice = adviceOf(h);
  /** A repeated keydown was seen and not yet let go: the click it makes is not a press (R313 b). */
  const repeating = useRef(false);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.repeat) {
      e.preventDefault();
      repeating.current = true;
    } else repeating.current = false;
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Space makes its click on keyup, after this: a held Space still presses once, when it is let go.
    if (e.key === "Enter" || e.key === " ") repeating.current = false;
  };
  const press = (d: HeldFileDecision) => () => {
    if (repeating.current) return;
    if (!busy) onDecide(item, d);
  };
  return (
    <li className="ao-review__file" ref={(el) => cardRef(item.id, el)}>
      <h4 className="ao-review__title ao-review__file-title" tabIndex={-1} ref={(el) => headRef(item.id, el)}>
        <UserText>{recordTitle || "Untitled"}</UserText>
      </h4>
      {(creators || year) && (
        <dl className="ao-review__fields">
          {creators && (
            <>
              <dt>Creators</dt>
              <dd>
                <UserText>{creators}</UserText>
              </dd>
            </>
          )}
          {year && (
            <>
              <dt>Year</dt>
              <dd>
                <UserText>{year}</UserText>
              </dd>
            </>
          )}
        </dl>
      )}
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
      {error && (
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
      <div className="ao-import__actions">
        <button
          type="button"
          className="ao-import__primary"
          aria-label={`Use this file for ${named}`}
          aria-disabled={busy ? true : undefined}
          aria-busy={busy === "attach" || undefined}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onClick={press("attach")}
        >
          Use this file
        </button>
        <button
          type="button"
          aria-label={`Not this file for ${named}`}
          aria-disabled={busy ? true : undefined}
          aria-busy={busy === "discard" || undefined}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onClick={press("discard")}
        >
          Not this file
        </button>
      </div>
    </li>
  );
});

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
  flagFolderNames(id: string): boolean;
  busy: boolean;
  onDecide(d: ReviewDecision, done: string): void;
  /** A conflicting field's value chosen through the source screen's confirm (R149). */
  onConfirm(field: string, value: unknown): Promise<void>;
}

function ItemPanel({ api, projectId, item, source, loadFailed, onRetry, collections, tags, flagTitle, flagFolderNames, busy, onDecide, onConfirm }: ItemPanelProps) {
  const [mode, setMode] = useState<"view" | "edit" | "merge">("view");
  const s = source?.source;
  const title = titleOf(source);
  const inCollections = (s?.collectionIds ?? []).map((id) => collections.find((c) => c.id === id)?.name ?? id);
  const itsTags = (s?.tagIds ?? []).map((id) => ({ id, index: tags.findIndex((t) => t.id === id) + 1, tag: tags.find((t) => t.id === id) }));
  const folderCollections = (s?.collectionIds ?? []).some(flagFolderNames);
  const folderTags = (s?.tagIds ?? []).some(flagFolderNames);

  return (
    <div className="ao-review__panel">
      <div className="ao-review__side-by-side">
        <Section title="Imported record" level={2} className="ao-review__record">
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
              <UserText as="p" className="ao-review__title">
                {title || "Untitled"}
              </UserText>
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
              {folderCollections && (
                <p className="ao-import__warning">
                  These collection names come from folder names, which can carry participants' names. Check them, and rename the collection or move the item if one names someone.
                </p>
              )}
              {folderTags && (
                <p className="ao-import__warning">
                  These tag names come from folder names, which can carry participants' names. Check them, and rename or remove a tag that names someone.
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
                <button type="button" disabled={busy} onClick={() => onDecide({ action: "merge", sourceId: item.duplicateOf!.sourceId }, "Merged")}>
                  Merge into the likely duplicate
                </button>
              </>
            )}
          </Section>
        </Section>

        <Section title="Candidate matches" level={2} className="ao-review__candidates">
          {!item.candidates?.length && <p className="ao-import__hint">No candidate matches were found.</p>}
          {item.candidates && item.candidates.length > 0 && (
            <ol className="ao-review__candidate-list">
              {item.candidates.map((c, i) => (
                <CandidateRow key={i} c={c} busy={busy} onUse={() => onDecide({ action: "accept-candidate", index: i }, "Accepted the match")} />
              ))}
            </ol>
          )}
        </Section>
      </div>

      <div className="ao-import__actions" role="group" aria-label="Decide this item">
        <button type="button" className="ao-import__primary" disabled={busy || !source} onClick={() => onDecide({ action: "accept" }, "Accepted")}>
          Accept
        </button>
        <button type="button" disabled={busy || !source} aria-expanded={mode === "edit"} onClick={() => setMode(mode === "edit" ? "view" : "edit")}>
          Edit
        </button>
        <button type="button" disabled={busy} aria-expanded={mode === "merge"} onClick={() => setMode(mode === "merge" ? "view" : "merge")}>
          Merge
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide({ action: "skip" }, "Skipped")}>
          Skip
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide({ action: "keep-both" }, "Kept both")}>
          Keep both
        </button>
      </div>

      {mode === "edit" && source && <EditForm source={source} busy={busy} onCancel={() => setMode("view")} onSave={(d) => onDecide(d, "Saved and accepted")} />}
      {mode === "merge" && <MergeForm api={api} projectId={projectId} item={item} busy={busy} onMerge={(sid) => onDecide({ action: "merge", sourceId: sid }, "Merged")} />}
    </div>
  );
}

function CandidateRow({ c, busy, onUse }: { c: Candidate; busy: boolean; onUse(): void }) {
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
      <button type="button" disabled={busy} onClick={onUse}>
        Use this match<span className="ao-visually-hidden">: {c.title}</span>
      </button>
    </li>
  );
}

function EditForm({ source, busy, onCancel, onSave }: { source: SourceFile; busy: boolean; onCancel(): void; onSave(d: ReviewDecision): void }) {
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
        <button type="submit" className="ao-import__primary" disabled={busy || !title.trim()}>
          Save and accept
        </button>
      </div>
    </form>
  );
}

function MergeForm({ api, projectId, item, busy, onMerge }: { api: ReturnType<typeof importApi>; projectId: string; item: ReviewItem; busy: boolean; onMerge(sourceId: string): void }) {
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
              <button type="button" disabled={busy} onClick={() => onMerge(r.id)}>
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
