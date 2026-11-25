# Decision 31 (c), "Look up again": adversarial review of the SERVICE and the PAGE

Branch `d31c-service-page`, worktree `kg-5`, head 8ce0311. Diff reviewed: `89a97d2..HEAD -- apps packages/shared packages/ui e2e`. The engine (`look-again.ts`, `look-up-state.ts`) was used as the specification and was not reviewed again.

Every probe ran in a throwaway copy of `look-up-again.test.ts` (same harness: `MockAgent` with `disableNetConnect`, no public host). The copy has been deleted. Mutants were made by copying the file aside, editing, running and restoring. `git status --short` is empty.

**Verdict: NOT APPROVED.** There is no Critical finding. There are three Important findings and seven Minor ones.

---

## Important

### I1. The service's hold is lost at every reopen, so a service is asked again inside the time it named (R566 5, R411, R556 ii; choice 31c-3)

**Sequence (probe A1).**
1. Three waiting entries. The opening pass sends entry 1. OpenAlex answers 429 with `Retry-After: 3600`.
2. Entries 2 and 3 are left out without anything being written, because they are held.
3. The library is closed and opened again one minute later. The session gets a new lookup client, with nothing held.
4. The opening pass **sends entry 2** to OpenAlex. Another reopen a minute later **sends entry 3**.
5. Between the reopens, the queue listed entry 3 as `{"state":"waiting","tries":0,"canLookUpNow":true}`. The button is therefore ready, and a press sends to OpenAlex within the hour it asked for.

**What happens.** Each opening (and each app restart) within the named time sends one request per service that asked to wait.

**What should happen.** Nothing is sent to that service until its time. The design's claim ("after a restart the in-memory hold is lost, and the `notBefore` kept on the entry covers it", design §Politeness) holds only for entries that were themselves tried. Entries that the hold skipped carry their older, already-passed time.

**Where.**
- `apps/library-service/src/state.ts:992-999`: the pass at `activate` runs with a fresh client.
- `state.ts:2049`: the press.
- `routes/review.ts:65`: `lookUpOut` says "ready".

**Smallest mend.** At `activate` (and at an unlock), before the pass:
1. Read each unlocked project's pending entries once.
2. For each service, take the latest *kept* `notBefore` (`keptNotBefore`, which keeps the wrong-clock rule) among unanswered asked-to-wait lookups.
3. Set the session client's hold for that host to it, capped at `MAX_HOLD_MS`. This needs a small `holdUntil(host, t)` setter on `HttpClient`.

The engine's existing held-service logic then covers the pass and the press alike. For the press it answers "not yet" with the hold's time, which is already handled. The same mend closes an edge in the engine: a lookup that failed outright, on a service that a sibling lookup says to wait for, is askable by hand after a restart.

**Test.** Probe A1 as a test: three entries, a 429 with one hour, reopen after a minute, and 0 requests expected.

### I2. Locking a project during a look-up leaves the late answer in memory, against R30 and R50

**Sequence (probe A3).**
1. An encrypted project with two waiting entries. It is reopened past the first wait and unlocked, and the unlock's pass sends entry 1.
2. OpenAlex's answer is delayed by 1.5 s. Meanwhile `POST /projects/:id/lock` returns 200.
3. The answer arrives. The write is refused (review file byte-identical, which is right) and entry 2 is not sent (right).
4. After `idle()`, **1 sensitive answer is in the session client's memory cache**.

**Why.** The lock route calls `s.http.purgeSensitive()` (`routes/projects.ts:183`) before the in-flight answer lands, and the client then `remember`s that answer as sensitive.

**What should happen.** "Nothing looked up for an encrypted project stays in memory once it is locked" (the route's own comment, R30). The lock route stops Find for an encrypted project before its key goes (`:172`). It does nothing for a look-up again.

**Where.**
- `routes/projects.ts:170-190`.
- `state.ts:2063-2076` (`lookUpInTurn`).

**Smallest mend.** In `lookUpInTurn`'s `finally` (it serves both the pass and the press): if the entry's project is encrypted and no longer unlocked, call `s.http.purgeSensitive()`. That is one line, and the session is reachable as `this.session`.

The same race very likely exists for an attach that is in flight at a lock. That is older than this work and outside this review, but worth listing.

**Test.** Probe A3 as a test.

### I3. A lookup that failed outright is never said once it is in a mix or the entry has matches; after a mix, the page says something untrue (R595, R566 8, R577)

**Sequence (probe R595).**
1. An entry with two left-out lookups: A (asked to wait, title search) and B (failed outright, a different title).
2. Before the press, the queue lists `state: "waiting", canLookUpNow: true`. The reasons are "Waiting for lookup service response." and "The item could not be identified with enough confidence." Nothing says that a service could not be reached.
3. The researcher presses. A is answered with no results, and B fails again (HTTP 500, 4 attempts).
4. The route answers `{kind:"nothing"}`. The entry has `lookUp: {state:"nothing", canLookUpNow:true}` and the reasons "**The lookup service has now answered, but it found no match for this item.**" and "The item could not be identified…".

**What the page then shows.**
- The polite region says that "nothing" sentence.
- Under the empty list of matches it says "**No candidate matches were found.**" (`ReviewQueue.tsx:2375`).
- A ready "Look up again" button is offered with no sentence saying why.

One lookup was never answered, so "found no match for this item" and "No candidate matches were found." are untrue in part. That is exactly R566 (8)'s trap.

**Also: a pure "failed" state where the entry has matches** (from the attach's other lookups) shows no sentence at all. `ReviewQueue.tsx:2374` shows the failed sentence only when `empty`. The page's own first test uses that state (`ReviewQueue.lookUp.test.tsx:92`) without noticing.

**Smallest mend, with no engine change.**
1. In `lookUpOut` (`routes/review.ts:65`), add `failed: true` when some `leftOut` item has `why === "failed"` and no outcome.
2. Add the field to `ReviewLookUp` in shared.
3. The page shows `LOOK_UP_AGAIN_TEXT.notLookedUpFailed` under the matches whenever it is set, whatever the main state and whether or not matches are listed. In that case it does not show "No candidate matches were found."
4. The polite region adds that sentence after the state's sentence(s).

**Tests.** The probe's sequence at the service, and the page with `{state:"nothing", failed:true}`, with and without candidates.

---

## Minor (7)

**m1. A double press sends two sets of requests when the look-up turn is busy.**
- Sequence (probe B1): the pass holds the turn on entry 1. Two presses for entry 2 (failed lookup, service answering 500) arrive 50 ms apart. Both are queued, both run, and both answer `failed`. Entry 2 got 8 requests, where 4 is right.
- Cause: `lookUpRunning` is set only when a turn *starts* (`state.ts:2066`), so a second press queued behind the first is not seen as under way. For a found, nothing or asked-to-wait first press, the second answers "nothing to look up" or "not yet". The double send happens only when the first press fails again.
- Mend: mark the key at enqueue in `lookUpAgainByHand` (a `queued` set checked with `lookUpRunning`).
- One screen cannot do this (`busyRef`); two windows can.

**m2. A press waits behind the pass's current entry for as long as that entry takes.**
- Probe B2: the press was not answered while the pass's request was held, and it went through on release.
- One entry's look-up can take minutes: per request, up to `attemptTimeoutMs` of 60 s, 3 retries, several services and several lookups.
- Meanwhile the page shows "Looking this up again…", and **every decision on the screen is disabled**, because `busy` covers the whole screen and not just the entry as the report says.
- Mend: give the researcher's turn priority over the pass's next entry, or at least keep `busy` to the entry.

**m3. The "under way" re-reading.**
- After the 30th re-read (`ReviewQueue.tsx:820-836`) nothing is said, and the button comes back ready with nothing explaining it. The whole screen was busy for up to 30 s.
- The "changed" test compares the entry's whole JSON, so `canLookUpNow` flipping only because time passed counts as "answered", and the polite region then says the old state's sentence while the pass is still at work.
- Mend: compare `reasons`, `candidates` and `lookUp.state` only. Whether something should be said after the 30th re-read needs a sentence ruled; I propose none, and leave the button as it is.

**m4. Refusals and "not yet" read the whole project's queue with titles.**
- `routes/review.ts:233` calls `listProjectReview(projectId, {})` when `!r.done`. That is every entry's source read, including decryption: about 500 reads per "not yet" press in a queue of 500.
- Mend: read the entry's `sourceId` from `projectReviewEntries` first and pass it.

**m5. The button's time format.**
- `ReviewQueue.tsx:258` uses the browser's locale (`undefined`), while the same screen's dates use `"en"` (`:250`). In a non-English locale the label mixes languages, for example "Look up again (after 25 nov. 2026, 14:00)".
- The time zone (the researcher's own) and the date part (right across midnight) are fine. A time already passed shows "Look up again", ready.

**m6. The pass's bound counts entries where nothing was sent.**
- `not-due` (every service held) counts toward the 20 (`state.ts:2031-2033`). A pass whose 20 oldest entries are all held on Crossref does nothing, while later entries that need only OpenAlex wait for the next pass.
- `lookUpPassAgain` (`:1986`) runs a second full pass straight after the first when an unlock or the timer comes during one, so up to 40 entries go at once.
- Mend: count only results with `sent > 0` (or `done`), and keep the overall bound.

**m7. Tests missing.**
- Service:
  - lock during a look-up (I2);
  - reopen within the hold (I1);
  - double press while the turn is busy (m1);
  - a failed lookup in a mix (I3);
  - a timer or unlock during a pass (the "again" loop);
  - an old session's pass when the library is reopened.
- Page:
  - a press answered 409 LIBRARY_CLOSED, 409 CONFLICT, or by a network failure (the code handles them: `ReviewQueue.tsx:799-803`, untested);
  - running out the 30 re-reads.

---

## What held under probes and reading

**The pass.**
- It starts at `activate` (read-write only, not awaited), at an unlock, and on a 10-minute `unref`'d timer that is stopped at close and at quiesce.
- One pass at a time, and entries one after another.
- `stop()` sees `this.session !== s`, so a pass of a closed session stops.
- `beginClosing`: 0 requests and the folder byte-identical (existing test).
- A request in the air at close is cut: review file unchanged, no warning logged (existing test).
- Read-only: nothing is sent. Locked: skipped without reading. Rules deny: nothing sent, and the ruled sentence is in the reasons.
- A failed lookup is never taken automatically (choice 31c-4, tested).
- Logs carry `describe(err)` only. Audit lines carry ids, service names and counts (the engine's).

**Request counts (A).**
- Against a service that keeps answering 429 **with** `Retry-After`: **one request per pass per service** at most, and 0 while the client's hold lasts (existing test, and probe A2 at the pass after 10 minutes).
- Against 429 **without** `Retry-After` (a 60 s hold): one request per pass (every 10 minutes). Probe A2: 30 waiting entries gave **1** request at the opening.
- With 500 entries the per-pass bound is the same. Each entry has at most 5 automatic tries.
- **Exception, I1: +1 request per service at every reopen or restart inside the named time.**
- A healthy service: at most 20 entries per pass, times their lookups and services, or 40 if a pass is asked again during one (m6).

**The route.**
- Every outcome and refusal in the builders' table was checked by reading against the engine's values. The `switch` statements are exhaustive (`unknownValue: never`).
- "Not yet" sends nothing and audits nothing (tested). "Under way" sends nothing (tested, and the mutant removing the guard fails the test).
- Locked gives 423 before anything is read. Read-only gives 409. Closed gives 409 `LIBRARY_CLOSED` with `LIBRARY_CLOSED_TEXT`. A foreign project gives 400. Missing gives 404. Decided gives 409 CONFLICT.
- The entry is named by id, and the engine's results by position in `leftOut`.

**The field.**
- `lookUp` is absent when nothing was left out.
- `canLookUpNow` and `notBefore` come only from `lookUpNow`. The only other comparison is the page's "turn ready when the time comes" (`ReviewQueue.tsx:2433`), which is not a second rule.
- No title or identifier (tested).
- No event tells other open screens about a look-up. Neither the pass nor the route publishes a review change. Only the pressing screen refreshes its entry, and an open queue learns of the pass's new matches only at its next reload or press. The count does not change, so nothing else is stale. (Not listed as a finding: the queue screen never listened for review events.)

**Accepting after a look-up.**
- It is the existing accept, by position. Candidates are only appended, so a match that arrives while the researcher looks at the list cannot move one that is shown. The page keeps its own copy until the press answers (tested: the third match is accepted as `index: 2`).

**The existing behaviour.**
- Attach (b), Bulk Import, Zotero and Find are untouched by this diff.
- The review queue's other tests pass.

---

## D. The sentences (R577, word for word)

Each sentence was compared character by character with `packages/shared/src/api/sources.ts:159,168-189`. All are identical to R577.

| Sentence | Where shown | State that shows it | True? |
|---|---|---|---|
| "Waiting for lookup service response." | reasons (engine); polite region | waiting (main or `also`) | yes |
| "Not looked up yet: the lookup service asked to wait." | under the matches | waiting or gave-up, no candidates | yes |
| "Looking this up again…" | button label | press under way; "under way" re-reads | yes (not itself announced) |
| "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one." | reasons; polite region | found (main or `also`) | yes |
| "The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first." | reasons only | `fromFile` | yes (per entry, not per match: the engine's limit) |
| "The lookup service has now answered, but it found no match for this item." | reasons; polite region | nothing | **partly untrue in a mix with a failed lookup (I3)** |
| "This project's rules no longer allow this lookup, so it was not looked up again." | reasons; polite region | not-allowed | yes; no sentence under the matches (builders' Uncertain; acceptable) |
| "The lookup service asked to wait each time it was tried ({n} tries), so the app has stopped trying by itself. You can still use Look up again." | reasons; polite region | gave-up; {n} = `tries` or `gaveUpTries` | yes |
| "Look up again" | button | ready | yes |
| "Look up again (after {time})" | button; polite region on "not yet" | off before the time | yes (format: m5) |
| "Not looked up: a lookup service could not be reached. You can use Look up again." | under the matches; polite region | state "failed" **and no candidates** only | **missing when matches are listed, and in every mix (I3)** |
| "No candidate matches were found." (existing) | under the matches | no `lookUp`, nothing, or found, with no candidates | **untrue when a failed lookup is still left (I3)** |

States with no sentence:
- "failed" with candidates (I3).
- not-allowed with no candidates (accepted).
- the end of the 30 re-reads (m3).

The mix order: the polite region gives the main state first, while the reasons follow the engine's order. That was ruled as built (R592 point 4).

Focus after the answer stays on the button. If the button has gone, focus goes to the "Candidate matches" heading, but only when focus had fallen to the body. The result is announced once: `setStatus` keeps only messages not yet shown.

## R595, answered

In a mix that contains a lookup that failed outright, the ruled sentence is **never shown**:
- **Before a look-up:** the researcher sees the other state's sentence(s), for example "Waiting for lookup service response.", plus the attach's own reasons (for example "The item could not be identified with enough confidence."). Nothing says that a service could not be reached.
- **The button:** it is offered (`canLookUpNow: true`, because the failed lookup has no time to wait for).
- **After the other lookups are answered:** the failed one's sentence still does not appear, because the state is "nothing" or "found", never "failed". The page then says "The lookup service has now answered, but it found no match for this item." and "No candidate matches were found." That is untrue in part.
- **When the entry has matches:** even a pure "failed" state shows no sentence.

The mend is I3.

## E. The four choices

| Choice | Built as stated? | To switch later |
|---|---|---|
| 31c-1 automatic and by hand | Yes: `startLookUpAgain` at opening, unlock and timer, plus the route. | By hand only: make `startLookUpAgain` return at once (one line, `state.ts:1974`). |
| 31c-2 never fills a record | Yes: the only writes are the engine's review-entry change (candidates appended, `leftOut`, reasons). Neither the service nor the page has a path to `source.json` except the existing accept. | Auto-fill would need a new governed accept path in the engine: not a one-liner. |
| 31c-3 the button waits for the time | Yes in one session: "not yet" sends nothing (tested), and the button is `aria-disabled` with its time. **Broken across a reopen or restart (I1).** | "At once" (R411 b): `askableByHand` ignores `notBefore` for the researcher, and the page drops the off state (two small edits). |
| 31c-4 failed lookups by hand only | Yes: `dueAutomatically` skips `why: "failed"` (tested: 0 requests). A press asks them at once (tested). | Retry automatically: remove the `isAskedToWait` test in `dueAutomatically` (one line). |

## F. Tests run (each alone, `nice -n 10`)

**Service:**
- `look-up-again.test.ts`: 27/27
- `review-queue.test.ts`: 23/23
- `open-library.test.ts`: 26/26
- `close-during-attach.test.ts`: 13/13

**Page:**
- `ReviewQueue.lookUp.test.tsx`: 19/19
- `ReviewQueue.look.test.tsx`: 18/18
- `ReviewQueue.test.tsx`: 125/125

**Typecheck:** `pnpm -r typecheck`: all nine packages Done.

**Mutants (each restored):**
- Removing `state.startLookUpAgain()` from the unlock route makes the unlock test fail, as it should.
- Removing the "under way" guard in `lookUpAgainByHand` makes the point 5 test fail, as it should.

**Probes:**
- A1 restart hold: confirms I1.
- A2 count against 429: 1 per opening.
- A3 lock mid-request: confirms I2.
- B1 double press: confirms m1.
- B2 press behind the pass: confirms m2.
- R595 mix: confirms I3.

All probes were deleted. `git status --short` is empty, and no process was left running.

## Verdict

**NOT APPROVED.** The fix round is I1 to I3. m1 and m3 are worth taking with it, and the rest can be listed.

---

# Second look (R606)

Head 5a53b73: ten commits after 8ce0311. I read the builder's section "Fix round (R600)", rulings R600 and R606, and the diff `8ce0311..HEAD`.

My probes ran again in throwaway copies of `look-up-again.test.ts`, with the same harness and no public host. The copies are deleted. The timing mutant was made by copying the file aside, editing it, running, and restoring it. `git status --short` is empty, and no process of mine is left running.

**Verdict: APPROVED WITH SMALL POINTS.** Every finding of the first review is closed. Three new Minor points, none Critical or Important.

## The first review's findings

| Finding | Closed? | Evidence |
|---|---|---|
| I1 the hold over a reopening | **closed** | Probe A1, again: a 429 for one hour, then three reopenings a minute apart. Requests: 1, 0, 0, 0 (before the fix: 1, 1, 1). After them, the queue lists all three entries `canLookUpNow:false` with one time. A press answers `not-yet` with that same time and sends 0. An attach after the reopening goes to review with "Waiting for lookup service response." and sends 0. Code: `state.ts:2019` `carryLookUpHolds`, `:1009`, awaited in `adopt` at `:787`, in the pass at `:1998`, in a press at `:2104`; unlock at `routes/projects.ts:166`. |
| I2 a lock during a look-up | **closed** | Probe A3, again: 1 request in the air during the lock. Sensitive answers left in memory: **0** (before: 1). Code: `state.ts:2138`. |
| I3 a failed lookup always said | **closed** (one stale case is a new point: n1) | Probe R595, again: after the press (one lookup nothing, one failed again) the entry carries `lookUp:{state:"nothing", canLookUpNow:true, failed:true}`. Page `ReviewQueue.tsx:2389-2390`: the failed sentence is shown and "No candidate matches were found." is not. Before the press: `{state:"waiting", failed:true}`. |
| m1 double press | **closed** | Probe B1, again: the first press answers `failed`, the second `under-way`. Entry 2 got **4** requests (before: 8). Code: `state.ts:2107`. |
| m2 busy | **closed** as ruled | The page's busy state is per entry (`ReviewQueue.tsx:1331`). A press goes before the pass's next entry. The wait behind the pass's current entry is accepted and listed. |
| m3 re-reads | **closed** | Only `reasons`, `candidates` and `lookUp.state` are compared. After the 30th re-read the entry as last read is shown, and nothing is said. Page tests cover both. |
| m4 | **closed** | The optional `sourceId`, then that source only. |
| m5 | **closed** | `ReviewQueue.tsx:258` uses "en". |
| m6 | **closed** | Only `sent > 0` is counted (`state.ts:2086`). A tick during a pass is dropped. An unlock during a pass gets a pass of its own project only. Side effect: n3 below. |
| m7 | **closed** | The tests asked for are present: service 37 tests, page 31 tests. |

## I1 in depth

**(a) What feeds the carried hold.** Only lookups that are asked to wait and not answered feed it. Failed lookups, "found" and "nothing" are skipped. The kept time goes through the engine's `keptNotBefore`, so:
- a wrong clock's time (more than an hour ahead) is ignored;
- a time already passed is skipped.

The rest, by case:
- **Several projects naming different times for one service:** the latest is kept. Probe I1b: the plain project's 40 minutes was carried at opening, past the encrypted project's 20.
- **A locked project at opening:** it is not read. At its unlock its times are added (`carryLookUpHolds(s, [id])`).
- **Can an unlock shorten or lose a hold?** No. `holdUntil` takes the larger of the two times (`http.ts:451`), and probe I1b gave the same hold before and after the unlock.
- **Inherent limit:** while a project is locked, its own times are not known. An attach into *another* project can therefore ask that service before the locked project's time. The queue is sealed, so nothing better is possible. Noted only.

**(b) `holdUntil`** (`packages/library/src/lookup/http.ts:448`):
- It is capped at the client's `MAX_HOLD_MS` from now.
- It never shortens a hold.
- A time already passed holds nothing.
- It writes the same `notBefore` map as an ordinary hold, so a 2xx from the host clears it (`:794`).

**Does a 2xx from an attach clear it?** An attach cannot get one while the host is held, because it uses `leave-out` and sends nothing. Only a caller *without* that option (Bulk Import, Find, Zotero) can get a 2xx then, and it clears the carried hold exactly as it clears an ordinary hold (R563 I2: the service is answering again). After that:
- Entries the hold had skipped become askable and due.
- Entries that were themselves tried keep their own kept time.

That is right.

**Unchanged for Bulk Import, Zotero and Find.** They never look at or wait for a hold. A call without `leave-out` does not read the map (`http.ts:765,776`). `holdUntil` changes nothing for them.

**(c) R606: what the opening's wait costs.** Each figure is three openings, warm.

| Waiting entries | `POST /libraries/open` (ms) | `carryLookUpHolds` alone (ms) |
|---|---|---|
| 0 | 26 / 14 / 13 | 0 |
| 50 | 45 / 33 / 43 | 10 / 8 / 8 |
| 500 | 227 / 178 / 200 | 80 / 76 / 78 |

**An encrypted project.** It is locked at opening, so the opening does not read it. The cost moves to its unlock, which waits for the carrying.

| Unlock of an encrypted project with … | Unlock (ms) | Carrying alone (ms) |
|---|---|---|
| 1 waiting entry | 360 / 357 | 1 |
| 300 waiting entries | 793 / 768 | 83 / 72 |
| 300 waiting entries, with the carrying's `await` removed in a copy | 678 / 670 | — |

So the carrying costs about 100 ms at 300 encrypted entries. The rest of the unlock's growth comes from other unlock work.

**Verdict on R606: not felt.** It is under about 100 ms at 500 plain entries and about 100 ms at 300 encrypted ones. Exporting the plain reader is not needed. If it is ever wanted, the smallest mend is to export `projectReviewEntries` and use it in `carryLookUpHolds`; it needs no titles.

**The opening should keep waiting.** An attach (or a watched folder's bring-in, see n2) or a press in the gap would send to a held service before its time, which is exactly I1. Waiting only in the pass, a press and an attach would need the attach to await `s.holdsCarried` too. The cost does not justify that.

**(d) One place for "now" and its time.** Yes: `lookUpOut` (`routes/review.ts:79`), which reads `lookUpNow` and the client's holds. The page compares only to turn ready when the time comes.

A press can disagree with it in two cases, both harmless:
1. A lookup whose allowed services are all held, while a service the rules deny is not held. The field says "now", and the press answers `not-yet` with the hold's time, which the page shows (builder's Uncertain 2).
2. Every askable lookup held, plus a lookup the rules now refuse. The field says "not now", while a press would write "not allowed" and send nothing.

Nothing is sent early in either case.

## I3: what the page says with `failed: true`, word for word against R577

Under the matches, whatever the main state, with or without matches: "Not looked up: a lookup service could not be reached. You can use Look up again." It is never beside "No candidate matches were found.".

What else is shown, by main state:
- **waiting, no matches:** "Not looked up yet: the lookup service asked to wait." is shown as well. Both are true, and they are different sentences.
- **nothing:** the reasons say "The lookup service has now answered, but it found no match for this item." That is true of the lookup that answered, and the failed sentence stands beside it, so the earlier untrue pair is gone.
- **found:** the reasons carry the found sentence, and the matches are listed with the failed sentence below them.
- **failed:** that sentence only. In the announcement, "failed" plus `failed:true` is deduplicated by the `Set` (`ReviewQueue.tsx:274`), so it is said once.

The announcement is the state's sentence or sentences, then the failed sentence, each once. Every word matches `packages/shared/src/api/sources.ts`, which is R577.

## New points (all Minor)

**n1. "Could not be reached" stays after the rules refuse that lookup.**
- Sequence (probe R595, continued):
  1. One lookup answered nothing; the other failed again.
  2. The project's rules are changed to allow no lookup.
  3. A press answers `{kind:"not-allowed"}`.
- The engine keeps the lookup's `why:"failed"` and adds `outcome:"not-allowed"`. The field stays `failed:true` (`routes/review.ts:106` excludes only found and nothing), so the page says, for that same lookup:
  - "This project's rules no longer allow this lookup, so it was not looked up again." (true);
  - "Not looked up: a lookup service could not be reached. You can use Look up again." (stale: its last attempt was refused by the rules, not unreachable).
- Mend: `failed` only when `l.why === "failed" && !l.outcome` (one condition).

**n2. A watched folder's bring-in at opening can start before the holds are carried.**
- `activate` starts the watches (`state.ts:998`) before `s.holdsCarried` (`:1009`). A bring-in uses `leave-out` and does not await it.
- A file waiting in a watched folder at opening could therefore ask a held service within its time. In practice the watch's stability wait likely makes it lose the race, but nothing guarantees that. Not probed: a timing race.
- Mend: the bring-in, or `startProjectsWatches`, awaits `s.holdsCarried` (one line), or `holdsCarried` is set before the watches start and awaited by them.

**n3. A pass against a held service walks every due entry, each reading the whole queue.**
- m6 counts only entries for which something was sent. While a service holds, every due entry is tried, and each `lookUpAgain` re-reads the project's whole queue before answering `not-due`.
- Probe P, 500 entries, OpenAlex held for an hour:
  - opening pass: 1 760 ms, 1 request;
  - next timer pass: **959 ms of work, 0 requests, 0 taken**.
- Quadratic in the queue's size, every ten minutes while a hold lasts. A press waits behind at most one entry.
- Mend: before taking an entry, skip it in the pass when every service of every due lookup is held. That is the same `heldBy` check `lookUpOut` makes, with no queue read. Alternatively, keep a bound on entries tried as well as on entries sent (for example 100).

## Runs (each alone, `nice -n 10`)

**library:**
- http-leave-out 33/33
- http-closing 7/7
- look-again 34/34
- look-up-state 20/20
- attach-asked-to-wait 12/12

**service:**
- look-up-again 37/37
- review-queue 23/23
- open-library 26/26
- close-during-attach 13/13
- lock-during-change 3/3
- server (includes lock and unlock) 160 passed, 1 skipped

**page:**
- ReviewQueue.lookUp 31/31
- ReviewQueue.look 18/18
- ReviewQueue 125/125

**typecheck:** `pnpm -r typecheck`: 9/9 Done.

## Verdict (second look)

**APPROVED WITH SMALL POINTS.** I1, I2, I3 and m1 to m7 are closed. n1 is a one-condition mend worth making now. n2 and n3 can be made now or listed.
