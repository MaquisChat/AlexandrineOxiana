# KG-3a — fix round report (Ruling R508)

Worktree `.claude/worktrees/kg-3a`, branch `kg-3a-service`, bf11704 → head **c4f0bf2**. Eight commits, one per point. Not pushed. `git status --short` is empty. No `git stash` was used. No permission check refused anything.

## Points

| Point | What changed (file:line at head) | Test, and whether it failed first |
|---|---|---|
| **I1 (FR-720)** 926f4f7 | `apps/library-service/src/state.ts:1017-1018`: `watchedFoldersReadAgain` returns at once while `moving` or `shuttingDown` is set. The warning stays, and the next successful read starts the watches in the library open then. The read-only condition was already there (`s.lib.mode !== "read-write"`, the opening's own condition). The comment names R508. The check sits in the restart, not in `startProjectsWatches`, because a move refused inside `quiesce` calls `activate(s)` while `moving` is still true, and that must restart the watches. | `device-notices.test.ts`, describe "FR-720 (R508 I1)". Each project has a real watched folder holding a PDF. **Move**: with `moving` set, the list GET is 200, no watch starts, both registers are empty, and the warning stays. With the move over, the next read starts both watches, the warning goes, and each file then reaches its register. **Stop**: with `shuttingDown` set, the restart starts nothing and the warning stays. **Locked**: the locked project's list is 423 and nothing starts. **Read-only**: a read-only library with the warning injected starts nothing. Move and stop **failed first** ("expected true to be false" on the watches). Locked and read-only passed before the fix, because the conditions already held. |
| **M3** 1bf9fc2 | `state.ts:156` and `:716`: a new `Session.watchStarting` map. `startProjectsWatches` (`:993`) records each project's start while it is under way. A second start of the same project (the opening's, or another restart's) waits for that start and counts it as its own. | describe "FR-720 (R508 M3)". (1) Two list reads in flight at once, every start held: 2 starts, one watch per project in `session.watches`, each file once in its register and once among its project's sources. This passed before the fix: the existing `watchRestart` guard covers it, and it had no test until now. (2) The opening's start of Q is held while P's start fails, then P's read succeeds: Q is started once and holds one watch. **Failed first**: Q was started twice (`expected 2 to be 1`). |
| **M2 (FR-718)** b594722 | `server.ts:46-47`: the existing 60 s wait for requests in flight is now the named constant `IN_FLIGHT_WAIT_MS`, with an `inFlightWaitMs` test seam (`:69-70`, `:366`). `close()` uses it both for the requests in flight (`:391`) and for `pairing.idle(inFlightWaitMs)` (`:397`). `auth.ts:418`: `idle(takeBackWaitMs?)` bounds only the takings-back; port recordings are still waited for in full. | `pairing-status.test.ts`, "FR-718 (R508 M2)". The reviewer's probe: the write is held for good, the confirm gets 503, then `close()`. **Failed first** ("still closing" after 10 s). Now the stop ends after the bound, and the pairing stays unusable (`isPairedOrigin` false, list empty). |
| **M4 (FR-717)** 9b6063a | `routes/sources.ts:295`: `GET /projects/:id/recheck` answers a locked project with 423 PROJECT_LOCKED and the existing sentence. | `project-recheck.test.ts`, "a locked project…": exact 423 body. **Failed first** (200 `{running:null}`). |
| **M5** cc5584e | (a) `sources.ts:315-321`: a recheck stopped for a move deletes its entry. Its continuation puts the entry back when it runs, then calls `run(done)`. (b) Test only; the `!cur` delete (`:324`) is unchanged. (c) **Not built**: see below. | (a) "a recheck stopped for a move gives up its entry…": the first source is held, `drainWork` stops the job as `quiesce` does, and the GET answers `running:null`. **Failed first** (the entry was kept). Then `restartStoppedWork()` brings it back as running 1 of 2, and it is gone at the end. (b) "a recheck that finds the library closed gives up its entry": three sources, the second held, the library closed, the source released, the library reopened: `running:null`. It passes with the code. **With the delete removed by a scratch edit it fails**; the edit was restored. |
| **M6** 8943e39 | `packages/ui/src/screens/Library.recheck.test.tsx` (the "answer older than the job's own end" test). There is no `setTimeout`. The route's answer waits on a promise that the test releases (also in `onTestFinished`) once the end shows. The test waits until the screen has read the answer: `running` is a getter that sets a flag in a microtask, after the rest of `ask`, which is synchronous. Then it asserts what the screen shows. | Passes. **With the `seen` guard removed by a scratch edit it fails**; the edit was restored. |
| **M7 (FR-721)** eb88e72 | `packages/library/src/registry.ts:88-117`: `backupIfDamaged` reads the list again right before the rename (after choosing the name) and sets it aside only if it is still damaged. Otherwise it returns the good list, and `update` (`:173-195`) makes the change on that list: nothing is set aside and no notice is raised. What is salvaged now comes from the text actually set aside. The comments (`:88-96`, `:153-162`) give the remaining window: for a save, the last comparison, then the temporary file written and synced, then the rename; for a setting aside, the last read, then the rename. | `registry-race.test.ts`. (1) The list is damaged at the first read and at the comparison, then the other process saves a good list: nothing set aside, no notice, A, B and C kept. **Failed first** (the good list was set aside). (2) The other process renames the still-damaged list away between the re-read and this writer's rename: no failure, only the other's `.corrupt-` copy, no notice from this writer, A and C kept. **With the ENOENT tolerance removed by a scratch edit it fails**; the edit was restored. |
| **M8** c4f0bf2 | `auth.ts:102` `PAIRING_NOT_SAVED_IN_TIME` is the one place this sentence lives. The extension shows `error.message` and does not quote it. | `pairing-status.test.ts`, "past the limit…" now asserts the new sentence. **Failed first** with the old constant. |

**M4, what the screen shows for a 423 at mount:** `RecheckProjectButton` asks at mount, and `ask` ignores a failed answer. The library screen renders the button only for a project not known to be locked (`Library.tsx:614`, `project && !locked`). So the screen shows what it already shows for a locked project: its existing locked view. Nothing new is shown.

**M5 (c), not built:** the library screen's event stream is a loop inside `Library.tsx:242-296` (`api.events({signal})`, which retries after 2 s). `LibraryApi.events` (`api/library.ts:337`) does not pass `onOpen` through, and nothing tells the recheck hook or anyone else that the stream has reconnected. As the brief says, I changed nothing for (c). After a lost end event the button stays off until the screen mounts again.

## Built differently from the ruling, or read narrowly

- **I1, "nor for a locked project":** the brief says to use the opening's conditions, through one code path. The opening starts a locked project's watches too, and the watch waits in its "locked" state, bringing nothing in until the unlock (`watch.ts` `projectLocked`/`pauseForLock`). So: a read of a **locked project's** list is refused (423, already so) and never triggers the restart. A restart triggered by an **unlocked** project's read starts a locked project's watch just as the opening does. The test asserts that this watch's state is `"locked"`. Skipping locked projects instead would leave the warning standing for as long as any project is locked, and an unlock does not start watches.

## Researcher-visible sentences, new or changed

- Changed (M8), shown by the browser extension (503 UNAVAILABLE): **"The desktop app could not save the pairing in time, so the browser is not paired. Show a new code in the desktop app and pair again."** It was "This app could not save…".
- M4 reuses the existing **"This project is locked. Its passphrase is needed."** (423). The screen does not show it (see above).
- No other sentence is new or changed.

## NEEDS A RULING

None.

## Runs (all at `nice -n 10`, one file at a time)

- library-service `src/device-notices.test.ts`: Tests 16 passed (16)
- library-service `src/pairing-status.test.ts`: Tests 27 passed (27)
- library-service `src/pairing-port.test.ts`: Tests 15 passed (15)
- library-service `src/project-recheck.test.ts`: Tests 5 passed (5)
- library-service `src/sources-list-pdf.test.ts`: Tests 5 passed (5)
- library-service `src/watched-folders-routes.test.ts`: Tests 58 passed (58)
- library-service `src/server.test.ts`: Tests 151 passed | 1 skipped (152)
- library `src/registry-race.test.ts`: Tests 5 passed (5); `src/registry-notice.test.ts`: 7 passed (7); `src/library.test.ts`: 35 passed (35)
- ui `src/screens/Library.recheck.test.tsx`: Tests 10 passed (10). The MSW "unhandled request" noise is the pre-existing noise.
- typecheck `@ao/library-service`, `@ao/library`, `@ao/ui`, `@ao/cli`: all clean
- `@ao/ui` build: ✓ built
- e2e Chromium `watched-folders.spec.ts`: 13 passed (2.3m); `maintenance.spec.ts`: 3 passed (28.4s)
- The extension: not run. Its tests do not assert the sentence.
- One time-limit failure, my own test: under load, the first run of the M3 "two reads" test timed out waiting for the file to come in. Run again alone, it passed in 6.5 s, and it passed in every later run.
- `git status --short`: empty

## Last points (R515)

Head **57d550c** (c4f0bf2 → 737ccda → 57d550c). One commit per point. Not pushed. `git status --short` is empty.

| Point | What changed (file:line) | Test, and whether it failed first |
|---|---|---|
| **N1 (FR-720)** 737ccda | `apps/library-service/src/state.ts:1057-1068` `stopWatches`: the whole-library stop is the one place where a move (`quiesce`) and a close stop every watch. It now first waits for every start of watches still under way (`s.watchStarting`, from M3), then stops. The wait is bounded by `suspendTimeoutMs`/`SUSPEND_TIMEOUT_MS` (60 s), the existing bound on the move's wait for background work to reach a safe point; no new number. At `:1185`, if a start is still under way after that bound, the move is refused with the existing sentence "Some background work could not be paused in time, so the library was not moved; try again in a moment." `quiesce`'s own rollback then restarts the watches. At `:1024`, a restart whose starts end while a move or the stop is under way leaves the warning. No new start begins once the move has begun, as already built (`:1018`). | `device-notices.test.ts` "a restart already under way when a move begins…" uses the real `POST /libraries/move`. The restart's start of both projects is held, and is released only when the move calls its whole-library stop. The move's `beforeExecuteMove` hook waits for any start still under way, as a long copy would, and then looks. **Failed first**: 2 watches running in the library being copied. Now the copy sees no watch, empty registers and the warning still there. After the move, the moved library's watches run once each, a further read starts nothing more, and each file reaches its register. |
| **N2 (R508 M5 c)** 57d550c | `packages/ui/src/screens/Library.tsx:240-257`: the event loop counts the streams opened after a drop (`reconnects`, raised at the first event of a new stream, the fresh state) and passes the count to `RecheckProjectButton` (`:624`). `components/RecheckProject.tsx:96-121`, `:148-159`: at each reconnect the control asks `GET …/recheck` again, for the job it showed when it asked. If the service says none, the job is no longer shown, the button is free, and the badges are read again (`onFinished`). If the job still runs, its progress is brought up to date. | `Library.recheck.test.tsx`, describe "R515 N2", with a `drop()` added to the test's own event stream. (1) Running 3 of 10 at mount, then the stream drops and the route says none: the button is enabled again, the status is empty and the route was asked twice. (2) The job still runs (4 of 10): "4 of 10" shows and the button stays off. **Both failed first.** The reconnect is the screen's own 2-second retry. No existing test drives that loop's reconnect, so the tests wait on the true state with `waitFor`/`findBy` (10 s limit), not a sleep. |

**What bounds a start today:** nothing of its own. A start is the read of this computer's settings file (`listWatchedFolders`; a damaged file is set aside under its lock). `watchFolder` returns at once, and its folder calls run in the watch's own `ready`, which is not awaited. So the move's existing 60-second bound applies.

**The service's stop:** `closeLibrary` clears `session` before it stops the watches, and a start that ends afterwards stops its own watches (`startWatches`' session check). Its watches are also waited for among the tracked tasks before the lock goes, so no watch outlives the stop. The close now also goes through the same bounded wait, because it uses the same whole-library stop; nothing else changed there.

**Researcher-visible sentences:** none new or changed. N1 reuses the existing move refusal above, and only when a start of watches hangs for 60 s. N2 adds no sentence: a job's status text simply empties.

**NEEDS A RULING:** none.

**Runs (nice -n 10, one at a time):**
- library-service `device-notices.test.ts`: 17 passed (17)
- `watched-folders-routes.test.ts`: in the first run, "FR-741 (2)" hit its time limit (150 s, load average 3.7) and the next test failed after it. Run again alone: 58 passed (58). That test does not touch the start or stop of watches.
- `find-routes.test.ts`: 46 passed (46). It replaces `stopWatches` in a move test.
- `server.test.ts`: 151 passed | 1 skipped (152)
- ui `Library.recheck.test.tsx`: 12 passed (12); `Library.test.tsx`: 46 passed (46)
- typecheck `@ao/library-service`, `@ao/ui`: clean
- `lint:css`: clean; `lint:colours`: ok
- UI build: built
- e2e Chromium `watched-folders.spec.ts`: 13 passed (2.0m); `maintenance.spec.ts`: 3 passed (23.6s)
