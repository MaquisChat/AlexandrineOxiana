/**
 * Decision 31 (c), "Look up again" (R566, R577): the pure rules of a review entry's left-out lookups — their state for
 * display, the sentence that stands for it in the entry's reasons, how later matches join the entry's candidates, and
 * the bounds and waits of the automatic pass (declared here, once).
 *
 *  - Candidates are only ever APPENDED (R566 1): the page accepts a match by its position in `candidates`, so an existing
 *    one never moves, is never replaced and is never pushed out. One look-up adds at most three new matches (the
 *    resolution's own cap per item), so an entry looked up again may list more than three; every one of them is listed
 *    and accepted by its position as before.
 *  - The state is read from the `leftOut` items' optional fields (R566 7). "Waiting for lookup service response." stays
 *    only while an asked-to-wait lookup has no outcome yet; a lookup that failed outright never makes an entry read so.
 */
import { LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT, lookUpGaveUpText } from "@ao/shared";
import type { LookupResult } from "../lookup/index.js";
import { MAX_HOLD_MS } from "../lookup/http.js";
import type { LeftOutLookup, ReviewEntry } from "../repo/review.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The automatic pass's bounds (R566 5): at most `maxAutomaticTries` tries for each left-out lookup; before automatic try
 * k+1 the wait `waitsMs[k]` has passed since the last try (the attach itself counts as the try before the first, from the
 * entry's creation) — and the service's own later time (`notBefore`) always. `newCandidatesPerLookUp`: at most this many
 * matches join an entry's candidates in one look-up.
 */
export const LOOK_UP_AGAIN_BOUNDS = {
  maxAutomaticTries: 5,
  waitsMs: [15 * MINUTE, HOUR, 4 * HOUR, 12 * HOUR, 24 * HOUR] as readonly number[],
  newCandidatesPerLookUp: 3,
} as const;

/**
 * R585 M1: a kept time that only a wrong clock could have written counts as PASSED. The client never holds a service
 * longer than MAX_HOLD_MS (an hour), so a `notBefore` further ahead than that cannot be a service's; the longest wait
 * between automatic tries is the last of `waitsMs` (24 hours), so a `lastTriedAt` further ahead than that, with an
 * hour's margin, cannot be a try's. Every real wait is below these bounds and unchanged (R411).
 */
export const WRONG_CLOCK_BOUNDS = {
  notBeforeAheadMs: MAX_HOLD_MS,
  lastTriedAheadMs: Math.max(...LOOK_UP_AGAIN_BOUNDS.waitsMs) + HOUR,
} as const;

const kept = (iso: string | undefined, now: number, aheadMs: number): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) || t > now + aheadMs ? undefined : t;
};
/** The lookup's `notBefore` (ms), or undefined when it has none or only a wrong clock could have written it (M1). */
export const keptNotBefore = (l: LeftOutLookup, now: number) => kept(l.notBefore, now, WRONG_CLOCK_BOUNDS.notBeforeAheadMs);
/** The lookup's `lastTriedAt` (ms), or undefined when it has none or only a wrong clock could have written it (M1). */
export const keptLastTriedAt = (l: LeftOutLookup, now: number) => kept(l.lastTriedAt, now, WRONG_CLOCK_BOUNDS.lastTriedAheadMs);

/** Outcomes that end a lookup for everyone: it is never asked again. */
const FINAL_OUTCOMES = new Set<LeftOutLookup["outcome"]>(["found", "nothing"]);
export const isAnswered = (l: LeftOutLookup): boolean => FINAL_OUTCOMES.has(l.outcome);

/**
 * Whether the RESEARCHER's act may ask this lookup now: not answered yet, and its service's time has passed (R411,
 * R577 iii; a lookup that failed outright has no time to wait for; a time only a wrong clock could have written counts
 * as passed, M1). The one rule `lookUpAgain` (by: "researcher") and `lookUpNow` both apply.
 */
export function askableByHand(l: LeftOutLookup, now: number): boolean {
  if (isAnswered(l)) return false;
  const t = keptNotBefore(l, now);
  return t === undefined || t <= now;
}

/**
 * For the service and the page: whether the researcher's "Look up again" would send something for this entry now,
 * and if not, the earliest time at which it would — exactly the rules `lookUpAgain` applies for `by: "researcher"`
 * (it uses this function for its "not yet"). Not now and no time: nothing is left to look up (or the entry is no
 * longer pending). Only the entry is known here: a service the client holds in memory since (it asked to wait again)
 * can still make `lookUpAgain` answer "not yet" with the hold's time.
 */
export function lookUpNow(entry: { leftOut?: LeftOutLookup[]; status?: string }, now: Date): { canLookUpNow: boolean; notBefore?: string } {
  if (entry.status !== undefined && entry.status !== "pending") return { canLookUpNow: false };
  const t = now.getTime();
  const left = entry.leftOut ?? [];
  if (left.some((l) => askableByHand(l, t))) return { canLookUpNow: true };
  const later = left
    .filter((l) => !isAnswered(l))
    .map((l) => [keptNotBefore(l, t), l.notBefore] as const)
    .filter(([k]) => k !== undefined && k > t)
    .sort(([a], [b]) => a! - b!);
  return later.length ? { canLookUpNow: false, notBefore: later[0]![1]! } : { canLookUpNow: false };
}

/** The key two matches are the same by: the one the resolution's `addCandidate` uses (provider, DOI, title in any case). */
export function candidateKeyOf(c: Pick<LookupResult, "provider" | "identifiers" | "title">): string {
  return `${c.provider}|${c.identifiers?.doi ?? ""}|${String(c.title ?? "").toLowerCase()}`;
}

/** A stored candidate's key; one that is not a lookup result's shape is keyed by its whole text (never equal to a result's). */
function storedKey(c: unknown): string {
  const x = c as Partial<LookupResult> | null;
  return x && typeof x === "object" && typeof x.provider === "string" && typeof x.title === "string" ? candidateKeyOf(x as LookupResult) : `\u0000${JSON.stringify(c)}`;
}

/**
 * `existing` with the matches of `found` not already listed appended after it, in their order: at most `limit` new ones.
 * Never reorders, replaces or drops an existing candidate (R566 1). Returns a new array.
 */
export function appendCandidates(existing: readonly unknown[] | undefined, found: readonly LookupResult[], limit: number = LOOK_UP_AGAIN_BOUNDS.newCandidatesPerLookUp): unknown[] {
  const out = [...(existing ?? [])];
  const keys = new Set(out.map(storedKey));
  let added = 0;
  for (const r of found) {
    if (added >= limit) break;
    const k = candidateKeyOf(r);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(r);
    added++;
  }
  return out;
}

/** A lookup left out because its service asked to wait (absent `why`: an entry of decision 31 b). */
export const isAskedToWait = (l: LeftOutLookup): boolean => l.why !== "failed";

export type LookUpState = "waiting" | "found" | "nothing" | "not-allowed" | "gave-up" | "failed";

/** An entry's look-up state for display. */
export interface LookUpView {
  state: LookUpState;
  /** The tries of the lookups the state stands for (the most of them). */
  tries: number;
  /** "waiting": the latest time a lookup still waiting may be asked again (R411); never for "failed". */
  notBefore?: string;
  /**
   * Some match came from an identifier found in the file (a hint, R55): the warning sentence is said. R585 M3: whenever
   * such a lookup was answered "found", whatever the one-word state (also with "waiting").
   */
  fromFile: boolean;
  /**
   * R585 M3: every OTHER state true of the entry besides `state` (never "failed"), in the order of the sentences: found,
   * waiting, nothing, not-allowed, gave-up. Present only in a mix: an entry in one state has no `also`.
   */
  also?: Array<Exclude<LookUpState, "failed">>;
  /** R585 M3: with "gave-up" in `also`, the tries of the lookups the app gave up on (for its sentence's {n}). */
  gaveUpTries?: number;
}

/** R585 M3: the order of the states' sentences in an entry's reasons. */
const SENTENCE_ORDER = ["found", "waiting", "nothing", "not-allowed", "gave-up"] as const;

/**
 * The entry's look-up state, or undefined when nothing was left out. The ONE word for the service, in this order of
 * precedence: "waiting" (an asked-to-wait lookup has no outcome yet), then "found", then the rest — "gave-up", "nothing",
 * "not-allowed"; "failed" when only lookups that failed outright are left, none answered. Why waiting first: while a
 * lookup still waits the entry is not settled — the automatic pass will take it and the page's act follows its time —
 * so that is what the service must act on; found next, because it is the news the researcher acts on (a match to check).
 * R585 M3: every other state true of the entry is in `also`, so its reasons carry every sentence.
 */
export function lookUpStateOf(entry: Pick<ReviewEntry, "leftOut" | "hints">): LookUpView | undefined {
  const all = entry.leftOut ?? [];
  if (all.length === 0) return undefined;
  const most = (ls: LeftOutLookup[]) => ls.reduce((n, l) => Math.max(n, l.tries ?? 0), 0);
  const hints = new Set(entry.hints ?? []);
  const fromFile = all.some((l) => l.outcome === "found" && !!l.identifier && hints.has(l.identifier));
  const of = (st: Exclude<LookUpState, "failed">) => all.filter((l) => (st === "waiting" ? isAskedToWait(l) && !l.outcome : l.outcome === st));
  const present = SENTENCE_ORDER.filter((st) => of(st).length > 0);
  const extra = (state: LookUpState) => {
    const also = present.filter((st) => st !== state);
    if (!also.length) return {};
    return { also, ...(also.includes("gave-up") ? { gaveUpTries: most(of("gave-up")) } : {}) };
  };
  const waiting = of("waiting");
  if (waiting.length) {
    const times = waiting.map((l) => l.notBefore).filter((t): t is string => !!t).sort();
    return { state: "waiting", tries: most(waiting), ...(times.length ? { notBefore: times[times.length - 1]! } : {}), fromFile, ...extra("waiting") };
  }
  for (const state of ["found", "gave-up", "nothing", "not-allowed"] as const) {
    const ls = of(state);
    if (!ls.length) continue;
    return { state, tries: most(ls), fromFile, ...extra(state) };
  }
  return { state: "failed", tries: most(all), fromFile: false };
}

/**
 * The sentences that stand for an entry's look-up state in its reasons ("failed": none — the entry keeps its own
 * reason). R585 M3: every state true of it (`state` and `also`), each once, in the order found (and the warning when a
 * match came from the file's identifier); still waiting; nothing found; not allowed; gave up.
 */
export function lookUpSentences(v: LookUpView): string[] {
  const states = new Set<LookUpState>([v.state, ...(v.also ?? [])]);
  const out: string[] = [];
  for (const st of SENTENCE_ORDER) {
    if (!states.has(st)) continue;
    if (st === "found") out.push(LOOK_UP_AGAIN_TEXT.found, ...(v.fromFile ? [LOOK_UP_AGAIN_TEXT.fromFile] : []));
    else if (st === "waiting") out.push(LOOKUP_WAITING_TEXT);
    else if (st === "nothing") out.push(LOOK_UP_AGAIN_TEXT.nothing);
    else if (st === "not-allowed") out.push(LOOK_UP_AGAIN_TEXT.notAllowed);
    else out.push(lookUpGaveUpText(v.state === "gave-up" ? v.tries : (v.gaveUpTries ?? v.tries)));
  }
  return out;
}

const [GAVE_UP_HEAD, GAVE_UP_TAIL] = LOOK_UP_AGAIN_TEXT.gaveUp.split("{n}") as [string, string];
const STATE_SENTENCES = new Set<string>([LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, LOOK_UP_AGAIN_TEXT.nothing, LOOK_UP_AGAIN_TEXT.notAllowed]);
const isStateSentence = (s: string) => STATE_SENTENCES.has(s) || (s.startsWith(GAVE_UP_HEAD) && s.endsWith(GAVE_UP_TAIL) && /^\d+$/u.test(s.slice(GAVE_UP_HEAD.length, s.length - GAVE_UP_TAIL.length)));

/**
 * `reasons` with the look-up state's sentence in place of the earlier one (where it stood; nothing else moves). Where none
 * stood, it is put first after a likely duplicate's sentence, where the waiting sentence is put (decision 31 b, R563 M6).
 */
export function reasonsWithLookUpState(reasons: readonly string[], v: LookUpView, likelyDuplicate?: string): string[] {
  const at = reasons.findIndex(isStateSentence);
  const kept = reasons.filter((s) => !isStateSentence(s));
  const where = at >= 0 ? at : likelyDuplicate !== undefined && kept[0] === likelyDuplicate ? 1 : 0;
  return [...kept.slice(0, where), ...lookUpSentences(v), ...kept.slice(where)];
}
