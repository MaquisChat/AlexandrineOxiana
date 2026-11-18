# FR-A16, second review of round 2 (R409, R428)

This review covers worktree `agent-a7f301291240d4274`, branch `fr-a16-old-copies`, head f98a5c4, on top of e869dc6. I read the whole round-2 package (1,849 lines), the section "Round 2 (R409)" of the report, and Rulings R409 and R428 in full.

## Verdict: APPROVED WITH SMALL POINTS

All four Important findings of my first review are closed, and so are M1–M4.
- **Probes:** I re-ran my own probes in new forms. Most are already tests in `retention-old-copies.test.ts`, and the core ones fail when their guard is taken out.
- **Where the warning should end, it does:**
  - a copy deleted by hand;
  - a disk that was unplugged, then plugged in empty;
  - a copy deleted with remains, once the remains are removed;
  - one of two old copies removed.
- **The place:** it reaches only the desktop app's own screen, and it is shown through `UserText`.

What is left is minor: two guards with no test, wording that says more than the app knows, and three edge cases.

## What I ran
All runs used `nice -n 10`. The probe file `retention-old-copies.probeFRA16.test.ts` has been deleted, and `git status --short` is empty.

**Probes:**
- **Q1: the app's deletion with no `destRepo`** (the service has another library open). 7 files were deleted and the root is gone. The record is kept as `deleted {remains:false}` because the library's note still names it. The next pass records `status "deleted"` (removed by the app) and drops the record. **Sound.**
- **Q4: an unreachable disk** (the record points to `…/Volumes/Ext/Lib`; neither the folder nor its parent exists).
  - At the destruction the copy is named, and a pass keeps the warning.
  - After `mkdir` of the empty folder, the next pass records `no-longer-present` and the warning ends. **Sound.**
- **Q5: two moves (A→B→C), with A removed by hand.** The pass records `noLongerHolding` for A, keeps `outstanding` for B, and the warning stays. `oldCopiesBehindWarning` returns only B with its place. **Sound.**

**Mutations on the implementer's test file** (one guard taken out, the file run, the guard put back with `git checkout`):

| Guard taken out | Result |
|---|---|
| A missing record counted as gone (`if (!r) continue`) | **Fails** (P1) |
| A damaged list at a destruction counted as none | **Fails** (P2, and a record without a usable place) |
| `offerOpen` no longer checks expiry | **Fails** (R409 d library test) |
| `oldCopyNotedIn` ignored when pruning | **27/27 pass** |
| `listPendingOldCopies` offers deleted records again | **27/27 pass** |
| An unreadable `Projects/` read as empty in `lookAtPlace` | **27/27 pass** |

The implementer's own mutation runs cover the own-root guard, `mayRecord`, recording only on `none`, the Backups and trash looks, the bound, and M3.

## Your questions, in order

**1. My probes against the new code.**
- **I1 (another computer, a damaged list, the app's deletion keeping a file):** closed. The P1, P3 and P4 tests exist, and the core mutation fails.
- **I2:** closed (P2 and the `oldRoot: 42` record test).
- **I3:** closed (the P5 split-move backup, a backup left after the project folder was removed by hand, and the trash).
- **I4:** closed. The place and the sentence that fits are given; the server and UI tests cover them.
- **M1:** a missing or bad date is named "(date unknown)" and the destruction goes ahead.
- **M2:** see the table above and the report.
- **M3:** `newRoot` of an unfinished move is looked at.
- **M4:** every look is bounded to two seconds.
- **The other side, when the warning should end:** each case ends correctly: deleted by hand, plugged in empty (Q4), remains removed (P4), one of two copies (Q5). The exceptions are in N3 and N4.

**2. The place (d).**
- It is computed in `oldCopiesBehindWarning` from this computer's list and sent in `library.state`.
- That reaches only `GET /events` (the desktop app's token). `/events` is not in `EXTENSION_ROUTES` (server.ts:121), so the browser extension's token is refused.
- `GET /libraries/integrity` returns `projectWarnings` without it. The command line never reads it.
- It is in no log line, audit event, certificate, amendment or `backups-state.json`. The server and library tests read every file of the library looking for it.
- On screen: one `<li>` per place, through `UserText` (dir=auto). The UI test shows `<b>` is not parsed.
- A second computer gets no place, only the "no record" sentence with the date.

**3. (c) Backups and trash.**
- A backup of another project is not counted: it is told by its manifest or owner entry.
- An encrypted backup, or one that cannot be opened, is never opened; it is told by the manifest only.
- A large `Backups/` costs one `readdir` and two small JSON files.
- A `.tmp` with thousands of files is walked one file at a time. If that runs past 2 s the look is "cannot tell": nothing is recorded and the warning stays, never "holds none". That errs toward the warning; the case of a copy that is never deleted is in N5.

**4. The certificate (b).**
- The certificate always has its line. Unchecked: "could not be checked". Holding: the dates of the moves.
- "None known" is used for both no-record and known-but-none; R428 says not to count that.
- A certificate written before this round is read without a line. `presentOldCopies` returns undefined and nothing is made up.
- One wording says more than the app knows: N2.

**5. (e) Refusals and hangs.**
- Neither a damaged list nor a bad date refuses a destruction (tested).
- **`listPendingOldCopies` throwing on a record without a date** is not reachable where R409 e forbids a refusal. Its only caller is `deleteOldCopy(…, {confirm: true})` (move.ts:1015). Neither the service's delete route (token, through `getPendingOldCopy`) nor the command line calls it, and no destruction, retry pass, open or Move-screen path does. It stays as it was before the task.
- On hangs: N3.

**6. Guards.** See the table: two guards that matter have no test (N1).

## Findings (all Minor)

**N1. Two guards have no test that fails without them.**
- **`pruneDeletedOldCopy`'s `oldCopyNotedIn` check** (`retention.ts:1331`). Q1 shows this is what keeps the record when `deleteOldCopy` runs with no `destRepo` open, or a locked project. Without it the record is dropped, the next pass finds no record, and the warning stays for good with the "no record" sentence.
- **`listPendingOldCopies` hiding deleted records** (`old-copies.ts:242`).
- (A third, the unreadable `Projects/` in `lookAtPlace`, cannot be shown while running as root.)
- **Fix:** add a test of Q1, the deletion without `destRepo`, asserting that the record is kept and the next pass records "deleted". Add a one-line test that a deleted record is not listed.

**N2. The certificate states that a copy it could not look at "still holds the destroyed data".**
- **Where:** `retention.ts:1363-1375` (`oldCopiesSentence`) and `holdingOldCopies`, which names a copy on `cannot-tell`.
- **Evidence:** Q4. With the disk unplugged, the certificate says "…still holds the destroyed data and was not destroyed". A look that ran out of time gets the same sentence.
- This is evidence written once and never rewritten. Naming the copy is right; asserting what it holds is not known. The implementer listed it as deferred.
- **Fix:** keep the `cannot-tell` copies apart and say "…may still hold the destroyed data (it could not be looked at) and was not destroyed". It could go into the small R428 wording round.

**N3. A share that does not answer can use up the runtime's file threads.** Could not verify: this needs a real hung mount.
- **Where:** `bounded` (`retention.ts:1243`). After 2 s the race gives up, but the `lstat` goes on and holds one of libuv's 4 threads.
- The next look at the same place (the next destruction or copy in the same pass, the prune look, the next pass hourly or at open or unlock) starts another one.
- With a mount that hangs for good (an NFS "hard" mount, some SMB states), four stuck calls block every file operation in the service, opening a project included. That is what R409 e meant to prevent.
- **Fix:** remember, per process, each place whose look is still running. Answer `cannot-tell` at once for that place until the earlier call returns. Optionally, also raise `UV_THREADPOOL_SIZE` at the service's start.

**N4. An old copy at a volume's root that is unplugged reads as deleted.**
- **Where:** `oldRootThere` (`retention.ts:1102`).
- For an old root of `/Volumes/Ext` (a library made at the top of a disk), an unplugged disk leaves the parent `/Volumes`, so the result is "gone". That counts as `none`: an amendment "no longer holding" is written and the warning ends while the disk holds the data.
- Nothing stops a library from being made at a mount point. This is rare, because a macOS volume root is seldom empty.
- **Fix:** treat a parent of `/Volumes` (or any mount point in `LocationEnv.mounts`) as "cannot tell".

**N5. Mixed cases on the screen.**
- **Where:** `shared/src/api/destruction.ts:69` and `StatusBanner.tsx:292`.
- When one copy has no record and another has a place, only the "no record" sentence is shown, while the other's place is listed below without being told to delete it by hand.
- When any destruction is `unchecked`, every known place is hidden. This lasts until the next pass after the list is readable again.
- **Fix:** list both sentences when both apply, and keep the known places under the unchecked sentence.

**N6. Telling a backup in the old place by its name is less careful than in the current library.**
- **Where:** `retention.ts:1223`.
- A backup with no manifest or owner entry counts as this project's only by its name stem. For a backup named another way (`.enc`), it is "not mine" and therefore "none".
- `unresolvedBackupsOf` (`export/backup.ts:625`) checks the sealed key id for `.enc` files, and `oldPlaceLook` gives "cannot tell" for an unattributed backup.
- **Fix:** an unattributed backup that does not match by name is "cannot tell" in `lookAtPlace` too, or the key id is checked as `unresolvedBackupsOf` does.

## Checked and sound
- A copy leaves the warning only on a `none` look:
  - a missing record, a damaged list, and a time-out record nothing;
  - "removed by the app" only on a deleted record that left nothing, or on that deletion's own look.
- The app's deletion keeps the record while anything stays.
- The prune never drops a record from a damaged list.
- R174/R175 a: a log that does not hold together records nothing (tested).
- The amendment numbering is still shared, and a crash between the destruction and its note is still rebuilt at the next pass.
- **R428:** the "no record" warning stays until the library is opened on the computer that moved it. The certificate's note ends "Deleting it completes the destruction." and names no screen.
- **The service:** `canDelete` requires both that the offer is open and that the service holds the token for that very place. The sentence order is: unchecked, then no record, then in-app, then by hand.

## Could not verify
- A real stale SMB or NFS mount (N3) and APFS unplug behaviour.
- The whole suites, the type-check and the lints (not run, as the rules say; the report states them).
