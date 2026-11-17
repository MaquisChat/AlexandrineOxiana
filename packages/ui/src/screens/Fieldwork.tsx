/**
 * Fieldwork (spec 3.6, 5.3; R97, R117): participants (pseudonymous codes given automatically and
 * never changed), sessions and consent records, whose other details can be edited. A signed
 * consent form is attached by dropping it on its record (one at a time). Withdrawing a consent
 * keeps the record (marked withdrawn), is audited, and flags the participant's sources for review —
 * nothing is deleted. A participant or session can be deleted only when nothing links to it (asked
 * first); otherwise the service says what still does.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ConsentRecord, GovernanceApi, Participant, Session } from "../api/governance";
import { ApiClientError } from "../api/client";
import { FileDrop } from "../components/FileDrop";
import { READABLE_SCOPE_TEXT, useReadableNote } from "../components/ReadableNameNote";
import { ChoiceDialog, ReasonOptionalDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import { inAppLink, PATHS } from "../navigation";
import "./GovernanceScreens.css";

/** `headingRef`: the heading can take focus (tabIndex -1), e.g. after what had it was deleted. */
function Section({ title, children, headingRef }: { title: string; children: ReactNode; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  const id = useId();
  return (
    <section className="ao-card" aria-labelledby={id}>
      <h2 id={id} ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, type = "text", required, describedBy }: { label: string; value: string; onChange: (v: string) => void; type?: "text" | "date"; required?: boolean; describedBy?: string | undefined }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} required={required} value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

function SessionEditor({ s, onSave, onCancel, busy }: { s: Session; onSave: (patch: { date: string; place: string | null; notes: string | null }) => void; onCancel: () => void; busy: boolean }) {
  const [v, setV] = useState({ date: s.date, place: s.place ?? "", notes: s.notes ?? "" });
  return (
    <form
      className="ao-field"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ date: v.date, place: v.place.trim() || null, notes: v.notes.trim() || null });
      }}
    >
      <Field type="date" label="Date of this session" required value={v.date} onChange={(date) => setV({ ...v, date })} />
      <Field label="Place of this session" value={v.place} onChange={(place) => setV({ ...v, place })} />
      <Field label="Notes on this session" value={v.notes} onChange={(notes) => setV({ ...v, notes })} />
      <button type="submit" disabled={busy || !v.date}>
        Save session
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function ConsentEditor({ c, onSave, onCancel, encrypted, busy }: { c: ConsentRecord; onSave: (patch: { scope: string; date: string; expires: string | null }) => void; onCancel: () => void; encrypted?: boolean | undefined; busy: boolean }) {
  const [v, setV] = useState({ scope: c.scope, date: c.date, expires: c.expires ?? "" });
  // R362 h: in an encrypted project the scope is kept where it can be read without the passphrase.
  const readable = useReadableNote(encrypted, READABLE_SCOPE_TEXT);
  return (
    <form
      className="ao-field"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ scope: v.scope.trim(), date: v.date, expires: v.expires || null });
      }}
    >
      <Field label="Scope of this consent" required value={v.scope} describedBy={readable.describedBy} onChange={(scope) => setV({ ...v, scope })} />
      {readable.note}
      <Field type="date" label="Date of this consent" required value={v.date} onChange={(date) => setV({ ...v, date })} />
      <Field type="date" label="Expiry of this consent" value={v.expires} onChange={(expires) => setV({ ...v, expires })} />
      <button type="submit" disabled={busy || !v.scope.trim() || !v.date}>
        Save consent
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** `encrypted`: the project is encrypted (R362 h: a consent's scope typed here says it can be read without the passphrase). */
export function Fieldwork({ api, projectId, encrypted }: { api: GovernanceApi; projectId: string; encrypted?: boolean | undefined }) {
  const readableScope = useReadableNote(encrypted, READABLE_SCOPE_TEXT);
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Participant | null>(null);
  /** The session whose deletion is asked about (R379, I4: never deleted at one press). */
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);
  const sessionsHeading = useRef<HTMLHeadingElement>(null);
  /** Bumped after a session was deleted: focus goes to the Sessions heading (its button is gone). */
  const [sessionGone, setSessionGone] = useState(0);
  useEffect(() => {
    if (sessionGone) sessionsHeading.current?.focus();
  }, [sessionGone]);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<ConsentRecord | null>(null);
  /** A dropped form the service refused because it was detached from this record before (R119): offered for an explicit re-attach. */
  const [reattach, setReattach] = useState<{ consentId: string; path: string } | null>(null);
  const [session, setSession] = useState({ date: "", place: "", notes: "", participantIds: [] as string[] });
  const [consent, setConsent] = useState({ participantId: "", scope: "", date: "", expires: "" });
  const ids = useId();

  /** The last change put sources in the review queue: the result links to it (Task 67). */
  const [flagged, setFlagged] = useState(false);
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

  /** A request of this screen is running (R379, I3): a second press, a doubled submit or a held key is not taken. */
  const busyRef = useRef(false);
  /** Where focus was when the request started: it goes back there once the controls are enabled again. */
  const focusBack = useRef<HTMLElement | null>(null);

  /**
   * Runs a change, shows its error (if any) and reloads the records — one at a time (R379, I3): a
   * call while one runs is ignored (a consent record can never be deleted, a participant's code is
   * used up for good), and every control that starts a request is disabled meanwhile.
   */
  const run = async (fn: () => Promise<string | void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    focusBack.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setError(null);
    setResult(null);
    setFlagged(false);
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) setResult(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That could not be done.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    await load();
  };

  // The request ended and the controls are back: focus returns to where it was (disabling a focused
  // button drops focus in the browsers). A control still disabled (an emptied form) hands it to its
  // form's first field; one that is gone (a dialog closed meanwhile) is left to the dialog.
  useEffect(() => {
    if (busy) return;
    const el = focusBack.current;
    focusBack.current = null;
    if (!el || !el.isConnected) return;
    const lost = document.activeElement === null || document.activeElement === document.body || document.activeElement === el;
    if (!lost) return;
    if (!(el as HTMLButtonElement).disabled) {
      if (document.activeElement !== el) el.focus();
      return;
    }
    const first = el.closest("form")?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
    first?.focus();
  }, [busy]);

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
      {result && flagged ? (
        <p>
          <a href={`${PATHS.reviewQueue}?project=${encodeURIComponent(projectId)}`} onClick={inAppLink}>
            Open the review queue
          </a>
        </p>
      ) : null}

      <Section title="Participants">
        <ul className="ao-list">
          {participants.map((p) => (
            <li key={p.id} className="ao-field">
              <UserText>{p.code}</UserText>
              <span className="ao-hint">{p.consentIds.length === 1 ? "1 consent record" : `${p.consentIds.length} consent records`}</span>
              <button type="button" aria-label={`Delete ${p.code}`} disabled={busy} onClick={() => setDeleting(p)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <button type="button" disabled={busy} onClick={() => void run(async () => void (await api.createParticipant(projectId, {})))}>
          Add participant
        </button>
        <p className="ao-hint">Each participant gets the next code (P-001, P-002, …). A code is never changed or given to anyone else; identifying details stay out of citations and file names.</p>
      </Section>

      <Section title="Sessions" headingRef={sessionsHeading}>
        <ul className="ao-list">
          {sessions.map((s) =>
            editing === s.id ? (
              <li key={s.id}>
                <SessionEditor
                  s={s}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(patch) => {
                    setEditing(null);
                    void run(async () => void (await api.updateSession(projectId, s.id, patch)));
                  }}
                />
              </li>
            ) : (
              <li key={s.id} className="ao-field">
                <UserText>{s.date}</UserText>
                {s.place ? <UserText>{s.place}</UserText> : null}
                <span className="ao-hint">
                  {s.participantIds.map((pid) => (
                    <UserText key={pid}>{codeOf(pid)} </UserText>
                  ))}
                </span>
                <button type="button" aria-label={`Edit the session of ${s.date}`} onClick={() => setEditing(s.id)}>
                  Edit
                </button>
                <button type="button" aria-label={`Delete the session of ${s.date}`} disabled={busy} onClick={() => setDeletingSession(s)}>
                  Delete
                </button>
              </li>
            ),
          )}
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
                  <UserText>{p.code}</UserText>
                </label>
              ))}
            </fieldset>
          ) : null}
          <label className="ao-stack">
            Notes
            <textarea rows={2} value={session.notes} onChange={(e) => setSession({ ...session, notes: e.target.value })} />
          </label>
          <button type="submit" disabled={busy || !session.date}>
            Add session
          </button>
        </form>
      </Section>

      <Section title="Consent records">
        <ul className="ao-list">
          {consents.map((c) => (
            <li key={c.id}>
              {editing === c.id ? (
                <ConsentEditor
                  busy={busy}
                  encrypted={encrypted}
                  c={c}
                  onCancel={() => setEditing(null)}
                  onSave={(patch) => {
                    setEditing(null);
                    void run(async () => void (await api.updateConsent(projectId, c.id, patch)));
                  }}
                />
              ) : (
                <div className="ao-field">
                  <UserText>{codeOf(c.participantId)}</UserText>
                  <UserText>{c.scope}</UserText>
                  <UserText>{c.date}</UserText>
                  {c.expires ? (
                    <span>
                      expires <UserText>{c.expires}</UserText>
                    </span>
                  ) : null}
                  {c.withdrawn ? (
                    <strong className="ao-deny">
                      Withdrawn on <UserText>{c.withdrawn.at.slice(0, 10)}</UserText>
                    </strong>
                  ) : (
                    <>
                      <button type="button" aria-label={`Edit consent of ${codeOf(c.participantId)}`} onClick={() => setEditing(c.id)}>
                        Edit
                      </button>
                      <button type="button" className="ao-danger" aria-label={`Withdraw consent of ${codeOf(c.participantId)}`} disabled={busy} onClick={() => setWithdrawing(c)}>
                        Withdraw
                      </button>
                    </>
                  )}
                </div>
              )}
              {c.documentAssetId ? (
                <p className="ao-hint">Signed form attached.</p>
              ) : !c.withdrawn ? (
                <FileDrop
                  prompt="Drop the signed consent form here (a PDF or an image, up to 100 MB)."
                  fieldLabel="Or add the form by its full path"
                  single={{ message: "Drop one signed form at a time: each consent record holds one form. Nothing was added." }}
                  disabled={busy}
                  onPaths={(paths) =>
                    void run(async () => {
                      setReattach(null);
                      try {
                        const r = await api.attachConsentDocument(projectId, c.id, paths[0]!);
                        return r.note ? `Signed form attached. ${r.note}` : undefined;
                      } catch (err) {
                        if (err instanceof ApiClientError && err.reason === "detached-form") {
                          setReattach({ consentId: c.id, path: paths[0]! });
                          return;
                        }
                        throw err;
                      }
                    })
                  }
                />
              ) : null}
              {reattach?.consentId === c.id && !c.documentAssetId && (
                <div role="group" aria-label={`Re-attach the signed form of ${codeOf(c.participantId)}?`} className="ao-field">
                  <span>
                    This form was detached from this consent record before. Re-attach it? Re-attaching is recorded in the project&apos;s audit log.
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const { path } = reattach;
                      void run(async () => {
                        const r = await api.attachConsentDocument(projectId, c.id, path, true);
                        setReattach(null);
                        return r.note ? `Signed form attached. ${r.note}` : undefined;
                      });
                    }}
                  >
                    Re-attach the form
                  </button>
                  <button type="button" disabled={busy} onClick={() => setReattach(null)}>
                    Cancel
                  </button>
                </div>
              )}
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
            <input id={`${ids}-cs`} type="text" required value={consent.scope} aria-describedby={readableScope.describedBy} onChange={(e) => setConsent({ ...consent, scope: e.target.value })} />
            {readableScope.note}
          </div>
          <div className="ao-field">
            <label htmlFor={`${ids}-cd`}>Consent date</label>
            <input id={`${ids}-cd`} type="date" required value={consent.date} onChange={(e) => setConsent({ ...consent, date: e.target.value })} />
            <label htmlFor={`${ids}-ce`}>Expires</label>
            <input id={`${ids}-ce`} type="date" value={consent.expires} onChange={(e) => setConsent({ ...consent, expires: e.target.value })} />
          </div>
          <button type="submit" disabled={busy || !consent.participantId || !consent.scope.trim() || !consent.date}>
            Add consent record
          </button>
        </form>
      </Section>

      {deleting ? (
        <ChoiceDialog
          title={`Delete participant ${deleting.code}`}
          action="Delete"
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const p = deleting;
            void run(async () => {
              await api.deleteParticipant(projectId, p.id);
            }).finally(() => setDeleting(null));
          }}
        >
          <p>
            <UserText>{deleting.code}</UserText> will be deleted. Its code is retired and never given to anyone else. A participant that consent records, sessions, sources or the
            pseudonym map refer to cannot be deleted; withdraw their consent instead.
          </p>
        </ChoiceDialog>
      ) : null}

      {deletingSession ? (
        <ChoiceDialog
          title={`Delete the session of ${deletingSession.date}${deletingSession.place ? `, ${deletingSession.place}` : ""}`}
          action="Delete session"
          busy={busy}
          onCancel={() => setDeletingSession(null)}
          onConfirm={() => {
            const s = deletingSession;
            let gone = false;
            void run(async () => {
              await api.deleteSession(projectId, s.id);
              gone = true;
            }).finally(() => {
              setDeletingSession(null);
              if (gone) setSessionGone((n) => n + 1);
            });
          }}
        >
          <p>
            The session of <UserText>{deletingSession.date}</UserText>
            {deletingSession.place ? (
              <>
                {" "}
                in <UserText>{deletingSession.place}</UserText>
              </>
            ) : null}{" "}
            will be deleted, with its date, place and notes. A session that sources refer to cannot be deleted.
          </p>
        </ChoiceDialog>
      ) : null}

      {withdrawing ? (
        <ReasonOptionalDialog
          title="Withdraw consent"
          label="Reason (optional; kept with the record, sealed in encrypted projects)"
          action="Withdraw consent"
          onCancel={() => setWithdrawing(null)}
          onConfirm={(reason) => {
            const c = withdrawing;
            setWithdrawing(null);
            void run(async () => {
              const r = await api.withdrawConsent(projectId, c.id, reason || undefined);
              const n = r.flaggedSourceIds.length;
              setFlagged(n > 0);
              return `Consent withdrawn. ${n === 1 ? "1 source was" : `${n} sources were`} flagged for review; nothing was deleted.`;
            });
          }}
        >
          <p>
            The consent of <UserText>{codeOf(withdrawing.participantId)}</UserText> will be marked withdrawn. The record is kept, and every source linked to this participant (directly or
            through a session) is put in the review queue for you to decide what happens to it. Nothing is deleted.
          </p>
        </ReasonOptionalDialog>
      ) : null}
    </main>
  );
}
