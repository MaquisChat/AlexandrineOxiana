#!/usr/bin/env node
// A stand-in for the media worker that answers only `audio.transcribe` (a canned two-segment
// transcript, one segment flagged). Used through AO_WORKER_BIN, so the CLI tests can cover a
// finished transcription without a speech model or real audio.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The token is the first line of standard input, as the real worker takes it (R155); the stand-in
// stops when its standard input closes, like the real one.
const lines = createInterface({ input: process.stdin });
const token = await new Promise((resolve) => lines.once("line", resolve));
lines.once("close", () => process.exit(0));
const jobs = new Map();
let n = 0;

if (process.env.AO_TEST_ENV_DUMP) writeFileSync(process.env.AO_TEST_ENV_DUMP, JSON.stringify(Object.keys(process.env)));

const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: "UNAUTHORIZED", message: "no" } });
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, versions: { yt_dlp: null } });
    if (req.method === "POST" && req.url === "/jobs") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const id = `j${++n}`;
      if (body.type !== "audio.transcribe") {
        jobs.set(id, { status: "failed", error: { code: "UNSUPPORTED", message: "stub" } });
      } else {
        mkdirSync(body.output, { recursive: true });
        writeFileSync(join(body.output, "segments.json"), JSON.stringify([{ start: 0, end: 2, text: "Welcome to the market.", flags: [] }]));
        writeFileSync(join(body.output, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the market.\n");
        jobs.set(id, { status: "done", result: { output: body.output, meta: { model: body.params?.model ?? "large-v3", detectedLanguages: ["en"], durationSec: 2, flaggedCount: 1 } } });
      }
      return send(202, { id });
    }
    const m = /^\/jobs\/([^/]+)$/.exec(req.url ?? "");
    const job = m && jobs.get(m[1]);
    return job ? send(200, { id: m[1], progress: 1, ...job }) : send(404, { error: { code: "NOT_FOUND", message: "no" } });
  });
});

server.listen(0, "127.0.0.1", () => console.log(`AO_WORKER_READY port=${server.address().port}`));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));
