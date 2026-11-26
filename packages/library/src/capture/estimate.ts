/**
 * The estimate before a channel, playlist or profile is captured (whole channels, Task 4): from one
 * listing, what would be downloaded (only the videos not yet in the project), the length of sound
 * the listing gives for them, and how many have no known length. Nothing is guessed. The service
 * fills in whether Video tools are installed, and the measured transcription speed.
 */
import { DEFAULT_SPEECH_MODEL, type CaptureEstimate, type CapturePlatform } from "@ao/shared";
import { WorkerJobError, WorkerToolError, WorkerUnavailableError } from "../worker-client.js";
import type { RunOptions } from "./download-run.js";
import { plainReason } from "./errors.js";
import type { ProfileListing } from "./profile-capture.js";

/**
 * The estimate of one listing. A listing the platform slowed down throws WorkerJobError
 * RATE_LIMITED; a failed one throws with its code (WorkerToolError naming a missing tool;
 * WorkerUnavailableError when the media helper is not running).
 */
export async function estimateCapture(
  listing: ProfileListing,
  opts: RunOptions,
  disk: { freeBytes: number | null; diskName: string | null },
): Promise<CaptureEstimate> {
  if (listing.status === "rate-limited") throw new WorkerJobError("RATE_LIMITED", plainReason("RATE_LIMITED"));
  if (listing.status === "failed") {
    const code = listing.errorCode ?? "EXTRACTOR_ERROR";
    if (code === "WORKER_UNAVAILABLE") throw new WorkerUnavailableError(plainReason(code));
    if (listing.tool) throw new WorkerToolError(code, plainReason(code), listing.tool);
    throw new WorkerJobError(code, plainReason(code));
  }
  const fresh = listing.entries.filter((e) => !e.known);
  const known = (s: number | undefined): s is number => typeof s === "number" && Number.isFinite(s) && s > 0;
  return {
    kind: listing.kind,
    platform: listing.platform as CapturePlatform,
    title: listing.title,
    count: fresh.length,
    alreadyInProject: listing.entries.length - fresh.length,
    soundSeconds: fresh.reduce((sum, e) => sum + (known(e.durationSec) ? e.durationSec : 0), 0),
    unknownLengths: fresh.filter((e) => !known(e.durationSec)).length,
    listComplete: listing.listComplete,
    freeBytes: disk.freeBytes,
    diskName: disk.diskName,
    videoToolsInstalled: null,
    speechModel: opts.transcribeModel ?? DEFAULT_SPEECH_MODEL,
    metadataOnly: opts.metadataOnly === true,
  };
}
