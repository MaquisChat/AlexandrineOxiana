/**
 * Plays one audio or video asset through a media ticket (R135, R140).
 *
 * The ticket is asked for when the player opens and set as the element's `src` (a media element
 * cannot send the token). It is revoked when the player closes or the asset changes. A ticket ends
 * on its own (10 minutes without bytes sent, 8 hours, project locked, library closed or moved): the
 * element then fails its next read, and the player asks for a new ticket and resumes where it was,
 * playing or paused. If that is refused (locked project, closed library) it says so in plain words.
 *
 * The ticket address is a secret (R135 5): it goes to the element only — never shown as text,
 * logged, stored, or put in the page address. No `crossorigin` attribute: the service expects the
 * element's plain (no-cors) range reads.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
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
  asset: { id: string; mime: string };
  /** Accessible name of the player. */
  label: string;
  /** The playback position, as the element reports it. */
  onTime?: (seconds: number) => void;
  /** The service said the project is locked. */
  onLocked?: () => void;
  control?: MutableRefObject<PlayerControl | null>;
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "renewing" } | { kind: "failed"; message: string };

const isVideo = (mime: string) => /^video\//i.test(mime);

export function MediaTicketPlayer({ api, projectId, sourceId, asset, label, onTime, onLocked, control }: MediaTicketPlayerProps) {
  const elRef = useRef<HTMLMediaElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const apiRef = useRef(api);
  apiRef.current = api;
  const timeRef = useRef(onTime);
  timeRef.current = onTime;
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;

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
    /** Renewals since the recording last loaded data: one is tried, never a loop. */
    let renewals = 0;

    const revoke = (path: string) => {
      void api.revokeTicket(path).catch(() => {});
    };

    const attach = async () => {
      let path: string;
      try {
        path = (await api.ticket(projectId, sourceId, asset.id)).path;
      } catch (err) {
        if (!live) return;
        if (isProjectLocked(err)) lockedRef.current?.();
        const renewing = ticket !== null;
        const locked = isProjectLocked(err);
        const message = renewing
          ? locked
            ? "The project was locked, so the recording stopped. Unlock the project to play it again."
            : `The recording stopped and could not be started again. ${errorText(err, "The library service did not answer.")}`
          : locked
            ? "The recording cannot be played while the project is locked."
            : `The recording could not be opened. ${errorText(err, "The library service did not answer.")}`;
        setPhase({ kind: "failed", message });
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
        setPhase({ kind: "failed", message: "The library service gave an address the player cannot use." });
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
      if (renewals >= 1) {
        setPhase({ kind: "failed", message: "The recording could not be played. Its file may be damaged or in a format this app cannot play." });
        return;
      }
      renewals++;
      resume = { at: lastTime, play: wantPlay };
      setPhase({ kind: "renewing" });
      void attach();
    };
    const onTimeUpdate = () => {
      lastTime = el.currentTime;
      timeRef.current?.(el.currentTime);
    };
    const onPlay = () => {
      wantPlay = true;
    };
    const onPause = () => {
      wantPlay = false;
    };
    const onMetadata = () => {
      if (!resume) return;
      const r = resume;
      resume = null;
      el.currentTime = r.at;
      if (r.play) {
        const p = el.play() as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    };
    const onData = () => {
      renewals = 0;
    };
    el.addEventListener("error", onError);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("seeked", onTimeUpdate);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("loadedmetadata", onMetadata);
    el.addEventListener("loadeddata", onData);
    setPhase({ kind: "loading" });
    void attach();

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
      el.removeEventListener("error", onError);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("seeked", onTimeUpdate);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("loadedmetadata", onMetadata);
      el.removeEventListener("loadeddata", onData);
      if (control) control.current = null;
      if (ticket) revoke(ticket);
      ticket = null;
      // Stop reading: without a source the element lets its connection go.
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        /* nothing to stop */
      }
    };
  }, [projectId, sourceId, asset.id, control]);

  const Element = isVideo(asset.mime) ? "video" : "audio";
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
        <p className="ao-error" role="alert">
          {phase.message}
        </p>
      )}
    </div>
  );
}
