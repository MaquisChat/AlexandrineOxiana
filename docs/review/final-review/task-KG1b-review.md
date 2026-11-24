# KG-1b: adversarial review (FR-735 with FR-723; R503 c, R509, R519, R525)

Checkout `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, detached at b72caae. Reviewed `ad99c57..b72caae` (six commits, 13 files), read in full. Rulings read: R473, R479, R484, R491, R493, R503, R509, R519, R525. Build 10 was read at `main` (2d12ab1): `packages/library/src/repo/txn.ts` (`markerProblem`, `undoEntries`, `changedSinceMarker`) and `mutate.ts`.

**Verdict: APPROVE WITH SMALL POINTS.** The findings are 0 Critical, 1 Important and 6 Minor.
- No probe produced a lost person's file outside the gaps R525 lists and the ones named below.
- No ordinary crash was left incomplete.
- Build 10 reads the new marker.

## What I ran (single files, `nice -n 15`)
- `rollback-rerun.test.ts`: 19 passed, 31.2 s. The R519 block alone took about 11.5 s (2.3 + 1.5 + 4.8 + 2.9).
- `rollback-own-writes.test.ts`: 14 passed.
- `rollback-hand-put.test.ts`: 22 passed.
- `pending-writes.test.ts`: 22 passed.
- `lock-mid-read.test.ts`: 44 passed, 683 s (the file is slow; nothing failed).
- Probe file `src/repo/rollback.probeKG1b.test.ts`: 13 probes, run and then deleted. Details below.
- **Scratch edit:** I disabled the replaced-line guard in `undoEntries` (`if (e.sha256)` → `if (false && e.sha256)`). The R519 enumeration then fails: 40 + 24 + 96 + 56 failures. I restored the file with `git checkout`.
- `git status --short` is empty at the end. No permission check refused anything.

## Findings

### Important

**I1. A put-back original whose timestamps change is wrongly judged "never put back". The roll-back can then never complete, with the untrue cause `kept-copy-gone`.**
- **Where:** `txn.ts` `isOriginal` (about l.318–326) and the "the original" branch of `undoEntries`' first pass (about l.410–420).
- **The rule:** once the kept copy is gone, the original is recognised only when its file number, size **and** time of last modification all match the trashed line.
- **The problem with folders:** a folder's modification time changes whenever an entry inside it is added, removed or renamed. That includes:
  - Finder writing `.DS_Store` when the researcher browses the folder;
  - a sync client's own files;
  - any editor that saves by renaming, used on a file inside the folder.
- **The problem with files:** a sync client that only re-stamps a file's times does the same thing to a put-back file.
- **The window:** this matters in exactly the state where the researcher is told to act by hand. A roll-back was incomplete for another reason (a hand-changed file, `could-not-look`, a failed in-process undo, a crash during the reopen's roll-back), and the original was already put back.
- **Probe C (end to end in the library):**
  1. One change writes `a.txt` in source 1 and trashes source 2's folder; a crash happens before the audit.
  2. `a.txt` is changed by hand. Reopen: source 2's folder is put back, and the roll-back is incomplete with `hand-changed-file` at `a.txt`.
  3. Reopen again (same result). Then `.DS_Store` is written in the put-back folder and `a.txt` is moved away. Reopen.
  4. **Result:** the marker stays, with `causes: [{"kind":"kept-copy-gone","path":"Projects/P/Sources/2026-11-11 Unknown - Two [qev6]"}]`, although `source.json` there is byte for byte as before.
  5. **Control:** without the `.DS_Store`, the roll-back completes.
- **Consequence:** the project refuses every change until the researcher "closes" a change (KG-1c) whose original is in fact at its path. KG-1c's planned statement that "the original could not be put back" would then be untrue. Nothing is deleted.
- **The enumeration encodes this:** the case "written over in place" after a cut that had put the original back requires the result to be incomplete.
- **Direction (not a patch):** identify the original by file number plus **birth time**, not by modification time and size.
  - Measured on this ext4 with Node `lstat({bigint:true}).birthtimeNs`: the birth time survives a rename into another folder and back, and survives an edit in place.
  - A file created after the old one was deleted got the **same** file number but a new birth time.
  - APFS has a birth time; where a file system gives none, keep today's rule.
- This needs a ruling: the identity R519 (3) names, and whether an edit of the put-back original counts as "put back". R525 accepted "time of last writing".

### Minor

**M1. Not in R525's list of gaps: a person's file at a copied path whose completion line was never written is deleted.**
- **Where:** `knowsBytes` and the created step of `undoEntries`.
- **Probe E4:** a `created` line with no hash and no completion line, and a person's regular file at the path. Result `{"ok":true}`; the file is removed.
- **Probe E2:** the same with a symbolic link at the path. The link is removed (its target is untouched).
- This is what R519 rules ("no completion line: a half-written file"). The undo cannot tell the change's fully renamed copy, cut before its completion line, from a person's file.
- It is a third unprotected case beside R525 (3)(a) and (b). It should be **listed** with FR-746 so that the claim "a person's file is never destroyed" names it.
- **Related, older and outside the undo:** `copyFile`/`writeFile` check whether the path exists and only then rename into place (`fs/atomic.ts` `commit`). A file a person puts there in between is overwritten by the change itself, not by the undo. Found by reading only.

**M2. A folder the change made, already removed by a cut undo, then made again by a person, is removed with the person's files by the re-run.**
- **Probe D:** lines `[dir D, created D/f complete]`. The first undo is cut after both steps. The person runs `mkdir D` and writes `D/mine.txt`. The second undo returns `{"ok":true}` and `mine.txt` is gone.
- A `dir` line has no identity and is undone again on every run, which breaks R493's rule for this one shape.
- It is close to R525 (3)(b), but the folder itself is the person's.
- It is unlikely in practice, because the app's folders mostly have random names. It should be listed with FR-746. Direction: a `dir` line's undo removes only an empty folder, or only what the change's lines name.

**M3. The "file number only" identity accepts a reused file number, and a person's file is then cut short with the roll-back reported complete.**
- **Where:** `trashedContent` returns "changed by the change", which leads to `isOriginal(…, numberOnly = true)`.
- On this ext4 a file created right after another was deleted got the **same** file number (measured twice).
- **Probe F:** `[append P prevSize 2, trashed P (identity)]`. The kept copy is deleted, then a person writes a new file at P. The file number is reused, the result is `{"ok":true}`, and the person's file is cut to `"a "`.
- It sits inside the append family of R525 (3)(a), and a change that appends to a file and then trashes it is rare.
- The birth time of I1 settles it too.

**M4. A folder (not a file) at a cut copy's path makes the undo incomplete with no cause.**
- **Probe E3:** `undoEntries` returns `{"ok":false,"causes":[]}`. `fsp.rm` without `recursive` throws on a folder, and the generic `catch` sets `ok = false` without a cause.
- Nothing is lost, but KG-1c will have nothing to name. Direction: a cause (`hand-changed-file` or `path-occupied`) for "other" at that path.

**M5. The look seam's inertness test covers one of its two sites.**
- `seams.failLook` is checked in `look` (txn.ts about l.280) and in `isOriginal` (about l.320). The new R47 test (`rollback-hand-put.test.ts` l.434–454) reaches only `look`.
- My probe G showed that the `isOriginal` site is also inert under `NODE_ENV=production`.
- The seam is also not in `src/seams-inert.test.ts`, the central proof. Small: add the second site.

**M6. The R519 enumeration is narrower than "every named path".**
- `rollback-rerun.test.ts` l.689–773 builds its cases only from `writeFile` and `trash` at one file path:
  - no copies (completion lines);
  - no folder the change made;
  - no trashed folder;
  - a hand-put file at only one moment: after the in-process cut, before the second roll-back.
- The count is honest (18/12/40/24 = 94, checked by hand). Each case compares the bytes at the path exactly, and the kept copies by base64.
- I filled the copy gap with **probe H**: every 2- and 3-step sequence of trash/copy/create/replace containing a copy, every cut, ordinary and with a hand-put file: 106 cases, 0 failures.
- Ordinary crash: complete twice, with the path as before. Hand-put: kept at the path, incomplete. This could be added to the enumeration.

## Answers to the brief's nine points

1. **Ordinary crash.** Sound for everything I tried.
   - The R493 and equal-bytes enumerations pass.
   - Probe H (completion lines at every cut) passes.
   - A file renamed into place but without its completion line is removed (no completion line = the change's own), as ruled.
   - A second write to the same path in one change: every hash the change recorded at that path counts as its own (`writeHashes`), and a replaced backup's bytes count as "kept aside".
   - Encrypted copy of 3 MB + 17 bytes (many 64 KiB chunks), probe A: the completion hash equals the SHA-256 of the bytes on disk and differs from the plain source's.
   - The opening of a **locked** project (fresh key ring) judges by the stored bytes alone: unchanged → removed and complete; one byte flipped (same size) → kept, `hand-changed-file`.
   - Mode or time changes alone never block a created or replaced line (by reading: `look` hashes bytes only).
2. **A person's file.** Protected:
   - a created or replaced file changed by hand (same size included);
   - a symbolic link or folder at a hashed created path (probe E1: blocked, the link kept);
   - an occupied trashed path;
   - the same path named by three lines (enumeration).
   - A hand-put file identical byte for byte to what the change wrote is removed or put back over; nothing is destroyed.
   - **Not protected beyond R525:** M1, M2 and M3.
3. **Replaced files (R525 (1)).**
   - I read the seven changed tests: six in `rollback-own-writes.test.ts` and one in `sources-read-race.test.ts`.
   - Each now asserts, through `handEditKeptThenMovedAway`: the bytes as edited, exactly one cause at that path, no outside-change warning, then moved away → the earlier state back. Nothing was loosened.
   - "The reverse order" (with no hand edit) changed its expected bytes because R519 (1) now puts the original back over the change's own file; that is right.
   - Its hand-edit sibling moved to a crash variant. This is correct: under the new rule the old failed-undo state puts the original back first.
   - "Changed by hand" is judged by bytes only for created and replaced lines. Trashed identity is where times matter (I1).
   - The app's own later write cannot happen while a marker is pending: probe B shows `repo.mutate` is refused. The writes outside transactions in `projects.ts` (key activation) run only for a project with no unresolved interrupted change (by reading).
   - A sync client that rewrites with other bytes blocks the project. That is R525's accepted cost.
4. **Identity.**
   - `lstat({bigint:true})` is taken on `from` before the line and before the rename, and does not follow a link.
   - The file number and the nanosecond time are kept and compared as decimal strings (`isDigits`, `toString()`). The size is a Number, which is exact below 2^53.
   - File-number reuse: shown (M3); the full identity is saved by `mtimeNs` (I1's direction keeps that).
   - FAT/exFAT (by reading only): file numbers are tied to the directory entry, so a rename can change them. The result is `kept-copy-gone`, incomplete and closable: the safe side, but with I1's untrue cause.
   - Lines with no identity are judged by KG-1a's rule. The 179 older cases pass, and their diff is only `.ok`.
5. **Build 10 (read only, `main` 2d12ab1).**
   - `markerProblem` checks only `path` and `sha256` on created lines, `from`, `to` and `shred` on trashed lines, and refuses only an unknown kind or version. The extra fields `complete`, `ino`, `size` and `mtimeNs` are ignored, so the marker is valid.
   - Its `undoEntries` removes created paths with `rm -f`, so a doubled created line is harmless and is not a failed step. It handles trashed lines as R491 does and ignores the identity.
   - Its `changedSinceMarker` now sees the completion hash, so a hand-changed copied file is reported "not kept" and deleted. Before, it was deleted silently: never worse.
   - `pending-writes` at main shows the number of lines as a step count. That number grows; it is cosmetic.
6. **Causes.**
   - Every caller of `undoEntries`/`rollBackMarker`/`log.undo` is updated: `mutate.ts` l.537, `pending-writes.ts` l.154, `TxnLog.undo`, `recoverTransactions`.
   - Cause paths come from marker lines and are library-relative; they reveal nothing the marker does not already hold in the clear.
   - The causes are not passed on by the service: `state.ts` maps only `kind` and `detail`, and the 409 carries `err.message`. The CLI does the same.
   - All four causes are reached and tested; none appears for an ordinary crash (enumerations, probe H).
   - Probe B, end to end: incomplete → the file moved away → `resolvePendingWrite(txn, "roll-back")` completes, the marker is gone, and a later `mutate` succeeds.
7. **R493.** The rule holds: probe C control, the hand-put tests and the enumeration's third run. Exceptions: M2 (a `dir` line) and I1 (the cause, not data).
8. **Seam.** Inert at both sites (probe G); only one site has a committed test (M5).
9. **The enumeration's honesty.** It generates what it says; its scope is narrower than "every named path" (M6). It took about 11.5 s alone on this machine.

## Table

| Property | Verdict | Note |
|---|---|---|
| An ordinary crash is undone completely | holds | Enumerations; probe H (106 copy cases); probe A (encrypted, larger than one chunk, locked opening) |
| A person's file is never destroyed: created | partly | Protected when the change knows its bytes. M1 (no completion line), M2 (`dir` line re-run) |
| A person's file is never destroyed: replaced | holds | The scratch edit shows the guard is tested |
| A person's file is never destroyed: trashed | holds | path-occupied; M3 is within the append family |
| Identity | partly | Precise and taken from the right file; folder and time changes give a false `kept-copy-gone` (I1); file number alone accepts reuse (M3) |
| Build 10 reads the marker | holds (by reading) | No new kind; extra fields ignored; a doubled created line is harmless |
| Causes | holds | All four reachable and tested; a folder at a cut copy's path gives no cause (M4); probe B end to end |
| R493 | holds | Except M2 |
| Seam inert | holds | The second site is untested in the committed tests (M5) |

**Judged by reading only:**
- build 10's behaviour;
- APFS, FAT/exFAT and network shares;
- that no non-transactional write lands on a marker-named path while a marker is pending;
- the TOCTOU in `copyFile` and `writeFile` (M1).

**Needs a ruling:**
- I1: the identity used, and the case where the put-back original was then edited;
- whether to list M1 and M2 with FR-746.
