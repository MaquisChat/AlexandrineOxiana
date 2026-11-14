/**
 * "Zotero" (`/settings/zotero`, Task Z9; R78, R145, R248, R250, R252; Amendments A8–A11 of the Zotero sync plan): the
 * researcher sees what their saved key can read, chooses which Zotero library goes into which project, starts and
 * stops a sync, and reads how each sync went. Nothing here runs by itself: a key check, a save, a run and a stop each
 * happen only when the researcher presses for them (the scheduler is a later task).
 *
 * The key (R78, R248): typed only into the key field moved out of the import wizard (ZoteroKeyField), which stores it
 * through PUT /secrets/zotero-api-key and empties itself; "Check the key" then asks POST /zotero/key-check with no body.
 * The screen itself never holds, sends, shows, logs or stores the key.
 *
 * The service is the authority, and every word about a sync is the service's: a link's line is the state's `status`;
 * a history row is the shared `zoteroSyncStatusLine` of its record; a refusal is the service's own sentence; a pause is
 * said with the shared reason sentences. Nothing is told by colour or symbol alone, and nothing reads as success for a
 * run that did not succeed.
 *
 * Order (R250, R268 I1): the state (and the history beside it) is read at load, after every "finished" event, after an
 * act and after a lost event stream came back; reads are coalesced (one at a time, and one more if asked meanwhile), and
 * a read's answer carries the number drawn when its request STARTED, so of two reads the later-started wins. A WRITE's
 * answer (a settings save) draws its number when it ARRIVES: it is applied then and wins over every read that started
 * before; exactly one fresh read follows it, and "Saved." is said with its answer on screen. The run in progress comes from the events and the state's
 * `running` only (the history never holds it): an answer whose request started before the latest event does not
 * overrule what that event said about the run. Answers after the screen was left, the library was closed or another
 * library was opened are dropped. The form's draft is kept apart from the service's state until it is saved, so a
 * reading or an event never takes away an unsaved choice.
 *
 * Focus (R145): "Sync with Zotero now" and "Stop syncing" are one button whose words change, so focus stays on it;
 * a control that goes away while it had focus (a pause cleared by its remedy) hands focus to its row's "Keep in step",
 * or to "Check the key" — never to the page.
 */
import {
  ZOTERO_SYNC_EVERY_MINUTES,
  ZOTERO_SYNC_REASON_TEXT,
  ZOTERO_SYNC_SENTENCES,
  zoteroSyncReasonText,
  zoteroSyncStatusLine,
  type ZoteroKeyCheckResponse,
  type ZoteroSyncEveryMinutes,
  type ZoteroSyncRun,
  type ZoteroSyncSettingsRequest,
  type ZoteroSyncStateResponse,
} from "@ao/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { importApi, isValidId, type ProjectInfo } from "../api/import";
import { libraryApi, type LibraryState } from "../api/library";
import { zoteroSyncApi, zoteroSyncEventOf } from "../api/zoteroSync";
import { UserText } from "../components/UserText";
import { ZoteroKeyField } from "../components/ZoteroKeyField";
import "../components/library.css";
import { inAppLink } from "../navigation";
import { reportHref } from "./import/shared";
import { projectQueueHref } from "./import/ReviewQueue";
import { defaultOptions } from "./import/StepOptions";
import "./ZoteroSync.css";

/** The plan's words (Z9 Accept 1–4) and this screen's own few. */
export const ZOTERO_TEXT = {
  intro: "Your Zotero libraries come into this app and stay in step. Nothing in Zotero is ever changed, and nothing here is deleted because it was deleted in Zotero.",
  noFiles: "It cannot read attached files, so only references, notes and highlights will come in.",
  noNotes: "It cannot read notes.",
  canWrite: "This key could also change your Zotero library. This app never does, but a key that can only read is safer: at zotero.org, Settings, Security, make a new key with “Allow write access” off.",
  automaticHint: "Only while this library is open and the project is unlocked.",
  // This screen's own sentences (listed in the task's report).
  beforeCheck: "Press “Check the key” to see the names of your Zotero libraries; until then, linked libraries are shown by their Zotero number.",
  notListed: "The last key check did not list this library.",
  goneRemedy: "When the key can read this library again, “Check the key” turns syncing of it back on.",
  locked: "Unlock the project to sync.",
  pausedUnknown: "Syncing of this library is paused.",
  noLinks: "No Zotero library is linked to a project yet.",
  noHistory: "No sync has been recorded on this computer yet.",
  chooseProject: "Choose a project",
  saved: "Saved.",
  starting: "Starting the sync…",
  totalUnknown: "the number of items is not known yet.",
  loading: "Reading the Zotero sync settings…",
  noLibrary: "No library is open.",
} as const;

const EVERY_TEXT: Record<ZoteroSyncEveryMinutes, string> = { 30: "Every 30 minutes", 60: "Every hour", 240: "Every 4 hours" };
/** The history shows the newest 20 (plan Z9 Accept 6). */
const HISTORY_SHOWN = 20;
/** The running line changes at most once a second (Accept 5). */
const PROGRESS_EVERY_MS = 1000;
const RECONNECT_MS = 2000;
/** "Sync with Zotero now" and "Stop syncing" are one button: a press this soon after its last act ended is the rest of a double click. */
const SECOND_PRESS_MS = 500;
/** Personal library: "My library" (Accept 3). */
const MY_LIBRARY = "My library";

const num = (n: number) => n.toLocaleString("en-GB");
/** A library the last check did not name: by its Zotero number. */
export const refLabel = (ref: string): string => {
  const [type, id] = ref.split(":");
  return type === "group" ? `Zotero group ${id ?? ""}` : `Zotero library ${ref}`;
};
/** The service's own sentence for a refusal. */
const sentenceOf = (err: unknown, fallback: string) => (err instanceof ApiClientError && err.message ? err.message : fallback);

type Link = ZoteroSyncStateResponse["links"][number];
interface RowDraft {
  keep: boolean;
  projectId: string;
}
interface Draft {
  automatic: boolean;
  everyMinutes: ZoteroSyncEveryMinutes;
  rows: Record<string, RowDraft>;
}
/** The run as the events and the state say it; `ref` is unknown between a 202 and the first word about it. */
interface RunView {
  ref?: string;
  done: number;
  total: number;
}
interface Said {
  text: ReactNode;
  n: number;
}

/** What the field a refusal names is, from the service's own sentence (`"links[1].projectId" …`). */
function refusedField(message: string, links: ZoteroSyncSettingsRequest["links"]): string | undefined {
  const m = /^"([^"]+)"/u.exec(message);
  if (!m) return undefined;
  const f = m[1]!;
  if (f === "automatic" || f === "everyMinutes") return f;
  const l = /^links\[(\d+)\](?:\.(\w+))?$/u.exec(f);
  const ref = l ? links[Number(l[1])]?.ref : undefined;
  if (!ref) return undefined;
  return l![2] === "projectId" ? `project:${ref}` : `keep:${ref}`;
}

export function ZoteroSync({ client }: { client: ApiClient }) {
  const api = useMemo(() => zoteroSyncApi(client), [client]);
  const imp = useMemo(() => importApi(client), [client]);
  const lib = useMemo(() => libraryApi(client), [client]);
  const ids = useId();

  const [state, setState] = useState<ZoteroSyncStateResponse | undefined>();
  const [history, setHistory] = useState<ZoteroSyncRun[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [noLibrary, setNoLibraryState] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  /** What the last key check of this visit said (names live only here, R78: no storage). */
  const [access, setAccess] = useState<ZoteroKeyCheckResponse | undefined>();
  const [checkError, setCheckError] = useState<string | undefined>();
  /** The last check's summary is shown only while that check is the last word (R268 M2: a failed one takes it off). */
  const [checkOk, setCheckOk] = useState(false);
  /** How many entries wait in each linked project's review queue now (the library screen's count, R268 M3). */
  const [reviewWaiting, setReviewWaiting] = useState<Record<string, number>>({});
  const appliedWaiting = useRef(0);
  const [checking, setChecking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [focusField, setFocusField] = useState<{ field: string; n: number } | null>(null);
  const [runError, setRunError] = useState<string | undefined>();
  const [running, setRunningState] = useState<RunView | null>(null);
  const [shown, setShown] = useState<RunView | null>(null);
  const [live, setLive] = useState<Said>({ text: "", n: 0 });
  const [, setTick] = useState(0);

  const alive = useRef(true);
  /** Moves on when the library closes or another opens: answers drawn before are dropped. */
  const gen = useRef(0);
  /** The number each reading drew when its request started; the highest applied so far. */
  const readSeq = useRef(0);
  const appliedState = useRef(0);
  const appliedHistory = useRef(0);
  /** Counts `zotero.sync` events: a reading started before the latest one does not overrule it about the run. */
  const eventSeq = useRef(0);
  const reading = useRef<{ again: boolean } | null>(null);
  const runBusy = useRef(false);
  const runEndedAt = useRef(-Infinity);
  const checkBusy = useRef(false);
  const saveBusy = useRef(false);
  const runningRef = useRef<RunView | null>(null);
  const libraryId = useRef<string | undefined>(undefined);
  const libraryMode = useRef<string | undefined>(undefined);
  const noLibraryRef = useRef(false);
  const lastShownAt = useRef(-Infinity);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mainRef = useRef<HTMLElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<{ el: HTMLElement; ref: string | undefined } | null>(null);
  const stateRef = useRef<ZoteroSyncStateResponse | undefined>(undefined);
  const accessRef = useRef<ZoteroKeyCheckResponse | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(progressTimer.current);
    };
  }, []);

  const setNoLibrary = useCallback((v: boolean) => {
    noLibraryRef.current = v;
    setNoLibraryState(v);
  }, []);

  const say = useCallback((text: ReactNode) => setLive((s) => ({ text, n: s.n + 1 })), []);

  /** The run, and its line shown at most once a second (the latest value wins when the second is up). */
  const setRunning = useCallback((next: RunView | null) => {
    runningRef.current = next;
    setRunningState(next);
    clearTimeout(progressTimer.current);
    if (!next) {
      lastShownAt.current = -Infinity;
      setShown(null);
      return;
    }
    const wait = lastShownAt.current + PROGRESS_EVERY_MS - Date.now();
    if (wait <= 0) {
      lastShownAt.current = Date.now();
      setShown(next);
      return;
    }
    progressTimer.current = setTimeout(() => {
      if (!alive.current) return;
      lastShownAt.current = Date.now();
      setShown(runningRef.current);
    }, wait);
  }, []);

  /** A reading of the state, applied only if no later-started one was; its `running` only if no event came since it started. */
  const applyState = useCallback(
    (s: ZoteroSyncStateResponse, seq: number, eventsAtStart: number) => {
      if (seq < appliedState.current) return;
      appliedState.current = seq;
      stateRef.current = s;
      setState(s);
      setLoadError(undefined);
      if (eventSeq.current === eventsAtStart) setRunning(s.running ? { ref: s.running.ref, done: s.running.done, total: s.running.total } : null);
    },
    [setRunning],
  );

  /** The library went away (closed, or another opened): nothing of it stays, and every answer still out is dropped. */
  const forget = useCallback(() => {
    gen.current++;
    reading.current = null;
    stateRef.current = undefined;
    accessRef.current = undefined;
    setState(undefined);
    setHistory(undefined);
    setAccess(undefined);
    setCheckOk(false);
    setReviewWaiting({});
    setDraft(null);
    setFieldErrors({});
    setSaveError(undefined);
    setRunError(undefined);
    setCheckError(undefined);
    setRunning(null);
  }, [setRunning]);

  /**
   * The number waiting in each linked project's review queue, as the library screen reads it (GET /projects/:id/review,
   * limit 0): one request per linked project per reading of the state (so at load, after a run ends, after a save),
   * never per event; not for a locked project or a library that cannot be changed. Taken by the reading's number.
   */
  const readWaiting = useCallback(
    (s: ZoteroSyncStateResponse, seq: number, g: number) => {
      if (s.readOnly || s.settingsNewer) return;
      const pids = [...new Set(s.links.filter((l) => l.waitingFor !== "project-locked").map((l) => l.projectId))].filter((p) => isValidId(p));
      void Promise.all(pids.map((p) => lib.reviewQueue.count(p).then((n) => [p, n] as const, () => undefined))).then((got) => {
        if (!alive.current || g !== gen.current || seq < appliedWaiting.current) return;
        appliedWaiting.current = seq;
        const next: Record<string, number> = {};
        for (const e of got) if (e) next[e[0]] = e[1];
        setReviewWaiting(next);
      });
    },
    [lib],
  );

  /** The state and the history, read again; one at a time, and one more when asked meanwhile. */
  const read = useCallback(async (): Promise<void> => {
    if (reading.current) {
      reading.current.again = true;
      return;
    }
    const mark = { again: false };
    reading.current = mark;
    const g = gen.current;
    try {
      do {
        mark.again = false;
        const seq = ++readSeq.current;
        const ev = eventSeq.current;
        const [s, h] = await Promise.allSettled([api.state(), api.history()]);
        if (!alive.current || g !== gen.current) return;
        if (s.status === "fulfilled") {
          applyState(s.value, seq, ev);
          readWaiting(s.value, seq, g);
        } else if (!stateRef.current) {
          const e = s.reason;
          if (e instanceof ApiClientError && e.code === "LIBRARY_OFFLINE") setNoLibrary(true);
          setLoadError(sentenceOf(e, "The Zotero sync settings could not be read."));
        }
        if (h.status === "fulfilled" && seq >= appliedHistory.current) {
          appliedHistory.current = seq;
          setHistory(h.value.runs);
        }
      } while (mark.again);
    } finally {
      if (reading.current === mark) reading.current = null;
    }
  }, [api, applyState, setNoLibrary, readWaiting]);

  const readProjects = useCallback(() => {
    const g = gen.current;
    imp.projects().then(
      (p) => alive.current && g === gen.current && setProjects(p),
      () => {},
    );
  }, [imp]);

  // ---- load ----
  useEffect(() => {
    void read();
    readProjects();
  }, [read, readProjects]);

  // ---- live updates: zotero.sync, and the library's own state ----
  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let opened = false;
    const listen = async () => {
      try {
        const onOpen = () => {
          // After a lost stream, what happened meanwhile is read from the service.
          if (opened) void read();
          opened = true;
        };
        for await (const ev of client.events({ signal: ac.signal, onOpen })) {
          if (!alive.current) return;
          if (ev.type === "library.state" && ev.data && typeof ev.data === "object") {
            const d = ev.data as LibraryState;
            if (d.open === false) {
              libraryId.current = undefined;
              libraryMode.current = undefined;
              forget();
              setNoLibrary(true);
              continue;
            }
            if (d.libraryId && d.libraryId !== libraryId.current) {
              const fresh = libraryId.current !== undefined;
              libraryId.current = d.libraryId;
              libraryMode.current = d.mode;
              if (fresh || noLibraryRef.current) {
                // Opened again, or another library in its place: read afresh.
                forget();
                setNoLibrary(false);
                void read();
                readProjects();
              }
              continue;
            }
            // The mode changed (read-write, read-only): the service says what it means here.
            if (d.mode && d.mode !== libraryMode.current) {
              const known = libraryMode.current !== undefined;
              libraryMode.current = d.mode;
              if (known) void read();
            }
            continue;
          }
          const e = zoteroSyncEventOf(ev);
          if (!e) continue;
          eventSeq.current++;
          if (e.state === "finished") {
            const cur = runningRef.current;
            setRunning({ ref: e.ref, done: cur?.ref === e.ref ? cur.done : 0, total: cur?.ref === e.ref ? cur.total : 0 });
            if (e.run) {
              const label = labelOfRef(e.ref, accessRef.current);
              const line = zoteroSyncStatusLine(e.run, new Date());
              say(
                <>
                  <UserText>{label}</UserText>: <UserText>{line}</UserText>
                </>,
              );
            }
            void read();
          } else {
            setRunning({ ref: e.ref, done: e.done ?? 0, total: e.total ?? 0 });
          }
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
  }, [client, read, readProjects, forget, say, setRunning, setNoLibrary]);

  // ---- back-off: the button comes back by one timer to that instant, not by asking again ----
  const backoffAt = state?.backoffUntil ? Date.parse(state.backoffUntil) : NaN;
  useEffect(() => {
    if (!Number.isFinite(backoffAt)) return;
    const wait = backoffAt - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), wait + 1);
    return () => clearTimeout(t);
  }, [backoffAt]);
  const backingOff = Number.isFinite(backoffAt) && backoffAt > Date.now();

  // ---- focus: a control that went away while it had focus hands it on (never to the page) ----
  useEffect(() => {
    const lf = lastFocus.current;
    const now = document.activeElement;
    if (!lf || lf.el.isConnected || (now && now !== document.body && now.isConnected)) return;
    const keep = lf.ref ? mainRef.current?.querySelector<HTMLElement>(`[data-keep-ref="${CSS.escape(lf.ref)}"]`) : null;
    (keep ?? checkButton.current ?? mainRef.current?.querySelector<HTMLElement>("h1"))?.focus();
  });
  const noteFocus = (e: FocusEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    lastFocus.current = { el, ref: el.closest<HTMLElement>("[data-row-ref]")?.dataset.rowRef };
  };
  useEffect(() => {
    if (!focusField) return;
    mainRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusField.field)}"]`)?.focus();
  }, [focusField]);

  // ---- the key ----
  const checkKey = async () => {
    if (checkBusy.current) return;
    checkBusy.current = true;
    setChecking(true);
    setCheckError(undefined);
    const g = gen.current;
    try {
      const a = await api.checkKey();
      if (!alive.current || g !== gen.current) return;
      accessRef.current = a;
      setAccess(a);
      setCheckOk(true);
      say(<UserText>{a.summary}</UserText>);
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      // The earlier check's sentence is no longer the last word (the names it gave stay on the rows).
      setCheckOk(false);
      setLive((s) => (s.text ? { text: "", n: s.n + 1 } : s));
      setCheckError(sentenceOf(err, "The key could not be checked. Try again in a moment."));
    } finally {
      checkBusy.current = false;
      if (alive.current) setChecking(false);
    }
    // A successful check clears pauses in the service (R248); a refusal may carry a back-off: either way, read again.
    if (alive.current && g === gen.current) void read();
  };
  const keyChanged = () => {
    // What the old key could read says nothing about the new one.
    accessRef.current = undefined;
    setAccess(undefined);
    setCheckOk(false);
    setCheckError(undefined);
    void read();
  };

  // ---- the rows: the libraries the last check listed, then every stored link it did not ----
  const links = state?.links ?? [];
  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (access?.personal.library) m.set(`user:${access.userId}`, MY_LIBRARY);
    for (const g of access?.groups ?? []) m.set(g.ref, g.name);
    return m;
  }, [access]);
  const rows: Array<{ ref: string; label: string; link?: Link; listed: boolean }> = [];
  for (const [ref, name] of names) rows.push({ ref, label: name, link: links.find((l) => l.ref === ref), listed: true });
  for (const l of links) if (!names.has(l.ref)) rows.push({ ref: l.ref, label: refLabel(l.ref), link: l, listed: false });

  const stored = (ref: string): RowDraft => {
    const l = links.find((x) => x.ref === ref);
    return l ? { keep: true, projectId: l.projectId } : { keep: false, projectId: "" };
  };
  const fromState = (): Draft => ({ automatic: state?.automatic ?? false, everyMinutes: state?.everyMinutes ?? 60, rows: {} });
  const valueOf = (ref: string): RowDraft => draft?.rows[ref] ?? stored(ref);
  const automatic = draft ? draft.automatic : (state?.automatic ?? false);
  const everyMinutes = draft ? draft.everyMinutes : (state?.everyMinutes ?? 60);
  const edit = (fn: (d: Draft) => Draft) => {
    // R268 M1: the form is inert while a save is out, so nothing edited under it can be lost.
    if (saveBusy.current) return;
    setDraft((d) => fn(d ?? fromState()));
  };
  const editRow = (ref: string, patch: Partial<RowDraft>) => edit((d) => ({ ...d, rows: { ...d.rows, [ref]: { ...(d.rows[ref] ?? stored(ref)), ...patch } } }));

  /**
   * The whole request: every row kept, in the order shown. A stored link's structure and duplicates go back unchanged;
   * a new link gets what the import wizard gives a Zotero Web import (StepOptions' `defaultOptions` under the project's
   * rules: collections, or none where names are pseudonymised (R64), and merge).
   */
  const request = async (d: { automatic: boolean; everyMinutes: ZoteroSyncEveryMinutes; rows: Array<{ ref: string } & RowDraft> }): Promise<ZoteroSyncSettingsRequest> => {
    const out: ZoteroSyncSettingsRequest["links"] = [];
    const confirmed = stateRef.current?.links ?? [];
    for (const r of d.rows) {
      if (!r.keep) continue;
      const was = confirmed.find((l) => l.ref === r.ref);
      // A link that stays in its project keeps its options exactly; moved to another project, it takes that project's
      // defaults, as a new link does (R268 M5).
      if (was && was.projectId === r.projectId) {
        out.push({ ref: r.ref, projectId: r.projectId, structure: was.structure, duplicates: was.duplicates });
        continue;
      }
      const policy = isValidId(r.projectId) ? await imp.policy(r.projectId).catch(() => ({ pseudonymizeNames: true, encryptionRequired: true })) : { pseudonymizeNames: true, encryptionRequired: true };
      const o = defaultOptions(policy);
      out.push({ ref: r.ref, projectId: r.projectId, structure: o.structure, duplicates: o.duplicates });
    }
    return { automatic: d.automatic, everyMinutes: d.everyMinutes, links: out };
  };

  /**
   * A save: the answer is a reading of the state; a refusal that names a field is said there, with focus. "Save" sends
   * the draft with no `resume` anywhere, so an undone library stays paused (R265). "Turn syncing on again" sends the
   * service's last confirmed settings (never the unsaved draft) with `resume: true` on that one link. While it is out
   * the form is inert (R268 M1).
   */
  const save = async (which: "draft" | { resume: string }) => {
    const confirmed = stateRef.current;
    if (saveBusy.current || !confirmed || confirmed.readOnly || confirmed.settingsNewer) return;
    saveBusy.current = true;
    setSaving(true);
    setSaveError(undefined);
    setFieldErrors({});
    const g = gen.current;
    try {
      const body =
        which === "draft"
          ? await request({ automatic, everyMinutes, rows: rows.map((r) => ({ ref: r.ref, ...valueOf(r.ref) })) })
          : await request({ automatic: confirmed.automatic, everyMinutes: confirmed.everyMinutes, rows: confirmed.links.map((l) => ({ ref: l.ref, keep: true, projectId: l.projectId })) }).then((r) => ({
              ...r,
              links: r.links.map((l) => (l.ref === which.resume ? { ...l, resume: true as const } : l)),
            }));
      if (!alive.current || g !== gen.current) return;
      const ev = eventSeq.current;
      try {
        const s = await api.saveSettings(body);
        if (!alive.current || g !== gen.current) return;
        // R268 I1: a write's answer is numbered when it arrives, so it wins over every read that started before it.
        applyState(s, ++readSeq.current, ev);
        if (which === "draft") setDraft(null);
        say(ZOTERO_TEXT.saved);
        // Exactly one fresh reading follows (one already out is overruled, and the coalesced read asks once more).
        void read();
      } catch (err) {
        if (!alive.current || g !== gen.current) return;
        const msg = sentenceOf(err, "The settings could not be saved.");
        const field = err instanceof ApiClientError && err.status === 400 ? refusedField(msg, body.links) : undefined;
        if (field) {
          setFieldErrors({ [field]: msg });
          setFocusField((f) => ({ field, n: (f?.n ?? 0) + 1 }));
        } else setSaveError(msg);
        if (err instanceof ApiClientError && (err.code === "READ_ONLY" || err.code === "LIBRARY_OFFLINE")) void read();
      }
    } finally {
      saveBusy.current = false;
      if (alive.current) setSaving(false);
    }
  };

  // ---- run and stop: one request per press ----
  const isRunning = running !== null;
  const runOrStop = async () => {
    if (runBusy.current || !state || state.readOnly) return;
    if (!isRunning && backingOff) return;
    if (Date.now() - runEndedAt.current < SECOND_PRESS_MS) return;
    runBusy.current = true;
    setRunError(undefined);
    const g = gen.current;
    const ev = eventSeq.current;
    const stopping = isRunning;
    try {
      if (stopping) await api.stop();
      else {
        await api.run();
        // Started: until the service says which library, the run is "starting" (an event may already have said more).
        if (alive.current && g === gen.current && eventSeq.current === ev) setRunning({ done: 0, total: 0 });
      }
    } catch (err) {
      if (!alive.current || g !== gen.current) return;
      setRunError(sentenceOf(err, stopping ? "The sync could not be stopped." : "The sync could not be started."));
    } finally {
      runBusy.current = false;
      runEndedAt.current = Date.now();
    }
    if (alive.current && g === gen.current) void read();
  };

  // ---- the page ----
  const ro = state?.readOnly ?? false;
  const newer = state?.settingsNewer ?? false;
  const titleId = `${ids}-h`;

  if (noLibrary && !state) {
    return (
      <main className="ao-page ao-zotero" aria-labelledby={titleId}>
        <h1 id={titleId}>Zotero</h1>
        <p role="status">
          <UserText>{loadError ?? ZOTERO_TEXT.noLibrary}</UserText>
        </p>
      </main>
    );
  }

  const progressLine = (): ReactNode => {
    if (!shown) return null;
    if (!shown.ref) return ZOTERO_TEXT.starting;
    const label = <UserText>{labelOfRef(shown.ref, access)}</UserText>;
    return shown.total > 0 ? (
      <>
        Syncing “{label}”: {num(shown.done)} of {num(shown.total)} items
      </>
    ) : (
      <>
        Syncing “{label}”: {ZOTERO_TEXT.totalUnknown}
      </>
    );
  };
  const backoffText = state?.backoffUntil ? zoteroSyncReasonText("backing-off", new Date(), state.backoffUntil) : "";
  const shownHistory = (history ?? []).slice(0, HISTORY_SHOWN);

  return (
    <main ref={mainRef} className="ao-page ao-zotero" aria-labelledby={titleId} onFocus={noteFocus}>
      <h1 id={titleId} tabIndex={-1}>
        Zotero
      </h1>
      <p>{ZOTERO_TEXT.intro}</p>
      <p className="ao-visually-hidden" role="status" aria-live="polite" data-testid="zotero-live">
        {live.text ? <span key={live.n}>{live.text}</span> : null}
      </p>
      {!state && !loadError && <p role="status">{ZOTERO_TEXT.loading}</p>}
      {!state && loadError && (
        <p role="alert" className="ao-error">
          <UserText>{loadError}</UserText>
        </p>
      )}
      {state && ro && (
        <p className="ao-zotero__note">
          <UserText>{ZOTERO_SYNC_REASON_TEXT["library-read-only"]}</UserText>
        </p>
      )}
      {state && newer && (
        <p className="ao-zotero__note" data-testid="zotero-newer">
          <UserText>{ZOTERO_SYNC_SENTENCES.settingsNewer}</UserText>
        </p>
      )}

      {state && !ro && (
        <section aria-labelledby={`${ids}-key`}>
          <h2 id={`${ids}-key`}>Your Zotero key</h2>
          <ZoteroKeyField api={imp} onChanged={keyChanged} />
          <p>
            <button type="button" ref={checkButton} aria-disabled={checking || undefined} onClick={() => void checkKey()}>
              Check the key
            </button>
          </p>
          {access && checkOk && (
            <div data-testid="zotero-key-result">
              <p>
                <UserText>{access.summary}</UserText>
              </p>
              {access.personal.library && !access.personal.files && <p>{ZOTERO_TEXT.noFiles}</p>}
              {access.personal.library && !access.personal.notes && <p>{ZOTERO_TEXT.noNotes}</p>}
              {(access.personal.write || access.groups.some((g) => g.write)) && <p>{ZOTERO_TEXT.canWrite}</p>}
            </div>
          )}
          {checkError && (
            <p role="alert" className="ao-error" data-testid="zotero-key-error">
              <UserText>{checkError}</UserText>
            </p>
          )}
        </section>
      )}

      {state && !newer && (
        <section aria-labelledby={`${ids}-libs`} data-testid="zotero-libraries">
          <h2 id={`${ids}-libs`}>Libraries to keep in step</h2>
          {!access && links.length > 0 && !ro && <p className="ao-zotero__note">{ZOTERO_TEXT.beforeCheck}</p>}
          {rows.length === 0 && <p>{ZOTERO_TEXT.noLinks}</p>}
          {rows.map((r) => (
            <LibraryRow
              key={r.ref}
              ids={`${ids}-${r.ref}`}
              refName={r.ref}
              label={r.label}
              link={r.link}
              listed={r.listed || !access}
              readOnly={ro}
              value={valueOf(r.ref)}
              projects={projects}
              errors={fieldErrors}
              busy={saving || checking}
              saving={saving}
              waitingNow={reviewWaiting[r.link?.projectId ?? ""] ?? 0}
              onKeep={(keep) => editRow(r.ref, { keep })}
              onProject={(projectId) => editRow(r.ref, { projectId })}
              onResume={() => void save({ resume: r.ref })}
              onCheck={() => void checkKey()}
            />
          ))}
        </section>
      )}

      {state && !ro && !newer && (
        <section aria-labelledby={`${ids}-auto`}>
          <h2 id={`${ids}-auto`}>Automatic sync</h2>
          <p>
            <label className="ao-zotero__option">
              <input
                type="checkbox"
                data-field="automatic"
                checked={automatic}
                disabled={saving}
                aria-describedby={[`${ids}-auto-hint`, fieldErrors.automatic ? `${ids}-auto-err` : ""].filter(Boolean).join(" ")}
                onChange={(e) => edit((d) => ({ ...d, automatic: e.target.checked }))}
              />
              <span>Sync automatically while the app is open</span>
            </label>
          </p>
          <p id={`${ids}-auto-hint`} className="ao-zotero__note">
            {ZOTERO_TEXT.automaticHint}
          </p>
          {fieldErrors.automatic && (
            <p id={`${ids}-auto-err`} className="ao-error">
              <UserText>{fieldErrors.automatic}</UserText>
            </p>
          )}
          <p>
            <label className="ao-zotero__field">
              <span>How often</span>
              <select
                data-field="everyMinutes"
                value={String(everyMinutes)}
                disabled={saving}
                aria-describedby={fieldErrors.everyMinutes ? `${ids}-every-err` : undefined}
                onChange={(e) => edit((d) => ({ ...d, everyMinutes: Number(e.target.value) as ZoteroSyncEveryMinutes }))}
              >
                {ZOTERO_SYNC_EVERY_MINUTES.map((m) => (
                  <option key={m} value={String(m)}>
                    {EVERY_TEXT[m]}
                  </option>
                ))}
              </select>
            </label>
          </p>
          {fieldErrors.everyMinutes && (
            <p id={`${ids}-every-err`} className="ao-error">
              <UserText>{fieldErrors.everyMinutes}</UserText>
            </p>
          )}
          <p>
            <button type="button" aria-disabled={saving || undefined} onClick={() => void save("draft")}>
              Save
            </button>
          </p>
          {saveError && (
            <p role="alert" className="ao-error" data-testid="zotero-save-error">
              <UserText>{saveError}</UserText>
            </p>
          )}
        </section>
      )}

      {state && !ro && !newer && (
        <div>
          <p>
            <button
              type="button"
              aria-disabled={(!isRunning && backingOff) || undefined}
              aria-describedby={!isRunning && backingOff ? `${ids}-backoff` : undefined}
              onClick={() => void runOrStop()}
            >
              {isRunning ? "Stop syncing" : "Sync with Zotero now"}
            </button>
            {!isRunning && backingOff && (
              <>
                {" "}
                <span id={`${ids}-backoff`} className="ao-zotero__note" data-testid="zotero-backoff">
                  <UserText>{backoffText}</UserText>
                </span>
              </>
            )}
          </p>
          {runError && (
            <p role="alert" className="ao-error" data-testid="zotero-run-error">
              <UserText>{runError}</UserText>
            </p>
          )}
        </div>
      )}
      {state && (
        <p role="status" data-testid="zotero-progress" className="ao-zotero__progress">
          {progressLine()}
        </p>
      )}

      {state && (
        <section aria-labelledby={`${ids}-hist`}>
          <h2 id={`${ids}-hist`}>History</h2>
          {history && shownHistory.length === 0 && <p>{ZOTERO_TEXT.noHistory}</p>}
          <ul aria-label="Sync history" className="ao-zotero__history">
            {shownHistory.map((r) => (
              <li key={r.id}>
                <UserText>{labelOfRef(r.ref, access)}</UserText>: <UserText>{zoteroSyncStatusLine(r, new Date())}</UserText>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/** A library's name for this visit: from the last key check, else by its Zotero number. */
function labelOfRef(ref: string, access: ZoteroKeyCheckResponse | undefined): string {
  if (access?.personal.library && ref === `user:${access.userId}`) return MY_LIBRARY;
  return access?.groups.find((g) => g.ref === ref)?.name ?? refLabel(ref);
}

// ---------------------------------------------------------------------------------------------
// One library

interface RowProps {
  ids: string;
  refName: string;
  label: string;
  link: Link | undefined;
  listed: boolean;
  readOnly: boolean;
  value: RowDraft;
  projects: ProjectInfo[];
  errors: Record<string, string>;
  busy: boolean;
  /** A save is out: the row's settings are inert (R268 M1). */
  saving: boolean;
  /** How many entries wait in this link's project's review queue now (R268 M3). */
  waitingNow: number;
  onKeep(keep: boolean): void;
  onProject(projectId: string): void;
  onResume(): void;
  onCheck(): void;
}

/** "for “<name>”", heard but not seen (after a space the caller writes): every control's name says which library it is for. */
function ForName({ label }: { label: string }) {
  return (
    <span className="ao-visually-hidden">
      for “<UserText>{label}</UserText>”
    </span>
  );
}

const KNOWN_PAUSES: readonly string[] = ["undone", "key-refused", "library-gone"];

function LibraryRow({ ids, refName, label, link, listed, readOnly, value, projects, errors, busy, saving, waitingNow, onKeep, onProject, onResume, onCheck }: RowProps) {
  const headingId = `${ids}-h`;
  const keepErr = errors[`keep:${refName}`];
  const projectErr = errors[`project:${refName}`];
  const last = link?.lastRun;
  // R268 M6: a pause this build does not know is still a pause.
  const unknownPause = !!link && ((!!link.paused && !KNOWN_PAUSES.includes(link.paused)) || (link.waitingFor === "paused" && !link.paused));
  const linkable = !!last?.batchId && isValidId(last.projectId) && isValidId(last.batchId);
  return (
    <section className="ao-zotero__lib" aria-labelledby={headingId} data-row-ref={refName}>
      <h3 id={headingId}>
        <UserText>{label}</UserText>
      </h3>
      {!listed && <p className="ao-zotero__note">{ZOTERO_TEXT.notListed}</p>}
      {link && (
        <p className="ao-zotero__status">
          <UserText>{link.status}</UserText>
        </p>
      )}
      {!link && !readOnly && (
        <p className="ao-zotero__status">
          <UserText>{zoteroSyncStatusLine(undefined, new Date())}</UserText>
        </p>
      )}
      {link?.paused === "undone" && (
        <p className="ao-zotero__pause">
          <UserText>{ZOTERO_SYNC_REASON_TEXT["sync-undone"]}</UserText>{" "}
          {!readOnly && (
            <button type="button" aria-disabled={busy || undefined} onClick={onResume}>
              Turn syncing on again{" "}
              <ForName label={label} />
            </button>
          )}
        </p>
      )}
      {link?.paused === "key-refused" && (
        <p className="ao-zotero__pause">
          <UserText>{ZOTERO_SYNC_REASON_TEXT["key-refused"]}</UserText>{" "}
          {!readOnly && (
            <button type="button" aria-disabled={busy || undefined} onClick={onCheck}>
              Check the key{" "}
              <ForName label={label} />
            </button>
          )}
        </p>
      )}
      {link?.paused === "library-gone" && (
        <p className="ao-zotero__pause">
          <UserText>{ZOTERO_SYNC_REASON_TEXT["library-gone"]}</UserText> {ZOTERO_TEXT.goneRemedy}{" "}
          {!readOnly && (
            <button type="button" aria-disabled={busy || undefined} onClick={onCheck}>
              Check the key{" "}
              <ForName label={label} />
            </button>
          )}
        </p>
      )}
      {unknownPause && <p className="ao-zotero__pause">{ZOTERO_TEXT.pausedUnknown}</p>}
      {link?.waitingFor === "project-locked" && <p className="ao-zotero__pause">{ZOTERO_TEXT.locked}</p>}
      {!readOnly && (
        <div className="ao-zotero__controls">
          <label className="ao-zotero__option">
            <input
              type="checkbox"
              data-keep-ref={refName}
              data-field={`keep:${refName}`}
              checked={value.keep}
              disabled={saving}
              aria-describedby={keepErr ? `${ids}-keep-err` : undefined}
              onChange={(e) => onKeep(e.target.checked)}
            />
            <span>
              Keep “<UserText>{label}</UserText>” in step
            </span>
          </label>
          {keepErr && (
            <p id={`${ids}-keep-err`} className="ao-error">
              <UserText>{keepErr}</UserText>
            </p>
          )}
          <label className="ao-zotero__field">
            <span>
              Into project <ForName label={label} />
            </span>
            <select data-field={`project:${refName}`} value={value.projectId} disabled={saving} aria-describedby={projectErr ? `${ids}-project-err` : undefined} onChange={(e) => onProject(e.target.value)}>
              <option value="">{ZOTERO_TEXT.chooseProject}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id} disabled={p.unlocked === false && p.id !== link?.projectId}>
                  {p.name}
                  {p.unlocked === false ? " (locked)" : ""}
                </option>
              ))}
            </select>
          </label>
          {projectErr && (
            <p id={`${ids}-project-err`} className="ao-error">
              <UserText>{projectErr}</UserText>
            </p>
          )}
        </div>
      )}
      {!readOnly && link && (linkable || waitingNow > 0) && (
        <p className="ao-zotero__links">
          {linkable && (
            <a href={reportHref(last!.projectId, last!.batchId!)} onClick={inAppLink}>
              Import report <ForName label={label} />
            </a>
          )}
          {waitingNow > 0 && (
            <a href={projectQueueHref(link.projectId)} onClick={inAppLink}>
              Review {num(waitingNow)} waiting{" "}
              <ForName label={label} />
            </a>
          )}
        </p>
      )}
    </section>
  );
}
