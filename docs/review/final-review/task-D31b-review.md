# D31b review: decision 31 (b), R556 (2), "bring a file in at once when a lookup service asks to wait"

Reviewed: worktree `.claude/worktrees/kg-3a`, branch `d31-attach-at-once` at 6e9c1f4 (four commits from db8623b). The whole diff was read. The probes were `*.probeD31.test.ts` files beside the code: undici `MockAgent` with `disableNetConnect()`, the client's injected clock and sleep, and every request counted. All probes are deleted, `git status --short` is empty, and nothing was committed.

## Findings

### Critical
None.

### Important

**I1. R411 / R556 (2) ii breaks under concurrency. Requests already queued for a host are sent after that host has asked to wait.**
`packages/library/src/lookup/http.ts:740-743`. The `notBefore` check runs once, at the top of `fetchWithRetries`. It runs before the call takes its concurrency place (`hold`) and its throttle slot, and it is never checked again before the send in `fetchFollowingRedirects` (:812-817). So a leave-out call that is already waiting behind another request goes out after that request's 429.

Probes:
- **Client.** Three leave-out calls to `api.crossref.org` at once (one at a time is allowed for that host). The first was answered 429 with Retry-After 60. The MockAgent received **3** requests; 1 was expected. The 2nd and 3rd were sent after the 429 had been received, because Crossref runs strictly one request at a time.
- **OpenAlex.** Five leave-out calls at once, first answered 429: **5** requests received.
- **Engine, end to end.** Three `attachFiles` calls at once in three projects, each a PDF with a DOI, every answer delayed 50 ms: Crossref was asked **3** times. Attaches in one project are serialised by its store turn, so this needs two projects: an attach in project A while a watched folder of project B brings files in, or two watched folders. A watched folder of twelve files in one project was fine: 1 request.

Two more paths with the same gap:
- **A leave-out call's own retries.** After a 500 or a network error, the retry is sent without checking the hold. Probe: call `a` got a 500, call `b` then got a 429 (hold until +60 s), and `a` was re-sent at +0.7 s.
- **A 429 received by a caller without the choice records no hold** (:772-790: only the leave-out branch calls `holdHost`). Probe: Bulk's request is answered 429 / Retry-After 60, and while Bulk sleeps out that minute an attach asks the same host at once.

R556 (2) ii says "not asked again before the time it named … for every file". This was not so before the change either, but (ii) now requires it.

Mend:
- Re-check the hold after `hold()` and after `throttle()`, immediately before `request()`, and before each retry. A leave-out call then settles as left out. A waiting caller waits.
- Record the hold from any caller's 429, or from a 503 with a wait.
- Add a test that counts requests with two leave-out calls in flight to Crossref.

**I2. R556 (2) v: Bulk Import, Zotero and Find ARE changed when an attach has left a hold. They are slower, and for a hold over 60 s they still send before the time the service named.**
`http.ts:712-717` and `:751` (`awaitHold` before every attempt), together with `:310` (a hold is never cleared by a 200).

Probes, on the injected clock:
- **A one-hour hold left by an attach.** Five consecutive Bulk requests to Crossref, every one answered 200, were sent at **0, 60, 120, 180, 240 s**. Each request waits 60 s again because the 200 does not lift the hold. So for up to an hour, Bulk Import of 300 files sends at most one request a minute to that host while the service is answering normally. Bulk is up to an hour slower.
- **The same hold, with the service still answering 429.** One Bulk lookup now waits 7 × 60 s = **420 s**; the requests go at 60, 180, 300 and 420 s. At db8623b, with the same 429 received by Bulk itself, it waited 3 × 60 s = 180 s (requests at 0, 60, 120, 180).
- In both cases the request is still sent **before** the hour the service named.

So the new behaviour is neither unchanged (v) nor R411 for holds longer than 60 s. No more items fail: the number of tries is the same, so a Bulk item fails exactly as before. Find's lookups are bounded by `FIND_LOOKUP_TIMEOUT_MS` (240 s, `find/runner.ts:138`); up to 4 × 60 s of hold waits can now use that bound up, so Find can time out where at db8623b it got an answer (by reading).

The report names this as uncertain (§8). It needs a ruling. Option 1: callers without the choice ignore attach holds, which is truly "unchanged". Option 2: they honour the whole hold, which is R411 in full but changes Bulk. In either case a 200 from the host should clear its hold.

### Minor

- **M1. Odd Retry-After values on a 429.** (`http.ts:890-896`, the existing `retryAfterMs`, now used for the hold.)
  - `-5` and junk such as `x 7` are read by `Date.parse` as past dates, so the hold is **0** where the "no time named" minute was meant.
  - `0` and a past HTTP date also give a hold of 0, yet the file is still left out and shown as "Waiting…" although the service said "ask now". The next file asks again at once.
  - Correct values held as expected: `30` gave 30 s; a 2099 date and `86400` were cut to 1 h, which is R411 (b) ("a longer wish is cut to the hour"); `1e3` and unparsable text gave 60 s; a 503 with RA 120 or a date was honoured; a 503 without a wait took today's retry path.
- **M2. One service asks to wait and another FAILS outright.** Probes: Crossref 429 with OpenAlex 500, and the reverse. The outcome reads only "Waiting for lookup service response."; the failure is not said. The failed lookups are not in `leftOut`, so (c) will not retry them. The failure path's own back-off is kept (3.5 s per failed request, as today, (vi)). The sentence is not untrue, since a service did ask to wait.
- **M3. `leftOut` keeps one `notBefore` per lookup, the latest of its services** (`lookup/index.ts:422-425`). Each service's own time and host are lost. This is conservative and harmless for (c); (c) can map service to host itself.
- **M4. The hold lives only in memory** (`apps/library-service/src/state.ts:726`, one client per open library). Close and reopen the library, attach again within the minute, and **one request per held host goes out before the time named**. The next 429 then re-sets the hold. The new client does not seed its holds from the `notBefore` already written in the review entries. R556 (ii) accepts "in memory", and the report says so (§2).
- **M5. The changed closing tests detect "asked" by polling** (`while (count()===0) await setTimeout(5)` in `attach-closing.test.ts` and `close-during-attach.test.ts`; `until(...)` in `watch-closing`). That is a poll, not the true resting state the rules ask for. Some doc comments became overlong run-on lines, for example `close-during-attach.test.ts:3-5`.
- **M6. A likely duplicate keeps its own sentence on the "Attached files" line.** The researcher reads "Stored; it needs review: This may be a duplicate of a source already in the project, so it is in the review queue." The waiting sentence is second under "Why it needs review", and `leftOut` is still written (`import/common.ts:137-153`). Judged by reading: my probes could not produce a fuzzy duplicate, because the embedded metadata has no year.
- **Outside this change (noted only).** In an encrypted project the source's folder name, for example "2021 Okafor - Rivers and Memory…", and `manifest.json` hold the title in the clear. This is the same with no 429 (404 answers), so it was there before.

## The points

| # | point | verdict | note |
|---|---|---|---|
| 1 | R411 never sooner | **does not hold** (partly) | One caller in sequence: holds (one file with a DOI, then the title search: 2 requests, the later lookups left out unsent; 12 files in a watched folder: 1 request). Concurrent calls, retries and a non-option 429: broken (I1). Holds over 60 s for Bulk and Find: sent before the time (I2). Per host: OpenAlex's DOI lookup and title search share one hold, which is reasonable. The cap at an hour matches R411 (b). Close and reopen: one early request (M4). |
| 2 | stored at once, sentence true | holds | No long waits in any "asks to wait" mix. Waiting plus a failure shows "Waiting…" (M2). One service waits and another confirms: `created`, nothing shown, the same as db8623b when one service failed; the `leftOut` dropped then is for a lookup another service answered, so nothing is lost. Likely duplicate: M6. |
| 3 | R55 | holds | Two different PDFs with the same unconfirmed DOI were not matched (no `duplicateOf`). The DOI is in no file except the review file, plain project. Encrypted project: the review line is sealed, none of the DOI, `leftOut`, `notBefore` or the sentence is in the clear, and it is unreadable without the key. Debug lines name only the service. |
| 4 | older build 2d12ab1 end to end | holds (by reading) | `parseReviewFile` checks only id and project. The service's `entryOut` (`routes/review.ts:39-64`) picks named fields, so `leftOut` never reaches the page. The page casts the response (`ui/api/import.ts:380`) and has no runtime schema. The row shows `reasons[0]` as text and "Why it needs review" lists all reasons through `UserText`. Every decision rewrites through `{...entry,…}` (`bulk/review.ts:214`); remove/undo spread too. Rebuild: 0 lines skipped. Incomplete-lines check: line-level only. No CLI package exists; exports do not read the queue. |
| 5 | the sentence | holds | Declared once (`shared/api/sources.ts`), used by the library as `ITEM_REASONS.waiting`. Exact text tested in the engine, service and UI. The Attached files line and the queue item go through `UserText`. It appears also on the watched folder's `imported` event and in the index's cached reasons; it is true wherever it is shown, with the caveat of M2. |
| 6 | not changed | partly | Three closing tests changed. Each still proves cancel, nothing written, count 1 (re-run: pass). Bulk's close-during-429 part is unchanged (pass). Bulk, Zotero and Find tests: bulk.test 103, bulk-closing, bulk-asked-to-wait, search 120, free-copy 80, zotero-web 92, lookup 39, http-closing all pass. Behaviour is changed under an attach's hold (I2). |
| 7 | watched folders | holds | Twelve files while OpenAlex asks to wait: 12 × needs-review "Waiting…", **1** request, no waits. Across two projects: I1. |
| 8 | enough for (c) | holds, with small gaps | Services, the identifier (`doi:`/`isbn:`/`arxiv:` as the hints are written) or the title and creator, and an ISO `notBefore`. `notBefore` is from the machine's clock, so a move to another machine only shifts a "not before"; harmless. Gaps: per-service times (M3); lookups that failed outright (M2); the project rules in force at the time (the report says so). No format change is foreseen. |
| 9 | tests bite | holds | The three planted faults each failed tests and were restored. (1) Hold not recorded: 2 tests in http-leave-out and 2 in attach-asked-to-wait failed. (2) Watched folder not passing the choice (`deps.readable ? c : …`): the watched-folder test failed. (3) Constant without its final ".": the engine, UI and service tests failed. The new tests count requests and use the injected clock. There is no test of two calls in flight (I1). |

## What I could not judge
- The likely-duplicate outcome with a left-out lookup, by probe (judged by reading, M6).
- The page in the real older build: judged by reading 2d12ab1's route, API client and screen; no Chromium run.
- Real network timing. The concurrency case was shown with 20–50 ms stand-in delays.

## Verdict
**Not approved.** I1 (R411 under concurrency, in retries, and for a 429 that a caller without the choice receives) must be mended and tested. I2 needs the coordinator's or owner's ruling: either "unchanged" or "never sooner" for Bulk, Zotero and Find, and a 200 should clear a hold. Then a scoped re-look.
