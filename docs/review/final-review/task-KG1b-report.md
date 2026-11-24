# Batch KG-1b: report (FR-735 with FR-723; R503 c as corrected by **R519**; R509 M1, M2)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from ad99c57. Not pushed. No permission check refused anything.

Commits:
- `3d6585a`: format (completion lines, identity on trashed lines).
- `7c12f3a`: the undo of created and replaced files; causes.
- `7b8e580`: an occupied trashed path.
- `36a0bda`: the identity rule, M1 and M2.
- `9802bd0`: the enumeration, plus a fix it found in `36a0bda`.
- `b72caae`: the look seam's R47 test.

Head **b72caae**; `git status --short` is empty.

First round: I stopped at the questions and built nothing. R519 ruled the five questions; this round builds them.

## Answers to the questions to answer BEFORE building (first round's answers, kept; changes marked R519)

**Point 1: what the older reader does with a line it does not know.**
- It refuses the whole marker. `markerProblem` returns "unknown entry kind"; `formatVersion` ≠ 1 is refused too. The marker is then invalid: it is kept, nothing is undone, and the project refuses changes until it is resolved.
- It ignores fields it does not know on a known kind.
- **R519 ruled:** no new kind and no version. See "What build 10 does with a marker of this build" below.

**a. Can a completion line be written durably after a streamed copy without changing the commit order or the fsync discipline? Yes.**
- **Where.** `TxImpl.copyFile` (`repo/mutate.ts`), after `copyFileAtomic` returns. By then the copy is synced, renamed into place and its folder synced. The completion line is written by `TxnLog.completed`, a marker rewrite through `writeSmallFileAtomic`, as every line is.
- **Order.** It is still inside `fn(tx)`, before the change log, the audit append and the marker's removal, so the commit order does not change.
- **The stored-bytes hash.** `copyFileAtomic` now also returns `storedSha256`, the hash of the bytes as written, taken in the same loop that writes them (`fs/atomic.ts`). The file is never read twice. Its existing `sha256` is still that of the plain source.

**b. Moving into "the library's trash".** That trash is the transaction's own scratch space: it is emptied at every writable open and the retention rule can destroy files in it. **R519: nothing is moved aside.** Moot.

**c. A read-only open writes nothing; the undo does not run. Confirmed.** `openRepoInternal`: `writable = read-write && !noHeal`; only then do `recoverTransactions` and `sweep` run.

**d. Is the move aside crash-safe?** Moot (R519). The undo also writes nothing to the marker (R519 (3)), so a re-run reads only what the change itself recorded.

## What build 10 does with a marker of this build (read at `main`, 2d12ab1)

**Reading the marker.** `markerProblem` (main, txn.ts) accepts every line this build writes:
- `created` with `sha256` and `complete: true`: only `path`, `sha256` and `kind` are checked; `complete` is ignored.
- `trashed` with `ino`, `size`, `mtimeNs`: only `from`, `to` and `shred` are checked.
- `unsafeOnDisk` checks the paths only.
- So the marker is valid on build 10, and the project is not blocked.

**Undone once by build 10** (`undoEntries` at main):
- **Two `created` lines for one path:** each is `rm -f`, so the second does nothing.
- **A completion line inside a created folder:** its `rm`, then the folder's `rm -r`. That is what build 10 already does for such a file.
- **A `trashed` line:** its extra fields are ignored. It is put back when the path is empty; when the path is occupied, `ok = false` and the copy is kept (R491).
- **Effect.** Build 10 deletes a hand-changed copied file, as it does today. What changes is its `changedSinceMarker`, which now sees the completion line's hash and raises its existing "…the outside change to that file was not kept." That sentence is true on build 10. A copied file is therefore treated as every other hashed file already is on that build, never worse.

**Undone again by build 10.** Its R493 rule ("copy gone → every later line at that path skipped") covers the completion lines, which are at the same path.

**The reverse: a build-10 marker read by this build.**
- **No completion line:** a copied file there is taken for the change's own half-written copy and removed, as before.
- **No identity on a `trashed` line:** it is judged exactly as KG-1a did (`ownBytesAt`).

**R519 (4): a marker of this build half-undone by build 10.**
- Build 10 puts an original back by `rename`, which keeps the file number, size and modification time. The identity is a property of the file, not a record of who put it back, so this build then still recognises the original as put back.
- **The known oddity, on the safe side.** Where build 10 did something else, the identity no longer matches. This build then reports the change incomplete as `kept-copy-gone`, which KG-1c can close. Two cases:
  - build 10 deleted a hand-changed copied file, then a person put another file there;
  - a person edited the put-back original in place before this build reopened it. This is the same oddity as the library-copied case below.

## Point by point

| Point | Still present? | What changed | Its test, and whether it failed first | Note |
|---|---|---|---|---|
| 1 Completion lines (FR-723 format), R519 (2) | Yes: a copy had a `created` line with no hash; in a created folder, no line at all | `txn.ts`: `MarkerEntry.created.complete`, `TxnLog.completed`, `TxnLog.inCreatedDir`; `markerProblem` checks `complete` (must be `true` and have a hash). `mutate.ts`: `copyFile` always writes a completion line; `writeFile` writes one inside a created folder. `fs/atomic.ts`: `storedSha256`. | `txn-completion.test.ts` (new, 9 tests): plain and encrypted copy (the encrypted hash is of the stored bytes, ≠ source), a failed copy has no completion line, created folder, whole write unchanged, the reader's checks. **Failed first:** 5 of 8 at first run (the 3 that passed were the controls; the reader-refusal test passed vacuously at first because of a test-id bug, then fixed and given a control). | No new kind, no version. |
| R519 (3) format: the original's identity on `trashed` | n/a | `mutate.ts moveToTrash`: one `lstat({bigint})` before the line is recorded; the line carries `ino` (string), `size`, `mtimeNs` (string). `markerProblem` checks the identity is whole or absent. | Same file, "R519 (3)". **Failed first.** | **Deviation from R519's wording:** "time of change" (ctime) is replaced by **time of last modification** (mtime). See "The identity" below. |
| 2 Created / replaced: only the change's own bytes are removed or put back over (FR-735; R519 (1)) | Yes | `txn.ts undoEntries`, new helpers `look`, `writeHashes`, `knowsBytes`. **Created:** removed when the bytes are the change's (line or completion hash), or when no hash is known (a cut-off copy). **Replaced:** the backup is put back over nothing, over the change's own bytes, or over bytes kept aside at that path. Otherwise the path is **blocked**: left as it is, no earlier line at, under or above it is undone (a `dir` line would otherwise `rm -r` it), and the cause is `hand-changed-file` (unreadable: `could-not-look`) with the path. `undoEntries` answers `{ ok, causes }`, and every caller is updated (`TxnLog.undo`, `mutate.ts`, `rollBackMarker`, `recoverTransactions`, `pending-writes.ts`). Causes reach `RecoveryResult.causes`, `IntegrityWarning.causes` (only on `rolled-back-incomplete-write`, not passed by the service), and `PendingWriteIncompleteError.causes`. A test-only seam `seams.failLook` (NODE_ENV=test, R47; test of its inertness added). | `rollback-hand-put.test.ts` (new): copied, written, in a created folder, could-not-look, replaced source record, the list's refusal carries the cause, the controls. **Failed first** (7 of 9; the replaced test failed first on a test bug, then was shown failing for the right reason with the check disabled). | **Replaced lines are included**, although R519's "concretely" names only created files and trashed paths. R519's principle ("…delete **or replace**…"), the enumeration it asks for ("the hand-put bytes are afterwards AT THE PATH, unchanged") and the house rule require it. It supersedes R473 I1 3 and R484's "put back all the same". So `changed-outside-before-rollback` is no longer raised by anything: `changedSinceMarker` is removed. **For the review.** |
| 3 Occupied trashed path (R519 (1)) | Yes (occupied → `ok = false`, no cause) | `undoEntries` trashed step: the change's own bytes at the path (`ownBytesAt`, completion hashes included: a later undo failed) are removed, then the original is put back. Anything else is blocked as `path-occupied`; the copy stays. | `rollback-hand-put.test.ts` "R519 (1)": a hand-put file (incomplete; then moved away, the original is back), and the change's own file written or copied whose undo failed. **Failed first** (3 of 3). | |
| 7, 8 Identity: M1, M2 (R519 (3), (4)) | Yes (as R509 reviewed) | `undoEntries` first pass: where a trashed line's copy is gone and the line has an identity, `trashedContent` decides what the copy held. **"the original"** (no earlier line of the change at, under or above the path): the full identity must match, so it is put back and done whatever the bytes are (M1). Otherwise `kept-copy-gone`, with the path blocked: nothing deleted or moved (M2). **"changed by the change"** (earlier appends, or lines under a folder): the file number alone, because undoing the addition in place keeps the number but not the size or time. **"the change's"** (an earlier line made it whole): R493's rule, because nothing of the researcher's was in that copy, and the earlier lines' undo, which is own-bytes-protected, restores the path. **No identity** (older build): KG-1a's rule, unchanged. | `rollback-hand-put.test.ts` "R519 (3)": M1 equal bytes, cut before the marker went (done at the next two reopens); M2 with the change's own written file, its own copied file, a hand file, nothing; an appended-then-trashed original; the original replaced by a copy of itself; a crash before the trash rename; an older build's line. **Failed first** (4: M1, M2 hand and nothing, and the copy of itself; the own-file cases already held after point 2). | The M1 rule for "the change's" was wrong in `36a0bda` (it held equal bytes incomplete for ever). The enumeration found it, and it is fixed in `9802bd0`. |
| 4 The enumeration (R519 adapted) | n/a | `rollback-rerun.test.ts`, new block "R519: with a file put there by hand…". See below. | **Failed first:** run against the undo before R519 (the library files of `3d6585a`): 423 failures in 94 cases. | |
| 5 New warning sentence | Dropped by R519 | none | none | |
| 6 / point 8's cause | as ruled | `kept-copy-gone` on the outcome and the warning | covered above | |

## The identity (R519 (3)), and what a rename does to it

- **ext4 (measured on this machine).** After a rename into another folder and back, for a file and for a folder alike:
  - unchanged: the file number (`ino`), the size, and the time of last modification (`mtimeNs`);
  - changed: **the time of change (`ctimeNs`) changes on each rename**. Linux sets the inode's ctime in `rename`.
  - So a ctime recorded before the trash can never match after the put-back. That is why I used mtime.
- **APFS (by its documentation and POSIX).** `rename(2)` keeps the file's inode number (the file ID) and its modification time. POSIX allows `rename` to update ctime, and macOS does. The same reasoning holds; it cannot be proven here.
- **The library copied to another disk between the crash and the reopening.**
  - Every file gets a new number, so a put-back original no longer matches.
  - Result: incomplete as `kept-copy-gone`, nothing deleted, and closable by KG-1c (the safe side).
  - Only a marker whose kept copy is already gone is affected: an original still in the trash is put back by rename as before.
  - Tested by replacing the put-back original with a copy of itself.
- **An original edited in place by a person after it was put back** (a rare re-run case): the mtime changes, so the result is `kept-copy-gone`, nothing deleted. Also the safe side.
- **A folder** keeps its number. Its mtime changes only when its entries change, which is why lines under a folder compare the number alone.

## The enumeration (brief point 4, as R519 adapts it)

**What it covers.**
- Every sequence of two and three steps of **trash, create and replace** at one path that the transaction takes: 3+2 of two steps, 5+3 of three.
- The first roll-back is cut after each of its steps; cut 0 is before its first undo.
- Then a person puts a file at the path, in one of two ways:
  - a new file renamed into place (a new file number);
  - the file written over in place (same number, new size and time).
- The library is then reopened twice.

**What it asserts.**
- After each reopen, the hand-put bytes are at the path, unchanged.
- The roll-back is incomplete, with causes only at that path and of a known kind.
- Every copy the app kept before the second roll-back is still there, unchanged.
- The third run changes nothing the second left.
- No marker is found invalid, and no "outside change not kept" is reported.

**The equal-bytes companion (M1).** Beside each sequence, every write of the change puts the original's very bytes back. At every cut, the next reopen completes with the path as before, and so does the one after.

**Size and time.** 94 hand-put cases (`EXPECTED_HAND` 18/12/40/24) and 94 equal-bytes runs. The whole file `rollback-rerun.test.ts` (KG-1a's 179 cases, the 94 old-shape markers among them, all untouched) runs in **about 27 s**; the R519 block alone takes about 10.5 s.

**Sequences with an append are not in the hand-put enumeration. This is NEEDS A RULING 1.**

## Per cause: what the researcher is told today (existing sentences only; KG-1c writes the words)

Every cause ends as outcome `rollback-incomplete`, and the researcher gets the same existing sentences:
- **Banner** (`StatusBanner.tsx`, kind `rolled-back-incomplete-write`): "An interrupted change in {project} was undone when the library opened, so nothing half-saved was kept." This is **untrue for every cause** (FR-736).
- **The warning's detail:** "a change interrupted before it was audited could only be partly rolled back; the marker is kept and recovery is retried on the next open (transaction …)". The causes are on the warning as data and are not shown.
- **A named source, read:** "A change to a source in {project} did not finish and could not be undone. Close the library and open it again to put it back." For a hand-changed file, reopening does not help until the file is moved away. For `kept-copy-gone`, it never helps.
- **A write to the project:** `RecoveryPendingError` ("…refuses changes: an earlier change could not be fully undone…"). In Find and acquire: "This project is waiting for the library to be reopened before anything can be written."
- **"Roll it back" in the list:** "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library." The error now carries the causes.

What each cause adds to that:
- **`hand-changed-file`:** the same sentences. Moving the file away makes the next opening complete the roll-back.
- **`path-occupied`:** the same. Moving the file away completes it.
- **`kept-copy-gone`:** the same. It can never complete; KG-1c's close.
- **`could-not-look`:** the same. It completes once the file can be read.

## Researcher-visible sentences

**None new or changed.** One that **no longer appears:** "A file in {project} was changed outside the app while a change the app had not finished was waiting to be undone. When the library opened, the app undid its unfinished change, and the outside change to that file was not kept." (R479 a). Nothing raises it now, because nothing is put back over an outside change. Its declaration in `StatusBanner.tsx` and its kind are left in place for KG-1c to remove or reuse.

## Tests changed (asserting the old behaviour)

- **`rollback-own-writes.test.ts`.** Six tests asserted R484's overwrite and the `changed-outside-before-rollback` warning: "P1 / P2 with a real edit…", "the reverse order with a real edit…", "cut, then a real edit…", and "R484 b" × 2. They now assert, through `handEditKeptThenMovedAway`:
  - the hand-edited file kept, incomplete with `hand-changed-file` at its path, no outside warning;
  - then moved away, the earlier state back.
- **The helper `trashedThenWrittenAgainThenFailed`** asserted the change's file left at the path after a failed in-process undo. Point 3 puts the original back there, so it now asserts the original. Its hand-edit test uses a new crash variant, so that the change's file is still there to be edited.
- **`sources-read-race.test.ts`.** The test "…changed by hand meanwhile, is still put back…" becomes "…is left as it is…, incomplete with its cause; moved away, it is put back".
- **`rollback-rerun.test.ts` and `rollback-own-writes.test.ts`.** `undoEntries(...)` → `(await undoEntries(...)).ok` (5 places, mechanical).
- No assertion was loosened.

## NEEDS A RULING (none blocks what is built)

1. **Append lines are not protected.**
   - **The gap.** An `append` line records only the size before it. A file a person puts by hand at a path the change only appended to cannot be told from the change's own.
   - **What the probe showed** (not committed; every append sequence that the transaction takes; 76 cases, 144 failures):
     - for `created: true` (the append made the file), the undo **deletes** the hand-put file, e.g. `[trash, append]` then a hand file, or `[append, append]` from no file;
     - otherwise it truncates it, unless R131 b's offset check refuses the whole marker.
   - **Where it matters.** These paths are the app's own logs: the change log, audit segments, the Find queue, the review file, the watch register, the audit reasons. A person putting a file there is unlikely, but R503 c's property does not hold for them.
   - **Proposal.** An append line gains an extra field, written as a completion when the change's last append to that file is durable: the file's end size and the hash of the bytes after `prevSize`. The undo then truncates or deletes only when the tail is the change's own. Build 10 ignores the field. This is a change of its own, with its enumeration.
2. **Replaced lines** are protected as well (above). Confirm that R519 supersedes R473 I1 3 and R484's "the earlier state is put back all the same, and that is recorded". In the source-record case, a project with a hand-edited record during a pending roll-back is now blocked until the file is moved away or the change is closed (KG-1c).
3. **`changed-outside-before-rollback`** is now raised by nothing. Should KG-1c remove its declaration and banner text, or keep them for warnings an older build raised? Today warnings are not persisted, and FR-729 makes them persist.
4. **Unnamed files in a folder the change created.** A `dir` line's undo still removes the folder recursively, with anything a person added inside it that no line names. Named files are protected: a blocked file blocks its folder's line. Unnamed ones are as before. Proposal, if wanted: a folder line's undo removes only what the change's lines name, and leaves the folder when anything else is in it.

## What only a real Mac can show

- APFS keeping the file number and modification time across `rename` (documented, not measured here).
- A permission-denied read at undo (the machine runs as root; tested through the `failLook` seam).
- A library copied between disks (simulated by a copy of the file).

## Runs (each alone, `nice -n 10`, single files)

`@ao/library`:
- `src/repo/rollback-rerun.test.ts`: 19 passed (19), about 27 s
- `src/repo/rollback-hand-put.test.ts`: 22 passed (22)
- `src/repo/rollback-own-writes.test.ts`: 14 passed (14)
- `src/repo/txn-completion.test.ts`: 9 passed (9)
- `src/repo/pending-writes.test.ts`: 22 passed (22)
- `src/repo/recovery-code.test.ts`: 27 passed (27)
- `src/repo/sources-read-race.test.ts`: 13 passed (13)
- `src/repo/repo.test.ts`: 61 passed (61)
- `src/repo/review-held.test.ts`: 67 passed (67)
- `src/repo/key-lock-race.test.ts`: 11 passed (11)
- `src/repo/watch-register.test.ts`: 30 passed (30)
- `src/find/queue-store.test.ts`: 81 passed (81)
- `src/repo/lock-mid-read.test.ts`: 44 passed (44)
- `src/import/bulk/bulk.test.ts`: 103 passed (103)
- `src/repo/fieldwork.test.ts`: 31 passed (31)
- `src/repo/annotations.test.ts`: 42 passed (42)
- `src/repo/source-record.test.ts`: 5 passed (5)
- `src/seams-inert.test.ts`: 3 passed (3)

`@ao/library-service` `src/server.test.ts` (the integrity route that lists warnings): 151 passed, 1 skipped (152).
`@ao/ui` `src/components/StatusBanner.test.tsx`: 53 passed (53); no screen changed.

Typechecks, each clean: `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`. No screen or route changed, so there is no lint:css or end-to-end run.
