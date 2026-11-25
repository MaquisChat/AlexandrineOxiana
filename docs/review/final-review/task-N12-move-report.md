# N12 (R570 b) — the move left the old copy's index open

Worktree `.claude/worktrees/kg-3a`, branch `n12-move-index`, from 6c33ea1. Commit **46338c8** (not pushed).

## Reproduction

`pnpm --filter @ao/ui run build`, then `pnpm e2e -- --app-only --trace off --project=chromium maintenance.spec.ts:47`:
failed at "checked independently before deleting anything…" with `files of the old copy missing or different at the
new place` — received `["library.sqlite-shm"]`, as in R570 b.

## Cause (proved)

The index was NOT closed late: it was never closed at all after a move.

- R551 M7 (commits 227b488, then db8623b) took the index's close out of `closeLibrary` and put it in the step
  `closeLibrary` hands to the library's close: `s.lib.close({ beforeRelease: () => s.index?.close() })`
  (`apps/library-service/src/state.ts:1339–1349`).
- R551 M1 (def76de) made a second `close()` return the first one's promise
  (`packages/library/src/library.ts:469`), so a second caller's `beforeRelease` never runs.
- The move closes the old copy's library ITSELF, earlier, in its "close-source" step, with no such step
  (`packages/library/src/move.ts:852`, was `await ctx.source.close()`). The route's later `state.closeLibrary()`
  (`apps/library-service/src/routes/libraries.ts:370`) then got the move's promise; the index stayed open, its
  `-wal` and `-shm` stayed in the old copy, and the handle leaked.

Proved by a service-level test (`apps/library-service/src/open-library.test.ts`, "R570 b: a move leaves the old
copy's index closed…"): before the mend it failed at `expect(oldIndex.isOpen).toBe(false)` — received `true`.

## The order of events

At **facf73d** and **now** the copy part is the same:
1. `checkpointTruncate` of the open index (`move.ts:619`); the index stays OPEN during the copy, in both;
2. walk, skipping `library.sqlite-wal/-shm` (never copied, `NEVER_COPIED`, `move.ts:57`), copy (`:667`);
3. verify, byte for byte against the source (`:692` on); `library.sqlite` included;
4. switch: "mark-old" (MOVED.json, `:835`), "register", "close-source" (`:852`: the old copy's lock released);
5. route: open the new place (`libraries.ts:365`), `closeLibrary()` of the old session (`:370`), `adopt` (`:382`).

- **facf73d:** at 5, `closeLibrary` closed the index explicitly before `lib.close()` (facf73d `state.ts:1325`):
  the old copy's `-wal`/`-shm` went then — AFTER the old copy's lock had been released at 4.
- **6c33ea1:** at 5, the index close sat only in `beforeRelease`, which did not run (M1): never closed.
- **Now (46338c8):** at 4, "close-source" closes the source with
  `close({ beforeRelease: () => ctx.index?.close() })` (`move.ts:858`; `SwitchContext.index`, passed from
  `opts.index` at both `runSwitch`/`completeMove` calls): the index closes after copy, verify and MOVED.json, and
  BEFORE the old copy's lock is released (better than facf73d, as R247 c / M7 want).

I did not close the index before the copy (as the dispatch suggested): it was open during the copy at facf73d too,
the copy is consistent because it is checkpointed first and the move refuses every change meanwhile (verify proves
`library.sqlite` unchanged), and closing it before the copy would need reopening it on every refused or failed move
(`state.activate(s)` keeps using the same handle) — a larger change. Nothing writes the old copy after it was copied
except: MOVED.json (by design) and, now, the removal of the index's working files (never-copied files) at the
index's close; closing an index with an empty WAL does not change `library.sqlite` (the test compares it byte for
byte). Who could reopen the old index: only `IndexHandle.reopen()` in the rebuild (`index/rebuild.ts:155,172`),
which `quiesce` stops before the copy; status routes and the page only read through `s.index` (`isOpen` checked).

## The index at the new place

The copied `library.sqlite` is complete (checkpointed) and current: opened there, the open's check finds it current
and does NOT rebuild it (probed with a counting `rebuildIndexIfNeeded` seam: one call, for the new root, result
"not rebuilt"; probe removed). Its own `-wal`/`-shm` appear there when it is opened.

## M7 kept

`closeLibrary` is unchanged. M7's own tests pass untouched: `close-during-attach.test.ts` "the close waits: the
source is fully stored and audited, then the lock goes; a change asked meanwhile is refused" and "R551 M7: in an
encrypted project too, the change finishes with its key and its index update (the index and the keys go after the
wait)".

## Runs (each alone, `nice -n 5`)

- e2e `maintenance.spec.ts:47`: Chromium FAILED before (as above); after: Chromium 1 passed, WebKit 1 passed.
- e2e Chromium, whole files: `maintenance.spec.ts` 3 passed; `library.spec.ts` 4 passed;
  `interrupted-change.spec.ts` 1 passed (the dispatch's grep finds only maintenance.spec.ts; these two also close /
  reopen a library).
- `@ao/library-service`: open-library 26 passed (new test failed first); close-during-attach 13; lock-during-change 3;
  transcription-jobs 40; server 160 passed, 1 skipped; zotero-sync-scheduler 43; library-audit 11; capture-queues 31;
  device-notices 17; zotero-sync-routes 43; find-routes 47; fieldwork-governance 23 — all passed (every service test
  file that calls `/libraries/move`).
- `@ao/library`: move 77; reconnect 54; repo/kept-warnings 13; retention-old-copies 40; index/index 58;
  index/rebuild-interrupted 13; index/annotations-cap 6; repo/closed-library 6 — all passed.
- typecheck: `@ao/library`, `@ao/library-service`, `@ao/cli` clean.
- `git status --short` empty; nothing left running.

## Uncertain / not done

- The command line (`apps/cli`) has no move, so nothing there; its own close is unchanged.
- A move finished after a crash through `completeMove` from a process that has no index handle passes none: nothing
  to close there.
- R570 a (`integrity-confirm-batches.test.ts`) is the other debugger's; not touched.
