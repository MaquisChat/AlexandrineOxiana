/**
 * Plays one audio or video asset through a media ticket (R135, R140).
 *
 * The ticket is asked for when the player opens and set as the element's `src` (a media element
 * cannot send the token). It is revoked when the player closes or the asset changes. A ticket ends
 * on its own (10 minutes without bytes sent, 8 hours, project locked, library closed or moved): the
 * element then fails its next read, and the player asks for a new ticket and resumes where it was,
 * playing or paused. If that is refused (locked project, closed library) it says so in plain words.
 *
 * Renewal is not a loop (R143): a recording is renewed at most twice without real progress — the
 * position moving RENEWAL_PROGRESS_S beyond where it failed; loading alone does not count — and a
 * place that fails a third time (within SAME_PLACE_S) ends it however much was played in between.
 * Then the player stops, says so, and offers "Try the recording again". Every ticket is revoked
 * once it is replaced or given up. A failure after the element was idle longer than a ticket lives
 * unused is the ticket ending on its own: it is renewed and counts toward none of these (FR-260).
 *
 * The position is kept by the player, not read back from the element while a new `src` loads: a
 * browser reports 0 then, and a resume seeks to the kept position before any report counts.
 *
 * A recording never starts by itself (R362 f): what the researcher does while a ticket is renewed is
 * kept. A pause pressed then ends the renewal paused; a play pressed then plays when it lands; a seek
 * made then is where it resumes. Until the new `src` is set every pause, play and seek the element
 * reports is the researcher's; after it, a pause is the browser's own (the source changed) unless the
 * researcher pressed play since.
 *
 * The ticket address is a secret (R135 5): it goes to the element only — never shown as text,
 * logged, stored, or put in the page address. No `crossorigin` attribute: the service expects the
 * element's plain (no-cors) range reads.
 */
import { MEDIA_TICKET_IDLE_MS } from "@ao/shared";
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
/**
 * Failures this close (seconds) count as the same place: a place that fails this many times
 * (MAX_RENEWALS_WITHOUT_PROGRESS) ends in the plain message, however much was played elsewhere.
 */
export const SAME_PLACE_S = 2;
/** A reported time this close to a resume target means the resume seek has landed. */
const SEEK_TOLERANCE_S = 1;

/**
 * A resume in progress: where to seek, whether to play, whether its seek was issued, whether the new
 * `src` was set (R362 f: before it, the element's events are the researcher's), and whether the
 * researcher pressed play after it (a pause after that is theirs too).
 */
interface Pending {
  at: number;
  play: boolean;
  seekIssued: boolean;
  srcSet: boolean;
  playedSince: boolean;
}

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
    /**
     * The position the researcher is at, kept apart from what the element reports: when a new
     * `src` is set (or the element is emptied) a browser resets its position to 0 and fires
     * `timeupdate` before any seek. That 0 is never taken as the position (R143, review I1b).
     */
    let position = 0;
    let wantPlay = false;
    /**
     * A resume in progress after a new `src`: where to seek and whether to play. Until the seek has
     * completed (`seeked`, or a reported time at the target), the element's reported time is ignored.
     */
    let pending: Pending | null = null;
    /** Given up (or refused): the element's reports are ignored until Try again. */
    let halted = false;
    let stopped = { at: 0, play: false };
    /** Renewals since playback last made real progress, and where the last failure happened. */
    let renewals = 0;
    let failedAt = 0;
    /** Every failure position since the player opened (or Try again): a damaged place is bounded. */
    let failures: number[] = [];
    /**
     * When the element last did anything (a new source, a time report, a play, a seek, bytes read).
     * A failure after longer than a ticket lives unused is the ticket ending on its own, not damage
     * (FR-260): it is renewed without counting as a strike, so long pauses near one spot never read
     * as "may be damaged". It cannot loop: each such failure needs that long without activity.
     */
    let lastActivity = Date.now();
    const active = () => {
      lastActivity = Date.now();
    };

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

    const halt = (phase: Phase) => {
      stopped = pending ? { at: pending.at, play: pending.play } : { at: position, play: wantPlay };
      pending = null;
      halted = true;
      release();
      setPhase(phase);
    };

    const attach = async (renewing: boolean) => {
      let path: string;
      try {
        path = (await api.ticket(projectId, sourceId, asset.id)).path;
      } catch (err) {
        if (!live) return;
        if (isProjectLocked(err)) lockedRef.current?.();
        halt({ kind: "failed", message: refusal(err, renewing), retry: !isProjectLocked(err) });
        return;
      }
      if (!live || halted) {
        revoke(path);
        return;
      }
      let address: string;
      try {
        address = api.mediaUrl(path);
      } catch {
        revoke(path);
        halt({ kind: "failed", message: "The library service gave an address the player cannot use.", retry: true });
        return;
      }
      const old = ticket;
      ticket = path;
      if (old && old !== path) revoke(old);
      el.src = address;
      active();
      if (pending) pending.srcSet = true;
      setPhase({ kind: "ready" });
    };

    const onError = () => {
      if (!ticket || !live || halted) return;
      const at = pending ? pending.at : position;
      const play = pending ? pending.play : wantPlay;
      const idleExpiry = Date.now() - lastActivity >= MEDIA_TICKET_IDLE_MS;
      if (idleExpiry) renewals = 0;
      const samePlace = idleExpiry ? 0 : failures.filter((f) => Math.abs(f - at) <= SAME_PLACE_S).length;
      if (!idleExpiry) failures.push(at);
      if (renewals >= MAX_RENEWALS_WITHOUT_PROGRESS || samePlace >= MAX_RENEWALS_WITHOUT_PROGRESS) {
        pending = { at, play, seekIssued: false, srcSet: false, playedSince: false };
        halt({ kind: "failed", message: `The recording could not be played: it stopped at the same place again. Its file may be damaged or in a format this app cannot play. You can choose ${RETRY}.`, retry: true });
        return;
      }
      renewals++;
      failedAt = at;
      position = at;
      pending = { at, play, seekIssued: false, srcSet: false, playedSince: false };
      setPhase({ kind: "renewing" });
      void attach(true);
    };
    const onTimeUpdate = (e: Event) => {
      if (halted) return;
      active();
      if (pending) {
        // FR-259: `playing` after the resume seek was issued also ends the wait, so a seek that never
        // reports landing does not leave the player ignoring the element's time for good.
        const done = pending.seekIssued && (e.type === "seeked" || e.type === "playing" || Math.abs(el.currentTime - pending.at) < SEEK_TOLERANCE_S);
        if (!done) return;
        // R371 b: a pause or a play pressed after the metadata, before the seek landed, is what the next renewal resumes with.
        wantPlay = pending.play;
        pending = null;
      }
      position = el.currentTime;
      if (renewals > 0 && position >= failedAt + RENEWAL_PROGRESS_S) renewals = 0;
      timeRef.current?.(position);
    };
    const onPlay = () => {
      if (halted) return;
      active();
      if (!pending) wantPlay = true;
      else {
        // R362 f: a play pressed during a renewal still plays when it lands.
        pending.play = true;
        if (pending.srcSet) pending.playedSince = true;
      }
    };
    const onPause = () => {
      if (halted) return;
      if (!pending) wantPlay = false;
      // R362 f: a pause pressed during a renewal is kept: it ends paused. A browser pauses an element whose source
      // changes: after the new `src` that pause is not the researcher's, unless they pressed play since.
      else if (!pending.srcSet || pending.playedSince) pending.play = false;
    };
    const onSeeking = () => {
      if (halted) return;
      active();
      // R371 c: a seek's target is recorded when it is asked, so a ticket that ends before it lands resumes there.
      if (!pending) {
        position = el.currentTime;
        return;
      }
      // R362 f: a seek by the researcher while the new ticket is asked for: the renewal resumes there.
      if (pending.srcSet) return;
      pending.at = el.currentTime;
      position = pending.at;
      timeRef.current?.(position);
    };
    const onMetadata = () => {
      if (!pending || pending.seekIssued || !ticket || halted) return;
      pending.seekIssued = true;
      el.currentTime = pending.at;
      wantPlay = pending.play;
      if (pending.play) {
        const p = el.play() as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => {});
      } else if (!el.paused) el.pause();
    };
    el.addEventListener("error", onError);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("seeked", onTimeUpdate);
    el.addEventListener("playing", onTimeUpdate);
    el.addEventListener("progress", active);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("loadedmetadata", onMetadata);
    setPhase({ kind: "loading" });
    void attach(false);

    retryRef.current = () => {
      if (!live) return;
      halted = false;
      renewals = 0;
      failures = [];
      position = stopped.at;
      pending = { at: stopped.at, play: stopped.play, seekIssued: false, srcSet: false, playedSince: false };
      setPhase({ kind: "loading" });
      void attach(false);
    };

    if (control) {
      control.current = {
        seek: (sec) => {
          position = sec;
          if (halted) stopped = { ...stopped, at: sec };
          else if (pending) {
            pending.at = sec;
            if (pending.seekIssued) el.currentTime = sec;
          } else el.currentTime = sec;
          timeRef.current?.(sec);
        },
      };
    }

    return () => {
      live = false;
      retryRef.current = null;
      el.removeEventListener("error", onError);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("seeked", onTimeUpdate);
      el.removeEventListener("playing", onTimeUpdate);
      el.removeEventListener("progress", active);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("seeking", onSeeking);
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
