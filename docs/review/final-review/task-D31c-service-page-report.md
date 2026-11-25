# Decision 31 (c), "Look up again": the service and the page (T3, T4). Report

Branch `d31c-service-page`, worktree `.claude/worktrees/kg-5`, from 2e3a471. Status: **BUILT**. The engine was not changed. Nothing stored was added: the route and the field are answers only.

Commits, in order:
- `80bb960`: the service's automatic pass.
- `1c7036b`: the route and the queue entry's `lookUp` field, with the service tests.
- `4ecddda`: R585 adaptation. The "under way" answer, `tries` documented as automatic tries, audit tests that accept one send line per service.
- `459121f`: the page (button, sentences under the matches), with its tests.

## 1. The pass (`apps/library-service/src/state.ts`)

**Constants:**
- `LOOK_UP_AGAIN_PASS_MAX = 20` (:217).
- `LOOK_UP_AGAIN_CHECK_MS = 10 min`, overridable by the option `lookUpAgainCheckMs` (StateOptions; `server.ts` passes it through).

**When it runs.** `startLookUpAgain()` (:1969) registers the work as `startWork("lookup-again")`. It is called:
- in `activate` after the opening's backup (:992), for read-write libraries only. It is not awaited, so the opening's answer does not wait for it;
- at unlock (`routes/projects.ts:165`);
- by the timer (`startLookUpAgainTimer`, started in `activate` at :999, `unref`'d).

The timer is stopped in `closeLibrary` (:1324) and in `quiesce` (:1227). If `quiesce` rolls back, it calls `activate`, which restarts the timer.

Only one pass runs at a time. A request that arrives while a pass is running (for example an unlock) runs once more when that pass ends.

**Order.** `runLookUpAgain(ctl)` (:1998) goes through each unlocked project:
- It calls `dueLookUps(repo, p, now)`, which lists entries oldest first.
- It then calls `lookUpAgain(..., { by: "automatic", closing: s.closing.signal, now })` for each entry, strictly one after another.
- Look-ups take turns with the researcher's route (`lookUpInTurn`), so two look-ups never run at the same time in this service.

**Cap.** At most 20 entries per pass in total. The next pass (timer, unlock or opening) takes the rest.

**How it stops:**
- It stops before each project and each entry if any of these holds: `ctl.stopping` (a move's drain), `startsHeld`, `shuttingDown`, the closing signal is aborted, or another session is open.
- It stops on the engine results `closing`, `cancelled` and `read-only`.
- On `locked` it skips the rest of that project.
- A policy refusal or other error on one entry is logged, and the pass goes on to the next entry.
- An unknown "not done" result, such as R585's "under way", is skipped.
- A service that asks to wait again is held by the session's lookup client. The engine leaves a held service out without sending, so the rest of the pass sends that service nothing. This is tested.
- A lookup that failed outright is never due (the engine's `dueLookUps`). This is tested.

`idle()` waits for the pass, because `startWork` tracks it.

At a close, `beginClosing` aborts the signal and stops the client. A request in the air is cut, and the engine writes nothing ("cancelled"). This is tested: the review file is byte-identical, the folder is identical from close to settle, and no "lookup-again failed" warning is logged.

## 2. The route `POST /review/:itemId/look-up-again` `{ projectId }` (`routes/review.ts:217`)

It is its own route: `REVIEW_DECISION_ACTIONS` and the `Same<>` checks are untouched. A new check, `Same<LookUpState, ReviewLookUpState>`, was added. The extension token gets 403 "The browser extension cannot use this." from the global check.

| Case | Status | Answer |
|---|---|---|
| found n | 200 | `{ outcome: { kind: "found", found: n }, entry }` |
| nothing | 200 | `{ kind: "nothing" }` |
| not allowed (nothing asked) | 200 | `{ kind: "not-allowed" }` |
| asked to wait again | 200 | `{ kind: "asked-to-wait", notBefore? }` (also used for gave-up) |
| failed again | 200 | `{ kind: "failed" }` |
| not yet | 200 | `{ kind: "not-yet", notBefore }`, with 0 requests sent and nothing audited. `entry.lookUp` is set to `canLookUpNow: false` with that time. |
| nothing left | 200 | `{ kind: "nothing-to-look-up" }` |
| under way, or any unknown "not done" (R585 3) | 200 | `{ kind: "under-way" }` with the entry as it is |
| read-only | 409 | READ_ONLY |
| locked | 423 | PROJECT_LOCKED (checked before anything is read) |
| missing | 404 | NOT_FOUND (the decide route's own `NotFoundError`) |
| decided, source removed, dropped | 409 | CONFLICT "This item has already been reviewed." (the decide route's sentence) |
| closing, cancelled | 409 | LIBRARY_CLOSED with `LIBRARY_CLOSED_TEXT` |
| project not in library | 400 | |
| rules refuse the send | 403 | POLICY_DENIED (the error mapper) |

"Not yet" is 200 because the act was understood and the entry is answered as it stands, like the other answers that are not refusals.

## 3. The field (`entryOut`, `lookUpOut` at `routes/review.ts:64`)

`lookUp?: { state, tries, canLookUpNow, notBefore? }`.
- `state` comes from the engine's `lookUpStateOf`.
- `notBefore` is the earliest time the act may send. It is present only when `canLookUpNow` is false.
- `canLookUpNow` false with no `notBefore` means nothing is left to look up.
- The field holds no title and no identifier. The test greps the answer's bytes for the DOI, "doi", the title and the match titles.
- The field is absent when nothing was left out.
- The entry's `reasons` carry the state's sentence as the engine writes it. This is checked: waiting, found (+ the from-file sentence), nothing, not allowed.

Shared types are in `packages/shared/src/api/review.ts`: `ReviewLookUp`, `ReviewLookUpState`, `ReviewLookUpAgainRequest`, `ReviewLookUpOutcome`, `ReviewLookUpAgainResponse`.

## 4. The page (`packages/ui/src/screens/import/ReviewQueue.tsx`)

**Where the button sits.** At the end of "Why it needs review": after the reasons, the hints and "Merge into the likely duplicate", and before the candidates' "Use this match". The test checks Tab and Shift+Tab between it and the first accept button.

**When it is offered.** Only when `lookUp` has something left (`canLookUpNow`, or `notBefore`). A read-only library or a locked project shows no entry at all, so the button is not offered (tested).

**Button states, word for word:**
- Ready: "Look up again".
- Off (the time has not come): "Look up again (after {time})". `{time}` is `toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })`, as the pairing screen writes a time: the researcher's own zone and format. It turns ready by itself when the time comes.
- Busy: "Looking this up again…", with `aria-busy`. The entry's other decisions are disabled (the screen's usual busy state).
  - Off and busy use `aria-disabled="true"` rather than native `disabled`. The button stays focusable, so focus is kept, as the held-file cards on this screen do. A press then sends nothing (tested).
  - After the answer, focus stays on the button. If the button has gone (nothing left to look up), focus goes to the "Candidate matches" heading.
- Under way (R585 3): still "Looking this up again…" with no second press. The entry is read again every second, at most 30 times, until it changes.

**After the answer.** The answered entry replaces the shown one. Its reasons are shown in full through `UserText`, as before. The polite region says the state's ruled sentence, or for "not yet" the button's "after {time}".

**Under the matches, when there are no candidates:**
- waiting or gave-up: "Not looked up yet: the lookup service asked to wait."
- failed: "Not looked up: a lookup service could not be reached. You can use Look up again."
- nothing, or no `lookUp` at all: "No candidate matches were found."
- not-allowed: no sentence (see §7).

**After "found".** The new matches appear after the earlier ones, and accept goes by position. The test presses the third match and checks the body sent is `index: 2`, the third of the route's answer.

**The from-file sentence.** It is shown among the reasons, where the engine writes it. The engine marks it per entry (`fromFile`), not per candidate, so the page cannot say which match came from the file.

**Locked mid-look-up:** the queue is forgotten and the unlock form is shown. **Conflict:** the entry leaves the view with the screen's existing sentence. Colours are unchanged: no CSS was added, and `lint:colours` passes.

## 5. Ruling R585 (the coordinator's five points)

1. **"Under way".** The route answers any unknown "not done" result as `{ kind: "under-way" }` with the entry, never as an error (tested by standing in such a result). The pass skips it. The page keeps "Looking this up again…", offers no second press, and re-reads until the entry changes (tested). In this service the case cannot actually arise, because look-ups already take turns (`lookUpInTurn`).
2. **`tries`.** It is not shown to the researcher anywhere. It is documented in the shared type as "the app's own automatic tries". The only number shown is inside the engine's own gave-up sentence (`lookUpGaveUpText(tries)`), which is used in the polite region.
3. **Reasons.** The page shows the whole `reasons` list as the service gives it, unchanged. `state` is used only for the button and the text under the matches. The polite region says one sentence chosen by state; that is an announcement, not the list.
4. **Audit.** The service tests treat consecutive send lines for the same entry as one step. No test asserts a single send line.
5. **Clock — not fully met (see §6).** `canLookUpNow` and `notBefore` are worked out in the service (`lookUpOut`) by comparing the lookups' `notBefore` with the service clock, using the same rule as the engine's private `askableByHand`. This is the one place the comparison is done, but it is not R585 M1's rule: a far-future wrong-clock time would show the button off until the researcher's press is answered. The page compares with its own clock only to turn an off button ready when the service's time comes.

## 6. Needed of the engine, missing or looking wrong

- **(Needed for R585 5.)** An exported function such as `lookUpAskable(entry, now) → { now: boolean; notBefore?: string }`, with M1's wrong-clock rule built in. `lookUpOut` should call it instead of its own comparison. Today `askableByHand` is private, so the service has a copy of the rule.
- The from-file marking is per entry (`fromFile`), not per candidate, so the page cannot say which match came from the file.
- `LookUpAgainResult` does not say which services asked to wait again. The pass relies on the client's hold, which the engine consults. That is enough, and it is tested.
- `readAudit` returned events out of `seq` order in these tests: the send line came after the outcome line. The tests sort by `seq`. Worth a look by whoever owns the audit reader.

## 7. Tests run (each file alone, `nice -n 10`, MockAgent with `disableNetConnect`)

**New, service: `apps/library-service/src/look-up-again.test.ts`, 21/21.** All failed before the code: 20/20 at first, then 9 to the code's absence. The "under way" test was added later. Scenarios:
- pass at opening, counting and ordering requests and checking the audit interleaving;
- `idle()` waits, using a gated `getJson`;
- the cap of 20, with the next pass taking the rest;
- a service asking to wait again is left alone;
- a failed lookup is not taken;
- unlock;
- read-only;
- rules allow none;
- the timer at 10 min (fake `setInterval`, nothing at 10 min − 1 ms), and the timer gone after close;
- the timer option;
- a move: `startsHeld`, and quiesce stopping the timer;
- `beginClosing`: 0 requests, the route answers LIBRARY_CLOSED, the folder byte-identical;
- a pass under way cut by the close: the review file is unchanged;
- route: found (appended, same order as the queue), not yet (0 requests, nothing audited), nothing / asked to wait / not yet again / nothing left, not allowed, a failed lookup asked at once, under way, refusals (locked, extension token, missing, decided, foreign project, read-only);
- the field: keys, no identifier or title, absent with nothing left out.

Planted faults that were caught: a parallel pass (the order test failed), and the timer not stopped at close (the timer count was 1).

**New, page: `packages/ui/src/screens/import/ReviewQueue.lookUp.test.tsx`, 14/14.** Against the original screen: 9 failed (no button, wrong sentence). The 4 that passed were the cases unchanged by design: read-only, locked, "nothing", and no `lookUp`. The "under way" test was added later.

**Existing:**

| File | Result |
|---|---|
| review-queue | 23/23 |
| attach-asked-to-wait | 1/1 |
| close-during-attach | 13/13 |
| open-library | 26/26 |
| server (backups' scheduler, unlock/lock, move) | 160 passed, 1 skipped |
| lock-during-change | 3/3 |
| zotero-sync-scheduler | 43/43 |
| recovery-code | 10/10 |
| ui-only-routes | 128/128 |
| transcription-jobs | 40/40 |
| find-routes | 47/47 |
| ProjectReviewQueue | 26/26 (run again after the last change) |
| ReviewQueue | 125/125 (run again after the last change) |
| ReviewQueue.look | 18/18 |
| api/import | 7/7 |

Also passing: `pnpm -r typecheck` (all nine packages Done), `lint:css`, `lint:colours`, and the interface build.

End to end, in Chromium, unchanged: `review-queue.spec.ts` 11/11 and `import.spec.ts` 4/4.

`git status --short` is empty, and no process is left running.

## 8. Uncertain

- **Not-allowed with no candidates: no sentence under the matches.** None of the ruled sentences is true there: nothing was looked up, so "No candidate matches were found." is not true either. The reasons say "This project's rules no longer allow this lookup…". The owner may want a sentence.
- **Gave-up with no candidates shows "Not looked up yet: the lookup service asked to wait."** This is true (the service never answered), but it is a reading of the ruling.
- **Off and busy use `aria-disabled` rather than native `disabled`.** This keeps focus and Tab order. The brief said "disabled".
- **The page's "under way" follow-up blocks the entry's other decisions for at most 30 s.** In this service the case does not arise.
- The service tests' clock runs ahead of the lookup client's real clock. Waits answered during a test are therefore one hour long, so they stay ahead of the service's "now".
