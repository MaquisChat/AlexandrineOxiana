/**
 * Bulk Import wizard (spec 5.4, Task 35): Source → Scan → Identify → Review → Options → Run →
 * Report and undo. Identify has no screen of its own: it runs as part of the scan and the run.
 *
 * Everything goes through the library service's import routes (api/import.ts); the project's
 * governance sets the defaults (R24: no link in place when files must be encrypted; R64: folder
 * structure ignored by default where names are pseudonymised). Files outside the source's folders
 * are approved on the Scan step and the approvals go with the start request (R67).
 */
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client";
import { importApi, type BatchState, type ImportPolicy, type ProjectInfo, type ScanSummary } from "../../api/import";
import { UserText } from "../../components/UserText";
import { ErrorNote, errorText } from "./shared";
import { StepOptions, defaultOptions, type WizardOptions } from "./StepOptions";
import { StepReport } from "./StepReport";
import { StepReview } from "./StepReview";
import { StepRun } from "./StepRun";
import { NO_APPROVALS, StepScan, approveOutsideOf, type OutsideApprovals } from "./StepScan";
import { StepSource, adapterOf, type SourceChoice } from "./StepSource";
import "./import.css";

type Step = "source" | "scan" | "identify" | "review" | "options" | "run" | "report";

const STEPS: Array<{ step: Step; label: string; note?: string }> = [
  { step: "source", label: "Source" },
  { step: "scan", label: "Scan" },
  { step: "identify", label: "Identify", note: "runs during Scan and Run" },
  { step: "review", label: "Review" },
  { step: "options", label: "Options" },
  { step: "run", label: "Run" },
  { step: "report", label: "Report and undo" },
];

const STRICT: ImportPolicy = { pseudonymizeNames: true, encryptionRequired: true };

function describeChoice(c: SourceChoice): string {
  switch (c.kind) {
    case "zotero-web":
      return `Zotero ${c.libraryType === "group" ? "group" : "personal"} library ${c.libraryId}`;
    case "zotero-local":
      return c.dataDir;
    case "device":
      return c.dir;
    default:
      return c.path;
  }
}

export interface ImportWizardProps {
  client: ApiClient;
  /** The project to preselect. */
  projectId?: string;
}

export function ImportWizard({ client, projectId: initialProject }: ImportWizardProps) {
  const api = useMemo(() => importApi(client), [client]);
  const [step, setStep] = useState<Step>("source");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState(initialProject ?? "");
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  const [choice, setChoice] = useState<SourceChoice>({ kind: "folder", path: "" });
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [approvals, setApprovals] = useState<OutsideApprovals>(NO_APPROVALS);
  const [options, setOptions] = useState<WizardOptions | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [api]);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setPolicy(null);
    setOptions(null); // defaults follow the project's rules
    api
      .policy(projectId)
      .then((p) => live && setPolicy(p))
      .catch(() => live && setPolicy(STRICT));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  const effectivePolicy = policy ?? STRICT;
  const opts = options ?? defaultOptions(effectivePolicy);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      setSummary(await api.dryRun(projectId, adapterOf(choice)));
      setApprovals(NO_APPROVALS);
      setStep("scan");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    const approveOutside = approveOutsideOf(approvals);
    const o = { ...opts, ...(approveOutside ? { approveOutside } : {}) };
    try {
      const r =
        choice.kind === "device"
          ? await api.deviceImport(projectId, {
              dir: choice.dir,
              ...(choice.sessionId ? { sessionId: choice.sessionId } : {}),
              ...(choice.participantIds.length ? { participantIds: choice.participantIds } : {}),
              options: o,
            })
          : await api.start(projectId, adapterOf(choice), o);
      setBatchId(r.batchId);
      setStep("run");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ended = (_state: BatchState, err?: string) => {
    setRunError(err);
    setStep("report");
  };

  const current = STEPS.findIndex((s) => s.step === step);
  const project = projects.find((p) => p.id === projectId);

  return (
    <main className="ao-import" aria-labelledby="ao-import-title">
      <h1 id="ao-import-title">Bulk import</h1>
      {project && step !== "source" && (
        <p className="ao-import__hint">
          Into <UserText>{project.name}</UserText>
        </p>
      )}
      <ol className="ao-import__steps" aria-label="Import steps">
        {STEPS.map((s, i) => (
          <li
            key={s.step}
            className={i === current ? "ao-import__step ao-import__step--current" : i < current ? "ao-import__step ao-import__step--done" : "ao-import__step"}
            {...(i === current ? { "aria-current": "step" as const } : {})}
          >
            {s.note ? `${s.label} — ${s.note}` : s.label}
          </li>
        ))}
      </ol>

      {step === "source" && (
        <StepSource
          api={api}
          projects={projects}
          projectId={projectId}
          onProject={setProjectId}
          choice={choice}
          onChoice={setChoice}
          busy={busy}
          error={error}
          onScan={() => void scan()}
        />
      )}
      {step === "scan" && summary && (
        <>
          <StepScan summary={summary} sourceName={describeChoice(choice)} approvals={approvals} onApprovals={setApprovals} />
          <Nav onBack={() => setStep("source")} onNext={() => setStep("review")} />
        </>
      )}
      {step === "review" && (
        <>
          <StepReview policy={effectivePolicy} likelyDuplicates={summary?.likelyDuplicates ?? 0} />
          <Nav onBack={() => setStep("scan")} onNext={() => setStep("options")} />
        </>
      )}
      {step === "options" && (
        <>
          <StepOptions options={opts} onOptions={setOptions} policy={effectivePolicy} />
          <ErrorNote error={error} />
          <div className="ao-import__actions">
            <button type="button" onClick={() => setStep("review")} disabled={busy}>
              Back
            </button>
            <button type="button" className="ao-import__primary" onClick={() => void start()} disabled={busy || policy === null}>
              Start import
            </button>
          </div>
        </>
      )}
      {step === "run" && batchId && <StepRun client={client} api={api} projectId={projectId} batchId={batchId} onEnded={ended} />}
      {step === "report" && batchId && <StepReport api={api} projectId={projectId} batchId={batchId} {...(runError ? { error: runError } : {})} />}
    </main>
  );
}

function Nav({ onBack, onNext }: { onBack(): void; onNext(): void }) {
  return (
    <div className="ao-import__actions">
      <button type="button" onClick={onBack}>
        Back
      </button>
      <button type="button" className="ao-import__primary" onClick={onNext}>
        Next
      </button>
    </div>
  );
}
