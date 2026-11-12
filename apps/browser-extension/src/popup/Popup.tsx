/**
 * The toolbar popup: pairing (port + 6-digit code from the desktop app), the project picker
 * (projects whose rules allow browser capture), "Capture this page", and "Capture profile as I
 * scroll" with its counter and Finish. Everything shown is React text — nothing from a page or the
 * service is ever rendered as HTML.
 */
import { useCallback, useEffect, useState } from "react";
import type { Api, Pairing } from "../api.js";
import type { PendingByProject } from "../pending.js";
import type { BackgroundRequest, CaptureReply, ProfileStatus, ProjectChoice } from "../types.js";

export interface PopupBridge {
  api: Api;
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

export function Popup({ bridge }: { bridge: PopupBridge }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [port, setPort] = useState("");
  const [code, setCode] = useState("");
  const [projects, setProjects] = useState<ProjectChoice[] | undefined>();
  const [projectId, setProjectId] = useState("");
  const [alsoDownload, setAlsoDownload] = useState(true);
  const [tabId, setTabId] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<ProfileStatus>({ active: false, count: 0 });
  const [pending, setPending] = useState<PendingByProject>({});

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
    } catch (e) {
      setProjects([]);
      setStatus(message(e));
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

  async function unpair() {
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
        <span>Paired with the desktop app (port {load.pairing.port}).</span>{" "}
        <button type="button" className="link" onClick={() => void unpair()}>
          Unpair
        </button>
      </p>

      {projects === undefined ? (
        <p>Loading projects…</p>
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
            <input type="checkbox" checked={alsoDownload && downloaderAllowed} disabled={!downloaderAllowed || busy} onChange={(e) => setAlsoDownload(e.target.checked)} />
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
