# KG-1c, second look: fix rounds A and B (R527, R528, R529; R530 respected)

Checkout `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, detached at 1634be4. I reviewed `3facb9c..1634be4`, which is 14 commits: round A up to 908d6a8, then round B. I read the following in full:
- the diff;
- both fix reports and the first review;
- both briefs;
- R519 and R525–R530.

What I did not do, and how the checkout was left:
- No product code was changed, nothing was committed, and `git stash` was never used.
- Every scratch edit was restored with `git checkout -- <file>`.
- The probe `packages/library/src/repo/close.probeKG1c2.test.ts` was deleted, and `git status --short` is empty.
- No permission check refused anything.
- I did not report anything R530 already rules.

## Verdict: APPROVE WITH SMALL POINTS — 0 Critical, 1 Important, 6 Minor

Point 1 (the `dir` line) is sound in every shape I tried. The four Important findings of the first review are mended, and each new guard fails its test when it is taken out. Mac build 10 leaves the new root file alone (by reading).

One Important point stands. The guard that refuses the close (`keptCopiesLeft`) counts the change's OWN intermediate copies as "a copy of another file". After round B, that makes a terminal state, `lost-copy-stuck`: the project is blocked for good, the words say a backup is the only way, and the claim is untrue. It is not a data-loss risk; it errs on the side of refusing.

## What I ran (each alone, `nice -n 15`)

**`@ao/library`:**

| File | Result |
|---|---|
| pending-writes-close | 13/13 |
| kept-warnings | 11/11 |
| rollback-words | 18/18 |
| pending-writes | 22/22 |
| rollback-hand-put (once) | 42/42 |
| rollback-rerun (once) | 30/30 |

**Other packages:**

| File | Result |
|---|---|
| `@ao/shared` interrupted-changes | 132/132 |
| `@ao/ui` StatusBanner | 73/73 |
| `@ao/ui` PendingWritesDialog | 24/24 |
| `@ao/ui` Library.dismiss | 4/4 |
| `@ao/library-service` server.test `-t "FR-736\|FR-729\|R527\|R528\|R529\|R509"` | 6 passed, 152 skipped |

**End to end:** `nice -n 15 pnpm --filter @ao/ui build`, then `interrupted-change.spec.ts --project=chromium`: **1 passed** (6.8 s).

**Scratch edits, each restored:**

| Guard removed | Result |
|---|---|
| R527's `dir` pre-pass (`txn.ts:532-541`, the `block("hand-changed-file")`) | rollback-hand-put: the reviewer's-probe test **fails** |
| `keptCopiesLeft` returns false | pending-writes-close: the P5 test **fails** |
| kept-warnings filter `w.rollback === undefined` | kept-warnings: the R528 I3 test **fails** |
| `noteAttempt` updating no warning | rollback-words: **4 fail** |
| `noteAttempt` in `closePendingWrite` replaced by a bare `rollbackAttempts.set` | **nothing fails**: close 13/13, words 18/18 (M3 below) |
| the service's `publishState` in `/resolve`'s catch | server.test "R528 I2" **fails** |
| M6: `others` not written back | kept-warnings **fails** |
| M6: the `newer` early return | kept-warnings **fails** |

**The probe (cases A–F):**
- A, B: the close guard and the change's own copies (I1).
- C: a look that fails where the kept copy is gone (M1).
- D, E, F: point 1 with a copied library and an ordinary crash.

## Findings

### Important

**I1: `keptCopiesLeft` takes the change's own intermediate copies for "a copy of another file of the change, which it cannot put back". A project with a lost file is then held with no way out but a backup, and the words are untrue** (R509, R528 M2).
- **Where:** `packages/library/src/repo/txn.ts:1026-1037`. It is used by `copyKeptOf` (`:1044`, which picks `lost-copy-stuck`), by `closeOf`, and twice by `closePendingWrite`.
- **What it does:** for every `replaced` line whose backup exists, a path that does not hold that backup's bytes counts as "kept". The backup of a SECOND `replaced` line for the same path holds the change's own earlier write. So does the backup of a `replaced` line that follows the change's own `created` line. Neither is ever meant to be at the path after a complete undo.
- **Probe A:** the change trashes `kept.txt`, then writes a new `new.txt` twice (`created`, `replaced`). There is a crash, the trash copy is deleted, and the library is reopened.
  - The undo removed `new.txt`: everything of the change is undone but the lost file.
  - The list says `rollback: "lost-copy-stuck"`, `canClose: false`.
  - The only file left is `.tmp/txn-….orig-0`, which holds "first\n": the change's own bytes.
  - The close is refused with sentence 40 ("…the app still keeps a copy of a file it could not put back… Restoring the project from a backup… is the way").
- **Probe B:** the same, with an existing `x.txt` rewritten twice (`replaced`, `replaced`).
  - After the undo, `x.txt` holds the researcher's bytes.
  - The state is still `lost-copy-stuck`, and the close is refused the same way.
- **Consequence:** the banner (7), the list's line (14), the answer (21) and the CLI detail (33) say that a copy of another file is kept that the app cannot put back. Nothing of the researcher's is kept. Closing would delete only the change's own intermediate bytes, so "closing deletes nothing" of the researcher's would hold. The project refuses changes until a backup is restored. Before round B the same guard sent the researcher round to "Roll it back" (sentence 25). Round B made it final, with words.
- **Reach:** a file the change wrote twice (the enumeration has `[create, replace]` and `[replace, replace]` as sequences this build takes), plus a lost original.
- **Direction:** count a `replaced` backup as kept only when it holds bytes that are not the change's own. That is the backup of the FIRST `replaced` line at a path that no earlier line of the change created (as `trashedContent` judges "the original"). Add a test with a doubled write.

### Minor

**M1: "Nothing was lost" is still shown while a file IS lost, when the look at the place fails** (R528 I1; probe C).
- **Where:** `txn.ts:501-509`, the trashed line's identity check in the first pass. Its look fails, so the only cause is `could-not-look`. The state is `could-not-read`, and banner 2 says "…the app could not read a file. Nothing was lost; the app keeps what it needs to finish."
- **Probe C:** the kept copy of `kept.txt` is gone, nothing is at its place, and the look at that place fails (`seams.failLook`).
  - **Result:** `.tmp` holds only the marker, and nothing is at the place.
  - Once the look works, "Roll it back" answers the lost answer and the state becomes `lost`. So the banner was untrue while the look failed.
- **By reading, the same at `txn.ts:474-478`:** `exists(to)` fails, so `could-not-look` is raised, and the identity check then adds `kept-copy-gone`. That gives `lost-and-blocked`, which says "the copy… is gone" where the app could not look at the copy at all.
- Rare: it needs a permission or I/O error at the original's place AND a lost copy. It passes when the look works again.
- **Direction:** a `could-not-look` raised on a trashed line whose copy is known to be gone must not choose a "nothing was lost" state.

**M2: `lost-and-blocked` whose other blocker is a failed step points at a file the list does not name as in the way.**
- The list's next line (`interrupted-changes.ts:119`) says "Deal with what is named above first". Above it the only line is the lost file (or, `unconfirmed`, the "something is at that place" line).
- The banner (`:73`) says "move the file the list names, or try again". A researcher may move the file at the unconfirmed place (possibly the original) out of the library.
- Nothing is destroyed, since it is moved outside, but the words point at the wrong act.
- R530 (2) changes only "After that…".
- **Direction:** where no hand-changed, occupied or could-not-look cause is present, say "try again" only.

**M3: the close path's `noteAttempt` has no test** (R528 I2).
- **Where:** `pending-writes.ts:444`. A close whose undo now comes back non-closable (for example, a hand file put in the way after the list said "lost") updates the banner there.
- Replaced by a bare `rollbackAttempts.set`, every test still passes. The service test of a refused close uses a policy refusal, which changes no state.
- **Direction:** a test that closes after a file is put in the way and asserts the warning's state.

**M4: point 1 can take two rounds for a folder the change made, trashed and made again, in a copied library** (probe E: `dir`, `created`, `trashed`, `dir`, `created`).
1. First the new folder is blocked; the researcher moves it out and chooses "Roll it back".
2. The trashed folder is put back, its file removed by hash, and then its `dir` line meets another identity: `hand-changed-file` again, on an EMPTY folder that is surely the change's own.
3. Moved out a second time, the roll-back completes.

Safe: nothing is removed that should not be, and nothing is called done. But the researcher is asked twice and told an empty folder was "changed or put there outside the app". In the ordinary crash (probe F) all of it is undone at the opening.

**M5: two refusal sentences are untrue in a state the ruled words did not consider** (reading only).
- (a) **`RECOVERY_PENDING_TEXT`** ("…until an interrupted change is resolved"). It is also the refusal where a project is held ONLY because an incomplete audit line could not be trimmed in a writable opening (`repo.ts:720`; `pendingReason` gives `interrupted-change` there). No interrupted change exists, and the warning shown says it is "tidied up when the library is next opened with write access".
- (b) **`NOT_CLOSABLE`** (`pending-writes.ts:350`, "…this one can still be rolled back"). It is the route's refusal to close an UNVERIFIABLE change, which cannot be rolled back. It is route-only: the screen offers no close and falls back to its own sentence. R529 holds: no close by any route.

**M6: the M6 reader still drops what another build adds to an entry of a KNOWN kind** (reading only).
- **Where:** `kept-warnings.ts:94`. The entry is rebuilt from the known fields, so a later build's extra field on, say, `interrupted-change-closed` is lost at the next rewrite.
- A known kind whose `projectId` or `at` a later build writes differently makes the whole file "damaged" and set aside.
- **Direction:** keep a known entry's unknown fields, or treat an entry whose known fields fail as `others`.

## The first review's findings

| Finding | Status | Note |
|---|---|---|
| I1 | **mended**, partly | P1's state (lost and in the way) is `lost-and-blocked`, and P2's (lost and a failed step) too; neither says "Nothing was lost" (tested word for word). The 128-row table holds as built. One remaining way in: M1 above. |
| I2 | **mended** | Roll back and failed attempts update the warning, which is tested; the service publishes after a refusal, also tested. A close's non-closable outcome updates it too, but untested (M3). Moving a file outside the app is no act: the banner changes at the next act, as the list does. |
| I3 | **mended** | Both guards fail their tests when removed (verified). The guard itself is over-strict (I1 above). |
| I4 | **mended** | f3bb99f; the service tests pass. |
| M1 | **mended** | Library.dismiss 4/4. |
| M2 | **mended** in words | The states lead in order. But `lost-copy-stuck` is reached falsely (I1 above), and one word slip remains (M2 above). |
| M3 | **mended** | Plus the `reopen` reason, ruled in R530. Leftover: M5 (a) above. |
| M4 | **mended** | `could-not-read`. |
| M5 | **mended** | The answer names the close; the CLI detail is per state; no "yet". |
| M6 | **mended** | Unknown kinds are kept; a higher version is byte for byte, also after a dismissal attempt (404, no write) and after a close (`keepWarning` returns on `newer`). A higher version is never set aside. Leftover: M6 above. |
| M7 | **mended** | `notPutBack` is `{source, role}`; tested for an "other" place and for an original. |
| M8 | **mended** | `lookNow`: "nothing" only on ENOENT/ENOTDIR. The source is named for its own folder, tested. |

## Point 1, the `dir` line (9bc11fa), by probe and reading

A copied library (`cp` with times kept): the change made `M/sub` and `M/f.txt` and created `other.txt` elsewhere (probe D).
- The state is `in-the-way` with `hand-changed-file M`, and nothing inside M is removed.
- `other.txt` (the change's own, by hash) is removed. The rest of the change is undone; nothing is reported done; the marker is kept.
- Moved out, "Roll it back" completes and the marker is gone.

The other cases:
- **An ordinary crash** (probe F, and the existing "ordinary crash" test): removed at the opening, complete.
- **No recorded identity** (an older marker, or a crash before the completion line): `dirIdentity` is undefined, so it is removed as before. By reading, and by the rerun enumeration (30/30).
- **A folder at a created file's path:** `hand-changed-file` (tests changed from `path-occupied`; read and passing).

By reading:
- The pre-pass skips a `dir` line that a later trash at or above it moves away; that line is judged in the reverse pass once its trash is undone (probe E).
- `isBlocked` also skips every line above or below the blocked folder, so nothing in it is half-removed.
- `dirMade` on a nested folder writes an orphan completion line; it is harmless (skipped everywhere).

The remaining oddity is M4.

## The fifty sentences (round B's list)

Untrue somewhere, beyond what R530 changes:
- **7, 14, 21, 33** (lost-copy-stuck): untrue where the "copy" is the change's own (I1).
- **40:** untrue in the same states (I1).
- **2** (could-not-read, "Nothing was lost"): untrue where the unread place had its copy gone (M1).
- **6 and 13** (lost-and-blocked): point at a file to deal with where only a failed step blocks (M2).
- **22:** untrue for the trim-only hold (M5 a).
- **38:** untrue for an unverifiable change, route only (M5 b).

All others are true in every state I built or read, plain and whole:
- No path outside the list: the banner, the answers and the CLI details are path-free; the list shows paths through `UserText`.
- "Lost" is never said where something stands at the place: `somethingThere` drives "unconfirmed" on every surface, and closed sentence 43 is used only where all places had something.
- **48 (R529):** true. No close is offered for an unverifiable change, by any route (`closable` requires `status === "uncommitted"`), and the banner has no "Dismiss".

## The kept warnings' new place (908d6a8)

**A move:** carried, tested ("kept across a move"). A split copies it to both sides, as R529 lists.

**A backup or restore:**
- The app's backups are project zips, which do not carry it.
- A folder-level copy or Time Machine restore carries it as of the time of the backup: warnings dismissed after that backup are shown again. That is harmless; they are this same library's.
- A project restored from a zip gets a new id, so warnings about the old id do not name it.

**Quiet about it:**
- this build's integrity check (tested);
- the retention sweep: `retention.ts:293-317` and `:1201-1222` read only `.tmp/trash-*`;
- the export (per project);
- this build's sweep (`.tmp` names only).

**Mac build 10 (`main` 2d12ab1), by reading.** Nothing in it flags, refuses or sweeps an unknown file at the library's top level:
- `library.ts` (open) reads `library.json` only.
- `entriesBesidesFinderFiles` (`library.ts:81`) is used only for a NEW library and a move's destination (`library.ts:190`, `move.ts:335`, `library-place.ts:31`).
- The sweep (`repo/repo.ts:523-538` at `main`) clears only `Projects/.creating-*` and `.tmp` names.
- `index/rebuild.ts:111` removes only `REBUILD_PREFIX` files.
- A move (`move.ts:237-250`, `NEVER_COPIED` at `:57`) copies it as an ordinary file, and `scanOldCopy` (`move.ts:933-968`) treats it as part of the verified move.
- No Rust code of the shell reads the library folder.

So build 10 ignores it, and a move by build 10 carries it.

**A locked encrypted project:** the record holds an id, kind, project id, time and an optional `"unconfirmed"`. Nothing else (tested).

## The end-to-end scenario

`e2e/interrupted-change.spec.ts` is honest:
- a real marker in this build's shape, written while the library is closed, with the audit count from the log;
- opened through the chooser;
- waits on visible states and on the marker file's absence, with no sleep;
- passed in Chromium.

It does not assert the refused write (409 with sentence 22) before the roll-back. That would be a cheap addition.

## Could only judge by reading
- Mac build 10's handling of the root file.
- M5 (a) and (b).
- M6.
- The `exists(to)` branch of M1.
- APFS identities after a Finder copy: only `fs.cp` on this machine.
