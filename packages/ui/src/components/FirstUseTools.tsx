/**
 * The first-use tools question (Task 48b; R126, R133, R152; Task 48c, R163, R164). It never opens
 * by itself: on the open library's screen a banner asks it until it is answered, and "Choose tools…"
 * opens the dialogue, which asks what the researcher will do
 * and offers the matching tools pre-selected, with the total download size and the hosts each
 * download contacts (from the catalogue). Nothing is downloaded until "Download …" is pressed; each
 * chosen tool is then one install job (one request each), and the Optional tools screen opens to
 * show their progress. "Not now" (in the banner or the dialogue) is remembered, so the question does
 * not come back; Escape only closes the dialogue, back to the banner. Reaching the Optional tools
 * screen by any route also counts as an answer. The question never blocks the app: when the
 * catalogue cannot be read (the media helper is not running, or the page is not the desktop app)
 * there is no banner.
 *
 * Where the answer is remembered: `FirstUseMemory`. The service has no route for this setting yet,
 * so the default keeps it in the app's own web storage on this computer (never in a library); a
 * service-backed store can replace it without changing the dialogue.
 */
import type { ToolId, ToolInfo } from "@ao/shared";
import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_SPEECH_MODEL, describeHosts, formatSize, hostsOf, PUBLISHER_SERVERS, remainingOf, speechTool, toolsErrorText, usedByApp, type ToolsApi } from "../api/tools";
import { navigate, PATHS } from "../navigation";
import { toolsHref } from "./MissingToolNotice";
import { DialogShell } from "./ReasonDialog";
import { UserText } from "./UserText";
import "../screens/GovernanceScreens.css";
import "../screens/ToolsSetup.css";

/** "seen": the Optional tools screen was reached by some route before the question was answered (R163). */
export type FirstUseAnswer = "not-now" | "chosen" | "seen";

export interface FirstUseMemory {
  get(): FirstUseAnswer | null;
  set(answer: FirstUseAnswer): void;
}

const KEY = "ao.firstUseTools";

/** The answer in this app's web storage on this computer; a store that cannot be used counts as unanswered. */
export const localFirstUseMemory: FirstUseMemory = {
  get() {
    try {
      const v = window.localStorage.getItem(KEY);
      return v === "not-now" || v === "chosen" || v === "seen" ? v : null;
    } catch {
      return null;
    }
  },
  set(answer) {
    try {
      window.localStorage.setItem(KEY, answer);
    } catch {
      // not remembered: the dialogue may ask again next time
    }
  },
};

interface Activity {
  id: string;
  label: string;
  hint: string;
  tools: ToolId[];
}

const ACTIVITIES: Activity[] = [
  {
    id: "recordings",
    label: "Work with recordings",
    hint: "Transcribe interviews and other recordings with the app's default speech model. The video tools make viewing copies of videos, also copies that leave out a recorded location.",
    tools: [speechTool(DEFAULT_SPEECH_MODEL), "ffmpeg"],
  },
  { id: "videos", label: "Save videos from the web", hint: "Capture links to YouTube, TikTok and similar video posts.", tools: ["video-downloader", "ffmpeg"] },
  { id: "pictures", label: "Save picture posts from the web", hint: "Capture links to Instagram and similar posts with photos.", tools: ["image-downloader"] },
  { id: "scans", label: "Read scanned documents", hint: "Recognise the text of scanned pages so they can be searched.", tools: ["ocr"] },
];

/** Already being installed (from the tools screen): not offered again. */
const running = (t: ToolInfo) => t.job?.status === "running";
const selectable = (t: ToolInfo) => t.available && !t.installed && !running(t) && usedByApp(t.id);

/**
 * Reaching the Optional tools screen, by any route, answers the first-use question (R163, R164): the
 * researcher has seen the choice. An answer already given is kept.
 */
export function recordToolsScreenSeen(memory: FirstUseMemory = localFirstUseMemory): void {
  if (!memory.get()) memory.set("seen");
}

/** The banner's question, in one sentence (R164). */
export const FIRST_USE_QUESTION = "Some features need optional tools that are not included with the app: would you like to choose which to download?";

/** After an answer the banner is gone: focus goes to the library's own "Optional tools" link, where the choice stays. */
const focusToolsLink = () => setTimeout(() => document.querySelector<HTMLElement>(`a[href="${PATHS.tools}"]`)?.focus());

/**
 * The first-use question on the open library's screen (Task 48c, D9; R164). It never opens by
 * itself: until it is answered, a non-modal banner asks it in one sentence, with "Choose tools…"
 * (which opens the dialogue) and "Not now" (which records the answer). The banner never takes focus;
 * it is announced once (a polite live region, present before the banner is put in it). `hidden`
 * keeps it off the screen (a locked project's unlock screen) without asking again; when it comes back
 * it is not announced a second time. It is mounted only on the open library's screen, so it is never
 * on the chooser or any other screen.
 */
export function FirstUseTools({ api, memory = localFirstUseMemory, hidden = false }: { api: ToolsApi; memory?: FirstUseMemory; hidden?: boolean }) {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const visible = !closed && tools !== null && !hidden;
  // Announced on its first appearance only: when it comes back (after an unlock screen), it is put
  // outside the live region.
  const [announced, setAnnounced] = useState(false);
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible) wasVisible.current = true;
    else if (wasVisible.current) setAnnounced(true);
  }, [visible]);

  useEffect(() => {
    if (closed || memory.get()) return;
    let live = true;
    const ac = new AbortController();
    api.catalogue(ac.signal).then(
      (r) => {
        if (!live || memory.get()) return;
        const list = Array.isArray(r.tools) ? r.tools : [];
        // Asked whenever it has not been answered (R158), whatever is already on this computer; not
        // when nothing at all could be downloaded here.
        setTools(r.platform !== null && list.some(selectable) ? list : null);
      },
      () => {
        // The catalogue cannot be read: the app is used without the dialogue.
      },
    );
    return () => {
      live = false;
      ac.abort();
    };
  }, [api, memory, closed]);

  const notNow = () => {
    memory.set("not-now");
    setOpen(false);
    setClosed(true);
    focusToolsLink();
  };

  const sentence = visible ? <p>{FIRST_USE_QUESTION}</p> : null;

  return (
    <>
      {/* Always present on the library screen, so the sentence put in its live region is announced
          (politely, once). The buttons sit outside the live region, so their labels are not read
          with the sentence (FR-316). */}
      <div className={visible ? "ao-first-use-live ao-first-use-banner" : "ao-first-use-live"}>
        <div role="status">{announced ? null : sentence}</div>
        {announced ? sentence : null}
        {visible ? (
          <div className="ao-actions">
            <button type="button" onClick={() => setOpen(true)}>
              Choose tools…
            </button>
            <button type="button" onClick={notNow}>
              Not now
            </button>
          </div>
        ) : null}
      </div>
      {open && visible && tools ? (
        <FirstUseDialog
          api={api}
          tools={tools}
          onCancel={() => setOpen(false)}
          onNotNow={notNow}
          onStarted={(first) => {
            memory.set("chosen");
            setOpen(false);
            setClosed(true);
            // The banner and its "Choose tools…" are gone, so focus is not given back there: the tools
            // screen brings the first started tool's heading into focus (FR-315).
            navigate(toolsHref(first));
          }}
        />
      ) : null}
    </>
  );
}

function FirstUseDialog({ api, tools, onCancel, onNotNow, onStarted }: { api: ToolsApi; tools: ToolInfo[]; onCancel: () => void; onNotNow: () => void; onStarted: (first: ToolId) => void }) {
  const id = useId();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [unticked, setUnticked] = useState<ReadonlySet<ToolId>>(new Set());
  const [started, setStarted] = useState<ReadonlySet<ToolId>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const byId = new Map(tools.map((t) => [t.id, t]));
  const offeredIds = new Set(ACTIVITIES.filter((a) => chosen.has(a.id)).flatMap((a) => a.tools));
  const offered = tools.filter((t) => offeredIds.has(t.id));
  const ticked = offered.filter((t) => selectable(t) && !unticked.has(t.id) && !started.has(t.id));
  const total = ticked.reduce((n, t) => n + remainingOf(t), 0);
  const approx = ticked.some((t) => t.sizeApproximate);
  const hosts = [...new Set(ticked.flatMap((t) => hostsOf(t, { missingOnly: true })))];
  const sizeText = formatSize(total, approx);
  const action = ticked.length === 0 ? "Download selected tools" : `Download ${ticked.length} ${ticked.length === 1 ? "tool" : "tools"} (${sizeText})`;

  const toggleActivity = (a: Activity, on: boolean) => {
    setChosen((c) => {
      const n = new Set(c);
      if (on) n.add(a.id);
      else n.delete(a.id);
      return n;
    });
    // Chosen again: its tools are offered ticked again.
    if (on) setUnticked((u) => new Set([...u].filter((t) => !a.tools.includes(t))));
  };

  const toggleTool = (t: ToolId, on: boolean) =>
    setUnticked((u) => {
      const n = new Set(u);
      if (on) n.delete(t);
      else n.add(t);
      return n;
    });

  const confirm = async () => {
    if (sending.current || ticked.length === 0) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    let firstError: unknown;
    const ok = new Set(started);
    for (const t of ticked) {
      try {
        await api.start(t.id, "install");
        ok.add(t.id);
      } catch (err) {
        failed.push(t.name);
        firstError ??= err;
      }
    }
    sending.current = false;
    if (!alive.current) return;
    setBusy(false);
    setStarted(ok);
    if (failed.length === 0) {
      onStarted(ticked[0]!.id);
      return;
    }
    setError(`${failed.join(", ")} could not be started. ${toolsErrorText(firstError, "The library service did not answer.")} Try again, or choose Not now and install later from the Optional tools screen.`);
  };

  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onCancel} busy={busy} className="ao-first-use">
      <h2 id={`${id}-t`}>Optional tools</h2>
      <p id={`${id}-d`}>
        Some tools are not included with the app, so that its download stays small. What will you do? Choose, and the tools that match are offered. Nothing is downloaded until you confirm. You can change
        this later in the settings, under Optional tools.
      </p>
      <fieldset>
        <legend>What will you do?</legend>
        {ACTIVITIES.map((a) => (
          <label key={a.id} className="ao-first-use__option">
            <input type="checkbox" checked={chosen.has(a.id)} disabled={busy} onChange={(e) => toggleActivity(a, e.target.checked)} />
            <span>
              {a.label}
              <br />
              <span className="ao-hint">{a.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {offered.length > 0 ? (
        <fieldset>
          <legend>Tools to download</legend>
          {offered.map((t) => {
            const disabled = busy || !selectable(t) || started.has(t.id);
            const checked = selectable(t) && !unticked.has(t.id) && !started.has(t.id);
            const reasonId = `${id}-${t.id}-why`;
            const why = t.installed
              ? "Already on this computer."
              : started.has(t.id)
                ? "Started."
                : running(t)
                  ? "Being installed."
                  : !t.available
                    ? `Not available on this computer. ${t.unavailableReason ?? ""}`.trim()
                    : null;
            const known = byId.get(t.id)!;
            return (
              <label key={t.id} className="ao-first-use__option">
                <input type="checkbox" checked={checked} disabled={disabled} aria-describedby={why ? reasonId : undefined} onChange={(e) => toggleTool(t.id, e.target.checked)} />
                <span>
                  <UserText>{known.name}</UserText> ({formatSize(remainingOf(known), known.sizeApproximate)})
                  <br />
                  {why ? (
                    <UserText as="span" className="ao-hint">
                      <span id={reasonId}>{why}</span>
                    </UserText>
                  ) : (
                    <UserText className="ao-hint">{known.without}</UserText>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      {offered.length > 0 ? <p>Total download: {sizeText}</p> : null}
      <p className="ao-hint">
        {/* Every entry is named; "only" is claimed only when every ticked tool lists its hosts (N1). */}
        {ticked.length > 0 && ticked.every((t) => hostsOf(t, { missingOnly: true }).length > 0) ? (
          <>
            Downloading contacts only these addresses: <UserText>{describeHosts(hosts)}</UserText>.{" "}
          </>
        ) : ticked.some((t) => hostsOf(t, { missingOnly: true }).length > 0) ? (
          <>
            Downloading contacts these servers:{" "}
            <UserText>{ticked.map((t) => `${t.name}: ${hostsOf(t, { missingOnly: true }).length > 0 ? describeHosts(hostsOf(t, { missingOnly: true })) : PUBLISHER_SERVERS}`).join("; ")}</UserText>.{" "}
          </>
        ) : (
          // FR-291, R467 M7: the servers that host a tool are not always its publisher's (a speech model is hosted by a third party).
          `Downloading contacts the servers that host each tool (the catalogue does not name them). `
        )}
        Nothing about your projects or about you is sent.
      </p>
      {error ? (
        <div role="alert" className="ao-warning">
          <UserText as="p">{error}</UserText>
        </div>
      ) : null}
      <p role="status" className="ao-visually-hidden">
        {busy ? "Starting the downloads…" : ""}
      </p>
      <div className="ao-actions">
        <button type="button" disabled={busy || ticked.length === 0} onClick={(e) => e.detail < 2 && void confirm()}>
          {action}
        </button>
        <button type="button" onClick={onNotNow} disabled={busy}>
          Not now
        </button>
      </div>
    </DialogShell>
  );
}
