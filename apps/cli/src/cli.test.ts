/**
 * End-to-end tests of the `ao` command: the CLI is spawned (from source, through tsx) against a
 * temporary library, with the fake yt-dlp / gallery-dl first on PATH and the real media worker
 * started from the venv made by `pnpm setup:py` (skipped when it is missing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devWorkerPython, openLibrary } from "@ao/library";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");
const FAKE_TOOLS = join(REPO_ROOT, "packages/library/tests/fixtures/fake-tools");
const HAVE_WORKER = existsSync(devWorkerPython()) || !!process.env.AO_WORKER_BIN;

const YT = "https://www.youtube.com/watch?v=aoTest00001&si=trackme&utm_source=share";
const YT_CONFLICT = "https://youtu.be/aoTest00002";
const PASS = "correct horse battery staple";

let tmp: string;
let libPath: string;
let baseEnv: NodeJS.ProcessEnv;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function start(args: string[], env: NodeJS.ProcessEnv = {}): { child: ChildProcess; done: Promise<Result> } {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const done = new Promise<Result>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  return { child, done };
}

const ao = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> => start(args, env).done;
const json = (r: Result): any => JSON.parse(r.stdout);

/** A fresh library for tests that need their own. */
async function newLibrary(name: string): Promise<string> {
  const p = join(tmp, name);
  const r = await ao(["library", "create", p, "--name", name]);
  expect(r.code, r.stderr).toBe(0);
  return p;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-cli-"));
  libPath = join(tmp, "Lib");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AO_") || k.startsWith("FAKE_") || k === "INIT_CWD") delete env[k];
  baseEnv = { ...env, PATH: `${FAKE_TOOLS}${delimiter}${process.env.PATH ?? ""}`, AO_CONFIG_DIR: join(tmp, "config"), AO_LIBRARY: libPath,
    // never pick up (or download into) the developer's own managed yt-dlp: the fake one on PATH is used
    AO_TOOLS_DIR: join(tmp, "tools"),
  };
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("library and project", () => {
  it("creates a library and opens it, in text and JSON", async () => {
    const created = await ao(["library", "create", libPath, "--name", "Study library"]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain('Created the library "Study library"');

    const opened = await ao(["library", "open", libPath]);
    expect(opened.code).toBe(0);
    expect(opened.stdout).toContain("Mode: read-write");

    const j = await ao(["--json", "library", "open", libPath]);
    expect(json(j)).toMatchObject({ name: "Study library", mode: "read-write" });
  });

  it("creates a project; --profile repeats and --capture is validated", async () => {
    const ok = await ao([
      "project", "create", "Study", "--profile", "irb", "--profile", "gdpr", "--capture", "downloader",
      "--protocol-number", "IRB-2026-001", "--not-identifiable", "--default-legal-basis", "public task (Art. 6(1)(e))",
    ]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Created the project "Study"  →  Projects/Study');
    const yaml = await readFile(join(libPath, "Projects", "Study", "governance.yaml"), "utf8");
    expect(yaml).toContain("irb");
    expect(yaml).toContain("gdpr");
    expect(yaml).toContain("downloader");
    expect(yaml).toContain("public task (Art. 6(1)(e))");

    const bad = await ao(["project", "create", "Other", "--capture", "downloader,teleport"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('"teleport" is not a capture method');
    const badProfile = await ao(["project", "create", "Other", "--profile", "nope"]);
    expect(badProfile.code).toBe(1);
  });

  it("an unencrypted project the rules forbid exits 2 and points at --encrypt", async () => {
    const r = await ao(["project", "create", "Plain", "--profile", "irb"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--encrypt");
  });

  it("error messages show no absolute paths", async () => {
    const again = await ao(["library", "create", libPath]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already contains a library");
    expect(again.stderr).not.toContain(tmp);
    expect(again.stderr).toContain("<library>");
  });

  it("--encrypt with no usable passphrase creates nothing (never a quiet unencrypted project)", async () => {
    const none = await ao(["project", "create", "NoPass", "--profile", "gdpr", "--encrypt"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("needs a passphrase");
    const empty = await ao(["project", "create", "NoPass", "--profile", "gdpr", "--encrypt"], { AO_PASSPHRASE: "" });
    expect(empty.code).toBe(1);
    const blank = await ao(["--json", "project", "create", "NoPass", "--not-identifiable", "--encrypt"], { AO_PASSPHRASE: "   " });
    expect(blank.code).toBe(1);
    const listing = await ao(["list", "--project", "NoPass"]);
    expect(listing.stderr).toContain('no project called "NoPass"');
  });

  it("the worker never sees AO_PASSPHRASE (or the token)", async () => {
    const dump = join(tmp, "worker-env.json");
    const r = await ao(["tools", "versions"], {
      AO_WORKER_BIN: join(REPO_ROOT, "apps/cli/tests/stub-transcribe-worker.mjs"),
      AO_TEST_ENV_DUMP: dump,
      AO_PASSPHRASE: "super secret words",
    });
    expect(r.code, r.stderr).toBe(0);
    const names = JSON.parse(await readFile(dump, "utf8")) as string[];
    expect(names).toContain("AO_WORKER_TOKEN"); // its own token, set by the app for it
    expect(names).not.toContain("AO_PASSPHRASE");
  });

  it("a read-only library prints the reason and refuses write commands", async () => {
    const p = await newLibrary("Busy");
    // Held by this process under another device id: the CLI sees it as in use elsewhere.
    const held = await openLibrary(p, {
      clock: () => new Date(),
      deviceId: "other-device",
      hostname: "other-host",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(tmp, "other-config"),
      settleMs: 0,
    });
    try {
      expect(held.mode).toBe("read-write");
      const open = await ao(["library", "open", p]);
      expect(open.stdout).toContain("Mode: read-only");
      expect(open.stdout).toContain("Read-only because");
      const write = await ao(["--library", p, "project", "create", "X", "--not-identifiable"]);
      expect(write.code).toBe(1);
      expect(write.stderr).toContain("open read-only");
    } finally {
      await held.close();
    }
  });
});

describe.skipIf(!HAVE_WORKER)("capture, with the real media worker and the fake tools", () => {
  let lib: string;

  beforeAll(async () => {
    lib = await newLibrary("Capture");
    const env = { AO_LIBRARY: lib };
    const mk = (name: string, ...extra: string[]) => ao(["project", "create", name, "--protocol-number", "IRB-1", "--not-identifiable", ...extra], env);
    expect((await mk("Open", "--profile", "irb", "--capture", "downloader", "--default-legal-basis", "public task")).code).toBe(0);
    expect((await mk("Manual", "--profile", "irb")).code).toBe(0);
  }, 60_000);

  const cap = (args: string[], env: NodeJS.ProcessEnv = {}) => ao(args, { AO_LIBRARY: lib, ...env });

  it("capture prints created with the library-relative folder, then duplicate", async () => {
    const first = await cap(["capture", YT, "--project", "Open", "--no-transcribe"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^created {2,}.+ {2}→ {2}Projects\/Open\/Sources\/.+/m);
    expect(first.stdout).not.toContain(tmp);
    expect(first.stderr).toContain("[1/1] created");

    const again = await cap(["capture", YT, "--project", "open", "--no-transcribe"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^duplicate /m);
  }, 60_000);

  it("--json parses, names no absolute path and no tracking parameter", async () => {
    const r = await cap(["--json", "capture", YT_CONFLICT, "--project", "Open", "--no-transcribe"]);
    expect(r.code, r.stderr).toBe(0);
    const doc = json(r);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ status: "needs-review", url: "https://www.youtube.com/watch?v=aoTest00002" });
    expect(doc.items[0].folder).toMatch(/^Projects\/Open\/Sources\//);
    expect(r.stdout).not.toContain(tmp);
    expect(r.stdout).not.toMatch(/token|trackme|utm_/i);

    const dup = await cap(["--json", "capture", `${YT}`, "--project", "Open", "--no-transcribe"]);
    expect(dup.stdout).not.toContain("trackme");
    expect(json(dup).items[0].url).toBe("https://www.youtube.com/watch?v=aoTest00001");
  }, 60_000);

  it("list and recheck show the planted conflict with its reason", async () => {
    const list = await cap(["list", "--project", "Open", "--needs-review"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("[needs review]");
    expect(list.stdout).not.toContain("Market day in Kumasi");

    const all = await cap(["list", "--project", "Open"]);
    expect(all.stdout).toContain("Market day in Kumasi");

    const r = await cap(["--json", "recheck", "--all", "--project", "Open"]);
    expect(r.code, r.stderr).toBe(0);
    const flagged = json(r).sources.filter((s: any) => s.fields.length > 0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].fields[0]).toMatchObject({ field: "/issued", status: "conflict" });
    expect(flagged[0].fields[0].reason).toMatch(/two different dates/);
    expect(r.stdout).not.toContain(tmp);

    const text = await cap(["recheck", "--all", "--project", "Open"]);
    expect(text.stdout).toMatch(/\/issued {2}conflict: The platform data gives two different dates/);

    const one = await cap(["recheck", "--project", "Open"]);
    expect(one.code).toBe(1);
    expect(one.stderr).toContain("--all");
  }, 60_000);

  it("recheck saves its result: a stale verification on disk is replaced and shows up again", async () => {
    const list = json(await cap(["--json", "list", "--project", "Open"]));
    const conflict = list.sources.find((x: any) => x.needsReview);
    expect(conflict).toBeTruthy();
    const file = join(lib, conflict.folder, "source.json");
    const sf = JSON.parse(await readFile(file, "utf8"));
    const real = sf.verification;
    sf.verification = {};
    await writeFile(file, JSON.stringify(sf, null, 2));
    expect((await cap(["list", "--project", "Open", "--needs-review"])).stdout).toContain("Nothing needs review");

    const r = await cap(["--json", "recheck", conflict.id, "--project", "Open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r).sources[0]).toMatchObject({ saved: true });
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.verification).toEqual(real);
    expect((await cap(["list", "--project", "Open", "--needs-review"])).stdout).toContain("[needs review]");

    const again = await cap(["recheck", conflict.id, "--project", "Open"]);
    expect(again.stdout).toContain("Nothing had changed");
  });

  it("capture follows the project's transcription setting by default (off) and --model is checked", async () => {
    const r = await cap(["--json", "capture", "https://www.youtube.com/watch?v=aoTest00002", "--project", "Fresh"]);
    expect(r.code).not.toBe(0); // no such project yet: plain error
    expect((await cap(["project", "create", "Fresh", "--profile", "irb", "--capture", "downloader", "--protocol-number", "IRB-2", "--not-identifiable"])).code).toBe(0);
    const ok = await cap(["--json", "capture", "https://www.youtube.com/watch?v=aoTest00002", "--project", "Fresh"]);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    const item = json(ok).items[0];
    const stored = JSON.parse(await readFile(join(lib, item.folder, "source.json"), "utf8"));
    expect(stored.assets.some((a: any) => a.kind === "transcript")).toBe(false);
    const badModel = await cap(["capture", YT, "--project", "Open", "--model", "huge"]);
    expect(badModel.code).toBe(1);
    const badModel2 = await cap(["capture-profile", "https://www.tiktok.com/@fake.dancer", "--project", "Open", "--model", "huge"]);
    expect(badModel2.code).toBe(1);
  });

  it("a project without the downloader exits 2 with the policy reason", async () => {
    const r = await cap(["capture", YT, "--project", "Manual", "--no-transcribe"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("failed");
    expect(r.stdout.toLowerCase()).toMatch(/downloader|capture method/);
  }, 60_000);

  it("--cookies-from-browser without acknowledgement exits 3 with the explanation; the flag lets it through", async () => {
    const denied = await cap(["capture", YT, "--project", "Open", "--no-transcribe", "--cookies-from-browser", "chrome"]);
    expect(denied.code).toBe(3);
    expect(denied.stderr).toContain("Platforms may restrict or suspend accounts");
    expect(denied.stderr).toContain("--acknowledge-cookies");

    const badBrowser = await cap(["capture", YT, "--project", "Open", "--cookies-from-browser", "netscape"]);
    expect(badBrowser.code).toBe(1);

    const ok = await cap(["capture", YT, "--project", "Open", "--no-transcribe", "--cookies-from-browser", "chrome", "--acknowledge-cookies"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^duplicate /m);
    expect(ok.stdout + ok.stderr).not.toMatch(/cookie value|sessionid/i);
  }, 60_000);

  it("a failing tool run exits 1 with the plain reason", async () => {
    const r = await cap(["capture", "https://www.youtube.com/watch?v=aoTest09999", "--project", "Open", "--no-transcribe"], { PATH: `${await wrapper("login")}${delimiter}${baseEnv.PATH}` });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("failed");
    expect(r.stdout).toContain("needs a signed-in session");
    expect(r.stdout).toContain("--cookies-from-browser <browser>");
    expect(r.stdout).not.toContain("Use my browser session");
  }, 60_000);

  it("encrypted project: AO_PASSPHRASE unlocks, a missing passphrase is refused, recovery code is shown once", async () => {
    const env = { AO_PASSPHRASE: PASS };
    const created = await cap(["project", "create", "Secret", "--profile", "gdpr", "--capture", "downloader", "--encrypt"], env);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain("RECOVERY CODE");
    expect(created.stdout).toMatch(/shown only this once/);
    const code = /RECOVERY CODE[^\n]*\n\s+(\S[^\n]*)\n/.exec(created.stdout)?.[1];
    expect(code?.length).toBeGreaterThan(10);

    const noPass = await cap(["list", "--project", "Secret"]);
    expect(noPass.code).toBe(1);
    expect(noPass.stderr).toContain("AO_PASSPHRASE");

    const wrong = await cap(["list", "--project", "Secret"], { AO_PASSPHRASE: "nope" });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("not correct");

    const listed = await cap(["list", "--project", "Secret"], env);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("no sources yet");
  }, 120_000);

  it("a missing legal basis exits 4 with a hint; --legal-basis fixes it", async () => {
    const env = { AO_PASSPHRASE: PASS };
    expect((await cap(["project", "create", "Basis", "--profile", "gdpr", "--capture", "downloader", "--encrypt"], env)).code).toBe(0);
    const need = await cap(["capture", YT, "--project", "Basis", "--no-transcribe"], env);
    expect(need.code, need.stdout + need.stderr).toBe(4);
    expect(need.stdout).toContain("Record a legal basis");
    expect(need.stdout).toContain("--legal-basis");
    expect(need.stdout).toContain("--default-legal-basis");

    const fixed = await cap(["capture", YT, "--project", "Basis", "--no-transcribe", "--legal-basis", "consent (Art. 6(1)(a))"], env);
    expect(fixed.code, fixed.stdout + fixed.stderr).toBe(0);
    expect(fixed.stdout).toMatch(/^created /m);

    const withDefault = await cap(["project", "create", "Defaulted", "--profile", "gdpr", "--capture", "downloader", "--encrypt", "--default-legal-basis", "public task"], env);
    expect(withDefault.code).toBe(0);
    const viaDefault = await cap(["capture", YT, "--project", "Defaulted", "--no-transcribe"], env);
    expect(viaDefault.code, viaDefault.stdout + viaDefault.stderr).toBe(0);
  }, 180_000);

  it("capture-profile prints the report summary and re-running finds nothing new", async () => {
    const profile = join(tmp, "profile.json");
    const T0 = 1767312000;
    await writeFile(
      profile,
      JSON.stringify({
        platform: "tiktok",
        handle: "fake.dancer",
        displayName: "Fake Dancer",
        bio: "Synthetic test profile.",
        links: [],
        avatar: "https://p16.example/avatar.jpeg",
        followers: 10,
        following: 1,
        items: Array.from({ length: 3 }, (_, i) => ({ id: `710000000000000000${3 - i}`, caption: `Dance number ${3 - i}\n#dance`, timestamp: T0 + (3 - i) * 86400 })),
      }),
    );
    const bin = await wrapper("ok", { FAKE_PROFILE_FILE: profile });
    const env = { PATH: `${bin}${delimiter}${baseEnv.PATH}` };
    const r = await cap(["capture-profile", "https://www.tiktok.com/@fake.dancer?lang=en", "--project", "Open", "--since", "2025-01-01", "--max-items", "10"], env);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Profile capture finished.");
    expect(r.stdout).toMatch(/saved 3, already had 0/);
    expect(r.stderr).toMatch(/Captured \d+ of \d+ posts/);
    expect(r.stdout).not.toContain(tmp);

    const again = await cap(["--json", "capture-profile", "https://www.tiktok.com/@fake.dancer", "--project", "Open", "--since", "2025-01-01", "--max-items", "10"], env);
    expect(again.code, again.stderr).toBe(0);
    const doc = json(again);
    expect(doc).toMatchObject({ status: "completed", created: 0 });
    expect(again.stdout).not.toContain(tmp);

    const badDate = await cap(["capture-profile", "https://www.tiktok.com/@fake.dancer", "--project", "Open", "--since", "yesterday"]);
    expect(badDate.code).toBe(1);
    expect(badDate.stderr).toContain("YYYY-MM-DD");
  }, 120_000);

  it("a profile run paused by the platform's rate limit exits 4 and says to run it again", async () => {
    const profile = join(tmp, "profile-limited.json");
    const T0 = 1767312000;
    await writeFile(
      profile,
      JSON.stringify({
        platform: "tiktok", handle: "fake.limited", displayName: "Fake Limited", bio: "Synthetic.", links: [], avatar: "https://p16.example/a.jpeg",
        followers: 1, following: 1, rateLimitAfter: 1,
        items: Array.from({ length: 4 }, (_, i) => ({ id: `720000000000000000${4 - i}`, caption: `Post ${4 - i}`, timestamp: T0 + (4 - i) * 86400 })),
      }),
    );
    const bin = await wrapper("ratelimit", { FAKE_PROFILE_FILE: profile });
    const r = await cap(["capture-profile", "https://www.tiktok.com/@fake.limited", "--project", "Open"], { PATH: `${bin}${delimiter}${baseEnv.PATH}`, AO_RATE_LIMIT_WAIT_MS: "5" });
    expect(r.code, r.stdout + r.stderr).toBe(4);
    expect(r.stdout).toContain("Profile capture paused.");
    expect(r.stdout).toContain("Run the same command later");
  });

  it("transcribe adds a transcript (and flags) to a captured video source", async () => {
    const list = json(await cap(["--json", "list", "--project", "Open"]));
    const vid = list.sources.find((s: any) => s.title.includes("Market day in Kumasi"));
    expect(vid).toBeTruthy();
    // A stand-in worker answers the transcription: the fake download has no real audio.
    const stub = { AO_WORKER_BIN: join(REPO_ROOT, "apps/cli/tests/stub-transcribe-worker.mjs") };
    const r = await cap(["--json", "transcribe", vid.id, "--project", "Open", "--model", "small", "--language", "en"], stub);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const doc = json(r);
    expect(doc.flaggedSegments).toBe(1);
    expect(doc.files).toHaveLength(2);
    expect(doc.files.every((f: string) => f.startsWith("Projects/Open/Sources/"))).toBe(true);
    expect(r.stdout).not.toContain(tmp);

    const text = await cap(["transcribe", vid.title, "--project", "Open"], stub);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/^transcribed {2}.+ {2}→ {2}Projects\/Open\/Sources\//m);
    expect(text.stdout).toContain("flagged");

    // Without the stand-in, the fake file has no audio: the failure is plain, exit 1.
    const real = await cap(["transcribe", vid.id, "--project", "Open", "--model", "small"]);
    expect(real.code).toBe(1);
    expect(real.stderr).toContain("transcript could not be made");

    expect((await readdir(join(lib, ".tmp"))).filter((n) => /^(transcribe|capture|worker)-/.test(n))).toEqual([]);

    expect((await cap(["transcribe", vid.id, "--project", "Open", "--model", "huge"])).code).toBe(1);
    const badLang = await cap(["transcribe", vid.id, "--project", "Open", "--language", "e n"]);
    expect(badLang.code).toBe(1);
    expect(badLang.stderr).toContain("not a language code");

    const none = await cap(["transcribe", "zzzzzzzz", "--project", "Open"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No source");
  });

  it("Ctrl+C (SIGINT) stops the downloader, closes everything and releases the library lock", async () => {
    const mark = join(tmp, "started");
    const bin = await wrapper("sleep", { mark });
    const { child, done } = start(["capture", "https://www.youtube.com/watch?v=aoTest07777", "--project", "Open", "--no-transcribe"], {
      AO_LIBRARY: lib,
      PATH: `${bin}${delimiter}${baseEnv.PATH}`,
    });
    for (let i = 0; i < 200 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(mark), "the download should have started").toBe(true);
    child.kill("SIGINT");
    const r = await done;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("Stopping");
    // the fake download (the downloader's child process) is gone too
    const pid = Number((await readFile(mark, "utf8")).trim());
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r2) => setTimeout(r2, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive, "the downloader's child process should have ended").toBe(false);

    const check = await openLibrary(lib, {
      clock: () => new Date(),
      deviceId: "checker",
      hostname: "checker-host",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(tmp, "checker-config"),
      settleMs: 0,
    });
    try {
      expect(check.mode, `read-only because ${check.readOnlyReason}`).toBe("read-write");
    } finally {
      await check.close();
    }
  }, 120_000);

  it("tools versions and tools update use the worker", async () => {
    const v = await ao(["--json", "tools", "versions"]);
    expect(v.code, v.stderr).toBe(0);
    expect(json(v).versions).toHaveProperty("yt_dlp");
    const text = await ao(["tools", "versions"]);
    expect(text.stdout).toMatch(/yt_dlp\s+2026\.10\.22/);

    const u = await ao(["--json", "tools", "update"]);
    expect(u.code, u.stderr).toBe(0);
    expect(json(u).ytDlp).toMatchObject({ managed: false, old: "2026.10.22", new: "2026.10.22" });
    const ut = await ao(["tools", "update"]);
    expect(ut.stdout).toContain("provided by your system");
  }, 60_000);
});

/** A folder with yt-dlp / gallery-dl wrappers (for modes and extra environment the worker would not pass on). */
async function wrapper(mode: string, env: Record<string, string> = {}): Promise<string> {
  // (the worker passes only some of its environment on to the tools, so values are written into the scripts)
  const dir = await mkdtemp(join(tmp, "bin-"));
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n");
  for (const tool of ["yt-dlp", "gallery-dl"]) {
    const body =
      mode === "sleep"
        ? `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.10.22; exit 0; fi\necho $$ > "${env.mark}"\nexec sleep 60\n`
        : `#!/bin/sh\n${exports}\nexport FAKE_TOOL_MODE=${mode}\nexec "${join(FAKE_TOOLS, tool)}" "$@"\n`;
    await writeFile(join(dir, tool), body);
    await chmod(join(dir, tool), 0o755);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}
