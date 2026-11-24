# KG-3a — adversarial review (FR-717, FR-718, FR-720, FR-721, FR-741; R503 m, n; R505 c)

Worktree `.claude/worktrees/kg-3a`, branch `kg-3a-service`, 579bdcd..bf11704 (5 commits, 19 files). Reviewed the whole diff once. Everything below was run at `nice -n 15`, one file at a time. All probes are deleted, every scratch edit is restored, and `git status --short` is empty.

**Verdict: NOT APPROVED.** There is one Important finding (FR-720 during a move), plus small points. The fix is small and local: the restart must not run while a move holds the library.

## Findings

### Important

**I1 — FR-720: a read of the watched-folders list during a library move starts every project's watches in the library being copied** (`apps/library-service/src/state.ts:1000-1012` `watchedFoldersReadAgain`, called from `routes/watched-folders.ts:627`).
- R102 N2 says nothing may change anything during a move, and the move first stops every watch (`quiesce` → `stopWatches(s)`). The server's move guard (`server.ts:304`) lets every GET through, and `GET /projects/:id/watched-folders` now starts watches as a side effect. `watchedFoldersReadAgain` checks the session and the mode, but not `state.moving`.
- The path: the warning stands (the list was unreadable at the opening), the list has become readable, a move is running, and any screen reads the folder list. The watches then start on the library being copied. They can write register lines and import new files while the copy runs. After a successful move these writes can be missing from the new copy. The GET is also not counted in `inFlightMutating`, so the move does not wait for it.
- Probe (`device-notices.probeKG3a.test.ts`, deleted): I opened a library with the list unreadable, made the list readable, set `state.moving = true` (the flag `runMove` sets after the watches are stopped) and called the GET. Output: `status 200 watches started: [true, true] warned: false`.
- Direction: refuse or skip the restart while `state.moving` (and while `shuttingDown`), and leave the warning for the next read. Add a test with the moving flag set. Also consider starting the restart without the list GET awaiting it.

### Minor

**M1 — FR-718: the pairing can come back after a restart.** If the take-back's own write fails and the service then restarts, the pairing is loaded and listed again. The `givenUp` set lives only in memory (`auth.ts:157`, `takeBack` :421-431).
- Probe (`pairing-status.probeKG3a.test.ts`, deleted): I held the confirm's write past a 50 ms limit (503), then made the take-back's write fail with EIO and released. The file then held the pairing and the list showed 0. After a restart the list showed 1, and `GET /extension/pairings` showed 1.
- No one holds the token: the 503 never returns it. So there is no working token anywhere. But a browser the researcher was told is not paired appears as paired, against R503 n / FR-718 ("must not exist afterwards").
- The implementer reported this ("Minor (deferred)"). It needs two failures in a row. Direction: record the given-up id durably (for example a `withdrawn` list in the same file, or a retry of the take-back at the next `load()`), or accept it explicitly.

**M2 — FR-718: a save that never lands now blocks the service's orderly stop for ever.** `idle()` waits on `takingBack` (`auth.ts:414`), and `takingBack` waits on the stalled `save`. `close()` awaits `pairing.idle()` with no bound (`server.ts:390`). Before this change the confirm was an in-flight request, and the stop waited at most 60 s for it.
- Probe: I held the write for good, the confirm got 503, and I called `svc.close()`. Output: `still closing after 5s`. It ended only when I released the write.
- Direction: bound the wait for the take-back at shutdown. The in-memory guard already makes the pairing unusable, and M1's durable mark would cover the restart.

**M3 — FR-720: a second start of the same project's watches can still slip in.** `watchRestart` stops two list reads from running the restart twice. But the restart can still run beside the opening's own start for a project whose opening start is still in flight. The restart picks every project not yet in `s.watches`. `startWatches` is not safe to run twice at once for one project: both calls append (`state.ts:1036`), which leaves two watches on each folder.
- This needs the list to fail for one project's read at the opening and succeed for another's. That is unlikely, and I judged it by reading only.
- The `watchRestart` guard has no test of its own: every FR-720 test issues one read at a time.

**M4 — FR-717: `GET /projects/:id/recheck` does not check whether the project is locked** (`routes/sources.ts:291`). For a locked project it answers 200, and while a recheck runs it gives the job id, done and total. That is only counts. A recheck that runs on into a lock keeps going, and its sources fail. No path and no title is told. Other reads of a locked project answer 423. Direction: `requireUnlocked`, or accept it in writing.

**M5 — FR-717: one stale-entry case and two untested guards.**
- A recheck stopped for a move whose moved copy then cannot be opened keeps its `rechecks` entry. If the researcher opens the old copy (kept until the deletion is confirmed), the project's button stays disabled until the service restarts. The report names this case. The continuation is keyed by the new root, so it never runs.
- The `!cur` delete (`sources.ts:314`) has no test. I probed it: close mid-recheck, then reopen gives `{"running":null}`, so it is correct, but no test fails without it.
- If the end event of a job the answer reported as running is lost (an event-stream reconnect), the button now stays disabled. Before this change it stayed enabled. Nothing asks the service again on reconnect.

**M6 — FR-717 UI test uses sleeps.** "an answer older than the job's own end…" (`Library.recheck.test.tsx`, about :233-245) sleeps with `setTimeout(r, 40)` in the handler and `setTimeout(r, 30)` before its final assertions. That breaks the "no sleep" rule. The guard it covers (`seen`) is real: with it removed the test fails, which I checked with a scratch edit.

**M7 — FR-721: the guard for "the other process set it aside first" has no test, and the race window is a little wider than the comment says.**
- The ENOENT tolerance in `backupIfDamaged` (`registry.ts:96-102`) has no test. With it removed, `registry-race` and `registry-notice` still pass: in test (b) the comparison step `continue`s before any rename.
- The comparison happens before `writeFileAtomic` writes and fsyncs its temporary file. So the open window is "comparison → temp write → fsync → rename", not only the rename.
- Hitting the window in the damaged-list branch is worse than in the save branch. A good list the other process just wrote is set aside as "damaged", with the set-aside notice, and its new registration then sits only in the `.corrupt-` file.
- After `UPDATE_TRIES` the writer saves over the other process's change without a word. That is acceptable and said in the code.

**M8 — FR-718 sentence.** "This app could not save the pairing in time…" is shown by the browser extension, where "This app" reads as the extension. Prefer "The desktop app could not save the pairing in time, so the browser is not paired. Show a new code in the desktop app and pair again." The rest is true, plain, and says what to do next.

## Per item

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-717 | Read-only `GET /projects/:id/recheck`; the button asks at mount; the screen's own state wins; a stale answer is dropped | **holds** (M4–M6) | Extension token: refused by `EXTENSION_ROUTES` (server.ts:128), by reading. Unknown or other project: 404 (tested). It tells only jobId, done and total. Not in `ui-only-routes`: the reason is right (that list holds routes with their own shell check, and neither recheck route has one). Mount, unmount and project change: the `live()` flag drops a late answer, no timer is left, and a failed read changes nothing. Two components each ask, which is harmless. **R505 c:** a second recheck in parallel is still possible from a second window mounted before the first job's first event, or by a direct POST. Nothing is corrupted: `recheckSource` applies a function update, so the second job's write is a no-op. Both jobs may count the same source as "changed", so each report says "1 source changed": duplicated but true. By reading. |
| FR-718 | 30 s limit; 503 with a sentence; the late write is taken back; the token is unusable from the refusal | **partly** (M1, M2, M8) | Refused from the moment of refusal: yes. `paired` is filtered at once, and `usable`/`withoutGivenUp` cover every later read and write (tested). Re-pairing while the first late write is out: the second pairing survives the first's take-back, because the take-back removes by id. Probe output: `200, list 1, paired true`. The timer is cleared in `finally`. The tests use a held write, not a sleep. M1 is the restart hole, already disclosed. |
| FR-720 | One start path; the next successful list read starts the watches; the warning clears only when all have started | **does not hold** (I1, M3) | The start path is the same code as the opening (`startProjectsWatches`). A failed start keeps the warning (tested). A read-only library is excluded. A locked project is treated as at the opening. Only the list route triggers the restart, as the report says. It runs during a move (I1). |
| FR-721 | Merge and retry on a changed file, by content; no lock file; bounded | **holds** (M7) | Comparison by full text: no mtime or inode granularity problem, and ABA is harmless. A removal by one process and an add by the other: the retry re-reads, so nothing is resurrected. The only exception is entries salvaged from a damaged list. The list's order is kept, with additions at the end. The test is deterministic: an in-read hook, no sleep. With the before-save comparison removed, test (a) fails (scratch edit). The window and "no two real processes" are honestly reported. |
| FR-741 | Full disk → existing 503 sentence; stopped watch → new 409 sentence | **holds** | Other register-write failures now take their own true mappings: a lock gives 423; EACCES/EPERM gives 409 "That file or folder cannot be written to."; read-only gives 409. None of them says "the disk is full". `WatchOrigin` shows the service's own message for any status above 0 (`refusalText`). The new sentence is plain and true, and "Try again" works because the act runs without the watch. With the `flushError` throw removed, FR-741 (1) fails (scratch edit). The e2e run happened after the last commit: the UI build at 05:44:41 followed commit bf11704 at 05:42:32, and `e2e/test-results/.last-run.json` says passed at 05:49:41. So I believe the 13/13 and did not run it again. |

**Item 6, `server.test.ts`:** with the citation styles now present, `apps/library-service/src/server.test.ts` passes: **151 passed | 1 skipped (152)**.

## What I ran
- `server.test.ts`: 151 passed, 1 skipped.
- `Library.recheck.test.tsx`: 10 passed.
- Scratch edits, each restored at once:
  - registry before-save comparison removed: race (a) fails;
  - ENOENT guard removed: all tests still pass (M7);
  - `flushError` throw removed: FR-741 (1) fails;
  - UI `seen` check removed: FR-717 UI test 2 fails.
- Probes, all deleted:
  - FR-718: take-back fails then restart (M1); re-pair during the late write (sound); close with a write that never lands (M2);
  - FR-720: list read while moving (I1);
  - FR-717: close mid-recheck then reopen (sound).

## Judged by reading only
- The extension token, wrong Host and foreign Origin on the new GET (the global hooks).
- R505 c's parallel-recheck consequences.
- M3's double start.
- The lost-end-event case in M5.
- The extension shows the 503 message: `api.ts` `call()` uses `error.message` and has no shorter timeout on pair.

## Could not verify
- Two real processes racing on `libraries.json` (FR-721).
- A real keyring or disk stall (FR-718).
- A real move with the watches started part-way. I1 was shown with the moving flag, not a full move.
