# KG-1c: a scoped third look at the close guard (`keptCopiesLeft`) and the last small changes (47302d6..4e83973)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, detached at 4e83973. No product code was changed and nothing was committed. Two scratch edits of `txn.ts` were each restored at once with `git checkout --`. The probe `packages/library/src/repo/close-guard.probeKG1d.test.ts` has been deleted. `git stash` was never used, `…/kg-1` was not touched, no permission check refused anything, and `git status --short` is empty.

## Verdict

**Not approved as it stands: 1 Important, 2 Minor.** The guard's own property fails for one shape. The fix is one line plus cases for the table, and once that is done I would approve. Everything else in the range is sound.

## Findings

### Important

**I1: the guard says "not kept" while the researcher's bytes are held only in a rewrite's backup, and a real close then destroys them.** This is the copy shape that R533 (4) ruled must be held, reached through a folder that the change trashed and then made again.

- **Where:** `packages/library/src/repo/txn.ts:1062`, in `backupHoldsOriginal`:
  ```ts
  if (x.kind === "trashed" || x.kind === "dir" || x.path !== path) continue;
  ```
  The scan goes back past a `trashed` line that covers the path (the path itself or a folder above it) and past a `dir` line above the path. It can therefore reach a line about a file that is no longer the one being rewritten. The report's premise, "a path trashed and then made again always passes through a 'created' line, or a 'dir' line above it", is true. But the code skips that `dir` line instead of stopping at it.
- **Probe, run through `repo.mutate`:** the researcher has a folder `d` (holding `g.txt`) and a file `q.txt`. The change does these steps in order:
  1. `writeFile d/f`, which writes `created(sha)`, the change's own label;
  2. `trash d`;
  3. `mkdir d`, which writes `dir`;
  4. `copyFile(q → d/f)`. This file is inside a new folder, so the change writes only a completion line and no `created` line without a hash;
  5. `writeFile d/f`, which writes `replaced`. Its backup holds q's bytes;
  6. `trash q`.

  Then there is a crash, and the kept copies of `d` and `q` are deleted.
- **What happens:**
  - The scan from the `replaced` line skips the completion line, the `dir` line and the `trashed` line, and stops at line 1, `created(sha)`. It answers "the change's own".
  - The guard says `false`. The list shows `lost` with `canClose: true`.
  - From the bytes on disk, q's bytes are held only in `.tmp/txn-….orig-0`.
  - `closePendingWrite` closes the change. Afterwards q's bytes are nowhere in the library.
  - The same happens at both moments, "as crashed" and "undone".
- **Reach:** no flow of this build copies into a remade folder and then rewrites the copy (the same class as R533 (4)'s residual shape), and two kept copies must be deleted by hand. So it is rare. But it is the exact property the guard exists for, and R533 ruled that this class is closed now.
- **Mend I tried by scratch edit (restored):** stop the scan with `true` at a `trashed` or `dir` line whose path is the path or a folder above it:
  ```ts
  const at = x.kind === "trashed" ? x.from : x.path;
  if ((x.kind === "trashed" || x.kind === "dir") && (path === at || path.startsWith(`${at}/`))) return true;
  ```
  With this change, all 29 of my probe's cases pass and the table still passes 130/130 **with identical counts**.
- **Why the table did not catch it:** the table is generated at one path in an existing folder. It never crosses a folder boundary, and its oracle reads a folder's trash copy as "(not a file)" (`close-guard.test.ts:133`), so it could not judge a folder shape anyway. Its oracle is independent of the guard (it works from the bytes), but its set of shapes leaves out the boundary the guard mishandles.
- **Direction:** add the stop above, and add table cases that trash `p`'s parent folder and make it again (C·Tdir·mkdir·K·R, and the same with R or C in place of K), with an oracle that walks folder trash copies.

### Minor

**M1: in a folder the change made, the over-refusal (point 3) is on the safe side, but its words are untrue there.**
- **Probe:** the change trashes `q` (its kept copy is deleted), runs `mkdir n`, then writes `n/f` twice.
- **What happens:** the guard says `true` at both moments, although nothing of the researcher's is kept. The state is `lost-copy-stuck` and no close is offered.
- **What the researcher is told** (`interrupted-changes.ts:97`, and the list line at :153): "The app still keeps a copy of another file of the change, which it cannot put back either, and closing the change would let that copy go… Restoring the project from a backup made before the change is the way to undo it." This is not true here: the kept copy holds only the change's own bytes, and closing would be harmless.
- **Is it safe?** Yes. It only ever refuses too much. I found no case where it refuses too little, and my mend for I1 does not make it worse.
- **For the coordinator:** list it. Telling the two kinds of file apart would need a field on the completion line.

**M2 (reading only):** `lost-and-try-again` is also chosen for a cause kind this build does not know, and its words then say "A step of the undo also failed". This is roughly true. It only arises when the service and the screen run different builds.

## Point 1: every shape I tried (the guard's answer, against what the bytes showed)

| Shape | Moment | Held only in a kept copy (from the bytes) | Guard | Right? |
|---|---|---|---|---|
| C d/f, T d, mkdir d, K q→d/f, R d/f, T q (copies of d and q gone) | as crashed | q | not kept, and the close destroyed q's bytes | **NO (I1)** |
| same | undone | q | not kept, and the close destroyed q's bytes | **NO (I1)** |
| R d/f, T d, mkdir d, K q→d/f, R d/f, T q | both | f's original and q | kept | yes (saved by the first backup) |
| folder: R d/f (first rewrite), T d (copy gone) | both | f's original | kept | yes |
| T p, C p, R p (p's trash copy gone) | both | nothing (p's original was lost before the close) | not kept | yes |
| R p, T p, C p, R p, q lost | as crashed / undone | p's original / nothing | kept / not kept | yes |
| new folder: mkdir n, C n/f, R n/f, q lost | both | nothing | kept | safe side (M1) |
| encrypted: R p, R p, q lost (stored bytes compared) | as crashed / undone | p's original / nothing | kept / not kept | yes |
| encrypted: K q→p, R p, T q | both | q | kept | yes |
| unreadable backup (a folder at the backup's path) | as crashed | p's original | throws EISDIR: the list shows `lost-copy-stuck`, `canClose: false`; the close is refused; nothing changed | yes |
| hand-laid older marker: `created` without a hash and no completion line (a copy), R, T q | — | q | kept | yes |
| hand-laid: append `created:false`, then R (an older build's mixed shape) | — | p's original plus the appended line | kept | yes |
| hand-laid: append `created:true`, then R | — | nothing (only the change's own appended bytes) | not kept | yes |
| hand-laid: R `A.txt`, then R `a.txt` (case) | — | — | kept | safe side |

By reading:
- **Case and Unicode spellings.** A different spelling never matches the string comparison, so it is treated as a first rewrite, which is the safe side. The same string always names the same file. On a case-insensitive disk, putting the researcher's bytes back behind a variant spelling needs a trash first, and that trash copy counts while it exists.
- **A `created` line where the researcher's file already stood** cannot be written. `writeFile` writes `created` only when `exists()` is false, `copyFile` refuses an existing file, and `mkdir` takes back its line on EEXIST. Only a race inside the write itself could do it, and that destroys the bytes at the write, not at the close.
- **Older builds' markers:** `main` (build 10) writes the same `created` lines: a hash for `writeFile`, none for `copyFile`. Its copies therefore count as kept.
- **"Own" means bytes given to `writeFile`.** I found no flow that writes a library file's bytes to a new path through `writeFile` (I read the callers of `tx.writeFile` and `tx.trash` in `repo/`).

## Point 2: real closes, then a reopen

I compared the library outside `.tmp` byte for byte with its state before the change:

| Case | Result |
|---|---|
| Table probe A (none CR cut 2), as crashed and undone | Closed. Only the q lost beforehand differs; no marker after the reopen; the project takes a change. |
| R p, T p, C p, R p, q lost (undone) | Closed. Only q differs; p's original is back. |
| Encrypted R p, R p, q lost (undone) | Closed. Only q differs. |
| T p, C p, R p (as crashed) | Closed. Only p, already lost, differs. |
| Table probe B (orig RR cut 2), as crashed | Refused. The whole disk is unchanged, `.tmp`, audit and warnings included. |
| Remade folder via R (as crashed) | Refused. The whole disk is unchanged. |
| Encrypted K q→p, R, T q (undone) | Refused. The whole disk is unchanged. |

The failing case is I1's: closed, and q's bytes destroyed.

## Point 4: the other eight commits

All sound:
- **"Try again" where the only other blocker is a failed step:** the words point at no file.
- **Could-not-read:** the "Nothing was lost" sentence is gone. A `copyGone` look leads with the loss and never says "nothing was lost". A copy that could not be read is never called gone, and its place is blocked.
- **The list line for an unreadable kept copy:** `{f}` is shown through `UserText`, the route passes `copyUnread`, and the sentence is true.
- **The route's refusals:** the sentences for committed, invalid, unverifiable and lost-and-try-again are each true of their state.
- **"Opened again" for a trim-only hold:** it is set only when no marker or unattributed marker holds the project.
- **The kept warnings' reader:** known entries keep their unknown fields (`shown` still picks only the known ones), and an entry whose fields cannot be read goes to `others`. When the file is rewritten, those set-aside entries come first; that is harmless.
- **Atomic tests:** `storedSha256` is computed on its own, as the sha256 of the data, of the file read back from disk, or the empty hash.

I checked that the R533 (4) line has a test that fails without it: with `return false` in its place, 10 runs plus the counts check fail.

## Point 5: runs (each alone, `nice -n 15`)

| File | Result |
|---|---|
| `close-guard.test.ts` | 130/130 (counts as reported: undone 6/58, as crashed 48/16, held only in a kept copy 47) |
| `pending-writes.test.ts` | 22/22 |
| `fs/atomic.test.ts` | 23/23 |
| `rollback-rerun.test.ts` | 30/30 (72 s) |
