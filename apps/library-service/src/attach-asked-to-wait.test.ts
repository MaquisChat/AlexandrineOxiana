/**
 * Decision 31 (b), R556 (2): `POST /projects/:id/attach` does not wait for a metadata service that answers "too many
 * requests". The file is stored at once as "needs review" with the owner's sentence, and the review queue lists its entry
 * with that sentence. The service's own lookup client (real waits, real clock) is used: only the answer is a stand-in.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOOKUP_WAITING_TEXT } from "@ao/shared";
import { deviceDeps, type Deps } from "@ao/library";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
/** Lookups allowed: the file's title is searched at OpenAlex. */
const LOOKUP_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let agent: MockAgent;
let previous: Dispatcher;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-attach-wait-svc-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  agent = new MockAgent();
  agent.disableNetConnect();
  previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent" });
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown }) {
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

describe("POST /projects/:id/attach when OpenAlex answers 429 / Retry-After 60 (decision 31 b, R556 2)", () => {
  it("answers promptly with the outcome and the owner's sentence; the review route lists the entry with it", async () => {
    expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
    const p = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: LOOKUP_GOV, encryption: { enabled: false } } });
    expect(p.status, p.body).toBe(200);
    const pid = p.json.project.id as string;
    let asked = 0;
    agent
      .get("https://api.openalex.org")
      .intercept({ path: () => true, method: "GET" })
      .reply(() => {
        asked++;
        return { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "60" } } };
      })
      .persist();
    const file = join(tmp, "Desktop", "tide-line-notes.pdf");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await buildPdf({ title: "Notes from the tide-line interviews", author: "Ana Souza", lines: ["Notes from the tide-line interviews."] }));

    const started = Date.now();
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [file] } });
    const took = Date.now() - started;
    expect(att.status, att.body).toBe(200);
    expect(att.json.items).toEqual([{ path: file, outcome: "needs-review", sourceId: expect.any(String), reason: LOOKUP_WAITING_TEXT }]);
    expect(att.json.items[0].reason).toBe("Waiting for lookup service response.");
    expect(took).toBeLessThan(15_000); // before decision 31 (b): a minute
    expect(asked).toBe(1);

    const q = await call({ url: `/projects/${pid}/review` });
    expect(q.status, q.body).toBe(200);
    expect(q.json.items).toHaveLength(1);
    expect(q.json.items[0]).toMatchObject({ sourceId: att.json.items[0].sourceId, kind: "import", group: "attach" });
    expect(q.json.items[0].reasons[0]).toBe(LOOKUP_WAITING_TEXT);
  });
});
