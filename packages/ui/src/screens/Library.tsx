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
import { CollectionTree } from "../components/CollectionTree";
import { DropZone } from "../components/DropZone";
import { JobsIndicator, type Job } from "../components/JobsIndicator";
import { ProjectNav } from "../components/ProjectNav";
import { RecheckProjectButton, useProjectRecheck } from "../components/RecheckProject";
import { SearchBox } from "../components/SearchBox";
import { SourceTable } from "../components/SourceTable";
import { PendingWritesDialog } from "../components/PendingWritesDialog";
import { StatusBanner, bannersFor, useNoticeDismiss, volumeOf } from "../components/StatusBanner";
import { TagList } from "../components/TagList";
import { UserText } from "../components/UserText";
import "../components/library.css";
import { PATHS } from "../navigation";
import { madeSince, NewProject, type UnresolvedCreate } from "./NewProject";
import { NewRecoveryCode } from "./NewRecoveryCode";
import { SourceDetail } from "./SourceDetail";
import { UnlockProject } from "./UnlockProject";

/** Where "needs review" outcomes send the researcher (the import review queue, Task 35). */
export const REVIEW_QUEUE_PATH = PATHS.reviewQueue;
const governanceHref = (projectId: string) => `${PATHS.governance}?project=${encodeURIComponent(projectId)}`;
const importHref = (projectId: string) => `${PATHS.importWizard}?project=${encodeURIComponent(projectId)}`;

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
}

const message = (err: unknown, fallback: string) => errorText(err, fallback);

/** Sources asked for per page; "Load more" asks for the next page by offset. */
export const SOURCE_PAGE_SIZE = 100;
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

const OUTCOME_TEXT: Record<AttachOutcome["outcome"], string> = {
  created: "Added as a new source",
  attached: "Added to an existing source",
  duplicate: "Already in the library",
  "needs-review": "Stored; it",
  failed: "Not added",
};

const JOB_LABELS: Record<string, string> = { recheck: "Rechecking sources", ocr: "Recognising text", proxy: "Making viewing copies", import: "Importing" };

export function Library({ api, current, libraryPath, onSwitchLibrary, navigate, onClosed, projectFromAddress, onProjectSelected, firstUse }: LibraryProps) {
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
  /** A dialog shows a recovery code not yet confirmed: a library close waits for it. */
  const holdClose = useRef(false);
  /** The library closed while that code was on screen. */
  const [closedUnder, setClosedUnder] = useState(false);
  /** A create whose answer was lost and could not be checked when the dialog closed (fix round 2). */
  const [unresolved, setUnresolved] = useState<{ create: UnresolvedCreate; state: "unknown" | "still-unknown" | "checking" | "not-created" | { found: ProjectSummary } } | null>(null);
  /** Counts library.state events: an open "Resolve…" dialog reads its list again on each. */
  const [stateSeq, setStateSeq] = useState(0);

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

  /**
   * Forgets everything read from a project that is now locked (R114): its collections, tags,
   * sources, open source and attach outcomes; UnlockProject shows in their place.
   */
  const forgetDecrypted = useCallback(() => {
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
  });
  const recheckEvent = useRef(recheck.onEvent);
  recheckEvent.current = recheck.onEvent;

  // ---- service events: library state, index progress, background jobs ----
  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const listen = async () => {
      try {
        for await (const e of api.events({ signal: ac.signal })) {
          if (e.type === "library.state" && e.data && typeof e.data === "object") {
            const d = e.data as LibraryState;
            if (d.open === false) {
              // A new project's recovery code on screen is never taken away (R134 I2): the dialog
              // says the library closed, and the library is left once the code is confirmed.
              if (holdClose.current) setClosedUnder(true);
              else closedRef.current?.();
              continue;
            }
            // Each event is the whole state: a reason, lock holder or index state it no longer names is gone.
            setState(({ readOnlyReason: _r, lockedBy: _l, index: _i, ...s }) => ({ ...s, ...d }));
            setStateSeq((n) => n + 1);
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
        // the stream dropped: listen again shortly (a fresh state arrives first)
      }
      if (!ac.signal.aborted) retry = setTimeout(() => void listen(), 2000);
    };
    void listen();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
  }, [api]);

  // ---- projects and their profile badges ----
  const showProjects = useCallback((list: ProjectSummary[]) => {
    setProjects(list);
    // The badges are the profiles the service reads from each project's rules (R118).
    setProfiles(Object.fromEntries(list.map((p) => [p.id, knownProfiles(p.profiles)])));
  }, []);
  useEffect(() => {
    let live = true;
    api.projects
      .list()
      .then(({ projects: list }) => live && showProjects(list))
      .catch((err: unknown) => live && setError(message(err, "The projects could not be read.")));
    return () => {
      live = false;
    };
  }, [api, showProjects]);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
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
  const checkUnresolved = useCallback(
    async (create: UnresolvedCreate, auto = false) => {
      setUnresolved({ create, state: "checking" });
      try {
        const fresh = madeSince(await reloadProjects(), create);
        if (mounted.current) setUnresolved({ create, state: fresh.length ? { found: fresh[fresh.length - 1]! } : "not-created" });
      } catch {
        if (mounted.current) setUnresolved({ create, state: auto ? "unknown" : "still-unknown" });
      }
    },
    [reloadProjects],
  );
  const dialogClosed = (unresolvedCreate?: UnresolvedCreate, made?: ProjectSummary) => {
    setCreating(false);
    if (unresolvedCreate) void checkUnresolved(unresolvedCreate, true);
    else void reloadProjects(made).catch(() => {});
  };

  // ---- the selected project's collections and tags ----
  useEffect(() => {
    if (!projectId || locked) return;
    let live = true;
    Promise.all([api.collections.list(projectId), api.tags.list(projectId)])
      .then(([c, t]) => {
        if (!live) return;
        setCollections(c.collections);
        setTags({ tags: t.tags, workspaceTags: t.workspaceTags });
      })
      .catch((err: unknown) => live && fail(err, "The collections and tags could not be read."));
    return () => {
      live = false;
    };
  }, [api, projectId, locked, reload]);

  // ---- the sources for the current search and filters ----
  useEffect(() => {
    staleMore();
    if (!projectId || locked) return;
    const ac = new AbortController();
    api.sources
      .search(projectId, { ...query(), limit: SOURCE_PAGE_SIZE }, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return;
        setSources(r);
        setSourcesError(undefined); // only the sources' own error: other errors stay until dismissed or replaced
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted) fail(err, "The sources could not be read.", setSourcesError);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, locked, filter, reload]);

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
    if (!projectId || !sources) return;
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
      staleMore();
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
  const banners = bannersFor(state, { projectNames, index, ...(libraryPath ? { volume: volumeOf(libraryPath) } : {}), ...(state.lockedBy ? { hostname: state.lockedBy } : {}) });
  const readOnlyReason = state.readOnlyReason === "offline" ? "The library is offline; attaching waits until it is back." : "This library is read-only.";

  return (
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
          {project && !locked && <RecheckProjectButton control={recheck} projectId={project.id} readOnly={readOnly} />}
          {!locked && !readOnly && project && (
            <a href={importHref(project.id)} onClick={(e) => follow(e, importHref(project.id))}>
              Import
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
          <a href={PATHS.extension} onClick={(e) => follow(e, PATHS.extension)}>
            Browser extension
          </a>
          <a href={PATHS.tools} onClick={(e) => follow(e, PATHS.tools)}>
            Optional tools
          </a>
          <a href="/about" onClick={(e) => follow(e, "/about")}>About and third-party notices</a>
          {onSwitchLibrary && (
            <button type="button" onClick={onSwitchLibrary}>
              Switch library
            </button>
          )}
        </div>
      </header>
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
        <div className="ao-library__banners" ref={bannersRef} tabIndex={-1} aria-label="Library status">
          {banners.map((b, i) => (
            <StatusBanner
              key={b.kind === "notice" ? `notice-${b.notice}` : `${b.kind}-${i}`}
              variant={b}
              onResolve={() => setResolving({ from: document.activeElement instanceof HTMLElement ? document.activeElement : null })}
              onDismiss={dismissNotice}
            />
          ))}
          {noticeError && (
            <p role="alert" className="ao-warning">
              {noticeError}
            </p>
          )}
        </div>
      )}
      {firstUse?.(locked)}
      <aside className="ao-library__side">
        {projects === undefined ? (
          <p aria-live="polite">Loading projects…</p>
        ) : (
          <ProjectNav projects={projects} profiles={profiles} selectedId={projectId} onSelect={selectProject} />
        )}
        <button type="button" ref={newProjectButton} className="ao-new-project" disabled={readOnly || projects === undefined} onClick={() => setCreating(true)}>
          New project
        </button>
        {creating && (
          <NewProject
            api={api}
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
            onCancel={dialogClosed}
            onCreated={(made) => {
              if (closedUnder) {
                // The library went away while the recovery code was on screen: now leave it.
                setCreating(false);
                closedRef.current?.();
                return;
              }
              dialogClosed(undefined, made);
              setProjects((list) => [...(list ?? []).filter((p) => p.id !== made.id), made]);
              setProfiles((all) => ({ ...all, [made.id]: knownProfiles(made.profiles) }));
              // Selected like any other project: the address names it (41b2 I1).
              selectProject(made.id);
            }}
          />
        )}
        {unresolved && (
          <section aria-label="A project that may have been created" className="ao-newproject-notice">
            {typeof unresolved.state === "object" ? (
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
              {typeof unresolved.state === "object" ? (
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
              ) : unresolved.state === "not-created" ? (
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
              onCreate={(name, scope) => edit("Creating the tag", () => api.tags.create(project.id, name, scope))}
              onRename={(tid, name) => edit("Renaming the tag", () => api.tags.rename(project.id, tid, name))}
              onRenameWorkspace={(tid, name) => edit("Renaming the workspace tag", () => api.tags.renameWorkspace(tid, name))}
              onDeleteWorkspace={(tid) =>
                edit("Deleting the workspace tag", async () => {
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
            <SearchBox label="Search sources" onSearch={(text) => setFilter((f) => (f.text === text ? f : { ...f, text }))} />
            <DropZone onPaths={(paths) => void attach(paths)} disabled={readOnly || attaching} disabledReason={attaching ? "Attaching…" : readOnlyReason} target={project.name} />
            {outcomes && (
              <ul aria-label="Attached files" className="ao-plain-list ao-outcomes">
                {outcomes.map((o, i) => (
                  <li key={`${o.path}-${i}`} className={o.outcome === "failed" ? "ao-outcome--failed" : undefined}>
                    <UserText>{baseName(o.path)}</UserText> — {OUTCOME_TEXT[o.outcome] ?? o.outcome}
                    {o.outcome === "needs-review" && (
                      <>
                        {" "}
                        <a href={REVIEW_QUEUE_PATH} onClick={(e) => follow(e, REVIEW_QUEUE_PATH)}>
                          needs review
                        </a>
                      </>
                    )}
                    {o.reason && (
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
              !sourcesError && <p aria-live="polite">Loading sources…</p>
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
                <SourceTable items={sources.items} total={sources.total} onOpen={setOpenSource} selectedId={openSource} incomplete={sources.incomplete} limited={sources.limited} rebuilding={!!index && index.done < index.total} />
                {sources.items.length < sources.total && (
                  <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                    Load more sources
                  </button>
                )}
              </>
            )}
            {openSource && (
              <div className="ao-library__detail">
                <SourceDetail api={api} projectId={project.id} sourceId={openSource} readOnly={readOnly} onClose={() => setOpenSource(undefined)} onChanged={refresh} onLocked={() => markLocked(project.id)} refreshKey={badgesVersion} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
