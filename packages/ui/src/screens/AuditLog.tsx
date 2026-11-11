/**
 * The project's audit log (spec 3.10, 6.3(6)): a paged table of events, newest first, and "Verify
 * integrity", which checks the hash chain and the head recorded outside the library (R12, R82):
 * intact, broken at a position, or UNVERIFIED when this computer holds no anchor to compare with.
 */
import { useCallback, useEffect, useState } from "react";
import type { AuditCheck, AuditPage, GovernanceApi } from "../api/governance";
import { UserText } from "../components/UserText";
import "./GovernanceScreens.css";

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number) => `${count(n)} ${n === 1 ? "event" : "events"}`;

function Verdict({ check }: { check: AuditCheck }) {
  const problems: string[] = [];
  if (check.problem?.kind === "chain-broken") {
    const at = /event (\d+)/.exec(check.problem.detail)?.[1];
    problems.push(`Hash chain broken at event ${at ? count(Number(at)) : "?"} of ${count(check.events)}: ${check.problem.detail}.`);
  } else if (check.problem) {
    problems.push(`The audit log does not verify: ${check.problem.detail}.`);
  }
  for (const at of check.alteredAt) problems.push(`The audit log was found altered on ${at.slice(0, 10)} (recorded when the library was opened).`);
  if (problems.length || !check.ok) {
    return (
      <div role="alert" className="ao-warning">
        {problems.length ? problems.map((p) => <p key={p}>{p}</p>) : <p>The audit log does not verify.</p>}
      </div>
    );
  }
  if (!check.anchored) {
    return (
      <p role="status" aria-label="Integrity" className="ao-warning">
        UNVERIFIED — {plural(check.events)}, hash chain intact, but this computer has no anchor (a record of the log's last event kept outside the library) to compare it with, so a shortened log could not be detected.
      </p>
    );
  }
  return (
    <p role="status" aria-label="Integrity" className="ao-ok">
      {plural(check.events)} — hash chain intact
    </p>
  );
}

export function AuditLog({ api, projectId, pageSize = 100 }: { api: GovernanceApi; projectId: string; pageSize?: number }) {
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<AuditCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const before = cursors[cursors.length - 1];

  const load = useCallback(async () => {
    try {
      setPage(await api.audit(projectId, { limit: pageSize, ...(before !== undefined ? { before } : {}) }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The audit log could not be read.");
    }
  }, [api, projectId, pageSize, before]);
  useEffect(() => {
    void load();
  }, [load]);

  const verify = async () => {
    setChecking(true);
    setCheck(null);
    try {
      setCheck(await api.verifyAudit(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The audit log could not be checked.");
    } finally {
      setChecking(false);
    }
  };

  const events = page?.events ?? [];
  const oldest = events[events.length - 1]?.seq;
  return (
    <main className="ao-screen">
      <h1>Audit log</h1>
      <div className="ao-actions">
        <button type="button" onClick={() => void verify()} disabled={checking}>
          Verify integrity
        </button>
        {checking ? <span role="status">Checking the hash chain…</span> : null}
      </div>
      {check ? <Verdict check={check} /> : null}
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
      {page ? (
        <>
          <p className="ao-hint">{events.length ? `Events ${count(events[0]!.seq)}–${count(oldest!)} of ${count(page.total)}` : "No events."}</p>
          <table className="ao-table" aria-label="Audit events">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Operation</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.at}</td>
                  <td>
                    <UserText>{e.actor}</UserText>
                  </td>
                  <td>{e.action}</td>
                  <td>{typeof e.details?.op === "string" ? e.details.op : e.entity ? e.entity.type : ""}</td>
                  <td className={e.decision?.result === "deny" ? "ao-deny" : undefined}>
                    {e.decision?.result === "deny" ? `Denied: ${e.decision.reason ?? ""}` : e.decision?.result === "allow_with_conditions" ? "Allowed with conditions" : e.decision ? "Allowed" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ao-actions">
            <button type="button" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Newer events
            </button>
            <button type="button" disabled={oldest === undefined || oldest <= 1} onClick={() => oldest !== undefined && setCursors((c) => [...c, oldest])}>
              Older events
            </button>
          </div>
        </>
      ) : null}
    </main>
  );
}
