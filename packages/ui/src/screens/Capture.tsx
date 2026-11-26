/**
 * The capture screen (Task 34b, spec 5.1, 5.5): paste links (one per line) with a per-line preview
 * of platform and kind; the options (my browser session with a browser picker, transcription with a
 * model, refresh existing); the profile form (dates, maximum items with the R43 notice, content
 * types, metadata only, comments off by default and explained); the legal basis where the project's
 * rules require one (R41); the one-time browser-session acknowledgement (shown once per project,
 * with the library's exact text); the queue (CaptureQueue) filled from `capture.progress` events; and
 * "Update capture tools" with old → new versions.
 *
 * The queue is read again from the service (Task 63) on opening and after every reconnect, and a
 * capture the screen does not know is read when its first event arrives, so captures started
 * earlier or from the browser extension are shown, and outcomes missed while the connection was
 * down are replaced by the truth.
 *
 * A profile, channel or playlist is not captured at once (whole channels, Task 8): "Capture profile" asks the
 * service for an estimate (the platform is asked only for the list) and shows it in place of the form's buttons
 * (CaptureEstimate), with the quality and the Transcribe box; "Start" captures it. The box starts from the
 * Transcription choice, where "Use the project's setting" is the project's automation switch (read beside the estimate;
 * untouched, Start leaves transcription out and the service applies the switch, R683 C). The estimate belongs to the
 * form as it was when "Capture profile" was pressed: any change closes it (R683 B).
 *
 * Stale answers are dropped: the screen is keyed by its project, every answer and event is checked
 * against `live` (unmount), a read is used only if the connection it was asked on is still the
 * current one (and only the latest read), and events of other projects are never applied. A capture
 * is started once however often its button is pressed (a synchronous guard, then the button is
 * disabled).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_TEXT,
  CAPTURE_RULES_UNREADABLE_TEXT,
  CAPTURE_RUNNING,
  CAPTURE_STOPPING,
  estimateText,
  type CaptureEstimate as Estimate,
  type CapturePlatform,
  type DownloadQuality,
} from "@ao/shared";
import { ApiClientError, STREAM_OPEN_TIMEOUT_MS, STREAM_QUIET_TIMEOUT_MS, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, oneNoAnswerSentence, readWithin } from "../api/firstRead";
import {
  applyProgress,
  BROWSERS,
  captureApi,
  captureProgress,
  CONTENT_TYPES,
  COOKIES_ACKNOWLEDGEMENT,
  isWebAddress,
  KNOWN_OUTCOME_CODES,
  linkQueue,
  markGap,
  MAX_LINKS,
  mergeRead,
  MODELS,
  outcomeText,
  parseLinks,
  previewLink,
  profileQueue,
  queueFromDetail,
  type BrowserName,
  type CaptureOptions,
  type CapturePolicy,
  type CaptureProgress,
  type CaptureProject,
  type CaptureQueueState,
  type ProfileCaptureOptions,
  type ProfileContentType,
  type ToolsUpdate,
} from "../api/capture";
import { isValidId } from "../api/import";
import { errorText } from "../api/library";
import { CaptureEstimate, initialQuality } from "../components/CaptureEstimate";
import { CaptureQueue } from "../components/CaptureQueue";
import { useEventFeed, WorkLines } from "../components/WorkLines";
import { PageReads, usePageHost, usePageRead } from "../components/PageReads";
import { MissingToolNotice, modelOptionLabel, SpeechModelNotice, ToolsLink, useSpeechModels } from "../components/MissingToolNotice";
import { DEFAULT_SPEECH_MODEL, toolsApi } from "../api/tools";
import { useTrap } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import { inAppLink, libraryHref, navigate, normalisePath, type AppLocation } from "../navigation";
import "./Capture.css";

/** Reconnects after the event stream ends (then a message and a manual reconnect). */
const RECONNECTS = 2;
const RECONNECT_DELAY_MS = 300;
/** Events kept for queues whose id is not known yet (their start's answer is still on its way). */
const EARLY_EVENTS = 500;
/** Lines previewed one by one. */
const PREVIEW_LINES = 100;

/** A link carrying a user name or password (it would be shown, queued and sent as it is). */
function hasCredentials(u: string): boolean {
  try {
    const p = new URL(u.trim());
    return p.username !== "" || p.password !== "";
  } catch {
    return false;
  }
}

/**
 * A failed request in plain words for a researcher (review M2/N3). The service's `reason` is shown
 * only where it is meant for people (a project rule's own reason, POLICY_DENIED); elsewhere it is
 * internal (a read-only reason word, the media helper's start-up text, which can name shell commands
 * or paths) and is left out. A media helper that is not running gets one sentence of what to do.
 */
/** What a lock cut from this project's capture queues: only the count is known (R464 b), the link in flight at the lock included (R480 c). */
const cutByLockText = (n: number): string =>
  n === 1
    ? "A lock stopped 1 link in this project from being captured. The link was not kept while the project was locked: add it again to capture it."
    : `A lock stopped ${n} links in this project from being captured. The links were not kept while the project was locked: add them again to capture them.`;

function plainError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiClientError)) return fallback;
  if (err.code === "WORKER_UNAVAILABLE") return `${fallback} The media helper is not running. Restart the app and try again.`;
  // The same link (or profile) is still being captured: the service's own sentence, and where to look.
  if (err.code === "CONFLICT" && err.reason === CAPTURE_RUNNING) return `${err.message} The running capture is shown in the capture queue below.`;
  // An ended capture still finishing its download (a lock): the service's own sentence, as it is.
  if (err.code === "CONFLICT" && err.reason === CAPTURE_STOPPING) return err.message;
  if (err.code === "POLICY_DENIED") return errorText(err, fallback);
  return errorText(new ApiClientError(err.status, { code: err.code, message: err.message }), fallback);
}

/** The profile field's hint: the preview's guess, never a verdict. */
function profileHint(url: string): string {
  const p = previewLink(url);
  if (p.problem === "not-a-web-address") return p.label;
  if (p.collection) return p.label;
  if (p.kind !== "unknown" && p.platform !== "other") return `${p.label}: this looks like a single post, not a profile, channel or playlist — the app will check it.`;
  return "Not recognised here as a profile, channel or playlist — the app will check it.";
}

type Transcribe = "project" | "yes" | "no";

/** The platforms whose list the estimate can name ("Asking YouTube for the list of videos…"). */
const LISTED: readonly string[] = ["youtube", "instagram", "tiktok"] satisfies CapturePlatform[];

/** An estimate on show: what it was asked for (sent again at Start), and the researcher's choices in it. */
interface ShownEstimate {
  estimate: Estimate;
  url: string;
  options: ProfileCaptureOptions;
  /** The profile form it was asked for (R683 B). */
  form: string;
}

const LEGAL_MISSING = "Enter the legal basis for this capture. This project's rules need one for social-media data that can identify people, and they give no default.";
const COMMENTS_LEGAL_MISSING = "Enter the legal basis for this capture. Comments are other people's personal data, so saving them always needs one.";

// ---------------------------------------------------------------------------------------------
// The acknowledgement dialog (inert background, focus trapped and restored, Escape and Cancel)

function AckDialog({ busy, error, onConfirm, onCancel }: { busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  // What had focus before the dialog, read while rendering: before the background is made inert,
  // which in a browser can move focus to <body> before useTrap's passive effect reads it (review M9).
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  // First focus on the heading (R376 c): a held or repeated key on the opener must not acknowledge.
  const heading = useRef<HTMLHeadingElement>(null);
  const { ref, onKeyDown } = useTrap(onCancel, busy, heading);
  // Declared after useTrap: its cleanup runs after useTrap's, so this restore is the one that stays.
  useEffect(() => () => before?.focus?.(), [before]);
  const [host] = useState(() => document.createElement("div"));
  // Attached before useTrap's effect moves focus into the dialog (layout effects run first).
  useLayoutEffect(() => {
    document.body.appendChild(host);
    const others = [...document.body.children].filter((el) => el !== host && !el.hasAttribute("inert"));
    for (const el of others) el.setAttribute("inert", "");
    return () => {
      for (const el of others) el.removeAttribute("inert");
      host.remove();
    };
  }, [host]);
  return createPortal(
    <div className="ao-capture-dialog-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} aria-busy={busy || undefined} className="ao-capture-dialog" onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`} ref={heading} tabIndex={-1}>
          Use your browser session?
        </h2>
        <p id={`${id}-d`}>{COOKIES_ACKNOWLEDGEMENT}</p>
        <p>You are asked this once for this project.</p>
        {error && (
          <p className="ao-capture__error" role="alert">
            {error}
          </p>
        )}
        <div className="ao-capture__actions">
          <button type="button" className="ao-capture__primary" onClick={onConfirm} disabled={busy}>
            I understand, use my browser session
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}

// ---------------------------------------------------------------------------------------------
// Capture tools

const TOOL_LABELS: Array<{ keys: string[]; label: string; missing: string }> = [
  { keys: ["yt_dlp", "yt-dlp"], label: "yt-dlp (video downloader)", missing: "Not installed. Install it from the Optional tools screen." },
  { keys: ["gallery_dl", "gallery-dl"], label: "gallery-dl (image downloader)", missing: "Not installed. Install it from the Optional tools screen." },
  { keys: ["ffmpeg"], label: "ffmpeg (video conversion)", missing: "Not installed on this computer." },
  { keys: ["faster_whisper", "faster-whisper"], label: "faster-whisper (transcription)", missing: "Not installed on this computer." },
];

/**
 * Plain words for a failed tools call. A failed update is 502 TOOL_FAILED with the helper's code in
 * `reason` (for example TOOL_UPDATE_FAILED), which is explained, never shown; any other failure is
 * `lead` plus the service's message. The reason of a 503 (the helper's start-up message, which can
 * name commands or paths) is never shown.
 */
function toolsErrorText(err: unknown, lead: string): string {
  if (!(err instanceof ApiClientError)) return lead;
  if (err.reason && /^[A-Z][A-Z0-9_]+$/.test(err.reason)) return KNOWN_OUTCOME_CODES.includes(err.reason) ? outcomeText(err.reason) : lead;
  if (err.code === "WORKER_UNAVAILABLE") return `${lead} The media helper is not running. Restart the app and try again.`;
  return err.message && err.message !== lead ? `${lead} ${err.message}` : lead;
}

function updateLines(u: ToolsUpdate): string[] {
  const out: string[] = [];
  const { old, new: now, managed } = u.ytDlp;
  if (!managed) out.push(`yt-dlp${now ?? old ? ` ${now ?? old}` : ""} is this computer's own installation, so the app did not change it.`);
  else if (old === null && now) out.push(`yt-dlp was installed: ${now}.`);
  else if (old && now && old === now) out.push(`yt-dlp is up to date (${now}).`);
  else out.push(`yt-dlp: ${old ?? "not installed"} → ${now ?? "not installed"}`);
  if (u.galleryDl.version) out.push(`gallery-dl ${u.galleryDl.version} is the image downloader; it is installed and updated from the Optional tools screen.`);
  return out;
}

function CaptureTools({ api }: { api: ReturnType<typeof captureApi> }) {
  const id = useId();
  const live = useRef(true);
  const [versions, setVersions] = useState<Record<string, string | null> | undefined>();
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [result, setResult] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    live.current = true;
    api.toolVersions().then(
      (v) => live.current && setVersions(v),
      (err: unknown) => live.current && setVersionsError(toolsErrorText(err, "The tools' versions could not be read.")),
    );
    return () => {
      live.current = false;
    };
  }, [api]);

  const update = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const u = await api.updateTools();
      if (!live.current) return;
      setResult(updateLines(u));
      setVersions((v) => ({ ...(v ?? {}), yt_dlp: u.ytDlp.new, ...(u.galleryDl.version ? { gallery_dl: u.galleryDl.version } : {}) }));
    } catch (err) {
      if (live.current) setError(toolsErrorText(err, "The capture tools could not be updated."));
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };

  const rows = versions ? TOOL_LABELS.map((t) => ({ t, key: t.keys.find((k) => Object.hasOwn(versions, k)) })).filter((r) => r.key !== undefined) : [];
  return (
    <section className="ao-capture__section" aria-labelledby={id}>
      <h2 id={id}>Capture tools</h2>
      <p>The downloaders change often as platforms change. Updating them can fix links that stopped working.</p>
      <p>Install or remove the downloaders on the <ToolsLink>Optional tools screen</ToolsLink>.</p>
      {versionsError && (
        <UserText as="p" className="ao-capture__note">
          {versionsError}
        </UserText>
      )}
      {rows.length > 0 && (
        <dl className="ao-capture__tools">
          {rows.map(({ t, key }) => {
            const v = versions![key!];
            return (
              <div key={t.label}>
                <dt>{t.label}</dt>
                <dd>{v ? <UserText>{v}</UserText> : t.missing}</dd>
              </div>
            );
          })}
        </dl>
      )}
      <div className="ao-capture__actions">
        <button type="button" onClick={() => void update()} disabled={busy}>
          Update capture tools
        </button>
        {busy && <span role="status">Updating…</span>}
      </div>
      {result && (
        <div role="status">
          {result.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
      {error && (
        <div className="ao-capture__error" role="alert">
          <UserText as="p">{error}</UserText>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The screen

function Hint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="ao-capture__hint">
      {children}
    </span>
  );
}

function FieldError({ id, error }: { id: string; error: string | null }) {
  if (!error) return null;
  return (
    <span id={id} className="ao-capture__field-error" role="alert">
      {error}
    </span>
  );
}

export interface CaptureProps {
  client: ApiClient;
  projectId: string;
  /** FR-756: how long each first read (the project, its rules) is waited for. */
  firstReadMs?: number;
  /** FR-756 (R597): how long the event stream is waited for to open before it is closed and tried afresh. */
  streamOpenMs?: number;
  /** R641 D2: how long an open event stream may deliver nothing (not even the service's keep-alive) before it is closed and tried afresh. */
  streamQuietMs?: number;
}

/** FR-756: the first reads that "Try again" (and a new opening of the event stream) can make again. */
type FirstRead = "project" | "policy";

export function Capture({ client, projectId, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS, streamQuietMs = STREAM_QUIET_TIMEOUT_MS }: CaptureProps) {
  const api = useMemo(() => captureApi(client), [client]);
  const installedModels = useSpeechModels(useMemo(() => toolsApi(client), [client]));
  const id = useId();
  const live = useRef(true);

  // The project and its rules.
  const [project, setProject] = useState<CaptureProject | null | undefined>();
  const [policy, setPolicy] = useState<CapturePolicy | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  /**
   * FR-756: the first reads that got no answer (none in time, or the service could not be reached), each with the
   * error's own sentence — "did not answer in time" or "could not be reached", never both run together (R586 M5).
   */
  const [unanswered, setUnanswered] = useState<Partial<Record<FirstRead, string>>>({});
  const unansweredRef = useRef(unanswered);
  unansweredRef.current = unanswered;
  /** The first reads now in the air (one may never settle). */
  const out = useRef(new Set<FirstRead>());
  /** Bumped to make one first read again ("Try again", or a new opening of the stream). */
  const [tries, setTries] = useState<Record<FirstRead, number>>({ project: 0, policy: 0 });
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Links.
  const [text, setText] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  // Options.
  const [useSession, setUseSession] = useState(false);
  const [browser, setBrowser] = useState<BrowserName>("chrome");
  const [transcribe, setTranscribe] = useState<Transcribe>("project");
  const [model, setModel] = useState<string>(DEFAULT_SPEECH_MODEL);
  const [refresh, setRefresh] = useState(false);
  const [legalBasis, setLegalBasis] = useState("");
  const [legalError, setLegalError] = useState<string | null>(null);
  const [legalRefused, setLegalRefused] = useState(false);
  const legalRef = useRef<HTMLInputElement>(null);
  // Profile.
  const [profileUrl, setProfileUrl] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [maxItems, setMaxItems] = useState("");
  const [types, setTypes] = useState<ProfileContentType[]>([]);
  const [metadataOnly, setMetadataOnly] = useState(false);
  const [comments, setComments] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const profileRef = useRef<HTMLInputElement>(null);
  // The estimate before a profile is captured (whole channels, Task 8).
  /** The profile form's status: the listing, or why an estimate was closed. The region is always there (R683 M5). */
  const [estStatus, setEstStatus] = useState("");
  const [shown, setShown] = useState<ShownEstimate | null>(null);
  /**
   * The estimate open or still being read, and the profile form as it was when "Capture profile" was pressed (R683 B):
   * the address and every option. Whenever the form differs from it, the estimate is closed (one comparison, below).
   */
  const estimateOf = useRef<{ form: string; ac: AbortController } | null>(null);
  const [quality, setQuality] = useState<DownloadQuality>("720p");
  const [estTranscribe, setEstTranscribe] = useState(false);
  /** The box's starting state, and whether the researcher has changed it (R683 C1). */
  const estInitial = useRef(false);
  const estTouched = useRef(false);
  /** Beside the box when the project's switch could not be read (R683 C2). */
  const [switchNote, setSwitchNote] = useState<string | undefined>();
  /** The project this screen is for now: an estimate asked for another one is dropped. */
  const projectNow = useRef(projectId);
  projectNow.current = projectId;
  // Starting, queues and the acknowledgement.
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** The refusal behind `formError` where a missing tool is named from it (an estimate refused, R683 D3). */
  const [formErrorFrom, setFormErrorFrom] = useState<unknown>();
  /** The profile form's own "busy" (R683 D2): while an estimate is read or started, the links form stays usable. */
  const profileBusy = useRef(false);
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  /** The list is being asked for: its status and Cancel are shown (R683 D1). */
  const [listing, setListing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [queues, setQueues] = useState<CaptureQueueState[]>([]);
  /** The work lines follow this screen's own event stream (R679 A2). */
  const feed = useEventFeed();
  const queuesNow = useRef(queues);
  queuesNow.current = queues;
  /** Queues in the list (started here, or read from the service). */
  const known = useRef(new Set<string>());
  /** Queues this screen started (a refusal of theirs may open the legal-basis field). */
  const startedHere = useRef(new Set<string>());
  const early = useRef<CaptureProgress[]>([]);
  /** The connection's generation: changes at every open and every loss, so a read asked on another connection is dropped. */
  const conn = useRef(0);
  const readSeq = useRef(0);
  /** Queues already looked up after an event of theirs (each once), with the connection they were read on. */
  const looked = useRef(new Map<string, number>());
  const [ack, setAck] = useState<{ from: "checkbox" | "service" } | null>(null);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Links a lock of this project cut before they were captured, as the service counts them (R464 b). */
  const [cutByLock, setCutByLock] = useState(0);
  const [cutAckError, setCutAckError] = useState<string | null>(null);
  const cutAcking = useRef(false);
  const linksRef = useRef<HTMLTextAreaElement>(null);

  /** "Got it": one request; the reminder goes once the service has forgotten the count. */
  const acknowledgeCut = async () => {
    if (cutAcking.current) return;
    cutAcking.current = true;
    setCutAckError(null);
    try {
      await api.acknowledgeCutByLock(projectId);
      if (!live.current) return;
      setCutByLock(0);
      linksRef.current?.focus(); // where the links are added again
    } catch (err) {
      if (live.current) setCutAckError(plainError(err, "This could not be recorded."));
    } finally {
      cutAcking.current = false;
    }
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Another project: an estimate shown or asked for this one goes.
  useEffect(() => {
    dropEstimate();
    setEstStatus("");
  }, [projectId]);

  // The project; given up after `firstReadMs` as a read that got no answer (FR-756).
  useEffect(() => {
    const ac = new AbortController();
    out.current.add("project");
    readWithin((signal) => api.projects({ signal }), firstReadMs, ac.signal).then(
      (list) => {
        if (ac.signal.aborted) return;
        out.current.delete("project");
        if (!live.current) return;
        // R602 (a): an answered read takes away its earlier give-up sentence.
        setUnanswered(({ project: _p, ...u }) => u);
        const p = list.find((x) => x.id === projectId) ?? null;
        setProject(p);
        setAcknowledged(!!p?.acknowledgements?.includes("cookies"));
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        out.current.delete("project");
        if (!live.current) return;
        if (isUnreachable(err)) setUnanswered((u) => ({ ...u, project: (err as ApiClientError).message }));
        else {
          setUnanswered(({ project: _p, ...u }) => u);
          setLoadError(plainError(err, "The project could not be read."));
        }
      },
    );
    return () => {
      ac.abort();
      out.current.delete("project");
    };
  }, [api, projectId, firstReadMs, tries.project]);
  // Its rules, likewise.
  useEffect(() => {
    const ac = new AbortController();
    out.current.add("policy");
    readWithin((signal) => api.policy(projectId, { signal }), firstReadMs, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        out.current.delete("policy");
        if (!live.current) return;
        setUnanswered(({ policy: _p, ...u }) => u);
        setPolicy(p);
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        out.current.delete("policy");
        if (!live.current) return;
        // Unreadable rules are read strictly (the service then refuses everything anyway).
        setPolicy({ legalBasisRequired: true, defaultLegalBasis: undefined, downloaderAllowed: false, readable: false });
        if (isUnreachable(err)) setUnanswered((u) => ({ ...u, policy: (err as ApiClientError).message }));
        else {
          setUnanswered(({ policy: _p, ...u }) => u);
          setLoadError(plainError(err, "This project's rules could not be read."));
        }
      },
    );
    return () => {
      ac.abort();
      out.current.delete("policy");
    };
  }, [api, projectId, firstReadMs, tries.policy]);

  /**
   * FR-756: makes again each first read that got no answer, and (`stillOut`) each still in the air — after the event
   * stream was lost, one may never settle. Meanwhile its words go and the rules are unknown again (the loading words).
   */
  const readAgain = useCallback((stillOut: boolean) => {
    const again = new Set<FirstRead>([...(Object.keys(unansweredRef.current) as FirstRead[]), ...(stillOut ? out.current : [])]);
    if (!again.size) return;
    if (again.has("policy") && unansweredRef.current.policy !== undefined) setPolicy(undefined);
    setUnanswered((u) => Object.fromEntries(Object.entries(u).filter(([r]) => !again.has(r as FirstRead))));
    setTries((t) => ({ project: t.project + (again.has("project") ? 1 : 0), policy: t.policy + (again.has("policy") ? 1 : 0) }));
  }, []);
  /** FR-756, R602 M1: one sentence for the first reads that got no answer ("could not be reached" wins). */
  const noAnswer = oneNoAnswerSentence(Object.values(unanswered));
  // R605 I2: one sentence and one "Try again" for the page (with the route's list of projects); "Try again" makes
  // again every first read unanswered or still out.
  const { yields, retryAll } = usePageRead("capture", { sentence: noAnswer, out: () => out.current.size > 0, retry: () => readAgain(true) });

  /** A LEGAL_BASIS_REQUIRED refusal of a queue this screen started opens the legal-basis field (review M7). */
  const noteRefusal = (e: CaptureProgress) => {
    if (e.outcome?.errorCode === "LEGAL_BASIS_REQUIRED" || e.report?.errorCode === "LEGAL_BASIS_REQUIRED") setLegalRefused(true);
  };

  /** False while the event stream is down: events published then are missed (R146). */
  const connected = useRef(false);

  /**
   * Queues as the service reports them, merged with what the screen saw (Task 63); the events that
   * arrived for them before they were known are applied on top. Shown oldest first in the state
   * (the queue view shows the newest first).
   */
  const adopt = useCallback((reads: CaptureQueueState[]) => {
    if (!reads.length) return;
    const ids = new Set(reads.map((r) => r.queueId));
    const pending = early.current.filter((e) => ids.has(e.queueId));
    early.current = early.current.filter((e) => !ids.has(e.queueId));
    for (const id of ids) known.current.add(id);
    setQueues((qs) => {
      const byId = new Map(qs.map((q) => [q.queueId, q]));
      for (const r of reads) byId.set(r.queueId, pending.filter((e) => e.queueId === r.queueId).reduce(applyProgress, mergeRead(byId.get(r.queueId), r)));
      return [...byId.values()].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    });
  }, []);

  /** Whether a read asked on connection `gen` (and read number `seq`) may still be used. */
  const current = (gen: number, seq?: number) => live.current && connected.current && gen === conn.current && (seq === undefined || seq === readSeq.current);

  /**
   * Reads the project's running and recent queues (on opening, after a reconnect, after a
   * CAPTURE_RUNNING refusal), and any queue shown with missed progress that the list leaves out; one
   * the service no longer knows is marked so (review M2). A queue already read after an event on this
   * connection is not read again (review M8).
   */
  const readQueues = useCallback(async () => {
    const gen = conn.current;
    const seq = ++readSeq.current;
    try {
      const answer = await api.queues(projectId);
      if (!current(gen, seq)) return;
      const list = answer.queues;
      const cut = answer.cutByLock;
      setCutByLock(typeof cut === "number" && Number.isInteger(cut) && cut > 0 ? cut : 0);
      const listed = new Set(list.map((q) => q.queueId));
      const missed = queuesNow.current.filter((q) => q.gap && !listed.has(q.queueId)).map((q) => q.queueId);
      const ids = [...listed, ...missed].filter((id) => looked.current.get(id) !== gen);
      const gone: string[] = [];
      const details = await Promise.all(
        ids.map((id) =>
          api.queue(projectId, id).catch((err: unknown) => {
            // Forgotten by the service (restarted, or finished long ago): left out, and said so if shown.
            if (err instanceof ApiClientError && err.code === "NOT_FOUND") {
              gone.push(id);
              return undefined;
            }
            throw err;
          }),
        ),
      );
      if (!current(gen, seq)) return;
      adopt(details.filter((d) => d !== undefined).map(queueFromDetail));
      if (gone.length) setQueues((qs) => qs.map((q) => (q.gap && gone.includes(q.queueId) ? { ...q, forgotten: true } : q)));
    } catch {
      // Not readable now: what was seen stays, with its gap note; the next reconnect reads again.
    }
  }, [api, projectId, adopt]);

  /** A capture the screen does not know (started elsewhere, or its start's answer still on its way): read once. */
  const readOne = useCallback(
    (queueId: string) => {
      if (looked.current.has(queueId)) return;
      const gen = conn.current;
      looked.current.set(queueId, gen);
      api.queue(projectId, queueId).then(
        (d) => {
          if (current(gen)) adopt([queueFromDetail(d)]);
        },
        () => {
          // Not readable (another library's, or forgotten): its events stay unshown.
        },
      );
    },
    [api, projectId, adopt],
  );

  const onProgress = useCallback(
    (e: CaptureProgress) => {
      if (!known.current.has(e.queueId)) {
        early.current.push(e);
        if (early.current.length > EARLY_EVENTS) early.current.splice(0, early.current.length - EARLY_EVENTS);
        readOne(e.queueId);
        return;
      }
      if (startedHere.current.has(e.queueId)) noteRefusal(e);
      setQueues((qs) => qs.map((q) => applyProgress(q, e)));
    },
    [readOne],
  );

  // capture.progress events of this project, for as long as the screen is shown.
  useEffect(() => {
    const ctl = new AbortController();
    let stop = false;
    (async () => {
      let tries = 0;
      let attempts = 0;
      while (!stop) {
        // FR-756: at an opening after a try that failed, dropped or did not open in time, the first reads still out or
        // unanswered are made again, without waiting for an event.
        const again = attempts++ > 0;
        try {
          const onOpen = () => {
            feed.opened();
            connected.current = true;
            conn.current++;
            tries = 0; // a working connection starts the count again (review M4)
            if (live.current) setLost(false);
            // Read the queues now: with the stream open, nothing published from here on is missed.
            void readQueues();
            if (again && live.current) readAgain(true);
          };
          // FR-756 (R597): a stream not opened within `streamOpenMs` is closed and tried afresh below.
          for await (const ev of client.events({ signal: ctl.signal, onOpen, openWithinMs: streamOpenMs, quietWithinMs: streamQuietMs })) {
            if (stop) return;
            feed.event(ev);
            const e = captureProgress(ev, projectId);
            if (e) onProgress(e);
          }
        } catch {
          // ended, failed, or did not open in time (FR-756): try again below
        }
        if (stop || ctl.signal.aborted) return;
        // The stream ended: whatever is published until it is back is missed by every running queue.
        connected.current = false;
        conn.current++;
        if (live.current) setQueues((qs) => qs.map(markGap));
        if (tries >= RECONNECTS) {
          if (live.current) setLost(true);
          return;
        }
        tries++;
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    })();
    return () => {
      stop = true;
      connected.current = false;
      conn.current++;
      ctl.abort();
    };
  }, [client, projectId, onProgress, readQueues, attempt, streamOpenMs, readAgain, streamQuietMs, feed]);

  /** A queue the service has started: its early events are applied now. */
  const addQueue = (q: CaptureQueueState) => {
    startedHere.current.add(q.queueId);
    if (known.current.has(q.queueId)) {
      // Already read from the service (an event of it came before this answer): not added twice.
      const seen = queuesNow.current.find((x) => x.queueId === q.queueId);
      if (seen?.items.some((i) => i.errorCode === "LEGAL_BASIS_REQUIRED") || seen?.errorCode === "LEGAL_BASIS_REQUIRED") setLegalRefused(true);
      return;
    }
    known.current.add(q.queueId);
    const mine = early.current.filter((e) => e.queueId === q.queueId);
    early.current = early.current.filter((e) => e.queueId !== q.queueId);
    for (const e of mine) noteRefusal(e);
    // Started while the stream was down: its first events may already be lost.
    const start = connected.current ? q : markGap(q);
    setQueues((qs) => [...qs, mine.reduce(applyProgress, start)]);
  };

  // ---- the legal basis (R41) ----
  const fallback = policy?.defaultLegalBasis;
  const legalNeeded = (withComments: boolean) => !fallback && (!!policy?.legalBasisRequired || legalRefused || withComments);
  const showLegal = !!policy && (policy.legalBasisRequired || legalRefused || comments);
  const legalRequired = legalNeeded(comments);

  const checkLegal = (withComments: boolean): boolean => {
    if (legalNeeded(withComments) && !legalBasis.trim()) {
      setLegalError(withComments && !policy?.legalBasisRequired && !legalRefused ? COMMENTS_LEGAL_MISSING : LEGAL_MISSING);
      legalRef.current?.focus();
      return false;
    }
    setLegalError(null);
    return true;
  };

  // Built by assignment to the shared request type, so every key is checked against it (R184):
  // a key spread in from an untyped object would not be.
  const baseOptions = (): CaptureOptions => {
    const o: CaptureOptions = {};
    if (useSession) o.cookiesFromBrowser = browser;
    if (transcribe === "yes") o.transcribe = true;
    else if (transcribe === "no") o.transcribe = false;
    if (transcribe !== "no" && model) o.transcribeModel = model;
    if (refresh) o.refreshIfExists = true;
    if (legalBasis.trim()) o.legalBasis = legalBasis.trim();
    return o;
  };

  /** A refusal of a start, in plain words; the service asking for the acknowledgement opens it. */
  const refused = (err: unknown, fallbackText: string, namesTool = false) => {
    if (err instanceof ApiClientError && err.code === "ACKNOWLEDGEMENT_REQUIRED") {
      setAcknowledged(false);
      setAckError(null);
      setAck({ from: "service" });
      return;
    }
    setFormError(plainError(err, fallbackText));
    // The error as the service sent it, with its `reason` (the tool's id), so the notice can name the tool.
    setFormErrorFrom(namesTool ? err : undefined);
    // The same link is still being captured: make sure that capture is in the list.
    if (err instanceof ApiClientError && err.code === "CONFLICT" && err.reason === CAPTURE_RUNNING) void readQueues();
  };

  const start = async (run: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setFormError(null);
    setFormErrorFrom(undefined);
    setNotice(null);
    try {
      await run();
    } finally {
      busy.current = false;
      if (live.current) setSubmitting(false);
    }
  };

  /** As `start`, for the profile form: its own synchronous guard and busy, so the links form is never held (R683 D2). */
  const startProfileWork = async (run: () => Promise<void>) => {
    if (profileBusy.current) return;
    profileBusy.current = true;
    setProfileSubmitting(true);
    setFormError(null);
    setFormErrorFrom(undefined);
    setNotice(null);
    try {
      await run();
    } finally {
      profileBusy.current = false;
      if (live.current) setProfileSubmitting(false);
    }
  };

  const linkLines = parseLinks(text);
  const distinct = [...new Set(linkLines)];
  // Only the first lines are previewed: thousands of rows on every keystroke help nobody (review M11).
  const previews = linkLines.slice(0, PREVIEW_LINES).map((u, i) => ({ url: u, p: previewLink(u), repeat: linkLines.indexOf(u) < i }));

  const captureLinks = () =>
    start(async () => {
      const lines = parseLinks(text);
      if (!lines.length) return setLinkError("Paste at least one link, one per line.");
      const bad = lines.findIndex((u) => !isWebAddress(u));
      if (bad >= 0) return setLinkError(`Line ${bad + 1} is not a web address. Each line must be one link starting with https:// or http://.`);
      const secret = lines.findIndex(hasCredentials);
      if (secret >= 0) return setLinkError(`Line ${secret + 1} contains a user name or password. Remove it from the link (the part before @), then capture.`);
      // A link listed twice is captured once (review M3).
      const urls = [...new Set(lines)];
      if (urls.length > MAX_LINKS) return setLinkError(`At most ${MAX_LINKS} links can be queued at once; this list has ${urls.length}.`);
      setLinkError(null);
      if (!checkLegal(false)) return;
      try {
        const { queueId } = await api.capture(projectId, urls, baseOptions());
        if (!live.current) return;
        addQueue(linkQueue(queueId, urls));
        setText("");
      } catch (err) {
        if (live.current) refused(err, "The links could not be queued.");
      }
    });

  const maxNumber = maxItems.trim() === "" ? undefined : Number(maxItems);

  /** The profile form as it is now: the address and every option that goes into the request (R683 B1). */
  const profileForm = JSON.stringify([profileUrl.trim(), since, until, maxItems, types, metadataOnly, comments, legalBasis.trim(), useSession, browser, transcribe, model, refresh]);
  const profileUrlNow = useRef(profileUrl);
  profileUrlNow.current = profileUrl;

  /** The estimate goes: a request still out is cancelled (its answer dropped), an open one is closed. */
  function dropEstimate() {
    estimateOf.current?.ac.abort();
    estimateOf.current = null;
    setShown(null);
    setListing(false);
  }

  // One place (R683 B1): the form no longer as it was when "Capture profile" was pressed closes the estimate, said once.
  useEffect(() => {
    if (!estimateOf.current || estimateOf.current.form === profileForm) return;
    dropEstimate();
    setEstStatus(estimateText.settingsChanged);
  }, [profileForm]);

  /** "Capture profile": the form checked as before, then the estimate is asked for and shown (nothing is captured yet). */
  const captureProfile = () =>
    startProfileWork(async () => {
      const url = profileUrl.trim();
      if (!url) return setProfileError("Paste the link of a profile, channel or playlist.");
      if (!isWebAddress(url)) return setProfileError("This is not a web address. It must start with https:// or http://.");
      if (hasCredentials(url)) return setProfileError("This link contains a user name or password. Remove it from the link (the part before @), then capture.");
      // What kind of address it is, the service decides: the preview never refuses one (R146).
      if (since && until && since > until) return setProfileError("“Posts from” must be on or before “Posts until”.");
      if (maxNumber !== undefined && (!Number.isInteger(maxNumber) || maxNumber < 1)) return setProfileError("The maximum number of items must be a whole number of 1 or more.");
      setProfileError(null);
      if (!checkLegal(comments)) return;
      // By assignment to the shared request type, as baseOptions (R184).
      const options: ProfileCaptureOptions = baseOptions();
      if (since) options.since = since;
      if (until) options.until = until;
      if (maxNumber !== undefined) options.maxItems = maxNumber;
      if (types.length) options.contentTypes = CONTENT_TYPES.map((t) => t.value).filter((t) => types.includes(t));
      if (metadataOnly) options.metadataOnly = true;
      if (comments) options.includeComments = true;
      const asked = projectId;
      const mine = { form: profileForm, ac: new AbortController() };
      estimateOf.current?.ac.abort();
      estimateOf.current = mine;
      // Only the estimate of the form as it still is, for this project, is shown.
      const stillHere = () => live.current && projectNow.current === asked && estimateOf.current === mine;
      const platform = previewLink(url).platform;
      const listed = LISTED.includes(platform) ? (platform as CapturePlatform) : undefined;
      setEstStatus(listed ? estimateText.listing(listed) : "");
      setListing(true);
      // No hard limit (a large channel takes minutes), but past the first-read limit it says it is still asking.
      const slow = listed ? setTimeout(() => stillHere() && setEstStatus(estimateText.listingSlow(listed)), firstReadMs) : undefined;
      // The Transcribe box starts from the Transcription choice; "Use the project's setting" is the project's switch,
      // read beside the estimate with the first-read limit, never holding it back (R683 C2).
      estTouched.current = false;
      estInitial.current = transcribe === "yes";
      setEstTranscribe(estInitial.current);
      setSwitchNote(undefined);
      if (transcribe === "project") {
        readWithin((signal) => api.automation(projectId, { signal }), firstReadMs, mine.ac.signal).then(
          (a) => {
            if (!stillHere() || estTouched.current) return;
            estInitial.current = a.transcribeNewMedia === true;
            setEstTranscribe(estInitial.current);
          },
          () => {
            // Not read: the box stays unticked, said beside it; untouched, the service applies the switch.
            if (stillHere()) setSwitchNote(estimateText.switchNotRead);
          },
        );
      }
      try {
        const estimate = await api.estimate(projectId, url, options, { signal: mine.ac.signal }).finally(() => clearTimeout(slow));
        if (!stillHere()) return;
        setEstStatus("");
        setListing(false);
        setQuality(initialQuality(estimate));
        setShown({ estimate, url, options, form: mine.form });
      } catch (err) {
        if (!stillHere()) return;
        estimateOf.current = null;
        setEstStatus("");
        setListing(false);
        refused(err, "The profile capture could not be started.", true);
      }
    });

  /** "Start": the estimated profile with the chosen quality and an explicit transcription choice. */
  const startProfile = () =>
    startProfileWork(async () => {
      if (!shown) return;
      const asked = projectId;
      const { url, estimate } = shown;
      // By assignment to the shared request type, as baseOptions (R184).
      const options: ProfileCaptureOptions = { ...shown.options };
      // Explicit only when chosen above ("Transcribe", "Do not transcribe") or changed in the box (R683 C1); else left
      // out, and the service applies the project's switch as it stands then.
      const explicit = shown.options.transcribe !== undefined || estTranscribe !== estInitial.current;
      if (estimate.metadataOnly) {
        // Nothing to transcribe: never sent as true (R683 C3).
        delete options.transcribeModel;
        if (options.transcribe !== undefined) options.transcribe = false;
      } else if (explicit) {
        options.transcribe = estTranscribe;
        // The model the box names (R683 C3).
        if (estTranscribe) options.transcribeModel = estimate.speechModel;
        else delete options.transcribeModel;
      } else {
        delete options.transcribe;
        if (options.transcribeModel !== undefined) options.transcribeModel = estimate.speechModel;
      }
      if (!estimate.metadataOnly) options.quality = quality;
      try {
        const { queueId } = await api.captureProfile(projectId, url, options);
        if (!live.current || projectNow.current !== asked) return;
        addQueue(profileQueue(queueId, url));
        // An address typed since Start was pressed is not wiped.
        if (profileUrlNow.current.trim() === url) setProfileUrl("");
        if (estimateOf.current?.form === shown.form) {
          estimateOf.current = null;
          setShown(null);
        }
        profileRef.current?.focus();
      } catch (err) {
        if (live.current && projectNow.current === asked) refused(err, "The profile capture could not be started.");
      }
    });

  /** "Cancel": the estimate goes and the profile field takes focus. */
  const cancelEstimate = () => {
    if (profileBusy.current) return;
    dropEstimate();
    setEstStatus("");
    profileRef.current?.focus();
  };

  /** "Cancel" while the list is asked for: the request is cancelled, its answer dropped, focus on the profile field. */
  const cancelListing = () => {
    dropEstimate();
    setEstStatus("");
    profileRef.current?.focus();
  };

  // ---- the acknowledgement ----
  const onSessionChange = (checked: boolean) => {
    if (!checked) return setUseSession(false);
    if (acknowledged) return setUseSession(true);
    setAckError(null);
    setAck({ from: "checkbox" });
  };
  const ackRunning = useRef(false);
  const confirmAck = async () => {
    if (ackRunning.current) return;
    ackRunning.current = true;
    setAckBusy(true);
    setAckError(null);
    try {
      const list = await api.acknowledge(projectId);
      if (!live.current) return;
      setAcknowledged(list.includes("cookies"));
      if (ack?.from === "checkbox") setUseSession(true);
      else setNotice("Your acknowledgement is recorded. Capture again to start.");
      setAck(null);
    } catch (err) {
      if (live.current) setAckError(plainError(err, "The acknowledgement could not be recorded."));
    } finally {
      ackRunning.current = false;
      if (live.current) setAckBusy(false);
    }
  };

  const locked = project?.unlocked === false;
  const ready = !!policy && project !== undefined && !locked && project !== null;
  const ids = {
    links: `${id}-links`,
    linksHint: `${id}-links-hint`,
    linksError: `${id}-links-error`,
    legal: `${id}-legal`,
    legalHint: `${id}-legal-hint`,
    legalError: `${id}-legal-error`,
    max: `${id}-max`,
    maxHint: `${id}-max-hint`,
    profile: `${id}-profile`,
    profileHint: `${id}-profile-hint`,
    profileError: `${id}-profile-error`,
    comments: `${id}-comments-hint`,
    refresh: `${id}-refresh-hint`,
    session: `${id}-session-hint`,
  };
  const describe = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ") || undefined;

  return (
    <main className="ao-page ao-capture" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
        Capture
      </h1>
      {project && (
        <p>
          Project: <UserText>{project.name}</UserText>
        </p>
      )}
      {!policy && !loadError && <p role="status">Reading this project&apos;s rules…</p>}
      {loadError && (
        <p className="ao-capture__error" role="alert">
          {loadError}
        </p>
      )}
      {noAnswer !== undefined && !yields && (
        <p className="ao-capture__error" role="alert">
          {noAnswer}
        </p>
      )}
      {noAnswer !== undefined && !yields && (
        <p>
          <button
            type="button"
            onClick={() => {
              // The button goes while the reads are made again: focus waits on the heading, never the page.
              headingRef.current?.focus();
              retryAll();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {project === null && (
        <p className="ao-capture__error" role="alert">
          This project was not found in the library.
        </p>
      )}
      {locked && (
        <p className="ao-capture__note" role="alert">
          This project is locked. <a href={libraryHref(projectId)} onClick={inAppLink}>Unlock it in the library</a>, then capture.
        </p>
      )}
      {/* Always mounted, so the reminder that arrives with the queues' read is announced (R464 b). */}
      <div className={cutByLock > 0 ? "ao-capture__note" : undefined}>
        <p role="status">{cutByLock > 0 ? cutByLockText(cutByLock) : ""}</p>
        {cutByLock > 0 && (
          <button type="button" onClick={() => void acknowledgeCut()}>
            Got it
          </button>
        )}
        {cutByLock > 0 && cutAckError && <p role="alert">{cutAckError}</p>}
      </div>
      {/* Rules the engine cannot read: every capture is refused; say why (R379 FR-A18). A failed read is said above. */}
      {policy && !policy.readable && !loadError && !unanswered.policy && <p className="ao-capture__note">{CAPTURE_RULES_UNREADABLE_TEXT}</p>}
      {policy?.readable && !policy.downloaderAllowed && (
        <p className="ao-capture__note">
          This project&apos;s rules do not allow capture with the downloader, so links will be refused. Whoever manages the project&apos;s rules can allow it under Governance.
        </p>
      )}
      {lost && (
        <div className="ao-capture__note" role="alert">
          <p>Progress updates are not available right now. Captures keep running in the library service; the queue below may not show their latest state.</p>
          <button
            type="button"
            onClick={() => {
              setLost(false);
              setAttempt((n) => n + 1);
              // R605 M7: the first reads still out (or unanswered) are made again too, not only at the stream's opening;
              // on the route, its list of projects too (the page's reads, R605 I2).
              retryAll();
            }}
          >
            Reconnect
          </button>
        </div>
      )}

      <form
        className="ao-capture__section"
        aria-labelledby={`${id}-links-h`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void captureLinks();
        }}
      >
        <h2 id={`${id}-links-h`}>Capture links</h2>
        <label className="ao-capture__field" htmlFor={ids.links}>
          <span>Links, one per line</span>
        </label>
        <textarea
          id={ids.links}
          ref={linksRef}
          rows={5}
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={linkError ? true : undefined}
          aria-describedby={describe(ids.linksHint, linkError && ids.linksError)}
          onChange={(e) => {
            setText(e.target.value);
            setLinkError(null);
          }}
        />
        <Hint id={ids.linksHint}>YouTube, Instagram and TikTok posts and videos, up to {MAX_LINKS} at once. A whole profile or playlist is better captured below, with its options.</Hint>
        <FieldError id={ids.linksError} error={linkError} />
        {previews.length > 0 && (
          <>
            <p className={distinct.length > MAX_LINKS ? "ao-capture__field-error" : undefined}>
              {linkLines.length === distinct.length
                ? `${linkLines.length === 1 ? "1 link" : `${linkLines.length} links`} (at most ${MAX_LINKS} at once)`
                : `${linkLines.length} lines, ${distinct.length === 1 ? "1 different link" : `${distinct.length} different links`} (at most ${MAX_LINKS} at once)`}
            </p>
            <p className="ao-capture__hint">The preview is a hint: the library service decides what each link is when it captures it.</p>
            <ol className="ao-capture__preview" aria-label="Link preview">
              {previews.map(({ url, p, repeat }, i) => (
                <li key={i} className={p.problem ? "ao-capture__preview--problem" : undefined}>
                  <UserText className="ao-capture__url">{url}</UserText>
                  <span>{repeat ? "Listed twice: captured once." : p.label}</span>
                  {p.collection && !p.problem && !repeat && <span className="ao-capture__hint">The whole list is captured with default options; use “Capture profile” below to choose them.</span>}
                </li>
              ))}
            </ol>
            {linkLines.length > previews.length && <p className="ao-capture__hint">{`The first ${PREVIEW_LINES} lines are previewed; all ${linkLines.length} are sent.`}</p>}
          </>
        )}
        <div className="ao-capture__actions">
          <button type="submit" className="ao-capture__primary" disabled={submitting || !ready}>
            Capture links
          </button>
          {submitting && <span role="status">Starting…</span>}
        </div>
      </form>

      <fieldset className="ao-capture__section ao-capture__options">
        <legend>Options for links and profiles</legend>
        <div className="ao-capture__row">
          <label>
            <input type="checkbox" checked={useSession} aria-describedby={ids.session} onChange={(e) => onSessionChange(e.target.checked)} /> Use my browser session
          </label>
          <label htmlFor={`${id}-browser`}>Browser</label>
          <select id={`${id}-browser`} value={browser} disabled={!useSession} onChange={(e) => setBrowser(e.target.value as BrowserName)}>
            {BROWSERS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <Hint id={ids.session}>For posts that need you to be signed in. The downloader reads your signed-in session from that browser; it is never copied or stored.</Hint>
        <fieldset className="ao-capture__group" aria-describedby={`${id}-transcribe-hint`}>
          <legend>Transcription</legend>
          {(
            [
              ["project", "Use the project's setting"],
              ["yes", "Transcribe"],
              ["no", "Do not transcribe"],
            ] as const
          ).map(([v, l]) => (
            <label key={v}>
              <input type="radio" name={`${id}-transcribe`} value={v} checked={transcribe === v} onChange={() => setTranscribe(v)} /> {l}
            </label>
          ))}
          <label className="ao-capture__field" htmlFor={`${id}-model`}>
            <span>Transcription model</span>
          </label>
          <select id={`${id}-model`} value={model} disabled={transcribe === "no"} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {modelOptionLabel(m.label, m.value, installedModels)}
              </option>
            ))}
          </select>
          {transcribe !== "no" && <SpeechModelNotice model={model} installed={installedModels} />}
          <Hint id={`${id}-transcribe-hint`}>{`“Use the project's setting” follows the project's switch “${AUTOMATION_TEXT.label}”, on the Governance screen.`}</Hint>
        </fieldset>
        <label>
          <input type="checkbox" checked={refresh} aria-describedby={ids.refresh} onChange={(e) => setRefresh(e.target.checked)} /> Refresh existing
        </label>
        <Hint id={ids.refresh}>For a post already in the project, save a new dated snapshot of its platform data. Otherwise it is skipped.</Hint>
        {showLegal && (
          <div className="ao-capture__legal">
            <label className="ao-capture__field" htmlFor={ids.legal}>
              <span>Legal basis</span>
            </label>
            <input
              id={ids.legal}
              ref={legalRef}
              type="text"
              maxLength={2000}
              value={legalBasis}
              aria-required={legalRequired}
              aria-invalid={legalError ? true : undefined}
              aria-describedby={describe(ids.legalHint, legalError && ids.legalError)}
              onChange={(e) => {
                setLegalBasis(e.target.value);
                setLegalError(null);
              }}
            />
            <Hint id={ids.legalHint}>
              {fallback ? (
                <>
                  Leave it empty to use the project&apos;s default for social media: <UserText>{fallback}</UserText>
                </>
              ) : legalRefused && !policy?.legalBasisRequired ? (
                "A capture was refused because a legal basis was needed and none was given. Enter the legal basis for these captures (for example, “Public task, GDPR Art. 6(1)(e)”)."
              ) : policy?.legalBasisRequired ? (
                "This project's rules need a legal basis for social-media data that can identify people. Enter it here (for example, “Public task, GDPR Art. 6(1)(e)”). It is recorded with each source."
              ) : (
                "Comments are other people's personal data, so saving them needs a legal basis. It is recorded with each source."
              )}
            </Hint>
            <FieldError id={ids.legalError} error={legalError} />
          </div>
        )}
      </fieldset>

      <form
        className="ao-capture__section"
        aria-labelledby={`${id}-profile-h`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!shown) void captureProfile();
        }}
      >
        <h2 id={`${id}-profile-h`}>Capture profile</h2>
        <p>A whole profile, channel or playlist: every post not yet in the project is captured, and a later run finds new, edited and removed posts.</p>
        <label className="ao-capture__field" htmlFor={ids.profile}>
          <span>Profile, channel or playlist link</span>
        </label>
        <input
          id={ids.profile}
          ref={profileRef}
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={profileUrl}
          aria-invalid={profileError ? true : undefined}
          aria-describedby={describe(ids.profileHint, profileError && ids.profileError)}
          onChange={(e) => {
            setProfileUrl(e.target.value);
            setProfileError(null);
          }}
        />
        <Hint id={ids.profileHint}>{profileUrl.trim() ? profileHint(profileUrl.trim()) : "For example https://www.instagram.com/name/ or a YouTube channel."}</Hint>
        <div className="ao-capture__row">
          <label className="ao-capture__field" htmlFor={`${id}-since`}>
            <span>Posts from</span>
          </label>
          <input id={`${id}-since`} type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          <label className="ao-capture__field" htmlFor={`${id}-until`}>
            <span>Posts until</span>
          </label>
          <input id={`${id}-until`} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <label className="ao-capture__field" htmlFor={ids.max}>
            <span>Maximum number of items</span>
          </label>
          <input id={ids.max} type="number" min={1} step={1} value={maxItems} aria-describedby={ids.maxHint} onChange={(e) => setMaxItems(e.target.value)} />
        </div>
        <Hint id={ids.maxHint}>
          Setting a maximum number of items turns off removed-item detection for this capture: posts left out of a shortened list cannot be told apart from posts that were removed. A date range does the
          same.
        </Hint>
        {(maxNumber !== undefined && Number.isInteger(maxNumber) && maxNumber >= 1) || since || until ? (
          <p className="ao-capture__note" role="status">
            {maxNumber !== undefined && Number.isInteger(maxNumber) && maxNumber >= 1
              ? `With a maximum of ${maxNumber} items, removed-item detection is off for this capture.`
              : "With a date range, removed-item detection is off for this capture."}
          </p>
        ) : null}
        <fieldset className="ao-capture__group">
          <legend>Content types</legend>
          {CONTENT_TYPES.map((t) => (
            <label key={t.value}>
              <input type="checkbox" checked={types.includes(t.value)} onChange={(e) => setTypes((xs) => (e.target.checked ? [...xs, t.value] : xs.filter((x) => x !== t.value)))} /> {t.label}
            </label>
          ))}
          <span className="ao-capture__hint">None chosen: the profile&apos;s main list. Not every platform has every type.</span>
        </fieldset>
        <label>
          <input type="checkbox" checked={metadataOnly} onChange={(e) => setMetadataOnly(e.target.checked)} /> Metadata only
        </label>
        <span className="ao-capture__hint">The posts&apos; text and details, without their pictures and videos.</span>
        <label>
          <input type="checkbox" checked={comments} aria-describedby={ids.comments} onChange={(e) => setComments(e.target.checked)} /> Include comments
        </label>
        <Hint id={ids.comments}>
          Off unless you need them. Comments are other people&apos;s personal data: saving them always needs a legal basis, and they are kept as a separate file of each post.
        </Hint>
        <FieldError id={ids.profileError} error={profileError} />
        {shown && (
          <CaptureEstimate
            estimate={shown.estimate}
            quality={quality}
            onQuality={setQuality}
            transcribe={estTranscribe}
            onTranscribe={(v) => {
              estTouched.current = true;
              setEstTranscribe(v);
            }}
            {...(switchNote ? { transcribeNote: switchNote } : {})}
            onStart={() => void startProfile()}
            onCancel={cancelEstimate}
            busy={profileSubmitting}
          />
        )}
        <div className="ao-capture__actions">
          {!shown && (
            <button type="submit" className="ao-capture__primary" disabled={profileSubmitting || !ready}>
              Capture profile
            </button>
          )}
          <span role="status">{estStatus}</span>
          {listing && (
            <button type="button" onClick={cancelListing}>
              {estimateText.cancel}
            </button>
          )}
        </div>
      </form>

      {formError && (
        <div className="ao-capture__error" role="alert">
          {/* It carries the service's message and a rule's own reason (review M6); a missing tool is named (R683 D3). */}
          <MissingToolNotice from={formErrorFrom} as="p">
            <UserText as="p">{formError}</UserText>
          </MissingToolNotice>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      <p className="ao-capture__hint">
        Captures started earlier or from the browser extension are shown here too, for as long as the library service runs; a finished capture stays listed for up to an hour.
      </p>
      {!locked && <WorkLines client={client} projectId={projectId} events={feed.events} />}
      <CaptureQueue queues={queues} />

      <CaptureTools api={api} />

      {ack && (
        <AckDialog
          busy={ackBusy}
          error={ackError}
          onConfirm={() => void confirmAck()}
          onCancel={() => {
            if (ackBusy) return;
            setAck(null);
          }}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// The route: the project named in the address (`?project=<id>`), else the first one

/** `firstReadMs` (FR-756): how long the list of projects, and the screen's own first reads, are waited for. */
export function CaptureRoute({ client, loc, firstReadMs = FIRST_READ_TIMEOUT_MS }: { client: ApiClient; loc: AppLocation; firstReadMs?: number }) {
  const api = useMemo(() => captureApi(client), [client]);
  const id = useId();
  const path = normalisePath(loc.pathname);
  const asked = new URLSearchParams(loc.search).get("project") ?? "";
  const [projects, setProjects] = useState<CaptureProject[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  /** FR-756: the list got no answer (none in time, or the service could not be reached): "Try again" is offered. */
  const [unanswered, setUnanswered] = useState(false);
  const [tries, setTries] = useState(0);
  const pickerRef = useRef<HTMLSelectElement>(null);
  /** The list's read is in the air (it may never settle). */
  const listOut = useRef(false);
  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    listOut.current = true;
    readWithin((signal) => api.projects({ signal }), firstReadMs, ac.signal).then(
      (list) => {
        if (!live) return;
        listOut.current = false;
        setProjects(list);
      },
      (err: unknown) => {
        if (!live) return;
        listOut.current = false;
        // R605 I1: a list not read (given up at the limit, or failed) is never taken for an empty one: the project named
        // in the address stays shown (its working Capture screen, links being typed are not lost), and nothing says it
        // is not one of the library's projects.
        // A read with no answer says only its own sentence (never "could not be reached" and "did not answer" together).
        setUnanswered(isUnreachable(err));
        setError(isUnreachable(err) ? (err as ApiClientError).message : plainError(err, "The projects could not be read."));
      },
    );
    return () => {
      live = false;
      listOut.current = false;
      ac.abort();
    };
  }, [api, firstReadMs, tries]);
  // R605 I2: the list and the Capture screen's own first reads are one page: one sentence and one "Try again".
  const { page, sentence: pageSentence, screenSays, retryAll } = usePageHost({
    sentence: error !== null && unanswered ? error : undefined,
    out: () => listOut.current,
    retry: () => {
      setError(null);
      setUnanswered(false);
      setProjects(undefined);
      setTries((n) => n + 1);
    },
  });
  const list = projects ?? [];
  // A name that is not one of the library's selects none (never another project's screen).
  const unknown = !!asked && (!isValidId(asked) || (!!projects && !list.some((p) => p.id === asked)));
  const projectId = asked ? (unknown ? "" : asked) : (list.find((p) => p.unlocked !== false)?.id ?? list[0]?.id ?? "");
  return (
    <>
      <nav className="ao-capture__picker" aria-label="Capture project">
        <label htmlFor={`${id}-project`}>Project</label>
        <select id={`${id}-project`} ref={pickerRef} value={projectId} onChange={(e) => e.target.value && navigate(`${path}?project=${encodeURIComponent(e.target.value)}`)}>
          {!projectId && <option value="">Choose a project</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id} dir="auto">
              {p.name}
            </option>
          ))}
        </select>
      </nav>
      {/* R617 N2: where the screen's alert already says the page's sentence, the list's no-answer is said by it. */}
      {(pageSentence ?? (screenSays ? undefined : error)) && (
        <p className="ao-capture__error" role="alert">
          {pageSentence ?? error}
        </p>
      )}
      {pageSentence !== undefined && (
        <p>
          <button
            type="button"
            onClick={() => {
              // The button goes while the reads are made again: focus waits on the project choice, never the page.
              pickerRef.current?.focus();
              retryAll();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {unknown && (
        <p className="ao-capture__error" role="alert">
          The project in this address is not one of this library&apos;s projects. Choose a project.
        </p>
      )}
      <PageReads value={page}>{projectId && isValidId(projectId) && <Capture key={projectId} client={client} projectId={projectId} firstReadMs={firstReadMs} />}</PageReads>
    </>
  );
}
