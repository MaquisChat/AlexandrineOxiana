/**
 * The estimate before a channel, playlist or profile is captured (whole channels, R668; spec "Before it starts"):
 * what will be downloaded, the quality, whether to transcribe, the disk and the time, then Start or Cancel. Every
 * sentence is @ao/shared's (`estimateText`, `QUALITY_LABELS`), said once with the service. The title and the disk's
 * name come from outside and are shown as user text.
 *
 * Without Video tools (`videoToolsInstalled === false`) the four better choices are disabled, said so with a link to
 * install them, and the ready-made file is offered; with them, it is not offered. Metadata only has no quality.
 * The heading takes focus when the estimate appears. Metadata only has no Transcribe box either (R683 C3); a note on
 * the box (`transcribeNote`, e.g. the project's switch could not be read) is shown beside it and describes it.
 */
import { useEffect, useId, useRef } from "react";
import {
  DEFAULT_QUALITY,
  DOWNLOAD_QUALITIES,
  estimateText,
  FALLBACK_QUALITY,
  QUALITIES_NEEDING_VIDEO_TOOLS,
  QUALITY_LABELS,
  type CaptureEstimate as Estimate,
  type DownloadQuality,
} from "@ao/shared";
import { ToolsLink } from "./MissingToolNotice";
import { UserText } from "./UserText";

export interface CaptureEstimateProps {
  estimate: Estimate;
  transcribe: boolean;
  onTranscribe(v: boolean): void;
  /** Said beside the Transcribe box, and tied to it (R683 C2). */
  transcribeNote?: string;
  quality: DownloadQuality;
  onQuality(q: DownloadQuality): void;
  onStart(): void;
  onCancel(): void;
  busy: boolean;
}

/** The quality chosen when the estimate appears: the ready-made file without Video tools, else Up to 720p. */
export const initialQuality = (e: Estimate): DownloadQuality => (e.videoToolsInstalled === false ? FALLBACK_QUALITY : DEFAULT_QUALITY);

const needsTools = (q: DownloadQuality) => QUALITIES_NEEDING_VIDEO_TOOLS.includes(q);

export function CaptureEstimate({ estimate: e, transcribe, onTranscribe, transcribeNote, quality, onQuality, onStart, onCancel, busy }: CaptureEstimateProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const noTools = e.videoToolsInstalled === false;
  // The sketch's order; the ready-made file only where Video tools are missing.
  const choices = DOWNLOAD_QUALITIES.filter((q) => noTools || q !== FALLBACK_QUALITY);
  const alreadyIn = estimateText.alreadyIn(e);
  const cutShort = estimateText.cutShort(e);
  const tooBig = estimateText.tooBig(e, quality);
  const L = estimateText.legends;
  return (
    <section className="ao-capture-estimate" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} ref={heading} tabIndex={-1}>
        <UserText>{estimateText.heading(e.kind, e.title)}</UserText>
      </h3>
      <p>{estimateText.count(e)}</p>
      {alreadyIn && <p>{alreadyIn}</p>}
      {cutShort && <p className="ao-capture__note">{cutShort}</p>}
      {!e.metadataOnly && (
        <fieldset className="ao-capture__group ao-capture-estimate__choices">
          <legend>{L.quality}</legend>
          {choices.map((q) => {
            const off = noTools && needsTools(q);
            return (
              <label key={q}>
                <input
                  type="radio"
                  name={`${id}-quality`}
                  value={q}
                  checked={quality === q}
                  disabled={off}
                  aria-describedby={off ? `${id}-tools` : undefined}
                  onChange={() => onQuality(q)}
                />{" "}
                {QUALITY_LABELS[q]}
              </label>
            );
          })}
          {noTools && (
            <p className="ao-capture__hint">
              <span id={`${id}-tools`}>{estimateText.videoToolsNeeded}</span> <ToolsLink tool="ffmpeg">{estimateText.installVideoTools}</ToolsLink>
            </p>
          )}
        </fieldset>
      )}
      {!e.metadataOnly && (
        <fieldset className="ao-capture__group ao-capture-estimate__choices">
          <legend>{L.transcribe}</legend>
          <label>
            <input
              type="checkbox"
              checked={transcribe}
              aria-describedby={transcribeNote ? `${id}-tnote` : undefined}
              onChange={(ev) => onTranscribe(ev.target.checked)}
            />{" "}
            {estimateText.transcribeLabel(e.speechModel)}
          </label>
          {transcribeNote && (
            <p className="ao-capture__hint" id={`${id}-tnote`}>
              {transcribeNote}
            </p>
          )}
        </fieldset>
      )}
      <dl className="ao-capture-estimate__facts">
        <dt>{L.disk}</dt>
        <dd>
          {/* It names the disk, as the computer calls it. */}
          <UserText as="p">{estimateText.disk(e, quality)}</UserText>
          {tooBig && <p>{tooBig}</p>}
        </dd>
        <dt>{L.time}</dt>
        <dd>
          <p>{estimateText.downloadTime(e)}</p>
          {transcribe && !e.metadataOnly && <p>{estimateText.transcribeTime(e)}</p>}
        </dd>
      </dl>
      <div className="ao-capture__actions">
        <button type="button" className="ao-capture__primary" onClick={onStart} disabled={busy}>
          {tooBig ? estimateText.startAnyway : estimateText.start}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          {estimateText.cancel}
        </button>
      </div>
    </section>
  );
}
