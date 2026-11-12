/**
 * Optional tools (Task 48b; R126, R133, R152): the app does not bundle these, so this screen lists
 * each one from the media helper's catalogue (GET /tools) with what it is for, what stops working
 * without it, its download size and whether it is installed, and installs, updates or removes it
 * as a job of the service (POST /tools/:id/:action; progress read from GET /tools/jobs/:id).
 *
 * - A tool the catalogue marks unavailable on this computer (OCR today) is shown with its reason and
 *   cannot be installed. The video downloader and the JavaScript runtime it needs are one choice.
 * - Downloading contacts only the tool's publisher (the hosts come from the catalogue) and sends
 *   nothing about projects or the researcher (R7).
 * - Without ffmpeg, media that carries a location stays "proxy pending" and is left out of exports
 *   (R83, R90 c).
 * - Jobs (R99): progress is visible; the live region speaks at the start, half way and the end only;
 *   a running job can be cancelled; leaving and coming back (or a reload) finds it again, because the
 *   catalogue carries each tool's latest job. One request per action (a double click sends one);
 *   answers that arrive after the screen was left, or after a newer reading, are dropped; every
 *   failure is said in plain words with a way to try again.
 */
import type { ToolAction, ToolId, ToolInfo, ToolJob } from "@ao/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import { errorText } from "../api/library";
import { formatSize, hostsOf, remainingOf, speechSize, toolsApi, type ToolsApi } from "../api/tools";
import { UserText } from "../components/UserText";
import type { AppLocation } from "../navigation";
import "./GovernanceScreens.css";
import "./ToolsSetup.css";

const GROUPS: Array<{ id: ToolInfo["group"]; title: string; hint: string }> = [
  { id: "speech", title: "Speech recognition", hint: "Speech models turn recordings into transcripts. Bigger models are slower and more accurate; most interviews need only the small one." },
  { id: "capture", title: "Saving from the web", hint: "Downloaders save videos and picture posts from the links you capture." },
  { id: "media", title: "Video and audio conversion", hint: "Makes viewing copies of videos and reads the sound of recordings." },
  { id: "documents", title: "Scanned documents", hint: "Reads the text of scanned pages so they can be searched." },
];

/** Speed and accuracy of each speech model, in plain words. */
const SPEECH_HINT: Record<string, string> = {
  tiny: "Fastest and least accurate: for a quick first look at a recording.",
  small: "A good balance of speed and accuracy for most interviews.",
  medium: "Slower, and more accurate than the small model.",
  "large-v3": "Slowest and most accurate: for difficult recordings, on a fast computer.",
};

const FFMPEG_WITHOUT =
  "Without ffmpeg, media that carries a location stays “proxy pending”: its viewing copy, with the location coarsened or removed, is not made, and the media is left out of exports.";

const VERB: Record<ToolAction, { doing: string; done: string; button: string }> = {
  install: { doing: "Installing", done: "installed", button: "Install" },
  update: { doing: "Updating", done: "updated", button: "Update" },
  remove: { doing: "Removing", done: "removed", button: "Remove" },
};

type Mark = "start" | "half" | "end";

interface RequestError {
  text: string;
  action: ToolAction;
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
  const [announcement, setAnnouncement] = useState("");

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
      setLoadError(errorText(err, "The list of optional tools could not be read."));
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
          setTools((ts) => ts && ts.map((t) => {
            const f = fresh.find((g) => g.j.toolId === t.id && t.job?.jobId === g.id);
            return f ? { ...t, job: f.j } : t;
          }));
        }
        // Ended, or no longer known to the service (it restarted): the catalogue says what is installed now.
        if (got.some((g) => !g.j || g.j.status !== "running")) void load();
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

  // The live region: the start, half way and the end of each job, never every step.
  useEffect(() => {
    if (!tools) return;
    let say = "";
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
      if (!m.has("start")) {
        m.add("start");
        say = `${v.doing} ${t.name} started.`;
      }
      if (j.status === "running" && j.progress >= 0.5 && !m.has("half")) {
        m.add("half");
        say = `${v.doing} ${t.name}: half way.`;
      }
      if (j.status !== "running" && !m.has("end")) {
        m.add("end");
        m.add("half");
        if (j.status === "done") say = `${t.name} is ${v.done}.`;
        else if (j.status === "cancelled") say = `${v.doing} ${t.name} was cancelled.`;
        else say = `${v.doing} ${t.name} did not finish.`;
      }
    }
    if (say) setAnnouncement(say);
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

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const act = async (t: ToolInfo, action: ToolAction) => {
    const key = `${t.id}:act`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setBusyKey(key, true);
    setReqErrors(({ [t.id]: _gone, ...rest }) => rest);
    const ac = controller();
    try {
      const job = await api.start(t.id, action, ac.signal);
      if (!alive.current) return;
      startedHere.current.add(job.jobId);
      putJob(job);
      headings.current.get(t.id)?.focus();
    } catch (err) {
      if (!alive.current) return;
      setReqErrors((e) => ({ ...e, [t.id]: { text: errorText(err, `${VERB[action].doing} ${t.name} could not be started.`), action } }));
    } finally {
      release(ac);
      inFlight.current.delete(key);
      if (alive.current) setBusyKey(key, false);
    }
  };

  const cancel = async (t: ToolInfo, job: ToolJob) => {
    const key = `${job.jobId}:cancel`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setBusyKey(key, true);
    const ac = controller();
    try {
      const j = await api.cancel(job.jobId, ac.signal);
      if (!alive.current) return;
      putJob(j);
      if (j.status !== "running") void load();
    } catch (err) {
      if (!alive.current) return;
      setReqErrors((e) => ({ ...e, [t.id]: { text: errorText(err, `${VERB[job.action].doing} ${t.name} could not be cancelled.`), action: job.action } }));
    } finally {
      release(ac);
      inFlight.current.delete(key);
      if (alive.current) setBusyKey(key, false);
    }
  };

  const groups = GROUPS.map((g) => ({ ...g, tools: (tools ?? []).filter((t) => t.group === g.id) }));
  const others = (tools ?? []).filter((t) => !GROUPS.some((g) => g.id === t.group));
  if (others.length) groups.push({ id: "documents", title: "Other tools", hint: "", tools: others });

  const card = (t: ToolInfo) => {
    const hid = `${ids}-${t.id}`;
    const job = t.job;
    const running = job?.status === "running";
    const size = speechSize(t.id);
    const hosts = hostsOf(t, { missingOnly: !t.installed });
    const systemOnly = t.installed && !t.managed && t.components.some((c) => c.source === "system" || c.source === "override");
    const reqError = reqErrors[t.id];
    const failed = job?.status === "failed" ? job : undefined;
    const actBusy = busy.has(`${t.id}:act`);
    const remaining = remainingOf(t);
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
        {size && SPEECH_HINT[size] ? <p className="ao-hint">{SPEECH_HINT[size]}</p> : null}
        <p>
          Without it: <UserText>{t.without}</UserText>
        </p>
        {t.id === "ffmpeg" ? <p>{FFMPEG_WITHOUT}</p> : null}
        {t.components.length > 1 ? (
          <div>
            <p>One choice; it includes:</p>
            <ul className="ao-tool__parts">
              {t.components.map((c) => (
                <li key={c.id}>
                  <UserText>{c.name}</UserText> {c.version ? <span className="ao-hint">(<UserText>{c.version}</UserText>)</span> : null}
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
        {t.notice ? <UserText as="p" className="ao-hint">{t.notice}</UserText> : null}

        {running && job ? (
          <div className="ao-tool__job">
            <label className="ao-tool__progress">
              <span>
                {VERB[job.action].doing}… {Math.round(job.progress * 100)}%
              </span>
              <progress max={100} value={Math.round(Math.min(1, Math.max(0, job.progress)) * 100)} aria-label={`${VERB[job.action].doing} ${t.name}`} />
            </label>
            <button type="button" aria-label={`Cancel ${VERB[job.action].doing.toLowerCase()} ${t.name}`} disabled={busy.has(`${job.jobId}:cancel`)} onClick={() => void cancel(t, job)}>
              Cancel
            </button>
          </div>
        ) : null}
        {job?.status === "cancelled" ? <p>{VERB[job.action].doing} was cancelled. Nothing was changed.</p> : null}
        {failed && !reqError ? (
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
            <button type="button" aria-label={`Try again: ${reqError.action} ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, reqError.action)}>
              Try again
            </button>
          </div>
        ) : null}

        {!running ? (
          <div className="ao-actions">
            {!t.installed && t.available ? (
              <button type="button" aria-label={`Install ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, "install")}>
                Install
              </button>
            ) : null}
            {t.installed && t.managed ? (
              <button type="button" aria-label={`Update ${t.name}`} disabled={actBusy} onClick={(e) => e.detail < 2 && void act(t, "update")}>
                {t.updateAvailable ? "Update (a newer version is available)" : "Update"}
              </button>
            ) : null}
            {t.installed && t.managed ? (
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
        Each download contacts only the tool's publisher{(tools ?? []).some((t) => hostsOf(t).length > 0) ? ", at the addresses listed with the tool," : ""} and sends nothing about your projects or about you. Each
        file is checked against its published checksum before it is used.
      </p>
      <p role="status" aria-label="Tool progress" className="ao-visually-hidden">
        {announcement}
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
