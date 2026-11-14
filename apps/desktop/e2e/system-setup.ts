/**
 * The machine's set-up for the library scenarios (Task F19, R343 a, R346) — the TEST's, never the product's.
 *
 * The sign-in window and the shell's own request reach the made-up library and publisher
 * (library-standin.ts) over https by name, exactly as they reach a real library: the web view
 * (WebKitGTK: GnuTLS with the system's trust) and the shell's request (native-tls: OpenSSL with the
 * system's trust) both check the stand-in's certificate against the SYSTEM's certificate store, and
 * both look the names up through the system's resolver. Nothing in the shell, the service or the
 * interface is relaxed for this. Instead, and only when `AO_E2E_SYSTEM_SETUP=1` is set, this module
 * (`SystemSetup.prepare`), in this order:
 *
 *  1. takes the run's lock, `/var/lib/ao-e2e-library-standin/lock` (exclusive creation; the run's id
 *     and process id): one run at a time (R346 e). A lock whose process is gone is taken over, and only
 *     together with step 2;
 *  2. if an earlier run's record is there (a run killed outright), puts the machine back from it first
 *     — the hosts file exactly (its bytes, mode, owner and times), the authority's file and links
 *     removed and the store rebuilt with an empty hooks folder, the folders' times, its work folder
 *     removed — and checks the result against the record; if it cannot, the run FAILS with what it
 *     found (R346 a). Leftovers with no record are refused, not guessed at;
 *  3. writes, BEFORE it changes anything, the record of what it will change and how to put it back
 *     (`record.json` and the hosts file's original bytes, `hosts.orig`, in that folder);
 *  4. makes a throw-away certificate authority that can vouch ONLY for names under the stand-in's
 *     made-up domain (a critical name constraint) and a certificate for the stand-in's names, with the
 *     system's `openssl` in a private folder, valid one day; the authority's key (and the server's) is
 *     deleted from disk as soon as the one certificate is signed, before the store trusts it;
 *  5. adds that authority to the system's store: one file `/usr/local/share/ca-certificates/
 *     ao-e2e-library-standin-<run>.crt`, then `update-ca-certificates` with an EMPTY hooks folder (so
 *     that no other store, such as Java's, is touched) — after trying it on a COPY of the store, which
 *     must come out unchanged, or the run could not put the store back exactly;
 *  6. maps the made-up names (all under `ao-library-standin.test`, a name that cannot exist: `.test` is
 *     reserved, RFC 6761) to 127.0.0.1 by appending one marked block to `/etc/hosts` (written in place:
 *     the file may be a mount);
 *
 * and `undo()` puts everything back from the same record (step 2's restore) and proves it: the hosts
 * file's bytes, mode, owner and modification time; every entry of `/etc/ssl/certs` and of the local
 * authorities' folder (name, kind, link target or content, mode); the modification times of those two
 * folders and of the bundle (R346 g). Any difference is a failure. What cannot be put back: the hosts
 * file's and the folders' change times (ctime), and the regenerated bundle's inode. `undo()` is
 * synchronous and idempotent: the spec calls it after the scenarios, and on SIGINT, SIGTERM, SIGHUP and
 * the process's exit.
 *
 * Before any of it (`machineObstacle`, looking only): Linux, root, the tools (`openssl`,
 * `update-ca-certificates`, `touch`), and a network namespace with the loopback interface alone (R346 d,
 * made by `e2e/netns.mjs`). With the switch set, any obstacle FAILS the run with its reason (R346 c,
 * `decide`); without it the scenarios are NOT RUN, with the reason.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Where the set-up works: the machine's own files, or a sandbox's (system-setup.test.ts). */
export interface Machine {
  hosts: string;
  /** The local authorities' folder (update-ca-certificates' --localcertsdir). */
  localCa: string;
  /** The store (update-ca-certificates' --etccertsdir). */
  etcCerts: string;
  /** The run's own folder: the lock, the record of what it changes, the hosts file's original. */
  state: string;
  /** Where the run's work folder (the certificates) is made. */
  tmp: string;
  /** update-ca-certificates' other options (a sandbox's configuration and certificates folder; none on the machine). */
  storeArgs: string[];
}

export const STATE_DIR = "/var/lib/ao-e2e-library-standin";
export const MACHINE: Machine = { hosts: HOSTS_FILE, localCa: LOCAL_CA_DIR, etcCerts: ETC_CERTS_DIR, state: STATE_DIR, tmp: tmpdir(), storeArgs: [] };
/** The tools the set-up runs (the machine's, not the project's). */
export const SETUP_TOOLS = ["openssl", "update-ca-certificates", "touch"];

function run(cmd: string, args: string[], what: string): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", TMPDIR: tmpdir() } });
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 500)}`);
  return r.stdout;
}

/** `update-ca-certificates` on `etcCerts`, with an EMPTY hooks folder (no other store, such as Java's, is touched). */
function updateStore(m: Machine, etcCerts: string, emptyHooks: string): void {
  run("update-ca-certificates", [...m.storeArgs, "--localcertsdir", m.localCa, "--etccertsdir", etcCerts, "--hooksdir", emptyHooks], "update-ca-certificates");
}

/** A file's or folder's access and modification times, to the nanosecond ("<seconds>.<nanoseconds>"). */
interface Times {
  a: string;
  m: string;
}
const ns = (t: bigint) => `${t / 1_000_000_000n}.${String(t % 1_000_000_000n).padStart(9, "0")}`;
function timesOf(p: string): Times {
  const st = lstatSync(p, { bigint: true });
  return { a: ns(st.atimeNs), m: ns(st.mtimeNs) };
}
/** Puts both times back exactly (touch takes nanoseconds; node's utimes does not). */
function putTimes(p: string, t: Times): void {
  run("touch", ["-a", "-d", `@${t.a}`, "--", p], "putting back the access time");
  run("touch", ["-m", "-d", `@${t.m}`, "--", p], "putting back the modification time");
}

export interface Certificates {
  /** The authority's certificate (PEM): what the system is made to trust. */
  caPem: string;
  /** The stand-in's certificate (PEM) for every name, signed by the authority, and its key (kept in memory only). */
  certPem: string;
  keyPem: string;
}

/**
 * The authority's extensions (R346 a): an authority for one level only, that may sign certificates and
 * nothing else, and — CRITICAL, so that a client that does not understand it refuses it — only for
 * names under the stand-in's made-up domain (every stand-in name is under it; the bare domain is not
 * used). OpenSSL (the shell's request) and GnuTLS (the web view) both enforce it.
 */
export const AUTHORITY_EXTENSIONS = ["basicConstraints=critical,CA:TRUE,pathlen:0", "keyUsage=critical,keyCertSign,cRLSign", `nameConstraints=critical,permitted;DNS:.${STANDIN_DOMAIN}`];

/** The throw-away authority's recipe: `ca.pem` and its key `ca.key` in `dir` (one day). */
export function makeAuthority(dir: string, runId: string): void {
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "ca.key"), "-out", join(dir, "ca.pem"), "-days", "1", "-subj", `/CN=AO e2e library stand-in throw-away authority ${runId}`, ...AUTHORITY_EXTENSIONS.flatMap((e) => ["-addext", e])], "making the throw-away authority");
}

/**
 * A throw-away authority and a certificate for `names`, made with the system's openssl in `dir` (one
 * day). The authority's key is deleted as soon as the one certificate is signed (it can sign nothing
 * more), and the server's key is read and deleted too: no key is left on disk.
 */
export function makeCertificates(dir: string, names: string[], runId: string): Certificates {
  if (!standinNamesOk(names)) throw new Error("only names under the stand-in's made-up domain get a certificate");
  const f = (n: string) => join(dir, n);
  writeFileSync(f("server.ext"), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((n) => `DNS:${n}`).join(",")}\n`);
  try {
    makeAuthority(dir, runId);
    run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", f("server.key"), "-out", f("server.csr"), "-subj", `/CN=${names[0]}`], "making the stand-in's key");
    run("openssl", ["x509", "-req", "-in", f("server.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("server.pem"), "-days", "1", "-extfile", f("server.ext")], "signing the stand-in's certificate");
    return { caPem: readFileSync(f("ca.pem"), "utf8"), certPem: readFileSync(f("server.pem"), "utf8"), keyPem: readFileSync(f("server.key"), "utf8") };
  } finally {
    for (const k of ["ca.key", "server.key"]) rmSync(f(k), { force: true });
  }
}

/** Whether `/proc/self/net/dev` lists the loopback interface and nothing else (undefined), or what else it lists. */
export function loopbackOnly(netDev: string): string | undefined {
  const names = netDev
    .split("\n")
    .slice(2)
    .map((l) => l.split(":")[0]!.trim())
    .filter(Boolean);
  const other = names.filter((n) => n !== "lo");
  if (other.length) return `the network namespace has other interfaces than the loopback (${other.join(", ")}), so an outside server could be reached`;
  return names.includes("lo") ? undefined : "the network namespace has no loopback interface";
}

/** What `decide` says before the scenarios (R346 c). */
export type SetupOutcome = { kind: "run" } | { kind: "not-run"; reason: string } | { kind: "fail"; reason: string };
/** The start of the reason a run fails with when the set-up was asked for and cannot be made (said in the run's last lines). */
export const SETUP_FAILED = "FAILED: the library scenarios were asked for (AO_E2E_SYSTEM_SETUP=1) but the machine's set-up cannot be made:";

/**
 * Without the switch: NOT RUN with the reason, and nothing is looked at. With it: any obstacle FAILS
 * the run (asked-for scenarios that did not run are never green), with its reason; none: they run.
 */
export function decide(env: Record<string, string | undefined>, obstacle: () => string | undefined): SetupOutcome {
  if (env[SYSTEM_SETUP_SWITCH] !== "1") return { kind: "not-run", reason: NOT_ASKED };
  const o = obstacle();
  return o ? { kind: "fail", reason: `${SETUP_FAILED} ${o}` } : { kind: "run" };
}

/**
 * What stands in the way on this machine, looking only (undefined: none): Linux, root, the tools, and
 * a network namespace with only the loopback interface (made by `e2e/netns.mjs`, which the package's
 * `e2e` command runs first; R346 d).
 */
export function machineObstacle(): string | undefined {
  if (process.platform !== "linux") return `the machine's set-up is written for Linux (this is ${process.platform})`;
  if (process.getuid?.() !== 0) return "it needs root (it changes /etc/hosts and the system's certificate store, and puts both back)";
  for (const tool of SETUP_TOOLS) if (spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0) return `${tool} is not installed`;
  let netDev: string;
  try {
    netDev = readFileSync("/proc/self/net/dev", "utf8");
  } catch {
    return "the network interfaces cannot be read (/proc/self/net/dev)";
  }
  const ns = loopbackOnly(netDev);
  if (ns) return `${ns}: run it through \`pnpm --filter @ao/desktop run e2e\`, which starts it in a namespace with only the loopback interface`;
  return undefined;
}

/**
 * What the run will change and how to put it back, written in the state folder BEFORE anything is
 * changed (R346 a): a later run that finds it puts the machine back from it first.
 */
interface SetupRecord {
  v: 1;
  runId: string;
  pid: number;
  names: string[];
  /** The hosts file's mode, owner and times (its bytes: `hosts.orig` beside the record). */
  hosts: { mode: number; uid: number; gid: number; times: Times };
  /** The authority's file in the local authorities' folder, and its link's name in the store. */
  caFile: string;
  pem: string;
  /** The work folder (where the certificates were made; their keys are deleted at once). */
  work: string;
  /** The times of the store's folder, its bundle and the local authorities' folder, as they were. */
  times: Array<[string, Times]>;
  storeBefore: Array<[string, string]>;
  localBefore: Array<[string, string]>;
}

const RECORD = "record.json";
const HOSTS_ORIG = "hosts.orig";
const LOCK = "lock";
const TAKEOVER = "takeover";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The state folder, made when missing; refused when it is a link, not a folder or not this user's. */
function stateFolder(m: Machine): void {
  try {
    mkdirSync(m.state, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`the state folder ${m.state} cannot be made: ${(err as Error).message}`);
  }
  const st = lstatSync(m.state);
  if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error(`${m.state} is not a folder of this user's`);
  if ((st.mode & 0o7777) !== 0o700) refuse(m, "the state folder", `has mode ${(st.mode & 0o7777).toString(8)}, not 0700`);
}

/**
 * The refusal of a record (or of the folder it is in) that is not exactly what `apply` writes: it
 * names the field, and says that nothing was changed and where the clean-up by hand is described (R350).
 */
function refuse(m: Machine, field: string, why: string): never {
  throw new Error(
    `the record of an earlier run in ${m.state} is refused: ${field} ${why}; nothing was changed (no file, link, mode, owner or time; the record and the state folder are as they were). apps/desktop/README.md, "If such a run was killed outright", says how to clean up by hand`,
  );
}

/** A file of the state folder, read only when it is a regular file (not a link) of this user's: lstat, then O_NOFOLLOW, then the descriptor's own fstat must be the same file. */
function readStateFile(m: Machine, name: string): Buffer {
  const p = join(m.state, name);
  const st = lstatSync(p);
  if (!st.isFile() || st.uid !== process.getuid?.()) refuse(m, name, "is not a regular file (or a link, or not this user's)");
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const open = fstatSync(fd);
    if (open.dev !== st.dev || open.ino !== st.ino) refuse(m, name, "changed while it was being opened");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Takes the run's lock (R346 e): `<state>/lock`, made with exclusive creation, holding the run's id
 * and process id. A lock whose process is gone is taken over (under `<state>/takeover`, made
 * exclusively, so that two runs cannot both take it); the caller then puts the machine back from the
 * dead run's record before anything else. A lock whose process is running: refused, with the reason.
 */
function takeLock(m: Machine, runId: string, pid: number): { stale?: { runId: string; pid: number } } {
  const lock = join(m.state, LOCK);
  const mine = JSON.stringify({ runId, pid, since: new Date().toISOString() });
  try {
    writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const text = readFileSync(lock, "utf8");
  let held: { runId?: string; pid?: number } = {};
  try {
    held = JSON.parse(text) as typeof held;
  } catch {
    /* unreadable: treated as held by no process */
  }
  if (typeof held.pid === "number" && alive(held.pid)) throw new Error(`another run of the library scenarios (run ${held.runId}, process ${held.pid}) holds ${lock}; one run at a time`);
  try {
    mkdirSync(join(m.state, TAKEOVER));
  } catch {
    throw new Error(`another run is taking over the lock of a run that is gone (${join(m.state, TAKEOVER)}); if no run is going, remove that folder`);
  }
  try {
    if (readFileSync(lock, "utf8") !== text) throw new Error(`another run took over ${lock} meanwhile`);
    writeFileSync(`${lock}.${runId}`, mine, { mode: 0o600 });
    renameSync(`${lock}.${runId}`, lock);
  } finally {
    rmdirSync(join(m.state, TAKEOVER));
  }
  return { stale: { runId: String(held.runId), pid: Number(held.pid) } };
}

/** Lets the lock go and removes the state folder once nothing else is in it. */
function releaseLock(m: Machine, runId: string): void {
  const lock = join(m.state, LOCK);
  try {
    if ((JSON.parse(readFileSync(lock, "utf8")) as { runId?: string }).runId === runId) unlinkSync(lock);
  } catch {
    /* not ours, or gone */
  }
  try {
    rmdirSync(m.state);
  } catch {
    /* a record kept for the next run */
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isTimes = (t: unknown): t is Times => isObject(t) && typeof t.a === "string" && /^\d+\.\d{9}$/.test(t.a) && typeof t.m === "string" && /^\d+\.\d{9}$/.test(t.m);
const isPair = (x: unknown): x is [string, string] => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string";

/** The record read from the state folder, and checked against exactly what `apply` writes, before anything is done with it (R350). */
function parseRecord(m: Machine, text: string): SetupRecord {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    return refuse(m, RECORD, "is not valid JSON");
  }
  if (!isObject(r)) return refuse(m, RECORD, "is not an object");
  if (r.v !== 1) refuse(m, "the version (v)", `is ${JSON.stringify(r.v)}, not 1`);
  if (typeof r.runId !== "string" || !/^[0-9a-f]{12}$/.test(r.runId)) refuse(m, "runId", "is not twelve lower-case hexadecimal digits");
  const runId = r.runId;
  if (!Number.isSafeInteger(r.pid) || (r.pid as number) < 0) refuse(m, "pid", "is not a process id");
  if (!Array.isArray(r.names) || !r.names.every((n) => typeof n === "string") || !standinNamesOk(r.names as string[])) refuse(m, "names", "are not only the stand-in's own names");
  const h = r.hosts;
  if (!isObject(h) || !isTimes(h.times)) refuse(m, "hosts", "is not a mode, owner and well-formed times");
  const hosts = h as Record<string, unknown>;
  if (!Number.isInteger(hosts.mode) || ((hosts.mode as number) & ~0o644) !== 0) refuse(m, "hosts.mode", `is ${String(hosts.mode)}: not a plain permission no wider than 0644`);
  const now = statSync(m.hosts);
  for (const [k, present] of [["uid", now.uid], ["gid", now.gid]] as const)
    if (hosts[k] !== present && hosts[k] !== 0) refuse(m, `hosts.${k}`, `is ${String(hosts[k])}: neither the hosts file's present ${k} (${present}) nor 0`);
  if (r.caFile !== join(m.localCa, `${MARK}-${runId}.crt`)) refuse(m, "caFile", `is ${String(r.caFile)}, not ${join(m.localCa, `${MARK}-${runId}.crt`)}`);
  if (r.pem !== `${MARK}-${runId}.pem`) refuse(m, "pem", `is ${String(r.pem)}, not ${MARK}-${runId}.pem`);
  if (r.work !== join(m.tmp, `ao-e2e-system-setup-${runId}`)) refuse(m, "work", `is ${String(r.work)}, not the run's own folder`);
  const allowed = [m.etcCerts, join(m.etcCerts, "ca-certificates.crt"), m.localCa];
  if (!Array.isArray(r.times) || !r.times.every((t) => Array.isArray(t) && t.length === 2 && typeof t[0] === "string" && allowed.includes(t[0]) && isTimes(t[1])))
    refuse(m, "times", `names a path other than ${allowed.join(", ")}, or has times that are not well formed`);
  for (const k of ["storeBefore", "localBefore"]) if (!Array.isArray(r[k]) || !(r[k] as unknown[]).every(isPair)) refuse(m, k, "is not a list of name and description pairs");
  return r as unknown as SetupRecord;
}

/** The earlier run's record, if there is one: the record, `hosts.orig` and the state folder checked before anything is restored. */
function readRecord(m: Machine): SetupRecord | undefined {
  try {
    lstatSync(join(m.state, RECORD));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const rec = parseRecord(m, readStateFile(m, RECORD).toString("utf8"));
  readStateFile(m, HOSTS_ORIG);
  return rec;
}

/**
 * Puts the machine back from a run's record, and proves it: the problems found (empty when the hosts
 * file, the store, the local authorities' folder and their times are exactly as the record says they
 * were). Removes the work folder in any case (it holds no key); removes the record only when nothing
 * is left to put back.
 */
function restore(m: Machine, rec: SetupRecord): string[] {
  const problems: string[] = [];
  const step = (what: string, f: () => void) => {
    try {
      f();
    } catch (err) {
      problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const origPath = join(m.state, HOSTS_ORIG);
  let orig: Buffer | undefined;
  step("the hosts file", () => {
    orig = readStateFile(m, HOSTS_ORIG);
    const now = readFileSync(m.hosts);
    if (!now.equals(orig)) {
      // Only the run's own block is taken out: anything else is not this run's to undo.
      if (now.toString("utf8") !== hostsWith(orig.toString("utf8"), rec.names, rec.runId))
        throw new Error(`${m.hosts} is neither its original nor the original with run ${rec.runId}'s block (changed by something else since?); not touched — its original is in ${origPath}`);
      writeFileSync(m.hosts, orig); // in place: the file may be a mount
    }
    const st = statSync(m.hosts);
    if ((st.mode & 0o7777) !== rec.hosts.mode) chmodSync(m.hosts, rec.hosts.mode);
    if (st.uid !== rec.hosts.uid || st.gid !== rec.hosts.gid) chownSync(m.hosts, rec.hosts.uid, rec.hosts.gid);
    if (timesOf(m.hosts).m !== rec.hosts.times.m) putTimes(m.hosts, rec.hosts.times);
  });
  let removed = false;
  step("the authority's file", () => {
    if (existsSync(rec.caFile)) {
      unlinkSync(rec.caFile);
      removed = true;
    }
  });
  // update-ca-certificates leaves the links of a removed local authority in place (it removes links
  // only for its configuration's "!" lines, or with --fresh, which would remake every link): the two
  // it added are removed here — exactly the links to this run's authority (its `.pem` link, and the
  // hash link to that), found by their targets.
  step("the authority's links", () => {
    const ours = new Set([rec.caFile, rec.pem]);
    for (const name of readdirSync(m.etcCerts)) {
      const p = join(m.etcCerts, name);
      if (lstatSync(p).isSymbolicLink() && ours.has(readlinkSync(p))) {
        unlinkSync(p);
        removed = true;
      }
    }
  });
  const storeBefore = new Map(rec.storeBefore);
  step("the certificate store", () => {
    if (!removed && snapshotDiff(storeBefore, snapshotDir(m.etcCerts)).length === 0) return;
    // The same empty hooks folder as the set-up used: no other store is touched.
    const hooks = join(m.state, "no-hooks");
    mkdirSync(hooks, { recursive: true, mode: 0o700 });
    try {
      updateStore(m, m.etcCerts, hooks);
    } finally {
      rmdirSync(hooks);
    }
  });
  step("the times", () => {
    for (const [p, t] of rec.times) if (timesOf(p).m !== t.m) putTimes(p, t);
  });
  // The proof: compared with what the record says they were.
  step("comparing the hosts file", () => {
    const st = statSync(m.hosts);
    if (orig && !readFileSync(m.hosts).equals(orig)) problems.push(`${m.hosts} is not as it was`);
    if ((st.mode & 0o7777) !== rec.hosts.mode || st.uid !== rec.hosts.uid || st.gid !== rec.hosts.gid) problems.push(`${m.hosts}'s mode or owner is not as it was`);
    if (timesOf(m.hosts).m !== rec.hosts.times.m) problems.push(`${m.hosts}'s modification time is not as it was`);
  });
  step("comparing the store", () => {
    problems.push(...snapshotDiff(storeBefore, snapshotDir(m.etcCerts)).map((x) => `${m.etcCerts}: ${x}`), ...snapshotDiff(new Map(rec.localBefore), snapshotDir(m.localCa)).map((x) => `${m.localCa}: ${x}`));
    for (const [p, t] of rec.times) if (timesOf(p).m !== t.m) problems.push(`${p}'s modification time is not as it was`);
  });
  step("the work folder", () => {
    // Only the run's own folder, by its exact name.
    if (rec.work === join(m.tmp, `ao-e2e-system-setup-${rec.runId}`)) rmSync(rec.work, { recursive: true, force: true });
    else problems.push(`the record names a work folder that is not the run's (${rec.work}); not removed`);
  });
  if (problems.length === 0) for (const f of [RECORD, HOSTS_ORIG]) rmSync(join(m.state, f), { force: true });
  else problems.push(`the record of run ${rec.runId} is kept in ${join(m.state, RECORD)} (the hosts file's original beside it)`);
  return problems;
}

/** Leftovers of a run that left no record (an older run's, or one killed before its record was written whole). */
function unrecordedLeftover(m: Machine): string | undefined {
  const hosts = lstatSync(m.hosts);
  if (!hosts.isFile()) return `${m.hosts} is not a plain file, so it could not be put back exactly`;
  if (hostsHoldsLeftover(readFileSync(m.hosts, "utf8"))) return `${m.hosts} still holds a block of an earlier run (marked ${MARK}) and there is no record of that run to put it back from; remove it by hand as apps/desktop/README.md says`;
  if (!existsSync(m.localCa) || !statSync(m.localCa).isDirectory()) return `${m.localCa} is not there`;
  if (readdirSync(m.localCa).some((n) => n.startsWith(MARK))) return `${m.localCa} still holds an authority of an earlier run (${MARK}-*.crt) and there is no record of that run; remove it by hand as apps/desktop/README.md says`;
  if (readdirSync(m.etcCerts).some((n) => n.startsWith(MARK))) return `${m.etcCerts} still holds the link of an earlier run's authority (${MARK}-*.pem) and there is no record of that run; remove it by hand as apps/desktop/README.md says`;
  return undefined;
}

/** The set-up as applied: `undo()` puts the machine back (synchronous, idempotent). */
export class SystemSetup {
  private undone = false;
  private constructor(
    readonly runId: string,
    readonly certificates: Certificates,
    private readonly m: Machine,
    private readonly record: SetupRecord,
    /** What the run put back of an earlier, killed run before it began (undefined: there was nothing). */
    readonly restored: string | undefined,
  ) {}

  /**
   * The whole set-up for `names`, in this order: the lock (R346 e); an earlier run's leftovers put back
   * from its record (R346 a), or refused when they cannot be put back exactly; the checks; the record
   * of what will change, written first; then the changes (see the file comment). Throws with the reason,
   * having put back whatever it changed and let the lock go, when it cannot. `pid` is the process the
   * lock names (this one; a test names a gone one to stand for a killed run).
   */
  static prepare(names: string[], m: Machine = MACHINE, pid: number = process.pid): SystemSetup {
    if (!standinNamesOk(names)) throw new Error("only names under the stand-in's made-up domain are mapped");
    const runId = randomBytes(6).toString("hex");
    stateFolder(m);
    const { stale } = takeLock(m, runId, pid);
    let restored: string | undefined;
    try {
      const earlier = readRecord(m);
      if (earlier) {
        const left = restore(m, earlier);
        if (left.length) throw new Error(`an earlier run's leftovers (run ${earlier.runId}${stale ? `, process ${stale.pid}, gone` : ""}) could not be put back exactly: ${left.join("; ")}`);
        restored = `put back what run ${earlier.runId} (killed${stale ? `, process ${stale.pid}` : ""}) had left: the hosts file, the authority and its links, the store, the times, its work folder`;
      }
      const leftover = unrecordedLeftover(m);
      if (leftover) throw new Error(leftover);
      return SystemSetup.apply(names, m, runId, pid, restored);
    } catch (err) {
      releaseLock(m, runId);
      throw err;
    }
  }

  private static apply(names: string[], m: Machine, runId: string, pid: number, restored: string | undefined): SystemSetup {
    const work = join(m.tmp, `ao-e2e-system-setup-${runId}`);
    const bundle = join(m.etcCerts, "ca-certificates.crt");
    const st = statSync(m.hosts);
    // R350: a record is restored only when its hosts mode is no wider than 0644, so a machine whose
    // hosts file is wider is not changed at all (a killed run there could not be put back from its record).
    if (((st.mode & 0o7777) & ~0o644) !== 0)
      throw new Error(`the hosts file ${m.hosts} has mode ${(st.mode & 0o7777).toString(8)}, wider than 0644: the set-up does not change such a machine; nothing was changed`);
    const hostsBytes = readFileSync(m.hosts);
    const record: SetupRecord = {
      v: 1,
      runId,
      pid,
      names,
      hosts: { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, times: timesOf(m.hosts) },
      caFile: join(m.localCa, `${MARK}-${runId}.crt`),
      pem: `${MARK}-${runId}.pem`,
      work,
      times: [m.etcCerts, bundle, m.localCa].filter((p) => existsSync(p)).map((p) => [p, timesOf(p)]),
      storeBefore: [...snapshotDir(m.etcCerts)],
      localBefore: [...snapshotDir(m.localCa)],
    };
    // The record first (the hosts file's bytes, then the record itself, whole or not at all).
    writeFileSync(join(m.state, HOSTS_ORIG), hostsBytes, { mode: 0o600 });
    writeFileSync(join(m.state, `${RECORD}.new`), JSON.stringify(record), { mode: 0o600 });
    renameSync(join(m.state, `${RECORD}.new`), join(m.state, RECORD));
    let certificates: Certificates | undefined;
    try {
      mkdirSync(work, { mode: 0o700 });
      const emptyHooks = join(work, "no-hooks");
      mkdirSync(emptyHooks);
      // The store must be what update-ca-certificates itself makes of it, or it could not be put back
      // exactly: tried on a copy first.
      const copy = join(work, "certs-copy");
      cpSync(m.etcCerts, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      updateStore(m, copy, emptyHooks);
      const dry = snapshotDiff(new Map(record.storeBefore), snapshotDir(copy));
      rmSync(copy, { recursive: true, force: true });
      if (dry.length) throw new Error(`the certificate store is not what update-ca-certificates makes of it (${dry.slice(0, 5).join(", ")}), so it could not be put back exactly`);
      certificates = makeCertificates(work, names, runId);
      // No key of the authority on disk once the store trusts it (nor the server's).
      const keys = readdirSync(work).filter((n) => /\.key$/.test(n) || (statSync(join(work, n)).isFile() && /PRIVATE KEY/.test(readFileSync(join(work, n), "utf8"))));
      if (keys.length) throw new Error(`a key was left on disk (${keys.join(", ")})`);
      writeFileSync(record.caFile, certificates.caPem, { mode: 0o644, flag: "wx" });
      updateStore(m, m.etcCerts, emptyHooks);
      // What that added: the authority's link and its hash link, nothing else (or it is put back at once).
      const after = snapshotDir(m.etcCerts);
      for (const c of snapshotDiff(new Map(record.storeBefore), after)) {
        const name = c.replace(/^\w+ /, "");
        const what = after.get(name);
        if (!c.startsWith("added ") && name !== "ca-certificates.crt") throw new Error(`update-ca-certificates changed ${name} as well`);
        if (c.startsWith("added ") && what !== `link ${record.caFile}` && what !== `link ${record.pem}`) throw new Error(`update-ca-certificates added ${name}, which is not the authority's link`);
      }
      // In place (the hosts file may be a mount that cannot be replaced).
      writeFileSync(m.hosts, hostsWith(hostsBytes.toString("utf8"), names, runId));
    } catch (err) {
      const left = restore(m, record);
      throw new Error(`${err instanceof Error ? err.message : String(err)}${left.length ? `; and putting the machine back failed: ${left.join("; ")}` : ""}`);
    }
    return new SystemSetup(runId, certificates, m, record, restored);
  }

  /**
   * Puts the machine back and proves it: the problems found (empty when the hosts file, the store and
   * their times are exactly as before). Synchronous and idempotent; the second call answers [] at once.
   * The lock is let go either way; when something could not be put back, the record stays for the next
   * run (or a person) to put it back from.
   */
  undo(): string[] {
    if (this.undone) return [];
    this.undone = true;
    const problems = restore(this.m, this.record);
    releaseLock(this.m, this.runId);
    return problems;
  }

  /** What the scenarios' report says of the machine (no key, no certificate). */
  describe(): string {
    return `hosts block ${MARK} ${this.runId} and authority ${this.record.caFile}`;
  }
}

/**
 * Says at the end of `pnpm --filter @ao/desktop run e2e` how many library scenarios were not run, and
 * why: for want of the switch, NOT RUN (R343 a: never as passed; the exit as before); with the switch
 * set and the set-up refused, FAILED with the reason (R346 c: the run's exit is not 0, since the
 * scenarios' `beforeAll` threw). Listed in playwright.config.ts after the list reporter, so its lines
 * are the last.
 */
export default class LibraryScenariosNotRun implements Reporter {
  private skipped = new Map<string, number>();
  private library = 0;
  private failed: string | undefined;
  onBegin(_config: unknown, suite: Suite): void {
    this.library = suite.allTests().filter((t) => t.location.file.endsWith("library-window.e2e.ts")).length;
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    const message = result.errors.map((e) => e.message ?? "").find((m) => m.includes(SETUP_FAILED));
    if (message) this.failed ??= message.slice(message.indexOf(SETUP_FAILED)).split("\n")[0];
    if (result.status !== "skipped") return;
    const why = test.annotations.find((a) => a.type === "skip" && a.description?.startsWith("not run:"))?.description;
    if (why) this.skipped.set(why, (this.skipped.get(why) ?? 0) + 1);
  }
  onEnd(_result: FullResult): void {
    for (const [why, n] of this.skipped) process.stdout.write(`\n  ${n} library scenario${n === 1 ? "" : "s"} NOT RUN (skipped), not passed — ${why}\n`);
    if (this.failed) process.stdout.write(`\n  ${this.library} library scenario${this.library === 1 ? "" : "s"} not run — ${this.failed}\n`);
  }
  printsToStdio(): boolean {
    return true;
  }
}
