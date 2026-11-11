/**
 * PLACEHOLDER (Task 34d) for the entry point to the transcript viewer, which Task 34c builds in
 * parallel. It links to `/transcript?project=<id>&source=<id>`; when 34c's screen and its path are
 * merged, the coordinator points this at that path (PATHS in navigation.tsx) or replaces this
 * component with 34c's own link. In-app navigation goes through navigate() (R118).
 */
import { inAppLink } from "../navigation";

/** Where Task 34c's transcript viewer is expected to live (not yet in the route table). */
export const TRANSCRIPT_PATH = "/transcript";

export const transcriptHref = (projectId: string, sourceId: string): string => `${TRANSCRIPT_PATH}?${new URLSearchParams({ project: projectId, source: sourceId }).toString()}`;

export function TranscriptLink({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  return (
    <a href={transcriptHref(projectId, sourceId)} onClick={inAppLink}>
      Open the transcript
    </a>
  );
}
