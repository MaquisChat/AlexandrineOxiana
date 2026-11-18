# FR-A17: second, scoped look at round 2 (Ruling R411)

Worktree `.claude/worktrees/fr-a17`, branch `fr-a17-find-not-fetched`, head 015630e (08ab472 a, b10ddb2 b, 3c2c096 c, 015630e d). I read the round's diff (440 lines) and the report's "Round 2 (R411)" section.

## Verdict: APPROVED WITH SMALL POINTS

Points (a) to (d) are built as R411 says. Each new guard has a test that fails without it. In every path I probed, a found file is still held once, with one pending review and nothing attached. One Minor point and one note follow.

## What I ran
Every run was at `nice -n 10`, with the load average between 23 and 30. I never used `git stash`. The probe file `runner.probeFRA17.test.ts` has been deleted, and `git status --short` is empty.

- `runner.test.ts -t "R411|R379|R282 e"`: 17 of 17 pass.
- **Guards.** Each line was taken out, the same 17 tests were run, and the line was put back with `git checkout -- <file>`. Each mutation made at least one test fail:

| Guard taken out | Tests that fail |
|---|---|
| (a) `copy-some-unreachable` in the final branch (`runner.ts:2243`) | "R411 a (M1)" |
| (b) the one-hour cap in `askedWaitMs` (`runner.ts:127`) | "7200 is cut to the hour" |
| (b) `Math.max(usual, …)` replaced by the asked wait, or the usual delay when none (`:1588`) | "R379, R411 b (M6)" (5 s gives 5 s, not 60 s) |
| (b) the download's `retryAfter.push` (`:2194`) | 4 tests: 3600, 7200, the HTTP date, and Try again during the hour |
| (b) `found.retryAfter` not passed to the unreachable wait (`:2142`) | 2 tests: the copy service's 429 and its 503 |
| (b) both `withRetryAfter` calls in `lookup/http.ts:641,645` | the same 2 copy-service tests |
| (c) `...kept` taken out of the wait's patch (`:2238`) | "R411 c (M3)" |

- **Hostile Retry-After values, end to end through the runner** (a download answering 429):

| Value | Next try in | Attempts |
|---|---|---|
| 10,000 characters | 60 s | 1 |
| "-5" | 60 s | 1 |
| A date in 1970 | 60 s | 1 |
| A date in the year 9999 | 1 h | 1 |
| Arabic-Indic digits | 60 s | 1 |
| "9999999999" | 1 h | 1 |
| "+3600" | 1 h | 1 |

  There was no crash. The wait was never longer than one hour, and never shorter than the usual delay. For every value except "-5", the raw value is in neither `queue.jsonl`, the audit, nor the debug notes. "-5" also matched, but two characters that common show up by chance in the stored text, so that match says nothing.
- **An hour's wait, then a restart** (`stopAll`, then a new runner's `resume`): no request before the hour. At the hour the entry ends "needs-check" with 1 held file and 1 pending review, and the source has no asset.
- In round 1 I had already probed the timer racing "Try again", the lock and unlock, and a crash. Round 2 does not touch those paths (`holdOne`, `retry`, `finish`'s version check).

## Findings

### Minor
**M1: `FetchFileError.retryAfter` is an enumerable field, unlike `LookupHttpError`'s.**
- **Where:** `fetch-file.ts:89`.
- **Evidence:** a probe gives `Object.keys(new FetchFileError("status", …, 429, "X"))` = `code, status, retryAfter, name`. `inspect(err)` and `JSON.stringify(err)` both show the raw value.
- **Why only Minor:** nothing serialises or logs this error today. The runner's debug line logs `err.code` only (`runner.ts:2195`), and no app imports `FetchFileError`, although `find/index.ts:90` exports it. But the class's own promise, "no address, no host", would not cover a later `debug(inspect(err))`. That is the leak R411 asks to rule out, and `LookupHttpError` is already guarded against it.
- **Smallest fix:** set it with `Object.defineProperty(this, "retryAfter", { value, enumerable: false })`, as `withRetryAfter` does. Add one assertion to the fetch-file R379 test that `Object.keys` leaves it out.

### Note (not a defect)
`retryAfterMs` is the existing shared parser. It passes anything that is not 1 to 10 digits to `Date.parse`, which is lenient: "+3600" and "3600.5" are read as dates in the year 3600 and so become the one-hour cap. The value is bounded on both sides, so the only effect is a longer wait than a strict reading would give. A strict parser would be digits only, or an RFC 7231 date only. This is optional.

## The implementer's doubts
1. **`LookupHttpError.retryAfter`, hidden.**
   - It is set only through `defineProperty` with `enumerable: false`, at most 100 characters, so it is left out of spread, `JSON.stringify` and the default `inspect`.
   - The other users of the class are unaffected. `search.ts` reads Retry-After through its own `RateLimitAnswer` and `retryAfterMs`. `zotero-web.ts` reads headers itself. No caller compares these errors by their keys. The client's own retry sleep (`retryDelay(attempt, res?.retryAfter)`) is unchanged.
   - The free-copy debug line prints "HTTP <status>" or fixed words, never the value. `Throttled`'s message is "throttled".
2. **Links found while every service fails** (`runner.ts:2140-2142`).
   - This line cannot be reached in the product. A service that fails returns `[]` from `askOne` (`free-copy.ts:552-563`), and the Internet Archive throws only when it found nothing (`:513`). So when every service asked failed, `found.elsewhere` is empty and `seen` is always empty.
   - It does no harm: the patch is then `{}`, and links kept by an earlier attempt stay, because the wait drops only `reason`. That is the behaviour R411 c wants.
   - No test is possible for it, and none is needed. The comment could say that the line is defensive.

## Checked and sound
- **(a)** The final branch keeps `copy-some-unreachable` when `found.failed` is not empty, with its links and no automatic retry, and "Try again" is accepted. A plain case (every service answered) is still plain and `retry` is refused ("every offer refused for good"). `failed` also counts a service that answered 429 ("Throttled"), which is a fair reading of "could not be reached".
- **(b)** On both paths the next try is max(the usual delay, the longest Retry-After, each cut to `FIND_RETRY_AFTER_MAX_MS` = 1 h).
  - The attempts count and the number of tries are unchanged: the second wait is again an hour, and there are still 3 waits.
  - The look-up part of `tryLater` (`workOn`) passes no values, so it is unchanged.
  - "Try again" during an hour's wait goes at once (`retry` cancels the timer and resets attempts), and the file is held with nothing attached.
  - A wait persisted across a restart is honoured (probe).
- **(c)** The links stay on the wait after failed downloads and on the rest. The screen shows "Where to get it" for "looking-for-copy" with "Try again" (the UI test added).
- **(d)** The comment at `runner.ts:2229-2232` now says what the code does: it runs again, the look-up's kept answer usually serves it, and the same offers are downloaded again. The renamed M6 test asserts the 60 s for a 5 s Retry-After, and the new tests show the hour honoured, with nothing asked of a service or a file host before it.
- **(e)** M4 and M7 were not built, as R411 says.
- **The owner's rule (R301, R303).** No new write path. Every file obtained still goes through `holdOne`: a held file and a pending review entry, with the source's assets empty, in the tests and in probes B, E, F and the restart probe.

## Could not verify
Real services sending odd Retry-After headers. MockAgent stand-ins only.
