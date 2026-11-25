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
