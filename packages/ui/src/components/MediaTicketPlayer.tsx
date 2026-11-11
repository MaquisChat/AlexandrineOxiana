/**
 * Plays one audio or video asset through a media ticket (R135, R140).
 *
 * The ticket is asked for when the player opens and set as the element's `src` (a media element
 * cannot send the token). It is revoked when the player closes or the asset changes. A ticket ends
 * on its own (10 minutes without bytes sent, 8 hours, project locked, library closed or moved): the
 * element then fails its next read, and the player asks for a new ticket and resumes where it was,
 * playing or paused. If that is refused (locked project, closed library) it says so in plain words.
 *
 * Renewal is not a loop (R143): a recording that fails again at the same place (a damaged or cut
 * file, for example) is renewed at most twice without real progress — the position moving
 * RENEWAL_PROGRESS_S beyond where it failed; loading alone does not count. Then the player stops,
 * says so, and offers "Try the recording again". Every ticket is revoked once it is replaced or
 * given up.
 *
 * The ticket address is a secret (R135 5): it goes to the element only — never shown as text,
 * logged, stored, or put in the page address. No `crossorigin` attribute: the service expects the
 * element's plain (no-cors) range reads.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { ApiClientError } from "../api/client";
import { errorText, isProjectLocked } from "../api/library";
import type { TranscriptApi } from "../api/transcripts";

export interface PlayerControl {
  /** Moves playback to `seconds` (playing stays playing, paused stays paused). */
  seek(seconds: number): void;
}

export interface MediaTicketPlayerProps {
  api: Pick<TranscriptApi, "ticket" | "revokeTicket" | "mediaUrl">;
  projectId: string;
  sourceId: string;
  /** `kind` ("audio" / "video") chooses the element when the recorded type is missing. */
  asset: { id: string; mime: string; kind?: string };
  /** Accessible name of the player. */
  label: string;
  /** The playback position, as the element reports it. */
  onTime?: (seconds: number) => void;
  /** The service said the project is locked. */
  onLocked?: () => void;
  control?: MutableRefObject<PlayerControl | null>;
}

/** Renewals allowed in a row without real progress. */
export const MAX_RENEWALS_WITHOUT_PROGRESS = 2;
/** How far (seconds) playback must move beyond the failure for it to count as progress. */
export const RENEWAL_PROGRESS_S = 3;

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "renewing" } | { kind: "failed"; message: string; retry: boolean };

const isVideo = (asset: { mime: string; kind?: string }) => /^video\//i.test(asset.mime) || (!/^audio\//i.test(asset.mime) && asset.kind === "video");

const RETRY = "Try the recording again";

function refusal(err: unknown, renewing: boolean): string {
  if (isProjectLocked(err)) return renewing ? "The project was locked, so the recording stopped. Unlock the project to play it again." : "The recording cannot be played while the project is locked.";
  if (err instanceof ApiClientError && err.code === "RATE_LIMITED") {
    return `${renewing ? "The recording stopped" : "The recording could not be opened"}: too many recordings are open at once. Close another recording, then choose ${RETRY}.`;
  }
  return renewing
    ? `The recording stopped and could not be started again. ${errorText(err, "The library service did not answer.")}`
    : `The recording could not be opened. ${errorText(err, "The library service did not answer.")}`;
}

export function MediaTicketPlayer({ api, projectId, sourceId, asset, label, onTime, onLocked, control }: MediaTicketPlayerProps) {
  const elRef = useRef<HTMLMediaElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const apiRef = useRef(api);
  apiRef.current = api;
  const timeRef = useRef(onTime);
  timeRef.current = onTime;
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;
  const retryRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const api = apiRef.current;
    let live = true;
    /** The ticket address in use (a secret: kept here only, to revoke it). */
    let ticket: string | null = null;
    /** Where to resume once a renewed ticket's recording has loaded. */
    let resume: { at: number; play: boolean } | null = null;
    let wantPlay = false;
    let lastTime = 0;
    /** Renewals since playback last made real progress, and where the last failure happened. */
    let renewals = 0;
    let failedAt = 0;

    const revoke = (path: string) => {
      void api.revokeTicket(path).catch(() => {});
    };

    /** Lets go of the ticket and stops the element reading. */
    const release = () => {
      if (ticket) revoke(ticket);
      ticket = null;
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        /* nothing to stop */
      }
    };

    const attach = async (renewing: boolean) => {
      let path: string;
      try {
        path = (await api.ticket(projectId, sourceId, asset.id)).path;
      } catch (err) {
        if (!live) return;
        if (isProjectLocked(err)) lockedRef.current?.();
        release();
        setPhase({ kind: "failed", message: refusal(err, renewing), retry: !isProjectLocked(err) });
        return;
      }
      if (!live) {
        revoke(path);
        return;
      }
      let address: string;
      try {
        address = api.mediaUrl(path);
      } catch {
        revoke(path);
        release();
        setPhase({ kind: "failed", message: "The library service gave an address the player cannot use.", retry: true });
        return;
      }
      const old = ticket;
      ticket = path;
      if (old && old !== path) revoke(old);
      el.src = address;
      setPhase({ kind: "ready" });
    };

    const onError = () => {
      if (!ticket || !live) return;
      resume = { at: lastTime, play: wantPlay };
      if (renewals >= MAX_RENEWALS_WITHOUT_PROGRESS) {
        release();
        setPhase({ kind: "failed", message: `The recording could not be played: it stopped at the same place again. Its file may be damaged or in a format this app cannot play. You can choose ${RETRY}.`, retry: true });
        return;
      }
      renewals++;
      failedAt = lastTime;
      setPhase({ kind: "renewing" });
      void attach(true);
    };
    const onTimeUpdate = () => {
      lastTime = el.currentTime;
      if (renewals > 0 && lastTime >= failedAt + RENEWAL_PROGRESS_S) renewals = 0;
      timeRef.current?.(el.currentTime);
    };
    const onPlay = () => {
      wantPlay = true;
    };
    const onPause = () => {
      wantPlay = false;
    };
    const onMetadata = () => {
      if (!resume || !ticket) return;
      const r = resume;
      resume = null;
      el.currentTime = r.at;
      if (r.play) {
        const p = el.play() as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    };
    el.addEventListener("error", onError);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("seeked", onTimeUpdate);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("loadedmetadata", onMetadata);
    setPhase({ kind: "loading" });
    void attach(false);

    retryRef.current = () => {
      if (!live) return;
      renewals = 0;
      resume = { at: lastTime, play: resume?.play ?? false };
      setPhase({ kind: "loading" });
      void attach(false);
    };

    if (control) {
      control.current = {
        seek: (s) => {
          el.currentTime = s;
          lastTime = s;
          timeRef.current?.(s);
        },
      };
    }

    return () => {
      live = false;
      retryRef.current = null;
      el.removeEventListener("error", onError);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("seeked", onTimeUpdate);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("loadedmetadata", onMetadata);
      if (control) control.current = null;
      release();
    };
  }, [projectId, sourceId, asset.id, control]);

  const Element = isVideo(asset) ? "video" : "audio";
  return (
    <div className="ao-tx__player">
      <Element key={asset.id} ref={elRef as never} controls preload="metadata" aria-label={label} className="ao-tx__media" />
      {phase.kind === "loading" && (
        <p className="ao-muted" role="status">
          Opening the recording…
        </p>
      )}
      {phase.kind === "renewing" && (
        <p className="ao-muted" role="status">
          Reconnecting the recording…
        </p>
      )}
      {phase.kind === "failed" && (
        <div className="ao-row">
          <p className="ao-error" role="alert">
            {phase.message}
          </p>
          {phase.retry && (
            <button type="button" onClick={() => retryRef.current?.()}>
              {RETRY}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
