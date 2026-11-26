/**
 * R641 D3: the missing-files check says how far it is. `GET /libraries/integrity` asked for NDJSON
 * (Accept: application/x-ndjson) streams `{ progress: { checked, total } }` lines and ends with
 * `{ result: <the plain answer> }`; a client that goes away aborts the check; the plain answer is
 * unchanged for every other caller.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

/** A test's hold on the check: while set, the route's check waits for its signal (standing for a long check). */
const hold: { on: boolean; signal?: AbortSignal; started?: () => void } = { on: false };
vi.mock("@ao/library", async (orig) => {
  const real = await orig<typeof import("@ao/library")>();
  return {
    ...real,
    checkIntegrity: async (...args: Parameters<typeof real.checkIntegrity>) => {
      if (!hold.on) return real.checkIntegrity(...args);
      const signal = args[2]?.signal;
      hold.signal = signal;
      args[2]?.onProgress?.(0, 3);
      hold.started?.();
      await new Promise<void>((_, reject) => {
        if (!signal) return; // no signal: never ends (the test fails on its own)
        signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
      });
      throw new Error("unreachable");
    },
  };
});

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}`, origin: "http://tauri.localhost" };
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-svc-integrity-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  hold.on = false;
  delete hold.signal;
  delete hold.started;
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(tmp, { recursive: true, force: true });
});

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown; headers?: Record<string, string> }) {
  const res = await svc!.app.inject({ method: r.method ?? "GET", url: r.url, headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers }, ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}) });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

/** A library with one project holding `n` sources of one PDF each. */
async function library(n: number): Promise<void> {
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
  const made = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
  expect(made.status, made.body).toBe(200);
  const pid = made.json.project.id as string;
  const repo = svc.state.session!.repo;
  await mkdir(join(tmp, "in"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const file = join(tmp, "in", `p${i}.pdf`);
    await writeFile(file, await buildPdf({ title: `Paper ${i}`, author: "Ana Souza", lines: [`Line ${i}.`] }));
    await repo.createSource(
      pid,
      { projectIds: [pid], type: "report", title: { variants: [{ lang: "en", kind: "original", value: `Paper ${i}` }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: file, role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
  }
}

describe("GET /libraries/integrity with its progress (R641 D3)", () => {
  it("asked for NDJSON: progress lines up to the total, then the plain answer as its result", async () => {
    await library(3);
    const plain = await call({ url: "/libraries/integrity?sample=full" });
    expect(plain.status, plain.body).toBe(200);
    const r = await call({ url: "/libraries/integrity?sample=full", headers: { accept: "application/x-ndjson" } });
    expect(r.status, r.body).toBe(200);
    expect(String(r.headers["content-type"])).toContain("application/x-ndjson");
    const lines = r.body.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    const progress = lines.filter((l) => l.progress).map((l) => l.progress as { checked: number; total: number });
    const total = plain.json.report.checked as number;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(progress[0]).toEqual({ checked: 0, total });
    expect(progress.at(-1)).toEqual({ checked: total, total });
    for (let i = 1; i < progress.length; i++) expect(progress[i]!.checked).toBeGreaterThanOrEqual(progress[i - 1]!.checked);
    const last = lines.at(-1)!;
    expect(Object.keys(last)).toEqual(["result"]);
    expect(last.result).toEqual(plain.json);
  });

  it("the plain answer (not asked for NDJSON) is exactly as before: JSON, its three parts, no progress", async () => {
    await library(1);
    const r = await call({ url: "/libraries/integrity?sample=full" });
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toContain("application/json");
    expect(Object.keys(r.json).sort()).toEqual(["integrityWarnings", "projectWarnings", "report"]);
    expect(r.body).not.toContain("progress");
  });

  it("refused before it starts (bad sample, no library) as before, with a plain error, even when asked for NDJSON", async () => {
    await library(0);
    const bad = await call({ url: "/libraries/integrity?sample=2", headers: { accept: "application/x-ndjson" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION");
  });

  it("a client that goes away aborts the check (its signal), and a later check runs as usual", async () => {
    await library(1);
    const port = await svc!.listen(0);
    hold.on = true;
    const started = new Promise<void>((r) => (hold.started = r));
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/libraries/integrity?sample=full`, { headers: { authorization: auth.authorization, accept: "application/x-ndjson" }, signal: ac.signal });
    expect(res.status).toBe(200);
    await started;
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first.split("\n")[0]!)).toEqual({ progress: { checked: 0, total: 3 } });
    expect(hold.signal?.aborted).toBe(false);
    ac.abort();
    await vi.waitFor(() => expect(hold.signal?.aborted).toBe(true));
    hold.on = false;
    // Listening, the service checks the Host against its port.
    const again = await call({ url: "/libraries/integrity?sample=full", headers: { host: `127.0.0.1:${port}`, accept: "application/x-ndjson" } });
    expect(again.status).toBe(200);
    expect(again.body.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).at(-1)).toHaveProperty("result");
  });
});
