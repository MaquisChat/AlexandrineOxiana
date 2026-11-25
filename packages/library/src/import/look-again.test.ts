/**
 * Decision 31 (c), "Look up again" (R566, R577): `lookUpAgain` asks ONLY the lookups an entry kept in `leftOut`, of ONLY
 * the services left out, and APPENDS what is found to the entry's candidates; nothing of the record changes. The send is
 * audited before it goes (R566 6); the result is one governed change that reads the entry again inside itself (R566 2);
 * nothing is sent before the time kept on the entry (R411, R577 iii); automatic tries are bounded with growing waits
 * (R566 5); a lookup that failed outright is looked up again only by the researcher's act (R577 iv); nothing is written
 * once the library begins to close (R247 c, R546). Requests are counted with a MockAgent that refuses the network.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent } from "@ao/core";
import { LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT, lookUpGaveUpText } from "@ao/shared";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { FIXTURE_DOI, buildDoiPdf, buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient, lookupDoi, lookupContextFor } from "../lookup/index.js";
import { REVIEW_FILE, parseReviewFile, type LeftOutLookup, type ReviewEntry } from "../repo/review.js";
import { storeRequest } from "../repo/sources.js";
import { importChange, projectDataKey, type Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { createAttach } from "./attach.js";
import { decideReview } from "./bulk/review.js";
import { LOOK_SEND_OP, LOOK_UP_AGAIN_OP, dueLookUps, lookUpAgain } from "./look-again.js";
import { LOOK_UP_AGAIN_BOUNDS, lookUpNow } from "./look-up-state.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lookup");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;
const TITLE = "Notes from the tide-line interviews";
const MIN = 60_000;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let agent: MockAgent;
let now: number;
let sent: string[];
/** What each host answers now (set per test); a host without one answers 418 (and the request is counted). */
let answers: Record<string, (path: string) => Answer>;

const deps = (): Deps => ({
  clock: () => new Date(now),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

/** The client as the service makes it, on a clock only the test moves (its waits move it too: no real wait). */
const client = () =>
  new HttpClient({
    libraryRoot: lib.root,
    dispatcher: agent,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });

type Answer = { statusCode: number; data?: string; headers?: Record<string, string> };
const WAIT_60: Answer = { statusCode: 429, data: "slow down", headers: { "retry-after": "60" } };
const SEARCH: Answer = { statusCode: 200, data: fixture("openalex-search.json") };
const NO_RESULTS: Answer = { statusCode: 200, data: JSON.stringify({ results: [] }) };
const to = (host: string) => sent.filter((s) => s.startsWith(host)).length;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-look-again-"));
  now = Date.parse("2026-11-24T15:00:00Z");
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(now), tz: "UTC" });
  agent = new MockAgent();
  agent.disableNetConnect();
  sent = [];
  answers = {};
  for (const origin of ["https://api.openalex.org", "https://api.crossref.org", "https://openlibrary.org"]) {
    const host = new URL(origin).hostname;
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((req) => {
        sent.push(`${host}${req.path}`);
        const a = answers[host]?.(req.path) ?? { statusCode: 418 };
        return { statusCode: a.statusCode, data: a.data ?? "", responseOptions: { headers: { "content-type": "application/json", ...(a.headers ?? {}) } } };
      })
      .persist();
  }
});
afterEach(async () => {
  await agent.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});
afterAll(async () => {
  await shutdownExtractors();
});

async function project(encrypted = false, gov = GOV) {
  return (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: encrypted ? { enabled: true, passphrase: "correct horse battery staple" } : { enabled: false } })).project;
}
async function put(name: string, data: Buffer): Promise<string> {
  const p = join(tmp, "Desktop", `${Math.random().toString(36).slice(2, 7)}`, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
  return p;
}
const notesPdf = (title = TITLE) => buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] });
const reviewPath = (p: { folder: string }) => join(lib.root, p.folder, ...REVIEW_FILE.split("/"));
async function entries(p: { id: string; folder: string }): Promise<ReviewEntry[]> {
  const text = await readFile(reviewPath(p), "utf8").catch(() => "");
  const k = projectDataKey(repo, p.id);
  return parseReviewFile(text, p.id, k ? k.key : null).entries;
}
async function entry(p: { id: string; folder: string }, id: string): Promise<ReviewEntry> {
  return (await entries(p)).find((e) => e.id === id)!;
}
/** Attaches files while the services answer as set; returns the entries of the files attached. */
async function attached(p: { id: string; folder: string }, http: HttpClient, files: Array<Promise<Buffer>>): Promise<ReviewEntry[]> {
  const paths = await Promise.all(files.map(async (f, i) => put(`f${i}.pdf`, await f)));
  const out = await createAttach({ repo, http }).attachFiles(p.id, paths);
  const all = await entries(p);
  return out.map((o) => all.find((e) => e.sourceId === o.sourceId)!);
}
/** Sets fields of an entry as an earlier change would have written them (a governed change of the test's own). */
async function patch(p: { id: string }, e: ReviewEntry, fields: Partial<ReviewEntry>): Promise<void> {
  const sf = await repo.getSource(p.id, e.sourceId!);
  await importChange(repo, p.id, storeRequest(sf.source.provenance), async (ops) => ops.updateReview({ ...e, ...fields }), { op: "test.patch" });
}
async function auditOf(p: { folder: string }): Promise<{ events: AuditEvent[]; bytes: string }> {
  const dir = join(lib.root, p.folder, "audit");
  let bytes = "";
  for (const f of (await readdir(dir)).sort()) bytes += await readFile(join(dir, f), "utf8");
  return { events: bytes.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEvent), bytes };
}
/** The send lines on disk now, read synchronously — called from the stand-in's reply, as the request arrives. */
function sendLinesNow(p: { folder: string }): AuditEvent[] {
  const dir = join(lib.root, p.folder, "audit");
  return readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as AuditEvent)
    .filter((x) => x.details?.op === LOOK_SEND_OP);
}
async function sourceJson(p: { id: string }, sourceId: string): Promise<Buffer> {
  const sf = await repo.getSource(p.id, sourceId);
  const dir = join(lib.root, ...sf.source.folder.split("/"));
  const name = (await readdir(dir)).find((n) => n.startsWith("source.json"))!;
  return readFile(join(dir, name));
}
/** Every file under the library folder with its bytes (folders too), for a byte-for-byte comparison. */
async function snapshot(dir: string, base = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out[`${rel}/`] = "";
      Object.assign(out, await snapshot(join(dir, d.name), rel));
    } else out[rel] = (await readFile(join(dir, d.name))).toString("base64");
  }
  return out;
}
/** Holds every GET of `http` until `gate` is released: `when` is "before" the request goes, or "after" its answer came. */
function holdRequests(http: HttpClient, when: "before" | "after") {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const orig = http.getJson.bind(http) as (...a: unknown[]) => Promise<unknown>;
  (http as unknown as { getJson: (...a: unknown[]) => Promise<unknown> }).getJson = async (...a: unknown[]) => {
    if (when === "before") {
      reached();
      await gate;
      return orig(...a);
    }
    // An answer that throws (a service asking to wait, with "leave-out") is held as well, then thrown.
    const r = await orig(...a).then(
      (v) => ({ v }),
      (err: unknown) => ({ err }),
    );
    reached();
    await gate;
    if ("err" in r) throw r.err;
    return r.v;
  };
  onTestFinished(() => release());
  return { atGate, release: () => release() };
}
const match = (title: string, doi?: string) => ({ title, creators: [{ role: "author" as const, family: "Souza", given: "Ana" }], type: "article-journal" as const, identifiers: doi ? { doi } : {}, provider: "crossref" });

describe("lookUpAgain: what is found is appended; the record does not change (R566 1, R577 ii)", () => {
  it("(8) after \"found\", source.json is byte-identical; accept-candidate with the OLD positions accepts the same matches, with the new position the new one", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [a, b] = await attached(p, http, [notesPdf(), notesPdf("Market days in the northern valleys")]);
    expect(to("api.openalex.org")).toBe(1); // the second file was left out at once (the hold)
    expect(a!.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    const old = [match("An older match", "10.1/old"), match("A second older match")];
    await patch(p, a!, { candidates: old });
    await patch(p, b!, { candidates: old });
    const before = { a: await sourceJson(p, a!.sourceId!), b: await sourceJson(p, b!.sourceId!) };

    now += 16 * MIN;
    const tried = new Date(now).toISOString();
    answers["api.openalex.org"] = () => SEARCH;
    const ra = await lookUpAgain(repo, http, p.id, a!.id, { by: "automatic", now: new Date(now) });
    expect(ra).toMatchObject({ done: true, entryId: a!.id, asked: 1, services: ["openalex"], found: 2, state: { state: "found" } });
    const rb = await lookUpAgain(repo, http, p.id, b!.id, { by: "researcher", now: new Date(now) });
    expect(rb).toMatchObject({ done: true, found: 2 });
    expect(to("api.openalex.org")).toBe(3);

    const ea = await entry(p, a!.id);
    expect(ea.status).toBe("pending");
    expect(ea.candidates!.slice(0, 2)).toEqual(old);
    expect((ea.candidates as Array<{ title: string }>).slice(2).map((c) => c.title)).toEqual(["Rivers and Memory in Upland Villages", "Rivers of Memory"]);
    expect(ea.leftOut).toEqual([{ services: ["openalex"], title: TITLE, creator: "Souza", notBefore: new Date(Date.parse("2026-11-24T15:00:00Z") + MIN).toISOString(), tries: 1, lastTriedAt: tried, outcome: "found" }]);
    expect(ea.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.found);
    expect(ea.reasons).not.toContain(LOOKUP_WAITING_TEXT);
    // Nothing of the record changed.
    expect(await sourceJson(p, a!.sourceId!)).toEqual(before.a);
    expect(await sourceJson(p, b!.sourceId!)).toEqual(before.b);

    // The researcher accepts with the existing act, by position.
    await decideReview(repo, p.id, a!.id, { action: "accept-candidate", index: 0 });
    expect((await repo.getSource(p.id, a!.sourceId!)).source.title.variants[0]!.value).toBe("An older match");
    await decideReview(repo, p.id, b!.id, { action: "accept-candidate", index: 2 });
    expect((await repo.getSource(p.id, b!.sourceId!)).source.title.variants[0]!.value).toBe("Rivers and Memory in Upland Villages");
  });

  it("an identifier from the file: only the left-out services are asked; the found sentence says the match came from the file's identifier; R55 holds", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [buildDoiPdf()]);
    expect(e!.hints).toEqual([`doi:${FIXTURE_DOI}`]);
    const left = e!.leftOut!.find((l) => l.identifier)!;
    expect(left.services).toEqual(["crossref", "openalex"]);
    const before = await sourceJson(p, e!.sourceId!);
    sent = [];
    now += 16 * MIN;
    answers["api.crossref.org"] = () => ({ statusCode: 200, data: fixture("crossref-work.json") });
    answers["api.openalex.org"] = () => NO_RESULTS; // the title search the attach left out too
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    expect(r).toMatchObject({ done: true, state: { state: "found", fromFile: true } });
    expect(to("api.crossref.org")).toBe(1);
    expect(sent.filter((s) => s.startsWith("api.openalex.org/works/doi"))).toEqual([]); // Crossref gave it: OpenAlex not asked for the DOI
    const after = await entry(p, e!.id);
    expect(after.reasons.slice(0, 2)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile]);
    expect(await sourceJson(p, e!.sourceId!)).toEqual(before); // the DOI is still NOT on the record
    expect(JSON.stringify(await repo.getSource(p.id, e!.sourceId!))).not.toContain(FIXTURE_DOI);
  });

  it("nothing found: outcome \"nothing\", the entry's sentence says so, no candidate added", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 2 * MIN;
    answers["api.openalex.org"] = () => NO_RESULTS;
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    expect(r).toMatchObject({ done: true, found: 0, state: { state: "nothing" } });
    const after = await entry(p, e!.id);
    expect(after.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.nothing);
    expect(after.candidates).toBeUndefined();
    expect(after.leftOut![0]!.outcome).toBe("nothing");
    // a lookup that has its answer is not asked again, by anyone
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now + 60 * MIN) })).toEqual({ done: false, why: "nothing-to-look-up" });
    expect(to("api.openalex.org")).toBe(2);
  });
});

describe("lookUpAgain refuses early and writes nothing", () => {
  it("(1) an entry decided BETWEEN the send and the write is not reopened: the answer is dropped", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 2 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    const hold = holdRequests(http, "after");
    const run = lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    await hold.atGate; // the request was sent and answered
    await decideReview(repo, p.id, e!.id, { action: "keep-both" });
    const decided = await readFile(reviewPath(p));
    hold.release();
    expect(await run).toEqual({ done: false, why: "dropped" });
    expect(await readFile(reviewPath(p))).toEqual(decided);
    expect(await entry(p, e!.id)).toMatchObject({ status: "resolved", decision: "keep-both" });
    expect((await auditOf(p)).events.some((x) => x.details?.op === LOOK_UP_AGAIN_OP)).toBe(false);
  });

  it("(1) an entry already decided: nothing is sent, nothing written", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    await decideReview(repo, p.id, e!.id, { action: "keep-both" });
    now += 30 * MIN;
    const snap = await snapshot(lib.root);
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "decided" });
    expect(await snapshot(lib.root)).toEqual(snap);
    expect(to("api.openalex.org")).toBe(1);
  });

  it("(2) a source removed between the send and the write: nothing is written by the look-up", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 2 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    const hold = holdRequests(http, "after");
    const run = lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    await hold.atGate;
    await repo.deleteSource(p.id, e!.sourceId!);
    const removed = await readFile(reviewPath(p));
    hold.release();
    expect(await run).toEqual({ done: false, why: "dropped" });
    expect(await readFile(reviewPath(p))).toEqual(removed);
    expect(await entry(p, e!.id)).toMatchObject({ status: "resolved", decision: "source-removed" });
  });

  it("(3) a service the project's rules no longer allow is not asked (0 requests) and gets \"not-allowed\"", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    const g = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, `${GOV}processing:\n  metadata_lookup: [crossref]\n`, { baseSha256: g.sha256 });
    sent = [];
    now += 16 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) });
    expect(r).toMatchObject({ done: true, asked: 0, services: [], notAllowed: 1, state: { state: "not-allowed" } });
    expect(sent).toEqual([]);
    const after = await entry(p, e!.id);
    expect(after.leftOut![0]).toMatchObject({ outcome: "not-allowed" });
    expect(after.leftOut![0]!.tries).toBeUndefined(); // nothing was tried
    expect(after.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.notAllowed);
    // nothing was sent, so no send was audited
    expect((await auditOf(p)).events.some((x) => x.details?.op === LOOK_SEND_OP)).toBe(false);
  });

  it("(4) a locked project: nothing is sent and nothing is written", async () => {
    const p = await project(true);
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    await repo.lockProject(p.id);
    sent = [];
    now += 16 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    const snap = await snapshot(lib.root);
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "locked" });
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "locked" });
    expect(await dueLookUps(repo, p.id, new Date(now))).toEqual([]);
    expect(sent).toEqual([]);
    expect(await snapshot(lib.root)).toEqual(snap);
  });

  it("(5) nothing is sent before the time kept on the entry: automatic — not due; the researcher — \"not yet\", with the time", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    const notBefore = new Date(now + MIN).toISOString();
    expect(e!.leftOut![0]!.notBefore).toBe(notBefore);
    sent = [];
    now += 30_000;
    answers["api.openalex.org"] = () => SEARCH;
    const snap = await snapshot(lib.root);
    expect(await dueLookUps(repo, p.id, new Date(now))).toEqual([]);
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "not-due" });
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "not-yet", notBefore });
    // A fresh client (as after the library is closed and opened again: the in-memory hold is gone) — the time kept on the
    // entry still holds (R411, R563 M4).
    const fresh = client();
    expect(fresh.heldUntil("api.openalex.org")).toBeUndefined();
    expect(await lookUpAgain(repo, fresh, p.id, e!.id, { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "not-yet", notBefore });
    expect(await lookUpAgain(repo, fresh, p.id, e!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "not-due" });
    expect(sent).toEqual([]);
    expect(await snapshot(lib.root)).toEqual(snap);
  });

  it("a closing session, or an entry that is not there: refused before anything is sent", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 30 * MIN;
    const ctl = new AbortController();
    ctl.abort();
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", closing: ctl.signal, now: new Date(now) })).toEqual({ done: false, why: "closing" });
    expect(await lookUpAgain(repo, http, p.id, "no-such-entry", { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "not-found" });
    expect(to("api.openalex.org")).toBe(1);
  });
});

describe("the automatic pass: due, bounded, growing waits; the hold (R411, R566 5)", () => {
  it("(6) a second \"asked to wait\" sets the hold: the next entry sends nothing to that host; tries grow; the fifth automatic try ends \"gave-up\"", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [a, b] = await attached(p, http, [notesPdf(), notesPdf("Market days in the northern valleys")]);
    expect(to("api.openalex.org")).toBe(1);
    // Not due before 15 minutes after the attach, though the service's own time (60 s) has passed.
    now += 14 * MIN;
    expect(await dueLookUps(repo, p.id, new Date(now))).toEqual([]);
    now += MIN;
    expect(await dueLookUps(repo, p.id, new Date(now))).toEqual([
      { entryId: a!.id, sourceId: a!.sourceId },
      { entryId: b!.id, sourceId: b!.sourceId },
    ]);

    const ra = await lookUpAgain(repo, http, p.id, a!.id, { by: "automatic", now: new Date(now) });
    expect(ra).toMatchObject({ done: true, asked: 1, state: { state: "waiting", tries: 1 } });
    expect(to("api.openalex.org")).toBe(2);
    const ea = await entry(p, a!.id);
    expect(ea.leftOut![0]).toMatchObject({ tries: 1, lastTriedAt: new Date(now).toISOString(), notBefore: new Date(now + MIN).toISOString() });
    expect(ea.leftOut![0]!.outcome).toBeUndefined();
    expect(ea.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    // The next entry is due by its own record, but the service asked to wait again: nothing is sent to it.
    expect(await lookUpAgain(repo, http, p.id, b!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "not-due" });
    expect(await lookUpAgain(repo, http, p.id, b!.id, { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "not-yet", notBefore: new Date(now + MIN).toISOString() });
    expect(to("api.openalex.org")).toBe(2);
    expect((await entry(p, b!.id)).leftOut![0]!.tries).toBeUndefined();

    // The growing waits: 1, 4 and 12 hours after tries 1, 2 and 3; then 24 hours; the fifth try ends it.
    const waits = LOOK_UP_AGAIN_BOUNDS.waitsMs;
    for (let k = 1; k < LOOK_UP_AGAIN_BOUNDS.maxAutomaticTries; k++) {
      now += waits[k]! - MIN;
      expect((await dueLookUps(repo, p.id, new Date(now))).map((d) => d.entryId)).not.toContain(a!.id);
      now += MIN;
      expect((await dueLookUps(repo, p.id, new Date(now))).map((d) => d.entryId)).toContain(a!.id);
      const r = await lookUpAgain(repo, http, p.id, a!.id, { by: "automatic", now: new Date(now) });
      expect(r).toMatchObject({ done: true, asked: 1 });
      expect(to("api.openalex.org")).toBe(2 + k);
    }
    const end = await entry(p, a!.id);
    expect(end.leftOut![0]).toMatchObject({ tries: 5, outcome: "gave-up" });
    expect(end.reasons[0]).toBe(lookUpGaveUpText(5));
    now += 48 * 60 * MIN;
    expect((await dueLookUps(repo, p.id, new Date(now))).map((d) => d.entryId)).not.toContain(a!.id);
    expect(await lookUpAgain(repo, http, p.id, a!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "not-due" });
    // The researcher can still look it up again.
    answers["api.openalex.org"] = () => SEARCH;
    expect(await lookUpAgain(repo, http, p.id, a!.id, { by: "researcher", now: new Date(now) })).toMatchObject({ done: true, state: { state: "found" } });
    expect((await entry(p, a!.id)).reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.found);
  });

  it("a lookup that failed outright is not taken by the automatic pass, but is by the researcher's act (R577 iv)", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => ({ statusCode: 500, data: "broken" });
    const [e] = await attached(p, http, [notesPdf()]);
    expect(e!.leftOut).toEqual([{ services: ["openalex"], title: TITLE, creator: "Souza", why: "failed" }]);
    sent = [];
    now += 48 * 60 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    expect(await dueLookUps(repo, p.id, new Date(now))).toEqual([]);
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "not-due" });
    expect(sent).toEqual([]);
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    expect(r).toMatchObject({ done: true, asked: 1, found: 2, state: { state: "found" } });
    expect(sent).toHaveLength(1);
    const after = await entry(p, e!.id);
    // R585 M3: a researcher's press is not counted in tries; it moves the last try's time
    expect(after.leftOut![0]).toMatchObject({ why: "failed", lastTriedAt: new Date(now).toISOString(), outcome: "found" });
    expect(after.leftOut![0]!.tries).toBeUndefined();
    expect(after.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.found);
  });

  it("a failed lookup that fails again stays failed (the researcher's press moves its last try, not its tries, R585 M3); the entry never reads \"Waiting…\"", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => ({ statusCode: 500, data: "broken" });
    const [e] = await attached(p, http, [notesPdf()]);
    const pressed = new Date(now); // the client's back-off waits move the test's clock after this
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: pressed });
    expect(r).toMatchObject({ done: true, asked: 1, found: 0, state: { state: "failed", tries: 0 } });
    const after = await entry(p, e!.id);
    expect(after.leftOut![0]).toMatchObject({ why: "failed", lastTriedAt: pressed.toISOString() });
    expect(after.leftOut![0]!.tries).toBeUndefined();
    expect(after.leftOut![0]!.outcome).toBeUndefined();
    expect(after.reasons).not.toContain(LOOKUP_WAITING_TEXT);
    expect(after.reasons).toEqual(e!.reasons);
  });
});

describe("closing, audit and sealing (R247 c, R546, R566 6, R55)", () => {
  it("(7) the library closing in mid-lookup: nothing written — byte for byte after close() and after everything settled; the send's audit line stands alone", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 2 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    const ctl = new AbortController();
    const hold = holdRequests(http, "before");
    const run = lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", closing: ctl.signal, now: new Date(now) });
    await hold.atGate; // the send was audited; the request is about to go
    ctl.abort();
    http.stop();
    await lib.close();
    const atClose = await snapshot(lib.root);
    hold.release();
    expect(await run).toEqual({ done: false, why: "cancelled" });
    expect(await snapshot(lib.root)).toEqual(atClose);
    expect(to("api.openalex.org")).toBe(1); // the attach's only
    const { events } = await auditOf(p);
    const last = events[events.length - 1]!;
    expect(last.details).toEqual({ op: LOOK_SEND_OP, reviewEntry: e!.id, by: "researcher", services: ["openalex"], lookups: 1 });
    expect(last).toMatchObject({ action: "process", entity: { type: "source", id: e!.sourceId }, decision: { result: "allow" } });
    expect(events.some((x) => x.details?.op === LOOK_UP_AGAIN_OP)).toBe(false);
  });

  it("(9) the audit lines hold ids, service names and counts only: neither the title nor the identifier is in the audit file's bytes", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [buildDoiPdf()]);
    const titles = e!.leftOut!.map((l) => l.title).filter((t): t is string => !!t);
    now += 16 * MIN;
    // R585 M6: each request, as it arrives, finds its service's send line already on disk.
    const onDisk: string[][] = [];
    answers["api.crossref.org"] = () => {
      onDisk.push(sendLinesNow(p).map((x) => (x.details!.services as string[]).join()));
      return { statusCode: 200, data: fixture("crossref-work.json") };
    };
    answers["api.openalex.org"] = () => {
      onDisk.push(sendLinesNow(p).map((x) => (x.details!.services as string[]).join()));
      return SEARCH;
    };
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) });
    expect(r).toMatchObject({ done: true });
    expect(onDisk).toEqual([["crossref"], ["crossref", "openalex"]]);
    const { events, bytes } = await auditOf(p);
    expect(bytes).not.toContain(FIXTURE_DOI);
    expect(bytes.toLowerCase()).not.toContain(FIXTURE_DOI.toLowerCase());
    for (const t of titles) expect(bytes).not.toContain(t);
    expect(bytes).not.toContain("Rivers and Memory");
    const send = events.filter((x) => x.details?.op === LOOK_SEND_OP);
    const write = events.filter((x) => x.details?.op === LOOK_UP_AGAIN_OP);
    // R585 M8: one send line PER SERVICE asked (Crossref for the DOI, OpenAlex for the title search), each with its name.
    expect(send).toHaveLength(2);
    expect(write).toHaveLength(1);
    for (const x of send) expect(x.seq).toBeLessThan(write[0]!.seq);
    for (const x of send) expect(Object.keys(x.details!).sort()).toEqual(["by", "lookups", "op", "reviewEntry", "services"]);
    expect(send.map((x) => x.details!.services)).toEqual([["crossref"], ["openalex"]]);
    const { txn: _t, changes: _c, ...rest } = write[0]!.details as Record<string, unknown>;
    expect(Object.keys(rest).sort()).toEqual(["by", "candidatesAdded", "lookups", "op", "reviewEntry", "sent", "state"]); // R585 M2: `sent`
    expect(rest.sent).toBe(2);
    expect(write[0]!.entity).toEqual({ type: "source", id: e!.sourceId });
  });

  it("an encrypted project's entry stays sealed on disk with the new fields", async () => {
    const p = await project(true);
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 2 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    expect(r).toMatchObject({ done: true, state: { state: "found" } });
    const raw = await readFile(reviewPath(p), "utf8");
    for (const word of [TITLE, "Rivers and Memory", "lastTriedAt", "outcome", "openalex", "found", LOOK_UP_AGAIN_TEXT.found]) expect(raw).not.toContain(word);
    const after = await entry(p, e!.id); // opened with the project's key
    expect(after.leftOut![0]).toMatchObject({ lastTriedAt: new Date(now).toISOString(), outcome: "found" });
    expect(after.candidates).toHaveLength(2);
  });
});

describe("the provider filter is the call's own (R566 5)", () => {
  it("lookupDoi with only [openalex] does not ask Crossref; without it the chain is as before", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => ({ statusCode: 200, data: fixture("crossref-work.json") });
    answers["api.openalex.org"] = () => ({ statusCode: 200, data: fixture("openalex-work.json") });
    const ctx = await lookupContextFor(repo, p.id, http);
    const a = await lookupDoi(FIXTURE_DOI, ctx, { only: ["openalex"] });
    expect(a?.provider).toBe("openalex");
    expect([to("api.crossref.org"), to("api.openalex.org")]).toEqual([0, 1]);
    const b = await lookupDoi("10.5555/another", ctx);
    expect(b?.provider).toBe("crossref");
    expect(to("api.crossref.org")).toBe(1);
  });
});

describe("decision 31 (c), R585: each left-out lookup is known by its PLACE in leftOut (I2)", () => {
  it("P-N: Crossref asked to wait and OpenAlex failed for the file's DOI; OpenAlex then asks to wait; Crossref then finds the DOI — its \"found\" stands, the OpenAlex lookup appears once, the entry does not read \"Waiting…\"", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => ({ statusCode: 500, data: "broken" });
    const [e] = await attached(p, http, [buildDoiPdf()]);
    const doi = `doi:${FIXTURE_DOI}`;
    expect(e!.leftOut!.map((l) => [l.services, l.identifier ?? "title", l.why ?? "asked-to-wait"])).toEqual([
      [["crossref"], doi, "asked-to-wait"],
      [["openalex"], doi, "failed"],
      [["openalex"], "title", "failed"],
    ]);
    // First look-up, by hand: both services ask to wait. The failed DOI lookup becomes one that waits — beside, not over,
    // the Crossref one with the same identifier.
    now += 2 * MIN;
    answers["api.openalex.org"] = () => WAIT_60;
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) })).toMatchObject({ done: true });
    const mid = await entry(p, e!.id);
    expect(mid.leftOut).toHaveLength(3);
    expect(mid.leftOut!.map((l) => [l.services, l.identifier ?? "title"])).toEqual([
      [["crossref"], doi],
      [["openalex"], doi],
      [["openalex"], "title"],
    ]);
    // Second look-up, by hand: Crossref finds the DOI; OpenAlex knows nothing of either.
    now += 2 * MIN;
    answers["api.crossref.org"] = () => ({ statusCode: 200, data: fixture("crossref-work.json") });
    answers["api.openalex.org"] = (path) => (path.includes("search") ? NO_RESULTS : { statusCode: 404, data: "{}" });
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    expect(r).toMatchObject({ done: true, found: 1, state: { state: "found", fromFile: true } });
    const end = await entry(p, e!.id);
    expect(end.leftOut).toHaveLength(3);
    expect(end.leftOut![0]).toMatchObject({ services: ["crossref"], identifier: doi, outcome: "found" });
    expect(end.leftOut![1]).toMatchObject({ services: ["openalex"], identifier: doi, outcome: "nothing" });
    expect(end.leftOut![2]).toMatchObject({ services: ["openalex"], title: "Rivers and Memory in Upland Villages", outcome: "nothing" });
    expect(end.reasons.slice(0, 2)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile]);
    expect(end.reasons).not.toContain(LOOKUP_WAITING_TEXT);
  });
});

describe("decision 31 (c), R585 I1: two look-ups of one entry", () => {
  it("P-B, with the in-process guard: while the automatic look-up of an entry is under way, the researcher's act answers \"under-way\" at once — nothing audited, sent or written; the first then writes its own result", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 16 * MIN;
    const hold = holdRequests(http, "after");
    const runB = lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) });
    await hold.atGate; // B was answered "wait"; its write is held
    const sentBefore = sent.length;
    const auditBefore = (await auditOf(p)).bytes;
    const reviewBefore = await readFile(reviewPath(p));
    answers["api.openalex.org"] = () => SEARCH;
    expect(await lookUpAgain(repo, client(), p.id, e!.id, { by: "researcher", now: new Date(now + 2 * MIN) })).toEqual({ done: false, why: "under-way" });
    expect(sent.length).toBe(sentBefore);
    expect((await auditOf(p)).bytes).toBe(auditBefore);
    expect(await readFile(reviewPath(p))).toEqual(reviewBefore);
    hold.release();
    expect(await runB).toMatchObject({ done: true, state: { state: "waiting" } });
    // Once it is over, the entry can be looked up again.
    now += 30 * MIN;
    expect(await lookUpAgain(repo, client(), p.id, e!.id, { by: "researcher", now: new Date(now) })).toMatchObject({ done: true, state: { state: "found" } });
  });

  it("P-A: two look-ups of one entry at once — ONE send audit line, ONE request", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 16 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    sent = [];
    const [r1, r2] = await Promise.all([
      lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) }),
      lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) }),
    ]);
    expect([r1, r2].filter((r) => r.done)).toHaveLength(1);
    expect([r1, r2].filter((r) => !r.done)).toEqual([{ done: false, why: "under-way" }]);
    expect(sent).toHaveLength(1);
    const { events } = await auditOf(p);
    expect(events.filter((x) => x.details?.op === LOOK_SEND_OP)).toHaveLength(1);
    expect(events.filter((x) => x.details?.op === LOOK_UP_AGAIN_OP)).toHaveLength(1);
  });

  it("(a) without the guard (two handles of the library): the slower look-up's result is worked out against the entry as re-read — a \"found\" written meanwhile stands, no time moves back, matches are appended once", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    const repo2 = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(now), tz: "UTC" });
    now += 16 * MIN;
    const tB = new Date(now);
    const hold = holdRequests(http, "after");
    const runB = lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: tB });
    await hold.atGate; // B was answered "wait"; its write is held
    answers["api.openalex.org"] = () => SEARCH;
    now += 2 * MIN;
    const tA = new Date(now);
    const ra = await lookUpAgain(repo2, client(), p.id, e!.id, { by: "researcher", now: tA });
    expect(ra).toMatchObject({ done: true, found: 2, state: { state: "found" } });
    hold.release();
    expect(await runB).toMatchObject({ done: true, state: { state: "found" } });
    const end = await entry(p, e!.id);
    expect(end.leftOut).toHaveLength(1);
    expect(end.leftOut![0]).toMatchObject({ outcome: "found", lastTriedAt: tA.toISOString() });
    expect(end.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.found);
    expect(end.reasons).not.toContain(LOOKUP_WAITING_TEXT);
    expect(end.candidates).toHaveLength(2);
  });

  it("FR-758 (two handles): the look-up that really sent is the slower to write; the other answered from the cache wrote first — the time of the last real try is kept", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    expect((await entry(p, e!.id)).leftOut![0]!.lastTriedAt).toBeUndefined();
    const repo2 = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(now), tz: "UTC" });
    now += 16 * MIN;
    answers["api.openalex.org"] = () => SEARCH;
    // Only the first call is held once answered (B's): the second handle's call is served from the client's cache.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    const orig = http.getJson.bind(http) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    (http as unknown as { getJson: (...a: unknown[]) => Promise<unknown> }).getJson = async (...a: unknown[]) => {
      if (++calls > 1) return orig(...a);
      const v = await orig(...a);
      reached();
      await gate;
      return v;
    };
    const tB = new Date(now);
    const runB = lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: tB });
    await atGate; // B's request left and was answered; its write is held
    now += 2 * MIN;
    const sentBefore = sent.length;
    const ra = await lookUpAgain(repo2, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    expect(ra).toMatchObject({ done: true, sent: 0, state: { state: "found" } });
    expect(sent.length).toBe(sentBefore);
    release();
    expect(await runB).toMatchObject({ done: true, sent: 1, state: { state: "found" } });
    const end = await entry(p, e!.id);
    expect(end.leftOut![0]).toMatchObject({ outcome: "found", lastTriedAt: tB.toISOString() });
  });
});

describe("decision 31 (c), R585 M8: the send is audited per service, through the unchanged authorizeOnly", () => {
  it("two services asked: two send lines, each on disk BEFORE its own service's request leaves, each with that service's own decision", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [buildDoiPdf()]);
    now += 16 * MIN;
    sent = [];
    const seen: Record<string, string[][]> = { crossref: [], openalex: [] };
    answers["api.crossref.org"] = () => {
      seen.crossref!.push(sendLinesNow(p).map((x) => (x.details!.services as string[]).join()));
      return { statusCode: 404, data: "{}" };
    };
    answers["api.openalex.org"] = (path) => {
      seen.openalex!.push(sendLinesNow(p).map((x) => (x.details!.services as string[]).join()));
      return path.includes("search") ? NO_RESULTS : { statusCode: 404, data: "{}" };
    };
    const r = await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) });
    expect(r).toMatchObject({ done: true, services: ["crossref", "openalex"] });
    expect([to("api.crossref.org"), to("api.openalex.org")]).toEqual([1, 2]);
    expect(seen.crossref).toEqual([["crossref"]]); // its own line was there before its request
    expect(seen.openalex![0]).toEqual(["crossref", "openalex"]); // and OpenAlex's before OpenAlex's first
    const lines = (await auditOf(p)).events.filter((x) => x.details?.op === LOOK_SEND_OP);
    expect(lines.map((x) => x.details)).toEqual([
      { op: LOOK_SEND_OP, reviewEntry: e!.id, by: "automatic", services: ["crossref"], lookups: 1 },
      { op: LOOK_SEND_OP, reviewEntry: e!.id, by: "automatic", services: ["openalex"], lookups: 2 },
    ]);
    for (const x of lines) expect(x).toMatchObject({ action: "process", entity: { type: "source", id: e!.sourceId }, decision: { result: "allow" } });
  });

  it("a service the rules deny when its send is authorised: it is not asked and its lookups get \"not-allowed\"; one allowed send line, one request", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [buildDoiPdf()]);
    now += 16 * MIN;
    sent = [];
    answers["api.crossref.org"] = () => ({ statusCode: 404, data: "{}" });
    answers["api.openalex.org"] = () => SEARCH;
    const hold = holdRequests(http, "after");
    const run = lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
    await hold.atGate; // Crossref has answered; the project's rules now allow Crossref only
    const g = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, `${GOV}processing:\n  metadata_lookup: [crossref]\n`, { baseSha256: g.sha256 });
    hold.release();
    const r = await run;
    expect(r).toMatchObject({ done: true, services: ["crossref"], notAllowed: 2, state: { state: "not-allowed" } });
    expect(sent).toHaveLength(1);
    expect(to("api.crossref.org")).toBe(1);
    const lines = (await auditOf(p)).events.filter((x) => x.details?.op === LOOK_SEND_OP);
    expect(lines.filter((x) => x.decision?.result === "allow").map((x) => x.details!.services)).toEqual([["crossref"]]);
    // the deny is audited as any denied act is (once: the service is not asked again in this look-up)
    expect(lines.filter((x) => x.decision?.result === "deny")).toHaveLength(1);
    const end = await entry(p, e!.id);
    expect(end.leftOut!.map((l) => l.outcome)).toEqual(["not-allowed", "not-allowed"]);
    expect(end.leftOut![0]!.services).toEqual(["openalex"]); // the service still to be asked; Crossref answered
  });
});

describe("decision 31 (c), R585 M2: what was really sent", () => {
  it("P-H: five automatic look-ups whose request the client's hold left out (another call was told to wait between the send's audit and the request): no try is counted, never \"gave-up\"; each outcome line says sent: 0", async () => {
    const p = await project();
    const http = client();
    const raw = http.getJson.bind(http);
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 16 * MIN;
    for (let k = 0; k < 6; k++) {
      sent = [];
      const hold = holdRequests(http, "before");
      const run = lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) });
      await hold.atGate; // the send is audited; before the request goes another call is told to wait
      await expect(raw(`https://api.openalex.org/works?search=other${k}`, { cacheKey: `other${k}`, sensitive: false, askedToWait: "leave-out" })).rejects.toThrow();
      expect(sent).toHaveLength(1); // that other call's request
      hold.release();
      expect(await run).toMatchObject({ done: true, sent: 0, state: { state: "waiting" } });
      expect(sent).toHaveLength(1); // the look-up's own request never left
      now += 2 * MIN;
    }
    const end = await entry(p, e!.id);
    expect(end.leftOut![0]!.tries).toBeUndefined();
    expect(end.leftOut![0]!.lastTriedAt).toBeUndefined();
    expect(end.leftOut![0]!.outcome).toBeUndefined();
    expect(end.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    const outcomes = (await auditOf(p)).events.filter((x) => x.details?.op === LOOK_UP_AGAIN_OP);
    expect(outcomes).toHaveLength(6);
    for (const x of outcomes) expect(x.details).toMatchObject({ sent: 0, state: "waiting" });
  });

  it("a request that left is counted: the outcome line says how many left (sent), and the try is counted", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 16 * MIN;
    answers["api.openalex.org"] = () => NO_RESULTS;
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "automatic", now: new Date(now) })).toMatchObject({ done: true, sent: 1, state: { state: "nothing" } });
    expect((await entry(p, e!.id)).leftOut![0]).toMatchObject({ tries: 1, lastTriedAt: new Date(now).toISOString(), outcome: "nothing" });
    const [line] = (await auditOf(p)).events.filter((x) => x.details?.op === LOOK_UP_AGAIN_OP);
    expect(line!.details).toMatchObject({ sent: 1 });
  });
});

describe("decision 31 (c), R585 M1: a kept time only a wrong clock could have written counts as passed", () => {
  const FAR = "2031-01-01T00:00:00.000Z";
  it("P-D: notBefore and lastTriedAt in 2031 — the researcher's act sends; the automatic pass takes it; with notBefore mended and lastTriedAt still in 2031, the automatic pass still takes it", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [a, b, c] = await attached(p, http, [notesPdf(), notesPdf("Market days in the northern valleys"), notesPdf("Harvest songs of the delta")]);
    for (const e of [a!, b!]) await patch(p, e, { leftOut: [{ ...e.leftOut![0]!, notBefore: FAR, lastTriedAt: FAR, tries: 1 }] });
    await patch(p, c!, { leftOut: [{ ...c!.leftOut![0]!, notBefore: new Date(now).toISOString(), lastTriedAt: FAR, tries: 1 }] });
    now += 61 * MIN; // past the wait after one try (an hour, counted from the attach: the 2031 try is not kept)
    answers["api.openalex.org"] = () => NO_RESULTS;
    // 1. by hand
    expect(await lookUpAgain(repo, client(), p.id, a!.id, { by: "researcher", now: new Date(now) })).toMatchObject({ done: true, sent: 1, state: { state: "nothing" } });
    // 2. automatic (and listed as due)
    expect((await dueLookUps(repo, p.id, new Date(now))).map((d) => d.entryId)).toEqual([b!.id, c!.id]);
    expect(await lookUpAgain(repo, client(), p.id, b!.id, { by: "automatic", now: new Date(now) })).toMatchObject({ done: true, sent: 1 });
    // 3. notBefore mended, lastTriedAt still in 2031: due all the same
    expect(await lookUpAgain(repo, client(), p.id, c!.id, { by: "automatic", now: new Date(now) })).toMatchObject({ done: true, sent: 1 });
    // the times written are today's, not 2031's (a time never moves back — but a wrong one is not kept)
    expect((await entry(p, c!.id)).leftOut![0]!.lastTriedAt).toBe(new Date(now).toISOString());
  });

  it("every real wait is unchanged (R411): a notBefore less than an hour ahead holds, by hand and automatically", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    now += 16 * MIN;
    const nb = new Date(now + 59 * MIN).toISOString();
    await patch(p, e!, { leftOut: [{ ...e!.leftOut![0]!, notBefore: nb }] });
    sent = [];
    expect(await lookUpAgain(repo, client(), p.id, e!.id, { by: "researcher", now: new Date(now) })).toEqual({ done: false, why: "not-yet", notBefore: nb });
    expect(await lookUpAgain(repo, client(), p.id, e!.id, { by: "automatic", now: new Date(now) })).toEqual({ done: false, why: "not-due" });
    expect(sent).toEqual([]);
  });

  it("lookUpNow (for the service and the page) agrees with lookUpAgain's own answer for the researcher, over a table of entries", async () => {
    const p = await project();
    const T = now + 16 * MIN;
    const iso = (d: number) => new Date(T + d).toISOString();
    const w = (title: string, extra: Partial<LeftOutLookup> = {}): LeftOutLookup => ({ services: ["openalex"], title, creator: "Souza", notBefore: iso(30_000), ...extra });
    const rows: Array<[string, (t: string) => LeftOutLookup[], { canLookUpNow: boolean; notBefore?: string }]> = [
      ["waiting", (t) => [w(t)], { canLookUpNow: false, notBefore: iso(30_000) }],
      ["due", (t) => [w(t, { notBefore: iso(-MIN) })], { canLookUpNow: true }],
      ["wrong clock ahead", (t) => [w(t, { notBefore: FAR, lastTriedAt: FAR })], { canLookUpNow: true }],
      ["less than an hour ahead", (t) => [w(t, { notBefore: iso(59 * MIN) })], { canLookUpNow: false, notBefore: iso(59 * MIN) }],
      ["failed", (t) => [{ services: ["openalex"], title: t, why: "failed" }], { canLookUpNow: true }],
      ["mixed: waiting and found", (t) => [w(t), w(`${t} b`, { outcome: "found" })], { canLookUpNow: false, notBefore: iso(30_000) }],
      ["mixed: failed and waiting", (t) => [{ services: ["openalex"], title: t, why: "failed" }, w(`${t} b`)], { canLookUpNow: true }],
      ["two waiting: the earliest", (t) => [w(t, { notBefore: iso(10 * MIN) }), w(`${t} b`)], { canLookUpNow: false, notBefore: iso(30_000) }],
      ["gave up, its time passed", (t) => [w(t, { notBefore: iso(-MIN), tries: 5, outcome: "gave-up" })], { canLookUpNow: true }],
      ["nothing left", (t) => [w(t, { outcome: "found" }), w(`${t} b`, { outcome: "nothing" })], { canLookUpNow: false }],
    ];
    answers["api.openalex.org"] = () => WAIT_60;
    const made = await attached(p, client(), rows.map((_, i) => notesPdf(`Field notes number ${i}`)));
    for (const [i, [, left]] of rows.entries()) await patch(p, made[i]!, { leftOut: left(`Field notes number ${i}`) });
    now = T;
    answers["api.openalex.org"] = () => NO_RESULTS;
    for (const [i, [name, , expected]] of rows.entries()) {
      const e = await entry(p, made[i]!.id);
      const said = lookUpNow(e, new Date(now));
      expect(said, name).toEqual(expected);
      const r = await lookUpAgain(repo, client(), p.id, e.id, { by: "researcher", now: new Date(now) });
      if (said.canLookUpNow) expect(r.done, name).toBe(true);
      else expect(r, name).toEqual(said.notBefore ? { done: false, why: "not-yet", notBefore: said.notBefore } : { done: false, why: "nothing-to-look-up" });
    }
  });
});

describe("decision 31 (c), R585 M3: the sentences in mixes; only the app's own automatic tries count toward giving up", () => {
  it("P-K: Crossref finds the file's DOI while the title search is told to wait: found, the warning about the file's identifier, and waiting — each once", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [buildDoiPdf()]);
    now += 16 * MIN;
    answers["api.crossref.org"] = () => ({ statusCode: 200, data: fixture("crossref-work.json") });
    const r = await lookUpAgain(repo, client(), p.id, e!.id, { by: "automatic", now: new Date(now) });
    expect(r).toMatchObject({ done: true, found: 1, state: { state: "waiting", fromFile: true } });
    const end = await entry(p, e!.id);
    expect(end.reasons.slice(0, 3)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, LOOKUP_WAITING_TEXT]);
    for (const s of [LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, LOOKUP_WAITING_TEXT]) expect(end.reasons.filter((x) => x === s)).toHaveLength(1);
  });

  it("P-M: five presses of the researcher, each told to wait, never end \"gave-up\" and are not counted in tries; they move lastTriedAt and notBefore", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    for (let k = 0; k < 6; k++) {
      now += 2 * MIN;
      expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) })).toMatchObject({ done: true, sent: 1, state: { state: "waiting" } });
      const l = (await entry(p, e!.id)).leftOut![0]!;
      expect(l.tries).toBeUndefined();
      expect(l.outcome).toBeUndefined();
      expect(l).toMatchObject({ lastTriedAt: new Date(now).toISOString(), notBefore: new Date(now + MIN).toISOString() });
    }
    expect((await entry(p, e!.id)).reasons[0]).toBe(LOOKUP_WAITING_TEXT);
  });

  it("after the app gave up, a researcher's press told to wait leaves it \"gave-up\" (the automatic pass does not take it again) with the app's own tries", async () => {
    const p = await project();
    const http = client();
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [notesPdf()]);
    await patch(p, e!, { leftOut: [{ ...e!.leftOut![0]!, tries: 5, outcome: "gave-up" }] });
    now += 2 * MIN;
    expect(await lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) })).toMatchObject({ done: true, state: { state: "gave-up", tries: 5 } });
    expect((await entry(p, e!.id)).reasons[0]).toBe(lookUpGaveUpText(5));
  });
});

describe("decision 31 (c), R585 M6: only the part of a chain that was left out is asked", () => {
  it("a DOI lookup of which only OpenAlex was left out (Crossref had answered): the look-up asks OpenAlex alone; Crossref receives 0 requests", async () => {
    const p = await project();
    const http = client();
    answers["api.crossref.org"] = () => WAIT_60;
    answers["api.openalex.org"] = () => WAIT_60;
    const [e] = await attached(p, http, [buildDoiPdf()]);
    // Only part of the chain left out, as an attach writes it when Crossref answered and OpenAlex asked to wait. (Set by
    // hand: a Crossref answer at the attach would sit in the lookup cache and hide a request made in error.)
    const at = e!.leftOut!.findIndex((l) => l.identifier);
    await patch(p, e!, { leftOut: e!.leftOut!.map((l, i) => (i === at ? { ...l, services: ["openalex"] } : l)) });
    now += 16 * MIN;
    sent = [];
    answers["api.crossref.org"] = () => ({ statusCode: 200, data: fixture("crossref-work.json") });
    answers["api.openalex.org"] = (path) => (path.includes("search") ? NO_RESULTS : { statusCode: 200, data: fixture("openalex-work.json") });
    // a fresh client (as after reopening): Crossref's earlier answer is not in its memory, so a request would show
    const r = await lookUpAgain(repo, client(), p.id, e!.id, { by: "automatic", now: new Date(now) });
    expect(r).toMatchObject({ done: true, services: ["openalex"] });
    expect(to("api.crossref.org")).toBe(0);
    expect(sent.filter((s) => s.startsWith("api.openalex.org/works/doi"))).toHaveLength(1);
  });
});

describe("decision 31 (c), R593 m2: a service the rules deny at send time is KEPT in a lookup that met a wait or a failure", () => {
  for (const [name, first] of [
    ["asks to wait (429)", WAIT_60],
    ["fails outright (500)", { statusCode: 500, data: "broken" } as Answer],
  ] as const) {
    it(`Crossref ${name}, then the rules deny OpenAlex before its send: the DOI lookup still names both services; once the rules allow OpenAlex again, a later look-up asks it`, async () => {
      const p = await project();
      const http = client();
      answers["api.crossref.org"] = () => WAIT_60;
      answers["api.openalex.org"] = () => WAIT_60;
      const [e] = await attached(p, http, [buildDoiPdf()]);
      const at = e!.leftOut!.findIndex((l) => l.identifier);
      expect(e!.leftOut![at]!.services).toEqual(["crossref", "openalex"]);
      now += 16 * MIN;
      answers["api.crossref.org"] = () => first;
      answers["api.openalex.org"] = () => SEARCH;
      const hold = holdRequests(http, "after");
      const run = lookUpAgain(repo, http, p.id, e!.id, { by: "researcher", now: new Date(now) });
      await hold.atGate; // Crossref has answered; before OpenAlex's send is authorised the rules deny OpenAlex
      const g = await repo.getGovernance(p.id);
      await repo.setGovernance(p.id, `${GOV}processing:\n  metadata_lookup: [crossref]\n`, { baseSha256: g.sha256 });
      hold.release();
      const r = await run;
      expect(r).toMatchObject({ done: true, services: ["crossref"] });
      const mid = await entry(p, e!.id);
      const doi = mid.leftOut![at]!;
      expect(doi.services).toEqual(["crossref", "openalex"]);
      expect(doi.outcome).toBeUndefined();
      if (first === WAIT_60) expect(doi.notBefore).toBeDefined();
      else expect(doi.why).toBe("failed");
      // The state and sentences: the title search (OpenAlex only) is "not-allowed"; the DOI lookup waits (429) or has failed.
      const view = (r as { state: unknown }).state;
      if (first === WAIT_60) {
        expect(view).toMatchObject({ state: "waiting", also: ["not-allowed"] });
        expect(mid.reasons.slice(0, 2)).toEqual([LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT.notAllowed]);
      } else {
        expect(view).toMatchObject({ state: "not-allowed" });
        expect(mid.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.notAllowed);
      }
      // The rules allow OpenAlex again: a later look-up asks it for the DOI.
      const g2 = await repo.getGovernance(p.id);
      await repo.setGovernance(p.id, GOV, { baseSha256: g2.sha256, reason: "test: OpenAlex allowed again" });
      now += 30 * MIN;
      sent = [];
      answers["api.crossref.org"] = () => ({ statusCode: 404, data: "{}" });
      answers["api.openalex.org"] = (path) => (path.includes("search") ? NO_RESULTS : { statusCode: 200, data: fixture("openalex-work.json") });
      const r2 = await lookUpAgain(repo, client(), p.id, e!.id, { by: "researcher", now: new Date(now) });
      expect(r2).toMatchObject({ done: true });
      expect(sent.filter((s) => s.startsWith("api.openalex.org/works/doi"))).toHaveLength(1);
      expect((await entry(p, e!.id)).leftOut![at]!.outcome).toBe("found");
    });
  }
});
