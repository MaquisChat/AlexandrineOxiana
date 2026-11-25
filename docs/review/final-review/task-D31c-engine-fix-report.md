# Decision 31 (c), "Look up again": the engine fix round (R585). Report

Worktree `.claude/worktrees/kg-4`, branch `d31c-look-up-again`, from 2e3a471 to **e62d244** (8 commits, one per finding; not pushed). Status: **BUILT**: I1, I2, M1, M2, M3, M6, M7 and M8, plus the coordinator's addition `lookUpNow`. M4 and M5 were not touched. The attach, Bulk Import, Find and R577's words are unchanged. `git status --short` is empty, and no process is left running.

## 0. Additions that the service and the page use (nothing was renamed or removed)

**1. `LookUpAgainRefusal` gains `"under-way"`** (`import/look-again.ts:80`).
- The answer is `{ done: false; why: "under-way" }`.
- Meaning: a look-up of the same entry is already running on the same `Repo` handle. This call audited nothing, sent nothing and wrote nothing.
- A `switch` over `why` that must be exhaustive needs this new case.
- Suggested route mapping: 409, or "Looking this up again…" (`LOOK_UP_AGAIN_TEXT.looking`).

**2. The `done: true` result gains `sent: number`.** This is how many requests actually left.
- An answer from the client's cache is not counted.
- A request that the client's hold left out is not counted either.

**3. `LookUpView` gains two optional fields** (`import/look-up-state.ts:140-142`).
- `also?: Array<Exclude<LookUpState, "failed">>`: every other state that is true of the entry. It is present only when the entry is in a mix of states.
- `gaveUpTries?: number`: present only when `also` includes `"gave-up"`.
- An entry in a single state gives exactly the same view as before.

**4. New function: `lookUpNow(entry, now)`.** It is exported from `@ao/library` (`look-up-state.ts:76`).

```ts
lookUpNow(entry: { leftOut?: LeftOutLookup[]; status?: string }, now: Date): { canLookUpNow: boolean; notBefore?: string }
```

- It answers whether the researcher's act would send something now. If it would not, `notBefore` is the earliest time at which it would.
- If it would not and there is no `notBefore`, nothing is left to look up, or the entry is not pending.
- `lookUpAgain(by: "researcher")` uses this function for its own "not yet" answer.
- The page should use it instead of comparing `notBefore` with the clock.
- Limit: it knows only the entry. A service that the client still holds in memory can still make `lookUpAgain` answer "not-yet" with the hold's time.

**5. Other new exports from `look-up-state.ts`.** These are not exported from the index: `WRONG_CLOCK_BOUNDS`, `keptNotBefore`, `keptLastTriedAt`, `askableByHand`, `isAnswered`.

**6. The audit lines changed.**

*The send line* (op `review.lookup-again.send`):
- It is now one line per service asked. Previously there was one line for all services.
- Its `details` are `{ op, reviewEntry, by, services: [<that one service>], lookups: <the planned lookups that ask it> }`.
- A service that the rules deny at that moment gets the ordinary deny line, with the same op and `decision.result: "deny"`.

*The outcome line* (op `review.lookup-again`) gains `sent: number`.

**7. Meanings that changed.**
- `tries` now counts only the app's own automatic tries, and only those in which a request left. A researcher's press is never counted.
- `lastTriedAt` moves whenever a request left, whether the try was automatic or by hand.
- `"gave-up"` comes only from automatic tries. A researcher's press that is told to wait leaves a given-up lookup as `"gave-up"`.
- `fromFile` is true whenever a "found" lookup's identifier was one of the file's hints, whatever the state word, for example also with "waiting".
- Each left-out lookup is identified by its index in `leftOut`.
- A service that the rules deny at send time is now answered as "not-allowed". It is no longer thrown as a `PolicyDeniedError`.
- `asked` no longer counts a lookup all of whose services were denied at send time.
- `LookupContext.onSend?` and `GetOptions.onSend?` are new optional callbacks. They are used only by `lookUpAgain`.

## 1. Per finding

### I2: two lookups with the same key (commit 5939839)

**What was wrong.** Lookups were keyed by what they look up. An attach where Crossref asked to wait and OpenAlex failed gave two items with the same key. Crossref's "found" was then overwritten.

**Test.** `look-again.test.ts:611`, "P-N". It failed first: the state was `nothing`, not `found`.

**Fix.** `Plan.at` holds the lookup's index in `leftOut`, and the change writes `leftOut[p.at]`.

**Every writer of `leftOut` keeps the order and the length:**
- `resolve.ts` builds the list with `push` only.
- `common.ts` `reviewFor` writes the list once.
- `review.ts` `writeReviewLine` copies it as given.
- Every later rewrite spreads the entry: `bulk/review.ts:217`, `bulk/undo.ts:106,109,334`.
- `look-again` writes items by index and nothing else.
- `parseReviewFile` does not touch `leftOut`.

### I1: two look-ups of one entry (commit 501d606)

**Tests:**
- `:652` "P-B": the second call answers "under-way", and the audit, the review file and the requests are unchanged.
- `:676` "P-A": one send line and one request.
- `:696` "(a)": two `Repo` handles of the same library, which bypasses the guard. This worked: `openTestRepo` called twice on the same `lib`.

All three failed first. In (a), the slower look-up wrote "waiting" over "found".

**Fix (a), the re-read.** `settle` (`look-again.ts:244`) works each lookup out against the item as re-read inside the change, at its index:
- An item that was answered "found" or "nothing" meanwhile is left as it is.
- `lastTriedAt` takes the later of the two times.
- Matches are appended once, through the existing de-duplication.

**Fix (b), one look-up at a time.** `underWay` (`:292`, `:302-305`) is a `WeakMap<Repo, Set<projectId+entryId>>`, released in a `finally`.

**Test-helper change.** `holdRequests` "after" now also holds an answer that throws. A 429 with "leave-out" throws, and the old helper never reached its gate.

### M8: put `authorizeOnly` back (commit 42b4895)

`git diff 7d8d861..HEAD -- packages/library/src/repo/mutate.ts packages/library/src/repo/repo.ts` is empty.

**How the send is audited now.** `sendAllowed` (`:382`) audits each service through the unchanged `authorizeOnly` (`authorizeProcessing`), with that service's own request, once per act.
- The audit happens lazily, just before that service's first request.
- `askByService` (`:258`) asks a lookup's services one after another, in chain order, and stops at the first match, as the chain does.
- A `PolicyDeniedError` means the service is not asked. Lookups whose only services were denied get "not-allowed".

**Tests:**
- `:724`: two services give two send lines, each already on disk when its request arrives. The stand-in's reply reads the audit file synchronously.
- `:754`: one service denied gives one allow line, one deny line and one request.

Both failed first.

**Changed test.** Test (9) expected a single send line. It now expects one line per service.

### M2: what was really sent (commit 5d3c5a5)

**Fix.**
- `GetOptions.onSend` is called just before `request()` (`lookup/http.ts:840`).
- It is carried by `LookupContext.onSend` through `requestRules` (`context.ts:60`).
- `askByService` counts the requests per lookup.
- A try is counted only when the count is above 0.
- `details.sent` and the result's `sent` carry the count (`look-again.ts:420,460`).

**Tests.** Both failed first:
- `:785` "P-H": six such look-ups. None ends "gave-up", `tries` and `lastTriedAt` stay absent, and every outcome line says `sent: 0`.
- `:814`: a counted request.

Test (9) now also expects `sent: 2`.

### M1: a wrong clock (commit 7113d66), and `lookUpNow`

**The bounds** are `WRONG_CLOCK_BOUNDS` (`look-up-state.ts:39`):
- `notBefore` may be at most `MAX_HOLD_MS` (1 hour) ahead.
- `lastTriedAt` may be at most the last of `waitsMs` (24 hours) plus 1 hour ahead.

**Where they apply:**
- `dueAutomatically` (`look-again.ts:113`).
- `askableByHand` and `lookUpNow`.
- Every place where a kept time is carried into the new one (`:208`, `:232`, and `laterTry`).

A wrong time is never kept.

**Tests:**
- `:830` "P-D", all three parts. It failed first: "not-yet".
- `:850`: a wait 59 minutes ahead still holds, for R411.
- `:864`: a table of ten entries: waiting, due, wrong clock ahead, less than an hour ahead, failed, two mixes, two waiting, gave-up with its time passed, nothing left. For each, `lookUpNow` and `lookUpAgain(by: "researcher")` agree. It failed first because the function did not exist yet.

### M3: the sentences in mixes, and researcher tries (commit 496889c)

**The sentences.** `lookUpStateOf` (`look-up-state.ts:156`) fills `also`. `lookUpSentences` (`:187`) gives every true sentence, each once, in this order: found, then the warning when the match came from the file, waiting, nothing, not allowed, gave up.

**The state word keeps its precedence:** waiting, then found, then gave-up, nothing, not-allowed. The comment in the code gives the reason:
- An entry with a lookup still waiting is not settled: the automatic pass will take it, and the page's act follows its time.
- "found" comes next because it is the news the researcher acts on.

**Researcher tries.** In `after` (`look-again.ts:204`), only `by: "automatic"` counts a try and can give up.

**Tests.** All failed first:
- `look-up-state.test.ts:125` block: not-allowed + nothing; P-K as a pure case; all five states in order.
- `look-again.test.ts:898` P-K through the act, `:913` P-M, and `:929` a lookup that gave up stays given up after a press.

**Changed tests.** Three tests asserted that a researcher's press counts a try. They now assert that `lastTriedAt` moves and `tries` stays absent:
- "a lookup that failed outright is not taken by the automatic pass…"
- "a failed lookup that fails again…" (renamed)
- "an encrypted project's entry stays sealed…"

The comment on `tries` in `review.ts` was updated.

### M6: the two missing tests (commit 0431709)

**Partial chain.** `:942`: only OpenAlex was left out for a DOI, and Crossref receives 0 requests.
- I planted a fault that ignores the filter, and this test failed under it.
- The entry's partial chain is set through a governed patch. A Crossref answer at the attach would sit in the client's disk cache and hide a request made in error; my first version passed even with the fault for that reason.

**Send before request.** Test (9) now checks, inside the stand-in's reply, that the service's send line is already on disk.

### M7: the older build's proof (commit e62d244)

`olderParse` in `attach-asked-to-wait.test.ts` now covers sealed lines:
- It sits at module level and copies `parseReviewFile` from commit 2d12ab1, `packages/library/src/repo/review.ts` lines 463-479, including the sealed-line branch and the `KeyNotAvailableError` rethrow. The comment names the commit and lines.
- `openLine` is this build's own. `git diff 2d12ab1 HEAD -- packages/library/src/repo/io.ts packages/library/src/crypto` is empty.

**New test `:370`.** It uses an encrypted project and an entry the app gave up on, written through the governed sealing write.
- Both lines are sealed, and none of the plain text appears in them.
- Without the key, both lines are skipped.
- With the key, the entry is read exactly, with the values that build branches on.
- A decision of that build keeps every new field.

This test proves a property that already holds, so it passed when written.

## 2. Runs

Each file was run alone with `nice -n 10`, and every run passed:

| Area | Files (passed/total) |
|---|---|
| import | look-again 32/32 · look-up-state 20/20 · attach-asked-to-wait 12/12 · attach-closing 5/5 · attach 69/69 · common 2/2 · resolve-titles 24/24 |
| lookup | http-closing 7/7 · http-keys 18/18 · http-leave-out 31/31 · lookup 39/39 · recorded 21/21 |
| review | repo/review-held.linked 6/6 · repo/review-held 67/67 · review-later-conflict 18/18 · review-resolution 27/27 |
| watch | watch-choices 9/9 · watch-closing 1/1 · watch-local 51/51 · watch-settings 9/9 · watch 143/143 |
| bulk | annotations-plan 9/9 · bulk-asked-to-wait 1/1 · bulk-closing 2/2 · bulk 103/103 · disk-full 14/14 · failure-cause 5/5 · patterns 2/2 · space 15/15 · zotero-conflict 41/41 · zotero-gone 26/26 |
| other callers | transcription-jobs (library) 15/15 · library-service transcription-jobs 40/40 · backup-governed 22/22 · lock-guards 7/7 (authorizeOnly's callers) · find/runner 301/301 (the client changed) |

- `pnpm -r typecheck`: all nine packages Done.
- Not run: `bulk.scale.test.ts` and `watch.scale.test.ts`. They have their own config, and their code paths are unchanged.

## 3. Uncertain, or choices made

1. **The guard is per `Repo` handle**, not per library folder. The service holds one handle per library. A second handle in the same process is not guarded, but the re-read (a) still keeps the result right in that case.
2. **The `lookups` count on a send line is planned, not actual.** It is the number of this act's lookups that would ask that service. One that ends early, because a match was found earlier in its chain, still counts. The outcome line's `sent` says what really left.
3. **A lookup with mixed answers.** One service answered "nothing" and another was denied at send time. The lookup becomes "not-allowed", with the denied services still listed to ask, rather than "nothing", so the researcher's act can ask it again when the rules allow it.
4. **`lookUpNow` cannot see the client's in-memory hold**, as said in §0.4. The table test runs every row with a fresh client.
5. **`lookUpStateOf` still reports a wrong-clock `notBefore` in `view.notBefore`.** The page should take the time for its button from `lookUpNow`.
6. **M7's sealed line** is written through the real governed sealing write with "gave-up" fields set by the test. Writing it through the engine's own five automatic tries was not done, because the attach test file's harness has no movable clock for the repository.
