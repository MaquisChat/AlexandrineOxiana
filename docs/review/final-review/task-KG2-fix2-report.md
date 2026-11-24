# KG-2 fix 2 (R534 c): the R328 e record-read test

Branch `kg-2-find-linked`, worktree `.claude/worktrees/kg-2`. Base head e59ea20. Commit **6158143**. Not pushed.

## The extra reads' call path
I reproduced the failure: `your-library-routes.test.ts:463` expected 2 and got 4. That assertion is the read made right after the unlock. The second GET before the lock still read 0, so the extra cost is not paid at every read.

To find the extra reads, I wrapped the test's `getSource` spy for a moment and logged a stack at each read. The four reads after the unlock were:
- 2 × `judgeResting` (`packages/library/src/find/runner.ts:2679`, at HEAD). This is the opening's pass, started from `resume`, which the unlock route calls. It runs asynchronously and reads `repo.getSource(pid, e.sourceId)` directly.
- 2 × `libraryChancesOf` (`runner.ts:516`) ← `libraryChances` (`runner.ts:3024`) ← `libraryPartsOf` (`apps/library-service/src/routes/find.ts:210`). This is the view's own read. The cache had been dropped at the lock, so this read is correct.

**The commit:** 993a23b (FR-728). As a scratch edit I set `const wanting = false && restsWantingCopy(e)` in `judgeResting`, and the test passed. I then restored the file with `git checkout -- packages/library/src/find/runner.ts`.

## Root cause (proved)
FR-728 widened the opening's pass, which runs once per opening as R483 a requires. The pass now also judges the entries that rest for want of a copy: `no-open-copy` with the listed reasons, and `failed` for unreachable or unexpected. These are exactly the entries the view reads (`restsForLibrary`). The pass reads each of their records with `repo.getSource`, outside the view's record cache, which is kept by each record file's stamp. So after every opening, the first read of the queue read every such record a second time.

The other suspects were not the cause:
- The pass does not run at each read. The second and third GETs read 0.
- FR-727's `lstat` is not a record read.
- The reader's `missing` flag has nothing to do with it. Only the two paths above appear in the trace.

## The mend (`packages/library/src/find/runner.ts`)
- `RecordFacts` now also keeps the record's originals: those with role original that are not destroyed (`:391`, `:403`).
- The cache has a new method, `load(projectId, sourceId, stamp, read)` (`:419-424`, `:434-435`, `:464-486`). It returns the facts it holds for that stamp, or makes one read that every caller asking meanwhile shares. The result is kept only if the project was not dropped (locked) and the cache not cleared (closed) while the read was under way. `dropProject` and `clear` also forget reads under way (`:489`, `:494`).
- `libraryChancesOf` reads through `load` (`:546-554`).
- `judgeResting` now takes the record file's stamp (`sourceRecordStampIn`) and reads through the same cache (`:2710-2715`). A stamp of `null` is treated as `NotFoundError`, which keeps the R488 a path. The pass still judges the linked originals anew with `originalsReach(root, { assets: facts.originals })`, so it still sees a drive that has come back.

The re-judging still happens only at an opening or an unlock, never at a read. Nothing else changed. The pass still reads the records at the opening (once), and the view then finds them already read.

## Tests (`apps/library-service/src/your-library-routes.test.ts:467`, describe "R534 c …")
- **R328 e's test:** unchanged. It now passes.
- **New, at an unlock:** an encrypted project has three entries resting for want of a copy, one of whose sources has gained a stored file. Over the unlock and the first GET each record is read once (3 reads). The pass moves that entry to "in your library". The second and third GETs read 0.
- **New, at the library's opening:** the same, across closing and reopening the library.

Both new tests let the project's daily backup happen first, by unlocking or opening once beforehand. The backup reads every record and would otherwise fall inside the counted window. **Both failed first** with the old `runner.ts` in place (5 reads where 3 are right; the R328 e test also failed, 4 against 2), and both pass with the mend.

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)
- `your-library-routes.test.ts`: 35 passed (35). The three counting tests were also run 6 times in a row: 3 passed each time.
- `find-routes.test.ts`: 46 passed (46)
- `find-browser-routes.test.ts`: 44 passed (44)
- `find/runner.test.ts`: 300 passed (300)
- `find/runner.linked-missing.test.ts`: 62 passed (62). This includes FR-728's tests at the opening and at the unlock.
- `repo/review-held.linked.test.ts`: 6 passed (6). The brief gives the path as `find/`; the file is in `repo/`.
- `find/where.test.ts` (another R328 file): 87 passed (87)
- `pnpm --filter @ao/library typecheck`, `pnpm --filter @ao/library-service typecheck`: clean
- `git status --short`: empty

No route or screen changed, so no end-to-end scenario applies.

## Note
R328 e's test counts reads from the moment the unlock answers. With the mend, the 2 reads it sees after the unlock are made by the pass, and the view then reads nothing. The pass runs after the answer, because it first reads the project's rules and its queue. So the test's exact count still depends on that order, as it already did at the base: the unlock's backup reads also land after its count. It was stable over 6 runs. A robust form of the test would count reads from before the unlock. That would change the test, which this task forbids, so it is not done. Nothing needs a ruling.

## The count made certain (review I1, M1; commit ff3b6a9)
The coordinator gave leave to change the set-up of R328 e's test, but not its expectation of 2.

- **(a) Count from before the unlock.** R328 e now clears its counter before `POST /unlock` (`your-library-routes.test.ts:463`). The opening's pass and the GET share the cache, so each record is read once between them, whichever reads first. The count is still **2**.
- **(b) No backup in the window, by construction.** A helper, `noBackups(pid)` (`:206`), sends `PUT /projects/:id/backup-settings {automatic:false}`, as `server.test.ts` does. Each of the three counting tests calls it right after creating its project (`:441`, `:497`, `:527`). The backup's "due" check (`backupIfDueLocked`, and `runScheduledBackups`) returns nothing when automatic backups are off. The R534 c tests no longer depend on the backup not being due again the same day (M1). Their earlier lock/unlock and backup wait are gone.
- **(c) A true signal for the pass.**
  - `FindRunner.resume` now returns `Promise<void>` (`packages/library/src/find/runner.ts:715-719`, `:2743-2755`, `:2804`, `:2862-2867`). The promise never rejects. It settles when the opening's pass (`judgeResting`) has ended, or as soon as the opening ends without one (closed, read-only, locked, recovery pending, the rules unreadable). It does not wait for the work the opening queues.
  - `ServiceState.resumeFind` registers that promise with `track` (`apps/library-service/src/state.ts:1489-1496`), which is the set `idle()` waits on.
  - The R534 c tests now `await svc.state.idle()` instead of polling, then assert that the moved entry is in your library.
  - **The orderly stop:** `closeLibrary` (and so `shutdown`) calls `endFind` (the runner's `stopAll`) before it waits on `tasks`. The stop signal ends the pass through `guard`, and its write checks `live()`. So the stop is held no longer than before.
  - **A lock:** a lock calls `stop`, which ends the pass the same way. The existing tests for a lock or close during the pass passed: `runner.linked-missing.test.ts` 62/62 and `runner.test.ts` 300/300.

**Failed first:** with `state.ts` restored, the two R534 c tests failed after `idle()` (`expected 'no-open-copy' to be 'in-library'`).

**The reviewer's experiments, each a scratch edit restored afterwards with `git checkout --`:**
- With 300 ms added before the unlock's answer (`routes/projects.ts:165`), the three counting tests passed with their exact counts.
- With 300 ms added in `libraryPartsOf` before `libraryChances` (`routes/find.ts:210`), the three counting tests passed with their exact counts.

**Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`):**
- `your-library-routes.test.ts`: 35/35, five times in a row
- `find-routes.test.ts`: 46/46
- `find-browser-routes.test.ts`: 44/44
- `capture-queues.test.ts`: 30/30
- `server.test.ts`: 151 passed, 1 skipped
- `runner.test.ts`: 300/300
- `runner.linked-missing.test.ts`: 62/62
- Both typechecks: clean
- `git status --short`: empty

The file took between 17 and 32 s across runs, depending on the machine's load; the base took about 20 s.
