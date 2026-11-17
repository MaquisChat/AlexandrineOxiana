/**
 * R393 b: the service connects the import's debug sink to its log: each unexpected item error and the batch's stopping
 * error are logged with their kind, code and the program's stack — never the error's message, a title or a path.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps, type ImportSourceAdapter, type ScanItem } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import]
processing:
  metadata_lookup: []
`;
const SECRET = "/Users/jane/Zotero/storage/ABCD1234/Confidential interview.pdf";

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let lines: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-implog-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  lines = [];
  const logStream = new Writable({
    write: (c, _e, cb) => {
      lines.push(String(c));
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null });
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

function sysError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: too many open files, open '${SECRET}'`), { code, syscall: "open", path: SECRET });
}

describe("the import's log (R393 b)", () => {
  it("an item that fails unexpectedly and a batch that stops are logged by kind and stack, never by message or path", async () => {
    expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
    const pr = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: false } } });
    expect(pr.status, pr.body).toBe(200);
    const pid = pr.json.project.id as string;
    const bad = {
      key: "bad-1",
      get files(): ScanItem["files"] {
        throw sysError("EMFILE");
      },
    } as ScanItem;
    const adapter: ImportSourceAdapter = {
      kind: "csl-json",
      location: join(tmp, "export.json"),
      roots: [tmp],
      async *scan() {
        yield bad;
        throw sysError("ENFILE");
      },
    };
    const h = await svc.state.session!.bulk!.startBatch(pid, adapter);
    expect((await h.done).state).toBe("failed");
    const log = lines.join("");
    const item = lines.find((l) => l.includes("bulk import item failed"));
    expect(item).toBeDefined();
    expect(item).toMatch(/kind=EMFILE/u);
    expect(item).toMatch(/syscall=open/u);
    const stopped = lines.find((l) => l.includes("bulk import stopped"));
    expect(stopped).toMatch(/kind=ENFILE/u);
    expect(stopped).toMatch(/\\n\s+at /u); // the program's stack frames
    expect(log).not.toContain("Confidential");
    expect(log).not.toContain("/Users/jane");
    expect(log).not.toContain("too many open files");
  });
});
