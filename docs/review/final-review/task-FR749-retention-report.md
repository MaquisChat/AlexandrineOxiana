# FR-749, R554: a destruction's backups step cut by the library's close; and R555 1, 2, 3, 4, 6

Branch `fr-749-close-attach` in the worktree `.claude/worktrees/kg-3b`, from db8623b. Not pushed. Commits:

| commit | what |
|---|---|
| 23428ba | R554: the step stops at a close, records nothing; registered with the close's wait |
| ca5f6b2 | R555 4: the backups state file is never written once its library is closed (one writer) |
| 77dd275 | R555 1: a change that calls `close()` while another close waits for it is refused |
| 34a4efa | R555 2: only the RUNNING change counts as "closing its own library" |
| 5affbfd | R555 3: the page tells `LIBRARY_CLOSED` from "changed elsewhere" |
| e3ecd40 | R555 6: the closing tests wait for the work itself, not a fixed time |

## R554 — what the step did at a close before

The tests are in `packages/library/src/retention-closing.test.ts`. Each one failed at db8623b, with the retention mend taken out, for the stated reason:

1. **"the close comes while the step's fresh backup is held …"** (held at `backupSeams.afterSnapshot`). The cancel (`BackupCancelledError`) was taken for a fresh backup that failed. The step went on: it removed both listed backups after `close()` had resolved, and its amendment was refused.
   Failing line: the snapshot taken after everything settled differed from the one taken right after `close()`: `expected [ '.cache dir', '.tmp dir', …(20) ] to deeply equal [ …(22) ]`.
2. **"the close comes between two removals …"**. The close started while the first listed backup was being overwritten, through the existing `shredSeams.failFor` predicate, which returns false so that removal goes ahead. The second removal still happened after the close: `expected […(21)] to deeply equal […(22)]`.
3. **"the close comes during the last removal, before the amendment's record …"**. The amendment was refused and `destroyRaw` rejected with `LibraryClosedError`: `expected { …(1) } to have property "ok"`.
4. **"a retry pass cut by the close leaves the destruction's retry record exactly as it was …"**. Same fault as 2, on a `resumeDestruction` pass. The folder changed after `close()`, and the retry record had already been bumped before the cut.
5. **"an inherited list (R138 a, R175): a restored copy's pass cut by the close …"**. This is the copy's own path: `withProjectMaintenance` of the origin, with a byte-for-byte `expect`. Before the mend: `expected { …(1) } to have property "ok"`.

R138 e's own case still holds. The existing test passes untouched: `retention.test.ts` › "R92" › "I3, as R138 e changed it: a failed fresh backup no longer keeps the holding backups; they are removed and the certificate says no new backup could be made" (`backupSeams.failBackup`).

## R554 — the mend

`packages/library/src/retention.ts`:
- `settleBackups` (:712) is now a wrapper. It runs the step (`settleRun`) inside `inFlight(lib, …)`, the same registration a backup uses (`export/backup.ts` `inFlight`, now exported as package-internal). There is no second mechanism: the library's `close()` waits for the step the way it waits for a backup.
- `StepCutByClose` (:720) is internal. The step's cut test (:730) is `isClosed(lib)`, or the session's closing signal (`closingSignal(lib)`, when the work runs under one). It is checked:
  - first, before anything is read or written;
  - after the listed backups are looked at;
  - when the fresh backup is cancelled (`cutByClose(err) || cut()`, :817): R138 e is not applied, `freshFailed` is not set, and `backup-failed` is not recorded (the backup itself records nothing when it is cancelled);
  - after the fresh backup;
  - before EACH removal, through a new `step` argument to `removeHoldingBackups` (`export/backup.ts`). It is checked between files, never in the middle of one, so a removal already under way finishes;
  - before the manifest's clean-up of missing entries;
  - after the removals, before anything is recorded;
  - when the summary event or the amendment (`amendProjectDestruction`) is refused by the closed library.
  After the amendment is recorded, a refused report event (`retention.backups`, the same facts again) is skipped, and pruning is skipped while the library is closing.
- The retry record stays exactly as the pass found it. The attempt's bump (`lastAttemptAt`, `attemptsSinceRecord`) used to be written BEFORE the attempt. It is now written when the attempt ends: with its outcome (as before), as it is in the summary path, or as it is when the attempt throws. It is NOT written when the close cut the attempt (:747–764).
  One consequence: after a process crash (`SimulatedCrash`), the bump of the crashed attempt is not on disk, so the next pass is due at once. No test asserted otherwise; the R147 crash tests advance the clock an hour anyway.
- Callers:
  - `destroyRawLocked` (:453) treats `StepCutByClose` as "nothing recorded". The destruction itself is already done and its certificate written, so it returns as it stands: `amendments: []`, status `pending`.
  - `resumeLocked` (:1110) ends the pass at once (`return out`). It writes no notes and records nothing more.

## R554 — how the close waits

The close waits through `inFlight` in `export/backup.ts`. Each library's set of work in flight is registered once with `onClose`, as a drain. `close()` sets the handle closed and then awaits every drain before the lock is released. The step is in that set from the moment it is called. Its nested fresh backup is in it too.

Nothing under `Backups/` changes after `close()` resolved. Every test above snapshots the whole library folder, byte for byte, right after `close()` resolved and again after the destruction's or the pass's own promise ended. The two snapshots are identical.

## R554 — the next opening

A new `Library` and repository are opened on the same folder. `resumeDestruction` finds the retry record as it was (absent, after the destruction's own cut), so the step is due, and it does the step again:
- the fresh backup, unless one was recorded;
- the removals still owed, each listed backup at most once;
- one amendment;
- a backup that is not listed is never touched. The cut pass's committed fresh backup is kept: it is not listed.

A listed backup that the cut pass had already removed is found gone. It is recorded as **no longer present**, at the time this pass noticed it (`noLongerPresent`, status `no-longer-present`). That is how a removal whose record was never committed is recorded after a crash today (`retention-r147.test.ts`, "crash safety: a removal that was not recorded": "Recorded as removed by the app only when the app's own record of the removal was committed").

The code cannot truthfully say more. The audit log, which is the authority (R147), has no record that the app removed that file. The manifest entry the removal cleared is a convenience, and it is also cleared for a file removed by hand (`forgetMissingBackups`) or by a rebuilt manifest. See "Uncertain" below.

If the cut came after the fresh backup was made, the next pass makes another fresh backup when removals are still owed. That is the second test. The first fresh backup is a real, recorded backup, but the step's record never named it. When nothing is left to remove (the third test), no new fresh backup is made, and the amendment names none. It also says no "could not be made".

## R554 — what the certificate and the list show meanwhile

- The certificate file is as written at the destruction: `backups.status: "pending"`, `containing` = the listed backups, `deleted: []`. There is no `freshBackupFailed` and no note.
- `destroyRaw`'s answer and `listDestructions` show the same: status `pending`, `outstanding` = every listed backup, including one already removed before the cut, which is not yet verifiably gone by the audit log. There are no amendments, and the warning `destruction-backups-pending` stands.
- There is no `backup-failed` warning, no certificate line, and no `retention.backups` audit event.

This is true. The raw data was destroyed and certified; the backups step has not been recorded as done; and the audit log names nothing about the step that did not happen.

## R555 — per point

**(4) the backups state file** (ca5f6b2). Done.
- Tests: `packages/library/src/export/backup-state-closing.test.ts`:
  - "a retention pass held just before it writes the notes of the backups still to remove …";
  - "… the notes of the old copies …";
  - "a write under way when close() is called finishes before the lock is released". It also checks that a write after the close is refused.
  The pass is held at the new `retentionSeams.beforeNotes`, the write at the new `backupSeams.stateWrite`.
- Before the mend: the folder changed after `close()` (`…(13)` vs `…(14)`, twice), and the order was `['closed', 'written']`. For the first test, that failure was seen with the R554 commit's own narrow guard on that call taken out in favour of the one mechanism.
- Mend, `export/backup.ts`: `editStateNow` (:536) is the one writer. `withState`, the name reservation and prune's pending record all go through it. It refuses with `LibraryClosedError` once the library is closed. Otherwise it runs inside `inFlight`, checked and registered in the same tick, so a write being made is in the close's wait. Every caller already treats the refusal as "cannot run now", either with `.catch(() => {})` or by mapping `LibraryClosedError` to the cancel; nothing is recorded.
- **One deliberate exception, please confirm.** Work the close is ALREADY waiting for, meaning a backup or a destruction's step that began while the library was open, may still make its own state writes inside that wait. This is `waitedForByClose`: an AsyncLocalStorage set by `inFlight`, with a `live` flag so that a stale callback does not count.
  Without the exception, a cut backup could not take back its pending record. The next opening would then settle that record as an interrupted backup and show `backup-failed`, which breaks R551 I2. `backup-closing.test.ts` failed twice without it: `expected { …(1) } to deeply equal {}`.
  The exception keeps R247 c: those writes land before `close()` resolves.
- `resumeLocked`'s own guard from 23428ba is replaced by this mechanism: a plain call through the guarded writer.

**(1) M2 before M1** (77dd275). Done.
- `library.ts:465`: the `holdsTurn` check now comes before `if (ctl.closing) return ctl.closing`.
- Test: `repo/close-inside-change.test.ts` "1: an outside close waits for a change; that change then calls close() …". Before: `expected 'still waiting after 1 s' to be an instance of CloseInsideChangeError`. The test races the inner close against one second, so the fault fails the test instead of hanging it.

**(2) a stale turn context** (34a4efa). Done.
- `repo/state.ts`: the close's drain registration (:227) uses the new `inRunningTurn()`, which compares with `this.running`, as `admitsOnlyRunningTurn` does. `holdsTurn()` itself is unchanged; it has other callers.
- Tests: "2: close() from a callback set up inside a change and run after it ended goes through …". Before: `expected CloseInsideChangeError … to be 'closed'`. And "2, the true case …", which still refuses.

**(3) the page** (5affbfd). Done.
- `GovernanceSettings.tsx:240`: the conflict branch is now `status === 409 && code !== "LIBRARY_CLOSED"`. A `LIBRARY_CLOSED` answer falls to the error branch and shows the answer's own sentence, with no "Reload".
- `YourLibrary.tsx:437` (the save of the "Stay signed in" switch) and `:520` (Save): the draft is dropped and read again only for a 409 that is not `LIBRARY_CLOSED`. The sentence shown is already the answer's own (`sentenceOf`).
- Tests:
  - `GovernanceSettings.test.tsx` "R555 3: a save refused because the library was closed …". Before: `expected 'These rules were changed elsewhere — …' to contain 'That library has been closed, so noth…'`.
  - `YourLibrary.test.tsx`, two "R555 3" tests (the save; the switch's save). Before: `expected 'Zorblatt University' to contain 'DRAFTNAME'`.
- Left: `SearchSources.tsx`, `WatchedFolders.tsx` and `FindAcquire.tsx` are unchanged, as the review judged. They read again on a 409, and that read answers 503 "No library is open.", which is handled. None shows an untrue sentence.
- No new sentence. The shown sentence is the service's `LIBRARY_CLOSED_TEXT`: "That library has been closed, so nothing was changed." It is shown as text, as before; the existing branch renders `status.message` as a React text node, and the "Your library" sentence goes through `UserText`.
- Not run: the e2e spec `find-copies.spec.ts`. It only asserts that no "could not be saved | changed elsewhere" alert appears, which is unaffected, and a UI build plus Chromium on a shared machine was not justified for a 409 branch it never reaches.

**(6) fixed waits** (e3ecd40). Done.
- `backup-closing.test.ts:94` and the same pattern in my `retention-closing.test.ts`: no `setTimeout`. The second snapshot is taken after the work's own promise.
- `close-during-attach.test.ts:190`: the 100 ms wait is removed. Both the attach's answer and the stop are already awaited, and after the service's stop there is no further promise or idle signal to wait for, so the second snapshot now stands only as a check of the same state.
- `:296` `settledBatch`: the polling loop is replaced by `svc.state.idle()`. The batch's run is tracked work. The function then asserts the batch is listed and no longer in the session's registry.
- The 1-second race in R555 1's test is not a wait for a resting state: it turns a hang into a failure.

## Runs (each file alone, `nice -n 10`)

`@ao/library`. After R554, after R555 4, and again after R555 1–2 for the close-related ones:
- retention-closing 5;
- retention 23; retention-confirm 3; retention-old-copies 40;
- export/retention-r147 37; retention-restore 9; retention-check-unmade 1;
- backup-closing 5; backup-state-closing 3; backup 23; backup-r138 20; backup-governed 22; backup-manifest-d15 13; backup-read-fails 1;
- closed-reads 3; project-export-anchors-locked 2; restore-governed 72; restore-lock-state 15;
- import/in-library 32; zotero-web 92; index/index 58; integrity-confirm 5;
- repo/audit-reasons 32; recovery-code 27; restore-sealed-purposes 12; review-held 67; closed-library 6; close-inside-change 3; pending-writes-close 14; sources-confirm-bound 6;
- library 35; lookup/http-closing 7; seams-inert 9.

All passed. `repo/lock-mid-read.test.ts` is the large R404 matrix. Two earlier attempts were stopped by my own time limits. Run at the end, with all commits in place, it passed: 44 tests in 623 s.

`@ao/library-service`: close-during-attach 11, fieldwork-governance 23, media 34, server 160 (+1 skipped). The final runs are listed at the end.

`@ao/ui`: GovernanceSettings 65, YourLibrary 53; `lint:css` and `lint:colours` ok.

Typecheck: `@ao/library`, `@ao/library-service` and `@ao/ui` are clean.

## Uncertain

- **"Recorded truly" for a backup removed before the cut.** It is recorded as no longer present, not as removed by the app, as after a crash. The status then reads `no-longer-present`, whose wording says at least one listed backup "was not removed by the app". For this file that is not literally so. The code cannot tell it apart from one removed by hand without a record the cut is ruled not to write.
  If "removed by the app" is wanted, it needs a record at the removal itself (a format change), or trusting the manifest's cleared entry (a convenience). I did not do either. A ruling may want to say which.
- R555 4's exception for work already in the close's wait (above).
- The retry bump is now written at the attempt's end, not before it (above): a crashed attempt does not count for the back-off.
- With the close coming after the fresh backup is made, the next pass makes a second fresh backup when removals are still owed (truthful, one more backup).
