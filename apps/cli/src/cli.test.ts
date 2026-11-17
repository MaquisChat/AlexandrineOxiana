/**
 * End-to-end tests of the `ao` command: the CLI is spawned (from source, through tsx) against a
 * temporary library, with the fake yt-dlp / gallery-dl first on PATH and the real media worker
 * started from the venv made by `pnpm setup:py` (skipped when it is missing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devWorkerPython, openLibrary } from "@ao/library";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";

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
    expect(names).not.toContain("AO_WORKER_TOKEN"); // its own token arrives on standard input (R155)
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

describe("import, export, secrets and maintenance", () => {
  let lib: string;
  let papers: string;
  let elsewhere: string;
  const GOV_NO_LOOKUPS = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\nprocessing:\n  metadata_lookup: []\n";
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => ao(args, { AO_LIBRARY: lib, ...env });
  /** A project with the given governance.yaml (written over the one `project create` made). */
  async function projectWith(name: string, yaml: string): Promise<void> {
    const r = await run(["project", "create", name, "--not-identifiable"]);
    expect(r.code, r.stderr).toBe(0);
    await writeFile(join(lib, "Projects", name, "governance.yaml"), yaml);
  }

  beforeAll(async () => {
    lib = await newLibrary("Imports");
    papers = join(tmp, "Papers");
    elsewhere = join(tmp, "Elsewhere");
    await mkdir(join(papers, "Sub"), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(papers, "Okafor - 2024 - Feeding the City.pdf"), await buildPdf({ title: "Feeding the City", author: "Ngozi Okafor", extra: "cli one" }));
    await writeFile(join(papers, "Sub", "Bello - 2022 - Trader Survey.pdf"), await buildPdf({ title: "Trader Survey", author: "Amina Bello", extra: "cli two" }));
    await writeFile(join(elsewhere, "linked.pdf"), await buildPdf({ title: "Street Food and the State", author: "Tunde Adebayo", extra: "cli linked" }));
    await projectWith("Imp", GOV_NO_LOOKUPS);
    await projectWith("NoUpload", "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\ncaptureMethods: [refman_import]\n");
  }, 60_000);

  it("--dry-run --json prints a ScanSummary and exits 0 (nothing imported)", async () => {
    const r = await run(["--json", "import", papers, "--project", "Imp", "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    const s = json(r);
    expect(s).toMatchObject({ items: 2, byType: { pdf: 2 }, alreadyImported: 0, outsideFiles: [], unreadable: [] });
    expect(s.totalBytes).toBeGreaterThan(0);
    const listed = await run(["--json", "list", "--project", "Imp"]);
    expect(json(listed).sources).toEqual([]);
  }, 60_000);

  it("a denied import exits 2 with the reason on stderr", async () => {
    const r = await run(["import", papers, "--project", "NoUpload"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/rules do not allow/u);
    expect(r.stderr).toMatch(/manual_upload/u);
    expect(r.stderr).not.toContain(tmp);
  }, 60_000);

  it("R362 c: the library's own folder, a project's folder and a folder holding the library are refused, nothing imported", async () => {
    for (const dir of [lib, join(lib, "Projects", "Imp"), tmp]) {
      for (const extra of [["--dry-run"], []]) {
        const r = await run(["import", dir, "--project", "Imp", ...extra]);
        expect([r.code, r.stderr.includes(IN_LIBRARY_TEXT.folder)], r.stderr).toEqual([1, true]);
      }
    }
    expect(json(await run(["--json", "list", "--project", "Imp"])).sources).toEqual([]);
    expect(await readdir(join(lib, "Projects", "Imp"))).not.toContain("imports");
  }, 120_000);

  it("R368 a: a ZIP inside the library (a backup) and an export file inside it are refused whole, nothing imported", async () => {
    const zip = join(lib, "Backups", "Imp - backup.zip");
    const bib = join(lib, "Exports", "refs.bib");
    await writeFile(zip, "not read");
    await writeFile(bib, "@book{a, title = {Not read}}\n");
    for (const file of [zip, bib]) {
      for (const extra of [["--dry-run"], []]) {
        const r = await run(["import", file, "--project", "Imp", ...extra]);
        expect([r.code, r.stderr.includes(IN_LIBRARY_TEXT.importFile)], r.stderr).toEqual([1, true]);
      }
    }
    expect(json(await run(["--json", "list", "--project", "Imp"])).sources).toEqual([]);
    expect(await readdir(join(lib, "Projects", "Imp"))).not.toContain("imports");
    await rm(zip);
    await rm(bib);
  }, 120_000);

  it("imports a folder, then the same folder again finds the duplicates", async () => {
    const r = await run(["--json", "import", papers, "--project", "Imp", "--structure", "tags", "--duplicates", "skip"]);
    expect(r.code, r.stderr).toBe(0);
    const out = json(r);
    expect(out.state).toBe("finished");
    expect(out.counts.created + out.counts.needsReview).toBe(2);
    expect(JSON.stringify(out)).not.toContain(tmp);
    const again = await run(["import", papers, "--project", "Imp"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/duplicates 2/u);
  }, 120_000);

  it("R67 in the CLI: --dry-run lists outside files; --approve-folder / --approve-file attach them; --remember-folder remembers", async () => {
    const bibDir = join(tmp, "Refs");
    await mkdir(bibDir, { recursive: true });
    const bib = (key: string) => `@book{${key}, title = {Street Food and the State}, author = {Adebayo, Tunde}, year = {2019}, file = {${join(elsewhere, "linked.pdf")}}}\n`;
    await writeFile(join(bibDir, "a.bib"), bib("adebayo2019"));
    await projectWith("RefsA", GOV_NO_LOOKUPS.replace("processing", "captureMethods: [manual_upload, refman_import]\nprocessing"));
    await projectWith("RefsB", GOV_NO_LOOKUPS.replace("processing", "captureMethods: [manual_upload, refman_import]\nprocessing"));
    await projectWith("RefsC", GOV_NO_LOOKUPS.replace("processing", "captureMethods: [manual_upload, refman_import]\nprocessing"));

    const dry = await run(["--json", "import", join(bibDir, "a.bib"), "--project", "RefsA", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(json(dry).outsideFiles).toEqual([{ item: expect.any(String), folder: await realpath(elsewhere), file: await realpath(join(elsewhere, "linked.pdf")) }]);
    const dryText = await run(["import", join(bibDir, "a.bib"), "--project", "RefsA", "--dry-run"]);
    expect(dryText.stdout).toContain("--approve-folder");

    const plain = await run(["--json", "import", join(bibDir, "a.bib"), "--project", "RefsA"]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(json(plain).report.fileNotes).toEqual([expect.objectContaining({ note: expect.stringMatching(/not approved/u) })]);

    const folder = await run(["--json", "import", join(bibDir, "a.bib"), "--project", "RefsB", "--approve-folder", elsewhere, "--approve-folder", bibDir, "--remember-folder"]);
    expect(folder.code, folder.stderr).toBe(0);
    expect(json(folder).report.fileNotes).toEqual([]);
    expect(await readFile(join(tmp, "config", "approved-import-folders.json"), "utf8")).toContain(await realpath(elsewhere));

    const file = await run(["--json", "import", join(bibDir, "a.bib"), "--project", "RefsC", "--approve-file", join(elsewhere, "linked.pdf")]);
    expect(file.code, file.stderr).toBe(0);
    expect(json(file).report.fileNotes).toEqual([]);

    const bad = await run(["import", join(bibDir, "a.bib"), "--project", "RefsC", "--remember-folder"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--approve-folder");
  }, 120_000);

  it("export writes the chosen file atomically; a governance denial exits 2", async () => {
    const out = join(tmp, "exported.ris");
    const r = await run(["--json", "export", "--project", "RefsB", "--format", "ris", "--output", out]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r)).toMatchObject({ format: "ris", exported: 1, excluded: 0 });
    const text = await readFile(out, "utf8");
    expect(text).toContain("TY  - BOOK");
    expect(text).toContain("ID  - adebayo2019");
    expect(text).not.toContain("linked.pdf");
    const bib = await run(["export", "--project", "RefsB", "--format", "bibtex", "--output", join(tmp, "exported.bib")]);
    expect(bib.code, bib.stderr).toBe(0);
    expect(bib.stdout).toContain("Exported 1 source");
    const badFormat = await run(["export", "--project", "RefsB", "--format", "endnote", "--output", out]);
    expect(badFormat.code).toBe(1);

    await projectWith("Broken", GOV_NO_LOOKUPS);
    await run(["import", papers, "--project", "Broken"]);
    await writeFile(join(lib, "Projects", "Broken", "governance.yaml"), "identifiability: [not, valid\n");
    const denied = await run(["export", "--project", "Broken", "--format", "csl-json", "--output", join(tmp, "denied.json")]);
    expect(denied.code).toBe(2);
    expect(existsSync(join(tmp, "denied.json"))).toBe(false);
  }, 120_000);

  it("verify-audit checks the chain (exit 1 when it was changed); rebuild-index rebuilds", async () => {
    const ok = await run(["--json", "verify-audit", "--project", "Imp"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(json(ok)).toMatchObject({ ok: true, anchored: true });
    expect(json(ok).events).toBeGreaterThan(0);
    const auditDir = join(lib, "Projects", "Imp", "audit");
    const seg = join(auditDir, (await readdir(auditDir)).sort()[0]!);
    const lines = (await readFile(seg, "utf8")).split("\n");
    lines[0] = lines[0]!.replace('"actor":"', '"actor":"x');
    await writeFile(seg, lines.join("\n"));
    const broken = await run(["verify-audit", "--project", "Imp"]);
    expect(broken.code).toBe(1);
    expect(broken.stdout + broken.stderr).toMatch(/changed outside the app/u);

    const rb = await run(["--json", "rebuild-index"]);
    expect(rb.code, rb.stderr).toBe(0);
    expect(json(rb).indexed).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("the Zotero API key is never accepted on argv; AO_ZOTERO_API_KEY is read once and removed; no keyring → a plain refusal", async () => {
    const SECRET = "zk-SECRET-never-on-argv-123";
    const argv = await run(["secrets", "set", "zotero-api-key", SECRET]);
    expect(argv.code).toBe(1);
    expect(argv.stdout + argv.stderr).not.toContain(SECRET);
    const opt = await run(["secrets", "set", "zotero-api-key", `--key=${SECRET}`]);
    expect(opt.code).toBe(1);
    expect(opt.stdout + opt.stderr).not.toContain(SECRET);

    const env = await run(["--json", "secrets", "set", "zotero-api-key"], { AO_ZOTERO_API_KEY: SECRET });
    // This test machine has no keyring (no Secret Service): refused, nothing stored anywhere.
    expect([0, 1]).toContain(env.code);
    expect(env.stdout + env.stderr).not.toContain(SECRET);
    if (env.code === 1) expect(env.stderr).toContain("No secure key store");
    for (const f of await readdir(join(tmp, "config"))) expect(await readFile(join(tmp, "config", f), "utf8").catch(() => "")).not.toContain(SECRET);

    const unknown = await run(["secrets", "set", "github-token"], { AO_ZOTERO_API_KEY: SECRET });
    expect(unknown.code).toBe(1);

    // The worker (and anything else started) never sees it.
    const dump = join(tmp, "worker-env-zotero.json");
    const r = await ao(["tools", "versions"], {
      AO_WORKER_BIN: join(REPO_ROOT, "apps/cli/tests/stub-transcribe-worker.mjs"),
      AO_TEST_ENV_DUMP: dump,
      AO_ZOTERO_API_KEY: SECRET,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(await readFile(dump, "utf8"))).not.toContain("AO_ZOTERO_API_KEY");
  }, 60_000);

  it("review round 1 (R81 C1): verify-audit never heals; a truncated or emptied log exits 1; other commands show integrity warnings", async () => {
    await projectWith("AuditT", GOV_NO_LOOKUPS);
    await projectWith("AuditE", GOV_NO_LOOKUPS);
    for (const name of ["AuditT", "AuditE"]) expect((await run(["import", papers, "--project", name])).code).toBe(0);
    const segs = async (name: string) => {
      const d = join(lib, "Projects", name, "audit");
      return (await readdir(d)).sort().map((f) => join(d, f));
    };
    // Truncate the tail of one log; empty the other.
    const tSegs = await segs("AuditT");
    const last = tSegs.at(-1)!;
    const lines = (await readFile(last, "utf8")).split("\n").filter(Boolean);
    await writeFile(last, `${lines.slice(0, -2).join("\n")}\n`);
    for (const f of await segs("AuditE")) await writeFile(f, "");
    const before = await readFile(last, "utf8");

    const t = await run(["--json", "verify-audit", "--project", "AuditT"]);
    expect(t.code).toBe(1);
    expect(json(t)).toMatchObject({ ok: false, problem: { kind: "truncated" } });
    const e = await run(["verify-audit", "--project", "AuditE"]);
    expect(e.code).toBe(1);
    expect(e.stdout).toMatch(/NOT intact/u);
    // Nothing healed: the log is as it was, and checking again still fails.
    expect(await readFile(last, "utf8")).toBe(before);
    expect((await run(["verify-audit", "--project", "AuditT"])).code).toBe(1);

    // Any other command reports the problem (stderr, and --json), and records it in the log.
    const listed = await run(["--json", "list", "--project", "AuditT"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stderr).toMatch(/Warning: .*AuditT.*changed outside the app/u);
    expect(listed.stderr).not.toContain(tmp);
    expect(json(listed).integrityWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ project: "AuditT", kind: "truncated" })]));
    const after = await run(["verify-audit", "--project", "AuditT"]);
    expect(after.code).toBe(1);
    expect(after.stdout).toMatch(/the audit log was found altered on \d{4}-\d{2}-\d{2}/u);
  }, 180_000);

  it("verify-audit on a computer without the project's anchor: UNVERIFIED, exit 0 with a warning", async () => {
    const r = await run(["verify-audit", "--project", "RefsB"], { AO_CONFIG_DIR: join(tmp, "fresh-config") });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED (no anchor on this device)");
    expect(r.stderr).toMatch(/Warning/u);
  }, 60_000);

  it("review round 1 (R81 I1): the whole secrets group never echoes what was typed", async () => {
    const SECRET = "zk-SECRET-echo-check-987";
    for (const args of [
      ["secrets", "set", SECRET],
      ["secrets", "set", "zotero-api-key", SECRET],
      ["secrets", SECRET],
      ["secrets", `--${SECRET}`],
      ["secrets", "delete", SECRET],
      ["secrets", "delete", "zotero-api-key", SECRET],
      ["secrets", "set", "zotero-api-key", "--api-key", SECRET],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).not.toBe(0);
      expect(r.stdout + r.stderr, args.join(" ")).not.toContain(SECRET);
    }
  }, 120_000);

  it("review round 1: dry run honours the approve flags and reports a governance denial (exit 2); options are checked", async () => {
    const bibDir = join(tmp, "Refs2");
    await mkdir(bibDir, { recursive: true });
    await writeFile(join(bibDir, "b.bib"), `@book{dry2019, title = {Dry}, author = {Doe, Jane}, year = {2019}, file = {${join(elsewhere, "linked.pdf")}}}\n`);
    await projectWith("DryA", GOV_NO_LOOKUPS.replace("processing", "captureMethods: [manual_upload, refman_import]\nprocessing"));
    const approved = await run(["--json", "import", join(bibDir, "b.bib"), "--project", "DryA", "--dry-run", "--approve-file", join(elsewhere, "linked.pdf")]);
    expect(approved.code, approved.stderr).toBe(0);
    expect(json(approved).outsideFiles).toEqual([]);
    const denied = await run(["import", papers, "--project", "NoUpload", "--dry-run"]);
    expect(denied.code).toBe(2);
    expect(denied.stderr).toMatch(/rules do not allow/u);
    const zoteroOnly = await run(["import", papers, "--project", "Imp", "--web", "user:1"]);
    expect(zoteroOnly.code).toBe(1);
    expect(zoteroOnly.stderr).toContain("only with `import zotero`");
    const webDry = await run(["import", "zotero", "--project", "Imp", "--web", "user:42", "--dry-run"]);
    // No keyring on this test machine: a plain message about reading the key (not about saving it).
    expect([1, 4]).toContain(webDry.code);
    expect(webDry.stderr).not.toMatch(/was not saved/u);
  }, 120_000);

  it("review round 1: export --output to a folder or into a missing folder gives a plain message", async () => {
    const dir = await run(["export", "--project", "RefsB", "--format", "ris", "--output", tmp]);
    expect(dir.code).toBe(1);
    expect(dir.stderr).toMatch(/is a folder/u);
    expect(dir.stderr).not.toContain(tmp);
    const missing = await run(["export", "--project", "RefsB", "--format", "ris", "--output", join(tmp, "nope", "x.ris")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/folder .*does not exist/u);
  }, 60_000);

  it("review round 2 (R82): a deleted anchor does not hide a truncated or emptied log", async () => {
    await projectWith("AnchT", GOV_NO_LOOKUPS);
    await projectWith("AnchE", GOV_NO_LOOKUPS);
    expect((await run(["import", papers, "--project", "AnchT"])).code).toBe(0); // a log with several events
    const segs = async (name: string) => {
      const d = join(lib, "Projects", name, "audit");
      return (await readdir(d)).sort().map((f) => join(d, f));
    };
    const anchors = join(tmp, "config", "audit-anchors.json");
    const t = (await segs("AnchT")).at(-1)!;
    const lines = (await readFile(t, "utf8")).split("\n").filter(Boolean);
    await writeFile(t, `${lines.slice(0, -1).join("\n")}\n`);
    for (const f of await segs("AnchE")) await writeFile(f, "");
    await rm(anchors);

    const v1 = await run(["--json", "verify-audit", "--project", "AnchT"]);
    expect(v1.code).toBe(1);
    expect(json(v1).problem.kind).toBe("anchor-missing");
    const ve = await run(["verify-audit", "--project", "AnchE"]);
    expect(ve.code).toBe(1);

    const any = await run(["list", "--project", "AnchT"]);
    expect(any.code, any.stderr).toBe(0);
    expect(any.stderr).toMatch(/Warning: AnchT: .*record of the log's head is missing/u);
    const events = (await Promise.all((await segs("AnchT")).map((f) => readFile(f, "utf8")))).join("");
    expect(events).toContain('"action":"audit.anchor-missing"');
    const v2 = await run(["verify-audit", "--project", "AnchT"]);
    expect(v2.code).toBe(1);
    expect(v2.stdout).toMatch(/found altered on/u);

    // --json errors carry the integrity warnings too (the earlier open recorded AnchE's state: tamper again).
    for (const f of await segs("AnchE")) await writeFile(f, "");
    const err = await run(["--json", "export", "--project", "AnchE", "--format", "endnote", "--output", join(tmp, "x.ris")]);
    expect(err.code).toBe(1);
    expect(JSON.parse(err.stdout)).toMatchObject({ error: expect.any(String), code: 1, integrityWarnings: expect.arrayContaining([expect.objectContaining({ project: "AnchE" })]) });
    // The CLI's own settings folder is private.
    expect((await stat(join(tmp, "config"))).mode & 0o777).toBe(0o700);
  }, 180_000);

  it("import zotero needs --data-dir or --web; a bad --web is refused", async () => {
    const none = await run(["import", "zotero", "--project", "Imp"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("--data-dir");
    const bad = await run(["import", "zotero", "--project", "Imp", "--web", "user:abc"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("user:<id>");
    const missing = await run(["import", "zotero", "--project", "Imp", "--data-dir", join(tmp, "NoZotero")]);
    expect(missing.code).toBe(1);
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

describe("this computer's identity renewed by the command-line tool (Task 68 fix round 1, I2)", () => {
  it("a damaged device.json: the tool says so on standard error and the notice is written before it exits", async () => {
    const cfg = join(tmp, "config-renewed");
    await mkdir(cfg, { recursive: true });
    await writeFile(join(cfg, "device.json"), "garbage{");
    // A quick command that fails: the notice must be written all the same.
    const r = await ao(["library", "open", join(tmp, "no-such-library")], { AO_CONFIG_DIR: cfg });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/This computer's identity for the app could not be read and had to be renewed/);
    expect(r.stderr).not.toContain(cfg);
    const notices = JSON.parse(await readFile(join(cfg, "notices.json"), "utf8")) as { notices: Array<{ kind: string }> };
    expect(notices.notices.map((n) => n.kind)).toEqual(["device-identity-renewed"]);
    expect((await readdir(cfg)).filter((n) => n.startsWith("device.json.corrupt-"))).toHaveLength(1);
    // A second run reads the new identity: nothing said again.
    const again = await ao(["library", "open", join(tmp, "no-such-library")], { AO_CONFIG_DIR: cfg });
    expect(again.stderr).not.toMatch(/had to be renewed/);
  }, 60_000);
});
