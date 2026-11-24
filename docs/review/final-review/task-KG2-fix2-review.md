# KG-2 fix 2 (R534 c), review of 6158143 (on e59ea20)

Worktree `.claude/worktrees/kg-2`, branch `kg-2-find-linked`. No product code changed. The probe (`packages/library/src/find/runner.cache.probeKG2c.test.ts`) is deleted, every scratch edit is restored, and `git status --short` is empty.

## Findings

### Critical
None.

### Important
**I1. R328 e's test (`apps/library-service/src/your-library-routes.test.ts:459-463`) does not count deterministically. The mend adds a new race to the one that was already there.** The test calls `reads()` (which clears the spy) right after the unlock answers, then counts the reads of one GET. The answer depends on two things that happen in the background:
- **Race 1 (new with this mend).** The 2 reads the test sees are now made by the opening's pass, which shares the cache with the GET. If the pass finishes before the unlock's answer reaches the test, `reads()` throws those reads away, the GET finds them cached, and the count is **0**. Probe: as a scratch edit I added `await setTimeout 300ms` before `return { unlocked: true }` in `routes/projects.ts`. Result: R328 e failed, **Expected 2, Received 0**. Both R534 c tests still passed.
- **Race 2 (already at the base).** The unlock's daily backup (`startWork("backup")`, which calls `getSource` about twice per record, `export/backup.ts:723,1301`) can land inside the counted window if the GET is slow. Probe: as a scratch edit I added 300 ms in `libraryPartsOf` (`routes/find.ts`, before `runner.libraryChances`). Result: **Expected 2, Received 6**.
- Delaying the pass instead (300 ms at the top of `judgeResting`) still passes. The view then reads 2 and the pass finds them cached.

In normal runs the test passed 5 of 5 times when the file ran alone. That holds only because the pass needs four or more thread-pool round trips while the inject answer needs a few ticks. The test is not deterministic by design.

**The smallest change that makes it deterministic:** count from before the unlock, and keep the backup out of the window.
1. Call `reads()` before `POST /unlock`, not after it. The total then comes to 2 whatever the order: if the pass reads first, the view finds the records cached; if the view reads first, the pass finds them cached; if both read at once, they share one read.
2. Make the counted unlock's backup not due, as the new R534 c tests already do: an earlier lock and unlock, then `until(... '"backup"' ...)`. Or `await svc.state.idle()` after that earlier unlock. `svc.state.idle()` waits for the backup, because the backup is tracked through `startWork`. It does **not** wait for the find runner's pass, which lives in the runner's own `inflight` set and has no public signal. That is why counting from before the unlock, rather than waiting for the pass, is the robust fix.

This edits a ruled test's setup but not its expectation (still 2). It is the owner's or coordinator's call, since the brief said the test stays unchanged.

### Minor
**M1. The new R534 c tests (`:476-551`) rely on the backup not being due a second time "within the day".** If a run crosses the day boundary between the first unlock or opening and the counted one, a backup falls inside the counted window. Rare, but it is a dependence on time. (Reading only.)

**M2. A slower read under way can replace a fresher entry.** Read A starts at stamp S1, the record changes, read B at S2 finishes first, then A finishes and stores S1's facts over S2's. The next read sees a mismatched stamp and reads again. The cost is one extra read; stale facts are never served. (Reading only.)

## What I checked and found sound
- **Staleness.** The cache key is `ino:size:mtimeNs:ctimeNs` of `source.json(.enc)` (`repo/sources.ts:736-737`). Every atomic rewrite changes it. Assets live in `source.json` (`getSourceRecordWithAssets`), so attaching a file, removing an original and a reconnect each rewrite it. A deleted or merged record has no folder in `st.sources`, so the stamp is `null`, which becomes `NotFoundError` (the same class as before, so the R488 a path is kept). A move to another project gives another `projectId` key. Probe: a record rewrite changes the stamp and the record is read again.
- **Linked originals are judged afresh with the cache warm.** `originalsReach` calls `missingAt` (an `lstat`) on every call (`repo/linked-file.ts:43-51`). Probes ran two `resume`s on one runner, so the second pass hit the cache (record reads stayed at 1):
  - Drive returned: a "Not this file" entry moves to in-library, with nothing asked or fetched.
  - Drive unplugged: an in-library entry moves to `linked-file-missing`.
- **The lock.** `stop()` calls `records.dropProject` (`runner.ts:2861`), and the lock route stops Find before the key is dropped. `dropProject` forgets whole entries, so the new `originals` field goes too. (For an encrypted project these are stored-file assets; linked files are refused there.) It also forgets reads under way. A result that arrives after a lock is not kept: `pending.get(k) !== mine`. Probe: with a read finishing after the lock, the locked view returns an empty map, and after the unlock the record is read afresh. A GET that started before the lock still gets its own answer, as before the mend. The pass is cut by `guard`'s stop signal.
- **Sharing a read under way.** Probe: the pass and a GET at the same time made one read. A failing read (a "damaged record") reached the GET as a rejection and the pass as "left as it is". It was not cached (the next GET read again), and a third GET read nothing. `pending` is cleared on both success and failure, so nothing stays pending unless the underlying read itself never settles, which was equally true before. There are no unhandled rejections (`guard` adds a catch).
- **R301, R303.** The pass still only moves entries between resting states. It runs only from `resume` (opening, unlock, a save of the rules), never at a read. `runner.linked-missing.test.ts` passed 62/62 and `runner.test.ts` passed 300/300.
- **Tests.**
  - `git diff e59ea20..6158143` on the test file only adds the R534 c block; R328 e is untouched.
  - `your-library-routes.test.ts` passed 35/35 in five runs, each alone.
  - With e59ea20's `runner.ts` in place, all three counting tests fail: 4≠2, 5≠3 and 5≠3.
  - The two new tests count from before the unlock or opening, wait on the real moved state (`until` polling the stored queue, which is written after every record is read), and use no sleep. They are deterministic apart from M1.

## Verdict
**Approve with small points.** The product mend is correct and safe. I1 concerns how robust the R328 e test is, not the product. Its fix is two lines in the test's setup, and that needs the coordinator's leave.
