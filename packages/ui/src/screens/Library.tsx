/**
 * The library (mockup screens 1 and 5): projects with their profile badges on the side, then the
 * selected project's collections and tags; the main pane has search, the drop zone, the sources and
 * the open source's details. The service's `library.state` and `job.progress` events drive the
 * status banners (read-only, offline, index rebuilding, integrity and project warnings) and the
 * jobs indicator. While the library is read-only the drop zone and every edit button are off. A
 * locked encrypted project shows UnlockProject in place of its sources. "New project" opens the
 * new-project dialog (Task 60); the project it creates is selected through the address, like any
 * other selection. "New recovery code…" (an unlocked encrypted project) opens the new-recovery-code
 * dialog (Task 61).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AttachOutcome, Collection, CurrentLibrary, LibraryApi, LibraryState, ProfileId, IndexStatus, ProjectSummary, SourcePage, Tag } from "../api/library";
import { errorText, isProjectLocked, knownProfiles } from "../api/library";
import { ApiClientError, SERVICE_NO_ANSWER, STREAM_OPEN_TIMEOUT_MS, STREAM_QUIET_TIMEOUT_MS } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, readWithin } from "../api/firstRead";
import { CollectionTree } from "../components/CollectionTree";
import { DropZone } from "../components/DropZone";
import { JobsIndicator, type Job } from "../components/JobsIndicator";
import { PageReads, usePageHost } from "../components/PageReads";
import { ProjectNav } from "../components/ProjectNav";
import { RecheckProjectButton, useProjectRecheck } from "../components/RecheckProject";
import { WorkLines } from "../components/WorkLines";
import { SearchBox } from "../components/SearchBox";
import { SourceTable } from "../components/SourceTable";
import { PendingWritesDialog } from "../components/PendingWritesDialog";
import { StatusBanner, bannersFor, useNoticeDismiss, volumeOf } from "../components/StatusBanner";
import { TagList } from "../components/TagList";
import { UserText } from "../components/UserText";
import { ATTACH_CLOSED_TEXT } from "@ao/shared";
import { findHref } from "../api/find";
import { zoteroSyncEventOf } from "../api/zoteroSync";
import { watchedFoldersHref } from "../api/watchedFolders";
import "../components/library.css";
import { navigate as goTo, PATHS } from "../navigation";
import { clearPendingFind, guardPendingFind, setPendingFind } from "../reader/readerHandoff";
import { readerHref } from "../routes/reader";
import { listInWords, madeSince, NewProject, SameNamedProjects, stillToFillIn, type UnresolvedCreate } from "./NewProject";
import { NewRecoveryCode } from "./NewRecoveryCode";
import { SourceDetail } from "./SourceDetail";
import { UnlockProject } from "./UnlockProject";
import { LibraryZotero, type ZoteroEvents } from "./LibraryZotero";
import { noteLostCreate } from "./lostCreates";

/** Where "needs review" outcomes send the researcher (the import review queue, Task 35). */
export const REVIEW_QUEUE_PATH = PATHS.reviewQueue;
const governanceHref = (projectId: string) => `${PATHS.governance}?project=${encodeURIComponent(projectId)}`;
const importHref = (projectId: string) => `${PATHS.importWizard}?project=${encodeURIComponent(projectId)}`;
const captureHref = (projectId: string) => `${PATHS.capture}?project=${encodeURIComponent(projectId)}`;
/** The project's whole review queue (Task 67), or that source's entries in it. */
export const reviewQueueHref = (projectId: string, sourceId?: string) =>
  `${REVIEW_QUEUE_PATH}?project=${encodeURIComponent(projectId)}${sourceId ? `&source=${encodeURIComponent(sourceId)}` : ""}`;

export interface LibraryProps {
  api: LibraryApi;
  current: CurrentLibrary;
  /** The library's folder as last known, for "reconnecting when <volume> returns". */
  libraryPath?: string;
  onSwitchLibrary?: () => void;
  /** In-app navigation for links (falls back to ordinary links). */
  navigate?: (path: string) => void;
  /** The service reports no library open any more (library.state open:false). */
  onClosed?: () => void;
  /**
   * The project named in the address (`?project=<id>`). It is selected whenever it changes; an id
   * that is not one of the library's selects nothing and says so. Without one, the first project.
   */
  projectFromAddress?: string | undefined;
  /** The selected project changed (the route keeps it in the address). */
  onProjectSelected?: (id: string) => void;
  /**
   * The first-use tools question's banner (Task 48c, R164), shown under the status banners; `hidden`
   * while a locked project's unlock screen is shown (it stays mounted, so it is not asked anew).
   */
  firstUse?: (hidden: boolean) => ReactNode;
  /**
   * FR-756 B: how long each of the screen's reads of what it shows (the projects, the collections and tags, the sources)
   * is waited for before it is given up as a read that got no answer (FIRST_READ_TIMEOUT_MS; smaller in tests).
   */
  firstReadMs?: number;
  /**
   * FR-756 C (R586 M2): how long the event stream is waited for to open before it is closed and tried afresh, after the
   * screen's usual pause (STREAM_OPEN_TIMEOUT_MS; smaller in tests). A stream that has opened is never ended by it.
   */
  streamOpenMs?: number;
  /**
   * R641 D2: how long an open event stream may deliver nothing (not even the service's keep-alive) before it is taken
   * as lost, closed and, after the same pause, opened afresh (STREAM_QUIET_TIMEOUT_MS; smaller in tests).
   */
  streamQuietMs?: number;
}

const message = (err: unknown, fallback: string) => errorText(err, fallback);
/**
 * FR-756 B (R586 M5): a read that got no answer says its own sentence — "did not answer in time" where the limit ended
 * it, "could not be reached" where it failed — never both run together.
 */
const noAnswerText = (err: unknown) => (err as ApiClientError).message;

/** FR-756 B: the screen's reads that "Try again" (and a new opening of the event stream) can make again. */
type FirstRead = "projects" | "collections" | "sources";

/** Sources asked for per page; "Load more" asks for the next page by offset. */
export const SOURCE_PAGE_SIZE = 100;
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

const OUTCOME_TEXT: Record<AttachOutcome["outcome"], string> = {
  created: "Added as a new source",
  attached: "Added to an existing source",
  duplicate: "Already in the library",
  "needs-review": "Stored; it",
  failed: "Not added",
  // Said in its own sentence (ATTACH_CLOSED_TEXT, below); never shown on its own.
  cancelled: "Not added",
};

const JOB_LABELS: Record<string, string> = { recheck: "Rechecking sources", ocr: "Recognising text", proxy: "Making viewing copies", import: "Importing", transcription: "Transcribing recordings" };

export function Library({ api, current, libraryPath, onSwitchLibrary, navigate, onClosed, projectFromAddress, onProjectSelected, firstUse, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS, streamQuietMs = STREAM_QUIET_TIMEOUT_MS }: LibraryProps) {
  const [state, setState] = useState<LibraryState>({
    mode: current.mode,
    ...(current.readOnlyReason ? { readOnlyReason: current.readOnlyReason } : {}),
    ...(current.lockedBy ? { lockedBy: current.lockedBy } : {}),
    ...(current.index ? { index: current.index } : {}),
  });
  const [index, setIndex] = useState<{ done: number; total: number } | undefined>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [profiles, setProfiles] = useState<Record<string, ProfileId[]>>({});
  const [projectId, setProjectId] = useState<string | undefined>();
  const [unlockedHere, setUnlockedHere] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<{ tags: Tag[]; workspaceTags: Tag[] }>({ tags: [], workspaceTags: [] });
  const [filter, setFilter] = useState<{ text: string; collection?: string | undefined; tag?: string | undefined }>({ text: "" });
  const [sources, setSources] = useState<SourcePage | undefined>();
  const [openSource, setOpenSource] = useState<string | undefined>();
  const [outcomes, setOutcomes] = useState<AttachOutcome[] | undefined>();
  /** "Resolve…" (R27) is open; focus goes back to the button that opened it. */
  const [resolving, setResolving] = useState<{ from: HTMLElement | null } | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sourcesError, setSourcesError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * The list on screen answers the current search: false from a new search (or reload) until its
   * first page arrives, so "Load more" never asks at the old list's offset (FR-152).
   */
  const [listCurrent, setListCurrent] = useState(false);
  const [reload, setReload] = useState(0);
  /** The address named a project this library does not have (41b2 I1). */
  const [unknownProject, setUnknownProject] = useState(false);
  /** The new-project dialog is open. */
  const [creating, setCreating] = useState(false);
  const newProjectButton = useRef<HTMLButtonElement>(null);
  /** The new-recovery-code dialog is open, for this project. */
  const [recovering, setRecovering] = useState<ProjectSummary | null>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  // This computer's notices (Task 68): "Got it" asks once per notice; focus stays in the library.
  const bannersRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [noticeGone, setNoticeGone] = useState(0);
  useEffect(() => {
    if (noticeGone > 0) (bannersRef.current ?? mainRef.current)?.focus();
  }, [noticeGone]);
  const { onDismiss: dismissNotice, error: noticeError } = useNoticeDismiss(
    (kind) => api.libraries.dismissNotice(kind),
    (kind) => {
      setState((s) => ({ ...s, notices: (s.notices ?? []).filter((n) => n.kind !== kind) }));
      setNoticeGone((n) => n + 1);
    },
  );
  // FR-729: a warning kept with the library, dismissed for good: one request each; the banner goes, focus stays in the banners.
  const dismissing = useRef(new Set<string>());
  const [warningError, setWarningError] = useState<string | null>(null);
  const dismissWarning = (id: string) => {
    if (dismissing.current.has(id)) return;
    dismissing.current.add(id);
    setWarningError(null);
    api.libraries.dismissWarning(id).then(
      () => {
        dismissing.current.delete(id);
        setState((s) => ({ ...s, integrityWarnings: (s.integrityWarnings ?? []).filter((w) => w.keptId !== id) }));
        setNoticeGone((n) => n + 1);
      },
      (err: unknown) => {
        dismissing.current.delete(id);
        setWarningError(errorText(err, "The warning could not be dismissed."));
      },
    );
  };
  /** A dialog shows a recovery code not yet confirmed: a library close waits for it. */
  const holdClose = useRef(false);
  /** The library closed while that code was on screen. */
  const [closedUnder, setClosedUnder] = useState(false);
  /** A create whose answer was lost and could not be checked when the dialog closed (fix round 2). */
  const [unresolved, setUnresolved] = useState<{ create: UnresolvedCreate; state: "unknown" | "still-unknown" | "checking" | "not-created" | { found: ProjectSummary } | { many: ProjectSummary[] } } | null>(null);
  /** FR-187, FR-188: a project just made whose rules ask for what only the researcher can give: a hint, until dismissed. */
  const [toFillIn, setToFillIn] = useState<{ project: ProjectSummary; words: string[] } | null>(null);
  /** Counts library.state events: an open "Resolve…" dialog reads its list again on each. */
  const [stateSeq, setStateSeq] = useState(0);
  /** What the Zotero sync's events said (Task Z12: the lines under the header read again after a finished one), and whether the library is still open. */
  const [zoteroEvents, setZoteroEvents] = useState<ZoteroEvents>({ n: 0, finished: 0 });
  const [libraryOpen, setLibraryOpen] = useState(true);
  /**
   * FR-756 B: the reads that got no answer (none at all, or none in time), with what is said for each; "Try again" is
   * offered while there is one. `tries` moves each read on: a press, or a new opening of the event stream.
   */
  const [unanswered, setUnanswered] = useState<Partial<Record<FirstRead, string>>>({});
  const [tries, setTries] = useState<Record<FirstRead, number>>({ projects: 0, collections: 0, sources: 0 });
  /** The reads out now (begun and not settled): a new opening of the stream makes them again, as they may never settle. */
  const out = useRef(new Set<FirstRead>());
  const answered = useCallback((r: FirstRead) => {
    out.current.delete(r);
    setUnanswered((u) => {
      if (!(r in u)) return u;
      const { [r]: _gone, ...rest } = u;
      return rest;
    });
  }, []);
  const noAnswer = useCallback((r: FirstRead, err: unknown) => {
    out.current.delete(r);
    setUnanswered((u) => ({ ...u, [r]: noAnswerText(err) }));
  }, []);
  const unansweredRef = useRef(unanswered);
  unansweredRef.current = unanswered;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  /**
   * FR-756 B: what has not been read is read again — a read that got no answer, one still out (it may never settle),
   * and the projects whenever they have not been read. Once per press, once per new opening of the event stream.
   */
  const readAgain = useCallback(() => {
    const again = (r: FirstRead) => r in unansweredRef.current || out.current.has(r) || (r === "projects" && !projectsRef.current);
    const which = (["projects", "collections", "sources"] as const).filter(again);
    if (which.length) setTries((t) => ({ ...t, ...Object.fromEntries(which.map((r) => [r, t[r] + 1])) }));
  }, []);
  const readAgainRef = useRef(readAgain);
  readAgainRef.current = readAgain;
  /** "Try again" was pressed: once nothing is left unanswered, focus goes to the main pane if it was lost. */
  const triedAgain = useRef(false);
  const showTryAgain = Object.keys(unanswered).length > 0;
  /**
   * R602 M1: one sentence at a time. A read that could not be made at all explains one that got no answer in time, so
   * "could not be reached" is said alone where any read failed so; "did not answer in time" where every one was given up.
   */
  const unansweredText = showTryAgain ? (Object.values(unanswered).find((t) => t !== SERVICE_NO_ANSWER) ?? SERVICE_NO_ANSWER) : undefined;
  /**
   * FR-756's remainder: the source's detail, opened beside the list, is part of this page. While the screen says its
   * one sentence, the panel says none of its own, the sentence covers the panel's read too (R602 M1), and the one
   * "Try again" reads it again as well (R605 I2). The panel is a side panel: once the screen's own read is unanswered the
   * screen says the page's sentence in its own place, even where the panel said it first (R641 C2 i).
   */
  const { page, sentence: pageSentence, retryAll, tryAgainRef } = usePageHost({
    sentence: unansweredText,
    out: () => out.current.size > 0 || !projectsRef.current,
    retry: () => {
      triedAgain.current = true;
      readAgain();
    },
  }, { panelsOnly: true });
  useEffect(() => {
    if (showTryAgain || !triedAgain.current) return;
    triedAgain.current = false;
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected) mainRef.current?.focus();
  }, [showTryAgain]);

  const readOnly = state.mode !== "read-write";
  const project = projects?.find((p) => p.id === projectId);
  const locked = !!project && project.encrypted && !project.unlocked && !unlockedHere.has(project.id);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  /**
   * The current list of sources' generation: a new search, a reload, another project, a lock or
   * unmounting moves it on, and a "Load more" answer for an older generation is dropped (41b1 I1).
   */
  const pageGen = useRef(0);
  const morePage = useRef<AbortController | undefined>(undefined);
  const staleMore = useCallback(() => {
    pageGen.current++;
    morePage.current?.abort();
    morePage.current = undefined;
    setLoadingMore(false);
  }, []);
  useEffect(() => staleMore, [staleMore]);

  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  /** The new-project dialog's create whose outcome is being checked or cannot be told (FR-194). */
  const dialogUncertain = useRef<UnresolvedCreate | null>(null);
  const libraryNameRef = useRef(current.name);
  /**
   * FR-194 (R461 b): as the library closes, each create whose outcome is not known (in the dialog, or this screen's
   * notice) is left for the chooser, which asks the researcher to look for it when the library is open again.
   */
  const noteUnknownCreates = useCallback(() => {
    const u = unresolvedRef.current;
    const creates = [u && (u.state === "unknown" || u.state === "still-unknown" || u.state === "checking") ? u.create : null, dialogUncertain.current];
    for (const c of creates) if (c) noteLostCreate(current.libraryId, libraryNameRef.current, c.name);
  }, [current.libraryId]);

  /**
   * Forgets everything read from a project that is now locked (R114): its collections, tags,
   * sources, open source and attach outcomes; UnlockProject shows in their place.
   */
  const forgetDecrypted = useCallback(() => {
    // A search's words waiting for the reader are not kept past a lock (Task R12).
    clearPendingFind();
    staleMore();
    setCollections([]);
    setTags({ tags: [], workspaceTags: [] });
    setSources(undefined);
    setOpenSource(undefined);
    setOutcomes(undefined);
  }, [staleMore]);
  const markLocked = useCallback(
    (id: string) => {
      setUnlockedHere((s) => new Set([...s].filter((x) => x !== id)));
      // The service says it is locked, so it is an encrypted project, whatever the list said.
      setProjects((list) => list?.map((p) => (p.id === id ? { ...p, encrypted: true, unlocked: false } : p)));
      forgetDecrypted();
    },
    [forgetDecrypted],
  );
  /** A failure: PROJECT_LOCKED returns to UnlockProject; anything else is shown in plain words. */
  const fail = useCallback(
    (err: unknown, fallback: string, show: (m: string) => void = setError) => {
      if (isProjectLocked(err) && projectIdRef.current) {
        markLocked(projectIdRef.current);
        setError(undefined);
        return;
      }
      show(message(err, fallback));
    },
    [markLocked],
  );
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  /** "Recheck project" (Task 34d, R99): its job's events come from the stream below; when it finishes, the open source's badges are read again. */
  const [badgesVersion, setBadgesVersion] = useState(0);
  const recheck = useProjectRecheck(api, {
    onFinished: () => {
      setBadgesVersion((n) => n + 1);
      refresh();
    },
    onLocked: markLocked,
    firstReadMs,
  });
  const recheckEvent = useRef(recheck.onEvent);
  recheckEvent.current = recheck.onEvent;
  /** How many times the event stream below has connected again after dropping (R515 N2: the recheck asks again). */
  const [reconnects, setReconnects] = useState(0);

  // ---- service events: library state, index progress, background jobs ----
  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let streams = 0;
    const listen = async () => {
      const again = streams++ > 0;
      let first = true;
      // FR-756 B: at an opening after the stream was lost, without waiting for an event on it, what has not been read is
      // read again (as FR-750's screens do). The first opening, with the first reads still out, reads nothing more.
      const onOpen = () => {
        if (again) readAgainRef.current();
      };
      try {
        for await (const e of api.events({ signal: ac.signal, onOpen, openWithinMs: streamOpenMs, quietWithinMs: streamQuietMs })) {
          // A stream after a drop is open once its first event (the fresh state) arrives: what was missed is asked for.
          if (first) {
            first = false;
            if (again) setReconnects((n) => n + 1);
          }
          if (e.type === "library.state" && e.data && typeof e.data === "object") {
            const d = e.data as LibraryState;
            if (d.open === false) {
              setLibraryOpen(false);
              noteUnknownCreates();
              clearPendingFind();
              // A new project's recovery code on screen is never taken away (R134 I2): the dialog
              // says the library closed, and the library is left once the code is confirmed.
              if (holdClose.current) setClosedUnder(true);
              else closedRef.current?.();
              continue;
            }
            setLibraryOpen(true);
            // Each event is the whole state: a reason, lock holder or index state it no longer names is gone.
            setState(({ readOnlyReason: _r, lockedBy: _l, index: _i, ...s }) => ({ ...s, ...d }));
            setStateSeq((n) => n + 1);
          }
          const zotero = zoteroSyncEventOf(e);
          if (zotero) {
            const done = zotero.state === "finished";
            setZoteroEvents((z) => ({ n: z.n + 1, finished: z.finished + (done ? 1 : 0), ...(done ? {} : { run: { ref: zotero.ref, done: zotero.done ?? 0, total: zotero.total ?? 0 } }) }));
          }
          if (e.type === "job.progress" && e.data && typeof e.data === "object") {
            const d = e.data as { kind?: string; jobId?: string; done?: number; total?: number; finished?: boolean };
            if (typeof d.done !== "number" || typeof d.total !== "number") continue;
            // A project recheck shows its own progress by its button (announced at start and end only, R113).
            if (d.kind === "recheck") recheckEvent.current(e.data);
            else if (d.kind === "index") {
              setIndex({ done: d.done, total: d.total });
              // A finished rebuild: read the sources again, so a "needs rebuilding" note goes at once (N3).
              if (d.done >= d.total) refresh();
            }
            else {
              const key = `${d.kind ?? "job"}:${d.jobId ?? ""}`;
              const finished = d.finished === true || d.done >= d.total;
              const job: Job = { key, label: JOB_LABELS[d.kind ?? ""] ?? "Working", done: d.done, total: d.total };
              setJobs((list) => (finished ? list.filter((j) => j.key !== key) : [...list.filter((j) => j.key !== key), job]));
            }
          }
        }
      } catch {
        // the stream dropped, did not open in time (FR-756 C) or fell silent (R641 D2): listen again shortly (a fresh state arrives first)
      }
      if (!ac.signal.aborted) retry = setTimeout(() => void listen(), 2000);
    };
    void listen();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
  }, [api, noteUnknownCreates, streamOpenMs, streamQuietMs]);

  // ---- projects and their profile badges ----
  const showProjects = useCallback((list: ProjectSummary[]) => {
    setProjects(list);
    // The badges are the profiles the service reads from each project's rules (R118).
    setProfiles(Object.fromEntries(list.map((p) => [p.id, knownProfiles(p.profiles)])));
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    out.current.add("projects");
    readWithin((signal) => api.projects.list({ signal }), firstReadMs, ac.signal)
      .then(({ projects: list }) => {
        if (ac.signal.aborted) return;
        answered("projects");
        showProjects(list);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        if (isUnreachable(err)) return noAnswer("projects", err);
        // An answer, though a refusal: the give-up it followed is no longer true (R602 I2).
        answered("projects");
        setError(message(err, "The projects could not be read."));
      });
    return () => {
      ac.abort();
      out.current.delete("projects");
    };
  }, [api, showProjects, firstReadMs, tries.projects, answered, noAnswer]);
  const mounted = useRef(true);
  // Set again at mount: under strict mode (mount, clean-up, mount) the screen otherwise reads nothing after (FR-762).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Reads the project list again (after the new-project dialog closes, whatever the reason). */
  const reloadProjects = useCallback(async (keep?: ProjectSummary) => {
    const { projects: read } = await api.projects.list();
    // The project just created stays listed even if a read made before it was answered says otherwise.
    const list = keep && !read.some((p) => p.id === keep.id) ? [...read, keep] : read;
    if (mounted.current) showProjects(list);
    return list;
  }, [api, showProjects]);

  /**
   * Settles a create whose answer was lost (fix round 2): a successful read of the list says whether
   * the project was made; until then the notice stays. `auto`: the read made as the dialog closed.
   */
  /** A check is in flight: an automatic one does not start another (R463 M8). */
  const checkingNow = useRef(false);
  const checkUnresolved = useCallback(
    async (create: UnresolvedCreate, auto = false, quiet = false) => {
      // R463 M8: an automatic re-check (`quiet`) changes nothing on screen unless it settles the outcome, so the alert
      // that says the app cannot tell is not taken down and announced again at each one.
      if (quiet && checkingNow.current) return;
      checkingNow.current = true;
      if (!quiet) setUnresolved({ create, state: "checking" });
      try {
        const fresh = madeSince(await reloadProjects(), create);
        // FR-204, FR-205: more than one new project with that name is said, and none is taken for the one made then.
        if (mounted.current) setUnresolved((u) => (quiet && u?.create !== create ? u : { create, state: fresh.length > 1 ? { many: fresh } : fresh.length ? { found: fresh[0]! } : "not-created" }));
      } catch {
        if (mounted.current && !quiet) setUnresolved({ create, state: auto ? "unknown" : "still-unknown" });
      } finally {
        checkingNow.current = false;
      }
    },
    [reloadProjects],
  );
  // FR-182: a notice that cannot tell yet checks again by itself each time the service reports the library's state (it
  // is answering again); a check that fails leaves the notice as it was, and "Check again" stays.
  const unresolvedRef = useRef(unresolved);
  unresolvedRef.current = unresolved;
  useEffect(() => {
    const u = unresolvedRef.current;
    if (stateSeq && u && (u.state === "unknown" || u.state === "still-unknown")) void checkUnresolved(u.create, u.state === "unknown", true);
  }, [stateSeq, checkUnresolved]);
  const dialogClosed = (unresolvedCreate?: UnresolvedCreate, made?: ProjectSummary) => {
    setCreating(false);
    if (unresolvedCreate) void checkUnresolved(unresolvedCreate, true);
    else void reloadProjects(made).catch(() => {});
  };

  // ---- the selected project's collections and tags ----
  useEffect(() => {
    if (!projectId || locked) return answered("collections");
    let live = true;
    const ac = new AbortController();
    out.current.add("collections");
    readWithin((signal) => Promise.all([api.collections.list(projectId, { signal }), api.tags.list(projectId, { signal })]), firstReadMs, ac.signal)
      .then(([c, t]) => {
        if (!live) return;
        answered("collections");
        setCollections(c.collections);
        setTags({ tags: t.tags, workspaceTags: t.workspaceTags });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isUnreachable(err)) return noAnswer("collections", err);
        // An answer, though a refusal: the give-up it followed is no longer true (R602 I2).
        answered("collections");
        fail(err, "The collections and tags could not be read.");
      });
    return () => {
      live = false;
      ac.abort();
      out.current.delete("collections");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, locked, reload, firstReadMs, tries.collections]);

  // ---- the sources for the current search and filters ----
  useEffect(() => {
    staleMore();
    setListCurrent(false);
    if (!projectId || locked) return answered("sources");
    const ac = new AbortController();
    const asked = filter.text;
    out.current.add("sources");
    readWithin((signal) => api.sources.search(projectId, { ...query(), limit: SOURCE_PAGE_SIZE }, { signal }), firstReadMs, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        answered("sources");
        setSources(r);
        setListCurrent(true);
        setSearched(asked);
        setSourcesError(undefined); // only the sources' own error: other errors stay until dismissed or replaced
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        if (isUnreachable(err)) return noAnswer("sources", err);
        // An answer, though a refusal: the give-up it followed is no longer true (R602 I2).
        answered("sources");
        fail(err, "The sources could not be read.", setSourcesError);
      });
    return () => {
      ac.abort();
      out.current.delete("sources");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, locked, filter, reload, firstReadMs, tries.sources]);

  // ---- Task R12: "Show in the reader" for a hit in an annotation (no request per row: a row does not say whether it has a PDF) ----
  /** The text of the search whose answer is shown (what the reader is handed). */
  const [searched, setSearched] = useState("");
  /** "Show in the reader": the words searched for go to the reader in memory; the address carries ids only. */
  const showInReader = (sourceId: string) => {
    if (!projectId) return;
    setPendingFind(projectId, sourceId, searched);
    // Watched while the reader opens: a lock, a close or a switch on the way drops them.
    guardPendingFind((o) => api.events(o));
    (navigate ?? goTo)(readerHref(projectId, sourceId));
  };

  // ---- how many entries wait in the project's review queue (Task 67): read with the list, never for a locked project ----
  const [waiting, setWaiting] = useState<{ projectId: string; total: number } | undefined>();
  useEffect(() => {
    setWaiting(undefined);
    if (!projectId || locked) return;
    const ac = new AbortController();
    // FR-756 M4 (R602): given up silently at the limit, as when it fails.
    readWithin((signal) => api.reviewQueue.count(projectId, { signal }), firstReadMs, ac.signal)
      .then((total) => {
        if (!ac.signal.aborted) setWaiting({ projectId, total });
      })
      // Without the count (a read-only library, a lock meanwhile) the link is not offered; the list says why.
      .catch(() => {});
    return () => ac.abort();
  }, [api, projectId, locked, reload, firstReadMs]);

  // ---- the index (D8): when a rebuild ends, the sources are read again ----
  const indexState = state.index?.state;
  const wasRebuilding = useRef(indexState === "rebuilding");
  useEffect(() => {
    const before = wasRebuilding.current;
    wasRebuilding.current = indexState === "rebuilding";
    if (before && indexState !== "rebuilding") {
      setIndex(undefined);
      refresh();
    }
  }, [indexState, refresh]);
  // A list read while the index was being rebuilt is read again shortly (its end may have been missed).
  const listRebuilding = sources?.index?.state === "rebuilding";
  // A partial index (missing or unreadable, no rebuild completed since) holds only what was written
  // meanwhile: its list is never shown as the library's content (C1).
  const listIndex = sources?.index ?? state.index;
  const listPartial = !!listIndex && "partial" in listIndex && listIndex.partial === true;
  useEffect(() => {
    if (!listRebuilding) return;
    const t = setTimeout(refresh, 2000);
    return () => clearTimeout(t);
  }, [listRebuilding, sources, refresh]);

  const query = () => ({ text: filter.text, ...(filter.collection ? { collection: filter.collection } : {}), ...(filter.tag ? { tag: filter.tag } : {}) });

  const loadMore = async () => {
    if (!projectId || !sources || !listCurrent) return;
    const pid = projectId;
    const gen = pageGen.current;
    const ac = new AbortController();
    morePage.current?.abort();
    morePage.current = ac;
    const stale = () => gen !== pageGen.current || ac.signal.aborted || projectIdRef.current !== pid;
    setLoadingMore(true);
    try {
      const r = await api.sources.search(pid, { ...query(), limit: SOURCE_PAGE_SIZE, offset: sources.items.length }, { signal: ac.signal });
      if (stale()) return;
      // A late page is only ever added to the list it continues, never used as a whole list.
      setSources((cur) => (cur ? { ...r, items: [...cur.items, ...r.items.filter((x) => !cur.items.some((y) => y.id === x.id))] } : cur));
    } catch (err) {
      if (!stale()) fail(err, "More sources could not be read.", setSourcesError);
    } finally {
      if (!stale()) setLoadingMore(false);
      if (morePage.current === ac) morePage.current = undefined;
    }
  };

  const selectedRef = useRef(onProjectSelected);
  selectedRef.current = onProjectSelected;
  /**
   * The project this screen last wrote into the address, until the address shows it: a render with
   * an older address (a selection made just before) must not undo the selection.
   */
  const written = useRef<string | undefined>(undefined);
  const selectProject = useCallback(
    (id: string | undefined) => {
      setUnknownProject(false);
      if (id && selectedRef.current) {
        written.current = id;
        selectedRef.current(id);
      }
      if (id === projectIdRef.current) return;
      projectIdRef.current = id;
      clearPendingFind();
      staleMore();
      // R602 I2: what the project left got no answer for is not said of the next one.
      setUnanswered(({ projects }) => (projects ? { projects } : {}));
      setProjectId(id);
      setCollections([]);
      setTags({ tags: [], workspaceTags: [] });
      setSources(undefined);
      setOpenSource(undefined);
      setOutcomes(undefined);
      setFilter((f) => ({ text: f.text }));
    },
    [staleMore],
  );

  // ---- the project named in the address (41b2 I1): honoured on every way into the library ----
  useEffect(() => {
    if (!projects) return;
    if (written.current !== undefined) {
      if (projectFromAddress !== written.current) return; // the address has not caught up yet
      written.current = undefined;
    }
    if (!projectFromAddress) {
      // No project named: keep the one selected, else the first; either way the address names it.
      selectProject(projectIdRef.current ?? projects[0]?.id);
      return;
    }
    if (projects.some((p) => p.id === projectFromAddress)) {
      selectProject(projectFromAddress);
      // The address already names it, so nothing waits for the address to catch up: a later change
      // of the address (browser Back or Forward) is followed (FR-151).
      written.current = undefined;
      return;
    }
    // Not one of this library's projects: select none, so nothing is dropped into the wrong one.
    selectProject(undefined);
    setUnknownProject(true);
  }, [projects, projectFromAddress, selectProject]);


  // Edits: each goes through the service; a failure is shown, success reloads.
  const edit = (what: string, run: () => Promise<unknown>) => {
    setError(undefined);
    run()
      .then(refresh)
      .catch((err: unknown) => fail(err, `${what} could not be done.`));
  };

  /**
   * A workspace tag's change (R118): it can be refused because some other project is locked (a 409
   * whose words say so, shown after what could not be done rather than under "Something changed"),
   * and an interrupted one may have changed some projects, so the tags and sources are read again
   * whether it worked or not (FR-165).
   */
  const editWorkspace = (what: string, run: () => Promise<unknown>) => {
    setError(undefined);
    run()
      .then(refresh)
      .catch((err: unknown) => {
        refresh();
        if (err instanceof ApiClientError && err.code === "CONFLICT" && err.message) setError(`${what} could not be done. ${err.message}`);
        else fail(err, `${what} could not be done.`);
      });
  };

  const attach = async (paths: string[]) => {
    if (!projectId || readOnly || locked) return;
    setAttaching(true);
    setError(undefined);
    try {
      setOutcomes(await api.sources.attach(projectId, paths));
      refresh();
    } catch (err) {
      fail(err, "The files could not be attached.");
    } finally {
      setAttaching(false);
    }
  };

  const follow = (e: MouseEvent, path: string) => {
    if (!navigate) return;
    e.preventDefault();
    navigate(path);
  };

  const projectNames = useMemo(() => Object.fromEntries((projects ?? []).map((p) => [p.id, p.name])), [projects]);
  libraryNameRef.current = state.name ?? current.name;
  const banners = bannersFor(state, { projectNames, index, ...(libraryPath ? { volume: volumeOf(libraryPath) } : {}), ...(state.lockedBy ? { hostname: state.lockedBy } : {}) });
  const readOnlyReason = state.readOnlyReason === "offline" ? "The library is offline; attaching waits until it is back." : "This library is read-only.";

  return (
    <PageReads value={page}>
    <div className="ao-library">
      <header className="ao-library__header">
        <UserText as="h1">{state.name ?? current.name}</UserText>
        <JobsIndicator jobs={jobs} />
        <div className="ao-row">
          {project?.encrypted && !locked && (
            <button
              type="button"
              disabled={!project}
              onClick={() =>
                edit("Locking the project", async () => {
                  await api.projects.lock(project.id);
                  markLocked(project.id);
                })
              }
            >
              Lock project
            </button>
          )}
          {project?.encrypted && !locked && (
            <button type="button" ref={recoveryButton} disabled={readOnly} onClick={() => setRecovering(project)}>
              New recovery code…
            </button>
          )}
          {project && !locked && <RecheckProjectButton control={recheck} projectId={project.id} readOnly={readOnly} reconnects={reconnects} />}
          {!locked && !readOnly && project && (
            <a href={importHref(project.id)} onClick={(e) => follow(e, importHref(project.id))}>
              Import
            </a>
          )}
          {/* Capture is the other way a project takes in sources (from the web), so it sits beside Import, under the same conditions (D10). */}
          {!locked && !readOnly && project && (
            <a href={captureHref(project.id)} onClick={(e) => follow(e, captureHref(project.id))}>
              Capture from the web
            </a>
          )}
          {!locked && !readOnly && project && (
            <a href={findHref(project.id)} onClick={(e) => follow(e, findHref(project.id))}>
              Find and acquire
            </a>
          )}
          {/* What the ways in left for the researcher to decide (Task 67): after Import and Capture. */}
          {project && !locked && waiting?.projectId === project.id && (
            <a href={reviewQueueHref(project.id)} onClick={(e) => follow(e, reviewQueueHref(project.id))}>
              {waiting.total > 0 ? `Review queue (${waiting.total} waiting)` : "Review queue"}
            </a>
          )}
          {project && (
            <a href={governanceHref(project.id)} onClick={(e) => follow(e, governanceHref(project.id))}>
              Governance and records
            </a>
          )}
          <a href={PATHS.appearance} onClick={(e) => follow(e, PATHS.appearance)}>
            Appearance
          </a>
          <a href={PATHS.zotero} onClick={(e) => follow(e, PATHS.zotero)}>Zotero</a>
          <a href={PATHS.searchSources} onClick={(e) => follow(e, PATHS.searchSources)}>Search sources</a>
          <a href={PATHS.yourLibrary} onClick={(e) => follow(e, PATHS.yourLibrary)}>Your library</a>
          <a href={PATHS.extension} onClick={(e) => follow(e, PATHS.extension)}>
            Browser extension
          </a>
          <a href={PATHS.tools} onClick={(e) => follow(e, PATHS.tools)}>
            Optional tools
          </a>
          {project && <a href={watchedFoldersHref(project.id)} onClick={(e) => follow(e, watchedFoldersHref(project.id))}>Watched folders</a>}
          <a href={PATHS.about} onClick={(e) => follow(e, PATHS.about)}>About and third-party notices</a>
          {onSwitchLibrary && (
            <button
              type="button"
              onClick={() => {
                noteUnknownCreates();
                onSwitchLibrary();
              }}
            >
              Switch library
            </button>
          )}
        </div>
      </header>
      <LibraryZotero api={api} projectId={project?.id} open={libraryOpen && !closedUnder} events={zoteroEvents} firstReadMs={firstReadMs} />
      {recovering && (
        <NewRecoveryCode
          api={api}
          project={recovering}
          returnFocusTo={() => {
            // The opener, unless it is gone or off meanwhile: then the project list.
            const b = recoveryButton.current;
            if (b && !b.disabled) return b;
            return document.querySelector<HTMLElement>(".ao-projects button[aria-current='true'], .ao-projects button");
          }}
          onRecoveryPending={(pending) => {
            holdClose.current = pending;
          }}
          libraryClosed={closedUnder}
          onLocked={() => markLocked(recovering.id)}
          onClose={() => {
            setRecovering(null);
            // The library went away while the recovery code was on screen: now leave it.
            if (closedUnder) closedRef.current?.();
          }}
        />
      )}
      {resolving && (
        <PendingWritesDialog
          api={api}
          readOnly={readOnly}
          changed={stateSeq}
          onClose={() => {
            const from = resolving.from;
            setResolving(null);
            // After the dialog is gone and the page is no longer inert.
            setTimeout(() => from?.focus());
          }}
          onResolved={refresh}
        />
      )}
      {banners.length > 0 && (
        <div className="ao-library__banners" ref={bannersRef} tabIndex={-1} role="region" aria-label="Library status">
          {banners.map((b, i) => (
            <StatusBanner
              key={b.kind === "notice" ? `notice-${b.notice}` : `${b.kind}-${i}`}
              variant={b}
              onResolve={() => setResolving({ from: document.activeElement instanceof HTMLElement ? document.activeElement : null })}
              onDismiss={dismissNotice}
              {...(readOnly ? {} : { onDismissWarning: dismissWarning })}
            />
          ))}
          {noticeError && (
            <p role="alert" className="ao-warning">
              {noticeError}
            </p>
          )}
          {warningError && (
            <p role="alert" className="ao-warning">
              {warningError}
            </p>
          )}
        </div>
      )}
      {firstUse?.(locked)}
      <aside className="ao-library__side">
        {projects === undefined ? (
          !unanswered.projects && <p aria-live="polite">Loading projects…</p>
        ) : (
          <ProjectNav projects={projects} profiles={profiles} selectedId={projectId} onSelect={selectProject} />
        )}
        <button type="button" ref={newProjectButton} className="ao-new-project" disabled={readOnly || projects === undefined} onClick={() => setCreating(true)}>
          New project
        </button>
        {creating && (
          <NewProject
            api={api}
            firstReadMs={firstReadMs}
            returnFocusTo={() => {
              // The opener, unless it was disabled meanwhile (the library turned read-only): then the project list.
              const b = newProjectButton.current;
              if (b && !b.disabled) return b;
              return document.querySelector<HTMLElement>(".ao-projects button[aria-current='true'], .ao-projects button");
            }}
            onRecoveryPending={(pending) => {
              holdClose.current = pending;
            }}
            libraryClosed={closedUnder}
            onUncertain={(c) => {
              dialogUncertain.current = c;
            }}
            onCancel={(u) => {
              if (closedUnder) {
                // The library went away while a held panel was on screen (FR-194): now leave it.
                setCreating(false);
                closedRef.current?.();
                return;
              }
              dialogClosed(u);
            }}
            onCreated={(made) => {
              // FR-180: a project this dialog made is known, so a notice still unsettled never takes it for the lost create.
              setUnresolved((u) => (u ? { ...u, create: { ...u.create, before: new Set([...u.create.before, made.id]) } } : u));
              if (closedUnder) {
                // The library went away while the recovery code was on screen: now leave it.
                setCreating(false);
                closedRef.current?.();
                return;
              }
              dialogClosed(undefined, made);
              const words = stillToFillIn(made.profiles);
              setToFillIn(words.length ? { project: made, words } : null);
              setProjects((list) => [...(list ?? []).filter((p) => p.id !== made.id), made]);
              setProfiles((all) => ({ ...all, [made.id]: knownProfiles(made.profiles) }));
              // Selected like any other project: the address names it (41b2 I1).
              selectProject(made.id);
            }}
          />
        )}
        {toFillIn && (
          <section aria-label="What the new project still needs" className="ao-newproject-notice">
            <p role="status">
              “<UserText>{toFillIn.project.name}</UserText>” follows rules that ask for what only you can give: {listInWords(toFillIn.words)}. Fill them in under Governance; until then, Governance lists them as not met.
            </p>
            <div className="ao-row">
              <a href={governanceHref(toFillIn.project.id)} onClick={(e) => follow(e, governanceHref(toFillIn.project.id))}>
                Open Governance
              </a>
              <button type="button" onClick={() => setToFillIn(null)}>
                Dismiss
              </button>
            </div>
          </section>
        )}
        {unresolved && (
          <section aria-label="A project that may have been created" className="ao-newproject-notice">
            {typeof unresolved.state === "object" && "many" in unresolved.state ? (
              <>
                <p role="status">
                  {unresolved.state.many.length} projects named “<UserText>{unresolved.create.name}</UserText>” were found that were not there before, so the app cannot tell which one was made then.
                  {unresolved.create.encrypted &&
                    " The one made then opens with the passphrase you chose; its recovery code was not shown and cannot be shown again. Once it is unlocked, choose “New recovery code…” to get a recovery code you can save."}
                </p>
                <SameNamedProjects
                  projects={unresolved.state.many}
                  onOpen={(p) => {
                    setUnresolved(null);
                    selectProject(p.id);
                  }}
                />
              </>
            ) : typeof unresolved.state === "object" ? (
              <p role="status">
                “<UserText>{unresolved.create.name}</UserText>” was created.
                {unresolved.create.encrypted &&
                  " Its recovery code was not shown and cannot be shown again; it opens with the passphrase you chose. Once it is unlocked, choose “New recovery code…” to get a recovery code you can save."}
              </p>
            ) : unresolved.state === "not-created" ? (
              <p role="status">
                “<UserText>{unresolved.create.name}</UserText>” was not created. Nothing was changed; you can create it again.
              </p>
            ) : (
              <p role="alert">
                “<UserText>{unresolved.create.name}</UserText>” may have been created: the library service did not answer, so the app cannot tell yet.
                {unresolved.create.encrypted && " If it was, its recovery code was not shown and cannot be shown again; it opens with the passphrase you chose, and “New recovery code…” gives it a new one."}
                {" "}Do not create it again until this is settled.
                {unresolved.state === "still-unknown" && " The app still cannot tell: the service did not answer. Try again in a moment."}
              </p>
            )}
            <div className="ao-row">
              {typeof unresolved.state === "object" && "found" in unresolved.state ? (
                <button
                  type="button"
                  onClick={() => {
                    const p = (unresolved.state as { found: ProjectSummary }).found;
                    setUnresolved(null);
                    selectProject(p.id);
                  }}
                >
                  Open the project
                </button>
              ) : unresolved.state === "not-created" || typeof unresolved.state === "object" ? (
                <button type="button" onClick={() => setUnresolved(null)}>
                  Dismiss
                </button>
              ) : (
                <button type="button" disabled={unresolved.state === "checking"} onClick={() => void checkUnresolved(unresolved.create)}>
                  Check again
                </button>
              )}
            </div>
          </section>
        )}
        {project && !locked && (
          <>
            <CollectionTree
              collections={collections}
              selectedId={filter.collection}
              readOnly={readOnly}
              onSelect={(collection) => setFilter((f) => ({ ...f, collection }))}
              encrypted={project.encrypted}
              onCreate={(name, parentId) => edit("Creating the collection", () => api.collections.create(project.id, name, parentId))}
              onRename={(cid, name) => edit("Renaming the collection", () => api.collections.update(project.id, cid, { name }))}
              onDelete={(cid) =>
                edit("Deleting the collection", async () => {
                  await api.collections.remove(project.id, cid);
                  setFilter((f) => (f.collection === cid ? { ...f, collection: undefined } : f));
                })
              }
            />
            <TagList
              tags={tags.tags}
              workspaceTags={tags.workspaceTags}
              selectedId={filter.tag}
              readOnly={readOnly}
              onSelect={(tag) => setFilter((f) => ({ ...f, tag }))}
              encrypted={project.encrypted}
              onCreate={(name, scope) => edit("Creating the tag", () => api.tags.create(project.id, name, scope))}
              onRename={(tid, name) => edit("Renaming the tag", () => api.tags.rename(project.id, tid, name))}
              onRenameWorkspace={(tid, name) => editWorkspace("Renaming the workspace tag", () => api.tags.renameWorkspace(tid, name))}
              onDeleteWorkspace={(tid) =>
                editWorkspace("Deleting the workspace tag", async () => {
                  await api.tags.removeWorkspace(tid);
                  setFilter((f) => (f.tag === tid ? { ...f, tag: undefined } : f));
                })
              }
              onDelete={(tid) =>
                edit("Deleting the tag", async () => {
                  await api.tags.remove(project.id, tid);
                  setFilter((f) => (f.tag === tid ? { ...f, tag: undefined } : f));
                })
              }
            />
          </>
        )}
      </aside>
      <main className="ao-library__main" ref={mainRef} tabIndex={-1}>
        {error && (
          <p role="alert" className="ao-error">
            {error}
          </p>
        )}
        {/* FR-756 B: a read that got no answer says so (each sentence once) and is offered again. */}
        {pageSentence && (
          <p role="alert" className="ao-error">
            {pageSentence}
          </p>
        )}
        {pageSentence !== undefined && (
          <p>
            <button type="button" ref={tryAgainRef} onClick={retryAll}>
              Try again
            </button>
          </p>
        )}
        {unknownProject && (
          <p role="alert" className="ao-error">
            The project named in the address is not in this library. Choose a project from the list.
          </p>
        )}
        {project && locked && (
          <UnlockProject
            api={api}
            project={project}
            onUnlocked={() => {
              setUnlockedHere((s) => new Set([...s, project.id]));
              setProjects((list) => list?.map((p) => (p.id === project.id ? { ...p, unlocked: true } : p)));
              refresh();
            }}
          />
        )}
        {project && !locked && (
          <>
            <WorkLines client={api.client} projectId={project.id} streamOpenMs={streamOpenMs} streamQuietMs={streamQuietMs} />
            <SearchBox label="Search sources" onSearch={(text) => setFilter((f) => (f.text === text ? f : { ...f, text }))} />
            <DropZone onPaths={(paths) => void attach(paths)} disabled={readOnly || attaching} disabledReason={attaching ? "Attaching…" : readOnlyReason} target={project.name} />
            {outcomes && (
              <ul aria-label="Attached files" className="ao-plain-list ao-outcomes">
                {outcomes.map((o, i) => (
                  <li key={`${o.path}-${i}`} className={o.outcome === "failed" || o.outcome === "cancelled" ? "ao-outcome--failed" : undefined}>
                    {o.outcome === "cancelled" ? (
                      // FR-749 (R546): one sentence, the service's and the page's (ATTACH_CLOSED_TEXT), the name as the researcher's own text.
                      <>
                        {ATTACH_CLOSED_TEXT.before}
                        <UserText>{baseName(o.path)}</UserText>
                        {ATTACH_CLOSED_TEXT.after}
                      </>
                    ) : (
                      <>
                        <UserText>{baseName(o.path)}</UserText> — {OUTCOME_TEXT[o.outcome] ?? o.outcome}
                      </>
                    )}
                    {o.outcome === "needs-review" && (
                      <>
                        {" "}
                        <a href={reviewQueueHref(project.id, o.sourceId)} onClick={(e) => follow(e, reviewQueueHref(project.id, o.sourceId))}>
                          needs review
                        </a>
                      </>
                    )}
                    {o.reason && o.outcome !== "cancelled" && (
                      <>
                        : <UserText>{o.reason}</UserText>
                      </>
                    )}
                    {o.note && (
                      <>
                        {" "}
                        <span className="ao-muted">
                          (<UserText>{o.note}</UserText>)
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {sourcesError && (
              <p role="alert" className="ao-error">
                {sourcesError}
              </p>
            )}
            {(sources?.index ?? state.index)?.state === "unavailable" && (
              <p className="ao-muted">This library is open read-only, so its search index cannot be built here: sources are listed from the library's files, and search looks at titles only.</p>
            )}
            {sources === undefined ? (
              !sourcesError && !unanswered.sources && <p aria-live="polite">Loading sources…</p>
            ) : (sources.total === 0 || listPartial) && (listRebuilding || indexState === "rebuilding") ? (
              // An index being rebuilt is never passed off as an empty library (D8).
              <p role="status">The library's search index is being rebuilt from its files. The sources appear here as soon as it has finished; nothing in the library has been lost.</p>
            ) : (sources.total === 0 || listPartial) && listIndex?.state === "failed" ? (
              <p role="status">
                The sources cannot be listed: the library's search index could not be rebuilt. Your sources are safe in the library folder;{" "}
                <a href={PATHS.missingFiles} onClick={(e) => follow(e, PATHS.missingFiles)}>
                  rebuild the library from its folder
                </a>{" "}
                to list them again.
              </p>
            ) : (
              <>
                <SourceTable
                  items={sources.items}
                  total={sources.total}
                  onOpen={setOpenSource}
                  selectedId={openSource}
                  incomplete={sources.incomplete}
                  limited={sources.limited}
                  rebuilding={!!index && index.done < index.total}
                  reviewHref={readOnly ? undefined : (sid) => reviewQueueHref(project.id, sid)}
                  onFollow={follow}
                  onShowInReader={showInReader}
                />
                {sources.items.length < sources.total && (
                  <button type="button" disabled={loadingMore || !listCurrent} onClick={() => void loadMore()}>
                    Load more sources
                  </button>
                )}
              </>
            )}
            {openSource && (
              <div className="ao-library__detail">
                <SourceDetail api={api} projectId={project.id} sourceId={openSource} readOnly={readOnly} onClose={() => setOpenSource(undefined)} onChanged={refresh} onLocked={() => markLocked(project.id)} refreshKey={badgesVersion} firstReadMs={firstReadMs} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
    </PageReads>
  );
}
