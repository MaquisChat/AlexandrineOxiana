/**
 * Bulk Import routes (Task 35, R113): `/import` is the wizard (`?project=<id>`; with `&batch=<id>`
 * it opens that import's run or report, D1), `/import/review` the review queue
 * (`?project=<id>&batch=<id>` one import's items; `?project=<id>` the project's whole queue, with
 * `&source=<id>` only that source's entries, Task 67; else a picker). App.tsx's route table (R118) renders what
 * `importRoute` returns for these paths; null means the path is not an import route.
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { ApiClient } from "../api/client";
import { importApi, isValidId, type BatchSummary, type ProjectInfo } from "../api/import";
import { ImportWizard } from "../screens/import/ImportWizard";
import { projectQueueHref, ReviewQueue } from "../screens/import/ReviewQueue";
import { ErrorNote, errorText, fmt } from "../screens/import/shared";
import { IMPORT_PATHS, inAppLink, normalisePath as norm, type AppLocation as RouteLocation } from "../navigation";

export { IMPORT_PATHS };
export type { RouteLocation };

export const isImportPath = (path: string): boolean => (Object.values(IMPORT_PATHS) as string[]).includes(norm(path));

export function importRoute(loc: RouteLocation, client: ApiClient): ReactElement | null {
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
    if (project && !batch) return <ReviewQueue key={key} client={client} projectId={project} {...(source ? { sourceId: source } : {})} />;
    return <ReviewRoute key={key} client={client} project={project ?? ""} batch={batch ?? ""} />;
  }
  return null;
}

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

function batchLabel(b: BatchSummary): string {
  const when = Number.isNaN(Date.parse(b.startedAt)) ? "" : `, ${DATE.format(new Date(b.startedAt))}`;
  return `Import ${fmt(b.number)} — ${b.kind}${when} (${fmt(b.counts.needsReview)} waiting)`;
}

function ReviewRoute({ client, project, batch }: { client: ApiClient; project: string; batch: string }) {
  const api = useMemo(() => importApi(client), [client]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState(project);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [batchId, setBatchId] = useState(batch);
  const [error, setError] = useState<string | null>(null);
  const picking = !(project && batch);

  useEffect(() => {
    if (!picking) return;
    let live = true;
    api
      .projects()
      .then((list) => {
        if (!live) return;
        setProjects(list);
        setProjectId((cur) => cur || (list.find((p) => p.unlocked !== false)?.id ?? ""));
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [api, picking]);

  useEffect(() => {
    if (!picking || !projectId) return;
    let live = true;
    api
      .batches(projectId)
      .then((list) => {
        if (!live) return;
        setBatches(list);
        setBatchId((cur) => (list.some((b) => b.batchId === cur) ? cur : (list.find((b) => b.counts.needsReview > 0)?.batchId ?? "")));
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [api, picking, projectId]);

  if (!picking) return <ReviewQueue client={client} projectId={project} batchId={batch} />;
  return (
    <>
      <div className="ao-import ao-import__picker">
        <label className="ao-import__field">
          <span>Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
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
            <option value="">Choose an import</option>
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
      </div>
      {projectId && batchId && <ReviewQueue key={`${projectId}/${batchId}`} client={client} projectId={projectId} batchId={batchId} />}
    </>
  );
}
