import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REQUIRED_FIELDS, type AuditEvent, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { IndexHandle } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, type Library } from "../library.js";
import { PolicyDeniedError, type Repo } from "../repo/index.js";
import { decryptBytes } from "../repo/io.js";
import { openTestRepo } from "../repo/testing.js";
import { WorkerClient, devWorkerPython, startWorker } from "../worker-client.js";
import { AcknowledgementRequiredError, COOKIES_ACKNOWLEDGEMENT, plainReason } from "./errors.js";
import { createLinkCapture, type LinkCapture } from "./link-capture.js";
import { classifyUrl } from "./platforms.js";
import { stripSnapshot } from "./snapshot.js";
import { FAKE_TOOLS_DIR, startToolWorker, type ToolWorker } from "./testing.js";

const FAST = 2 ** 10;
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [downloader, manual_upload]
`;
const ENC_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
captureMethods: [downloader]
`;
const NO_DOWNLOADER_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;
const YT = "https://www.youtube.com/watch?v=aoTest00001&si=trackme&utm_source=share";
const YT_CONFLICT = "https://youtu.be/aoTest00002";
const IG = "https://www.instagram.com/p/CfAkEcArO01/?igsh=abcdef";
const TT = "https://www.tiktok.com/@fake.dancer/video/7000000000000000001?is_from_webapp=1";
const LOGIN_SENTENCE = "This post needs a signed-in session. Try again with 'Use my browser session'.";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let worker: ToolWorker;
let client: WorkerClient;
let capture: LinkCapture;
const savedEnv = { PATH: process.env.PATH, FAKE_TOOL_MODE: process.env.FAKE_TOOL_MODE, FAKE_ARGV_FILE: process.env.FAKE_ARGV_FILE };
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

async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, projectFolder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

async function project(gov = GOV, encrypted = false) {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } });
  return project;
}

const fileOf = (sf: SourceFile, kind: string) => sf.assets.filter((a) => a.kind === kind);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-capture-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  process.env.PATH = `${FAKE_TOOLS_DIR}${delimiter}${savedEnv.PATH ?? ""}`;
  delete process.env.FAKE_TOOL_MODE;
  delete process.env.FAKE_ARGV_FILE;
  worker = await startToolWorker();
  client = new WorkerClient({ repo, worker, index: { db: handle.db }, pollMs: 5 });
  capture = createLinkCapture({ repo, worker: client, index: handle });
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await worker.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("classifyUrl", () => {
  const cases: Array<[string, ReturnType<typeof classifyUrl>]> = [
    ["https://www.youtube.com/watch?v=aoTest00001&si=abc&utm_source=x&feature=share", { platform: "youtube", kind: "video", canonicalUrl: "https://www.youtube.com/watch?v=aoTest00001", postId: "aoTest00001" }],
    ["https://m.youtube.com/watch?v=aoTest00001&list=PLfake123&index=2", { platform: "youtube", kind: "video", canonicalUrl: "https://www.youtube.com/watch?v=aoTest00001&list=PLfake123", postId: "aoTest00001" }],
    ["https://youtu.be/aoTest00001?si=xyz", { platform: "youtube", kind: "video", canonicalUrl: "https://www.youtube.com/watch?v=aoTest00001", postId: "aoTest00001" }],
    ["https://www.youtube.com/shorts/aoShort0001?feature=share", { platform: "youtube", kind: "short", canonicalUrl: "https://www.youtube.com/shorts/aoShort0001", postId: "aoShort0001" }],
    ["https://www.youtube.com/playlist?list=PLfake123&si=x", { platform: "youtube", kind: "playlist", canonicalUrl: "https://www.youtube.com/playlist?list=PLfake123" }],
    ["https://www.youtube.com/@amatest_fake/videos", { platform: "youtube", kind: "profile", canonicalUrl: "https://www.youtube.com/@amatest_fake", handle: "@amatest_fake" }],
    ["https://www.youtube.com/channel/UCfakeChannel000000000001", { platform: "youtube", kind: "profile", canonicalUrl: "https://www.youtube.com/channel/UCfakeChannel000000000001" }],
    ["https://www.instagram.com/p/CfAkEcArO01/?igsh=abcdef", { platform: "instagram", kind: "post", canonicalUrl: "https://www.instagram.com/p/CfAkEcArO01/", postId: "CfAkEcArO01" }],
    ["https://instagram.com/reel/CrEeL000001", { platform: "instagram", kind: "reel", canonicalUrl: "https://www.instagram.com/reel/CrEeL000001/", postId: "CrEeL000001" }],
    ["https://www.instagram.com/reels/CrEeL000001/?igsh=x", { platform: "instagram", kind: "reel", canonicalUrl: "https://www.instagram.com/reel/CrEeL000001/", postId: "CrEeL000001" }],
    ["https://www.instagram.com/stories/highlights/17900000000000001/", { platform: "instagram", kind: "story-highlight", canonicalUrl: "https://www.instagram.com/stories/highlights/17900000000000001/", postId: "17900000000000001" }],
    ["https://www.instagram.com/fake_photographer/?hl=en", { platform: "instagram", kind: "profile", canonicalUrl: "https://www.instagram.com/fake_photographer/", handle: "fake_photographer" }],
    ["https://www.tiktok.com/@fake.dancer/video/7000000000000000001?is_from_webapp=1&sender_device=pc", { platform: "tiktok", kind: "video", canonicalUrl: "https://www.tiktok.com/@fake.dancer/video/7000000000000000001", postId: "7000000000000000001", handle: "@fake.dancer" }],
    ["https://www.tiktok.com/@fake.dancer", { platform: "tiktok", kind: "profile", canonicalUrl: "https://www.tiktok.com/@fake.dancer", handle: "@fake.dancer" }],
    ["https://vm.tiktok.com/ZMfake123/", { platform: "tiktok", kind: "unknown", canonicalUrl: "https://vm.tiktok.com/ZMfake123/" }],
    ["https://example.org/page?utm_source=x&id=5&fbclid=abc#frag", { platform: "other", kind: "unknown", canonicalUrl: "https://example.org/page?id=5" }],
    ["not a url", { platform: "other", kind: "unknown", canonicalUrl: "not a url" }],
  ];
  it.each(cases)("%s", (url, expected) => {
    expect(classifyUrl(url)).toEqual(expected);
  });
});

describe("stripSnapshot", () => {
  it("drops formats, http_headers, requested_*, cookies, local paths and any cookie/token/auth/header key, recursively", () => {
    const s = stripSnapshot({
      id: "x", title: "t", formats: [], http_headers: {}, requested_formats: [], requested_downloads: [], cookies: "c",
      _filename: "/home/a/b", filepath: "/home/a/b", nested: { csrf_token: "t", Authorization: "a", ok: 1, list: [{ set_cookie: "x", keep: 2 }] },
    });
    expect(s).toEqual({ id: "x", title: "t", nested: { ok: 1, list: [{ keep: 2 }] } });
  });
});

describe("captureUrl", () => {
  it("captures a YouTube video: media, info JSON, thumbnail, platform captions, transcript, downloader provenance, verified fields", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, YT, { transcribe: true, transcribeModel: "tiny" });
    expect(out).toMatchObject({ url: YT, status: "created" });
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.type).toBe("video");
    expect(sf.source.title.variants).toEqual([{ lang: "en", kind: "original", value: "Market day in Kumasi: a walk through the stalls" }]);
    expect(sf.source.creators).toEqual([{ literal: "Ama Test Channel", role: "channel", handle: "@amatest_fake" }]);
    expect(sf.source.issued).toBe("2020-11-09");
    expect(sf.source.identifiers).toEqual({ platform: "youtube", platformPostId: "aoTest00001", url: "https://www.youtube.com/watch?v=aoTest00001" });

    const originals = sf.assets.filter((a) => a.role === "original");
    expect(originals.map((a) => a.kind).sort()).toEqual(["platform-metadata", "thumbnail", "video"]);
    expect(base(fileOf(sf, "video")[0]!.path)).toMatch(/\.mp4$/);
    const captions = fileOf(sf, "platform-captions");
    expect(captions).toHaveLength(1);
    expect(base(captions[0]!.path)).toMatch(/ - platform-captions - en - platform - modified .*\.vtt$/);
    expect(captions[0]!.derivation).toMatchObject({ provider: "platform", parents: [fileOf(sf, "video")[0]!.id] });
    const transcripts = fileOf(sf, "transcript");
    const vtt = transcripts.find((a) => a.path.endsWith(".vtt"))!;
    const json = transcripts.find((a) => a.path.endsWith(".json"))!;
    expect(base(vtt.path)).toMatch(/ - transcript - en - whisper-tiny - modified \d{4}-\d{2}-\d{2} \d{4}\.vtt$/);
    expect(base(json.path)).toBe(base(vtt.path).replace(/\.vtt$/, ".json"));
    expect(vtt.metadata?.flaggedSegments).toBe(1);
    expect(json.metadata?.flaggedSegments).toBe(1);
    expect(vtt.derivation).toMatchObject({ operation: "transcribe", model: "tiny", ranAt: "local", parents: [fileOf(sf, "video")[0]!.id] });

    const prov = sf.source.provenance;
    expect(prov.captureMethod).toBe("downloader");
    expect(prov.tool).toEqual({ name: "yt-dlp", version: "2026.10.22" });
    expect(prov.originalUrl).toBe("https://www.youtube.com/watch?v=aoTest00001");
    for (const a of originals) expect(prov.fileHashes[a.id]).toBe(a.sha256);
    for (const f of REQUIRED_FIELDS.video) expect([f, sf.verification[f]?.status]).toEqual([f, "verified"]);
    expect(sf.fieldEvidence.find((e) => e.field === "/issued")).toMatchObject({ source: { kind: "platform-json", ref: "/timestamp" } });

    // the worker got the canonical URL, never the tracking parameters
    const dl = worker.submitted.find((j) => j.type === "capture.download")!;
    expect(dl.input).toBe("https://www.youtube.com/watch?v=aoTest00001");
    expect(dl.params).toMatchObject({ tool: "yt-dlp" });
    // exactly one audited capture decision
    expect((await auditEvents(p.folder)).filter((e) => e.action === "capture")).toHaveLength(1);
    // the work folder is gone
    expect((await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => n.startsWith("capture-") || n.startsWith("worker-"))).toEqual([]);
  });

  it("stores the platform snapshot without http_headers, cookies, formats or tokens", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, YT, { transcribe: false });
    const sf = await repo.getSource(p.id, out.sourceId!);
    const snap = sf.source.provenance.platformSnapshot as Record<string, unknown>;
    for (const k of ["http_headers", "cookies", "formats", "requested_formats", "requested_downloads", "requested_subtitles", "_filename", "filepath"]) expect(snap).not.toHaveProperty(k);
    expect(snap.player).toEqual({ client: "web" });
    const meta = fileOf(sf, "platform-metadata")[0]!;
    const text = await readFile(join(lib.root, meta.path), "utf8");
    expect(JSON.parse(text)).toMatchObject({ id: "aoTest00001", title: "Market day in Kumasi: a walk through the stalls" });
    for (const secret of ["fake-secret-cookie", "SECRET", "fake-visitor-token", "Bearer", "/home/someone"]) expect(text).not.toContain(secret);
    expect(JSON.stringify(sf)).not.toContain("fake-secret-cookie");
  });

  it("a second capture of the same post is a duplicate; with refreshIfExists it adds a dated snapshot", async () => {
    const p = await project();
    const first = await capture.captureUrl(p.id, YT, { transcribe: false });
    const jobs = worker.submitted.length;
    const again = await capture.captureUrl(p.id, "https://youtu.be/aoTest00001", { transcribe: false });
    expect(again).toMatchObject({ status: "duplicate", sourceId: first.sourceId });
    expect(worker.submitted.length).toBe(jobs); // known post id: nothing downloaded
    expect(repo.listSourceIds(p.id)).toHaveLength(1);

    const refreshed = await capture.captureUrl(p.id, YT, { transcribe: false, refreshIfExists: true });
    expect(refreshed).toMatchObject({ status: "refreshed", sourceId: first.sourceId });
    expect(worker.submitted.at(-1)!.params).toMatchObject({ metadataOnly: true });
    const sf = await repo.getSource(p.id, first.sourceId!);
    const snaps = fileOf(sf, "platform-metadata");
    expect(snaps).toHaveLength(2);
    expect(snaps.every((a) => a.role === "original" && typeof a.metadata?.capturedAt === "string")).toBe(true);
    expect(base(snaps[1]!.path)).toMatch(/platform-metadata \d{4}-\d{2}-\d{2} \d{4}\.json$/);
    expect(fileOf(sf, "video")).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  });

  it("finds duplicates without an index by reading the project's sources", async () => {
    const p = await project();
    const first = await capture.captureUrl(p.id, YT, { transcribe: false });
    const noIndex = createLinkCapture({ repo, worker: client });
    expect(await noIndex.captureUrl(p.id, YT, { transcribe: false })).toMatchObject({ status: "duplicate", sourceId: first.sourceId });
  });

  it("captures an Instagram carousel with gallery-dl as one source with three image originals", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, IG, { transcribe: "project-default" });
    expect(out.status).toBe("created");
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.type).toBe("social-post");
    expect(fileOf(sf, "image")).toHaveLength(3);
    expect(fileOf(sf, "platform-metadata")).toHaveLength(1);
    expect(sf.source.provenance.tool).toEqual({ name: "gallery-dl", version: "1.30.10" });
    expect(sf.source.title.variants[0]).toEqual({ lang: "und", kind: "original", value: "Three views of the synthetic river market" });
    expect(sf.source.creators).toEqual([{ literal: "Fake Photographer", role: "uploader", handle: "fake_photographer" }]);
    expect(sf.source.identifiers).toMatchObject({ platform: "instagram", platformPostId: "CfAkEcArO01", url: "https://www.instagram.com/p/CfAkEcArO01/" });
    for (const f of REQUIRED_FIELDS["social-post"]) expect([f, sf.verification[f]?.status]).toEqual([f, "verified"]);
    expect(worker.submitted.find((j) => j.type === "capture.download")!.params).toMatchObject({ tool: "gallery-dl" });
    expect(worker.submitted.some((j) => j.type === "audio.transcribe")).toBe(false); // project default: off
  });

  it("titles a TikTok from the caption's first line; an invalid language tag becomes und", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, TT, { transcribe: false });
    expect(out.status).toBe("created");
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.type).toBe("video");
    expect(sf.source.title.variants[0]).toEqual({ lang: "und", kind: "original", value: "Learning the river dance #fyp" });
    expect(sf.source.creators).toEqual([{ literal: "Fake Dancer", role: "uploader", handle: "fake.dancer" }]);
    for (const f of REQUIRED_FIELDS.video) expect([f, sf.verification[f]?.status]).toEqual([f, "verified"]);
  });

  it("a login wall fails with the plain-language reason and saves nothing", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "login";
    const out = await capture.captureUrl(p.id, YT, { transcribe: false });
    expect(out).toEqual({ url: YT, status: "failed", errorCode: "LOGIN_REQUIRED", reason: LOGIN_SENTENCE });
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a partial download (media saved, then an error) creates an incomplete source", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "partial";
    const out = await capture.captureUrl(p.id, YT, { transcribe: false });
    expect(out).toMatchObject({ status: "incomplete", errorCode: "RATE_LIMITED" });
    expect(out.reason).toMatch(/^Only part of this post was saved\./);
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.availability).toMatchObject({ status: "incomplete", reason: out.reason });
    expect(fileOf(sf, "video")).toHaveLength(1);
  });

  it("using the browser session needs the one-time acknowledgement, which is recorded and audited", async () => {
    const p = await project();
    const argv = join(tmp, "argv.json");
    process.env.FAKE_ARGV_FILE = argv;
    const err = await capture.captureUrl(p.id, YT, { transcribe: false, cookiesFromBrowser: "firefox" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcknowledgementRequiredError);
    expect((err as AcknowledgementRequiredError).explanation).toBe(
      "Using your browser's signed-in session lets the downloader see what you can see. Platforms may restrict or suspend accounts they detect using automated tools. This choice is recorded in the project's audit log.",
    );
    expect(COOKIES_ACKNOWLEDGEMENT).toBe((err as AcknowledgementRequiredError).explanation);
    expect(worker.submitted).toEqual([]);

    await repo.acknowledge(p.id, "cookies");
    expect(repo.getProject(p.id).captureAcknowledgements?.cookies).toMatchObject({ by: "tester" });
    const out = await capture.captureUrl(p.id, YT, { transcribe: false, cookiesFromBrowser: "firefox" });
    expect(out.status).toBe("created");
    expect(JSON.parse(await readFile(argv, "utf8"))).toEqual(expect.arrayContaining(["--cookies-from-browser", "firefox"]));
    const ack = (await auditEvents(p.folder)).filter((e) => e.details?.op === "project.acknowledge.cookies");
    expect(ack).toHaveLength(1);
    expect(ack[0]!.entity).toEqual({ type: "project", id: p.id });
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.provenance.legal.status).toBe("unknown"); // seen through a signed-in session
  });

  it("a project without the downloader capture method denies (PolicyDeniedError, audited once, nothing downloaded)", async () => {
    const p = await project(NO_DOWNLOADER_GOV);
    await expect(capture.captureUrl(p.id, YT, { transcribe: false })).rejects.toBeInstanceOf(PolicyDeniedError);
    const deny = (await auditEvents(p.folder)).filter((e) => e.decision?.result === "deny");
    expect(deny).toHaveLength(1);
    expect(deny[0]!.action).toBe("capture");
    expect(worker.submitted).toEqual([]);
  });

  it("an upload_date that disagrees with the timestamp needs review: /issued conflict, review file and index row", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, YT_CONFLICT, { transcribe: false });
    expect(out.status).toBe("needs-review");
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.verification["/issued"]!.status).toBe("conflict");
    expect(sf.source.provenance.identification?.confidence).toBeLessThanOrEqual(0.6);
    const lines = (await readFile(join(lib.root, p.folder, "review", "pending.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { id: string; sourceId: string; status: string; fields: Record<string, string>; reasons: string[] };
    expect(entry).toMatchObject({ sourceId: out.sourceId, status: "pending", kind: "verification", fields: { "/issued": "conflict" } });
    const rows = () => handle.db.prepare("SELECT id, source_id, kind, status FROM review_items").all();
    expect(rows()).toEqual([{ id: entry.id, source_id: out.sourceId, kind: "verification", status: "pending" }]);

    // the file is the record: a rebuild restores the row from it
    handle.db.prepare("DELETE FROM review_items").run();
    await rebuildIndex(handle, ring, lib);
    expect(rows()).toEqual([{ id: entry.id, source_id: out.sourceId, kind: "verification", status: "pending" }]);
  });

  it("an encrypted project gets encrypted files and a sealed review file; the index row has no reasons", async () => {
    const p = await project(ENC_GOV, true);
    const out = await capture.captureUrl(p.id, YT_CONFLICT, { transcribe: true, transcribeModel: "tiny" });
    expect(out.status).toBe("needs-review");
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.assets.length).toBeGreaterThan(3);
    for (const a of sf.assets) {
      expect(a.encrypted).toBe(true);
      const raw = await readFile(join(lib.root, a.path));
      expect(raw.includes(Buffer.from("aoTest00002"))).toBe(false);
      const plain = await decryptBytes((id) => ring.get(id), raw);
      expect(createHash("sha256").update(plain).digest("hex")).toBe(a.sha256);
    }
    const text = await readFile(join(lib.root, p.folder, "review", "pending.jsonl"), "utf8");
    for (const s of ["Harvest", "Ama Test", "issued", out.sourceId!]) expect(text).not.toContain(s);
    const row = handle.db.prepare("SELECT payload_json FROM review_items").get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toEqual({ fields: { "/issued": "conflict" } });
    // locked: the sealed file cannot be read, so a rebuild keeps the row it had
    repo.lockProject(p.id);
    await rebuildIndex(handle, ring, lib);
    expect(handle.db.prepare("SELECT source_id FROM review_items").all()).toEqual([{ source_id: out.sourceId }]);
    // unlocked: rebuilt from the file
    await repo.unlockProject(p.id, "pw");
    handle.db.prepare("DELETE FROM review_items").run();
    await rebuildIndex(handle, ring, lib);
    expect(handle.db.prepare("SELECT source_id, payload_json FROM review_items").all()).toEqual([{ source_id: out.sourceId, payload_json: JSON.stringify({ fields: { "/issued": "conflict" } }) }]);
  });

  it("profile and playlist links are handed to captureProfile when given, else fail plainly", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, "https://www.youtube.com/@amatest_fake", { transcribe: false });
    expect(out).toMatchObject({ status: "failed", errorCode: "PROFILE_CAPTURE_UNAVAILABLE" });
    const seen: string[] = [];
    const withProfile = createLinkCapture({
      repo, worker: client, index: handle,
      captureProfile: async (_pid, url) => {
        seen.push(url);
        return { url, status: "created" };
      },
    });
    expect(await withProfile.captureUrl(p.id, "https://www.youtube.com/playlist?list=PLfake123", { transcribe: false })).toMatchObject({ status: "created" });
    expect(seen).toEqual(["https://www.youtube.com/playlist?list=PLfake123"]);
    expect(worker.submitted).toEqual([]);
  });

  it("an unsupported link fails without contacting the worker", async () => {
    const p = await project();
    expect(await capture.captureUrl(p.id, "https://example.org/video?id=1", { transcribe: false })).toMatchObject({ status: "failed", errorCode: "UNSUPPORTED_URL" });
    expect(worker.submitted).toEqual([]);
  });
});

describe("plain-language reasons", () => {
  it("never contain URLs, paths, cookies or tokens", () => {
    for (const code of ["LOGIN_REQUIRED", "RATE_LIMITED", "NOT_FOUND_OR_REMOVED", "GEO_BLOCKED", "PRIVATE", "EXTRACTOR_ERROR", "WORKER_UNAVAILABLE", "SOMETHING_ELSE"]) {
      const r = plainReason(code);
      expect(r.length).toBeGreaterThan(10);
      expect(r).not.toMatch(/:\/\/|[\\/]home|cookie=|token/i);
    }
    expect(plainReason("LOGIN_REQUIRED")).toBe(LOGIN_SENTENCE);
  });
  it("a removed post fails with its reason", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "notfound";
    const out = await capture.captureUrl(p.id, YT, { transcribe: false });
    expect(out).toMatchObject({ status: "failed", errorCode: "NOT_FOUND_OR_REMOVED", reason: plainReason("NOT_FOUND_OR_REMOVED") });
  });
});

describe("captureUrls", () => {
  it("captures one link at a time, reporting each outcome", async () => {
    const p = await project();
    const progress: Array<[number, number, string]> = [];
    const outs = await capture.captureUrls(p.id, [YT, IG, YT, TT], { transcribe: false }, (done, total, o) => progress.push([done, total, o.status]));
    expect(outs.map((o) => o.status)).toEqual(["created", "created", "duplicate", "created"]);
    expect(progress).toEqual([[1, 4, "created"], [2, 4, "created"], [3, 4, "duplicate"], [4, 4, "created"]]);
    expect(worker.maxConcurrent).toBe(1);
  });
  it("turns a policy deny into a failed outcome per link and asks for the acknowledgement before starting", async () => {
    const p = await project(NO_DOWNLOADER_GOV);
    const outs = await capture.captureUrls(p.id, [YT], { transcribe: false }, () => {});
    expect(outs).toEqual([{ url: YT, status: "failed", errorCode: "POLICY_DENIED", reason: "Capture method downloader is not enabled for this project" }]);
    const q = await project();
    await expect(capture.captureUrls(q.id, [YT, IG], { transcribe: false, cookiesFromBrowser: "chrome" }, () => {})).rejects.toBeInstanceOf(AcknowledgementRequiredError);
    expect(worker.submitted).toEqual([]);
  });
});

describe("with the real Python media worker", () => {
  const venv = devWorkerPython();
  it.skipIf(!existsSync(venv))("captures through the worker's own yt-dlp handling (fake yt-dlp on PATH)", async () => {
    const bin = join(tmp, "bin");
    await mkdir(bin);
    const wrap = async (mode: string) => {
      await writeFile(join(bin, "yt-dlp"), `#!/bin/sh\nFAKE_TOOL_MODE=${mode} exec "${join(FAKE_TOOLS_DIR, "yt-dlp")}" "$@"\n`);
      await chmod(join(bin, "yt-dlp"), 0o755);
    };
    await wrap("ok");
    const w = await startWorker({ env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, AO_MODELS_DIR: join(tmp, "models"), AO_TOOLS_DIR: join(tmp, "tools") } });
    closers.push(() => w.stop());
    const real = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w, index: { db: handle.db }, pollMs: 20 }), index: handle });
    const p = await project();
    const out = await real.captureUrl(p.id, YT, { transcribe: false, quality: "720p" });
    expect(out.status).toBe("created");
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.provenance.tool).toEqual({ name: "yt-dlp", version: "2026.10.22" });
    expect(fileOf(sf, "platform-captions")).toHaveLength(1);
    await wrap("login");
    expect(await real.captureUrl(p.id, YT_CONFLICT, { transcribe: false })).toMatchObject({ status: "failed", errorCode: "LOGIN_REQUIRED", reason: LOGIN_SENTENCE });
  }, 60_000);
});
