/**
 * Optional tools (Task 48b; R126, R133, R152, R156, R158): the app does not bundle these, so this
 * screen lists each one from the media helper's catalogue (GET /tools) with what it is for, what
 * stops working without it, its download size and whether it is installed, and installs, updates or
 * removes it as a job of the service (POST /tools/:id/:action; progress read from GET /tools/jobs/:id).
 *
 * - Only tools a feature of the app uses are offered (R158): a speech model the app does not accept
 *   is not listed, unless the app installed it earlier, when it can only be removed.
 * - A tool the catalogue marks unavailable on this computer (OCR today) is shown with its reason and
 *   cannot be installed. The video downloader and the JavaScript runtime it needs are one choice.
 * - Downloading contacts only the tool's publisher (the hosts come from the catalogue, when it lists
 *   them) and sends nothing about projects or the researcher (R7).
 * - Without ffmpeg, media that carries a location stays "proxy pending" and is left out of exports
 *   (R83, R90 c): said once, by the catalogue's text or else by this screen.
 * - Jobs (R99): progress is visible; the live region speaks at the start, half way and the end only;
 *   an install or update can be stopped (a remove cannot); after a stop the catalogue is read again
 *   and the screen says what is installed now, part by part. Leaving and coming back (or a reload)
 *   finds a running job again, because the catalogue carries each tool's latest job. One request per
 *   action; answers that arrive after the screen was left, or after a newer reading, are dropped;
 *   every failure is said in plain words, and its Try again repeats exactly what failed.
 */
import type { ToolAction, ToolId, ToolInfo, ToolJob } from "@ao/shared";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { DEFAULT_SPEECH_MODEL, formatSize, hostsOf, remainingOf, speechSize, toolsApi, toolsErrorText, usedByApp, type ToolsApi } from "../api/tools";
import { UserText } from "../components/UserText";
import type { AppLocation } from "../navigation";
import "./GovernanceScreens.css";
import "./ToolsSetup.css";

const GROUPS: Array<{ id: ToolInfo["group"]; title: string; hint: string }> = [
  { id: "speech", title: "Speech recognition", hint: "Speech models turn recordings into transcripts. Bigger models are slower and more accurate." },
  { id: "capture", title: "Saving from the web", hint: "Downloaders save videos and picture posts from the links you capture." },
  { id: "media", title: "Video conversion", hint: "Makes viewing copies of videos, including copies that leave out or coarsen a recorded location." },
  { id: "documents", title: "Scanned documents", hint: "Reads the text of scanned pages so they can be searched." },
];

/** Speed and accuracy of each speech model the app accepts, in plain words. */
const SPEECH_HINT: Record<string, string> = {
  tiny: "Quickest and least accurate: for trying things out.",
  small: "Fast, and less accurate than the medium model.",
  medium: "More accurate than the small model, and slower.",
  "large-v3": "Slowest and most accurate: for difficult recordings, on a fast computer.",
};

const FFMPEG_WITHOUT =
  "Without ffmpeg, media that carries a location stays “proxy pending”: its viewing copy, with the location coarsened or removed, is not made, and the media is left out of exports.";

const VERB: Record<ToolAction, { doing: string; done: string }> = {
  install: { doing: "Installing", done: "installed" },
  update: { doing: "Updating", done: "updated" },
  remove: { doing: "Removing", done: "removed" },
};

type Mark = "start" | "half" | "stopping" | "end";

/** A failed request on one tool, and what its Try again repeats (exactly the request that failed). */
interface RequestError {
  text: string;
  retry?: { label: string; run: () => void };
}

/** One spoken message: the tool's name is catalogue text (UserText), the rest fixed words. */
interface Said {
  lead: string;
  name: string;
  tail: string;
}

/** What is on this computer now, from the catalogue, part by part for a tool of several parts. */
function installedNow(t: ToolInfo): string {
  if (t.components.length > 1) return `${t.components.map((c) => `${c.name} is ${c.installed ? "installed" : "not installed"}`).join("; ")}.`;
  return `${t.name} is ${t.installed ? "installed" : "not installed"}.`;
}

/** The route's wrapper: one api object per client; `?tool=<id>` brings that tool into view. */
export function ToolsSetupRoute({ client, loc }: { client: ApiClient; loc: AppLocation }) {
  const api = useMemo(() => toolsApi(client), [client]);
  const focusTool = new URLSearchParams(loc.search).get("tool") ?? undefined;
  return <ToolsSetup api={api} {...(focusTool ? { focusTool } : {})} />;
}

export function ToolsSetup({ api, pollMs = 1000, focusTool }: { api: ToolsApi; pollMs?: number; focusTool?: string }) {
  const ids = useId();
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reqErrors, setReqErrors] = useState<Partial<Record<ToolId, RequestError>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /** Tools whose job was just stopped, while the catalogue is read again. */
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState<{ n: number; said: Said[] }>({ n: 0, said: [] });

  const alive = useRef(true);
  const aborts = useRef(new Set<AbortController>());
  const loadSeq = useRef(0);
  const inFlight = useRef(new Set<string>());
  /** What the live region has said for each job. */
  const marks = useRef(new Map<string, Set<Mark>>());
  /** Jobs started from this screen (announced from their start); others are seen silently first. */
  const startedHere = useRef(new Set<string>());
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const focused = useRef(false);
  const wasRunning = useRef(new Set<string>());

  const controller = () => {
    const ac = new AbortController();
    aborts.current.add(ac);
    return ac;
  };
  const release = (ac: AbortController) => void aborts.current.delete(ac);

  useEffect(() => {
    alive.current = true;
    const pending = aborts.current;
    return () => {
      alive.current = false;
      for (const ac of pending) ac.abort();
    };
  }, []);

  /** Reads the catalogue; only the newest reading is kept. */
  const load = useCallback(async () => {
    const my = ++loadSeq.current;
    const ac = controller();
    try {
      const r = await api.catalogue(ac.signal);
      if (!alive.current || my !== loadSeq.current) return;
      setTools(Array.isArray(r.tools) ? r.tools : []);
      setLoadError(null);
    } catch (err) {
      if (!alive.current || my !== loadSeq.current) return;
      setLoadError(toolsErrorText(err, "The list of optional tools could not be read."));
    } finally {
      release(ac);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A job's newest state, from this screen's own request: it supersedes any reading still on its way. */
  const putJob = (job: ToolJob) => {
    loadSeq.current++;
    setTools((ts) => ts && ts.map((t) => (t.id === job.toolId && (!t.job || t.job.jobId === job.jobId || job.status === "running") ? { ...t, job } : t)));
  };

  // Progress of the running jobs: read every `pollMs`, one round at a time; a finished job reloads the catalogue.
  const runningKey = (tools ?? [])
    .filter((t) => t.job?.status === "running")
    .map((t) => t.job!.jobId)
    .join(",");
  useEffect(() => {
    if (!runningKey) return;
    const jobIds = runningKey.split(",");
    let stopped = false;
    let reading = false;
    const ac = new AbortController();
    const tick = async () => {
      if (reading || stopped) return;
      reading = true;
      try {
        const got = await Promise.all(jobIds.map((id) => api.job(id, ac.signal).then((j) => ({ id, j }), () => ({ id, j: undefined as ToolJob | undefined }))));
        if (stopped || !alive.current) return;
        const fresh = got.filter((g): g is { id: string; j: ToolJob } => !!g.j && g.j.jobId === g.id);
        if (fresh.length) {
          setTools((ts) =>
            ts &&
            ts.map((t) => {
              const f = fresh.find((g) => g.j.toolId === t.id && t.job?.jobId === g.id);
              return f ? { ...t, job: f.j } : t;
            }),
          );
        }
        // Ended, or no longer known to the service (it restarted): the catalogue says what is installed
        // now, and a stopped job's card waits for it before it says anything.
        const ended = got.filter((g) => !g.j || g.j.status !== "running");
        if (ended.length) {
          const ids = ended.map((g) => g.j?.toolId).filter((x): x is ToolId => !!x);
          for (const id of ids) setIn(setChecking, id, true);
          await load();
          if (alive.current) for (const id of ids) setIn(setChecking, id, false);
        }
      } finally {
        reading = false;
      }
    };
    const t = setInterval(() => void tick(), pollMs);
    return () => {
      stopped = true;
      clearInterval(t);
      ac.abort();
    };
  }, [runningKey, pollMs, api, load]);

  // The live region: the start, half way and the end of each job, never every step; every change
  // seen in one reading is said (not only the last).
  useEffect(() => {
    if (!tools) return;
    const said: Said[] = [];
    for (const t of tools) {
      const j = t.job;
      if (!j) continue;
      let m = marks.current.get(j.jobId);
      const v = VERB[j.action] ?? VERB.install;
      if (!m) {
        m = new Set();
        marks.current.set(j.jobId, m);
        if (!startedHere.current.has(j.jobId)) {
          // Seen first in a reading (after coming back): what has happened so far is not announced again.
          m.add("start");
          if (j.progress >= 0.5) m.add("half");
          if (j.status !== "running") m.add("end");
        }
      }
      let say: Said | undefined;
      if (!m.has("start")) {
        m.add("start");
        say = { lead: `${v.doing} `, name: t.name, tail: " started." };
      }
      if (j.status === "running" && j.cancelRequested && !m.has("stopping")) {
        m.add("stopping");
        say = { lead: "Stopping ", name: t.name, tail: "." };
      }
      if (j.status === "running" && !j.cancelRequested && j.progress >= 0.5 && !m.has("half")) {
        m.add("half");
        say = { lead: `${v.doing} `, name: t.name, tail: ": half way." };
      }
      if (j.status !== "running" && !m.has("end")) {
        m.add("end");
        m.add("half");
        if (j.status === "done" && j.cancelRequested) say = { lead: "", name: t.name, tail: ` is ${v.done}: it finished before the stop took effect.` };
        else if (j.status === "done") say = { lead: "", name: t.name, tail: ` is ${v.done}.` };
        else if (j.status === "cancelled") say = { lead: `${v.doing} `, name: t.name, tail: " was stopped." };
        else say = { lead: `${v.doing} `, name: t.name, tail: " did not finish." };
      }
      if (say) said.push(say);
    }
    if (said.length) setAnnouncement((a) => ({ n: a.n + 1, said }));
  }, [tools]);

  // Focus is not left on nothing when a job's Cancel button goes away: it moves to the tool's heading.
  useEffect(() => {
    if (!tools) return;
    const now = new Set(tools.filter((t) => t.job?.status === "running").map((t) => t.id));
    for (const id of wasRunning.current) {
      if (!now.has(id as ToolId) && (document.activeElement === document.body || document.activeElement === null)) headings.current.get(id)?.focus();
    }
    wasRunning.current = now;
  }, [tools]);

  // `?tool=<id>`: that tool's heading, once.
  useEffect(() => {
    if (!tools || !focusTool || focused.current) return;
    const h = headings.current.get(focusTool);
    if (!h) return;
    focused.current = true;
    h.scrollIntoView?.({ block: "start" });
    h.focus();
  }, [tools, focusTool]);

  const setIn = (set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void, key: string, on: boolean) =>
    set((b) => {
      const n = new Set(b);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const clearError = (id: ToolId) => setReqErrors(({ [id]: _gone, ...rest }) => rest);

  const act = async (t: ToolInfo, action: ToolAction) => {
    const key = `${t.id}:act`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setIn(setBusy, key, true);
    clearError(t.id);
    const ac = controller();
    try {
      const job = await api.start(t.id, action, ac.signal);
      if (!alive.current) return;
      startedHere.current.add(job.jobId);
      putJob(job);
      headings.current.get(t.id)?.focus();
    } catch (err) {
      if (!alive.current) return;
      setReqErrors((e) => ({
        ...e,
        [t.id]: { text: toolsErrorText(err, `${VERB[action].doing} ${t.name} could not be started.`), retry: { label: `Try again: ${action} ${t.name}`, run: () => void act(t, action) } },
      }));
    } finally {
      release(ac);
      inFlight.current.delete(key);
      if (alive.current) setIn(setBusy, key, false);
    }
  };

  const cancel = async (t: ToolInfo, job: ToolJob) => {
    const key = `${job.jobId}:cancel`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setIn(setBusy, key, true);
    clearError(t.id);
    const doing = VERB[job.action].doing;
    const ac = controller();
    try {
      const j = await api.cancel(job.jobId, ac.signal);
      if (!alive.current) return;
      // The job stays running, with cancelRequested, until the media helper answers (stopped, or
      // finished first); the poll reads that answer and then the catalogue.
      putJob(j);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiClientError && err.code === "NOT_FOUND") {
        // The job had ended (or the service restarted): nothing to stop; say what is installed now.
        setReqErrors((e) => ({ ...e, [t.id]: { text: "That job had already ended, so there was nothing to stop. The list shows what is installed now." } }));
        void load();
      } else {
        setReqErrors((e) => ({
          ...e,
          [t.id]: { text: toolsErrorText(err, `${doing} ${t.name} could not be stopped.`), retry: { label: `Try again: cancel ${doing.toLowerCase()} ${t.name}`, run: () => void cancel(t, job) } },
        }));
      }
    } finally {
      release(ac);
      inFlight.current.delete(key);
      if (alive.current) setIn(setBusy, key, false);
    }
  };

  // Only tools a feature uses (R158); one the app installed earlier stays listed so it can be removed.
  const listed = (tools ?? []).filter((t) => usedByApp(t.id) || t.managed);
  const groups = GROUPS.map((g) => ({ ...g, tools: listed.filter((t) => t.group === g.id) }));
  const others = listed.filter((t) => !GROUPS.some((g) => g.id === t.group));
  if (others.length) groups.push({ id: "documents", title: "Other tools", hint: "", tools: others });
  const anyHosts = listed.some((t) => hostsOf(t).length > 0);

  const card = (t: ToolInfo) => {
    const hid = `${ids}-${t.id}`;
    const job = t.job;
    const running = job?.status === "running";
    const used = usedByApp(t.id);
    const size = speechSize(t.id);
    const hosts = hostsOf(t, { missingOnly: !t.installed });
    const systemOnly = t.installed && !t.managed && t.components.some((c) => c.source === "system" || c.source === "override");
    const reqError = reqErrors[t.id];
    const failed = job?.status === "failed" ? job : undefined;
    const actBusy = busy.has(`${t.id}:act`);
    const remaining = remainingOf(t);
    const hint = size ? (size === DEFAULT_SPEECH_MODEL ? `The app's default model. ${SPEECH_HINT[size] ?? ""}`.trim() : SPEECH_HINT[size]) : undefined;
    return (
      <section key={t.id} className="ao-card ao-tool" aria-labelledby={hid}>
        <h3
          id={hid}
          tabIndex={-1}
          ref={(el) => {
            if (el) headings.current.set(t.id, el);
            else headings.current.delete(t.id);
          }}
        >
          <UserText>{t.name}</UserText>
        </h3>
        <UserText as="p">{t.purpose}</UserText>
        {hint ? <p className="ao-hint">{hint}</p> : null}
        {!used ? <p className="ao-hint">No feature of the app uses it, so it is not offered any more. You can remove it.</p> : null}
        <p>
          Without it: <UserText>{t.without}</UserText>
        </p>
        {t.id === "ffmpeg" && !/proxy pending/i.test(t.without) ? <p>{FFMPEG_WITHOUT}</p> : null}
        {t.components.length > 1 ? (
          <div>
            <p>One choice; it includes:</p>
            <ul className="ao-tool__parts">
              {t.components.map((c) => (
                <li key={c.id}>
                  <UserText>{c.name}</UserText>
                  {c.version ? (
                    <span className="ao-hint">
                      {" "}
                      (<UserText>{c.version}</UserText>)
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="ao-tool__status">
          {t.installed ? (
            t.usable ? (
              <strong>Installed</strong>
            ) : (
              <strong>Installed, but it does not run on this computer</strong>
            )
          ) : t.available ? (
            <strong>Not installed</strong>
          ) : (
            <strong>Not available on this computer</strong>
          )}
        </p>
        {!t.installed && !t.available && t.unavailableReason ? <UserText as="p">{t.unavailableReason}</UserText> : null}
        {systemOnly ? <p className="ao-hint">Found on this computer (not the app's own copy), so the app uses it and leaves it alone.</p> : null}
        {t.installed && !t.usable && t.managed ? <p className="ao-hint">Remove it and install it again.</p> : null}
        <p className="ao-hint">
          {t.installed ? "Download size: " : remaining > 0 && remaining < t.downloadSize ? `Still to download (of ${formatSize(t.downloadSize, t.sizeApproximate)}): ` : "Download size: "}
          {formatSize(t.installed ? t.downloadSize : remaining || t.downloadSize, t.sizeApproximate)}
        </p>
        {hosts.length > 0 ? (
          <p className="ao-hint">
            Downloads from: <UserText>{hosts.join(", ")}</UserText>
          </p>
        ) : null}
        {t.notice ? (
          <UserText as="p" className="ao-hint">
            {t.notice}
          </UserText>
        ) : null}

        {running && job ? (
          <div className="ao-tool__job">
            <label className="ao-tool__progress">
              <span>{job.cancelRequested ? "Stopping…" : `${VERB[job.action].doing}… ${Math.round(job.progress * 100)}%`}</span>
              <progress max={100} value={Math.round(Math.min(1, Math.max(0, job.progress)) * 100)} aria-label={`${VERB[job.action].doing} ${t.name}`} />
            </label>
            {/* A remove cannot be stopped part-way, and a stop asked for once is not asked again. */}
            {job.action !== "remove" && !job.cancelRequested ? (
              <button type="button" aria-label={`Cancel ${VERB[job.action].doing.toLowerCase()} ${t.name}`} disabled={busy.has(`${job.jobId}:cancel`)} onClick={() => void cancel(t, job)}>
                Cancel
              </button>
            ) : null}
          </div>
        ) : null}
        {job && job.status !== "running" && (job.status === "cancelled" || job.cancelRequested) ? (
          checking.has(t.id) ? (
            <p>Reading what is installed now…</p>
          ) : job.status === "cancelled" ? (
            <UserText as="p">{`Stopped. ${installedNow(t)}`}</UserText>
          ) : job.status === "done" ? (
            <UserText as="p">{`It finished before the stop took effect. ${installedNow(t)}`}</UserText>
          ) : null
        ) : null}
        {failed && failed.error?.code === "CANCEL_UNCONFIRMED" && !reqError ? (
          <div role="alert" className="ao-warning">
            <UserText as="p">{failed.error.message}</UserText>
            {checking.has(t.id) ? null : <UserText as="p">{`What is on this computer now: ${installedNow(t)}`}</UserText>}
          </div>
        ) : null}
        {failed && failed.error?.code !== "CANCEL_UNCONFIRMED" && !reqError ? (
          <div role="alert" className="ao-warning">
            <p>
              {VERB[failed.action].doing} did not finish. <UserText>{failed.error?.message ?? "Nothing was left half-installed."}</UserText>
            </p>
            <button type="button" aria-label={`Try again: ${failed.action} ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, failed.action)}>
              Try again
            </button>
          </div>
        ) : null}
        {reqError ? (
          <div role="alert" className="ao-warning">
            <UserText as="p">{reqError.text}</UserText>
            {reqError.retry ? (
              <button type="button" aria-label={reqError.retry.label} disabled={actBusy} onClick={(e) => e.detail < 2 && reqError.retry!.run()}>
                Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {!running ? (
          <div className="ao-actions">
            {!t.installed && t.available && used ? (
              <button type="button" aria-label={`Install ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, "install")}>
                Install
              </button>
            ) : null}
            {t.installed && t.managed && used ? (
              <button type="button" aria-label={`Update ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, "update")}>
                {t.updateAvailable ? "Update (a newer version is available)" : "Update"}
              </button>
            ) : null}
            {/* Any part the app installed can be removed, also a part left by a stopped install. */}
            {t.managed ? (
              <button type="button" aria-label={`Remove ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, "remove")}>
                Remove
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <main className="ao-screen ao-tools">
      <h1>Optional tools</h1>
      <p>The app does not include these tools, so that its own download stays small. Install only the ones you need; you can remove them again here.</p>
      <p>
        Each download contacts only the tool's publisher{anyHosts ? ", at the addresses listed with the tool," : ""} and sends nothing about your projects or about you. Each file is checked against its
        published checksum before it is used.
      </p>
      <p role="status" aria-label="Tool progress" className="ao-visually-hidden">
        {/* Keyed by count, so the same words said again are announced again. */}
        <span key={announcement.n}>
          {announcement.said.map((s, i) => (
            <Fragment key={i}>
              {i > 0 ? " " : null}
              {s.lead}
              <UserText>{s.name}</UserText>
              {s.tail}
            </Fragment>
          ))}
        </span>
      </p>
      {loadError ? (
        <div role="alert" className="ao-warning">
          <UserText as="p">{loadError}</UserText>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {tools === null && !loadError ? <p className="ao-hint">Reading the list of tools…</p> : null}
      {groups
        .filter((g) => g.tools.length > 0)
        .map((g) => (
          <section key={g.title} className="ao-tools__group" aria-labelledby={`${ids}-g-${g.title}`}>
            <h2 id={`${ids}-g-${g.title}`}>{g.title}</h2>
            {g.hint ? <p className="ao-hint">{g.hint}</p> : null}
            {g.tools.map(card)}
          </section>
        ))}
    </main>
  );
}
