# FR-068 (R599) — a move run again after it failed before the old copy was marked

Branch `fr-068-move-rerun`, made from PART 1's head `4588572` (`fr-755-move-failure`). Two commits, not pushed. `git status --short` empty; nothing of mine left running.

| commit | points |
|---|---|
| 95097b8 | (1)–(6): the one judgement; copy and verification made again; the records; split; crash; what does not change |
| 838852f | (7) M-2: the stale copy says what it is and accuses nothing (engine, service, page) |

(1)–(6) do not separate cleanly: the judgement alone, without the copy made again, sends the re-run into a copy phase that cannot finish when a source was deleted, and the records go with the same code path. (7) is separate.

The commits were cut from the tested final tree. The (7) parts were taken out, and the intermediate tree was typechecked (library, library-service) and run: move 135, move-finish 40. The final tree was then put back exactly as tested.

**Failing first:** every new test was run against the code before the change. I put back the HEAD versions of the 7 product files with the tests kept, ran them, and restored the files.
- Engine `move.test.ts` FR-068: 6 failed and 6 passed. The 6 that passed are the (6) "must not change" guards and the (7) "once marked" guard, as they should.
- Service `move-finish.test.ts` FR-068: 4 of 4 failed.

## The one judgement of "the old copy cannot have changed"
- `packages/library/src/old-copies.ts:305` `oldCopyState(rec, switch)` returns one of:
  - `"recorded"`: the journal's `done` has `mark-old`.
  - `"seen"`: for a whole library, the top `MOVED.json` names the library. For a split, a moved project's `MOVED.json` names it, or the old `library.json` already carries `remainingLibraryId`.
  - `"unmarked"`.
  - `"unreachable"`: the old folder cannot be read.
- `markNames` moved there too (`old-copies.ts:319`). The old `oldCopyMarked` in `move.ts` is gone.
- `packages/library/src/move.ts:584` `switchMayResume(rec, j)` wraps it. It gives true for recorded or seen, false for unmarked, and throws `MoveFinishRefusedError("old-copy-unreachable")` when the copy is unreachable, as before.
- Its users:
  - `executeMove`'s resume, `finishesSwitch` (`move.ts:571`).
  - `finishMoveAt` (`move.ts:959`; its old rule "recorded, or `oldCopyMarked`" is exactly the same judgement).
  - `oldCopyMarkedFor` (`move.ts:1115`, the service's check after a failure).
  - The move's plan, `preflight` (`move.ts:399`). `planMove` has no `deps`, so it judges at the library being moved (`lib.root`), which is the old copy. The existing test "a switch already decided … planMove would call the destination not empty" holds unchanged.
  - The stale-copy check at an opening, `staleMoveCopyAt` (`old-copies.ts:333`).
- `finishesSwitch` with NO record of the move on this computer still hands over to `completeMove`, which refuses as before.

## How the copy and the verification are made again
In `executeMove`, when the journal is in its switching phase and the switch may not resume:
1. **The journal.** It goes back to `phase: "copying"` (`move.ts:697`). Its `switch` is dropped, and the earlier attempt's record id is kept in a new journal field `replaces`, which `readJournal` reads.
2. **`filesDone`.** It is used exactly as for any resumed copy, and never trusted. A journaled file is skipped only when the destination file exists, has the same mode and hashes the same as the source NOW. Otherwise it is copied again. Files not journaled (added at the source) are copied.
3. **Files that differ at the destination** are overwritten by the copy (`copyFileAtomic`).
4. **Files at the destination no longer at the source.** The existing copy phase does not remove them; its verification refuses them as "unexpected" (MoveVerificationError). The earlier attempt's own record holds the checksum of every file it verified and the list of folders it made. So after the copy (`move.ts:758`):
   - a file at the destination that is not in the source now, but IS in that record, AND whose content is still exactly the recorded checksum, is removed;
   - a folder it made that is now empty is removed (`rmdir`, deepest first).

   Nothing else at the destination is touched. A file put there by hand (or changed since) is left, and the verification names it. Test: "(2) a file at the new place that the move did not put there is not deleted: verification fails and names it".

   So no STOP: making the stale new place exact needs only the removal of files the move itself put there, proven by its own checksums.
5. **Verification.** The ordinary full verification follows: both sides re-read, every source file hashed against the destination, and nothing extra allowed at the destination. Then the ordinary switch runs, with a NEW record and a new moveId, starting at `mark-old`.

## This computer's records (3)
- The first attempt wrote its record (complete: false) BEFORE the switching journal. Its id is the journal's `switch.pendingId`.
- The re-run keeps that id in `replaces` while copying, so a crash during the copy does not lose it.
- Once the new copy is verified, and before the new record is written (`move.ts:810`), it removes that record and its checksum file (`removePendingOldCopy`). A list that cannot be read stops the move with the existing `OldCopiesUnreadableError("move")` words.
- Afterwards exactly one record describes the move, and it is complete. `listUnfinishedMoves` is empty. The old place reads `{ newRoot, unfinished: false }`, and its deletion offer is the new record's.
- Remaining crash windows (not tested):
  - Between the removal and the new record: the journal still says copying, with `replaces` naming a record that is gone. A later re-run still copies, but cannot remove files deleted at the source in the meantime, so the verification names them and nothing is deleted.
  - Between the new record and the switching journal: an orphan incomplete record. This window exists for every first move too, before and after this change.

## Per ruled point: the test (failed first) and the mend
| point | test(s) | mend |
|---|---|---|
| (1) | covered by (2)–(6) | `oldCopyState` (`old-copies.ts:305`), `switchMayResume` and `finishesSwitch` (`move.ts:571`, `:584`), `preflight` (`move.ts:399`) |
| (2) | `move.test.ts:1872` "(2) whole library: a record edited, a source attached, a source deleted and the index changed …" (with an IndexHandle; trees compared at the moment the move reports "switch", i.e. after its own verification passed: equal exactly over every file the move copies; `fileCount`, `totalBytes` and `filesCopied` checked against the listing; the changes read back at the new place; the old copy then `moved`). `move.test.ts:1941` (a hand-made file is not deleted). `move-finish.test.ts:600` "(2) whole library …" (through the service: PATCH, attach, DELETE; search; the dialog's plan route then the move route; done; an independent listing and checksum of `Projects/` at both places equal; sources, edit and search at the new place; the old copy marked) | `move.ts:697`, `:702`, `:758` |
| (3) | `move.test.ts:1924` "(3) this computer's records …"; record counts in every FR-068 test | `move.ts:810` |
| (4) | `move.test.ts:1952` "(4) a split that failed before its first mark …" (the reviewer's probe: a folder planted at each moved project's `MOVED.json`, then removed). `move-finish.test.ts:636` "(4) …" (plan, move, then Study 3 sources, the late one searchable; the library left behind opens read-write with Kept's 2 sources) | as (1)–(3) |
| (5) | `move.test.ts:1982`, `move-finish.test.ts:671` "(5) … killed between the switching journal and the first mark …" (restart, reopening at start opens the OLD place read-write, attach, move again, done, 3 sources) | new test seam `moveSeams.crashAfter = "switching-journal"` (`move.ts:867`) |
| (6) | `move.test.ts:2012` ×4: whole recorded (crash after mark-old), whole seen (journal write fails after mark-old), split recorded (crash after register), split seen (split-mark fails after 1). Each: resumed, `filesCopied` 0, no copy or verify phase reported, the destination unchanged but for the switch's own files. `move.test.ts:2030` (`finishMoveAt` over an unmarked old copy: undefined, both trees unchanged). A first run and a resumed copy: the existing tests ("copies, verifies and switches…", "resumes an interrupted move…", "recopies a journaled file…") pass unchanged | — |
| (7) | `move.test.ts:2038` (the stale place opens `move-incomplete` with `staleMoveOf` = the old place; its repo has NO integrity warnings, where before it had the anchor ones). `move.test.ts:2048` (once marked, not stale: a log emptied by hand still gives `empty`). `move-finish.test.ts:689` "(7) …" (open route: read-only, `move-incomplete`, `staleMoveOf`; no warning kinds; nothing written). Existing `move-finish.test.ts` R590 N2 (log emptied or cut after the mark): still `empty` / `truncated` exactly, now also asserting no `staleMoveOf`. `StatusBanner.test.tsx:566` (words; the path isolated; other move-incomplete words unchanged) | `Library.staleMoveOf` (`library.ts`, set at `:295` from `staleMoveCopyAt`); `repo.ts:632-633`, `:710`, `:733` and `library-audit.ts:156-163` (no anchor comparison for such a place: no anchor and no "this computer wrote here" check, while chain and empty checks stay); the service passes `staleMoveOf` (`state.ts:1849`, `routes/libraries.ts:55`); the page (`api/library.ts`, `StatusBanner.tsx:424` and the text) |

## Every sentence shown, word for word
- **NEW** (banner of the stale copy, the whole sentence inside UserText as for the "moved" banners):

  "Read-only — this folder holds the copy made by a move that did not finish. The library is still at its old place, {oldRoot}, and nothing here is the library yet. To finish the move, open the library there and move it to this folder again; or delete this folder."

  The existing `move-incomplete` words, "Read-only — a move into this folder has not finished. Changes are off.", are true but do not fit: they do not say where the library is, or that this folder is not it. They are unchanged for every other unfinished move into a folder.
- Unchanged and still shown in their states: every cannot-finish, not-finished and files-differ sentence; "empty" and "truncated" for a log changed by hand after the mark.
- No other sentence changed.

## The dialog's words after the failure in this state (asked; not built)
Probed through the service: a folder planted where the top mark goes.
- The move route's last line: `{"error":{"code":"INTERNAL","message":"Something went wrong. Nothing was changed by this request unless it says otherwise."}}`.
- The dialog (`MoveLibrary.tsx:67`) shows: "Something went wrong. Nothing was changed by this request unless it says otherwise. The move stopped; nothing was deleted, and the library stays where it was."
- With the re-run now safe:
  - "nothing was deleted" and "the library stays where it was" are true.
  - "Nothing was changed by this request" is untrue: a full copy, its journal, and a record on this computer were written at and for the new place, and nothing says so or what to do with it. The new banner says it only once that folder is opened.

  A truer ending would be, for instance: "The move stopped before the library was switched; nothing was deleted, and the library stays where it was. The copy made at the new place is not used: move the library to it again to finish, or delete it." That is a proposal only.
- **Found while probing:** before this change, the dialog's own "Check destination" (POST `/libraries/move/plan`) REFUSED the same folder in this state: 403 `POLICY_DENIED` "The library cannot be moved there." with the reason "The destination folder is not empty; choose an empty folder".
  - So through the page the researcher could not run the move again at all. The silent loss was reached by a move request without the plan (the route directly, as the reviewer's probe did).
  - Now the plan accepts the folder in this state, and the re-run copies and verifies again.
  - Whether the released page's flow ever skips the plan, I did not establish beyond reading `MoveLibrary.tsx`, which always plans first.

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)
- **`@ao/library`:**
  - `move.test.ts` 137: FR-068 has 12 tests, and the 7 FR-755 R599 M-1 tests of PART 1 are in this count.
  - `device-and-old-copies` 18, `retention-old-copies` 40, `reconnect` 55, `library` 35, `library-place` 19.
  - (The only `move*.test.ts` in the library is `move.test.ts`.)
  - All passed.
- **`@ao/library-service`:** `move-finish` 41 (4 new), `library-place-routes` 8, `open-library` 26. All passed.
- **`@ao/ui`:** `StatusBanner` 82 (1 new), `MoveLibrary` 29. All passed.
- **Typecheck:** library, library-service, ui, shared, cli clean.
- **Lint:** `lint:css` and `lint:colours` clean.
- **End to end:** `@ao/ui` built; `pnpm e2e -- --app-only --trace off --project=chromium maintenance.spec.ts`: 3 passed.

## Uncertain
- **Two places one judgement is applied from.** `preflight` judges at the library being moved, and `finishesSwitch` at the record's old place. Both call the same `oldCopyState`, and they are the same folder in every real case. If a hand-made copy of the library (same id) elsewhere were moved to the same destination, the re-run would copy from it and remove the earlier record of the other folder, which was never marked.
- **The stale check needs the old copy to be reachable.** With it unreachable, the new place opens with today's move-incomplete words, and the anchor comparison is made (the untrue "shorter" warnings can then appear). Saying "the library is still there" without seeing it would not be safe.
- **A split run again with other exclusions than the first attempt.** Files the first attempt copied for a project that is now left behind are removed from the new place (they are the move's own unchanged copies). The new place is then exactly the new plan.
- **Removing what the earlier attempt put there.** A file at the same path with byte-identical content that someone put there by hand cannot be told from the move's own copy.
- **From PART 1:** a hand-written line in the library's own audit log with no `at` field makes the read-only opening throw a TypeError (`library-audit.ts` `checkLibraryAudit`) rather than report a fault. This is pre-existing and not changed.
