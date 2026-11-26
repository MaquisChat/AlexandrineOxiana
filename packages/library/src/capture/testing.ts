/**
 * Test-only helpers for link capture (not exported from the package): an in-process stand-in for
 * the media worker's HTTP API that runs `capture.download` with whatever `yt-dlp` / `gallery-dl` is
 * first on PATH (the fake tools in tests/fixtures/fake-tools), mirroring the Python worker's
 * arguments, output listing (comments split out, partial enumerations) and error mapping, and answers `audio.transcribe` with a canned
 * transcript (one of two segments flagged).
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
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

// Same order and patterns as services/media-worker/ao_worker/download.py (with the worker's
// DISK_FULL and NETWORK_LOST, placed before NOT_FOUND_OR_REMOVED).
const ERROR_PATTERNS: Array<[string, RegExp]> = [
  ["PRIVATE", /private video|this (account|profile|user) is private|is private\b|private (account|profile|post)/i],
  ["GEO_BLOCKED", /not (made this video )?available in your (country|region|location)|geo[- ]?(restrict|block)/i],
  ["RATE_LIMITED", /\b429\b|too many requests|rate[- ]?limit/i],
  ["LOGIN_REQUIRED", /sign in to confirm|log ?in required|login required|requires? (a )?log ?in|--cookies|authentication|age[- ]?restricted|you need to log in|log in to/i],
  ["DISK_FULL", /No space left on device|ENOSPC|disk (is )?full/i],
  ["NETWORK_LOST", /Unable to download|timed out|Connection (reset|refused|aborted)|Network is unreachable|Temporary failure in name resolution|getaddrinfo failed|Read timed out/i],
  ["NOT_FOUND_OR_REMOVED", /video unavailable|has been removed|\b404\b|not found|does not exist|no longer available|has been deleted|account (has been )?(terminated|suspended)|unavailable/i],
];

function mapError(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.includes("ERROR") || l.includes("[error]"));
  const text = lines.length ? lines.join("\n") : stderr;
  for (const [code, re] of ERROR_PATTERNS) if (re.test(text)) return code;
  return "EXTRACTOR_ERROR";
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

async function runCapture(body: SubmittedJob): Promise<Record<string, unknown>> {
  const p = body.params;
  const tool = (p.tool as string | undefined) ?? "yt-dlp";
  const out = body.output;
  await mkdir(out, { recursive: true });
  let args: string[];
  if (tool === "yt-dlp") {
    args = ["--ignore-config", "-o", join(out, "%(id)s.%(ext)s"), "--write-info-json", "--write-subs", "--write-auto-subs", "--write-thumbnail"];
    if (p.archiveFile) args.push("--download-archive", String(p.archiveFile));
    if (p.flatList) args.push("--flat-playlist");
    if (p.maxItems) args.push("--playlist-end", String(p.maxItems));
    if (p.dateAfter) args.push("--dateafter", String(p.dateAfter));
    if (p.dateBefore) args.push("--datebefore", String(p.dateBefore));
    if (p.metadataOnly) args.push("--skip-download");
    if (p.includeComments) args.push("--write-comments");
    // The worker's QUALITY_FORMATS ("audio" also extracts the sound to m4a).
    const formats: Record<string, string[]> = {
      best: ["-f", "bv*+ba/b"],
      "1080p": ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b"],
      "720p": ["-f", "bv*[height<=720]+ba/b[height<=720]/b"],
      audio: ["-f", "ba/b", "-x", "--audio-format", "m4a"],
      ready: ["-f", "b"],
    };
    if (typeof p.quality === "string" && formats[p.quality]) args.push(...formats[p.quality]!);
  } else {
    args = ["--config-ignore", "--write-metadata", "-D", out];
    if (p.archiveFile) args.push("--download-archive", String(p.archiveFile));
    if (p.maxItems) args.push("--range", `1-${Number(p.maxItems)}`);
    if (p.metadataOnly) args.push("--no-download");
  }
  if (p.cookiesFromBrowser) args.push("--cookies-from-browser", String(p.cookiesFromBrowser));
  args.push("--", body.input);
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
    const enumeration = !!(p.flatList || p.metadataOnly);
    if (files.length === 0 && !(enumeration && infos.length > 0)) return { status: "failed", error: { code, message: `${tool} failed (${code})` } };
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
export async function startToolWorker(opts: { beforeCapture?: (job: SubmittedJob) => void | Promise<void>; missing?: string[] } = {}): Promise<ToolWorker> {
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
        else final = body.type === "capture.download" ? await runCapture(body) : body.type === "audio.transcribe" ? await runTranscribe(body) : { status: "failed", error: { code: "UNSUPPORTED", message: "stub" } };
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
