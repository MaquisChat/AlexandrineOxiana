/**
 * Decision 31 (c), "Look up again" (R566, R577): the entry's look-up state and its pure helpers. Candidates are only ever
 * appended (R566 1: the page accepts by position); the entry's sentence follows its state (R577 4, word for word); a lookup
 * that failed outright never makes an entry read "Waiting for lookup service response.".
 */
import { LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT, lookUpAgainAfter, lookUpGaveUpText } from "@ao/shared";
import { describe, expect, it } from "vitest";
import type { LookupResult } from "../lookup/index.js";
import type { LeftOutLookup } from "../repo/review.js";
import { ITEM_REASONS } from "./common.js";
import { LOOK_UP_AGAIN_BOUNDS, appendCandidates, candidateKeyOf, isAskedToWait, lookUpStateOf, reasonsWithLookUpState } from "./look-up-state.js";

const r = (title: string, provider = "openalex", doi?: string): LookupResult => ({
  title,
  creators: [{ role: "author", family: "Souza", given: "Ana" }],
  type: "article-journal",
  identifiers: doi ? { doi } : {},
  provider,
});

describe("appendCandidates (R566 1)", () => {
  it("keeps every existing candidate at its position and appends the new ones after them, in order", () => {
    const existing = [r("A"), r("B", "crossref", "10.1/b"), r("C")];
    const out = appendCandidates(existing, [r("D"), r("E", "crossref", "10.1/e")]);
    expect(out.slice(0, 3)).toEqual(existing);
    expect(out.slice(3)).toEqual([r("D"), r("E", "crossref", "10.1/e")]);
    expect(existing).toHaveLength(3); // not changed in place
  });
  it("de-duplicates with the resolution's key (provider, DOI, title in any case): a match already listed is not added again", () => {
    const existing = [r("Tide-line notes", "openalex", "10.1/x")];
    const out = appendCandidates(existing, [r("TIDE-LINE NOTES", "openalex", "10.1/x"), r("Tide-line notes", "crossref", "10.1/x"), r("Other"), r("other")]);
    expect(out).toEqual([existing[0], r("Tide-line notes", "crossref", "10.1/x"), r("Other")]);
    expect(candidateKeyOf(r("A", "openalex", "10.1/a"))).toBe("openalex|10.1/a|a");
  });
  it("adds at most three new matches in one look-up, and never pushes an existing one out (an entry may then list more than three)", () => {
    const existing = [r("A"), r("B"), r("C")];
    const out = appendCandidates(existing, [r("D"), r("E"), r("F"), r("G")]);
    expect(out.map((c) => (c as LookupResult).title)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(LOOK_UP_AGAIN_BOUNDS.newCandidatesPerLookUp).toBe(3);
  });
  it("an entry without candidates gets the new ones; nothing found leaves the list as it was", () => {
    expect(appendCandidates(undefined, [r("A")])).toEqual([r("A")]);
    const existing = [r("A")];
    expect(appendCandidates(existing, [])).toEqual(existing);
  });
});

const wait = (o: Partial<LeftOutLookup> = {}): LeftOutLookup => ({ services: ["openalex"], title: "Tide-line notes", notBefore: "2026-11-24T15:01:00.000Z", ...o });
const failed = (o: Partial<LeftOutLookup> = {}): LeftOutLookup => ({ services: ["openalex"], identifier: "doi:10.1/x", why: "failed", ...o });

describe("lookUpStateOf: the entry's look-up state for display (R577 4)", () => {
  it("no lookup left out: no state", () => {
    expect(lookUpStateOf({})).toBeUndefined();
    expect(lookUpStateOf({ leftOut: [] })).toBeUndefined();
  });
  it("waiting: an asked-to-wait lookup with no outcome yet (an entry of decision 31 b has no `why`); its time is said", () => {
    expect(lookUpStateOf({ leftOut: [wait()] })).toEqual({ state: "waiting", tries: 0, notBefore: "2026-11-24T15:01:00.000Z", fromFile: false });
    expect(lookUpStateOf({ leftOut: [wait({ why: "asked-to-wait", tries: 2, notBefore: "2026-11-24T16:00:00.000Z" }), wait({ outcome: "nothing", tries: 1 })] })).toMatchObject({ state: "waiting", tries: 2, notBefore: "2026-11-24T16:00:00.000Z" });
    expect(isAskedToWait(wait())).toBe(true);
    expect(isAskedToWait(failed())).toBe(false);
  });
  it("found, and whether the match came from an identifier found in the file (a hint, R55)", () => {
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "found", tries: 1 })] })).toMatchObject({ state: "found", fromFile: false });
    expect(lookUpStateOf({ hints: ["doi:10.1/x"], leftOut: [wait({ identifier: "doi:10.1/x", title: undefined, outcome: "found", tries: 1 })] })).toMatchObject({ state: "found", fromFile: true });
  });
  it("nothing, not-allowed and gave-up (with its tries)", () => {
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "nothing", tries: 1 })] })).toMatchObject({ state: "nothing" });
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "not-allowed" })] })).toMatchObject({ state: "not-allowed" });
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "gave-up", tries: 5 })] })).toMatchObject({ state: "gave-up", tries: 5 });
  });
  it("failed: only lookups that failed outright, none tried with an answer; a failed lookup alone never reads as waiting", () => {
    expect(lookUpStateOf({ leftOut: [failed()] })).toEqual({ state: "failed", tries: 0, fromFile: false });
    expect(lookUpStateOf({ leftOut: [failed({ tries: 1, lastTriedAt: "2026-11-24T16:00:00.000Z" })] })).toMatchObject({ state: "failed", tries: 1 });
  });
  it("found wins over the others once nothing waits; a lookup still waiting wins over everything", () => {
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "nothing" }), failed(), wait({ outcome: "found" })] })).toMatchObject({ state: "found" });
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "found" }), wait()] })).toMatchObject({ state: "waiting" });
  });
});

describe("reasonsWithLookUpState: the waiting sentence is replaced by the state's own (R577 4)", () => {
  const DUP = ITEM_REASONS.likelyDuplicate;
  const other = "The title in the file differs from the one found.";
  it("found replaces it in place; from a file's identifier the second sentence follows", () => {
    expect(reasonsWithLookUpState([DUP, LOOKUP_WAITING_TEXT, other], { state: "found", tries: 1, fromFile: false })).toEqual([DUP, LOOK_UP_AGAIN_TEXT.found, other]);
    expect(reasonsWithLookUpState([LOOKUP_WAITING_TEXT, other], { state: "found", tries: 1, fromFile: true })).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, other]);
  });
  it("nothing, not-allowed, gave-up with {n} filled; waiting keeps the owner's sentence", () => {
    expect(reasonsWithLookUpState([LOOKUP_WAITING_TEXT], { state: "nothing", tries: 1, fromFile: false })).toEqual([LOOK_UP_AGAIN_TEXT.nothing]);
    expect(reasonsWithLookUpState([LOOKUP_WAITING_TEXT], { state: "not-allowed", tries: 0, fromFile: false })).toEqual([LOOK_UP_AGAIN_TEXT.notAllowed]);
    expect(reasonsWithLookUpState([LOOKUP_WAITING_TEXT], { state: "gave-up", tries: 5, fromFile: false })).toEqual([lookUpGaveUpText(5)]);
    expect(lookUpGaveUpText(5)).toBe("The lookup service asked to wait each time it was tried (5 tries), so the app has stopped trying by itself. You can still use Look up again.");
    expect(reasonsWithLookUpState([LOOKUP_WAITING_TEXT, other], { state: "waiting", tries: 2, fromFile: false })).toEqual([LOOKUP_WAITING_TEXT, other]);
  });
  it("a later state replaces an earlier state's sentence (found after gave-up), and nothing else moves", () => {
    expect(reasonsWithLookUpState([DUP, lookUpGaveUpText(5), other], { state: "found", tries: 6, fromFile: true })).toEqual([DUP, LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, other]);
  });
  it("failed: the entry keeps its own reasons (today's sentence); none is added", () => {
    expect(reasonsWithLookUpState([other], { state: "failed", tries: 0, fromFile: false })).toEqual([other]);
  });
  it("the words are R577's, word for word", () => {
    expect(LOOK_UP_AGAIN_TEXT).toEqual({
      notLookedUpYet: "Not looked up yet: the lookup service asked to wait.",
      looking: "Looking this up again…",
      found: "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one.",
      fromFile: "The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first.",
      nothing: "The lookup service has now answered, but it found no match for this item.",
      notAllowed: "This project's rules no longer allow this lookup, so it was not looked up again.",
      gaveUp: "The lookup service asked to wait each time it was tried ({n} tries), so the app has stopped trying by itself. You can still use Look up again.",
      act: "Look up again",
      after: "Look up again (after {time})",
      notLookedUpFailed: "Not looked up: a lookup service could not be reached. You can use Look up again.",
    });
    expect(lookUpAgainAfter("4:05 pm")).toBe("Look up again (after 4:05 pm)");
  });
});

describe("the bounds and waits of the automatic pass (one place)", () => {
  it("at most 5 automatic tries; waits of 15 minutes, then 1, 4, 12 and 24 hours", () => {
    expect(LOOK_UP_AGAIN_BOUNDS.maxAutomaticTries).toBe(5);
    expect(LOOK_UP_AGAIN_BOUNDS.waitsMs).toEqual([15 * 60_000, 3_600_000, 4 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000]);
  });
});

describe("R585 M3: the sentences in mixes — every sentence true of the entry, each once, in order", () => {
  const other = "The title in the file differs from the one found.";
  const sentencesOf = (e: { leftOut: LeftOutLookup[]; hints?: string[] }) => reasonsWithLookUpState([LOOKUP_WAITING_TEXT, other], lookUpStateOf(e)!);
  it("not allowed + nothing found: both sentences, nothing first", () => {
    const v = lookUpStateOf({ leftOut: [wait({ outcome: "not-allowed" }), wait({ outcome: "nothing", tries: 1 })] })!;
    expect(v.state).toBe("nothing"); // the one word for the service stays as it was
    expect(sentencesOf({ leftOut: [wait({ outcome: "not-allowed" }), wait({ outcome: "nothing", tries: 1 })] })).toEqual([LOOK_UP_AGAIN_TEXT.nothing, LOOK_UP_AGAIN_TEXT.notAllowed, other]);
  });
  it("P-K: found from the file's identifier and still waiting: found, the warning, waiting; the state is \"waiting\"", () => {
    const e = { hints: ["doi:10.1/x"], leftOut: [wait({ identifier: "doi:10.1/x", title: undefined, outcome: "found", tries: 1 }), wait()] };
    expect(lookUpStateOf(e)).toMatchObject({ state: "waiting", fromFile: true });
    expect(sentencesOf(e)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, LOOKUP_WAITING_TEXT, other]);
  });
  it("all five at once, in the ruled order: found; still waiting; nothing found; not allowed; gave up (with its own tries)", () => {
    const e = { leftOut: [wait({ outcome: "gave-up", tries: 5 }), wait({ outcome: "not-allowed" }), wait({ outcome: "nothing", tries: 1 }), wait({ tries: 2 }), wait({ outcome: "found", tries: 1 })] };
    expect(lookUpStateOf(e)).toMatchObject({ state: "waiting", tries: 2 });
    expect(sentencesOf(e)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT.nothing, LOOK_UP_AGAIN_TEXT.notAllowed, lookUpGaveUpText(5), other]);
    // written again: each sentence still once, nothing else moved
    expect(reasonsWithLookUpState(sentencesOf(e), lookUpStateOf(e)!)).toEqual(sentencesOf(e));
  });
  it("a single state reads as before (the view has no `also`)", () => {
    expect(lookUpStateOf({ leftOut: [wait({ outcome: "nothing", tries: 1 })] })).toEqual({ state: "nothing", tries: 1, fromFile: false });
  });
});
