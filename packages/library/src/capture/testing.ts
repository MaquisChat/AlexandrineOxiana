/**
 * Test-only helpers for link capture (not exported from the package): an in-process stand-in for
 * the media worker's HTTP API that runs `capture.download` with whatever `yt-dlp` / `gallery-dl` is
 * first on PATH (the fake tools in tests/fixtures/fake-tools), mirroring the Python worker's
 * arguments, refusals, output listing (comments split out, partial results) and error mapping (as of
 * worker commit 6814636; see "The worker's own rules" below and testing.test.ts), and answers `audio.transcribe` with a canned
 * transcript (one of two segments flagged).
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_TOOLS_DIR = fileURLToPath(new URL("../../tests/fixtures/fake-tools/", import.meta.url));
export const CAPTURE_FIXTURES_DIR = fileURLToPath(new URL("../../tests/fixtures/capture/", import.meta.url));
export const STUB_TOKEN = "stub-token-0123456789";

export interface SubmittedJob {
  type: string;
  input: string;
  output: string;
  params: Record<string, unknown>;
}

export interface ToolWorker {
  baseUrl: string;
  token: string;
  submitted: SubmittedJob[];
  /** Most capture jobs that ran at the same time. */
  maxConcurrent: number;
  close(): Promise<void>;
}

// ---- The worker's own rules (services/media-worker/ao_worker/download.py at worker commit 6814636,
// the integration branch, R674 B and R678): the error patterns in the same order with the same HTTP-answer guard,
// the arguments per quality, the ffmpeg refusal, when a failed download is kept as partial, and the
// platform's reason. Not copied: the worker's redaction of the reason and of the error detail, the
// progress lines, the JavaScript runtime argument, and its recursive output listing.

// First match wins; the order matters ("Private video. Sign in if ..." is PRIVATE, not LOGIN_REQUIRED).
const ERROR_PATTERNS: Array<[string, RegExp]> = [
  ["TOOL_NOT_INSTALLED", /ffmpeg not found/i],
  ["PRIVATE", /private video|this (account|profile|user) is private|is private\b|private (account|profile|post)/i],
  ["GEO_BLOCKED", /not (made this video )?available in your (country|region|location)|geo[- ]?(restrict|block)/i],
  // 5xx: the server asks to be tried later (before NOT_FOUND_OR_REMOVED: "Service Unavailable").
  ["RATE_LIMITED", /\b429\b|too many requests|rate[- ]?limit|HTTP ?Error:? '?5\d\d|content isn'?t available, try again later/i],
  ["LOGIN_REQUIRED", /sign in to confirm|log ?in required|login required|requires? (a )?log ?in|--cookies|authentication|age[- ]?restricted|you need to log in|log in to/i],
  ["DISK_FULL", /No space left on device|ENOSPC|disk (is )?full/i],
  [
    "NETWORK_LOST",
    /urlopen error|timed out|Connection (reset|refused|aborted)|Network is unreachable|No route to host|Temporary failure in name resolution|Name or service not known|nodename nor servname|getaddrinfo failed|Remote end closed connection|IncompleteRead|Did not get any data blocks|fragment \d+ not found/i,
  ],
  ["NOT_FOUND_OR_REMOVED", /video unavailable|has been removed|\b404\b|not found|does not exist|no longer available|has been deleted|account (has been )?(terminated|suspended)|unavailable/i],
];

/** The worker's `map_error`: the error lines (yt-dlp `ERROR:`, gallery-dl `[x][error]`), else the whole text. */
export function mapError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.includes("ERROR") || /\]\[error\]/i.test(l));
  const text = lines.length ? lines.join("\n") : stderr;
  // An HTTP answer means the connection worked: such a text is never a lost connection.
  const httpAnswer = /HTTP ?Error/i.test(text);
  for (const [code, re] of ERROR_PATTERNS) {
    if (code === "NETWORK_LOST" && httpAnswer) continue;
    if (re.test(text)) return code;
  }
  return "EXTRACTOR_ERROR";
}

const H264_AAC = "vcodec:h264,acodec:m4a";
const QUALITY_FORMATS: Record<string, string> = { best: "bv*+ba/b", "1080p": "bv*+ba/b", "720p": "bv*+ba/b", audio: "ba[ext=m4a]/ba/b", ready: "b" };
const QUALITY_SORT: Record<string, string> = { best: `res,fps,${H264_AAC}`, "1080p": `res:1080,fps,${H264_AAC}`, "720p": `res:720,fps,${H264_AAC}` };
const QUALITY_EXTRA_ARGS: Record<string, string[]> = { audio: ["-x", "--audio-format", "m4a"] };
/** Only "ready" can be saved without ffmpeg; the others refuse to run. */
const QUALITY_WITHOUT_FFMPEG = new Set(["ready"]);
/** Asked for nothing and ffmpeg is there: the app's default quality. */
const DEFAULT_QUALITY = "720p";

/** The worker's `build_ytdlp_args` (`ffmpeg`: whether ffmpeg was found; the stand-in names no path). */
export function ytdlpArgs(url: string, out: string, p: Record<string, unknown>, ffmpeg: boolean): string[] {
  const args = [
    "--ignore-config", "--newline", "--no-color",
    "-o", join(out, "%(id)s.%(ext)s"),
    "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", "all",
    "--write-thumbnail", "--no-overwrites",
    "--sleep-requests", "2", "--sleep-interval", "3", "--max-sleep-interval", "8",
    "--retries", "3",
  ];
  if (p.archiveFile) args.push("--download-archive", String(p.archiveFile));
  if (p.flatList) args.push("--flat-playlist");
  if (p.maxItems) args.push("--playlist-end", String(Math.trunc(Number(p.maxItems))));
  if (p.dateAfter) args.push("--dateafter", String(p.dateAfter));
  if (p.dateBefore) args.push("--datebefore", String(p.dateBefore));
  if (p.metadataOnly) args.push("--skip-download");
  if (p.includeComments) args.push("--write-comments");
  if (p.cookiesFromBrowser) args.push("--cookies-from-browser", String(p.cookiesFromBrowser));
  const enumeration = !!(p.flatList || p.metadataOnly);
  const quality = (typeof p.quality === "string" && p.quality) || (ffmpeg ? DEFAULT_QUALITY : undefined);
  if (quality && !enumeration && QUALITY_FORMATS[quality]) {
    args.push("-f", QUALITY_FORMATS[quality]!);
    if (QUALITY_SORT[quality]) args.push("-S", QUALITY_SORT[quality]!);
    args.push(...(QUALITY_EXTRA_ARGS[quality] ?? []));
    // Joined picture and sound are always mp4.
    if (QUALITY_SORT[quality]) args.push("--merge-output-format", "mp4");
  }
  // A video whose pieces could not all be fetched fails; it is never stored cut short.
  if (!enumeration) args.push("--abort-on-unavailable-fragments");
  if (ffmpeg) args.push("--ffmpeg-location", "ffmpeg");
  return [...args, "--", url];
}

/** gallery-dl's `datetime(Y, M, D)`, `plusDays` later. */
function gdlDate(d: string, plusDays = 0): string {
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + plusDays));
  return `datetime(${t.getUTCFullYear()}, ${t.getUTCMonth() + 1}, ${t.getUTCDate()})`;
}

/** The worker's `build_gallerydl_args`. */
export function gallerydlArgs(url: string, out: string, p: Record<string, unknown>): string[] {
  const args = ["--config-ignore", "--write-metadata", "--sleep", "3-8", "-D", out];
  if (p.archiveFile) args.push("--download-archive", String(p.archiveFile));
  if (p.maxItems) args.push("--range", `1-${Math.trunc(Number(p.maxItems))}`);
  const filters: string[] = [];
  if (p.dateAfter) filters.push(`date >= ${gdlDate(String(p.dateAfter))}`);
  if (p.dateBefore) filters.push(`date < ${gdlDate(String(p.dateBefore), 1)}`); // inclusive, like yt-dlp --datebefore
  if (filters.length) args.push("--filter", filters.join(" and "));
  if (p.metadataOnly) args.push("--no-download");
  if (p.cookiesFromBrowser) args.push("--cookies-from-browser", String(p.cookiesFromBrowser));
  return [...args, "--", url];
}

/** After these a download never counts as partial, whatever was written. */
const DOWNLOAD_FAILS_ALWAYS = new Set(["NETWORK_LOST", "DISK_FULL", "TOOL_NOT_INSTALLED"]);
const MEDIA_SUFFIXES = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".3gp", ".ts", ".mpg", ".mpeg", ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".oga", ".wav", ".flac", ".weba"]);
/** abc.f137.mp4, abc.fhls-720p.mp4: one stream, not yet joined. */
const UNJOINED_RE = /\.f[^.]+\.[^.]+$/;
const SKIP_SUFFIXES = [".part", ".ytdl", ".temp", ".tmp"];

function isFinishedMedia(path: string): boolean {
  const name = basename(path);
  // A join or download still in progress.
  if (name.includes(".temp.") || name.includes(".part") || name.endsWith(".ytdl")) return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && MEDIA_SUFFIXES.has(name.slice(dot).toLowerCase()) && !UNJOINED_RE.test(name);
}

/**
 * Whether a job that ended with an error keeps what it wrote (partial) or fails (the worker's rule):
 * a yt-dlp download is kept only when a finished video or audio file was written and the failure is
 * not a lost connection, a full disk or a missing ffmpeg; an enumeration keeps what it listed.
 */
export function downloadKept(tool: string, p: Record<string, unknown>, code: string, files: string[], infos: string[]): boolean {
  const enumeration = !!(p.flatList || p.metadataOnly);
  if (tool === "yt-dlp" && !enumeration) return !DOWNLOAD_FAILS_ALWAYS.has(code) && files.some(isFinishedMedia);
  return files.length > 0 || (enumeration && infos.length > 0);
}

const PLATFORM_REASON_RE = /ERROR: \[[^\]]+\] [^:]+: (.+)/;
const REASON_CUTS = ["; please report", " (caused by", " See "];
const OPTION_CUT_RE = /\s+(?:use\s+)?--[A-Za-z]/i;
const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/g;
const REASON_REFUSED = ["Errno", "urlopen", "ConnectionPool", "HTTP Error", "Traceback", "/Users/", "/home/", "/var/", "/tmp/", "~/"];
/** Only for these failures is the platform's sentence about the video. */
const PLATFORM_REASON_CODES = new Set(["PRIVATE", "GEO_BLOCKED", "NOT_FOUND_OR_REMOVED", "LOGIN_REQUIRED"]);
const PLATFORM_REASON_MAX = 200;

/**
 * The worker's `platform_reason`, by its visible rule: only for the four codes about the video, the
 * words after the last `ERROR: [x] id: `, cut where the downloader speaks for itself, links removed,
 * at most 200 characters ending in `…` at a word. (The worker's redaction is not copied.)
 */
export function platformReason(stderr: string, code: string): string | undefined {
  if (!PLATFORM_REASON_CODES.has(code)) return undefined;
  let reason: string | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const m = PLATFORM_REASON_RE.exec(line);
    if (m) reason = m[1];
  }
  if (reason === undefined) return undefined;
  const cuts = REASON_CUTS.map((c) => reason!.indexOf(c)).filter((i) => i >= 0);
  const option = OPTION_CUT_RE.exec(reason);
  if (option) cuts.push(option.index);
  if (cuts.length) reason = reason.slice(0, Math.min(...cuts));
  reason = reason.replace(URL_RE, "").replace(/ {2,}/g, " ").trim();
  if (!reason || REASON_REFUSED.some((bad) => reason!.includes(bad))) return undefined;
  if (reason.length > PLATFORM_REASON_MAX) {
    const head = reason.slice(0, PLATFORM_REASON_MAX - 1);
    const space = head.lastIndexOf(" ");
    reason = `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
  }
  return reason;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCapture(body: SubmittedJob, ffmpeg: boolean): Promise<Record<string, unknown>> {
  const p = body.params;
  const tool = (p.tool as string | undefined) ?? "yt-dlp";
  const out = body.output;
  await mkdir(out, { recursive: true });
  const enumeration = !!(p.flatList || p.metadataOnly);
  if (tool === "yt-dlp" && !ffmpeg && !enumeration && typeof p.quality === "string" && !QUALITY_WITHOUT_FFMPEG.has(p.quality)) {
    // As the worker: a better quality without ffmpeg refuses to run rather than save less.
    return { status: "failed", error: { code: "TOOL_NOT_INSTALLED", message: "ffmpeg is not installed", tool: "ffmpeg" } };
  }
  const args = tool === "yt-dlp" ? ytdlpArgs(body.input, out, p, ffmpeg) : gallerydlArgs(body.input, out, p);
  const version = (await run(tool, ["--version"])).stdout.trim().split("\n")[0] ?? null;
  const r = await run(tool, args);
  // yt-dlp's comments move out of the info JSON into <id>.comments.json (as the worker does).
  if (p.includeComments && tool === "yt-dlp") {
    for (const n of (await readdir(out)).filter((x) => x.endsWith(".info.json"))) {
      const info = JSON.parse(await readFile(join(out, n), "utf8")) as Record<string, unknown>;
      if (!("comments" in info)) continue;
      const { comments, ...rest } = info;
      await writeFile(join(out, n.replace(/\.info\.json$/, ".comments.json")), JSON.stringify(Array.isArray(comments) ? comments : []));
      await writeFile(join(out, n), JSON.stringify(rest));
    }
  }
  const files: string[] = [];
  const infos: string[] = [];
  const comments: string[] = [];
  for (const n of (await readdir(out)).sort()) {
    if (SKIP_SUFFIXES.some((x) => n.endsWith(x)) || n.includes(".part-Frag")) continue;
    if (n.endsWith(".comments.json")) {
      comments.push(join(out, n));
      continue;
    }
    const isInfo = tool === "yt-dlp" ? n.endsWith(".info.json") : n.endsWith(".json");
    (isInfo ? infos : files).push(join(out, n));
  }
  const meta: Record<string, unknown> = { files, infoJson: infos, comments, tool, toolVersion: version, partial: false };
  if (p.includeComments && tool !== "yt-dlp") meta.commentsUnsupported = true;
  if (r.code !== 0) {
    const code = mapError(r.stderr);
    if (!downloadKept(tool, p, code, files, infos)) {
      // ffmpeg went away while the job ran: named as the missing tool.
      if (code === "TOOL_NOT_INSTALLED") return { status: "failed", error: { code, message: "ffmpeg is not installed", tool: "ffmpeg" } };
      const reason = platformReason(r.stderr, code);
      return { status: "failed", error: { code, message: `${tool} failed (${code})`, ...(reason ? { platformReason: reason } : {}) } };
    }
    Object.assign(meta, { partial: true, errorCode: code, errorDetail: "redacted" });
  }
  return { status: "done", result: { output: out, meta } };
}

async function runTranscribe(body: SubmittedJob): Promise<Record<string, unknown>> {
  const out = body.output;
  await mkdir(out, { recursive: true });
  const segments = [
    { start: 0, end: 2, text: "Welcome to the market.", lang: "en", avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.2, flags: [] },
    { start: 2, end: 4, text: "Thanks for watching!", lang: "en", avgLogprob: -1.4, noSpeechProb: 0.9, compressionRatio: 1.1, flags: ["outside-speech", "stock-phrase"] },
  ];
  await writeFile(join(out, "segments.json"), JSON.stringify(segments));
  await writeFile(
    join(out, "transcript.vtt"),
    "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the market.\n\nNOTE flags: outside-speech, stock-phrase\n\n00:00:02.000 --> 00:00:04.000\nThanks for watching!\n",
  );
  const model = (body.params.model as string | undefined) ?? "large-v3";
  return { status: "done", result: { output: out, meta: { model, detectedLanguages: ["en"], durationSec: 4, flaggedCount: 1 } } };
}

/** Starts the stand-in worker on 127.0.0.1 (random port). */
export async function startToolWorker(
  opts: {
    beforeCapture?: (job: SubmittedJob) => void | Promise<void>;
    missing?: string[];
    /** Whether the stand-in finds ffmpeg (default true), as the worker looks it up for each yt-dlp job. */
    ffmpeg?: boolean;
  } = {},
): Promise<ToolWorker> {
  const jobs = new Map<string, { type: string; final: Record<string, unknown> }>();
  const submitted: SubmittedJob[] = [];
  let n = 0;
  let active = 0;
  const state = { maxConcurrent: 0 };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "no" } });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method === "POST" && req.url === "/jobs") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SubmittedJob;
      submitted.push(body);
      const id = `j${++n}`;
      active++;
      state.maxConcurrent = Math.max(state.maxConcurrent, active);
      let final: Record<string, unknown>;
      try {
        if (body.type === "capture.download") await opts.beforeCapture?.(body);
        // As the Python worker: a job whose optional tool is missing fails naming it (Task 48a).
        const tool =
          body.type === "capture.download" ? (body.params.tool === "gallery-dl" ? "image-downloader" : "video-downloader") : body.type === "audio.transcribe" ? `speech-${String(body.params.model ?? "large-v3")}` : "";
        if (tool && opts.missing?.includes(tool)) final = { status: "failed", error: { code: "TOOL_NOT_INSTALLED", message: `${tool} is not installed`, tool } };
        else final = body.type === "capture.download" ? await runCapture(body, opts.ffmpeg !== false) : body.type === "audio.transcribe" ? await runTranscribe(body) : { status: "failed", error: { code: "UNSUPPORTED", message: "stub" } };
      } catch (err) {
        final = { status: "failed", error: { code: "STUB_ERROR", message: String(err) } };
      } finally {
        active--;
      }
      jobs.set(id, { type: body.type, final });
      return send(202, { id });
    }
    const m = /^\/jobs\/([^/]+)$/.exec(req.url ?? "");
    const job = m ? jobs.get(m[1]!) : undefined;
    if (!job) return send(404, { error: { code: "NOT_FOUND", message: "no" } });
    return send(200, { id: m![1], type: job.type, progress: 1, ...job.final });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: STUB_TOKEN,
    submitted,
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
