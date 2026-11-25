/**
 * Decision 31 (b), R556 (2): an attach, and a watched folder's bringing-in, do not wait for a metadata service that asks
 * to wait (429, or 503 with a wait asked). That service is left out for the file; the file is stored at once with what
 * the other services and the file itself say, as "needs review" with the owner's sentence LOOKUP_WAITING_TEXT, and the
 * review entry keeps what was left out (`leftOut`) for a later "look up again". R55 holds: an identifier found in the file
 * and not confirmed is never on the record; it stays a hint on the review entry. The service is not asked again before
 * the time it named (R411): the next files leave it out without asking it.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { newId } from "@ao/core";
import { LOOKUP_WAITING_TEXT, lookUpGaveUpText } from "@ao/shared";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_DOI, buildDoiPdf, buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import { REVIEW_FILE, parseReviewFile, type LeftOutLookup, type ReviewEntry } from "../repo/review.js";
import { appendCandidates, lookUpStateOf, reasonsWithLookUpState } from "./look-up-state.js";
import { importChange, projectDataKey, type Repo } from "../repo/repo.js";
import { openLine } from "../repo/io.js";
import { storeRequest } from "../repo/sources.js";
import { KeyNotAvailableError } from "../crypto/format.js";
import { openTestRepo } from "../repo/testing.js";
import { ATTACH_REASONS, createAttach } from "./attach.js";
import { watchFolder, type WatchEvent } from "./watch.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lookup");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;
const W = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100, watchEvents: false, rescanMs: 200 } as const;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let agent: MockAgent;
let now: number;
let sleeps: number[];
let sent: string[];

const deps = (): Deps => ({
  clock: () => new Date(),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

/** The client as the service makes it (default retries and caps), on a clock that only the waits move. */
const client = () =>
  new HttpClient({
    libraryRoot: lib.root,
    dispatcher: agent,
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
/** Time waited other than the per-host throttle's short gaps (at most a second between two requests to one host). */
const longWaits = () => sleeps.filter((ms) => ms >= 1000);

type Answer = { statusCode: number; data?: string; headers?: Record<string, string> };
function answering(origin: string, answer: (path: string) => Answer): void {
  agent
    .get(origin)
    .intercept({ path: () => true, method: "GET" })
    .reply((req) => {
      sent.push(`${new URL(origin).hostname}${req.path}`);
      const a = answer(req.path);
      return { statusCode: a.statusCode, data: a.data ?? "", responseOptions: { headers: { "content-type": "application/json", ...(a.headers ?? {}) } } };
    })
    .persist();
}
const WAIT_60: Answer = { statusCode: 429, data: "slow down", headers: { "retry-after": "60" } };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-attach-wait-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
  agent = new MockAgent();
  agent.disableNetConnect();
  now = Date.parse("2026-11-24T15:00:00Z");
  sleeps = [];
  sent = [];
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

async function project() {
  return (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } })).project;
}
async function put(name: string, data: Buffer): Promise<string> {
  const p = join(tmp, "Desktop", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
  return p;
}
const notesPdf = (title = "Notes from the tide-line interviews") => buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] });
/**
 * The older build's reader of a review file, copied line for line from commit 2d12ab1,
 * `packages/library/src/repo/review.ts` lines 463-479 (`parseReviewFile`; `git show 2d12ab1:packages/library/src/repo/review.ts
 * | sed -n '455,485p'`): each line opened with the project's key when there is one (`openLine(key, projectId, line,
 * PURPOSE)`, PURPOSE = "ao-review" at its line 23), JSON.parse, then the one check `typeof e.id === "string" &&
 * e.projectId === projectId`; a wiped key is rethrown, any other failure skips the line; the newest line per id wins.
 * Nothing else is checked and no field is removed. `openLine` is this build's own: `packages/library/src/repo/io.ts` and
 * `src/crypto` are unchanged since 2d12ab1 (`git diff 2d12ab1 HEAD -- packages/library/src/repo/io.ts
 * packages/library/src/crypto` is empty). Only the types differ (the entry is kept as a plain record).
 */
function olderParse(text: string, projectId: string, key: Uint8Array | null = null): { entries: Array<Record<string, unknown>>; skipped: number } {
  const byId = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const json = key ? openLine(key, projectId, line, "ao-review") : line;
      const e = JSON.parse(json) as Record<string, unknown>;
      if (typeof e?.id !== "string" || e.projectId !== projectId) throw new Error("not a review entry of this project");
      byId.set(e.id as string, e);
    } catch (err) {
      if (err instanceof KeyNotAvailableError) throw err; // a wiped key: locked, not a skipped line (R386 a)
      skipped++;
    }
  }
  return { entries: [...byId.values()], skipped };
}

async function reviewEntries(p: { id: string; folder: string }): Promise<ReviewEntry[]> {
  const text = await readFile(join(lib.root, p.folder, ...REVIEW_FILE.split("/")), "utf8").catch(() => "");
  return parseReviewFile(text, p.id, null).entries;
}

describe("an attach does not wait for a service that asks to wait (decision 31 b, R556 2)", () => {
  it("the owner's sentence is declared once, word for word", () => {
    expect(LOOKUP_WAITING_TEXT).toBe("Waiting for lookup service response.");
  });

  it("a PDF whose only service answers 429 / Retry-After 60 is stored at once, needs review, with the owner's sentence", async () => {
    const p = await project();
    answering("https://api.openalex.org", () => WAIT_60);
    const path = await put("tide-line-notes.pdf", await notesPdf());
    const attach = createAttach({ repo, http: client() });
    const [o] = await attach.attachFiles(p.id, [path]);
    expect(o).toMatchObject({ path, outcome: "needs-review", reason: LOOKUP_WAITING_TEXT });
    expect(longWaits()).toEqual([]);
    expect(sent).toHaveLength(1); // the title search, asked once
    const sf = await repo.getSource(p.id, o!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Notes from the tide-line interviews"); // what the file says
    const [e] = await reviewEntries(p);
    expect(e).toMatchObject({ kind: "import", sourceId: o!.sourceId, status: "pending" });
    expect(e!.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    expect(e!.leftOut).toEqual([
      { services: ["openalex"], title: "Notes from the tide-line interviews", creator: "Souza", notBefore: new Date(Date.parse("2026-11-24T15:00:00Z") + 60_000).toISOString() },
    ]);
  });

  it("a PDF with a DOI whose services all ask to wait: stored at once; the DOI is NOT on the record (R55), only a hint, and kept as left out", async () => {
    const p = await project();
    answering("https://api.crossref.org", () => WAIT_60);
    answering("https://api.openalex.org", () => WAIT_60);
    const path = await put("doi-article.pdf", await buildDoiPdf());
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [path]);
    expect(o).toMatchObject({ outcome: "needs-review", reason: LOOKUP_WAITING_TEXT });
    expect(longWaits()).toEqual([]);
    expect(sent.filter((s) => s.startsWith("api.crossref.org"))).toHaveLength(1);
    expect(sent.filter((s) => s.startsWith("api.openalex.org"))).toHaveLength(1);
    const sf = await repo.getSource(p.id, o!.sourceId!);
    expect(sf.source.identifiers.doi).toBeUndefined();
    expect(JSON.stringify(sf)).not.toContain(FIXTURE_DOI);
    const [e] = await reviewEntries(p);
    expect(e!.hints).toEqual([`doi:${FIXTURE_DOI}`]);
    expect(e!.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    expect(e!.leftOut?.[0]).toMatchObject({ services: ["crossref", "openalex"], identifier: `doi:${FIXTURE_DOI}` });
  });

  it("Crossref asks to wait, OpenAlex answers: OpenAlex's record is used and nothing is shown as waiting", async () => {
    const p = await project();
    answering("https://api.crossref.org", () => WAIT_60);
    answering("https://api.openalex.org", () => ({ statusCode: 200, data: fixture("openalex-work.json") }));
    const path = await put("doi-article.pdf", await buildDoiPdf());
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [path]);
    expect(longWaits()).toEqual([]);
    expect(o).toMatchObject({ outcome: "created" });
    expect(o!.reason).toBeUndefined();
    const sf = await repo.getSource(p.id, o!.sourceId!);
    expect(sf.source.identifiers.doi).toBe(FIXTURE_DOI);
    expect(sf.fieldEvidence.some((x) => x.field === "/title" && x.source.kind === "lookup" && x.source.provider === "openalex")).toBe(true);
    expect(await reviewEntries(p)).toEqual([]);
  });

  it("a record in review for another reason, with nothing left out, keeps today's sentence", async () => {
    const p = await project();
    answering("https://api.openalex.org", () => ({ statusCode: 200, data: JSON.stringify({ results: [] }) }));
    const path = await put("tide-line-notes.pdf", await notesPdf());
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [path]);
    expect(o).toMatchObject({ outcome: "needs-review", reason: ATTACH_REASONS.review });
    const [e] = await reviewEntries(p);
    expect(e!.reasons).not.toContain(LOOKUP_WAITING_TEXT);
    expect(e!.leftOut).toBeUndefined();
  });

  it("decision 31 (c), R577 iv: a lookup that fails outright is kept with why \"failed\" (no time to wait for) and the entry does NOT read \"Waiting…\"", async () => {
    const p = await project();
    answering("https://api.openalex.org", () => ({ statusCode: 500, data: "broken" }));
    const path = await put("tide-line-notes.pdf", await notesPdf());
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [path]);
    expect(o).toMatchObject({ outcome: "needs-review", reason: ATTACH_REASONS.review });
    const [e] = await reviewEntries(p);
    expect(e!.reasons).not.toContain(LOOKUP_WAITING_TEXT);
    expect(e!.leftOut).toEqual([{ services: ["openalex"], title: "Notes from the tide-line interviews", creator: "Souza", why: "failed" }]);
  });

  it("decision 31 (c): a DOI from the file whose Crossref asks to wait and whose OpenAlex fails outright — each kept for what it is; the DOI stays a hint only (R55)", async () => {
    const p = await project();
    answering("https://api.crossref.org", () => WAIT_60);
    answering("https://api.openalex.org", () => ({ statusCode: 500, data: "broken" }));
    const path = await put("doi-article.pdf", await buildDoiPdf());
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [path]);
    expect(o).toMatchObject({ outcome: "needs-review", reason: LOOKUP_WAITING_TEXT });
    const sf = await repo.getSource(p.id, o!.sourceId!);
    expect(JSON.stringify(sf)).not.toContain(FIXTURE_DOI);
    const [e] = await reviewEntries(p);
    expect(e!.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    expect(e!.leftOut).toEqual([
      { services: ["crossref"], identifier: `doi:${FIXTURE_DOI}`, notBefore: new Date(Date.parse("2026-11-24T15:00:00Z") + 60_000).toISOString() },
      { services: ["openalex"], identifier: `doi:${FIXTURE_DOI}`, why: "failed" },
      // the title search that followed failed outright too (the project allows title searches)
      { services: ["openalex"], title: "Rivers and Memory in Upland Villages", creator: "Okafor", why: "failed" },
    ]);
  });

  it("three files attached together: no waits add up, and the service is asked once (not again before the time it named)", async () => {
    const p = await project();
    answering("https://api.openalex.org", () => WAIT_60);
    const paths = [
      await put("a.pdf", await notesPdf("Notes from the tide-line interviews")),
      await put("b.pdf", await notesPdf("Market days in the northern valleys")),
      await put("c.pdf", await notesPdf("Letters about the river crossing")),
    ];
    const out = await createAttach({ repo, http: client() }).attachFiles(p.id, paths);
    expect(out.map((o) => [o.outcome, o.reason])).toEqual(paths.map(() => ["needs-review", LOOKUP_WAITING_TEXT]));
    expect(longWaits()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(3);
  });

  it("after the time named the service is asked again for the next file", async () => {
    const p = await project();
    let n = 0;
    answering("https://api.openalex.org", () => (++n === 1 ? WAIT_60 : { statusCode: 200, data: JSON.stringify({ results: [] }) }));
    const http = client();
    const attach = createAttach({ repo, http });
    await attach.attachFiles(p.id, [await put("a.pdf", await notesPdf("Notes from the tide-line interviews"))]);
    expect(sent).toHaveLength(1);
    now += 60_000;
    const [o] = await attach.attachFiles(p.id, [await put("b.pdf", await notesPdf("Market days in the northern valleys"))]);
    expect(sent.length).toBeGreaterThan(1);
    expect(o).toMatchObject({ outcome: "needs-review", reason: ATTACH_REASONS.review });
  });

  it("a watched folder's file the same: stored at once, the sentence on its event, its register line as for any stored file", async () => {
    const p = await project();
    answering("https://api.openalex.org", () => WAIT_60);
    const wid = newId();
    const inbox = join(tmp, "Inbox");
    await mkdir(inbox);
    const events: WatchEvent[] = [];
    const w = watchFolder({ repo, http: client(), lib, onEvent: (e) => events.push(e), ...W }, p.id, inbox, {}, wid);
    try {
      await w.ready;
      await writeFile(join(inbox, "tide-line-notes.pdf"), await notesPdf());
      const end = Date.now() + 20_000;
      while (!events.some((e) => e.kind === "imported") || (await repo.watchRegister(p.id, wid)).get("tide-line-notes.pdf")?.state !== "in-library") {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      await w.stop();
    }
    const ev = events.find((e) => e.kind === "imported")!;
    expect(ev).toMatchObject({ file: "tide-line-notes.pdf", outcome: "needs-review", reason: LOOKUP_WAITING_TEXT });
    expect((await repo.watchRegister(p.id, wid)).get("tide-line-notes.pdf")).toMatchObject({ state: "in-library", sourceId: ev.sourceId });
    expect(longWaits()).toEqual([]);
    expect(sent).toHaveLength(1);
    const [e] = await reviewEntries(p);
    expect(e!.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    expect(e!.leftOut?.length).toBeGreaterThan(0);
  }, 60_000);

  it("R556 (2) iv: the entry is read by the build of main at 2d12ab1 — its kind and every value it checks are ones that build knows; the new field is kept when it rewrites the entry", async () => {
    const p = await project();
    answering("https://api.openalex.org", () => WAIT_60);
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [await put("tide-line-notes.pdf", await notesPdf())]);
    const raw = (await readFile(join(lib.root, p.folder, ...REVIEW_FILE.split("/")), "utf8")).split("\n").filter(Boolean);
    expect(raw).toHaveLength(1);
    const { entries, skipped } = olderParse(raw.join("\n"), p.id);
    expect(skipped).toBe(0);
    const e = entries[0]!;
    // The values the older build branches on are ones it knows (2d12ab1 review.ts:65-101; shared review.ts reviewGroup).
    expect(e.kind).toBe("import");
    expect(e.status).toBe("pending");
    expect(e.batchId).toBeUndefined(); // listed in the group "attach", as any attached file
    expect(e.cause).toBeUndefined();
    expect(e.method).toBe("embedded");
    expect((e.reasons as unknown[]).every((r) => typeof r === "string")).toBe(true);
    expect((e.reasons as string[])[0]).toBe(LOOKUP_WAITING_TEXT); // shown by that build too: its queue lists the reasons as text
    // The older build's rewrites of an import entry spread it (2d12ab1 import/bulk/review.ts:214, bulk/undo.ts:106,109,332;
    // repo/review.ts:330): the field it does not know is kept in the line it appends.
    const resolved = JSON.parse(JSON.stringify({ ...e, status: "resolved", resolvedAt: "2026-11-25T09:00:00.000Z", decision: "accept" }));
    expect(resolved.leftOut).toEqual(e.leftOut);
    expect(olderParse([...raw, JSON.stringify(resolved)].join("\n"), p.id).entries).toEqual([resolved]);
    expect(e.sourceId).toBe(o!.sourceId);

    // Decision 31 (c), R566 (7): a later line of the same entry, as "Look up again" writes it — every new optional field on
    // the `leftOut` items (`why`, `tries`, `lastTriedAt`, `outcome`), a failed lookup kept, candidates APPENDED and the
    // state's sentence in the reasons — is read by that build, with the same kind, status and values it branches on.
    const match = { title: "Notes from the tide-line interviews", creators: [{ role: "author" as const, family: "Souza", given: "Ana" }], type: "article-journal" as const, identifiers: { doi: "10.1/tide" }, provider: "openalex" };
    const before = (e.candidates as unknown[] | undefined) ?? [];
    const later = {
      ...e,
      candidates: appendCandidates(before, [match]),
      leftOut: [
        ...(e.leftOut as LeftOutLookup[]).map((l) => ({ ...l, why: "asked-to-wait", tries: 1, lastTriedAt: "2026-11-24T15:20:00.000Z", outcome: "found" })),
        { services: ["crossref"], identifier: "doi:10.1/other", why: "failed", tries: 2, lastTriedAt: "2026-11-24T15:30:00.000Z" },
      ],
      reasons: reasonsWithLookUpState(e.reasons as string[], { state: "found", tries: 1, fromFile: false }),
    };
    const read = olderParse([...raw, JSON.stringify(later)].join("\n"), p.id);
    expect(read.skipped).toBe(0);
    const l = read.entries[0]!;
    expect(l).toEqual(JSON.parse(JSON.stringify(later)));
    expect([l.kind, l.status, l.batchId, l.cause, l.method]).toEqual(["import", "pending", undefined, undefined, "embedded"]);
    expect((l.reasons as unknown[]).every((x) => typeof x === "string")).toBe(true);
    // 2d12ab1 import/bulk/review.ts:153-155,177-179: accept-candidate takes `entry.candidates[index]` of the newest line —
    // every candidate it could accept before is at the same position; the new one is after them.
    const cands = l.candidates as unknown[];
    before.forEach((c, i) => expect(cands[i]).toEqual(c));
    expect(cands[before.length]).toEqual(match);
    // Its rewrite of the entry (a decision) spreads it: every new field is kept.
    const decided = JSON.parse(JSON.stringify({ ...l, status: "resolved", resolvedAt: "2026-11-25T09:00:00.000Z", decision: "accept-candidate" }));
    expect(olderParse([...raw, JSON.stringify(later), JSON.stringify(decided)].join("\n"), p.id).entries).toEqual([decided]);
    expect(decided.leftOut).toEqual(JSON.parse(JSON.stringify(later.leftOut)));
  });

  it("R585 M7: an entry the app GAVE UP on, in an encrypted project — its SEALED lines are read by 2d12ab1's reader with the project's key; the values it branches on are ones it knows; a decision keeps every new field", async () => {
    const p = (await repo.createProject({ name: `E${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: true, passphrase: "correct horse battery staple" } })).project;
    answering("https://api.openalex.org", () => WAIT_60);
    const [o] = await createAttach({ repo, http: client() }).attachFiles(p.id, [await put("sealed-notes.pdf", await notesPdf("Harvest songs of the delta"))]);
    const k = projectDataKey(repo, p.id)!.key;
    const file = join(lib.root, p.folder, ...REVIEW_FILE.split("/"));
    const [e] = parseReviewFile(await readFile(file, "utf8"), p.id, k).entries;
    expect(e!.sourceId).toBe(o!.sourceId);
    // A later line as "Look up again" writes it once the app has given up (five automatic tries told to wait), through
    // the same governed, sealing write.
    const leftOut: LeftOutLookup[] = e!.leftOut!.map((l) => ({ ...l, tries: 5, lastTriedAt: "2026-11-26T10:00:00.000Z", notBefore: "2026-11-26T10:01:00.000Z", outcome: "gave-up" }));
    const later: ReviewEntry = { ...e!, leftOut, reasons: reasonsWithLookUpState(e!.reasons, lookUpStateOf({ leftOut })!) };
    expect(later.reasons[0]).toBe(lookUpGaveUpText(5));
    const sf = await repo.getSource(p.id, e!.sourceId!);
    await importChange(repo, p.id, storeRequest(sf.source.provenance), async (ops) => ops.updateReview(later), { op: "test.later-line" });
    const raw = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(raw).toHaveLength(2);
    for (const line of raw) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(["alg", "ct", "keyId", "nonce", "v"]); // sealed
      for (const word of ["Harvest songs", "gave-up", "lastTriedAt", "openalex", lookUpGaveUpText(5)]) expect(line).not.toContain(word);
    }
    // Without the key the older build reads nothing of it (a locked project: as for any sealed line).
    expect(olderParse(raw.join("\n"), p.id, null)).toEqual({ entries: [], skipped: 2 });
    const read = olderParse(raw.join("\n"), p.id, k);
    expect(read.skipped).toBe(0);
    const l = read.entries[0]!;
    expect(l).toEqual(JSON.parse(JSON.stringify(later)));
    expect([l.kind, l.status, l.batchId, l.cause, l.method]).toEqual(["import", "pending", undefined, undefined, "embedded"]);
    expect((l.reasons as unknown[]).every((x) => typeof x === "string")).toBe(true);
    expect((l.reasons as string[])[0]).toBe(lookUpGaveUpText(5));
    // Its decision spreads the entry (2d12ab1 import/bulk/review.ts:214): the given-up lookups are kept.
    const decided = JSON.parse(JSON.stringify({ ...l, status: "resolved", resolvedAt: "2026-11-27T09:00:00.000Z", decision: "keep-both" }));
    expect(decided.leftOut).toEqual(JSON.parse(JSON.stringify(leftOut)));
  });
});
