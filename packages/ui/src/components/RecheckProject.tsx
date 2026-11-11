/**
 * "Recheck project" (Task 34d, R99): every source of the project is rechecked by the service as a
 * background job (`POST /projects/:id/recheck` → `{ jobId, total }`), which reports through the
 * `job.progress` events (kind "recheck"). The library screen feeds those events to the hook; the
 * button is off while its project's job runs, so a second click starts nothing, and `onFinished`
 * lets the screen read the badges again. Events that arrive before the start is answered are kept
 * by job id, so a job that finished at once is not left showing progress.
 */
import { useCallback, useRef, useState } from "react";
import { errorText, isProjectLocked, type LibraryApi } from "../api/library";
import type { RecheckProgress } from "../api/verification";

export type ProjectRecheck =
  | { state: "starting" }
  | { state: "running"; jobId: string; done: number; total: number }
  | { state: "finished"; total: number; changed?: number; failed?: number }
  | { state: "failed"; error: string };

const isRecheck = (d: unknown): d is RecheckProgress => {
  const x = d as Partial<RecheckProgress> | null;
  return !!x && x.kind === "recheck" && typeof x.jobId === "string" && typeof x.projectId === "string" && typeof x.done === "number" && typeof x.total === "number";
};

export function useProjectRecheck(api: Pick<LibraryApi, "verification">, opts: { onFinished: (projectId: string) => void; onLocked: (projectId: string) => void }) {
  const [jobs, setJobs] = useState<Record<string, ProjectRecheck>>({});
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  /** The last event of each job id, kept for a job whose start has not been answered yet. */
  const seen = useRef(new Map<string, RecheckProgress>());
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const starting = useRef(new Set<string>());

  const apply = useCallback((projectId: string, e: RecheckProgress) => {
    if (e.finished) {
      setJobs((all) => ({ ...all, [projectId]: { state: "finished", total: e.total, ...(e.changed !== undefined ? { changed: e.changed } : {}), ...(e.failed !== undefined ? { failed: e.failed } : {}) } }));
      optsRef.current.onFinished(projectId);
    } else {
      setJobs((all) => ({ ...all, [projectId]: { state: "running", jobId: e.jobId, done: e.done, total: e.total } }));
    }
  }, []);

  /** A `job.progress` event's data (anything else is ignored). */
  const onEvent = useCallback(
    (data: unknown) => {
      if (!isRecheck(data)) return;
      seen.current.set(data.jobId, data);
      if (seen.current.size > 50) seen.current.delete(seen.current.keys().next().value!);
      const cur = jobsRef.current[data.projectId];
      if (cur?.state === "running" && cur.jobId === data.jobId) apply(data.projectId, data);
    },
    [apply],
  );

  const start = useCallback(
    async (projectId: string) => {
      const cur = jobsRef.current[projectId];
      if (starting.current.has(projectId) || cur?.state === "starting" || cur?.state === "running") return;
      starting.current.add(projectId);
      setJobs((all) => ({ ...all, [projectId]: { state: "starting" } }));
      try {
        const { jobId, total } = await api.verification.recheckProject(projectId);
        const early = seen.current.get(jobId);
        const running: ProjectRecheck = { state: "running", jobId, done: 0, total };
        jobsRef.current = { ...jobsRef.current, [projectId]: running };
        setJobs((all) => ({ ...all, [projectId]: running }));
        if (early) apply(projectId, early);
      } catch (err) {
        if (isProjectLocked(err)) optsRef.current.onLocked(projectId);
        setJobs((all) => ({ ...all, [projectId]: { state: "failed", error: errorText(err, "The library service did not answer.") } }));
      } finally {
        starting.current.delete(projectId);
      }
    },
    [api, apply],
  );

  return { jobs, start, onEvent };
}

export type ProjectRecheckControl = ReturnType<typeof useProjectRecheck>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The button and its progress for one project (in the library's project menu). Only the start and
 * the end are announced (the live region's text changes twice, R113); the counter and the bar move
 * outside it, where a screen reader finds them when asked.
 */
export function RecheckProjectButton({ control, projectId, readOnly }: { control: ProjectRecheckControl; projectId: string; readOnly: boolean }) {
  const job = control.jobs[projectId];
  const busy = job?.state === "starting" || job?.state === "running";
  return (
    <>
      <button type="button" disabled={readOnly || busy} aria-describedby={`recheck-${projectId}`} onClick={() => void control.start(projectId)}>
        Recheck project
      </button>
      {job?.state === "running" && (
        <span className="ao-muted">
          <span>
            {job.done} of {job.total}
          </span>{" "}
          <progress max={Math.max(job.total, 1)} value={Math.min(job.done, job.total)} aria-label="Project recheck progress" />
        </span>
      )}
      <span id={`recheck-${projectId}`} role="status" aria-label="Project recheck" className="ao-muted">
        {busy && "Rechecking the project's sources."}
        {job?.state === "finished" &&
          `Recheck finished: ${plural(job.changed ?? 0, "source changed", "sources changed")}${job.failed ? `, ${plural(job.failed, "source", "sources")} could not be checked` : ""}.`}
      </span>
      {job?.state === "failed" && (
        <span role="alert" className="ao-error">
          The project recheck did not start. {job.error}
        </span>
      )}
    </>
  );
}
