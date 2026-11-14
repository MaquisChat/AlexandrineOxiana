/**
 * The machine's set-up for the library scenarios (Task F19, R343 a) — the TEST's, never the product's.
 *
 * The sign-in window and the shell's own request reach the made-up library and publisher
 * (library-standin.ts) over https by name, exactly as they reach a real library: the web view
 * (WebKitGTK: GnuTLS with the system's trust) and the shell's request (native-tls: OpenSSL with the
 * system's trust) both check the stand-in's certificate against the SYSTEM's certificate store, and
 * both look the names up through the system's resolver. Nothing in the shell, the service or the
 * interface is relaxed for this. Instead, and only when `AO_E2E_SYSTEM_SETUP=1` is set, this module:
 *
 *  1. makes a throw-away certificate authority and a server certificate for the stand-in's names (with
 *     the system's `openssl`, in a private temporary folder, valid for one day; the authority's key is
 *     deleted with that folder at the end);
 *  2. adds that authority to the system's store: one file `/usr/local/share/ca-certificates/
 *     ao-e2e-library-standin-<run>.crt`, then `update-ca-certificates` with an EMPTY hooks folder (so
 *     that no other store, such as Java's, is touched);
 *  3. maps the made-up names (all under `ao-library-standin.test`, a name that cannot exist: `.test` is
 *     reserved, RFC 6761) to 127.0.0.1 by appending one marked block to `/etc/hosts` (written in place:
 *     the file may be a mount);
 *
 * and `undo()` puts both back exactly: the hosts file's bytes, mode, owner and times as they were;
 * the authority's file removed and `update-ca-certificates` run again; then the store and the hosts
 * file are compared with what they were before (every entry of `/etc/ssl/certs` by name, kind, link
 * target or content and mode; the local authorities' folder likewise) and any difference is a failure.
 * `undo()` is synchronous and idempotent: the spec calls it after the scenarios, and on SIGINT, SIGTERM,
 * SIGHUP and the process's exit, so that a failed or interrupted run leaves nothing behind.
 *
 * Guards, before anything is touched (`refusal`): Linux, root, the switch exactly "1"; the hosts file a
 * plain file (not a link); no block or authority of an earlier run left over (a run killed outright
 * leaves them: removed by hand as apps/desktop/README.md says); and the store as it is now must be what
 * `update-ca-certificates` itself would make of it — tried first on a COPY of `/etc/ssl/certs` — or
 * the run could not put it back exactly, and refuses.
 *
 * What a run killed outright (SIGKILL) leaves: the block in /etc/hosts and the authority's file and
 * links. The hosts file's original is kept beside them until the undo (`<tmp>/ao-e2e-system-setup-<run>/
 * hosts.orig`), and the README says how to remove both.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";

export const SYSTEM_SETUP_SWITCH = "AO_E2E_SYSTEM_SETUP";
/** The made-up domain every stand-in name is under (`.test` is reserved and never resolves on the internet). */
export const STANDIN_DOMAIN = "ao-library-standin.test";
/** Marks the hosts block and names the authority's file. */
export const MARK = "ao-e2e-library-standin";

export const HOSTS_FILE = "/etc/hosts";
export const LOCAL_CA_DIR = "/usr/local/share/ca-certificates";
export const ETC_CERTS_DIR = "/etc/ssl/certs";

/** The reason the library scenarios are skipped when the set-up is not asked for (said in the report). */
export const NOT_ASKED =
  "not run: AO_E2E_SYSTEM_SETUP=1 is not set. The library scenarios need this machine to trust a throw-away certificate authority and to resolve the stand-in's made-up names to 127.0.0.1, which only that switch allows (apps/desktop/README.md, \"The library scenarios\")";

// ---------- pure parts (system-setup.test.ts) ----------

/** Why the set-up cannot be done here (undefined when it can be asked for). */
export function refusal(p: { env: Record<string, string | undefined>; platform: string; uid: number | undefined }): string | undefined {
  if (p.env[SYSTEM_SETUP_SWITCH] !== "1") return NOT_ASKED;
  if (p.platform !== "linux") return `not run: the machine's set-up is written for Linux (this is ${p.platform})`;
  if (p.uid !== 0) return "not run: AO_E2E_SYSTEM_SETUP=1 needs root (it changes /etc/hosts and the system's certificate store, and puts both back)";
  return undefined;
}

/** Only names under the made-up domain, each a plain host name. */
export function standinNamesOk(names: string[]): boolean {
  return names.length > 0 && names.every((n) => n.endsWith(`.${STANDIN_DOMAIN}`) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n));
}

/** The hosts file with the stand-in's block appended (the original bytes kept as they are). */
export function hostsWith(original: string, names: string[], run: string): string {
  if (!standinNamesOk(names)) throw new Error("only names under the stand-in's made-up domain are mapped");
  const sep = original === "" || original.endsWith("\n") ? "" : "\n";
  return `${original}${sep}# ${MARK} ${run} begin (the desktop library scenarios; removed when they end)\n127.0.0.1 ${names.join(" ")}\n# ${MARK} ${run} end\n`;
}

/** Whether a hosts file holds a block of any run, or names under the made-up domain. */
export function hostsHoldsLeftover(text: string): boolean {
  return text.includes(MARK) || text.includes(STANDIN_DOMAIN);
}

export type StoreSnapshot = Map<string, string>;

/** Every entry under `dir`: relative name → its kind and what it is (a link's target, a file's content hash), with its mode. */
export function snapshotDir(dir: string): StoreSnapshot {
  const out: StoreSnapshot = new Map();
  const walk = (rel: string) => {
    const p = rel ? join(dir, rel) : dir;
    const st = lstatSync(p);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) out.set(rel, `link ${readlinkSync(p)}`);
    else if (st.isDirectory()) {
      if (rel) out.set(rel, `dir ${mode} ${st.uid}:${st.gid}`);
      for (const n of readdirSync(p).sort()) walk(rel ? `${rel}/${n}` : n);
    } else out.set(rel, `file ${mode} ${st.uid}:${st.gid} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
  };
  walk("");
  return out;
}

/** What differs between two snapshots ("added x", "removed x", "changed x"), sorted. */
export function snapshotDiff(before: StoreSnapshot, after: StoreSnapshot): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (!before.has(k)) out.push(`added ${k}`);
  else if (before.get(k) !== v) out.push(`changed ${k}`);
  for (const k of before.keys()) if (!after.has(k)) out.push(`removed ${k}`);
  return out.sort();
}

// ---------- the machine ----------

function run(cmd: string, args: string[], what: string): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", TMPDIR: tmpdir() } });
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 500)}`);
  return r.stdout;
}

/** `update-ca-certificates` on `etcCerts`, with no hooks run (no other store is touched). */
function updateStore(etcCerts: string, emptyHooks: string): void {
  run("update-ca-certificates", ["--etccertsdir", etcCerts, "--hooksdir", emptyHooks], "update-ca-certificates");
}

export interface Certificates {
  /** The authority's certificate (PEM): what the system is made to trust. */
  caPem: string;
  /** The stand-in's certificate (PEM) for every name, signed by the authority, and its key. */
  certPem: string;
  keyPem: string;
}

/** A throw-away authority and a certificate for `names`, made with the system's openssl in `dir` (one day). */
export function makeCertificates(dir: string, names: string[], runId: string): Certificates {
  if (!standinNamesOk(names)) throw new Error("only names under the stand-in's made-up domain get a certificate");
  const f = (n: string) => join(dir, n);
  writeFileSync(f("server.ext"), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((n) => `DNS:${n}`).join(",")}\n`);
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f("ca.key"), "-out", f("ca.pem"), "-days", "1", "-subj", `/CN=AO e2e library stand-in throw-away authority ${runId}`, "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], "making the throw-away authority");
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", f("server.key"), "-out", f("server.csr"), "-subj", `/CN=${names[0]}`], "making the stand-in's key");
  run("openssl", ["x509", "-req", "-in", f("server.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("server.pem"), "-days", "1", "-extfile", f("server.ext")], "signing the stand-in's certificate");
  return { caPem: readFileSync(f("ca.pem"), "utf8"), certPem: readFileSync(f("server.pem"), "utf8"), keyPem: readFileSync(f("server.key"), "utf8") };
}

interface HostsState {
  bytes: Buffer;
  mode: number;
  uid: number;
  gid: number;
  atime: Date;
  mtime: Date;
}

/** The set-up as applied: `undo()` puts the machine back (synchronous, idempotent). */
export class SystemSetup {
  private undone = false;
  /** The links `update-ca-certificates` added for the authority (its `.pem` and its hash link). */
  private readonly addedLinks: Array<{ name: string; target: string }> = [];
  private constructor(
    readonly runId: string,
    readonly certificates: Certificates,
    private readonly work: string,
    private readonly hosts: HostsState,
    private readonly storeBefore: StoreSnapshot,
    private readonly localBefore: StoreSnapshot,
    private readonly caFile: string,
  ) {}

  /** What stands in the way of a set-up here that can be put back exactly (undefined: none). Looks only; touches nothing. */
  static obstacle(): string | undefined {
    const r = refusal({ env: process.env, platform: process.platform, uid: process.getuid?.() });
    if (r) return r;
    let hostsStat;
    try {
      hostsStat = lstatSync(HOSTS_FILE);
    } catch {
      return `not run: ${HOSTS_FILE} cannot be read`;
    }
    if (!hostsStat.isFile()) return `not run: ${HOSTS_FILE} is not a plain file, so it could not be put back exactly`;
    if (hostsHoldsLeftover(readFileSync(HOSTS_FILE, "utf8"))) return `not run: ${HOSTS_FILE} still holds a block of an earlier run (marked ${MARK}); remove it as apps/desktop/README.md says`;
    if (!existsSync(LOCAL_CA_DIR) || !statSync(LOCAL_CA_DIR).isDirectory()) return `not run: ${LOCAL_CA_DIR} is not there`;
    if (readdirSync(LOCAL_CA_DIR).some((n) => n.startsWith(MARK))) return `not run: ${LOCAL_CA_DIR} still holds an authority of an earlier run (${MARK}-*.crt); remove it as apps/desktop/README.md says`;
    if (readdirSync(ETC_CERTS_DIR).some((n) => n.startsWith(MARK))) return `not run: ${ETC_CERTS_DIR} still holds the link of an earlier run's authority (${MARK}-*.pem); remove it as apps/desktop/README.md says`;
    for (const tool of ["openssl", "update-ca-certificates"]) if (spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0) return `not run: ${tool} is not installed`;
    return undefined;
  }

  /** Applies the set-up for `names` (see the file comment). Throws, having put back whatever it changed, when it cannot. */
  static apply(names: string[]): SystemSetup {
    const obstacle = SystemSetup.obstacle();
    if (obstacle) throw new Error(obstacle);
    if (!standinNamesOk(names)) throw new Error("only names under the stand-in's made-up domain are mapped");
    const runId = randomBytes(6).toString("hex");
    const work = mkdtempSync(join(tmpdir(), `ao-e2e-system-setup-${runId}-`));
    chmodSync(work, 0o700);
    try {
      const emptyHooks = join(work, "no-hooks");
      mkdirSync(emptyHooks);
      // The store must be what update-ca-certificates itself makes of it, or it could not be put back
      // exactly: tried on a copy first.
      const storeBefore = snapshotDir(ETC_CERTS_DIR);
      const copy = join(work, "certs-copy");
      cpSync(ETC_CERTS_DIR, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      updateStore(copy, emptyHooks);
      const dry = snapshotDiff(storeBefore, snapshotDir(copy));
      rmSync(copy, { recursive: true, force: true });
      if (dry.length) throw new Error(`not run: the certificate store is not what update-ca-certificates makes of it (${dry.slice(0, 5).join(", ")}), so it could not be put back exactly`);
      const localBefore = snapshotDir(LOCAL_CA_DIR);
      const certificates = makeCertificates(work, names, runId);
      const st = statSync(HOSTS_FILE);
      const hosts: HostsState = { bytes: readFileSync(HOSTS_FILE), mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, atime: st.atime, mtime: st.mtime };
      writeFileSync(join(work, "hosts.orig"), hosts.bytes, { mode: 0o600 });
      const caFile = join(LOCAL_CA_DIR, `${MARK}-${runId}.crt`);
      const setup = new SystemSetup(runId, certificates, work, hosts, storeBefore, localBefore, caFile);
      try {
        writeFileSync(caFile, certificates.caPem, { mode: 0o644, flag: "wx" });
        updateStore(ETC_CERTS_DIR, emptyHooks);
        // What that added: the authority's link and its hash link, nothing else (or it is put back at once).
        const after = snapshotDir(ETC_CERTS_DIR);
        const changes = snapshotDiff(storeBefore, after);
        const pem = `${MARK}-${runId}.pem`;
        for (const c of changes) {
          const name = c.replace(/^\w+ /, "");
          const what = after.get(name);
          if (!c.startsWith("added ") && name !== "ca-certificates.crt") throw new Error(`update-ca-certificates changed ${name} as well`);
          if (c.startsWith("added ")) {
            if (what !== `link ${caFile}` && what !== `link ${pem}`) throw new Error(`update-ca-certificates added ${name}, which is not the authority's link`);
            setup.addedLinks.push({ name, target: what.slice("link ".length) });
          }
        }
        // In place (the hosts file may be a mount that cannot be replaced).
        writeFileSync(HOSTS_FILE, hostsWith(hosts.bytes.toString("utf8"), names, runId));
      } catch (err) {
        const left = setup.undo();
        throw new Error(`${err instanceof Error ? err.message : String(err)}${left.length ? `; and putting the machine back failed: ${left.join("; ")}` : ""}`);
      }
      return setup;
    } catch (err) {
      // Nothing of the machine was changed before this point, or `undo` above has put it back.
      if (!(err instanceof Error && /putting the machine back failed/.test(err.message))) rmSync(work, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Puts the machine back and proves it: the problems found (empty when the hosts file and the store
   * are exactly as before). Synchronous and idempotent; the second call answers [] at once.
   */
  undo(): string[] {
    if (this.undone) return [];
    this.undone = true;
    const problems: string[] = [];
    const step = (what: string, f: () => void) => {
      try {
        f();
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    step("the hosts file", () => {
      if (!readFileSync(HOSTS_FILE).equals(this.hosts.bytes)) writeFileSync(HOSTS_FILE, this.hosts.bytes);
      chmodSync(HOSTS_FILE, this.hosts.mode);
      chownSync(HOSTS_FILE, this.hosts.uid, this.hosts.gid);
      utimesSync(HOSTS_FILE, this.hosts.atime, this.hosts.mtime);
    });
    step("the authority's file", () => {
      if (existsSync(this.caFile)) unlinkSync(this.caFile);
    });
    // update-ca-certificates leaves the links of a removed local authority in place (it removes links
    // only for its configuration's "!" lines, or with --fresh, which would remake every link): the
    // two it added are removed here: exactly the links to this run's authority (its `.pem` link, and
    // the hash link to that), found by their targets.
    step("the authority's links", () => {
      const ours = new Set([this.caFile, `${MARK}-${this.runId}.pem`]);
      for (const name of readdirSync(ETC_CERTS_DIR)) {
        const p = join(ETC_CERTS_DIR, name);
        if (lstatSync(p).isSymbolicLink() && ours.has(readlinkSync(p))) unlinkSync(p);
      }
    });
    step("the certificate store", () => {
      const emptyHooks = join(this.work, "no-hooks");
      mkdirSync(emptyHooks, { recursive: true });
      updateStore(ETC_CERTS_DIR, emptyHooks);
    });
    // The proof: compared with what they were before.
    step("comparing the hosts file", () => {
      const st = statSync(HOSTS_FILE);
      if (!readFileSync(HOSTS_FILE).equals(this.hosts.bytes)) problems.push(`${HOSTS_FILE} is not as it was`);
      if ((st.mode & 0o7777) !== this.hosts.mode || st.uid !== this.hosts.uid || st.gid !== this.hosts.gid) problems.push(`${HOSTS_FILE}'s mode or owner is not as it was`);
      if (st.mtimeMs !== this.hosts.mtime.getTime()) problems.push(`${HOSTS_FILE}'s modification time is not as it was`);
    });
    step("comparing the store", () => {
      const d = [...snapshotDiff(this.storeBefore, snapshotDir(ETC_CERTS_DIR)).map((x) => `${ETC_CERTS_DIR}: ${x}`), ...snapshotDiff(this.localBefore, snapshotDir(LOCAL_CA_DIR)).map((x) => `${LOCAL_CA_DIR}: ${x}`)];
      problems.push(...d);
    });
    if (problems.length === 0) rmSync(this.work, { recursive: true, force: true });
    else problems.push(`the hosts file's original is kept in ${join(this.work, "hosts.orig")}`);
    return problems;
  }

  /** What the scenarios' report says of the machine before and after (no key, no certificate). */
  describe(): string {
    return `hosts block ${MARK} ${this.runId} and authority ${this.caFile}`;
  }
}

/**
 * Says at the end of `pnpm --filter @ao/desktop run e2e` how many library scenarios were not run for
 * want of the set-up, and why (R343 a: reported as NOT RUN, never as passed). Listed in
 * playwright.config.ts after the list reporter, so its lines are the last.
 */
export default class LibraryScenariosNotRun implements Reporter {
  private skipped = new Map<string, number>();
  onBegin(_config: unknown, _suite: Suite): void {}
  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== "skipped") return;
    const why = test.annotations.find((a) => a.type === "skip" && a.description?.startsWith("not run:"))?.description;
    if (why) this.skipped.set(why, (this.skipped.get(why) ?? 0) + 1);
  }
  onEnd(_result: FullResult): void {
    for (const [why, n] of this.skipped) process.stdout.write(`\n  ${n} library scenario${n === 1 ? "" : "s"} NOT RUN (skipped), not passed — ${why}\n`);
  }
  printsToStdio(): boolean {
    return true;
  }
}
