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
 *   - Every read and every act draws a number when it STARTS (a read) or is SENT (an act, R258 M1); each
 *     entry keeps the number of what it was last taken from, and a read only replaces (or drops) entries holding a
 *     lower number. So of two reads the one STARTED later wins, whatever order they answer in; an act's answer never
 *     undoes a read started after the act was sent, and the status says the state as shown. After every act the
 *     queue is read once more. While events keep coming, coalesced reads start at least 400 ms apart (M7).
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
 * closed on a row that changed), focus goes to that row's next control, else its text — never to the page.
 */
import {
  FIND_ROUTE_TEXT,
  type FindAddResponse,
  type FindEntryView,
  type FindQueueResponse,
  type FindScreenSettings,
} from "@ao/shared";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ApiClientError, type ApiClient, type ServiceEvent } from "../api/client";
import { findApi, findHref, findProgressOf, type FindApi } from "../api/find";
import { isValidId } from "../api/import";
import { isProjectLocked, libraryApi, type Collection, type LibraryApi, type LibraryState, type ProjectSummary } from "../api/library";
import { ChooseWorkDialog } from "../components/ChooseWorkDialog";
import { FindEntryRow, stateWords, WordsView, type FindAction, type FindActKind, type FindPlace, type Words } from "../components/FindEntryRow";
import { UserText } from "../components/UserText";
import "../components/library.css";
import { navigate, projectInQuery, type AppLocation } from "../navigation";
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
} as const;

const RECONNECT_MS = 2000;
/** At most this many "where is it" questions out at once. */
const PLACE_CONCURRENCY = 4;
/** Events that arrive this close together make one read. */
const EVENT_COALESCE_MS = 50;
/** While events keep coming, coalesced reads of the queue start at least this far apart (R258 M7). */
const READ_GAP_MS = 400;

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
const saidOf = (v: FindEntryView, stopped: boolean): Words => ["“", { user: typeof v.typed === "string" ? v.typed : "" }, "”: ", ...stateWords(v, { stopped }), "."];

const byCreated = (a: FindEntryView, b: FindEntryView) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const same = (a: FindEntryView, b: FindEntryView) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isElsewhere = (e: FindEntryView) => !!e.elsewhere && (e.state === "already" || e.state === "maybe-duplicate");

// ---------------------------------------------------------------------------------------------
// The screen: project, collection, the switch; the queue of the chosen project below

/** What the screen passes on to the queue from the one event stream it listens to. */
type QueueSignal = { kind: "event"; ev: ServiceEvent } | { kind: "refresh" };
interface QueueBus {
  subscribe(fn: (s: QueueSignal) => void): () => void;
}

export function FindAcquire({ client, loc }: { client: ApiClient; loc: AppLocation }) {
  const api = useMemo(() => findApi(client), [client]);
  const lib = useMemo(() => libraryApi(client), [client]);
  const ids = useId();
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [projectsError, setProjectsError] = useState<string | undefined>();
  /** What this computer remembers, as the service last confirmed it (the controls show this). */
  const [remembered, setRemembered] = useState<FindScreenSettings | undefined>();
  /** The remembered settings could not be read: the service's sentence, said once (R258 M3). */
  const [screenError, setScreenError] = useState<string | undefined>();
  /** The switch while its change is being sent. */
  const [checkSending, setCheckSending] = useState<boolean | undefined>();
  const [switchError, setSwitchError] = useState<string | undefined>();
  const [settingsError, setSettingsError] = useState<string | undefined>();
  /** The project the researcher chose on this screen (else the address's, else the remembered one). */
  const [chosen, setChosen] = useState<string | undefined>();
  const [collections, setCollections] = useState<Collection[] | undefined>();
  const [collectionId, setCollectionId] = useState("");
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
  /** The PUTs, one at a time. */
  const putChain = useRef<Promise<void>>(Promise.resolve());
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

  /** The project list, read again when the service says the library changed; one read at a time, one more after it. */
  const projectsRead = useRef<{ again: boolean } | null>(null);
  const readProjects = useCallback(() => {
    if (projectsRead.current) {
      projectsRead.current.again = true;
      return;
    }
    const mark = { again: false };
    projectsRead.current = mark;
    const g = libGen.current;
    void (async () => {
      try {
        do {
          mark.again = false;
          try {
            const r = await lib.projects.list();
            if (!alive.current || g !== libGen.current) return;
            setProjects(r.projects);
            setProjectsError(undefined);
          } catch (err) {
            if (!alive.current || g !== libGen.current) return;
            setProjects((cur) => cur ?? []);
            setProjectsError(sentenceOf(err, FIND_SCREEN_TEXT.projectsUnreadable));
          }
        } while (mark.again && alive.current && g === libGen.current);
      } finally {
        if (projectsRead.current === mark) projectsRead.current = null;
      }
    })();
  }, [lib]);

  // ---- at load, and afresh for each library ----
  useEffect(() => {
    const g = libGen.current;
    readProjects();
    api.screen().then(
      (s) => {
        if (!alive.current || g !== libGen.current) return;
        confirmed.current = { ...s };
        screenUnread.current = false;
        setRemembered(s);
      },
      (err: unknown) => {
        if (!alive.current || g !== libGen.current) return;
        confirmed.current = { checkEverything: false };
        screenUnread.current = true;
        setScreenError(sentenceOf(err, FIND_SCREEN_TEXT.screenUnreadable));
        setRemembered({ checkEverything: false });
      },
    );
  }, [api, readProjects, epoch]);

  /** Another library (or none): nothing of the old one is kept — lists, settings, answers still out (R258 I1). */
  const forgetLibrary = useCallback(() => {
    libGen.current++;
    projectsRead.current = null;
    putChain.current = Promise.resolve();
    switchBusy.current = false;
    confirmed.current = { checkEverything: false };
    screenUnread.current = false;
    setProjects(undefined);
    setProjectsError(undefined);
    setRemembered(undefined);
    setScreenError(undefined);
    setCheckSending(undefined);
    setSwitchError(undefined);
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
          // After a lost stream, what happened meanwhile is read.
          if (opened) {
            readProjects();
            emit({ kind: "refresh" });
          }
          opened = true;
        };
        for await (const ev of client.events({ signal: ac.signal, onOpen })) {
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
            if (d.libraryId && known === undefined) {
              known = d.libraryId;
              if (noLibraryRef.current) {
                forgetLibrary();
                setNoLibrary(false);
              }
              continue;
            }
            // The same library: a project may have been locked, unlocked, created or removed, or the mode changed (M8).
            readProjects();
            emit({ kind: "refresh" });
            continue;
          }
          emit({ kind: "event", ev });
        }
      } catch {
        // the stream dropped: listen again shortly
      }
      if (!ac.signal.aborted) retry = setTimeout(() => void listen(), RECONNECT_MS);
    };
    void listen();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, readProjects, forgetLibrary]);

  const asked = projectInQuery(loc.search);
  // A project named in the address again (a link) takes over from the one chosen here.
  useEffect(() => setChosen(undefined), [asked]);
  const list = projects ?? [];
  const holds = (p: string | undefined): p is string => !!p && isValidId(p) && list.some((x) => x.id === p);
  const projectId =
    projects && remembered ? (holds(chosen) ? chosen : holds(asked) ? asked : holds(remembered.projectId) ? remembered.projectId : (list.find((p) => p.unlocked)?.id ?? list[0]?.id)) : undefined;
  const project = list.find((p) => p.id === projectId);

  // The chosen project's collections; the remembered collection only if it is one of them.
  useEffect(() => {
    setCollections(undefined);
    setCollectionId("");
    if (!projectId) return;
    let live = true;
    lib.collections.list(projectId).then(
      (r) => {
        if (!live) return;
        setCollections(r.collections);
        const want = confirmed.current.projectId === projectId ? confirmed.current.collectionId : undefined;
        if (want && r.collections.some((c) => c.id === want)) setCollectionId(want);
      },
      () => live && setCollections([]),
    );
    return () => {
      live = false;
    };
  }, [lib, projectId, epoch]);

  /**
   * One PUT of the remembered settings, after those before it: built from the last CONFIRMED answer plus its own
   * change. On success that answer is the new confirmed one; on a failure the controls show the confirmed one (M2).
   */
  const put = (change: (base: FindScreenSettings) => FindScreenSettings, h: { done?: (s: FindScreenSettings) => void; failed: (err: unknown) => void; always?: () => void }) => {
    const g = libGen.current;
    const run = async () => {
      if (!alive.current || g !== libGen.current) return;
      try {
        const s = await api.putScreen(change(confirmed.current));
        if (!alive.current || g !== libGen.current) return;
        confirmed.current = { ...s };
        screenUnread.current = false;
        setRemembered(s);
        h.done?.(s);
      } catch (err) {
        if (!alive.current || g !== libGen.current) return;
        setRemembered({ ...confirmed.current });
        h.failed(err);
      } finally {
        if (alive.current && g === libGen.current) h.always?.();
      }
    };
    putChain.current = putChain.current.then(run, run);
  };

  /** After a refused change of a select: both selects show what the service last confirmed. */
  const selectsBack = () => {
    const c = confirmed.current;
    setChosen(c.projectId);
    if (c.projectId) navigate(findHref(c.projectId), { replace: true });
    setCollectionId(c.collectionId && collections?.some((x) => x.id === c.collectionId) ? c.collectionId : "");
  };
  const rememberFailed = (err: unknown) => {
    setSettingsError(`This computer could not remember the choice. ${sentenceOf(err, "")}`.trim());
    selectsBack();
  };

  const pickProject = (pid: string) => {
    if (!holds(pid) || pid === projectId) return;
    setChosen(pid);
    setSettingsError(undefined);
    navigate(findHref(pid), { replace: true });
    put((b) => ({ checkEverything: b.checkEverything, projectId: pid }), { failed: rememberFailed });
  };
  const pickCollection = (cid: string) => {
    setCollectionId(cid);
    setSettingsError(undefined);
    const pid = projectId;
    put((b) => ({ checkEverything: b.checkEverything, ...(pid ? { projectId: pid } : {}), ...(cid ? { collectionId: cid } : {}) }), { failed: rememberFailed });
  };

  const confirmedCheck = remembered?.checkEverything ?? false;
  const shownCheck = checkSending ?? confirmedCheck;
  const toggle = () => {
    if (switchBusy.current || !remembered) return;
    switchBusy.current = true;
    const next = !shownCheck;
    setCheckSending(next);
    setSwitchError(undefined);
    put((b) => ({ ...b, checkEverything: next }), {
      done: () => setSwitchVersion((v) => v + 1),
      // Back to what the service stores, and why.
      failed: (err) => setSwitchError(`“Check everything I have” could not be changed. ${sentenceOf(err, "")}`.trim()),
      always: () => {
        switchBusy.current = false;
        setCheckSending(undefined);
      },
    });
  };

  /** The queue's answer says what is stored; used only while the remembered settings could not be read (M3). */
  const onStoredCheck = useCallback((v: boolean) => {
    if (!screenUnread.current || confirmed.current.checkEverything === v) return;
    confirmed.current = { ...confirmed.current, checkEverything: v };
    setRemembered((r) => (r ? { ...r, checkEverything: v } : r));
  }, []);

  if (noLibrary) {
    return (
      <main className="ao-page ao-find" aria-labelledby={`${ids}-h`}>
        <h1 id={`${ids}-h`}>Find and acquire</h1>
        <p role="status">{FIND_SCREEN_TEXT.noLibrary}</p>
      </main>
    );
  }

  return (
    <main className="ao-page ao-find" aria-labelledby={`${ids}-h`}>
      <h1 id={`${ids}-h`}>Find and acquire</h1>
      <div className="ao-find__bar">
        <label className="ao-find__field">
          Project
          <select value={projectId ?? ""} onChange={(e) => pickProject(e.target.value)} disabled={!projects?.length}>
            {!projectId && <option value="">{projects ? "No project" : "Reading the projects…"}</option>}
            {list.map((p) => (
              <option key={p.id} value={p.id} dir="auto">
                {p.unlocked ? p.name : `${p.name} (locked)`}
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
            onChange={toggle}
          />
          Check everything I have
        </label>
      </div>
      {screenError && (
        <p role="alert" className="ao-error">
          <UserText>{screenError}</UserText>
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
      {projectsError && (
        <p role="alert" className="ao-error">
          <UserText>{projectsError}</UserText>
        </p>
      )}
      {projects && remembered && !projectId && !projectsError && <p>{FIND_SCREEN_TEXT.noProject}</p>}
      {projectId && project && (
        <ProjectQueue
          key={`${epoch}\u0000${projectId}`}
          bus={bus}
          api={api}
          lib={lib}
          project={project}
          collectionId={collectionId}
          text={text}
          setText={setText}
          checkEverything={confirmedCheck}
          switchVersion={switchVersion}
          onStoredCheck={onStoredCheck}
          onUnlocked={readProjects}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// One project's box and queue

interface Held {
  view: FindEntryView;
  seq: number;
}

interface Meta {
  readOnly: boolean;
  stopped?: FindQueueResponse["stopped"];
  unreadableLines: number;
  lockedProjectsNotChecked: number;
}

interface DialogState {
  entry: FindEntryView;
  busy: boolean;
  error?: string;
}

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
  readOnly: boolean;
  stopped: boolean;
  onAction: (a: FindAction) => void;
}) {
  const { entries, places, busy, errors, readOnly, stopped, onAction } = props;
  return (
    <>
      {entries.map((e) => (
        <FindEntryRow key={e.id} entry={e} onAction={onAction} place={places[e.id]} busy={busy[e.id]} readOnly={readOnly} stopped={stopped} error={errors[e.id]} />
      ))}
    </>
  );
});

function ProjectQueue(props: {
  bus: QueueBus;
  api: FindApi;
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
}) {
  const { bus, api, lib, project, collectionId, text, setText, checkEverything, switchVersion, onStoredCheck, onUnlocked } = props;
  const projectId = project.id;
  const ids = useId();

  const [entries, setEntries] = useState<FindEntryView[] | undefined>();
  const [meta, setMeta] = useState<Meta | undefined>();
  const [locked, setLocked] = useState(false);
  /** The queue cannot be read at all (409): the service's sentence in its place. */
  const [unreadable, setUnreadable] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  /** The library cannot be reached (503 LIBRARY_OFFLINE): the service's sentence (R258 M4). */
  const [offline, setOffline] = useState<string | undefined>();
  const [busy, setBusyState] = useState<Record<string, FindActKind>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [places, setPlaces] = useState<Record<string, FindPlace>>({});
  const [dialog, setDialogState] = useState<DialogState | null>(null);
  const [openSource, setOpenSource] = useState<{ projectId: string; sourceId: string; from: HTMLElement | null } | null>(null);
  const [said, setSaid] = useState<Said>({ words: [], n: 0 });
  const [addBusy, setAddBusyState] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const [focusTarget, setFocusTarget] = useState<{ to: string; n: number } | null>(null);

  const alive = useRef(true);
  /** Moves on at a lock or when the library goes: every answer of the time before is dropped. */
  const gen = useRef(0);
  /** The order of what the screen took from the service (see the header). */
  const clock = useRef(0);
  const held = useRef(new Map<string, Held>());
  /** Entries known gone, with the number of what said so. */
  const gone = useRef(new Map<string, number>());
  const metaSeq = useRef(0);
  const firstRead = useRef(true);
  const busyRef = useRef<Record<string, FindActKind>>({});
  const acting = useRef(new Set<string>());
  const dialogRef = useRef<DialogState | null>(null);
  const pendingSay = useRef<Words | null>(null);
  const soon = useRef<{ again: boolean } | null>(null);
  const addBusyRef = useRef(false);
  const placeKeys = useRef(new Map<string, string>());
  const placeQueue = useRef<Array<{ id: string; key: string }>>([]);
  const placeRunning = useRef(0);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastFocus = useRef<{ el: HTMLElement; entryId: string | undefined } | null>(null);
  const sourceRef = useRef<HTMLElement>(null);
  /** When the last coalesced read started (R258 M7). */
  const lastSoon = useRef(0);

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

  /** Said once in the polite region; while the dialog is open (the page is inert) it waits for the dialog to close. */
  const say = useCallback((words: Words) => {
    if (dialogRef.current) {
      pendingSay.current = words;
      return;
    }
    setSaid((s) => ({ words, n: s.n + 1 }));
  }, []);
  useEffect(() => {
    if (!dialog && pendingSay.current) {
      const w = pendingSay.current;
      pendingSay.current = null;
      setSaid((s) => ({ words: w, n: s.n + 1 }));
    }
  }, [dialog]);

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
   * One entry from an act's answer, in its place in the order: `seq` was drawn when the act was SENT, so a read that
   * started after it wins (R258 M1). Returns the entry as now shown.
   */
  const takeOne = useCallback(
    (v: FindEntryView, seq: number): FindEntryView => {
      const cur = held.current.get(v.id);
      if ((gone.current.get(v.id) ?? -1) >= seq || (cur && cur.seq > seq)) return cur?.view ?? v;
      held.current.set(v.id, { view: cur && same(cur.view, v) ? cur.view : v, seq });
      commit();
      askPlaces([v]);
      return v;
    },
    [commit, askPlaces],
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
        const cur = held.current.get(v.id);
        if (cur && cur.seq > start) continue;
        held.current.set(v.id, { view: cur && same(cur.view, v) ? cur.view : v, seq: start });
      }
      for (const [id, h] of [...held.current]) {
        if (present.has(id) || h.seq > start) continue;
        held.current.delete(id);
        gone.current.set(id, start);
      }
      if (start > metaSeq.current) {
        metaSeq.current = start;
        setMeta({ readOnly: r.readOnly, ...(r.stopped ? { stopped: r.stopped } : {}), unreadableLines: r.unreadableLines, lockedProjectsNotChecked: r.lockedProjectsNotChecked });
        if (typeof r.checkEverything === "boolean") onStoredCheck(r.checkEverything);
        setOffline(undefined);
        setUnreadable(undefined);
        setLoadError(undefined);
        setLocked(false);
      }
      commit();
      const now = [...held.current.values()].map((h) => h.view);
      askPlaces(now);
      // A row's change of state is said; several at once are counted, not each one.
      if (firstRead.current) {
        firstRead.current = false;
        return;
      }
      const changed = now.filter((v) => {
        const b = before.get(v.id);
        return b && b.state !== v.state && !acting.current.has(v.id);
      });
      if (changed.length === 1) {
        const v = changed[0]!;
        say(saidOf(v, !!r.stopped));
      } else if (changed.length > 1) say([`${changed.length} entries in the queue changed.`]);
    },
    [commit, askPlaces, say, onStoredCheck],
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

  /** One read of the queue (it may overlap another; the numbers keep the order). */
  const readOnce = useCallback(async (): Promise<void> => {
    const start = ++clock.current;
    const g = gen.current;
    try {
      const r = await api.queue(projectId);
      if (!alive.current || g !== gen.current) return;
      applyQueue(r, start);
    } catch (err) {
      if (!alive.current || g !== gen.current || start < metaSeq.current) return;
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
    }
  }, [api, projectId, applyQueue, markLocked]);

  const readNow = useCallback(() => void readOnce(), [readOnce]);
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
          await readOnce();
        } while (mark.again && alive.current && g === gen.current && soon.current === mark);
      } finally {
        if (soon.current === mark) soon.current = null;
      }
    })();
  }, [readOnce]);

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
        if (sig.kind === "refresh" || findProgressOf(sig.ev, projectId)) readSoon();
      }),
    [bus, projectId, readSoon],
  );
  useEffect(() => {
    if (openSource) sourceRef.current?.focus();
  }, [openSource]);

  // ---- focus ----
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.to === "box") boxRef.current?.focus();
    else listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focusTarget.to)}"] [data-entry-text]`)?.focus();
  }, [focusTarget]);
  // When the control the researcher used has gone, focus goes to its row's next control (else its text, else the box).
  useEffect(() => {
    const lf = lastFocus.current;
    const now = document.activeElement;
    if (!lf || lf.el.isConnected || (now && now !== document.body && now.isConnected)) return;
    const rowEl = lf.entryId ? listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(lf.entryId)}"]`) : null;
    const target = rowEl?.querySelector<HTMLElement>(".ao-find__actions button:not([disabled])") ?? rowEl?.querySelector<HTMLElement>("[data-entry-text]") ?? boxRef.current;
    target?.focus();
  });
  const noteFocus = (e: FocusEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const inDialog = el.closest('[role="dialog"]');
    const entryId = inDialog ? dialogRef.current?.entry.id : el.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
    lastFocus.current = { el, entryId };
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
    const seq = ++clock.current;
    try {
      const v = await call();
      if (!alive.current || g !== gen.current) return;
      say(saidOf(takeOne(v, seq), !!meta?.stopped));
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
      say(["Removed “", { user: e.typed }, "” from the queue."]);
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

  // Stable for the memoised rows: reads what it needs from refs and the latest closure.
  const actRef = useRef<(a: FindAction) => void>(() => {});
  actRef.current = (a: FindAction) => {
    const e = a.entry;
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    switch (a.kind) {
      case "choose":
        if (readOnly || dialogRef.current || busyRef.current[e.id]) return;
        setDialog({ entry: e, busy: false });
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
      case "remove":
        void remove(e);
        return;
    }
  };
  const onAction = useCallback((a: FindAction) => actRef.current(a), []);

  const choose = async (candidateId: string | null) => {
    const d = dialogRef.current;
    if (!d || d.busy || readOnly) return;
    const e = d.entry;
    setDialog({ ...d, busy: true, error: undefined });
    acting.current.add(e.id);
    const g = gen.current;
    const seq = ++clock.current;
    try {
      const v = await api.choose(projectId, e.id, candidateId);
      if (!alive.current || g !== gen.current) return;
      const shown = takeOne(v, seq);
      setDialog(null);
      say(saidOf(shown, !!meta?.stopped));
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      if (isProjectLocked(err)) {
        markLocked();
        return;
      }
      // The service's sentence, in the dialog; nothing is changed here.
      setDialog((cur) => (cur ? { ...cur, busy: false, error: sentenceOf(err, "The choice could not be made. Try again.") } : cur));
      if (err instanceof ApiClientError && (err.status === 404 || err.status === 409)) readSoon();
    } finally {
      acting.current.delete(e.id);
    }
  };

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
    const seq = ++clock.current;
    try {
      const r = await api.add(projectId, { lines: kept.map((k) => k.line), ...(collectionId ? { collectionId } : {}) });
      if (!alive.current || g !== gen.current) return;
      for (const v of r.added) takeOne(v, seq);
      // The box was read-only while the add was out, so it holds exactly what was sent (R258 I2).
      setText("");
      boxRef.current?.focus();
      say([addedText(r)]);
      readSoon();
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      if (isProjectLocked(err)) {
        markLocked();
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
      addBusyRef.current = false;
      if (alive.current) {
        setAddBusyState(false);
        boxRef.current?.focus();
      }
    }
  };
  const onBoxKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
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
        <UnlockProject
          api={lib}
          project={project}
          onUnlocked={() => {
            setLocked(false);
            readNow();
            onUnlocked();
          }}
        />
      )}

      <h2 id={`${ids}-queue`}>Queue</h2>
      {loadError && !entries?.length && (
        <p role="alert" className="ao-error">
          <UserText>{loadError}</UserText>
        </p>
      )}
      {!locked && !unreadable && !offline && (
        <>
          {!entries && !loadError && <p>{FIND_SCREEN_TEXT.loading}</p>}
          <ul ref={listRef} className="ao-find__queue" aria-labelledby={`${ids}-queue`} data-count={entries?.length ?? 0}>
            {entries && <Rows entries={entries} places={places} busy={busy} errors={errors} readOnly={readOnly} stopped={!!stopped} onAction={onAction} />}
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

      {dialog && (
        <ChooseWorkDialog
          entry={dialog.entry}
          busy={dialog.busy}
          {...(dialog.error ? { error: dialog.error } : {})}
          onChoose={(id) => void choose(id)}
          onClose={() => {
            if (!dialogRef.current?.busy) setDialog(null);
          }}
        />
      )}
    </div>
  );
}
