/**
 * Fieldwork (spec 3.6, 5.3; R97): participants (pseudonymous codes given automatically), sessions
 * and consent records. A signed consent form is attached by dropping it on its record. Withdrawing
 * a consent keeps the record (marked withdrawn), is audited, and flags the participant's sources
 * for review — nothing is deleted. A participant or session can be deleted only when nothing links
 * to it; otherwise the service says what still does.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { ConsentRecord, GovernanceApi, Participant, Session } from "../api/governance";
import { FileDrop } from "../components/FileDrop";
import { useTrap } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import "./GovernanceScreens.css";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ao-card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function WithdrawDialog({ code, onConfirm, onCancel }: { code: string; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const { ref, onKeyDown } = useTrap(onCancel);
  return (
    <div className="ao-dialog-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} className="ao-dialog" onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`}>Withdraw consent</h2>
        <p>
          The consent of <UserText>{code}</UserText> will be marked withdrawn. The record is kept, and every source linked to this participant is put in the review queue for you to decide what happens to it. Nothing is deleted.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(reason.trim());
          }}
        >
          <label className="ao-stack">
            Reason (optional; kept with the review notes)
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="ao-actions">
            <button type="submit" className="ao-danger">
              Withdraw consent
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Fieldwork({ api, projectId }: { api: GovernanceApi; projectId: string }) {
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; code: string } | null>(null);
  const [withdrawing, setWithdrawing] = useState<ConsentRecord | null>(null);
  const [session, setSession] = useState({ date: "", place: "", notes: "", participantIds: [] as string[] });
  const [consent, setConsent] = useState({ participantId: "", scope: "", date: "", expires: "" });
  const ids = useId();

  const load = useCallback(async () => {
    try {
      const [p, s, c] = await Promise.all([api.participants(projectId), api.sessions(projectId), api.consents(projectId)]);
      setParticipants(p.participants);
      setSessions(s.sessions);
      setConsents(c.consents);
      setComplete(p.complete && s.complete && c.complete);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The fieldwork records could not be loaded.");
    }
  }, [api, projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a change, shows its error (if any) and reloads the records. */
  const run = async (fn: () => Promise<string | void>) => {
    setError(null);
    setResult(null);
    try {
      const msg = await fn();
      if (msg) setResult(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That could not be done.");
    }
    await load();
  };

  const codeOf = (id: string) => participants?.find((p) => p.id === id)?.code ?? "(removed participant)";

  if (!participants) {
    return (
      <main className="ao-screen">
        <h1>Fieldwork</h1>
        {error ? (
          <p role="alert" className="ao-warning">
            {error}
          </p>
        ) : (
          <p role="status">Loading…</p>
        )}
      </main>
    );
  }

  return (
    <main className="ao-screen">
      <h1>Fieldwork</h1>
      {!complete ? <p className="ao-hint">This project is locked: identifying details, places and notes are hidden until it is unlocked.</p> : null}
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
      {result ? (
        <p role="status" aria-label="Fieldwork result" className="ao-ok">
          {result}
        </p>
      ) : null}

      <Section title="Participants">
        <ul className="ao-list">
          {participants.map((p) => (
            <li key={p.id}>
              {editing?.id === p.id ? (
                <form
                  className="ao-field"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const code = editing.code.trim();
                    setEditing(null);
                    void run(async () => {
                      await api.updateParticipant(projectId, p.id, { code });
                    });
                  }}
                >
                  <label htmlFor={`${ids}-code`}>Code</label>
                  <input id={`${ids}-code`} type="text" value={editing.code} onChange={(e) => setEditing({ id: p.id, code: e.target.value })} />
                  <button type="submit" disabled={!editing.code.trim()}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="ao-field">
                  <UserText>{p.code}</UserText>
                  <span className="ao-hint">{p.consentIds.length === 1 ? "1 consent record" : `${p.consentIds.length} consent records`}</span>
                  <button type="button" aria-label={`Edit ${p.code}`} onClick={() => setEditing({ id: p.id, code: p.code })}>
                    Edit
                  </button>
                  <button type="button" aria-label={`Delete ${p.code}`} onClick={() => void run(async () => void (await api.deleteParticipant(projectId, p.id)))}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void run(async () => void (await api.createParticipant(projectId, {})))}>
          Add participant
        </button>
        <p className="ao-hint">Each participant gets the next code (P-001, P-002, …). Identifying details stay out of citations and file names.</p>
      </Section>

      <Section title="Sessions">
        <ul className="ao-list">
          {sessions.map((s) => (
            <li key={s.id} className="ao-field">
              <span>{s.date}</span>
              {s.place ? <UserText>{s.place}</UserText> : null}
              <span className="ao-hint">{s.participantIds.map(codeOf).join(", ")}</span>
              <button type="button" aria-label={`Delete the session of ${s.date}`} onClick={() => void run(async () => void (await api.deleteSession(projectId, s.id)))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const body = {
              date: session.date,
              ...(session.place.trim() ? { place: session.place.trim() } : {}),
              ...(session.notes.trim() ? { notes: session.notes.trim() } : {}),
              participantIds: session.participantIds,
            };
            void run(async () => {
              await api.createSession(projectId, body);
              setSession({ date: "", place: "", notes: "", participantIds: [] });
            });
          }}
        >
          <div className="ao-field">
            <label htmlFor={`${ids}-sdate`}>Date</label>
            <input id={`${ids}-sdate`} type="date" required value={session.date} onChange={(e) => setSession({ ...session, date: e.target.value })} />
            <label htmlFor={`${ids}-splace`}>Place</label>
            <input id={`${ids}-splace`} type="text" value={session.place} onChange={(e) => setSession({ ...session, place: e.target.value })} />
          </div>
          {participants.length ? (
            <fieldset className="ao-fieldset">
              <legend>Participants in this session</legend>
              {participants.map((p) => (
                <label key={p.id} className="ao-choice">
                  <input
                    type="checkbox"
                    checked={session.participantIds.includes(p.id)}
                    onChange={(e) =>
                      setSession({ ...session, participantIds: e.target.checked ? [...session.participantIds, p.id] : session.participantIds.filter((x) => x !== p.id) })
                    }
                  />
                  {p.code}
                </label>
              ))}
            </fieldset>
          ) : null}
          <label className="ao-stack">
            Notes
            <textarea rows={2} value={session.notes} onChange={(e) => setSession({ ...session, notes: e.target.value })} />
          </label>
          <button type="submit" disabled={!session.date}>
            Add session
          </button>
        </form>
      </Section>

      <Section title="Consent records">
        <ul className="ao-list">
          {consents.map((c) => (
            <li key={c.id}>
              <div className="ao-field">
                <UserText>{codeOf(c.participantId)}</UserText>
                <UserText>{c.scope}</UserText>
                <span>
                  {c.date}
                  {c.expires ? `, expires ${c.expires}` : ""}
                </span>
                {c.withdrawn ? (
                  <strong className="ao-deny">Withdrawn on {c.withdrawn.at.slice(0, 10)}</strong>
                ) : (
                  <button type="button" className="ao-danger" aria-label={`Withdraw consent of ${codeOf(c.participantId)}`} onClick={() => setWithdrawing(c)}>
                    Withdraw
                  </button>
                )}
              </div>
              {c.documentAssetId ? (
                <p className="ao-hint">Signed form attached.</p>
              ) : !c.withdrawn ? (
                <FileDrop
                  prompt="Drop the signed consent form here."
                  fieldLabel="Or add the form by its full path"
                  onPaths={(paths) =>
                    void run(async () => {
                      await api.attachConsentDocument(projectId, c.id, paths[0]!);
                    })
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const body = { participantId: consent.participantId, scope: consent.scope.trim(), date: consent.date, ...(consent.expires ? { expires: consent.expires } : {}) };
            void run(async () => {
              await api.createConsent(projectId, body);
              setConsent({ participantId: "", scope: "", date: "", expires: "" });
            });
          }}
        >
          <div className="ao-field">
            <label htmlFor={`${ids}-cp`}>Participant</label>
            <select id={`${ids}-cp`} required value={consent.participantId} onChange={(e) => setConsent({ ...consent, participantId: e.target.value })}>
              <option value="">Choose…</option>
              {participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code}
                </option>
              ))}
            </select>
            <label htmlFor={`${ids}-cs`}>Scope</label>
            <input id={`${ids}-cs`} type="text" required value={consent.scope} onChange={(e) => setConsent({ ...consent, scope: e.target.value })} />
          </div>
          <div className="ao-field">
            <label htmlFor={`${ids}-cd`}>Consent date</label>
            <input id={`${ids}-cd`} type="date" required value={consent.date} onChange={(e) => setConsent({ ...consent, date: e.target.value })} />
            <label htmlFor={`${ids}-ce`}>Expires</label>
            <input id={`${ids}-ce`} type="date" value={consent.expires} onChange={(e) => setConsent({ ...consent, expires: e.target.value })} />
          </div>
          <button type="submit" disabled={!consent.participantId || !consent.scope.trim() || !consent.date}>
            Add consent record
          </button>
        </form>
      </Section>

      {withdrawing ? (
        <WithdrawDialog
          code={codeOf(withdrawing.participantId)}
          onCancel={() => setWithdrawing(null)}
          onConfirm={(reason) => {
            const c = withdrawing;
            setWithdrawing(null);
            void run(async () => {
              const r = await api.withdrawConsent(projectId, c.id, reason || undefined);
              const n = r.flaggedSourceIds.length;
              return `Consent withdrawn. ${n === 1 ? "1 source was" : `${n} sources were`} flagged for review; nothing was deleted.`;
            });
          }}
        />
      ) : null}
    </main>
  );
}
