/**
 * The project's audit log (spec 3.10, 6.3(6)): a paged table of events, newest first, and "Verify
 * integrity", which checks the hash chain and the head recorded outside the library (R12, R82):
 * intact, broken at a position, or UNVERIFIED when this computer holds no anchor to compare with.
 *
 * Task 50 (R154 b, d): an event recorded late says when it happened, when and by which computer it
 * was recorded, and whether the action may not have finished; the project's attention marks are
 * listed ("Needs attention") with "Set aside…" (a reason, decided and audited); the library's own
 * audit log (refused project creations, set-asides) has a view and an integrity check here. Every
 * text from a log or a mark goes through UserText.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AttentionMarkView, AuditCheck, AuditEvent, AuditPage, GovernanceApi, LibraryAuditPage } from "../api/governance";
import { DialogShell } from "../components/ReasonDialog";
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
      <p role="status" className="ao-warning">
        UNVERIFIED — {plural(check.events)}, hash chain intact, but this computer has no anchor (a record of the log's last event kept outside the library) to compare it with, so a shortened log could not be detected.
      </p>
    );
  }
  return (
    <p role="status" className="ao-ok">
      {plural(check.events)} — hash chain intact
    </p>
  );
}

/**
 * Operations named in plain words where the raw name would not tell a researcher what happened
 * (Task 61): what an allowed event did, and what a refused one asked for (M-d).
 */
const PLAIN_OPS: Record<string, { allowed: string; refused: string }> = {
  "attention.set-aside": { allowed: "A mark was set aside", refused: "Setting a mark aside was asked for" },
  "project.recovery-code": { allowed: "A new recovery code was issued", refused: "A new recovery code was asked for" },
};
const PLAIN_ACTIONS: Record<string, string> = {
  "key.recovery-activated": "A new recovery code was put in place when the library opened (it may not have been shown)",
};

/** The "what" cell: a plain description where there is one, else the operation, else the entity type. */
function whatOf(e: { action: string; details?: Record<string, unknown> | undefined; entity?: { type: string } | undefined; decision?: { result?: string } | undefined }): string {
  const op = typeof e.details?.op === "string" ? e.details.op : undefined;
  if (op && Object.hasOwn(PLAIN_OPS, op)) return e.decision?.result === "deny" ? PLAIN_OPS[op]!.refused : PLAIN_OPS[op]!.allowed;
  if (Object.hasOwn(PLAIN_ACTIONS, e.action)) return PLAIN_ACTIONS[e.action]!;
  return op ?? (e.entity ? e.entity.type : "");
}

/** "Happened …; recorded late on … by …" for an event recorded after the fact (Task 50). */
function WhenCell({ e }: { e: AuditEvent }) {
  const late = e.details?.recordedLate as { occurredAt?: unknown; interrupted?: unknown; by?: unknown } | undefined;
  if (!late || typeof late !== "object") return <>{e.at}</>;
  return (
    <>
      Happened <UserText>{String(late.occurredAt ?? "?")}</UserText>; recorded late on {e.at}
      {typeof late.by === "string" ? (
        <>
          {" "}
          by <UserText>{late.by}</UserText>
        </>
      ) : null}
      {late.interrupted === true ? " — the action was interrupted and may not have finished" : ""}
    </>
  );
}

function Decision({ e }: { e: AuditEvent }) {
  if (e.decision?.result === "deny") {
    return (
      <>
        Denied: <UserText>{e.decision.reason ?? ""}</UserText>
      </>
    );
  }
  return <>{e.decision?.result === "allow_with_conditions" ? "Allowed with conditions" : e.decision ? "Allowed" : ""}</>;
}

/** A mark in plain words (no codes); the action named as recorded, through UserText. */
function markText(m: AttentionMarkView): ReactNode {
  const action = m.action ? (
    <>
      {" "}
      (<UserText>{m.action}</UserText>)
    </>
  ) : null;
  const when = m.occurredAt ? <> on <UserText>{m.occurredAt}</UserText></> : null;
  switch (m.kind) {
    case "audit-unrecorded":
      return (
        <>
          {m.refusal ? "A refusal" : "A change"}
          {action}
          {when} was not recorded in the audit log yet{m.interrupted ? "; it was interrupted and may not have finished" : ""}. It is recorded the next time the
          library is opened with write access, while this project's audit log can take it; otherwise set it aside with a reason.
        </>
      );
    case "permissions-not-set":
      return <>A file restored{when} could not be made private to you on this disk. This is tried again each time the library opens; if this disk cannot do it, set it aside with a reason.</>;
    case "unrecognised":
      return (
        <>
          An unrecognised item in the attention folder: <UserText>{m.name ?? ""}</UserText>. It is kept, and never opened, until you set it aside with a reason.
        </>
      );
    case "waiting":
      return (
        <>
          A change{action}
          {when} is kept on this computer because another computer had the library open; it is recorded when this computer next opens the library with write access.
        </>
      );
  }
}

function SetAsideDialog({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const ok = reason.trim() !== "" && !busy;
  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onCancel} busy={busy}>
      <h2 id={`${id}-t`}>Set this aside</h2>
      <p id={`${id}-d`}>The banner stops asking about it. The audit record keeps the mark, your reason, who set it aside and when.</p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (ok) onConfirm(reason.trim());
        }}
      >
        <label className="ao-stack">
          Reason
          <textarea required rows={3} maxLength={1000} value={reason} disabled={busy} onChange={(ev) => setReason(ev.target.value)} />
        </label>
        <div className="ao-actions">
          <button type="submit" disabled={!ok}>
            Set aside
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Which mark a set-aside was about, from its audit record (N3); every text through UserText. */
function MarkSummary({ mark }: { mark: unknown }) {
  const m = (mark && typeof mark === "object" ? mark : {}) as { kind?: unknown; name?: unknown; record?: { action?: unknown; occurredAt?: unknown } };
  const rec = m.record && typeof m.record === "object" ? m.record : undefined;
  const of = rec ? (
    <>
      {" "}
      (<UserText>{String(rec.action ?? "?")}</UserText>, <UserText>{String(rec.occurredAt ?? "?")}</UserText>)
    </>
  ) : null;
  switch (m.kind) {
    case "audit-unrecorded":
      return <>a change not recorded in the audit log{of}</>;
    case "permissions-not-set":
      return <>a file that could not be made private{of}</>;
    case "unrecognised":
      return (
        <>
          an unrecognised item in the attention folder: <UserText>{String(m.name ?? "")}</UserText>
        </>
      );
    default:
      return <>a mark</>;
  }
}

/** For a set-aside event: which mark and the reason (who and when are the row's own columns). */
function SetAsideDetails({ e }: { e: AuditEvent }) {
  if (e.details?.op !== "attention.set-aside") return null;
  return (
    <>
      {" "}
      — <MarkSummary mark={e.details.mark} />. Reason: <UserText>{String(e.details.reason ?? "")}</UserText>
    </>
  );
}

function NeedsAttention({ api, projectId, onChanged }: { api: GovernanceApi; projectId: string; onChanged: () => void }) {
  const ids = useId();
  const [marks, setMarks] = useState<AttentionMarkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusHeading, setFocusHeading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  /** The project whose answers are current: an answer for another one is dropped (N8). */
  const current = useRef(projectId);
  current.current = projectId;
  const sending = useRef(false);

  const load = useCallback(async () => {
    const asked = projectId;
    try {
      const r = await api.attention(asked);
      if (!alive.current || current.current !== asked) return;
      setMarks(r.marks);
      setError(null);
    } catch (err) {
      if (!alive.current || current.current !== asked) return;
      setError(err instanceof Error ? err.message : "What needs attention could not be read.");
    }
  }, [api, projectId]);
  useEffect(() => {
    setMarks(null);
    setOpen(null);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (focusHeading && marks) {
      heading.current?.focus();
      setFocusHeading(false);
    }
  }, [focusHeading, marks]);

  const setAside = async (reason: string) => {
    if (!open || sending.current) return;
    sending.current = true;
    const asked = projectId;
    setBusy(true);
    try {
      await api.setAsideMark(asked, open, reason);
      if (!alive.current || current.current !== asked) return;
      setOpen(null);
      setError(null);
      await load();
      setFocusHeading(true);
      onChanged();
    } catch (err) {
      if (!alive.current || current.current !== asked) return;
      setOpen(null);
      setError(err instanceof Error ? err.message : "It could not be set aside.");
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`} ref={heading} tabIndex={-1}>
        Needs attention
      </h2>
      {error ? (
        <p role="alert" className="ao-warning">
          <UserText>{error}</UserText>
        </p>
      ) : null}
      {marks && marks.length === 0 ? <p className="ao-hint">Nothing needs attention.</p> : null}
      {marks && marks.length > 0 ? (
        <ul>
          {marks.map((m) => (
            <li key={`${m.kind}:${m.id}`}>
              {markText(m)}
              {m.canSetAside ? (
                <>
                  {" "}
                  <button type="button" className="ao-small" onClick={() => setOpen(m.id)} disabled={busy}>
                    Set aside…
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {open ? <SetAsideDialog busy={busy} onConfirm={(r) => void setAside(r)} onCancel={() => setOpen(null)} /> : null}
    </section>
  );
}

/** What a library-log event was, in plain words; user text through UserText. */
function LibraryWhat({ e }: { e: AuditEvent }) {
  const d = e.details ?? {};
  if (d.op === "project.create") {
    return (
      <>
        A project named <UserText>{String(d.name ?? "")}</UserText> was asked for
        {e.decision?.result === "deny" ? ". Further identical refusals that day are not listed." : ""}
      </>
    );
  }
  if (d.op === "attention.set-aside") {
    return (
      <>
        {e.decision?.result === "deny" ? PLAIN_OPS["attention.set-aside"]!.refused : PLAIN_OPS["attention.set-aside"]!.allowed}
        <SetAsideDetails e={e} />
      </>
    );
  }
  if (e.action === "audit.anchor-mismatch" || e.action === "audit.anchor-missing") return <>The library's audit log was found altered when the library was opened</>;
  if (e.action === "audit.trimmed-incomplete-line") return <>An entry cut off by a crash was removed</>;
  return <UserText>{e.action}</UserText>;
}

function LibraryAudit({ api }: { api: GovernanceApi }) {
  const ids = useId();
  const [page, setPage] = useState<LibraryAuditPage | null>(null);
  const [check, setCheck] = useState<AuditCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  // Refs, not state: a double click fires before the button re-renders as disabled (N8, R113).
  const loadingRef = useRef(false);
  const checkingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const show = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const p = await api.libraryAudit({ limit: 100 });
      if (!alive.current) return;
      setPage(p);
      setError(null);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "The library's audit log could not be read.");
    } finally {
      loadingRef.current = false;
      if (alive.current) setLoading(false);
    }
  };
  const verify = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const c = await api.verifyLibraryAudit();
      if (!alive.current) return;
      setCheck(c);
      setError(null);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "The library's audit log could not be checked.");
    } finally {
      checkingRef.current = false;
      if (alive.current) setChecking(false);
    }
  };
  return (
    <section aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>The library's audit log</h2>
      <p className="ao-hint">Refused requests that belong to no project, such as a project that could not be created, and marks set aside while a project's own log could not take them.</p>
      <div className="ao-actions">
        <button type="button" onClick={() => void show()} disabled={loading}>
          Show the library's audit log
        </button>
        <button type="button" onClick={() => void verify()} disabled={checking}>
          Verify the library's audit log
        </button>
      </div>
      {check ? <Verdict check={check} /> : null}
      {error ? (
        <p role="alert" className="ao-warning">
          <UserText>{error}</UserText>
        </p>
      ) : null}
      {page ? (
        page.events.length === 0 ? (
          <p className="ao-hint">The library's audit log is empty.</p>
        ) : (
          <table className="ao-table" aria-label="Library audit events">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {page.events.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.at}</td>
                  <td>
                    <UserText>{e.actor}</UserText>
                  </td>
                  <td>
                    <LibraryWhat e={e} />
                  </td>
                  <td className={e.decision?.result === "deny" ? "ao-deny" : undefined}>
                    <Decision e={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}

export function AuditLog({ api, projectId, pageSize = 100 }: { api: GovernanceApi; projectId: string; pageSize?: number }) {
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<AuditCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const before = cursors[cursors.length - 1];
  const ids = useId();

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
      {check ? (
        <section aria-labelledby={`${ids}-check`}>
          <h2 id={`${ids}-check`}>Integrity check</h2>
          <Verdict check={check} />
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
      <NeedsAttention api={api} projectId={projectId} onChanged={() => void load()} />
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
                  <td>
                    <WhenCell e={e} />
                  </td>
                  <td>
                    <UserText>{e.actor}</UserText>
                  </td>
                  <td>
                    <UserText>{e.action}</UserText>
                  </td>
                  <td>
                    <UserText>{whatOf(e)}</UserText>
                    <SetAsideDetails e={e} />
                  </td>
                  <td className={e.decision?.result === "deny" ? "ao-deny" : undefined}>
                    <Decision e={e} />
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
      <LibraryAudit api={api} />
    </main>
  );
}
