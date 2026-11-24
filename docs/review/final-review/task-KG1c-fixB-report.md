# KG-1c, fix round B (Ruling R528, with R529's sentence): report

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from 908d6a8. Not pushed. `git stash` was never used. `…/kg-1-look` was not touched. No permission check refused anything. `git status --short` is empty.

## Commits (head 1634be4)

| Point | Commit | What |
|---|---|---|
| 1 (I4) | none | Already mended by round A (f3bb99f). |
| 2 (I3) | 053d0e2 | Tests for the two guards. |
| 3 (I1, M2, M4) | d835d5c | The banner by the worst thing true, two new states, `could-not-read`. Also carries sentence 11 of M5, which changes with the states. |
| 4 (I2) | a84298e | The warning follows every act; the service publishes after a refusal. |
| 5 (M3, M5) | bf3d404 | Refused write; reopen reason; CLI detail per state; no "yet". |
| 6 (M6) | 3cd210a | Reader skips other builds' kinds; a higher version is left alone. |
| 7 (M7) | df340c9 | The close's audit entry: source id and role. |
| 8 (M8) | 2767b58 | "Nothing is at that place now." only after a successful look; source named for its own folder. |
| 9 (M1) | a4325c5 | Library screen "Dismiss" tests. |
| 11 (R529) | bdcc222 | The unverifiable banner and CLI detail. |
| 10 | 1634be4 | End-to-end spec. |

## Per point

### 1. I4: already mended
The `server.test.ts` fixture `lostOriginal` (FR-736 block, about l.3010) writes `ino` and `birthtimeNs`. Round A changed it in f3bb99f.
- Run at 908d6a8 before any change: `server.test.ts` 156 passed, 1 skipped.
- Nothing was changed for this point.

### 2. I3: the two guards, each held by a test that fails without it
**(a) The close guard.** New test in `packages/library/src/repo/pending-writes-close.test.ts`, "R528 I3 (probe P5)":
- The change trashes `D/x.txt`, then `D`. The kept copy of `D` is deleted, and the library is reopened.
- It asserts:
  - the list's `canClose: false`, and the causes name only `D`;
  - the close is refused with sentence 25;
  - the marker is unchanged;
  - the inner copy ("inner original\n") is still in `.tmp` after a reopen, and the marker is still there.
- Point 3 added: the state `lost-copy-stuck`, the banner's whole sentence, and the answer to "Roll it back".

Scratch edits, each restored with `git checkout`:

| Guard removed | Result |
|---|---|
| `keptCopiesLeft` returns false | FAILS at `canClose` |
| Only the two checks inside `closePendingWrite` | FAILS: "expected null to be an instance of PendingWriteIncompleteError" (the close went through) |
| `keptCopiesLeft` (moved to `txn.ts`) returns false, after point 3 | still FAILS |

**(b) The kept-record filter.** New test in `kept-warnings.test.ts`, "R528 I3: an undo that did not complete is never kept as one that did":
- A change creates a file, which is then changed by hand, so the undo is incomplete (in the way).
- It asserts that:
  - the standing warning has a state and no `keptId`;
  - `recovery-warnings.json` does not exist, after this opening and the next;
  - no kept warning is shown;
  - the warning shown carries its state.
- With the filter `w.rollback === undefined` removed (scratch, restored), it FAILS: "expected '01a2…' to be undefined".

### 3. I1 with M4 and M2: which banner, and the order of the words

**Shared** (`packages/shared/src/api/interrupted-changes.ts`):
- `IncompleteRollback` gains three states:
  - `could-not-read`: the cause `could-not-look`. The banner says "the app could not read a file", as the list does (M4).
  - `lost-and-blocked`: a copy is gone (lost or unconfirmed), and something the researcher can deal with also stops the undo: a file in the way, a file that could not be read, a failed step, or a cause of an unknown kind. It leads with the loss, then what to do first, then the close.
  - `lost-copy-stuck`: a copy is gone, nothing else stops the undo, and the app still keeps a copy that it cannot put back (P5). There is no close; the words say a backup is the way.
- `incompleteRollbackOf(causes, stepFailed, copyKept = false)` follows the ruled order: loss, then in the way, then could not read, then step failed.
- "Nothing was lost" is never said where a copy is gone.
- New: `CLOSABLE_ROLLBACK`, `ROLLBACK_LIST_NEXT` and `CLOSE_COPIES_LEFT_TEXT`.
- The banners and answers of the new states are new.
- The answer `lost`/`unconfirmed` (sentence 11) names the close (M5).

**Library:**
- `keptCopiesLeft` moved to `txn.ts`. New `copyKeptOf` judges it only where it chooses the state, and counts a failed look as kept.
- `RecoveryResult.copyKept` is set by `recoverTransactions`.
- The attempt carries `copyKept` (`RollbackAttempt` in `state.ts`). It is set at the opening (`repo.ts`), in `carryOut` and `closePendingWrite` (`pending-writes.ts`), and in process (`mutate.ts`).
- New `stateOf` (`pending-writes.ts`).
- `closable` uses `CLOSABLE_ROLLBACK`.
- A close refused for `lost-copy-stuck` says sentence 25. For `lost-and-blocked` it says a new route-only sentence (24b).
- New `incompleteDetail(state, origin)` (`pending-writes.ts`) replaces `INCOMPLETE_DETAIL` (`repo.ts`): the CLI detail for every state.

**UI:** `PendingWritesDialog.tsx` shows `ROLLBACK_LIST_NEXT[state]` under the causes.

**Tests:**
- `packages/shared/src/api/interrupted-changes.test.ts` (new):
  - every one of the 128 combinations of {lost, unconfirmed, hand-changed, path-occupied, could-not-look, step failed, copy kept} maps to its state;
  - "Nothing was lost" never appears where a copy is gone;
  - an unknown kind is never closable;
  - every banner and every answer, word for word.
  - **101 of 132 failed first.**
- `rollback-words.test.ts`:
  - **probe P1**: the warning's state, the whole banner sentence, and the list's two lines word for word;
  - **probe P2**: the banner never says "Nothing was lost" or "a step failed". After the step passes, "Roll it back" gives the new lost answer and the list offers the close;
  - **the mixed state step by step**: a lost `a.txt`, plus `c.txt` occupied by a hand file (its copy is kept). The banner is `lost-and-blocked`. The hand file is moved out of the library. "Roll it back" puts `c.txt` back, answers the lost answer, and the list says `lost` with `canClose`. Point 4 adds the warning, the banner being `lost`, word for word. Then the close, and a write is accepted.
  - **Changed (it asserted the M4 defect):** CASES "could-not-look" now expects `could-not-read`, and its detail may say "retried".
- `pending-writes-close.test.ts`: P5 extended (above).
- `StatusBanner.test.tsx`: the three new states, for both kinds, with "Resolve…".
- `PendingWritesDialog.test.tsx`:
  - P1's list: the cause lines plus the next-step line, and no close (**failed first**);
  - P5's list: the backup line, with no close and no hint (**failed first**);
  - **changed:** the could-not-look case sends `could-not-read`.
- **Changed:** `server.test.ts` "Roll it back answers…": the lost answer now names the close.
- The library tests of this point (P1, P2, the mixed state) were written after the library change. The state function they rest on failed first in the shared table test.

### 4. I2: the warning follows every outcome of the list's acts
**Library:** new `noteAttempt(core, txn, attempt)` (`pending-writes.ts`).
- It records the attempt.
- For the change's `rolled-back-incomplete-write` or `incomplete-write-pending` warning that carries a state, it updates:
  - `rollback`;
  - `causes`;
  - for the first kind, the CLI detail, keeping its origin (opening or in process) and its "(transaction …)".
- It is used by `carryOut` (roll-back, also at the opening for a recorded choice) and by `closePendingWrite` (refused for a non-closable state).
- A completed attempt is unchanged: `afterResolved` removes the warnings.

**Service** (`apps/library-service/src/routes/libraries.ts`): `/resolve` and `/close` publish the library's state after a refusal too (`catch → publishState → rethrow`). The order on success is unchanged.

**Tests:**
- `rollback-words.test.ts`, "R528 I2":
  - **P1 continued:** `b.txt` is moved out and "Roll it back" is chosen. The list says `lost` with `canClose`. The warning now says `lost` with `[kept-copy-gone]`, and its detail is the lost detail word for word.
  - **In process:** try-again, then a hand edit, then "Roll it back". The warning becomes `in-the-way` with its cause, and its in-process detail is word for word. Moved away and rolled back, the warning goes.
  - **A recorded choice's `incomplete-write-pending`:** `lost-and-blocked` becomes `lost`.
  - **4 failed first** (the mixed step-by-step test among them).
- `server.test.ts`, "R528 I2":
  - after the opening's background work is idle, a refused "Roll it back" publishes exactly one `library.state`, whose warning has `state: "lost"`;
  - a close refused by unreadable rules (403) publishes a second.
  - **Failed first:** "expected [] to have a length of 1".

### 5. M3 and M5: sentences
- **Sentence 12 (ruled):** `RECOVERY_PENDING_TEXT`. Tested in `server.test.ts` (the 409) and through Find's `recovery-pending`.
- **Held for another reason** (see NEEDS A RULING 1). `RecoveryPendingError` gains `reason: "interrupted-change" | "reopen"` (`errors.ts`).
  - New `ProjectState.reopenToResume` is set where `audit-append-failed-at-open` is raised (`repo.ts`) and where a resolve is held at an anchor mismatch (`afterResolved`).
  - New `pendingReason(st)` (`state.ts`) gives `reopen` only when no marker of the project is left.
  - All 8 throw sites pass it (`repo.ts` ×3, `mutate.ts` ×2, `projects.ts` ×2, `collections.ts`).
  - The service maps `reopen` to `RECOVERY_PENDING_REOPEN_TEXT`.
  - Find and acquire has a new stopped code, `reopen-pending`, with the same text (`shared/api/find.ts`). The runner blocks by reason, and `recoveryPendingReason(repo, pid)` is new in `repo.ts`.
  - Tests:
    - `pending-writes.test.ts` (d) asserts `reason: "reopen"` after a held resolve.
    - `rollback-words.test.ts` asserts `reason: "interrupted-change"`.
    - `runner.test.ts` asserts `reopen-pending` and its text.
    - Both FAILED with `pendingReason` forced to "interrupted-change" (scratch, restored).
- **Sentence 13:** untouched (it still ends ", then resume the import."). Its coupling with the resume is tested: `disk-full.test.ts`, "a project that refuses writes…", asserts the note is gone after the resume. Run: 14/14.
- **Sentence 11:** names the close (point 3).
- **Sentence 19:** the in-process detail is `incompleteDetail(state, "in-process")` (`mutate.ts`). New tests in `rollback-words.test.ts`, "R528 M5": try-again (word for word) and could-not-read (word for word, **failed first**).
- **Sentences 15 and 16:** "yet" removed.
  - Tests changed: `StatusBanner.test.tsx` (ONE, SEVERAL, `SOURCE_CHANGE_UNFINISHED`) and `sources-read-race.test.ts` (`UNFINISHED`).
  - `SOURCE_CHANGE_UNFINISHED` lives in `shared/api/annotations.ts`.

### 6. M6: the kept warnings' reader (`kept-warnings.ts`)
`readKeptWarnings` returns `{ list, others, newer? }`:
- An entry of an unknown kind, or with an unknown `rollback` on a known kind, goes to `others`. It is written back first, as it was, on every rewrite.
- `formatVersion` > 1 gives `newer`:
  - nothing is shown from it;
  - nothing is written, not even this opening's new warnings, which are shown for the session only;
  - it is never set aside;
  - a dismissal finds nothing (404) and writes nothing.
- A malformed entry, or one of a known kind with bad fields, is still "damaged", as before.

Tests in `kept-warnings.test.ts`, **both failed first**:
- An unknown kind among known ones: the known one is shown, and nothing is set aside. After dismissing the known one, the file is exactly `{formatVersion:1, warnings:[LATER]}`. A later opening adds its warning beside it, and the unknown entry is kept deep-equal.
- Version 2: the file is byte for byte the same after an opening that raised a keepable warning, after a dismissal attempt (`NotFoundError`), and after another reopen. Nothing is set aside, and no set-aside warning is raised.

### 7. M7: the close's audit entry
`notPutBack` is now an array of `{ source?: <id>, role }` (`auditedPlace`, `pending-writes.ts`).
- `role` is read from where the file stands in its source's folder: `original`, `derived`, `record`, `annotations`, `folder`, or `other`. A place outside every source is `{ role: "other" }`.
- So it is known while a project is locked. No path is recorded.
- Other audit entries record ids and counts only (`sources.ts` about l.844; `attention.ts` about l.436).
- The list and the question still show the path.

Tests in `pending-writes-close.test.ts`, **both failed first**:
- The existing close test now asserts the whole `details`, `{ txn, choice: "close", status: "uncommitted", steps, notPutBack: [{ source, role: "other" }] }`, and that the folder's name is absent.
- **New probe P4:** a source's original is trashed and its copy deleted. The list still shows the path. The entry is exactly `notPutBack: [{ source: sid, role: "original" }]`, without "Annotated" and without the path.

### 8. M8: `lostOf`
- New `lookNow(root, rel)` (`txn.ts`) answers:
  - `nothing` only on ENOENT or ENOTDIR;
  - `could-not-look` for any other failure;
  - `a file` or `something else` otherwise.
- The roll-back's look seam reaches it under "test" only. A case was added to `seams-inert.test.ts` (R47).
- The source is named also when the place IS its folder (`c.path === f`).
- UI: a new `NOW_THERE["could-not-look"]` and the API type.

Tests, each failed first:
- `pending-writes-close.test.ts`: a failed look gives `now: "could-not-look"`.
- The source's own folder (made again at the place, with its record in it) gives `sourceId` and `rollback: "unconfirmed"`. It failed with the equality check removed.
- `PendingWritesDialog.test.tsx`: the question's whole text with the new sentence.

### 9. M1: the library screen's "Dismiss"
New `packages/ui/src/screens/Library.dismiss.test.tsx`, 4 tests:
- **Double press:** a press, a double press and another press send one request. The banner leaves, the other warning keeps its "Dismiss", and the focus is on the "Library status" region (`document.activeElement`).
- **Last banner dismissed:** the focus is on `<main>`, never on the body.
- **Refusal:** an alert ends with the service's sentence, and the banner stays. A second try works and the alert goes.
- **Read-only:** no "Dismiss".

The code was not changed; the tests pass against it. Each scratch edit (restored) made its test FAIL:
- the one-request guard removed;
- the focus step removed (2 tests);
- the alert removed;
- "Dismiss" given in read-only.

### 10. End to end: `e2e/interrupted-change.spec.ts` (new)
`libraryWithProject`, then `POST /libraries/close`. Then, with the library closed:
- a marker in this build's shape is laid down in `<lib>/.tmp/`: a `created` line for `Projects/…/notes.txt` with the change's hash, and the audit count read from the project's log;
- the file holds other bytes (changed by hand).

Then:
1. The library is opened through the chooser ("Open Harbour library").
2. The banner's whole sentence plus "Resolve…", and no "Dismiss".
3. "Resolve…": the list's line with the path, word for word, and no close.
4. The test moves the file out of the library.
5. "Roll it back", then "Yes, roll it back": "Nothing is waiting: every interrupted change is resolved." The moved file is intact and the marker is gone.
6. Close: the banner is gone.
7. `POST /projects/:id/collections` gives 200.

Built with `nice -n 10 pnpm --filter @ao/ui build`. **Chromium: 1 passed (8.9 s). WebKit: 1 passed (15.9 s).**

### 11. R529: the unverifiable change
- `StatusBanner.tsx` `txn-recovery-skipped-audit-unverifiable` gets the ruled sentence.
- The CLI detail (`repo.ts` `RECOVERY_WARNINGS["skipped-audit-unverifiable"]`) gains the same backup clause.
- The list already said "The way forward is to restore the project from a backup made before this change." It offers no act, and still does not.

Checked against the states that show this banner. They are the opening's `unverifiable` markers: the chain before the change does not verify, the anchor is past the change's start, an offset is not on a line boundary, or the old mixed shape.
- Every part is true in each, including a change that may have been finished. "Cannot undo it safely" and "a backup … is the way to undo it" claim nothing about whether it finished.

Tests, **both failed first**:
- `StatusBanner.test.tsx`: the whole sentence, and the only button is "Resolve…", even with a dismiss handler given.
- `pending-writes.test.ts` P3: the CLI detail's prefix, and no "retried" or "tried again".

## The final list of every sentence a researcher can see in this task (replaces section 2 of `task-KG1c-report.md`)

All shared ones live once in `packages/shared/src/api/interrupted-changes.ts` unless named.
- `{p}` is the project's name, always through `UserText`.
- `{f}` is a library-relative path, shown ONLY in the list and its close question, through `UserText`.
- [B] is new or changed in round B. [A] is changed in round A. No mark means unchanged since KG-1c.

**Banner of an incomplete undo, by state** (`INCOMPLETE_ROLLBACK_BANNER`; kinds `rolled-back-incomplete-write` and `incomplete-write-pending` with a state). Each has "Resolve…".
1. try-again (a step failed, nothing else): "An interrupted change in {p} could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to {p} are off until it is undone. Choose “Resolve…” to try again."
2. [B] could-not-read: "An interrupted change in {p} could not be undone completely: the app could not read a file. Nothing was lost; the app keeps what it needs to finish. Changes to {p} are off until it is undone. Choose “Resolve…” to see which file."
3. in-the-way: "An interrupted change in {p} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to {p} are off until it is undone. Choose “Resolve…” to see which file to move."
4. lost: "An interrupted change in {p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to {p} are off until you close the change. Choose “Resolve…” to see what was lost."
5. [A] unconfirmed: "An interrupted change in {p} cannot be undone completely: the copy the app kept of a file it removed is gone, so the app cannot put that file back. Something is at its place now, which may be that file, but the app cannot confirm it, so it left it as it is. Changes to {p} are off until you close the change. Choose “Resolve…” to see what is there."
6. [B] lost-and-blocked: "An interrupted change in {p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. Something else also stops the undo, and you can deal with it first: move the file the list names, or try again. After that, you can close the change as it is. Changes to {p} are off until then. Choose “Resolve…” to see what to do first."
7. [B] lost-copy-stuck: "An interrupted change in {p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. The app still keeps a copy of another file of the change, which it cannot put back either, and closing the change would let that copy go, so it cannot be closed. Changes to {p} are off. Restoring the project from a backup made before the change is the way to undo it."

**The list, per cause** (`ROLLBACK_CAUSE_TEXT`, `KEPT_COPY_GONE_UNCONFIRMED_TEXT`):

8. [A] hand-changed-file: "{f} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”."
9. path-occupied: "A file this change removed cannot be put back at {f}, because another file is there now. Move that file somewhere outside the library, then choose “Roll it back” to put the removed file back."
10. kept-copy-gone, nothing there: "The file this change removed from {f} cannot be put back: the copy the app kept of it is gone, so it is lost."
11. [A] kept-copy-gone, something there: "The file this change removed from {f} cannot be put back: the copy the app kept of it is gone. Something is at that place now, which may be that file, but the app cannot confirm it, so it left it as it is."
12. could-not-look: "The app could not read {f}, so it left it as it is. Make sure the file can be read, then choose “Roll it back”."

**The list, the next step** (`ROLLBACK_LIST_NEXT` [B]; the close hint in `PendingWritesDialog.tsx`):

13. [B] lost-and-blocked: "Deal with what is named above first, then choose “Roll it back” again. After that, you can close this change as it is."
14. [B] lost-copy-stuck: "The app still keeps a copy of another file of this change, which it cannot put back either, and closing would let that copy go, so this change cannot be closed. The way forward is to restore the project from a backup made before this change."
15. Where the close is offered: "You can close this change as it is."

**"Roll it back" answers** (`ROLLBACK_INCOMPLETE_ANSWER`):

16. try-again: "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library."
17. [B] could-not-read: "The change could not be undone completely: the app could not read a file. The list shows which file; make sure it can be read, then choose “Roll it back” again."
18. in-the-way: "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again."
19. [B] lost and unconfirmed (was 11): "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back. You can now close the change as it is from the list."
20. [B] lost-and-blocked: "The change could not be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and something else also stops the undo. The list shows what; deal with it first (move the file it names, or try again), then choose “Roll it back” again. After that, you can close the change as it is."
21. [B] lost-copy-stuck: "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and the app keeps a copy of another file of the change, which it cannot put back either. Restoring the project from a backup made before the change is the way to undo it."

**A write refused:**

22. [B] Held by an interrupted change (`RECOVERY_PENDING_TEXT`: the service's 409 and Find and acquire's `recovery-pending`): "This project takes no changes until an interrupted change is resolved. The warning on the library's main screen says what to do."
23. [B] Held until the library is opened again (`RECOVERY_PENDING_REOPEN_TEXT`: the service's 409 with reason `reopen`, and Find and acquire's new `reopen-pending`): "This project takes no changes until the library is opened again. The warning on the library's main screen says why."
24. The import's stop note (`RECOVERY_NOTE`, `space.ts`, untouched): "The import stopped because an earlier change in this project could not be undone. Do what the warning at the top of the library says, then resume the import."
25. CLI and library error (`RecoveryPendingError`, untouched): "Project {id} refuses changes until an interrupted change is resolved or its audit log is repaired. The library's integrity warnings say which, and what to do."

**A source whose change did not finish:**

26. [B] Banner (`StatusBanner.tsx`): "A change to a source in {p} did not finish and could not be undone. Choose “Resolve…” to see what can be done." / "Changes to {n} sources in {p} did not finish and could not be undone. Choose “Resolve…” to see what can be done."
27. [B] Its detail (`SOURCE_CHANGE_UNFINISHED`, `shared/api/annotations.ts`): "A change to this source did not finish and could not be undone. The app's list of interrupted changes says what can be done."

**CLI details of an incomplete undo** (`incompleteDetail`, `pending-writes.ts` [B]). Each is followed by " (transaction …)".
- The prefix at the opening: "a change interrupted before it was audited could only be partly rolled back".
- [B] The prefix in the running app: "a change that failed could only be partly rolled back".

The prefix is followed by, per state:

28. try-again: "; the marker is kept and recovery is retried on the next open". In process this is the old sentence 19, unchanged for this state.
29. [B] could-not-read: ", because the app could not read a file; the marker is kept, and recovery is retried on the next open or by rolling it back in the app's list of interrupted changes, which names the file"
30. in-the-way: ", because a file changed or put there outside the app is in the way; the marker is kept, and the roll-back completes once that file is moved away (the app's list of interrupted changes names it)"
31. lost and unconfirmed: ": the copy the app kept of a file it removed is gone, so that file cannot be put back; the marker is kept until the change is closed in the app's list of interrupted changes"
32. [B] lost-and-blocked: ": the copy the app kept of a file it removed is gone, so that file cannot be put back, and something else also stops the roll-back (the app's list of interrupted changes names it); the marker is kept until that is dealt with and the change is closed in that list"
33. [B] lost-copy-stuck: ": the copy the app kept of a file it removed is gone, so that file cannot be put back, and the app keeps a copy of another file of the change that it cannot put back either; the marker is kept, and restoring the project from a backup made before the change is the way to undo it"

**Closing (R509), in the list dialog:**

34. Button: "Close this change as it is"
35. The question, which takes the focus: "Close this change as it is?", then for each lost file "What it removed from {f} cannot be put back." [+ "It belonged to the source {title}." where the title can be read], then one of:
    - "Nothing is at that place now." (only after a look that found nothing [B]);
    - "A file is at that place now; it stays as it is.";
    - "Something else is at that place now; it stays as it is.";
    - [B] "The app could not look at that place, so it cannot say what is there now; whatever is there stays as it is.";

    then [A] "Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it."
36. Buttons: "Yes, close it as it is" / "Cancel". While busy: "Closing the change…"
37. After closing (role=status): "The change was closed as it is. Nothing was deleted, and the project takes changes again."
38. The library's refusal for a cause that may pass or can be removed: "Only a change that can never be undone completely can be closed as it is; this one can still be rolled back."
39. [B] The library's refusal for lost-and-blocked (route only; the screen shows a CONFLICT without the mark as its own fallback): "This change cannot be closed yet: something else still stops its undo. Deal with what the list names first, then choose “Roll it back” again."
40. [B] The library's refusal while the app still keeps a copy (was 25): "This change cannot be closed: the app still keeps a copy of a file it could not put back, and closing would let that copy go. Restoring the project from a backup made before the change is the way to undo it."
41. The dialog's intro, last sentence: "A change is never kept half-written, unless it can never be undone completely and you close it as it is."
42. Banner after closing (kept until dismissed; kind `interrupted-change-closed`): "An interrupted change in {p} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone: that file is lost. The closing is recorded in the audit log of {p}."
43. [A] The same where something stood at every place: "An interrupted change in {p} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone; the app could not confirm that what is at its place is that file. The closing is recorded in the audit log of {p}."
44. CLI detail of 42 and 43: "an interrupted change was closed as it was; a file it had removed could not be put back"

**FR-729:**

45. The banner button on a kept warning: "Dismiss" (accessible name "Dismiss this warning about {p}"). Its failure falls back to "The warning could not be dismissed."
46. A damaged record, banner: "The library's record of earlier warnings about interrupted changes could not be read, so some of those warnings may not be shown again. The damaged record is kept in the library's work folder." Its CLI detail is "the record of earlier warnings about interrupted changes could not be read" plus one of:
    - "; it was set aside in the library's work folder and a new record was started";
    - "; it could not be set aside and is left in place";
    - "; it is left as it is (the library is open read-only)".

    [B] It is never raised for a record of a later format.
47. Undone at the opening (kept): "An interrupted change in {p} was undone when the library opened, so nothing half-saved was kept." Its CLI details:
    - at the opening: "a change interrupted before it was audited was rolled back (transaction …)";
    - kept: "a change interrupted before it was audited was rolled back when the library was opened".

**An unverifiable change (R529):**

48. [B] Banner (with "Resolve…" only): "An interrupted change in {p} was left as it is, because its audit log could not be checked first. The app cannot undo it safely. Restoring a backup made before the change is the way to undo it."
49. [B] Its CLI detail: "an interrupted change was not rolled back because the audit log cannot be trusted to show it was uncommitted; the marker is kept, and restoring the project from a backup made before the change is the way to undo it"
50. Its list (unchanged):
    - "The app cannot confirm whether this change was finished: the audit log has no record that it was, but the log itself could not be checked in full. So it will not change anything itself."
    - "The way forward is to restore the project from a backup made before this change."
    - Its detail ends: "The app cannot confirm whether this change was finished, so it will change nothing itself. Restoring the project from a backup made before the change is the safe way on."

**Unchanged, for completeness:**
- Read-only: "An interrupted change in {p} could not be finished or undone yet. It is tried again when the library is next opened with write access."
- The read-only source banners.
- "A note left by an interrupted change in {p} could not be read. It was kept aside and nothing was changed."

## Cause combinations → banner (every one of the 128 is tested in `interrupted-changes.test.ts`)

| A copy gone (lost or unconfirmed) | In the way (hand-changed or occupied) | Could not read | Step failed, no cause, or unknown kind | Copy still kept | Banner (state) |
|---|---|---|---|---|---|
| yes | at least one of these three is yes | ← | ← | any | **lost-and-blocked** (6) |
| yes | no | no | no | yes | **lost-copy-stuck** (7) |
| yes, at least one with nothing there | no | no | no | no | **lost** (4), closable |
| yes, all with something there | no | no | no | no | **unconfirmed** (5), closable |
| no | yes | any | any | (not judged) | **in-the-way** (3) |
| no | no | yes | any | (not judged) | **could-not-read** (2) |
| no | no | no | yes (or no cause) | (not judged) | **try-again** (1) |

"Nothing was lost" (1, 2, 3) is never said where a copy is gone. Only `lost` and `unconfirmed` are closable. "Copy still kept" is judged only where it decides between `lost`/`unconfirmed` and `lost-copy-stuck`.

## NEEDS A RULING

### 1. The ruled sentence 12 is untrue where a project is held for a reason other than an interrupted change
Built for the interrupted change as ruled (22). Two other holds also refuse writes with `RecoveryPendingError`:
- an audit append that failed at the opening;
- the held resolve at an anchor mismatch, which is the brief's `afterResolved` case.

In both, "until an interrupted change is resolved" is false; in the second, the change WAS resolved. I built a second sentence (23) and a Find code `reopen-pending`, so that "the sentence shown says what to do there". Reopening is the way in both: the warning says so for the first, and the next opening records the mismatch, then takes writes, which is tested in `pending-writes.test.ts` (d).
- **To confirm:** the words of 23.
- The held case's BANNER is still the anchor kind's sentence (e.g. "…may have been changed outside the app; check the verification report."). It says why, not "reopen". I left it, so that a new warning kind is not added without a ruling.
- Proposal, if wanted, as its own kind: "An interrupted change in {p} was resolved, but {p}'s audit log may have been changed outside the app. The app records this the next time the library is opened, and changes to {p} are off until then: close the library and open it again."

### 2. The words of `lost-and-blocked` (6, 13, 20) promise the close "after that"
That is true in every case I could build: a lost file plus a file in the way, a step that failed, a file that could not be read, or an occupied place whose copy is kept.

It is untrue in one rare combination: P5's state (a folder lost, a file inside it with its copy kept) PLUS something in the way. After the file is moved, the state becomes `lost-copy-stuck`, and by I2 the banner then says so.

Options:
- (a) Keep it.
- (b) Say "After that, the list says whether the change can be closed as it is."

Recommendation: (a). The brief asks that the words say the change can be closed after that.

### 3. Sentence 24 (the import's stop note) was left untouched, as the brief says
It still says "the warning at the top of the library", the M3 point for 12. In the two non-interrupted holds it also says "could not be undone".
- Proposal, keeping the ending: "The import stopped because this project takes no changes until a problem is resolved. Do what the warning on the library's main screen says, then resume the import."

### 4. M8: naming the source where the lost place is its own folder
Done where the app knows the source:
- an encrypted project (its manifest);
- a record standing at the place (tested).

In an unencrypted project with NOTHING at the place, the source cannot be named. The project's sources are read from their folders on disk, and that folder is gone. The question then names no source. I found no other record of the id in reach (the marker holds paths only). Said plainly; no change.

## Things to know (not rulings)
- **M6:** while a record of a later format is present, this build's own new kept warnings are shown for the session only, never written. That is the cost of "never rewrite it".
- **Sentence 25:** route only. The screen shows a CONFLICT without `reason: "rollback-incomplete"` as its own fallback. Sentence 40 has no mark, so the screen shows "That choice is no longer possible…", as before for 25. Unchanged behaviour.
- **What only a real Mac can show:**
  - a permission-denied look (`could-not-look` in `lookNow` and the undo), which is tested through the seam;
  - the WebKit rendering of the new list lines, other than the end-to-end path, which ran in WebKit.

## Runs (each alone, `nice -n 10`)

**@ao/library:**

| File | Result |
|---|---|
| pending-writes | 22/22 |
| kept-warnings | 11/11 |
| rollback-words | 18/18 |
| pending-writes-close | 13/13 |
| **rollback-rerun (once, untouched)** | 30/30 |
| **rollback-hand-put (once, untouched)** | 42/42 |
| rollback-own-writes | 14/14 |
| repo | 61/61 |
| recovery-code | 27/27 |
| sources-read-race | 13/13 |
| annotations | 42/42 |
| workspace-tags | 10/10 |
| import/bulk/disk-full | 14/14 |
| retention | 23/23 |
| seams-inert | 8/8 |
| txn-completion | 9/9 |
| find/runner | 301/301 |

**@ao/library-service:**
- server.test: 157 passed, 1 skipped (158). It holds the interrupted-changes route tests; there is no separate route test file.
- find-routes: 46/46.

**@ao/ui:**
- StatusBanner: 73/73
- PendingWritesDialog: 24/24
- Library.dismiss: 4/4
- Library: 46/46
- Library.notices: 4/4
- dialogs.r145: 42/42

**Others:**
- @ao/shared: interrupted-changes 132/132.
- @ao/cli: cli.test 40/40.

**Typechecks** (0 errors each): shared, core, library, library-service, ui, cli, e2e.

**Lint:** `lint:css` clean; `lint:colours` "ok: no hard-coded colours in src/**/*.ts(x)".

**Build:** `@ao/ui build` built.

**End to end** (`interrupted-change.spec.ts`): chromium 1 passed; webkit 1 passed.

`git status --short`: empty.
