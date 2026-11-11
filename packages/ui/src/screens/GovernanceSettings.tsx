/**
 * Governance settings (spec 6.2–6.3; mockup screen 3): profile toggles, one card per control (9)
 * with its value and which selected profile requires it, and the raw governance.yaml behind
 * "View governance.yaml". Turning a profile on raises its controls to what it requires. Loosening
 * a control (below a profile's requirement, or looser than the saved rules) first asks for a
 * reason; below a profile it is also written as an exception (control, value, reason, approver,
 * time). Saving sends the version the edit was made from (R99); a 409 means the file changed
 * elsewhere: the edits stay and the person can reload. Violations the service reports are shown on
 * the card of their control. Also: protocol approval documents and the retention list.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ApiClientError } from "../api/client";
import type { DestructionCertificate, GovernanceApi, Profile, ProtocolDocument, RetentionDue, Violation } from "../api/governance";
import { FileDrop } from "../components/FileDrop";
import { ConfirmDialog, ReasonDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import {
  ENCRYPTION_LEVELS,
  LOCATION_LEVELS,
  PROCESSING_LABEL,
  PROCESSING_OPS,
  PROFILE_LABEL,
  PROFILE_REQUIREMENTS,
  PROFILES,
  RESIDENCY_KINDS,
  RESIDENCY_LABEL,
  addException,
  belowProfile,
  getPath,
  hasException,
  isLooser,
  nowUtc,
  readConfig,
  requiredBy,
  setIn,
  tightened,
  type Config,
} from "./governanceModel";
import "./GovernanceScreens.css";

interface Pending {
  message: ReactNode;
  /** The edit to make once a reason is recorded (returns the new text). */
  apply?: (reason: string, by: string) => string;
  /** The service refused the save for want of a reason: save again with it. */
  resave?: boolean;
}

type Status = { kind: "saved" } | { kind: "conflict"; message: string } | { kind: "error"; message: string } | null;

const describe = (v: unknown) => JSON.stringify(v);

export function GovernanceSettings({ api, projectId }: { api: GovernanceApi; projectId: string }) {
  const [saved, setSaved] = useState<{ yaml: string; sha256: string } | null>(null);
  const [text, setText] = useState("");
  const [violations, setViolations] = useState<Violation[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rawId = useId();

  const load = useCallback(async () => {
    try {
      const g = await api.getGovernance(projectId);
      setSaved({ yaml: g.yaml, sha256: g.sha256 });
      setText(g.yaml);
      setViolations(g.violations);
      setReasons([]);
      setStatus(null);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The rules could not be loaded.");
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo((): { cfg: Config | null; error: string | null } => {
    try {
      return { cfg: readConfig(text), error: null };
    } catch (err) {
      return { cfg: null, error: err instanceof Error ? err.message : "governance.yaml cannot be read" };
    }
  }, [text]);
  const savedCfg = useMemo(() => {
    try {
      return saved ? readConfig(saved.yaml) : null;
    } catch {
      return null;
    }
  }, [saved]);

  const cfg = parsed.cfg;

  /** One control changed through the form. */
  const change = (control: string, value: unknown) => {
    if (!cfg) return;
    setStatus(null);
    const profile = belowProfile(cfg, control, value);
    const needsException = profile !== null && !hasException(cfg, control, value);
    const looser = savedCfg ? isLooser(control, getPath(savedCfg, control), value) : true;
    if (!needsException && !looser) {
      setText((t) => setIn(t, control, value));
      return;
    }
    setPending({
      message: needsException
        ? `${PROFILE_LABEL[profile!]} requires ${describe(requiredBy(cfg, control).find((r) => r.profile === profile)?.req.value ?? "a value")} for ${control}. Setting it to ${describe(value)} is recorded as an exception with your reason.`
        : `Setting ${control} to ${describe(value)} loosens the project's rules, so it needs a reason.`,
      apply: (reason, by) => {
        let next = setIn(text, control, value);
        if (needsException) next = addException(next, { control, value, reason, by, at: nowUtc() });
        return next;
      },
    });
  };

  const toggleProfile = (profile: Profile, on: boolean) => {
    if (!cfg) return;
    setStatus(null);
    const profiles = on ? [...new Set([...cfg.profiles, profile])] : cfg.profiles.filter((p) => p !== profile);
    if (on) {
      let next = setIn(text, "profiles", profiles);
      let current = readConfig(next);
      for (const req of PROFILE_REQUIREMENTS[profile]) {
        const before = getPath(current, req.control);
        const after = tightened(req.control, before, req);
        if (describe(after) !== describe(before)) {
          next = setIn(next, req.control, after);
          current = readConfig(next);
        }
      }
      setText(next);
      return;
    }
    setPending({
      message: `Turning off the ${PROFILE_LABEL[profile]} profile removes its requirements, so it needs a reason.`,
      apply: () => setIn(text, "profiles", profiles),
    });
  };

  const save = async (extraReason?: string) => {
    if (!saved) return;
    const all = extraReason ? [...reasons, extraReason] : reasons;
    setBusy(true);
    try {
      const r = await api.putGovernance(projectId, text, saved.sha256, all.length ? all.join("; ") : undefined);
      setSaved({ yaml: text, sha256: r.sha256 });
      setViolations(r.violations);
      setReasons([]);
      setStatus({ kind: "saved" });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        setStatus({ kind: "conflict", message: "These rules were changed elsewhere — reload to see them. Your edits are still here." });
      } else if (err instanceof ApiClientError && err.code === "VALIDATION" && /needs a reason/i.test(err.message)) {
        setReasons(all);
        setPending({ message: err.message, resave: true });
      } else {
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "The rules could not be saved." });
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmReason = (reason: string, by: string) => {
    const p = pending;
    setPending(null);
    if (!p) return;
    const line = `${reason} (${by})`;
    if (p.apply) {
      setText(p.apply(reason, by));
      setReasons((r) => [...r, line]);
    }
    if (p.resave) void save(line);
  };

  if (loadError) {
    return (
      <main className="ao-screen">
        <h1>Governance</h1>
        <p role="alert" className="ao-warning">
          {loadError}
        </p>
      </main>
    );
  }
  if (!saved) {
    return (
      <main className="ao-screen">
        <h1>Governance</h1>
        <p role="status">Loading the project's rules…</p>
      </main>
    );
  }

  const off = !cfg;

  return (
    <main className="ao-screen">
      <h1>Governance</h1>
      <p className="ao-hint">These rules are checked on every capture, import, change and export in this project. You may make any rule stricter; making one looser asks for a reason, which is kept in the audit log.</p>

      <fieldset className="ao-fieldset">
        <legend>Compliance profiles</legend>
        {PROFILES.map((p) => (
          <label key={p.id} className="ao-choice">
            <input type="checkbox" disabled={off} checked={cfg?.profiles.includes(p.id) ?? false} onChange={(e) => toggleProfile(p.id, e.target.checked)} />
            {p.label}
          </label>
        ))}
      </fieldset>

      {parsed.error ? (
        <p role="alert" className="ao-warning">
          governance.yaml cannot be read: {parsed.error}. Fix it in the text below.
        </p>
      ) : null}

      <div className="ao-cards">
        <ControlCard violations={violations} title="Data residency" controls={["residency"]}>
          <fieldset className="ao-fieldset">
            <legend>Where the library may be stored</legend>
            {RESIDENCY_KINDS.map((k) => (
              <label key={k} className="ao-choice">
                <input
                  type="checkbox"
                  disabled={off}
                  checked={cfg?.residency.allowed.includes(k) ?? false}
                  onChange={(e) => cfg && change("residency.allowed", e.target.checked ? [...cfg.residency.allowed, k] : cfg.residency.allowed.filter((x) => x !== k))}
                />
                {RESIDENCY_LABEL[k]}
              </label>
            ))}
          </fieldset>
          <Required cfg={cfg} control="residency.allowed" />
        </ControlCard>

        <ControlCard violations={violations} title="Processing location" controls={["processing", "vendors"]}>
          <p className="ao-hint">Per operation: "local" (on this computer) or named vendors, separated by commas.</p>
          {PROCESSING_OPS.map((op) => (
            <ListInput key={op} label={PROCESSING_LABEL[op]} disabled={off} value={cfg?.processing[op] ?? []} onCommit={(v) => change(`processing.${op}`, v)} />
          ))}
        </ControlCard>

        <ControlCard violations={violations} title="Identifiability" controls={["identifiability.containsIdentifiable", "identifiability.pseudonymizeFileNames"]}>
          <CheckControl cfg={cfg} onChange={change} control="identifiability.containsIdentifiable" label="This project holds identifiable data" />
          <CheckControl cfg={cfg} onChange={change} control="identifiability.pseudonymizeFileNames" label="Pseudonymise file and folder names" />
        </ControlCard>

        <ControlCard violations={violations} title="Consent and provenance" controls={["consent"]}>
          <CheckControl cfg={cfg} onChange={change} control="consent.requireStatus" label="Every source records its consent status" />
          <CheckControl cfg={cfg} onChange={change} control="consent.requireLegalBasis" label="Every identifiable source records its legal basis" />
        </ControlCard>

        <ControlCard violations={violations} title="Retention and destruction" controls={["retention"]}>
          <div className="ao-field">
            <label htmlFor={`${rawId}-ret`}>Destroy raw data after</label>
            <input
              id={`${rawId}-ret`}
              type="date"
              disabled={off}
              value={cfg?.retention.rawDataDestroyAfter ?? ""}
              onChange={(e) => change("retention.rawDataDestroyAfter", e.target.value || null)}
            />
            <Required cfg={cfg} control="retention.rawDataDestroyAfter" />
          </div>
          <Retention api={api} projectId={projectId} />
        </ControlCard>

        <ControlCard violations={violations} title="Audit log" controls={["audit"]}>
          <CheckControl cfg={cfg} onChange={change} control="audit.enabled" label="Keep an append-only, hash-chained audit log" />
        </ControlCard>

        <ControlCard violations={violations} title="Encryption" controls={["encryption"]}>
          <div className="ao-field">
            <label htmlFor={`${rawId}-enc`}>Encryption at rest</label>
            <select id={`${rawId}-enc`} disabled={off} value={cfg?.encryption.atRest ?? "required"} onChange={(e) => change("encryption.atRest", e.target.value)}>
              {ENCRYPTION_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <Required cfg={cfg} control="encryption.atRest" />
          </div>
        </ControlCard>

        <ControlCard violations={violations} title="Sharing and export" controls={["sharing", "identifiability.deidentifiedExportsOnly"]}>
          <div className="ao-field">
            <label htmlFor={`${rawId}-loc`}>Location metadata in shared copies</label>
            <select id={`${rawId}-loc`} disabled={off} value={cfg?.sharing.locationMetadata ?? "coarsen"} onChange={(e) => change("sharing.locationMetadata", e.target.value)}>
              {LOCATION_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <Required cfg={cfg} control="sharing.locationMetadata" />
          </div>
          <CheckControl cfg={cfg} onChange={change} control="identifiability.deidentifiedExportsOnly" label="Export de-identified copies only" />
        </ControlCard>

        <ControlCard violations={violations} title="Protocol record" controls={["protocol"]}>
          <TextField label="Protocol number" disabled={off} value={cfg?.protocol.number ?? ""} onChange={(v) => change("protocol.number", v || null)} />
          <TextField type="date" label="Approved from" disabled={off} value={cfg?.protocol.approvedFrom ?? ""} onChange={(v) => change("protocol.approvedFrom", v || null)} />
          <TextField type="date" label="Approval expires" disabled={off} value={cfg?.protocol.expires ?? ""} onChange={(v) => change("protocol.expires", v || null)} />
          <p className="ao-hint">Approved scope, separated by commas (empty: not restricted).</p>
          <ListInput label="Platforms" disabled={off} value={cfg?.protocol.platforms ?? []} onCommit={(v) => change("protocol.platforms", v)} />
          <ListInput label="Populations" disabled={off} value={cfg?.protocol.populations ?? []} onCommit={(v) => change("protocol.populations", v)} />
          <ListInput label="Languages" disabled={off} value={cfg?.protocol.languages ?? []} onCommit={(v) => change("protocol.languages", v)} />
          <CheckControl cfg={cfg} onChange={change} control="protocol.requireBeforeCapture" label="A protocol record is required before capture" />
          <ProtocolDocuments api={api} projectId={projectId} />
        </ControlCard>
      </div>

      <div className="ao-actions">
        <button type="button" onClick={() => void save()} disabled={busy || text === saved.yaml || off}>
          Save changes
        </button>
        <button type="button" aria-expanded={rawOpen} aria-controls={`${rawId}-raw`} onClick={() => setRawOpen((o) => !o)}>
          View governance.yaml
        </button>
        {status?.kind === "saved" ? <span role="status">Saved.</span> : null}
      </div>
      {status && status.kind !== "saved" ? (
        <div role="alert" className="ao-warning">
          {status.message}{" "}
          {status.kind === "conflict" ? (
            <button type="button" onClick={() => void load()}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}
      {rawOpen ? (
        <div id={`${rawId}-raw`} className="ao-raw">
          <label htmlFor={`${rawId}-text`}>governance.yaml</label>
          <textarea id={`${rawId}-text`} className="ao-code" rows={18} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      ) : null}
      {pending ? <ReasonDialog message={pending.message} onConfirm={confirmReason} onCancel={() => setPending(null)} /> : null}
    </main>
  );
}

function Required({ cfg, control }: { cfg: Config | null; control: string }) {
  const by = cfg ? requiredBy(cfg, control) : [];
  if (!by.length) return null;
  return <span className="ao-gov-req">Required by {by.map((b) => PROFILE_LABEL[b.profile]).join(", ")}</span>;
}

function ControlCard({ title, controls, children, violations }: { title: string; controls: string[]; children: ReactNode; violations: Violation[] }) {
  const id = useId();
  const list = violations.filter((v) => controls.some((c) => v.control === c || v.control.startsWith(`${c}.`)));
  return (
    <section className="ao-card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
      {list.length ? (
        <ul className="ao-violations">
          {list.map((v, i) => (
            <li key={i} className="ao-warning">
              {v.control}: {PROFILE_LABEL[v.profile]} requires {describe(v.required)} (this asks for {describe(v.actual)})
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CheckControl({ cfg, control, label, onChange }: { cfg: Config | null; control: string; label: string; onChange: (control: string, value: unknown) => void }) {
  return (
    <div className="ao-field">
      <label className="ao-choice">
        <input type="checkbox" disabled={!cfg} checked={cfg ? getPath(cfg, control) === true : false} onChange={(e) => onChange(control, e.target.checked)} />
        {label}
      </label>
      <Required cfg={cfg} control={control} />
    </div>
  );
}

function TextField({ label, value, onChange, disabled, type = "text" }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; type?: "text" | "date" }) {
  const id = useId();
  return (
    <div className="ao-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** A comma-separated list, committed when the field loses focus or on Enter. */
function ListInput({ label, value, onCommit, disabled }: { label: string; value: string[]; onCommit: (v: string[]) => void; disabled?: boolean }) {
  const id = useId();
  const joined = value.join(", ");
  const [draft, setDraft] = useState(joined);
  useEffect(() => setDraft(joined), [joined]);
  const commit = () => {
    const next = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (next.join(", ") !== joined) onCommit(next);
  };
  return (
    <div className="ao-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </div>
  );
}

const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function ProtocolDocuments({ api, projectId }: { api: GovernanceApi; projectId: string }) {
  const [docs, setDocs] = useState<ProtocolDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.protocolDocuments(projectId).then((r) => setDocs(r.documents), () => setError("The approval documents could not be listed."));
  }, [api, projectId]);
  const add = async (paths: string[]) => {
    try {
      setDocs((await api.addProtocolDocuments(projectId, paths)).documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The documents could not be added.");
    }
  };
  return (
    <div className="ao-subsection">
      <h3>Approval documents</h3>
      {docs.length ? (
        <ul className="ao-list">
          {docs.map((d) => (
            <li key={d.name}>
              <UserText>{d.name}</UserText> <span className="ao-hint">{`${size(d.bytes)}${d.encrypted ? ", encrypted" : ""}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ao-hint">No approval documents yet.</p>
      )}
      <FileDrop prompt="Drop approval documents here (kept in the project's protocol folder)." fieldLabel="Or add a document by its full path" onPaths={(p) => void add(p)} />
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Retention({ api, projectId }: { api: GovernanceApi; projectId: string }) {
  const [due, setDue] = useState<RetentionDue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cert, setCert] = useState<{ certificate: DestructionCertificate; certificateFile: string } | null>(null);
  const certId = useId();
  const load = useCallback(() => {
    api.retention(projectId).then(setDue, (err: unknown) => setError(err instanceof Error ? err.message : "What is due could not be listed."));
  }, [api, projectId]);
  useEffect(load, [load]);
  const assetIds = due?.due.flatMap((d) => d.assetIds) ?? [];
  const destroy = async () => {
    setBusy(true);
    try {
      setCert(await api.destroyRaw(projectId, assetIds));
      setConfirming(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The raw data could not be destroyed.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ao-subsection">
      <h3>Due for destruction</h3>
      {due === null ? (
        <p role="status">Checking…</p>
      ) : due.due.length === 0 ? (
        <p className="ao-hint">Nothing is due for destruction.</p>
      ) : (
        <ul className="ao-list">
          {due.due.map((d) => (
            <li key={d.sourceId}>
              <UserText>{d.title}</UserText> <span className="ao-hint">({d.assetIds.length === 1 ? "1 file" : `${d.assetIds.length} files`})</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ao-danger" disabled={!assetIds.length} onClick={() => setConfirming(true)}>
        Destroy raw data
      </button>
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmDialog title="Destroy raw data" word="destroy" action="Destroy permanently" busy={busy} onConfirm={() => void destroy()} onCancel={() => setConfirming(false)}>
          <p>
            {assetIds.length === 1 ? "1 raw original" : `${assetIds.length} raw originals`} will be overwritten and deleted, with the copies in this app's backups. This cannot be undone. Transcripts and other text made from them are kept.
          </p>
        </ConfirmDialog>
      ) : null}
      {cert ? (
        <section className="ao-certificate" aria-labelledby={certId}>
          <h3 id={certId}>Destruction certificate</h3>
          <p>
            {cert.certificate.assets.length === 1 ? "1 file destroyed" : `${cert.certificate.assets.length} files destroyed`} on {cert.certificate.at} by <UserText>{cert.certificate.actor}</UserText>.
          </p>
          <p>Backups holding them: {cert.certificate.backups.status}.</p>
          <p className="ao-hint">{cert.certificate.notice}</p>
          {cert.certificateFile ? (
            <p>
              Saved as <code>{cert.certificateFile}</code>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
