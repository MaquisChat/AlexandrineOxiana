/**
 * Background jobs in progress (index rebuild, recheck, backups…), from the service's `job.progress`
 * events. A polite live region: it is empty when nothing is running.
 */
import "./library.css";

export interface Job {
  key: string;
  label: string;
  done: number;
  total: number;
}

export function JobsIndicator({ jobs }: { jobs: Job[] }) {
  return (
    <div role="status" aria-label="Background jobs" className="ao-jobs">
      {jobs.length > 0 && (
        <ul className="ao-plain-list">
          {jobs.map((j) => (
            <li key={j.key} className="ao-job">
              <span>
                {j.label} {j.done}/{j.total}
              </span>
              <progress max={Math.max(j.total, 1)} value={Math.min(j.done, j.total)} aria-label={j.label} aria-valuemin={0} aria-valuemax={j.total} aria-valuenow={j.done} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
