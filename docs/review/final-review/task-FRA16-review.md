# Review: Task FR-A16 (R379, WB2 I2). A destruction certificate is true about old copies of the library

Reviewer: a fresh adversarial reviewer. Worktree `agent-a7f301291240d4274`, branch `fr-a16-old-copies`, base 7537f63, head e869dc6. I read the common brief, the reader's rules, finding I2 with its FR-067…FR-075 answers, the task brief, the report, the whole package (1,768 lines), and R379 (the FR-A16 bullet), R147, R175, R90 and R92.

## Verdict: NOT APPROVED

The case the finding probed is closed. A library is moved within one computer, then a project is destroyed. The certificate now names the old copy by the move's date and stores no path, and the warning is raised. Two moves are named as two old copies, and an expired offer, a split move and an unplugged disk all count.

The warning and the certificate's amendment, however, clear on "this computer's list no longer has the record". That is not "verifiably gone" as R147 requires, and it happens in ordinary use:
- the library is opened on another computer;
- the list is damaged;
- the deletion through the app keeps a file.

In each case the amendment then records that the old copy no longer holds the data while the destroyed originals are still on disk. In the split-move case, the moved project's backups stay in the old root and are covered by nothing. In practice the warning can only ever be settled by hand, because the app can delete an old copy only within 15 minutes of the move, and it never tells the researcher where the old copy is.

## What I ran
All runs used `nice -n 10`, with a load average of about 40. One probe file was used: `packages/library/src/retention-old-copies.probeFRA16.test.ts`, since deleted. `git status --short` is empty at the end.

**Probes:**
- **P1, another computer.** Move and destroy on computer A. Then the library is opened on computer B (another `appConfigDir` and device id) and one `resumeDestruction` pass runs. Result: warnings `[]`; the certificate shows `status "no-longer-present"`, `noLongerHolding:[{movedAt…}]`; the old file is still there (`true`).
- **P2, damaged list** (`{ damaged`) at the destruction. Result: the certificate has no `oldCopies` at all, warnings `[]`, and the old file is still there.
- **P3, list damaged after the destruction**, then one pass. Result: warnings `[]`, `status "no-longer-present"`, and the old file is still there.
- **P4, deletion through the app with one destroyed file whose hash differs.**
  - `deleteOldCopy` returns `kept:[…/original/2026-12-02 Smith - Interview one.mp3]` and removes the record.
  - Right after the deletion, the warning is still shown. This is correct.
  - After the next pass: warnings `[]`, `status "no-longer-present"`, and the file is still there.
- **P5, split move with a backup made before the move.**
  - The old root's `Backups/` holds `Interviews - backup - modified 2026-12-02 1000.zip`. The destination's `Backups/` is empty, because a split move skips `Backups` (`move.ts` SHARED_DERIVED).
  - At the destruction, the certificate says `backups {"status":"none"}`.
  - After `deleteOldCopy`: warnings `[]`, and the old root still holds the zip.
- **P6, a record without `createdAt`.** `destroyRaw` throws `RangeError: Invalid time value`.
- **P7, two moves (A→B→C), then a destruction.** Result: `notDestroyed` holds both, and the note reads "2 old copies … left by the move of 2026-11-10, 2026-11-11". This is sound.
- **P8, an audit line edited (the chain broken) after the old copy was removed by hand**, then one pass. The warning stays and the status stays `pending`. This is sound (R174/R175 a).

**Mutations on the implementer's own test file (`retention-old-copies.test.ts`):** each guard was taken out, the file was run, and the guard was put back with `git checkout`.
- `if (root === resolve(currentRoot)) return false` (the library's own root is not an old copy): **10/10 still pass**.
- `if (!(await opts.mayRecord())) return` (nothing is recorded on a log that does not hold): **10/10 still pass**.
- In the deleted-through-the-app path, the check that nothing is left (`removed.push` only when `!oldCopyHolds`): **10/10 still pass**.
- Inheritance by a restored copy (`inheritedOldCopies` returning nothing): **1 test fails**, the restore test.

I did not run whole suites, the type-check, the UI, or the end-to-end tests (the rules forbid it, and the load makes them slow). The report's runs stand as given.

## Findings

### Important

**I1: "No longer on this computer's list" is recorded as "no longer holding the data". The warning ends and the amendment says something untrue while the destroyed originals remain.**
- **Where:** `packages/library/src/retention.ts:1221` (`if (!r || …) gone.push(id)`). The empty record set comes from `old-copies.ts:82,85`, where a damaged list reads as `[]`. The record is removed by `move.ts:1116` (`removePendingOldCopy`, unconditional).
- **Ways in, all probed:**
  - (a) The library is opened on another computer, whose list does not have the record (P1). This is the common case for a library on an external disk used at work and at home. The first pass at open settles the destruction for good in the audit log.
  - (b) A restore into another library has the same effect: `oldCopiesOfLibrary(otherLib.id)` never contains the record. I traced this in the code but did not probe it.
  - (c) A damaged list, at a later pass (P3).
  - (d) The implementer's open point (P4): `deleteOldCopy` keeps a destroyed file (its hash differs, or it cannot be stat'ed) but removes the record anyway. The next pass then records the copy as no longer holding the data.
- **Rule broken:** R147, "An entry leaves the list only when its file is verifiably gone … errs on the side of the warning staying". The certificate's last sentence ("covers the copies this app manages") is made untrue by the amendment.
- **Direction, the smallest sound rule:**
  1. A record missing from the list is "cannot tell". Nothing is recorded and the warning stays. A copy leaves only when its path was looked at and holds none of the destroyed paths.
  2. `deleteOldCopy` does not drop a record whose scope still holds anything it kept or left. Instead it leaves the record as a tombstone: id, old root, and `deleted: true` or `residue: true`. Records live in the app's configuration folder, where a path is allowed. Later passes keep checking it, and the tombstone is pruned once the old root holds nothing of the library.
  3. A damaged list counts as unreadable: `unchecked` at a destruction, and nothing recorded at a pass. See I2.
- **Cost:** on a computer that does not list the copy, the warning stays until the library is opened on the computer that does. That is the direction R147 chose. **The coordinator should rule** on whether a library opened on another computer should show the warning with a sentence that says so.
- **Tests:** none covers this. The R147 guard `mayRecord` has no test either (mutation: 10/10 pass).

**I2: A damaged list of old copies at a destruction is read as "none". The certificate is silent and no warning is raised.**
- **Where:** `old-copies.ts:80-86` (a JSON error or a non-array returns `{records: [], damaged: true}`), and `oldCopiesOfLibrary` ignores `damaged`. Probe P2.
- **Rule broken:** the brief, point 1 ("fail towards the warning, never towards silence"), and the dispatch, which names "unreadable or damaged". Only `OldCopiesUnreadableError` (an I/O error) is treated as unchecked. A record dropped by `usable` (no `oldRoot`) is silently lost the same way.
- **Direction:** `oldCopiesOfLibrary` reports `damaged`, and the destruction treats it as `unchecked` (unknown-pending, "could not be checked"). Add a test.

**I3: In a split move, the moved project's backups stay in the old root, and neither the destruction nor the old-copy mechanism sees them.**
- **Where:** `move.ts` `skipper` (`SHARED_DERIVED` includes `Backups`, so they are not copied in a split move). `holdingBackups` looks only at the current `Backups/`, and `oldCopyHolds` looks only under `Projects/<n>` (`retention.ts:1096-1119`). `deleteOldCopy` in a split move deletes only the moved folders.
- **Probe P5:** the certificate says `backups: none`. After "Delete the old copy", the warning ends and the amendment says `deleted`. Yet `Interviews - backup - modified … .zip`, which holds the destroyed original, is still in the old root's `Backups/`.
  - That folder now belongs to the "remaining projects" library, which the app opens and manages.
  - The same holds for a whole-library old copy from which the researcher deleted only `Projects/<n>` by hand: the old copy's `Backups/` and `.tmp/trash-*` are never looked at.
- **Rule broken:** R90 d / R147 (backups that hold destroyed assets are listed), and finding I2's own effect.
- **Direction:**
  - Look in the old copy's `Backups/` for this project's backups (the backups manifest's `owners`, or the naming). Count them as holding, or list them, in the certificate's old-copies section.
  - In a split move, either copy the moved projects' backups or have `deleteOldCopy` include them in scope.
  - The coordinator may prefer to treat the split-move backups as a separate move defect. The certificate is untrue either way.

**I4: The warning tells the researcher to use a screen that cannot do it, and gives no way to find the old copy.**
- **Where:** `apps/library-service/src/routes/libraries.ts:269-281`. Deletion through the app needs `pendingMove()`'s single-use token, which lasts 15 minutes and is held in memory only (`move.ts` `tokens`). Also `move.ts:1021`: an offer older than 24 hours is refused as expired. Nothing in the service or the UI lists old copies after that.
- **Effect:** a destruction comes at the retention date, weeks after a move, and by then:
  - "Delete them from the Move library screen" can never be done (the warning's text and the certificate's `note`);
  - point 4 of the brief (the deletion through the app clears the warning) is reachable only for a destruction made within 15 minutes of the move;
  - the researcher is given only a date (`destructionOldCopiesPending` → `{movedAt}`), never the place, so "by hand" means remembering where the library used to be.
- **Rule broken:** a standing warning the researcher cannot act on through the app. The brief mandated the exact sentence, so **this needs the coordinator's ruling.**
- **Direction:**
  - The service returns the old copy's place to the researcher's own screen, as the Move screen shows it right after a move. It is not stored or exported, and it is scrubbed nowhere else.
  - Either a route that deletes an old copy listed for a pending destruction (re-using `deleteOldCopy` with `{confirm: true}`, which exists), or a sentence changed to match what the app can do.

### Minor

- **M1: A hand-damaged record refuses a destruction.**
  - `retention.ts:1136` (`moveDate` → `formatModified(new Date(undefined))`) throws `RangeError` inside the certificate callback when a listed record of this library has no or a bad `createdAt` (P6).
  - `usable` (`old-copies.ts:67`) checks only `id` and `oldRoot`.
  - This breaks brief point 5 ("never refused because of an old copy").
  - Direction: validate `createdAt`, and when it is bad, name the copy as "an old copy (date unknown)".
- **M2: Three guards have no test that fails without them** (mutations above):
  - the library's own root is never its own old copy (`retention.ts:1098`, the A→B→A case);
  - `mayRecord` on a log that does not hold (R174/R175 a);
  - in the deleted-through-the-app path, recording only when nothing is left (`retention.ts:1217`).

  Each needs a test that fails without it. P8 shows the second guard does hold.
- **M3: An unfinished move is not looked at.**
  - Case: a crash after `addPendingOldCopy` but before `mark-old`. The source is still read-write, and its record (`complete: false`, `oldRoot` = the current root) is skipped. The destination holds a full verified copy (`move-incomplete`) that the record names as `newRoot`, and a destruction in the source never looks there.
  - This is rare, and FR-067 makes such stale records worse.
  - Direction: for an incomplete record whose `oldRoot` is the current root, look at `newRoot` too.
- **M4: Possible hang on an unreachable share.** `lstat` on a stale network mount can block for minutes. Each pass at open, at unlock and hourly does it under the project's maintenance lock, for every outstanding copy, and so does the destruction itself. This is not probed (it needs a real SMB mount). Direction: a time limit, treating "no answer" as holding.
- **M5: Limit to state in the certificate's documentation.** A destruction made on a computer whose list does not have the record names nothing, and the certificate is silent. This is a limit of a per-computer list, not something this task can fully fix.

## The implementer's own doubts
- **"Record removed while files remain"** is real, and worse than thought: the same false clearing comes from another computer, from another library and from a damaged list (I1). "A warning that can never clear" is not the only alternative: a tombstone record kept in the configuration folder makes the check possible.
- **"The service's open library is not the moved one":** this also falls under I1. The copy is recorded as "no longer holding" whether or not it was deleted.
- **Shared amendment numbering and the op `retention.backups`:** checked and sound. `settleOldCopies` mutates the same `Audited` object, which the backups loop then continues, so numbers follow one after the other.
- **The unplugged volume on a Mac:** the parent-folder rule is sound for `/Volumes/<disk>/…`. When a researcher deletes the old copy together with its parent folder, the copy counts as unreachable for ever. The warning then never clears, because a hand deletion is the only way (I4). This is related to I4, and less likely.

## Checked and sound
- **No absolute path** in the certificate text, the audit events, the amendments, the `retention.old-copies` report, the `backups-state.json` note (`id` and `movedAt` only), or the service's `destructionOldCopiesPending` (shown by the implementer's tests and by the P1 output). The record id and `moveId` are random.
- **Two moves** name two copies (P7). **Expired offers** count. **Another library's copy** does not count. **A split move** counts the moved folder. **An unplugged disk** counts.
- **Per-file matching:**
  - single-source destructions are covered;
  - a project folder that is empty, or holds only some of the files, is handled correctly;
  - source and project folders are never renamed in this code base, so matching by path is enough;
  - the `project.json` look-up is harmless.
- **A library never moved:** the same certificate keys and audit-event keys. The state file is written without the new key when it is empty, in the same key order.
- **The destruction never touches an old copy.** The note is raised at the destruction and rebuilt from the audit log at every pass, so a crash between the commit and the note is repaired at the next open (R26). A locked project or a read-only library records nothing.
- **R175:** a restored copy inherits the warning (tested, and the mutation fails), with the undo when the copy does not go live. A log that does not hold together records nothing (P8).
- **The service** publishes when what stands behind the warning changes. **The UI banner** has the exact sentence from `@ao/shared`. The backups' warning has no screen of its own either, so nothing is missing there.

## Could not verify
- The type-check, the lints and the whole suites (not run by the rules; the report says they pass apart from time limits).
- APFS unplug behaviour, and a stale network mount (M4).
