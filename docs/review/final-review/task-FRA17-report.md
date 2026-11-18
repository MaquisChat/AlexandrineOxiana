# Task FR-A17 report: a copy found but not downloaded (R379; WB4 I3)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/fr-a17`, branch `fr-a17-find-not-fetched`.
Commits: `5f22f90` (point 1), `76da5a3` (points 2–4, engine, shared, service test), `b3777c6` (point 5, screen).

## Point 1: passing or final, for each failed download (`5f22f90`)
- `packages/library/src/find/fetch-file.ts`: `FetchFileError` gains an optional third constructor argument, `readonly status?: number`. It is set for code "status" (the answer's HTTP status). This adds to the constructor and is backward compatible; the brief's 408/425/429/5xx sorting needs the status. A table `DOWNLOAD_FAILURE: Record<FetchFileErrorCode, "passing" | "final">` sorts every code, and the type makes the table complete:
  - Final: address, redirect-refused, too-many-redirects (the fetcher's own safety rules); encoded, too-large, not-pdf-or-epub (what was sent).
  - Passing: headers-timeout, deadline, unreachable (the network or a reset), write-failed (the library's temporary folder, not the copy).
  - For "status": 408, 425, 429 and 5xx pass; every other status is final.
  - An error that is not a `FetchFileError` passes (for example the runner's own `TimedOut` of FIND_DOWNLOAD_TIMEOUT_MS, or anything not foreseen).
  - New export `downloadFailurePasses(err)`. It is not re-exported from `find/index.ts`; only the runner uses it.
- Test: `fetch-file.test.ts` "R379 (FR-A17): a refusal for its answer keeps the answer's status, and every refusal is sorted passing or final". It failed first (status undefined, function missing).

## Points 2–4: the engine (`76da5a3`)
- `packages/shared/src/api/find.ts`: new reason `copy-not-downloaded` in `FIND_REASON_CODES`, next to `copy-some-unreachable`. Its sentence in `FIND_REASON_TEXT` is exactly "A free copy was found, but it could not be downloaded just now. Try again later, or open one of the links." The library's `FindReasonCode` (`find/types.ts`) gains the same code. The service's `Same<>` check holds them equal.
- `packages/library/src/find/runner.ts`:
  - `tryLater(code, patch, rest?)`: the one existing retry path, used for unreachable look-ups and for "every free-copy service unreachable" (R282 e). It gains an optional `rest`, which is where the entry rests instead of "failed" once FIND_RETRY_DELAYS_MS (60 s, 300 s, 900 s) is spent. Callers that pass no `rest` behave as before.
  - In `copyOn`'s download loop, each failure that is not an abort is sorted with `downloadFailurePasses`. If no file was obtained and at least one failure was passing, the runner calls `tryLater("copy-not-downloaded", { state: "looking-for-copy" }, { state: "no-open-copy", offers: links })`. The entry then waits exactly as an unreachable free-copy lookup waits: the same delays and the same attempts counter. At each retry the services are asked again, and the attempts are not reset, because the state is already "looking-for-copy". Once the delays are spent it rests as "no-open-copy" with reason "copy-not-downloaded", its links kept. Before it rests, a wait shows no reason, like the unreachable case.
  - When every offer failed finally, the result is unchanged: "no-open-copy", the links kept, no reason, nothing tried again.
  - Point 4 is untouched: an abort (the researcher's removal, the record removed, a stop, lock or close) returns before any sorting.
  - A file obtained on a later attempt goes through the same `holdOne` path, so it is held for the researcher's check and nothing is attached.
  - `retry` also accepts "no-open-copy" with "copy-not-downloaded": it looks for a copy again, the same branch as "copy-some-unreachable". The state diagram and the comments were updated.
  - `restsForLibrary` already offers "Get through my library" for any "no-open-copy" except a removed record, so the new reason gets it too. This is shown in the service test.
- Tests, each seen to fail first (they timed out waiting for the wait state, or failed on 409 against 200):
  - Changed (it pinned the defect): `runner.test.ts` "a download is bounded as a whole: past FIND_DOWNLOAD_TIMEOUT_MS …". It used to expect `no-open-copy` with links after a timed-out download. It now expects the wait: "looking-for-copy", attempts 1, nextTryAt = now + FIND_RETRY_DELAYS_MS[0], no reason, the folder gone.
  - New: "every download timed out: tried again like an unreachable lookup, then 'no open copy' saying a copy was found, with Try again; a later file is held for the researcher". It runs all delays with nothing downloaded before each delay ends, then checks the rest with links, nextTryAt gone and no timer, then that `retry` is accepted, and that the file is then held: needs-check / file-looks-right, one pending review entry, the source has no asset.
  - New: "one offer 503 and another 404" → copy-not-downloaded after the same waits, and Try again is accepted.
  - New: "a second attempt that gets the file holds it … exactly as a first would" (502, then the file).
  - New: "a 429 with a Retry-After (30 s)" → waits the runner's delay (60 s) and nothing is downloaded sooner.
  - New: "every offer refused for good (404, 410)" → plain no-open-copy, no nextTryAt, no timer, and `retry` is refused. This passed before the change; it guards against regression.
  - The test harness gained `fileStatus` (address → status and headers) on the existing MockAgent.
  - `shared/src/api/boundary.test.ts`: the code list and the exact sentence. It failed first.
  - `apps/library-service/src/your-library-routes.test.ts`: new "R379 (FR-A17): a copy found but not downloaded: the view carries its reason (its own sentence) and its links, a start is offered, and Try again is accepted". `POST …/retry` returns 200 and "looking-for-copy", and the plain one still returns 409. It failed first (409 against 200).

## Point 5: the screen (`b3777c6`)
- `packages/ui/src/components/FindEntryRow.tsx` (the "no-open-copy" case of the controls table): "Try again" is also offered for "copy-not-downloaded". The sentence comes from `FIND_REASON_TEXT` as for every reason. Nothing else on the screen changed.
- `FindAcquire.test.tsx`: the copy part's table gains the row "no copy not downloaded" (No open copy, the sentence, controls try/open/remove). The Get-through-my-library table gains "startable not downloaded" (try/library/open/remove). Both failed first.

## Built differently from the brief, and why
- Retry-After: the unreachable-services path does not read a Retry-After into the runner's waits. Its HTTP client honours one within a request, capped at 60 s, and the runner's next try comes only from FIND_RETRY_DELAYS_MS, whose first delay is 60 s. The download path now uses exactly those delays. So a Retry-After up to 60 s is always respected, and a longer one is respected by neither path. The test pins "not sooner than 60 s / the Retry-After". If a longer Retry-After should push the next try later, that applies to both paths and is a decision for the coordinator.
- The services are cached by the lookup client within a run, so the test detects each retry by the file requests (a new download) rather than by a new request to the services.

## End to end
`e2e/find-copies.spec.ts` and `e2e/find.spec.ts` have no scenario for unreachable services. Their headers say that a failing service would show only as "Some services could not be reached…" or as the engine's waits (60, 300, 900 s), "which no scenario waits on". So there is no twin to add, and a failed download would reach "Try again" only after 21 minutes of engine waits. Nothing was added.

## What only a real service can show
Real arXiv, Europe PMC and the other services answering 429 or 503 under load. All of it is shown here with MockAgent stand-ins only.

## Incident (needs the coordinator's attention)
While showing that a test fails without the change, I used `git stash push <file>` and `git stash pop`. The stash list is shared by all worktrees of the repository. Another worktree (`fr-a10-names`) used the stash at the same moment. My `pop` applied its entry ("WIP on fr-a10-names: 3ed638e …", touching `packages/library/src/repo/pseudonyms.ts`) into my worktree, with a conflict. My own entry (only `packages/library/src/find/runner.ts`) disappeared from the list, probably popped by that worktree.
- I restored `pseudonyms.ts` to HEAD in my worktree, so nothing of it is in my commits.
- I recovered my change from the dangling stash commit `816e3e1`.
- I did not drop the fr-a10 entry: it is still `stash@{0}`.
- I did not look at or touch the fr-a10 worktree. It may now hold my `runner.ts` change, uncommitted, in place of its own stashed `pseudonyms.ts` change. Its owner should check `git status` there and recover its work from `stash@{0}`.

**Update after the coordinator's note.** The other worktree put my entry back, and it is now `stash@{0}` = `816e3e1`. Its `runner.ts` diff is line for line the same as `git diff 5f22f90 76da5a3 -- packages/library/src/find/runner.ts`. The stash's content is in my commits, so it can be dropped. I did not apply or drop it, and I will not use `git stash` again. Later the coordinator moved the entry to the branch `keep/fr-a17-stash` (816e3e1). `git diff keep/fr-a17-stash 76da5a3 -- packages/library/src/find/runner.ts` is empty, and so is the same diff against HEAD. The content is in my commits, so the branch can be deleted.

## minor (deferred)
- `write-failed` is sorted passing: a full or broken temporary folder may last, and then the row says "could not be downloaded just now" after three retries. That is true enough, but a local fault would be better said as such.
- During the waits the row reads "Looking for a copy" with "Try again", like the unreachable lookup's waits. It carries no links until it rests.

## Runs
Every run was at `nice -n 10`. The load average was 33–49 throughout.
- **Touched test files.** Each passed:
  - `fetch-file.test.ts`: 41/41.
  - `src/find/` in the library (runner.test.ts included): 13 files, 1169/1169.
  - `FindAcquire.test.tsx` alone: 206/206.
  - `boundary.test.ts`: 19/19.
  - The new service test passed. It is in `your-library-routes.test.ts`, which also passed as a whole within the service suite (no failure listed there).
- **@ao/shared (vitest run; the package has no test script).** 4 files, 52/52.
- **@ao/library suite.** 6 files failed, 100 passed, 1 skipped; 15 tests failed, 3691 passed, 22 skipped.
  - Every failure is a time or memory limit in a file I did not touch: html-strip, custom-styles, extract, refman, annotations-cap, transcript-segments.
  - Re-run alone, 5 of those 6 files failed again with the same limits (16 failed / 277 passed); transcript-segments passed. The load was still 33–40.
  - None of these files is in `find/`.
- **@ao/library-service suite.** 3 files failed, 37 passed; 3 tests failed, 1023 passed. The re-run alone gave the same 3:
  - `find-browser-routes` R348 d: "Ready in 20 seconds." against "Ready in 15 seconds." — a real-clock pause measured late.
  - `main.test` R98: start-up took 13,031 ms against a 10,000 ms limit.
  - `recovery-code` "a success clears the count": a 60 s time-out.
  - All three are real-clock limits under load and do not touch the reasons or the retry.
- **@ao/ui suite.** 17 files failed, 96 passed; 39 tests failed, 2118 passed. FindAcquire was among them under load (time-outs), then passed 206/206 alone. The other 16 files re-run alone: 4 failed (19 tests), 12 passed:
  - PdfPages: after its first time-out, the following tests of the file cascade.
  - ReviewQueue "six at a time": known to fail under load.
  - Library.reader R12: time-outs.
  - LibraryNotFound: streaming.
  - None of these renders FindEntryRow.
- **`pnpm -r typecheck`.** Exit 0.
- **`lint:css`.** Exit 0 (stylelint, no findings).
- **`lint:colours`.** "ok: no hard-coded colours in src/**/*.ts(x)".
- **UI build.** "✓ built in 33.98s".
- **End to end.** Not run: no spec covers this (see above).
- `git status --short` is empty. Nothing was left running.

## Round 2 (R411)
Head: 015630e. One commit per point: 08ab472 (a, M1), b10ddb2 (b, M2 and M6), 3c2c096 (c, M3), 015630e (d, M5). I did not use `git stash`.

- **a (M1).** `runner.ts`, in the branch where every offer failed for good: when `found.failed` is not empty, the entry now rests "no-open-copy" / `copy-some-unreachable` with its links. That is what the no-offer case does (R282 e): no automatic retries there either, and "Try again" is accepted.
  - New test "R411 a (M1)" (the review's probe G: Semantic Scholar unreachable, OpenAlex's link answers 404) gives `copy-some-unreachable`, and `retry` is accepted. It failed first.
  - The plain case (every service answered and the link answered 404/410: plain, `retry` refused) is the existing test "every offer refused for good".
- **b (M2).** The service's Retry-After now reaches the runner on both paths:
  - **The download.** `FetchFileError` gains an optional 4th argument, `retryAfter` (raw, at most 100 characters), set on a "status" refusal.
  - **The look-up of copies.** `LookupHttpError` gains a non-enumerable `retryAfter`, set on a 429 and on any other status in the `getText` path (`lookup/http.ts`, `withRetryAfter`). `free-copy.ts`'s `Throttled` carries it. `findFreeCopies` returns `retryAfter?: string[]` only when some service asked to wait, so existing deep-equality tests are unchanged.
  - **The runner.** `tryLater` takes the raw values. The next try by itself comes at max(the usual delay, the longest Retry-After), each Retry-After cut to `FIND_RETRY_AFTER_MAX_MS` (one hour, exported). The runner parses the values with its own clock, so the HTTP-date form follows the runner's `now`; unreadable values are ignored. When an offer is downloaded, the services' waits count too.
  - The number of tries is unchanged, and the researcher's "Try again" goes at once.
  - **New tests, all of which failed first apart from the two that pin the usual delay:**
    - A download 429 with Retry-After 3600: an hour, nothing asked before it, and the second wait also an hour.
    - 7200 is cut to an hour.
    - An HTTP date on a 503, together with another offer's 600: the longest counts (30 min).
    - An unreadable value gives the usual delay.
    - A copy service 429 with 3600 gives an hour; a copy service 503 with 900 gives 15 min.
    - "Try again" during an hour's wait asks for the file at once, and the file is held with nothing attached.
  - **M6.** The old 429 test is now "R379, R411 b (M6): a download's Retry-After shorter than the usual delay (5 s): the usual delay (60 s), nothing sooner".
- **c (M3).** The wait after failed downloads keeps `offers: links`, and they are also kept on the rest.
  - The wait for unreachable services keeps any links found in that attempt. When every service failed there are normally none, and links kept by an earlier attempt stay, because the wait drops only `reason`.
  - New runner test: the links are on the entry during the 1st and 2nd waits. It failed first.
  - The screen already shows "Where to get it" in every state (`showOffers` does not depend on state), and the service passes stored offers through for "looking-for-copy". `FindAcquire.test.tsx`'s "Where to get it lists the offers…" gains a waiting row with links and "Try again". It passed without any screen change, which confirms the screen did not hide them.
- **d (M5).** The comment now says that the copy part runs again, that the look-up's kept answer usually serves it, and that the same offers are downloaded again.

**Not done here:** a test that the unreachable-services wait keeps links found in that same attempt. The lookup's cache makes "every service fails at the retry, links found" unreachable in this harness. The code path is one line beside the tested one.

**Runs** (load average 28–30):
- `vitest run src/find src/lookup` (library): 16 files, 1256/1256.
- The service's find-routes, find-browser-routes and your-library-routes: 119 passed, 1 failed. The failure is R348 d "Ready in 20 seconds." against 19 received. It is the real-clock pause test that also failed in round 1 under load; it failed again alone with 19. It is unrelated: the library-pause countdown touches neither the free-copy waits nor Retry-After.
- `FindAcquire.test.tsx`: 206/206.
- `pnpm -r typecheck`: exit 0.
- `git status --short`: empty.

## Round 3 (review 2, M1)
- Commit 54276e3: `FetchFileError.retryAfter` is now declared on the class and set non-enumerable with `Object.defineProperty`, only when given and cut to 100 characters, as on `LookupHttpError`. The new test in fetch-file.test.ts ("R411 b (review 2, M1)") checks `Object.keys`, `JSON.stringify`, a spread and the cut. It failed first.
- Runs: `vitest run src/find` 13 files, 1179/1179, the R411 b runner tests included; `pnpm -r typecheck` exit 0.
