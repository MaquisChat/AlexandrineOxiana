/**
 * Bulk Import wizard (spec 5.4, Task 35): Source → Scan → Identify → Review → Options → Run →
 * Report and undo. Identify has no screen of its own: it runs as part of the scan and the run.
 *
 * Everything goes through the library service's import routes (api/import.ts); the project's
 * governance sets the defaults (R24: no link in place when files must be encrypted; R64: folder
 * structure ignored by default where names are pseudonymised). Files outside the source's folders
 * are approved on the Scan step and the approvals go with the start request (R67).
 *
 * An import's report stays reachable (D1): once an import starts, the wizard's address names it
 * (`/import?project=<id>&batch=<id>`, replacing the current history entry), and the wizard opened
 * on such an address shows that import (its run while it runs, else its report and undo), read
 * from the service (GET /projects/:id/imports, /imports/:id/report), never from memory. The Source
 * step lists the project's recent imports, each linking to its report.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { STREAM_OPEN_TIMEOUT_MS, type ApiClient, type ApiClientError } from "../../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, oneNoAnswerSentence, readWithin } from "../../api/firstRead";
import { IMPORT_RULES_UNREADABLE_TEXT } from "@ao/shared";
import { importApi, isValidId, type BatchState, type BatchSummary, type ImportPolicy, type ProjectInfo, type ScanSummary } from "../../api/import";
import { UserText } from "../../components/UserText";
import { inAppLink, navigate } from "../../navigation";
import { batchStateText, ErrorNote, errorText, fmt, reportHref, Section } from "./shared";
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
  /** An import of `projectId` to open (from the address): its run, or its report and undo (D1). */
  batchId?: string;
  /** FR-756: how long each first read (the import, the projects, the rules, the run's state on arrival) is waited for. */
  firstReadMs?: number;
  /** FR-756 (R597): how long the run step's event stream is waited for to open before it is closed and tried afresh. */
  streamOpenMs?: number;
}

/** FR-756: a read that got no answer (none in time, or the service could not be reached) says only its own sentence. */
const noAnswerText = (e: unknown) => (e as ApiClientError).message;

/** Batch states the run screen follows; any other state is shown as the report. */
const LIVE: ReadonlySet<BatchState> = new Set(["running", "paused", "interrupted"]);

/** How many of the project's imports the Source step lists. */
export const RECENT_IMPORTS = 5;

/** What was scanned: the start request uses exactly this (R115 I2). */
interface Scanned {
  projectId: string;
  choice: SourceChoice;
  summary: ScanSummary;
}

export function ImportWizard({ client, projectId: initialProject, batchId: initialBatch, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS }: ImportWizardProps) {
  const api = useMemo(() => importApi(client), [client]);
  /** The import named by the address, when both ids are valid: it is read before anything is shown. */
  const [opening, setOpening] = useState(() => isValidId(initialProject) && isValidId(initialBatch));
  const [step, setStep] = useState<Step>("source");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectIdState] = useState(isValidId(initialProject) ? initialProject : "");
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  /** The service cannot read the project's rules: every import is refused (R379 FR-A18). */
  const [rulesUnreadable, setRulesUnreadable] = useState(false);
  const [choice, setChoice] = useState<SourceChoice>({ kind: "folder", path: "" });
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [approvals, setApprovals] = useState<OutsideApprovals>(NO_APPROVALS);
  const [options, setOptions] = useState<WizardOptions | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  /** The project of the import being run or reported (the scanned one, or the one in the address). */
  const [runProject, setRunProject] = useState<string>("");
  const [recent, setRecent] = useState<BatchSummary[] | null>(null);
  /** The import was opened from the address: its step's heading takes focus when shown (R145). */
  const [arrived, setArrived] = useState(false);
  /** Set when a run ends here: whether the report's heading takes focus (FR-363). */
  const [reportFocus, setReportFocus] = useState<boolean | undefined>(undefined);
  const wizard = useRef<HTMLElement>(null);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * FR-756: the reads that got no answer and that "Try again" makes again (the import in the address, the projects),
   * each with the error's own sentence. Shown as ONE sentence (R602 M1: "could not be reached" wins).
   */
  const [unanswered, setUnanswered] = useState<{ open?: string; projects?: string }>({});
  const [projectsTry, setProjectsTry] = useState(0);

  /** Any edit after a scan makes it stale: the scan and its approvals are dropped. */
  const invalidate = () => {
    setScanned(null);
    setApprovals(NO_APPROVALS);
  };
  const setProjectId = (id: string) => {
    setProjectIdState(id);
    invalidate();
  };
  const editChoice = (c: SourceChoice) => {
    setChoice(c);
    invalidate();
  };

  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    readWithin((signal) => api.projects({ signal }), firstReadMs, ac.signal)
      .then((list) => {
        if (!live) return;
        // R602 (a): an answered read takes away its earlier give-up sentence.
        setUnanswered(({ projects: _p, ...u }) => u);
        setProjects(list);
        setProjectIdState((cur) => (cur && list.some((p) => p.id === cur) ? cur : (list.find((p) => p.unlocked !== false && isValidId(p.id))?.id ?? "")));
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (isUnreachable(e)) setUnanswered((u) => ({ ...u, projects: noAnswerText(e) }));
        else {
          setUnanswered(({ projects: _p, ...u }) => u);
          setError(errorText(e));
        }
      });
    return () => {
      live = false;
      ac.abort();
    };
  }, [api, firstReadMs, projectsTry]);

  // The import named in the address (D1): its run while it runs, else its report.
  useEffect(() => {
    if (!opening || !isValidId(initialProject) || !isValidId(initialBatch)) return;
    let live = true;
    const ac = new AbortController();
    readWithin((signal) => api.batches(initialProject, { signal }), firstReadMs, ac.signal)
      .then((list) => {
        if (!live) return;
        const b = list.find((x) => x.batchId === initialBatch);
        if (!b) {
          setError("This import was not found in this project; it may have been removed. You can start a new import here.");
        } else {
          setRunProject(initialProject);
          setBatchId(b.batchId);
          setArrived(true);
          setStep(LIVE.has(b.state) ? "run" : "report");
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (isUnreachable(e)) setUnanswered((u) => ({ ...u, open: noAnswerText(e) }));
        else setError(`The import could not be read. ${errorText(e)}`);
      })
      .finally(() => live && setOpening(false));
    return () => {
      live = false;
      ac.abort();
    };
  }, [api, opening, initialProject, initialBatch, firstReadMs]);

  /** FR-756: "Try again" makes again what got no answer: the import in the address ("Opening the import…"), the projects. */
  const readAgain = () => {
    // The button goes while the reads are made again: focus waits on the wizard's heading, never the page.
    document.getElementById("ao-import-title")?.focus();
    if (unanswered.open) setOpening(true);
    if (unanswered.projects) setProjectsTry((n) => n + 1);
    setUnanswered({});
  };

  // The project's recent imports, listed on the Source step, each linking to its report (D1).
  useEffect(() => {
    setRecent(null);
    if (step !== "source" || opening || !isValidId(projectId)) return;
    let live = true;
    api
      .batches(projectId)
      .then((list) => live && setRecent([...list].sort((a, b) => b.number - a.number).slice(0, RECENT_IMPORTS)))
      .catch(() => live && setRecent([])); // a read-only or locked library: nothing is listed
    return () => {
      live = false;
    };
  }, [api, step, opening, projectId]);

  useEffect(() => {
    if (!isValidId(projectId)) return;
    let live = true;
    setPolicy(null);
    setRulesUnreadable(false);
    setOptions(null); // defaults follow the project's rules
    const ac = new AbortController();
    // FR-756: given up after `firstReadMs` as a read that failed: the rules are then taken strictly, as before.
    readWithin((signal) => api.policy(projectId, { signal }), firstReadMs, ac.signal)
      .then((p) => {
        if (!live) return;
        setPolicy(p);
        setRulesUnreadable(!p.readable);
      })
      .catch(() => live && setPolicy(STRICT));
    return () => {
      live = false;
      ac.abort();
    };
  }, [api, projectId, firstReadMs]);

  const effectivePolicy = policy ?? STRICT;
  const opts = options ?? defaultOptions(effectivePolicy);

  const scan = async () => {
    setBusy(true);
    setError(null);
    const snapshot = { projectId, choice };
    try {
      const summary = await api.dryRun(snapshot.projectId, adapterOf(snapshot.choice));
      setScanned({ ...snapshot, summary });
      setApprovals(NO_APPROVALS);
      setStep("scan");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!scanned) return;
    setBusy(true);
    setError(null);
    const approveOutside = approveOutsideOf(approvals);
    const c = scanned.choice;
    // "Copy into the library" copies linked files (Zotero's) unless kept as links by choice (R136),
    // even ones the scan did not see (M2). A device import has no linked files.
    const copyLinked = c.kind !== "device" && opts.fileHandling === "copy";
    const o = { ...opts, ...(copyLinked ? { linkedFiles: opts.linkedFiles ?? "copy" } : {}), ...(approveOutside ? { approveOutside } : {}) };
    try {
      const r =
        c.kind === "device"
          ? await api.deviceImport(scanned.projectId, {
              dir: c.dir,
              ...(c.sessionId ? { sessionId: c.sessionId } : {}),
              ...(c.participantIds.length ? { participantIds: c.participantIds } : {}),
              options: { ...o, ...(c.researcherName.trim() ? { researcherName: c.researcherName.trim() } : {}) },
            })
          : await api.start(scanned.projectId, adapterOf(c), o);
      setRunProject(scanned.projectId);
      setBatchId(r.batchId);
      setStep("run");
      // The address names the import, so Back from the review queue (or anywhere) returns to it (D1).
      if (isValidId(scanned.projectId) && isValidId(r.batchId)) navigate(reportHref(scanned.projectId, r.batchId), { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ended = (_state: BatchState, err?: string) => {
    // The report's heading takes focus only if focus was in the wizard (or nowhere): a researcher
    // who moved elsewhere on the page while the run went on keeps their place (FR-363).
    const a = document.activeElement;
    setReportFocus(!a || a === document.body || !!wizard.current?.contains(a));
    setRunError(err);
    setStep("report");
  };

  /** R602 M1: one sentence for the reads that got no answer. */
  const noAnswer = oneNoAnswerSentence([unanswered.open, unanswered.projects]);
  const current = STEPS.findIndex((s) => s.step === step);
  const project = projects.find((p) => p.id === (runProject || projectId));

  return (
    <main ref={wizard} className="ao-import" aria-labelledby="ao-import-title">
      <h1 id="ao-import-title" tabIndex={-1}>
        Bulk import
      </h1>
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

      {opening && <p role="status">Opening the import…</p>}
      {!opening && noAnswer !== undefined && <ErrorNote error={unanswered.open ? `The import could not be read. ${noAnswer}` : noAnswer} />}
      {!opening && noAnswer !== undefined && (
        <p>
          <button type="button" onClick={readAgain}>
            Try again
          </button>
        </p>
      )}
      {/* Rules the engine cannot read: every import is refused; say why on the first step (R379 FR-A18). */}
      {!opening && step === "source" && rulesUnreadable && isValidId(projectId) && <ErrorNote error={IMPORT_RULES_UNREADABLE_TEXT} />}
      {!opening && step === "source" && (
        <StepSource
          api={api}
          projects={projects}
          projectId={projectId}
          onProject={setProjectId}
          choice={choice}
          onChoice={editChoice}
          busy={busy}
          error={error}
          onScan={() => void scan()}
          {...(scanned ? { onNext: () => setStep("scan") } : {})}
        />
      )}
      {!opening && step === "source" && recent && recent.length > 0 && isValidId(projectId) && <RecentImports projectId={projectId} batches={recent} />}
      {step === "scan" && scanned && (
        <>
          <StepScan summary={scanned.summary} sourceName={describeChoice(scanned.choice)} approvals={approvals} onApprovals={setApprovals} device={scanned.choice.kind === "device"} />
          <Nav onBack={() => setStep("source")} onNext={() => setStep("review")} />
        </>
      )}
      {step === "review" && (
        <>
          <StepReview policy={effectivePolicy} likelyDuplicates={scanned?.summary.likelyDuplicates ?? 0} />
          <Nav onBack={() => setStep("scan")} onNext={() => setStep("options")} />
        </>
      )}
      {step === "options" && (
        <>
          <StepOptions options={opts} onOptions={setOptions} policy={effectivePolicy} linkedAttachments={scanned?.summary.linkedFiles ?? 0} />
          <ErrorNote error={error} />
          <div className="ao-import__actions">
            <button type="button" onClick={() => setStep("review")} disabled={busy}>
              Back
            </button>
            <button type="button" className="ao-import__primary" onClick={() => void start()} disabled={busy || policy === null || !scanned}>
              Start import
            </button>
          </div>
        </>
      )}
      {step === "run" && batchId && runProject && <StepRun client={client} api={api} projectId={runProject} batchId={batchId} onEnded={ended} focusOnArrival={arrived} firstReadMs={firstReadMs} streamOpenMs={streamOpenMs} />}
      {step === "report" && batchId && runProject && <StepReport api={api} projectId={runProject} batchId={batchId} focusOnArrival={reportFocus ?? arrived} {...(runError ? { error: runError } : {})} />}
    </main>
  );
}

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** The project's latest imports, newest first, each a link to its report and undo (D1). */
function RecentImports({ projectId, batches }: { projectId: string; batches: BatchSummary[] }) {
  return (
    <Section title="Recent imports">
      <ul>
        {batches.filter((b) => isValidId(b.batchId)).map((b) => (
          <li key={b.batchId}>
            <a href={reportHref(projectId, b.batchId)} onClick={inAppLink}>
              Import {fmt(b.number)} — <UserText>{b.kind}</UserText>
              {Number.isNaN(Date.parse(b.startedAt)) ? "" : `, ${DATE.format(new Date(b.startedAt))}`} ({batchStateText(b.state)})
            </a>
          </li>
        ))}
      </ul>
    </Section>
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
