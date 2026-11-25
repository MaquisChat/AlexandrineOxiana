/**
 * Decision 31 (c), "Look up again" (R566; the owner's choices R577 4): a review entry that came in while a metadata service
 * asked to wait — or (R577 iv) whose lookup failed outright — is looked up again later: ONLY the lookups kept in its
 * `leftOut`, of ONLY the services left out. What is found is APPENDED to the entry's candidates; nothing of the record
 * (`source.json`) changes: the researcher accepts a candidate with the existing act (R577 ii). Two callers (R577 i): the
 * session's automatic pass (`by: "automatic"`, through `dueLookUps`) and the researcher's act (`by: "researcher"`).
 *
 * `lookUpAgain`, in order:
 *  1. reads the entry and refuses early, writing and sending nothing: decided, source gone, project locked, library
 *     read-only or closing; automatic and nothing due; by hand before the time kept on the entry → "not yet", with the time
 *     (R577 iii; a lookup that failed outright has no time to wait for);
 *  2. asks the project's rules again, now, per service and for title search; a lookup none of whose services is allowed
 *     is not asked and gets "not-allowed"; a service the client holds (it asked to wait since) is left out without sending;
 *  3. audits the send BEFORE it goes (R566 6): one governed authorisation of the `process/metadata_lookup` requests, op
 *     LOOK_SEND_OP, ids and service names only; refused like any change when the library closes or the project is locked;
 *  4. asks, one lookup after another, with `askedToWait: "leave-out"` and the call's own provider filter, under the
 *     session's closing scope: a service that asks to wait again sets the client's hold and the lookup a new time, one more
 *     try and no outcome — "gave-up" once the automatic bound is reached; a lookup cut by the closing writes NOTHING;
 *  5. writes the result as ONE governed change that READS THE ENTRY AGAIN inside itself (R566 2, as
 *     `reviewedAfterWithdrawal`): a decided entry or a removed source → nothing is written (the answer is dropped); else
 *     one new line of the entry — candidates appended, the lookups' tries, last try and outcome, the reasons' sentence for
 *     the new state — audited as LOOK_UP_AGAIN_OP with ids and counts only. Each lookup's result is worked out against
 *     the entry AS RE-READ there, at the lookup's place in `leftOut` (R585 1, 2): one another look-up settled meanwhile is
 *     left as it is, and no time moves backwards.
 *
 * One look-up of an entry at a time (R585 3): a second call for the same entry while one is under way answers
 * "under-way" at once, doing nothing.
 */
import { LookupCancelledError, LookupHttpError, LookupLeftOutError, PROVIDER_HOSTS, failedServicesOf, isSensitive, lookupContextFor, lookupDoi, lookupIsbn, providerAllowed, searchTitle, type HttpClient, type LookupContext, type LookupResult, type Provider } from "../lookup/index.js";
import { isClosed, whileOpen } from "../library.js";
import { LibraryClosedError, NotFoundError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError, isLockedRefusal } from "../repo/errors.js";
import { authorizeProcessing, importChange, projectReviewEntries, repoLibrary, type Repo } from "../repo/repo.js";
import type { LeftOutLookup, ReviewEntry } from "../repo/review.js";
import { storeRequest } from "../repo/sources.js";
import { ITEM_REASONS } from "./common.js";
import { LOOK_UP_AGAIN_BOUNDS, appendCandidates, isAskedToWait, lookUpStateOf, reasonsWithLookUpState, type LookUpView } from "./look-up-state.js";
import { arxivDoi } from "./resolve.js";

/** The audit op of the send's authorisation (before anything goes) and of the result's change. Ids and counts only. */
export const LOOK_SEND_OP = "review.lookup-again.send";
export const LOOK_UP_AGAIN_OP = "review.lookup-again";

export type LookUpBy = "automatic" | "researcher";

export interface LookUpAgainOptions {
  by: LookUpBy;
  /** The session's closing signal (R546 2): once aborted nothing more is sent or written. */
  closing?: AbortSignal;
  /** Now (the pass's clock; default the current time). The client's own clock decides its hold. */
  now?: Date;
  debug?: (note: string) => void;
}

/** Why nothing was done (nothing was written; nothing was sent except where said). */
export type LookUpAgainRefusal =
  /** No import entry of that id with a source. */
  | "not-found"
  /** The entry is no longer pending. */
  | "decided"
  /** Its source is no longer in the project. */
  | "source-removed"
  /** The project is encrypted and locked: the pass waits for its unlock. */
  | "locked"
  /** The library is read-only. */
  | "read-only"
  /** The library is closing (or closed): nothing is sent or written. */
  | "closing"
  /** Automatic: no left-out lookup is due (or every one due is held by its service). */
  | "not-due"
  /** Every left-out lookup has its answer: nothing is left to look up. */
  | "nothing-to-look-up"
  /** Sent, but the entry was decided or its source removed before the result could be written: the answer was dropped. */
  | "dropped"
  /** Sent (audited), but the library began to close before the answer came: nothing written. */
  | "cancelled"
  /**
   * R585 (3): a look-up of this entry is already under way (in this process, on this library handle): this call did
   * nothing — nothing audited, nothing sent, nothing written. The one under way writes its result.
   */
  | "under-way";

export type LookUpAgainResult =
  | {
      done: true;
      entryId: string;
      sourceId: string;
      /** How many lookups were sent (each to its own left-out services, one after another). */
      asked: number;
      /** The services asked (names only). */
      services: string[];
      /** How many lookups the rules no longer allow (not asked; outcome "not-allowed"). */
      notAllowed: number;
      /** How many matches were appended to the entry's candidates. */
      found: number;
      /** The entry's look-up state after the change. */
      state: LookUpView | undefined;
    }
  | { done: false; why: LookUpAgainRefusal }
  /** By hand before the time the service named (R577 iii): nothing was sent; it can be asked from `notBefore` on. */
  | { done: false; why: "not-yet"; notBefore: string };

const no = (why: LookUpAgainRefusal): LookUpAgainResult => ({ done: false, why });
const FINAL = new Set<LeftOutLookup["outcome"]>(["found", "nothing"]);
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** Whether the automatic pass takes this lookup now (R566 5, R577 iv). */
function dueAutomatically(e: Pick<ReviewEntry, "createdAt">, l: LeftOutLookup, now: number): boolean {
  if (!isAskedToWait(l) || l.outcome) return false;
  const tries = l.tries ?? 0;
  if (tries >= LOOK_UP_AGAIN_BOUNDS.maxAutomaticTries) return false;
  if (l.notBefore && ms(l.notBefore) > now) return false;
  const from = ms(l.lastTriedAt ?? e.createdAt);
  const wait = LOOK_UP_AGAIN_BOUNDS.waitsMs[tries] ?? LOOK_UP_AGAIN_BOUNDS.waitsMs[LOOK_UP_AGAIN_BOUNDS.waitsMs.length - 1]!;
  return Number.isNaN(from) || from + wait <= now;
}

/** Whether the researcher's act may ask this lookup now: not answered yet, and its service's time has passed (R411). */
const askableByHand = (l: LeftOutLookup, now: number) => !FINAL.has(l.outcome) && !(l.notBefore && ms(l.notBefore) > now);

const pendingWithSource = (e: ReviewEntry, present: Set<string>) => e.kind === "import" && e.status === "pending" && !!e.sourceId && present.has(e.sourceId);

/** A pending import entry the automatic pass may look up now. */
export interface DueLookUp {
  entryId: string;
  sourceId: string;
}

/**
 * The pending entries (with their source in the project) with a left-out lookup due for the AUTOMATIC pass now, oldest
 * first: an asked-to-wait lookup (never one that failed outright, R577 iv) with no outcome, its service's time passed,
 * below the bound of tries, and the growing wait since its last try passed. A locked project: none (its pass waits for the
 * unlock). Reads only. The client's in-memory hold is not known here: `lookUpAgain` leaves a held service out.
 */
export async function dueLookUps(repo: Repo, projectId: string, now: Date = new Date()): Promise<DueLookUp[]> {
  let all: ReviewEntry[];
  try {
    all = await projectReviewEntries(repo, projectId);
  } catch (err) {
    if (isLockedRefusal(err)) return [];
    throw err;
  }
  const present = new Set(repo.listSourceIds(projectId));
  const t = now.getTime();
  return all
    .filter((e) => pendingWithSource(e, present) && (e.leftOut ?? []).some((l) => dueAutomatically(e, l, t)))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .map((e) => ({ entryId: e.id, sourceId: e.sourceId! }));
}

/** One chosen lookup, and what this act does with it. */
interface Plan {
  /**
   * R585 (1): the lookup's PLACE in the entry's `leftOut` — its identity. Two lookups may look up the same thing (one
   * service asked to wait, another failed); nothing reorders or shortens `leftOut` (the attach writes it once, in
   * `reviewFor`; every later line keeps each item at its place), so the place names the one lookup.
   */
  at: number;
  lookup: LeftOutLookup;
  /** The services asked now. */
  ask: string[];
  /** Services allowed but held by the client (asked to wait since): left out without sending; the latest hold. */
  held: string[];
  heldUntil?: number;
  /** None of its services is allowed now. */
  notAllowed: boolean;
}

type Asked = { kind: "found"; results: LookupResult[] } | { kind: "nothing" } | { kind: "waiting"; services: string[]; notBefore: number } | { kind: "failed"; services: string[] };
/**
 * A lookup's answer from its services asked one by one (R585 M8), with the services whose send the project's rules
 * denied at that moment (not asked). "denied": every service it would have asked was denied — nothing was asked.
 */
type Answered = (Asked | { kind: "denied" }) & { denied: string[] };

/** One lookup, asked of ONLY `only` (the call's own filter: no other caller sees it). */
async function askOne(l: LeftOutLookup, ctx: LookupContext, only: string[]): Promise<Asked> {
  try {
    if (l.identifier) {
      const [kind, ...rest] = l.identifier.split(":");
      const id = rest.join(":");
      const r = kind === "isbn" ? await lookupIsbn(id, ctx, { only }) : await lookupDoi(kind === "arxiv" ? arxivDoi(id) : id, ctx, { only });
      return r ? { kind: "found", results: [r] } : { kind: "nothing" };
    }
    const rs = await searchTitle(l.title ?? "", l.creator, ctx, { only });
    return rs.length ? { kind: "found", results: rs } : { kind: "nothing" };
  } catch (e) {
    if (e instanceof LookupLeftOutError) return { kind: "waiting", services: [...new Set([...e.services, ...failedServicesOf(e)])], notBefore: e.notBefore };
    if (e instanceof LookupHttpError) return { kind: "failed", services: failedServicesOf(e).length ? [...failedServicesOf(e)] : only };
    throw e;
  }
}

const laterIso = (a: string | undefined, b: string): string => (a && ms(a) > ms(b) ? a : b);

/** The lookup after this act (see the module comment, step 4), worked out against `l`: the lookup as re-read (R585 2). */
function after(p: Plan, l: LeftOutLookup, a: Answered | undefined, at: string): LeftOutLookup {
  if (p.notAllowed || (a?.kind === "denied" && !p.held.length)) return { ...l, outcome: "not-allowed" };
  if (!a || a.kind === "denied") {
    // Every allowed service held: not asked now; it waits for the hold (no try counted).
    return { ...l, services: p.held, notBefore: new Date(Math.max(ms(l.notBefore) || 0, p.heldUntil ?? 0)).toISOString() };
  }
  const tries = (l.tries ?? 0) + 1;
  const { outcome: _o, ...base } = l;
  // A time never moves backwards (R585 2): a later try written meanwhile keeps its time.
  const tried = { ...base, tries, lastTriedAt: laterIso(l.lastTriedAt, at) };
  if (a.kind === "found") return { ...tried, outcome: "found" };
  if (a.kind === "nothing" && !p.held.length) {
    // R585 M8: a service whose send the rules denied was not asked: the lookup is not answered by it ("not-allowed",
    // that service still to be asked); else every service asked answered with nothing.
    return a.denied.length ? { ...tried, services: a.denied, outcome: "not-allowed" } : { ...tried, outcome: "nothing" };
  }
  if (a.kind === "failed") {
    // Every service asked failed outright: it is now a lookup that failed (looked up again by hand only, R577 iv).
    const { notBefore: _n, ...rest } = tried;
    return { ...rest, services: [...new Set([...a.services, ...p.held])], why: "failed" };
  }
  // Still to be asked: those that asked to wait again, and those held.
  const services = a.kind === "waiting" ? [...new Set([...a.services, ...p.held])] : p.held;
  const notBefore = Math.max(a.kind === "waiting" ? a.notBefore : 0, p.heldUntil ?? 0, ms(l.notBefore) || 0);
  const waiting: LeftOutLookup = { ...tried, services, notBefore: new Date(notBefore).toISOString(), ...(isAskedToWait(l) ? {} : { why: "asked-to-wait" as const }) };
  return tries >= LOOK_UP_AGAIN_BOUNDS.maxAutomaticTries ? { ...waiting, outcome: "gave-up" } : waiting;
}

/**
 * R585 (2): the lookup at `p`'s place in the entry as re-read inside the change, after this act. A lookup that another
 * look-up has settled meanwhile ("found" or "nothing" now, not when this act read it) is left as the re-read has it; one
 * that is not the same lookup any more (it cannot be: nothing reorders `leftOut`) is left too.
 */
function settle(p: Plan, cur: LeftOutLookup | undefined, a: Answered | undefined, at: string): LeftOutLookup | undefined {
  if (!cur) return undefined;
  const same = (x: LeftOutLookup) => JSON.stringify([x.identifier, x.title, x.creator]);
  if (same(cur) !== same(p.lookup)) return cur;
  if (FINAL.has(cur.outcome) && cur.outcome !== p.lookup.outcome) return cur;
  return after(p, cur, a, at);
}

/**
 * One lookup asked of its services one by one (R585 M8: each service's send audited before its request), combined as
 * the chain combines its providers' answers (`firstAnswer`): the first match ends it; else a service that asked to wait
 * keeps it waiting (with those that failed outright, when none answered); else all failed outright → failed; else
 * nothing.
 */
async function askByService(p: Plan, ctx: LookupContext, sendAllowed: (s: string) => Promise<boolean>): Promise<Answered> {
  const denied: string[] = [];
  const waiting: string[] = [];
  const failed: string[] = [];
  let notBefore = 0;
  let answered = false;
  for (const s of p.ask) {
    if (!(await sendAllowed(s))) {
      denied.push(s);
      continue;
    }
    const a = await askOne(p.lookup, ctx, [s]);
    if (a.kind === "found") return { ...a, denied };
    if (a.kind === "nothing") answered = true;
    else if (a.kind === "waiting") {
      waiting.push(...a.services);
      notBefore = Math.max(notBefore, a.notBefore);
    } else failed.push(...a.services);
  }
  if (waiting.length) return { kind: "waiting", services: [...new Set([...waiting, ...(answered ? [] : failed)])], notBefore, denied };
  if (failed.length && !answered) return { kind: "failed", services: [...new Set(failed)], denied };
  if (answered) return { kind: "nothing", denied };
  return { kind: "denied", denied };
}

/** Thrown inside the change to roll it back: the entry was decided or its source removed meanwhile (nothing written). */
class Dropped extends Error {}

/**
 * R585 (3): the entries with a look-up under way, per library handle (the service holds one per library): a second
 * call for the same entry answers "under-way" at once. A WeakMap: a handle let go takes its set with it.
 */
const underWay = new WeakMap<Repo, Set<string>>();

/**
 * Looks up an entry's left-out lookups again (see the module comment). Never throws for the library's state: a closing,
 * a read-only library and a locked project are answered as refusals; other errors (a policy refusal of the send, which is
 * audited) are thrown.
 */
export async function lookUpAgain(repo: Repo, http: HttpClient, projectId: string, entryId: string, opts: LookUpAgainOptions): Promise<LookUpAgainResult> {
  const lib = repoLibrary(repo);
  if (opts.closing?.aborted || isClosed(lib)) return no("closing");
  let busy = underWay.get(repo);
  if (!busy) underWay.set(repo, (busy = new Set()));
  const key = JSON.stringify([projectId, entryId]);
  if (busy.has(key)) return no("under-way");
  busy.add(key);
  const progress = { sent: false };
  try {
    return await whileOpen(lib, opts.closing, () => run(repo, http, projectId, entryId, opts, progress));
  } catch (err) {
    // The closing cut it: before the send was audited nothing happened ("closing"); after it, the answer is let go.
    if (err instanceof LookupCancelledError || err instanceof LibraryClosedError) return no(progress.sent ? "cancelled" : "closing");
    if (err instanceof ReadOnlyLibraryError) return no("read-only");
    if (err instanceof ProjectLockedError || isLockedRefusal(err)) return no("locked");
    throw err;
  } finally {
    busy.delete(key);
  }
}

async function run(repo: Repo, http: HttpClient, projectId: string, entryId: string, opts: LookUpAgainOptions, progress: { sent: boolean }): Promise<LookUpAgainResult> {
  const lib = repoLibrary(repo);
  const now = opts.now ?? new Date();
  const t = now.getTime();
  // 1. Read the entry; refuse early, writing nothing.
  if (lib.mode !== "read-write") return no("read-only");
  const all = await projectReviewEntries(repo, projectId); // ProjectLockedError for a locked project
  const e = all.find((x) => x.id === entryId);
  if (!e || e.kind !== "import" || !e.sourceId) return no("not-found");
  if (e.status !== "pending") return no("decided");
  if (!repo.listSourceIds(projectId).includes(e.sourceId)) return no("source-removed");
  const left = e.leftOut ?? [];
  const chosen = left.map((l, at) => ({ l, at })).filter(({ l }) => (opts.by === "automatic" ? dueAutomatically(e, l, t) : askableByHand(l, t)));
  if (!chosen.length) {
    if (opts.by === "automatic") return no("not-due");
    const later = left.filter((l) => !FINAL.has(l.outcome) && l.notBefore && ms(l.notBefore) > t).map((l) => l.notBefore!).sort();
    return later.length ? { done: false, why: "not-yet", notBefore: later[0]! } : no("nothing-to-look-up");
  }

  // 2. The project's rules, asked again now, per service and for title search.
  const ctx: LookupContext = { ...(await lookupContextFor(repo, projectId, http, opts.debug ? { debug: opts.debug } : {})), askedToWait: "leave-out" };
  const allowed = (l: LeftOutLookup, s: string): boolean => {
    if (!l.identifier) return s === "openalex" && ctx.titleSearchAllowed === true && providerAllowed(ctx, "openalex");
    if (!(s in PROVIDER_HOSTS)) return false;
    if (s === "loc" && isSensitive(ctx)) return false; // plain HTTP: never for an encrypted project (R52)
    return providerAllowed(ctx, s as Provider);
  };
  const plans: Plan[] = chosen.map(({ l, at }) => {
    const ok = l.services.filter((s) => allowed(l, s));
    const holds = ok.map((s) => [s, http.heldUntil(PROVIDER_HOSTS[s as Provider])] as const);
    const held = holds.filter(([, h]) => h !== undefined);
    return {
      at,
      lookup: l,
      ask: holds.filter(([, h]) => h === undefined).map(([s]) => s),
      held: held.map(([s]) => s),
      ...(held.length ? { heldUntil: Math.max(...held.map(([, h]) => h!)) } : {}),
      notAllowed: ok.length === 0,
    };
  });
  const toAsk = plans.filter((p) => p.ask.length > 0);
  const notAllowed = plans.filter((p) => p.notAllowed);
  if (!toAsk.length && !notAllowed.length) {
    // Every allowed service is held by the client (it asked to wait since): nothing is sent, nothing written (R411).
    if (opts.by === "automatic") return no("not-due");
    const until = Math.min(...plans.map((p) => p.heldUntil ?? Number.POSITIVE_INFINITY));
    return { done: false, why: "not-yet", notBefore: new Date(until).toISOString() };
  }

  const sf = await repo.getSource(projectId, e.sourceId).catch((err: unknown) => {
    if (err instanceof NotFoundError) return null; // removed since it was read
    throw err;
  });
  if (!sf) return no("source-removed");

  // 3. The send is audited before it goes (R566 6), as one event PER SERVICE (R585 M8): through the unchanged
  // `authorizeOnly`, with that service's own policy decision, on disk before that service's first request in this act.
  // Ids, the service's name and a count only — no title, no identifier. A service the rules deny now is not asked (its
  // deny is audited as any denied act is), once per act.
  const decided = new Map<string, boolean>();
  const sendAllowed = async (s: string): Promise<boolean> => {
    const known = decided.get(s);
    if (known !== undefined) return known;
    try {
      await authorizeProcessing(repo, projectId, { action: "process", process: { op: "metadata_lookup", provider: s } }, {
        op: LOOK_SEND_OP,
        entity: { type: "source", id: e.sourceId! },
        auditAllow: { details: { reviewEntry: e.id, by: opts.by, services: [s], lookups: toAsk.filter((p) => p.ask.includes(s)).length } },
      });
    } catch (err) {
      if (!(err instanceof PolicyDeniedError)) throw err;
      decided.set(s, false);
      return false;
    }
    progress.sent = true;
    decided.set(s, true);
    return true;
  };

  // 4. Ask, one lookup after another and each of its services one after another in its chain's order (the first that
  // finds it ends the lookup, as the chain does), only the left-out services (LookupCancelledError: the closing cut it,
  // nothing written).
  const answered = new Map<Plan, Answered>();
  const found: LookupResult[] = [];
  for (const p of toAsk) {
    const a = await askByService(p, ctx, sendAllowed);
    answered.set(p, a);
    if (a.kind === "found") found.push(...a.results);
  }
  const services = [...decided].filter(([, ok]) => ok).map(([s]) => s);
  const at = now.toISOString();

  // 5. One governed change that reads the entry again inside itself.
  let added = 0;
  let view: LookUpView | undefined;
  // Ids and counts only (R177); the counts are filled in by the change before its audit line is written.
  const details: Record<string, unknown> = { reviewEntry: e.id, by: opts.by, lookups: plans.length };
  try {
    await importChange(
      repo,
      projectId,
      storeRequest(sf.source.provenance),
      async (ops) => {
        const cur = (await ops.reviewEntries()).find((x) => x.id === entryId);
        if (!cur || cur.status !== "pending" || !cur.sourceId || !ops.tx.state.sources.has(cur.sourceId)) throw new Dropped();
        // R585 (2): each lookup's result is worked out against the entry as re-read here, at its place (R585 1).
        const leftOut = [...(cur.leftOut ?? [])];
        for (const p of plans) {
          const settled = settle(p, leftOut[p.at], answered.get(p), at);
          if (settled) leftOut[p.at] = settled;
        }
        const candidates = appendCandidates(cur.candidates, found);
        added = candidates.length - (cur.candidates?.length ?? 0);
        view = lookUpStateOf({ leftOut, ...(cur.hints ? { hints: cur.hints } : {}) });
        const reasons = view ? reasonsWithLookUpState(cur.reasons, view, ITEM_REASONS.likelyDuplicate) : cur.reasons;
        await ops.updateReview({ ...cur, ...(candidates.length ? { candidates } : {}), leftOut, reasons });
        details.candidatesAdded = added;
        details.state = view?.state ?? "none";
      },
      {
        op: LOOK_UP_AGAIN_OP,
        entity: { type: "source", id: e.sourceId },
        auditDetails: details,
      },
    );
  } catch (err) {
    if (err instanceof Dropped || err instanceof NotFoundError) return no("dropped");
    throw err;
  }
  const deniedAll = (p: Plan) => answered.get(p)?.kind === "denied";
  return {
    done: true,
    entryId: e.id,
    sourceId: e.sourceId,
    asked: toAsk.filter((p) => !deniedAll(p)).length,
    services,
    notAllowed: plans.filter((p) => after(p, p.lookup, answered.get(p), at).outcome === "not-allowed").length,
    found: added,
    state: view,
  };
}
