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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TranscriptResponse, TranscriptSaveRequest } from "@ao/shared";
import { ApiClientError } from "../api/client";
import { errorText, isProjectLocked, type SourceFile } from "../api/library";
import { TRANSCRIPTION_MODELS, type TranscriptApi, type TranscriptionModel } from "../api/transcripts";
import { MediaTicketPlayer, type PlayerControl } from "../components/MediaTicketPlayer";
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
}

const MODEL_LABELS: Record<TranscriptionModel, string> = {
  "large-v3": "large-v3 (most accurate, slowest)",
  medium: "medium",
  small: "small (fastest)",
};

const LOCKED = "This project is locked. Unlock it in the library to see this transcript.";
const UNSAVED = "You have edits that are not saved. Save them as a new version or discard them first.";

/** A language code in words ("en" → "English"); "und" → "Language not known". */
function languageName(code: string): string {
  if (!code || code === "und") return "Language not known";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (name && name !== code) return name;
  } catch {
    /* not a code Intl knows */
  }
  return code;
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

/** Plain words for a failed transcription, with what the service reported. */
function transcribeError(err: unknown, model: string): string {
  if (!(err instanceof ApiClientError)) return "Transcription could not be started.";
  const said = err.message ? ` The service said: “${err.message}”` : "";
  switch (err.reason) {
    case "MODEL_UNAVAILABLE":
      return `The speech model “${model}” is not installed and could not be downloaded. Connect to the internet and try again, or choose a model that is already installed.${said}`;
    case "FFMPEG_FAILED":
      return `The sound could not be read from the recording: the audio tool (ffmpeg) is missing or failed.${said}`;
    case "UNSUPPORTED_INPUT":
      return `The recording has no sound the speech tool can read.${said}`;
    case "INPUT_NOT_FOUND":
      return `The recording's file could not be found in the library.${said}`;
    case "INVALID_PARAMS":
      return `The speech tool refused these settings on this computer.${said}`;
  }
  if (err.code === "WORKER_UNAVAILABLE") return `The media helper that runs speech recognition is not running. ${err.message}`.trim();
  return errorText(err, "Transcription failed.");
}

type Drafts = ReadonlyMap<number, string>;

/**
 * A new project or source starts the viewer afresh (its player closes and revokes its ticket, and
 * nothing of the previous source is shown for even one render).
 */
export function TranscriptViewer(props: TranscriptViewerProps) {
  return <Viewer key={`${props.projectId}\u0000${props.sourceId}`} {...props} />;
}

function Viewer({ api, projectId, sourceId, onLocked }: TranscriptViewerProps) {
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
  const [loadError, setLoadError] = useState<string | undefined>();
  const [versions, setVersions] = useState<VersionEntry[] | undefined>();
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
  const [model, setModel] = useState<TranscriptionModel>("medium");
  const [transcribing, setTranscribing] = useState<TranscriptionModel | null>(null);
  const [transcribeFailure, setTranscribeFailure] = useState<string | undefined>();

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
  }, [key]);

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
  }, [selected, projectId, sourceId, sawLocked]);

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

  // The segment playing is brought into view (never focused: focus stays where the person put it).
  useEffect(() => {
    if (current < 0 || editing !== null) return;
    const el = items.current.get(current);
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [current, editing]);

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

  const discard = () => {
    setDrafts(new Map());
    setWholeDraft(undefined);
    setEditing(null);
    setSaveError(undefined);
    setRefused(false);
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
      await loadVersions({ id: r.id });
    } catch (err) {
      if (!mounted.current || k !== keyRef.current || mine !== actionSeq.current) return;
      // The edits stay on screen even when the project was locked meanwhile.
      if (isProjectLocked(err)) lockedRef.current?.();
      setSaveError(`Your edits were not saved and are still here. ${errorText(err, "The library service did not answer.")}`);
    } finally {
      if (mounted.current && k === keyRef.current && mine === actionSeq.current) setSaving(false);
    }
  };

  const transcribe = async () => {
    if (transcribing) return;
    const chosen = model;
    const k = keyRef.current;
    setTranscribing(chosen);
    setTranscribeFailure(undefined);
    setNotice(undefined);
    try {
      const r = await apiRef.current.transcribe(projectId, sourceId, { model: chosen });
      if (!mounted.current || k !== keyRef.current) return;
      const flagged = r.flaggedSegments === 1 ? "1 segment is" : `${r.flaggedSegments} segments are`;
      setNotice(`The new transcript is ready (${flagged} flagged for review). ${dirtyRef.current ? "It is listed under Version." : "It is shown below."}`);
      await loadVersions({ paths: r.files });
    } catch (err) {
      if (!mounted.current || k !== keyRef.current) return;
      if (isProjectLocked(err)) lockedRef.current?.();
      setTranscribeFailure(transcribeError(err, chosen));
    } finally {
      if (mounted.current && k === keyRef.current) setTranscribing(null);
    }
  };

  const media = useMemo(() => source?.assets.find((a) => a.role === "original" && a.status !== "destroyed" && typeof a.mime === "string" && /^(audio|video)\//i.test(a.mime)), [source]);
  const title = source?.source.title.variants[0];
  const human = transcript?.origin === "human-edit";

  return (
    <main className="ao-page ao-tx" aria-labelledby={`${id}-h`}>
      <h1 id={`${id}-h`}>
        Transcript{title?.value ? ": " : ""}
        {title?.value && <UserText lang={title.lang}>{title.value}</UserText>}
      </h1>

      {locked && (
        <p role="alert" className="ao-error">
          {LOCKED}
        </p>
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
              asset={{ id: media.id, mime: media.mime ?? "" }}
              label="Recording"
              onTime={onTime}
              onLocked={() => {
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
          <select id={`${id}-version`} value={selected ?? ""} disabled={!versions?.length} onChange={(e) => chooseVersion(e.target.value)} aria-describedby={dirty ? `${id}-dirty` : undefined}>
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
      {saveError && (
        <p role="alert" className="ao-error">
          {saveError}
        </p>
      )}
      {transcriptError && (
        <p role="alert" className="ao-error">
          {transcriptError}
        </p>
      )}

      {!locked && human && (
        <p className="ao-tx__note">
          This version was edited by a person. The checks for invented or repeated text run only on what speech recognition wrote, so a person's edit was not checked.
        </p>
      )}

      {!locked && selected && !transcript && !transcriptError && <p aria-live="polite">Loading the transcript…</p>}

      {transcript && !transcript.timed && (
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

      {transcript?.timed && (
        <ol aria-label="Transcript segments" className="ao-tx__segments">
          {segments.map((s, i) => {
            const flags = s.flags ? flagLabels(s.flags) : [];
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
              <p className="ao-muted">Runs speech recognition on this computer again and adds the result as a new version. Earlier versions are kept.</p>
              <div className="ao-row">
                <label htmlFor={`${id}-model`}>Speech model</label>
                <select id={`${id}-model`} value={model} disabled={transcribing !== null} onChange={(e) => setModel(e.target.value as TranscriptionModel)}>
                  {TRANSCRIPTION_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {MODEL_LABELS[m]}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => void transcribe()} disabled={transcribing !== null}>
                  Re-transcribe
                </button>
              </div>
              {transcribing && (
                <div className="ao-tx__progress" role="status">
                  <progress aria-label="Transcription in progress" />
                  <p>{`Transcribing with the ${transcribing} model. This can take several minutes for a long recording; you can keep reading and listening meanwhile.`}</p>
                </div>
              )}
              {transcribeFailure && (
                <p role="alert" className="ao-error">
                  {transcribeFailure}
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
