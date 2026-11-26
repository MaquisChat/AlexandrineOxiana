/**
 * The stand-in media worker (testing.ts) against the real worker's own rules (R674 B): the same error
 * names, the same arguments per quality, the same refusals and the same platform reasons as
 * services/media-worker/ao_worker/download.py, so that the tests built on it prove what the app does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_TOOLS_DIR, STUB_TOKEN, downloadKept, gallerydlArgs, mapError, platformReason, startToolWorker, ytdlpArgs, type ToolWorker } from "./testing.js";

// The worker's tests/test_download.py: test_map_error, test_map_error_gallery_dl_http_answers_and_fragments,
// and the two single cases after them (copied as they are).
const GDL_WARN = "[urllib3.connectionpool][warning] Retrying (Retry(total=3)) after connection broken by 'ReadTimeoutError(\"Read timed out. (read timeout=30)\")'";
const WORKER_CASES: Array<[string, string]> = [
  ["ERROR: [youtube] x: Sign in to confirm you're not a bot", "LOGIN_REQUIRED"],
  ["ERROR: [instagram] x: login required to access this", "LOGIN_REQUIRED"],
  ["ERROR: unable to download webpage: HTTP Error 429: Too Many Requests", "RATE_LIMITED"],
  ["ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader", "NOT_FOUND_OR_REMOVED"],
  ["ERROR: HTTP Error 404: Not Found", "NOT_FOUND_OR_REMOVED"],
  ["ERROR: [youtube] x: The uploader has not made this video available in your country", "GEO_BLOCKED"],
  ["ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", "PRIVATE"],
  ["ERROR: [tiktok] x: Unable to extract universal data for rehydration", "EXTRACTOR_ERROR"],
  ["ERROR: unable to write data: [Errno 28] No space left on device", "DISK_FULL"],
  ["ERROR: [youtube] x: Unable to download webpage: <urlopen error timed out>", "NETWORK_LOST"],
  ["ERROR: [youtube] x: Read timed out.", "NETWORK_LOST"],
  ["ERROR: unable to download video data: Connection reset by peer", "NETWORK_LOST"],
  ["ERROR: [youtube] x: Temporary failure in name resolution", "NETWORK_LOST"],
  ["ERROR: [youtube] abc: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)", "NOT_FOUND_OR_REMOVED"],
  ["ERROR: unable to download video data: HTTP Error 403: Forbidden", "EXTRACTOR_ERROR"],
  ["ERROR: [youtube] abc: Unable to download webpage: HTTP Error 429: Too Many Requests", "RATE_LIMITED"],
  ["ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution> (caused by URLError(...))", "NETWORK_LOST"],
  ["ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>", "NETWORK_LOST"],
  ["ERROR: unable to download video data: [Errno 104] Connection reset by peer", "NETWORK_LOST"],
  ["ERROR: [youtube] abc: Unable to download webpage: The read operation timed out", "NETWORK_LOST"],
  ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "NOT_FOUND_OR_REMOVED"],
  // test_map_error_gallery_dl_http_answers_and_fragments
  [GDL_WARN + "\n[instagram][error] HttpError: '404 Not Found' for 'https://www.instagram.com/p/abc/'", "NOT_FOUND_OR_REMOVED"],
  ["[instagram][error] HttpError: '429 Too Many Requests' for 'https://www.instagram.com/p/abc/'", "RATE_LIMITED"],
  ["ERROR: [youtube] abc: Unable to download webpage: HTTP Error 504: Gateway Time-out (caused by <HTTPError 504: Gateway Time-out>); the read operation timed out", "RATE_LIMITED"],
  ["ERROR: [youtube] abc: Unable to download webpage: HTTP Error 404: Not Found (caused by timed out)", "NOT_FOUND_OR_REMOVED"],
  ["ERROR: [youtube] abc: HTTP Error 403: Forbidden; Connection reset by peer", "EXTRACTOR_ERROR"],
  ["ERROR: [youtube] abc: Unable to download webpage: HTTP Error 503: Service Unavailable", "RATE_LIMITED"],
  ["ERROR: [youtube] abc: Unable to download webpage: HTTP Error 500: Internal Server Error", "RATE_LIMITED"],
  ["ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later.", "RATE_LIMITED"],
  ["ERROR: [youtube] abc: Video unavailable", "NOT_FOUND_OR_REMOVED"],
  ["ERROR: Did not get any data blocks", "NETWORK_LOST"],
  ["ERROR: fragment 3 not found, unable to continue", "NETWORK_LOST"],
  // test_a_missing_ffmpeg_during_the_job_is_a_missing_tool_not_a_removed_video
  ["ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location", "TOOL_NOT_INSTALLED"],
  // test_a_gallery_dl_failure_is_not_named_after_a_retry_warning_before_it
  [GDL_WARN + "\n[instagram][error] NotFoundError: Requested user could not be found", "EXTRACTOR_ERROR"],
];

describe("the stand-in worker mirrors the real one (R674 B)", () => {
  it("the stand-in names failures as the worker does", () => {
    for (const [stderr, code] of WORKER_CASES) expect([stderr, mapError(stderr)]).toEqual([stderr, code]);
  });

  it("the same arguments per quality as the worker", () => {
    const after = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const fmt = (params: Record<string, unknown>, ffmpeg = true) => {
      const a = ytdlpArgs("https://x.test/p", "/out", params, ffmpeg);
      return [after(a, "-f"), after(a, "-S"), a.includes("-x"), after(a, "--merge-output-format"), a.includes("--abort-on-unavailable-fragments")];
    };
    expect(fmt({ quality: "best" })).toEqual(["bv*+ba/b", "res,fps,vcodec:h264,acodec:m4a", false, "mp4", true]);
    expect(fmt({ quality: "1080p" })).toEqual(["bv*+ba/b", "res:1080,fps,vcodec:h264,acodec:m4a", false, "mp4", true]);
    expect(fmt({ quality: "720p" })).toEqual(["bv*+ba/b", "res:720,fps,vcodec:h264,acodec:m4a", false, "mp4", true]);
    expect(fmt({ quality: "audio" })).toEqual(["ba[ext=m4a]/ba/b", undefined, true, undefined, true]);
    expect(fmt({ quality: "ready" })).toEqual(["b", undefined, false, undefined, true]);
    // nothing asked and ffmpeg found: the 720p default; ffmpeg not found: no format at all
    expect(fmt({})).toEqual(["bv*+ba/b", "res:720,fps,vcodec:h264,acodec:m4a", false, "mp4", true]);
    expect(fmt({}, false)).toEqual([undefined, undefined, false, undefined, true]);
    expect(fmt({ quality: "ready" }, false)).toEqual(["b", undefined, false, undefined, true]);
    // an enumeration asks for no format and never aborts on fragments
    expect(fmt({ flatList: true })).toEqual([undefined, undefined, false, undefined, false]);
    expect(fmt({ metadataOnly: true, quality: "720p" })).toEqual([undefined, undefined, false, undefined, false]);
    const a = ytdlpArgs("https://x.test/p", "/out", { quality: "720p" }, true);
    expect(a.indexOf("-f")).toBeLessThan(a.indexOf("--"));
    expect(a.at(-1)).toBe("https://x.test/p");
    expect(after(a, "--sleep-requests")).toBe("2");
    expect(after(ytdlpArgs("https://x.test/p", "/out", { cookiesFromBrowser: "firefox" }, true), "--cookies-from-browser")).toBe("firefox");
    // gallery-dl: inclusive dates, as the worker filters them
    const g = gallerydlArgs("https://www.instagram.com/x/", "/out", { dateAfter: "20260101", dateBefore: "20261231", maxItems: 3 });
    expect(after(g, "--filter")).toBe("date >= datetime(2026, 1, 1) and date < datetime(2027, 1, 1)");
    expect(after(g, "--range")).toBe("1-3");
    expect(after(g, "--sleep")).toBe("3-8");
  });

  it("a failure in the middle of a download is a failure unless a finished media file was written", () => {
    const media = ["/o/a.info.json", "/o/a.mp4"];
    const unjoined = ["/o/a.info.json", "/o/a.f137.mp4", "/o/a.webp"];
    for (const code of ["NETWORK_LOST", "DISK_FULL", "TOOL_NOT_INSTALLED"]) expect([code, downloadKept("yt-dlp", {}, code, media, [])]).toEqual([code, false]);
    expect(downloadKept("yt-dlp", {}, "RATE_LIMITED", media, [])).toBe(true);
    expect(downloadKept("yt-dlp", {}, "RATE_LIMITED", unjoined, [])).toBe(false);
    expect(downloadKept("yt-dlp", {}, "EXTRACTOR_ERROR", ["/o/a.webp", "/o/a.en.vtt"], [])).toBe(false);
    // an enumeration keeps what it listed; gallery-dl keeps any file
    expect(downloadKept("yt-dlp", { flatList: true }, "RATE_LIMITED", [], ["/o/p.info.json"])).toBe(true);
    expect(downloadKept("gallery-dl", {}, "NETWORK_LOST", ["/o/1.jpg"], [])).toBe(true);
  });

  it("the platform's reason by the worker's visible rule", () => {
    expect(platformReason("ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "NOT_FOUND_OR_REMOVED")).toBe(
      "Video unavailable. This video has been removed by the uploader",
    );
    // cut where the downloader speaks for itself
    expect(platformReason("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.", "LOGIN_REQUIRED")).toBe(
      "Sign in to confirm you're not a bot.",
    );
    expect(platformReason("ERROR: [youtube] abc: Private video; please report this issue on https://x", "PRIVATE")).toBe("Private video");
    expect(platformReason("ERROR: [youtube] abc: The uploader has not made this video available (caused by X)", "GEO_BLOCKED")).toBe("The uploader has not made this video available");
    // the last such line counts
    expect(platformReason("ERROR: [youtube] abc: first\nERROR: [youtube] abc: second", "NOT_FOUND_OR_REMOVED")).toBe("second");
    // only for the four codes about the video itself
    expect(platformReason("ERROR: [youtube] abc: HTTP Error 429: Too Many Requests", "RATE_LIMITED")).toBeUndefined();
    expect(platformReason("ERROR: [youtube] abc: Unable to download webpage: <urlopen error timed out>", "NETWORK_LOST")).toBeUndefined();
    expect(platformReason("ERROR: unable to write data: [Errno 28] No space left on device", "DISK_FULL")).toBeUndefined();
    // at most 200 characters, cut at a word and ended with an ellipsis
    const long = platformReason(`ERROR: [youtube] abc: ${"word ".repeat(60)}end`, "NOT_FOUND_OR_REMOVED")!;
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("word…")).toBe(true);
  });
});

describe("the stand-in worker's jobs (R674 B)", () => {
  let tmp: string;
  let w: ToolWorker | undefined;
  const savedPath = process.env.PATH;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ao-standin-"));
    process.env.PATH = `${FAKE_TOOLS_DIR}${delimiter}${savedPath ?? ""}`;
  });
  afterEach(async () => {
    await w?.close();
    w = undefined;
    process.env.PATH = savedPath;
    await rm(tmp, { recursive: true, force: true });
  });
  const job = async (worker: ToolWorker, params: Record<string, unknown>, input = "https://www.youtube.com/watch?v=aoTest00001") => {
    const h = { Authorization: `Bearer ${STUB_TOKEN}`, "Content-Type": "application/json" };
    const r = await fetch(`${worker.baseUrl}/jobs`, { method: "POST", headers: h, body: JSON.stringify({ type: "capture.download", input, output: join(tmp, `o${Math.random()}`), params }) });
    const { id } = (await r.json()) as { id: string };
    return (await (await fetch(`${worker.baseUrl}/jobs/${id}`, { headers: h })).json()) as { status: string; error?: Record<string, unknown> };
  };

  it("without ffmpeg a download in better quality is refused naming ffmpeg; ready, and listings, still run", async () => {
    w = await startToolWorker({ ffmpeg: false });
    for (const quality of ["best", "1080p", "720p", "audio"]) {
      expect([quality, await job(w, { tool: "yt-dlp", quality })]).toEqual([quality, { id: expect.any(String), type: "capture.download", progress: 1, status: "failed", error: { code: "TOOL_NOT_INSTALLED", message: "ffmpeg is not installed", tool: "ffmpeg" } }]);
    }
    expect((await job(w, { tool: "yt-dlp", quality: "ready" })).status).toBe("done");
    expect((await job(w, { tool: "yt-dlp" })).status).toBe("done");
    expect((await job(w, { tool: "yt-dlp", metadataOnly: true, quality: "720p" })).status).toBe("done");
    // nothing reached the downloader for the refused ones
    const asked = w.submitted.filter((j) => j.params.quality !== undefined).map((j) => j.params.quality);
    expect(asked).toEqual(["best", "1080p", "720p", "audio", "ready", "720p"]);
  });

  it("a failure carries the platform's reason for the codes about the video", async () => {
    w = await startToolWorker();
    process.env.FAKE_TOOL_MODE = "notfound";
    try {
      expect((await job(w, { tool: "yt-dlp" })).error).toEqual({
        code: "NOT_FOUND_OR_REMOVED",
        message: "yt-dlp failed (NOT_FOUND_OR_REMOVED)",
        platformReason: "Video unavailable. This video has been removed by the uploader",
      });
    } finally {
      delete process.env.FAKE_TOOL_MODE;
    }
  });
});
