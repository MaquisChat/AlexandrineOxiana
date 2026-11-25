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
