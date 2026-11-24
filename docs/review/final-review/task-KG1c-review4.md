# KG-1c: a short check of the close guard's mend (4e83973..a4ba523)

I worked in `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, detached at a4ba523. No product code was changed and nothing was committed. The probe `close-guard.probeKG1e.test.ts` has been deleted. `git stash` was never used, no permission check refused anything, and `git status --short` is empty.

## Verdict: approve

There are no findings. Three small observations follow at the end; none needs a change.

## 1. The I1 probe again

My probe from review 3 is the shape C d/f, then trash d and make it again, then copy q into d/f, rewrite d/f, and trash q, with both kept copies deleted. It was rebuilt through `repo.mutate` and run at both moments ("as crashed" and "undone").

In both runs:
- From the bytes on disk, q's bytes are held only in a kept copy.
- The guard says "kept".
- The list shows `lost-copy-stuck` with `canClose: false`.
- The close is refused with `PendingWriteIncompleteError`.
- A walk of the whole library, `.tmp` and the audit included, is identical before and after the refused close.

## 2. The new rule's edges

These are proved by reading the function's shape (`txn.ts`, `backupHoldsOriginal`), and the probes below confirm them.

- **It can only add "kept".** The new line is an early `return true`, and it fires only on a `trashed` or `dir` line. Before the mend, that same line took the next branch, `continue`. No other line's handling changed.
  - So for each `replaced` line the answer either stays the same or goes from false to true, never from true to false.
  - `keptCopiesLeft` uses the answer only as a filter (`e.kind === "replaced" && backupHoldsOriginal(...)`), and it answers "kept" if any line is kept. An answer that moves from false to true can therefore only add "kept".
  - The trashed-copy rule is untouched.
- **Sibling names** (`d` against `d2/f`, `dir` against `dir-old/f`): `"d2/f".startsWith("d/")` is false, so the line is not counted as covering and the scan continues exactly as before.
  - Probe: the change writes its own `d2/f`, trashes `d`, then rewrites `d2/f`. The guard says "not kept", which is true: nothing of the researcher's is held. The close went through and nothing was destroyed.
  - Probe: the same with a copy of q into `d2/f`. The guard says "kept", which is true (the R533 (4) rule).
- **A trailing slash or a doubled slash**: the marker's reader would accept `d/`, because `LibraryRelativePath` does not forbid it. But no build writes one: `toRel` is `path.relative`, joined with `/`.
  - Even with such a line, the stop is merely missed. The function then falls back to its old behaviour and never answers "not kept" where it said "kept" before. (This is reading only.)
- **A covering line after the rewrite**: the loop runs only over `j < i`, so a later line cannot affect that rewrite's backup.
  - Probe: C d/f, R d/f, then trash d, with q lost. The guard says "not kept", which is true; the close went through and nothing was destroyed.
- **A `trashed` line's `from` against a `dir` line's `path`**: both are library-relative paths written by `toRel`. Both are compared the same way.

## 3. The folder table

**The generator is honest.** `folderSequences` grows every sequence of one to four steps that the transaction can take:
- C or K only where `d` exists and `f` does not;
- R or T only where `f` exists;
- M only where `d` does not exist;
- D or X only where `d` exists.

It keeps every sequence that has at least one folder step, deduplicated by name, from each of the three starts. The total, 405 cases, is printed by the table. Every trashed copy is deleted after the crash.

**The oracle does not depend on the guard.** It works from the bytes alone: it walks `.tmp` into folders and checks the snapshot of the library outside it. It shares no logic with the guard.

The table asserts `onlyKept ⇒ guard`, never fewer. Where the guard holds, it checks that nothing changed. Where the guard lets a close through, it checks that nothing a kept copy held was lost.

Observation: unlike the first table, it does not assert `guard === expected`, so how often it refuses too much is not pinned. That is acceptable for a safety property.

**My own shapes.** All were built through `repo.mutate` and run at both moments. In every row the guard agreed with the bytes, and the close destroyed nothing.

| Shape | Held only in a kept copy | Guard | Close |
|---|---|---|---|
| Nested folders: C d/e/f, trash d/e, trash d, mkdir d/e, K q→d/e/f, R, T q | q | kept | refused, disk unchanged |
| Nested, only the inner folder made again: C d/e/f, trash d/e, mkdir d/e, K, R, T q | q | kept | refused, disk unchanged |
| A move between folders: K d1/f→d2/f, trash d1/f, R d2/f | the original of d1/f | kept | refused, disk unchanged |
| A move into a folder made: mkdir d2, K d1/f→d2/f, trash d1, R d2/f | the original of d1/f | kept | refused, disk unchanged |
| The I1 shape with the folder trashed twice: C d/f, X, X, K, R, T q | q | kept | refused, disk unchanged |
| Sibling prefix, the change's own bytes (above) | nothing | not kept | closed, nothing destroyed |
| Sibling prefix with a copy (above) | q | kept | refused, disk unchanged |
| A covering line after the rewrite (above) | nothing | not kept | closed, nothing destroyed |
| The I1 probe (section 1) | q | kept | refused, disk unchanged |

## 4. Runs (each alone, `nice -n 15`)

| File | Result |
|---|---|
| `close-guard.test.ts` | **942/942**. The old table's counts are unchanged (undone 6/58, as crashed 48/16, held only in a kept copy 47). The folder table: 405 cases, undone 104/301 and as crashed 104/301, held only in a kept copy 162, closed 546, let through but not closed 56, refused 208. |
| `pending-writes.test.ts` | 22/22 |

## Observations (no action needed)

- Review 3's M1 is unchanged: the over-refusal in a folder the change made, with its untrue "a backup is the way" words. It stays on the coordinator's list. The mend neither caused it nor made it worse.
- In the folder table, the "undone" and "as crashed" counts are identical, as the implementer noted. With every kept copy deleted, the opening's undo does not change what the guard reads in these shapes.
- The a4ba523 commit changes comments only (review 3's M2).
