# Build 16, batch D: report

`b16-d-streams` (kg-8) from fe85aac; two commits; not pushed.

| Item | Still a gap? | What changed | Test, failed first? |
|---|---|---|---|
| D1, Governance form | yes | f784ee9 `routes/governance.tsx` ≈:66-108: a reconnect loop (2 s pause), `openWithinMs` (prop `streamOpenMs`, 20 s). A reopened stream's first state counts as a change, so the projects are read again | `routes/governance.test.tsx` "R641 D1": a drop then a reopen; a stream that never opens. Both failed first |
| D1, reader hand-off | yes | nothing: NEEDS A RULING | none |
| D2 | yes | 1b68f67 `api/client.ts`: `events({ quietWithinMs })` and `STREAM_QUIET_TIMEOUT_MS` = 60 s. At the limit the request and the read are cancelled and the stream ends "did not answer in time". Turned on for the library screen (prop `streamQuietMs`) and the Governance form | `client.test.ts` "R641 D2": the limit failed first (it hung), the constant failed first, the keep-alive guard passed first. `Library.firstReads` and `governance.test` D2 tests: both failed first |
| D3 | yes | sized, not built: NEEDS A RULING | none |

**Heartbeat (D2):** the service already writes `: keep-alive` every 25 s (`routes/libraries.ts:630`), so nothing was added. Each consumer turns the silence limit on for itself, as R597 rules for the opening limit. Tied to `openWithinMs`, it broke three fake-clock tests (fakes send no keep-alive). The other eight consumers are unchanged. No existing test was changed.

## Sentences a person sees
None new or changed.

## NEEDS A RULING

**1. The reader hand-off (D1).** Its rule is "words are never kept unwatched; a lost watch drops them". A reconnect only helps if the words are kept through the gap, and then they are unwatched in it. A project lock in the gap cannot be detected afterwards, because `library.state` does not carry a project's unlocked state.
- (a) No reconnect. Add only the limits: a watch not open within 20 s, or silent for 60 s, drops the words ("Your search was not carried over", existing words). **I recommend this one:** the words live at most 60 s anyway.
- (b) Reconnect, keep the words through the gap, and drop them if the reopened state differs from the last one seen. This leaves the lock hole open.

**2. D3.** It fits: about 150 lines of product code and no background job.
- Engine: `checkOnce` (`reconnect.ts`) calls `onProgress(checked, total)` after each file (about 6 lines). It already takes a `signal`.
- Service: `GET /libraries/integrity` answers in NDJSON when asked: `{checked,total}` at most every 250 ms, then the report. `reply.raw.on("close")` aborts the check, as `:189` does (about 45 lines).
- Client: `integrityProgress(signal)` over `client.ndjson` (about 15 lines).
- Screen: `MissingFiles.tsx` gets the progress, "Stop" (it aborts the request), the stopped state and focus (about 80 lines).

The ruling gives no words for a stopped check. Proposed: "The check was stopped. Nothing was changed.", with "Check again" (words the app already uses). "Checking the library…" stays while the list of files is being read.

## Only a real Mac or service can show
Whether WebKit ends a silent real stream on the abort and `reader.cancel()`.

## Runs (each file alone, `nice -n 10`)
- governance.test 23/23 · client 46/46 · Library.firstReads 18/18 · governance.firstReads 37/37 · App 16/16
- Library 48 · dismiss 4 · notices 4 · reader 9 · recheck 12 · zotero 15 · routes/library 15
- FindAcquire 233/233 · ZoteroSync 60/60 · LibraryChooser 24 · YourLibrary 60
- New timing tests ×20: 20/20, 20/20, 20/20.
- typecheck, lint:css, lint:colours: clean. Build: done.
- Chromium: capture.spec 4/4. library.spec 4 passed, 1 failed (scenario 2, `/cite` 503): this worktree has no CSL bundle (gitignored), which is not related to this work.
- `git status --short`: empty.

## Second round (the coordinator's rulings)

| Item | Commit | Change | Tests (all failed first, except where noted) |
|---|---|---|---|
| Hand-off, ruled (a) | 047d5bd | `reader/readerHandoff.ts`: the watch opens with `openWithinMs` 20 s and `quietWithinMs` 60 s. There is no reconnect: a lost watch drops the words as before | `readerHandoff.test.ts` "two limits": the options failed first; "not open within the limit drops the words, nothing reopened" failed first; "opens in time, keeps its keep-alives, carries the words as today" passed first (a guard); "silent: cancelled at 60 s" passed first. That last one is weak: the words' own 60 s life ends at the same time. |
| D2, the other consumers | e7bd576 | `quietWithinMs: streamQuietMs` (default 60 s) in each place listed below. Off by default in the client | one new test per consumer, each failed first |
| D3 | e1806fe | engine `reconnect.ts` `onProgress`; route `routes/libraries.ts` NDJSON when asked, with an abort on close; `api/governance.ts` `integrityProgress`; `screens/MissingFiles.tsx`. 115 product lines added, 22 removed | `reconnect.test.ts` R641 D3; new `apps/library-service/src/integrity-progress.test.ts` (4 tests: 2 failed first, 2 are guards for the plain answer); `MissingFiles.test.tsx` R641 D3 (4) |

**Consumers that now have the silence limit, with each one's test (the test name begins "R641 D2"):**
- library screen: `Library.firstReads.test.tsx`
- Governance form: `routes/governance.test.tsx`
- Find and acquire: `FindAcquire.test.tsx`
- Watched folders: `WatchedFolders.test.tsx`
- Zotero sync: `ZoteroSync.test.tsx`
- Capture: `Capture.firstReads.test.tsx`
- the import's run step: `ImportWizard.firstReads.test.tsx`
- transcript viewer: `TranscriptViewer.firstReads.test.tsx`
- reader route: `reader.firstReads.test.tsx`
- reader hand-off: `readerHandoff.test.ts`

No consumer changed what a person sees. One case: in the run step, the try count does not restart when a stream opens. A stream that falls silent four times in a row (about four minutes) therefore ends in the step's existing notice with the existing sentence "The library service did not answer in time.", as a stream that keeps dropping does today.

**Test fakes:** the fake streams of `FindAcquire.test.tsx` and `ZoteroSync.test.tsx` now send `: keep-alive` every 25 s. In Find and acquire's two FR-558 tests the keep-alives run on the test's own clock (`events.keepAlive()`). In `MissingFiles.test.tsx`, five handlers now answer as the service answers this screen (NDJSON with a `result` line). No assertion was loosened.

**D3, the words:** "Checking the library…" (existing), "Checked {n} of {m} files…" (numbers as en-US), "Stop", "The check was stopped. Nothing was changed.", "Check again" (focus goes there, asserted through `document.activeElement`). There is no time limit. The progress lines come at the start, at most every 250 ms, and at the end. An error line is shown in the service's words. Leaving the screen cancels the check. The plain answer is unchanged (tested). No e2e scenario drives the missing-files screen (checked with grep), so the screen's and the route's tests carry D3.

**Runs (each file alone):**
- readerHandoff 18/18; Library.reader 9; Library 48; reader.find 22
- WatchedFolders 66; FindAcquire 234; ZoteroSync 61; TranscriptViewer.firstReads 12; reader.firstReads 6; Capture.firstReads 15; ImportWizard.firstReads 14
- routes import 19, reader 13, tools 9, transcript 4; Capture 65; TranscriptViewer 66; ImportWizard 56; Step* 35; Fieldwork 31; Reader 59; Reader.keyboard 43; App 16
- MissingFiles 9/9; integrity-progress 4/4; reconnect 56/56; server.test -t integrity 3/3; integrity-confirm 5, -batches 7; kept-warnings 13
- lock-mid-read 42/44: the 2 failures are the missing CSL bundle in this worktree (citations); its checkIntegrity row passes
- ×20: the hand-off 20/20; WatchedFolders, ZoteroSync, TranscriptViewer, reader, ImportWizard 20/20 each; FindAcquire 18/20 → after making the assertion ≥ 2 attempts (more than two under load), 20/20; Capture 19/20 under load (no log kept), then 20/20 with logging; MissingFiles D3 20/20; integrity-progress 20/20
- typecheck @ao/library, @ao/library-service, @ao/ui, @ao/cli: 0 errors; lint:css and lint:colours clean
- Chromium (UI built): capture, watched-folders, zotero-sync, import specs: 29 passed. No spec file was touched.

## Fix round (after the review)

`b16-d-streams` e1806fe → 9fb7369, eight commits, not pushed.

- **I1** (85cc7e0, tests only): the request is kept and `.signal` read when asserted. Places: `test/service.ts` (`sseAttempts`, `asksInTurn`); governance `attempts`, plus its D2 test; `routes/library`, `reader.firstReads` ×3; `Reader.test` ×4; Capture/ImportWizard `holding`; TranscriptViewer.firstReads ×2; MissingFiles `ndjsonCheck`; Library.firstReads ×2, WatchedFolders, ZoteroSync side reads; Library.zotero; YourLibrary; SearchSources; SourceDetail.firstReads; governance.firstReads ×2; ReviewQueue.firstReads ×3. Requests are also kept where an abort listener counts: `test/importService`, `captureService`, `msw-transcripts`, FindAcquire FR-558, ReviewQueue held-file.
- **M1** (646f67f): `readerHandoff.ts:110–111`, the limit removed, with a reason; its test removed. The options test asserts no `quietWithinMs`; it failed first.
- **M4** (e21b664): `governance.tsx:101–109`. Test: six live listeners became one; it failed first. `routes/reader.tsx:330` has the same leak; it was not changed.
- **I2** (e1edf74): `MissingFiles.tsx:44,121–128`. Test: a cut-off answer, then "Check again"; it failed first.
- **M3** (c8a77f1): `MissingFiles.tsx:24,47–60,139–143`. The visible line is no longer live; a hidden status carries it at most every 5 s. Fake-clock test; it failed first.
- **M6** (8f24841): the fake answer is NDJSON. The test now sees the file listed; it failed first.
- **M2** (9fb7369): `reconnect.ts:79–112,570,633`. Two tests, both failed first.
- **M5: NEEDS A RULING, not built.** Resetting `tries` on open breaks `ImportWizard.test` R115 I5 ("closes after connecting… not on Starting…"): a stream that opens and closes at once would loop forever. (a) Reset only after a silence give-up or an event (recommended). (b) Reset on open and change that test.

**Certain (answer 4, 1c3b7cd):**
- client "keep-alive", Governance silence, Governance M4, the hand-off: fake clock.
- client "silent": waits for the rejection; its limit is a lower bound.
- Governance drop and never-opens: the reopened stream rests (60 s limits).
- Library, WatchedFolders, FindAcquire, Zotero, reader, transcript, Capture: they wait for "≥N tries and the first cancelled". This only grows, and the limit is a lower bound.
- Import run step: its second try is held unopened, so the step rests.
- MissingFiles: the test drives each line.

**Loaded (4 busy loops, killed; nothing running), 30/30 each:** client, governance, Library.firstReads, WatchedFolders, FindAcquire, ZoteroSync (resumed at run 17 after a time limit, no failure), Capture/ImportWizard/TranscriptViewer/reader firstReads, readerHandoff, MissingFiles, integrity-progress.

**Other runs:** touched files pass; typecheck ui/library/service 0 errors; lint:css and lint:colours clean.

## Second fix round (R658)

Commits (worktree kg-8, branch b16-d-streams, not pushed): 25695d6 (mend 1), c6ff19b (mend 2), 64d525a (mend 3). Head 64d525a.

**Mend 1 — import run step's count of tries starts again (review M5).** `packages/ui/src/screens/import/StepRun.tsx:87–124`: the `for (tries…)` loop is now `while`, with `opened` (set in `onOpen`) and `proved` per try. `proved` is set on any event the loop receives (before the batch filter), or when the try ended with the client's did-not-answer-in-time error after it had opened (`opened && isNoAnswerInTime(err)`: after opening, the client gives that error only at its quiet limit). A proved try sets `tries = 0`; otherwise `tries++ >= RECONNECTS` ends in the notice as before. `client.ts` not changed. No words changed.
Tests, `ImportWizard.firstReads.test.tsx:232–268`, both failed first ("expected 3 to be 6": the notice after 3 tries):
- "R658: more silences in a row than the step's tries, each after the stream opened, do not end in the notice: the step keeps following" (5 quiet streams, sixth held unopened; first five requests cancelled, sixth not; no notice).
- "R658: a stream that delivered an event and then dropped, more times than the step's tries, …" (each of five streams sends another batch's `import.progress` then ends; sixth held; no notice, still "Starting…").
- Unchanged and passing: `ImportWizard.test.tsx` › "run screen (R115 I5)" › "a stream that closes after connecting does not leave the screen on Starting…". Not opened in time, more than the limit, still ends in the notice: existing `ImportWizard.firstReads.test.tsx` › "a stream that never opens at all ends, after the step's own tries, in its existing notice, saying it did not answer in time …" (passes).

**Mend 2 — the reader's pause removes its listener (as review M4).** `packages/ui/src/routes/reader.tsx:326–335`, mended exactly as `governance.tsx` (e21b664). Test `reader.firstReads.test.tsx:133` "R658: each pause before the stream is listened to again leaves no abort listener behind once it is over (as review M4)", on the pattern of e21b664's test (fake clock, live listeners counted); failed first ("expected 6 to be 1").

**Mend 3 — "Check again" on Missing files hands focus on (coordinator's addition).** No existing component fitted (`TryAgain` carries the words "Try again"); followed the fallback ruled: `packages/ui/src/screens/MissingFiles.tsx:46,100–104,122,133,141` — the `<h1>` has `tabIndex={-1}` and a ref; both "Check again" buttons call `checkAgain`, which focuses the heading and starts the check. The first check at mount and `search()`'s re-check do not move focus; "after Stop, focus goes to Check again" unchanged. No words changed.
Tests `MissingFiles.test.tsx:223–260`: "R658: “Check again” after a stop, pressed, hands focus to the screen's heading…" and "R658: “Check again” under a failed check, pressed, …" — both failed first (focus on `<body>`). A third, "R658: the screen's first check, at its opening, does not take focus to the heading", is a guard and passed before the mend too.

**30× under load (4 busy loops, killed; nothing left running):**
- `ImportWizard.firstReads.test.tsx`: 30/30 — last: Tests 16 passed (16)
- `reader.firstReads.test.tsx`: 30/30 — last: Tests 7 passed (7)
- `MissingFiles.test.tsx`: 30/30 — last: Tests 14 passed (14)

**Verify (once, no load):** `ImportWizard.test.tsx` Tests 56 passed (56); `reader.firstReads.test.tsx` 7 passed; `reader.test.tsx` 13 passed (13); `Reader.test.tsx` 59 passed (59); `MissingFiles.test.tsx` 14 passed; `@ao/ui typecheck` 0 errors; `lint:css`, `lint:colours` clean; `git status --short` empty.

Uncertain: the import's "proved by silence" relies on the client's only post-open did-not-answer-in-time being the quiet limit (true at this head, `client.ts:466–484`); a future change there would need this read again.

### Correction (R659)

Commit 01af081, on top of 64d525a; it is now the head. The real service sends `library.state` as soon as a stream opens, so the R658 rule "any event proves the connection" let a stream that opens and closes at once be retried for ever.
- `packages/ui/src/screens/import/StepRun.tsx:87–105`: `proved = true` now comes after the `isProgressFor(batchId, e)` check. The comment above `let tries` is updated. Proof (ii), opened and then did-not-answer-in-time, is unchanged.
- `packages/ui/src/api/client.ts:484`: a one-line comment (no code change) saying StepRun reads "opened, then this error" as "open and silent to the quiet limit".
- Tests, all in `ImportWizard.firstReads.test.tsx`. A `dropping()` helper answers `/events` as the real service does: the opening `library.state` event, then the test's own event, then the stream ends.
  - New: "R659: a stream that sends only the service's opening state and ends, every time, ends after the step's tries in the notice with “Check again”; the step then rests". The notice appears and the connection count is 3. It failed at 64d525a: no notice, endless reconnects.
  - New: "R659: a stream that delivered the opening state and another batch's event and then dropped, every time, ends after the step's tries in the notice". It failed at 64d525a the same way.
  - Changed: "R658, R659: a stream that delivered a progress event of this batch and then dropped, more times than the step's tries, does not end in the notice …". Each stream sends the opening state, then this batch's progress. It passes at 64d525a too. This is expected, since it is the positive case; it failed first in R658, against the original loop.
- Runs:
  - `ImportWizard.firstReads.test.tsx`: Tests 18 passed (18).
  - `ImportWizard.test.tsx`: Tests 56 passed (56).
  - `@ao/ui typecheck`: 0 errors.
  - `ImportWizard.firstReads.test.tsx` 30 times under load (4 busy loops, killed): 30/30, last line Tests 18 passed (18).
  - `git status` is empty.
