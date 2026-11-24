# RE-9a — adversarial review of 78430fe (Ruling R497 c)

Worktree `.claude/worktrees/re-join-trial`, branch `re-join-trial`, commit 78430fe on 99b3642. Reviewed: the diff, the action and showing routes (`apps/library-service/src/routes/watched-folders.ts`), the engine's acts (`packages/library/src/import/watch.ts`: `LiveWatch.exclusive`, `flush`, `act`, `registeredEntry`, `bringInNewVersion`, `settleWatchedFile`, `stopWith`, `origins`), the error mapping (`apps/library-service/src/errors.ts`), the session close path (`apps/library-service/src/state.ts`), and the three new tests.

## Verdict: APPROVE WITH SMALL POINTS

The mend does what R497 c asks. An origin shown from the running watch's memory can now be acted on by both acts. Each act still goes through the engine unchanged: governed, audited, one change. The register on disk ends up as it would have. I found no Critical and no Important finding.

## What I ran (nice -n 15, one file at a time)
- Probe `apps/library-service/src/watched-folders-routes.probeRE9a.test.ts`: a copy of the route test file plus three probes, run with `-t PROBE`. All three ran; the file is deleted.
- `src/watched-folders-routes.test.ts` (library-service): 56 passed.
- `src/import/watch.test.ts` (library): 143 passed. FR-475's tests in both files pass.
- `git status --short`: empty at the end.

## Findings

### Critical
None.

### Important
None.

### Minor

**M1. A failed register write makes the claim "writes its lines first, then reads" false. The act then answers with a sentence that does not say what happened.**
- Where: `watch.ts:967-995` (`flush`) catches the write error, keeps the lines and returns normally. `LiveWatch.exclusive` (`watch.ts:2538-2551`) then goes on to `registeredEntry` (`watch.ts:2749-2755`). That function finds no line on disk and throws `InvalidInputError`.
- Probe a: `recordWatchedFiles` throws "disk full" on the origin shown "changed" from memory. Results:
  - Both acts answer 400 "This file is not in the watched folder's register."
  - Nothing is written. The source keeps 1 original.
  - Once writes succeed again, "Keep" answers 200 and the register says "settled".
- So the answer is a plain sentence, not a 500 and not a hang, and nothing is half-written. But the sentence does not say what happened. Before the mend this case answered 404 "That file of a watched folder was not found."
- The same 400 comes back for an entry the engine keeps "for this run only" (`note`, when `isRegisterEntry` fails). That entry is shown but never written.
- Direction: when the watch's lines could not be written, the act should say so in plain words (for example, the watch's "register could not be written" reason, or "try again in a moment"). Do not let it fall through to "not in the register".

**M2. The new tests hold the register back, and on any failure before the release, the test file stalls for about 60 s and then fails in its teardown.**
- Where: `watched-folders-routes.test.ts`, the helper `changedInMemoryOnly` (about :810-845) and the third test. The release (`letGo`) is called only from inside the `watchOrigins` spy.
- Suppose any `until` or `expect` fails before that spy is called (`expect(shown)…`, "the register on disk has no line yet", or a timed-out `until`). Then `afterEach` calls `svc.close()`. That reaches `closeLibrary` → `stopWatches` (`state.ts:1003-1006`, no time limit) → the watch's `stop` → `await flush()`, which waits on the held promise forever.
- Probe b: with the hold never released, `svc.close()` was "still blocked after 8 s", and closed at once after `letGo()`.
- So it is bounded by `hookTimeout` (60 s), not an endless hang. But a real failure turns into a hook time-out, `svc` is not cleared, and the next tests may fail as a result.
- Direction: release the hold in a `finally` (or in `afterEach`, for example `onTestFinished(letGo)`).
- The spies are on that test's own `repo` instance. Each test opens a new library, so nothing stays stubbed for later tests.

**M3. The "watch stops between the look and the act" case. Reading-only point; not a fault of the mend.**
- No `await` lies between `heldOrigins` and `act()`'s lookup of the live watch (`watchDeps` and the start of `settleWatchedFile`/`bringInNewVersion` are synchronous). So a stop cannot fall between the two.
- A stop that comes after the job is queued refuses it with `FolderNotAnsweringError` (`watch.ts:2501`, `2542-2543`). The answer is 503 "The folder did not answer. Try again when it is reachable." That sentence is slightly off for a stopped watch, but it was the same before the mend for lines on disk.
- Probe c: stop called during the route's own look. Result: 404 "That file of a watched folder was not found.", as before, because `stopped` is set synchronously. The stop then wrote the lines ("changed").

## Checked and sound
- **Claim 1, on the paths that work.**
  - Both acts run through `act()`, which uses `live.exclusive` when the watch is running. That function `await flush()`s before `fn` reads the register. `flush` chains onto `flushing`, so a batch write already in flight is waited for.
  - Two acts at once on the same file run one after the other as jobs of the watch. The second reads what the first wrote. For example, Bring in and then Keep gives 400 "There is nothing to settle…".
  - Project locked in between: `refuseUnwritable` or `watchRegister` throws `ProjectLockedError` → 423.
  - Library closed or read-only: `requireWritable`/`refuseUnwritable` → 409.
  - All of these are plain sentences. Nothing is half-written. Each act is the engine's one governed, audited `recordWatchedFiles` (plus the attach).
- **Claim 2, which entry is acted on.** In the watch's memory a source has at most one entry per folder. A copy of the same bytes in the same folder is not registered (`regBySource` and `holders`; see `watch.ts:1954-1982`). Taking `[0]` therefore matches what the on-disk `.find` has always done. The act carries only `watchId`, so the button's identity was never more precise than that. The mend adds no difference here. The route uses the held entry only for its `key`; the engine re-reads the line on disk after the flush.
- **Claim 3, guards.**
  - Session, project, unlocked, writable, the body checks and `sourceParam` are unchanged and come before the look.
  - `heldOrigins` → `watchOf(s, projectId, wid)` is filtered by the project's watches, and `origins(sid)` by the source. A `watchId` from another project, or a made-up one, gives `undefined` → 404, as before.
  - The answer holds only `done` and `sourceId`. No path leaks: `scrubPaths` on the 409 is unchanged.
  - The showing and the acts use the same rule: a line on disk first, else memory. The one difference is the GET's `rec.dir` condition, which the implementer noted and which is harmless.
- **Claim 4, the tests.** Judged by reading: the route's on-disk look returns before `letGo` can let the flush write, so the old code finds nothing and answers 404. All three tests therefore fail without the mend for the stated reason, and deterministically. They wait on true states (no sleep). The 50 ms polling `until` is the file's existing helper.
- **Claim 5.** FR-475's own tests pass, in the route test file and in `watch.test.ts`.

## Judged by reading only
- That the three new tests fail without the mend. I did not revert product code; the brief says to change none.
- That no `await` lies between the route's look and the act's lookup of the live watch (M3).
- That a source has at most one entry per folder in practice. A register on disk written by an older version could hold two, but then the on-disk branch is the one taken, unchanged.
