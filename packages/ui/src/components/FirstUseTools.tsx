/**
 * The first-use tools dialogue (Task 48b; R126, R133, R152). It belongs to the open library's
 * screen and waits for a quiet moment there (Task 48c, D9: see `FirstUseTools` for the rule). While
 * the question is not yet answered, it asks what the researcher will do
 * and offers the matching tools pre-selected, with the total download size and the hosts each
 * download contacts (from the catalogue). Nothing is downloaded until "Download …" is pressed; each
 * chosen tool is then one install job (one request each), and the Optional tools screen opens to
 * show their progress. "Not now" (or Escape) is always there and is remembered, so the dialogue does
 * not come back; the same choices stay on the Optional tools screen in the settings. The dialogue
 * never blocks the app: when the catalogue cannot be read (the media helper is not running, or the
 * page is not the desktop app) it does not open at all.
 *
 * Where the answer is remembered: `FirstUseMemory`. The service has no route for this setting yet,
 * so the default keeps it in the app's own web storage on this computer (never in a library); a
 * service-backed store can replace it without changing the dialogue.
 */
import type { ToolId, ToolInfo } from "@ao/shared";
import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_SPEECH_MODEL, describeHosts, formatSize, hostsOf, PUBLISHER_SERVERS, remainingOf, speechTool, toolsErrorText, usedByApp, type ToolsApi } from "../api/tools";
import { navigate, PATHS } from "../navigation";
import { DialogShell } from "./ReasonDialog";
import { UserText } from "./UserText";
import "../screens/GovernanceScreens.css";
import "../screens/ToolsSetup.css";

export type FirstUseAnswer = "not-now" | "chosen";

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
      return v === "not-now" || v === "chosen" ? v : null;
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

/** Some other dialog is open (a recovery code, a confirmation): this one waits until it has closed. */
const otherDialogOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;

/** Inputs that take no typing: focus on one of these does not hold the question back. */
const NOT_TYPED = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** A field the researcher types into (or chooses from) has focus. */
const fieldHasFocus = () => {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type);
  return el instanceof HTMLElement && (el.isContentEditable || el.getAttribute("contenteditable") === "true");
};

/** How long nothing may have been typed or clicked before the question opens (D9). */
export const FIRST_USE_QUIET_MS = 1500;

/** What counts as the researcher doing something. */
const ACTIVITY_EVENTS = ["keydown", "pointerdown", "mousedown", "input", "paste", "drop"] as const;

/**
 * The first-use question, on the library screen (Task 48c, D9). It is mounted only there, so it is
 * never asked over the library chooser or any other screen. Until it is answered a quiet line on the
 * screen offers the Optional tools screen. The dialogue itself opens only when all of these hold: no
 * other dialog is open, no text field has focus, and nothing has been typed or clicked for
 * `quietMs` (by default 1.5 s); the moment any of them stops holding, the wait starts again. It never
 * takes focus from a field, and when it closes focus goes back to where it was.
 */
export function FirstUseTools({ api, memory = localFirstUseMemory, quietMs = FIRST_USE_QUIET_MS }: { api: ToolsApi; memory?: FirstUseMemory; quietMs?: number }) {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [ready, setReady] = useState(false);
  const [closed, setClosed] = useState(false);

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

  // Never over another dialog, never while a field has focus, never while the researcher is busy.
  useEffect(() => {
    if (!tools || ready || closed) return;
    let last = Date.now();
    const busy = () => {
      last = Date.now();
    };
    for (const e of ACTIVITY_EVENTS) document.addEventListener(e, busy, true);
    const t = setInterval(
      () => {
        if (otherDialogOpen() || fieldHasFocus()) busy();
        else if (Date.now() - last >= quietMs) setReady(true);
      },
      Math.max(50, Math.min(250, quietMs)),
    );
    return () => {
      clearInterval(t);
      for (const e of ACTIVITY_EVENTS) document.removeEventListener(e, busy, true);
    };
  }, [tools, ready, closed, quietMs]);

  if (closed || !tools) return null;
  const note = (
    <p className="ao-hint ao-first-use-note">
      Some features use optional tools that are not included with the app.{" "}
      <a
        href={PATHS.tools}
        onClick={(e) => {
          e.preventDefault();
          navigate(PATHS.tools);
        }}
      >
        Set up optional tools
      </a>
      , now or whenever you like.
    </p>
  );
  if (!ready) return note;
  return (
    <>
      {note}
      <FirstUseDialog
        api={api}
        tools={tools}
        onNotNow={() => {
          memory.set("not-now");
          setClosed(true);
        }}
        onStarted={() => {
          memory.set("chosen");
          setClosed(true);
          navigate(PATHS.tools);
        }}
      />
    </>
  );
}

function FirstUseDialog({ api, tools, onNotNow, onStarted }: { api: ToolsApi; tools: ToolInfo[]; onNotNow: () => void; onStarted: () => void }) {
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
      onStarted();
      return;
    }
    setError(`${failed.join(", ")} could not be started. ${toolsErrorText(firstError, "The library service did not answer.")} Try again, or choose Not now and install later from the Optional tools screen.`);
  };

  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onNotNow} busy={busy} className="ao-first-use">
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
          `Downloading contacts each tool's publisher's servers (the catalogue does not name them). `
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
