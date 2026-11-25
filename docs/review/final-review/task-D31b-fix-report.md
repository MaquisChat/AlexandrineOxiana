# D31b fix round: decision 31 (b), R563 (I1, I2, M1, M5)

Worktree `.claude/worktrees/kg-3a`, branch `d31-attach-at-once`, from 6e9c1f4. Not pushed. **Built.**

## Commits

| commit | finding |
|---|---|
| 53b358f | I1: the hold is looked at just before every send and every retry; any caller's 429 sets it |
| d4c2346 | I2: callers without the choice are as at db8623b; a 2xx clears the hold |
| c9eab69 | M1: odd Retry-After values on a 429 hold for a minute; a 503 with no usable wait takes today's failure path |
| bebe640 | M5: the closing tests learn a request arrived from the stand-in's own reply |

## I1: the hold was looked at too early

**What was wrong.** The hold was checked once, at the top of `fetchWithRetries`, before the call took its place and its throttle slot. It was not checked again before the send or before a retry. Only a leave-out call's own 429 set a hold.

**Tests.** In `packages/library/src/lookup/http-leave-out.test.ts`, describe "the hold is looked at just before every send and every retry (decision 31 b, R563 I1)". Each was seen failing first:

| test | failed with |
|---|---|
| "five calls with the choice started together: after the first 429 nothing more is sent" | `expected 5 to be 1` (`expect(count("api.crossref.org")).toBe(1)`) |
| "a call with the choice whose first try got a 500 sends no retry once another call has set a hold" | `expected 3 to be 2` |
| "a 429 received by a caller WITHOUT the choice sets the hold: a call with the choice then sends nothing" | `expected { status: 'ok', … } to be an instance of LookupLeftOutError` (the attach's request was sent and answered 200) |

How "in the air" is made deterministic:
- Crossref takes one request at a time (`DEFAULT_CONCURRENCY`), so exactly one request is in the air and the other four wait for their place behind it. The test's comment says this.
- The retry and Bulk cases hold the injected sleep with promises the test controls.

**Mend.** All in `packages/library/src/lookup/http.ts`:
- `leftOutIfHeld` (:710).
  - It is called at the start (:733).
  - It is called before every retry (:751).
  - It is called immediately before the send, after the place and the throttle slot (:818, in `fetchFollowingRedirects`, which now takes `leaveOut`).
- A `LookupLeftOutError` raised there is passed on and not treated as a network failure (:757).
- Any caller's 429, or 503 with a wait asked, sets the hold (:771-775). Only a leave-out call then throws.
- A request already in the air cannot be called back. It is not counted.

## I2: callers without the choice were changed

**What was wrong.**
- `awaitHold` made Bulk, Zotero and Find wait up to 60 s before every request while a hold stood.
- A 200 did not clear a hold.

**Tests.** Describe "callers without the choice are as at db8623b (decision 31 b, R563 I2)". Each "with a hold" case was seen failing first:
- "with a one-hour hold left by an attach: 429/Retry-After 60 three times, then 200 …" failed with `expected [ 60000, 180000, 300000, 420000 ] to deeply equal [ +0, 60000, 120000, 180000 ]`.
- "… 429 for ever …" failed the same way.
- "… a service answering normally: Bulk asks at once, five times, no wait" failed with `expected false to be true`: 60 s sleeps.
- "a 2xx answer clears the host's hold, whoever received it: a call with the choice is then SENT" failed with "promise rejected LookupLeftOutError instead of resolving".

The "with no hold" twins passed before and after.

**Mend.**
- `awaitHold` is removed. A caller without the choice never looks at the hold (:749-751).
- A 2xx deletes the host's hold (:766).

**Tests replaced** (they asserted the gap):
- "a caller without the option that meets a host's 'not before' waits until then before asking (R411): never sooner";
- "a cut of the client (stop) ends a non-option caller's wait for the hold: nothing is sent". It tested `awaitHold`, which is gone.

### Bulk as before: the old client against the new one

Setup:
- The reference is the db8623b `http.ts`, copied to a temporary file and driven by a temporary probe; both were deleted afterwards.
- The new client is at d4c2346 and later.
- Both are driven through the same answers on the same injected clock.
- The caller is one `getJson` without the choice, to `api.crossref.org`.
- "With hold" means an attach first left a one-hour hold, then 1 s passed.
- Times are seconds from the call's start.

| answers | client | requests at (s) | sleeps (ms) | result |
|---|---|---|---|---|
| 429/RA 60 ×3, then 200 | db8623b | 0, 60, 120, 180 | 60000 ×3 | the answer |
| 429/RA 60 ×3, then 200 | new, no hold | 0, 60, 120, 180 | 60000 ×3 | the answer |
| 429/RA 60 ×3, then 200 | new, 1 h hold | 0, 60, 120, 180 | 60000 ×3 | the answer |
| 429/RA 60 for ever | db8623b | 0, 60, 120, 180 | 60000 ×3 | "The metadata service answered HTTP 429" |
| 429/RA 60 for ever | new, no hold | 0, 60, 120, 180 | 60000 ×3 | the same |
| 429/RA 60 for ever | new, 1 h hold | 0, 60, 120, 180 | 60000 ×3 | the same |
| 429/RA 0 for ever | db8623b | 0, 0.2, 0.4, 0.6 | 0,200,0,200,0,200 | 429 failure |
| 429/RA 0 for ever | new, no hold | 0, 0.2, 0.4, 0.6 | 0,200,0,200,0,200 | the same |
| 429/RA 0 for ever | new, 1 h hold | 0, 0.2, 0.4, 0.6 | 0,200,0,200,0,200 | the same |
| (at 6e9c1f4, for comparison) 429/RA 60 for ever, 1 h hold | old fix | 60, 180, 300, 420 | | |

The review's numbers are confirmed: 180 s at db8623b, 420 s at 6e9c1f4. "One lookup" is one client call: the first try and 3 retries. The committed tests assert the db8623b numbers.

## M1: odd Retry-After values

**What was wrong.**
- `Date.parse` accepts `x 7` and `-5` as dates (2001). Against a real clock they gave a hold of 0. Against the tests' 1970 clock they gave the full hour.
- `0` and a past date gave a hold of 0, while the file was still shown as waiting.
- A 503 with `0` or a past date was "left out" with a hold of nothing.

**Tests.** Describe "odd Retry-After values (decision 31 b, R563 M1)": for `x 7`, `0`, `-5` and a past date, one 429 test and one 503 test each.
- The 429 tests failed first. For example, `expected 4600000 to be 1060000` for `x 7` and `expected 1000000 to be 1060000` for `0`.
- The 503 tests failed with `expected LookupLeftOutError … to be an instance of LookupHttpError`.
- Also added: "a 429 with a usable Retry-After (30) holds for 30 s", and "a caller without the choice still waits what it waited at db8623b for a 429 with Retry-After 0". The second asserts the reference's sleeps and times.

**Mend.** `holdAskedMs` (`http.ts`:910), with `HTTP_DATE` (:900), is used at :771. It applies to the hold only.
- **429.** Whole seconds, or an HTTP date in a form RFC 9110 allows, that lies in the future: honoured, cut to the hour by `holdHost`. Anything else counts as 60 s: absent, unreadable, 0, negative, or past.
- **503.** It holds only for a usable positive wait.
  - **A 503 with `Retry-After: 0`** (or negative, past, or unreadable) asks for no wait. It is therefore "a 503 WITHOUT a wait asked" and takes today's failure path: retried with the client's usual delay, then `LookupHttpError`, with no hold.
- `retryAfterMs` and `retryDelay` are unchanged, so the waits of callers without the choice are unchanged.

## M5: polling in the closing tests

The stand-in's reply callback now counts the request and resolves `asked` (or `lookedUp`). It answers 404 after `.delay(600_000)`, which an abort clears. The callback runs when the request is dispatched, before the delay (undici 8.12.3, `mock-utils.js` `mockDispatch`).
- `packages/library/src/import/attach-closing.test.ts:111-127`
- `apps/library-service/src/close-during-attach.test.ts:111-127`
- `packages/library/src/import/watch-closing.test.ts:82-97`

The assertions are unchanged. The overlong doc comments in `close-during-attach.test.ts:1-9` and `attach-closing.test.ts:1-8`, and the helpers' comments, are now plain sentences.

This is a test-only change. There is no failing-first test for it; the three files pass.

## Runs (each file alone, `--testTimeout 120000`)

**Library, lookup:**

| file | tests |
|---|---|
| http-closing | 7 |
| http-keys | 18 |
| http-leave-out | 31 |
| lookup | 39 |
| recorded | 21 |

**Library, attach, resolve and watch:**

| file | tests |
|---|---|
| attach-asked-to-wait | 9 |
| attach-closing | 5 |
| attach | 69 |
| resolve-titles | 24 |
| watch-choices | 9 |
| watch-closing | 1 |
| watch-local | 51 |
| watch-settings | 9 |
| watch | 143 |

**Library, Bulk:**

| file | tests |
|---|---|
| annotations-plan | 9 |
| bulk-asked-to-wait | 1 |
| bulk-closing | 2 |
| bulk | 103 |
| disk-full | 14 |
| failure-cause | 5 |
| patterns | 2 |
| space | 15 |
| zotero-conflict | 41 |
| zotero-gone | 26 |

**Library, Find:**

| file | tests |
|---|---|
| elicit | 18 |
| fetch-file.recorded | 15 |
| fetch-file | 42 |
| file-check.hostile | 275 |
| file-check | 112 |
| free-copy | 80 |
| people | 40 |
| queue-store | 81 |
| reference | 6 |
| runner.linked-missing | 62 |
| runner | 301 |
| search | 120 |
| settings | 21 |
| where | 87 |

**Library, Zotero:**

| file | tests |
|---|---|
| zotero-web | 92 |
| zotero-local | 85 |
| zotero-sync | 77 |
| zotero-dry-run-journals | 4 |

**Service:**

| file | tests |
|---|---|
| attach-asked-to-wait | 1 |
| close-during-attach | 11 |
| find-routes | 47 |
| import-disk-full-answer | 3 |
| import-disk-full | 2 |
| import-log | 1 |
| import-setup | 25 |

All passed. Typecheck is clean for `@ao/library` and `@ao/library-service`. `git status --short` is empty. No process of mine is left running.

## Uncertain

- **A good answer clears the hold.** If two requests are in the air together, one answered 429 and the other 200 just after, the 200 clears the hold. The next leave-out call then asks at once. This follows the ruling ("whoever received it").
- **A held leave-out call uses up a throttle slot.** The check just before the send comes after the throttle slot is taken. A held leave-out call therefore uses up one slot (at most 200 ms for Crossref or OpenAlex) without sending anything.
- **A strict date reading for the hold only.** For the hold, a date is read only in an HTTP form. `retryAfterMs` still uses lenient `Date.parse` for the waits of callers without the choice. This is unchanged on purpose (I2).
