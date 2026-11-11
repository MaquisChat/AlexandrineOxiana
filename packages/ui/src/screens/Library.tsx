/**
 * The library (mockup screens 1 and 5): projects with their profile badges on the side, then the
 * selected project's collections and tags; the main pane has search, the drop zone, the sources and
 * the open source's details. The service's `library.state` and `job.progress` events drive the
 * status banners (read-only, offline, index rebuilding, integrity and project warnings) and the
 * jobs indicator. While the library is read-only the drop zone and every edit button are off. A
 * locked encrypted project shows UnlockProject in place of its sources.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AttachOutcome, Collection, CurrentLibrary, LibraryApi, LibraryState, ProfileId, ProjectSummary, SourceRow, Tag } from "../api/library";
import { errorText, isProjectLocked } from "../api/library";
import { projectProfiles } from "../api/profilesFallback";
import { CollectionTree } from "../components/CollectionTree";
import { DropZone } from "../components/DropZone";
import { JobsIndicator, type Job } from "../components/JobsIndicator";
import { ProjectNav } from "../components/ProjectNav";
import { SearchBox } from "../components/SearchBox";
import { SourceTable } from "../components/SourceTable";
import { StatusBanner, bannersFor, volumeOf } from "../components/StatusBanner";
import { TagList } from "../components/TagList";
import { UserText } from "../components/UserText";
import "../components/library.css";
import { PATHS } from "../navigation";
import { SourceDetail } from "./SourceDetail";
import { UnlockProject } from "./UnlockProject";

/** Where "needs review" outcomes send the researcher (the import review queue, Task 35). */
export const REVIEW_QUEUE_PATH = PATHS.reviewQueue;
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

export function Library({ api, current, libraryPath, onSwitchLibrary, navigate, onClosed }: LibraryProps) {
  const [state, setState] = useState<LibraryState>({ mode: current.mode, ...(current.readOnlyReason ? { readOnlyReason: current.readOnlyReason } : {}) });
  const [index, setIndex] = useState<{ done: number; total: number } | undefined>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [profiles, setProfiles] = useState<Record<string, ProfileId[]>>({});
  const [projectId, setProjectId] = useState<string | undefined>();
  const [unlockedHere, setUnlockedHere] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<{ tags: Tag[]; workspaceTags: Tag[] }>({ tags: [], workspaceTags: [] });
  const [filter, setFilter] = useState<{ text: string; collection?: string | undefined; tag?: string | undefined }>({ text: "" });
  const [sources, setSources] = useState<{ total: number; items: SourceRow[] } | undefined>();
  const [openSource, setOpenSource] = useState<string | undefined>();
  const [outcomes, setOutcomes] = useState<AttachOutcome[] | undefined>();
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sourcesError, setSourcesError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);

  const readOnly = state.mode !== "read-write";
  const project = projects?.find((p) => p.id === projectId);
  const locked = !!project && project.encrypted && !project.unlocked && !unlockedHere.has(project.id);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  /**
   * Forgets everything read from a project that is now locked (R114): its collections, tags,
   * sources, open source and attach outcomes; UnlockProject shows in their place.
   */
  const forgetDecrypted = useCallback(() => {
    setCollections([]);
    setTags({ tags: [], workspaceTags: [] });
    setSources(undefined);
    setOpenSource(undefined);
    setOutcomes(undefined);
  }, []);
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
              closedRef.current?.();
              continue;
            }
            setState((s) => ({ ...s, ...d }));
          }
          if (e.type === "job.progress" && e.data && typeof e.data === "object") {
            const d = e.data as { kind?: string; jobId?: string; done?: number; total?: number; finished?: boolean };
            if (typeof d.done !== "number" || typeof d.total !== "number") continue;
            if (d.kind === "index") setIndex({ done: d.done, total: d.total });
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
  useEffect(() => {
    let live = true;
    api.projects
      .list()
      .then(async ({ projects: list }) => {
        if (!live) return;
        setProjects(list);
        setProjectId((id) => id ?? list[0]?.id);
        const entries = await Promise.all(list.map(async (p) => [p.id, await projectProfiles(p, api.projects.governance)] as const));
        if (live) setProfiles(Object.fromEntries(entries));
      })
      .catch((err: unknown) => live && setError(message(err, "The projects could not be read.")));
    return () => {
      live = false;
    };
  }, [api]);

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

  const query = () => ({ text: filter.text, ...(filter.collection ? { collection: filter.collection } : {}), ...(filter.tag ? { tag: filter.tag } : {}) });

  const loadMore = async () => {
    if (!projectId || !sources) return;
    const pid = projectId;
    setLoadingMore(true);
    try {
      const r = await api.sources.search(pid, { ...query(), limit: SOURCE_PAGE_SIZE, offset: sources.items.length });
      if (projectIdRef.current !== pid) return;
      setSources((cur) => (cur ? { total: r.total, items: [...cur.items, ...r.items.filter((x) => !cur.items.some((y) => y.id === x.id))] } : r));
    } catch (err) {
      fail(err, "More sources could not be read.", setSourcesError);
    } finally {
      setLoadingMore(false);
    }
  };

  const selectProject = (id: string) => {
    if (id === projectId) return;
    setProjectId(id);
    setCollections([]);
    setTags({ tags: [], workspaceTags: [] });
    setSources(undefined);
    setOpenSource(undefined);
    setOutcomes(undefined);
    setFilter((f) => ({ text: f.text }));
  };

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
  const banners = bannersFor(state, { projectNames, index, ...(libraryPath ? { volume: volumeOf(libraryPath) } : {}) });
  const readOnlyReason = state.readOnlyReason === "offline" ? "The library is offline; attaching waits until it is back." : "This library is read-only.";

  return (
    <div className="ao-library">
      <header className="ao-library__header">
        <h1>
          <UserText>{state.name ?? current.name}</UserText>
        </h1>
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
          {!locked && !readOnly && project && (
            <a href={importHref(project.id)} onClick={(e) => follow(e, importHref(project.id))}>
              Import
            </a>
          )}
          <a href={PATHS.appearance} onClick={(e) => follow(e, PATHS.appearance)}>
            Appearance
          </a>
          {onSwitchLibrary && (
            <button type="button" onClick={onSwitchLibrary}>
              Switch library
            </button>
          )}
        </div>
      </header>
      {banners.length > 0 && (
        <div className="ao-library__banners">
          {banners.map((b, i) => (
            <StatusBanner key={`${b.kind}-${i}`} variant={b} />
          ))}
        </div>
      )}
      <aside className="ao-library__side">
        {projects === undefined ? (
          <p aria-live="polite">Loading projects…</p>
        ) : (
          <ProjectNav projects={projects} profiles={profiles} selectedId={projectId} onSelect={selectProject} />
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
      <main className="ao-library__main">
        {error && (
          <p role="alert" className="ao-error">
            {error}
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
            {sources === undefined ? (
              !sourcesError && <p aria-live="polite">Loading sources…</p>
            ) : (
              <>
                <SourceTable items={sources.items} total={sources.total} onOpen={setOpenSource} selectedId={openSource} />
                {sources.items.length < sources.total && (
                  <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                    Load more sources
                  </button>
                )}
              </>
            )}
            {openSource && (
              <div className="ao-library__detail">
                <SourceDetail api={api} projectId={project.id} sourceId={openSource} readOnly={readOnly} onClose={() => setOpenSource(undefined)} onChanged={refresh} onLocked={() => markLocked(project.id)} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
