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
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { LookupHttpError } from "./http.js";

export const LOOKUP_FIXTURES_ENV = "AO_LOOKUP_FIXTURES";
const ANSWERS_FILE = "answers.json";

type Answer = { status: 200; file: string } | { status: 404 };

export interface RecordedLookups {
  /** The recorded answer for `url`; throws LookupHttpError when there is none. */
  answer(url: string): { status: 200 | 404; body: string | null };
}

export function recordedLookupsFromEnv(env: NodeJS.ProcessEnv = process.env): RecordedLookups | undefined {
  if (env.NODE_ENV !== "test") return undefined;
  const dir = env[LOOKUP_FIXTURES_ENV];
  if (!dir) return undefined;
  if (!isAbsolute(dir)) throw new Error(`${LOOKUP_FIXTURES_ENV} must be an absolute folder path`);
  let answers: Record<string, Answer>;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ANSWERS_FILE), "utf8")) as { v?: unknown; answers?: unknown };
    if (parsed?.v !== 1 || !parsed.answers || typeof parsed.answers !== "object") throw new Error("not a v1 answers file");
    answers = parsed.answers as Record<string, Answer>;
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
  return {
    answer(url) {
      const a = Object.hasOwn(answers, url) ? answers[url] : undefined;
      if (!a) throw new LookupHttpError("No recorded answer for this lookup (test mode: nothing is fetched)");
      if (a.status === 404) return { status: 404, body: null };
      return { status: 200, body: readFileSync(join(dir, a.file), "utf8") };
    },
  };
}
