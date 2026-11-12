/**
 * The transcript viewer's route (Task 34c): `/transcript?project=<id>&source=<id>`. App.tsx's route
 * table (R118) shows it; links come from TranscriptLink (components/TranscriptLink.tsx). Only the
 * project and source ids are ever in the address (never a media ticket, R135 5).
 */
import { useMemo } from "react";
import type { ApiClient } from "../api/client";
import { toolsApi } from "../api/tools";
import { transcriptApi } from "../api/transcripts";
import { normalisePath, PATHS, type AppLocation } from "../navigation";
import { TranscriptViewer } from "../screens/TranscriptViewer";

export const isTranscriptPath = (path: string): boolean => normalisePath(path) === PATHS.transcript;

export function TranscriptRoute({ client, loc }: { client: ApiClient; loc: AppLocation }) {
  const api = useMemo(() => transcriptApi(client), [client]);
  const tools = useMemo(() => toolsApi(client), [client]);
  const q = new URLSearchParams(loc.search);
  const projectId = q.get("project") ?? "";
  const sourceId = q.get("source") ?? "";
  if (!projectId || !sourceId) {
    return (
      <main className="ao-page" aria-labelledby="ao-transcript-none">
        <h1 id="ao-transcript-none">Transcript</h1>
        <p>No source is named in this address. Open a source in the library and choose its transcript.</p>
      </main>
    );
  }
  return <TranscriptViewer api={api} tools={tools} projectId={projectId} sourceId={sourceId} />;
}
