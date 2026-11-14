// The machine's set-up for the library scenarios (system-setup.ts, Task F19, R343 a): its pure parts —
// when it may run at all, the hosts block, the leftovers it refuses, the store's comparison — and the
// throw-away certificates (made with the system's openssl in a temporary folder; nothing of the
// machine is touched here).
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STANDIN_NAMES } from "./library-standin.js";
import {
  AUTHORITY_EXTENSIONS,
  decide,
  hostsHoldsLeftover,
  hostsWith,
  loopbackOnly,
  type Machine,
  makeAuthority,
  makeCertificates,
  MARK,
  NOT_ASKED,
  SETUP_FAILED,
  snapshotDiff,
  snapshotDir,
  standinNamesOk,
  STANDIN_DOMAIN,
  SystemSetup,
} from "./system-setup.js";

const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const TOOLS = has("openssl") && has("update-ca-certificates") && has("touch");
const openssl = (args: string[]) => spawnSync("openssl", args, { encoding: "utf8" });

describe("what a run does when the set-up is asked for and cannot be made (R346 c)", () => {
  it("without the switch: NOT RUN with the reason, and nothing is even looked at", () => {
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) {
      let looked = false;
      const o = decide({ AO_E2E_SYSTEM_SETUP: v }, () => {
        looked = true;
        return "anything";
      });
      expect(o, String(v)).toEqual({ kind: "not-run", reason: NOT_ASKED });
      expect(looked).toBe(false);
    }
  });

  it("with the switch: any obstacle FAILS the run, with its reason; none: the scenarios run", () => {
    for (const why of ["it needs root", "openssl is not installed", "not in a network namespace with only the loopback interface", "an earlier run's leftovers could not be put back"]) {
      const o = decide({ AO_E2E_SYSTEM_SETUP: "1" }, () => why);
      expect(o.kind).toBe("fail");
      expect(o.kind === "fail" && o.reason).toBe(`${SETUP_FAILED} ${why}`);
    }
    expect(decide({ AO_E2E_SYSTEM_SETUP: "1" }, () => undefined)).toEqual({ kind: "run" });
    expect(SETUP_FAILED).toMatch(/AO_E2E_SYSTEM_SETUP=1/);
    expect(NOT_ASKED.startsWith("not run:")).toBe(true);
  });

  it("a namespace with any interface but the loopback is refused (R346 d)", () => {
    const dev = (...names: string[]) => `Inter-|   Receive\n face |bytes\n${names.map((n) => `${n.padStart(6)}:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0`).join("\n")}\n`;
    expect(loopbackOnly(dev("lo"))).toBeUndefined();
    expect(loopbackOnly(dev("lo", "eth0"))).toMatch(/eth0/);
    expect(loopbackOnly(dev("eth0"))).toMatch(/eth0/);
    expect(loopbackOnly(dev())).toMatch(/no loopback/);
  });
});

describe("the hosts block", () => {
  it("maps only the stand-in's made-up names, appended after the file's own bytes, marked", () => {
    expect(standinNamesOk(STANDIN_NAMES)).toBe(true);
    expect(STANDIN_NAMES.every((n) => n.endsWith(`.${STANDIN_DOMAIN}`))).toBe(true);
    const original = "127.0.0.1 localhost\n10.0.0.2 other\n";
    const out = hostsWith(original, STANDIN_NAMES, "abc123");
    expect(out.startsWith(original)).toBe(true);
    expect(out.slice(original.length)).toBe(`# ao-e2e-library-standin abc123 begin (the desktop library scenarios; removed when they end)\n127.0.0.1 ${STANDIN_NAMES.join(" ")}\n# ao-e2e-library-standin abc123 end\n`);
    // A file without a last newline keeps its bytes; the block starts on a line of its own.
    expect(hostsWith("127.0.0.1 localhost", ["a.ao-library-standin.test"], "r").startsWith("127.0.0.1 localhost\n# ao-e2e")).toBe(true);
  });

  it("never maps a real name, or anything that is not a plain host name", () => {
    for (const bad of [["api.crossref.org"], ["doi.org"], ["x.ao-library-standin.test.evil.org"], ["ao-library-standin.test"], ["a b.ao-library-standin.test"], ["x.ao-library-standin.test\n1.2.3.4 doi.org"], []]) {
      expect(standinNamesOk(bad), JSON.stringify(bad)).toBe(false);
      expect(() => hostsWith("", bad, "r"), JSON.stringify(bad)).toThrow(/made-up domain/);
    }
  });

  it("recognises what an earlier run left in the hosts file", () => {
    expect(hostsHoldsLeftover("127.0.0.1 localhost\n")).toBe(false);
    expect(hostsHoldsLeftover(hostsWith("127.0.0.1 localhost\n", STANDIN_NAMES, "r"))).toBe(true);
    expect(hostsHoldsLeftover("127.0.0.1 login.proxy.ao-library-standin.test\n")).toBe(true);
  });
});

describe("the store's comparison", () => {
  it("sees an added, a removed and a changed entry, a link's new target and a new mode; nothing when all is as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-store-test-"));
    try {
      writeFileSync(join(dir, "a.pem"), "A");
      writeFileSync(join(dir, "bundle.crt"), "A\nB\n");
      symlinkSync("a.pem", join(dir, "1234abcd.0"));
      mkdirSync(join(dir, "java"));
      writeFileSync(join(dir, "java", "cacerts"), "j");
      const before = snapshotDir(dir);
      expect(snapshotDiff(before, snapshotDir(dir))).toEqual([]);
      writeFileSync(join(dir, "bundle.crt"), "A\nB\nC\n");
      symlinkSync("/usr/local/share/ca-certificates/x.crt", join(dir, "x.pem"));
      rmSync(join(dir, "1234abcd.0"));
      symlinkSync("b.pem", join(dir, "1234abcd.0"));
      chmodSync(join(dir, "a.pem"), 0o600);
      rmSync(join(dir, "java", "cacerts"));
      expect(snapshotDiff(before, snapshotDir(dir))).toEqual(["added x.pem", "changed 1234abcd.0", "changed a.pem", "changed bundle.crt", "removed java/cacerts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the throw-away certificates (R346 a)", () => {
  it.skipIf(!TOOLS)("an authority, and a certificate for every stand-in name that the authority verifies (one day); no key left on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-certs-test-"));
    try {
      const c = makeCertificates(dir, STANDIN_NAMES, "test");
      writeFileSync(join(dir, "check-ca.pem"), c.caPem);
      writeFileSync(join(dir, "check-server.pem"), c.certPem);
      const verify = openssl(["verify", "-CAfile", join(dir, "check-ca.pem"), "-purpose", "sslserver", join(dir, "check-server.pem")]);
      expect(verify.stdout.trim(), verify.stderr).toMatch(/: OK$/);
      const text = openssl(["x509", "-in", join(dir, "check-server.pem"), "-noout", "-ext", "subjectAltName"]).stdout;
      for (const n of STANDIN_NAMES) expect(text).toContain(`DNS:${n}`);
      expect(c.keyPem).toMatch(/PRIVATE KEY/);
      // The authority's key is deleted as soon as the one certificate is signed (and the server's
      // key is kept only in memory): no key of any kind is left in the folder.
      expect(readdirSync(dir).filter((n) => n.endsWith(".key")), readdirSync(dir).join(" ")).toEqual([]);
      for (const n of readdirSync(dir)) expect(readFileSync(join(dir, n), "utf8"), n).not.toMatch(/PRIVATE KEY/);
      // It can vouch only for names under the made-up domain: a critical name constraint.
      const nc = openssl(["x509", "-in", join(dir, "check-ca.pem"), "-noout", "-ext", "nameConstraints"]).stdout;
      expect(nc).toMatch(/X509v3 Name Constraints: critical/);
      expect(nc.replace(/\s+/g, " ")).toContain(`Permitted: DNS:.${STANDIN_DOMAIN}`);
      expect(() => makeCertificates(dir, ["doi.org"], "test")).toThrow(/made-up domain/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!TOOLS)("a certificate for any other name, signed by an authority of the same recipe, does NOT verify against it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-certs-test-"));
    try {
      // The same recipe (makeAuthority, which makeCertificates uses), its key kept here for the proof.
      makeAuthority(dir, "copy");
      expect(existsSync(join(dir, "ca.key"))).toBe(true);
      const sign = (name: string) => {
        writeFileSync(join(dir, "e.ext"), `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${name}\n`);
        expect(openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "s.key"), "-out", join(dir, "s.csr"), "-subj", `/CN=${name}`]).status).toBe(0);
        expect(openssl(["x509", "-req", "-in", join(dir, "s.csr"), "-CA", join(dir, "ca.pem"), "-CAkey", join(dir, "ca.key"), "-CAcreateserial", "-out", join(dir, "s.pem"), "-days", "1", "-extfile", join(dir, "e.ext")]).status).toBe(0);
        const v = openssl(["verify", "-CAfile", join(dir, "ca.pem"), "-purpose", "sslserver", join(dir, "s.pem")]);
        return `${v.stdout}${v.stderr}`;
      };
      expect(sign(STANDIN_NAMES[0]!)).toMatch(/: OK/);
      for (const other of ["api.crossref.org", "doi.org", STANDIN_DOMAIN, `x.${STANDIN_DOMAIN}.example.org`]) expect(sign(other), other).toMatch(/permitted subtree violation/);
      expect(AUTHORITY_EXTENSIONS).toContain(`nameConstraints=critical,permitted;DNS:.${STANDIN_DOMAIN}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- the set-up in a sandbox: a hosts file and a certificate store of its own ----------

const nsOf = (p: string) => statSync(p, { bigint: true }).mtimeNs;

/** A sandbox laid out as the machine is: a hosts file, a store made by update-ca-certificates from one authority of its own, the local authorities' folder, a state folder. */
function sandbox(): { root: string; m: Machine } {
  const root = mkdtempSync(join(tmpdir(), "ao-setup-sandbox-"));
  try {
    return sandboxIn(root);
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}
function sandboxIn(root: string): { root: string; m: Machine } {
  const d = (...p: string[]) => join(root, ...p);
  for (const x of ["etc", "share/own", "local", "certs", "var", "tmp", "nohooks"]) mkdirSync(d(x), { recursive: true });
  writeFileSync(d("etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n", { mode: 0o644 });
  // The sandbox's "machine's own" authority (as this machine's store holds its proxy's).
  makeAuthority(d("tmp"), "sandbox-own");
  // Named to sort before the bundle (ca-certificates.crt), as the machine's first authority does:
  // openssl's rehash then takes the bundle's first certificate for a duplicate and links nothing to it.
  writeFileSync(d("share/own/aaa-own.crt"), readFileSync(d("tmp/ca.pem")));
  rmSync(d("tmp"), { recursive: true });
  mkdirSync(d("tmp"));
  writeFileSync(d("ca.conf"), "own/aaa-own.crt\n");
  const m: Machine = { hosts: d("etc/hosts"), localCa: d("local"), etcCerts: d("certs"), state: d("var/ao-e2e-library-standin"), tmp: d("tmp"), storeArgs: ["--certsconf", d("ca.conf"), "--certsdir", d("share")] };
  const r = spawnSync("update-ca-certificates", [...m.storeArgs, "--localcertsdir", m.localCa, "--etccertsdir", m.etcCerts, "--hooksdir", d("nohooks")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  // Times with nanoseconds, so that "put back" is checked exactly.
  for (const [p, t] of [[m.hosts, "1600000000.123456789"], [join(m.etcCerts, "ca-certificates.crt"), "1600000100.5"], [m.etcCerts, "1600000200.987654321"], [m.localCa, "1600000300.000000001"]] as const)
    expect(spawnSync("touch", ["-d", `@${t}`, p]).status).toBe(0);
  return { root, m };
}

interface Look {
  hosts: string;
  hostsNs: bigint;
  store: Map<string, string>;
  local: Map<string, string>;
  times: bigint[];
}
const look = (m: Machine): Look => ({
  hosts: readFileSync(m.hosts, "utf8"),
  hostsNs: nsOf(m.hosts),
  store: snapshotDir(m.etcCerts),
  local: snapshotDir(m.localCa),
  times: [nsOf(m.etcCerts), nsOf(m.localCa), nsOf(join(m.etcCerts, "ca-certificates.crt"))],
});
const expectAsBefore = (m: Machine, before: Look) => {
  const now = look(m);
  expect(now.hosts).toBe(before.hosts);
  expect(now.hostsNs, "the hosts file's modification time").toBe(before.hostsNs);
  expect(snapshotDiff(before.store, now.store)).toEqual([]);
  expect(snapshotDiff(before.local, now.local)).toEqual([]);
  expect(now.times, "the store's folders' and bundle's modification times").toEqual(before.times);
  expect(existsSync(m.state), "the state folder is removed").toBe(false);
  expect(readdirSync(m.tmp), "no work folder left").toEqual([]);
};
/** A pid that is certainly gone: a process that has ended. */
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

describe.skipIf(!TOOLS)("the set-up in a sandbox (R346 a, e, g)", () => {
  it("applies (hosts block, authority trusted, no key on disk, a record written first) and undo puts everything back, the times included", () => {
    const { root, m } = sandbox();
    try {
      const before = look(m);
      const setup = SystemSetup.prepare(STANDIN_NAMES, m);
      expect(readFileSync(m.hosts, "utf8")).toBe(hostsWith(before.hosts, STANDIN_NAMES, setup.runId));
      expect(readdirSync(m.localCa)).toEqual([`${MARK}-${setup.runId}.crt`]);
      expect(snapshotDiff(before.store, snapshotDir(m.etcCerts)).filter((x) => x.startsWith("added"))).toHaveLength(2);
      // What a later run needs to put the machine back, in one place, and the lock with this run's id and pid.
      const rec = JSON.parse(readFileSync(join(m.state, "record.json"), "utf8")) as { runId: string; caFile: string; work: string };
      expect(rec.runId).toBe(setup.runId);
      expect(readFileSync(join(m.state, "hosts.orig"), "utf8")).toBe(before.hosts);
      expect(JSON.parse(readFileSync(join(m.state, "lock"), "utf8"))).toMatchObject({ runId: setup.runId, pid: process.pid });
      // Once the store trusts the authority, no key of it is anywhere on disk (the work folder, the state folder).
      const keys = spawnSync("grep", ["-rl", "PRIVATE KEY", m.tmp, m.state], { encoding: "utf8" }).stdout.trim();
      expect(keys).toBe("");
      expect(setup.undo()).toEqual([]);
      expectAsBefore(m, before);
      expect(setup.undo(), "idempotent").toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("one run at a time: a second run meanwhile fails with the reason (R346 e)", () => {
    const { root, m } = sandbox();
    try {
      const before = look(m);
      const first = SystemSetup.prepare(STANDIN_NAMES, m);
      const during = look(m);
      expect(() => SystemSetup.prepare(STANDIN_NAMES, m)).toThrow(new RegExp(`another run .*${first.runId}.*process ${process.pid}`));
      // The second run changed nothing and took nothing.
      expect(look(m).hosts).toBe(during.hosts);
      expect(JSON.parse(readFileSync(join(m.state, "lock"), "utf8"))).toMatchObject({ runId: first.runId });
      expect(first.undo()).toEqual([]);
      expectAsBefore(m, before);
      const again = SystemSetup.prepare(STANDIN_NAMES, m);
      expect(again.undo()).toEqual([]);
      expectAsBefore(m, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a run killed outright is put back by the next run from its record, which then goes on (R346 a)", () => {
    const { root, m } = sandbox();
    try {
      const before = look(m);
      // The killed run: applied under a process that is gone, never undone.
      const killed = SystemSetup.prepare(STANDIN_NAMES, m, deadPid());
      expect(readFileSync(m.hosts, "utf8")).toContain(killed.runId);
      const next = SystemSetup.prepare(STANDIN_NAMES, m);
      expect(next.restored).toMatch(new RegExp(`put back .*${killed.runId}`));
      // Only the new run's block and authority are there now.
      expect(readFileSync(m.hosts, "utf8")).toBe(hostsWith(before.hosts, STANDIN_NAMES, next.runId));
      expect(readdirSync(m.localCa)).toEqual([`${MARK}-${next.runId}.crt`]);
      expect(readdirSync(m.tmp).filter((n) => n.includes(killed.runId)), "the killed run's work folder is removed").toEqual([]);
      expect(next.undo()).toEqual([]);
      expectAsBefore(m, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a killed run's leftovers that cannot be put back exactly FAIL the next run, saying what it found", () => {
    const { root, m } = sandbox();
    try {
      const killed = SystemSetup.prepare(STANDIN_NAMES, m, deadPid());
      appendFileSync(m.hosts, "10.0.0.9 changed-meanwhile\n");
      expect(() => SystemSetup.prepare(STANDIN_NAMES, m)).toThrow(/could not be put back exactly: the hosts file: .* is neither its original nor/);
      // The record is kept for the person who puts it back by hand; the lock is not held.
      expect(JSON.parse(readFileSync(join(m.state, "record.json"), "utf8"))).toMatchObject({ runId: killed.runId });
      expect(existsSync(join(m.state, "lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leftovers with no record (an older run's) are refused, not guessed at", () => {
    const { root, m } = sandbox();
    try {
      const before = look(m);
      writeFileSync(m.hosts, hostsWith(before.hosts, STANDIN_NAMES, "older"));
      expect(() => SystemSetup.prepare(STANDIN_NAMES, m)).toThrow(/still holds a block of an earlier run.*no record/);
      expect(existsSync(join(m.state, "lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!TOOLS)("a killed run's record is checked before anything is restored (R350)", () => {
  type Rec = Record<string, unknown> & { hosts: { mode: number } };
  interface Ctx {
    root: string;
    m: Machine;
    edit: (f: (r: Rec) => void) => void;
  }
  const cases: Array<{ name: string; field: string; tamper: (c: Ctx) => void; kept?: (c: Ctx) => string }> = [
    {
      name: "caFile naming the machine's own authority in the local authorities' folder",
      field: "caFile",
      tamper: (c) => {
        writeFileSync(join(c.m.localCa, "machine-local.crt"), "the machine's own authority");
        c.edit((r) => (r.caFile = join(c.m.localCa, "machine-local.crt")));
      },
      kept: (c) => join(c.m.localCa, "machine-local.crt"),
    },
    {
      name: "caFile naming an unrelated file outside",
      field: "caFile",
      tamper: (c) => {
        writeFileSync(join(c.root, "unrelated.txt"), "not ours");
        c.edit((r) => (r.caFile = join(c.root, "unrelated.txt")));
      },
      kept: (c) => join(c.root, "unrelated.txt"),
    },
    { name: "pem naming another store link", field: "pem", tamper: (c) => c.edit((r) => (r.pem = readdirSync(c.m.etcCerts).find((n) => n.endsWith(".pem") && !n.startsWith(MARK))!)) },
    { name: "hosts.mode 0o666", field: "hosts\\.mode", tamper: (c) => c.edit((r) => (r.hosts.mode = 0o666)) },
    { name: "a times path outside the three", field: "times", tamper: (c) => c.edit((r) => (r.times = [...(r.times as unknown[]), [join(c.root, "etc/hosts.other"), { a: "1.000000000", m: "1.000000000" }]])) },
    { name: "a wrong version", field: "version", tamper: (c) => c.edit((r) => (r.v = 2)) },
    { name: "a run id with a path separator", field: "runId", tamper: (c) => c.edit((r) => (r.runId = "aaaaaa/aaaaa")) },
    {
      name: "record.json replaced by a symbolic link to a valid record elsewhere",
      field: "record\\.json",
      tamper: (c) => {
        const p = join(c.m.state, "record.json");
        renameSync(p, join(c.root, "elsewhere.json"));
        symlinkSync(join(c.root, "elsewhere.json"), p);
      },
    },
    { name: "the state folder with mode 0755", field: "state folder", tamper: (c) => chmodSync(c.m.state, 0o755) },
  ];
  const lookAll = (m: Machine) => {
    const h = statSync(m.hosts);
    const rec = join(m.state, "record.json");
    return { ...look(m), mode: h.mode, uid: h.uid, gid: h.gid, tmp: readdirSync(m.tmp), record: readFileSync(rec, "utf8"), recordIsLink: lstatSync(rec).isSymbolicLink(), orig: readFileSync(join(m.state, "hosts.orig"), "utf8") };
  };
  for (const c of cases)
    it(`${c.name}: refused with words, and nothing is changed`, () => {
      const { root, m } = sandbox();
      try {
        SystemSetup.prepare(STANDIN_NAMES, m, deadPid());
        const rec = join(m.state, "record.json");
        const ctx: Ctx = {
          root,
          m,
          edit: (f) => {
            const r = JSON.parse(readFileSync(rec, "utf8")) as Rec;
            f(r);
            writeFileSync(rec, JSON.stringify(r));
          },
        };
        c.tamper(ctx);
        const before = lookAll(m);
        let message = "";
        try {
          SystemSetup.prepare(STANDIN_NAMES, m);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(new RegExp(`refused: .*${c.field}`));
        expect(message).toMatch(/nothing was changed/);
        expect(message).toMatch(/killed outright/);
        expect(lookAll(m)).toEqual(before);
        if (c.kept) expect(existsSync(c.kept(ctx)), "the named file is still there").toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
});
