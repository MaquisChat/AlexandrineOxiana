/**
 * The way into the transcript viewer from a source (Task 34c): a link shown when the source has a
 * transcript or a recording. Meant to be placed in the source's details (SourceDetail) — one line
 * there: `<TranscriptLink projectId={projectId} assets={file.assets} sourceId={sourceId} />`.
 */
import { inAppLink, PATHS } from "../navigation";

/** The viewer's address for a source (ids only; never a media address). */
export const transcriptHref = (projectId: string, sourceId: string): string => `${PATHS.transcript}?${new URLSearchParams({ project: projectId, source: sourceId }).toString()}`;

/** What the link reads of a source's assets (the library's Asset has these fields). */
export interface LinkAsset {
  role: string;
  kind: string;
  mime?: string | undefined;
  status?: unknown;
}

const live = (a: LinkAsset) => a.status !== "destroyed";
const isTranscript = (a: LinkAsset) => a.role === "derived" && a.kind === "transcript" && live(a);
const isRecording = (a: LinkAsset) =>
  a.role === "original" && live(a) && (a.kind === "audio" || a.kind === "video" || (typeof a.mime === "string" && /^(audio|video)\//i.test(a.mime)));

export function TranscriptLink({ projectId, sourceId, assets }: { projectId: string; sourceId: string; assets: readonly LinkAsset[] }) {
  const transcript = assets.some(isTranscript);
  if (!transcript && !assets.some(isRecording)) return null;
  return (
    <p>
      <a href={transcriptHref(projectId, sourceId)} onClick={inAppLink}>
        {transcript ? "Open the transcript" : "Play the recording and transcribe it"}
      </a>
    </p>
  );
}
