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
 * Stale answers are dropped: the screen is keyed by its project, every answer and event is checked
 * against `live` (unmount), a read is used only if the connection it was asked on is still the
 * current one (and only the latest read), and events of other projects are never applied. A capture
 * is started once however often its button is pressed (a synchronous guard, then the button is
 * disabled).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CAPTURE_RUNNING } from "@ao/shared";
import { ApiClientError, type ApiClient } from "../api/client";
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
import { CaptureQueue } from "../components/CaptureQueue";
import { modelOptionLabel, SpeechModelNotice, ToolsLink, useSpeechModels } from "../components/MissingToolNotice";
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
function plainError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiClientError)) return fallback;
  if (err.code === "WORKER_UNAVAILABLE") return `${fallback} The media helper is not running. Restart the app and try again.`;
  // The same link (or profile) is still being captured: the service's own sentence, and where to look.
  if (err.code === "CONFLICT" && err.reason === CAPTURE_RUNNING) return `${err.message} The running capture is shown in the capture queue below.`;
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

const LEGAL_MISSING = "Enter the legal basis for this capture. This project's rules need one for social-media data that can identify people, and they give no default.";
const COMMENTS_LEGAL_MISSING = "Enter the legal basis for this capture. Comments are other people's personal data, so saving them always needs one.";

// ---------------------------------------------------------------------------------------------
// The acknowledgement dialog (inert background, focus trapped and restored, Escape and Cancel)

function AckDialog({ busy, error, onConfirm, onCancel }: { busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  // What had focus before the dialog, read while rendering: before the background is made inert,
  // which in a browser can move focus to <body> before useTrap's passive effect reads it (review M9).
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  const { ref, onKeyDown } = useTrap(onCancel, busy);
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
        <h2 id={`${id}-t`}>Use your browser session?</h2>
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
}

export function Capture({ client, projectId }: CaptureProps) {
  const api = useMemo(() => captureApi(client), [client]);
  const installedModels = useSpeechModels(useMemo(() => toolsApi(client), [client]));
  const id = useId();
  const live = useRef(true);

  // The project and its rules.
  const [project, setProject] = useState<CaptureProject | null | undefined>();
  const [policy, setPolicy] = useState<CapturePolicy | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

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
  // Starting, queues and the acknowledgement.
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queues, setQueues] = useState<CaptureQueueState[]>([]);
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

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    api.projects().then(
      (list) => {
        if (!live.current) return;
        const p = list.find((x) => x.id === projectId) ?? null;
        setProject(p);
        setAcknowledged(!!p?.acknowledgements?.includes("cookies"));
      },
      (err: unknown) => live.current && setLoadError(plainError(err, "The project could not be read.")),
    );
    api.policy(projectId).then(
      (p) => live.current && setPolicy(p),
      (err: unknown) => {
        if (!live.current) return;
        // Unreadable rules are read strictly (the service then refuses everything anyway).
        setPolicy({ legalBasisRequired: true, defaultLegalBasis: undefined, downloaderAllowed: false, readable: false });
        setLoadError(plainError(err, "This project's rules could not be read."));
      },
    );
  }, [api, projectId]);

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
      const list = await api.queues(projectId);
      if (!current(gen, seq)) return;
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
      while (!stop) {
        try {
          const onOpen = () => {
            connected.current = true;
            conn.current++;
            tries = 0; // a working connection starts the count again (review M4)
            if (live.current) setLost(false);
            // Read the queues now: with the stream open, nothing published from here on is missed.
            void readQueues();
          };
          for await (const ev of client.events({ signal: ctl.signal, onOpen })) {
            if (stop) return;
            const e = captureProgress(ev, projectId);
            if (e) onProgress(e);
          }
        } catch {
          // ended or failed: try again below
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
  }, [client, projectId, onProgress, readQueues, attempt]);

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

  const baseOptions = (): CaptureOptions => ({
    ...(useSession ? { cookiesFromBrowser: browser } : {}),
    ...(transcribe === "yes" ? { transcribe: true } : transcribe === "no" ? { transcribe: false } : {}),
    ...(transcribe !== "no" && model ? { transcribeModel: model } : {}),
    ...(refresh ? { refreshIfExists: true } : {}),
    ...(legalBasis.trim() ? { legalBasis: legalBasis.trim() } : {}),
  });

  /** A refusal of a start, in plain words; the service asking for the acknowledgement opens it. */
  const refused = (err: unknown, fallbackText: string) => {
    if (err instanceof ApiClientError && err.code === "ACKNOWLEDGEMENT_REQUIRED") {
      setAcknowledged(false);
      setAckError(null);
      setAck({ from: "service" });
      return;
    }
    setFormError(plainError(err, fallbackText));
    // The same link is still being captured: make sure that capture is in the list.
    if (err instanceof ApiClientError && err.code === "CONFLICT" && err.reason === CAPTURE_RUNNING) void readQueues();
  };

  const start = async (run: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    try {
      await run();
    } finally {
      busy.current = false;
      if (live.current) setSubmitting(false);
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

  const captureProfile = () =>
    start(async () => {
      const url = profileUrl.trim();
      if (!url) return setProfileError("Paste the link of a profile, channel or playlist.");
      if (!isWebAddress(url)) return setProfileError("This is not a web address. It must start with https:// or http://.");
      if (hasCredentials(url)) return setProfileError("This link contains a user name or password. Remove it from the link (the part before @), then capture.");
      // What kind of address it is, the service decides: the preview never refuses one (R146).
      if (since && until && since > until) return setProfileError("“Posts from” must be on or before “Posts until”.");
      if (maxNumber !== undefined && (!Number.isInteger(maxNumber) || maxNumber < 1)) return setProfileError("The maximum number of items must be a whole number of 1 or more.");
      setProfileError(null);
      if (!checkLegal(comments)) return;
      const options: ProfileCaptureOptions = {
        ...baseOptions(),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(maxNumber !== undefined ? { maxItems: maxNumber } : {}),
        ...(types.length ? { contentTypes: CONTENT_TYPES.map((t) => t.value).filter((t) => types.includes(t)) } : {}),
        ...(metadataOnly ? { metadataOnly: true } : {}),
        ...(comments ? { includeComments: true } : {}),
      };
      try {
        const { queueId } = await api.captureProfile(projectId, url, options);
        if (!live.current) return;
        addQueue(profileQueue(queueId, url));
        setProfileUrl("");
      } catch (err) {
        if (live.current) refused(err, "The profile capture could not be started.");
      }
    });

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
      <h1 id={`${id}-title`}>Capture</h1>
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
          <Hint id={`${id}-transcribe-hint`}>A profile capture transcribes only when “Transcribe” is chosen.</Hint>
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
          void captureProfile();
        }}
      >
        <h2 id={`${id}-profile-h`}>Capture profile</h2>
        <p>A whole profile, channel or playlist: every post not yet in the project is captured, and a later run finds new, edited and removed posts.</p>
        <label className="ao-capture__field" htmlFor={ids.profile}>
          <span>Profile, channel or playlist link</span>
        </label>
        <input
          id={ids.profile}
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
        <div className="ao-capture__actions">
          <button type="submit" className="ao-capture__primary" disabled={submitting || !ready}>
            Capture profile
          </button>
        </div>
      </form>

      {formError && (
        <div className="ao-capture__error" role="alert">
          {/* It carries the service's message and a rule's own reason (review M6). */}
          <UserText as="p">{formError}</UserText>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      <p className="ao-capture__hint">
        Captures started earlier or from the browser extension are shown here too, for as long as the library service runs; a finished capture stays listed for up to an hour.
      </p>
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

export function CaptureRoute({ client, loc }: { client: ApiClient; loc: AppLocation }) {
  const api = useMemo(() => captureApi(client), [client]);
  const id = useId();
  const path = normalisePath(loc.pathname);
  const asked = new URLSearchParams(loc.search).get("project") ?? "";
  const [projects, setProjects] = useState<CaptureProject[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.projects().then(
      (list) => live && setProjects(list),
      (err: unknown) => {
        if (!live) return;
        setProjects([]);
        setError(plainError(err, "The projects could not be read."));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  const list = projects ?? [];
  // A name that is not one of the library's selects none (never another project's screen).
  const unknown = !!asked && (!isValidId(asked) || (!!projects && !list.some((p) => p.id === asked)));
  const projectId = asked ? (unknown ? "" : asked) : (list.find((p) => p.unlocked !== false)?.id ?? list[0]?.id ?? "");
  return (
    <>
      <nav className="ao-capture__picker" aria-label="Capture project">
        <label htmlFor={`${id}-project`}>Project</label>
        <select id={`${id}-project`} value={projectId} onChange={(e) => e.target.value && navigate(`${path}?project=${encodeURIComponent(e.target.value)}`)}>
          {!projectId && <option value="">Choose a project</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id} dir="auto">
              {p.name}
            </option>
          ))}
        </select>
      </nav>
      {error && (
        <p className="ao-capture__error" role="alert">
          {error}
        </p>
      )}
      {unknown && (
        <p className="ao-capture__error" role="alert">
          The project in this address is not one of this library&apos;s projects. Choose a project.
        </p>
      )}
      {projectId && isValidId(projectId) && <Capture key={projectId} client={client} projectId={projectId} />}
    </>
  );
}
