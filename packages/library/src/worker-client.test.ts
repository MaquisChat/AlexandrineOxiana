import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { openIndex, type IndexDb } from "./index/db.js";
import { createLibrary, type Library } from "./library.js";
import { PolicyDeniedError, type Repo } from "./repo/index.js";
import { decryptBytes, encryptBytes } from "./repo/io.js";
import { projectDataKey } from "./repo/repo.js";
import { openTestRepo } from "./repo/testing.js";
import { WorkerJobError, WorkerUnavailableError, WorkerClient, startWorker, type WorkerHandle } from "./worker-client.js";

const FAST = 2 ** 10;
const TOKEN = "stub-token-0123456789";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NO_TRANSCRIPTION_GOV = `${OPEN_GOV}processing:
  transcription: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let db: IndexDb;
const closers: Array<() => Promise<void> | void> = [];

function deps(): Deps {
  return {
    clock: () => new Date(),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

interface StubJob {
  id: string;
  body: { type: string; input: string; output: string; params: Record<string, unknown> };
  polls: number;
  final: Record<string, unknown>;
  cancelled: boolean;
}

/** In-process stand-in for the Python worker's HTTP API. `onSubmit` plays the job and returns its final state. */
async function stubWorker(
  onSubmit: (job: StubJob) => Promise<Record<string, unknown>> | Record<string, unknown>,
  opts: { pollsUntilDone?: number; failPolls?: number } = {},
) {
  const jobs = new Map<string, StubJob>();
  let failPolls = opts.failPolls ?? 0;
  const requests: string[] = [];
  let n = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && failPolls > 0) {
      failPolls--;
      req.socket.destroy(); // the connection drops: the client sees a network error
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "no" } });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (req.method === "POST" && req.url === "/jobs") {
      const job: StubJob = { id: `j${++n}`, body, polls: 0, final: {}, cancelled: false };
      try {
        job.final = await onSubmit(job);
      } catch (err) {
        job.final = { status: "failed", error: { code: "STUB_ASSERTION", message: String(err) } };
      }
      jobs.set(job.id, job);
      return send(202, { id: job.id });
    }
    const m = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(req.url ?? "");
    const job = m ? jobs.get(m[1]!) : undefined;
    if (!job) return send(404, { error: { code: "NOT_FOUND", message: "no" } });
    if (m![2]) {
      job.cancelled = true;
      return send(202, { id: job.id, type: job.body.type, status: "running", progress: 0.5 });
    }
    job.polls++;
    if (job.cancelled) return send(200, { id: job.id, type: job.body.type, status: "cancelled", progress: 0.5 });
    if (job.polls < (opts.pollsUntilDone ?? 2)) return send(200, { id: job.id, type: job.body.type, status: "running", progress: 0.5 });
    return send(200, { id: job.id, type: job.body.type, progress: 1, ...job.final });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, jobs, requests };
}

async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, projectFolder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

async function workerTempDirs(): Promise<string[]> {
  try {
    return (await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("worker-"));
  } catch {
    return [];
  }
}

const jobRows = () => db.prepare("SELECT id, project_id, kind, status FROM jobs ORDER BY created_at, id").all() as Array<Record<string, string>>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-worker-client-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
  db = openIndex(lib.root);
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  db.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("WorkerClient.submit", () => {
  it("decrypts an encrypted input into <Library>/.tmp, encrypts the outputs and removes the temp folder", async () => {
    const { project } = await repo.createProject({ name: "E", governanceYaml: "captureMethods: [manual_upload]\n", encryption: { enabled: true, passphrase: "pw" } });
    const { key, keyId } = projectDataKey(repo, project.id)!;
    const input = join(tmp, "audio.m4a.enc");
    await writeFile(input, await encryptBytes(key, keyId, "secret audio bytes"));
    const seen: Record<string, unknown> = {};
    const worker = await stubWorker(async (job) => {
      const { input: wIn, output: wOut } = job.body;
      seen.input = wIn;
      seen.plaintext = await readFile(wIn, "utf8");
      seen.dirMode = (await stat(dirname(dirname(wIn)))).mode & 0o777;
      seen.fileMode = (await stat(wIn)).mode & 0o777;
      await mkdir(wOut, { recursive: true });
      await writeFile(join(wOut, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsecret words\n");
      await writeFile(join(wOut, "segments.json"), "[]");
      return { status: "done", result: { output: wOut, meta: { model: "tiny", detectedLanguages: ["en"], durationSec: 1, flaggedCount: 0 } } };
    });
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    const output = join(tmp, "out", "transcript");
    const progress: number[] = [];
    const result = await client.submit(project.id, {
      type: "audio.transcribe", input, inputEncrypted: true, output, params: { model: "tiny" }, onProgress: (p) => progress.push(p),
    });

    expect(String(seen.input).startsWith(join(lib.root, ".tmp", "worker-"))).toBe(true);
    expect(seen.plaintext).toBe("secret audio bytes");
    if (process.platform !== "win32") {
      expect(seen.dirMode).toBe(0o700);
      expect(seen.fileMode).toBe(0o600);
    }
    expect(result.encrypted).toBe(true);
    expect(result.output).toBe(output);
    expect(result.files.sort()).toEqual([join(output, "segments.json"), join(output, "transcript.vtt")]);
    const vtt = await readFile(join(output, "transcript.vtt"));
    expect(vtt.includes("secret words")).toBe(false);
    expect((await decryptBytes((id) => ring.get(id), vtt)).toString("utf8")).toContain("secret words");
    expect(progress).toContain(0.5);
    expect(result.meta).toMatchObject({ model: "tiny" });
    expect(await workerTempDirs()).toEqual([]);
    expect(existsSync(String(seen.input))).toBe(false);
    expect(jobRows()).toEqual([{ id: result.id, project_id: project.id, kind: "audio.transcribe", status: "done" }]);
  });

  it("removes the decrypted input after a failed job and reports the worker's error", async () => {
    const { project } = await repo.createProject({ name: "E", governanceYaml: "captureMethods: [manual_upload]\n", encryption: { enabled: true, passphrase: "pw" } });
    const { key, keyId } = projectDataKey(repo, project.id)!;
    const input = join(tmp, "clip.mov");
    await writeFile(input, await encryptBytes(key, keyId, "video"));
    let workerInput = "";
    const worker = await stubWorker((job) => {
      workerInput = job.body.input;
      return { status: "failed", error: { code: "UNSUPPORTED_INPUT", message: "the input is not a readable video file" } };
    });
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    const err = await client
      .submit(project.id, { type: "video.proxy", input, inputEncrypted: true, output: join(tmp, "out", "proxy.mp4"), params: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerJobError).code).toBe("UNSUPPORTED_INPUT");
    expect(workerInput.startsWith(join(lib.root, ".tmp", "worker-"))).toBe(true);
    expect(existsSync(workerInput)).toBe(false);
    expect(await workerTempDirs()).toEqual([]);
    expect(existsSync(join(tmp, "out", "proxy.mp4"))).toBe(false);
    expect(jobRows().map((r) => r.status)).toEqual(["failed"]);
  });

  it("a denied transcription throws PolicyDeniedError, is audited, and never contacts the worker", async () => {
    const { project } = await repo.createProject({ name: "D", governanceYaml: NO_TRANSCRIPTION_GOV, encryption: { enabled: false } });
    const input = join(tmp, "a.wav");
    await writeFile(input, "RIFF");
    const worker = await stubWorker(() => ({ status: "done" }));
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    await expect(client.submit(project.id, { type: "audio.transcribe", input, output: join(tmp, "t"), params: {} })).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    expect(worker.requests).toEqual([]);
    const deny = (await auditEvents(project.folder)).filter((e) => e.decision?.result === "deny");
    expect(deny).toHaveLength(1);
    expect(deny[0]!.action).toBe("process");
    expect(deny[0]!.details).toMatchObject({ op: "worker.audio.transcribe" });
    expect(jobRows()).toEqual([]);
    expect(await workerTempDirs()).toEqual([]);
  });

  it("moves plaintext outputs into place for an unencrypted project and rewrites result paths", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const worker = await stubWorker(async (job) => {
      await mkdir(job.body.output, { recursive: true });
      await writeFile(join(job.body.output, "abc.mp4"), "mp4");
      await writeFile(join(job.body.output, "abc.info.json"), "{}");
      return {
        status: "done",
        result: {
          output: job.body.output,
          meta: { files: [join(job.body.output, "abc.mp4")], infoJson: [join(job.body.output, "abc.info.json")], tool: "yt-dlp", toolVersion: "1", partial: false },
        },
      };
    });
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    const output = join(tmp, "capture");
    const r = await client.submit(project.id, { type: "capture.download", input: "https://www.youtube.com/watch?v=abc", output, params: { tool: "yt-dlp" } });
    expect(worker.jobs.get("j1")!.body.input).toBe("https://www.youtube.com/watch?v=abc");
    expect(r.encrypted).toBe(false);
    expect(await readFile(join(output, "abc.mp4"), "utf8")).toBe("mp4");
    expect(r.meta.files).toEqual([join(output, "abc.mp4")]);
    expect(r.meta.infoJson).toEqual([join(output, "abc.info.json")]);
    expect(await workerTempDirs()).toEqual([]);
  });

  it("cancels the worker job when the signal aborts", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const input = join(tmp, "a.png");
    await writeFile(input, "png");
    const worker = await stubWorker(() => ({ status: "done", result: { output: "", meta: {} } }), { pollsUntilDone: 1000 });
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    const ac = new AbortController();
    const p = client.submit(project.id, { type: "image.proxy", input, output: join(tmp, "o.jpg"), params: {}, signal: ac.signal, onProgress: () => ac.abort() });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerJobError).code).toBe("CANCELLED");
    expect(worker.requests).toContain("POST /jobs/j1/cancel");
    expect(jobRows().map((r) => r.status)).toEqual(["cancelled"]);
    expect(await workerTempDirs()).toEqual([]);
  });

  it("keeps a job pending when the worker is unreachable and resubmits it on the next launch", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const input = join(tmp, "a.png");
    await writeFile(input, "png");
    const down = await stubWorker(() => ({ status: "done" }));
    closers.pop()!(); // close it: connections are refused
    await new Promise((r) => setTimeout(r, 20));
    const offline = new WorkerClient({ repo, worker: down, index: { db }, pollMs: 10 });
    const output = join(tmp, "o.jpg");
    await expect(offline.submit(project.id, { type: "image.proxy", input, output, params: { maxEdge: 100 } })).rejects.toBeInstanceOf(
      WorkerUnavailableError,
    );
    expect(jobRows().map((r) => r.status)).toEqual(["queued"]);

    const worker = await stubWorker(async (job) => {
      expect(job.body.params).toEqual({ maxEdge: 100 });
      await mkdir(dirname(job.body.output), { recursive: true });
      await writeFile(job.body.output, "jpeg");
      return { status: "done", result: { output: job.body.output, meta: { width: 100 } } };
    });
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    const resumed = await client.resumePending();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.error).toBeUndefined();
    expect(resumed[0]!.result!.output).toBe(output);
    expect(await readFile(output, "utf8")).toBe("jpeg");
    expect(jobRows().map((r) => r.status)).toEqual(["done"]);
  });
});

describe("WorkerClient polling", () => {
  async function imageJob(failPolls: number) {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const input = join(tmp, "a.png");
    await writeFile(input, "png");
    let workerOut = "";
    const worker = await stubWorker(
      async (job) => {
        workerOut = job.body.output;
        await mkdir(dirname(job.body.output), { recursive: true });
        await writeFile(job.body.output, "jpeg");
        return { status: "done", result: { output: job.body.output, meta: {} } };
      },
      { failPolls },
    );
    const client = new WorkerClient({ repo, worker, index: { db }, pollMs: 10 });
    const p = client.submit(project.id, { type: "image.proxy", input, output: join(tmp, "o.jpg"), params: {} });
    return { p, worker, workerOut: () => workerOut };
  }

  it("retries up to 3 failed polls", async () => {
    const { p } = await imageJob(3);
    const r = await p;
    expect(await readFile(r.output, "utf8")).toBe("jpeg");
    expect(jobRows().map((x) => x.status)).toEqual(["done"]);
  });

  it("after 4 failed polls it sends a best-effort cancel, keeps the job pending and only then removes the temp folder", async () => {
    const { p, worker, workerOut } = await imageJob(1000);
    await expect(p).rejects.toBeInstanceOf(WorkerUnavailableError);
    const gets = worker.requests.filter((r) => r.startsWith("GET "));
    expect(gets).toHaveLength(4);
    expect(worker.requests.at(-1)).toBe("POST /jobs/j1/cancel");
    expect(existsSync(workerOut())).toBe(false);
    expect(await workerTempDirs()).toEqual([]);
    expect(jobRows().map((x) => x.status)).toEqual(["running"]);
  });
});

describe("startWorker", () => {
  async function stubScript(body: string): Promise<string> {
    const p = join(tmp, `stub-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(p, body);
    return p;
  }

  const READY_STUB = `import { createServer } from "node:http";
const token = process.env.AO_WORKER_TOKEN;
const s = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, versions: {}, env: { port: process.env.AO_WORKER_PORT, models: process.env.AO_MODELS_DIR, secret: process.env.SOME_APP_SECRET ?? null, hasPath: !!process.env.PATH, proxy: process.env.HTTPS_PROXY ?? null } }));
});
s.listen(0, "127.0.0.1", () => console.log("AO_WORKER_READY port=" + s.address().port));
`;

  it("spawns the worker with a random token and resolves once it prints AO_WORKER_READY; stop() kills it", async () => {
    const script = await stubScript(READY_STUB);
    process.env.SOME_APP_SECRET = "s3cret";
    process.env.HTTPS_PROXY = "http://proxy.test:3128";
    let w: WorkerHandle;
    try {
      w = await startWorker({ command: [process.execPath, script], env: { AO_MODELS_DIR: "/models" } });
    } finally {
      delete process.env.SOME_APP_SECRET;
      delete process.env.HTTPS_PROXY;
    }
    closers.push(() => w.stop());
    expect(w.token).toMatch(/^[0-9a-f]{64}$/);
    const res = await fetch(`${w.baseUrl}/health`, { headers: { Authorization: `Bearer ${w.token}` } });
    expect(res.status).toBe(200);
    // only an allowlisted environment reaches the worker
    expect(await res.json()).toMatchObject({ ok: true, env: { port: "0", models: "/models", secret: null, hasPath: true, proxy: "http://proxy.test:3128" } });
    const other = await startWorker({ command: [process.execPath, script] });
    closers.push(() => other.stop());
    expect(other.token).not.toBe(w.token);
    await w.stop();
    await expect(fetch(`${w.baseUrl}/health`)).rejects.toThrow();
  });

  it("rejects when the worker exits before it is ready", async () => {
    const script = await stubScript(`console.error("boom: missing module"); process.exit(3);`);
    await expect(startWorker({ command: [process.execPath, script] })).rejects.toThrow(/exited.*3/);
  });

  it("rejects and kills the worker when it is not ready in time", async () => {
    const pidFile = join(tmp, "pid");
    const script = await stubScript(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    await expect(startWorker({ command: [process.execPath, script], readyTimeoutMs: 1000 })).rejects.toThrow(/not ready/);
    const pid = Number(await readFile(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  const venvPython = join(
    dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "media-worker", ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  it.skipIf(!existsSync(venvPython))("starts the real Python worker from the dev venv", async () => {
    const w = await startWorker({ env: { AO_MODELS_DIR: join(tmp, "models"), AO_TOOLS_DIR: join(tmp, "tools") } });
    closers.push(() => w.stop());
    const res = await fetch(`${w.baseUrl}/health`, { headers: { Authorization: `Bearer ${w.token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    const unauth = await fetch(`${w.baseUrl}/health`);
    expect(unauth.status).toBe(401);
  }, 60_000);
});
