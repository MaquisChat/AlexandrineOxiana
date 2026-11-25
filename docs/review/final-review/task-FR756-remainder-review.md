# FR-756, the remainder: adversarial review

Branch `fr-756-remainder` in `kg-7`, head 277b1ed; reviewed `git diff 257062a..HEAD` (ten commits). I changed nothing on the branch. My probe tests were written under `packages/ui/src`, run, and then moved out to the scratchpad. `git status --short` is empty.

## Verdict: APPROVED WITH SMALL POINTS

There is no Critical finding and one Important finding (a missing test). Every new limit is on a read; no act has one. I probed every combination of the review route's picker and queue (9 combinations): each shows one sentence and one "Try again", "could not be reached" wins, and the press reads again only what is out. With three mends taken out (items 1, 2 and 9), their tests fail. Typecheck and both lints are clean.

## Table: `readWithin` / `answerWithin` calls the diff adds (none uses `answerWithin`)

| file:line | call | read or act |
|---|---|---|
| ReviewQueue.tsx:598 | `projectReview` (each page of the project's queue) | read |
| ReviewQueue.tsx:605 | `review(batchId)` (one import's queue) | read |
| ReviewQueue.tsx:651 | `policy` (side read, silent) | read |
| ReviewQueue.tsx:655 | `batches` (side read, silent) | read |
| routes/import.tsx:93 | `projects` (the picker) | read |
| routes/import.tsx:123 | `batches` (the picker) | read |
| SourceDetail.tsx:280 | `sources.get` (the record; also the re-reads on `refreshKey` and `reloads`) | read |
| NewProject.tsx:258 | `projects.list` (before the create, and the check after a lost answer) | read. The create at :393 has no limit. |
| AppearanceProvider.tsx:113 | `appearance.get` | read. The `put` has no limit. |
| WatchedFolders.tsx:388 (`sideRead`) | collections, projects, libraries | read (silent) |
| ZoteroSync.tsx:342 | `imp.projects` | read (silent) |
| RecheckProject.tsx:107, LibraryZotero.tsx:97 | already limited; only the leave signal is added | read |

These are untouched and still have no limit, as they should: accept, dismiss and decide; "Look up again" and its 30 polls (`api.projectReview` at :868 is unchanged, with no signal and no limit); the held-file decision; confirming a field; the unlock; the create. The `ReviewQueue*.test.tsx` files are unchanged (`git diff` shows only the new file `ReviewQueue.firstReads.test.tsx`, 170 lines added) and pass: 125, 18 and 31 tests.

## Critical

None.

## Important

**I1 (item 1): on the review route, "one sentence and one 'Try again' per page" has no test.** When the queue itself is inside the picker's page, nothing tests that the queue stays silent while the picker shows the page's alert.
- **Sequence:** open `/import/review?batch=B` (no project). The list of projects answers. The list of imports fails with no answer, and the queue's read of B is held.
- **Shown now (correct):** one alert, "The library service could not be reached.", and one "Try again".
- **Shown with the queue's check taken out** (`{unanswered && !yields && (` changed to `{unanswered && (` at ReviewQueue.tsx:1290): two alerts and two "Try again" buttons. In the "fail / fail" case it is two copies of "could not be reached".
- **No test notices:** with that check taken out, `ReviewQueue.firstReads.test.tsx` passes 8 of 8 and `routes/import.test.tsx` passes 18 of 18. The builder's two route tests each have only one read unanswered.
- **Mend:** add the 3×3 table (imports read held / failed / answered × queue read held / failed / answered) as a test. My probe `zzprobe.route.test.tsx` (in the scratchpad) is that test almost verbatim: it asserts the one sentence and one button, and that the press reads both again. R605 M11 asks for the missing tests.

## Minor

1. **(item 2) The panel shows two alerts after a re-read that got no answer.** The panel's read is refused by the service ("The service refused this read."). Then `refreshKey` moves on (the badges are read again after a recheck) and the re-read is given up or fails with no answer. The panel now shows two alerts: the refusal and "did not answer in time" (I probed this). Before this work, a re-read that failed with no answer replaced the refusal, so the panel showed one alert; for that case this changes what a failed read shows. Where: SourceDetail.tsx:291-297. Mend: `setError(undefined)` in the no-answer branch, or at the start of each read.
2. **(item 2) The page's sentence about the list can be said only inside the source panel.** In the library screen, the panel's read is given up first, and then the screen's search is given up too. The page's one sentence stays in the panel's alert, and the only "Try again" is inside the source panel, where it reads as being about the source. It follows the takeover rule of R617 N2 and is true, but it is untidy. Closing the panel then inserts the screen's alert with the same words, so the sentence is said again.
3. **(item 1) The review queue's side reads of collections and tags have no limit and no signal** (ReviewQueue.tsx:652-653). The builder listed this. A hang leaves the bulk bar's lists empty and holds a connection. R602 M4 asks for the silent limit. Mend: add an optional `signal` to `importApi.collections` and `importApi.tags` (add only), as was done for `review`.
4. **(item 1, older than this work) Switching project in the picker while the new project's imports read is held.** The queue goes on showing the old project's import under the new project; the import select keeps the old project's import and `ReviewQueue` is rendered with the key `P2/B1` (probed). Now the "did not answer in time" alert also stands beside it. Mend: at a switch, clear `batchId` and `batches` until the new list is read (routes/import.tsx:118-128).
5. **(item 8, older, development build only) Under StrictMode, `LibraryZotero` never reads.** Its clean-up sets `alive.current = false` (LibraryZotero.tsx:112) and nothing sets it back. Probe: under StrictMode no `/zotero/sync` request was made at all; without StrictMode, one was. Not caused by this diff, but item 8 touched the file.
6. **(item 6) After a refused list, the chooser's only words about the list can disappear.** The refusal's message lives in `error`, which every act clears. After a failed "Open" or "Create", the list area is blank. That is not untrue, only silent, and a refused list has no "Try again" (as before).
7. **(item 1, older) A held held-file decision, then a re-read given up.** After the decision is given up at 60 s, the queue is read again. If that re-read is given up, the queue's alert stands where the card was, and the card's "The service did not answer…" is hidden (the card shows it again after "Try again" is answered). It was hidden during every re-read before this work too. Noted against R605 M5.
8. **(item 3) No separate "Try again" in the new-project dialog.** I agree with the builder: it is not a trap. After a give-up the form is usable, the passphrase is kept, and "Create project" reads first, so the duplicate-name check is never skipped. A project cannot be created twice, and none is created against a list that was not read (tested: the create is called only after an answered read). The give-up's sentence does not say that nothing was created; neither did the failure's.
9. **(F) Find and acquire has no page host for the source panel.** The screen-settings read given up, the queue answered, a source opened, and the panel's read given up: two alerts with the same words and two "Try again" buttons. That is untidy, not untrue (the builder listed it). Find's takeover in the other order can say the sentence twice: two announcements of true words.

## Probes and what they showed

- **Route, 9 combinations** (imports read × queue read): one sentence each time, the right one; one "Try again"; the press re-reads only what is out (with all answered, no alert and no button).
- **Library + panel:**
  - Search given up after the panel: one alert (in the panel). Search failed after the panel: one alert ("could not be reached", from the host; the panel yields).
  - The press reads both again.
  - Switching source while the first is held: no alert, "Loading…", and the first read cancelled. The first one's give-up never lands on the second.
  - Panel given up: "Edit details" and "Recheck" are disabled and no field is editable, so the researcher cannot save blanks.
  - A record shown, then a re-read given up: the earlier record stays (it was read) with the alert.
- **StrictMode:** Library (recheck and Zotero) and Watched folders show no alert while their real reads are out. In Watched folders the side reads of the simulated leave are cancelled and the real ones stay open.
- **Mends taken out:**
  - Item 1 (limit removed): 3 of 8 tests fail.
  - Item 2 (limit removed): 3 of 7 fail. With the panel's yield removed: 1 of 7 fails.
  - Item 9 (the check reverted to `leaving()` after the await): the StrictMode test fails (1 of 60).
  - Each file was copied aside and restored with `cp`; no `git stash`.
- **Appearance (read only):** a save sends only the changed fields (a patch), so stored values are never overwritten wholesale. As before for a failure, a change made during the give-up keeps the screen's other values at the defaults when "Try loading again" answers (`changed.current`).

## Tests run (each file alone, `nice -n 10`, NODE_OPTIONS=--use-openssl-ca)

**54 files, 1479 tests, all passed**, with no time-out. Per file: App.test.tsx 16 · api/client.test.ts 43 · api/firstRead.test.ts 6 · api/import.test.ts 7 · components/WatchOrigin.test.tsx 35 · routes/governance.test.tsx 20 · routes/import.test.tsx 18 · routes/library.test.tsx 15 · routes/reader.find.test.tsx 22 · routes/reader.firstReads.test.tsx 5 · routes/reader.test.tsx 13 · routes/tools.test.tsx 9 · routes/transcript.test.tsx 4 · screens/AppearanceSettings.reset.test.tsx 10 · screens/AppearanceSettings.test.tsx 26 · screens/AuditLog.test.tsx 18 · screens/Capture.firstReads.test.tsx 14 · screens/Capture.test.tsx 65 · screens/Fieldwork.test.tsx 31 · screens/FindAcquire.test.tsx 233 · screens/GovernanceSettings.test.tsx 65 · screens/Library.dismiss.test.tsx 4 · screens/Library.firstReads.test.tsx 17 · screens/Library.notices.test.tsx 4 · screens/Library.reader.test.tsx 9 · screens/Library.recheck.test.tsx 12 · screens/Library.test.tsx 48 · screens/Library.zotero.test.tsx 14 · screens/LibraryChooser.firstRead.test.tsx 6 · screens/LibraryChooser.lostCreate.test.tsx 2 · screens/LibraryChooser.notices.test.tsx 5 · screens/LibraryChooser.shell.test.tsx 3 · screens/LibraryChooser.test.tsx 24 · screens/LibraryNotFound.test.tsx 10 · screens/NewProject.firstReads.test.tsx 4 · screens/NewProject.outcome.test.tsx 26 · screens/NewProject.test.tsx 14 · screens/SourceDetail.firstReads.test.tsx 7 · screens/SourceDetail.test.tsx 47 · screens/WatchedFolders.test.tsx 65 · screens/YourLibrary.test.tsx 60 · screens/ZoteroSync.test.tsx 60 · screens/governance.firstReads.test.tsx 37 · screens/import/ImportWizard.firstReads.test.tsx 13 · screens/import/ImportWizard.test.tsx 56 · screens/import/ProjectReviewQueue.test.tsx 26 · screens/import/ReviewQueue.firstReads.test.tsx 8 · screens/import/ReviewQueue.look.test.tsx 18 · screens/import/ReviewQueue.lookUp.test.tsx 31 · screens/import/ReviewQueue.test.tsx 125 · screens/import/StepReport.test.tsx 25 · screens/import/StepScan.test.tsx 3 · screens/import/StepSource.shell.test.tsx 7 · theme/AppearanceProvider.test.tsx 14.

`pnpm --filter @ao/ui run typecheck`: 0 errors. `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
