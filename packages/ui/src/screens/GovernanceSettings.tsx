/**
 * Governance settings (spec 6.2–6.3; mockup screen 3): profile toggles, one card per control (9)
 * with its value and which selected profile requires it, and the raw governance.yaml behind
 * "View governance.yaml". Turning a profile on raises its controls to what it requires. Loosening
 * a control (below a profile's requirement, or looser than the saved rules) first asks for a
 * reason; below a profile it is also written as an exception (control, value, reason, approver,
 * time). Saving sends the version the edit was made from (R99); a 409 means the file changed
 * elsewhere: the edits stay and the person can reload. Violations the service reports are shown on
 * the card of their control. Also: protocol approval documents and the retention list.
 *
 * The cards are read with a lenient reader (so a broken file can still be corrected here); whether
 * the policy engine can read the rules is the service's to say (R379 FR-A18, R58): when it cannot,
 * an alert says that every capture, import, change and export is refused and lists the problems;
 * readable rules with notes show them. Both are re-read after a save.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { GOVERNANCE_UNREADABLE_TEXT, GOVERNANCE_WARNINGS_TEXT, type GovernanceReadability } from "@ao/shared";
import { ApiClientError } from "../api/client";
import type { DestructionCertificate, GovernanceApi, Profile, ProtocolDocument, ProtocolDocumentResult, RetentionDue, Violation } from "../api/governance";
import { FileDrop } from "../components/FileDrop";
import { ConfirmDialog, ReasonDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import {
  ACQUIRE_LABEL,
  ACQUIRE_METHODS,
  type AcquireMethod,
  CAPTURE_LABEL,
  CAPTURE_METHODS,
  WEB_CAPTURE_METHODS,
  WEB_LEGAL_CATEGORY,
  captureNeeds,
  removeIn,
  type CaptureMethod,
  ENCRYPTION_LEVELS,
  LOCATION_LEVELS,
  PROCESSING_LABEL,
  PROCESSING_OPS,
  PROFILE_LABEL,
  PROFILE_RESIDENCY_RULES,
  PROFILE_VENDOR_RULES,
  PROFILES,
  RESIDENCY_KINDS,
  RESIDENCY_LABEL,
  addException,
  belowProfile,
  getPath,
  hasException,
  isLooser,
  nowUtc,
  profileOnEntries,
  readConfig,
  requiredBy,
  setIn,
  setManyIn,
  type Config,
} from "./governanceModel";
import "./GovernanceScreens.css";

interface Pending {
  message: ReactNode;
  /** The edit records an exception: its reason and the approver's name are written into governance.yaml. */
  exception?: boolean;
  /** The edit to make once a reason is recorded (returns the new text). */
  apply?: (reason: string, by: string) => string;
  /** The service refused the save for want of a reason: save again with it. */
  resave?: boolean;
}

type Status = { kind: "saved" } | { kind: "conflict"; message: string } | { kind: "error"; message: string } | null;

const describe = (v: unknown) => JSON.stringify(v);

export interface GovernanceSettingsProps {
  api: GovernanceApi;
  projectId: string;
  /**
   * Why these rules cannot be changed now (a locked project, a read-only library), in plain words;
   * the rules are then shown but every control is off, with this reason.
   */
  readOnlyReason?: string | undefined;
  /** The project is encrypted (from the project list): its governance.yaml is still readable without the passphrase. */
  encrypted?: boolean | undefined;
}

/**
 * R369 a: an exception's reason and its approver's name are written into governance.yaml, which an encrypted project
 * does not seal (sealing them is the owner's decision); the "Record a reason" dialog says so, tied to its fields.
 */
export const EXCEPTION_READABLE_NOTE =
  "In an encrypted project this reason and the approver's name are kept in the project's rules file, which can be read without the passphrase. Do not put a participant's name in them.";

/** Today in this computer's time zone, YYYY-MM-DD (protocol dates are read in it when no project time zone is set). */
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function GovernanceSettings({ api, projectId, readOnlyReason, encrypted }: GovernanceSettingsProps) {
  const [saved, setSaved] = useState<{ yaml: string; sha256: string } | null>(null);
  const [text, setTextNow] = useState("");
  // What the cards show is parsed from `parseText`: at once for form edits, 300 ms after the last
  // keystroke in the raw editor (R117 I7: no full parse per keystroke of a large file).
  const [parseText, setParseText] = useState("");
  const setText = useCallback((next: string | ((t: string) => string)) => {
    setTextNow((t) => {
      const v = typeof next === "function" ? next(t) : next;
      setParseText(v);
      return v;
    });
  }, []);
  const rawTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typeRaw = (v: string) => {
    setTextNow(v);
    clearTimeout(rawTimer.current);
    rawTimer.current = setTimeout(() => setParseText(v), 300);
  };
  useEffect(() => () => clearTimeout(rawTimer.current), []);
  const [violations, setViolations] = useState<Violation[]>([]);
  /** Whether the policy engine can read the saved rules, with its problems or notes (R379 FR-A18). */
  const [readability, setReadability] = useState<GovernanceReadability | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Counts cancelled reason dialogs: a field holding the cancelled value is reset from the rules. */
  const [cancelled, setCancelled] = useState(0);
  const rawId = useId();

  const load = useCallback(async () => {
    try {
      const g = await api.getGovernance(projectId);
      setSaved({ yaml: g.yaml, sha256: g.sha256 });
      setText(g.yaml);
      setViolations(g.violations);
      setReadability(readabilityOf(g));
      setReasons([]);
      setStatus(null);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The rules could not be loaded.");
    }
  }, [api, projectId, setText]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo((): { cfg: Config | null; error: string | null } => {
    try {
      return { cfg: readConfig(parseText), error: null };
    } catch (err) {
      return { cfg: null, error: err instanceof Error ? err.message : "governance.yaml cannot be read" };
    }
  }, [parseText]);
  const savedCfg = useMemo(() => {
    try {
      return saved ? readConfig(saved.yaml) : null;
    } catch {
      return null;
    }
  }, [saved]);

  const cfg = parsed.cfg;

  /**
   * One control changed through the form; `said` names the change in plain words for the reason dialog. `write`, when
   * given, makes the edit to the text in place of setting `control` to `value` (the Elicit box: the same value, written
   * so that everything else in the file stays as it is); the reason is asked exactly as for any other control.
   */
  const change = (control: string, value: unknown, said?: ReactNode, write?: (text: string) => string) => {
    if (!cfg || readOnlyReason) return;
    setStatus(null);
    const profile = belowProfile(cfg, control, value);
    const needsException = profile !== null && !hasException(cfg, control, value);
    const looser = savedCfg ? isLooser(control, getPath(savedCfg, control), value) : true;
    if (!needsException && !looser) {
      setText((t) => (write ? write(t) : setIn(t, control, value)));
      return;
    }
    setPending({
      exception: needsException,
      message: needsException
        ? `${PROFILE_LABEL[profile!]} requires ${describe(requiredBy(cfg, control).find((r) => r.profile === profile)?.req.value ?? "a value")} for ${control}. Setting it to ${describe(value)} is recorded as an exception with your reason.`
        : said
          ? (
            <>
              {said} loosens the project&apos;s rules, so it needs a reason.
            </>
          )
          : `Setting ${control} to ${describe(value)} loosens the project's rules, so it needs a reason.`,
      apply: (reason: string, by: string) => {
        let next = write ? write(text) : setIn(text, control, value);
        if (needsException) next = addException(next, { control, value, reason, by, at: nowUtc() });
        return next;
      },
    });
  };

  const toggleProfile = (profile: Profile, on: boolean) => {
    if (!cfg) return;
    // FR-156: the text as it is now, parsed once here (R119), not the rules parsed 300 ms after the last raw keystroke,
    // so that a profiles list or a control just typed in the editor is neither overwritten nor missed.
    let now: Config;
    try {
      now = readConfig(text);
    } catch {
      return;
    }
    setStatus(null);
    const profiles = on ? [...new Set([...now.profiles, profile])] : now.profiles.filter((p) => p !== profile);
    if (on) {
      // Every requirement of the profile, worked out from the current text, applied in one edit (R119).
      setText(setManyIn(text, profileOnEntries(now, profile)));
      return;
    }
    setPending({
      message: `Turning off the ${PROFILE_LABEL[profile]} profile removes its requirements, so it needs a reason.`,
      apply: () => setIn(text, "profiles", profiles),
    });
  };

  /** A save in flight: one request per action, however fast the clicks or key repeats (R113). */
  const saving = useRef(false);
  const save = async (extraReason?: string) => {
    if (!saved || saving.current) return;
    saving.current = true;
    const all = extraReason ? [...reasons, extraReason] : reasons;
    setBusy(true);
    try {
      const r = await api.putGovernance(projectId, text, saved.sha256, all.length ? all.join("; ") : undefined);
      setSaved({ yaml: text, sha256: r.sha256 });
      setViolations(r.violations);
      setReadability(readabilityOf(r));
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
      saving.current = false;
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

  const off = !cfg || !!readOnlyReason;

  return (
    <main className="ao-screen">
      <h1>Governance</h1>
      <RulesReadability readability={readability} />
      <p className="ao-hint">These rules are checked on every capture, import, change and export in this project. You may make any rule stricter; making one looser asks for a reason, which is kept in the audit log.</p>
      {readOnlyReason ? (
        <p id={`${rawId}-why`} className="ao-warning">
          {readOnlyReason}
        </p>
      ) : null}

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
          <ProfileNotes cfg={cfg} rules={PROFILE_RESIDENCY_RULES} />
        </ControlCard>

        <ControlCard violations={violations} title="Processing location" controls={["processing", "vendors"]}>
          <p className="ao-hint">Per operation: "local" (on this computer) or named vendors, separated by commas.</p>
          {PROCESSING_OPS.map((op) => (
            <ListInput key={op} reset={cancelled} label={PROCESSING_LABEL[op]} disabled={off} value={cfg?.processing[op] ?? []} onCommit={(v) => change(`processing.${op}`, v)} />
          ))}
          <ProfileNotes cfg={cfg} rules={PROFILE_VENDOR_RULES} />
        </ControlCard>

        <ControlCard violations={violations} title="Identifiability" controls={["identifiability.containsIdentifiable", "identifiability.pseudonymizeFileNames"]}>
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="identifiability.containsIdentifiable" label="This project holds identifiable data" />
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="identifiability.pseudonymizeFileNames" label="Pseudonymise file and folder names" />
        </ControlCard>

        <ControlCard violations={violations} title="Consent and provenance" controls={["consent"]}>
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="consent.requireStatus" label="Every source records its consent status" />
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="consent.requireLegalBasis" label="Every identifiable source records its legal basis" />
        </ControlCard>

        <ControlCard violations={violations} title="Capture methods" controls={["captureMethods", "consent.defaultLegalBasis"]}>
          <CaptureMethods
            cfg={cfg}
            disabled={off}
            {...(readOnlyReason ? { whyId: `${rawId}-why` } : {})}
            cancelled={cancelled}
            onChange={change}
            onClearDefault={(path) => {
              setStatus(null);
              setText((t) => removeIn(t, path));
            }}
          />
        </ControlCard>

        <ControlCard violations={violations} title="How Find and acquire may get works" controls={["acquireMethods", `consent.defaultLegalBasis.${FIND_LEGAL_CATEGORY}`, "processing.metadata_lookup"]}>
          <FindAcquireWays
            cfg={cfg}
            savedVendors={savedCfg ? getPath(savedCfg, "vendors") : undefined}
            violations={violations}
            unsaved={text !== saved.yaml}
            disabled={off}
            {...(readOnlyReason ? { whyId: `${rawId}-why` } : {})}
            cancelled={cancelled}
            onChange={change}
            onClearDefault={(path) => {
              setStatus(null);
              setText((t) => removeIn(t, path));
            }}
          />
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
          <Retention api={api} projectId={projectId} {...(readOnlyReason ? { whyId: `${rawId}-why` } : {})} />
        </ControlCard>

        <ControlCard violations={violations} title="Audit log" controls={["audit"]}>
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="audit.enabled" label="Keep an append-only, hash-chained audit log" />
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
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="identifiability.deidentifiedExportsOnly" label="Export de-identified copies only" />
        </ControlCard>

        <ControlCard violations={violations} title="Protocol record" controls={["protocol"]}>
          <TextField label="Protocol number" disabled={off} value={cfg?.protocol.number ?? ""} onChange={(v) => change("protocol.number", v || null)} />
          <TextField type="date" label="Approved from" disabled={off} value={cfg?.protocol.approvedFrom ?? ""} onChange={(v) => change("protocol.approvedFrom", v || null)} />
          <TextField type="date" label="Approval expires" disabled={off} value={cfg?.protocol.expires ?? ""} onChange={(v) => change("protocol.expires", v || null)} />
          <p className="ao-hint">Approved scope, separated by commas (empty: not restricted).</p>
          <ListInput reset={cancelled} label="Platforms" disabled={off} value={cfg?.protocol.platforms ?? []} onCommit={(v) => change("protocol.platforms", v)} />
          <ListInput reset={cancelled} label="Populations" disabled={off} value={cfg?.protocol.populations ?? []} onCommit={(v) => change("protocol.populations", v)} />
          <ListInput reset={cancelled} label="Languages" disabled={off} value={cfg?.protocol.languages ?? []} onCommit={(v) => change("protocol.languages", v)} />
          <CheckControl cfg={cfg} disabled={off} onChange={change} control="protocol.requireBeforeCapture" label="A protocol record is required before capture" />
          <ProtocolDocuments api={api} projectId={projectId} {...(readOnlyReason ? { whyId: `${rawId}-why` } : {})} />
        </ControlCard>

        <ControlCard violations={violations} title="Data management plan" controls={["dmp"]}>
          <p className="ao-hint">What the funder's data management plan promises: where the data will be deposited, and in which formats.</p>
          <div className="ao-field">
            <TextField label="Repository" disabled={off} value={cfg?.dmp.repository ?? ""} onChange={(v) => change("dmp.repository", v || null)} />
            <Required cfg={cfg} control="dmp.repository" />
          </div>
          <div className="ao-field">
            <ListInput reset={cancelled} label="Formats" disabled={off} value={cfg?.dmp.formats ?? []} onCommit={(v) => change("dmp.formats", v)} />
            <Required cfg={cfg} control="dmp.formats" />
          </div>
          <TextField label="Metadata standard" disabled={off} value={cfg?.dmp.metadataStandard ?? ""} onChange={(v) => change("dmp.metadataStandard", v || null)} />
          <TextField type="date" label="Embargo until" disabled={off} value={cfg?.dmp.embargoUntil ?? ""} onChange={(v) => change("dmp.embargoUntil", v || null)} />
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
          <textarea id={`${rawId}-text`} className="ao-code" rows={18} spellCheck={false} readOnly={!!readOnlyReason} value={text} onChange={(e) => typeRaw(e.target.value)} />
        </div>
      ) : null}
      {pending ? (
        <ReasonDialog
          message={pending.message}
          {...(encrypted && pending.exception ? { fieldNote: EXCEPTION_READABLE_NOTE } : {})}
          onConfirm={confirmReason}
          onCancel={() => {
            setPending(null);
            // A field whose change was not recorded goes back to the rules as they are (review M2).
            setCancelled((n) => n + 1);
          }}
        />
      ) : null}
    </main>
  );
}

/** The service's readability answer, as given (lists default to empty). */
function readabilityOf(g: Partial<GovernanceReadability>): GovernanceReadability {
  return { readable: g.readable !== false, issues: g.issues ?? [], warnings: g.warnings ?? [] };
}

/**
 * Rules the policy engine cannot read (an alert: every request in the project is refused), or the
 * notes from reading readable ones (R379 FR-A18, R58). The alert does not move focus.
 */
function RulesReadability({ readability }: { readability: GovernanceReadability | null }) {
  if (!readability) return null;
  if (!readability.readable) {
    return (
      <div role="alert" className="ao-warning">
        <p>{GOVERNANCE_UNREADABLE_TEXT}</p>
        {readability.issues.length ? (
          <ul className="ao-list">
            {readability.issues.map((issue, i) => (
              <li key={i}>
                <UserText>{issue}</UserText>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  if (!readability.warnings.length) return null;
  return (
    <div className="ao-hint">
      <p>{GOVERNANCE_WARNINGS_TEXT}</p>
      <ul className="ao-list">
        {readability.warnings.map((w, i) => (
          <li key={i}>
            <UserText>{w}</UserText>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Required({ cfg, control }: { cfg: Config | null; control: string }) {
  const by = cfg ? requiredBy(cfg, control) : [];
  if (!by.length) return null;
  return <span className="ao-gov-req">Required by {by.map((b) => PROFILE_LABEL[b.profile]).join(", ")}</span>;
}

/** Profile rules that are not a single value (vendor agreements, cloud folders), for the selected profiles. */
function ProfileNotes({ cfg, rules }: { cfg: Config | null; rules: Partial<Record<Profile, string>> }) {
  const list = (cfg?.profiles ?? []).filter((p) => rules[p]);
  if (!list.length) return null;
  return (
    <ul className="ao-list">
      {list.map((p) => (
        <li key={p}>
          <span className="ao-gov-req">Required by {PROFILE_LABEL[p]}</span> {PROFILE_LABEL[p]}: {rules[p]}
        </li>
      ))}
    </ul>
  );
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

/**
 * The project's capture methods (D11): every method the rules know, in plain words, written to
 * `captureMethods` through the same governed change as the other controls. Next to the methods that
 * capture from the web it says what else a capture needs before it will run (R41), and offers the
 * default legal basis those captures use when none is given with them.
 */
function CaptureMethods({
  cfg,
  disabled,
  whyId,
  cancelled,
  onChange,
  onClearDefault,
}: {
  cfg: Config | null;
  disabled: boolean;
  /** The element saying why the rules cannot be changed now. */
  whyId?: string;
  /** Changes when a reason dialog is cancelled: the default legal basis field is reset from the rules. */
  cancelled: number;
  onChange: (control: string, value: unknown, said?: ReactNode) => void;
  onClearDefault: (path: string) => void;
}) {
  const id = useId();
  const on = new Set(cfg?.captureMethods ?? []);
  const needs = cfg ? captureNeeds(cfg, localToday()) : [];
  const basisPath = `consent.defaultLegalBasis.${WEB_LEGAL_CATEGORY}`;
  const basis = cfg?.consent.defaultLegalBasis?.[WEB_LEGAL_CATEGORY] ?? "";
  const toggle = (m: CaptureMethod, checked: boolean) => {
    if (!cfg) return;
    const next = CAPTURE_METHODS.filter((x) => (x === m ? checked : on.has(x)));
    // Methods the rules file names that this version does not know are kept as written.
    const unknown = cfg.captureMethods.filter((x) => !(CAPTURE_METHODS as readonly string[]).includes(x));
    onChange("captureMethods", [...next, ...unknown], `${checked ? "Allowing" : "Not allowing"} “${CAPTURE_LABEL[m]}”`);
  };
  const box = (m: CaptureMethod, describedBy?: string) => (
    <label key={m} className="ao-choice">
      <input type="checkbox" disabled={disabled} checked={on.has(m)} aria-describedby={describedBy} onChange={(e) => toggle(m, e.target.checked)} />
      {CAPTURE_LABEL[m]}
    </label>
  );
  return (
    <>
      <p className="ao-hint">How sources may come into this project. A method that is not ticked is refused, whoever asks: the Capture screen, the browser extension or an import.</p>
      <fieldset className="ao-fieldset" aria-describedby={whyId}>
        <legend>How sources may come in from the web</legend>
        {WEB_CAPTURE_METHODS.map((m) => box(m, `${id}-needs`))}
        <div id={`${id}-needs`} role="note" aria-labelledby={`${id}-needs-h`} className="ao-hint">
          <p id={`${id}-needs-h`}>What a capture from the web also needs before it will run:</p>
          {needs.length ? (
            <ul className="ao-list">
              {needs.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <p>Nothing else under these rules.</p>
          )}
        </div>
        <CommitInput
          reset={cancelled}
          label="Default legal basis for captures from the web (recorded with each capture that gives none)"
          hint="For example: Public task, GDPR Art. 6(1)(e). Setting or changing it loosens the rules, so it asks for a reason."
          disabled={disabled}
          value={basis}
          onCommit={(v) =>
            v
              ? onChange(
                  basisPath,
                  v,
                  <>
                    Setting the default legal basis for captures from the web to “<UserText>{v}</UserText>”
                  </>,
                )
              : onClearDefault(basisPath)
          }
        />
      </fieldset>
      <fieldset className="ao-fieldset" aria-describedby={whyId}>
        <legend>How sources may come in from files and other programs</legend>
        {CAPTURE_METHODS.filter((m) => !WEB_CAPTURE_METHODS.includes(m)).map((m) => box(m))}
      </fieldset>
    </>
  );
}

/** The data category of records made from typed references (the library's FIND_LEGAL_CATEGORY; plan Amendment A3). */
const FIND_LEGAL_CATEGORY = "reference-lookup";
/** The provider name a project's rules give Elicit under metadata lookups, with a vendor of that id (F12's report; R302 b). */
const ELICIT = "elicit";
const ELICIT_LABEL = "Elicit (a commercial service; it receives the words you type and nothing about this project)";
/** What the profiles' vendor rules mean for Elicit (core merge.ts: a vendor without the agreement is dropped). */
const ELICIT_PROFILE_NOTE: Partial<Record<Profile, string>> = {
  gdpr: "Under GDPR, Elicit is used only once its entry under vendors in governance.yaml records a data processing agreement (dpa: true).",
  hipaa: "Under HIPAA, Elicit is used only once its entry under vendors in governance.yaml records a business associate agreement (baa: true).",
};

/** Edits the YAML text in place with one parse, keeping comments and layout elsewhere. */
function editYaml(text: string, fn: (doc: Document) => void): string {
  const doc = parseDocument(text, { uniqueKeys: true }) as Document;
  if (doc.errors.length) throw new Error(doc.errors[0]!.message.split("\n")[0]);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  fn(doc);
  return String(doc);
}

/**
 * Elicit added to or taken out of `processing.metadata_lookup`: in the list as written when there is one (its other
 * entries untouched), else the list in force (`current`) written with or without it. Added, a vendor `elicit` is
 * declared unless one is already (an existing declaration, with its agreements, is kept as it is). Taken out, nothing
 * else changes: the vendors stay byte for byte (a declared vendor that no operation names allows nothing).
 */
/** Exactly the entry the Elicit box writes: `- id: elicit`, no other key, no comment anywhere on it. */
function isBoxEntry(v: unknown): boolean {
  if (!isMap(v) || v.items.length !== 1 || v.get("id") !== ELICIT) return false;
  const pair = v.items[0]!;
  const nodes = [v, pair.key, pair.value] as { comment?: string | null; commentBefore?: string | null }[];
  return nodes.every((n) => !n || (!n.comment && !n.commentBefore));
}

function writeElicit(text: string, on: boolean, current: string[], savedVendors: unknown): string {
  return editYaml(text, (doc) => {
    const path = ["processing", "metadata_lookup"];
    const list = doc.getIn(path, true);
    const isElicit = (n: unknown) => isScalar(n) && n.value === ELICIT;
    if (isSeq(list)) {
      if (on && !list.items.some(isElicit)) list.add(doc.createNode(ELICIT));
      if (!on) list.items = list.items.filter((n) => !isElicit(n));
    } else {
      const rest = current.filter((x) => x !== ELICIT);
      doc.setIn(path, doc.createNode(on ? [...rest, ELICIT] : rest));
    }
    const vendors = doc.getIn(["vendors"], true);
    if (!on) {
      // R314 e: a vendor entry for Elicit that this draft added (the saved file had none) goes with the tick.
      if (vendorDeclared(savedVendors) || !isSeq(vendors)) return;
      // R316 c: only an entry that is exactly what the box writes (the id alone, no comment) goes; anything typed stays.
      vendors.items = vendors.items.filter((v) => !isBoxEntry(v));
      if (vendors.items.length === 0 && savedVendors === undefined) doc.deleteIn(["vendors"]);
      return;
    }
    if (isSeq(vendors)) {
      if (!vendors.items.some((v) => isMap(v) && v.get("id") === ELICIT)) vendors.add(doc.createNode({ id: ELICIT }));
    } else if (vendors === undefined || vendors === null || (isScalar(vendors) && vendors.value === null)) {
      doc.setIn(["vendors"], doc.createNode([{ id: ELICIT }]));
    }
  });
}

/** Whether a vendors list (as read) declares Elicit. */
const vendorDeclared = (vendors: unknown): boolean =>
  Array.isArray(vendors) && vendors.some((v) => typeof v === "object" && v !== null && (v as { id?: unknown }).id === ELICIT);

/**
 * Why the rules in force do not allow Elicit, from the service's own evaluation (R314 a): a violation of the saved rules
 * for `processing.metadata_lookup` whose file names Elicit and whose effective list drops it. The service gives the
 * profile that dropped it (core merge.ts: a vendor without the agreement the profile requires); its reason in words is
 * R314's. Empty when the service reports no such violation.
 */
const ELICIT_DROPPED_BY: Partial<Record<Profile, string>> = {
  gdpr: "under GDPR, a data processing agreement must be recorded for Elicit under vendors (dpa: true).",
  hipaa: "under HIPAA, a business associate agreement must be recorded for Elicit under vendors (baa: true).",
};
function elicitRefusals(violations: Violation[]): string[] {
  return violations
    .filter((v) => v.control === "processing.metadata_lookup" && Array.isArray(v.actual) && v.actual.includes(ELICIT) && Array.isArray(v.required) && !v.required.includes(ELICIT))
    .map((v) => ELICIT_DROPPED_BY[v.profile] ?? "");
}

/**
 * How Find and acquire may get works (Find and acquire Task F13; R225 2, R301, R302 b): the three ways, written to
 * `acquireMethods` through the same governed change as every other control (adding one is a loosening: a reason is
 * asked); Elicit, allowed per project by one box that writes what the "Metadata lookups" field of "Processing location"
 * writes (the provider `elicit`, with its vendor declared), so the two always agree; and the default legal basis for
 * records made from typed references.
 */
function FindAcquireWays({
  cfg,
  savedVendors,
  violations,
  unsaved,
  disabled,
  whyId,
  cancelled,
  onChange,
  onClearDefault,
}: {
  cfg: Config | null;
  /** The vendors of the saved rules (R314 e). */
  savedVendors: unknown;
  /** The service's violations of the saved rules (R314 a). */
  violations: Violation[];
  /** The form holds changes not yet saved: the service's verdict is about the saved rules only. */
  unsaved: boolean;
  disabled: boolean;
  whyId?: string;
  cancelled: number;
  onChange: (control: string, value: unknown, said?: ReactNode, write?: (text: string) => string) => void;
  onClearDefault: (path: string) => void;
}) {
  const id = useId();
  const listed = cfg?.acquireMethods ?? [];
  const on = new Set(listed);
  const toggle = (m: AcquireMethod, checked: boolean) => {
    if (!cfg) return;
    const next = ACQUIRE_METHODS.filter((x) => (x === m ? checked : on.has(x)));
    // Ways the rules file names that this version does not know are kept as written.
    const unknown = listed.filter((x) => !(ACQUIRE_METHODS as readonly string[]).includes(x));
    onChange("acquireMethods", [...next, ...unknown], `${checked ? "Allowing" : "Not allowing"} “${ACQUIRE_LABEL[m]}”`);
  };
  const lookups = cfg?.processing.metadata_lookup ?? [];
  const elicitOn = lookups.includes(ELICIT);
  const vendors = cfg ? getPath(cfg, "vendors") : undefined;
  const declared = vendorDeclared(vendors);
  const toggleElicit = (checked: boolean) => {
    if (!cfg) return;
    const next = checked ? [...lookups.filter((x) => x !== ELICIT), ELICIT] : lookups.filter((x) => x !== ELICIT);
    onChange("processing.metadata_lookup", next, `${checked ? "Allowing" : "Not allowing"} Elicit`, (t) => writeElicit(t, checked, lookups, savedVendors));
  };
  // The general note on GDPR and HIPAA is said only while the box is unticked: once ticked, the verdict below says it.
  const profileNotes = elicitOn ? [] : (cfg?.profiles ?? []).flatMap((p) => (ELICIT_PROFILE_NOTE[p] ? [ELICIT_PROFILE_NOTE[p]!] : []));
  const refusals = elicitRefusals(violations);
  const reasons = refusals.filter(Boolean).join(" ");
  const verdict: ReactNode = !elicitOn ? null : unsaved ? (
    "What this project's rules allow for Elicit is said here once the changes are saved."
  ) : refusals.length ? (
    reasons ? (
      <>
        <strong>Named, but NOT allowed:</strong> {reasons}
      </>
    ) : (
      // R316 a: no words for the profile (or none given): no reason is invented.
      <strong>Named, but NOT allowed by the rules in force.</strong>
    )
  ) : !on.has("reference_lookup") ? (
    // R316 b: Find and acquire does not ask Elicit where it may not look references up (the card's first box, above).
    "Named, but Find and acquire may not look references up in this project, so Elicit is not asked."
  ) : (
    "Allowed by this project's rules."
  );
  const basisPath = `consent.defaultLegalBasis.${FIND_LEGAL_CATEGORY}`;
  const basis = cfg?.consent.defaultLegalBasis?.[FIND_LEGAL_CATEGORY] ?? "";
  return (
    <>
      <fieldset className="ao-fieldset" aria-describedby={whyId}>
        <legend>Ways allowed in this project</legend>
        {ACQUIRE_METHODS.map((m) => (
          <label key={m} className="ao-choice">
            <input type="checkbox" disabled={disabled || !cfg} checked={on.has(m)} onChange={(e) => toggle(m, e.target.checked)} />
            {ACQUIRE_LABEL[m]}
          </label>
        ))}
      </fieldset>
      <p className="ao-hint">A file found for a record is never added without your confirmation.</p>
      <fieldset className="ao-fieldset" aria-describedby={whyId}>
        <legend>Search services that need this project's permission</legend>
        <label className="ao-choice">
          <input
            type="checkbox"
            disabled={disabled || !cfg}
            checked={elicitOn}
            aria-describedby={[verdict ? `${id}-elicit-verdict` : "", `${id}-elicit`, profileNotes.length ? `${id}-elicit-profiles` : "", elicitOn && !declared ? `${id}-elicit-undeclared` : ""].filter(Boolean).join(" ")}
            onChange={(e) => toggleElicit(e.target.checked)}
          />
          {ELICIT_LABEL}
        </label>
        {verdict ? (
          <p id={`${id}-elicit-verdict`} className={refusals.length && !unsaved ? "ao-warning" : "ao-hint"}>
            {verdict}
          </p>
        ) : null}
        <p id={`${id}-elicit`} className="ao-hint">
          The same setting as “elicit” in Metadata lookups under Processing location. Elicit is asked only when it is also switched on in Search sources and its key is saved there.
        </p>
        {elicitOn && !declared ? (
          <p id={`${id}-elicit-undeclared`} className="ao-warning">
            Elicit is named under Metadata lookups but not declared under vendors in governance.yaml, so these rules cannot be saved as they are. Untick the box and tick it again to declare it.
          </p>
        ) : null}
        {profileNotes.length ? (
          <ul id={`${id}-elicit-profiles`} className="ao-list">
            {profileNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </fieldset>
      <CommitInput
        reset={cancelled}
        label="Default legal basis for records made from typed references (recorded with each such record)"
        hint="For records made from references you type into Find and acquire. For example: Legitimate interest, GDPR Art. 6(1)(f). Setting or changing it loosens the rules, so it asks for a reason."
        disabled={disabled}
        value={basis}
        onCommit={(v) =>
          v
            ? onChange(
                basisPath,
                v,
                <>
                  Setting the default legal basis for records made from typed references to “<UserText>{v}</UserText>”
                </>,
              )
            : onClearDefault(basisPath)
        }
      />
    </>
  );
}

/** One line of text, committed when the field loses focus or on Enter (a loosening asks for a reason once, not per keystroke). */
function CommitInput({ label, hint, value, onCommit, disabled, reset }: { label: string; hint: string; value: string; onCommit: (v: string) => void; disabled?: boolean; reset: number }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  // `reset` (the count of cancelled reason dialogs): the draft goes back to the rules in place, not
  // by a remount, so focus stays on the field (R468).
  useEffect(() => setDraft(value), [value, reset]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value.trim()) onCommit(next);
  };
  return (
    <div className="ao-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        dir="auto"
        maxLength={2000}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <p id={`${id}-hint`} className="ao-hint">
        {hint}
      </p>
    </div>
  );
}

function CheckControl({ cfg, control, label, onChange, disabled }: { cfg: Config | null; control: string; label: string; onChange: (control: string, value: unknown) => void; disabled?: boolean }) {
  return (
    <div className="ao-field">
      <label className="ao-choice">
        <input type="checkbox" disabled={!cfg || disabled} checked={cfg ? getPath(cfg, control) === true : false} onChange={(e) => onChange(control, e.target.checked)} />
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

/**
 * A comma-separated list, committed when the field loses focus or on Enter. `reset` is the count of
 * cancelled reason dialogs: when it changes the draft goes back to the rules as they are, so a list
 * whose loosening was not recorded is not left showing it (FR-390). The field is not remounted for
 * this, so focus stays where it was (R468).
 */
function ListInput({ label, value, onCommit, disabled, reset }: { label: string; value: string[]; onCommit: (v: string[]) => void; disabled?: boolean; reset: number }) {
  const id = useId();
  const joined = value.join(", ");
  const [draft, setDraft] = useState(joined);
  useEffect(() => setDraft(joined), [joined, reset]);
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

/** `whyId`: the element saying why nothing may be changed now (a locked project, a read-only library): adding is then off. */
function ProtocolDocuments({ api, projectId, whyId }: { api: GovernanceApi; projectId: string; whyId?: string }) {
  const [docs, setDocs] = useState<ProtocolDocument[]>([]);
  const [results, setResults] = useState<ProtocolDocumentResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.protocolDocuments(projectId).then((r) => setDocs(r.documents), () => setError("The approval documents could not be listed."));
  }, [api, projectId]);
  const add = async (paths: string[]) => {
    if (whyId) return;
    try {
      const r = await api.addProtocolDocuments(projectId, paths);
      setDocs(r.documents);
      setResults(r.results);
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
      <FileDrop prompt="Drop approval documents here (PDF, Word, OpenDocument, plain text or images, up to 100 MB each; kept in the project's protocol folder)." fieldLabel="Or add a document by its full path" disabled={!!whyId} onPaths={(p) => void add(p)} />
      {results ? (
        <ul className="ao-list" aria-label="Results of the last drop">
          {results.map((r, i) => (
            <li key={i} className={r.outcome === "failed" ? "ao-deny" : undefined}>
              <UserText>{r.file}</UserText>
              {r.outcome === "added" ? ": added" : `: not added — ${r.reason ?? ""}`}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** `whyId`: as for ProtocolDocuments; the time zone and destruction are then shown but off. */
function Retention({ api, projectId, whyId }: { api: GovernanceApi; projectId: string; whyId?: string }) {
  const [due, setDue] = useState<RetentionDue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cert, setCert] = useState<{ certificate: DestructionCertificate; certificateFile: string } | null>(null);
  const certId = useId();
  const tzId = useId();
  // The project's time zone (R93): the retention date is read in it; null is UTC.
  const [zone, setZone] = useState<{ saved: string | null; input: string } | null>(null);
  const [tzBusy, setTzBusy] = useState(false);
  const [tzSaved, setTzSaved] = useState(false);
  const [tzError, setTzError] = useState<string | null>(null);
  const tzSending = useRef(false);
  const current = useRef({ projectId, live: true });
  current.current.projectId = projectId;
  useEffect(() => {
    current.current.live = true;
    return () => {
      current.current.live = false;
    };
  }, []);
  const load = useCallback(() => {
    api.retention(projectId).then(
      (r) => {
        if (!current.current.live || current.current.projectId !== projectId) return;
        setDue(r);
        setZone({ saved: r.timeZone ?? null, input: r.timeZone ?? "" });
      },
      (err: unknown) => setError(err instanceof Error ? err.message : "What is due could not be listed."),
    );
  }, [api, projectId]);
  const saveZone = async () => {
    if (!zone || tzSending.current || whyId) return; // one request per click, however fast the clicks; none while nothing may change
    tzSending.current = true;
    const pid = projectId;
    const wanted = zone.input.trim() || null;
    setTzBusy(true);
    setTzSaved(false);
    setTzError(null);
    try {
      const r = await api.setTimeZone(pid, wanted);
      if (!current.current.live || current.current.projectId !== pid) return; // a stale answer
      setZone({ saved: r.timeZone, input: r.timeZone ?? "" });
      setTzSaved(true);
      load();
    } catch (err) {
      if (!current.current.live || current.current.projectId !== pid) return;
      setTzError(err instanceof Error ? err.message : "The time zone could not be saved.");
    } finally {
      tzSending.current = false;
      if (current.current.live) setTzBusy(false);
    }
  };
  useEffect(load, [load]);
  const assetIds = due?.due.flatMap((d) => d.assetIds) ?? [];
  const destroy = async () => {
    if (whyId) return;
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
      {zone ? (
        <div className="ao-field">
          <label htmlFor={`${tzId}-tz`}>The project's time zone (protocol and retention dates)</label>
          <input
            id={`${tzId}-tz`}
            type="text"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            disabled={!!whyId}
            aria-describedby={[`${tzId}-tz-hint`, tzError ? `${tzId}-tz-error` : "", whyId ?? ""].filter(Boolean).join(" ")}
            {...(tzError ? { "aria-invalid": true } : {})}
            value={zone.input}
            onChange={(e) => {
              const input = e.target.value;
              setZone((z) => (z ? { ...z, input } : z));
              setTzSaved(false);
              setTzError(null);
            }}
          />
          <p id={`${tzId}-tz-hint`} className="ao-hint">
            A time zone name such as Europe/Berlin or America/New_York. When set, the protocol's dates and the retention date are both read in it. Empty: protocol dates follow this computer's
            time zone, and the retention date is read in UTC. Changing the time zone moves the moment the retention date takes effect, by up to a day either way.
          </p>
          <button type="button" disabled={tzBusy || !!whyId} aria-describedby={whyId} onClick={() => void saveZone()}>
            Save time zone
          </button>
          <p role="status" className="ao-hint">
            {tzSaved ? "Saved. " : ""}
            {zone.saved ? (
              <>
                The project's dates are read in <UserText>{zone.saved}</UserText>.
              </>
            ) : (
              "No time zone is set: protocol dates in this computer's time zone, the retention date in UTC."
            )}
          </p>
          {tzError ? (
            <p role="alert" id={`${tzId}-tz-error`} className="ao-warning">
              {tzError}
            </p>
          ) : null}
        </div>
      ) : null}
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
      <button type="button" className="ao-danger" disabled={!assetIds.length || !!whyId} aria-describedby={whyId} onClick={() => setConfirming(true)}>
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
