# KG-3a — second look at the fix round (R508), bf11704..c4f0bf2

Scope: the eight fix commits only. Everything below was run at `nice -n 15`, one file at a time. The probes (`*.probeKG3a2.*`) are deleted, every scratch edit is restored, and `git status --short` is empty.

**Verdict: APPROVE WITH SMALL POINTS.**
- I1, M2, M3, M4, M5 (a, b), M6, M7 and M8 are built, and each has a test.
- One gap is left over from I1 and is narrower than I1 itself (N1).
- The implementer's narrower reading of "nor for a locked project" is right and safe (judged below), but it departs from the ruling's wording, so the coordinator should confirm it.
- M5 (c) could have been built (N2).

## Findings

### Important
None. N1 is the same harm as I1, but it needs a list read to land in a much narrower window. I put it at the top of Minor; the coordinator may raise it.

### Minor

**N1 — I1 is not fully closed: a restart already in flight when a move begins still leaves watches running during the copy.** (`state.ts` `watchedFoldersReadAgain` and `startProjectsWatches`; the move's `quiesce`.)
- The new check runs only when the restart begins. The move does not wait for a start that is under way. The list GET is not counted among the requests in flight, `drainWork` covers only `startWork` items, and `quiesce` calls `stopWatches(s)` without waiting on `s.watchStarting`.
- `startWatches` re-checks only `this.session !== s`, and the session is unchanged during a move. So a start that finishes after the move's `stopWatches` leaves its watches running.
- Probe (`device-notices.probeKG3a2.test.ts`, deleted): I held `startWatches`, issued the list GET, then set `moving = true` and ran `stopWatches(s)` as `quiesce` does, then released. Output: `watches during move: [1, 1] warned: false`.
- The window is as long as one `startWatchedFolders` call, which includes the folder calls and their time limits.
- The opening's own start has the same pre-existing gap, but only right after an opening.
- Direction: `quiesce` (and close) waits for, or awaits then stops, every entry in `s.watchStarting` before `stopWatches`. `startWatches` must NOT check `moving` itself, because a move refused inside `quiesce` calls `activate(s)` while `moving` is still true. Add a test with a start held across the move's start.

**N2 — M5 (c): the screen's own event loop does know when it reconnects.**
- `Library.tsx:245-292`: each retry `listen()` after the stream drops is a reconnection, and the comment says "a fresh state arrives first".
- The recheck control lives in the same component (`useProjectRecheck`, :231). It could be asked again there, or at the first `library.state` of a new stream.
- The report's claim that `LibraryApi.events` has no `onOpen` is true. That the point "cannot be built" is not.
- The ruling's condition ("if the existing events hook says when it reconnects") is arguable either way. This is for the coordinator. The effect is small: after a lost end event, the button stays off until the screen mounts again.

**N3 — the new FR-720 tests poll** (`until(...)` loops with `setTimeout(r, 25)` in the I1 and M3 describes). They poll a true end state (register size and sources) with a deadline, not a fixed sleep. It is borderline under the "no retry" rule, and the deadline gives a clear failure. Acceptable, noted.

## Per point

| Point | Verdict | Evidence |
|---|---|---|
| **I1** | **partly** (N1) | With `moving` set: 200, no watch, empty registers, the warning kept. After the move, the next read starts both watches once, and each file reaches its register. That library is the one open at that point: after a successful move it is the moved one, adopted through `activate`, which starts its watches anyway with fresh session warnings. With `shuttingDown` set: nothing starts. Scratch removal of the check makes the move and stop tests fail (2 failed). The stop is safe beyond the flag: `closeLibrary` clears `session` before `stopWatches`, so a start finishing late is stopped by `startWatches`' own session check. |
| I1, locked / read-only | **holds as built; the departure is right** | The opening's start excludes a read-only library (`activate` runs only for read-write libraries), and so does the restart (`s.lib.mode` check). The opening DOES start a locked encrypted project's watches. Such a watch pauses (`pauseForLock`, `watch.ts:2339`): the sealed register is dropped and nothing is kept, `loadRegister` returns false while locked (:1030), register writes refused by a lock keep their lines unwritten (:994), and the researcher's acts are refused (`refuseUnwritable` :2688). It resumes by itself in `poll` at the unlock (:2363). Nothing is brought in and no line is written while the project is locked. An unlock does not start watches, so skipping locked projects would leave them unstarted, and the warning standing, until a reopen. The locked project's own list read is refused with 423, and the test proves the watch's state is `"locked"`. The ruling's stricter word would be worse. Recommend the coordinator records that reading. |
| **M3** | **holds** | `s.watchStarting` makes a second start of a project wait for, and count as, the start under way. Two reads at once give one watch per project and each file once in its register and its sources (tested). With the opening's start held, a read starts Q only once (tested). With `if (under) return under` removed by scratch edit, that test fails (1 failed, restored). A restart beside another restart is covered by `watchRestart` and by this map. |
| **M2** | **holds** | `IN_FLIGHT_WAIT_MS` (60 s) bounds only the takings-back; port recordings are still awaited in full. The stop's order is unchanged. My earlier probe is now a test: with the write held for good, `close()` ends after the bound and the pairing stays unusable (`isPairedOrigin` false, list empty). The bound's timer is cleared. 27/27 pass. |
| **M4** | **holds** | 423 PROJECT_LOCKED with the existing sentence, and nothing else told (exact body tested). The button is not rendered for a locked project (`Library.tsx:614`), and `ask` ignores a failure. |
| **M5** | **(a), (b) hold; (c) see N2** | (a) A stop for a move deletes the entry, and the continuation puts it back and runs. Tested, including `restartStoppedWork` bringing it back as running 1 of 2. A refused move (drain rollback) also brings it back through `restartStoppedWork`. (b) The `!cur` test is new; the implementer reports it fails without the guard. |
| **M6** | **holds** | No `setTimeout`: the answer is held by a promise released in `onTestFinished`. The test failed without `seen` in my first look; the implementer re-checked it on the new test. 10/10 pass. |
| **M7** | **holds** | `backupIfDamaged` reads the list again just before the rename. A good list there is used, with no set-aside and no notice. A list still damaged is set aside and salvaged from what was re-read. The ENOENT tolerance now has a test. Damaged at both reads: set aside as before. Good at the second read: kept and merged, no notice. Both are tested; 5/5 pass. If the re-read itself fails with an error other than ENOENT, `load` throws and the change fails as any unreadable list did before. ENOENT at the re-read counts as "good, empty", and the comparison before the save handles a list written after that. The comment gives the remaining window correctly. |
| **M8** | **holds** | The sentence is word for word, in one place (`auth.ts:102`). The only other copy is the test's assertion. |
| **e2e** | **believed** | The UI was built at 08:58:10, after the last commit (c4f0bf2 at 08:53:00). `.last-run.json` says passed at 09:01:12. I did not run it again. |

## What I ran
- `device-notices.test.ts -t R508`: all pass. Scratch edits, each restored: without the M3 guard, 1 test fails; without the I1 check, 2 tests fail.
- `pairing-status.test.ts`: 27 passed.
- `project-recheck.test.ts`: 5 passed.
- `registry-race.test.ts`: 5 passed.
- `Library.recheck.test.tsx`: 10 passed.
- One probe (N1), now deleted.

## Judged by reading only
- The locked-watch behaviour.
- N2.
- The refused-move path for M5.
- The M7 re-read failure.
