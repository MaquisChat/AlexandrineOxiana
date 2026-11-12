/**
 * Task 69 (D17): a captured post that a later profile capture found gone from its platform keeps
 * its record, with `availability: { status: "unavailable-on-platform", firstNoticedAt }`. The
 * library's list rows and the source view carry that availability so the interface can show it.
 * The source is marked here the way profile capture marks it (the same repo call and values).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
captureMethods: [downloader]
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService;

async function call(r: { method?: "GET" | "POST" | "PATCH"; url: string; body?: unknown }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  return { status: res.statusCode, json: res.json() as any, body: res.body };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-availability-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
});
afterEach(async () => {
  await svc.close();
  await rm(tmp, { recursive: true, force: true });
});

async function setup(): Promise<{ pid: string; gone: string; here: string }> {
  const pid = (await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: false } } })).json.project.id as string;
  const repo = svc.state.session!.repo;
  const post = async (title: string) =>
    (
      await repo.createSource(
        pid,
        { projectIds: [pid], type: "social-post", title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
        [],
        { provenance: { captureMethod: "downloader", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
      )
    ).source.id;
  return { pid, gone: await post("Gone post"), here: await post("Present post") };
}

const NOTICED = "2026-11-03T09:15:00.000Z";

describe("availability in the list rows and the source view (Task 69, D17)", () => {
  it("a post marked no longer on the platform: its row and its record carry the status and the date it was noticed; an available post's row says available", async () => {
    const { pid, gone, here } = await setup();
    const repo = svc.state.session!.repo;
    // As profile capture marks a post missing from a whole listing (profile-capture.ts).
    await repo.updateSource(pid, gone, { availability: { status: "unavailable-on-platform", firstNoticedAt: NOTICED } });

    const list = await call({ url: `/projects/${pid}/sources` });
    expect(list.status, list.body).toBe(200);
    const row = (id: string) => list.json.items.find((i: { id: string }) => i.id === id);
    expect(row(gone).availability).toEqual({ status: "unavailable-on-platform", firstNoticedAt: NOTICED });
    expect(row(here).availability).toEqual({ status: "available" });

    const rec = await call({ url: `/projects/${pid}/sources/${gone}` });
    expect(rec.status, rec.body).toBe(200);
    expect(rec.json.source.availability).toEqual({ status: "unavailable-on-platform", firstNoticedAt: NOTICED });
  });

  it("a post that reappeared (its availability restored, as profile capture does): the row says available again", async () => {
    const { pid, gone } = await setup();
    const repo = svc.state.session!.repo;
    await repo.updateSource(pid, gone, { availability: { status: "unavailable-on-platform", firstNoticedAt: NOTICED } });
    await repo.updateSource(pid, gone, { availability: { status: "available" } });
    const list = await call({ url: `/projects/${pid}/sources` });
    expect(list.json.items.find((i: { id: string }) => i.id === gone).availability).toEqual({ status: "available" });
  });

  it("a text search's rows carry it too", async () => {
    const { pid, gone } = await setup();
    await svc.state.session!.repo.updateSource(pid, gone, { availability: { status: "unavailable-on-platform", firstNoticedAt: NOTICED } });
    const list = await call({ url: `/projects/${pid}/sources?text=Gone` });
    expect(list.json.items.map((i: { id: string }) => i.id)).toEqual([gone]);
    expect(list.json.items[0].availability).toEqual({ status: "unavailable-on-platform", firstNoticedAt: NOTICED });
  });
});
