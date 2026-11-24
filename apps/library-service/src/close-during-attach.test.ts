/**
 * FR-749 (R546 2, 3; R247 c, d): closing a library while an attach is under way. A close (the close route, the close
 * inside opening or creating another library, the service's stop) answers promptly while an attach waits on a "too
 * many requests" lookup: the attach is cancelled, answers the one sentence, and NOTHING is written into the library
 * after its lock is released. An attach already inside its store turn is waited for: it is fully stored and audited,
 * then the lock goes. A change asked for once the close has begun is refused, and writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { LIBRARY_CLOSED_TEXT, attachClosedSentence, backupClosedSentence } from "@ao/shared";
import { KeyRing, deviceDeps, openLibrary, openRepo, type Deps } from "@ao/library";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { seams } from "../../../packages/library/src/repo/testing.js";
import { backupSeams } from "../../../packages/library/src/export/backup.js";
import { pendingMarkers } from "../../../packages/library/src/repo/txn.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
/** Lookups allowed (the file's title is searched at OpenAlex): the attach waits on the service's 429. */
const LOOKUP_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
`;
const NO_LOOKUP_GOV = `${LOOKUP_GOV}processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let agent: MockAgent;
let previous: Dispatcher;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-close-attach-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  agent = new MockAgent();
  agent.disableNetConnect();
  previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent" });
});
afterEach(async () => {
  seams.beforeMkdir = undefined;
  backupSeams.afterSnapshot = undefined;
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

type Inject = { method?: "GET" | "POST"; url: string; body?: unknown };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function libraryWithProject(gov = LOOKUP_GOV): Promise<{ path: string; pid: string; folder: string }> {
  const path = join(tmp, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
  const p = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: gov, encryption: { enabled: false } } });
  expect(p.status, p.body).toBe(200);
  return { path, pid: p.json.project.id as string, folder: p.json.project.folder as string };
}

async function pdf(name: string, title: string): Promise<string> {
  const p = join(tmp, "Desktop", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  return p;
}

/** Every file under `root` with its bytes' digest: equal snapshots mean nothing was written in between. */
async function snapshot(root: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(`${rel}/`, ...(await snapshot(root, rel)));
    else out.push(`${rel} ${createHash("sha256").update(await readFile(join(root, rel))).digest("hex")}`);
  }
  return out.sort();
}

/** Every OpenAlex request answers 429 with Retry-After 60; `asked` resolves at the first. */
function openAlexSaysWait(): { asked: Promise<void>; count: () => number } {
  let n = 0;
  let asked!: () => void;
  const p = new Promise<void>((r) => (asked = r));
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (x: string) => x.startsWith("/works"), method: "GET" })
    .reply(() => {
      n++;
      asked();
      return { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "60" } } };
    })
    .persist();
  return { asked: p, count: () => n };
}

/** The lock is free: a second Library object opens the folder read-write and finds it clean (no marker, no warning). */
async function cleanForAnother(path: string): Promise<void> {
  const other = await openLibrary(path, { ...deviceDeps(join(tmp, "config-other")), settleMs: 0 });
  try {
    expect(other.mode).toBe("read-write");
    expect(await pendingMarkers(path)).toBe(0);
    const repo = await openRepo(other, new KeyRing(), {});
    expect(repo.integrityWarnings).toEqual([]);
  } finally {
    await other.close();
  }
}

/** Closes the library through `close` while an attach waits on its lookup; everything the brief asks is checked. */
async function closeDuringLookup(close: () => Promise<{ status: number; body: string }>): Promise<void> {
  const { path, pid } = await libraryWithProject();
  const file = await pdf("tide-line-notes.pdf", "Notes from the tide-line interviews");
  const original = await readFile(file);
  const wait = openAlexSaysWait();
  const attaching = call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [file] } });
  await wait.asked;
  const closed = await close();
  expect(closed.status, closed.body).toBe(200);
  const afterClose = await snapshot(path);
  const att = await attaching;
  expect(att.status, att.body).toBe(200);
  expect(att.json.items).toEqual([{ path: file, outcome: "cancelled", reason: attachClosedSentence("tide-line-notes.pdf") }]);
  // R551 M5, word for word.
  expect(att.json.items[0].reason).toBe("The library was closed or went offline before tide-line-notes.pdf was attached, so nothing was changed. Attach it again when the library is open.");
  await svc!.state.idle();
  expect(await snapshot(path)).toEqual(afterClose);
  expect(afterClose.filter((l) => l.includes("source.json") || l.includes("/original/") || l.includes("review/pending"))).toEqual([]);
  expect(wait.count()).toBe(1); // the wait was cut, nothing was asked again
  expect(await readFile(file)).toEqual(original);
  await cleanForAnother(path);
}

describe("a close while an attach waits on its lookup (FR-749, R546)", () => {
  it("POST /libraries/close: answers promptly; the attach says so; nothing is written after the lock is released", async () => {
    await closeDuringLookup(() => call({ method: "POST", url: "/libraries/close" }));
  });

  it("opening another library closes this one the same way", async () => {
    const other = join(tmp, "Other");
    expect((await call({ method: "POST", url: "/libraries", body: { path: other, name: "Other" } })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await closeDuringLookup(() => call({ method: "POST", url: "/libraries/open", body: { path: other } }));
  });

  it("creating a library closes this one the same way", async () => {
    await closeDuringLookup(() => call({ method: "POST", url: "/libraries", body: { path: join(tmp, "New"), name: "New" } }));
  });

  it("the service's stop does not wait for the lookup; nothing is written", async () => {
    const { path, pid } = await libraryWithProject();
    const file = await pdf("tide-line-notes.pdf", "Notes from the tide-line interviews");
    const wait = openAlexSaysWait();
    const attaching = call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [file] } });
    await wait.asked;
    const stopping = svc!.close();
    const att = await attaching;
    expect(att.json.items).toEqual([{ path: file, outcome: "cancelled", reason: attachClosedSentence("tide-line-notes.pdf") }]);
    await stopping;
    svc = undefined;
    // R551 M8: the whole folder, byte for byte, as the close route's test compares it: right after the stop, and once
    // everything has settled.
    const afterStop = await snapshot(path);
    expect(afterStop.filter((l) => l.includes("source.json") || l.includes("/original/") || l.includes("review/pending"))).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await snapshot(path)).toEqual(afterStop);
    expect(await pendingMarkers(path)).toBe(0);
    expect(wait.count()).toBe(1);
    expect(existsSync(join(path, ".lock"))).toBe(false);
  });
});

describe("a close while an attach is inside its store turn (FR-749, R546; R247 d)", () => {
  it("the close waits: the source is fully stored and audited, then the lock goes; a change asked meanwhile is refused", async () => {
    const { path, pid, folder } = await libraryWithProject(NO_LOOKUP_GOV);
    await closeWaitsForTheTurn(path, pid, folder);
  });

  it("R551 M7: in an encrypted project too, the change finishes with its key and its index update (the index and the keys go after the wait)", async () => {
    const path = join(tmp, "Lib");
    expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
    const p = await call({ method: "POST", url: "/projects", body: { name: "Sealed", governanceYaml: NO_LOOKUP_GOV, encryption: { enabled: true, passphrase: "correct horse battery" } } });
    expect(p.status, p.body).toBe(200);
    await closeWaitsForTheTurn(path, p.json.project.id as string, p.json.project.folder as string, true);
  });
});

async function closeWaitsForTheTurn(path: string, pid: string, folder: string, encrypted = false): Promise<void> {
  {
    const repo = svc!.state.session!.repo;
    const file = await pdf("ledger.pdf", "Harbour ledger of 1932");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    // Held inside the attach's change: its marker is written, its source folder about to be made.
    seams.beforeMkdir = async (abs) => {
      if (!abs.includes(`${join(folder, "Sources")}`.split("/").join("/"))) return;
      entered();
      await gate;
    };
    const attaching = call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [file] } });
    await inside;
    const order: string[] = [];
    const closing = call({ method: "POST", url: "/libraries/close" }).then((r) => {
      order.push(`closed:${existsSync(join(path, ".lock")) ? "locked" : "free"}`);
      return r;
    });
    // A change asked for once the close has begun: refused, in the words every request gets while no library is open.
    const late = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Late" } });
    expect(late.status).toBe(503);
    expect(late.json.error.message).toBe("No library is open.");
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);
    expect(existsSync(join(path, ".lock"))).toBe(true);
    order.push("released");
    release();
    const att = await attaching;
    expect((await closing).status).toBe(200);
    expect(order).toEqual(["released", "closed:free"]);
    expect(att.json.items).toEqual([expect.objectContaining({ path: file, outcome: "needs-review" })]);
    const sid = att.json.items[0].sourceId as string;
    // Fully there and audited, no marker left; the late collection is nowhere.
    const sources = await readdir(join(path, folder, "Sources"));
    expect(sources).toHaveLength(1);
    expect(existsSync(join(path, folder, "Sources", sources[0]!, encrypted ? "source.json.enc" : "source.json"))).toBe(true);
    const audit = (await readdir(join(path, folder, "audit"))).sort();
    const lines = (await Promise.all(audit.map((f) => readFile(join(path, folder, "audit", f), "utf8")))).join("");
    if (!encrypted) expect(lines).toContain(sid);
    expect(await readFile(join(path, folder, "project.json"), "utf8")).not.toContain("Late");
    // R551 M7: the change in its turn updated the index too (it was closed after the wait, not before).
    expect(repo.indexErrors).toEqual([]);
    await cleanForAnother(path);
  }
}

/** Every OpenAlex request answers 429 / Retry-After 60 while `wait` is true, else "not found"; `asked` at the first. */
function openAlexSwitchable(): { asked: Promise<void>; count: () => number; answer: () => void } {
  let n = 0;
  let wait = true;
  let asked!: () => void;
  const p = new Promise<void>((r) => (asked = r));
  agent
    .get("https://api.openalex.org")
    .intercept({ path: () => true, method: "GET" })
    .reply(() => {
      n++;
      asked();
      return wait ? { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "60" } } } : { statusCode: 404, data: "" };
    })
    .persist();
  return { asked: p, count: () => n, answer: () => void (wait = false) };
}

/** Waits until the batch has ended and the service let its run go; returns its listed state. */
async function settledBatch(pid: string, batchId: string): Promise<string> {
  for (;;) {
    const b = ((await call({ url: `/projects/${pid}/imports` })).json.batches as Array<{ batchId: string; state: string }>).find((x) => x.batchId === batchId);
    if (b && b.state !== "running" && !svc!.state.session?.batches.has(batchId)) return b.state;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function journalLines(path: string): Promise<Array<{ key: string; outcome: string }>> {
  const found = (await readdir(path, { recursive: true })).find((x) => x.replaceAll("\\", "/").endsWith("imports/batch-0001/journal.jsonl"));
  const text = found ? await readFile(join(path, found), "utf8") : "";
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { key: string; outcome: string });
}

/**
 * FR-749 (R551 I1): a Bulk Import running when the library closes is left paused — no item failed, nothing journaled
 * for the item whose lookup was cut — and, once the library is opened again, resumes and completes, each item once.
 */
async function importCutBy(close: (path: string) => Promise<void>): Promise<void> {
  const { path, pid } = await libraryWithProject();
  const src = join(tmp, "Papers");
  for (const [name, title] of [
    ["alpha.pdf", "Harbour ledgers of the northern coast"],
    ["beta.pdf", "Salt works and their keepers"],
    ["gamma.pdf", "Nets, boats and the tide-line"],
  ] as const) {
    await mkdir(src, { recursive: true });
    await writeFile(join(src, name), await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  }
  const oa = openAlexSwitchable();
  const start = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: src } } });
  expect(start.status, start.body).toBe(200);
  const batchId = start.json.batchId as string;
  await oa.asked;
  await close(path);
  expect(oa.count()).toBe(1); // the wait was cut, nothing was asked again
  expect((await journalLines(path)).filter((l) => l.outcome === "failed")).toEqual([]);
  expect(await journalLines(path)).toEqual([]);

  // Opened again: the batch is paused, nothing failed; resumed, it completes with each item once.
  const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
  expect(opened.status, opened.body).toBe(200);
  expect(await settledBatch(pid, batchId)).toBe("paused");
  expect((await call({ url: `/imports/${batchId}/report` })).json.counts.failed).toBe(0);
  oa.answer();
  const resumed = await call({ method: "POST", url: `/imports/${batchId}/resume` });
  expect(resumed.status, resumed.body).toBe(200);
  expect(await settledBatch(pid, batchId)).toBe("finished");
  const done = (await call({ url: `/imports/${batchId}/report` })).json;
  expect(done.counts.failed).toBe(0);
  expect(done.counts.created + done.counts.needsReview).toBe(3);
  const lines = await journalLines(path);
  expect(lines.map((l) => l.key).sort()).toEqual(["alpha.pdf", "beta.pdf", "gamma.pdf"]);
  expect(lines.every((l) => l.outcome !== "failed")).toBe(true);
}

describe("a Bulk Import running when the library closes (FR-749, R551 I1)", () => {
  it("POST /libraries/close: the batch is left paused, no item failed; after reopening it resumes and imports each item once", async () => {
    await importCutBy(async () => {
      const r = await call({ method: "POST", url: "/libraries/close" });
      expect(r.status, r.body).toBe(200);
    });
  }, 60_000);

  it("the service's stop: the same, read back by a new service", async () => {
    await importCutBy(async () => {
      await svc!.close();
      svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent" });
    });
  }, 60_000);
});

/** Resolves once the session's closing has begun (beginClosing aborted its signal). */
function closingBegun(): Promise<void> {
  const sig = svc!.state.session!.closing.signal;
  return sig.aborted ? Promise.resolve() : new Promise((r) => sig.addEventListener("abort", () => r(), { once: true }));
}

/** A hold on a seam: `inside` once reached; `release` lets it go (also when the test ends). */
function heldSeam(): { seam: () => Promise<void>; inside: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  return { seam: async () => (entered(), gate), inside, release };
}

async function stateFailures(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(path, "Backups", "backups-state.json"), "utf8")).failures ?? {};
  } catch {
    return {};
  }
}

describe("a backup in flight when the library closes (FR-749, R551 I2)", () => {
  it("POST /projects/:id/backups: cancelled, its own sentence; nothing under the library changes after the close; no backup-failed at the next opening", async () => {
    const { path, pid } = await libraryWithProject(NO_LOOKUP_GOV);
    const h = heldSeam();
    backupSeams.afterSnapshot = h.seam;
    const backingUp = call({ method: "POST", url: `/projects/${pid}/backups` });
    await h.inside;
    const closing = call({ method: "POST", url: "/libraries/close" });
    await closingBegun();
    h.release();
    expect((await closing).status).toBe(200);
    const afterClose = await snapshot(path);
    const b = await backingUp;
    expect(b.status, b.body).toBe(409);
    expect(b.json.error).toEqual({ code: "LIBRARY_CLOSED", message: backupClosedSentence("Study") });
    expect(b.json.error.message).toBe("The library was closed or went offline before the backup of Study was finished, so no backup was made. Back it up again when the library is open.");
    await svc!.state.idle();
    expect(await snapshot(path)).toEqual(afterClose);
    expect(afterClose.filter((l) => /\.tmp-[0-9a-f]+ /u.test(l) || /\.zip(\.enc)? /u.test(l))).toEqual([]);
    expect(await stateFailures(path)).toEqual({});
    // Opened again: no `backup-failed`.
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.projectWarnings(svc!.state.session!);
    const st = svc!.state.libraryState() as { projectWarnings: Record<string, string[]> };
    expect(st.projectWarnings[pid] ?? []).not.toContain("backup-failed");
  });

  it("the scheduler's backup is cut the same way: nothing made, nothing recorded", async () => {
    const { path, pid } = await libraryWithProject(NO_LOOKUP_GOV);
    const h = heldSeam();
    backupSeams.afterSnapshot = h.seam;
    const running = svc!.state.runScheduledBackups(pid);
    await h.inside;
    const closing = call({ method: "POST", url: "/libraries/close" });
    await closingBegun();
    h.release();
    expect((await closing).status).toBe(200);
    const afterClose = await snapshot(path);
    expect(await running).toEqual([{ projectId: pid, ok: true, backedUp: false }]);
    await svc!.state.idle();
    expect(await snapshot(path)).toEqual(afterClose);
    expect(await stateFailures(path)).toEqual({});
  });
});

describe("a change that reaches the engine after its library was closed (FR-749, R551 M5)", () => {
  it("answers 409 LIBRARY_CLOSED, \"That library has been closed, so nothing was changed.\"; a request with no library open keeps its answer", async () => {
    const { path, pid, folder } = await libraryWithProject(NO_LOOKUP_GOV);
    // The request takes the session, then is held before its change reaches the engine; the library closes meanwhile.
    const repo = svc!.state.session!.repo;
    const h = heldSeam();
    const original = repo.createCollection.bind(repo);
    repo.createCollection = (async (...a: Parameters<typeof original>) => {
      await h.seam();
      return original(...a);
    }) as typeof original;
    const late = call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Late" } });
    await h.inside;
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    h.release();
    const r = await late;
    expect(r.status, r.body).toBe(409);
    expect(r.json.error).toEqual({ code: "LIBRARY_CLOSED", message: LIBRARY_CLOSED_TEXT });
    expect(LIBRARY_CLOSED_TEXT).toBe("That library has been closed, so nothing was changed.");
    expect(await readFile(join(path, folder, "project.json"), "utf8")).not.toContain("Late");
    const none = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "None" } });
    expect(none.status).toBe(503);
    expect(none.json.error).toEqual({ code: "LIBRARY_OFFLINE", message: "No library is open." });
  });
});
