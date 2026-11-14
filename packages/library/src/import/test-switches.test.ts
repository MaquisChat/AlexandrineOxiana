/**
 * The three test-only switches of Task Z11 (Ruling R289 a): `AO_SECRETS=memory`, `AO_ZOTERO_API_ORIGIN` and
 * `AO_ZOTERO_TICK_MS`. Each is read once, at the service's start, by one function that takes the environment as
 * an argument; each is honoured ONLY when NODE_ENV is exactly "test" (as AO_LOOKUP_FIXTURES is, R47); outside
 * test mode its value is not even looked at; in test mode a value not in its exact form refuses the start with a
 * sentence that names the variable (never the origin's value).
 *
 * The keyring is never reached by this file: `node:module`'s createRequire is wrapped so that a request for
 * `@napi-rs/keyring` is recorded and answered by a fake entry that keeps nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { FakeZotero, fakeZoteroHandler, guardNetwork } from "../../tests/zotero/fake-zotero.js";
import { SECRETS_ENV, getSecret, deleteSecret, secretsBackendFromEnv, setSecret, useSecretsFromEnv } from "../secrets.js";
import { checkZoteroKey } from "./zotero-web-account.js";
import {
  ZOTERO_API_ORIGIN,
  ZOTERO_API_ORIGIN_ENV,
  ZOTERO_TICK_ENV,
  ZOTERO_WEB_FILE_NOTES,
  useZoteroApiOriginFromEnv,
  zoteroApiOriginFromEnv,
  zoteroTickMsFromEnv,
  zoteroWebAdapter,
} from "./zotero-web.js";
import type { ScanItem } from "./bulk/scan.js";

/** What the wrapped createRequire was asked to load, and what the fake keyring entry was asked to do. */
const keyring = vi.hoisted(() => ({ loads: 0, calls: [] as string[] }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (from: string | URL) => {
    const real = actual.createRequire(from);
    const wrapped = ((id: string) => {
      if (id !== "@napi-rs/keyring") return real(id);
      keyring.loads++;
      class AsyncEntry {
        async getPassword() {
          keyring.calls.push("get");
          return null;
        }
        async setPassword() {
          keyring.calls.push("set");
        }
        async deletePassword() {
          keyring.calls.push("delete");
          return false;
        }
      }
      return { AsyncEntry };
    }) as NodeJS.Require;
    return Object.assign(wrapped, { resolve: real.resolve, cache: real.cache, main: real.main, extensions: real.extensions });
  };
  return { ...actual, default: { ...actual, createRequire }, createRequire };
});

const ORIGIN = "http://127.0.0.1:47123";
const NOT_TEST: NodeJS.ProcessEnv[] = [{}, { NODE_ENV: "production" }, { NODE_ENV: "development" }, { NODE_ENV: "TEST" }, { NODE_ENV: "test " }, { VITEST: "true" }];

let unguard: () => void;
beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(() => unguard());

afterEach(() => {
  // Back to the product: the real origin and the OS keyring.
  useZoteroApiOriginFromEnv({});
  useSecretsFromEnv({});
  keyring.loads = 0;
  keyring.calls.length = 0;
});

describe("AO_ZOTERO_API_ORIGIN", () => {
  it("the Zotero origin switch is ignored unless NODE_ENV=test", async () => {
    for (const env of NOT_TEST) {
      // A good value, and values that test mode would refuse: neither is looked at.
      for (const value of [ORIGIN, "https://evil.example", "http://localhost:1", ""]) {
        expect(zoteroApiOriginFromEnv({ ...env, [ZOTERO_API_ORIGIN_ENV]: value }), JSON.stringify(env)).toBeUndefined();
        expect(useZoteroApiOriginFromEnv({ ...env, [ZOTERO_API_ORIGIN_ENV]: value })).toBe(ZOTERO_API_ORIGIN);
      }
    }
    expect(zoteroApiOriginFromEnv({ NODE_ENV: "test" })).toBeUndefined();
    expect(zoteroApiOriginFromEnv({ NODE_ENV: "test", [ZOTERO_API_ORIGIN_ENV]: ORIGIN })).toBe(ORIGIN);
    expect(zoteroApiOriginFromEnv({ NODE_ENV: "test", [ZOTERO_API_ORIGIN_ENV]: "http://127.0.0.1:1" })).toBe("http://127.0.0.1:1");
    expect(zoteroApiOriginFromEnv({ NODE_ENV: "test", [ZOTERO_API_ORIGIN_ENV]: "http://127.0.0.1:65535" })).toBe("http://127.0.0.1:65535");

    // Outside test mode the product's origin and storage rule are in force: a scan asks https://api.zotero.org
    // (the stand-in's own agent answers only there) and follows a file to files.zotero.net (R206, A1).
    useZoteroApiOriginFromEnv({ NODE_ENV: "production", [ZOTERO_API_ORIGIN_ENV]: ORIGIN });
    const z = new FakeZotero();
    try {
      const { items } = await scanWith(z, z.agent, async (parent) => attach(z, parent, "https://files.zotero.net/files/"));
      expect(items[0]!.files).toHaveLength(1);
      expect(items[0]!.fileNotes).toBeUndefined();
      expect(z.requests.some((r) => r.path.startsWith("/files/"))).toBe(true);
    } finally {
      await z.agent.close();
    }
  });

  it("a non-loopback origin is refused", () => {
    const wrong = [
      "http://localhost:47123", // localhost
      "http://127.0.0.2:47123", // another loopback address
      "http://10.0.0.1:47123", // another address
      "http://api.zotero.org:80", // another host
      "http://[::1]:47123", // IPv6 loopback
      "https://127.0.0.1:47123", // https
      "http://127.0.0.1:47123/", // a path (even "/")
      "http://127.0.0.1:47123/users", // a path
      "http://127.0.0.1:47123?x=1", // a query
      "http://127.0.0.1:47123#x", // a fragment
      "http://u:p@127.0.0.1:47123", // credentials
      "http://127.0.0.1", // no port
      "http://127.0.0.1:", // an empty port
      "http://127.0.0.1:0", // port 0
      "http://127.0.0.1:65536", // out of range
      "http://127.0.0.1:047123", // not a plain number
      "HTTP://127.0.0.1:47123", // not exactly that form
      " http://127.0.0.1:47123", // spaces
      "", // empty
    ];
    const messages = new Set<string>();
    for (const value of wrong) {
      let thrown: unknown;
      try {
        zoteroApiOriginFromEnv({ NODE_ENV: "test", [ZOTERO_API_ORIGIN_ENV]: value });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, value).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message, value).toContain(ZOTERO_API_ORIGIN_ENV);
      expect(message, value).toMatch(/not started/u);
      messages.add(message);
      expect(() => useZoteroApiOriginFromEnv({ NODE_ENV: "test", [ZOTERO_API_ORIGIN_ENV]: value }), value).toThrow(ZOTERO_API_ORIGIN_ENV);
    }
    // One fixed sentence whatever was typed: the value (an address someone typed) is never repeated.
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toMatch(/47123|localhost|10\.0\.0\.1|zotero\.org|::1/u);
  });

  it("with the origin switch on, a file is fetched from that origin only", async () => {
    expect(useZoteroApiOriginFromEnv({ NODE_ENV: "test", [ZOTERO_API_ORIGIN_ENV]: ORIGIN })).toBe(ORIGIN);
    const z = new FakeZotero();
    z.addGroup(7, "A group");
    z.redirectBase = `${ORIGIN}/zoterofilestorage/`;
    // One loopback server for the API and the storage, as the end-to-end stand-in is; nothing else can be reached.
    const agent = new MockAgent();
    agent.disableNetConnect();
    const seen: string[] = [];
    agent
      .get(ORIGIN)
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => {
        seen.push(String(opts.path));
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries((opts.headers ?? {}) as Record<string, string>)) h[k] = String(v);
        const r = fakeZoteroHandler(z)({ method: String(opts.method), path: String(opts.path), headers: h });
        return { statusCode: r.status, data: typeof r.body === "string" ? r.body : Buffer.from(r.body), responseOptions: { headers: r.headers } };
      })
      .persist();
    try {
      // The key check reaches the loopback origin.
      useSecretsFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: "memory" });
      await setSecret("zotero-api-key", z.key);
      const access = await checkZoteroKey({ dispatcher: agent, sleep: async () => {} });
      expect(access.personal.library).toBe(true);
      expect(access.groups.map((g) => g.ref)).toEqual(["group:7"]);
      expect(seen.some((p) => p.startsWith("/keys/current"))).toBe(true);

      let n = 0;
      const { items, result } = await scanWith(z, agent, async (parent) => {
        n++;
        // 1: the account's own redirect (the loopback origin); 2: Zotero's real file host, allowed in the product;
        // 3: the loopback address on another port; 4: Amazon's storage host.
        const redirect = [undefined, "https://files.zotero.net/files/", "http://127.0.0.1:47124/zoterofilestorage/", "https://zoterofilestorage.s3.amazonaws.com/zoterofilestorage/"][n - 1];
        await attach(z, parent, redirect);
      }, 4);
      const [loopback, ...refused] = items;
      expect(loopback!.files).toHaveLength(1);
      expect(loopback!.fileNotes).toBeUndefined();
      for (const it of refused) expect(it.fileNotes, it.key).toEqual([ZOTERO_WEB_FILE_NOTES.redirectRefused]);
      expect([...result.refusedHosts].sort()).toEqual(["127.0.0.1", "files.zotero.net", "zoterofilestorage.s3.amazonaws.com"].sort());
      // Nothing was asked of any other host: every request the stand-in saw came to the loopback origin.
      expect(z.requests.length).toBe(seen.length);
      expect(z.requests.some((r) => r.path.startsWith("/files/"))).toBe(false);
      expect(seen.filter((p) => p.startsWith("/zoterofilestorage/"))).toHaveLength(1);
    } finally {
      await agent.close();
      await z.agent.close();
    }
  });
});

describe("AO_SECRETS", () => {
  it("the memory secrets switch is ignored unless NODE_ENV=test", async () => {
    for (const env of NOT_TEST) {
      for (const value of ["memory", "keyring", ""]) {
        expect(secretsBackendFromEnv({ ...env, [SECRETS_ENV]: value }), JSON.stringify(env)).toBeUndefined();
        expect(useSecretsFromEnv({ ...env, [SECRETS_ENV]: value })).toBe("keyring");
      }
    }
    expect(secretsBackendFromEnv({ NODE_ENV: "test" })).toBeUndefined();
    expect(secretsBackendFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: "memory" })).toBe("memory");
    // Outside test mode the OS keyring is asked (here a fake entry that keeps nothing).
    useSecretsFromEnv({ NODE_ENV: "production", [SECRETS_ENV]: "memory" });
    expect(await getSecret("zotero-api-key")).toBeNull();
    expect(keyring.loads).toBe(1);
    expect(keyring.calls).toEqual(["get"]);
  });

  it("a secrets value other than memory refuses the start", () => {
    for (const value of ["keyring", "Memory", "memory ", "file", ""]) {
      expect(() => secretsBackendFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: value }), value).toThrow(SECRETS_ENV);
      expect(() => useSecretsFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: value }), value).toThrow(/not started/u);
    }
  });

  it("the memory store writes nothing", async () => {
    {
      expect(useSecretsFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: "memory" })).toBe("memory");
      const key = "MadeUpKeyForTheSwitchTest01";
      await setSecret("zotero-api-key", key);
      expect(await getSecret("zotero-api-key")).toBe(key);
      expect(await deleteSecret("zotero-api-key")).toBe(true);
      expect(await getSecret("zotero-api-key")).toBeNull();
      await setSecret("zotero-api-key", key);
      // The keyring was never even loaded, let alone asked.
      expect(keyring.loads).toBe(0);
      expect(keyring.calls).toEqual([]);
      // Read once at the start: a new start (a restart of the service) begins with an empty store.
      useSecretsFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: "memory" });
      expect(await getSecret("zotero-api-key")).toBeNull();
      expect(keyring.loads).toBe(0);
    }
  });
});

describe("AO_ZOTERO_TICK_MS", () => {
  it("the tick switch is ignored unless NODE_ENV=test", () => {
    for (const env of NOT_TEST) {
      for (const value of ["1000", "5", "abc", ""]) expect(zoteroTickMsFromEnv({ ...env, [ZOTERO_TICK_ENV]: value }), JSON.stringify(env)).toBeUndefined();
    }
    expect(zoteroTickMsFromEnv({ NODE_ENV: "test" })).toBeUndefined();
    expect(zoteroTickMsFromEnv({ NODE_ENV: "test", [ZOTERO_TICK_ENV]: "100" })).toBe(100);
    expect(zoteroTickMsFromEnv({ NODE_ENV: "test", [ZOTERO_TICK_ENV]: "1000" })).toBe(1000);
    expect(zoteroTickMsFromEnv({ NODE_ENV: "test", [ZOTERO_TICK_ENV]: "60000" })).toBe(60_000);
  });

  it("a tick out of range refuses the start", () => {
    for (const value of ["99", "60001", "0", "-1000", "1e3", "1000.5", "0100", " 1000", "1000ms", ""]) {
      let thrown: unknown;
      try {
        zoteroTickMsFromEnv({ NODE_ENV: "test", [ZOTERO_TICK_ENV]: value });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, value).toBeInstanceOf(Error);
      expect((thrown as Error).message, value).toContain(ZOTERO_TICK_ENV);
      expect((thrown as Error).message, value).toMatch(/not started/u);
    }
  });
});

// ---- helpers ------------------------------------------------------------------------------------------------

async function attach(z: FakeZotero, parent: string, redirect: string | undefined): Promise<void> {
  const bytes = await buildPdf({ extra: `file of ${parent}` });
  z.addItem("user:42", { itemType: "attachment", contentType: "application/pdf", filename: `${parent}.pdf` }, { parent, file: { bytes, ...(redirect ? { redirect } : {}) } });
}

/** A full scan of user:42 holding `count` articles, each given a file by `withFile`; files are really fetched. */
async function scanWith(z: FakeZotero, dispatcher: MockAgent, withFile: (parent: string) => Promise<void>, count = 1): Promise<{ items: ScanItem[]; result: ReturnType<ReturnType<typeof zoteroWebAdapter>["scanResult"]> }> {
  useSecretsFromEnv({ NODE_ENV: "test", [SECRETS_ENV]: "memory" });
  await setSecret("zotero-api-key", z.key);
  const parents: string[] = [];
  for (let i = 0; i < count; i++) {
    const parent = z.addItem("user:42", { itemType: "journalArticle", title: `Article ${i + 1}` });
    parents.push(parent);
    await withFile(parent);
  }
  const work = await mkdtemp(join(tmpdir(), "ao-switch-work-"));
  try {
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher, sleep: async () => {} });
    const items: ScanItem[] = [];
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, note: () => {} })) items.push(i);
    // In the order the articles were made.
    return { items: parents.map((p) => items.find((i) => i.key === `zotero:${p}`)!), result: a.scanResult() };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
