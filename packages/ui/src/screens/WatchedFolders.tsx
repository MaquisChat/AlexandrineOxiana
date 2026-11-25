/**
 * "Watched folders" (Task W8; R207, R219, R221, R233, R234; Amendment A9): the folders of a project —
 * typically inside Google Drive, OneDrive or Dropbox — whose new files are copied into the project by
 * themselves. The screen adds a folder only through the shell's own folder chooser
 * (`pickWatchFolder`): the page never holds, shows or sends a path of its own; the chooser gives a
 * single-use grant id and the folder's name, and the grant goes to the service once (a refused
 * request spends it too, R233 d, so a refusal offers the chooser again, never a second try).
 *
 * The service is the authority, and it gives the order (R241). Every summary — from the list, an
 * answer to an act, or a `watch.status` event — carries the service's `seq`, a number drawn when it
 * was read; the screen keeps, for each folder, the summary with the highest number it has seen,
 * whatever arrived last. A folder a list does not hold goes only if the list is the later reading; a
 * folder removed here never comes back. The result of an act is said from the act's own answer.
 *
 * Downloads happen only by an explicit agreement to a size the service reported (R219, R221): the
 * dialog names the number and size, sends exactly that number as `confirmBytes`, and on a 409 says
 * the service's sentence and asks again with the new size. The radio group shows the choice the
 * service reports, not the last click.
 *
 * One polite live region speaks only a change of a folder's state word, and the results of the
 * researcher's own acts once; each text is a new node, so the same result twice is said twice. While
 * a dialog is open the page is inert, so what is said then goes to the dialog's own polite region,
 * and the result of an act made in a dialog is said in the page's region once it has closed. When the
 * control that had focus goes away (its state passed), focus goes to its folder's heading (R145). Every name from a folder, a file, a collection or the service's reasons
 * is outside text: through UserText (dir="auto"), never as markup. Dialogs move focus in, trap it,
 * restore it and make the background inert (DialogShell, R145).
 */
import type { WatchedFolderFileItem, WatchedFolderSummary, WatchFolderState } from "@ao/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type Ref } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, readWithin } from "../api/firstRead";
import { isProjectLocked, libraryApi, type Collection, type LibraryState, type ProjectSummary } from "../api/library";
import { formatSize } from "../api/tools";
import { watchedFoldersApi, watchStatusOf } from "../api/watchedFolders";
import { DialogShell } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import "../components/library.css";
import { desktopShell } from "../desktopShell";
import { projectInQuery, type AppLocation } from "../navigation";
import { SourceDetail } from "./SourceDetail";
import { UnlockProject } from "./UnlockProject";
import "./GovernanceScreens.css";
import "./WatchedFolders.css";

/** The state words (the plan's five, and "stopped" as "Not watched", A9). */
export const STATE_WORDS: Record<WatchFolderState, string> = {
  watching: "Watching",
  paused: "Paused",
  unreachable: "Cannot be reached",
  locked: "Waiting for the project to be unlocked",
  "not-set-up": "Not set up on this Mac",
  stopped: "Not watched",
};

export const WATCH_TEXT = {
  intro: "Files put in these folders are copied into this project by themselves while the app is open. The app only reads them: it never changes, moves or deletes anything in a folder.",
  needsApp: "Adding a folder needs the desktop app.",
  noProject: "Open a project in the library first, then choose “Watched folders”.",
  readOnly: "This library is open read-only, so watched folders cannot be added, changed or removed here.",
  none: "No folder is watched in this project yet.",
  loading: "Reading the watched folders…",
  scanning: " — looking through the folder…",
  removeBody: "Nothing already in the library is removed, and nothing in the folder is touched.",
  firstOnly: "The list holds the first 5,000 files of each kind; the counts above are of all files.",
  noFiles: "No files to list.",
  unnamed: "Unnamed folder",
  chooserTitle: "Choose a folder to watch",
  /** The service's own sentence (W7's WATCH_ROUTE_TEXT.nothing): said instead of offering an agreement to nothing (M5). */
  nothingToDownload: "There is nothing to download in this folder at the moment.",
  /** R221 b: files of unknown size are never fetched under an agreement. */
  sizesUnknown: "The size of these files is not known until they are downloaded, so they are left for you to download yourself.",
  noLibrary: "No library is open. Open one from the library to see its watched folders.",
  listChanged: "The list changed while it was being read, so files may have moved between pages. Hide the list and show it again to read it afresh.",
} as const;

/** The service's reason for every folder of a read-only library (W7's WATCH_ROUTE_TEXT.readOnly): the screen says it once, above (M7). */
const SERVICE_READ_ONLY = "This library is open read-only, so no folder is watched.";

/** The most files the service keeps per kind (W2's WATCH_PROBLEMS_MAX): `total` is capped there, the counts are not (A9). */
const KIND_CAP = 5000;
const PAGE = 200;
const RECONNECT_MS = 2000;

const num = (n: number) => n.toLocaleString("en-US");
const files = (n: number) => (n === 1 ? "1 file" : `${num(n)} files`);
/** Ends a sentence: no full stop after an ellipsis. */
const end = (s: string) => (s.endsWith("…") || s.endsWith(".") ? s : `${s}.`);

export const labelOf = (f: Pick<WatchedFolderSummary, "label" | "place">): string => f.label ?? f.place?.display ?? WATCH_TEXT.unnamed;
const wordOf = (f: WatchedFolderSummary) => STATE_WORDS[f.state] ?? f.state;
/** The state word, with the first look through the folder said beside it (A9). */
export const stateLine = (f: WatchedFolderSummary) => `${wordOf(f)}${f.scanning ? WATCH_TEXT.scanning : ""}`;

/** The count lines, only those that are not zero (the plan's exact words). */
function countLines(f: WatchedFolderSummary): string[] {
  const c = f.counts;
  const out: string[] = [];
  if (c.cameIn) out.push(`${files(c.cameIn)} came in`);
  // FR-476: a file whose content is already in the project (a same-content conflict copy, say) is counted and said.
  if (c.alreadyInLibrary) out.push(`${files(c.alreadyInLibrary)} ${c.alreadyInLibrary === 1 ? "was" : "were"} already in the library, so ${c.alreadyInLibrary === 1 ? "it was" : "they were"} not brought in again`);
  if (c.notDownloaded) out.push(`${files(c.notDownloaded)} here ${c.notDownloaded === 1 ? "is" : "are"} not downloaded to this Mac${c.notDownloadedBytes > 0 ? ` (${formatSize(c.notDownloadedBytes)})` : ""}`);
  if (c.didNotComeIn) out.push(`${files(c.didNotComeIn)} did not come in`);
  if (c.waiting) out.push(`${files(c.waiting)} ${c.waiting === 1 ? "is" : "are"} waiting to come in`);
  if (c.changed) out.push(`${files(c.changed)} in the library ${c.changed === 1 ? "has" : "have"} changed in the folder`);
  if (c.gone) out.push(`${files(c.gone)} ${c.gone === 1 ? "is" : "are"} no longer in the folder`);
  return out;
}

const downloadTitle = (n: number, bytes: number) => `Download ${files(n)}${bytes > 0 ? ` (${formatSize(bytes)})` : ""} to this Mac and import them? They stay downloaded afterwards.`;

/** The service's own sentence for a refusal (plain words; the service puts no path in it). */
const sentenceOf = (err: unknown, fallback: string) => (err instanceof ApiClientError && err.message ? err.message : fallback);

type Act = "pause" | "resume" | "retry" | "choose" | "leave" | "continue";

type Dialog =
  | { kind: "add"; grant: string | null; name: string; busy: boolean; error?: string }
  | { kind: "download"; id: string; label: string; files: number; bytes: number; busy: boolean; error?: string }
  | { kind: "remove"; id: string; label: string; busy: boolean; error?: string };

interface FileList {
  items: WatchedFolderFileItem[];
  total: number;
  loading: boolean;
  /** Pages disagreed: the list changed while it was read (M9). */
  changed: boolean;
  error?: string;
}

const fileKey = (it: WatchedFolderFileItem) => `${it.kind}\u0000${it.file}`;

/** Something said: a new `n` is a new node, so the same text again is said again (M2). */
interface Said {
  text: string;
  n: number;
}

function LiveRegion({ said, testId }: { said: Said; testId: string }) {
  return (
    <p className="ao-visually-hidden" role="status" aria-live="polite" data-testid={testId}>
      {said.text && <span key={said.n}>{said.text}</span>}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// The route: the project named in the address.

/** `firstReadMs` (FR-750, R579): how long the screen's reads are waited for before they are given up (smaller in tests). */
export function WatchedFoldersRoute({ client, loc, firstReadMs }: { client: ApiClient; loc: AppLocation; firstReadMs?: number }) {
  const projectId = projectInQuery(loc.search);
  if (!projectId) {
    return (
      <main className="ao-page ao-watch" aria-labelledby="ao-watch-h">
        <h1 id="ao-watch-h">Watched folders</h1>
        <p>{WATCH_TEXT.noProject}</p>
      </main>
    );
  }
  return <WatchedFolders key={projectId} client={client} projectId={projectId} {...(firstReadMs !== undefined ? { firstReadMs } : {})} />;
}

// ---------------------------------------------------------------------------------------------

export function WatchedFolders({ client, projectId, firstReadMs = FIRST_READ_TIMEOUT_MS }: { client: ApiClient; projectId: string; firstReadMs?: number }) {
  const api = useMemo(() => watchedFoldersApi(client), [client]);
  const lib = useMemo(() => libraryApi(client), [client]);
  const shell = desktopShell();
  const ids = useId();

  const [folders, setFolders] = useState<WatchedFolderSummary[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  /** FR-750: the list's last read got no answer (or none in time): "Try again" is offered. */
  const [loadUnreachable, setLoadUnreachable] = useState(false);
  const [locked, setLocked] = useState(false);
  const [project, setProject] = useState<ProjectSummary | undefined>();
  const [readOnly, setReadOnly] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [busy, setBusy] = useState<Record<string, Act>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** A choice of this computer's folder was refused: the button offers the chooser again. */
  const [chooseAgain, setChooseAgain] = useState<Record<string, boolean>>({});
  const [lists, setListsState] = useState<Record<string, FileList>>({});
  const listsRef = useRef<Record<string, FileList>>({});
  const setLists = useCallback((fn: (m: Record<string, FileList>) => Record<string, FileList>) => {
    listsRef.current = fn(listsRef.current);
    setListsState(listsRef.current);
  }, []);
  const [dialog, setDialogState] = useState<Dialog | null>(null);
  /** The dialog as of now (a second press before the next render sees the first one's change). */
  const dialogRef = useRef<Dialog | null>(null);
  const setDialog = useCallback((next: Dialog | null | ((cur: Dialog | null) => Dialog | null)) => {
    dialogRef.current = typeof next === "function" ? next(dialogRef.current) : next;
    setDialogState(dialogRef.current);
  }, []);
  const [picking, setPickingState] = useState(false);
  const pickingRef = useRef(false);
  const setPicking = (v: boolean) => {
    pickingRef.current = v;
    setPickingState(v);
  };
  const [openSource, setOpenSource] = useState<{ sourceId: string; folderId: string; from: HTMLElement | null } | null>(null);
  /** The page's polite region and the open dialog's (M3); each text is a new node, so a repeat is said again (M2). */
  const [live, setLive] = useState<Said>({ text: "", n: 0 });
  const [dialogLive, setDialogLive] = useState<Said>({ text: "", n: 0 });
  const [focusFolders, setFocusFolders] = useState(0);
  /** The library was closed while the screen was shown (N3). */
  const [noLibrary, setNoLibraryState] = useState(false);
  const noLibraryRef = useRef(false);
  const setNoLibrary = (v: boolean) => {
    noLibraryRef.current = v;
    setNoLibraryState(v);
  };
  /** The open library, as the service last named it: another one opening in its place is a fresh start. */
  const libraryId = useRef<string | undefined>(undefined);

  const foldersRef = useRef<WatchedFolderSummary[]>([]);
  const alive = useRef(true);
  /** Moves on at a lock: anything answered for the time before is dropped. */
  const gen = useRef(0);
  /**
   * Folders known gone, with the reading that said so (R241): removed here (Infinity), or absent from a list with a
   * higher number. A summary of such a folder is taken only when it is a later reading still.
   */
  const gone = useRef(new Map<string, number>());
  /** Folders with an act of the researcher's in flight: its result is said, not the state change. */
  const acting = useRef(new Map<string, number>());
  const busyRef = useRef<Record<string, Act>>({});
  const listGen = useRef(new Map<string, number>());
  /** Lists being read (one request per press, M6). */
  const filesBusy = useRef(new Set<string>());
  const againBusy = useRef(false);
  const relisting = useRef<{ again: boolean; done: Promise<void>; drops: number; ac: AbortController } | null>(null);
  /** FR-750: the list has been read once (or since the library changed), and the times the event stream failed or dropped. */
  const listedOk = useRef(false);
  const streamDrops = useRef(0);
  const foldersHeading = useRef<HTMLHeadingElement>(null);
  const sourceRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  /** The last control that had focus, and its folder: if it goes away, focus goes to that folder's heading (I2). */
  const lastFocus = useRef<{ el: HTMLElement; folderId: string | undefined } | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Said once, in the open dialog's region while one is open (the page is inert then), else in the page's. */
  const say = useCallback((text: string) => {
    if (dialogRef.current) setDialogLive((s) => ({ text, n: s.n + 1 }));
    else setLive((s) => ({ text, n: s.n + 1 }));
  }, []);

  /** The folders shown from now on; a changed state word is said (unless the researcher's own act will say its result). */
  const commit = useCallback(
    (next: WatchedFolderSummary[], announce: boolean) => {
      const prev = foldersRef.current;
      if (announce) {
        for (const f of next) {
          const p = prev.find((x) => x.id === f.id);
          if (p && p.state !== f.state && !acting.current.get(f.id)) say(`“${labelOf(f)}”: ${wordOf(f)}.`);
        }
      }
      foldersRef.current = next;
      setFolders(next);
    },
    [say],
  );

  /**
   * Summaries from the service, by its order (R241): a folder keeps the summary with the highest `seq` seen, however
   * they arrive. With `listSeq` (a whole list): a folder the list does not hold goes only if the list is the later
   * reading.
   */
  const take = useCallback(
    (incoming: WatchedFolderSummary[], announce: boolean, listSeq?: number) => {
      let next = [...foldersRef.current];
      for (const s of incoming) {
        if ((gone.current.get(s.id) ?? -Infinity) >= s.seq) continue;
        const i = next.findIndex((f) => f.id === s.id);
        if (i >= 0 && next[i]!.seq >= s.seq) continue;
        gone.current.delete(s.id);
        if (i >= 0) next[i] = s;
        else next.push(s);
      }
      if (listSeq !== undefined) {
        const held = new Set(incoming.map((f) => f.id));
        next = next.filter((f) => {
          if (held.has(f.id) || f.seq >= listSeq) return true;
          gone.current.set(f.id, listSeq);
          return false;
        });
      }
      commit(next, announce);
    },
    [commit],
  );

  const markLocked = useCallback(() => {
    gen.current++;
    setLocked(true);
    setDialog(null);
    setOpenSource(null);
    setLists(() => ({}));
    foldersRef.current = [];
    setFolders(undefined);
  }, [setDialog, setLists]);

  /**
   * The library closed or another one opened (N3): what was shown, the numbers remembered and every answer still out
   * belong to the library that went, so all are dropped.
   */
  const forgetLibrary = useCallback(() => {
    gen.current++;
    relisting.current = null;
    gone.current.clear();
    acting.current.clear();
    busyRef.current = {};
    setBusy({});
    setErrors({});
    setChooseAgain({});
    setDialog(null);
    setOpenSource(null);
    setLists(() => ({}));
    setLoadError(undefined);
    setLoadUnreachable(false);
    listedOk.current = false;
    setLocked(false);
    foldersRef.current = [];
    setFolders(undefined);
  }, [setDialog, setLists]);

  /**
   * The list (at load, after a lost stream, an unlock, a 409 or a 404); one at a time, a second ask joins it. Each read is
   * given up after `firstReadMs` as one that got no answer (FR-750); `restart`: one still out is given up for a new one.
   */
  const relist = useCallback(async (o: { restart?: boolean } = {}): Promise<void> => {
    if (relisting.current) {
      if (!o.restart) {
        relisting.current.again = true;
        return relisting.current.done;
      }
      relisting.current.ac.abort();
    }
    let settle!: () => void;
    const mark = { again: false, done: new Promise<void>((r) => (settle = r)), drops: streamDrops.current, ac: new AbortController() };
    relisting.current = mark;
    const g = gen.current;
    const mine = () => alive.current && g === gen.current && relisting.current === mark;
    try {
      do {
        mark.again = false;
        try {
          const r = await readWithin((signal) => api.list(projectId, { signal }), firstReadMs, mark.ac.signal);
          if (!mine()) return;
          setLoadError(undefined);
          setLoadUnreachable(false);
          listedOk.current = true;
          take(r.folders, true, r.seq);
        } catch (err) {
          if (!mine()) return;
          if (isProjectLocked(err)) {
            markLocked();
            return;
          }
          if (foldersRef.current.length === 0) {
            setLoadError(sentenceOf(err, "The watched folders could not be read."));
            setLoadUnreachable(isUnreachable(err));
          }
        }
      } while (mark.again && mine());
    } finally {
      if (relisting.current === mark) relisting.current = null;
      settle();
    }
  }, [api, projectId, take, markLocked, firstReadMs]);

  const refreshCollections = useCallback(() => {
    lib.collections.list(projectId).then(
      (r) => alive.current && setCollections(r.collections),
      () => {},
    );
  }, [lib, projectId]);

  // ---- load: the folders, the project's name, the library's mode, the collections ----
  useEffect(() => {
    void relist();
    lib.projects.list().then(
      (r) => alive.current && setProject(r.projects.find((p) => p.id === projectId)),
      () => {},
    );
    lib.libraries.list().then(
      (r) => {
        if (!alive.current || !r.current) return;
        libraryId.current ??= r.current.libraryId;
        setReadOnly(r.current.mode !== "read-write");
      },
      () => {},
    );
    refreshCollections();
  }, [lib, projectId, relist, refreshCollections]);

  // ---- live updates: watch.status of this project, and the library's mode ----
  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let opened = false;
    const listen = async () => {
      try {
        const onOpen = () => {
          // FR-750 (R579): after the stream failed or dropped, a list not yet read — failed, or still out from before the
          // stream last failed (it may never settle) — is read again at once, without waiting for an event on it.
          const m = relisting.current;
          if (streamDrops.current > 0 && !listedOk.current && (!m || m.drops < streamDrops.current)) void relist({ restart: true });
          // After a lost stream, what was published meanwhile is read from the list.
          else if (opened) void relist();
          opened = true;
        };
        for await (const ev of client.events({ signal: ac.signal, onOpen })) {
          if (!alive.current) return;
          if (ev.type === "library.state" && ev.data && typeof ev.data === "object") {
            const d = ev.data as LibraryState;
            if (d.open === false) {
              // Closed (N3): nothing of it stays on screen.
              libraryId.current = undefined;
              forgetLibrary();
              setNoLibrary(true);
              continue;
            }
            if (d.mode) setReadOnly(d.mode !== "read-write");
            if (d.libraryId && d.libraryId !== libraryId.current) {
              // Opened again, or another library in its place: read afresh (its numbers may start below ours).
              const fresh = libraryId.current !== undefined || noLibraryRef.current;
              libraryId.current = d.libraryId;
              if (fresh) {
                forgetLibrary();
                setNoLibrary(false);
                void relist();
                refreshCollections();
              }
            }
            continue;
          }
          const e = watchStatusOf(ev, projectId);
          if (e) take([e.folder], true);
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
  }, [client, projectId, take, relist, forgetLibrary, refreshCollections]);

  useEffect(() => {
    if (focusFolders > 0) foldersHeading.current?.focus();
  }, [focusFolders]);
  useEffect(() => {
    if (openSource) sourceRef.current?.focus();
  }, [openSource]);
  // I2, M10: whenever the control that had focus has gone (its state passed, its list closed, its dialog's opener left),
  // focus goes to its folder's heading, or to "Folders" when the folder itself has gone — never to the page.
  useEffect(() => {
    const lf = lastFocus.current;
    const now = document.activeElement;
    if (!lf || lf.el.isConnected || (now && now !== document.body && now.isConnected)) return;
    const heading = lf.folderId ? mainRef.current?.querySelector<HTMLElement>(`[data-folder-heading="${CSS.escape(lf.folderId)}"]`) : null;
    (heading ?? foldersHeading.current)?.focus();
  });
  const noteFocus = (e: FocusEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const holder = el.closest<HTMLElement>("[data-folder-id]");
    lastFocus.current = { el, folderId: holder?.dataset.folderId };
  };

  const setBusyFor = (id: string, act: Act | undefined) => {
    const next = { ...busyRef.current };
    if (act) next[id] = act;
    else delete next[id];
    busyRef.current = next;
    setBusy(next);
  };
  const actingInc = (id: string, by: number) => {
    const n = (acting.current.get(id) ?? 0) + by;
    if (n > 0) acting.current.set(id, n);
    else acting.current.delete(id);
  };
  const setErrorFor = (id: string, msg: string | undefined) =>
    setErrors((e) => {
      const next = { ...e };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });

  /** A refusal: locked → the unlock screen; read-only → said once at the top; gone or changed → the list again. */
  const refused = (err: unknown) => {
    if (isProjectLocked(err)) {
      markLocked();
      return true;
    }
    if (err instanceof ApiClientError && err.code === "READ_ONLY") setReadOnly(true);
    if (err instanceof ApiClientError && (err.status === 404 || err.status === 409)) void relist();
    return false;
  };

  /**
   * One act on one folder: its button shows it is working and cannot be pressed twice; the rest of the screen stays
   * usable. The answer is taken by its number, and the result is said from the answer itself (R241).
   */
  const run = async (f: WatchedFolderSummary, act: Act, call: () => Promise<WatchedFolderSummary>, result: (s: WatchedFolderSummary) => string, onRefused?: () => void) => {
    if (busyRef.current[f.id] && busyRef.current[f.id] !== act) return;
    setBusyFor(f.id, act);
    actingInc(f.id, 1);
    setErrorFor(f.id, undefined);
    const g = gen.current;
    try {
      const s = await call();
      if (!alive.current || g !== gen.current) return;
      take([s], false);
      say(result(s));
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setErrorFor(f.id, sentenceOf(err, "That could not be done. Try again."));
      onRefused?.();
    } finally {
      actingInc(f.id, -1);
      if (alive.current) setBusyFor(f.id, undefined);
    }
  };

  const canAct = (f: WatchedFolderSummary) => !readOnly && !busyRef.current[f.id];

  const pause = (f: WatchedFolderSummary, paused: boolean) => {
    if (!canAct(f)) return;
    void run(f, paused ? "pause" : "resume", () => api.patch(projectId, f.id, { paused }), (s) => end(`“${labelOf(s)}”: ${stateLine(s)}`));
  };
  const retry = (f: WatchedFolderSummary) => {
    if (!canAct(f)) return;
    void run(f, "retry", () => api.retry(projectId, f.id), (s) => end(`Tried again. “${labelOf(s)}”: ${stateLine(s)}`));
  };
  const leave = (f: WatchedFolderSummary) => {
    if (!canAct(f)) return;
    void run(f, "leave", () => api.patch(projectId, f.id, { notDownloaded: "leave" }), (s) => `“${labelOf(s)}”: files not downloaded to this Mac are left until you download them.`);
  };
  /** "Continue downloading ({size})": the button's own size is the agreement (R219); a 409 reads the list again (M4). */
  const continueDownloading = (f: WatchedFolderSummary, held: { files: number; bytes: number }) => {
    if (!canAct(f)) return;
    void run(f, "continue", () => api.patch(projectId, f.id, { notDownloaded: "download", confirmBytes: held.bytes }), (s) => `Agreed to download ${files(held.files)} (${formatSize(held.bytes)}) for “${labelOf(s)}”.`);
  };
  /** This computer's folder for a watch that is not set up here: the chooser, then the grant once. */
  const chooseFolder = async (f: WatchedFolderSummary) => {
    if (!canAct(f) || !shell) return;
    setBusyFor(f.id, "choose");
    let picked: { grantId: string; name: string } | null = null;
    try {
      picked = await shell.pickWatchFolder(`Choose the folder for “${labelOf(f)}”`);
    } catch {
      picked = null;
    }
    if (!alive.current) return;
    if (!picked) {
      setBusyFor(f.id, undefined);
      return;
    }
    const grantId = picked.grantId;
    await run(
      f,
      "choose",
      () => api.setFolder(projectId, f.id, grantId),
      (s) => {
        setChooseAgain((m) => ({ ...m, [f.id]: false }));
        return end(`Folder chosen. “${labelOf(s)}”: ${stateLine(s)}`);
      },
      () => setChooseAgain((m) => ({ ...m, [f.id]: true })),
    );
  };

  // ---- add ----
  const startAdd = async () => {
    if (pickingRef.current || readOnly || !shell || dialogRef.current) return;
    setPicking(true);
    let picked: { grantId: string; name: string } | null = null;
    try {
      picked = await shell.pickWatchFolder(WATCH_TEXT.chooserTitle);
    } catch {
      picked = null;
    }
    if (!alive.current) return;
    setPicking(false);
    if (!picked) return;
    refreshCollections();
    setDialogLive({ text: "", n: 0 });
    setDialog({ kind: "add", grant: picked.grantId, name: picked.name, busy: false });
  };
  const addStart = async (o: { label: string; recursive: boolean; collectionId: string }) => {
    const d = dialogRef.current;
    if (d?.kind !== "add" || d.busy || !d.grant || readOnly) return;
    const grantId = d.grant;
    // The grant is spent by the request whatever its answer (R233 d): never sent twice.
    setDialog({ ...d, grant: null, busy: true, error: undefined });
    const label = o.label.trim();
    const body = { grantId, recursive: o.recursive, ...(label ? { label } : {}), ...(o.collectionId ? { collectionId: o.collectionId } : {}) };
    const g = gen.current;
    try {
      const s = await api.add(projectId, body);
      if (!alive.current || g !== gen.current) return;
      take([s], false);
      setDialog(null);
      say(end(`Added. “${labelOf(s)}”: ${stateLine(s)}`));
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setDialog((cur) => (cur?.kind === "add" ? { ...cur, busy: false, error: sentenceOf(err, "The folder could not be added.") } : cur));
    }
  };
  const addChooseAgain = async () => {
    const cur = dialogRef.current;
    if (cur?.kind !== "add" || cur.busy || !shell || againBusy.current) return;
    againBusy.current = true;
    let picked: { grantId: string; name: string } | null = null;
    try {
      picked = await shell.pickWatchFolder(WATCH_TEXT.chooserTitle);
    } catch {
      picked = null;
    } finally {
      againBusy.current = false;
    }
    if (!alive.current || !picked) return;
    const p = picked;
    setDialog((cur) => (cur?.kind === "add" ? { kind: "add", grant: p.grantId, name: p.name, busy: false } : cur));
  };

  // ---- download, by an agreement to the size the service reported ----
  const openDownload = (f: WatchedFolderSummary) => {
    if (!canAct(f) || dialogRef.current) return;
    // Nothing of a known size to agree to (M5; R221 b): no agreement is offered; said in plain words.
    if (f.counts.notDownloadedBytes === 0) {
      setErrorFor(f.id, f.counts.notDownloaded === 0 ? WATCH_TEXT.nothingToDownload : WATCH_TEXT.sizesUnknown);
      return;
    }
    setErrorFor(f.id, undefined);
    setDialogLive({ text: "", n: 0 });
    setDialog({ kind: "download", id: f.id, label: labelOf(f), files: f.counts.notDownloaded, bytes: f.counts.notDownloadedBytes, busy: false });
  };
  const agreeDownload = async () => {
    const d = dialogRef.current;
    if (d?.kind !== "download" || d.busy || readOnly || d.bytes === 0) return;
    setDialog({ ...d, busy: true, error: undefined });
    actingInc(d.id, 1);
    const g = gen.current;
    try {
      // Exactly the size the dialog shows (R219): never a number that arrived meanwhile.
      const s = await api.patch(projectId, d.id, { notDownloaded: "download", confirmBytes: d.bytes });
      if (!alive.current || g !== gen.current) return;
      take([s], false);
      setDialog(null);
      say(`Agreed to download ${files(d.files)} (${formatSize(d.bytes)}) for “${labelOf(s)}”.`);
    } catch (err) {
      if (!alive.current || g !== gen.current || isProjectLocked(err)) {
        if (isProjectLocked(err)) markLocked();
        return;
      }
      if (err instanceof ApiClientError && err.code === "READ_ONLY") setReadOnly(true);
      const msg = sentenceOf(err, "The download could not be agreed.");
      // A 409 (the size changed, or nothing to download): the service's sentence, and the question again with the size it reports now.
      const conflict = err instanceof ApiClientError && err.status === 409;
      if (conflict || (err instanceof ApiClientError && err.status === 404)) await relist();
      if (!alive.current || g !== gen.current) return;
      const now = conflict ? foldersRef.current.find((f) => f.id === d.id) : undefined;
      const nowText = now ? ` The folder now reports ${files(now.counts.notDownloaded)}${now.counts.notDownloadedBytes > 0 ? ` (${formatSize(now.counts.notDownloadedBytes)})` : ""} not downloaded.` : "";
      setDialog((cur) => (cur?.kind === "download" && cur.id === d.id ? { ...cur, busy: false, error: `${msg}${nowText}`, ...(now ? { files: now.counts.notDownloaded, bytes: now.counts.notDownloadedBytes } : {}) } : cur));
    } finally {
      actingInc(d.id, -1);
    }
  };

  // ---- remove ----
  const openRemove = (f: WatchedFolderSummary) => {
    if (!canAct(f) || dialogRef.current) return;
    setDialogLive({ text: "", n: 0 });
    setDialog({ kind: "remove", id: f.id, label: labelOf(f), busy: false });
  };
  const confirmRemove = async () => {
    const d = dialogRef.current;
    if (d?.kind !== "remove" || d.busy || readOnly) return;
    setDialog({ ...d, busy: true, error: undefined });
    const g = gen.current;
    try {
      await api.remove(projectId, d.id);
      if (!alive.current || g !== gen.current) return;
      // Removed here: no summary of it is taken again, whatever its number (a late event or a list in flight).
      gone.current.set(d.id, Infinity);
      listGen.current.set(d.id, (listGen.current.get(d.id) ?? 0) + 1);
      commit(
        foldersRef.current.filter((f) => f.id !== d.id),
        false,
      );
      setDialog(null);
      if (openSource?.folderId === d.id) setOpenSource(null);
      say(`Stopped watching “${d.label}”.`);
      setFocusFolders((n) => n + 1);
    } catch (err) {
      if (!alive.current || g !== gen.current || refused(err)) return;
      setDialog((cur) => (cur?.kind === "remove" ? { ...cur, busy: false, error: sentenceOf(err, "The folder could not be removed.") } : cur));
    }
  };

  // ---- the files that did not come in, fetched when asked for; one request per press (M6) ----
  const fetchFiles = async (id: string, offset: number) => {
    if (filesBusy.current.has(id)) return;
    filesBusy.current.add(id);
    const n = (listGen.current.get(id) ?? 0) + 1;
    listGen.current.set(id, n);
    const g = gen.current;
    setLists((m) => ({ ...m, [id]: { items: offset === 0 ? [] : (m[id]?.items ?? []), total: m[id]?.total ?? 0, loading: true, changed: offset === 0 ? false : !!m[id]?.changed } }));
    try {
      const r = await api.files(projectId, id, { offset, limit: PAGE });
      if (!alive.current || g !== gen.current || listGen.current.get(id) !== n) return;
      setLists((m) => {
        const cur = m[id];
        if (!cur) return m;
        if (offset === 0) return { ...m, [id]: { items: r.items, total: r.total, loading: false, changed: false } };
        // The list can change between pages (M9): no entry twice, and the change is said.
        const seen = new Set(cur.items.map(fileKey));
        const fresh = r.items.filter((it) => !seen.has(fileKey(it)));
        const changed = cur.changed || r.total !== cur.total || fresh.length !== r.items.length;
        return { ...m, [id]: { items: [...cur.items, ...fresh], total: r.total, loading: false, changed } };
      });
    } catch (err) {
      if (!alive.current || g !== gen.current || listGen.current.get(id) !== n || refused(err)) return;
      setLists((m) => (m[id] ? { ...m, [id]: { ...m[id]!, loading: false, error: sentenceOf(err, "The list could not be read.") } } : m));
    } finally {
      if (listGen.current.get(id) === n) filesBusy.current.delete(id);
    }
  };
  const toggleFiles = (id: string) => {
    if (listsRef.current[id]) {
      listGen.current.set(id, (listGen.current.get(id) ?? 0) + 1);
      filesBusy.current.delete(id);
      setLists(({ [id]: _gone, ...rest }) => rest);
      return;
    }
    void fetchFiles(id, 0);
  };
  const moreFiles = (id: string) => {
    const cur = listsRef.current[id];
    if (!cur || cur.loading) return;
    void fetchFiles(id, cur.items.length);
  };

  // ---- the page ----
  const heading = (
    <>
      <h1 id={`${ids}-h`}>Watched folders</h1>
      {project && (
        <p className="ao-muted">
          Project: <UserText>{project.name}</UserText>
        </p>
      )}
    </>
  );

  if (noLibrary) {
    return (
      <main className="ao-page ao-watch" aria-labelledby={`${ids}-h`}>
        <h1 id={`${ids}-h`}>Watched folders</h1>
        <p role="status">{WATCH_TEXT.noLibrary}</p>
      </main>
    );
  }

  if (locked) {
    return (
      <main className="ao-page ao-watch" aria-labelledby={`${ids}-h`}>
        {heading}
        <UnlockProject
          api={lib}
          project={project ?? { id: projectId, name: "This project" }}
          onUnlocked={() => {
            setLocked(false);
            void relist();
            refreshCollections();
          }}
        />
      </main>
    );
  }

  const liveFolder = dialog && dialog.kind !== "add" ? folders?.find((f) => f.id === dialog.id) : undefined;

  return (
    <main ref={mainRef} className="ao-page ao-watch" aria-labelledby={`${ids}-h`} onFocus={noteFocus}>
      {heading}
      <p>{WATCH_TEXT.intro}</p>
      {readOnly && <p className="ao-watch__note">{WATCH_TEXT.readOnly}</p>}
      {shell ? (
        <p>
          <button type="button" disabled={readOnly} aria-disabled={picking || undefined} onClick={() => void startAdd()}>
            Add a folder…
          </button>
        </p>
      ) : (
        <p className="ao-watch__note">{WATCH_TEXT.needsApp}</p>
      )}
      <LiveRegion said={live} testId="watch-live" />

      <h2 id={`${ids}-folders`} ref={foldersHeading} tabIndex={-1}>
        Folders
      </h2>
      {loadError && (
        <p role="alert" className="ao-error">
          {loadError}
        </p>
      )}
      {/* FR-750 (R579): a read that got no answer (or none in time) is offered again; an answer the screen handles is not. */}
      {loadError && loadUnreachable && (
        <p>
          <button type="button" onClick={() => void relist()}>
            Try again
          </button>
        </p>
      )}
      {!folders && !loadError && <p role="status">{WATCH_TEXT.loading}</p>}
      {folders && folders.length === 0 && <p>{WATCH_TEXT.none}</p>}
      {folders?.map((f) => (
        <FolderCard
          key={f.id}
          f={f}
          readOnly={readOnly}
          inShell={!!shell}
          busy={busy[f.id]}
          error={errors[f.id]}
          chooseAgain={!!chooseAgain[f.id]}
          list={lists[f.id]}
          onPause={() => pause(f, !f.choices.paused)}
          onRetry={() => retry(f)}
          onChoose={() => void chooseFolder(f)}
          onLeave={() => leave(f)}
          onDownload={() => openDownload(f)}
          onContinue={(held) => continueDownloading(f, held)}
          onRemove={() => openRemove(f)}
          onToggleFiles={() => toggleFiles(f.id)}
          onMoreFiles={() => moreFiles(f.id)}
          onOpenSource={(sourceId, from) => setOpenSource({ sourceId, folderId: f.id, from })}
        />
      ))}

      {openSource && (
        <section ref={sourceRef} tabIndex={-1} aria-label="Source" className="ao-watch__source" data-folder-id={openSource.folderId}>
          <SourceDetail
            api={lib}
            projectId={projectId}
            sourceId={openSource.sourceId}
            readOnly={readOnly}
            onLocked={markLocked}
            onClose={() => {
              const from = openSource.from;
              setOpenSource(null);
              // Back to the control that opened it; if that has gone, the effect above takes focus to the folder's heading (M10).
              if (from?.isConnected) from.focus();
            }}
          />
        </section>
      )}

      {dialog?.kind === "add" && (
        <AddDialog
          d={dialog}
          collections={collections}
          live={dialogLive}
          onStart={(o) => void addStart(o)}
          onChooseAgain={() => void addChooseAgain()}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "download" && <DownloadDialog d={dialog} live={liveFolder} said={dialogLive} onConfirm={() => void agreeDownload()} onCancel={() => setDialog(null)} />}
      {dialog?.kind === "remove" && <RemoveDialog d={dialog} said={dialogLive} onConfirm={() => void confirmRemove()} onCancel={() => setDialog(null)} />}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// One folder

const BUSY_TEXT: Record<Act, string> = { pause: "Pausing…", resume: "Resuming…", retry: "Trying again…", choose: "Choosing…", leave: "Saving…", continue: "Agreeing…" };

/** A button that shows it is working: it keeps focus (aria-disabled, not disabled) and ignores a second press. */
function ActButton({ text, name, working, waiting, disabled, onPress, className, buttonRef, expanded }: { text: string; name: string; working: boolean; waiting: boolean; disabled: boolean; onPress: (el: HTMLButtonElement) => void; className?: string; buttonRef?: Ref<HTMLButtonElement>; expanded?: boolean }) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={className}
      aria-label={name}
      disabled={disabled}
      aria-disabled={working || waiting || undefined}
      aria-busy={working || undefined}
      aria-expanded={expanded}
      onClick={(e) => {
        if (working || waiting) return;
        onPress(e.currentTarget);
      }}
    >
      {text}
    </button>
  );
}

function FolderCard(props: {
  f: WatchedFolderSummary;
  readOnly: boolean;
  inShell: boolean;
  busy: Act | undefined;
  error: string | undefined;
  chooseAgain: boolean;
  list: FileList | undefined;
  onPause: () => void;
  onRetry: () => void;
  onChoose: () => void;
  onLeave: () => void;
  onDownload: () => void;
  onContinue: (held: { files: number; bytes: number }) => void;
  onRemove: () => void;
  onToggleFiles: () => void;
  onMoreFiles: () => void;
  onOpenSource: (sourceId: string, from: HTMLElement) => void;
}) {
  const { f, readOnly, busy, error, list } = props;
  const id = useId();
  const label = labelOf(f);
  const q = `“${label}”`;
  /** Another act of this folder is in flight: this button waits (the folder's acts go one at a time). */
  const waits = (act: Act | Act[]) => !!busy && !(Array.isArray(act) ? act : [act]).includes(busy);
  const lines = countLines(f);
  const pauseAct: Act = f.choices.paused ? "resume" : "pause";
  const pauseText = busy === pauseAct ? BUSY_TEXT[pauseAct] : f.choices.paused ? "Resume" : "Pause";
  const chooseText = busy === "choose" ? BUSY_TEXT.choose : props.chooseAgain ? "Choose the folder again…" : "Choose the folder on this Mac…";
  const held = f.downloadHeld;
  const many = f.counts.notDownloaded > KIND_CAP || f.counts.didNotComeIn > KIND_CAP;

  return (
    <section className="ao-card ao-watch__folder" aria-labelledby={`${id}-name`} data-folder-id={f.id}>
      <h3 id={`${id}-name`} tabIndex={-1} data-folder-heading={f.id}>
        <UserText>{label}</UserText>
      </h3>
      {f.label !== undefined && f.place && (
        <p className="ao-muted">
          In <UserText>{f.place.display}</UserText>
        </p>
      )}
      {f.collectionName !== undefined && (
        <p className="ao-muted">
          Collection: <UserText>{f.collectionName}</UserText>
        </p>
      )}
      {f.recursive && <p className="ao-muted">The folders inside it are watched too.</p>}
      <p className="ao-watch__state">
        <strong>{stateLine(f)}</strong>
      </p>
      {f.reason && !(readOnly && f.reason === SERVICE_READ_ONLY) && (
        <p>
          <UserText>{f.reason}</UserText>
        </p>
      )}
      {lines.length > 0 && (
        <ul className="ao-watch__counts">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="ao-error">
          <UserText>{error}</UserText>
        </p>
      )}
      <div className="ao-actions">
        <ActButton text={pauseText} name={busy === pauseAct ? `${pauseText} ${q}` : f.choices.paused ? `Resume watching ${q}` : `Pause watching ${q}`} working={busy === pauseAct} waiting={waits(pauseAct)} disabled={readOnly} onPress={props.onPause} />
        {f.state === "unreachable" && <ActButton text={busy === "retry" ? BUSY_TEXT.retry : "Try again"} name={`${busy === "retry" ? BUSY_TEXT.retry : "Try again"} for ${q}`} working={busy === "retry"} waiting={waits("retry")} disabled={readOnly} onPress={props.onRetry} />}
        {f.state === "not-set-up" && props.inShell && <ActButton text={chooseText} name={`${chooseText} for ${q}`} working={busy === "choose"} waiting={waits("choose")} disabled={readOnly} onPress={props.onChoose} />}
        {held && (
          <ActButton
            text={busy === "continue" ? BUSY_TEXT.continue : `Continue downloading (${formatSize(held.bytes)})`}
            name={`${busy === "continue" ? BUSY_TEXT.continue : `Continue downloading (${formatSize(held.bytes)})`} for ${q}`}
            working={busy === "continue"}
            waiting={waits("continue")}
            disabled={readOnly}
            onPress={() => props.onContinue(held)}
          />
        )}
        <ActButton text="Show files that did not come in" name={`Show files that did not come in for ${q}`} working={false} waiting={false} disabled={false} expanded={!!list} onPress={props.onToggleFiles} />
        <ActButton text="Remove…" name={`Remove ${q}…`} className="ao-danger" working={false} waiting={!!busy} disabled={readOnly} onPress={props.onRemove} />
      </div>
      <fieldset className="ao-watch__choice">
        <legend>Files not downloaded to this Mac</legend>
        <label className="ao-watch__option">
          <input
            type="radio"
            name={`${id}-nd`}
            value="leave"
            checked={f.choices.notDownloaded === "leave"}
            disabled={readOnly}
            aria-disabled={!!busy || undefined}
            onChange={() => {
              if (!busy) props.onLeave();
            }}
          />
          Leave them until I download them
        </label>
        <label className="ao-watch__option">
          <input
            type="radio"
            name={`${id}-nd`}
            value="download"
            checked={f.choices.notDownloaded === "download"}
            disabled={readOnly}
            aria-disabled={!!busy || undefined}
            onChange={() => {
              if (!busy) props.onDownload();
            }}
          />
          Download and import them
        </label>
      </fieldset>
      {list && <FilesPanel label={label} list={list} many={many} onMore={props.onMoreFiles} onOpenSource={props.onOpenSource} />}
    </section>
  );
}

function FilesPanel({ label, list, many, onMore, onOpenSource }: { label: string; list: FileList; many: boolean; onMore: () => void; onOpenSource: (sourceId: string, from: HTMLElement) => void }) {
  const q = `“${label}”`;
  return (
    <div className="ao-watch__files">
      {list.error && (
        <p role="alert" className="ao-error">
          <UserText>{list.error}</UserText>
        </p>
      )}
      {many && <p>{WATCH_TEXT.firstOnly}</p>}
      {list.changed && <p role="status">{WATCH_TEXT.listChanged}</p>}
      {!list.loading && !list.error && list.items.length === 0 && <p>{WATCH_TEXT.noFiles}</p>}
      {list.items.length > 0 && (
        <>
          <p>
            Showing {num(list.items.length)} of {num(list.total)}.
          </p>
          <ul className="ao-watch__file-list" aria-label={`Files of ${q}`}>
            {list.items.map((it) => (
              <li key={fileKey(it)}>
                <UserText className="ao-watch__file">{it.file}</UserText>
                {": "}
                <UserText>{it.reason}</UserText>
                {it.bytes !== undefined && ` (${formatSize(it.bytes)})`}
                {it.sourceId && (
                  <>
                    {" "}
                    <button type="button" aria-label={`Open the source of “${it.file}”`} onClick={(e) => onOpenSource(it.sourceId!, e.currentTarget)}>
                      Open the source
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {list.loading && <p role="status">Reading the list…</p>}
      {!list.loading && list.items.length < list.total && (
        <button type="button" aria-label={`Show more files of ${q}`} onClick={onMore}>
          Show more
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs (R145: DialogShell moves focus in, traps it, restores it, and makes the rest inert)

function DialogError({ error }: { error: string | undefined }) {
  return error ? (
    <p role="alert" className="ao-error">
      <UserText>{error}</UserText>
    </p>
  ) : null;
}

/** The dialog's own polite region (M3): the page behind it is inert while it is open. */
function DialogLive({ said }: { said: Said }) {
  return <LiveRegion said={said} testId="watch-dialog-live" />;
}

function AddDialog({ d, collections, live, onStart, onChooseAgain, onCancel }: { d: Extract<Dialog, { kind: "add" }>; collections: Collection[]; live: Said; onStart: (o: { label: string; recursive: boolean; collectionId: string }) => void; onChooseAgain: () => void; onCancel: () => void }) {
  const id = useId();
  const [collectionId, setCollectionId] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [label, setLabel] = useState("");
  const start = useRef<HTMLButtonElement>(null);
  const grant = d.grant;
  // A new choice after a refusal: Start is the next thing to press.
  const lastGrant = useRef(grant);
  useEffect(() => {
    if (grant && lastGrant.current !== grant && lastGrant.current === null) start.current?.focus();
    lastGrant.current = grant;
  }, [grant]);
  const refusedChoice = !grant && !d.busy;
  // A refusal spent the grant: the next useful act is to choose again (M11).
  const again = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (refusedChoice && d.error) again.current?.focus();
  }, [refusedChoice, d.error]);
  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onCancel} busy={d.busy} className="ao-watch__dialog">
      <h2 id={`${id}-t`}>Add a watched folder</h2>
      <DialogLive said={live} />
      <p>
        Folder: <UserText>{d.name}</UserText>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (grant && !d.busy) onStart({ label, recursive, collectionId });
        }}
      >
        <label className="ao-stack">
          Collection
          <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
            <option value="">No collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id} dir="auto">
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ao-watch__option">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Also watch the folders inside it
        </label>
        <label className="ao-stack">
          Name shown here (optional)
          <input type="text" dir="auto" maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <DialogError error={d.error} />
        <div className="ao-actions">
          <button type="submit" ref={start} aria-disabled={!grant || d.busy || undefined}>
            {d.busy ? "Starting…" : "Start watching"}
          </button>
          {refusedChoice && (
            <button type="button" ref={again} onClick={onChooseAgain}>
              Choose the folder again…
            </button>
          )}
          <button type="button" onClick={onCancel} aria-disabled={d.busy || undefined}>
            Cancel
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function DownloadDialog({ d, live, said, onConfirm, onCancel }: { d: Extract<Dialog, { kind: "download" }>; live: WatchedFolderSummary | undefined; said: Said; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // First focus on the heading (R376 c): a held or repeated Enter on the opener must not agree to the download.
  const heading = useRef<HTMLHeadingElement>(null);
  // Nothing of a known size is left to agree to (a 409 said so): only Cancel stays (M5).
  const nothing = d.bytes === 0;
  // The numbers agreed to here are the ones in the title; a change since is said, never slipped in.
  const moved = live && !d.busy && (live.counts.notDownloaded !== d.files || live.counts.notDownloadedBytes !== d.bytes) ? live.counts : undefined;
  useEffect(() => {
    if (nothing) cancel.current?.focus();
  }, [nothing]);
  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onCancel} busy={d.busy} className="ao-watch__dialog" initialFocus={heading}>
      <h2 id={`${id}-t`} ref={heading} tabIndex={-1}>
        {downloadTitle(d.files, d.bytes)}
      </h2>
      <p id={`${id}-d`}>
        Folder: <UserText>{d.label}</UserText>
      </p>
      <DialogLive said={said} />
      {/* Said when it appears (M3): the numbers agreed to stay the title's. */}
      <div role="status" aria-live="polite">
        {moved && (
          <p>
            Since this opened, the folder&apos;s count has changed: {files(moved.notDownloaded)} ({formatSize(moved.notDownloadedBytes)}) {moved.notDownloaded === 1 ? "is" : "are"} not downloaded now. “Download and import” agrees only to the size above; cancel and choose again for the new size.
          </p>
        )}
      </div>
      <DialogError error={d.error} />
      <div className="ao-actions">
        {!nothing && (
          <button type="button" aria-disabled={d.busy || undefined} onClick={() => !d.busy && onConfirm()}>
            Download and import
          </button>
        )}
        <button type="button" ref={cancel} aria-disabled={d.busy || undefined} onClick={() => !d.busy && onCancel()}>
          Cancel
        </button>
      </div>
    </DialogShell>
  );
}

function RemoveDialog({ d, said, onConfirm, onCancel }: { d: Extract<Dialog, { kind: "remove" }>; said: Said; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  // First focus on the heading (R376 c): a held or repeated Enter on the opener must not stop the watch.
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onCancel} busy={d.busy} className="ao-watch__dialog" initialFocus={heading}>
      <h2 id={`${id}-t`} ref={heading} tabIndex={-1}>
        Stop watching “<UserText>{d.label}</UserText>”?
      </h2>
      <p id={`${id}-d`}>{WATCH_TEXT.removeBody}</p>
      <DialogLive said={said} />
      <DialogError error={d.error} />
      <div className="ao-actions">
        <button type="button" className="ao-danger" aria-disabled={d.busy || undefined} onClick={() => !d.busy && onConfirm()}>
          {d.busy ? "Stopping…" : "Stop watching"}
        </button>
        <button type="button" aria-disabled={d.busy || undefined} onClick={() => !d.busy && onCancel()}>
          Cancel
        </button>
      </div>
    </DialogShell>
  );
}

