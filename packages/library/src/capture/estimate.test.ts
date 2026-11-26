/**
 * The estimate before a channel, playlist or profile is captured (whole channels, Task 4): it counts
 * only what will be downloaded, sums the lengths it knows, and never guesses the others.
 */
import { DEFAULT_SPEECH_MODEL, type CaptureEstimate } from "@ao/shared";
import { describe, expect, it } from "vitest";
import { WorkerJobError, WorkerToolError, WorkerUnavailableError } from "../worker-client.js";
import { estimateCapture } from "./estimate.js";
import type { ProfileListing } from "./profile-capture.js";

const entry = (id: string, known: boolean, durationSec?: number): ProfileListing["entries"][number] => ({
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  raw: {},
  listing: "videos",
  known,
  ...(durationSec !== undefined ? { durationSec } : {}),
});
const listing = (entries: ProfileListing["entries"], over: Partial<ProfileListing> = {}): ProfileListing => ({
  status: "listed",
  platform: "youtube",
  kind: "channel",
  title: "Example Channel",
  entries,
  listComplete: true,
  ...over,
});
const disk = { freeBytes: 380e9, diskName: "Macintosh HD" };

describe("estimateCapture", () => {
  it("counts only what is not yet in the project and sums the known lengths", async () => {
    const e = await estimateCapture(
      listing([entry("a", false, 3600), entry("b", true, 7200), entry("c", false, 1800), entry("d", true)]),
      { transcribe: true, quality: "720p" },
      disk,
    );
    expect(e).toEqual({
      kind: "channel",
      platform: "youtube",
      title: "Example Channel",
      count: 2,
      alreadyInProject: 2,
      soundSeconds: 5400,
      unknownLengths: 0,
      listComplete: true,
      freeBytes: 380e9,
      diskName: "Macintosh HD",
      videoToolsInstalled: null,
      speechModel: DEFAULT_SPEECH_MODEL,
      metadataOnly: false,
    } satisfies CaptureEstimate);
    // the chosen model, metadata only, a list cut short and an unknown disk are carried as they are
    const f = await estimateCapture(listing([entry("a", false, 60)], { listComplete: false, kind: "playlist", platform: "tiktok" }), { transcribe: true, transcribeModel: "small", metadataOnly: true }, { freeBytes: null, diskName: null });
    expect(f).toMatchObject({ kind: "playlist", platform: "tiktok", speechModel: "small", metadataOnly: true, listComplete: false, freeBytes: null, diskName: null, count: 1, soundSeconds: 60 });
    // nothing new: count 0, still an estimate (Start still runs)
    expect(await estimateCapture(listing([entry("a", true, 60)]), { transcribe: false }, disk)).toMatchObject({ count: 0, alreadyInProject: 1, soundSeconds: 0, unknownLengths: 0 });
  });

  it("unknown lengths are counted, not guessed", async () => {
    const e = await estimateCapture(listing([entry("a", false), entry("b", false, 600), entry("c", false), entry("d", true)]), { transcribe: false }, disk);
    expect(e).toMatchObject({ count: 3, alreadyInProject: 1, soundSeconds: 600, unknownLengths: 2 });
    const all = await estimateCapture(listing([entry("a", false), entry("b", false)]), { transcribe: false }, disk);
    expect(all).toMatchObject({ count: 2, soundSeconds: 0, unknownLengths: 2 });
  });

  it("a slowed-down listing throws RATE_LIMITED", async () => {
    const slowed = listing([], { status: "rate-limited", errorCode: "RATE_LIMITED", listComplete: false });
    const err = await estimateCapture(slowed, { transcribe: false }, disk).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerJobError).code).toBe("RATE_LIMITED");
    // a failed listing throws with its code, and names a missing tool
    const tool = await estimateCapture(listing([], { status: "failed", errorCode: "TOOL_NOT_INSTALLED", tool: "video-downloader" }), { transcribe: false }, disk).catch((x: unknown) => x);
    expect(tool).toBeInstanceOf(WorkerToolError);
    expect([(tool as WorkerToolError).code, (tool as WorkerToolError).tool]).toEqual(["TOOL_NOT_INSTALLED", "video-downloader"]);
    const other = await estimateCapture(listing([], { status: "failed", errorCode: "EXTRACTOR_ERROR" }), { transcribe: false }, disk).catch((x: unknown) => x);
    expect(other).toBeInstanceOf(WorkerJobError);
    expect((other as WorkerJobError).code).toBe("EXTRACTOR_ERROR");
    // the media helper not running is the error the service already answers as 503
    const gone = await estimateCapture(listing([], { status: "failed", errorCode: "WORKER_UNAVAILABLE" }), { transcribe: false }, disk).catch((x: unknown) => x);
    expect(gone).toBeInstanceOf(WorkerUnavailableError);
  });
});
