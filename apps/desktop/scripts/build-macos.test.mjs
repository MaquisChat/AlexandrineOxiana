// The Mac build's logic that does not need a Mac (Task 37f): arguments, the per-architecture target,
// the resource layout (and that the Tauri configuration and the shell's Rust code agree with it), the
// service folder's identity check, reading a Mach-O file's minimum macOS, the signing order and the
// disk image's arguments. Only local temporary files; no network, no macOS tool.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  checkBuildInfo,
  dmgArgs,
  machOFiles,
  minOsReport,
  runWithRetries,
  MACOS_CONF,
  machoMinOs,
  macosTarget,
  minOsProblems,
  parseArgs,
  plan,
  RESOURCE_LAYOUT,
  SIGNING,
  signingPlan,
  stageResources,
  STAGE_FROM_TAURI,
  tauriArgs,
} from "./build-macos.mjs";
import { PINS } from "./node-release.mjs";

const root = mkdtempSync(join(tmpdir(), "ao-build-macos-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const DESKTOP = new URL("..", import.meta.url).pathname;

describe("parseArgs", () => {
  it("reads the options and refuses anything else", () => {
    assert.deepEqual(parseArgs([]), { dryRun: false, debugApp: false, arch: undefined });
    assert.deepEqual(parseArgs(["--", "--dry-run", "--debug-app", "--arch", "x64"]), { dryRun: true, debugApp: true, arch: "x64" });
    assert.deepEqual(parseArgs(["--dry-run", "--arch=arm64"]), { dryRun: true, debugApp: false, arch: "arm64" });
    assert.throws(() => parseArgs(["--arch", "x64"]), /--arch is for --dry-run only/);
    assert.throws(() => parseArgs(["--dry-run", "--arch", "ia32"]), /--arch takes arm64 or x64/);
    assert.throws(() => parseArgs(["--release"]), /unknown option --release/);
  });
});

describe("macosTarget", () => {
  it("names each architecture's triple, Node archive, worker pin set and download", () => {
    const a = macosTarget("arm64");
    assert.equal(a.triple, "aarch64-apple-darwin");
    assert.equal(a.label, "apple-silicon");
    assert.equal(a.node.key, "darwin-arm64");
    // FR-730 (R503 j): Apple Silicon on its complete pin set, every package of the bundle named.
    assert.equal(a.workerArgs[0], "--constraints");
    assert.match(a.workerArgs[1], /services\/media-worker\/packaging\/constraints-macos-arm64\.txt$/);
    assert.ok(existsSync(a.workerArgs[1]));
    assert.match(a.workerBundle, /apps\/desktop\/sidecars\/ao-worker-aarch64-apple-darwin$/);
    assert.equal(a.dmgName("0.1.0"), "Alexandrine-Oxiana-0.1.0-apple-silicon.dmg");

    const i = macosTarget("x64");
    assert.equal(i.triple, "x86_64-apple-darwin");
    assert.equal(i.label, "intel");
    assert.equal(i.node.key, "darwin-x64");
    // The Intel build is on its own older pin set (R133, ADR 0014).
    assert.equal(i.workerArgs[0], "--constraints");
    assert.match(i.workerArgs[1], /services\/media-worker\/packaging\/constraints-macos-x86_64\.txt$/);
    assert.ok(existsSync(i.workerArgs[1]));
    assert.equal(i.dmgName("0.1.0"), "Alexandrine-Oxiana-0.1.0-intel.dmg");
    assert.throws(() => macosTarget("ia32"), /arm64 or x64/);
  });
});

describe("the resource layout", () => {
  it("is where the shell looks (src-tauri/src/paths.rs) and what tauri.macos.conf.json copies", () => {
    assert.deepEqual(RESOURCE_LAYOUT, { node: "node/node", serviceEntry: "library-service/service.mjs", worker: "ao-worker/ao-worker" });
    const paths = readFileSync(join(DESKTOP, "src-tauri", "src", "paths.rs"), "utf8");
    assert.match(paths, /from_res\(&\["node", NODE_EXE\]\)/);
    assert.match(paths, /from_res\(&\["library-service"\]\)/);
    assert.match(paths, /from_res\(&\["ao-worker", WORKER_EXE\]\)/);
    const files = MACOS_CONF.bundle.macOS.files;
    assert.deepEqual(files, {
      "Resources/node": `${STAGE_FROM_TAURI}/node`,
      "Resources/library-service": `${STAGE_FROM_TAURI}/library-service`,
      "Resources/ao-worker": `${STAGE_FROM_TAURI}/ao-worker`,
    });
    assert.equal(STAGE_FROM_TAURI, "../.build/macos-resources");
  });

  it("puts the minimum macOS, the bundle and no signing in the Mac configuration", () => {
    const m = MACOS_CONF.bundle;
    assert.equal(m.macOS.minimumSystemVersion, PINS.minimumSystemVersion);
    assert.equal(PINS.minimumSystemVersion, "15.0");
    assert.equal(m.active, true);
    assert.deepEqual(m.targets, ["app"]);
    // Signing is the build script's, from macos/signing.json (Tauri builds with --no-sign).
    assert.equal(m.macOS.signingIdentity, undefined);
    assert.equal(m.macOS.hardenedRuntime, false);
    // The identifier stays defined in one place (tauri.conf.json).
    assert.equal(MACOS_CONF.identifier, undefined);
    // Nothing that would change the page's security (CSP, capabilities) is overridden for macOS.
    assert.equal(MACOS_CONF.app, undefined);
  });

  it("lets the page reach the loopback address (App Transport Security; Info.plist)", () => {
    const plist = readFileSync(join(DESKTOP, "src-tauri", "Info.plist"), "utf8");
    assert.match(plist, /<key>NSAppTransportSecurity<\/key>\s*<dict>\s*<key>NSAllowsLocalNetworking<\/key>\s*<true\/>\s*<\/dict>/);
    assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/);
  });

  // A small reader for the plist's top-level dictionary: keys with their value's tag and text. It checks that
  // the tags are balanced (so the file is well-formed XML for this simple shape) and throws otherwise.
  function readTopLevelPlist(xml) {
    const body = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "");
    const stack = [];
    const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
    const entries = [];
    let key = null;
    let valueStart = null;
    for (const t of tokens) {
      if (t.startsWith("<")) {
        const closing = t.startsWith("</");
        const selfClosing = t.endsWith("/>");
        const name = /^<\/?([A-Za-z]+)/.exec(t)?.[1];
        assert.ok(name, `unreadable tag ${t}`);
        if (closing) {
          assert.equal(stack.pop(), name, `unbalanced </${name}>`);
          if (stack.length === 2 && valueStart !== null && key !== null) {
            entries.push({ key, tag: name, text: valueStart.text ?? "" });
            key = null;
            valueStart = null;
          }
        } else if (selfClosing) {
          if (stack.length === 2 && key !== null) {
            entries.push({ key, tag: name, text: "" });
            key = null;
          }
        } else {
          stack.push(name);
          if (stack.length === 3 && name !== "key" && valueStart === null && key !== null) valueStart = { text: "" };
          if (stack.length === 3 && name === "key") {
            /* key text follows */
          }
        }
      } else if (stack.length === 3 && stack[2] === "key") {
        key = t;
      } else if (stack.length === 3 && valueStart !== null) {
        valueStart.text += t;
      }
    }
    assert.deepEqual(stack, [], "every tag is closed");
    return entries;
  }

  it("Info.plist declares NSFileProviderDomainUsageDescription", () => {
    const xml = readFileSync(join(DESKTOP, "src-tauri", "Info.plist"), "utf8");
    const entries = readTopLevelPlist(xml);
    const text = entries.find((e) => e.key === "NSFileProviderDomainUsageDescription");
    assert.ok(text, "the key is declared");
    assert.equal(text.tag, "string");
    assert.equal(
      text.text,
      "Alexandrine Oxiana reads the files in the cloud-drive folders you choose to watch, to copy them into your library. It never changes, moves or deletes them.",
    );
    // Nothing else in the plist changed: the App Transport Security entry is still there, and these are the only top-level keys.
    assert.deepEqual(entries.map((e) => e.key).sort(), ["NSAppTransportSecurity", "NSFileProviderDomainUsageDescription"]);
    assert.match(xml, /<key>NSAppTransportSecurity<\/key>\s*<dict>\s*<key>NSAllowsLocalNetworking<\/key>\s*<true\/>\s*<\/dict>/);
    // The comment above the key names Apple's page and the date it was read, as the App Transport Security comment does.
    assert.match(xml, /protected-resources,\s*read 2026-11-13/);
  });

  it("stages the three helpers, keeping the worker's symbolic links and the programs executable", () => {
    const src = mkdtempSync(join(root, "src-"));
    const node = join(src, "release", "bin", "node");
    mkdirSync(join(src, "release", "bin"), { recursive: true });
    writeFileSync(node, "node", { mode: 0o644 });
    const service = join(src, "service");
    mkdirSync(join(service, "node_modules", "x"), { recursive: true });
    writeFileSync(join(service, "service.mjs"), "//");
    writeFileSync(join(service, "node_modules", "x", "x.node"), "bin");
    const worker = join(src, "ao-worker-aarch64-apple-darwin");
    mkdirSync(join(worker, "_internal", "pkg", ".dylibs"), { recursive: true });
    writeFileSync(join(worker, "ao-worker"), "w", { mode: 0o755 });
    writeFileSync(join(worker, "_internal", "pkg", ".dylibs", "libz.dylib"), "z");
    symlinkSync("pkg/.dylibs/libz.dylib", join(worker, "_internal", "libz.dylib"));
    const stage = join(src, "stage");
    mkdirSync(join(stage, "stale"), { recursive: true });

    stageResources({ nodeExe: node, serviceDir: service, workerBundle: worker, stageDir: stage });
    assert.ok(!existsSync(join(stage, "stale")), "an earlier staging is removed");
    assert.equal(statSync(join(stage, "node", "node")).mode & 0o777, 0o755);
    assert.ok(existsSync(join(stage, "library-service", "service.mjs")));
    assert.ok(existsSync(join(stage, "library-service", "node_modules", "x", "x.node")));
    assert.ok(statSync(join(stage, "ao-worker", "ao-worker")).mode & 0o100);
    const link = join(stage, "ao-worker", "_internal", "libz.dylib");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), "pkg/.dylibs/libz.dylib");
  });

  it("refuses to stage without the service's entry point or the worker's program", () => {
    const src = mkdtempSync(join(root, "missing-"));
    writeFileSync(join(src, "node"), "n");
    mkdirSync(join(src, "svc"));
    mkdirSync(join(src, "w"));
    assert.throws(() => stageResources({ nodeExe: join(src, "node"), serviceDir: join(src, "svc"), workerBundle: join(src, "w"), stageDir: join(src, "s") }), /service\.mjs/);
    writeFileSync(join(src, "svc", "service.mjs"), "");
    assert.throws(() => stageResources({ nodeExe: join(src, "node"), serviceDir: join(src, "svc"), workerBundle: join(src, "w"), stageDir: join(src, "s") }), /packaged worker/);
  });
});

describe("checkBuildInfo", () => {
  const good = { platform: "darwin", arch: "arm64", node: PINS.node.version, nodeAbi: "127" };
  it("accepts a service folder built on this Mac by the pinned Node", () => {
    assert.deepEqual(checkBuildInfo(good, { arch: "arm64", nodeVersion: PINS.node.version }), []);
  });
  it("names a folder built elsewhere or by another Node", () => {
    const p = checkBuildInfo({ ...good, platform: "linux", arch: "x64", node: "v22.1.0" }, { arch: "arm64", nodeVersion: PINS.node.version });
    assert.equal(p.length, 3, p.join("\n"));
    assert.match(p.join("\n"), /linux/);
    assert.match(p.join("\n"), /x64/);
    assert.match(p.join("\n"), /v22\.1\.0/);
  });
});

// ---------- Mach-O ----------

const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;
const enc = (v) => {
  const [a, b = 0, c = 0] = v.split(".").map(Number);
  return (a << 16) | (b << 8) | c;
};
/** A thin 64-bit little-endian Mach-O header with the given load commands. */
function thin(cpu, cmds, filetype = 2) {
  const bodies = cmds.map(([cmd, v]) => {
    const b = Buffer.alloc(cmd === LC_BUILD_VERSION ? 24 : 16);
    b.writeUInt32LE(cmd, 0);
    b.writeUInt32LE(b.length, 4);
    if (cmd === LC_BUILD_VERSION) {
      b.writeUInt32LE(1, 8); // platform: macOS
      b.writeUInt32LE(enc(v), 12);
      b.writeUInt32LE(enc("26.0"), 16);
    } else {
      b.writeUInt32LE(enc(v), 8);
      b.writeUInt32LE(enc("26.0"), 12);
    }
    return b;
  });
  const h = Buffer.alloc(32);
  h.writeUInt32LE(0xfeedfacf, 0);
  h.writeUInt32LE(cpu, 4);
  h.writeUInt32LE(filetype, 12);
  h.writeUInt32LE(bodies.length, 16);
  h.writeUInt32LE(bodies.reduce((n, b) => n + b.length, 0), 20);
  return Buffer.concat([h, ...bodies]);
}
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
function fat(slices) {
  const head = Buffer.alloc(8 + 20 * slices.length);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(slices.length, 4);
  let offset = 4096;
  const parts = [];
  slices.forEach((s, i) => {
    head.writeUInt32BE(s.readUInt32LE(4), 8 + 20 * i);
    head.writeUInt32BE(offset, 8 + 20 * i + 8);
    head.writeUInt32BE(s.length, 8 + 20 * i + 12);
    parts.push({ offset, s });
    offset += 4096;
  });
  const out = Buffer.alloc(offset);
  head.copy(out, 0);
  for (const p of parts) p.s.copy(out, p.offset);
  return out;
}

describe("machoMinOs", () => {
  it("reads the minimum macOS from LC_BUILD_VERSION and from the older LC_VERSION_MIN_MACOSX", () => {
    assert.deepEqual(machoMinOs(thin(ARM64, [[LC_BUILD_VERSION, "15.0"]])), [{ cpu: "arm64", minos: "15.0" }]);
    assert.deepEqual(machoMinOs(thin(X86_64, [[LC_VERSION_MIN_MACOSX, "10.13"]])), [{ cpu: "x86_64", minos: "10.13" }]);
    assert.deepEqual(machoMinOs(thin(ARM64, [[LC_BUILD_VERSION, "14.2.1"]])), [{ cpu: "arm64", minos: "14.2.1" }]);
    assert.deepEqual(machoMinOs(thin(ARM64, [])), [{ cpu: "arm64", minos: null }]);
  });
  it("reads every slice of a universal file", () => {
    assert.deepEqual(machoMinOs(fat([thin(X86_64, [[LC_BUILD_VERSION, "10.9"]]), thin(ARM64, [[LC_BUILD_VERSION, "11.0"]])])), [
      { cpu: "x86_64", minos: "10.9" },
      { cpu: "arm64", minos: "11.0" },
    ]);
  });
  it("says null for anything that is not a Mach-O file (a script, a Java class file, a short file)", () => {
    assert.equal(machoMinOs(Buffer.from("#!/bin/sh\necho hi\n")), null);
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, 0, 0, 0, 0]);
    assert.equal(machoMinOs(javaClass), null);
    assert.equal(machoMinOs(Buffer.from([0xcf, 0xfa])), null);
  });
});

describe("machOFiles and minOsReport (a folder on disk)", () => {
  it("finds the regular Mach-O files, their type and minimum macOS, skipping links and other files", () => {
    const app = mkdtempSync(join(root, "app-"));
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources", "w", "_internal"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "prog"), thin(ARM64, [[LC_BUILD_VERSION, "15.0"]]));
    writeFileSync(join(app, "Contents", "Resources", "w", "_internal", "lib.dylib"), thin(ARM64, [[LC_BUILD_VERSION, "14.0"]], 6));
    writeFileSync(join(app, "Contents", "Resources", "w", "_internal", "x.o"), thin(ARM64, [[LC_BUILD_VERSION, "15.0"]], 1));
    writeFileSync(join(app, "Contents", "Resources", "w", "script.py"), "print('hello, this is long enough to be read')\n");
    symlinkSync("_internal/lib.dylib", join(app, "Contents", "Resources", "w", "lib.dylib"));
    const files = machOFiles(app).map((f) => ({ path: f.path.slice(app.length + 1), filetype: f.filetype, signable: f.signable, minos: f.slices[0].minos }));
    files.sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(files, [
      { path: "Contents/MacOS/prog", filetype: "execute", signable: true, minos: "15.0" },
      { path: "Contents/Resources/w/_internal/lib.dylib", filetype: "dylib", signable: true, minos: "14.0" },
      // An object file is not code that runs: it is not signed (codesign would refuse it).
      { path: "Contents/Resources/w/_internal/x.o", filetype: "object", signable: false, minos: "15.0" },
    ]);
    assert.deepEqual(minOsReport(app, "15.0"), { files: 3, newest: "15.0", none: 0, problems: [] });
    writeFileSync(join(app, "Contents", "Resources", "w", "_internal", "new.so"), thin(ARM64, [[LC_BUILD_VERSION, "26.0"]], 8));
    const r = minOsReport(app, "15.0");
    assert.equal(r.newest, "26.0");
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /^Contents\/Resources\/w\/_internal\/new\.so \(arm64\) needs macOS 26\.0/);
  });
});

describe("runWithRetries (the disk image)", () => {
  it("tries up to three times with a wait between, and keeps each failure's message", async () => {
    const waits = [];
    let n = 0;
    const r = await runWithRetries({ attempts: 3, wait: async (ms) => waits.push(ms), waitMs: 5000, run: () => (++n < 3 ? { ok: false, out: `hdiutil: create failed - Resource busy (${n})` } : { ok: true, out: "created" }) });
    assert.equal(n, 3);
    assert.deepEqual(waits, [5000, 5000]);
    assert.deepEqual(r, { ok: true, out: "created", failures: ["hdiutil: create failed - Resource busy (1)", "hdiutil: create failed - Resource busy (2)"] });
  });
  it("gives up after the last attempt with every message", async () => {
    let n = 0;
    await assert.rejects(
      runWithRetries({ attempts: 3, wait: async () => {}, waitMs: 1, run: () => ({ ok: false, out: `busy ${++n}` }) }),
      (e) => /3 attempts/.test(e.message) && /busy 1/.test(e.message) && /busy 2/.test(e.message) && /busy 3/.test(e.message),
    );
    assert.equal(n, 3);
  });
  it("does not retry what succeeded", async () => {
    let n = 0;
    const r = await runWithRetries({ attempts: 3, wait: async () => assert.fail("no wait"), waitMs: 1, run: () => (n++, { ok: true, out: "" }) });
    assert.equal(n, 1);
    assert.deepEqual(r.failures, []);
  });
});

describe("minOsProblems", () => {
  it("names each file that needs a newer macOS than the minimum, or states none", () => {
    const files = [
      { path: "Contents/MacOS/app", slices: [{ cpu: "arm64", minos: "15.0" }] },
      { path: "Contents/Resources/node/node", slices: [{ cpu: "arm64", minos: "11.0" }] },
      { path: "Contents/Resources/ao-worker/_internal/x.so", slices: [{ cpu: "arm64", minos: "15.4" }] },
      { path: "Contents/Resources/y.dylib", slices: [{ cpu: "arm64", minos: "26.0" }] },
      { path: "Contents/Resources/z.dylib", slices: [{ cpu: "arm64", minos: null }] },
    ];
    const p = minOsProblems(files, "15.0");
    assert.equal(p.length, 2, p.join("\n"));
    assert.match(p[0], /x\.so.*15\.4/);
    assert.match(p[1], /y\.dylib.*26\.0/);
  });
});

describe("signingPlan", () => {
  const app = "/b/Alexandrine Oxiana.app";
  const machO = [
    { path: `${app}/Contents/Resources/node/node`, signed: true },
    { path: `${app}/Contents/Resources/ao-worker/_internal/pkg/.dylibs/libz.dylib`, signed: false },
    { path: `${app}/Contents/Resources/ao-worker/ao-worker`, signed: true },
    { path: `${app}/Contents/Resources/library-service/node_modules/better-sqlite3/build/Release/better_sqlite3.node`, signed: false },
    { path: `${app}/Contents/MacOS/alexandrine-oxiana`, signed: true },
  ];

  it("ad hoc (R151): signs what is unsigned, deepest first, then the program, then the app; no hardened runtime, no timestamp", () => {
    assert.equal(SIGNING.identity, "-");
    const p = signingPlan({ app, machO, signing: SIGNING });
    assert.deepEqual(p.map((s) => s.path.slice(app.length) || "<app>"), [
      "/Contents/Resources/library-service/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "/Contents/Resources/ao-worker/_internal/pkg/.dylibs/libz.dylib",
      "/Contents/MacOS/alexandrine-oxiana",
      "<app>",
    ]);
    for (const s of p) {
      assert.deepEqual(s.args.slice(0, 3), ["--force", "--sign", "-"]);
      assert.ok(s.args.includes("--timestamp=none"));
      assert.ok(!s.args.includes("runtime"));
      assert.ok(!s.args.includes("--entitlements"));
      assert.equal(s.args.at(-1), s.path);
    }
  });

  it("with an identity (Task 37g): signs everything inside out with the hardened runtime, a timestamp and each part's entitlements", () => {
    const signing = { identity: "Developer ID Application: X (TEAM)", hardenedRuntime: true, entitlements: { app: "macos/app.entitlements", node: "macos/node.entitlements", worker: null } };
    const p = signingPlan({ app, machO, signing });
    assert.equal(p.length, machO.length + 1);
    assert.equal(p.at(-1).path, app);
    assert.equal(p.at(-2).path, `${app}/Contents/MacOS/alexandrine-oxiana`);
    for (const s of p) {
      assert.ok(s.args.includes("--timestamp"));
      assert.deepEqual(s.args.slice(s.args.indexOf("--options"), s.args.indexOf("--options") + 2), ["--options", "runtime"]);
    }
    const ent = (suffix) => {
      const s = p.find((x) => x.path.endsWith(suffix));
      const i = s.args.indexOf("--entitlements");
      return i < 0 ? null : s.args[i + 1];
    };
    assert.match(ent("/node/node"), /macos\/node\.entitlements$/);
    assert.match(ent("/MacOS/alexandrine-oxiana"), /macos\/app\.entitlements$/);
    assert.equal(ent("/ao-worker/ao-worker"), null);
    assert.equal(ent("better_sqlite3.node"), null, "a library gets no entitlements");
  });
});

describe("tauriArgs and dmgArgs", () => {
  it("bundles the .app only, unsigned, with the locked lock file", () => {
    assert.deepEqual(tauriArgs({ debug: false }), ["tauri", "build", "--ci", "--bundles", "app", "--no-sign", "--", "--locked"]);
    assert.deepEqual(tauriArgs({ debug: true }), ["tauri", "build", "--ci", "--debug", "--bundles", "app", "--no-sign", "--", "--locked"]);
  });
  it("makes a compressed disk image from a folder holding the app and a link to Applications", () => {
    assert.deepEqual(dmgArgs({ srcFolder: "/s", out: "/o/x.dmg" }), ["create", "-volname", "Alexandrine Oxiana", "-srcfolder", "/s", "-fs", "HFS+", "-format", "UDZO", "-ov", "/o/x.dmg"]);
  });
});

describe("the Mac workflow (.github/workflows/desktop-macos.yml)", () => {
  const wf = readFileSync(join(DESKTOP, "..", "..", ".github", "workflows", "desktop-macos.yml"), "utf8");
  /** The lines of a top-level key's block. */
  const block = (key) => {
    const lines = wf.split("\n");
    const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
    assert.ok(start >= 0, `no top-level ${key}`);
    const end = lines.findIndex((l, i) => i > start && /^[A-Za-z]/.test(l));
    return lines.slice(start, end < 0 ? undefined : end).filter((l) => l.trim() && !/^\s*#/.test(l));
  };

  it("starts only by hand, on a version tag, or on a branch push that changed the build-request file (R168); never on a pull request or a schedule", () => {
    const on = block("on").join("\n");
    assert.match(on, /^ {2}workflow_dispatch:/m);
    // The whole push trigger, exactly: version tags; and the named branches ONLY for the one path.
    assert.match(on, /^ {2}push:\n {4}tags:\n {6}- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+\*"\n {4}branches:\n {6}- "claude\/\*\*"\n {6}- main\n {4}paths:\n {6}- apps\/desktop\/mac-build-request\.json$/m);
    const triggers = block("on").map((l) => /^ {2}([a-z_]+):/.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(triggers, ["workflow_dispatch", "push"]);
    // A `branches` filter without the `paths` filter would run on every branch push: both or neither.
    assert.equal(/^ {4}branches:/m.test(on), /^ {4}paths:/m.test(on));
    assert.equal((on.match(/^ {6}- /gm) ?? []).length, 4, "one tag pattern, two branches, one path; nothing else");
  });

  it("reads only, builds on the two runners R133 names, and never overlaps", () => {
    assert.deepEqual(block("permissions").slice(1), ["  contents: read"]);
    // The runners come from scripts/mac-targets.mjs (tested in mac-targets.test.mjs) through the plan job.
    assert.match(wf, /run: node apps\/desktop\/scripts\/mac-targets\.mjs >> "\$GITHUB_OUTPUT"/);
    assert.match(wf, /include: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
    assert.match(block("concurrency").join("\n"), /cancel-in-progress: false/);
    assert.doesNotMatch(wf, /secrets\./);
    assert.match(wf, new RegExp(`MACOSX_DEPLOYMENT_TARGET: "${PINS.minimumSystemVersion.replace(".", "\\.")}"`));
  });

  it("smoke-tests the worker on the build's own pin set, and keys the build venv's cache on both constraints files (FR-730)", () => {
    const smoke = wf.split("\n").find((l) => l.includes("build-sidecars.mjs --skip-build --smoke"));
    assert.ok(smoke, "no smoke step");
    // build-sidecars.mjs picks the Mac's own constraints file by default, as build-macos.mjs passes it.
    assert.doesNotMatch(smoke, /--constraints/);
    const keys = wf.split("\n").filter((l) => /desktop-macos-build-\$\{\{ matrix\.runner \}\}/.test(l));
    assert.equal(keys.length, 2);
    for (const k of keys) assert.match(k, /'services\/media-worker\/packaging\/constraints-macos-x86_64\.txt', 'services\/media-worker\/packaging\/constraints-macos-arm64\.txt'\)/);
  });

  it("pins every action by full commit id, with its release named (R167 b)", () => {
    const uses = wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    assert.ok(uses.length >= 10);
    for (const l of uses) assert.match(l, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, l);
  });

  it("uploads the download straight after the build, before any check can fail", () => {
    const at = (s) => wf.indexOf(s);
    assert.ok(at("name: Upload the disk image") > at("id: build"));
    // Directly after the build: before the cache saves (a failed save must not skip it) and the checks.
    assert.ok(at("name: Upload the disk image") < at("name: Save the Rust build cache"));
    assert.ok(at("name: Upload the disk image") < at("name: Tools the checks hand to the worker"));
    const between = wf.slice(at("run: node apps/desktop/scripts/build-macos.mjs"), at("name: Upload the disk image"));
    assert.doesNotMatch(between, /\n {6}- (uses|name|run):/, "no step between the build and the upload");
    assert.match(wf.slice(at("name: Upload the disk image"), at("uses: actions/upload-artifact")), /if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' \}\}/);
  });

  it("keeps the system's crash reports after the launch checks, also when one failed (Task MAC5)", () => {
    const at = (s) => wf.indexOf(s);
    const start = at("name: Upload the crash reports");
    assert.ok(start > at("name: Launch check R"), "after both launch checks");
    const block = wf.slice(start, wf.indexOf("\n      - ", start));
    assert.match(block, /if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(block, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/);
    assert.match(block, /name: mac-crash-reports\n/);
    assert.match(block, /path: ~\/Library\/Logs\/DiagnosticReports\/\*\n/);
    assert.match(block, /if-no-files-found: ignore/);
    // Both launch checks run after a failed one (each needs only the build).
    for (const name of ["Launch check A-D", "Launch check R"]) assert.match(wf.slice(at(`name: ${name}`), wf.indexOf("run:", at(`name: ${name}`))), /if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' \}\}/, name);
  });

  it("saves the caches even when a later step failed", () => {
    for (const name of ["Save the Rust build cache", "Save the build caches"]) {
      const block = wf.slice(wf.indexOf(`name: ${name}`), wf.indexOf("uses:", wf.indexOf(`name: ${name}`)));
      assert.match(block, /if: \$\{\{ !cancelled\(\)/, name);
      assert.doesNotMatch(block, /cache-hit/, `${name}: no exact hit can skip it`);
    }
    // Each run saves under its own key and restores the newest by prefix, so a complete run supersedes a partial cache.
    const restores = wf.split("uses: actions/cache/restore@").slice(1).map((b) => b.slice(0, b.indexOf("\n      - ")));
    assert.equal(restores.length, 4);
    for (const r of restores.filter((x) => !x.includes(".cargo-tools"))) {
      assert.match(r, /key: .*-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n/);
      assert.match(r, /restore-keys: \|\n/);
    }
    // After a cancellation nothing more runs on the Mac (no always()).
    assert.doesNotMatch(wf, /always\(\)/);
    assert.doesNotMatch(wf, /uses: actions\/cache@/, "restore and save are separate steps");
    assert.match(wf, /!apps\/desktop\/src-tauri\/target\/\*\/bundle/);
  });

  describe("the browser extension's download (Task 65)", () => {
    /** The text of a job under `jobs:`, up to the next job or the end. */
    const job = (name) => {
      const lines = wf.split("\n");
      const jobsAt = lines.indexOf("jobs:");
      const start = lines.findIndex((l, i) => i > jobsAt && l === `  ${name}:`);
      assert.ok(jobsAt >= 0 && start > jobsAt, `no job ${name}`);
      const end = lines.findIndex((l, i) => i > start && (/^ {2}[A-Za-z]/.test(l) || /^[A-Za-z]/.test(l)));
      return lines.slice(start, end < 0 ? undefined : end).join("\n");
    };
    const ext = () => job("extension");
    const usesOf = (text) => text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l)).map((l) => l.trim().replace(/^- /, ""));

    it("is its own job on Linux, after plan only, so it neither waits for nor depends on the Mac build", () => {
      const e = ext();
      assert.match(e, /^ {4}runs-on: ubuntu-latest$/m);
      assert.match(e, /^ {4}needs: plan$/m);
      assert.doesNotMatch(e, /^ {4}if:/m, "no condition on the Mac build's outcome");
      assert.doesNotMatch(e, /matrix\.|needs\.build|strategy:/);
      assert.match(e, /^ {4}timeout-minutes: \d+$/m);
      // The Mac job does not wait for it either.
      assert.match(job("build"), /^ {4}needs: plan$/m);
    });

    it("installs from the lock file, runs the packaging script and uploads the zip and its SHA-256 for 30 days", () => {
      const e = ext();
      assert.match(e, /run: pnpm install --frozen-lockfile$/m);
      assert.match(e, /run: pnpm --filter @ao\/browser-extension run package$/m);
      assert.ok(e.indexOf("run: pnpm install --frozen-lockfile") < e.indexOf("run package"));
      assert.match(e, /node-version: "?22"?$/m);
      const upload = e.slice(e.indexOf("uses: actions/upload-artifact"));
      assert.ok(e.indexOf("uses: actions/upload-artifact") > e.indexOf("run package"), "uploads after packaging");
      assert.match(upload, /^ {10}name: alexandrine-oxiana-browser-extension$/m);
      assert.match(upload, /^ {12}apps\/browser-extension\/dist-zip\/\*\.zip$/m);
      assert.match(upload, /^ {12}apps\/browser-extension\/dist-zip\/\*\.zip\.sha256$/m);
      assert.match(upload, /^ {10}if-no-files-found: error$/m);
      assert.match(upload, /^ {10}retention-days: 30$/m);
      // Its size and checksum in the run's summary.
      assert.match(e, /dist-zip\/\*\.zip[\s\S]*>> "\$GITHUB_STEP_SUMMARY"/);
    });

    it("uses no secret and only the actions, at the commit ids, that the Mac build already uses", () => {
      const e = ext();
      assert.doesNotMatch(e, /secrets\.|GITHUB_TOKEN|github\.token/);
      // The workflow's `contents: read` stays the only permission: the job widens nothing.
      assert.doesNotMatch(e, /^\s+permissions:/m);
      assert.match(e, /persist-credentials: false/);
      const rest = wf.replace(e, "");
      const theirs = new Set(usesOf(rest));
      const mine = usesOf(e);
      assert.ok(mine.length >= 4, "checkout, pnpm, Node, upload");
      for (const u of mine) assert.ok(theirs.has(u), `${u}: a new action or a new version`);
    });
  });

  it("gives every step a time limit", () => {
    const steps = wf.split("\n").filter((l) => /^ {6}- (uses|name|run):/.test(l)).length;
    const limits = wf.split("\n").filter((l) => /^ {8}timeout-minutes: \d+$/.test(l)).length;
    assert.ok(steps > 10);
    assert.equal(limits, steps);
  });
});

describe("plan (--dry-run)", () => {
  it("lists the steps in order for each architecture", () => {
    for (const arch of ["arm64", "x64"]) {
      const steps = plan(macosTarget(arch), { debugApp: true });
      const names = steps.map((s) => s.id);
      assert.deepEqual(names, ["node", "service", "build-info", "worker", "notices", "interface", "stage", "tauri", "tauri-debug", "sign", "sign-debug", "min-os", "dmg"]);
      const text = steps.map((s) => s.describe).join("\n");
      assert.match(text, new RegExp(`node-${PINS.node.version}-darwin-${arch}\\.tar\\.gz`));
      assert.match(text, /MACOSX_DEPLOYMENT_TARGET=15\.0/);
      assert.match(text, new RegExp(arch === "x64" ? "constraints-macos-x86_64\\.txt" : "constraints-macos-arm64\\.txt"));
      assert.doesNotMatch(text, /--constraints none/);
      assert.match(text, /notices\.mjs .*--node .*bin\/node/);
    }
    assert.ok(!plan(macosTarget("arm64"), { debugApp: false }).some((s) => s.id.endsWith("-debug")));
  });
});
