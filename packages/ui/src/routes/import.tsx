/**
 * Bulk Import routes (Task 35, R113): `/import` is the wizard (`?project=<id>`; with `&batch=<id>`
 * it opens that import's run or report, D1), `/import/review` the review queue
 * (`?project=<id>&batch=<id>` one import's items; `?project=<id>` the project's whole queue, with
 * `&source=<id>` only that source's entries, Task 67; else a picker). App.tsx's route table (R118) renders what
 * `importRoute` returns for these paths; null means the path is not an import route.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ApiClient, ApiClientError } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, oneNoAnswerSentence, readWithin } from "../api/firstRead";
import { PageReads, usePageHost } from "../components/PageReads";
import { importApi, isValidId, type BatchSummary, type ProjectInfo } from "../api/import";
import { ImportWizard } from "../screens/import/ImportWizard";
import { projectQueueHref, ReviewQueue } from "../screens/import/ReviewQueue";
import { ErrorNote, errorText, fmt } from "../screens/import/shared";
import { TryAgain } from "../components/TryAgain";
import { IMPORT_PATHS, inAppLink, normalisePath as norm, type AppLocation as RouteLocation } from "../navigation";

export { IMPORT_PATHS };
export type { RouteLocation };

export const isImportPath = (path: string): boolean => (Object.values(IMPORT_PATHS) as string[]).includes(norm(path));

/** `opts.firstReadMs` (FR-756): how long the review queue's reads, and its picker's, are waited for (smaller in tests). */
export function importRoute(loc: RouteLocation, client: ApiClient, opts: { firstReadMs?: number } = {}): ReactElement | null {
  const ms = opts.firstReadMs !== undefined ? { firstReadMs: opts.firstReadMs } : {};
  const path = norm(loc.pathname);
  const key = `${path}${loc.search}`;
  const q = new URLSearchParams(loc.search);
  if (path === IMPORT_PATHS.wizard) {
    // An id from the address is used only when it is a valid id (R115 I3); otherwise it is ignored.
    const project = q.get("project");
    const batch = q.get("batch");
    return (
      <ImportWizard
        key={key}
        client={client}
        {...(isValidId(project) ? { projectId: project } : {})}
        {...(isValidId(project) && isValidId(batch) ? { batchId: batch } : {})}
      />
    );
  }
  if (path === IMPORT_PATHS.review) {
    const project = q.get("project");
    const batch = q.get("batch");
    const source = q.get("source");
    if ((project !== null && !isValidId(project)) || (batch !== null && !isValidId(batch)) || (source !== null && !isValidId(source))) {
      return (
        <main className="ao-import" aria-labelledby="ao-review-bad">
          <h1 id="ao-review-bad">Review queue</h1>
          <p className="ao-import__error" role="alert">
            This link is not a valid review queue link: its project, import or source id is not a valid id. Open the review queue from the library or an import report instead.
          </p>
        </main>
      );
    }
    // A project and no import: the project's whole queue (Task 67), or one source's entries in it.
    if (project && !batch) return <ReviewQueue key={key} client={client} projectId={project} {...(source ? { sourceId: source } : {})} {...ms} />;
    return <ReviewRoute key={key} client={client} project={project ?? ""} batch={batch ?? ""} firstReadMs={opts.firstReadMs ?? FIRST_READ_TIMEOUT_MS} />;
  }
  return null;
}

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

function batchLabel(b: BatchSummary): string {
  const when = Number.isNaN(Date.parse(b.startedAt)) ? "" : `, ${DATE.format(new Date(b.startedAt))}`;
  return `Import ${fmt(b.number)} — ${b.kind}${when} (${fmt(b.counts.needsReview)} waiting)`;
}

function ReviewRoute({ client, project, batch, firstReadMs }: { client: ApiClient; project: string; batch: string; firstReadMs: number }) {
  const api = useMemo(() => importApi(client), [client]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState(project);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [batchId, setBatchId] = useState(batch);
  /** R623 (Minor 4): the chosen project's list of imports is being read ("Loading…" in the import's picker). */
  const [listOut, setListOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * FR-756: the picker's reads that got no answer (given up at `firstReadMs`, or the service could not be reached), each
   * with its sentence; `tries` moves each on ("Try again"). `out`: the reads in the air (they may never settle).
   */
  const [unanswered, setUnanswered] = useState<{ projects?: string; batches?: string }>({});
  const [tries, setTries] = useState({ projects: 0, batches: 0 });
  const out = useRef(new Set<"projects" | "batches">());
  const pickerRef = useRef<HTMLSelectElement>(null);
  const picking = !(project && batch);

  useEffect(() => {
    if (!picking) return;
    let live = true;
    const ac = new AbortController();
    out.current.add("projects");
    readWithin((signal) => api.projects({ signal }), firstReadMs, ac.signal)
      .then((list) => {
        if (!live) return;
        setUnanswered(({ projects: _gone, ...rest }) => rest);
        setProjects(list);
        setProjectId((cur) => cur || (list.find((p) => p.unlocked !== false)?.id ?? ""));
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (isUnreachable(e)) setUnanswered((u) => ({ ...u, projects: (e as ApiClientError).message }));
        else {
          setUnanswered(({ projects: _gone, ...rest }) => rest);
          setError(errorText(e));
        }
      })
      .finally(() => live && out.current.delete("projects"));
    return () => {
      live = false;
      out.current.delete("projects");
      ac.abort();
    };
  }, [api, picking, firstReadMs, tries.projects]);

  useEffect(() => {
    if (!picking || !projectId) return;
    let live = true;
    const ac = new AbortController();
    out.current.add("batches");
    setListOut(true);
    // Another project chosen: the give-up of the one left is not said of this one.
    setUnanswered(({ batches: _gone, ...rest }) => rest);
    readWithin((signal) => api.batches(projectId, { signal }), firstReadMs, ac.signal)
      .then((list) => {
        if (!live) return;
        setUnanswered(({ batches: _gone, ...rest }) => rest);
        setBatches(list);
        setBatchId((cur) => (list.some((b) => b.batchId === cur) ? cur : (list.find((b) => b.counts.needsReview > 0)?.batchId ?? "")));
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (isUnreachable(e)) setUnanswered((u) => ({ ...u, batches: (e as ApiClientError).message }));
        else {
          setUnanswered(({ batches: _gone, ...rest }) => rest);
          setError(errorText(e));
        }
      })
      .finally(() => {
        if (!live) return;
        out.current.delete("batches");
        setListOut(false);
      });
    return () => {
      live = false;
      out.current.delete("batches");
      ac.abort();
    };
  }, [api, picking, projectId, firstReadMs, tries.batches]);

  // R605 I2: the picker's reads and the queue's own are one page: one sentence and one "Try again" for them all.
  const unansweredRef = useRef(unanswered);
  unansweredRef.current = unanswered;
  const { page, sentence: pageSentence, retryAll } = usePageHost({
    sentence: oneNoAnswerSentence([unanswered.projects, unanswered.batches]),
    out: () => out.current.size > 0,
    retry: () => {
      const u = unansweredRef.current;
      const again = { projects: u.projects !== undefined || out.current.has("projects"), batches: u.batches !== undefined || out.current.has("batches") };
      setUnanswered((cur) => ({ ...(again.projects ? {} : cur.projects !== undefined ? { projects: cur.projects } : {}), ...(again.batches ? {} : cur.batches !== undefined ? { batches: cur.batches } : {}) }));
      setTries((t) => ({ projects: t.projects + (again.projects ? 1 : 0), batches: t.batches + (again.batches ? 1 : 0) }));
    },
  });

  if (!picking) return <ReviewQueue client={client} projectId={project} batchId={batch} firstReadMs={firstReadMs} />;
  return (
    <PageReads value={page}>
      <div className="ao-import ao-import__picker">
        <label className="ao-import__field">
          <span>Project</span>
          <select
            ref={pickerRef}
            value={projectId}
            onChange={(e) => {
              // R623 (Minor 4): the import chosen, and the list it was chosen from, were the project left's: both are
              // cleared until the new project's list is read, so no queue is shown for a pair never read together.
              setProjectId(e.target.value);
              setBatches([]);
              setBatchId("");
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id} disabled={p.unlocked === false}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ao-import__field">
          <span>Import</span>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">{listOut ? "Loading…" : "Choose an import"}</option>
            {batches.map((b) => (
              <option key={b.batchId} value={b.batchId}>
                {batchLabel(b)}
              </option>
            ))}
          </select>
        </label>
        {projectId && (
          <p>
            <a href={projectQueueHref(projectId)} onClick={inAppLink}>
              Every entry waiting in this project
            </a>
          </p>
        )}
        <ErrorNote error={error} />
        {pageSentence !== undefined && (
          <>
            <p className="ao-import__error" role="alert">
              {pageSentence}
            </p>
            <TryAgain focusTo={pickerRef} onPress={retryAll} />
          </>
        )}
      </div>
      {projectId && batchId && <ReviewQueue key={`${projectId}/${batchId}`} client={client} projectId={projectId} batchId={batchId} firstReadMs={firstReadMs} />}
    </PageReads>
  );
}
