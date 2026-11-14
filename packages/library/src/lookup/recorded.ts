/**
 * Recorded lookup answers for end-to-end tests (R47, R130).
 *
 * `AO_LOOKUP_FIXTURES=<absolute folder>` makes every HttpClient answer lookups from the folder's
 * `answers.json` instead of the metadata services, but ONLY when `NODE_ENV=test`: in any other mode
 * the variable is ignored. The switch fails closed: a lookup whose URL has no recorded answer is a
 * LookupHttpError and nothing is fetched; a folder without a readable answers file stops the client
 * from being made at all.
 *
 *   answers.json  { "v": 1, "answers": { "<exact URL>": { "status": 200, "file": "<file in the folder>" }
 *                                        "<exact URL>": { "status": 404 } } }
 *
 * The answer files are the plain response bodies the library's own tests use
 * (tests/fixtures/lookup/*.json), so one recording serves both.
 *
 * FILE downloads (Find and acquire Task F14, Ruling R317): the same switch answers a free copy's download too, so
 * that in test mode with the switch on the download code never reaches the network. An optional second map, apart
 * from the lookups' (a lookup is never answered from it, nor a download from `answers`):
 *
 *   "files": { "<exact file address>": { "status": 200, "file": "<file in the folder>", "headers"?: { "<name>": "<value>" } }
 *              "<exact file address>": { "status": 301|302|303|307|308, "location": "<address, absolute or relative>" } }
 *
 * A file's bytes are served as they are (binary). They reach `fetchFile` (find/fetch-file.ts) through
 * `RecordedFiles.dispatcher`, handed to undici's `request` in place of the process's dispatcher, so the download
 * runs the SAME code from the first byte on: the host rule on every address and every redirect, at most three
 * redirects, the size limit by the bytes that pass, `content-encoding`, the type by the complete file's bytes, the
 * checksum, the part file. Any address without a file answer — on any host — is answered 404, which the download
 * says as "The service did not send the file."; the dispatcher has no way to the network (an undici MockAgent with
 * net connect disabled, whose one catch-all interceptor answers every request from the map).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { MockAgent, type Dispatcher } from "undici";
import { LookupHttpError } from "./http.js";

export const LOOKUP_FIXTURES_ENV = "AO_LOOKUP_FIXTURES";
const ANSWERS_FILE = "answers.json";

type Answer = { status: 200; file: string } | { status: 404 };
type FileAnswer = { status: 200; file: string; headers?: Record<string, string> } | { status: 301 | 302 | 303 | 307 | 308; location: string };
const REDIRECT_STATUSES: ReadonlySet<unknown> = new Set([301, 302, 303, 307, 308]);
const HEADER_NAME = /^[a-z0-9-]{1,64}$/u;

/**
 * The recorded FILE answers (R317), made only by `recordedLookupsFromEnv` (so only under NODE_ENV=test with the
 * switch set); `fetchFile` takes nothing else as recorded answers.
 */
export class RecordedFiles {
  /** Answers every request from the files map; a request it has no answer for is a 404. Never reaches the network. */
  readonly dispatcher: Dispatcher;
  /** @internal Made by `recordedLookupsFromEnv` only. */
  constructor(dir: string, files: Readonly<Record<string, FileAnswer>>) {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(() => true)
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => {
        const url = `${new URL(String(opts.origin)).origin}${opts.path}`;
        const a = opts.method === "GET" && Object.hasOwn(files, url) ? files[url] : undefined;
        if (!a) return { statusCode: 404, data: "" };
        if (a.status === 200) return { statusCode: 200, data: readFileSync(join(dir, a.file)), responseOptions: { headers: { ...a.headers } } };
        return { statusCode: a.status, data: "", responseOptions: { headers: { location: a.location } } };
      })
      .persist();
    this.dispatcher = agent;
  }
}

export interface RecordedLookups {
  /** The recorded answer for `url`; throws LookupHttpError when there is none. */
  answer(url: string): { status: 200 | 404; body: string | null };
  /** The recorded file downloads (R317); every address without one is answered 404. */
  readonly files: RecordedFiles;
}

function plainFileIn(dir: string, file: unknown, url: string): void {
  if (typeof file !== "string" || basename(file) !== file || file.startsWith(".")) {
    throw new Error(`${LOOKUP_FIXTURES_ENV}: the file answer for ${url} needs a plain file name in the folder`);
  }
  if (!existsSync(join(dir, file))) throw new Error(`${LOOKUP_FIXTURES_ENV}: the file answer for ${url} names ${file}, which is not in the folder`);
}

/** The optional "files" map, checked whole at start (fails closed like the lookups' map). */
function checkFiles(dir: string, raw: unknown): Record<string, FileAnswer> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${LOOKUP_FIXTURES_ENV}: "files" in ${ANSWERS_FILE} must be an object of file answers`);
  const files = raw as Record<string, FileAnswer>;
  for (const [url, a] of Object.entries(files)) {
    let href: string;
    try {
      href = new URL(url).href;
    } catch {
      throw new Error(`${LOOKUP_FIXTURES_ENV}: the file answer for ${url} is not under an address`);
    }
    if (href !== url) throw new Error(`${LOOKUP_FIXTURES_ENV}: the file answer for ${url} is not under an address written as a download asks it (${href})`);
    if (a?.status === 200) {
      plainFileIn(dir, a.file, url);
      const h: unknown = a.headers;
      if (h !== undefined && (!h || typeof h !== "object" || Array.isArray(h) || Object.entries(h).some(([k, v]) => !HEADER_NAME.test(k) || typeof v !== "string"))) {
        throw new Error(`${LOOKUP_FIXTURES_ENV}: the file answer for ${url} has headers that are not lower-case names with text values`);
      }
      continue;
    }
    if (REDIRECT_STATUSES.has(a?.status)) {
      const loc: unknown = (a as { location?: unknown }).location;
      if (typeof loc !== "string" || loc === "") throw new Error(`${LOOKUP_FIXTURES_ENV}: the redirect for ${url} needs a location`);
      continue;
    }
    throw new Error(`${LOOKUP_FIXTURES_ENV}: the file answer for ${url} needs status 200 with a file, or a redirect status (301, 302, 303, 307, 308) with a location`);
  }
  return files;
}

export function recordedLookupsFromEnv(env: NodeJS.ProcessEnv = process.env): RecordedLookups | undefined {
  if (env.NODE_ENV !== "test") return undefined;
  const dir = env[LOOKUP_FIXTURES_ENV];
  if (!dir) return undefined;
  if (!isAbsolute(dir)) throw new Error(`${LOOKUP_FIXTURES_ENV} must be an absolute folder path`);
  let answers: Record<string, Answer>;
  let rawFiles: unknown;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ANSWERS_FILE), "utf8")) as { v?: unknown; answers?: unknown; files?: unknown };
    if (parsed?.v !== 1 || !parsed.answers || typeof parsed.answers !== "object") throw new Error("not a v1 answers file");
    answers = parsed.answers as Record<string, Answer>;
    rawFiles = parsed.files;
  } catch (e) {
    throw new Error(`${LOOKUP_FIXTURES_ENV}: ${ANSWERS_FILE} in that folder could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  for (const [url, a] of Object.entries(answers)) {
    if (a?.status === 404) continue;
    if (a?.status !== 200 || typeof a.file !== "string" || basename(a.file) !== a.file || a.file.startsWith(".")) {
      throw new Error(`${LOOKUP_FIXTURES_ENV}: the answer for ${url} needs status 200 with a plain file name in the folder, or status 404`);
    }
    if (!existsSync(join(dir, a.file))) throw new Error(`${LOOKUP_FIXTURES_ENV}: the answer for ${url} names ${a.file}, which is not in the folder`);
  }
  const files = new RecordedFiles(dir, checkFiles(dir, rawFiles));
  return {
    files,
    answer(url) {
      const a = Object.hasOwn(answers, url) ? answers[url] : undefined;
      if (!a) throw new LookupHttpError("No recorded answer for this lookup (test mode: nothing is fetched)");
      if (a.status === 404) return { status: 404, body: null };
      return { status: 200, body: readFileSync(join(dir, a.file), "utf8") };
    },
  };
}
