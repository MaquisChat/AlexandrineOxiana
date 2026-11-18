# Review of Task FR-A17: a copy found but not downloaded (R379; WB4 I3)

Reviewer: fresh, adversarial. Worktree `.claude/worktrees/fr-a17`, branch `fr-a17-find-not-fetched`, base 7537f63, head b3777c6. The review package (744 lines) was read in full, with the brief, the report, WB4 I3 and check 4, and R379 (FR-A17), R282 (e), R283, R296, R301, R303 and R310.

## Verdict: APPROVED WITH SMALL POINTS

Spec: met. All five points of the brief are built as asked. Two differences are explained in the report and are justified: Retry-After is honoured exactly as on the unreachable-services path, and no end-to-end twin was added.
Quality: sound. No Critical or Important findings, and 7 Minor ones. M1 needs the coordinator's ruling: it is the one part of I3's text that is still not closed.

## What I ran
Every run was at `nice -n 10`, with the load average between 31 and 38. One probe file, `packages/library/src/find/runner.probeFRA17.test.ts`, was a copy of runner.test.ts with probes added to the F11 block. It has been deleted, and `git status --short` is empty. I never used `git stash`.

- **The finding's own case, re-checked against the fixed code** (`runner.test.ts -t "R379|bounded as a whole|R282 e"`): 9 of 9 pass. A timed-out download now waits as "looking-for-copy" with attempts 1 and nextTryAt now + 60 s, no reason, and its folder gone. It is no longer "no-open-copy".
- **Probes:**
  - **A.** A 429 with `Retry-After: 3600`, run through every retry. There are 4 file requests in all, at t = 0, 60, 360 and 1260 s. The entry then rests as no-open-copy / copy-not-downloaded. OpenAlex was asked only once in all four attempts, because the lookup cache answered the rest.
  - **B.** The retry timer fires and "Try again" is pressed in the same moment. The press is accepted, there are 2 file requests in all, and the entry ends "needs-check" with 1 held file and 1 pending review entry. The source has no asset.
  - **C.** A 503, then a 404 at the retry. The entry ends as a plain "no-open-copy" with no reason, no nextTryAt and no timer.
  - **D.** A 500 on a held (streamed) response. The entry waits, and its folder is gone.
  - **E.** An encrypted project, waiting after a 502, is locked past its retry time and then unlocked. No request was made while it was locked. After the unlock and resume, the file is held once and nothing is attached.
  - **F.** The service is restarted while the entry waits (`stopAll`, then a new runner's `resume`). Before its time the entry waits as looking-for-copy with attempts 1 and its nextTryAt kept. At its time the file is held once and nothing is attached.
  - **G.** Europe PMC cannot be reached ("could not be reached" in the notes), and OpenAlex offers a link that answers 404. The entry ends as a **plain "no-open-copy" with no reason, and "Try again" is refused** (`FindEntryStateError`). See M1.
  - **H.** As G, but the link answers 503. After the waits the entry rests as no-open-copy / copy-not-downloaded, with 1 link.
- **Guards** (each was removed, the test was seen to fail, and the line was put back with `git checkout -- <file>`):
  - Without `if (downloadFailurePasses(err)) passing = true`: 5 tests fail, including the changed pinned test.
  - With `passing = true` always: the "every offer refused for good" test fails, so the old behaviour is still held.
  - With `...rest` dropped from `tryLater`'s last write: the two rest tests fail.
  - With `copy-not-downloaded` dropped from `retry`: the timed-out test fails with FindEntryStateError.
  - With `copy-not-downloaded` dropped from `FindEntryRow.actionsOf`: both UI tables fail ("no copy not downloaded" and "startable not downloaded" lose "Try again").
  - `DOWNLOAD_FAILURE` and `PASSING_STATUS` are pinned entry by entry by the fetch-file table test.
- **Touched tests:**
  - fetch-file R379 test: 1/1.
  - `shared` boundary.test.ts: 19/19.
  - The service's R379 route test: 1/1.
  - FindAcquire's two tables pass with the guard in place, and failed without it (above).
- **Not re-run** (reported by the implementer): typecheck, lints, the UI build and the whole suites. These were not allowed under the review rules or were not needed.

## Findings

### Critical
None.

### Important
None.

### Minor

**M1 — One service unreachable, and every offer refused for good: still a plain "No open copy" with no "Try again" (I3's text names this case; the brief's point 3 kept it "as today").**
- **Where:** `runner.ts:2221-2222`. The final-failure branch drops `reason` even when `found.failed` is not empty. Compare `:2132`, where no offer plus some services failed gives `copy-some-unreachable`.
- **Probe G:** Europe PMC cannot be reached and OpenAlex's link answers 404, giving `{"state":"no-open-copy"}`, and `retry` is refused. A dead link in OpenAlex is common, and the unreachable service might have had a working copy. The row then says something false, and it stays that way: the defect WB4 I3 described ("the reason DROPPED, even when found.failed had services that could not be reached").
- **Why only Minor:** R282 e's literal wording ("some failed **and nothing was found**") and the brief's point 3 support what was built.
- **Direction:** for the coordinator. If R282 e's "nothing was found" means "nothing obtained", keep `copy-some-unreachable` in that branch when `found.failed.length > 0`. That is one condition and one test.

**M2 — A long Retry-After is not honoured: 4 requests in 21 minutes against a server that asked for an hour (probe A). "Try again" starts 4 more.**
- **Where:** `runner.ts:1575-1582` and `:2218`. `fetchFile` reads no Retry-After.
- **What the report says, and whether it holds:** the report says the lookup path does no better. I checked this and it is true: `free-copy.ts:225,242` treats a 429 as `Throttled`, "left alone for this call", with `final429`, and the next try comes only from FIND_RETRY_DELAYS_MS. So the brief's "respects what the unreachable path respects" is met.
- **How much it matters:** the volume is small and bounded: one request per offer per attempt, deduplicated by address (`free-copy.ts:573-579`), at most two downloads at a time. It is not a loop. It is still impolite to a host that said "an hour".
- **Direction:** a coordinator's decision for both paths: push `nextTryAt` to max(the delay, the Retry-After, with a cap).

**M3 — During the 21 minutes of waits the row has no links.**
- **Where:** `finish({state:"fetching"}, [... "offers"])` at `:2135`, and the wait's write at `:1581` adds none back.
- **Effect:** the researcher sees "Looking for a copy" with "Try again", but cannot open the found address until the entry rests. The entry waiting for unreachable services does the same, and the implementer noted it.
- **Direction:** keep `offers: links` in the wait's patch (`tryLater("copy-not-downloaded", { state: "looking-for-copy", offers: links }, …)`), and check that the row shows them for "looking-for-copy".

**M4 — Some lasting failures are sorted as "passing", so the row's "just now" can be untrue after three retries.**
- **Lasting failures sorted as passing:**
  - A DNS name that does not exist, or a TLS certificate refusal: both become `unreachable` at `fetch-file.ts:361`.
  - A full disk or a damaged temporary folder: `write-failed`, as the implementer noted.
  - Any error not foreseen inside `fetchFile`: the catch-all `write-failed` at `:444`.
  - A `TypeError` from `checkTarget` (`:202`), which is not reachable with the runner's ids.
  - A host that is always too slow: `deadline`. Each attempt downloads for up to 3 minutes, so up to 4 full downloads of up to `FREE_COPY_MAX_BYTES`.
- **Why it is only Minor:** all of this is bounded by the same three retries, and it follows the brief's rule that an unknown error passes.
- **Direction:** optional. Sort a local `write-failed` as its own reason later. Leave the rest.

**M5 — A code comment says something the code does not do.**
- **Where:** `runner.ts:2214-2216` says "services asked again".
- **Probe A:** OpenAlex was asked once across four attempts, because the lookup cache serves its answer. The behaviour is fine, and arguably better: it is polite, and the offers are the same. Only the comment and the report's sentence are wrong.
- **Direction:** reword the comment.

**M6 — The 429 test proves little.**
- **Where:** `runner.test.ts:4084`. It asserts `nextTryAt - now >= 30 s` and that nothing is requested before 60 s. It holds for any implementation that waits on FIND_RETRY_DELAYS_MS, and does not distinguish honouring the Retry-After from ignoring it.
- **Direction:** acceptable as the record of the decision in M2. Rename it to say what it pins ("the runner's 60 s, whatever the Retry-After up to 60 s").

**M7 — An older screen build shows a plain "No open copy" for the new reason.**
- **What happens:** `knownReason` at `FindEntryRow.tsx:256` gives no sentence and no "Try again". This is the old behaviour, not something worse, and the desktop bundles the screen with the service.
- **Other readers:** the browser extension and the command line show no queue reasons (grep shows no use outside tests).
- **Direction:** none needed. It is recorded here for completeness.

## Checked and sound
- **The owner's rule (R301, R303) on every new path.** A file obtained on an automatic retry (the "second attempt" test and probes B, E and F), or after "Try again" on the rested entry (the timed-out test), goes through the same `holdOne` path. Each time it ends "needs-check" with exactly one pending review entry and one file in `find/held/`, and the source has no asset.
  - A crash or restart during a wait keeps attempts and nextTryAt, and the new runner holds the file once (F).
  - A lock during a wait sends nothing, and the unlock holds the file once (E).
  - A Try-again press racing the timer gives one held file (B). The old run's `finish("fetching")` fails on the version check, at `runner.ts:1557-1559` and `:2135`.
  - A retry first looks again at the rules (`:2066-2072`) and at FIND_HELD_MAX (`:2093-2097`), before anything is asked.
  - A partly written file is removed by `fetchFile` (`:440-441`), and the per-entry folder is removed in `finally` (`:2230`). Probes D and C, and every `waitsToRetry`, check that the folder is gone.
  - No new path writes a source's asset.
- **R282 e mirrored by the same code.** `tryLater` is the one retry path, and it gained only an optional `rest`. The new reason uses the same delays (60, 300, 900 s), the same attempts counter shared with unreachable lookups (mixed sequences are bounded by the one counter), and the same look between tries (looking-for-copy, nextTryAt, no reason).
  - Callers that do not pass `rest` are unchanged: the R282 e tests pass.
  - The case where a service is unreachable AND a download failed rests as copy-not-downloaded (probe H). The sentence is true there.
- **Sorting.** Every `FetchFileErrorCode` is in the table, and the `Record` type makes it complete.
  - The fetcher's safety refusals (address, redirect-refused, too-many-redirects), encoded, too-large and not-pdf-or-epub are final.
  - 4xx answers other than 408, 425 and 429 are final, as the brief says. A 403 from a rate limiter is therefore final; the brief ordered this, and it is noted, not counted.
  - The time-out of the whole download (`TimedOut` through the signal) passes.
  - The researcher's abort, the entry removed, the record removed, a lock, a stop or a close all return before any sorting (`:2181-2185`). Point 4 is unchanged.
  - The same address offered by two services is downloaded once (deduplicated in `findFreeCopies`).
  - There is no loop: a rested entry is woken by nothing automatic. The only wakes for "no-open-copy" are `retry` (grep `copy-some-unreachable` and `copy-not-downloaded`).
- **`retry`:**
  - It accepts the rested state (service route: 200, "looking-for-copy").
  - It refuses a plain no-open-copy (409; the library's FindEntryStateError).
  - An entry of another project is refused by the scoped `current(projectId, …)`.
  - "fetching" is refused.
  - Two presses are serialised in `act`.
- **R310 wakes.** These are untouched and unaffected. The new waits do not wait for the held limit, and an entry that meets the limit at its retry goes to held-full as before.
- **Texts and contract.** The code is in `FIND_REASON_CODES` and in `FIND_REASON_TEXT`, with the exact sentence, and the library type matches (the service's `Same<>` check). The route carries the reason and the links, and "Get through my library" is offered.
  - The row table and the library table each gained the row with "Try again". Nothing else on the screen changed.
  - The sentence is true when shown: offers existed, nothing was obtained, and at least one failure was passing. Links are present, because every offer has a parsed address and `linksOf` keeps them (capped together with the "elsewhere" links).
  - A queue line with the new reason survives `sanitizeEntry` (a generic `reasonOf`), and F15's `returnTo`.
- **The changed pinned test** now expects the wait (correct). The old outcome for "every offer final" is pinned by the new 404/410 test and by R282 e's "plain no open copy" test, and the guard check above shows it fails when the old outcome breaks.
- **End to end.** The report's claim is correct. Recorded fixtures answer an unrecorded file with 404, which is final (`lookup/recorded.ts:114`), so no existing scenario changes. Neither spec has a scenario for unreachable services, so there was no twin to add.
- **The stash incident** in the report concerns only the process. Every R379 change is in the three commits, and the worktree is clean.

## Could not verify
- Real services (arXiv, Europe PMC) answering 429 or 503 under load. Only MockAgent stand-ins were used.
- The UI build, the lints, the typecheck and the whole suites were not re-run, as the review rules say; the report says they passed.
