/**
 * Task Z12: `ao zotero check-key` and `ao zotero sync`. The command line runs IN this process (through its own `run`),
 * against the stand-in Zotero (Z1), served as the global dispatcher, with an in-memory password store: nothing here
 * reaches a real host, and nothing but GET ever reaches the stand-in. What is pinned: the saved key is never printed
 * (any output mode, any failure); a failure is said honestly and exits 1; each linked library is run once, in the
 * settings' order, with the trigger "manual", through the engine's own runner and records; a paused link is not run; a
 * Zotero back-off is obeyed; a library held by the app is read-only for the command line and nothing runs.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZOTERO_SYNC_REASON_TEXT, ZOTERO_SYNC_SENTENCES, zoteroSyncStatusLine, zoteroSyncsAgainLine, type ZoteroSyncRun as SharedRun } from "@ao/shared";
import {
  ZOTERO_SYNC_FILE,
  ZOTERO_SYNC_HISTORY_FILE,
  deviceDeps,
  openLibrary,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  writeZoteroSyncSettings,
  type ZoteroSyncLink,
} from "@ao/library";
// The command line has no undici of its own: the library's (the one its Web import uses) sets the global dispatcher.
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../../packages/library/node_modules/undici/index.js";
import { useMemorySecrets, useNoSecretStore } from "../../../../packages/library/src/secrets-testing.js";
import { setSecret } from "../../../../packages/library/src/secrets.js";
import { FakeZotero, guardNetwork } from "../../../../packages/library/tests/zotero/fake-zotero.js";
import { InvalidArgumentError, Option, type CommanderError } from "commander";
import { buildProgram, run } from "../index.js";
import { hasEnvPassphrase } from "../prompt.js";
import { openSession } from "../session.js";

const ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const PASS = "correct horse battery staple";

/** A recognisable key: looked for in every output, every error and every file. */
const KEY = "Zk3yRecognisableAbCdEf12";
const U = "user:42";
const G = "group:9";

let tmp: string;
let config: string;
let libPath: string;
let libraryId: string;
let projectId: string;
let z: FakeZotero;
let secrets: { restore(): void };
let previous: Dispatcher;
let unguard: () => void;
let everything: string[];

beforeAll(() => {
  unguard = guardNetwork();
  // The command line reads AO_PASSPHRASE once per process (and removes it): this process is one run of it.
  process.env.AO_PASSPHRASE = PASS;
  hasEnvPassphrase();
});
afterAll(() => unguard());

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `ao` in this process with the environment the command line reads, capturing both streams. */
async function ao(args: string[], env: Record<string, string | undefined> = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += String(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += String(c);
    return true;
  }) as typeof process.stderr.write;
  const saved: Record<string, string | undefined> = {};
  const all = { AO_CONFIG_DIR: config, AO_LIBRARY: libPath, ...env };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const listeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  process.exitCode = undefined;
  try {
    const code = await run(["node", "ao", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const sig of ["SIGINT", "SIGTERM"] as const) for (const l of process.listeners(sig)) if (!listeners[sig].includes(l)) process.removeListener(sig, l);
    process.exitCode = undefined;
    everything.push(stdout, stderr);
  }
}
const json = (r: Result): any => JSON.parse(r.stdout);

/** The command line as its own process, with no passphrase and no terminal (stdin is closed). */
function spawnAo(args: string[]): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env, AO_CONFIG_DIR: config, AO_LIBRARY: libPath };
  delete env.AO_PASSPHRASE;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      everything.push(stdout, stderr);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zcli-"));
  config = join(tmp, "config");
  libPath = join(tmp, "Lib");
  everything = [];
  z = new FakeZotero({ key: KEY });
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", z.key);
  previous = getGlobalDispatcher();
  setGlobalDispatcher(z.agent);
  const made = await ao(["--json", "library", "create", libPath, "--name", "Lib"]);
  expect(made.code, made.stderr).toBe(0);
  libraryId = json(made).libraryId;
  const proj = await ao(["--json", "project", "create", "Study", "--not-identifiable", "--capture", "zotero_import"]);
  expect(proj.code, proj.stderr).toBe(0);
  projectId = json(proj).id;
});

afterEach(async () => {
  // One way only: nothing but GET ever reached the stand-in.
  expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
  // R78: the key is in nothing the command line printed, and in no file this computer or the library holds.
  for (const s of everything) expect(s).not.toContain(KEY);
  for (const f of await filesUnder(tmp)) expect(await readFile(f, "latin1"), f).not.toContain(KEY);
  setGlobalDispatcher(previous);
  secrets.restore();
  await z.agent.close();
  await rm(tmp, { recursive: true, force: true });
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await readdir(dir, { recursive: true }).catch(() => [] as string[])) {
    const p = join(dir, f);
    if ((await stat(p).catch(() => undefined))?.isFile()) out.push(p);
  }
  return out;
}

/** R299 b: the refusal of a --ref that is not a library, exactly; it repeats nothing that was typed. */
const NOT_A_LIBRARY = "That is not a Zotero library. Write --ref user:<number> or --ref group:<number>.";

const link = (ref: string, extra: Partial<ZoteroSyncLink> = {}): ZoteroSyncLink => ({ ref, projectId, fullDone: false, options: { structure: "collections", duplicates: "merge" }, ...extra });
const linked = (...links: ZoteroSyncLink[]) => writeZoteroSyncSettings(config, libraryId, { automatic: false, everyMinutes: 60, links });
const history = () => readZoteroSyncHistory(config, libraryId);
function articles(n: number, ref = U): void {
  for (let i = 0; i < n; i++) z.addItem(ref, { itemType: "journalArticle", title: `Article ${ref} ${i}`, creators: [{ creatorType: "author", firstName: "Ada", lastName: `Writer${i}` }], date: "2020", publicationTitle: "Journal" });
}

describe("ao zotero check-key", () => {
  it("prints the service's own summary sentence for the saved key", async () => {
    const r = await ao(["zotero", "check-key"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("This key can read your library.");
    z.addGroup(9, "Fieldwork group");
    const g = await ao(["zotero", "check-key"]);
    expect(g.stdout.trim()).toBe("This key can read your library and 1 group library.");
  });

  it("check-key never prints the key", async () => {
    z.addGroup(9, "Fieldwork group");
    expect((await ao(["zotero", "check-key"])).code).toBe(0);
    const okJson = await ao(["--json", "zotero", "check-key"]);
    expect(okJson.code).toBe(0);
    expect(json(okJson)).toMatchObject({ userId: "42", personal: { library: true }, summary: "This key can read your library and 1 group library." });
    expect(Object.keys(json(okJson))).not.toContain("key");
    // A key typed on the command line is refused by the parser; what was typed is not echoed back.
    const typed = await ao(["zotero", "check-key", KEY]);
    const typedOpt = await ao(["zotero", "check-key", `--key=${KEY}`]);
    expect(typed.code).toBe(1);
    expect(typedOpt.code).toBe(1);
    // Every failure, in text and in JSON.
    z.revokeKey();
    const revoked = await ao(["zotero", "check-key"]);
    const revokedJson = await ao(["--json", "zotero", "check-key"]);
    expect(revoked.code).toBe(1);
    expect(revoked.stderr).toContain(ZOTERO_SYNC_REASON_TEXT["key-refused"]);
    expect(json({ ...revokedJson, stdout: revokedJson.stdout.trim() })).toMatchObject({ error: ZOTERO_SYNC_REASON_TEXT["key-refused"] });
    const down = new FakeZotero({ key: KEY });
    down.failNext(50, 503);
    setGlobalDispatcher(down.agent);
    const offline = await ao(["zotero", "check-key"]);
    expect(offline.code).toBe(1);
    await down.agent.close();
    setGlobalDispatcher(z.agent);
    const none = useNoSecretStore();
    const noStore = await ao(["--json", "zotero", "check-key"]);
    none.restore();
    expect(noStore.code).toBe(1);
    const gone = useMemorySecrets();
    const noKey = await ao(["--json", "zotero", "check-key"]);
    gone.restore();
    expect(noKey.code).toBe(4);
  });

  it("check-key with no key exits 4", async () => {
    const empty = useMemorySecrets();
    try {
      const r = await ao(["zotero", "check-key"]);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain(ZOTERO_SYNC_REASON_TEXT["key-missing"]);
      expect(r.stderr).toContain("ao secrets set zotero-api-key");
      expect(r.stdout).toBe("");
      const j = await ao(["--json", "zotero", "check-key"]);
      expect(j.code).toBe(4);
      expect(json(j)).toMatchObject({ error: ZOTERO_SYNC_REASON_TEXT["key-missing"], code: 4 });
      // No request at all without a key.
      expect(z.requests).toEqual([]);
    } finally {
      empty.restore();
      secrets = useMemorySecrets();
      await setSecret("zotero-api-key", z.key);
    }
  });

  it("FR-507: a key check that works clears the pauses Zotero's refusals set, as the app's does; an undo's pause stays", async () => {
    z.addGroup(9, "Fieldwork group");
    const other = "group:10";
    const gone = "group:11";
    await linked(link(U, { paused: "key-refused" }), link(G, { paused: "library-gone" }), link(other, { paused: "undone" }), link(gone, { paused: "library-gone" }));
    const r = await ao(["zotero", "check-key"]);
    expect(r.code, r.stderr).toBe(0);
    const after = (await readZoteroSyncSettings(config, libraryId)).links.map((l) => [l.ref, l.paused]);
    // key-refused everywhere; library-gone where the key now reads the library; the researcher's own undo is theirs.
    expect(after).toEqual([
      [U, undefined],
      [G, undefined],
      [other, "undone"],
      [gone, "library-gone"],
    ]);
    // A check that fails clears nothing.
    await linked(link(U, { paused: "key-refused" }));
    z.revokeKey();
    expect((await ao(["zotero", "check-key"])).code).toBe(1);
    expect((await readZoteroSyncSettings(config, libraryId)).links[0]!.paused).toBe("key-refused");
  });

  it("FR-507 (R474): check-key clears the key's pauses for every library the settings file lists, in one write, keeps an undo's pause, and says how many links sync again", async () => {
    z.addGroup(9, "Fieldwork group");
    const other = "group:10";
    const gone = "group:11";
    // A library this computer's settings file lists but the libraries list does not (forgotten, or on a drive that is away).
    const away = "AwayLibrary01";
    await linked(link(U, { paused: "key-refused" }), link(G, { paused: "library-gone" }), link(other, { paused: "undone" }));
    await writeZoteroSyncSettings(config, away, { automatic: true, everyMinutes: 60, links: [link(U, { paused: "key-refused" }), link(G, { paused: "library-gone" }), link(gone, { paused: "library-gone" })] });
    const r = await ao(["zotero", "check-key"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["This key can read your library and 1 group library.", zoteroSyncsAgainLine(4)]);
    expect(zoteroSyncsAgainLine(1)).toBe("Syncing is on again for 1 linked Zotero library.");
    expect(zoteroSyncsAgainLine(4)).toBe("Syncing is on again for 4 linked Zotero libraries.");
    expect((await readZoteroSyncSettings(config, libraryId)).links.map((l) => [l.ref, l.paused])).toEqual([
      [U, undefined],
      [G, undefined],
      [other, "undone"],
    ]);
    const there = await readZoteroSyncSettings(config, away);
    expect(there.links.map((l) => [l.ref, l.paused])).toEqual([
      [U, undefined],
      [G, undefined],
      [gone, "library-gone"],
    ]);
    expect(there.automatic).toBe(true);
    // Nothing paused by the key any more: nothing of the kind is said; in JSON, the count.
    const again = await ao(["--json", "zotero", "check-key"]);
    expect(again.code, again.stderr).toBe(0);
    expect(json(again)).toMatchObject({ summary: "This key can read your library and 1 group library.", syncsAgain: 0 });
    const plain = await ao(["zotero", "check-key"]);
    expect(plain.stdout.trim()).toBe("This key can read your library and 1 group library.");
    expect(plain.stderr).toBe("");
  });

  it("FR-507 (R474): a damaged settings file set aside by check-key is said, as the app says it; a file that cannot be read or changed is said and exits 1", async () => {
    await writeFile(join(config, ZOTERO_SYNC_FILE), "{ not json");
    const r = await ao(["zotero", "check-key"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("This key can read your library.");
    expect(r.stderr.trim()).toBe(ZOTERO_SYNC_SENTENCES.settingsSetAside);
    expect((await readdir(config)).some((f) => f.startsWith(`${ZOTERO_SYNC_FILE}.unreadable-`))).toBe(true);
    const j = await ao(["--json", "zotero", "check-key"]);
    expect(json(j).notes ?? []).toEqual([]);
    await writeFile(join(config, ZOTERO_SYNC_FILE), "{ not json");
    const k = await ao(["--json", "zotero", "check-key"]);
    expect(json(k)).toMatchObject({ syncsAgain: 0, notes: [ZOTERO_SYNC_SENTENCES.settingsSetAside] });
    // Not readable at all (here: a folder where the file should be): said, exit 1; no path is printed.
    await rm(join(config, ZOTERO_SYNC_FILE), { force: true });
    await mkdir(join(config, ZOTERO_SYNC_FILE));
    const bad = await ao(["zotero", "check-key"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout.trim()).toBe("This key can read your library.");
    expect(bad.stderr.trim()).toBe(ZOTERO_SYNC_SENTENCES.keyPausesNotCleared);
    expect(ZOTERO_SYNC_SENTENCES.keyPausesNotCleared).toBe("This computer's Zotero sync settings could not be read or changed, so a Zotero library paused because of the key stays paused. Run the check again in a moment.");
    for (const out of [r, bad]) expect(out.stdout + out.stderr).not.toContain(config);
  });

  it("FR-507 (R482 a): a settings file written by a newer version is left as it is by check-key, and the app's sentence for it is said; nothing says syncing is on again", async () => {
    const file = join(config, ZOTERO_SYNC_FILE);
    const text = JSON.stringify({ v: 2, libraries: { [libraryId]: { automatic: true, everyMinutes: 60, links: [link(U, { paused: "key-refused" })] } } });
    await writeFile(file, text);
    const r = await ao(["zotero", "check-key"]);
    expect(r.code, r.stderr).toBe(0);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(r.stdout.trim()).toBe("This key can read your library.");
    expect(r.stderr.trim()).toBe(ZOTERO_SYNC_SENTENCES.settingsNewer);
    expect(ZOTERO_SYNC_SENTENCES.settingsNewer).toBe("These sync settings were written by a newer version of the app. Update the app to change them.");
    const j = await ao(["--json", "zotero", "check-key"]);
    expect(j.code, j.stderr).toBe(0);
    expect(json(j)).toMatchObject({ syncsAgain: 0, notes: [ZOTERO_SYNC_SENTENCES.settingsNewer] });
    expect(r.stdout + r.stderr).not.toContain("Syncing is on again");
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("R299 a: check-key obeys a back-off an earlier run recorded: it asks Zotero nothing, says the sentence with its time, exits 1; with the wait in the past it checks as before", async () => {
    articles(2);
    await linked(link(U));
    z.backoffOnce(7200);
    expect((await ao(["zotero", "sync"])).code).toBe(1);
    expect((await history())[0]!.backoffUntil).toBeDefined();
    const n = z.requests.length;
    const r = await ao(["zotero", "check-key"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Zotero asked this app to wait until");
    const j = await ao(["--json", "zotero", "check-key"]);
    expect(j.code).toBe(1);
    expect(json(j).error).toContain("Zotero asked this app to wait until");
    // Zero requests of any kind.
    expect(z.requests.length).toBe(n);
    // Another library of this computer recorded it: the same wait (a back-off is Zotero's answer to this computer's requests).
    const other = join(tmp, "Other");
    const made = await ao(["--json", "library", "create", other, "--name", "Other"]);
    expect(made.code, made.stderr).toBe(0);
    const fromOther = await ao(["zotero", "check-key"], { AO_LIBRARY: other });
    expect(fromOther.code).toBe(1);
    expect(fromOther.stderr).toContain("Zotero asked this app to wait until");
    expect(z.requests.length).toBe(n);
    // In the past: it checks.
    const file = join(config, ZOTERO_SYNC_HISTORY_FILE);
    const doc = JSON.parse(await readFile(file, "utf8"));
    for (const x of doc.libraries[libraryId]) if (x.backoffUntil) x.backoffUntil = new Date(Date.now() - 60_000).toISOString();
    await writeFile(file, JSON.stringify(doc));
    const again = await ao(["zotero", "check-key"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.trim()).toBe("This key can read your library.");
    expect(z.requests.length).toBeGreaterThan(n);
  });

  it("with no password store it says so and exits 1", async () => {
    const none = useNoSecretStore();
    try {
      const r = await ao(["zotero", "check-key"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(ZOTERO_SYNC_REASON_TEXT["no-store"]);
    } finally {
      none.restore();
    }
  });
});

describe("ao zotero sync", () => {
  it("sync prints an honest failure and exits 1", async () => {
    articles(2);
    await linked(link(U));
    z.failNext(500, 500);
    const r = await ao(["zotero", "sync"]);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toContain("Could not sync with Zotero");
    expect(r.stdout).not.toMatch(/up to date|nothing has changed|Last synced|✓/iu);
    const [rec] = await history();
    expect(rec).toMatchObject({ ref: U, outcome: "failed", trigger: "manual" });
    // The line printed is the shared one for the record the engine wrote.
    expect(r.stdout).toContain(zoteroSyncStatusLine(rec as SharedRun, new Date()).slice(0, 40));
  });

  it("sync runs each linked library once, in order, and records them as manual", async () => {
    z.addGroup(9, "Fieldwork group");
    articles(3, U);
    articles(2, G);
    await linked(link(G), link(U));
    const r = await ao(["zotero", "sync"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(G);
    expect(lines[1]).toContain(U);
    expect(lines[0]).toContain("Last synced with Zotero");
    // Settings' order; once each; manual.
    const recs = (await history()).slice().reverse();
    expect(recs.map((x) => [x.ref, x.trigger, x.outcome])).toEqual([
      [G, "manual", "finished"],
      [U, "manual", "finished"],
    ]);
    const first = (re: RegExp) => z.requests.findIndex((q) => re.test(q.path));
    expect(first(/^\/groups\/9\/items/u)).toBeGreaterThanOrEqual(0);
    expect(first(/^\/groups\/9\/items/u)).toBeLessThan(first(/^\/users\/42\/items/u));
    // The sources are in the project: the same engine, the same records as the service's own run.
    const again = await ao(["zotero", "sync"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("nothing has changed");
  });

  it("a paused link is not run", async () => {
    z.addGroup(9, "G");
    articles(2, U);
    articles(2, G);
    await linked(link(G, { paused: "key-refused" }), link(U));
    const r = await ao(["zotero", "sync"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${G}: ${ZOTERO_SYNC_REASON_TEXT["key-refused"]}`);
    expect(z.requests.filter((q) => q.path.startsWith("/groups/9/"))).toEqual([]);
    expect((await history()).map((x) => x.ref)).toEqual([U]);
    // Every link paused, or the one named paused: nothing runs, the reason is said, the researcher has to act (4).
    await linked(link(U, { paused: "undone" }));
    const n = z.requests.length;
    const all = await ao(["zotero", "sync"]);
    expect(all.code).toBe(4);
    expect(`${all.stdout}${all.stderr}`).toContain(ZOTERO_SYNC_SENTENCES.allPaused);
    const named = await ao(["zotero", "sync", "--ref", U]);
    expect(named.code).toBe(4);
    expect(`${named.stdout}${named.stderr}`).toContain(ZOTERO_SYNC_REASON_TEXT["sync-undone"]);
    expect(z.requests.length).toBe(n);
  });

  it("nothing linked says so and exits 4", async () => {
    const r = await ao(["zotero", "sync"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain(ZOTERO_SYNC_SENTENCES.nothingLinked);
    expect(z.requests).toEqual([]);
  });

  it("a back-off is respected: no request, the sentence, the exit code", async () => {
    z.addGroup(9, "G");
    articles(2, U);
    articles(2, G);
    await linked(link(U), link(G));
    // Zotero asks the command line to wait during the first library: the second is not asked for anything.
    z.backoffOnce(7200);
    const r = await ao(["zotero", "sync"]);
    expect(r.code).toBe(1);
    const recs = await history();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ ref: U, outcome: "failed", reason: "backing-off" });
    expect(recs[0]!.backoffUntil).toBeDefined();
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Zotero asked this app to wait until");
    expect(lines[1]).toContain(`${G}: Not synced.`);
    expect(lines[1]).toContain("Zotero asked this app to wait until");
    expect(z.requests.filter((q) => q.path.startsWith("/groups/9/"))).toEqual([]);
  });

  it("a back-off recorded by an earlier run is respected by the next command: no request, the sentence with its time, the exit code", async () => {
    articles(2);
    await linked(link(U));
    z.backoffOnce(7200);
    const first = await ao(["zotero", "sync"]);
    expect(first.code).toBe(1);
    const [rec] = await history();
    expect(rec!.backoffUntil).toBeDefined();
    const n = z.requests.length;
    // In the future: nothing is asked, nothing recorded, the sentence names the time.
    const r = await ao(["zotero", "sync"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Zotero asked this app to wait until");
    expect(r.stdout).toBe("");
    expect(z.requests.length).toBe(n);
    expect(await history()).toHaveLength(1);
    const j = await ao(["--json", "zotero", "sync"]);
    expect(j.code).toBe(1);
    expect(json(j).error).toContain("Zotero asked this app to wait until");
    expect(z.requests.length).toBe(n);
    // In the past: it runs.
    const file = join(config, ZOTERO_SYNC_HISTORY_FILE);
    const doc = JSON.parse(await readFile(file, "utf8"));
    for (const x of doc.libraries[libraryId]) if (x.backoffUntil) x.backoffUntil = new Date(Date.now() - 60_000).toISOString();
    await writeFile(file, JSON.stringify(doc));
    const again = await ao(["zotero", "sync"]);
    expect(again.code, again.stderr).toBe(0);
    expect(z.requests.length).toBeGreaterThan(n);
    expect((await history())[0]).toMatchObject({ outcome: "finished" });
  });

  it("a run the project's rules deny exits 2, and says the shared sentence, not the engine's", async () => {
    // An encrypted project that is not declared free of identifiable data: the rules refuse an import of it.
    const made = await ao(["--json", "project", "create", "Strict", "--encrypt", "--capture", "zotero_import"]);
    expect(made.code, made.stderr).toBe(0);
    articles(1);
    await linked(link(U, { projectId: json(made).id }));
    const r = await ao(["zotero", "sync"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(ZOTERO_SYNC_REASON_TEXT["rules-denied"]);
    expect(r.stdout).not.toContain("legal basis");
    expect((await history())[0]).toMatchObject({ outcome: "failed", reason: "rules-denied" });
    const j = await ao(["--json", "zotero", "sync"]);
    expect(j.code).toBe(2);
    expect(json(j).runs[0].run.reason).toBe("rules-denied");
  });

  it("a library held by the app is read-only: nothing runs", async () => {
    articles(2);
    await linked(link(U));
    // The app (another device) holds the library: the command line has it read-only, says so in the existing words, runs nothing.
    const held = await openLibrary(libPath, { ...deviceDeps(join(tmp, "other-config")), deviceId: "other-device", hostname: "other-host", settleMs: 0, isPidAlive: () => true });
    try {
      expect(held.mode).toBe("read-write");
      const r = await ao(["zotero", "sync"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("open read-only");
      expect(z.requests).toEqual([]);
      expect(await history()).toEqual([]);
      const j = await ao(["--json", "zotero", "sync"]);
      expect(j.code).toBe(1);
      expect(json(j).error).toContain("open read-only");
    } finally {
      await held.close();
    }
  });

  it("the library held by the command line makes the app read-only, as today", async () => {
    const s = await openSession({ library: libPath, write: true });
    try {
      const app = await openLibrary(libPath, { ...deviceDeps(join(tmp, "other-config")), deviceId: "other-device", hostname: "other-host", settleMs: 0, isPidAlive: () => true });
      try {
        expect(app.mode).toBe("read-only");
        expect(app.readOnlyReason).toBe("locked-by-other-device");
      } finally {
        await app.close();
      }
    } finally {
      await s.close();
    }
  });

  it("--ref runs one library; an unknown ref is refused in words", async () => {
    z.addGroup(9, "G");
    articles(2, U);
    articles(2, G);
    await linked(link(U), link(G));
    const one = await ao(["zotero", "sync", "--ref", G]);
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout.trim().split("\n")).toHaveLength(1);
    expect((await history()).map((x) => x.ref)).toEqual([G]);
    expect(z.requests.filter((q) => q.path.startsWith("/users/42/items"))).toEqual([]);
    const n = z.requests.length;
    const bad = await ao(["zotero", "sync", "--ref", "library:7"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(NOT_A_LIBRARY);
    const notLinked = await ao(["zotero", "sync", "--ref", "group:123"]);
    expect(notLinked.code).toBe(1);
    expect(notLinked.stderr).toContain(ZOTERO_SYNC_SENTENCES.notLinked);
    expect(z.requests.length).toBe(n);
  });

  it("R299 b: a refused --ref is never repeated, in text or in --json (a key typed there is in no output)", async () => {
    await linked(link(U));
    for (const args of [
      ["zotero", "sync", "--ref", KEY],
      ["zotero", "sync", `--ref=${KEY}`],
      ["--json", "zotero", "sync", "--ref", KEY],
      ["--json", "zotero", "sync", `--ref=${KEY}`],
      ["zotero", "sync", "--ref", "library:7"],
    ]) {
      const r = await ao(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(`${r.stdout}${r.stderr}`).not.toContain(KEY);
      expect(`${r.stdout}${r.stderr}`).not.toContain("library:7");
      if (args[0] === "--json") expect(json(r).error).toBe(NOT_A_LIBRARY);
      else expect(r.stderr.trim()).toBe(NOT_A_LIBRARY);
    }
    expect(z.requests).toEqual([]);
  });

  it("settings written by a newer version, or damaged, run nothing and say so", async () => {
    articles(1);
    await linked(link(U));
    const file = join(config, ZOTERO_SYNC_FILE);
    await writeFile(file, JSON.stringify({ v: 2, libraries: {} }));
    const newer = await ao(["zotero", "sync"]);
    expect(newer.code).toBe(1);
    expect(newer.stderr).toContain(ZOTERO_SYNC_SENTENCES.settingsNewer);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify({ v: 2, libraries: {} }));
    await writeFile(file, "{ this is not json");
    const damaged = await ao(["zotero", "sync"]);
    expect(damaged.code).not.toBe(0);
    expect(damaged.stderr).toMatch(/damaged|set aside/u);
    // FR-508: in the app's own words (its notice), then what the app says of a library with nothing linked.
    expect(damaged.stderr).toContain(ZOTERO_SYNC_SENTENCES.settingsSetAside);
    expect(damaged.stderr).toContain(ZOTERO_SYNC_SENTENCES.nothingLinked);
    expect(z.requests).toEqual([]);
  });

  it("R306 b: when the settings' damaged content cannot be set aside because another program holds their lock, it says so in the lock's sentence and runs nothing", async () => {
    articles(1);
    await linked(link(U));
    const file = join(config, ZOTERO_SYNC_FILE);
    await writeFile(file, "{ this is not json");
    const lock = `${file}.lock`;
    await writeFile(lock, JSON.stringify({ token: "c".repeat(32), at: new Date().toISOString() }), { mode: 0o600 });
    try {
      const r = await ao(["zotero", "sync"]);
      expect(r.code).toBe(1);
      expect(r.stderr.trim()).toBe("The Zotero sync settings are in use by another program. Try again.");
      const j = await ao(["--json", "zotero", "sync"]);
      expect(j.code).toBe(1);
      expect(json(j).error).toBe("The Zotero sync settings are in use by another program. Try again.");
      expect(await readFile(file, "utf8")).toBe("{ this is not json");
      expect(z.requests).toEqual([]);
    } finally {
      await rm(lock, { force: true });
    }
  }, 60_000);

  it("a locked project is unlocked as other commands unlock one, or its link is skipped with the sentence", async () => {
    const made = await ao(["--json", "project", "create", "Sealed", "--encrypt", "--not-identifiable", "--capture", "zotero_import"]);
    expect(made.code, made.stderr).toBe(0);
    const sealed = json(made).id as string;
    articles(2);
    await linked(link(U, { projectId: sealed }));
    // With no passphrase to give (a process of its own, with no terminal): skipped with the sentence.
    const skipped = await spawnAo(["zotero", "sync"]);
    expect(skipped.code).toBe(1);
    expect(skipped.stdout).toContain(`${U}: ${ZOTERO_SYNC_REASON_TEXT["project-locked"]}`);
    expect(z.requests).toEqual([]);
    expect(await history()).toEqual([]);
    const unlocked = await ao(["zotero", "sync"]);
    expect(unlocked.code, `${unlocked.stdout}|${unlocked.stderr}`).toBe(0);
    // Its counts are read from the project's own batch while it is unlocked: the line says what came in.
    expect(unlocked.stdout).toContain("2 new");
    expect((await history()).map((x) => [x.ref, x.outcome])).toEqual([[U, "finished"]]);
  });

  it("--json never holds the key", async () => {
    articles(2);
    await linked(link(U));
    const ok = await ao(["--json", "zotero", "sync"]);
    expect(ok.code, ok.stderr).toBe(0);
    const doc = json(ok);
    expect(doc.runs).toHaveLength(1);
    expect(doc.runs[0].run).toMatchObject({ ref: U, trigger: "manual", outcome: "finished" });
    expect(doc.runs[0].status).toBe(zoteroSyncStatusLine(doc.runs[0].run, new Date()));
    expect(ok.stdout).not.toContain(KEY);
    // A failure in JSON: still one object, the honest line beside the record.
    z.failNext(500, 500);
    await linked(link(U));
    const bad = await ao(["--json", "zotero", "sync"]);
    expect(bad.code).toBe(1);
    expect(json(bad).runs[0].run.outcome).toBe("failed");
    expect(json(bad).runs[0].status).toContain("Could not sync with Zotero");
    // Without a key: exit 4, the sentence, still no key.
    const empty = useMemorySecrets();
    try {
      const none = await ao(["--json", "zotero", "sync"]);
      expect(none.code).toBe(4);
      expect(none.stdout).toContain(ZOTERO_SYNC_REASON_TEXT["key-missing"]);
    } finally {
      empty.restore();
      secrets = useMemorySecrets();
      await setSecret("zotero-api-key", z.key);
    }
  });
});

describe("R299 d: the program's own messages repeat nothing that was typed", () => {
  /** Exit code, what kind of mistake it says, and that the usage text still follows; the key is in no output (afterEach). */
  async function refused(args: string[], kind: RegExp) {
    const r = await ao(args);
    expect(r.code, args.join(" ")).toBe(1);
    expect(`${r.stdout}${r.stderr}`).not.toContain(KEY);
    expect(r.stderr).toMatch(kind);
    return r;
  }

  it("a key as an unknown option of the program itself", async () => {
    const r = await refused([`--key=${KEY}`, "zotero", "check-key"], /unknown option/u);
    expect(r.stderr).toContain("Usage: ao");
    await refused([`--${KEY}`, "tools", "versions"], /unknown option/u);
    expect(z.requests).toEqual([]);
  });

  it("a key as an unknown option after another command", async () => {
    const r = await refused(["tools", "versions", `--key=${KEY}`], /unknown option/u);
    expect(r.stderr).toContain("Usage: ao tools versions");
    await refused(["library", "open", libPath, `--key=${KEY}`], /unknown option/u);
  });

  it("a key as an excess argument, and as an unknown command", async () => {
    const r = await refused(["tools", "versions", KEY], /too many arguments/u);
    expect(r.stderr).toContain("Usage: ao tools versions");
    await refused([KEY], /unknown command/u);
    await refused(["library", KEY], /unknown command/u);
  });

  it("R309 b: an invalid value for a known option or parameter names it by the program's own name, never the value", async () => {
    /** The program as `ao` builds it, with one more command whose option and parameter refuse values (no command of ao has one yet). */
    async function parse(args: string[]): Promise<{ stderr: string; code: string; exitCode: number }> {
      const program = buildProgram();
      let stderr = "";
      program.configureOutput({ writeErr: (t) => void (stderr += t), writeOut: () => undefined });
      program
        .command("probe")
        .addOption(new Option("--limit <n>", "how many").choices(["10", "20"]))
        .argument("[count]", "a number", (v: string) => {
          if (!/^\d+$/u.test(v)) throw new InvalidArgumentError(`"${v}" is not a number.`);
          return v;
        })
        .action(() => undefined);
      try {
        await program.parseAsync(args, { from: "user" });
      } catch (err) {
        const e = err as CommanderError;
        everything.push(stderr, e.message);
        return { stderr, code: e.code, exitCode: e.exitCode };
      }
      throw new Error("not refused");
    }
    const opt = await parse(["probe", "--limit", KEY]);
    expect([opt.code, opt.exitCode]).toEqual(["commander.invalidArgument", 1]);
    expect(opt.stderr).toContain("error: the value given for --limit is not valid (what you typed is not shown, in case it was a key). Allowed choices are 10, 20.");
    expect(opt.stderr).toContain("Usage: ao probe");
    const optEq = await parse(["probe", `--limit=${KEY}`]);
    expect(optEq.stderr).toContain("error: the value given for --limit is not valid (what you typed is not shown");
    const arg = await parse(["probe", KEY]);
    expect(arg.stderr).toContain("error: the value given for count is not valid (what you typed is not shown, in case it was a key)\n");
    for (const r of [opt, optEq, arg]) expect(r.stderr).not.toContain(KEY);
  });

  it("a missing argument still names the argument it wanted (the program's own word, not something typed)", async () => {
    const r = await ao(["library", "create"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing required argument");
  });

  it("the zotero group keeps its own fixed message for a word it does not understand (a key between `zotero` and its command)", async () => {
    const r = await refused(["zotero", `--key=${KEY}`, "check-key"], /That is not a zotero command ao understands/u);
    expect(r.stderr).toContain("ao zotero check-key");
    expect(z.requests).toEqual([]);
  });
});
