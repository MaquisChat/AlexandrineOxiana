# KG-1b fix round: second look (R526), `kg-1b-fix` b72caae..f1b7f5d

**Verdict: APPROVE WITH SMALL POINTS.** The findings are 1 Important (it needs a ruling and is a one-branch change), 2 Minor and 0 Critical.

**Scope.** Checkout `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look` at f1b7f5d. I read the five commits and `git diff b72caae..f1b7f5d` (7 files: `txn.ts`, `mutate.ts`, `seams.ts` and four test files), Ruling R526, the implementer's report, and build 10 at `main` (2d12ab1).

**What changed overall.**
- Nothing outside the roll-back moved.
- The cause kinds are unchanged; M4 uses the existing `path-occupied`.
- The old enumeration's operations (`OPS`) and its asserted counts are unchanged.

## Runs (single files, `nice -n 15`)
- `rollback-rerun.test.ts`: 30 passed, 52.9 s.
- `rollback-hand-put.test.ts`: 41 passed.
- `rollback-own-writes.test.ts`: 14 passed.
- `pending-writes.test.ts`: 22 passed.
- `txn-completion.test.ts`: 9 passed.
- `seams-inert.test.ts`: 7 passed.
- **Scratch check of the new seam:** with the `NODE_ENV` guard removed from `identityOf`, the "identityLook … never under production" test fails (1 of 7). Restored with `git checkout`; all 7 pass again.
- `lock-mid-read.test.ts` was not run again, as instructed.
- Probe file `src/repo/rollback.probeKG1b2.test.ts`: 7 probes, deleted. `git status --short` is empty at the end.

## Findings

### Important

**I1. A folder the change made, found with another identity, counts as "done". When the folder at the path is the change's own under a new identity, the roll-back is reported complete with pieces of the change left behind.**
- **Where:** `txn.ts` `undoEntries`, the `dir` step, `if (!own) continue;` (about l.541–556).
- **The rule as built:** a mismatch at a `dir` line's path always means "a person's folder, the step already done".
- **When that is wrong:** the change's own folder gets a new file number and birth time whenever the library is copied between the crash and the reopen:
  - a Finder copy to another disk;
  - a restore from a backup;
  - a sync client downloading the folder again.
  - (The app's own move refuses when a marker is pending; `move.ts` blocks "pending-writes".)
- **Why things are left behind:** named files are still removed one by one by their own lines. Things no line names are removed only by the folder's `rm -r`, and that no longer runs:
  - a file the change appended to inside the folder;
  - a subfolder;
  - the temporary file of a copy cut mid-way.
- **Probe ("a library copied", end to end):**
  1. One change runs `mkdir made/sub`, writes `made/f.txt`, copies to `made/c.txt`, and appends to `made/log.jsonl`; a crash happens before the audit.
  2. The library is copied with `fs.cp` (times preserved) and opened from the copy.
  3. **Result:** `markers=0, causes=[]`, and the folder still holds `["log.jsonl","sub"]`.
  4. **Control (no copy):** everything is removed.
  5. At b72caae this case removed the folder.
- **Why it matters:** this is a half-undone change reported as rolled back, which is the safe side the trashed lines keep (R519 (4), R526: "where it cannot be confirmed it is incomplete and closable") applied the other way round.
- **Direction:** on a mismatch, leave the folder and answer incomplete with `path-occupied` and the path (closable by KG-1c), instead of "done".
  - Probe D's person's folder is still never deleted; it then ends "incomplete, closable" instead of "complete".
  - Probe D's test and the folder enumeration's "between two undos / before the first undo" cases would change with it.
- **Needs the coordinator's ruling:** R526 says only "removes a folder only when it is the change's own".

### Minor

**M1. On a Linux system without `statx`, a folder's birth time may move as soon as the change writes inside it, with I1's outcome after an ordinary crash (reading only, not verified).**
- When `statx` is unavailable (an old kernel, or a sandbox that blocks it), libuv, which Node uses for file-system calls, reports the inode change time as the birth time.
- For a trashed original the look after the rename catches this (a rename changes that time), and a `noIdentity` line follows.
- For a folder the change made there is no second look: its identity is taken at `mkdir`, and adding a file inside it changes the time at once. The change's own folder would then be judged "another folder", and I1 follows.
- I did not prove libuv's fallback here. This machine (Linux 6.18, ext4 and tmpfs) gives real birth times that do not move when entries are added: measured.
- **Direction:** the same as I1. Or check the folder's identity once more at the commit or after its last write, the way the trash does.

**M2. Where the rename does not keep the birth time, a `noIdentity` line is judged by KG-1a's rule, so R509 M2 returns on that file system.** This is accepted by R526 ("judged as an older build's"). With the kept copy gone and another file at the path, the result is `{ok:true}`. It belongs on the FR-746 list beside the coarse-clock note.

## The points asked

**1. I1 with M3: sound.**
- **Probe C again:**
  - a `.DS_Store` written in the put-back source folder, and its `source.json` rewritten in place;
  - the blocking file moved away;
  - result: complete, with both left as the researcher left them.
- **A put-back file edited in place,** then the blocking file moved away: complete, with the edit kept.
- **Probe F with the new fields:** the file number was reused (`true`) but the birth time differs, so the result is `kept-copy-gone`, nothing is cut, and the person's bytes are intact.
- **A line with an identity followed by a `noIdentity` line for the same move,** compared with an older build's line (no identity) in six states:
  - kept copy gone, with the change's own bytes / another file / nothing at the path;
  - kept copy there, with the path empty / holding the change's own file / holding a hand-put file.
  - The outcome, the causes and the bytes at the path and in the copy are identical in all six. That is KG-1a's rule exactly.
- **A crash between the two lines:** by reading, an original put back then gives `kept-copy-gone`, closable. That is the safe side, and it is tested by the implementer.
- **(a) The coarse clock:** a collision needs the same file number *and* a birth in the same tick of about 4 ms.
  - For a trashed original, the original would have to be born within that tick of the new file. That is impossible by hand.
  - For M2, the person would have to make a folder within milliseconds of the undo removing the change's folder.
  - On APFS, file IDs are not reused at all (reading).
  - Only a program can do it. Agree to list it.
- **(b) The reader is not stricter for any marker a released build wrote.**
  - The new checks in `markerProblem` fire only when `ino`, `birthtimeNs` or `noIdentity` is present.
  - `main` writes none of them: its `trashed` lines carry `from`, `to` and `shred`; its `dir` lines carry `path`; its `created` lines carry `path` and `sha256`.
  - So a build-10 marker passes exactly as before.
  - Its no-identity `trashed` and `dir` lines take the unchanged older branches. The only exception: a folder now standing at a `created` path gets the cause `path-occupied`. Before, it was a bare incomplete; the outcome class is the same.
  - The 26 build-10-shaped markers (`legacySteps`: no identity) and KG-1a's tests pass.
  - Note: the other 153 of the "179 old cases" now run with markers written by this build, so they are not by themselves proof for build-10 markers. The proof for those is the reading above.
  - Only b72caae markers (unreleased) are refused.

**2. M2.**
- Probe D at the line level: the person's folder, moved in, is left with `mine.txt`, and the result is complete.
- The ordinary crash: the change's own folder is removed with its files (the implementer's test, the folder enumeration and my control).
- Without a birth time: no completion line, removal as before (the implementer's seam test; reading).
- Exception: I1.

**3. M4 and M5.**
- M4: a folder at a `created` path gives `path-occupied` with the path, and nothing is removed (the implementer's three tests; reading `txn.ts` about l.530).
- M5: both `failLook` sites and `identityLook` are in `seams-inert.test.ts`. The scratch check shows the new one bites.

**4. M6.**
- **The generators are honest.**
  - `writeSequences` filters with the same `takes` rule.
  - `EXPECTED_COPY` (8/16/30/52 = 106) and `EXPECTED_BEFORE` (13/14/35/38 = 100) are asserted.
  - Folder cases count "applies / not applicable": 30/0, 12/18, 13/17. They are not applicable where D holds the change's own folder, which is R525 (3)(b).
  - Kept copies of a folder are now compared as trees.
- **The three "written over in place" cases now expected COMPLETE** (`editedOriginal`: `startExists`, first op `trash`, cut = lines): right under R526, because an edited put-back original is still the original.
- **Time alone:** 52.9 s here (60.9 s reported).

**5. Nothing else moved.** Confirmed by the stat and the passing files.

## What build 10 does with the two doubled lines (read: `git show main:packages/library/src/repo/txn.ts`, `markerProblem` l.294–339, `undoEntries` l.212–271)

**The parser.** `markerProblem` accepts both doubled lines:
- `case "trashed"` checks `from` (under the project), `to` (this transaction's trash in `.tmp`) and `shred` (a boolean if present); `noIdentity`, `ino` and `birthtimeNs` are ignored.
- `case "dir"` checks `path`, and refuses only a `sha256`.
- No unknown kind is added.

**Two `trashed` lines `{from P, to T}` then `{from P, to T, noIdentity}`.**
- **First pass** (l.215–230): `putBack = !exists(T)` is computed for each line before any undo. If T still exists, nothing is marked. If T is gone, every later line at P is marked done, the second `trashed` line included.
- **Reverse pass** (l.238–268): the `noIdentity` line comes first. `exists(T)` → if P is empty, `renameWithRetry(T, P)`; if P is occupied, `ok = false` (the copy kept). Then the first line: `exists(T)` is now false, so nothing is done and nothing fails. If P was occupied, it repeats `ok = false`.
- **Outcome:** no double put-back, no error, no incomplete-for-ever. It is identical to one line.

**Two `dir` lines for D.**
- The reverse pass meets the completion line first. Every line for files inside D was written after it and has already been undone. It runs `rm(D, {recursive, force})`.
- The first `dir` line then runs `rm` on nothing, with `force`, which raises no error.
- **Outcome:** as with one line. Build 10 still removes a folder a person made again (M2 is not mended there), never worse than today.
- Its `changedSinceMarker` looks only at `created`, `replaced` and `trashed`; two identical trashes of P give the same `putBack`.

## Judged by reading only
- build 10's behaviour;
- APFS birth times and file IDs;
- libuv's fallback without `statx` (M1);
- the coarse-clock collision.
