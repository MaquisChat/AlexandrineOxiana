/**
 * Test-only (not exported from the package): an in-process stand-in for the Python media worker's
 * HTTP API (Task 15), shared by the worker client, capture and import suites. `onSubmit` plays each
 * submitted job (e.g. writes its output file) and returns the job's final state.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const STUB_TOKEN = "stub-token-0123456789";

export interface StubJob {
  id: string;
  body: { type: string; input: string; output: string; params: Record<string, unknown> };
  polls: number;
  final: Record<string, unknown>;
  cancelled: boolean;
}

export interface StubWorker {
  baseUrl: string;
  token: string;
  jobs: Map<string, StubJob>;
  requests: string[];
  close(): Promise<void>;
}

export async function stubWorker(
  onSubmit: (job: StubJob) => Promise<Record<string, unknown>> | Record<string, unknown>,
  opts: { pollsUntilDone?: number; failPolls?: number; token?: string; closers?: Array<() => Promise<void> | void> } = {},
): Promise<StubWorker> {
  const token = opts.token ?? STUB_TOKEN;
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
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: "UNAUTHORIZED", message: "no" } });
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
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((r) => server.close(() => r()));
  };
  opts.closers?.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, token, jobs, requests, close };
}
