/**
 * The transcript viewer (Task 34c): a source's recording and its transcript side by side.
 *
 * - The recording plays through a media ticket (MediaTicketPlayer; R135, R140). A source with no
 *   recording still shows its transcript.
 * - The segment list (time, language, text) follows playback: the segment playing is marked
 *   (`aria-current`, a visible "Now playing") and scrolled into view without moving focus; the list
 *   is not a live region, so a screen reader is not told of every change. Each segment's time is a
 *   button that moves playback there.
 * - Flagged segments carry their flags in words (spec 5.8), never colour alone. A person's edit
 *   shows the flags the service stored with it (Task 62): segments the person left unchanged keep
 *   the machine flags; edited and added ones are marked "not checked". An edit saved before flags
 *   were stored (`flagsStored: false`) marks every segment "not checked", never clean.
 * - Edits are saved as a NEW human-edit version; the version it came from is kept (the machine
 *   transcript is never overwritten). Unsaved edits are guarded against loss (leaving, closing the
 *   window, switching version); a failed save keeps the text.
 * - "Re-transcribe" starts speech recognition again as a job (Task 62): the service answers at once,
 *   progress arrives as `job.progress` events (the bar is outside the live region, so it is not
 *   announced on every event), and the job's state is read when the screen opens and whenever the
 *   event stream (re)connects, so a run started before the screen opened, or one that ended while
 *   the stream was down, is shown. "Stop transcribing" asks the service to stop it. The new version
 *   joins the version picker when it is stored.
 *
 * Every answer is checked against the project, source and request it was for, so one that arrives
 * after they changed (or after the screen closed) is dropped.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TranscriptionJob, TranscriptResponse, TranscriptSaveRequest, TranscriptVersionSummary } from "@ao/shared";
import { TRANSCRIPTION_RUNNING } from "@ao/shared";
import { ApiClientError, STREAM_OPEN_TIMEOUT_MS } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, oneNoAnswerSentence, readWithin } from "../api/firstRead";
import { errorText, isProjectLocked, type SourceFile } from "../api/library";
import { TRANSCRIPTION_MODELS, transcriptionJobOf, type TranscriptApi, type TranscriptionModel } from "../api/transcripts";
import { MediaTicketPlayer, NO_RECORDING_SENTENCE, type PlayerControl } from "../components/MediaTicketPlayer";
import { isPlayableRecording } from "../components/TranscriptLink";
import { MissingToolNotice, modelOptionLabel, SpeechModelNotice, useSpeechModels } from "../components/MissingToolNotice";
import { DEFAULT_SPEECH_MODEL, type ToolsApi } from "../api/tools";
import { UserText } from "../components/UserText";
import { blockNavigation } from "../navigation";
import { buildVtt, flagLabels, formatTime, segmentAt, versionEntries, type VersionEntry } from "./transcriptModel";
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
  /** FR-756: how long each first read (the source, its versions, the chosen version) is waited for. */
  firstReadMs?: number;
  /** FR-756 (R597): how long the event stream is waited for to open before it is closed and tried afresh. */
  streamOpenMs?: number;
}

/** FR-756: the first reads that "Try again" (and a new opening of the event stream) can make again. */
type FirstRead = "source" | "versions" | "transcript";

const MODEL_LABELS: Record<TranscriptionModel, string> = {
  tiny: "tiny (quickest, least accurate)",
  small: "small (fast)",
  medium: "medium",
  "large-v3": "large-v3 (most accurate, slowest)",
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
      return `The speech model “${model}” on this computer could not be loaded; it may be damaged. Remove it and install it again from the Optional tools screen, or choose another model.${said}`;
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

const isActive = (j: TranscriptionJob | null | undefined): j is TranscriptionJob & { status: "queued" | "running" } => j?.status === "queued" || j?.status === "running";
/** Cancelled because the project was locked: pending, it runs again at the unlock (R142). */
const lockWaiting = (j: TranscriptionJob | null | undefined): j is TranscriptionJob & { status: "cancelled" } => j?.status === "cancelled" && j.error?.code === "PROJECT_LOCKED";
/** Queued, running, or waiting to run again (after a restart or a lock): Re-transcribe stays off, Stop is offered. */
const isPending = (j: TranscriptionJob | null | undefined): j is TranscriptionJob & { status: "queued" | "running" | "cancelled" } => isActive(j) || lockWaiting(j);
const isEnded = (j: TranscriptionJob | null | undefined): j is TranscriptionJob & { status: "done" | "failed" | "cancelled" } =>
  (j?.status === "done" || j?.status === "failed" || j?.status === "cancelled") && !lockWaiting(j);

/** A job's failure as the service error it is, so the words and the missing-tool link are the same as for a refused start. */
const jobError = (j: TranscriptionJob): ApiClientError | undefined =>
  j.error ? new ApiClientError(j.error.code === "TOOL_NOT_INSTALLED" ? 409 : 502, j.error) : undefined;

/** The newest of two ISO times, or whether `a` is later than `b` (a missing `b`: true). */
const laterThan = (a: string, b: string | undefined) => b === undefined || a > b;

/** "Edited by a person — not checked" and the like, for a segment no check ran on (null: it was checked). */
function notChecked(human: boolean, s: { flags: string[] | null; edit?: string }): string | undefined {
  if (!human || s.flags !== null) return undefined;
  if (s.edit === "added") return "Added by a person — not checked";
  if (s.edit === "edited") return "Edited by a person — not checked";
  return "Not checked";
}

/**
 * A new project or source starts the viewer afresh (its player closes and revokes its ticket, and
 * nothing of the previous source is shown for even one render).
 */
export function TranscriptViewer(props: TranscriptViewerProps) {
  return <Viewer key={`${props.projectId}\u0000${props.sourceId}`} {...props} />;
}

function Viewer({ api, projectId, sourceId, onLocked, tools, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS }: TranscriptViewerProps) {
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
  /** The source's newest transcription job (Task 62): undefined until read, null when there is none. */
  const [job, setJob] = useState<TranscriptionJob | null | undefined>();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Said with the run (e.g. a start refused because one is already going). */
  const [jobNote, setJobNote] = useState<string | undefined>();
  const jobRef = useRef(job);
  jobRef.current = job;
  /**
   * FR-756: the first reads that got no answer (none in time, or the service could not be reached), each with the
   * error's own sentence — "did not answer in time" or "could not be reached", never both run together (R586 M5).
   */
  const [unanswered, setUnanswered] = useState<Partial<Record<FirstRead, string>>>({});
  /** The first reads now in the air (one may never settle). */
  const out = useRef(new Set<FirstRead>());
  /** Bumped to make one first read again ("Try again", or a new opening of the stream). */
  const [tries, setTries] = useState<Record<FirstRead, number>>({ source: 0, versions: 0, transcript: 0 });
  /** The versions have been read once: until then a failed read's empty list is not shown while it is read again. */
  const versionsRead = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

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

  /** The version list's read in the air: a newer one (or leaving the screen) cancels it. */
  const listAc = useRef<AbortController | null>(null);
  useEffect(() => () => listAc.current?.abort(), []);
  /**
   * Reads the version list; `choose` picks a version (by id, or by a stored file's path) when it is in it. Given up after
   * `firstReadMs` as a read that got no answer (FR-756).
   */
  const loadVersions = useCallback(
    async (choose?: { id?: string; paths?: string[] }) => {
      const mine = ++listSeq.current;
      const k = keyRef.current;
      listAc.current?.abort();
      const ac = new AbortController();
      listAc.current = ac;
      out.current.add("versions");
      const settled = () => {
        if (listAc.current === ac) out.current.delete("versions");
      };
      try {
        const r = await readWithin((signal) => apiRef.current.versions(projectId, sourceId, { signal }), firstReadMs, ac.signal);
        settled();
        if (!mounted.current || k !== keyRef.current || mine !== listSeq.current) return;
        versionsRead.current = true;
        // R602 (a): an answered read takes away its earlier give-up sentence.
        setUnanswered(({ versions: _v, ...u }) => u);
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
        settled();
        if (!mounted.current || k !== keyRef.current || mine !== listSeq.current) return;
        if (isUnreachable(err)) setUnanswered((u) => ({ ...u, versions: (err as ApiClientError).message }));
        else {
          setUnanswered(({ versions: _v, ...u }) => u);
          if (!sawLocked(err)) setLoadError(errorText(err, "The transcript versions could not be read."));
        }
        setVersions((v) => v ?? []);
      }
    },
    [projectId, sourceId, sawLocked, firstReadMs],
  );

  // The source, once (a new source is a new Viewer); again after "Try again" or a new opening of the stream (FR-756).
  useEffect(() => {
    const k = key;
    const ac = new AbortController();
    out.current.add("source");
    readWithin((signal) => apiRef.current.source(projectId, sourceId, { signal }), firstReadMs, ac.signal).then(
      (f) => {
        if (ac.signal.aborted) return;
        out.current.delete("source");
        if (!mounted.current || k !== keyRef.current) return;
        setUnanswered(({ source: _s, ...u }) => u);
        setSource(f);
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        out.current.delete("source");
        if (!mounted.current || k !== keyRef.current) return;
        if (isUnreachable(err)) setUnanswered((u) => ({ ...u, source: (err as ApiClientError).message }));
        else {
          setUnanswered(({ source: _s, ...u }) => u);
          if (!sawLocked(err)) setLoadError(errorText(err, "This source could not be read."));
        }
      },
    );
    return () => {
      ac.abort();
      out.current.delete("source");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, tries.source]);
  // Its versions, likewise.
  useEffect(() => {
    void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, tries.versions]);

  // The chosen version's segments.
  useEffect(() => {
    if (!selected) return;
    const mine = ++readSeq.current;
    const k = keyRef.current;
    setTranscript(undefined);
    setTranscriptError(undefined);
    setUnanswered(({ transcript: _t, ...u }) => u);
    const ac = new AbortController();
    out.current.add("transcript");
    readWithin((signal) => apiRef.current.read(projectId, sourceId, selected, { signal }), firstReadMs, ac.signal).then(
      (t) => {
        if (ac.signal.aborted) return;
        out.current.delete("transcript");
        if (!mounted.current || k !== keyRef.current || mine !== readSeq.current) return;
        setTranscript(t);
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        out.current.delete("transcript");
        if (!mounted.current || k !== keyRef.current || mine !== readSeq.current) return;
        if (isUnreachable(err)) setUnanswered((u) => ({ ...u, transcript: (err as ApiClientError).message }));
        else if (!sawLocked(err)) setTranscriptError(errorText(err, "This version could not be read."));
      },
    );
    return () => {
      ac.abort();
      out.current.delete("transcript");
    };
  }, [selected, projectId, sourceId, sawLocked, attempt, firstReadMs, tries.transcript]);

  /**
   * FR-756: makes again each first read that got no answer, and (`stillOut`) each still in the air — after the event
   * stream was lost, one may never settle. Its words go meanwhile, so the loading words show.
   */
  const readAgain = useCallback((stillOut: boolean) => {
    const again = new Set<FirstRead>([...(Object.keys(unansweredRef.current) as FirstRead[]), ...(stillOut ? out.current : [])]);
    if (!again.size) return;
    if (again.has("versions") && !versionsRead.current) setVersions(undefined);
    setUnanswered((u) => Object.fromEntries(Object.entries(u).filter(([r]) => !again.has(r as FirstRead))));
    setTries((t) => ({ source: t.source + (again.has("source") ? 1 : 0), versions: t.versions + (again.has("versions") ? 1 : 0), transcript: t.transcript + (again.has("transcript") ? 1 : 0) }));
  }, []);
  const unansweredRef = useRef(unanswered);
  unansweredRef.current = unanswered;

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

  // ---- transcription as a job (Task 62) ----

  /**
   * Takes a job's state, from an event, a read or a start. An answer older than what is shown (the
   * same job updated earlier, or an older job) is dropped, so a slow read never undoes an event.
   */
  const accept = useCallback((j: TranscriptionJob | null) => {
    if (!mounted.current) return;
    setJob((prev) => {
      if (!j) return prev ?? null;
      if (prev && prev.jobId === j.jobId && j.updatedAt < prev.updatedAt) return prev;
      if (prev && prev.jobId !== j.jobId && j.startedAt < prev.startedAt) return prev;
      return j;
    });
  }, []);

  const jobSeq = useRef(0);
  /** Reads the source's newest job; returns it (undefined when the read failed or was overtaken). */
  const readJob = useCallback(async (): Promise<TranscriptionJob | null | undefined> => {
    const mine = ++jobSeq.current;
    const k = keyRef.current;
    try {
      const r = await apiRef.current.transcription(projectId, sourceId);
      if (!mounted.current || k !== keyRef.current || mine !== jobSeq.current) return undefined;
      accept(r.job);
      return r.job;
    } catch (err) {
      if (mounted.current && k === keyRef.current) sawLocked(err);
      return undefined;
    }
  }, [projectId, sourceId, accept, sawLocked]);

  // The job's state on opening, and its events while the screen is open: each (re)connection of the
  // stream reads the state again, so nothing that happened while it was down is missed.
  // FR-756 (R597): a stream not opened within `streamOpenMs` is closed and tried afresh after the same pause; at an
  // opening after the first try, the first reads still out or unanswered are made again, without waiting for an event.
  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let opens = 0;
    void readJob();
    const listen = async () => {
      const again = opens++ > 0;
      const onOpen = () => {
        void readJob();
        if (again) readAgain(true);
      };
      try {
        for await (const e of apiRef.current.events({ signal: ac.signal, onOpen, openWithinMs: streamOpenMs })) {
          if (e.type !== "job.progress") continue;
          const j = transcriptionJobOf(e.data);
          if (j && j.projectId === projectId && j.sourceId === sourceId) accept(j);
          // A bare end of the run shown (one that ended after a lock): its state is read again.
          else if (!j && (e.data as { kind?: unknown; jobId?: unknown } | null)?.kind === "transcription" && (e.data as { jobId?: unknown }).jobId === jobRef.current?.jobId) void readJob();
        }
      } catch {
        // the stream dropped, or did not open in time (FR-756): listen again shortly
      }
      if (!ac.signal.aborted) retry = setTimeout(() => void listen(), 2000);
    };
    void listen();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, streamOpenMs]);

  const transcribeButton = useRef<HTMLButtonElement | null>(null);
  const stopButton = useRef<HTMLButtonElement | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  /** Move focus to Stop once the run shows (the Re-transcribe button pressed is turned off). */
  const focusStop = useRef(false);
  /** Jobs this screen saw queued or running: their end is told once. */
  const seen = useRef(new Set<string>());
  const told = useRef(new Set<string>());

  useEffect(() => {
    if (isPending(job)) {
      seen.current.add(job.jobId);
      if (focusStop.current) {
        focusStop.current = false;
        stopButton.current?.focus();
      }
      return;
    }
    stoppingRef.current = false;
    setStopping(false);
    if (!isEnded(job) || !seen.current.has(job.jobId) || told.current.has(job.jobId)) return;
    told.current.add(job.jobId);
    if (job.status === "done") {
      const n = job.result?.flaggedSegments;
      const flagged = n === undefined ? "" : ` (${n === 1 ? "1 segment is" : `${n} segments are`} flagged for review)`;
      setNotice(`The new transcript is ready${flagged}. ${dirtyRef.current ? "It is listed under Version." : "It is shown below."}`);
      void loadVersions({ paths: job.result?.files ?? [] });
    }
    // The Stop button went away with the run: focus is not left on nothing.
    if (!document.activeElement || document.activeElement === document.body) transcribeButton.current?.focus();
  }, [job, loadVersions]);

  const transcribe = async () => {
    if (isPending(job) || startingRef.current) return;
    startingRef.current = true;
    const chosen = model;
    focusStop.current = document.activeElement === transcribeButton.current;
    setStarting(true);
    setTranscribeFailure(undefined);
    setFailedWith(undefined);
    setNotice(undefined);
    setJobNote(undefined);
    try {
      const r = await apiRef.current.transcribe(projectId, sourceId, { model: chosen });
      accept(r.job);
    } catch (err) {
      if (!mounted.current) return;
      const running = err instanceof ApiClientError && err.reason === TRANSCRIPTION_RUNNING;
      const lost = err instanceof ApiClientError && err.status === 0;
      if (running || lost) {
        // The run already going, or the one this request may have started: shown, never started twice.
        const now = await readJob();
        if (!mounted.current) return;
        if (isPending(now)) {
          if (running) setJobNote("This recording is already being transcribed; that run is shown here.");
          return;
        }
        // No run to show (M3): the service's own words are said, never nothing.
      }
      focusStop.current = false;
      if (!sawLocked(err)) {
        setTranscribeFailure(transcribeError(err, chosen));
        setFailedWith(err);
      }
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  };

  const stop = async () => {
    const j = job;
    if (!isPending(j) || stoppingRef.current || j.cancelRequested) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const r = await apiRef.current.cancelTranscription(projectId, j.jobId);
      accept(r.job);
    } catch (err) {
      if (!mounted.current) return;
      stoppingRef.current = false;
      setStopping(false);
      if (!sawLocked(err)) setNotice(`The transcription could not be stopped. ${errorText(err, "The library service did not answer.")}`);
    }
  };

  const busy = isPending(job) || starting;
  const newestVersionAt = versions?.reduce<string | undefined>((m, v) => (v.at && (m === undefined || v.at > m) ? v.at : m), undefined);
  // A run that ended badly: told when this screen saw it run, or when it is newer than the newest version.
  const jobFailure = job && (job.status === "failed" || job.status === "cancelled") && job.error && (seen.current.has(job.jobId) || laterThan(job.updatedAt, newestVersionAt)) ? job : undefined;
  const failureText = transcribeFailure ?? (jobFailure ? transcribeError(jobError(jobFailure), jobFailure.model ?? model) : undefined);
  const failureFrom = transcribeFailure ? failedWith : jobFailure ? jobError(jobFailure) : undefined;
  const media = useMemo(() => source?.assets.find(isPlayableRecording), [source]);
  const title = source?.source.title.variants[0];
  const human = transcript?.origin === "human-edit";
  /** FR-756, R602 M1: one sentence for the first reads that got no answer ("could not be reached" wins). */
  const noAnswer = oneNoAnswerSentence(Object.values(unanswered));

  return (
    <main className="ao-page ao-tx" aria-labelledby={`${id}-h`}>
      <h1 id={`${id}-h`} ref={headingRef} tabIndex={-1}>
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
                setUnanswered({});
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
      {!locked && noAnswer !== undefined && (
        <>
          <p role="alert" className="ao-error">
            {noAnswer}
          </p>
          <p>
            <button
              type="button"
              onClick={() => {
                // The button goes while the reads are made again: focus waits on the heading, never the page.
                headingRef.current?.focus();
                readAgain(false);
              }}
            >
              Try again
            </button>
          </p>
        </>
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
            <p className="ao-muted">{NO_RECORDING_SENTENCE}</p>
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
          {transcript.flagsStored
            ? "This version was edited by a person. The checks for invented or repeated text run only on what speech recognition wrote: segments left unchanged show the flags found by speech recognition; segments the person changed or added are marked as not checked."
            : "This version was edited by a person before the app recorded which segments were changed, so no segment here shows the checks' results: every segment is marked as not checked. Open a speech recognition version under Version to see its flags."}
        </p>
      )}
      {!locked && human && transcript && !transcript.timed && (
        <p className="ao-tx__note">This version was edited by a person as plain text, without timings. The checks for invented or repeated text did not run on it.</p>
      )}

      {!locked && selected && !transcript && !transcriptError && !unanswered.transcript && <p aria-live="polite">Loading the transcript…</p>}

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
            const flags = s.flags ? flagLabels(s.flags) : [];
            const unchecked = notChecked(human, s);
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
                {unchecked && <p className="ao-tx__unchecked">{unchecked}</p>}
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
                <button
                  type="button"
                  ref={transcribeButton}
                  onClick={() => void transcribe()}
                  disabled={busy || installedModels?.[model] === false}
                  aria-describedby={busy ? `${id}-run` : undefined}
                >
                  Re-transcribe
                </button>
              </div>
              <SpeechModelNotice model={model} installed={installedModels} />
              <div id={`${id}-run`} role="status" className="ao-tx__progress">
                {isPending(job) &&
                  (job.cancelRequested || stopping
                    ? "Stopping the transcription… The media helper is asked to stop; nothing of this run is saved."
                    : lockWaiting(job)
                      ? `${job.error?.message ?? "The project was locked before the transcription could finish. It runs again when the project is unlocked."} Re-transcribe is off for this source until then.`
                      : job.waiting
                        ? `The transcription with the ${job.model ?? "chosen"} model is not running in this session of the app: it was interrupted, or it is still finishing after the project was locked. It runs again, or finishes, by itself, and the new version will appear under Version. Re-transcribe is off for this source until then.`
                        : `Transcribing with the ${job.model ?? "chosen"} model. This can take several minutes. You can leave this screen: the transcription goes on, and the new version will appear under Version. Re-transcribe is off for this source until it finishes.`)}
                {isPending(job) && jobNote && ` ${jobNote}`}
              </div>
              {isPending(job) && (
                <div className="ao-row">
                  {!isActive(job) || job.waiting ? null : job.progress === undefined ? (
                    <progress aria-label="Transcription in progress" />
                  ) : (
                    <progress aria-label="Transcription in progress" max={1} value={job.progress} />
                  )}
                  <button type="button" ref={stopButton} onClick={() => void stop()} disabled={stopping || job.cancelRequested === true}>
                    Stop transcribing
                  </button>
                </div>
              )}
              {failureText && !busy && (
                <p role="alert" className="ao-error">
                  <MissingToolNotice from={failureFrom}>{failureText}</MissingToolNotice>
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
