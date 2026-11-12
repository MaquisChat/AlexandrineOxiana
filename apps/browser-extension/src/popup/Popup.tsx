/**
 * The toolbar popup: pairing (port + 6-digit code from the desktop app), the project picker
 * (projects whose rules allow browser capture), "Capture this page", and "Capture profile as I
 * scroll" with its counter and Finish. Everything shown is React text — nothing from a page or the
 * service is ever rendered as HTML.
 *
 * When the desktop app does not answer on the saved port (R171, defect D13), the popup names the two
 * possible causes (the app is closed; the app's port changed when it was reopened) and offers "Use a
 * different port" beside "Unpair": the researcher types the port the app shows, the popup checks it
 * with one authorised request and saves it only if the app accepts the token there. It never looks
 * for a port itself (R110).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, type Api, type LocalStorageArea, type Pairing } from "../api.js";
import type { PendingByProject } from "../pending.js";
import type { BackgroundRequest, CaptureReply, ProfileStatus, ProjectChoice } from "../types.js";

export interface PopupBridge {
  api: Api;
  /** storage.local, for the researcher's own popup choices (R189); never storage.sync. */
  prefs: Pick<LocalStorageArea, "get" | "set">;
  /** The tab the popup was opened on. */
  activeTabId(): Promise<number | undefined>;
  send<T>(msg: BackgroundRequest): Promise<T>;
  pendingLinks(): Promise<PendingByProject>;
  copy(text: string): Promise<void>;
}

type Load = { state: "loading" } | { state: "unpaired" } | { state: "paired"; pairing: Pairing };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A reply that is not a profile status (no answer, or an error) means nothing is running. */
const statusOf = (r: ProfileStatus | null | undefined): ProfileStatus => (r && typeof r.active === "boolean" && typeof r.count === "number" ? r : { active: false, count: 0 });

/**
 * The researcher's last choice for "Also download media with the downloader" (R189, defect D18),
 * kept in storage.local under its own key. Anything but a stored boolean, or a read that fails,
 * means ticked, as before. The project's rules still decide whether the box is offered at all.
 */
const ALSO_DOWNLOAD = "alsoDownload";
async function readAlsoDownload(prefs: PopupBridge["prefs"]): Promise<boolean> {
  try {
    const v = (await prefs.get(ALSO_DOWNLOAD))?.[ALSO_DOWNLOAD];
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

export function Popup({ bridge }: { bridge: PopupBridge }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [port, setPort] = useState("");
  const [code, setCode] = useState("");
  const [projects, setProjects] = useState<ProjectChoice[] | undefined>();
  const [projectId, setProjectId] = useState("");
  const [alsoDownload, setAlsoDownload] = useState(true);
  /** The researcher changed the box in this opening: a stored value read late must not undo it. */
  const alsoDownloadChanged = useRef(false);
  const [tabId, setTabId] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<ProfileStatus>({ active: false, count: 0 });
  const [pending, setPending] = useState<PendingByProject>({});
  /** The app did not answer on the saved port (R171). */
  const [unreachable, setUnreachable] = useState(false);
  /** The app answered, but has no library open: said instead of "no project allows capture" (review M2). */
  const [noLibrary, setNoLibrary] = useState(false);
  /** "Use a different port": the field is open, what is typed, the check under way, why it failed. */
  const [portOpen, setPortOpen] = useState(false);
  const [newPort, setNewPort] = useState("");
  const [checking, setChecking] = useState(false);
  const [portError, setPortError] = useState("");
  const ids = useId();
  const checkingNow = useRef(false);
  const checkAbort = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const changeButton = useRef<HTMLButtonElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  const pairedLine = useRef<HTMLSpanElement>(null);
  /** Where focus goes once the field closes: back to its button, or to the line naming the new port. */
  const [focusAfter, setFocusAfter] = useState<{ to: "button" | "paired" } | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      checkAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    let current = true;
    void readAlsoDownload(bridge.prefs).then((v) => {
      if (current && !alsoDownloadChanged.current) setAlsoDownload(v);
    });
    return () => {
      current = false;
    };
  }, [bridge]);

  function chooseAlsoDownload(v: boolean) {
    alsoDownloadChanged.current = true;
    setAlsoDownload(v);
    // Remembered for the next opening; if it cannot be stored, the box still holds for this one.
    try {
      void bridge.prefs.set({ [ALSO_DOWNLOAD]: v }).catch(() => undefined);
    } catch {
      /* no storage: nothing to remember */
    }
  }

  useEffect(() => {
    if (portOpen) portInput.current?.focus();
  }, [portOpen]);

  useEffect(() => {
    if (!focusAfter) return;
    (focusAfter.to === "button" ? changeButton.current : pairedLine.current)?.focus();
  }, [focusAfter]);

  const refresh = useCallback(async () => {
    const pairing = await bridge.api.getPairing();
    setLoad(pairing ? { state: "paired", pairing } : { state: "unpaired" });
    setPending(await bridge.pendingLinks());
    const tab = await bridge.activeTabId();
    setTabId(tab);
    if (!pairing) return;
    try {
      const list = (await bridge.api.listProjects()).filter((p) => p.captureMethods.includes("browser_capture"));
      setProjects(list);
      setProjectId((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? "")));
      setUnreachable(false);
      setNoLibrary(false);
    } catch (e) {
      setProjects([]);
      setNoLibrary(e instanceof ApiError && e.code === "LIBRARY_OFFLINE");
      // Not answering: said once, with both causes and what to do, in its own notice (R171).
      // No library open: said once, in the list area (re-review M9).
      if (e instanceof ApiError && e.code === "UNREACHABLE") setUnreachable(true);
      else if (!(e instanceof ApiError && e.code === "LIBRARY_OFFLINE")) setStatus(message(e));
      if (!(await bridge.api.getPairing())) setLoad({ state: "unpaired" });
    }
    if (tab !== undefined) setProfile(statusOf(await bridge.send<ProfileStatus>({ type: "profile-status", tabId: tab })));
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While profile capture runs, keep the counter current.
  useEffect(() => {
    if (!profile.active || tabId === undefined) return;
    const t = setInterval(() => {
      void bridge.send<ProfileStatus>({ type: "profile-status", tabId }).then((r) => setProfile(statusOf(r)));
    }, 1000);
    return () => clearInterval(t);
  }, [profile.active, tabId, bridge]);

  const project = projects?.find((p) => p.id === projectId);
  const downloaderAllowed = !!project?.captureMethods.includes("downloader");

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await bridge.api.pair(port, code);
      setCode("");
      setStatus("Pairing done. Choose a project below.");
      await refresh();
    } catch (err) {
      setStatus(message(err));
    } finally {
      setBusy(false);
    }
  }

  function closePortField(focusTo: "button" | "paired") {
    checkAbort.current?.abort();
    checkAbort.current = undefined;
    checkingNow.current = false;
    setChecking(false);
    setPortOpen(false);
    setNewPort("");
    setPortError("");
    setFocusAfter({ to: focusTo });
  }

  /** One authorised request to the typed port; saved only when the app accepts the token there (R171). */
  async function checkPort(e: React.FormEvent) {
    e.preventDefault();
    if (checkingNow.current) return;
    checkingNow.current = true;
    const ac = new AbortController();
    checkAbort.current = ac;
    setChecking(true);
    setPortError("");
    try {
      const r = await bridge.api.changePort(newPort, { signal: ac.signal });
      if (!alive.current || ac.signal.aborted) return;
      const list = (r.projects ?? []).filter((p) => p.captureMethods.includes("browser_capture"));
      setLoad({ state: "paired", pairing: r.pairing });
      setProjects(list);
      setProjectId((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? "")));
      setUnreachable(false);
      setNoLibrary(r.projects === null);
      setStatus(
        r.projects === null
          ? `Connected again: this browser now uses port ${r.pairing.port}, and its pairing is unchanged.`
          : `Connected again: this browser now uses port ${r.pairing.port}, and its pairing is unchanged. Choose a project below.`,
      );
      closePortField("paired");
    } catch (err) {
      if (!alive.current || ac.signal.aborted) return;
      setPortError(message(err));
      portInput.current?.focus();
    } finally {
      if (checkAbort.current === ac) {
        checkAbort.current = undefined;
        checkingNow.current = false;
        if (alive.current) setChecking(false);
      }
    }
  }

  async function unpair() {
    if (portOpen) closePortField("button");
    setUnreachable(false);
    await bridge.api.unpair();
    setProjects(undefined);
    setStatus("Unpaired. The desktop app's list of paired extensions can remove it there too.");
    setLoad({ state: "unpaired" });
  }

  async function run<T>(msg: BackgroundRequest, working: string, after?: (r: T) => void) {
    setBusy(true);
    setStatus(working);
    try {
      const r = await bridge.send<T>(msg);
      after?.(r);
    } catch (e) {
      setStatus(message(e));
    } finally {
      setBusy(false);
    }
  }

  const showReply = (r: CaptureReply | undefined) => setStatus(r?.message ?? "No answer from the extension.");

  if (load.state === "loading") return <main className="popup"><p>Loading…</p></main>;

  if (load.state === "unpaired") {
    return (
      <main className="popup">
        <h1>Pair with the desktop app</h1>
        <p className="hint">In Alexandrine Oxiana, with your library open, choose “Browser extension” at the top of the window, then “Show a pairing code”. It shows a port number and a 6-digit code.</p>
        <form onSubmit={(e) => void pair(e)}>
          <label>
            Port
            <input inputMode="numeric" autoComplete="off" value={port} onChange={(e) => setPort(e.target.value.trim())} maxLength={5} required />
          </label>
          <label>
            Pairing code
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} maxLength={6} required />
          </label>
          <button type="submit" disabled={busy}>
            Pair
          </button>
        </form>
        <p role="status" className="status">
          {status}
        </p>
      </main>
    );
  }

  const canCapture = !busy && !!project && tabId !== undefined;
  return (
    <main className="popup">
      <p className="paired">
        <span ref={pairedLine} tabIndex={-1}>
          Paired with the desktop app (port {load.pairing.port}).
        </span>{" "}
        {unreachable || portOpen ? (
          <>
            <button type="button" className="link" ref={changeButton} aria-expanded={portOpen} aria-controls={`${ids}-port`} onClick={() => (portOpen ? closePortField("button") : setPortOpen(true))}>
              Use a different port
            </button>{" "}
          </>
        ) : null}
        <button type="button" className="link" onClick={() => void unpair()}>
          Unpair
        </button>
      </p>

      {unreachable ? (
        <div role="alert" className="notice">
          <p>The desktop app is not answering on port {load.pairing.port}.</p>
          <p>
            Either the app is closed: open it, then open this popup again. Or the app's port changed when it was reopened: its “Browser extension” page, at the top of its library window, then shows the new port. Enter that port with “Use a different port”. The pairing stays valid, so there is no need to pair again.
          </p>
        </div>
      ) : null}

      {portOpen ? (
        <form
          id={`${ids}-port`}
          aria-label="Use a different port"
          onSubmit={(e) => void checkPort(e)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closePortField("button");
            }
          }}
        >
          <label>
            New port (as shown in the desktop app)
            <input
              ref={portInput}
              inputMode="numeric"
              autoComplete="off"
              value={newPort}
              onChange={(e) => setNewPort(e.target.value.trim())}
              maxLength={5}
              required
              aria-invalid={portError ? true : undefined}
              aria-describedby={portError ? `${ids}-port-error` : undefined}
            />
          </label>
          {portError ? (
            <p id={`${ids}-port-error`} role="alert" className="error">
              {portError}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={checking} aria-busy={checking || undefined}>
              Check and save
            </button>
            <button type="button" onClick={() => closePortField("button")}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {projects === undefined ? (
        <p>Loading projects…</p>
      ) : projects.length === 0 && noLibrary ? (
        <p className="hint">No library is open in the desktop app. Open one, then open this popup again.</p>
      ) : projects.length === 0 ? (
        <p className="hint">No project allows browser capture. Allow it in a project's rules in the desktop app.</p>
      ) : (
        <>
          <label>
            Project
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy || profile.active}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={alsoDownload && downloaderAllowed} disabled={!downloaderAllowed || busy} onChange={(e) => chooseAlsoDownload(e.target.checked)} />
            Also download media with the downloader
          </label>
          {!downloaderAllowed && <p className="hint">This project's rules do not allow the downloader, so media downloads and profile capture are off.</p>}

          <div className="actions">
            <button type="button" disabled={!canCapture || profile.active} onClick={() => void run<CaptureReply>({ type: "capture-page", tabId: tabId!, projectId, alsoDownload: alsoDownload && downloaderAllowed }, "Capturing… keep this tab in front until it finishes.", showReply)}>
              Capture this page
            </button>
            {!profile.active ? (
              <button type="button" disabled={!canCapture || !downloaderAllowed} onClick={() => void run<ProfileStatus & { error?: string }>({ type: "profile-start", tabId: tabId!, projectId }, "Starting…", (r) => {
                setProfile(statusOf(r));
                setStatus(r?.error ?? "Scroll the profile yourself. Posts you scroll past are noted; nothing is clicked or opened for you.");
              })}>
                Capture profile as I scroll
              </button>
            ) : (
              <div className="profile">
                <p>
                  {profile.count} post{profile.count === 1 ? "" : "s"} noted
                </p>
                {profile.left && <p className="hint">This tab is no longer on the profile you started on, so nothing more is noted. Finish sends what was noted.</p>}
                <button type="button" disabled={busy} onClick={() => void run<CaptureReply>({ type: "profile-finish", tabId: tabId! }, "Sending…", (r) => {
                  setProfile({ active: false, count: 0 });
                  showReply(r);
                  void bridge.pendingLinks().then(setPending);
                })}>
                  Finish
                </button>
                <button type="button" disabled={busy} onClick={() => void run<ProfileStatus>({ type: "profile-cancel", tabId: tabId! }, "", (r) => {
                  setProfile(statusOf(r));
                  setStatus("Stopped. Nothing was sent.");
                })}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {Object.entries(pending).map(([pid, entry]) => (
        <section className="pending" key={pid}>
          <p>
            {entry.urls.length} link{entry.urls.length === 1 ? "" : "s"} for “{projects?.find((p) => p.id === pid)?.name ?? "another project"}” not sent: {entry.reason}.
          </p>
          <textarea readOnly value={entry.urls.join("\n")} rows={4} aria-label="Links not sent" />
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void run<CaptureReply>({ type: "pending-retry", projectId: pid }, "Sending…", (r) => {
              showReply(r);
              void bridge.pendingLinks().then(setPending);
            })}>
              Try again
            </button>
            <button type="button" onClick={() => void bridge.copy(entry.urls.join("\n")).then(() => setStatus("Copied."), (e: unknown) => setStatus(message(e)))}>
              Copy list
            </button>
            <button type="button" onClick={() => void run({ type: "pending-discard", projectId: pid }, "", () => {
              void bridge.pendingLinks().then(setPending);
              setStatus("Discarded.");
            })}>
              Discard
            </button>
          </div>
        </section>
      ))}

      <p role="status" className="status">
        {status}
      </p>
    </main>
  );
}
