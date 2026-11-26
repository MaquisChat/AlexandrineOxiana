/**
 * The work lines (whole channels, R668, R669, R672): one block per download run of the project and one line for its
 * transcription list, wherever the project is open (the Library and Capture screens). Every sentence comes from
 * @ao/shared (`runLines`, `transcriptionLines` and the fixed texts); titles, addresses and the service's and platform's
 * words go through UserText.
 *
 * Both lists are read at the opening and at every opening of the event stream; `background.progress` events of this
 * project keep them current. The stream is followed only while there is something to show (no run and an idle list
 * show nothing and open no stream); a screen that starts work mounts the lines afresh (a new `key`). The stream follows R597, R641 D2, R658 and R659 as the import's run step does: an opening
 * limit and a silence limit, two reconnects 300 ms apart, and the count of tries starts again only when a connection
 * proved itself (an event of this project arrived on it, or it stayed open and silent to the silence limit). A service
 * that does not know the two routes (404) has nothing to show: the section stays quiet.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LIST_BUTTONS,
  LIST_STOPPED_TEXT,
  PROBLEMS_TEXT,
  RUN_BUTTONS,
  WORK_LINES_TEXT,
  platformSays,
  problemLine,
  runLines,
  transcriptionLines,
  type DownloadProblemsResponse,
  type DownloadRunSummary,
  type TranscriptionListSummary,
} from "@ao/shared";
import { backgroundApi, backgroundProgress } from "../api/background";
import { ApiClientError, STREAM_OPEN_TIMEOUT_MS, STREAM_QUIET_TIMEOUT_MS, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, readWithin } from "../api/firstRead";
import { errorText } from "../api/library";
import { UserText } from "./UserText";
import "./WorkLines.css";

export interface WorkLinesProps {
  client: ApiClient;
  projectId: string;
  /** R597: how long the event stream is waited for to open before it is closed and tried afresh (smaller in tests). */
  streamOpenMs?: number;
  /** R641 D2: how long an open event stream may deliver nothing before it is closed and tried afresh (smaller in tests). */
  streamQuietMs?: number;
}

/** Reconnects after the event stream ends (then the notice and "Reconnect"). */
const RECONNECTS = 2;
const RECONNECT_DELAY_MS = 300;
/** R658 M3: a title line is told to a screen reader at most this often. */
const SAY_EVERY_MS = 5_000;

const RUNNING = new Set(["queued", "downloading", "waiting"]);

/** The service does not know the route (an older service): nothing to show. */
const unknownRoute = (err: unknown) => err instanceof ApiClientError && err.status === 404;

const newestFirst = (runs: DownloadRunSummary[]) => [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));

/** A run's state as read, unless the one already held is newer (an event that came while the read was out). */
function merge(held: DownloadRunSummary[], read: DownloadRunSummary[]): DownloadRunSummary[] {
  const byId = new Map(held.map((r) => [r.runId, r]));
  return newestFirst(read.map((r) => {
    const h = byId.get(r.runId);
    return h && h.updatedAt > r.updatedAt ? h : r;
  }));
}

function upsert(held: DownloadRunSummary[], run: DownloadRunSummary): DownloadRunSummary[] {
  const h = held.find((r) => r.runId === run.runId);
  if (h && h.updatedAt > run.updatedAt) return held;
  return newestFirst([...held.filter((r) => r.runId !== run.runId), run]);
}

/** A sentence with the outside words in it (a title) shown through UserText; the rest is the app's own. */
function Sentence({ text, part }: { text: string; part: string | undefined }): ReactNode {
  const at = part ? text.indexOf(part) : -1;
  if (!part || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <UserText>{part}</UserText>
      {text.slice(at + part.length)}
    </>
  );
}

/**
 * R658 M3: the line as told to a screen reader, at most every SAY_EVERY_MS, the last state always said in the end. The
 * line as first read is shown, not told: only its changes are.
 */
function useSaid(text: string | undefined): string {
  const [said, setSaid] = useState("");
  const saidAt = useRef(Number.NEGATIVE_INFINITY);
  const opening = useRef<string | undefined | null>(text);
  useEffect(() => {
    if (text === undefined) return;
    if (opening.current !== null && text === opening.current) return;
    opening.current = null;
    const say = () => {
      saidAt.current = Date.now();
      setSaid(text);
    };
    const wait = saidAt.current + SAY_EVERY_MS - Date.now();
    if (wait <= 0) return say();
    const t = setTimeout(say, wait);
    return () => clearTimeout(t);
  }, [text]);
  return said;
}

function Said({ text }: { text: string | undefined }) {
  const said = useSaid(text);
  return (
    <p className="ao-visually-hidden ao-worklines__said" role="status">
      {said}
    </p>
  );
}

interface ProblemsView {
  data?: DownloadProblemsResponse;
  error?: string;
  copied?: string;
}

export function WorkLines({ client, projectId, streamOpenMs = STREAM_OPEN_TIMEOUT_MS, streamQuietMs = STREAM_QUIET_TIMEOUT_MS }: WorkLinesProps) {
  const api = useMemo(() => backgroundApi(client), [client]);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [runs, setRuns] = useState<DownloadRunSummary[]>([]);
  const [list, setList] = useState<TranscriptionListSummary | null>(null);
  const [stopped, setStopped] = useState(false);
  /** After a Discard or a Stop here, the section stays while focus is on its heading (even with nothing left in it). */
  const [keep, setKeep] = useState(false);
  const [lost, setLost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyNow = useRef(new Set<string>());
  const [problems, setProblems] = useState<Record<string, ProblemsView>>({});
  const focusHeading = useRef(false);
  /** The project shown now: an answer for another one (or after unmount) changes nothing. */
  const current = useRef<string | null>(projectId);
  current.current = projectId;
  useEffect(() => {
    current.current = projectId;
    return () => {
      current.current = null;
    };
  }, [projectId]);

  // A new project starts from nothing.
  useEffect(() => {
    setRuns([]);
    setList(null);
    setStopped(false);
    setKeep(false);
    setLost(false);
    setError(null);
    setProblems({});
    busyNow.current = new Set();
    setBusy(new Set());
  }, [projectId]);

  useEffect(() => {
    if (focusHeading.current) {
      focusHeading.current = false;
      heading.current?.focus();
    }
  });

  /** Both lists, read for `pid`; dropped when the project changed or the read was cancelled. */
  const read = useCallback(
    (pid: string, signal: AbortSignal) => {
      const mine = () => !signal.aborted && current.current === pid;
      void readWithin((s) => api.downloads(pid, { signal: s }), FIRST_READ_TIMEOUT_MS, signal).then(
        (read) => mine() && setRuns((held) => merge(held, read.filter((r) => r.projectId === pid))),
        (err: unknown) => mine() && unknownRoute(err) && setRuns([]),
      );
      void readWithin((s) => api.transcriptionList(pid, { signal: s }), FIRST_READ_TIMEOUT_MS, signal).then(
        (l) => {
          if (!mine()) return;
          setList(l);
          if (l.total > 0) setStopped(false);
        },
        (err: unknown) => mine() && unknownRoute(err) && setList(null),
      );
    },
    [api],
  );

  const mine = runs.filter((r) => r.projectId === projectId);
  const listOfProject = list && list.projectId === projectId ? list : null;
  const listLines = listOfProject ? transcriptionLines(listOfProject) : {};
  const anything = mine.length > 0 || listLines.title !== undefined;
  /**
   * The event stream is followed while the section shows something. With nothing to show, the lists are read once (a
   * screen that starts work here mounts the lines afresh, with a new `key`, so that they are read again).
   */
  const following = anything || stopped || keep;

  // The lists as they stand at the opening.
  useEffect(() => {
    const ctl = new AbortController();
    read(projectId, ctl.signal);
    return () => ctl.abort();
  }, [projectId, read]);

  useEffect(() => {
    if (!following) return;
    const ctl = new AbortController();
    let stop = false;
    const pid = projectId;
    (async () => {
      // R658, R659: the tries in a row that did not prove themselves. A connection proves itself by delivering a
      // `background.progress` event of this project, or by staying open and silent to its quiet limit. Any other event
      // (the service's opening `library.state`, another project's) proves nothing; nor does a stream that closes at once,
      // or never opens.
      let tries = 0;
      while (!stop) {
        let opened = false;
        let proved = false;
        try {
          const onOpen = () => {
            opened = true;
            // With the stream open, nothing published from here on is missed.
            read(pid, ctl.signal);
          };
          for await (const ev of client.events({ signal: ctl.signal, onOpen, openWithinMs: streamOpenMs, quietWithinMs: streamQuietMs })) {
            if (stop) return;
            const e = backgroundProgress(ev, pid);
            if (!e) continue;
            proved = true;
            if (e.downloads) {
              const run = e.downloads;
              setRuns((held) => upsert(held, run));
            }
            if (e.discarded !== undefined) {
              const gone = e.discarded;
              setRuns((held) => held.filter((r) => r.runId !== gone));
            }
            if (e.transcriptions) {
              const l = e.transcriptions;
              setList(l);
              if (l.total > 0) setStopped(false);
            }
          }
        } catch (err) {
          // Once open, the client's "did not answer in time" is only its quiet limit: the stream was open and silent to it.
          if (opened && isNoAnswerInTime(err)) proved = true;
        }
        if (stop || ctl.signal.aborted) return;
        if (proved) tries = 0;
        else if (tries++ >= RECONNECTS) {
          setLost(true);
          return;
        }
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    })();
    return () => {
      stop = true;
      ctl.abort();
    };
  }, [client, projectId, read, attempt, streamOpenMs, streamQuietMs, following]);

  /** One request at a time per line (a double press sends one), its answer dropped if the project changed. */
  const act = async <T,>(key: string, call: () => Promise<T>, then: (answer: T) => void) => {
    if (busyNow.current.has(key)) return;
    busyNow.current.add(key);
    setBusy(new Set(busyNow.current));
    setError(null);
    const pid = projectId;
    try {
      const answer = await call();
      if (current.current === pid) then(answer);
    } catch (err) {
      if (current.current === pid) setError(errorText(err, "That could not be done. Try again."));
    } finally {
      if (current.current === pid) {
        busyNow.current.delete(key);
        setBusy(new Set(busyNow.current));
      }
    }
  };

  const runAction = (run: DownloadRunSummary, what: "pause" | "stop" | "resume") =>
    void act(`run:${run.runId}`, () => api.runAction(projectId, run.runId, what), (r) => setRuns((held) => upsert(held, r)));

  const discard = (run: DownloadRunSummary) =>
    void act(`run:${run.runId}`, () => api.discard(projectId, run.runId), () => {
      setRuns((held) => held.filter((r) => r.runId !== run.runId));
      setKeep(true);
      focusHeading.current = true;
    });

  const listAction = (what: "pause" | "continue" | "stop") =>
    void act("list", () => api.listAction(projectId, what), (l) => {
      setList(l);
      if (what === "stop") {
        setStopped(true);
        setKeep(true);
        focusHeading.current = true;
      }
    });

  const showProblems = (run: DownloadRunSummary) => {
    if (problems[run.runId]) {
      setProblems(({ [run.runId]: _closed, ...rest }) => rest);
      return;
    }
    setProblems((p) => ({ ...p, [run.runId]: {} }));
    const pid = projectId;
    api.problems(pid, run.runId).then(
      (data) => current.current === pid && setProblems((p) => (p[run.runId] ? { ...p, [run.runId]: { data } } : p)),
      (err: unknown) => current.current === pid && setProblems((p) => (p[run.runId] ? { ...p, [run.runId]: { error: errorText(err, "The list could not be read. Try again.") } } : p)),
    );
  };

  const copy = async (run: DownloadRunSummary, data: DownloadProblemsResponse) => {
    const text = data.problems.map((p) => problemLine(p, data.platform)).join("\n");
    let said: string = PROBLEMS_TEXT.copied;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
    } catch {
      said = PROBLEMS_TEXT.copyFailed;
    }
    setProblems((p) => (p[run.runId] ? { ...p, [run.runId]: { ...p[run.runId], copied: said } } : p));
  };

  if (!following) return null;

  return (
    <section className="ao-worklines" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        {WORK_LINES_TEXT.heading}
      </h2>
      {stopped && <p role="status">{LIST_STOPPED_TEXT}</p>}
      {error && (
        <div className="ao-worklines__error" role="alert">
          <UserText as="p">{error}</UserText>
        </div>
      )}
      {lost && anything && (
        <div className="ao-worklines__note" role="alert">
          <p>{WORK_LINES_TEXT.lost}</p>
          <button
            type="button"
            onClick={() => {
              setLost(false);
              setAttempt((n) => n + 1);
            }}
          >
            {WORK_LINES_TEXT.reconnect}
          </button>
        </div>
      )}
      {mine.length > 0 && (
        <ul className="ao-worklines__runs">
          {mine.map((run) => (
            <RunLine
              key={run.runId}
              run={run}
              busy={busy.has(`run:${run.runId}`)}
              problems={problems[run.runId]}
              onAction={(what) => runAction(run, what)}
              onDiscard={() => discard(run)}
              onShowProblems={() => showProblems(run)}
              onCopy={(data) => void copy(run, data)}
            />
          ))}
        </ul>
      )}
      {listOfProject && listLines.title !== undefined && (
        <ListLine list={listOfProject} title={listLines.title} time={listLines.time} busy={busy.has("list")} onAction={listAction} />
      )}
    </section>
  );
}

function RunLine({
  run,
  busy,
  problems,
  onAction,
  onDiscard,
  onShowProblems,
  onCopy,
}: {
  run: DownloadRunSummary;
  busy: boolean;
  problems: ProblemsView | undefined;
  onAction(what: "pause" | "stop" | "resume"): void;
  onDiscard(): void;
  onShowProblems(): void;
  onCopy(data: DownloadProblemsResponse): void;
}) {
  const id = useId();
  const lines = runLines(run);
  const running = RUNNING.has(run.state);
  /** A run that completed everything says so and has no button (the spec's sketch). */
  const allDone = run.state === "finished" && run.failed === 0 && run.notCompleted === 0;
  const problemsHeading = useRef<HTMLHeadingElement>(null);
  const open = problems !== undefined;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) problemsHeading.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const describe = { "aria-describedby": `${id}-title` };
  return (
    <li className="ao-worklines__run">
      <p id={`${id}-title`} className="ao-worklines__title">
        <Sentence text={lines.title} part={run.title} />
      </p>
      <Said text={lines.title} />
      {lines.wait && <p className="ao-worklines__detail">{lines.wait}</p>}
      {lines.failures && <p className="ao-worklines__detail">{lines.failures}</p>}
      {lines.why && (
        <p className="ao-worklines__detail">
          {run.state === "failed" ? <UserText>{lines.why}</UserText> : lines.why}
        </p>
      )}
      {!allDone && (
        <div className="ao-worklines__actions">
          {(run.state === "downloading" || run.state === "waiting") && (
            <button type="button" disabled={busy} {...describe} onClick={() => onAction("pause")}>
              {RUN_BUTTONS.pause}
            </button>
          )}
          {running && (
            <button type="button" disabled={busy} {...describe} onClick={() => onAction("stop")}>
              {RUN_BUTTONS.stop}
            </button>
          )}
          {run.failed > 0 && (
            <button type="button" aria-expanded={open} {...describe} onClick={onShowProblems}>
              {RUN_BUTTONS.showThem}
            </button>
          )}
          {lines.resume && (
            <button type="button" disabled={busy} {...describe} onClick={() => onAction("resume")}>
              {lines.resume}
            </button>
          )}
          {!running && (
            <button type="button" disabled={busy} {...describe} onClick={onDiscard}>
              {RUN_BUTTONS.discard}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="ao-worklines__problems">
          <h3 ref={problemsHeading} tabIndex={-1}>
            {PROBLEMS_TEXT.heading}
          </h3>
          {problems.error && (
            <div role="alert">
              <UserText as="p">{problems.error}</UserText>
            </div>
          )}
          {problems.data && (
            <>
              <ul className="ao-worklines__problem-list">
                {problems.data.problems.map((p, i) => (
                  <li key={`${p.url}-${i}`} className="ao-worklines__problem">
                    {p.title ? <UserText>{p.title}</UserText> : <span>{PROBLEMS_TEXT.noTitle}</span>}
                    <UserText>{p.url}</UserText>
                    <UserText>{p.reason}</UserText>
                    {p.platformReason && <UserText>{platformSays(problems.data!.platform, p.platformReason)}</UserText>}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => onCopy(problems.data!)}>
                {PROBLEMS_TEXT.copy}
              </button>
              <p role="status">{problems.copied ?? ""}</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function ListLine({ list, title, time, busy, onAction }: { list: TranscriptionListSummary; title: string; time: string | undefined; busy: boolean; onAction(what: "pause" | "continue" | "stop"): void }) {
  const id = useId();
  const describe = { "aria-describedby": `${id}-title` };
  return (
    <div className="ao-worklines__list">
      <p id={`${id}-title`} className="ao-worklines__title">
        <Sentence text={title} part={list.current?.title} />
      </p>
      <Said text={title} />
      {time && <p className="ao-worklines__detail">{time}</p>}
      {list.state !== "idle" && (
        <div className="ao-worklines__actions">
          {list.state === "running" ? (
            <button type="button" disabled={busy} {...describe} onClick={() => onAction("pause")}>
              {LIST_BUTTONS.pause}
            </button>
          ) : (
            <button type="button" disabled={busy} {...describe} onClick={() => onAction("continue")}>
              {LIST_BUTTONS.continue}
            </button>
          )}
          <button type="button" disabled={busy} {...describe} onClick={() => onAction("stop")}>
            {LIST_BUTTONS.stop}
          </button>
        </div>
      )}
    </div>
  );
}
