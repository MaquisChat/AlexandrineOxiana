# Round RE-1f: C1 (R493), a roll-back step already undone is never undone again

Worktree `.claude/worktrees/re-1b`, branch `re-1b-core`. Base 0cacb9f, head **435bc78**. Not pushed.

Two commits:
- aefcbea: test seam `seams.stopUndoAfter`.
- 435bc78: the fix and its tests.

## The ruling checked against the code

The ruling holds as worded in every case I could reach.

### (1) "The trash copy is gone while the marker still names it" can only mean "put back by an earlier run of this roll-back"

The ruling's assumption holds.

**The order of each forward step.** Every forward step records its line before it acts:
- `moveToTrash`, `mutate.ts:306-307`: `log.trashed(...)`, then `renameWithRetry(from, to)`.
- `writeFile`, `mutate.ts:258-262`: `replaced` (backup first, then the line) or `created`, then the write.
- `copyFile`, `mutate.ts:270`.
- `appendDurable`, `io.ts:140`: `onPlan` runs before the open.
- `mkdir`, `mutate.ts:233`.

**When the rename never happens.** If a crash or a failed rename falls between the line and the rename, the change stops there. No caller catches a failed `tx.trash` or `tx.destroy`; all ten call sites were checked. So no later line can exist, and skipping nothing is right. The file is still at its path.

**Other code that removes a trash copy:**
- **`mutate.ts:553`:** after commit, and only after `log.finish()` has removed the marker.
- **`finishCommittedSteps` (`txn.ts`):** only for a committed marker, which is never rolled back. `pending-writes.ts` allows only "keep" for a committed marker.
- **The open's sweep, `repo.ts:535`:** removes `trash-*` only when no marker is left at all.
- **`retention.strayCopies`:** skips trash that has a live marker. Its other scan reads an old place's `.tmp` after a move.
- **`removeMarker`:** removes backups only, never trash.

### (2) Which lines are compared

- `path` for created, replaced, append and **dir**; `from` for trashed.
- A dir line at the same path is compared too. It is reachable in principle, because a source folder is trashed at `sources.ts:898`. On a re-run its `rm -r` would remove a folder that has been put back.
- A later line *under* a trashed folder is always covered by a dir line at that folder or an ancestor. After a trash, `mkdir` records the outermost missing folder, which is the trashed folder itself or a trashed ancestor. Files inside a new folder get no line of their own.

**One case the ruling's "same path" does not cover (not reachable as far as I can find).** A change would trash a folder F, make F again, then write the same file inside it twice. The second write records `replaced F/a`, which is not at F. A re-run would then write that backup into the original folder that was put back.

I found no caller that does this:
- Source folders carry the source id.
- `deleteSourceInTx` does not make the folder again.

I did not patch this.

### (3) How paths are compared

- Every path is stored through the same `toRel(root, abs)`, a normalised relative path with `/` separators, and is compared as a string.
- On a case-insensitive disk, two spellings of one file would not match. Callers use fixed names, so this does not arise in practice.

## What changed

- **`txn.ts:205-270` (`undoEntries`).** A first pass, `:213-230`, collects which lines to skip: for each "trashed" line whose `to` is absent, every later line whose path (`from` for trashed) equals its `from`. The reverse loop then skips those lines (`:242`). Nothing else changes, and R491 C a's occupied-path rule is untouched: when the copy still exists, nothing is skipped.
- **A choice not in the ruling.** If the check on the trash copy fails with an error other than ENOENT, the later lines at that path are skipped and the roll-back is reported incomplete. This fails closed: nothing is destroyed and the marker is kept. Today, such a roll-back would undo those later lines and then fail at the trashed step itself.
- **The seam: `seams.ts:32-36`, used at `txn.ts:231-240` and `:269`.** `stopUndoAfter` stops a roll-back after N steps, as a crash would (returns false, marker kept), then clears itself. It is honoured only when `NODE_ENV === "test"`. Its inert test is in the new file.

## The tests: `packages/library/src/repo/rollback-rerun.test.ts`, 7 tests

They use real temporary libraries and the real `repo.mutate`, `importChange` and reopen.

### Named tests

Both failed before the fix (the annotations file was gone, `Received: null`) and pass after it:
- **Q1:** `failUndo = "replaced"`; the original annotations are back, byte for byte, after the reopen and after a second reopen, and the source reads them.
- **The crash during the reopen's own roll-back:** cut by the seam right after the trashed step was undone, then a second and a third reopen.

### The enumeration

Each case:
1. Runs the change's steps at one path, starting from {original bytes, absent}.
2. Fails the change.
3. Cuts the in-process roll-back after k steps.
4. Runs a second roll-back (reopen) to the end.
5. Runs a third roll-back (reopen).

**What counts as a pass, after the second and third roll-backs:**
- **(a)** No marker left, and the path byte for byte as it was before (or absent).
- **(b)** The marker kept and every backup kept.

**Skipped sequences.** A sequence the API cannot take is skipped:
- trash or replace with no file there;
- create with a file there (`writeFile` records "replaced" for an existing file);
- 2 steps: 8 of 16 from a file, 10 of 16 from none;
- 3 steps: 42 of 64 from a file, 48 of 64 from none.

**Sequences and cases:**
- 52 sequences: 8 + 6 with 2 steps, 22 + 16 with 3 steps.
- **179 cases** in all: 23 + 17 + 81 + 58.
- The cuts run from 0 to all steps. "All" is a crash after the last undo step, before the marker is removed. That is the Q1 crash shape, so I included it beyond the brief's "all but one". Without it there are 127 cases.

**Before the fix:** **14 cases failed** (of 23 + 81 from a file; none from no file).
- **11 were "reported complete with the path gone":** [trash,create] k=2, [trash,append] k=2, [trash,create,trash] k=3, [trash,create,replace] k=3, [trash,append,trash] k=3, [trash,append,replace] k=3, [trash,append,append] k=2, [append,trash,create] k=2,3, [append,trash,append] k=2,3.
- **3 were "incomplete, trash copy gone":** [trash,create,append] k=3, [replace,append,trash] k=3, [append,replace,trash] k=1.

**After the fix:** all 179 pass.

**I changed (b) for the 3 "incomplete, trash copy gone" cases.** Under the brief's strict wording they still fail after the fix: a trash copy that the first run put back is no longer there.
- The test now accepts a trash copy that is gone only when something is at its path, meaning the first run put it back.
- No case is reported complete with the original gone or changed.

## Found beyond the ruling (not patched)

**16 of the 179 cases end incomplete, with nothing lost.** The reopen answers `txn-recovery-skipped-audit-unverifiable`.
- **Cause:** R131 b's append-offset check (`offsetProblem`, `txn.ts`) is applied to *every* append line, not only logs. It refuses the whole roll-back when the appended file is now shorter than `prevSize`, or has no line end at that offset.
- **When that happens:** the same change appended to a file and also replaced or trashed it. This includes cut 0, which is a plain crash with no undo at all: for example, a crash in [append, replace] or [create, append, replace].
- **How it also arises:** on a re-run, after the first run had already restored the file. Examples: [replace, append] k=2; [trash, create, append] k=3.
- **Effect:** the marker, the backups and the copies are all kept; in several cases the original is already back at its path. But an unverifiable change cannot be resolved from the list (`NO_CHOICE`), so the project stays blocked: stuck, not harmed.
- **Is it reachable in real code?** Only where one change both appends to a file and rewrites or trashes that same file. Change logs and audit logs are only appended to, so they are not affected. I did not check every caller of `appendLine`.

The full list of the 16 cases:
- From a file:
  - [replace,append] k=2
  - [append,replace] k=0
  - [trash,create,append] k=3
  - [replace,replace,append] k=3
  - [replace,append,trash] k=3
  - [replace,append,replace] k=3
  - [replace,append,append] k=2
  - [append,trash,create] k=0
  - [append,trash,append] k=0
  - [append,replace,trash] k=1
  - [append,replace,replace] k=0 and k=1
  - [append,replace,append] k=0
  - [append,append,replace] k=0
- From no file:
  - [create,replace,append] k=2
  - [create,append,replace] k=0

## Runs

Each file was run alone at `nice -n 5`:

| File | Result |
|---|---|
| `rollback-rerun` | 7/7 |
| `rollback-own-writes` | 14/14 |
| `sources-read-race` | 13/13 |
| `pending-writes` | 22/22 |
| `repo.test` | 61/61 |
| `annotations` | 42/42 |
| `workspace-tags` | 10/10 |
| `retention` | 23/23 |
| `move` | 70/70 |
| `recovery-code` | 27/27 |
| `key-lock-race` | 11/11 |
| `import/bulk/disk-full` | 14/14 |
| `seams-inert` | 3/3 |

- `pnpm --filter @ao/library typecheck`: clean.
- No `txn*.test.ts` file exists. The recovery tests found by the grep are the files listed above.
- No time-limit failures.
- `git status --short`: empty.
