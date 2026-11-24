# KG-1c with KG-1b's last point: fix round A (Ruling R527), report

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from 3facb9c. Not pushed. `git stash` never used. No permission check refused anything. `…/kg-1-look` was not touched.

Commits:
- `9bc11fa`: point 1.
- `f3bb99f`: a fixture fix outside the four points (see "Also found").
- `85cdcf2`: point 2.
- `908d6a8`: point 4. **Head 908d6a8.**
- Point 3: **NOT BUILT. It cannot be built as ruled; see NEEDS A RULING 1.**

## Point 1: a folder the undo cannot identify is never "done"

**What changed** (`packages/library/src/repo/txn.ts`):
- `identityAt` (about l.381) answers `"nothing" | "it" | "other"`. It replaces `isOriginal`.
- `dirTrashedLater` (about l.393).
- **A new pass in `undoEntries`, BEFORE any line is undone** (after `block`, about l.520):
  - It takes every first `dir` line that has a recorded identity and is not already done (R493) and that no later `trashed` line moves away at or above its path.
  - If something with ANOTHER identity stands at its path, the folder is blocked with `hand-changed-file` and the folder's path.
  - Nothing at, under or above it is then undone, so none of the change's files inside it is removed either: nothing is left half-removed.
  - A look that fails is `could-not-look`.
- **The `dir` step in the reverse pass** (for folders a later trash moves, judged once that trash is undone):
  - nothing there: done;
  - the change's own folder: removed;
  - anything else: blocked with `hand-changed-file`, never "done".
- **A folder at a created FILE's path:** `path-occupied` becomes `hand-changed-file`.
- `path-occupied` is now raised only by a trashed line's put-back. The comment on `UndoCauseKind` says so.
- **No recorded identity** (an older build's marker, no time of birth): as before.

**Tests, each failed first:**
- `rollback-hand-put.test.ts`:
  - **New: the reviewer's probe.** The change runs `mkdir made/sub`, writes `made/f.txt`, copies `made/c.txt` and appends `made/log.jsonl`; a crash. The library is copied with `fs.cp` (times kept) and opened from the copy.
    - At two openings: the folder is whole (`c.txt`, `f.txt`, `log.jsonl`, `sub`), the marker is kept, and the result is incomplete with `[{hand-changed-file, made}]`.
    - Moved out of the library, "Roll it back" (`resolvePendingWrite`) completes.
    - Failed first: the folder held only `["log.jsonl","sub"]`, which is the half-removal.
  - **Changed: probe D (M2).** The person's folder is now kept with only `mine.txt`, incomplete with `hand-changed-file` at D, at the second and third opening. Moved away, "Roll it back" completes. It used to expect complete.
  - **Changed, line level:** "a folder at the path with another identity" now expects `{ok:false, causes:[hand-changed-file P]}` (it was `{ok:true}`). "a file at the path" expects the same (it was `{ok:true}`).
  - **Changed: the three M4 cases** expect `hand-changed-file`, not `path-occupied`.
- `rollback-rerun.test.ts`, `folderCase`:
  - **The changed expectation:** a person's own folder at D is never "complete", from an original OR from none. With no original it was "may complete (R526 M2)". The doc comment is changed with it.
  - Run against the old `txn.ts`: "a person's hand between two undos" failed with 6 failures. Now 30/30.
  - The asserted counts (`EXPECTED_FOLDER` and the rest) are unchanged.

**The sentence for `hand-changed-file`:** "your version is kept there" is untrue for a folder that may be the change's own (a copied library), so it is reworded. **FOR THE REVIEW** (shared `ROLLBACK_CAUSE_TEXT`; `PendingWritesDialog.test.tsx` changed with it):
- before: "{f} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (your version is kept there), then choose “Roll it back”."
- now: "{f} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”."
- "was changed or put there outside the app" holds for a copied library too: it was copied outside the app.
- **Also for the review, not changed:** the in-the-way banner and answer say "a file changed or put there outside the app is in the way". For a folder, "file" is loose.

## Point 2: "lost" is never said where something is at the place

**How it is carried.** No new cause KIND.
- `UndoCause` gains `somethingThere?: true`, on `kept-copy-gone` only (`txn.ts`):
  - set where the identity check found "other";
  - set in the older-build branch, where the change's own bytes stand at the place;
  - absent where nothing is there.
- The state of an incomplete undo gains a value: `IncompleteRollback = … | "unconfirmed"` (shared `interrupted-changes.ts`).
  - `incompleteRollbackOf` gives `lost` when at least one such place is empty, otherwise `unconfirmed`.
  - It flows unchanged through the warning's `rollback`, the service's `state`, the list's `rollback`, and the in-process warning.
- `closable` accepts `lost` or `unconfirmed` (`pending-writes.ts`).
- The closed change's kept warning carries `rollback: "unconfirmed"` when every place had something:
  - stored in the kept record as an optional field, checked by the reader;
  - shown by `StatusBanner` with its own sentence.
- The service's list passes `somethingThere` (`routes/libraries.ts`), and the UI's list picks the new line for it.

**Sentences, FOR THE REVIEW** (numbers as in KG-1c's §2):
- **3, banner. Kept for `lost`.** New for `unconfirmed`: "An interrupted change in {p} cannot be undone completely: the copy the app kept of a file it removed is gone, so the app cannot put that file back. Something is at its place now, which may be that file, but the app cannot confirm it, so it left it as it is. Changes to {p} are off until you close the change. Choose “Resolve…” to see what is there."
- **6, the list's line. Kept where nothing is there.** New (`KEPT_COPY_GONE_UNCONFIRMED_TEXT`): "The file this change removed from {f} cannot be put back: the copy the app kept of it is gone. Something is at that place now, which may be that file, but the app cannot confirm it, so it left it as it is."
- **11, the answer to "Roll it back": unchanged, and used for both states.** "…the copy the app kept of a file it removed is gone, so that file cannot be put back." It says nothing of what is at the place, so it is true in both.
- **18, the command line's detail: unchanged, used for both,** for the same reason.
- **21, the close question. Changed last sentence only:**
  - was: "Closing deletes nothing. The project takes changes again, and a warning about what was lost stays until you dismiss it."
  - now: "Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it."
  - Its now-sentences are unchanged.
- **27, the banner after closing. Kept where nothing was there.** New for `unconfirmed`: "An interrupted change in {p} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone; the app could not confirm that what is at its place is that file. The closing is recorded in the audit log of {p}."
- **28, the command line's detail after closing: unchanged.** "…a file it had removed could not be put back" is true in both.
- **Note for the review: the close question's now-sentence for a folder.** `lostOf` calls a folder "something else", so the question says "Something else is at that place now; it stays as it is." A put-back original source FOLDER can therefore be called "something else". Not changed: the brief accepts the dialog's three cases.

**Tests, each failed first:**
- `rollback-words.test.ts`:
  - **Changed:** the "kept copy gone" case, which has the change's own file at the place, is now `unconfirmed` with `somethingThere`. It was `lost`.
  - **New:** a case with nothing at the place: `lost`.
  - **Changed:** the recorded-choice test now uses the nothing case, so it still asserts `lost`.
- `rollback-hand-put.test.ts`: 7 exact cause assertions gain `somethingThere: true`, each where a file stands at the place:
  - M2 ×3 (not the "nothing at the path" one);
  - the copy-of-itself test;
  - the older-build line;
  - the control;
  - probe F;
  - the cut-marker test.
- `pending-writes-close.test.ts`:
  - **Changed:** "the kept copy gone" now expects `rollback: "unconfirmed"`.
  - **Changed:** the nothing case asserts `lost`.
  - **Changed:** the close test asserts the closed warning's `unconfirmed`, also after a reopen.
  - **New:** nothing at the place: the closed warning has no state, also after a reopen.
- `StatusBanner.test.tsx`: the `unconfirmed` banner for both kinds, and the closed `unconfirmed` sentence. 3 failed first.
- `PendingWritesDialog.test.tsx`: the new line, and the changed QUESTION. 2 failed first.
- Service `server.test.ts`, new "R527": the list's cause carries `somethingThere` and the warning's state is `unconfirmed`. It failed with the route's change taken out.

## Point 3: closing a change an older build left in the mixed shape. NOT BUILT (NEEDS A RULING 1)

## Point 4: the kept warnings travel with a move

**Where the move leaves things.** `move.ts` copies everything except `NEVER_COPIED` (`.lock`, `.tmp`, the index side files, the move markers). In a split it also leaves `SHARED_DERIVED` behind (index, Exports, Backups, .cache).
- The library's own bookkeeping at its root is copied by a whole move and by a split: `library.json`, the library's audit log `audit/`, `audit-reasons.jsonl`.
- **The record now lives at `<Library>/recovery-warnings.json`** (`kept-warnings.ts`: `pathOf`, and the header).

**Everything else as KG-1c built it:**
- atomic, 0600;
- a damaged record is set aside INTO `.tmp/` as `recovery-warnings.damaged-…json`, so sentence 30 ("kept in the library's work folder") stays true;
- read-only writes nothing;
- the record holds a project's id only.

**The integrity check:**
- this build's `checkIntegrity` reads only recorded files (tested: quiet);
- `main`'s reads only recorded files as well: by reading, `expectedFiles` builds from `listProjectEntries` and the manifests;
- nothing in `main` reads the library's root but `library.json`, `audit/` and the known folders.
- So no ruling is needed on that.

**About "a backup".** The app's backups are of projects (zips of a project folder) and carry nothing library-level, not even the library's audit log. The root is carried by a move and by a copy or Time Machine backup of the library folder. A restored project gets a new id, so a carried warning could not name it anyway. Said plainly for the review.

**Not built: a split move** copies the root file to both sides. Each side then shows the other side's warnings with the project named "a project". A show-time filter to this library's projects would mend it. Not ruled; listed.

**Tests:**
- `kept-warnings.test.ts`:
  - `FILE` is now the root path, so the tests read the record at its new place.
  - **New:** "kept across a move of the library". `executeMove` as `move.test.ts` runs it; the moved library shows the same warning with its id and dismisses it; and the record is not in `.tmp`.
  - **Failed first: 5 of 8.**
- `repo.test.ts`: the three assertions KG-1c changed to `.tmp` = `["recovery-warnings.json"]` are back to `[]`.
- `pending-writes-close.test.ts`: `snapshot()` skips the root record. It skipped `.tmp` before, where the record was. The closing writes that record, so this is not a deletion.

## Also found
- **`f3bb99f`: KG-1c's service fixture** (`server.test.ts`, `lostOriginal`) wrote a trashed line with b72caae's identity (`ino`, `size`, `mtimeNs`). The merged reader refuses it ("bad trashed entry"), so 3 FR-736 service tests failed on the merged head 3facb9c. It now carries `ino` and `birthtimeNs`. Fixture only.

## NEEDS A RULING

### 1. Point 3 (R527 (1)) cannot be built as ruled: closing would delete the researcher's only copy of the original

**The enumeration's unverifiable cases.** I listed them with a scratch run (instrumented, then restored with `git checkout`).
- **17 older-build mixed-shape cases** end `unverifiable` (KG-1c counted 15):
  - [append, replace] cut 0;
  - [append, append, replace] 0;
  - [append, replace, append] 0, 1, 2;
  - [append, replace, replace] 0, 1;
  - [append, replace, trash] 1;
  - [append, trash, create] 0;
  - [create, append, replace] 0;
  - [create, replace, append] 2;
  - [replace, append] 2;
  - [replace, append, append] 2;
  - [replace, append, replace] 3;
  - [replace, append, trash] 3;
  - [replace, replace, append] 3;
  - [trash, create, append] 3.
- **16 of the 17 still hold a kept copy the marker names:**
  - a `replaced` backup, or a trash copy;
  - holding the researcher's earlier bytes, which are NOT at the path. For example, [append, replace]: the backup holds the original plus one line, and the path holds the rewritten file.
- **What closing would do to those copies.** Closing removes the marker:
  - `removeMarker` deletes the `replaced` backups;
  - the opening's sweep deletes `trash-*` once no marker is left, and orphan backups.
  - So "Closing deletes nothing" would be untrue, and the only copy of the original would be destroyed.
- **The close as KG-1c built it already refuses this** (`keptCopiesLeft`, sentence 25). With it, 16 of the 17 could never be closed, against "the 15 cases become closable".
- **Only one case could be closed truthfully:** [trash, create, append] cut 3 (its copy was put back).

**One more case.** [append, trash, append] from a file, first roll-back cut 0, is a sequence this build itself takes. It also ends `unverifiable` ("now shorter than when the change began"), with its trash copy kept. It is not of the mixed shape. By the ruling it is not offered the close; it stays blocked, with the backup advice.

**How I would recognise the shape** (not built):
- the marker names one path in both an `append` line and a `created`/`replaced` line (R503 a's rule);
- the prefix verifies and the anchor is not past the change's start;
- `offsetProblem` fails, but passes when its end-of-file check skips exactly those paths (the audit-count checks still apply).

**Options:**
- **(a)** Offer the close only where no kept copy is left. That is one case in 17, plus any where a person has since removed the copies.
- **(b)** Offer it everywhere and keep the copies. There is no place a kept copy can survive the marker's removal (R519 (1): a kept folder is "not for this round").
- **(c)** Leave these as R131 a has them, with "restore from a backup", and change only the banner.

**Recommendation: (c) now,** with the banner change R527 rules, because the banner is untrue for every unverifiable marker:
- it would become: "An interrupted change in {p} was left as it is, because its audit log could not be checked first. Choose “Resolve…” to see what can be done."
- **(a)** later, if wanted.
- Nothing of point 3 is built, the banner included, because the brief says to stop the point.

### 2. Point 2: the new state value
`unconfirmed` is a STATE of the undo (like `lost`), not a cause kind. Confirm that this is acceptable.

## What only a real Mac can show
- APFS identities after a Finder copy, or a restore of the library. The probe uses `fs.cp` on ext4.

## Runs (each alone, `nice -n 10`, single files)

`@ao/library`:
- rollback-rerun 30/30 (60.1 s, at the head)
- rollback-hand-put 42/42
- txn-completion 9/9
- pending-writes 22/22
- pending-writes-close 9/9
- seams-inert 7/7
- rollback-words 10/10
- rollback-own-writes 14/14
- kept-warnings 8/8
- repo 61/61
- move 70/70
- annotations 42/42
- library 35/35
- recovery-code 27/27
- sources-read-race 13/13
- disk-full 14/14
- watch-register 30/30
- device-and-old-copies 18/18
- export/backup 23/23

`@ao/library-service`: server.test 156 passed, 1 skipped (157).

`@ao/ui`:
- StatusBanner 66/66
- PendingWritesDialog 21/21
- `lint:css` clean
- `lint:colours` "ok: no hard-coded colours"

`@ao/cli`: cli.test 40/40.

Typechecks clean: shared, library, library-service, ui, cli.

No end-to-end spec drives these screens (KG-1c's grep), so none was run. `git status --short` is empty.
