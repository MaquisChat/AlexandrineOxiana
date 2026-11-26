/**
 * The work lines (whole channels, R668, R669, R672): one block per download run of the project and one line for its
 * transcription list, wherever the project is open (the Library and Capture screens). Every sentence comes from
 * @ao/shared (`runLines`, `transcriptionLines` and the fixed texts); titles, addresses and the service's and platform's
 * words go through UserText.
 *
 * Both lists are read at the mount and at every opening of the event stream; `background.progress` events of this
 * project keep them current, from the mount to the unmount, whatever is shown (R679 A1). A screen hands its own event
 * stream to the lines (`events`, see `useEventFeed`), so a screen has one stream; without it the lines follow a stream
 * of their own, as the import's run step does (R597, R641 D2, R658, R659): an opening limit and a silence limit, two
 * reconnects 300 ms apart, and the count of tries starts again only when a connection proved itself (an event of this
 * project arrived on it, or it stayed open and silent to the silence limit). A service that does not know the two
 * routes (404) has nothing to show; any other failed read says the notice, with "Reconnect" (R679 A3).
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
import { ApiClientError, STREAM_OPEN_TIMEOUT_MS, STREAM_QUIET_TIMEOUT_MS, type ApiClient, type ServiceEvent } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, readWithin } from "../api/firstRead";
import { errorText } from "../api/library";
import { UserText } from "./UserText";
import "./WorkLines.css";

/** A screen's own event stream, handed to the lines (R679 A1): every event it receives and every (re)opening. */
export interface WorkLinesEvents {
  /** Returns the function that ends the subscription. */
  subscribe(onEvent: (e: ServiceEvent) => void, onOpen: () => void): () => void;
}

export interface WorkLinesProps {
  client: ApiClient;
  projectId: string;
  /** R597: how long the event stream is waited for to open before it is closed and tried afresh (smaller in tests). */
  streamOpenMs?: number;
  /** R641 D2: how long an open event stream may deliver nothing before it is closed and tried afresh (smaller in tests). */
  streamQuietMs?: number;
  /** The screen's own event stream (R679 A1): with it, the lines open no stream of their own. */
  events?: WorkLinesEvents;
}

/**
 * For a screen (R679 A2): a small set of subscribers beside its own event stream. The screen calls `event` for every
 * event its stream receives and `opened` at every opening; `events` goes to the lines.
 */
export function useEventFeed(): { events: WorkLinesEvents; event(e: ServiceEvent): void; opened(): void } {
  const [feed] = useState(() => {
    const subs = new Set<{ onEvent: (e: ServiceEvent) => void; onOpen: () => void }>();
    return {
      events: {
        subscribe(onEvent: (e: ServiceEvent) => void, onOpen: () => void) {
          const s = { onEvent, onOpen };
          subs.add(s);
          return () => void subs.delete(s);
        },
      },
      event: (e: ServiceEvent) => [...subs].forEach((s) => s.onEvent(e)),
      opened: () => [...subs].forEach((s) => s.onOpen()),
    };
  });
  return feed;
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

/**
 * The runs as read, against those held (R679 A4): a run that an event (or an answer) changed after the read was sent
 * keeps what that said, also a run the read does not know yet, or one an event removed; otherwise the read's, unless
 * the one held is newer by its `updatedAt`.
 */
function merge(held: DownloadRunSummary[], read: DownloadRunSummary[], seen: ReadonlyMap<string, number>, sent: number): DownloadRunSummary[] {
  const byId = new Map(held.map((r) => [r.runId, r]));
  const after = (id: string) => (seen.get(id) ?? -1) > sent;
  const out: DownloadRunSummary[] = [];
  for (const r of read) {
    const h = byId.get(r.runId);
    if (after(r.runId)) {
      if (h) out.push(h);
    } else out.push(h && h.updatedAt > r.updatedAt ? h : r);
  }
  for (const h of held) if (after(h.runId) && !read.some((r) => r.runId === h.runId)) out.push(h);
  return newestFirst(out);
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

export function WorkLines({ client, projectId, streamOpenMs = STREAM_OPEN_TIMEOUT_MS, streamQuietMs = STREAM_QUIET_TIMEOUT_MS, events }: WorkLinesProps) {
  const api = useMemo(() => backgroundApi(client), [client]);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [runs, setRuns] = useState<DownloadRunSummary[]>([]);
  const [list, setList] = useState<TranscriptionListSummary | null>(null);
  const [stopped, setStopped] = useState(false);
  /** After a Discard here, the section stays while focus is on its heading (even with nothing left in it); it goes when focus leaves. */
  const [holdFocus, setHoldFocus] = useState(false);
  /** The lines' own stream gave up (R659). */
  const [lost, setLost] = useState(false);
  /** A read of the runs or of the list failed with anything but 404 (R679 A3). */
  const [failed, setFailed] = useState<{ runs: boolean; list: boolean }>({ runs: false, list: false });
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyNow = useRef(new Set<string>());
  const [problems, setProblems] = useState<Record<string, ProblemsView>>({});
  const focusHeading = useRef(false);
  /**
   * R679 A4: a count of what arrived (events and answers), and for each run, and for the list, the count when it last
   * changed. A read's answer about something that changed after the read was sent is dropped.
   */
  const seq = useRef(0);
  const runSeen = useRef(new Map<string, number>());
  const listSeen = useRef(-1);
  /** The reads of the project shown now are cancelled through this when it changes or the lines go. */
  const reads = useRef(new AbortController());
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
    setHoldFocus(false);
    setLost(false);
    setFailed({ runs: false, list: false });
    setError(null);
    setProblems({});
    busyNow.current = new Set();
    setBusy(new Set());
    runSeen.current = new Map();
    listSeen.current = -1;
  }, [projectId]);

  useEffect(() => {
    if (focusHeading.current) {
      focusHeading.current = false;
      heading.current?.focus();
    }
  });

  const runChanged = useCallback((runId: string) => runSeen.current.set(runId, ++seq.current), []);
  const listChanged = useCallback(() => (listSeen.current = ++seq.current), []);

  /** Both lists, read for `pid`; dropped when the project changed or the read was cancelled. */
  const read = useCallback(
    (pid: string, signal: AbortSignal) => {
      const mine = () => !signal.aborted && current.current === pid;
      const sent = seq.current;
      void readWithin((s) => api.downloads(pid, { signal: s }), FIRST_READ_TIMEOUT_MS, signal).then(
        (read) => {
          if (!mine()) return;
          setFailed((f) => (f.runs ? { ...f, runs: false } : f));
          setRuns((held) => merge(held, read.filter((r) => r.projectId === pid), runSeen.current, sent));
        },
        (err: unknown) => {
          if (!mine()) return;
          // A 404: this service has no such route, nothing to show (and what events said stays).
          const lostRead = !unknownRoute(err);
          setFailed((f) => (f.runs === lostRead ? f : { ...f, runs: lostRead }));
        },
      );
      void readWithin((s) => api.transcriptionList(pid, { signal: s }), FIRST_READ_TIMEOUT_MS, signal).then(
        (l) => {
          if (!mine()) return;
          setFailed((f) => (f.list ? { ...f, list: false } : f));
          if (listSeen.current > sent) return;
          setList(l);
          if (l.total > 0) setStopped(false);
        },
        (err: unknown) => {
          if (!mine()) return;
          const lostRead = !unknownRoute(err);
          setFailed((f) => (f.list === lostRead ? f : { ...f, list: lostRead }));
        },
      );
    },
    [api],
  );

  /** A `background.progress` event of `pid` applied; any other event is not. True when it was one. */
  const apply = useCallback(
    (ev: ServiceEvent, pid: string): boolean => {
      const e = backgroundProgress(ev, pid);
      if (!e) return false;
      if (e.downloads) {
        const run = e.downloads;
        runChanged(run.runId);
        setRuns((held) => upsert(held, run));
      }
      if (e.discarded !== undefined) {
        const gone = e.discarded;
        runChanged(gone);
        setRuns((held) => held.filter((r) => r.runId !== gone));
      }
      if (e.transcriptions) {
        const l = e.transcriptions;
        listChanged();
        setList(l);
        if (l.total > 0) setStopped(false);
      }
      return true;
    },
    [runChanged, listChanged],
  );

  // The lists as they stand at the mount; with the screen's stream, its events and a new read at each of its openings.
  useEffect(() => {
    const ctl = new AbortController();
    reads.current = ctl;
    const pid = projectId;
    const unsubscribe = events?.subscribe(
      (ev) => {
        if (!ctl.signal.aborted) apply(ev, pid);
      },
      () => {
        if (!ctl.signal.aborted) read(pid, ctl.signal);
      },
    );
    read(pid, ctl.signal);
    return () => {
      ctl.abort();
      unsubscribe?.();
    };
  }, [projectId, read, apply, events]);

  // Without the screen's stream: the lines' own, from the mount.
  useEffect(() => {
    if (events) return;
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
            if (apply(ev, pid)) proved = true;
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
  }, [client, projectId, read, apply, attempt, streamOpenMs, streamQuietMs, events]);

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
    void act(`run:${run.runId}`, () => api.runAction(projectId, run.runId, what), (r) => {
      runChanged(r.runId);
      setRuns((held) => upsert(held, r));
    });

  const discard = (run: DownloadRunSummary) =>
    void act(`run:${run.runId}`, () => api.discard(projectId, run.runId), () => {
      runChanged(run.runId);
      setRuns((held) => held.filter((r) => r.runId !== run.runId));
      setHoldFocus(true);
      focusHeading.current = true;
    });

  const listAction = (what: "pause" | "continue" | "stop") =>
    void act("list", () => api.listAction(projectId, what), (l) => {
      listChanged();
      setList(l);
      if (what === "stop") {
        setStopped(true);
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

  const mine = runs.filter((r) => r.projectId === projectId);
  const listOfProject = list && list.projectId === projectId ? list : null;
  const listLines = listOfProject ? transcriptionLines(listOfProject) : {};
  const notice = lost || failed.runs || failed.list;
  /** R679 A5: nothing visible with no run, an idle empty list, no notice and no status sentence. */
  const visible = mine.length > 0 || listLines.title !== undefined || notice || stopped || error !== null || holdFocus;
  if (!visible) return null;

  return (
    <section className="ao-worklines" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1} onBlur={() => setHoldFocus(false)}>
        {WORK_LINES_TEXT.heading}
      </h2>
      {stopped && <p role="status">{LIST_STOPPED_TEXT}</p>}
      {error && (
        <div className="ao-worklines__error" role="alert">
          <UserText as="p">{error}</UserText>
        </div>
      )}
      {notice && (
        <div className="ao-worklines__note" role="alert">
          <p>{WORK_LINES_TEXT.lost}</p>
          <button
            type="button"
            onClick={() => {
              if (lost) {
                setLost(false);
                setAttempt((n) => n + 1);
              }
              if (failed.runs || failed.list) read(projectId, reads.current.signal);
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
