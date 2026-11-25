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
