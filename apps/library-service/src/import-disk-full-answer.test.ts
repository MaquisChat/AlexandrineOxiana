/**
 * R439 (1): a "disk full" or "quota" error that reaches the service's error answer is said in plain words on every
 * route — "The disk is full. Free some space and try again." — never as an unexpected error, and with no
 * path or system text (R96). The full disk is injected (an unpack that fails with ENOSPC, a repo write that does);
 * no real disk is filled.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { buildPdf, buildZip } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const unpack = vi.hoisted(() => ({ fail: 0 }));
vi.mock("../../../packages/library/src/extract/zip.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../../packages/library/src/extract/zip.js")>();
  return {
    ...m,
    extractArchive: async (...a: Parameters<typeof m.extractArchive>) => {
      if (unpack.fail > 0) {
        unpack.fail--;
        throw Object.assign(new Error("ENOSPC: no space left on device, write '/Users/jane/Lib/.tmp/x.pdf'"), { code: "ENOSPC", syscall: "write" });
      }
      return m.extractArchive(...a);
    },
  };
});

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
const SENTENCE = "The disk is full. Free some space and try again.";

let tmp: string;
let deps: Deps;
let svc: LibraryService;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-diskfull-answer-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await createService({ token: TOKEN, deps, worker: null });
  unpack.fail = 0;
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  return { status: res.statusCode, json: res.json() as any, body: res.body };
}

async function setUp(): Promise<string> {
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
  const pr = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: false } } });
  expect(pr.status, pr.body).toBe(200);
  return pr.json.project.id as string;
}

describe("a full disk is said in plain words on every route (R439 1)", () => {
  it("the dry run of a ZIP whose unpacking meets a full disk answers the sentence, with no path or system text", async () => {
    const pid = await setUp();
    const src = join(tmp, "Papers");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "a.zip"), buildZip([{ name: "one.pdf", data: await buildPdf({ extra: "one" }) }]));
    unpack.fail = 1;
    const r = await call({ method: "POST", url: `/projects/${pid}/import/dry-run`, body: { adapter: { kind: "folder", path: src } } });
    expect(r.status).toBe(503);
    expect(r.json.error).toEqual({ code: "DISK_FULL", message: SENTENCE });
    expect(r.body).not.toMatch(/ENOSPC|jane|no space/u);
  });

  it("another route whose write meets a full disk (or a quota) answers it too", async () => {
    const pid = await setUp();
    for (const code of ["ENOSPC", "EDQUOT"]) {
      svc.state.session!.repo.createCollection = async () => {
        throw Object.assign(new Error(`${code}: write '/Users/jane/Lib/x.json'`), { code });
      };
      const r = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Fieldwork" } });
      expect(r.status).toBe(503);
      expect(r.json.error).toEqual({ code: "DISK_FULL", message: SENTENCE });
    }
  });

  it("an ordinary unexpected error keeps the general answer", async () => {
    const pid = await setUp();
    svc.state.session!.repo.createCollection = async () => {
      throw new RangeError("something odd at /Users/jane/Lib");
    };
    const r = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Fieldwork" } });
    expect(r.status).toBe(500);
    expect(r.json.error).toEqual({ code: "INTERNAL", message: "Something went wrong. Nothing was changed by this request unless it says otherwise." });
  });
});
