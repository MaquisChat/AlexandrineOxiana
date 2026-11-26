/**
 * Whole-channel capture and transcription (R668, R669): the words the service and the screens share, and the
 * numbers they are built from. Every sentence here is fixed by the plan's copy table; these tests pin them.
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TEXT, BACKGROUND_EVENT, BYTES_PER_SECOND, DEFAULT_QUALITY, DISK_FLOOR_BYTES, DOWNLOAD_QUALITIES, FALLBACK_QUALITY, KEEP_AWAKE_TEXT,
  LIST_BUTTONS, LIST_STOPPED_TEXT, PROBLEMS_TEXT, QUALITIES_NEEDING_VIDEO_TOOLS, QUALITY_LABELS, RUN_ALREADY_RUNNING, RUN_ALREADY_RUNNING_TEXT, RUN_BUTTONS,
  RUN_NOT_RUNNING_TEXT, VIDEO_TOOLS_NEEDED_TEXT, WORK_LINES_TEXT, downloadProblemText, estimateBytes, estimateRateLimitedText, estimateText,
  formatSize, formatSizeRange, formatSoundLength, formatSpeed, formatTimeLeft, formatWait, platformName, platformSays, problemLine, runLines,
  transcribeAllText, transcriptionLines,
  type CaptureEstimate, type DownloadRunSummary, type TranscriptionListSummary,
} from "./background.js";

const e: CaptureEstimate = {
  kind: "channel", platform: "youtube", title: "Example Channel", count: 412, alreadyInProject: 0, soundSeconds: 310 * 3600, unknownLengths: 0,
  listComplete: true, freeBytes: 380_000_000_000, diskName: "Macintosh HD", videoToolsInstalled: true, speechModel: "medium", metadataOnly: false,
};

const run: DownloadRunSummary = {
  runId: "r1", projectId: "p1", url: "https://www.youtube.com/@example", title: "Example Channel", platform: "youtube", quality: "720p",
  transcribe: true, state: "downloading", total: 412, done: 120, failed: 0, notCompleted: 292,
  startedAt: "2026-11-26T09:00:00.000Z", updatedAt: "2026-11-26T10:00:00.000Z",
};

const l: TranscriptionListSummary = {
  projectId: "p1", state: "running", total: 412, done: 14, failed: 0, current: { sourceId: "s1", title: "Title of the video", progress: 0 },
  soundSecondsLeft: 6 * 86_400 * 4, unknownLeft: 0, soundPerSecond: 4,
};

describe("qualities and sizes", () => {
  it("the qualities, their labels, the default and the fallback", () => {
    expect(DOWNLOAD_QUALITIES).toEqual(["best", "720p", "1080p", "audio", "ready"]);
    expect(QUALITIES_NEEDING_VIDEO_TOOLS).toEqual(["best", "720p", "1080p", "audio"]);
    expect(DEFAULT_QUALITY).toBe("720p");
    expect(FALLBACK_QUALITY).toBe("ready");
    expect(QUALITY_LABELS).toEqual({
      best: "Best available", "720p": "Up to 720p", "1080p": "Up to 1080p", audio: "Audio only", ready: "Ready-made file (lower quality)",
    });
    expect(BYTES_PER_SECOND).toEqual({
      best: { low: 400_000, high: 1_500_000 }, "1080p": { low: 270_000, high: 450_000 }, "720p": { low: 135_000, high: 225_000 },
      audio: { low: 12_000, high: 20_000 }, ready: { low: 60_000, high: 110_000 },
    });
    expect(DISK_FLOOR_BYTES).toBe(10_000_000_000);
    expect([platformName("youtube"), platformName("instagram"), platformName("tiktok")]).toEqual(["YouTube", "Instagram", "TikTok"]);
  });

  it("sizes are written with two significant figures in one unit", () => {
    expect(formatSize(150_660_000_000)).toBe("150 GB");
    expect(formatSize(251_100_000_000)).toBe("250 GB");
    expect(formatSize(1_500_000_000)).toBe("1.5 GB");
    expect(formatSize(2_300_000_000_000)).toBe("2.3 TB");
    expect(formatSize(900_000_000)).toBe("900 MB");
    expect(formatSize(999_700_000_000)).toBe("1 TB");
    expect(formatSize(999_999)).toBe("less than 1 MB");
    const { low, high } = estimateBytes(310 * 3600, "720p");
    expect(formatSizeRange(low, high)).toBe("150–250 GB");
    expect(formatSizeRange(900_000_000, 1_500_000_000)).toBe("900 MB–1.5 GB");
    const audio = estimateBytes(310 * 3600, "audio");
    expect(formatSizeRange(audio.low, audio.high)).toBe("13–22 GB");
  });

  it("lengths of sound, waits, time left and speed", () => {
    expect(formatSoundLength(30)).toBe("about 1 minute");
    expect(formatSoundLength(540)).toBe("about 9 minutes");
    expect(formatSoundLength(3600)).toBe("about 1 hour");
    expect(formatSoundLength(3.5 * 3600)).toBe("about 3.5 hours");
    expect(formatSoundLength(4 * 3600)).toBe("about 4 hours");
    expect(formatSoundLength(310 * 3600)).toBe("about 310 hours");
    expect(formatWait(3_600_000)).toBe("1 hour");
    expect(formatWait(7_200_000)).toBe("2 hours");
    expect(formatWait(60_000)).toBe("1 minute");
    expect(formatWait(480_000)).toBe("8 minutes");
    expect(formatTimeLeft(59)).toBe("less than a minute");
    expect(formatTimeLeft(60)).toBe("about 1 minute");
    expect(formatTimeLeft(45 * 60)).toBe("about 45 minutes");
    expect(formatTimeLeft(5 * 3600)).toBe("about 5 hours");
    expect(formatTimeLeft(6 * 86_400)).toBe("about 6 days");
    expect(formatSpeed(4)).toBe("4 minutes of sound per minute");
    expect(formatSpeed(1)).toBe("1 minute of sound per minute");
    expect(formatSpeed(0.5)).toBe("2 minutes for each minute of sound");
    expect(formatSpeed(0.9)).toBe("1 minute for each minute of sound");
  });
});

describe("the estimate's words", () => {
  it("heading, listing and count", () => {
    expect(estimateText.heading("channel", "Example Channel")).toBe('Capture channel: "Example Channel"');
    expect(estimateText.heading("playlist", "Example")).toBe('Capture playlist: "Example"');
    expect(estimateText.heading("profile", "someone")).toBe('Capture profile: "someone"');
    expect(estimateText.listing("youtube")).toBe("Asking YouTube for the list of videos…");
    expect(estimateText.listing("instagram")).toBe("Asking Instagram for the list of posts…");
    expect(estimateText.count({ ...e, count: 412, soundSeconds: 310 * 3600, unknownLengths: 0 })).toBe("412 videos, about 310 hours.");
    expect(estimateText.count({ ...e, soundSeconds: 300 * 3600, unknownLengths: 12 })).toBe("412 videos, about 300 hours (12 of unknown length).");
    expect(estimateText.count({ ...e, soundSeconds: 0, unknownLengths: 412 })).toBe("412 videos; their lengths are not known.");
    expect(estimateText.count({ ...e, count: 1, soundSeconds: 0, unknownLengths: 1 })).toBe("1 video; its length is not known.");
    expect(estimateText.count({ ...e, count: 4, soundSeconds: 540 })).toBe("4 videos, about 9 minutes.");
    expect(estimateText.count({ ...e, platform: "instagram", count: 3, soundSeconds: 120 })).toBe("3 posts, about 2 minutes.");
    expect(estimateText.count({ ...e, count: 0, soundSeconds: 0 })).toBe(estimateText.nothingNew("youtube"));
  });

  it("nothing new, already in the project, and a list cut short", () => {
    expect(estimateText.nothingNew("youtube")).toBe(
      "Nothing new to download: every video listed is already in this project. Starting checks the listed videos for changes and removals.",
    );
    expect(estimateText.nothingNew("instagram")).toBe(
      "Nothing new to download: every post listed is already in this project. Starting checks the listed posts for changes and removals.",
    );
    expect(estimateText.alreadyIn({ ...e, alreadyInProject: 5 })).toBe("5 more are already in this project and are not downloaded again.");
    expect(estimateText.alreadyIn({ ...e, alreadyInProject: 1 })).toBe("1 more is already in this project and is not downloaded again.");
    expect(estimateText.alreadyIn({ ...e, alreadyInProject: 0 })).toBeUndefined();
    expect(estimateText.cutShort({ ...e, listComplete: false })).toBe("YouTube stopped listing part-way, so this may not be the whole channel.");
    expect(estimateText.cutShort({ ...e, kind: "playlist", listComplete: false })).toBe("YouTube stopped listing part-way, so this may not be the whole playlist.");
    expect(estimateText.cutShort(e)).toBeUndefined();
  });

  it("the disk sentence and too big", () => {
    expect(estimateText.disk(e, "720p")).toBe('Roughly 150–250 GB at this quality. 380 GB are free on "Macintosh HD".');
    expect(estimateText.disk({ ...e, soundSeconds: 300 * 3600, unknownLengths: 12 }, "720p")).toBe(
      'Roughly 150–240 GB at this quality, and more for the 12 videos of unknown length. 380 GB are free on "Macintosh HD".',
    );
    expect(estimateText.disk({ ...e, soundSeconds: 0, unknownLengths: 412 }, "720p")).toBe(
      'Size unknown: YouTube did not give the videos\' lengths. 380 GB are free on "Macintosh HD".',
    );
    expect(estimateText.disk({ ...e, diskName: null }, "720p")).toBe("Roughly 150–250 GB at this quality. 380 GB are free on this computer's disk.");
    expect(estimateText.disk({ ...e, freeBytes: null }, "720p")).toBe("Roughly 150–250 GB at this quality.");
    expect(estimateText.disk({ ...e, metadataOnly: true }, "720p")).toBe("Metadata only: almost no disk space is needed.");
    expect(estimateText.disk(e, "audio")).toBe('Roughly 13–22 GB at this quality. 380 GB are free on "Macintosh HD".');
    expect(estimateText.tooBig(e, "720p")).toBeUndefined();
    expect(estimateText.tooBig({ ...e, freeBytes: 260_000_000_000 }, "720p")).toBe(
      "This may need more space than the disk has free, less the 10 GB the app keeps free.",
    );
    expect(estimateText.tooBig({ ...e, freeBytes: null }, "720p")).toBeUndefined();
  });

  it("the times, the transcription label and the fixed words", () => {
    expect(estimateText.downloadTime({ ...e, count: 100 })).toBe("Downloading: less than an hour; it depends on YouTube.");
    expect(estimateText.downloadTime(e)).toBe("Downloading: some hours; it depends on YouTube.");
    expect(estimateText.downloadTime({ ...e, count: 2880 })).toBe("Downloading: a day or more; it depends on YouTube.");
    expect(estimateText.transcribeTime({ ...e, soundSeconds: 6 * 86_400 * 4, measuredSpeed: 4 })).toBe(
      "Transcribing: about 6 days at this Mac's speed (4 minutes of sound per minute).",
    );
    expect(estimateText.transcribeTime(e)).toBe(
      "Transcribing: days rather than hours. The app will say more exactly once it has transcribed the first video on this Mac.",
    );
    expect(estimateText.transcribeTime({ ...e, soundSeconds: 3600 })).toBe(
      "Transcribing: the app will say how long once it has transcribed the first video on this Mac.",
    );
    expect(estimateText.transcribeLabel("medium")).toBe("Transcribe each video on this Mac (speech model: medium)");
    expect(estimateText.videoToolsNeeded).toBe("These need Video tools.");
    expect(estimateText.installVideoTools).toBe("Install Video tools");
    expect(estimateText.start).toBe("Start");
    expect(estimateText.startAnyway).toBe("Start anyway — it will pause when the disk is nearly full");
    expect(estimateText.cancel).toBe("Cancel");
    expect(estimateText.legends).toEqual({ quality: "Quality", transcribe: "Transcribe", disk: "Disk", time: "Time" });
  });

  it("the settings changed, the switch not read, and a slow listing (R683)", () => {
    expect(estimateText.settingsChanged).toBe("The settings changed, so the estimate was closed. Press “Capture profile” to see it again.");
    expect(estimateText.switchNotRead).toBe(
      "The project's switch for automatic transcription could not be read. This capture follows the switch as it stands, unless you tick the box.",
    );
    expect(estimateText.listingSlow("youtube")).toBe("Still asking YouTube for the list. A long list can take a few minutes.");
    expect(estimateText.listingSlow("instagram")).toBe("Still asking Instagram for the list. A long list can take a few minutes.");
    expect(estimateText.listingAny).toBe("Asking the platform for the list…");
    expect(estimateText.listingSlowAny).toBe("Still asking the platform for the list. A long list can take a few minutes.");
  });
});

describe("refusals", () => {
  it("the run and Video tools sentences", () => {
    expect(RUN_ALREADY_RUNNING).toBe("RUN_ALREADY_RUNNING");
    expect(RUN_ALREADY_RUNNING_TEXT).toBe("These downloads are already running.");
    expect(RUN_NOT_RUNNING_TEXT).toBe("These downloads are not running.");
    expect(VIDEO_TOOLS_NEEDED_TEXT).toBe(
      "Video tools are not installed, so this quality cannot be downloaded. Install them from the Optional tools screen, or choose “Ready-made file (lower quality)”.",
    );
    expect(estimateRateLimitedText("youtube")).toBe("YouTube is asking the app to slow down, so the list could not be read. Try again in a few minutes.");
  });
});

describe("the run's lines", () => {
  it("queued: waiting its turn, with no Resume", () => {
    const q = runLines({ ...run, state: "queued", total: 0, done: 0, notCompleted: 0 });
    expect(q.title).toBe("\"Example Channel\" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.");
    expect(q.resume).toBeUndefined();
  });

  it("downloading and waiting", () => {
    const d = runLines({ ...run, state: "downloading" });
    expect(d).toEqual({ title: 'Downloading "Example Channel": 120 of 412' });
    expect(d.resume).toBeUndefined();
    expect(runLines({ ...run, state: "downloading", total: 0, done: 0, notCompleted: 0 }).title).toBe('Downloading "Example Channel": reading the list of videos…');
    expect(runLines({ ...run, platform: "instagram", state: "downloading", total: 0, done: 0, notCompleted: 0 }).title).toBe(
      'Downloading "Example Channel": reading the list of posts…',
    );
    expect(runLines({ ...run, failed: 3 }).failures).toBe("3 could not be downloaded");
    const w = runLines({ ...run, state: "waiting", wait: { ms: 120_000, why: "rate-limited" }, failed: 3 });
    expect(w).toEqual({ title: 'Downloading "Example Channel": 120 of 412', wait: "waiting 2 minutes — YouTube asked to slow down", failures: "3 could not be downloaded" });
    expect(runLines({ ...run, state: "waiting", wait: { ms: 60_000, why: "connection" } }).wait).toBe("waiting 1 minute — the connection was lost");
  });

  it("interrupted, with and without a list read", () => {
    const i = runLines({ ...run, state: "interrupted", done: 120, total: 412 });
    expect(i.title).toBe("The capture of 'Example Channel' was interrupted: 120 of 412 done.");
    expect(i.resume).toBe("Resume downloads (292 did not complete)");
    const b = runLines({ ...run, state: "interrupted", total: 0, done: 0, notCompleted: 0 });
    expect(b.title).toBe("The capture of 'Example Channel' was interrupted before it began.");
    expect(b.resume).toBe("Resume downloads");
  });

  it("paused, the paused reasons, failed and stopped", () => {
    expect(runLines({ ...run, state: "paused" }).title).toBe('"Example Channel" is paused: 120 of 412 downloaded.');
    const disk = runLines({ ...run, state: "paused-disk" });
    expect(disk.title).toBe('"Example Channel": 120 of 412 downloaded.');
    expect(disk.why).toBe("Paused: the disk is nearly full. Free some space, then press Resume downloads.");
    expect(runLines({ ...run, state: "paused-rate-limited" }).why).toBe(
      "Paused: YouTube kept asking the app to slow down for 12 hours. Press Resume downloads to try again.",
    );
    expect(runLines({ ...run, state: "paused-tool", tool: "ffmpeg" }).why).toBe(
      "Paused: Video tools are not installed. Install them from the Optional tools screen, then press Resume downloads.",
    );
    expect(runLines({ ...run, state: "paused-tool", tool: "video-downloader" }).why).toBe(
      "Paused: the video downloader is not installed. Install it from the Optional tools screen, then press Resume downloads.",
    );
    expect(runLines({ ...run, state: "paused-tool", tool: "image-downloader" }).why).toBe(
      "Paused: the image downloader is not installed. Install it from the Optional tools screen, then press Resume downloads.",
    );
    expect(runLines({ ...run, state: "paused-tool", tool: "ocr" }).why).toBe(
      "Paused: a tool this needs is not installed. Install it from the Optional tools screen, then press Resume downloads.",
    );
    const f = runLines({ ...run, state: "failed", reason: "The media helper is not running." });
    expect(f.title).toBe('"Example Channel": 120 of 412 downloaded.');
    expect(f.why).toBe("The media helper is not running.");
    expect(f.resume).toBe("Resume downloads (292 did not complete)");
    expect(runLines({ ...run, state: "stopped" }).title).toBe('"Example Channel" was stopped: 120 of 412 downloaded.');
  });

  it("finished", () => {
    const f = runLines({ ...run, state: "finished", done: 398, failed: 14, total: 412, notCompleted: 14 });
    expect(f).toEqual({ title: '"Example Channel": 398 of 412 downloaded. 14 could not be downloaded.', resume: "Resume downloads (14 did not complete)" });
    expect(runLines({ ...run, state: "finished", done: 412, failed: 0, total: 412, notCompleted: 0 })).toEqual({ title: '"Example Channel": all 412 downloaded.' });
    const none = runLines({ ...run, state: "finished", total: 0, done: 0, notCompleted: 0 });
    expect(none.title).toBe('"Example Channel": nothing new to download.');
    expect(none.resume).toBeUndefined();
  });
});

describe("problems", () => {
  it("each error code in plain words, with post for Instagram", () => {
    expect(downloadProblemText("PRIVATE", "youtube")).toBe("This video is private.");
    expect(downloadProblemText("PRIVATE", "instagram")).toBe("This post is private.");
    expect(downloadProblemText("NOT_FOUND_OR_REMOVED", "youtube")).toBe("This video has been removed, or its address is wrong.");
    expect(downloadProblemText("GEO_BLOCKED", "youtube")).toBe("This video is not available in your country.");
    expect(downloadProblemText("LOGIN_REQUIRED", "tiktok")).toBe("This video needs a sign-in the app does not have.");
    expect(downloadProblemText("NETWORK_LOST", "youtube")).toBe("The connection was lost three times.");
    expect(downloadProblemText("EXTRACTOR_ERROR", "youtube")).toBe("The downloader could not read this video. Updating the capture tools may help.");
    expect(downloadProblemText("NOTHING_SAVED", "instagram")).toBe("Nothing came back from the platform for this post.");
    expect(downloadProblemText("LEGAL_BASIS_REQUIRED", "youtube")).toBe("This project's rules need a legal basis for this video, and none was given.");
    expect(downloadProblemText("SOMETHING_ELSE", "youtube")).toBe("This video could not be downloaded.");
    expect(downloadProblemText(undefined, "instagram")).toBe("This post could not be downloaded.");
  });

  it("the platform's words, a problem's line and the list's words", () => {
    expect(platformSays("youtube", "Video unavailable")).toBe("YouTube says: “Video unavailable”");
    expect(problemLine({ title: "A talk", url: "https://youtu.be/abc", reason: "This video is private." }, "youtube")).toBe(
      "A talk — https://youtu.be/abc — This video is private.",
    );
    expect(problemLine({ url: "https://youtu.be/abc", reason: "This video could not be downloaded.", platformReason: "Video unavailable" }, "youtube")).toBe(
      "(no title) — https://youtu.be/abc — This video could not be downloaded. YouTube says: “Video unavailable”",
    );
    expect(PROBLEMS_TEXT).toEqual({
      heading: "Could not be downloaded", copy: "Copy the list", copied: "The list was copied.",
      copyFailed: "The list could not be copied. Select it and copy it by hand.", noTitle: "(no title)",
    });
    // R679 C1: "Remove from this list" takes a finished line off the screen.
    expect(RUN_BUTTONS).toEqual({ pause: "Pause", stop: "Stop", showThem: "Show them", discard: "Discard", remove: "Remove from this list" });
    expect(LIST_BUTTONS).toEqual({ pause: "Pause", continue: "Continue", stop: "Stop", remove: "Remove from this list" });
  });
});

describe("the transcription line", () => {
  it("running, measured and measuring", () => {
    expect(transcriptionLines(l)).toEqual({
      title: 'Transcribing: 14 of 412 — "Title of the video"', time: "about 6 days left at this Mac's speed (4 minutes of sound per minute)",
    });
    expect(transcriptionLines({ ...l, current: { sourceId: "s1" } }).title).toBe("Transcribing: 14 of 412");
    expect(transcriptionLines({ ...l, unknownLeft: 3 }).time).toBe(
      "about 6 days left at this Mac's speed (4 minutes of sound per minute), not counting 3 recordings of unknown length",
    );
    expect(transcriptionLines({ ...l, state: "running", soundPerSecond: undefined }).time).toBe("measuring…");
  });

  it("paused and idle", () => {
    expect(transcriptionLines({ ...l, state: "paused" })).toEqual({ title: "Transcriptions paused: 14 of 412 done." });
    expect(transcriptionLines({ ...l, state: "idle", done: 410, failed: 2 }).title).toBe("Transcriptions finished: 410 of 412 done; 2 could not be made.");
    expect(transcriptionLines({ ...l, state: "idle", done: 412, failed: 0 }).title).toBe("Transcriptions finished: all 412 done.");
    expect(transcriptionLines({ ...l, state: "idle", total: 0, done: 0, failed: 0 })).toEqual({});
  });

  it("a paused list says why: a speech model or another tool not installed, or something gone wrong (R692)", () => {
    expect(transcriptionLines({ ...l, state: "paused", tool: "speech-medium" })).toEqual({
      title: "Transcriptions paused: 14 of 412 done.",
      why: "Paused: the speech model “medium” is not installed. Install it from the Optional tools screen, then press Continue.",
    });
    expect(transcriptionLines({ ...l, state: "paused", tool: "speech-large-v3" }).why).toBe(
      "Paused: the speech model “large-v3” is not installed. Install it from the Optional tools screen, then press Continue.",
    );
    expect(transcriptionLines({ ...l, state: "paused", tool: "ffmpeg" })).toEqual({
      title: "Transcriptions paused: 14 of 412 done.",
      why: "Paused: a tool this needs is not installed. Install it from the Optional tools screen, then press Continue.",
    });
    expect(transcriptionLines({ ...l, state: "paused", stalled: true })).toEqual({
      title: "Transcriptions paused: 14 of 412 done.",
      why: "Paused: something went wrong while transcribing. Press Continue to try again.",
    });
    // Only a paused list says why.
    expect(transcriptionLines({ ...l, state: "running", tool: "speech-medium" }).why).toBeUndefined();
  });
});

describe("transcribe everything", () => {
  it("the confirmation, nothing to do, and how many were added", () => {
    expect(transcribeAllText.button).toBe("Transcribe everything without a transcript");
    expect(transcribeAllText.confirm({ count: 12, soundSeconds: 3.5 * 3600, unknownLengths: 0 })).toBe(
      "12 sources have audio or video and no transcript: about 3.5 hours of sound. They are transcribed one at a time on this Mac, after anything already on the list.",
    );
    expect(transcribeAllText.confirm({ count: 12, soundSeconds: 3.5 * 3600, unknownLengths: 2 })).toBe(
      "12 sources have audio or video and no transcript: about 3.5 hours of sound. 2 of them have no known length. They are transcribed one at a time on this Mac, after anything already on the list.",
    );
    expect(transcribeAllText.confirm({ count: 12, soundSeconds: 0, unknownLengths: 12 })).toBe(
      "12 sources have audio or video and no transcript; their lengths are not known. They are transcribed one at a time on this Mac, after anything already on the list.",
    );
    expect(transcribeAllText.none).toBe("Every source with audio or video already has a transcript, or is already on the transcription list.");
    expect(transcribeAllText.added(12)).toBe("12 sources were put on the transcription list.");
    expect(transcribeAllText.added(1)).toBe("1 source was put on the transcription list.");
    expect(transcribeAllText.confirmButton).toBe("Transcribe them");
    expect(transcribeAllText.cancel).toBe("Cancel");
  });
});

describe("the switches and the work lines", () => {
  it("automatic transcription, keeping awake, the section and the event", () => {
    expect(AUTOMATION_TEXT).toEqual({
      heading: "Automatic transcription",
      label: "Transcribe captured audio and video automatically",
      hint: "Applies to captures from links, channels, playlists and profiles. Files you import or drop in are not transcribed by this switch; “Transcribe everything without a transcript” in the sources list covers them.",
    });
    expect(KEEP_AWAKE_TEXT).toEqual({
      heading: "While downloads or transcriptions run",
      label: "Keep this Mac awake while downloads or transcriptions run",
      hint: "The screen may still switch off. Closing the lid still puts the Mac to sleep; downloads and transcriptions carry on when it wakes.",
    });
    expect(WORK_LINES_TEXT).toEqual({
      heading: "Downloads and transcriptions",
      lost: "Progress updates for downloads and transcriptions are not available right now. They keep running in the library service.",
      reconnect: "Reconnect",
    });
    expect(BACKGROUND_EVENT).toBe("background.progress");
  });
});

describe("fix round (R672)", () => {
  const zero = { ...run, total: 0, done: 0, failed: 0, notCompleted: 0 };

  it("a run that never read its list never says 0 of 0", () => {
    expect(runLines({ ...zero, state: "stopped" }).title).toBe('"Example Channel" was stopped before it began.');
    expect(runLines({ ...zero, state: "paused" }).title).toBe('"Example Channel" is paused. The list of videos has not been read yet.');
    expect(runLines({ ...zero, platform: "instagram", state: "paused" }).title).toBe('"Example Channel" is paused. The list of posts has not been read yet.');
    const disk = runLines({ ...zero, state: "paused-disk" });
    expect(disk.title).toBe('"Example Channel": the list of videos has not been read yet.');
    expect(disk.why).toBe("Paused: the disk is nearly full. Free some space, then press Resume downloads.");
    const rate = runLines({ ...zero, state: "paused-rate-limited" });
    expect(rate.title).toBe('"Example Channel": the list of videos has not been read yet.');
    expect(rate.why).toBe("Paused: YouTube kept asking the app to slow down for 12 hours. Press Resume downloads to try again.");
    const tool = runLines({ ...zero, state: "paused-tool", tool: "ffmpeg" });
    expect(tool.title).toBe('"Example Channel": the list of videos has not been read yet.');
    expect(tool.why).toBe("Paused: Video tools are not installed. Install them from the Optional tools screen, then press Resume downloads.");
    const f = runLines({ ...zero, platform: "instagram", state: "failed", reason: "The media helper is not running." });
    expect(f.title).toBe('"Example Channel": the list of posts has not been read yet.');
    expect(f.why).toBe("The media helper is not running.");
    expect(f.resume).toBe("Resume downloads");
  });

  it("the sentence after a Stop of the transcription list", () => {
    expect(LIST_STOPPED_TEXT).toBe(
      "The transcriptions were stopped. The sources stay; “Transcribe everything without a transcript” puts them on the list again.",
    );
  });

  it("transcribing everything for exactly 1 source", () => {
    expect(transcribeAllText.confirm({ count: 1, soundSeconds: 60, unknownLengths: 0 })).toBe(
      "1 source has audio or video and no transcript: about 1 minute of sound. It is transcribed on this Mac, after anything already on the list.",
    );
    expect(transcribeAllText.confirm({ count: 1, soundSeconds: 0, unknownLengths: 1 })).toBe(
      "1 source has audio or video and no transcript; its length is not known. It is transcribed on this Mac, after anything already on the list.",
    );
  });

  it("the disk sentence when nothing new will be downloaded", () => {
    expect(estimateText.disk({ ...e, count: 0, soundSeconds: 0 }, "720p")).toBe("Nothing new will be downloaded, so no disk space is needed.");
    expect(estimateText.tooBig({ ...e, count: 0, soundSeconds: 0, freeBytes: 1_000_000_000 }, "720p")).toBeUndefined();
  });

  it("a size range whose low end is below 1 MB", () => {
    expect(formatSizeRange(500_000, 1_200_000)).toBe("up to 1.2 MB");
    expect(formatSizeRange(100_000, 900_000)).toBe("less than 1 MB");
    expect(estimateText.disk({ ...e, count: 1, soundSeconds: 60, freeBytes: null }, "audio")).toBe("Roughly up to 1.2 MB at this quality.");
    expect(estimateText.disk({ ...e, count: 1, soundSeconds: 30, freeBytes: null }, "audio")).toBe("Roughly less than 1 MB at this quality.");
  });

  it("the measured transcription time with lengths not known", () => {
    expect(estimateText.transcribeTime({ ...e, soundSeconds: 0, unknownLengths: 412, measuredSpeed: 4 })).toBe(
      "Transcribing: the lengths are not known, so the app cannot say how long.",
    );
    expect(estimateText.transcribeTime({ ...e, soundSeconds: 6 * 86_400 * 4, unknownLengths: 12, measuredSpeed: 4 })).toBe(
      "Transcribing: about 6 days at this Mac's speed (4 minutes of sound per minute). The 12 videos of unknown length are not counted.",
    );
    expect(estimateText.transcribeTime({ ...e, soundSeconds: 6 * 86_400 * 4, unknownLengths: 1, measuredSpeed: 4 })).toBe(
      "Transcribing: about 6 days at this Mac's speed (4 minutes of sound per minute). The 1 video of unknown length is not counted.",
    );
    expect(estimateText.transcribeTime({ ...e, platform: "instagram", soundSeconds: 6 * 86_400 * 4, unknownLengths: 12, measuredSpeed: 4 })).toBe(
      "Transcribing: about 6 days at this Mac's speed (4 minutes of sound per minute). The 12 posts of unknown length are not counted.",
    );
    expect(estimateText.transcribeTime({ ...e, platform: "instagram", soundSeconds: 6 * 86_400 * 4, unknownLengths: 1, measuredSpeed: 4 })).toBe(
      "Transcribing: about 6 days at this Mac's speed (4 minutes of sound per minute). The 1 post of unknown length is not counted.",
    );
  });

  it("rounding never says 60 minutes, 120 minutes or 48 hours", () => {
    expect(formatSoundLength(3599)).toBe("about 1 hour");
    expect(formatSoundLength(3570)).toBe("about 1 hour");
    expect(formatSoundLength(3569)).toBe("about 59 minutes");
    expect(formatTimeLeft(7199)).toBe("about 2 hours");
    expect(formatTimeLeft(7169)).toBe("about 119 minutes");
    expect(formatTimeLeft(172_799)).toBe("about 2 days");
    expect(formatTimeLeft(171_000)).toBe("about 2 days");
    expect(formatTimeLeft(170_999)).toBe("about 47 hours");
  });

  it("a problem with an empty title says (no title)", () => {
    expect(problemLine({ title: "", url: "https://youtu.be/abc", reason: "This video is private." }, "youtube")).toBe(
      "(no title) — https://youtu.be/abc — This video is private.",
    );
  });
});
