# Decision 31 (c), "Look up again": adversarial review of the engine (T1, T2)

Reviewed: worktree `.claude/worktrees/kg-4`, branch `d31c-look-up-again` at 2e3a471 (four commits from 7d8d861; 15 files). Read: R556, R563, R566, R577, R582; R55, R247, R411, R546 in the index; the design `task-D31c-design.md`; the builder's report `task-D31c-engine-report.md`; the whole diff.

How I worked: probes in `packages/library/src/import/look-again.probeD31c.test.ts`, built on the test file's own harness (an undici `MockAgent` with `disableNetConnect()`, closed after each test; the client's clock and sleep injected, so no real waits). The probe file is deleted and `git status --short` is empty. No product code was changed except three planted faults, each restored with `git checkout`. Every test file was run alone with `nice -n 10`.

## Findings

### Critical
None.

### Important

**I1. Two look-ups of the same entry at once: the slower one writes its old view of the lookups over the newer one. A "found" goes back to "waiting".** `import/look-again.ts:297` and `:312`.
- **The cause.** `after()` works out each lookup's next state from the entry as read BEFORE the change (`e`, `chosen`, plans). Inside the change, the re-read (`cur`) is used only to check that the entry is still pending and its source still there. Then `cur.leftOut` is overwritten with `next.get(keyOf(l))`, which was computed from the old read.
- **Probe P-B.**
  1. Look-up B (automatic) is answered 429, and its write is held.
  2. Look-up A (the researcher's) is then answered with matches. It writes `outcome: "found"`, `lastTriedAt 15:18`, and the found sentence.
  3. B is released. It writes `{tries: 1, lastTriedAt: 15:16, notBefore: 15:17}` with no outcome. The entry's first reason is "Waiting for lookup service response." again.
- **What follows.** The two matches stay in `candidates` (de-duplicated, so they are not added twice), but the entry now says it is waiting although the service has answered. `lastTriedAt` goes back in time. "found" was meant to be final, but the automatic pass will now ask the service again. This is the trap R566 (2) names (a change that writes what it read earlier), one level down: it hits the look-up state, not the decision.
- **The builder's position.** The report (§9.6) says it and leaves it to T3 ("T3 should run the pass and the route one at a time per library"). But `lookUpAgain` is the exported engine API, and nothing in it prevents this.
- **The mend.** Either:
  - work out each lookup's result against `cur`'s item inside the change, and drop or merge it when that item changed since the read (`tries` or `lastTriedAt` differ, or it has an outcome); or
  - serialise per entry inside the engine.
- **The test.** Add P-B as a test.
- Probe P-A (both answered with matches) shows the milder form: 1 request (the second was served from the client's cache), 2 lines written, 2 send audit lines, 2 candidates (no duplicates).

**I2. Two lookups of an entry can end up with the same key. The write then puts one lookup's result over the other: a found lookup is lost and the item is duplicated.** `look-again.ts:141` (`keyOf` = why, identifier, title, creator; the services are not part of it), `:196` (a failed lookup that is now asked to wait becomes `why: "asked-to-wait"`), `:297` (`new Map(plans.map(...))`), `:312`.
- **Probe P-N.**
  - **The attach.** Crossref answers 429 and OpenAlex 500 for the file's DOI; the title search also gets 500. `leftOut` is then: `[{crossref, doi, notBefore}, {openalex, doi, why: "failed"}, {openalex, title, why: "failed"}]`, and the entry's sentence is the waiting one. This is correct (R563 M2).
  - **First look-up (by hand).** OpenAlex answers 429. The failed DOI item becomes `why: "asked-to-wait"`. Its key is now identical to the Crossref item's.
  - **Second look-up (by hand).** Crossref finds the DOI: `found: 1`, and the candidate is appended. Then the Map keeps only the later plan (OpenAlex, waiting), and both items are written with it. Result: `leftOut` = two identical `{services: ["openalex"], identifier: doi, tries: 2, …}` items. The Crossref lookup and its "found" are gone, and the entry reads "Waiting for lookup service response.".
  - In that one look-up, the same DOI was also sent to both services (two requests for one identifier).
- **The mend.** Key a lookup by its position in `leftOut`, or include the services in the key, or merge a failed item into its asked-to-wait sibling with the same identifier when it is converted.
- **The test.** Add P-N.

### Minor

**M1. A clock that was wrong (or jumped back) can make an entry wait for a very long time, and the researcher's act does not get through either.** `look-again.ts:101-108` (`notBefore` and `lastTriedAt` are compared with `now` as they are).
- **Probe P-D.** The entry has `notBefore` and `lastTriedAt` set to 2031-01-01 (as a clock running ahead would write them). With `now` set to November 2026:
  - by hand: `{why: "not-yet", notBefore: "2031-01-01…"}`, and 0 requests;
  - automatic: "not-due";
  - after `notBefore` was mended, automatic was still "not-due" (because of the future `lastTriedAt`).
- **Why a bound is safe.** The client never holds a host longer than an hour (`MAX_HOLD_MS`), and the longest wait is 24 h. So a kept `notBefore` more than an hour ahead, or a `lastTriedAt` more than about 25 h ahead, can only come from a wrong clock. It can be treated as passed, which keeps R411 for every real wait.

**M2. The send's audit line can say "asked" when nothing was sent, and no later line corrects it.** R566 (6).
- **P-H.** Between the send's audit and the request, another attach received a 429 for the same host. The look-up's request was then left out by the client: 0 requests. Still:
  - the send line stands: `services: ["openalex"], lookups: 1`;
  - the outcome line says only `state: "waiting"`;
  - a try was counted (`tries: 1`, `lastTriedAt`), so five such tries end "gave-up" without one request.
- **P-A.** Two look-ups at once give two send lines for one request (the second answer came from the client's cache).
- **A cancelled send.** The send line stands alone (tested). The design accepts this, but no line says it was not completed.
- **The mend.** Add `sent: n` (requests that left) to the outcome line, and count a try only when a request left.

**M3. The sentence is incomplete in some mixes.** `look-up-state.ts:87-98`.
- **Found and still waiting** (P-K): the reasons show only the waiting sentence, while a match found from the file's DOI hint has been appended. The R577 warning ("The match was found from an identifier in the file…") is not said. The attach's own hint sentence ("An identifier found in the file could not be confirmed…") is still in the reasons, which softens this.
- **Not allowed and nothing found:** only "nothing" is said.
- **Gave up after five presses by the researcher** (P-M; the researcher's tries count toward the bound): "…so the app has stopped trying by itself" is said, although the app never tried by itself.

**M4. A failed lookup asked by hand that meets a wait becomes asked-to-wait, and so enters the automatic pass.** P-N, first look-up. R577 (iv) says failed lookups are offered "by hand only". This departure is defensible, since the service did ask to wait, but the report does not say it (§9.4 covers only the reverse). The ruling should note it.

**M5. De-duplication uses the resolution's key.** The key holds the provider and the DOI as written. So the same work from Crossref and from OpenAlex, or a DOI that differs only in case, is appended twice (P-L: 3 candidates out of 3). This is inherited from `resolve.ts`. It is bounded, because "found" and "nothing" are final, apart from I1 and I2.

**M6. Two planted faults are caught by one test each.**
- **Provider filter ignored:** caught only by the unit test "the provider filter is the call's own". No test drives `lookUpAgain` on an entry where only part of a chain was left out (for example only OpenAlex for a DOI) and checks that the other service is not asked.
- **Send audited after the request:** caught only by test (7). Test (9) checks only send < write.

**M7. The older-build proof is a hand copy of 2d12ab1's `parseReviewFile`, not that build's code.** I compared it with `git show 2d12ab1:packages/library/src/repo/review.ts:463-479` and found it faithful for unsealed lines. It could drift. It does not cover sealed lines, and it does not cover an entry in the "gave-up" state.

**M8. With several requests, `authorizeOnly` audits only the first request's decision.** `repo/mutate.ts:462-465`. The second service's warnings or conditions are not recorded. By reading.

## What held (by probe unless marked)

- **`source.json` is byte-identical after every outcome.** Builder's tests, plus P-B, P-K and P-N, where nothing touched the record.
- **Accept by position.** Candidates are only appended, so every old position still names the same candidate (P-B, P-K, builder (8)).
- **The re-read inside the change catches every decision between the send and the write.**
  - Decided (keep-both) and source removed: builder's tests.
  - Removed by merge or skip: the same path through `deleteSource` (by reading).
  - Undo: not possible for attach entries (by reading).
  - A hand edit leaves an import entry pending: this is the design.
- **The rules are asked again.** A service no longer allowed gets 0 requests and "not-allowed". Title search no longer allowed (the project turned identifiable): 0 requests and "not-allowed" (P-E). When the rules allow it again, the automatic pass never asks it, but the researcher's act does (P-E, the builder's choice §9.5).
- **The closing.**
  - Closing signal aborted before the send's audit: "closing", 0 requests, no audit line (P-I 1).
  - Closed between the answer and the write: "cancelled", the folder byte-identical after `close()` and after the wait settled, no unhandled rejection (P-I 2).
  - Request in the air: the builder's (7).
- **The encrypted project's audit.** The send line is in the clear like every audit line: op, entry id, source id, service names, count. No title, file name or identifier is in the audit bytes (P-G).
- **The review line is sealed** (builder's test).
- **R411.** "not yet" with the time, and 0 requests. The second wait sets a new `notBefore` (P-M). The growing waits and "gave-up" after the fifth automatic try (builder's (6)).
- **The sentences.** All of R577's words match character for character; I compared them with a script against the ledger line.
- **`authorizeOnly` with one request** is byte-for-byte what it was. `decide` already took arrays, and `first.req.action === req.action`. The callers' tests pass: `transcription-jobs` 15/15, `lock-guards` 7/7, `backup-governed` 22/22.
- **One request denied among several:** the deny is audited and thrown, nothing is sent, and the allow is not audited (by reading `decide`).
- **The older build (2d12ab1), by reading:**
  - `verifyChain` checks only seq, prevHash and hash.
  - `AuditLog.tsx` shows an unknown `details.op` as raw text (`whatOf`).
  - The project export looks only at `retention.destroy`.
  - Every rewrite of a review entry spreads it (`review.ts:144, 251, 294, 330, 751, 771, 804`; bulk/review.ts, as the test cites).
  - The page lists every candidate with no limit, and the route sends them all.
- **Bulk Import.** No file under `import/bulk` changed. `keepFailed` is only for `askedToWait: "leave-out"`. `bulk-asked-to-wait` 1/1.
- **The provider filter** is a per-call argument with a default of `{}`. Only `look-again.ts` passes `{ only }`. The other change in `firstAnswer` adds a non-enumerable property to errors.
- **Runs, each file alone, all green:**
  - attach-asked-to-wait 11/11 · attach-closing 5/5 · attach 69/69 · resolve-titles 24/24 · common 2/2 · look-again 17/17 · look-up-state 16/16
  - lookup: http-closing 7/7 · http-keys 18/18 · http-leave-out 31/31 · lookup 39/39 · recorded 21/21
  - find: all 14 files, runner 301/301 ×7
- **Planted faults:**
  - re-read removed: tests (1) and (2) fail;
  - provider filter ignored: the filter test fails;
  - audit moved after the request: test (7) fails.

  All three were restored.

## The intermittent test

- **Its name.** The builder's report names it (§8): `find/runner.test.ts:4158`, "R411 b (M2): a Retry-After as an HTTP date, on a 503: honoured; several offers: the longest counts".
- **Reproduction.** I ran the file alone six times, then once beside two `yes > /dev/null` processes (killed afterwards; `pgrep` shows none). It passed 301/301 every time, so it did not reproduce.
- **The builder's cause does not hold, by reading.** The builder says "an HTTP date drops milliseconds". But `NOW` is `10:00:00.000Z`, and the fake clock moves only when the test calls `advance()`. So `toUTCString()` loses nothing.
- **A likelier cause (by reading only, not proved).** A race between the two offers: A answers 503 with an HTTP date of +30 min, and B answers 429 with 600 s. If the entry's `nextTryAt` is written with only B's wait collected, `waitsToRetry` sees +600 s.
- **It is not the order dependence mended earlier.** That was "R324 a …", a different test.
- **This change does not touch it.** It changes nothing under `src/find/`. In the client it adds only the read-only `heldUntil`; in `lookup/index.ts`, a non-enumerable error property and a default-off filter. The test and the runner are identical at 7d8d861, so it is almost certainly intermittent there too.
- **What it needs.** Its own entry in the list (R540, R574). It is not a reason to hold this change.

## Table

| point | verdict | note |
|---|---|---|
| 1 record never changed, decided never reopened | partly | Record and decisions hold. Two look-ups at once lose state (I1). |
| 2 accept by position | holds | Append-only. Growth is bounded except through I1 and I2. De-duplication by provider and DOI as written (M5). |
| 3 R411 and the hold | partly | `notBefore`, hold, bound and waits hold. A wrong clock blocks both paths (M1). The researcher's tries count toward "gave-up" (M3). `dueLookUps`: one read of the review file per project per call, not one per entry (by reading). |
| 4 rules asked again | holds | "not-allowed" is final for the automatic pass and asked again by hand. Locked: builder's test. Read-only: refused before anything (by reading). |
| 5 audit of the send | partly | Before the request; ids and counts only; clear like other lines. It can claim a send that never left (M2). `authorizeOnly`'s callers unchanged. The older build reads the events (by reading). |
| 6 R55 | holds | Hints only on the entry; `source.json` and the index untouched; sealed. |
| 7 the close | holds | At every point probed. "Inside the write" by reading (R546 machinery). |
| 8 failed lookups | partly | Kept, never "Waiting…", not automatic, asked at once by hand. A failed lookup that meets a wait becomes automatic (M4), and the collision in I2 starts from this mix. Bulk unchanged. |
| 9 state and words | partly | Words exact. Some mixes say less than is true (M3). |
| 10 older build | holds (by reading and a copied reader) | The copy is faithful. It does not cover sealed lines or "gave-up" (M7). |
| 11 other touched code | holds | The filter cannot leak. Attach, lookup and find all green. |
| 12 intermittent test | not reproduced | Named above. The builder's cause does not hold. Not touched by this change. |

## What I could not judge
- The older build's behaviour when actually running. Everything about 2d12ab1 is by reading its code.
- The exact cause of the intermittent find test, because it did not reproduce.
- Closing exactly inside the governed write. I relied on the R546 tests of `importChange`.
- A read-only library. I did not open one; this point is by reading only (`run` checks `lib.mode` first).
- The cost of `dueLookUps` with 500 entries. By reading only: one parse of the review file and one in-memory list of sources per call. Not measured.

## Verdict
**Not approved.** No Critical findings; two Important.
- I1 and I2 both corrupt an entry's look-up state: a found lookup is lost, the entry reads "Waiting…" after the service answered, and the service is asked again.
- Each mend is small and local to `look-again.ts`:
  - work out the lookup's result against `cur` inside the change;
  - give each lookup a stable key.
- Each needs its probe as a test (P-B, P-N).
- The Minors can follow, or go to T3 and T4 (M2's outcome counts, M3's sentence in mixes).
