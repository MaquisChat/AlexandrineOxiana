# FR-749 — review 3: R554's piece and R555's mends (db8623b..e3ecd40), with the R558 c mend

Reviewer: adversarial, checkout `.claude/worktrees/kg-1-look` (detached at e3ecd40, then branch `fr-749-retry-stamp`).
Read: the review rules, R554, R555, R558, R138, R147, R247, the builder's report, and the whole diff (`retention.ts` with `-w`).

## Verdict on the six commits: APPROVED WITH SMALL POINTS, once the R558 c mend below (cabcce3) is in.

R554 holds wherever I cut it: no backup is reported as removed while its file is still there, no failure is recorded because of a close, and nothing under the library changes after `close()` resolved. R555 1, 2, 3, 4 and 6 hold, and each guard has a test that fails without it.

One Important finding is NOT in these six commits' lines: it is older code that point 1 (f) asked about (I2 below). It should be mended before the join, or ruled on.

## Findings

### Critical
None. I looked for the worst case, a backup certified gone while its file is still there. The only record of a removal is the amendment and its audit event. They are built from `r.removed`, and `removeHoldingBackups` adds a file to that list only after `shredPath` succeeded. A cut anywhere before the amendment's turn begins means no amendment at all. After the amendment is committed, nothing throws `StepCutByClose`: the refused report event is swallowed, so a committed amendment is never followed by a cut. `noLongerPresent` is written only for files found missing. I checked this by reading the code, and by probes P-b and P-f below and the five existing closing tests.

### Important

**I1 — R558 c confirmed (the known defect; now mended in cabcce3).**
- Where: `packages/library/src/retention.ts:750–767` at e3ecd40.
- What: the stamp of an attempt was written only when the attempt ended. An attempt that crashes the app leaves no stamp, so every next opening tries it again at once.
- Probe: a destruction whose listed backup could not be removed. One hour later, every attempt crashes at `before-removal-record`. The repository is reopened three times on the same clock, and each time a pass is run:
  - at e3ecd40: `[-1, -1, -1]` (it crashed at every opening);
  - with db8623b's `retention.ts`: `[-1, 0, 0]` (after the first crash, not due).
- What the stamp before the attempt protected: the back-off (`retryDue` reads `lastAttemptAt`), so an attempt that kills the process is not repeated at every opening. It does not protect the once-a-day fresh backup: `lastFreshAt` is written only when the attempt ends, at db8623b as now.

**I2 — a close during the destruction's own change is answered "nothing was changed", although the raw data was destroyed and certified.**
- Where: `retention.ts:433` (older than db8623b, but this is R554's case (f)); `apps/library-service/src/errors.ts:129`; `routes/governance.ts:234–237`; `GovernanceSettings.tsx:1110`.
- Probe P-f:
  - The destruction's change was held at the `retention` folder's mkdir (`seams.beforeMkdir`), the library closed from outside, then the change released.
  - The change committed: one `retention.destroy` audit event.
  - The report event that follows it (`appendLibraryEvent(... "retention.destroyed" ...)`, a second turn) was refused, so `destroyRaw` rejected with `LibraryClosedError`.
  - The folder after `close()` resolved was byte-identical to the folder once everything had settled.
  - The next opening's pass completed the step.
- The route maps the error to 409 `LIBRARY_CLOSED`, "That library has been closed, so nothing was changed." (by reading). The page shows that sentence for a destruction that happened. The route also calls `forgetDestroyed(ended)`, so the players are told the files were not destroyed.
- This breaks R554's "nothing is reported … because of the close", in the opposite direction.
- Direction: after `destroyProjectAssets` has committed, a refusal of the report event because of the close (`cutByClose`) is not an error. The change's own audit event is the authority (R147). Return the destruction as it stands, with status `pending`, as is already done for a cut step.

### Minor

**M1 — writes under `Backups/` after the lock's release, outside the one state writer.** Older code, by probe. R555 4 covers only the state file; R247 c covers everything.
- Where: `export/backup.ts:350–373` (`loadManifest` rebuilds and writes the manifest) and `:1086` (`settlePending` → `discardArchive`).
- Probes, after `close()` resolved, `listBackups(repo, …)` on the closed library:
  - with the manifest missing, it wrote `Backups/backups-manifest.json`;
  - with a pending record of an interrupted backup, it removed that backup's `.tmp-…` archive. Its own state write was refused, so the pending record stays while the file is gone.
- When this can happen: only through a caller still holding the old repository after the close, such as a request that was still in flight.
- Direction: refuse the manifest's writes and `settlePending` on a closed library, as `editStateNow` does.

**M2 — a guard with no test of its own.** `retention.ts:821`: `if (cutByClose(err) || cut()) throw new StepCutByClose()` at the fresh backup. With it taken out, all five closing tests still pass: the `stopIfCut()` right after that block stops the step before `freshFailed` can be recorded. This is harmless, since that guard is redundant, but the line is not held by a test.

**M3 — a test that now proves nothing more.** `apps/library-service/src/close-during-attach.test.ts:190`: with the 100 ms wait removed, the second snapshot is taken straight after the first. The report says so, and no idle signal remains after the service's stop. It is not a loosened expectation, only a check of the same state.

**M4 — "put back byte for byte" has one edge case** (mend; by reading). When a retry pass runs with no state file at all, the stamp creates the file, and putting the record back leaves a file holding empty records. A cancelled backup's take-back of its pending record behaves the same way. This needs a state file removed by hand, because any backup creates the file.

**Seen, older, out of scope.** `writeQueueTurn` (`repo/repo.ts:1551`) and `assertWritable` (`repo/state.ts:266`) still use `holdsTurn()`, under which a stale callback counts as inside a turn. R555 2 changed only the close check, as ruled.

## Points 1–6

| point | verdict | note |
|---|---|---|
| 1 the step at a close (R554) | partly | (a) The folder is byte-identical after `close()` at every cut the tests and my probes reach: fresh backup, between removals, last removal, retry, inherited list, and the destruction's own change. (b) The next opening completes the step with one amendment. An unlisted backup of the same project, one of another project, and the cut pass's fresh backup are untouched; nothing is removed twice; a backup removed before the cut is recorded as "no longer present" with nothing left outstanding (probe P-b, three listed backups). (c) Nothing is certified gone while still there. (d) R138 e's own test in `retention.test.ts` is unchanged and passes. (e) `StepCutByClose` is caught at all three call sites; the CLI does not call these. (f) Does not hold for a close during the destruction's own change: see I2. |
| 2 the retry stamp (R558 c) | did not hold → mended | I1; commit cabcce3 |
| 3 the state file (R555 4, R558 a) | holds (for the state file) | A write queued behind a held write is refused when its turn comes, and the close resolves after the first write. A stale callback of a waited backup is refused after the close. The two tests with a held pass pass. Callers swallow the refusal and record nothing. Other writes under `Backups/` (the manifest, `settlePending`) are not gated: see M1. |
| 4 the close checks (R555 1, 2) | holds | The two earlier probes pass. Also refused: a nested turn (`writeQueueTurn` inside a change), a second change queued by the first when it runs, and a timer that fires while the change runs. Goes through: a stale callback while another change B runs (it waits for B), and a change of library A closing library B. |
| 5 the page (R555 3) | holds | Both branches are tested: `LIBRARY_CLOSED` shows its own sentence and keeps the draft or the edits; the old 409 tests pass unchanged (65 and 53 tests). The sentence is service text, rendered as a text node. |
| 6 the tests | holds | Planted faults, each restored: the per-removal cut taken out → the "between two removals" test fails; the state writer's refusal taken out → all three state-closing tests fail; the two close checks swapped back → test 1 fails; `inRunningTurn` → `holdsTurn` → test 2 fails. See M2 and M3. |

## What I could not judge
- A close that lands while the amendment's change is in its turn. I found no seam to hold that turn, so I read it: the amendment commits; the notes and retry-record writes are allowed (waited work); the report event is refused and swallowed; the amendment is returned. That is true.
- The service-level answer for I2 (route and page) is by reading only. The engine side is by probe.
- No end-to-end run.

## The mend (R558 c) — branch `fr-749-retry-stamp`, commit cabcce3 (from e3ecd40)

**Tests first** (`packages/library/src/retention-closing.test.ts`, a new describe, "the retry record's stamp of an attempt (FR-749, R558 c)"):

(i) "an attempt that crashes the app leaves its stamp on disk …". At e3ecd40 it failed: `expected undefined to be '2026-12-02T11:15:00.000Z'` (the `lastAttemptAt` of the crashed attempt was not on disk). It then checks:
- two more openings a minute apart return `[]`, so the attempt is not made again;
- after the hour, the step completes (`deleted`) and the retry record is gone.

(ii) "a retry pass whose fresh backup is cut by the close …". The destruction's fresh backup is made to fail, so a retry a day later makes one; that retry's fresh backup is held, then the library closed. It checks:
- the state file is byte-for-byte as it was;
- the folder is identical after `close()` and after the pass;
- no step event is written;
- the next opening, one minute later, is due at once and completes the step.

At e3ecd40, (ii) passed, since that code never stamped. With the mend, it fails when the put-back line is removed (checked), as do the existing tests 4 and 5.

On my first draft of (ii): its "no new audit event" assertion was wrong, because the cancelled fresh backup's own decision is audited (R551 I2). It now counts step events only.

**Changed** in `packages/library/src/retention.ts`:
- `:749–761` — the stamp is written before the attempt again, as at db8623b.
- `:762–769` — on `StepCutByClose`, the record is put back to `before` (`setRetentionRetry(repo, key, before)`). This runs inside the step's `inFlight` work, so the close waits for it (R558 a).
- A crash (`SimulatedCrash`) or any other error leaves the stamp. The e3ecd40 "write the stamp on failure" path is removed.
- `:862, :883` — `noted` is restored in the "changed nothing" path.

No existing assertion needed to change. Test 4's `stateFile()` equality and test 5's still hold, through the put-back.

**Run** (each file alone):
- retention-closing 7/7;
- retention 23; retention-confirm 3; retention-old-copies 40;
- export/retention-r147 37 (the R147 crash tests, unchanged); retention-restore 9; retention-check-unmade 1;
- backup-state-closing 3; backup-closing 5;
- `pnpm --filter @ao/library typecheck` clean;
- probe P-stamp after the mend: `[-1, 0, 0]`.

`git status --short` is empty; all probe files are deleted. Not pushed.
