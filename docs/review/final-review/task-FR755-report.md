# FR-755 (R573, R577 (2)) — a move that fails after "close-source": STOPPED, needs a ruling

Worktree `.claude/worktrees/kg-3a`, branch `fr-755-move-failure` at 7d8d861. **Nothing changed, nothing committed**
(`git status --short` empty). Stopped under the dispatch's own rule: *"a later opening does NOT finish the move from any
folder (then the sentence cannot be true: report what it does)"*.

## 1. The fault: REPRODUCED

Service-level probe (kept outside the repository:
`/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/fr755-probe.test.ts`;
run with `pnpm --filter @ao/library-service exec vitest run`: 1 passed). Seam: `moveSeams.crashAfter = "close-source"`
(`packages/library/src/move.ts:821`) — the step's journal is written (done = `mark-old, register, close-source`), then it
throws, so `executeMove` throws after the old copy's library and index were closed. What the service says afterwards:

| ask | answer today |
|---|---|
| `POST /libraries/move` | the progress line, then the error line (SimulatedMoveCrash, as an internal error) |
| `GET /libraries` | `current: { name: "Lib", mode: "read-write" }` — the closed old library still shown as open and writable |
| a change (`POST /projects/:id/attach`) | 200 with the item `cancelled`: "The library was closed or went offline before c.pdf was attached, so nothing was changed. Attach it again when the library is open." |
| a search (`GET /projects/:id/sources?text=harbour`) | **500 INTERNAL** "Something went wrong. Nothing was changed by this request unless it says otherwise." (the closed index) |
| old copy | `MOVED.json` present |
| destination | `.move-journal.json` present, phase `switching` |

So R573's description holds exactly.

## 2. What a later opening does: it does NOT finish the move, from either folder

Proved by the same probe, continuing after the failed move:

| opening | result |
|---|---|
| `POST /libraries/open` the **destination** | 200, `mode: "read-only"`, `readOnlyReason: "move-incomplete"`, index `unavailable`; a change → 409 READ_ONLY "This library is open read-only, so nothing can be changed." The journal stays. |
| `POST /libraries/open` the **old place** | 200, `mode: "read-only"`, `readOnlyReason: "moved"`, index `unavailable`. |
| **restart of the service** (reopen at start) | no library open afterwards (no `current`, no `reopening`, no `notFound` in `GET /libraries`); the journal at the destination still there. |
| `POST /libraries/reconnect` the destination | 200, read-only `move-incomplete`, `moveIncomplete: true`, the index not rebuilt ("opened read-only"). Nothing finished. |
| `POST /libraries/move` again to the same destination (which `executeMove` would finish through `finishesSwitch` → `completeMove`) | 409 READ_ONLY — `runMove` starts with `state.requireWritable()`, and every opening of either folder is read-only. |

Why, by reading:
- `openLibrary` (`packages/library/src/library.ts:279–283`) opens a folder with `MOVED.json` read-only `moved`, and a folder
  with `.move-journal.json` read-only `move-incomplete`. Nothing in the service ever calls `completeMove`:
  `grep -rn completeMove apps packages/ui packages/shared` finds nothing outside the library package and its tests. The
  library's `reconnect` only REPORTS `moveIncomplete: { completeWith: "completeMove", destRoot }` (`reconnect.ts:754–761`);
  the route passes on `moveIncomplete: true` (`routes/libraries.ts:188`), and the page only types it
  (`packages/ui/src/api/library.ts:78`) and shows the banner words "a move into this folder has not finished"
  (`StatusBanner.tsx:79`). There is no button, route or start-up step that finishes the switch.
- The only finisher reachable in the app is a second `executeMove` to the same destination, which needs a writable
  session — impossible once both folders open read-only.

So R573's "the move's journal then finishes the switch" (at the next start) is not what the code does: after such a
failure the library stays read-only in both places for good, through the app. Nothing is lost or duplicated: the
destination holds the full, verified copy (its journal records the verification); the old copy is intact apart from
`MOVED.json`; the pending record of the old copy is in this computer's list (unfinished). Only `completeMove` (library
API, tests) finishes it.

The same holds for the other failures after close-source: a failed journal write (close-source not recorded: the
journal says `mark-old, register`), a failed `markPendingComplete` or a failed unlink in "finalize" (the journal stays,
so the destination keeps opening `move-incomplete`; after `markPendingComplete` succeeded the record is `complete`, so
`listUnfinishedMoves` no longer lists it, but `completeMove(dest)` still finds the journal and the record by id and would
redo only "finalize"). Not run separately — the code path into `openLibrary` is the same.

## 3. Why no sentence can be true now

R577 (2) asks the sentence to say *where to open it* so that the move finishes. No folder does that today. A sentence
that is true today would have to say: the move did not finish; the library is closed; nothing is lost; it opens only
read-only, at either place, and the app cannot finish the move by itself. That is not what R573 rules, so I built nothing.

## NEEDS A RULING — options

**A (recommended): the service finishes an unfinished switch when the library is opened at its new place.** In
`/libraries/open`, `/libraries/reconnect` and the reopen at start: when the folder opens read-only `move-incomplete`, or
`moved` with `movedTo.unfinished` (this device's record), the service calls `completeMove(newRoot, deps, env, { tz })`
(the old copy's library is not open: its lock was released by close-source; `completeMove` redoes "register", skips what
is done, and audits at the destination through its own open), then opens the new place read-write and adopts it. Then
(a)–(d) of the dispatch can be built as written, and the sentence is true:

> "The move did not finish, so the library has been closed. Open it at its new place, {newRoot}, and the move will be finished then; nothing is lost."

(`{newRoot}` through `UserText` on the page; `scrubPaths` keeps it out of recorded text.) Opening the OLD place would
then either redirect to the new one or open read-only `moved` as today — a choice for the ruling; I would make the old
place finish it too (its record names the new place), so that the sentence can say "Open the library again" without a
path. Size: one more step in the open paths plus tests (fresh/old/restart), beyond "the route's failure path and a guard
for index reads" — hence this stop.

**B: the route finishes the switch itself, at once, in its failure path.** After a failure with the old library closed
(`isClosed(s.lib)`), call `completeMove(dest, …)` once; if it succeeds, carry on as a successful move (open the new place,
adopt); if it fails again (disk still full), close the library and say so. Smaller, but it does not help after a
restart, and the sentence for the second failure still has no folder that finishes the move — so B needs A, or a
sentence that admits the app cannot finish it.

**C: build only (a) and an honest sentence**, e.g. "The move did not finish, so the library has been closed. Nothing is
lost, but until the move is finished the library opens only read-only, at either place." — true, but leaves the
researcher with a read-only library and no way forward in the app (Important stays open).

Minor 2 (the window in a successful move) and Minor 4 (the comment and `MoveOptions.index` text) are independent and
small; not built because the item was stopped as a whole. Minor 3, by reading (`task-N12-look.md`): a RESUMED switch runs
no checkpoint, so an index written since the restart is folded into the old copy's `library.sqlite` when it closes, the
two differ, and `deleteOldCopy` keeps that one file (fail-closed) — note that with the finding above, a resumed switch is
only reachable through `executeMove` to the same destination from a writable session, i.e. after a crash of the PROCESS
before the old copy was marked/closed (the old copy then still opens read-write), not after FR-755's failure.

## Runs
- the probe above, `@ao/library-service`: 1 passed (exploration; not committed).
- Nothing else run: no code changed.

## Uncertain
- Why the reopen at start left no library open (no `notFound` either): not traced; the last opening before the restart
  was the old place, read-only `moved`.

---

# Part 2 — built under Ruling R578 (25 November 2026)

Branch `fr-755-move-failure`, three commits on 7d8d861 (not pushed):
- **01e32e7** the engine: `finishMoveAt`, the guard in `completeMove`, the seams, Minor 4;
- **6042e88** the service: the route's failure path (a), finishing at an opening (1), the old place's field (2), Minor 2, the shared sentence;
- **9b1a1fa** the page: the move dialog's sentence, the banners.
`git status --short` empty; nothing left running.

## The sentences, word for word

1. **The move's answer (R578 (3))**, `packages/shared/src/api/library-move.ts` (`moveNotFinishedText`, `moveNotFinishedParts`, reason `MOVE_NOT_FINISHED_REASON = "move-not-finished"`, code 503 UNAVAILABLE):
   - in the dialog: "The move did not finish, so the library has been closed. Open it at its new place, {newRoot}, and the move will be finished then; nothing is lost." — `{newRoot}` is the folder the dialog asked for, inside `UserText`;
   - in the service's answer and in the kept last failure (`move/status`), with no path: "The move did not finish, so the library has been closed. Open it at its new place, and the move will be finished then; nothing is lost."
   The four claims, each tied to a test in `apps/library-service/src/move-finish.test.ts`:
   - *did not finish*: the journal is still at the new place, phase `switching` (the "failure at …" tests check `switch.done`);
   - *closed now*: `GET /libraries` has no `current`; a change and a search answer 503 LIBRARY_OFFLINE "No library is open." (first test);
   - *where to open it*: `POST /libraries/open` with the new place → read-write, the move finished (every failure test, `assertWholeAtNewPlace`);
   - *nothing lost*: both sources at the new place, the search finds them, one `library.move` audit event, the old copy marked and intact (`assertWholeAtNewPlace`; the first test compares every file of the old copy with the new place byte for byte).
2. **An opening that finished the move** (session warning `move-finished-at-opening`, shown once in the library's banners, `StatusBanner.tsx`): "The move of this library to this folder had not finished. It was finished when the library was opened here; nothing was lost."
3. **An opening that could not finish it** (read-only as before; warning kind by cause):
   - `move-not-finished-disk-full`: "The move of this library to this folder has not finished, and it could not be finished now because the disk is full. The library is open read-only and nothing was lost; opening it again will try again."
   - `move-not-finished-not-writable`: the same, with "because this folder cannot be written to";
   - `move-not-finished-in-use`: the same, with "because the library or its old copy is open on another computer";
   - `move-not-finished`: the same, with "because a step of it failed".
   The service's detail is never shown (as for every warning).
4. **The old place of a move that has not finished** (R578 (2); read-only banner, `moveUnfinishedTo` from the service, the whole sentence inside `UserText`): "Read-only — this is the old copy of a library whose move has not finished. Open the library at its new place, {newRoot}, and the move will be finished then; nothing is lost." A finished move's old copy keeps today's "Read-only — this is the old copy of a library that was moved. Changes are off."

## What was built, file:line

- `packages/library/src/move.ts`
  - `:831` `completeMove` refuses a folder that is not the record's `newRoot` for the record's library. Before this, `completeMove` on a copy of the new place made by hand, with its journal, "finished" the move AT THE COPY: it registered the copy as the library's place and audited there. The test failed first ("promise resolved instead of rejecting").
  - `:848` `finishMoveAt(dest, deps, {tz, actor})`. It returns undefined and writes nothing unless all of these hold: the folder has a switching journal; this computer's old-copies list has the journal's record (`pendingId`); the record's `newRoot` is this folder and its `libraryId` is the journal's; and the old copy is marked. "Marked" means `mark-old` is recorded in the journal, or, for a whole-library move, the old copy's `MOVED.json` names this library. If the old copy must be marked again, it takes the old copy's lock first (`takeOldCopyLock`, `:880`). That lock is refused when another computer or process holds it, and also when THIS process holds it (a library still open here: taking over its lock would end that hold). The engine then opens the new place read-write ignoring the journal, which takes its lock. A new place held by another computer is refused with the new refusal `in-use`; a new place that cannot be written gives `read-only`. Then it opens the repo there and runs the remaining switch steps with that repo (`destRepo`), so audit-move and finalize run under the new place's lock. Every lock is released at the end.
  - The mark-old step (`runSwitch`) writes into the old copy only under the source's lock (its own handle, when this process has it open read-write), or under the lock finishMoveAt took, or under one taken for that step.
  - `:240` the seams `moveSeams.fail`: a simulated full disk at the journal's write after a named step, at the record's marking, and at the journal's removal.
  - Minor 4: the `MoveOptions.index` description (`:166`), and the close-source comment (`:962`), which now says what a resumed switch does.
- `packages/library/src/index.ts` exports `finishMoveAt` and `isClosed`.
- `apps/library-service/src/state.ts`
  - `:372` `finishUnfinishedMove(root)`. It runs only when the folder has `.move-journal.json` and no `MOVED.json`. It calls `finishMoveAt` and never throws. A second opening of the same folder waits for the first finishing (`finishing` map) and has nothing more to tell.
  - `openLibrary` calls it first: the open route, the reopening at start and the move's own opening of the new place (where there is no journal any more, so it does nothing). The note travels with the opened handle (`openingNotes`, a WeakMap) and becomes a session warning in `adopt` (`:822`): shown for that session, once.
  - `:732` Minor 2: `requireSession` refuses with MOVE_IN_PROGRESS while `moving` and the session's library or index is closed. Outside a move, and before close-source, reads are unchanged.
  - `:1817` `moveUnfinishedTo` in `libraryState()`.
- `apps/library-service/src/routes/libraries.ts`
  - `:52` `moveUnfinishedTo` in `libraryView`.
  - `:188` reconnect finishes first and passes the note on.
  - `:350` the move's failure path: when `state.session === s` and the old library is closed or its old copy carries `MOVED.json`, the route:
    - keeps the paused imports for the new place (`resumeWhenOpened(dest, paused, oldRoot)`, as after a move whose new place could not be opened);
    - calls `closeLibrary()`;
    - answers the sentence and keeps it as the last failure.
  - `closeLibrary` on a library the move already closed is sound: `close({ beforeRelease })` gets the first close's promise, and the index was already closed. Every test runs it and none hangs.
- `packages/ui`: `screens/MoveLibrary.tsx` (`failedWith`; the sentence from the stream's error line and from `move/status`; never "stays where it was" for this reason); `components/StatusBanner.tsx` (the warnings and the moved/unfinished banner); `api/library.ts` (`moveUnfinishedTo`).

## Deviation from the dispatch's (c), deliberate — please confirm
"A move that fails BEFORE close-source keeps today's behaviour exactly" is kept for every failure before the old copy is MARKED. It is not kept for the narrow span between "mark-old" and "close-source": the register step fails, or the journal's write after mark-old fails, which the seam `{at:"journal", after:"mark-old"}` simulates. There the library is now closed too, with the same sentence.

The reason: today the old library carries on there, and changes are written into an old copy that already carries `MOVED.json`. Once finishing at the new place exists, those changes would be lost: the new place becomes the library, and the old copy can later be deleted. The sentence is true there, as the test shows: opening the new place marks the old copy again under its lock and finishes the move.

## The states of the journal after a failure, and what `finishMoveAt` does from each

| failure | journal `switch.done` on disk | old copy | what the opening of the new place does | test |
|---|---|---|---|---|
| crash/stop after "mark-old" | mark-old | `MOVED.json`, lock released | register, close-source (nothing to close), audit-move (under the new place's lock, through its repo), finalize (record complete, journal removed) | engine `stopped after "mark-old"`; service `the service ended after "mark-old"` |
| journal's write fails after mark-old | (none) | `MOVED.json` | the marker names this library → takes the OLD copy's lock, writes the marker again (the only write into the old copy), releases it; then as above | service "a failure once the old copy is marked, before it is closed"; engine "marked but not yet recorded" (refused with the lock held elsewhere, byte for byte) |
| after "register" | mark-old, register | marked | register again (idempotent), audit-move, finalize | engine + service `"register"` |
| after "close-source" (the seam) | mark-old, register, close-source | marked, its index closed | as above | service first test, `"close-source"`, reconnect, two openings |
| journal's write fails after close-source | mark-old, register | marked, closed | register, close-source (no handle: nothing), audit-move, finalize | service `failure at "journal"` |
| the record's marking fails | …, audit-move | marked | register, finalize | service `failure at "mark-complete"`; engine "a step that fails while finishing" |
| the final unlink fails | …, audit-move (record already complete) | marked | register, finalize (marking a no-op, unlink) | service `failure at "unlink"` |
| switch stopped before the old copy was marked (journal says switching, no marker) | (none) | unmarked: still the library, opens read-write | nothing: undefined, nothing written; the new place opens read-only `move-incomplete` as today | engine "an old copy not yet marked" |

What it never finishes, writing nothing (returns undefined, the folder opens read-only as today):
- a copy of the new place made by hand, journal and all (the record's `newRoot` differs). Tested in the engine and the service, every folder byte for byte.
- a move this computer has no record of: a library brought from another computer, or a different config folder (tested in the engine).
- a folder that opens read-only for another reason before the journal is looked at: a newer format, or `MOVED.json`.

It is refused, writing nothing in either folder, when the new place is held by another computer (engine; service `move-not-finished-in-use`) and when the old copy must be marked and another holds its lock (engine). The service has no "read-only start"; the read-only cases it has are those above.

Two openings at once: one finishing, shared. Tested: one `library.move` event, read-write.

Finishing that fails (a full disk at the journal's write after register):
- the library opens read-only `move-incomplete` with the disk-full words;
- the journal, the old copy and the new place are byte for byte as before;
- the next opening finishes the move (service test).

One caveat: a read-write opening of a place appends that place to `library.json`'s location history when it is not already the last entry. Here the new place's folder has the old one's name, so nothing changed. In the engine test (folders "Src" and "Dest") that line is the one change besides the steps that completed, and audit-move's own opening writes it on every move.

## Locks held, when
- During `finishMoveAt`: the NEW place's lock for every step (opened read-write), and the OLD copy's lock only while it is being marked again. That lock is taken before the new place is opened, so a refusal comes before anything is written.
- audit-split (split moves) opens the old folder itself, as today (`auditIn`: its own lock, outbox otherwise).
- In a fresh move nothing changed: the source's own handle holds the old lock.
- The finishing in the service runs before the folder's normal opening. After it, every lock is released, and the normal opening takes the new place's lock again.

## The reopening at start
- The probe left no library open because `createService` never calls `reopenLast`; only `main.ts` does (`main.ts:102`). In the real app the reopening opens `lastKnownPaths[0]` of the remembered library.
- After a failure at or after "register", the record names the new place first, so the reopening at start finishes the move (test `"register"`, `"close-source"`, calling `reopenLast()`).
- After a stop between mark-old and register, it names the OLD place first. That opens read-only "moved" with the sentence naming the new place, and opening the new place finishes the move (test `"mark-old"`).
- That is the smallest true behaviour; the reopening was not redirected.

## Minor 2, 3, 4
- Minor 2: built, as above (test "a search answers the plain 'being moved' refusal": before the mend 500 INTERNAL, after it 503 "The library is being moved. Try again when the move has finished.").
- Minor 4: built (comments only).
- Minor 3, what a resumed move leaves behind today: a switch resumed by `executeMove` → `completeMove` in a process that has the old library open runs no checkpoint. The index that process wrote since its start is folded into the old copy's `library.sqlite` at close-source, so the old and new copies differ in that one file, and `deleteOldCopy` keeps it (fail-closed). `finishMoveAt` has no source handle and no index, so it closes no index and leaves nothing behind.
- Minor 5: not built.

## Not done / uncertain
- A finished-at-opening move gives the old copy no confirmation token in the service, because there is no move dialog to offer it. The old copy is kept and marked, its record complete: exactly as after a normal move whose dialog was closed. Its deletion goes through the existing old-copy paths (retention).
- A split move whose marking is not recorded in the journal is not finished (judged by the journal alone); it opens read-only as today.
- A stop in the milliseconds between the switching journal's write and the old copy's mark leaves the new place read-only for good, as today. The old copy is still the library and opens read-write. Finishing there would need to check that the old copy was not changed after the verify; this was not built.
- Real process death was simulated by the crash seam plus a new service on the same config folder. With real death the old lock stays behind, but `isStale` treats a dead process on the same host as stale.

## Runs (each file alone, `nice -n 10`)
- `@ao/library`: move.test 88 passed (11 new; the completeMove guard seen failing first); reconnect.test 54 passed.
- `@ao/library-service`:
  - move-finish.test 15 passed (new; 14 failed first against the old service code, each for its reason);
  - open-library 26, close-during-attach 13, lock-during-change 3, server 160 + 1 skipped;
  - transcription-jobs 40, zotero-sync-scheduler 43, library-audit 11, capture-queues 31, device-notices 17, zotero-sync-routes 43, find-routes 47, fieldwork-governance 23 — all passed.
- `@ao/ui`:
  - StatusBanner.test 78 (2 new, failed first); MoveLibrary.test 28 (2 new, failed first);
  - LibraryChooser.test 24, LibraryChooser.notices 5, Library.test 48, Library.notices 4, dialogs.r145 42, pathFields.shell 5 — all passed.
- Typecheck: `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/cli`, `@ao/ui` clean. `lint:css` and `lint:colours` clean.
- End to end: `@ao/ui` built, then `maintenance.spec.ts` in Chromium: 3 passed.

---

# Fix round (R583)

Branch `fr-755-move-failure`, seven commits on 9b1a1fa (not pushed); `git status --short` empty, nothing left running.

| commit | finding |
|---|---|
| 565e804 | M1: the new place is recognised by what the folder is |
| 559f62e | M2: an old copy cannot be deleted while its move is unfinished |
| 25ae942 | I1, M5, M4 (the engine) |
| d013d1f | I1 (service and page) |
| 12ed4fd | M5 (service and page) |
| c1a1285 | M4 (service and page) |
| 6e33ae2 | the day-long offer runs from the finishing |

The engine's part of I1, M5 and M4 is one commit because it is one function (`finishMoveAt` and its helpers); the service and page parts are one commit per finding.

Each new test was seen to fail before its mend, by restoring the previous file for the run and then putting it back. The engine's new split tests failed partly because the split-marking seam did not exist before. The journal-write split test failed for the real reason: `oldCopyMarked` refused every split.

## I1 — split moves
- **Failing tests.**
  - `move-finish.test.ts`, "R583 I1": seven late steps × (the split's sentence; no library open; an attach into a marked project answers 503 LIBRARY_OFFLINE, which was the reviewer's probe that got 200; the new place's opening finishes; both libraries whole). All 7 failed against the old route: DISK_FULL / INTERNAL / the whole-library sentence.
  - `move.test.ts`, "R583 … split": 5 tests.
  - `MoveLibrary.test.tsx`, "R583 I1".
- **Mend.**
  - `packages/library/src/move.ts:993` `oldCopyMarkedFor(dest, oldRoot, deps)`: the journal's own record of the steps done (`mark-old`). Failing that (the journal's write failed, or a split's marking stopped part-way), what the old copy demonstrably shows: its top's MOVED.json naming the library; for a split, any moved project's MOVED.json naming it, or the old library.json already rewritten as the remaining library (`oldCopyMarked`, `:963`).
  - `apps/library-service/src/routes/libraries.ts:355`: the route asks it, so any marked project closes the library in the service (R581).
  - `finishMoveAt` (`move.ts:879`) finishes a split from every such state. The marking is redone under the old copy's lock, which is released as soon as the step is done (`afterMarkOld`, `:1065`). The kept projects are untouched (the engine test compares their folder, audit logs aside: audit-split appends `library.split` there by design).
  - A split marked part-way is finished only when the moved projects not yet marked are unchanged in the library they came from. Otherwise it is refused (`source-changed`; see M4's words).
  - Test seam: `moveSeams.fail = { at: "split-mark", afterFolders: n }`.
- **Sentence (service answer without the path; the dialog with it, through UserText), reason `move-not-finished-split`:** "The move of the projects did not finish, so the library has been closed. Open the new library at its new place, {newRoot}, and the move will be finished then. The library they came from can be opened again for the projects that stayed; nothing is lost."

### A split's states (each a service test unless noted)

| failure | journal on disk | old folder | the new place's opening | the old folder's opening |
|---|---|---|---|---|
| after the first moved project's mark | (none) | first project marked; library.json still the original | checks that the unmarked project is unchanged at the old place, marks it and rewrites library.json (old lock), then register…finalize | the remaining library, "Kept" only |
| after the last project's mark | (none) | all moved projects marked; library.json original | rewrites library.json, then as above | "Kept" only |
| journal's write after the marking | (none) | marked; library.json rewritten | marks again (idempotent), then as above | "Kept" only |
| after register | mark-old, register | marked | register, close-source (nothing), audit-split, audit-move, finalize | "Kept" only |
| after close-source | …, close-source | marked | audit-split, audit-move, finalize | "Kept" only |
| record's marking complete fails | …, audit-move | marked | register, finalize | "Kept" only |
| journal's removal fails | …, audit-move (record complete) | marked | register, finalize | "Kept" only |
| nothing marked yet (engine test) | (none) | unmarked | not finished (undefined): it is still the library | the original library |
| part-way, the unmarked project changed at the old place (engine test) | (none) | partly marked | refused `source-changed`, nothing written | — |

Remaining risk: in the part-way state, opening the OLD folder before the new one shows the not-yet-marked moved project as its own, and a change to it there then stops the finishing safely, with the "cannot finish" words. Nothing is lost, but that move is then stuck.

## M5 — check again before finishing
- **Failing tests.**
  - `move-finish.test.ts`, "R583 M5": a PDF removed by hand at the new place; then a file changed; then put right, which finishes.
  - `move.test.ts`: the same in the engine, plus the old copy changed too.
  - `StatusBanner.test.tsx`, "R583 M5".
- **Mend.**
  - `move.ts:879`: before anything is written, `notMatching` (`:947`) checks the new place against the move's own verification record (`readVerifiedHashes`, read as the move's verification reads with `sha256File`). Every file must be present with the same content. Two kinds of file are only checked for presence, because the switch's own steps write them: `library.json` (its location history) and the projects' audit logs (audit-move appends). The library's integrity check at opening verifies the audit chains.
  - A mismatch refuses (`MoveFinishRefusedError("files-differ", { count, oldRoot, oldWhole })`), and the old copy is checked the same way for the words. Its index file and library.json are only checked for presence, because of Minor 3.
  - Service: `state.ts:152` `notFinishedNote`. The count and the place go into the session warning for the screen only. The log gets `describe(err)`, which carries no path.
- **Sentences** (banner, the place through UserText):
  - "The move of this library to this folder has not finished, and the app did not finish it: {n} files here no longer match what was checked when the library was copied. The old copy at {oldRoot} still holds every file as it was checked. Both copies are kept as they are, and this library is open read-only." (n = 1: "1 file here no longer matches").
  - When the old copy does not match either: "…: {n} files here no longer match what was checked when the library was copied, and the old copy at {oldRoot} could not be confirmed to hold every file either. Both copies are kept as they are, and this library is open read-only. Ask for help before changing or deleting either copy."
  - "move-finished-at-opening" ("…nothing was lost.") is now said only after a clean check.
- **Time:** the check reads every moved file once, as the move's verification phase did. Here SHA-256 runs at about 500 MB/s from the page cache (256 MB in 0.51 s). Off a disk it runs at the disk's read speed, for example about 1–2 minutes per 10 GB on a 100–200 MB/s external drive. It runs only when an interrupted move is finished, and the opening's answer waits for it.

## M1 — real paths
- **Failing test:** `move.test.ts` "R583 M1 … opened by its real path" (it failed; opened by the link it already passed). The hand-made copy at another path is still refused (the existing tests).
- **Mend:** `move.ts:1020` `sameFolder` compares `fs.realpath.native` of both sides, falling back to the text when a path cannot be resolved. It is used in `completeMove` and `finishMoveAt`. The service keys its shared finishing by real path too (`state.ts`, `finishUnfinishedMove`).

## M2 — unfinished while the journal is there
- **Failing tests:**
  - `move.test.ts` "R583 M2" (a failure at the unlink: `movedTo.unfinished` was false; `deleteOldCopy({confirm})` deleted the old copy);
  - `move-finish.test.ts` "R583 M2" (`moveUnfinishedTo` was undefined).
- **Mend:**
  - `old-copies.ts:192` `journalStillAt(rec)`: the journal at `newRoot` names this record.
  - `movedToFor` (`:185`) counts the move as unfinished then.
  - `deleteOldCopy` (`move.ts:1327`) refuses (`move-unfinished`), mapped to 409 CONFLICT in the service.
- **Sentence:** "The move of this library has not finished, so its old copy cannot be deleted yet. Open the library at its new place first; the move is finished then."

## M4 — each sentence true in its case
- **Failing tests:**
  - `move-finish.test.ts` "R583 M4": damaged journal, old copy unreachable, newer format (3 failed first); a lock held by another program on this computer.
  - `move.test.ts` (3);
  - `StatusBanner.test.tsx`.
- **Mend:** the engine refusals `journal-damaged`, `old-copy-unreachable` (the old folder cannot be reached when its marks must be looked at; with the mark recorded, the move finishes without the old copy), `newer-format` and `in-use`. `notFinishedNote` maps each to its kind.
- **Sentences (banner):**
  - in-use: "The move of this library to this folder has not finished, and it could not be finished now because the library or its old copy is open in another program or on another computer. Close it there; the library is open read-only, both copies are kept, and opening it again will try again."
  - newer format: "The move of this library to this folder has not finished, and this version of the app cannot finish it: the library was saved by a newer version of the app. Update the app and open the library again; both copies are kept."
  - damaged journal: "The move of this library to this folder has not finished, and the app cannot finish it: the record of the move kept in this folder is damaged. Both copies are kept as they are, and this library is open read-only. Tell the developer before changing or deleting either copy."
  - old copy unreachable: "The move of this library to this folder has not finished, and it could not be finished now because its old copy at {oldRoot} cannot be reached. Connect the drive it is on and open the library again; both copies are kept."
  - a split's project changed at the old place: "The move of these projects to this folder has not finished, and the app cannot finish it: some of them were changed in the library they came from after they were copied. Both copies are kept as they are, and this library is open read-only. Tell the developer before changing or deleting either copy."
  - disk full, not writable, and a step failed now end "The library is open read-only, and both copies are kept; opening it again will try again." They no longer say "nothing was lost" before any check.
- I changed my own earlier tests' expectations of these words: the in-use regex, the disk-full sentence, and the engine's "held by another computer" matcher, which is now `code: "in-use"`.
- The dialog's sentence after a failed move still promises "the move will be finished then". If the next opening meets one of these cases, its banner says why it was not.

## The day-long offer
It was a few lines (`old-copies.ts`, `completedAt` set in `markPendingComplete`; `offerFrom` at `:253`), so it is done: the offer runs from the finishing. Test: `move.test.ts` "the old copy's day-long offer … runs from the finishing" (it failed first: expired).

## Runs (each file alone)
- `@ao/library`: move.test 102; reconnect 54; retention-old-copies 40; device-and-old-copies 18.
- `@ao/library-service`: move-finish 29; open-library 26; close-during-attach 13; lock-during-change 3; server 160 + 1 skipped; transcription-jobs 40; zotero-sync-scheduler 43; library-audit 11; capture-queues 31; device-notices 17; zotero-sync-routes 43; find-routes 47; fieldwork-governance 23 — all passed.
- `@ao/ui`: StatusBanner 79; MoveLibrary 29; LibraryChooser 24; LibraryChooser.notices 5; Library 48; Library.notices 4; dialogs.r145 42 — all passed.
- Typecheck: shared, library, library-service, cli, ui clean. `lint:css` and `lint:colours` clean.
- End to end: `@ao/ui` built, `maintenance.spec.ts` in Chromium: 3 passed.

Not done, as ruled: M3, M6.

---

# Third round (R590)

Branch `fr-755-move-failure`, five commits on 6e33ae2 (not pushed), one per finding, in dependency order. `git status --short` is empty. Nothing of mine is left running.

| commit | finding |
|---|---|
| 0258e1a | N4: an old copy cannot be deleted while its new place cannot be read |
| 7389076 | N5: the damaged-journal words at the old place; the old place found by its real path |
| c52226b | N1: the old library of an unfinished split opens read-only |
| 6eebe87 | N2: each audit log at the new place is proved against what the move verified |
| 87181b8 | N3: every mark the journal records must still be there |

I wrote every new test first and saw it fail before the mend:
- the engine and page tests against the code before the change;
- the service tests by putting back the 6e33ae2 versions of the product files (tests kept) for one run, which gave 7 failed out of 7 R590 tests, then restoring.

The commits were cut from the tested final tree. The intermediate states were rebuilt backwards and checked to equal HEAD exactly, and the last state to equal the tested final exactly. Each intermediate stage was typechecked, and its R590 engine tests were run.

## N1 — the old library of an unfinished split opens read-only
- **Failing tests:**
  - `packages/library/src/move.test.ts`:
    - "R590 N1: the old library of a split whose marking stopped after the first / the last moved project opens read-only as moved…" (2 tests). Before the mend: `['read-write', undefined, undefined]`.
    - "…matched by its real path: opened through a symbolic link…".
    - A guard that passes before and after: "a split stopped before any project was marked: … opens for changes".
  - `apps/library-service/src/move-finish.test.ts` "R590 N1: after a split whose marking failed after the first moved project…". This is the reviewer's probe: Study and Field moving, Kept staying, `fail = {at:"split-mark", afterFolders:1}`. The test checks:
    - the old place opens read-only `moved` with `moveUnfinishedTo` = the new place;
    - after `idle()`, no file under the old place changed (byte snapshot), so no backup ran;
    - an attach into Study answers 409;
    - `restart()` + `reopenLast()` opens the OLD place, read-only, and still nothing under it changes;
    - opening the new place finishes it (read-write, told once, Field and Study);
    - the old place then opens read-write with no `moveUnfinishedTo` and "Kept" only.
  - The whole-library and finished-split tests are unchanged and pass.
- **Mend:**
  - `packages/library/src/library.ts:283`: in `openLibraryInternal`, after the `MOVED_MARKER` check, `unfinishedSplitFrom(deps, root, meta.libraryId)`. When it matches: `readOnly("moved", movedTo)`.
  - `packages/library/src/old-copies.ts:255` `unfinishedSplitFrom`.
- **How "unfinished split" is judged at the old place.** All of these must hold:
  1. This computer's newest record for this library id whose `oldRoot` is this folder by real path (`recordFrom`, `old-copies.ts:193`, using `sameFolder`, `:187`).
  2. The record has `split: true`.
  3. `moveFinished(rec) !== "finished"` (`:207`). This is the one judgement of "unfinished": `!complete`, or the journal at the new place names this record, or it is damaged, or (failing closed) the new place cannot be read.
  4. At least one of the record's `movedFolders` in this folder carries a MOVED.json naming the library.

  How this tells the cases apart:
  - **Unfinished split.** The old `library.json` still carries the ORIGINAL id until every moved project is marked. Once the marking is complete it carries the remaining library's id, so a finished split's remaining library never matches (nor does a fully marked one). No STOP was needed.
  - **Why condition 4.** With no project marked yet (the record is written before the journal and before the first mark), the finishing at the new place returns undefined: the old library is still the library. Making it read-only there would leave both places read-only for good. So that state opens as before.
- **Sentence** (`packages/shared/src/api/library-move.ts:30`). With the path in the dialog, inside UserText; without it in the service's answer:
  - "The move of the projects did not finish, so the library has been closed. Open the new library first, at its new place, {newRoot}: the move will be finished then. Until then the library they came from opens only read-only; after that it opens again for the projects that stayed. Nothing is lost."
  - Without the path: "… Open the new library first, at its new place: the move will be finished then. …"
- **Tests changed on purpose** (they asserted the old words): `move-finish.test.ts` "the sentence for a split, word for word" and `MoveLibrary.test.tsx` "R583 I1: …".
- **The old place's banner** is the existing one: "Read-only — this is the old copy of a library whose move has not finished. Open the library at its new place, {newRoot}, and the move will be finished then; nothing is lost."

## N2 — the audit logs at the new place
- **Failing tests:**
  - `move.test.ts`:
    - "R590 N2: an audit log at the new place cut to nothing by hand" and "… cut to its first line by hand" (D5, D5d). Each gives `files-differ`, count 1, nothing written at either place; before the mend the promise resolved.
    - "a line that is not the switch's own, appended by hand…: … the log counted once".
    - "the switch's own line changed by hand after the verified beginning (the chain broken): the finishing's own opening reports it…". This proves (i) on its own, because the verified beginning is intact.
    - A guard: "an audit log that begins with what was verified and goes on with the switch's own lines is finished over" (a finishing that failed at mark-complete after audit-move, then finished).
  - `move-finish.test.ts` "R590 N2: an audit log at the new place cut to nothing / to its first line by hand (the reviewer's D5)": read-only `move-incomplete`, `move-not-finished-files-differ` with count 1 and the old place. The read-only opening's own check also shows the log's fault (`empty` / `truncated`), which is true. Nothing is written.
- **Mend** (`packages/library/src/move.ts`):
  - `:902` before anything is written: `notMatching` with a third rule, `"begins"`, for `Projects/*/audit/*.jsonl`. `library.json` stays `"present"` (R588 a).
  - `:982` `beginsWithVerified`.
  - `:1013` `auditFaultsAt`. It opens the new place with `openLibraryInternal` as usual. Its journal makes that opening read-only `move-incomplete`, with no lock and nothing written. It then calls `openRepo(…, { noHeal: true })` and collects every `empty`, `truncated`, `chain-broken` or `head-mismatch` warning, mapped to `Projects/<n>/audit/`, or `audit/` for the library's own log.
  - A log that fails either check counts once.
  - Why not use the finishing's own writable `openRepo` warnings: that opening appends `audit.anchor-mismatch` to the log and anchors it anew. The refusal would then have already written into the new place, and the next opening would see no fault.
- **How an audit log's beginning is proved:**
  - The record (`old-copies/<id>.json`) holds, per file, only the SHA-256 of the whole file at verification. It holds no size.
  - The beginning is found by its hash. The log is read once, an incremental SHA-256 runs over it, and at the empty beginning, at every line end and at the end of the file, a copy of the running hash is compared with the recorded value. A match fixes the verified length. A collision would be needed to fake it.
  - Every complete line after that point must parse as an audit event with `action: "library.move"`, the only thing the finishing's switch appends there (audit-move). A late-recorded one keeps its action.
  - A last fragment with no line end is ignored. It is a line cut off by a crash, which the opening's own repair (R28) trims.
  - The old copy's log was not needed.

## N3 — the marks the journal records
- **Failing tests:**
  - `move.test.ts` "R590 N3: a moved project's mark the journal records, removed by hand: not finished, nothing written (C)" (a split with `crashAfter = "register"`).
  - `move.test.ts` "… a whole library's top mark …: (C2)".
  - `move-finish.test.ts` "R590 N3: the old copy's mark … (the reviewer's C2)" and "… a moved project's mark … (the reviewer's C)".
  - `StatusBanner.test.tsx` "N3: …".
- **Mend:**
  - `move.ts:893`: when the journal records `mark-old` and the old folder can be reached, every recorded mark must still name the library: a split's `movedFolders/*/MOVED.json`, or the top MOVED.json for a whole library. Otherwise `MoveFinishRefusedError("mark-missing")`, before anything is written.
  - `apps/library-service/src/state.ts:161` maps it to the warning `move-cannot-finish-mark-missing`.
  - `StatusBanner.tsx:116` holds the words.
- **Sentence:** "The move of this library to this folder has not finished, and the app cannot finish it: a mark the move left in the old copy, which keeps that copy from being changed, was removed outside the app. Both copies are kept as they are, and this library is open read-only. Tell the developer before changing or deleting either copy."

  This is a NEW sentence in the existing cannot-finish family. Neither existing one is true here: "journal damaged" is not the case, and "projects changed" does not fit a whole library. Please confirm.

## N4 — fail closed
- **Failing test:** `move.test.ts` "R590 N4: the new place's drive not connected: the old copy cannot be deleted, and the refusal says why". It covers a failure at unlink with the new place renamed away. Before the mend the deletion went ahead: `filesDeleted: 18`.
- **Mend:**
  - `old-copies.ts:207` `moveFinished`, with `journalAt` at `:215`. `journalStillAt` is gone. `journalAt` gives `"unreachable"` when the journal cannot be read for a reason other than "missing", or when it is missing and the new place's folder cannot be read either.
  - `move.ts:1390`: `deleteOldCopy` refuses on anything but `"finished"`.
- **Sentence** (code `move-unfinished`, 409 in the service): "The old copy cannot be deleted now: the library's new place cannot be reached, so the app cannot tell whether its move has finished. Connect the drive the new place is on and try again."

## N5 — words, and the old place by its real path
- **Failing tests:**
  - `move.test.ts`:
    - "R590 N5: the old place of a move whose journal is damaged says so…": `movedTo` = `{ newRoot, unfinished: true, journalDamaged: true }`.
    - "… the old place is matched by its real path: opened through a symbolic link…" (was `undefined`).
  - `move-finish.test.ts` "R590 N5: …": `moveCannotFinish: true` in the open route's answer and in `library.state`.
  - `StatusBanner.test.tsx` "N5: …".
- **Mend:**
  - `old-copies.ts:235` `movedToFor`, matched through `recordFrom` by real path, with `journalDamaged` from `moveFinished`.
  - `sameFolder` moved from `move.ts` to `old-copies.ts:187`; both use it.
  - `Library.movedTo` is the type `MovedTo`.
  - `state.ts:1847` and `routes/libraries.ts:53` carry `moveCannotFinish`.
  - The page: `api/library.ts`, and `StatusBanner.tsx:244` and `:416`.
- **Sentence:** "Read-only — this is the old copy of a library whose move has not finished, and the app cannot finish it: the record of the move kept at its new place, {newRoot}, is damaged. Both copies are kept as they are. Tell the developer before changing or deleting either copy." The whole sentence is inside UserText, as for the existing banner.

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)
- **`@ao/library`:** move.test 116 (14 new); reconnect 54; library 35; library-place 19; device-and-old-copies 18; retention-old-copies 40; retention-closing 10; retention-confirm 3; retention 23; export/backup 23. All passed.
- **`@ao/library-service`:** move-finish 35 (7 new, one changed); open-library 26; close-during-attach 13; lock-during-change 3; library-place-routes 8; device-notices 17; library-audit 11; your-library-routes 35; server 160 + 1 skipped; fieldwork-governance 23. All passed.
- **`@ao/ui`:** StatusBanner 81 (2 new); MoveLibrary 29 (1 changed); Library 48; LibraryChooser 24. All passed.
- **Typecheck:** shared, library, library-service, ui and cli clean. `lint:css` and `lint:colours` clean.
- **End to end:** `@ao/ui` built; `maintenance.spec.ts` in Chromium, 3 passed.

## Uncertain / for the reviewer
- **N1:**
  - If this computer's list of old copies cannot be read, the opening treats it as "no record" and opens normally, as `movedToFor` already did. Failing closed would make every library read-only while the list is unreadable.
  - The rule needs a moved project to be marked (see above).
- **N4 / one judgement:** `"cannot-tell"` counts as unfinished everywhere. So the old copy of a FINISHED move whose new drive is unplugged now says "…whose move has not finished. Open the library at its new place…". That is fail-closed and harmless (opening the new place opens it normally), but not exact. `listUnfinishedMoves` (used by reconnect) still judges by `!complete` alone; I did not change it.
- **N2:**
  - Only `library.move` counts as the switch's own. A finishing interrupted after a writable opening at the new place recorded another event in a moved project's log would refuse from then on, safely, with the files-differ words. An example is `audit.anchor-missing`, which appears only when this computer's anchor was lost.
  - `anchor-missing` and `anchors-unreadable` are not refused over. They are not among the ruled faults, and the beginning check still holds.
  - The library's own log (`audit/`) keeps the whole-hash rule.
- **N3:** with the old copy unreachable, a recorded mark is not looked at and the move still finishes without it (R583 M4, kept).
- **N3 words** are new (see N3).

## After R596
- **Commit and mend.**
  - In `704506d`, `movedToOf` in `old-copies.ts` sets `unfinished` only for "unfinished" and "damaged". For "cannot-tell" it gives the plain moved words, and `moveUnfinishedTo` is not sent.
  - `deleteOldCopy` still refuses with the cannot-reach sentence.
  - Every other reader goes through `movedToOf`: the service's state, the open route and the page.
- **Tests, each seen to fail first:**
  - `move.test.ts` "R596 b: the old copy of a FINISHED move whose new place cannot be read…"
  - `move-finish.test.ts` "R596 b: the old place of a FINISHED move…"
  - Two guards with the record not complete: "has not finished".
- **`unfinishedSplitFrom` (N1)** still opens read-only on anything but "finished".
  - In "cannot-tell" its banner would read the plain moved words.
  - That case cannot arise with a marked project. The record becomes complete only in "finalize", after "mark-old" has rewritten the old `library.json` to the remaining library's id, so the record (keyed by the original id) no longer matches. Only a hand-reverted `library.json` could reach it.
- **Runs:** move 118, device-and-old-copies 18, move-finish 37, StatusBanner 81; library and library-service typecheck clean.
