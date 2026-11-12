/**
 * The transcript viewer (Task 34c): a source's recording and its transcript side by side.
 *
 * - The recording plays through a media ticket (MediaTicketPlayer; R135, R140). A source with no
 *   recording still shows its transcript.
 * - The segment list (time, language, text) follows playback: the segment playing is marked
 *   (`aria-current`, a visible "Now playing") and scrolled into view without moving focus; the list
 *   is not a live region, so a screen reader is not told of every change. Each segment's time is a
 *   button that moves playback there.
 * - Flagged segments carry their flags in words (spec 5.8), never colour alone. A person's edit has
 *   `flags: null`: no flags are shown and the screen says the edit was not checked.
 * - Edits are saved as a NEW human-edit version; the version it came from is kept (the machine
 *   transcript is never overwritten). Unsaved edits are guarded against loss (leaving, closing the
 *   window, switching version); a failed save keeps the text.
 * - "Re-transcribe" runs speech recognition again with another model; the new version joins the
 *   version picker when it is stored.
 *
 * Every answer is checked against the project, source and request it was for, so one that arrives
 * after they changed (or after the screen closed) is dropped.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TranscriptResponse, TranscriptSaveRequest, TranscriptSegment, TranscriptVersionSummary } from "@ao/shared";
import { ApiClientError } from "../api/client";
import { errorText, isProjectLocked, type SourceFile } from "../api/library";
import { TRANSCRIPTION_MODELS, type TranscriptApi, type TranscriptionModel } from "../api/transcripts";
import { MediaTicketPlayer, type PlayerControl } from "../components/MediaTicketPlayer";
import { isPlayableRecording } from "../components/TranscriptLink";
import { MissingToolNotice, modelOptionLabel, SpeechModelNotice, useSpeechModels } from "../components/MissingToolNotice";
import { DEFAULT_SPEECH_MODEL, type ToolsApi } from "../api/tools";
import { UserText } from "../components/UserText";
import { blockNavigation } from "../navigation";
import { setTranscriptionRun, subscribeTranscriptionRuns, transcriptionRun } from "./transcriptionRuns";
import { buildVtt, carriedFlags, flagLabels, formatTime, machineBaseOf, segmentAt, versionEntries, type VersionEntry } from "./transcriptModel";
import "../components/library.css";
import "./TranscriptViewer.css";

export interface TranscriptViewerProps {
  api: TranscriptApi;
  projectId: string;
  sourceId: string;
  /** The service said the project is locked. */
  onLocked?: () => void;
  /** The optional tools (Task 48b): which speech models are installed. Left out: not known. */
  tools?: ToolsApi;
}

const MODEL_LABELS: Record<TranscriptionModel, string> = {
  "large-v3": "large-v3 (most accurate, slowest)",
  medium: "medium",
  small: "small (fastest)",
};

const LOCKED = "This project is locked, so its transcript and recording are not shown. Unlock it in the library, then choose Try again.";
const UNSAVED = "You have edits that are not saved. Save them as a new version or discard them first.";

let displayNames: Intl.DisplayNames | null | undefined;
const languageNames = new Map<string, string>();

/** A language code in words ("en" → "English"); "und" → "Language not known". Cached per code. */
function languageName(code: string): string {
  if (!code || code === "und") return "Language not known";
  const known = languageNames.get(code);
  if (known !== undefined) return known;
  let name = code;
  try {
    if (displayNames === undefined) displayNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
    const n = displayNames?.of(code);
    if (n && n !== code) name = n;
  } catch {
    /* not a code Intl knows */
  }
  if (languageNames.size < 500) languageNames.set(code, name);
  return name;
}

function dateText(iso: string | undefined): string {
  if (!iso) return "time not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "time not recorded" : d.toLocaleString();
}

function versionLabel(v: VersionEntry): string {
  const flagged = v.origin === "machine" && v.flagged !== undefined ? ` — ${v.flagged === 1 ? "1 segment" : `${v.flagged} segments`} flagged` : "";
  return `${v.madeBy}, ${dateText(v.at)}${flagged}`;
}

/** Plain words for a failed transcription, with what the service reported (never a raw code). */
function transcribeError(err: unknown, model: string): string {
  if (!(err instanceof ApiClientError)) return "Transcription could not be started.";
  const said = err.message ? ` The service said: “${err.message}”` : "";
  switch (err.reason) {
    case "MODEL_UNAVAILABLE":
      return `The speech model “${model}” on this computer could not be loaded; it may be damaged. Remove it and install it again from the optional tools screen, or choose another model.${said}`;
    case "FFMPEG_FAILED":
      return `The sound could not be read from the recording. The file may be damaged or in a form the speech tool cannot read.${said}`;
    case "UNSUPPORTED_INPUT":
      return `The recording has no sound the speech tool can read.${said}`;
    case "INPUT_NOT_FOUND":
      return `The recording's file could not be found in the library.${said}`;
    case "INVALID_PARAMS":
      return `The speech tool refused these settings on this computer.${said}`;
    case "INTERRUPTED":
      return `The transcription was interrupted before it finished (the media helper stopped). Nothing was saved; you can start it again.${said}`;
    case "CANCELLED":
      return `The transcription was stopped before it finished. Nothing was saved.${said}`;
    case "ENCRYPTION_REQUIRED":
      return `This project is encrypted and the media helper could not work on it encrypted, so nothing was transcribed.${said}`;
    case "INPUT_NOT_DECRYPTABLE":
      return `The recording could not be decrypted for transcription. Lock and unlock the project, then try again.${said}`;
    case "TOOL_FAILED":
      return `The speech tool failed while transcribing.${said}`;
  }
  if (err.code === "WORKER_UNAVAILABLE") return "The media helper that runs speech recognition is not running. Start the app again, then try again.";
  if (err.code === "INTERNAL" && err.reason) return `The media helper could not finish the transcription.${said === ` The service said: “The media helper could not finish the job.”` ? "" : said}`;
  return errorText(err, "Transcription failed.");
}

type Drafts = ReadonlyMap<number, string>;

type BaseState = { kind: "ready"; forId: string; segments: TranscriptSegment[]; guessed: boolean; at?: string } | { kind: "unavailable"; forId: string };

/**
 * A new project or source starts the viewer afresh (its player closes and revokes its ticket, and
 * nothing of the previous source is shown for even one render).
 */
export function TranscriptViewer(props: TranscriptViewerProps) {
  return <Viewer key={`${props.projectId}\u0000${props.sourceId}`} {...props} />;
}

function Viewer({ api, projectId, sourceId, onLocked, tools }: TranscriptViewerProps) {
  const installedModels = useSpeechModels(tools);
  const id = useId();
  const key = `${projectId}\u0000${sourceId}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;
  const apiRef = useRef(api);
  apiRef.current = api;

  const [source, setSource] = useState<SourceFile | undefined>();
  const [locked, setLocked] = useState(false);
  /** Bumped by "Try again" (after unlocking): everything is read again; unsaved edits are kept. */
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [versions, setVersions] = useState<VersionEntry[] | undefined>();
  const [rawVersions, setRawVersions] = useState<TranscriptVersionSummary[]>([]);
  /** A human edit's machine base and the flags carried from it (R143), for the transcript shown. */
  const [base, setBase] = useState<BaseState | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [transcript, setTranscript] = useState<TranscriptResponse | undefined>();
  const [transcriptError, setTranscriptError] = useState<string | undefined>();
  const [current, setCurrent] = useState(-1);
  const [drafts, setDrafts] = useState<Drafts>(new Map());
  const [wholeDraft, setWholeDraft] = useState<string | undefined>();
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [refused, setRefused] = useState(false);
  const [model, setModel] = useState<TranscriptionModel>(DEFAULT_SPEECH_MODEL);
  const [transcribeFailure, setTranscribeFailure] = useState<string | undefined>();
  const [failedWith, setFailedWith] = useState<unknown>(); // the error behind transcribeFailure (Task 48b)
  /** This source's re-transcription in this session (it outlives the screen; R143). */
  const run = useSyncExternalStore(subscribeTranscriptionRuns, () => transcriptionRun(key));

  const listSeq = useRef(0);
  const readSeq = useRef(0);
  const actionSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const player = useRef<PlayerControl | null>(null);
  const items = useRef(new Map<number, HTMLLIElement>());
  const editButtons = useRef(new Map<number, HTMLButtonElement>());

  const segments = transcript?.segments ?? [];
  const dirty = drafts.size > 0 || wholeDraft !== undefined;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const sawLocked = useCallback((err: unknown) => {
    if (!isProjectLocked(err)) return false;
    setLocked(true);
    lockedRef.current?.();
    return true;
  }, []);

  /** Reads the version list; `choose` picks a version (by id, or by a stored file's path) when it is in it. */
  const loadVersions = useCallback(
    async (choose?: { id?: string; paths?: string[] }) => {
      const mine = ++listSeq.current;
      const k = keyRef.current;
      try {
        const r = await apiRef.current.versions(projectId, sourceId);
        if (!mounted.current || k !== keyRef.current || mine !== listSeq.current) return;
        const entries = versionEntries(r.versions);
        setVersions(entries);
        setRawVersions(r.versions);
        const byPath = choose?.paths ? r.versions.filter((v) => choose.paths!.includes(v.path)).map((v) => v.id) : [];
        const wanted = [choose?.id, ...byPath].find((x) => x && entries.some((e) => e.id === x));
        setSelected((prev) => {
          if (wanted && !dirtyRef.current) return wanted;
          if (prev && entries.some((e) => e.id === prev)) return prev;
          return entries.at(-1)?.id;
        });
      } catch (err) {
        if (!mounted.current || k !== keyRef.current || mine !== listSeq.current) return;
        if (!sawLocked(err)) setLoadError(errorText(err, "The transcript versions could not be read."));
        setVersions((v) => v ?? []);
      }
    },
    [projectId, sourceId, sawLocked],
  );

  // The source and its versions, once (a new source is a new Viewer).
  useEffect(() => {
    const k = key;
    apiRef.current.source(projectId, sourceId).then(
      (f) => mounted.current && k === keyRef.current && setSource(f),
      (err: unknown) => {
        if (!mounted.current || k !== keyRef.current) return;
        if (!sawLocked(err)) setLoadError(errorText(err, "This source could not be read."));
      },
    );
    void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  // The chosen version's segments.
  useEffect(() => {
    if (!selected) return;
    const mine = ++readSeq.current;
    const k = keyRef.current;
    setTranscript(undefined);
    setTranscriptError(undefined);
    apiRef.current.read(projectId, sourceId, selected).then(
      (t) => {
        if (!mounted.current || k !== keyRef.current || mine !== readSeq.current) return;
        setTranscript(t);
      },
      (err: unknown) => {
        if (!mounted.current || k !== keyRef.current || mine !== readSeq.current) return;
        if (!sawLocked(err)) setTranscriptError(errorText(err, "This version could not be read."));
      },
    );
  }, [selected, projectId, sourceId, sawLocked, attempt]);

  // A person's edit carries `flags: null` (no check ran on it). Until the service stores flags per
  // segment (Task 62), the machine version it came from is read and its flags are shown on every
  // segment the person left exactly as it was; the others are marked as edited and not checked.
  const baseSeq = useRef(0);
  const baseOf = transcript?.origin === "human-edit" && transcript.timed ? machineBaseOf(transcript.id, rawVersions) : undefined;
  const humanId = transcript?.origin === "human-edit" && transcript.timed ? transcript.id : undefined;
  const baseId = baseOf?.id;
  const baseGuessed = baseOf?.guessed ?? false;
  const baseAt = baseOf?.at;
  useEffect(() => {
    const mine = ++baseSeq.current;
    setBase(undefined);
    if (!humanId) return;
    if (!baseId) {
      setBase({ kind: "unavailable", forId: humanId });
      return;
    }
    const k = keyRef.current;
    apiRef.current.read(projectId, sourceId, baseId).then(
      (t) => {
        if (!mounted.current || k !== keyRef.current || mine !== baseSeq.current) return;
        setBase({ kind: "ready", forId: humanId, segments: t.segments, guessed: baseGuessed, ...(baseAt ? { at: baseAt } : {}) });
      },
      () => {
        if (!mounted.current || k !== keyRef.current || mine !== baseSeq.current) return;
        setBase({ kind: "unavailable", forId: humanId });
      },
    );
  }, [humanId, baseId, baseGuessed, baseAt, projectId, sourceId]);
  const carried = useMemo(
    () => (transcript && base?.kind === "ready" && base.forId === transcript.id ? carriedFlags(transcript.segments, base.segments) : undefined),
    [transcript, base],
  );

  // Unsaved edits are not lost: the window asks before closing; in-app links and navigate() are
  // refused; Back and Forward land on a copy of this address and are refused too.
  useEffect(() => {
    if (!dirty) {
      setRefused(false);
      return;
    }
    const refuse = () => setRefused(true);
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    const unblock = blockNavigation(refuse);
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.pushState(null, "", here);
    let restoring = false;
    const onPop = () => {
      if (restoring) return;
      refuse();
      restoring = true;
      window.history.pushState(null, "", here);
      window.dispatchEvent(new PopStateEvent("popstate"));
      restoring = false;
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("popstate", onPop);
      unblock();
    };
  }, [dirty]);

  // "Follow playback" (R143): the segment playing is brought into view inside the segment list's own
  // scroll area — never the window, never focused. Following pauses while the researcher edits a
  // segment, has focus inside the list, or has scrolled the list themselves; "Back to the playing
  // segment" resumes it.
  const listRef = useRef<HTMLOListElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [userScrolled, setUserScrolled] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const following = follow && !userScrolled && !focusInside && editing === null;
  const scrollToSegment = useCallback((i: number) => {
    const list = listRef.current;
    const item = items.current.get(i);
    if (!list || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    const now = list.scrollTop;
    const target = top < now ? top : bottom > now + list.clientHeight ? Math.min(top, bottom - list.clientHeight) : null;
    if (target === null) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && typeof list.scrollTo === "function") list.scrollTo({ top: target, behavior: "smooth" });
    else list.scrollTop = target;
  }, []);
  useEffect(() => {
    if (following && current >= 0) scrollToSegment(current);
  }, [current, following, scrollToSegment]);
  const backToPlaying = () => {
    setUserScrolled(false);
    if (current >= 0) scrollToSegment(current);
  };

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const onTime = useCallback((t: number) => {
    const i = segmentAt(segmentsRef.current, t);
    setCurrent((c) => (c === i ? c : i));
  }, []);

  const seek = (i: number) => {
    const s = segments[i];
    if (!s || !player.current) return;
    player.current.seek(s.start);
    setCurrent(i);
  };

  const chooseVersion = (v: string) => {
    if (dirty) {
      setRefused(true);
      return;
    }
    setNotice(undefined);
    setSelected(v);
  };

  const finishEdit = (i: number) => {
    setEditing(null);
    requestAnimationFrame(() => editButtons.current.get(i)?.focus());
  };

  const setDraft = (i: number, text: string) => {
    setDrafts((d) => {
      const next = new Map(d);
      if (text === segments[i]?.text) next.delete(i);
      else next.set(i, text);
      return next;
    });
  };

  const versionPicker = useRef<HTMLSelectElement | null>(null);
  const discard = () => {
    setDrafts(new Map());
    setWholeDraft(undefined);
    setEditing(null);
    setSaveError(undefined);
    setRefused(false);
    // The button pressed goes away: focus moves to the version picker, not to the page.
    versionPicker.current?.focus();
  };

  const save = async () => {
    if (!transcript || !selected || !dirty || saving) return;
    const mine = ++actionSeq.current;
    const k = keyRef.current;
    const body: TranscriptSaveRequest = transcript.timed
      ? { format: "vtt", text: buildVtt(segments.map((s, i) => ({ start: s.start, end: s.end, text: drafts.get(i) ?? s.text }))), basedOn: selected }
      : { format: "txt", text: wholeDraft ?? transcript.text, basedOn: selected };
    setSaving(true);
    setSaveError(undefined);
    setNotice(undefined);
    try {
      const r = await apiRef.current.save(projectId, sourceId, body);
      if (!mounted.current || k !== keyRef.current || mine !== actionSeq.current) return;
      setDrafts(new Map());
      setWholeDraft(undefined);
      setEditing(null);
      dirtyRef.current = false;
      setNotice("Saved as a new version. The version it was edited from is kept.");
      versionPicker.current?.focus();
      await loadVersions({ id: r.id });
    } catch (err) {
      if (!mounted.current || k !== keyRef.current || mine !== actionSeq.current) return;
      // The edits are kept (hidden while the project is locked; shown again after Try again).
      sawLocked(err);
      setSaveError(`Your edits were not saved and are still here. ${errorText(err, "The library service did not answer.")}`);
    } finally {
      if (mounted.current && k === keyRef.current && mine === actionSeq.current) setSaving(false);
    }
  };

  // A run's outcome is taken up by whichever viewer of this source is open when it is known.
  useEffect(() => {
    if (!run || (run.state !== "finished" && run.state !== "failed")) return;
    setTranscriptionRun(key, undefined);
    if (run.state === "finished") {
      const r = run.result;
      const flagged = r.flaggedSegments === 1 ? "1 segment is" : `${r.flaggedSegments} segments are`;
      setNotice(`The new transcript is ready (${flagged} flagged for review). ${dirtyRef.current ? "It is listed under Version." : "It is shown below."}`);
      void loadVersions({ paths: r.files });
    } else if (!sawLocked(run.error)) {
      setTranscribeFailure(transcribeError(run.error, run.model));
      setFailedWith(run.error);
    }
  }, [run, key, loadVersions, sawLocked]);

  const transcribe = () => {
    if (run) return;
    const k = key;
    const chosen = model;
    const startedAt = new Date().toISOString();
    const transcribeApi = apiRef.current;
    setTranscribeFailure(undefined);
    setNotice(undefined);
    setTranscriptionRun(k, { state: "running", model: chosen, startedAt });
    transcribeApi.transcribe(projectId, sourceId, { model: chosen }).then(
      (result) => setTranscriptionRun(k, { state: "finished", model: chosen, startedAt, result }),
      (error: unknown) => {
        // The request was sent and no answer came back: the service may still be transcribing.
        const lost = error instanceof ApiClientError && error.status === 0;
        setTranscriptionRun(k, lost ? { state: "unknown", model: chosen, startedAt } : { state: "failed", model: chosen, startedAt, error });
      },
    );
  };

  /** After a lost connection: a machine version made since the run started means it finished. */
  const checkForNewVersions = async () => {
    if (run?.state !== "unknown") return;
    const since = Date.parse(run.startedAt) - 5_000;
    const k = keyRef.current;
    try {
      const r = await apiRef.current.versions(projectId, sourceId);
      if (!mounted.current || k !== keyRef.current) return;
      const fresh = r.versions.filter((v) => v.origin === "machine" && Date.parse(String((v.derivation as { at?: unknown } | undefined)?.at ?? "")) >= since);
      if (fresh.length) {
        setTranscriptionRun(k, { state: "finished", model: run.model, startedAt: run.startedAt, result: { sourceId, folder: "", files: fresh.map((v) => v.path), flaggedSegments: fresh[0]!.flaggedSegments ?? 0 } });
      } else {
        setNotice("No new version yet. The transcription may still be going; check again in a few minutes.");
      }
    } catch (err) {
      if (!mounted.current || k !== keyRef.current) return;
      if (!sawLocked(err)) setNotice(`The versions could not be checked. ${errorText(err, "The library service did not answer.")}`);
    }
  };

  const busy = run?.state === "running" || run?.state === "unknown";
  const media = useMemo(() => source?.assets.find(isPlayableRecording), [source]);
  const title = source?.source.title.variants[0];
  const human = transcript?.origin === "human-edit";

  return (
    <main className="ao-page ao-tx" aria-labelledby={`${id}-h`}>
      <h1 id={`${id}-h`}>
        Transcript{title?.value ? ": " : ""}
        {title?.value && <UserText lang={title.lang}>{title.value}</UserText>}
      </h1>

      {locked && (
        <div className="ao-tx__locked">
          <p role="alert" className="ao-error">
            {LOCKED}
          </p>
          {dirty && <p>Your edits that are not saved are kept here until you save or discard them.</p>}
          <div className="ao-row">
            <button
              type="button"
              onClick={() => {
                setLocked(false);
                setLoadError(undefined);
                setTranscriptError(undefined);
                setSaveError(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
            {dirty && (
              <button type="button" onClick={discard}>
                Discard edits
              </button>
            )}
          </div>
        </div>
      )}
      {loadError && !locked && (
        <p role="alert" className="ao-error">
          {loadError}
        </p>
      )}

      {!locked && source && (
        <section aria-label="Recording" className="ao-tx__recording">
          {media ? (
            <MediaTicketPlayer
              api={api}
              projectId={projectId}
              sourceId={sourceId}
              asset={{ id: media.id, mime: media.mime ?? "", kind: media.kind }}
              label="Recording"
              onTime={onTime}
              onLocked={() => {
                setLocked(true);
                lockedRef.current?.();
              }}
              control={player}
            />
          ) : (
            <p className="ao-muted">This source has no recording to play. Its transcript is shown below.</p>
          )}
        </section>
      )}

      {!locked && (
        <div className="ao-tx__toolbar">
          <label htmlFor={`${id}-version`}>Version</label>
          <select id={`${id}-version`} ref={versionPicker} value={selected ?? ""} disabled={!versions?.length} onChange={(e) => chooseVersion(e.target.value)} aria-describedby={dirty ? `${id}-dirty` : undefined}>
            {!versions?.length && <option value="">{versions ? "No transcript yet" : "Loading…"}</option>}
            {versions?.map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v)}
              </option>
            ))}
          </select>
          {dirty && (
            <>
              <button type="button" onClick={() => void save()} disabled={saving}>
                Save edits as a new version
              </button>
              <button type="button" onClick={discard} disabled={saving}>
                Discard edits
              </button>
              <span id={`${id}-dirty`} className="ao-muted">
                {saving ? "Saving…" : "Edits not saved yet."}
              </span>
            </>
          )}
        </div>
      )}

      <div role="status" className="ao-tx__notice">
        {notice}
      </div>
      {refused && dirty && (
        <p role="alert" className="ao-error">
          {UNSAVED}
        </p>
      )}
      {saveError && !locked && (
        <p role="alert" className="ao-error">
          {saveError}
        </p>
      )}
      {transcriptError && !locked && (
        <p role="alert" className="ao-error">
          {transcriptError}
        </p>
      )}

      {!locked && human && transcript?.timed && (
        <p className="ao-tx__note">
          {base?.kind === "ready"
            ? `This version was edited by a person. The checks for invented or repeated text run only on what speech recognition wrote: segments left unchanged show the flags found in the speech recognition version of ${dateText(base.at)}; segments the person changed are marked as not checked.${base.guessed ? " This edit does not record which version it was edited from, so the newest speech recognition version made before it was used." : ""}`
            : base?.kind === "unavailable"
              ? "This version was edited by a person. Flags are not available for this version: the speech recognition version it was edited from could not be read, so no segment here shows the checks' results. Open a speech recognition version under Version to see its flags."
              : "This version was edited by a person. Finding which segments the person changed…"}
        </p>
      )}
      {!locked && human && transcript && !transcript.timed && (
        <p className="ao-tx__note">This version was edited by a person as plain text, without timings. The checks for invented or repeated text did not run on it.</p>
      )}

      {!locked && selected && !transcript && !transcriptError && <p aria-live="polite">Loading the transcript…</p>}

      {!locked && transcript && !transcript.timed && (
        <section aria-label="Transcript text" className="ao-tx__whole">
          {wholeDraft === undefined ? (
            <>
              <UserText as="div" className="ao-tx__wholetext">
                {transcript.text}
              </UserText>
              <button type="button" onClick={() => setWholeDraft(transcript.text)}>
                Edit text
              </button>
            </>
          ) : (
            <>
              <label htmlFor={`${id}-whole`}>Text of this version</label>
              <textarea id={`${id}-whole`} dir="auto" rows={12} value={wholeDraft} readOnly={saving} onChange={(e) => setWholeDraft(e.target.value)} />
            </>
          )}
        </section>
      )}

      {!locked && transcript?.timed && media && (
        <div className="ao-tx__follow ao-row">
          <label>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow playback
          </label>
          {follow && !following && editing === null && current >= 0 && (
            <button type="button" onClick={backToPlaying}>
              Back to the playing segment
            </button>
          )}
        </div>
      )}

      {!locked && transcript?.timed && (
        <ol
          aria-label="Transcript segments"
          className="ao-tx__segments"
          ref={listRef}
          onWheel={() => setUserScrolled(true)}
          onTouchMove={() => setUserScrolled(true)}
          onPointerDown={(e) => {
            // The list's own scroll bar (a press on the list itself, not on a segment).
            if (e.target === e.currentTarget) setUserScrolled(true);
          }}
          onFocus={() => setFocusInside(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusInside(false);
          }}
        >
          {segments.map((s, i) => {
            const fromMachine = carried?.[i];
            const flags = s.flags ? flagLabels(s.flags) : Array.isArray(fromMachine) ? flagLabels(fromMachine) : [];
            const unchecked = fromMachine === "edited";
            const draft = drafts.get(i);
            const at = formatTime(s.start);
            const cls = ["ao-tx__seg", flags.length ? "ao-tx__seg--flagged" : "", i === current ? "ao-tx__seg--current" : ""].filter(Boolean).join(" ");
            return (
              <li
                key={`${transcript.id}-${i}`}
                className={cls}
                aria-current={i === current ? "true" : undefined}
                ref={(el) => {
                  if (el) items.current.set(i, el);
                  else items.current.delete(i);
                }}
              >
                <div className="ao-tx__meta">
                  {media ? (
                    <button type="button" className="ao-tx__time" onClick={() => seek(i)} aria-label={`Play from ${at}`}>
                      {at}
                    </button>
                  ) : (
                    <span className="ao-tx__time">{at}</span>
                  )}
                  <UserText className="ao-muted">{languageName(s.lang)}</UserText>
                  {i === current && <span className="ao-tx__now">Now playing</span>}
                  {draft !== undefined && <span className="ao-tx__edited">Edited, not saved</span>}
                </div>
                {editing === i ? (
                  <div className="ao-tx__editor">
                    <label htmlFor={`${id}-seg-${i}`}>{`Text of the segment at ${at}`}</label>
                    <textarea id={`${id}-seg-${i}`} dir="auto" lang={s.lang !== "und" ? s.lang : undefined} rows={3} autoFocus readOnly={saving} value={draft ?? s.text} onChange={(e) => setDraft(i, e.target.value)} />
                    <button type="button" onClick={() => finishEdit(i)}>
                      Done
                    </button>
                  </div>
                ) : (
                  <>
                    <UserText as="p" lang={s.lang !== "und" ? s.lang : undefined} className="ao-tx__text">
                      {draft ?? s.text}
                    </UserText>
                    <button
                      type="button"
                      className="ao-tx__edit"
                      aria-label={`Edit segment at ${at}`}
                      disabled={saving}
                      ref={(el) => {
                        if (el) editButtons.current.set(i, el);
                        else editButtons.current.delete(i);
                      }}
                      onClick={() => setEditing(i)}
                    >
                      Edit
                    </button>
                  </>
                )}
                {unchecked && <p className="ao-tx__unchecked">Edited by a person — not checked</p>}
                {flags.length > 0 && (
                  <p className="ao-tx__flags">
                    <span className="ao-tx__flag-mark" aria-hidden="true">
                      ⚑
                    </span>{" "}
                    <strong>Flagged for review:</strong> {flags.join("; ")}
                  </p>
                )}
              </li>
            );
          })}
          {segments.length === 0 && <li className="ao-muted">This version has no segments.</li>}
        </ol>
      )}

      {!locked && source && (
        <section aria-labelledby={`${id}-again`} className="ao-tx__again">
          <h2 id={`${id}-again`}>Transcribe again</h2>
          {media ? (
            <>
              <p className="ao-muted">
                Runs speech recognition on this computer again and adds the result as a new version; earlier versions are kept. This can take several minutes for a long recording. Leaving this screen does not stop it: the new version appears under Version when it finishes.
              </p>
              <div className="ao-row">
                <label htmlFor={`${id}-model`}>Speech model</label>
                <select id={`${id}-model`} value={model} disabled={busy} onChange={(e) => setModel(e.target.value as TranscriptionModel)}>
                  {TRANSCRIPTION_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {modelOptionLabel(MODEL_LABELS[m], m, installedModels)}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={transcribe} disabled={busy || installedModels?.[model] === false} aria-describedby={busy ? `${id}-run` : undefined}>
                  Re-transcribe
                </button>
              </div>
              <SpeechModelNotice model={model} installed={installedModels} />
              <div id={`${id}-run`} role="status" className="ao-tx__progress">
                {run?.state === "running" && (
                  <>
                    <progress aria-label="Transcription in progress" />
                    <p>{`Transcribing with the ${run.model} model. This can take several minutes. You can leave this screen: the transcription goes on, and the new version will appear under Version. Re-transcribe is off for this source until it finishes.`}</p>
                  </>
                )}
                {run?.state === "unknown" && (
                  <p>{`The connection to the library service was lost while transcribing with the ${run.model} model. The transcription may still be going: the new version will appear in the version list when it finishes. Re-transcribe is off for this source for the rest of this session, so the same recording is not transcribed twice while the outcome is not known.`}</p>
                )}
              </div>
              {run?.state === "unknown" && (
                <button type="button" onClick={() => void checkForNewVersions()}>
                  Check for new versions
                </button>
              )}
              {transcribeFailure && (
                <p role="alert" className="ao-error">
                  <MissingToolNotice from={failedWith}>{transcribeFailure}</MissingToolNotice>
                </p>
              )}
            </>
          ) : (
            <p className="ao-muted">This source has no recording to transcribe.</p>
          )}
        </section>
      )}
    </main>
  );
}
