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
