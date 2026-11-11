import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REQUIRED_FIELDS, type AuditEvent, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const savedEnv = { PATH: process.env.PATH, FAKE_TOOL_MODE: process.env.FAKE_TOOL_MODE, FAKE_ARGV_FILE: process.env.FAKE_ARGV_FILE, FAKE_FIXTURE: process.env.FAKE_FIXTURE };
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
  delete process.env.FAKE_FIXTURE;
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

  it("transcribeSource transcribes a stored source, keeps the transcript with it and leaves no work folder behind", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, YT, { transcribe: false });
    const before = await repo.getSource(p.id, out.sourceId!);
    expect(before.assets.some((a) => a.kind === "transcript")).toBe(false);
    const r = await capture.transcribeSource(p.id, out.sourceId!, { model: "small", language: "en" });
    expect(r.flaggedSegments).toBe(1);
    expect(r.files).toHaveLength(2);
    expect(r.files.every((f) => f.startsWith(`${before.source.folder}/derived/`))).toBe(true);
    const after = await repo.getSource(p.id, out.sourceId!);
    expect(after.assets.filter((a) => a.kind === "transcript")).toHaveLength(2);
    expect(worker.submitted.at(-1)).toMatchObject({ type: "audio.transcribe", params: { model: "small", language: "en" } });
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("capture-") || n.startsWith("transcribe-"))).toEqual([]);
    await expect(capture.transcribeSource(p.id, "00000000-0000-7000-8000-000000000000")).rejects.toThrow();
  });

  it("profile and playlist links go to the profile capture (or the captureProfile given)", async () => {
    const p = await project();
    // the built-in profile capture: the fake tools have no such channel, so listing it fails plainly
    const out = await capture.captureUrl(p.id, "https://www.youtube.com/@amatest_fake", { transcribe: false });
    expect(out).toMatchObject({ status: "failed", errorCode: "EXTRACTOR_ERROR" });
    expect(worker.submitted.map((j) => [j.input, j.params.flatList])).toEqual([["https://www.youtube.com/@amatest_fake/videos", true]]);
    worker.submitted.length = 0;
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

describe("fix round 1", () => {
  const GDPR_GOV = (basis?: string) => `profiles: [gdpr]
identifiability:
  containsIdentifiable: true
encryption:
  atRest: required
captureMethods: [downloader]
${basis ? `consent:\n  defaultLegalBasis:\n    social-media: "${basis}"\n` : ""}`;
  const TT_PHOTO = "https://www.tiktok.com/@fake.dancer/photo/7000000000000000002";
  const SECRETS = ["sig=", "si=", "expire=", "ip=", "oh=", "oe=", "signature", "x-expires", "_nc_", "FAKECOOKIE", "tt_chain_token", "/home/someone", "googlevideo"];
  const noSecrets = (label: string, text: string) => {
    for (const s of SECRETS) expect([label, s, text.includes(s)]).toEqual([label, s, false]);
  };
  const plainText = async (sf: SourceFile, kind: string) => {
    const a = fileOf(sf, kind)[0]!;
    const raw = await readFile(join(lib.root, a.path));
    return a.encrypted ? (await decryptBytes((id) => ring.get(id), raw)).toString("utf8") : raw.toString("utf8");
  };
  const captureEvents = async (folder: string) => (await auditEvents(folder)).filter((e) => e.action === "capture");

  it("C1: signed, expiring and tracking URLs and local paths never reach the stored snapshot or provenance (yt-dlp and gallery-dl)", async () => {
    const p = await project();
    for (const url of [YT, TT, IG, TT_PHOTO]) {
      const out = await capture.captureUrl(p.id, url, { transcribe: false });
      expect([url, out.status]).toEqual([url, "created"]);
      const sf = await repo.getSource(p.id, out.sourceId!);
      noSecrets(`${url} file`, await plainText(sf, "platform-metadata"));
      noSecrets(`${url} provenance`, JSON.stringify(sf.source.provenance));
      noSecrets(`${url} source.json`, JSON.stringify(sf));
    }
    const yt = await repo.getSource(p.id, (await capture.captureUrl(p.id, YT, { transcribe: false })).sourceId!);
    const snap = yt.source.provenance.platformSnapshot as Record<string, unknown>;
    expect(snap.original_url).toBe("https://www.youtube.com/watch?v=aoTest00001");
    expect(snap.webpage_url).toBe("https://www.youtube.com/watch?v=aoTest00001");
    expect(snap.uploader_url).toBe("https://www.youtube.com/@amatest_fake");
    for (const k of ["url", "manifest_url", "fragment_base_url", "fragments", "subtitles", "automatic_captions", "thumbnail", "thumbnails", "download_dir"]) expect(snap).not.toHaveProperty(k);
    expect(snap.chapters).toEqual([{ title: "Intro", start_time: 0, end_time: 10 }]);
  });

  it("I4: the key rule drops secrets by word and keeps author, authors, authority and header_image", () => {
    const s = stripSnapshot({
      author: { uniqueId: "a", nickname: "A" }, authors: ["x"], authority: "y", header_image: "z.jpg", headerImage: "h",
      sessionId: 1, session_id: 2, apikey: 3, xsrf_token: 4, csrfToken: 5, "Set-Cookie": 6, passwd: 7, client_secret: 8, sig: 9, bearer: 10,
      headers: {}, _http_headers: {}, HTTP_HEADERS: {}, authorization: 11, AuthToken: 12,
      page: "https://example.org/a/b?token=1#x", local: "/tmp/ao/x.mp4", list: ["/home/u/a", "keep"],
    });
    expect(s).toEqual({
      author: { uniqueId: "a", nickname: "A" }, authors: ["x"], authority: "y", header_image: "z.jpg", headerImage: "h",
      page: "https://example.org/a/b", list: ["keep"],
    });
  });

  it("R42a: drops api/access/private/secret + key pairs, credential(s) and jwt, but keeps a bare key and extractor_key", () => {
    const s = stripSnapshot({
      accesskey: 16, privatekey: 17, secretkey: 18, AccessKey: 19,
      api_key: 1, apiKey: 2, "X-Api-Key": 3, access_key: 4, AccessKeyId: 5, private_key: 6, privateKey: 7, secret_key: 8, SecretKey: 9,
      credential: 10, credentials: 11, aws_credentials: 12, jwt: 13, jwtToken: 14, id_jwt: 15,
      key: "k", extractor_key: "Youtube", keywords: ["a"], monkey: "m", access: "public", private: false, api: "v2", key_frames: 3,
      nested: [{ apiKeyName: "x", ok: 1 }],
    });
    expect(s).toEqual({
      key: "k", extractor_key: "Youtube", keywords: ["a"], monkey: "m", access: "public", private: false, api: "v2", key_frames: 3,
      nested: [{ ok: 1 }],
    });
  });

  it("I4: a TikTok photo post (gallery-dl, author{uniqueId,nickname}) gets a verified creator and keeps the author object", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, TT_PHOTO, { transcribe: false });
    expect(out.status).toBe("created");
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.type).toBe("social-post");
    expect(sf.source.provenance.tool.name).toBe("gallery-dl");
    expect(fileOf(sf, "image")).toHaveLength(3);
    expect(sf.source.creators).toEqual([{ literal: "Fake Dancer", role: "uploader", handle: "fake.dancer" }]);
    expect(sf.source.title.variants[0]!.value).toBe("Market colours in three photos #market");
    for (const f of REQUIRED_FIELDS["social-post"]) expect([f, sf.verification[f]?.status]).toEqual([f, "verified"]);
    expect((sf.source.provenance.platformSnapshot as { author?: unknown }).author).toMatchObject({ uniqueId: "fake.dancer", nickname: "Fake Dancer" });
  });

  it("I1: an identifiable GDPR project without a legal basis fails plainly before downloading; with the project default or an override it captures", async () => {
    const p = await project(GDPR_GOV(), true);
    const out = await capture.captureUrl(p.id, YT, { transcribe: false });
    expect(out).toEqual({ url: YT, status: "failed", errorCode: "LEGAL_BASIS_REQUIRED", reason: "Record a legal basis for this project's social-media data, then try again." });
    expect(worker.submitted).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);

    const q = await project(GDPR_GOV("public task (Art. 6(1)(e))"), true);
    const ok = await capture.captureUrl(q.id, YT, { transcribe: false });
    expect(ok.status).toBe("created");
    const sf = await repo.getSource(q.id, ok.sourceId!);
    expect(sf.source.provenance.legal).toEqual({ status: "public", basis: "public task (Art. 6(1)(e))" });
    expect(sf.source.provenance.identifiable).toBe(true);
    expect(sf.assets.every((a) => a.encrypted)).toBe(true);

    const over = await capture.captureUrl(p.id, TT, { transcribe: false, legalBasis: "consent (Art. 6(1)(a))" });
    expect(over.status).toBe("created");
    expect((await repo.getSource(p.id, over.sourceId!)).source.provenance.legal.basis).toBe("consent (Art. 6(1)(a))");
  });

  it("I2: every capture path leaves exactly one audited capture decision (created, duplicate, refreshed, short-link duplicate, failed)", async () => {
    const p = await project();
    let before = 0;
    const once = async (url: string, opts: Parameters<LinkCapture["captureUrl"]>[2], status: string) => {
      const out = await capture.captureUrl(p.id, url, opts);
      expect([url, out.status]).toEqual([url, status]);
      const evs = await captureEvents(p.folder);
      expect([status, evs.length - before]).toEqual([status, 1]);
      before = evs.length;
      const last = evs.at(-1)!;
      expect(last.decision?.result).toBe("allow");
      expect(last.details).toMatchObject({ platform: url.includes("tiktok") ? "tiktok" : "youtube", cookies: false });
      expect(JSON.stringify(last)).not.toContain("http");
    };
    await once(TT, { transcribe: false }, "created");
    await once(TT, { transcribe: false }, "duplicate");
    await once(TT, { transcribe: false, refreshIfExists: true }, "refreshed");
    process.env.FAKE_FIXTURE = "tiktok-video.info.json";
    await once("https://vm.tiktok.com/ZMfake123/", { transcribe: false }, "duplicate");
    delete process.env.FAKE_FIXTURE;
    process.env.FAKE_TOOL_MODE = "login";
    await once(YT, { transcribe: false }, "failed");
  });

  it("I3: capture jobs are never resumed, leftovers are swept, and the work folder is private", async () => {
    const p = await project();
    // a capture.download job left running by a crash
    handle.db.prepare("INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES ('j-old', ?, 'capture.download', 'running', ?, ?)")
      .run(p.id, JSON.stringify({ type: "capture.download", input: YT, output: join(lib.root, ".tmp", "capture-old"), params: {} }), new Date().toISOString());
    const stale = join(lib.root, ".tmp", "capture-old");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "aoTest00001.info.json"), '{"http_headers":{"Cookie":"SID=x"}}');
    const res = await client.resumePending();
    expect(res).toHaveLength(1);
    expect((res[0]!.error as { code?: string }).code).toBe("INTERRUPTED");
    expect(handle.db.prepare("SELECT status FROM jobs WHERE id = 'j-old'").get()).toEqual({ status: "failed" });
    expect(worker.submitted).toEqual([]);
    expect(existsSync(stale)).toBe(false);

    // leftovers are also removed when the library is opened
    await mkdir(join(lib.root, ".tmp", "capture-crashed"), { recursive: true });
    await mkdir(join(lib.root, ".tmp", "worker-crashed"), { recursive: true });
    await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
    expect(existsSync(join(lib.root, ".tmp", "capture-crashed"))).toBe(false);
    expect(existsSync(join(lib.root, ".tmp", "worker-crashed"))).toBe(false);

    // the work folder exists (0700) while the download runs, and is gone afterwards
    const modes: number[] = [];
    const w2 = await startToolWorker({
      beforeCapture: async () => {
        for (const n of await readdir(join(lib.root, ".tmp"))) if (n.startsWith("capture-")) modes.push((await stat(join(lib.root, ".tmp", n))).mode & 0o777);
      },
    });
    closers.push(() => w2.close());
    const c2 = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w2, pollMs: 5 }), index: handle });
    expect((await c2.captureUrl(p.id, YT, { transcribe: false })).status).toBe("created");
    if (process.platform !== "win32") expect(modes).toEqual([0o700]);
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("capture-"))).toEqual([]);
  });

  it("I5/M3: storing captions or the transcript can fail after the source exists; the outcome says what was saved", async () => {
    const p = await project();
    const spy = vi.spyOn(repo, "addDerivedAsset").mockRejectedValue(new Error("disk full"));
    const out = await capture.captureUrl(p.id, YT_CONFLICT, { transcribe: true, transcribeModel: "tiny" });
    spy.mockRestore();
    expect(out.status).toBe("needs-review");
    expect(out.reason).toContain("Some details could not be confirmed, so the source is in the review queue.");
    expect(out.reason).toContain("The source was saved, but some captions could not be stored.");
    expect(out.reason).toContain("The source was saved, but the transcript could not be stored.");
    expect(repo.listSourceIds(p.id)).toEqual([out.sourceId]);
    const spy2 = vi.spyOn(repo, "addDerivedAsset").mockRejectedValue(new Error("disk full"));
    const [o] = await capture.captureUrls(p.id, [YT], { transcribe: false }, () => {});
    spy2.mockRestore();
    expect(o).toMatchObject({ status: "created", reason: "The source was saved, but some captions could not be stored." });
  });

  it("I6: a miss in a stale index falls back to reading the sources", async () => {
    const p = await project();
    const first = await capture.captureUrl(p.id, YT, { transcribe: false });
    // content out of date while ids are present, and the recorded stamp no longer matches
    handle.db.prepare("UPDATE sources SET platform_post_id = NULL").run();
    handle.db.prepare("UPDATE meta SET value = '{}' WHERE key = 'projectStamps'").run();
    expect(await capture.captureUrl(p.id, YT, { transcribe: false })).toMatchObject({ status: "duplicate", sourceId: first.sourceId });
    // rows missing entirely
    handle.db.prepare("DELETE FROM sources").run();
    expect(await capture.captureUrl(p.id, YT, { transcribe: false })).toMatchObject({ status: "duplicate", sourceId: first.sourceId });
    expect(worker.submitted.filter((j) => j.type === "capture.download")).toHaveLength(1);
  });

  it("I7/M5: 'public' only for a post the platform marks public, seen without a session; access is recorded", async () => {
    const p = await project();
    const pub = await repo.getSource(p.id, (await capture.captureUrl(p.id, YT, { transcribe: false })).sourceId!);
    expect(pub.source.provenance.legal.status).toBe("public");
    expect(pub.source.provenance.access).toBe("public");
    const unlisted = await repo.getSource(p.id, (await capture.captureUrl(p.id, YT_CONFLICT, { transcribe: false })).sourceId!);
    expect(unlisted.source.provenance.legal.status).toBe("unknown");
    const ig = await repo.getSource(p.id, (await capture.captureUrl(p.id, IG, { transcribe: false })).sourceId!);
    expect(ig.source.provenance.legal.status).toBe("unknown"); // gallery-dl gives no availability
    await repo.acknowledge(p.id, "cookies");
    const signed = await repo.getSource(p.id, (await capture.captureUrl(p.id, TT, { transcribe: false, cookiesFromBrowser: "brave" })).sourceId!);
    expect(signed.source.provenance.legal.status).toBe("unknown");
    expect(signed.source.provenance.access).toBe("signed-in-session");
    expect(JSON.stringify(signed.source.provenance)).not.toContain("brave");
  });

  it("M1: the acknowledgement is asked before a profile link is handed on", async () => {
    const p = await project();
    let called = false;
    const c = createLinkCapture({ repo, worker: client, captureProfile: async (_p, url) => ((called = true), { url, status: "created" }) });
    await expect(c.captureUrl(p.id, "https://www.instagram.com/fake_photographer/", { transcribe: false, cookiesFromBrowser: "chrome" })).rejects.toBeInstanceOf(AcknowledgementRequiredError);
    expect(called).toBe(false);
  });

  it("M2: the post's data without any media file is an incomplete source", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "infoonly";
    const out = await capture.captureUrl(p.id, YT, { transcribe: true });
    expect(out).toMatchObject({ status: "incomplete", errorCode: "NO_MEDIA" });
    const sf = await repo.getSource(p.id, out.sourceId!);
    expect(sf.source.availability.status).toBe("incomplete");
    expect(sf.assets.map((a) => a.kind)).toEqual(["platform-metadata"]);
  });

  it("R42b: governance changed during the download → POLICY_CHANGED, nothing stored, one deny audited after the one allow", async () => {
    const p = await project();
    const w2 = await startToolWorker({
      beforeCapture: async () => {
        await writeFile(join(lib.root, p.folder, "governance.yaml"), NO_DOWNLOADER_GOV);
      },
    });
    closers.push(() => w2.close());
    const c2 = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w2, pollMs: 5 }), index: handle });
    const out = await c2.captureUrl(p.id, YT, { transcribe: false });
    expect(out).toEqual({
      url: YT,
      status: "failed",
      errorCode: "POLICY_CHANGED",
      reason: "This project's rules changed during the download, so nothing was saved.",
    });
    expect(repo.listSourceIds(p.id)).toEqual([]);
    const evs = await captureEvents(p.folder);
    expect(evs.map((e) => e.decision?.result)).toEqual(["allow", "deny"]);
    expect((await auditEvents(p.folder)).filter((e) => e.action === "store" && e.details?.op !== "project.create")).toEqual([]);
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("capture-"))).toEqual([]);
  });

  it("R42b: an expired protocol mid-download also stops a refresh before the new snapshot is stored", async () => {
    const p = await project();
    const first = await capture.captureUrl(p.id, YT, { transcribe: false });
    const before = (await repo.getSource(p.id, first.sourceId!)).assets.length;
    const w2 = await startToolWorker({
      beforeCapture: async () => {
        await writeFile(join(lib.root, p.folder, "governance.yaml"), `${GOV}protocol:\n  number: "X-1"\n  expires: "2020-01-01"\n`);
      },
    });
    closers.push(() => w2.close());
    const c2 = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w2, pollMs: 5 }), index: handle });
    const out = await c2.captureUrl(p.id, YT, { transcribe: false, refreshIfExists: true });
    expect(out).toMatchObject({ status: "failed", errorCode: "POLICY_CHANGED" });
    expect((await repo.getSource(p.id, first.sourceId!)).assets.length).toBe(before);
  });
});

describe("R116: one per-platform lane per library", () => {
  it("two link captures (two queues) on the same library never download from one platform at the same time", async () => {
    const p = await project();
    const inFlight = new Map<string, number>();
    const overlaps: string[] = [];
    let downloads = 0;
    const fake = {
      async submit(_pid: string, job: { type: string; input: string }) {
        const platform = classifyUrl(job.input).platform;
        const n = (inFlight.get(platform) ?? 0) + 1;
        inFlight.set(platform, n);
        if (n > 1) overlaps.push(platform);
        downloads++;
        await new Promise((r) => setTimeout(r, 5));
        inFlight.set(platform, n - 1);
        const { WorkerJobError } = await import("../worker-client.js");
        throw new WorkerJobError("TOOL_FAILED", "the tool failed");
      },
    } as unknown as WorkerClient;
    const a = createLinkCapture({ repo, worker: fake, index: handle });
    const b = createLinkCapture({ repo, worker: fake, index: handle });
    const urls = (k: string) => Array.from({ length: 4 }, (_, i) => `https://www.youtube.com/watch?v=aoLane${k}000${i}`);
    await Promise.all([a.captureUrls(p.id, urls("A"), { transcribe: false }), b.captureUrls(p.id, urls("B"), { transcribe: false })]);
    expect(downloads).toBe(8);
    expect(overlaps).toEqual([]);
  });
});
