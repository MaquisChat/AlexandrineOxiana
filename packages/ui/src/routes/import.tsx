/**
 * Bulk Import routes (Task 35, R113): `/import` is the wizard, `/import/review` the review queue
 * (`?project=<id>&batch=<id>`, else a picker). App.tsx asks `importRoute` first and renders what it
 * returns; null means the path is not an import route.
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { ApiClient } from "../api/client";
import { importApi, isValidId, type BatchSummary, type ProjectInfo } from "../api/import";
import { ImportWizard } from "../screens/import/ImportWizard";
import { ReviewQueue } from "../screens/import/ReviewQueue";
import { ErrorNote, errorText, fmt } from "../screens/import/shared";
import { IMPORT_PATHS } from "./paths";

export { IMPORT_PATHS, navigate } from "./paths";

export interface RouteLocation {
  pathname: string;
  search: string;
}

/** The import screen for the window's current location, following in-app navigation; null elsewhere. */
export function useImportRoute(client: ApiClient | undefined): ReactElement | null {
  const [loc, setLoc] = useState<RouteLocation>(() => (typeof window === "undefined" ? { pathname: "/", search: "" } : { pathname: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const on = () => setLoc({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return client ? importRoute(loc, client) : null;
}

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function importRoute(loc: RouteLocation, client: ApiClient): ReactElement | null {
  const path = norm(loc.pathname);
  const key = `${path}${loc.search}`;
  const q = new URLSearchParams(loc.search);
  if (path === IMPORT_PATHS.wizard) {
    // An id from the address is used only when it is a valid id (R115 I3); otherwise it is ignored.
    const project = q.get("project");
    return <ImportWizard key={key} client={client} {...(isValidId(project) ? { projectId: project } : {})} />;
  }
  if (path === IMPORT_PATHS.review) {
    const project = q.get("project");
    const batch = q.get("batch");
    if ((project !== null && !isValidId(project)) || (batch !== null && !isValidId(batch))) {
      return (
        <main className="ao-import" aria-labelledby="ao-review-bad">
          <h1 id="ao-review-bad">Review queue</h1>
          <p className="ao-import__error" role="alert">
            This link is not a valid review queue link: its project or import id is not a valid id. Open the review queue from an import report instead.
          </p>
        </main>
      );
    }
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
        <ErrorNote error={error} />
      </div>
      {projectId && batchId && <ReviewQueue key={`${projectId}/${batchId}`} client={client} projectId={projectId} batchId={batchId} />}
    </>
  );
}
