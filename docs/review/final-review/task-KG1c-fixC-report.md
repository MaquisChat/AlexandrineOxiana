# KG-1c, fix round C (Ruling R532): report

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from 47302d6. Not pushed. `git stash` was never used. `…/kg-1-look` was not touched. No permission check refused anything. `git status --short` is empty.

## Commits (head 9073095)

| Point | Commit | What |
|---|---|---|
| 1 (I1) | 0427a82 | The close guard no longer counts the change's own rewritten bytes; the table test. |
| 2 (M1) | 9b6a54e | A failed look never gives "Nothing was lost", and an unread kept copy is never called gone. |
| 3 (M2) | 74238da | New state `lost-and-try-again`: "try again", no file pointed at. |
| 4 (M3) | 011799f | Test for the close path's `noteAttempt`. |
| 5 (M5) | 2810958 | The trim-only hold gives "opened again"; the unverifiable close refusal has its own sentence. |
| 6 (M6) | 9073095 | The kept warnings' reader keeps unknown fields, and keeps aside entries it cannot read. |

## 1. I1: the guard (`packages/library/src/repo/txn.ts`)

**The rule as built.** `backupHoldsOriginal` (txn.ts:1045) and `keptCopiesLeft` (txn.ts:1063).
- A "trashed" line counts as kept when its copy exists. This is unchanged.
- A "replaced" line counts only when no EARLIER line of the same marker is any of these:
  - a "replaced" line at the same path;
  - a "created" line at the path;
  - an "append" line with `created` at the path;
  - a "dir" line at the path or above it.
- If it passes, it counts as kept when its backup exists and the path does not hold the backup's bytes. This is as before.
- So only the backup of the first rewrite of a path that the change did not create counts. The change's own intermediate bytes never count.
- A path trashed and then made again always passes through a "created" line, or a "dir" line above it. `writeFile` records "created" when nothing is there, `copyFile` refuses an existing file, and `mkdir` records the folder. So a rewrite after it is the change's own, and the original is in the trashed copy.
- The users are unchanged: `copyKeptOf`, `closeOf`, and both checks in `closePendingWrite` (before and after its undo).

**The table** (`packages/library/src/repo/close-guard.test.ts`, new). How it is built:
- **Sequences:** every 2- and 3-step sequence at one path `p` that the transaction can take, through `repo.mutate`. A create goes only where nothing is (`writeFile` → "created"); a rewrite (`writeFile` → "replaced") and a trash go only where a file is. Each sequence is cut after each of its steps, and each write uses bytes of its own.
- **Originals:** with an original at `p` (RR, RT, TC, RRR, RRT, RTC, TCR, TCT) and without (CR, CT, CRR, CRT, CTC).
- **The lost original:** the change first trashes the researcher's `q`, and its kept copy is deleted after the crash. So `q` is lost before any close, and the list is in the close-offering state.
- **Size:** 34 cases (21 with an original, 13 without). Each is judged at two moments, so 68 runs:
  - "undone": after the opening's undo;
  - "as crashed": the opening's undo cut off before its first step, by `seams.stopUndoAfter = 0`. The opening then still records the attempt, so the guard decides `lost` against `lost-copy-stuck`, and the close is taken or refused on that disk state.

What the test works out from the bytes, by itself:
- `onlyKept`: the original's bytes are in a `.tmp` backup or trash copy, and not at `p`.
- `expected` = `onlyKept` OR a trash copy of the change is left. Trashed copies count as before.

What it asserts:
- `onlyKept ⇒ guard` (never fewer).
- `guard === expected` (exactly the ruled rule).
- The list's state and `canClose` follow the guard.

**The counts:**

| Moment | "kept" | "not kept" |
|---|---|---|
| Undone (34) | 0 | 34 |
| As crashed (34) | 25 | 9 |

- Of the 25 "kept" cases, 21 have the original held only in a kept copy. The other 4 hold only a trash copy of the change's own bytes: none CT cut 2, CRT cut 3, CTC cut 2 and CTC cut 3. They are held because trashed copies count as before (a refusal on the safe side).
- In total, 43 cases were closed for real and 25 closes were refused.

**After each real close (the 43 "not kept" cases), asserted:**
- the marker is gone;
- the library's files outside `.tmp`, the audit logs and the kept-warnings record equal, byte for byte, the snapshot taken before the change, minus `q` (lost before the close);
- `p` holds the original exactly, or nothing where there was none;
- no copy of the original is left in `.tmp`.

**For each "kept" case (25), asserted:**
- the close is refused with `CLOSE_COPIES_LEFT_TEXT`;
- the marker is byte for byte the same;
- every kept copy in `.tmp` is unchanged;
- every library file is unchanged.

**Failed first:** 15 runs failed on the old guard ("expected true to be false"):
- undone: orig RR c2 (**probe B**), RRR c2, RRR c3, RRT c2, RRT c3, TCR c3; none CR c2 (**probe A**), CRR c2, CRR c3, CRT c2, CRT c3;
- as crashed: none CR c2, CRR c2, CRR c3, CRT c2.

Every other case passed, so the table passes for all the cases where the old guard was right. Untouched files pass: rollback-rerun 30/30, rollback-hand-put 42/42, and P5 in pending-writes-close.

**One shape outside the table, for the coordinator (not a case this build takes):** a change that does all three of these:
- copies a library file X into a new path P (`copyFile` → "created");
- then rewrites P;
- and trashes X.

P's backup would then hold X's bytes (the researcher's), and the new rule would not count it. I checked every `tx.copyFile` caller (`protocol-docs.ts`, `review.ts` ×2, `import-ops.ts`, `assets.ts` ×2, `tombstones.ts`, `sources.ts` ×2). None rewrites the copy in the same change: the set-aside copies have stamped names and are written once. So no transaction of this build reaches it, and I built the rule as ruled.

A related observation, not mine to change: in the set-aside flows, the copy itself is removed by the undo of its "created" line. If X's trash copy were then deleted by hand, the undo would remove the only other copy of X's bytes. This is the undo's own behaviour, not the guard's.

## 2. M1: a failed look

Where it is built:
- `UndoCause.copyGone` (txn.ts:323) is set on a `could-not-look` cause that comes from a trashed line whose kept copy is known to be gone, and whose place could not be looked at. Both branches set it: the identity check (txn.ts about :513) and the older-build check (about :497).
- `incompleteRollbackOf` (shared `interrupted-changes.ts:54-66`) counts such a cause as a copy gone. The state is then `lost-and-blocked`: the loss leads, and it never says "Nothing was lost".
- The list shows only the could-not-look line ("The app could not read {f}, so it left it as it is…"). That is true: it says neither that the file is lost nor that something is there.

**The look at the kept copy itself fails** (txn.ts:480-497):
- The copy is never said to be gone: the identity check is skipped, so no `kept-copy-gone` is raised.
- The place is blocked: nothing at, under or above it is undone while the app cannot tell.
- The state is `could-not-read`. No state's words were true there ("Nothing was lost" is not known, and "the copy is gone" is untrue). So, as the brief says, the state stays `could-not-read` and its banner no longer says "Nothing was lost; the app keeps what it needs to finish." (sentence 2). See NEEDS A RULING 1.
- The roll-back's look seam (`seams.failLook`, test only, R47) now also reaches the look at the kept copy, and `seams-inert.test.ts` has a case for it.

Tests, in `rollback-words.test.ts` "R532 M1" (both failed first):
- **Probe C:** the state is `lost-and-blocked`, not `could-not-read`. Once the look works, "Roll it back" gives `lost` and the close.
- **The copy look fails:** first, before the fix, `lost-and-blocked` was said, which claims the copy is gone. After the fix:
  - the state is `could-not-read`, with the new banner word for word;
  - the change's file and the copy are untouched;
  - once the copy can be read, the roll-back completes and the original is back.

Changed, because they asserted the old words or causes:
- `seams-inert.test.ts`: the identity-look case now expects `copyGone: true`.
- `StatusBanner.test.tsx`: the could-not-read sentence.
- `interrupted-changes.test.ts`: the could-not-read banner. Its table gains a dimension (`unreadGone`, 256 combinations). These shared tests were written after the change to shared; the library tests above failed first.

## 3. M2: a loss whose only other blocker is a failed step

- New state `lost-and-try-again` (shared `interrupted-changes.ts:31, 44, 66`). It is chosen where a copy is gone and no hand-changed, occupied or could-not-look cause is present: a step failed, or a cause of a kind this build does not know, which the list shows no line for.
- A state was the smallest way: the banner reaches the screen only as its state (`IntegrityWarning.state`; the causes are not sent with a warning).
- It has its own banner, list next line and answer.
- The `DETAIL_AFTER` record (pending-writes.ts:143) needs a value for every state, so the command line's detail has a variant too.
- The route's close refusal (pending-writes.ts:362) has one as well: without it the state would fall to "this one can still be rolled back", which is untrue. Both are beyond the three named; see NEEDS A RULING 2.
- Not closable (CLOSABLE_ROLLBACK is unchanged).

Tests:
- **Probe P2** in `rollback-words.test.ts`: changed, because it asserted `lost-and-blocked`. It failed first ("expected lost-and-blocked to equal lost-and-try-again"). It now asserts, word for word, the whole banner, the list's next line, the answer to "Roll it back" while the step still fails, the CLI detail and the close refusal.
- Shared: the expected-state table (unknown kind → `lost-and-try-again`) and a new check that in every such combination the banner, answer and next line contain neither "names", "named" nor "move the file". 11 failed first.
- UI: `StatusBanner.test.tsx` (the new state, both kinds, "Resolve…") and `PendingWritesDialog.test.tsx` (the list's lines for P2, no close).

## 4. M3: the close path's `noteAttempt`

New test in `pending-writes-close.test.ts`, "R532 M3":
1. The change trashes `a.txt` (its copy is then deleted) and writes `b.txt`. After the reopen, the state is `lost` and closable, and the warning says `lost`.
2. A hand file is put at `b.txt`.
3. The close is refused, and the marker and the hand file stay.
4. The list says `lost-and-blocked`, and so does the warning. Its causes are `[kept-copy-gone a, hand-changed-file b]`, and its whole CLI detail is asserted.

Scratch edit, restored with `git checkout`: `noteAttempt` at pending-writes.ts:451 replaced by a bare `core.rollbackAttempts.set`. Then the test **FAILS**: "expected [['lost', …]] to deeply equal [['lost-and-blocked', …]]". It passes with the code as is.

## 5. M5

**(a) The trim-only hold** (`repo.ts:720-725`):
- `st.reopenToResume` is set where the project is blocked only because a line whose trim was attempted at this writable opening failed. That means `l.error`, no marker of the project, and no unattributed marker.
- `pendingReason` then answers `reopen`, and the service sends sentence 23.
- An unattributed marker (no trim attempted) still gives `interrupted-change`, which is true there.
- The warning shown for that hold (`incomplete-audit-line-pending`, `StatusBanner.tsx:106`) says: "The last entry of an audit log in {p} was cut off by a crash. It is tidied up when the library is next opened with write access." So it says the next opening is the way, and sentence 23's "says why" holds.
- One caveat: if the trim fails again at that opening, the project stays held.
- Test: `trim-hold.test.ts` (new). It mocks `truncateDurable` from `./io.js` in that file only, and checks:
  - the warning's kind and detail;
  - `RecoveryPendingError.reason === "reopen"`;
  - no interrupted change is listed;
  - after a reopen with the trim working, the line is trimmed and a write is accepted.
- **Failed first:** "expected 'interrupted-change' to be 'reopen'". The service's mapping of `reopen` to sentence 23 was already tested (`server.test.ts` "R530").

**(b) The unverifiable close** (`pending-writes.ts:356`): `NOT_CLOSABLE_UNVERIFIABLE`, chosen where `i.status === "unverifiable"`.
- Test: `pending-writes.test.ts` P3 asserts the route's refusal word for word, and that nothing changed.
- **Failed first:** it received "Only a change that can never be undone completely…".

## 6. M6: the kept warnings' reader (`kept-warnings.ts:94-101`)

- An entry of a known kind is read with all of its fields (`{ ...w, … }`), so a later build's field stays on it, in its place, when the file is rewritten. What is shown is built from the known fields only, as before.
- An entry of a known kind whose `id`, `projectId` or `at` this build cannot read goes to `others`. It is not shown and is written back as it was; the record is not "damaged".
- A non-object entry, or one without a string kind, is still "damaged", as before.

Tests in `kept-warnings.test.ts` (both failed first):
- **Unknown field:** two kept entries, and a field added to the first. After the second is dismissed, the file is byte for byte `{"formatVersion":1,"warnings":[<the first, exactly as written>]}`.
- **Odd entries:** one entry with a numeric `at` and one with an object `projectId`, around a good entry.
  - The good entry is shown.
  - Nothing is set aside and no set-aside warning is raised.
  - After the good entry is dismissed, the file is byte for byte `{"formatVersion":1,"warnings":[oddAt, oddProject]}`.

## Every researcher-visible sentence new or changed in round C, word for word

The numbered list in `task-KG1c-fixB-report.md` is corrected: 2 is changed; 6b, 13b, 20b, 32b, 38b and 39b are new; and 23 has a note.

1. **(2, changed) Banner, could-not-read:** "An interrupted change in {p} could not be undone completely: the app could not read a file. Changes to {p} are off until it is undone. Choose “Resolve…” to see which file."
2. **(6b) Banner, lost-and-try-again:** "An interrupted change in {p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. A step of the undo also failed, and you can try again first. After that, the list says whether the change can be closed as it is. Changes to {p} are off until then. Choose “Resolve…” to try again."
3. **(13b) The list's next line, lost-and-try-again:** "A step of the undo also failed: first choose “Roll it back” again. After that, this list says whether the change can be closed as it is."
4. **(20b) "Roll it back" answer, lost-and-try-again:** "The change could not be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and a step of the undo also failed. Try again first: choose “Roll it back” again. After that, the list says whether the change can be closed as it is."
5. **(32b) CLI detail, lost-and-try-again** (after the usual prefix): ": the copy the app kept of a file it removed is gone, so that file cannot be put back, and a step of the roll-back also failed; the marker is kept, and once the roll-back is tried again (at the next open, or from the app's list of interrupted changes), that list says whether the change can be closed as it is"
6. **(38b) The library's refusal to close an unverifiable change** (route only): "This change cannot be closed: the app can neither undo it nor close it safely. Restoring a backup made before the change is the way."
7. **(39b) The library's refusal to close, lost-and-try-again** (route only): "This change cannot be closed yet: a step of its undo also failed. Choose “Roll it back” again first; after that, the list says whether the change can be closed as it is."

Unchanged words, now said in more places:
- Sentence 23 ("This project takes no changes until the library is opened again. The warning on the library's main screen says why.") is now also the refusal for the trim-only hold.
- The could-not-look list line (12) is now also shown for a lost file's place that could not be looked at.

Updated table of causes to states (from round B's table):
- `lost-and-blocked`: a copy gone, or a place that could not be looked at whose copy is gone (`copyGone`), AND a hand-changed, occupied or could-not-look cause.
- `lost-and-try-again`: a copy gone, with only a failed step or an unknown kind besides.
- The rest is as in round B.

## NEEDS A RULING

1. **The words where the app could not read a kept copy (M1).** No existing state's words were true there.
   - **Built:** sentence 2 (could-not-read) drops "Nothing was lost; the app keeps what it needs to finish." for every could-not-read case. This is the smallest change; what remains is true in each case.
   - The list's line for that cause says "The app could not read {f}", where `{f}` is the place, but what could not be read is the copy in the work folder.
   - **Proposed** (not built), if the coordinator wants the ordinary case to keep "Nothing was lost":
     - a state of its own, with the banner "An interrupted change in {p} could not be undone completely: the app could not read the copy it kept of a file the change removed, so it cannot tell yet whether that file can be put back. Changes to {p} are off until it is undone. Choose “Resolve…” to see which file.";
     - the list line "The app could not read the copy it kept of the file this change removed from {f}, so it left {f} as it is. Make sure the library's work folder can be read, then choose “Roll it back”.";
     - sentence 2 restored for the other could-not-read cases.
2. **Two sentences beyond the three the brief named (M2):** 32b (CLI detail) and 39b (the route's close refusal) for `lost-and-try-again`. Both were built. The state needs a detail, and without 39b the refusal would say "this one can still be rolled back", which is untrue. Confirm the words.
3. **The route's NOT_CLOSABLE ("…this one can still be rolled back.") is still said for a close asked of a committed marker (it can only be kept) or an invalid one** (route only; the screen offers no close). It is untrue there. Proposed: for committed, "This change was completed, so it cannot be closed; it can only be kept."; for invalid, reuse "Its record cannot be read safely, so nothing it names can be undone or kept." Not built.
4. **Point 1's one residual shape** (above): a copy within the library, then that copy rewritten, then its source trashed, all in one change. No flow of this build takes it. If a later flow does, the guard must count a backup of a path whose "created" line has no hash of its own (a `copyFile` copy) as kept.

## What only a real Mac can show
A real permission or I/O failure at the look at a kept copy, or at a lost file's place. Here both are tested through the look seam.

## Runs (each alone, `nice -n 10`)

**@ao/library:**

| File | Result |
|---|---|
| close-guard (new) | 70/70 |
| **rollback-rerun (once, untouched)** | 30/30 |
| **rollback-hand-put (once, untouched)** | 42/42 |
| pending-writes | 22/22 |
| pending-writes-close | 14/14 |
| rollback-words | 20/20 |
| kept-warnings | 13/13 |
| trim-hold (new) | 1/1 |
| repo | 61/61 |
| seams-inert | 9/9 |
| rollback-own-writes | 14/14 |
| txn-completion | 9/9 |
| find/runner | 301/301 |

**Other packages:**
- @ao/shared interrupted-changes: 262/262.
- @ao/ui: StatusBanner 76/76, PendingWritesDialog (the list's screen) 25/25.
- @ao/library-service server.test: 158 passed, 1 skipped.
- @ao/cli: no test quotes a changed sentence (searched `apps/` and `e2e/`); none run.

**Typechecks** (one at a time): shared, library, ui, library-service, cli: all ok.

**Not needed:**
- `lint:css` and `lint:colours`: no screen file changed (UI tests only).
- End to end: not run. `interrupted-change.spec.ts` asserts only the in-the-way banner and the list's line, and neither changed.

`git status --short`: empty.

## Last points (R533, R534)

Branch `kg-1-rollback`, from 9073095. Head 4e83973. Not pushed. `git stash` was never used, and `…/kg-1-look` was not touched. No permission check refused anything.

| Point | Commit | What |
|---|---|---|
| 1 (R533 (4)) | db204f8 | The guard counts the backup of a copy-made path as kept. The table creates by copying too. |
| 2 (R533 (1)) | 6083608 | The list's line for an unreadable kept copy. |
| 3 (R533 (3)) | bd1e502 | The route's refusal to close a completed or unreadable change. |
| 4 (R534 a) | 4e83973 | The atomic copy's tests assert `storedSha256` (test only). |

### 1. The guard, on the safe side (R533 (4))

**Where:** `backupHoldsOriginal`, `packages/library/src/repo/txn.ts:1058`. Its doc comment is at :1049. `keptCopiesLeft` itself is unchanged.

**The rule as it now reads, word for word:**
> R532 I1, R533 (4): whether the backup of "replaced" line `i` may hold bytes that are not the change's own. It holds only the change's own bytes where the nearest earlier line of the change at its path shows the change wrote the file there from bytes of its own making: an earlier "replaced" line at the path (the backup holds that rewrite's bytes), a "created" line with a hash of its own and no completion mark (a file written whole), or a file the change created by appending. Every other origin counts as holding the researcher's bytes (the safe side): the path was there before the change; the change created it BY COPYING a file (a "created" line with no hash of its own, whose completion line carries the hash as stored); or it lies in a folder the change made, where a copy and a write leave the same line.

How it tells the two kinds of file apart:
- `Tx.writeFile` writes a "created" line with `sha256` and no `complete`. That is the change's own bytes.
- `Tx.copyFile` writes a "created" line with no `sha256`, then a completion line (`complete: true`, the hash as stored).
- The scan goes back from the rewrite to the nearest line at that path. It skips completion lines and "trashed" and "dir" lines.

**One shape now held on the safe side that R532 I1 had let through: a file inside a folder the change made.** There, `writeFile` and `copyFile` both leave only a completion line. `created()` writes nothing in a new folder. So the guard cannot tell a copy from the change's own write, and it counts that backup as kept.

What this costs:
- Take a change that makes a folder, writes a file in it, and rewrites that file in the same change, and that also lost an original elsewhere. It now lands in "a copy is still kept", and no close is offered.
- Nothing is destroyed; a project is held without need, the over-refusal R532 I1 had removed for this shape.
- The table runs at one path in an existing folder and does not take this shape.
- The only way to tell the two apart would be a new field on the completion line, a change to the marker format. Not built; it is the coordinator's call.

**The table** (`packages/library/src/repo/close-guard.test.ts`):
- **A fourth kind of step, K:** create by copying. It goes only where nothing is: `tx.copyFile(q, p)`, from the researcher's file `q`.
- **Where q is trashed:** in a case whose steps include a copy, the change trashes `q` after its steps, not before. Its kept copy is deleted as before. So the residual shape, copy → rewrite → trash the source with its kept copy gone, is "none KR cut 2" (and KRR, KRT, TKR…).
- **What counts as the researcher's:** the test works out, from the bytes, whether either is held only in a `.tmp` copy:
  - the original at `p`, as before;
  - or `q`'s bytes, when they are in no file of the library outside `.tmp`.
- **What is asserted:** the same as before. `onlyKept ⇒ guard` (never fewer) and `guard === expected` (exact), the list's state and `canClose`, and then the real close or the refusal, with every byte compared.
- Every earlier case is unchanged in its steps and its expectations.

**Failed first:** on the unchanged guard, 10 runs failed at "never fewer" (`if (onlyKept) expect(guard).toBe(true)`, line 223): the guard said "not kept" while `q`'s bytes were held only in a rewrite's backup.
- undone: orig TKR c3; none KR c2, KRR c2, KRR c3, KRT c2, KRT c3;
- as crashed: none KR c2, KRR c2, KRR c3, KRT c2.

After the change, all pass.

A finding about the undo, not the guard: in the "undone" failures, the undo restores the copy's backup and leaves `q`'s bytes only in a kept file. So the guard's refusal is needed there too.

**The new counts:**

| | Before | Now |
|---|---|---|
| Cases | 34 | 64 (32 with an original, 32 without) |
| Runs (each case at both moments) | 68 | 128 |
| Undone: "kept" / "not kept" | 0 / 34 | 6 / 58 |
| As crashed: "kept" / "not kept" | 25 / 9 | 48 / 16 |
| Runs where the researcher's bytes are held only in a kept copy (all "kept") | 21 | 47 |
| Closed for real | 43 | 74 |
| Refused with nothing changed | 25 | 54 |

The file runs 130 tests: the 128 runs, the count check and the counts line.

### 2. The list's line for an unreadable kept copy (R533 (1))

The cause carries the field `copyUnread?: true` on the existing `could-not-look` cause. There is no new cause kind.
- It is defined at `txn.ts:328` and set at `txn.ts:500`, where the look at the kept copy fails.
- The route passes it on: `apps/library-service/src/routes/libraries.ts:449`.
- The UI's type: `packages/ui/src/api/library.ts:102`.
- The screen chooses the sentence at `packages/ui/src/components/PendingWritesDialog.tsx:64-75`. `{f}` is shown through `UserText`, both times.
- The sentence lives in one place: `COULD_NOT_READ_KEPT_COPY_TEXT`, `packages/shared/src/api/interrupted-changes.ts:122`.
- The banner is unchanged.

New sentence, word for word (`{f}` is the place's library-relative path):
> The app could not read the copy it kept of the file this change removed from {f}, so it left {f} as it is. Make sure the library's work folder can be read, then choose “Roll it back”.

Tests (each failed first):

| File | Test |
|---|---|
| `packages/shared/src/api/interrupted-changes.test.ts:125` | The whole sentence, and the ordinary could-not-look line unchanged. |
| `rollback-words.test.ts:552` | The cause is `{ kind: "could-not-look", path, copyUnread: true }`, and the whole sentence. At :521 (probe C, the place unread) there is no `copyUnread`. |
| `PendingWritesDialog.test.tsx:249` | The whole sentence rendered, with both paths as text. The existing four lines in the table above it are unchanged and pass. |
| `server.test.ts:3040` | The route carries `copyUnread` when the copy's look fails, and not when the place's look fails. |

Changed because it asserted the old shape: `packages/library/src/seams-inert.test.ts`, the "R532 M1 … kept copy" case. It now expects `copyUnread: true`.

### 3. The route's refusal to close (R533 (3))

In `packages/library/src/repo/pending-writes.ts`:
- `RECORD_UNREADABLE` (:198) is the existing sentence, moved into a constant that `whyNot` (:201) and the close refusal (:448) both use.
- `NOT_CLOSABLE_COMMITTED` (:359) is new.

The refusal now reads, word for word:

| Change asked to close | Refusal |
|---|---|
| Completed | "This change was completed, so it cannot be closed; it can only be kept." |
| Its record cannot be read | "Its record cannot be read safely, so nothing it names can be undone or kept." |
| Can still be rolled back (unchanged) | "Only a change that can never be undone completely can be closed as it is; this one can still be rolled back." |

Tests (each failed first):

| File | Test |
|---|---|
| `pending-writes.test.ts:184` | A completed change. |
| `pending-writes.test.ts:210` | An invalid marker, closed with `projectId "*"`. |
| `server.test.ts:3107` | The route, 409 with each sentence. |

The unchanged refusal is still asserted in `pending-writes-close.test.ts:289`, which passes.

### 4. The atomic copy's tests (R534 a)

`packages/library/src/fs/atomic.test.ts:133, :145, :160, :180`. No product code changed.

What each test now asserts for `storedSha256`:

| Case | `storedSha256` |
|---|---|
| Plain copy | The sha256 of the content. |
| `noFollow` | As the plain case. |
| Transform | The sha256 of the destination file read back from disk, and different from `sha256`. |
| Empty file | `e3b0c442…b855`, the hash of nothing. |

Each is what the code answers, so there is no finding. The original file, run as a copy beside it, failed these 4 tests, and the mended file passes 23/23.

### Runs (each alone, `nice -n 10`, `NODE_OPTIONS="--use-openssl-ca"`)

| File | Result |
|---|---|
| close-guard | 130/130 |
| rollback-rerun (untouched) | 30/30 |
| rollback-hand-put (untouched) | 42/42 |
| pending-writes | 22/22 |
| fs/atomic | 23/23 |
| shared interrupted-changes | 263/263 |
| library-service server.test | 160 passed, 1 skipped |
| ui PendingWritesDialog | 26/26 |
| seams-inert | 9/9 |
| rollback-words | 20/20 |
| pending-writes-close | 14/14 |
| rollback-own-writes | 14/14 |

- Typechecks: shared, library, ui, library-service and cli, each ok.
- `lint:css` and `lint:colours`: ok.
- `git status --short`: empty.

## The guard and covering folders (review 3)

Branch `kg-1-rollback`, from 4e83973. Head a4ba523. Not pushed.

| Commit | What |
|---|---|
| 4d78362 | The mend (I1), its probe test, and the folder table. |
| a4ba523 | M2: comments only. |

**The mend:** `backupHoldsOriginal`, `packages/library/src/repo/txn.ts` (about :1060). Inside the scan, before the old skip, there is now one stop:
```ts
const at = x.kind === "trashed" ? x.from : x.path;
if ((x.kind === "trashed" || x.kind === "dir") && (path === at || path.startsWith(`${at}/`))) return true;
```

**The rule as it now reads, word for word (doc comment):**
> R532 I1, R533 (4): whether the backup of "replaced" line `i` may hold bytes that are not the change's own. It holds only the change's own bytes where the nearest earlier line of the change at its path shows the change wrote the file there from bytes of its own making: an earlier "replaced" line at the path (the backup holds that rewrite's bytes), a "created" line with a hash of its own and no completion mark (a file written whole), or a file the change created by appending. Every other origin counts as holding the researcher's bytes (the safe side): the path was there before the change; the change created it BY COPYING a file (a "created" line with no hash of its own, whose completion line carries the hash as stored); or it lies in a folder the change made, where a copy and a write leave the same line. Where the scan back meets a "trashed" or "dir" line that covers the path (the path itself or a folder above it) before the line that made the file as it stood at the rewrite, it stops and counts the backup as kept (review 3 I1).

### (a) The reviewer's probe, as a test

It is in `close-guard.test.ts`, under "review 3 I1 … the reviewer's probe". The steps:
1. Write `d/f`.
2. Trash `d`.
3. Make `d` again.
4. Copy `q` into `d/f`.
5. Rewrite `d/f`.
6. Trash `q`.

Then both kept copies are deleted.

At both moments it asserts:
- From the bytes, `q`'s bytes are held only in a kept copy.
- The guard says "kept".
- The list shows `lost-copy-stuck` with `canClose: false`.
- The close is refused with `COPIES_LEFT_TEXT`, and the marker, `.tmp` and the library are unchanged.

**It failed first** on the unchanged guard: "undone: expected false to be true".

### (b) The folder table

The file is `d/f.txt` inside the folder `d`.

| Step kind | Letter |
|---|---|
| Create from the change's own bytes | C |
| Create by copying `q` | K |
| Rewrite | R |
| Trash the file | T |
| Make `d` | M |
| Trash `d` | D |
| Trash `d` and make it again | X |

What it covers:
- **Sequences:** every sequence of one to four steps the transaction can take with at least one folder step.
- **Starts:** `d` with the researcher's `f.txt` and `g.txt`; `d` with `g.txt` only; no `d`.
- **Duplicates removed:** a cut of a longer sequence is the shorter sequence, so it is not a case of its own.
- **Why four steps, not three:** the reviewer's shape is C X K R, and three steps cannot reach it.
- **Kept copies deleted:** after the crash, every kept copy the change trashed is deleted (the copies of `q`, of the file and of the folder).
- **The oracle**, from the bytes alone: it walks `.tmp`, into folders. For f's original, g and q, it asks whether each is held only there and in no library file.

What it asserts:
- `onlyKept ⇒ guard`.
- Where the guard holds, the close is refused with nothing changed.
- Where the guard lets the close through, nothing that a kept copy held before the close is lost. This covers a close that goes through, one refused as not closable, and one whose own undo stayed incomplete.

**Before the mend:** the only miss in the whole table was "d CXKR", at both moments: the reviewer's shape. No other miss.

**The counts:**

| Measure | Result |
|---|---|
| Cases | 405 |
| Runs | 810 |
| Undone: "kept" / "not kept" | 104 / 301 |
| As crashed: "kept" / "not kept" | 104 / 301 |
| Runs with the researcher's bytes held only in a kept copy (all "kept") | 162 |
| Closed for real | 546 |
| Let through but not closed | 56 |
| Refused by the guard with nothing changed | 208 |

The old table's counts are unchanged: undone 6/58, as crashed 48/16, held only in a kept copy 47.

Two things to note:
- The folder table's "undone" and "as crashed" counts are identical. With every kept copy deleted, the opening's undo changes nothing the guard reads in these shapes. This is an observation, not looked into further.
- In 56 runs the guard let the close through but it did not close (the change was refused as not closable, or its own undo stayed incomplete). Some of these record the close choice on the marker before stopping (R532 M3's path). No researcher bytes are lost in any of them.

### M2 (comments only)

In `packages/shared/src/api/interrupted-changes.ts`, three places now say that a cause of a kind this build does not know is also told "a step failed" (or "a step of the undo also failed"):
- the state list's line for `lost-and-try-again`;
- the comment at the `lost-and-try-again` return;
- a new comment at the final `try-again` return.

No behaviour changed.

M1 is for the coordinator's list; nothing was built.

### Runs (each alone, `nice -n 10`, `NODE_OPTIONS="--use-openssl-ca"`)

| Run | Result |
|---|---|
| close-guard | 942/942 |
| pending-writes | 22/22 |
| rollback-rerun | 30/30 |
| rollback-hand-put | 42/42 |
| `@ao/library` typecheck | ok |
| `@ao/shared` typecheck (comment change) | ok |

`git status --short`: empty.
