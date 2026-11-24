# KG-1b fix round: report (Ruling R526: I1 with M3, M2, M4, M5, M6)

Checkout `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, branch `kg-1b-fix` from b72caae. Not pushed. `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1` was not touched. No new cause kind was added and none renamed. No permission check refused anything.

Commits (each with its tests; head **f1b7f5d**):
- `c5a55df`: I1 with M3, the original's identity.
- `7d6d1e6`: M2, a folder the change made.
- `3c741a4`: M4, a folder at a created file's path.
- `ea0e592`: M5, the seams' central proof.
- `f1b7f5d`: M6, the enumeration.

## Per point

| Point | What changed (file:line, at the head) | Its test; failed first? |
|---|---|---|
| **1. I1 with M3** | `txn.ts`: the `trashed` line's identity fields are now `ino` and `birthtimeNs` (strings), plus the flag `noIdentity` (l.63–72). `FileIdentity` is `{ino, birthtimeNs}`. New `identityOf` (l.91): `lstat(…, {bigint:true})`, through the seam; undefined when the birth time is 0. New `TxnLog.identityNotKept` (l.267). New `trashedIdentity` (l.353): a line's identity, or none when a later line for the same `from`/`to` says `noIdentity`. `isOriginal` (l.365) now compares the file number and the birth time only. The "number only" check is gone: "the original" and "changed by the change" are one branch (l.467). A `noIdentity` line is skipped in both passes (l.446, l.514): its first line undoes the move. `markerProblem` (l.676–682): `ino` and `birthtimeNs` whole or absent; `noIdentity` must be `true` and carry no identity; `size` and `mtimeNs` are no longer read. `mutate.ts moveToTrash` (l.318–331): identity before the line → line → rename → a second look at the kept copy → `identityNotKept` when the identity is missing or changed. `seams.ts` (l.29, l.42–47): `identityLook` (NODE_ENV=test only). | `rollback-hand-put.test.ts` l.435, "R526 I1 (with M3)", 9 tests: probe C end to end (a `.DS_Store` written in the put-back folder, the blocking file moved away → complete); an edit in place of a put-back file → complete, the edit kept; the line's exact fields; the no-birth-time stand-in; the birth-time-not-kept stand-in; the control; probe F; a marker cut between the two lines; a folder with a file added. **Failed first: 8 of 9** for the right reasons (only the control passed; the existing "crash between the trashed line and its rename" also failed until its helper took the new fields). Probe C failed exactly as the review said (`kept-copy-gone`), the edit-in-place case likewise, and probe F returned `{ok:true}` and cut the file short. |
| **2. M2** | `txn.ts`: `dir` line gains `ino` and `birthtimeNs` (l.63–69). `TxnLog.dirMade` (l.225). `dirIdentity` (l.379): the next `dir` line at the path, before a trash at or above it. Undo (l.515, l.541–556): a `dir` line with an identity is a completion and is skipped; the first line removes the folder only when `isOriginal` matches; another thing at the path is left and the step counts as done; a failed look is `could-not-look` and blocks. Without an identity, as before. `markerProblem` (l.660): a folder's identity is whole or absent, and only on `dir`. `mutate.ts` l.242–243: `dirMade(first)` right after a successful `mkdir`. | `rollback-hand-put.test.ts` l.605, "R526 M2", 7 tests: the completion line's fields; **probe D** through the transaction (first undo cut after all its steps at a reopen, a person's folder with `mine.txt` moved in → `mine.txt` kept, complete, twice); the ordinary crash (the change's folder with its own files and a subfolder removed); no birth time → no second line, removal as before; lines level: another folder left (twice), a file left, no identity → removed. **Failed first: 5 of 7** (probe D: `mine.txt` gone). The two that passed are the "as before" controls. |
| **3. M4** | `txn.ts`: `Look` gains `folder` (l.312, l.320). A `created` line's undo with a folder at the path blocks with `path-occupied` and the path (l.530), whether or not the change knows the bytes. A replaced line with a folder at the path is unchanged (`hand-changed-file`, l.575). | `rollback-hand-put.test.ts` l.716, "R526 M4", 3 tests: probe E3 (cut copy) → was `{ok:false, causes:[]}`; a copy with its completion line → was `hand-changed-file`; a written-whole file → was `hand-changed-file`. Each is now `path-occupied`, twice, with the folder and its file kept. **Failed first: 3 of 3.** |
| **4. M5** | `seams-inert.test.ts` l.85–131: `seams.failLook` at the look of a written file and at the look of a trashed original's identity; `seams.identityLook`; `seams` not exported from the package's entry. No product change: the guards were already there. | Passes on the code as it was (no defect: a missing proof). **Shown to bite:** with the `NODE_ENV` guard removed from `isOriginal` and from `identityOf`, 2 of 7 fail; both guards restored with `git checkout`. |
| **5. M6** | `rollback-rerun.test.ts`: the `copy` op and `step()` (l.359–392); `runCase(…, strict)`, in which an ordinary crash must be complete; `handPutCase(…, moment)`; `treeOf`, so kept copies are compared byte for byte for folders too; three new blocks (l.852, l.883, l.1040) with `folderCase`. | See "The enumeration". All new cases pass. Against b72caae's `txn.ts`, `mutate.ts` and `seams.ts`, the copy and before-the-first-undo blocks pass, as the reviewer's probe H did (a gap in coverage, not a defect). The three folder blocks fail: 30, 40 and 62 failures. Most come from the line counts the old marker gives. Behavioural ones: I1 (a trashed folder put back, a file added inside: `kept-copy-gone`), and M2 shapes reported complete with the original not at its path. |

## How "only where it holds" reaches the marker

1. `moveToTrash` takes the identity (`ino`, `birthtimeNs`) of the original with `lstat` before anything else. If the birth time is 0, there is no identity, and the `trashed` line carries none. That line is judged as an older build's (KG-1a's `ownBytesAt` rule), and no second line is needed.
2. The `trashed` line, with that identity, is written durably BEFORE the rename (unchanged order: the marker's whole point).
3. The rename.
4. The kept copy is looked at once more (`identityOf(to, "trash-after")`). If the look fails, or the file number or birth time differs, a second `trashed` line for the same `from` and `to` is written with `noIdentity: true` and no identity. It is written after its step, through the same atomic marker rewrite (`TxnLog.add` → `writeSmallFileAtomic`) as the completion `created` line of this task. So the marker on disk holds either the first line alone or both lines. The first line is never rewritten.
5. The undo resolves a `trashed` line's identity with `trashedIdentity`: none if any later line for the same move says `noIdentity`. Then:
   - With no identity, the line is judged as an older build's.
   - With an identity, what has it at the path is the original; anything else is `kept-copy-gone`. The `noIdentity` line is never a step of its own.

**A marker cut between the two lines** (a crash after the rename, before the second line, on a file system whose rename did not keep the birth time):
- **The kept copy is still there:** the undo puts it back by rename and the identity is never consulted. This is complete, as for any marker.
- **The kept copy is gone** (an earlier undo put it back, or a person deleted it): the original at the path does not match the recorded birth time. The undo answers incomplete with `kept-copy-gone` at that path. Nothing is deleted, moved or cut (the path is blocked, and no line at or under it is undone). KG-1c can close it.
  - That is the safe side.
  - It cannot go the other way: a rename that does not keep the birth time gives the original a new one. Another file never matches the recorded number AND birth time, short of the coarse-clock case below.

**For folders (M2)**, nothing is renamed:
- The completion `dir` line is written after a successful `mkdir`, only when the birth time is not 0.
- A crash between the `mkdir` and that line leaves the folder without an identity, and its undo is as before (`rm -r`).

## What Mac build 10 does with each new line (by reading `git show main:packages/library/src/repo/txn.ts`)

**`trashed` with `ino` and `birthtimeNs` instead of `size` and `mtimeNs`.**
- `markerProblem` checks only `from`, `to` and `shred` on a `trashed` line, and ignores other fields. The marker is valid.
- Its undo ignores the identity and judges as R491/R493 did.

**A second `trashed` line `{from, to, noIdentity: true}`** (same `to`, no `shred`).
- It is valid for the same reason.
- **Copy still there:** the reverse pass meets the second line first. It renames the copy back when the path is empty, or sets `ok = false` when the path is occupied (the copy kept). The first line then finds no copy (nothing to do) or does the same as the second (`ok = false`).
- **Copy gone:** its first pass marks every later line at that path done (the second line included), so nothing is undone twice.
- `finishCommittedSteps` shreds only lines with `shred` (the first), then removes `to` once per line with `force`. Harmless.
- `changedSinceMarker` sees two trashes of one path with the same `to`, and gives the same result as with one.

**A second `dir` line `{path, ino, birthtimeNs}`.**
- `markerProblem`'s `dir` case checks `path` and refuses only a `sha256`. The marker is valid.
- Its undo runs `rm -r` with `force` on each `dir` line. The completion line (the later one) removes the folder; the first then finds nothing.
- Its R493 rule covers both lines at the path.
- So build 10 still removes a folder a person made again (M2 is not mended there), never worse than today.

**`created` lines:** unchanged by this round.

## Existing assertions changed, and why

1. **`rollback-rerun.test.ts` `handPutCase`** (the case "written over in place" after a cut that had put the original back). It required "incomplete". Now (`editedOriginal`, l.726) it requires COMPLETE with the person's bytes at the path, because the file written over in place IS the original (same number, same birth time), edited (R526). By construction this is `startExists && seq[0] === "trash" && cut === lines` with "written over in place".
   - Shown exact: with the new branch disabled, precisely these 3 cases fail, at the second and third reopen each:
     - `[trash, create]` cut 2;
     - `[trash, create, trash]` cut 3;
     - `[trash, create, replace]` cut 3.
2. **`txn-completion.test.ts`:**
   - "R519 (3)" now asserts the exact line `{kind, from, to, ino, birthtimeNs}`. It used to assert `ino`, `size` and `mtimeNs`.
   - The reader tests now use `ino` and `birthtimeNs`, and add `noIdentity` and the `dir` identity (accepted), plus a partial identity, `noIdentity: false`, `noIdentity` with an identity, `ino` on a `created` line and a `dir` line with `ino` alone (all refused).
   - "files written inside a folder the change created" now expects the folder's completion `dir` line after its `dir` line (M2).
3. **`rollback-hand-put.test.ts`**, "a crash between the trashed line and its rename": its `identity()` helper now gives `ino` and `birthtimeNs` (it gave `ino`, `size`, `mtimeNs`). The test failed on the old code until changed, as expected.
4. `rollback-rerun.test.ts` `keptCopies` now snapshots a folder copy as a tree (before, a folder copy read as "absent" and was silently not compared). For a file it gives the same base64 as before.

No assertion was loosened, no test skipped.

## The enumeration: counts and times

**New in `rollback-rerun.test.ts`.** Counts are asserted by `EXPECTED_*` constants, worked out by hand in the comments.

| Block | Cases | Time alone |
|---|---|---|
| Copies with their completion lines (probe H), all 2- and 3-step sequences of trash/copy/create/replace containing a copy, every cut, ordinary + hand-put (a new file put in its place, between two undos) | **106** (8 + 16 + 30 + 52) | about 8.7 s |
| A file put there by hand **before the first undo** (crash, hand, the reopen's roll-back cut at each step, then two more reopens), every sequence of trash/copy/create/replace | **100** (13 + 14 + 35 + 38) | about 9.5 s |
| Folder path: a trashed FOLDER (original with `a.txt`) and a folder the change made (with `f.txt`): `[trash]`, `[trash, make]`, `[trash, make, trash]` from the original; `[make]`, `[make, trash]`, `[make, trash, make]` from none; every cut | ordinary **30**; hand between two undos **12** apply (3 add a file inside the put-back original, 9 move a person's own folder into an empty D), 18 find the change's own folder at D; hand before the first undo **13** apply, 17 not | about 5.8 s |

- **"Not applicable" means:** D holds the change's own folder at the person's moment. A file added inside it is R525 (3)(b), listed on FR-746, and is not protected by this round.
- **The person's folder is made before the change runs, then moved in.** This keeps the file system from handing it the change's freed file number within the same clock tick (see below).
- **What every case asserts:**
  - An ordinary crash is complete after the second and third roll-back, with the path (or folder tree) as before, byte for byte.
  - What the person put is at the path byte for byte after every run.
  - Incomplete: a known cause at or under the path, and every kept copy unchanged (folders compared as trees).
  - The third run changes nothing the second left.
  - From an original, a person's own thing at the path is never "complete".
  - The original with a file added is complete.

`rollback-rerun.test.ts` alone, whole file: **30 passed, 60.9 s** (it was 28.8 s). That is under two minutes, so it was not split. The earlier blocks are unchanged: R493 179 cases, R519 94 hand-put cases and their equal-bytes runs.

## NEEDS A RULING

None that blocks what is built. For the record:

1. **The coarse clock** (measured here: two birth times taken in a row were exactly 4 ms apart).
   - Birth times have the kernel's coarse resolution. If a thing is deleted and another made at the same path within the same tick, and the file system hands it the freed number, the two have the same identity.
   - **Trashed originals:** the original is never deleted by the app. The case needs a person or a program to delete the kept copy and make a file at the path within milliseconds.
   - **M2:** the change's folder must be removed by the undo and a person's folder made at the path in the same few milliseconds.
   - Neither can happen by hand. I recommend listing it with FR-746 beside M1 rather than building anything.
2. **A marker written by the unreleased b72caae build** (`ino`, `size`, `mtimeNs`, no `birthtimeNs`) is now refused as invalid ("bad trashed entry": an identity that is not whole). Under R526 the ruled identity cannot be judged on part of it.
   - No released build wrote such a marker: `main`/build 10 writes no identity.
   - Only a library opened by a development build of KG-1b, which crashed mid-change, could hold one. If KG-1c's joined branch must read such markers, the reader could instead treat `ino` without `birthtimeNs` as "no identity".

## Not built
M1 (FR-746), as the brief says.

## What only a real Mac can show
- APFS giving a birth time, and keeping it (and the file number) across a rename and an edit in place. Documented, not measured here. Here: ext4 with `statx`.
- A volume with no birth time (FAT/exFAT, some network shares) is simulated through `seams.identityLook`.

## Runs (each alone, `nice -n 10`, single files, `@ao/library` unless named)
- `src/repo/rollback-rerun.test.ts`: 30 passed (30), 60.88 s
- `src/repo/rollback-hand-put.test.ts`: 41 passed (41)
- `src/repo/rollback-own-writes.test.ts`: 14 passed (14)
- `src/repo/pending-writes.test.ts`: 22 passed (22)
- `src/seams-inert.test.ts`: 7 passed (7)
- `src/repo/txn-completion.test.ts`: 9 passed (9)
- `src/repo/recovery-code.test.ts`: 27 passed (27)
- `src/repo/repo.test.ts`: 61 passed (61) (it uses `failUndo = "dir"`)
- `src/move.test.ts`: 70 passed (70) (same)
- `src/import/bulk/disk-full.test.ts`: 14 passed (14) (same)
- `src/repo/lock-mid-read.test.ts`: 44 passed (44), 699.99 s
- `pnpm --filter @ao/library typecheck`: clean
- `pnpm --filter @ao/library-service typecheck`: clean
- `git status --short`: empty
