# Batch KG-1a: report (FR-738, FR-737; Ruling R503 a, b)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from 579bdcd.
Commits: `e4bbc18` (FR-738), `067e199` (FR-737). Not pushed. `git status --short` is empty.

## Items

| FR | Still present? | What changed | Its test, and whether it failed first | Note |
|---|---|---|---|---|
| FR-738 | **Partly.** The queue did mix "replaced" and "append" in one change. **The blocked state as listed does NOT reproduce for the queue** (see the finding below). A different symptom of the same mix does reproduce: a **false "changed outside the app" warning**. | `find/queue-store.ts`: `mendFindQueueTail` (:737) cuts a torn last line in ONE governed change of its own (`project.find.repair`, audited `{ bytes }`), committed before the append. `appendFindEntries` (:610-613) calls it first. `linesInTx` no longer cuts: a file still torn is refused before anything is written or cached (:683, `TornFileError`, mapped to `FindQueueUnwritableError`). `find/types.ts`: `FIND_QUEUE_OPS.repair`. `repo/review.ts`: the hold, both decisions, and the entry's removal call the mend before their change (:623, :738, :775, :805). `recordRemovedLine` (:350-358): see below. `repo/watch-register.ts`: the same split (`mendTail` :334, op `project.watched-folder.repair`; the append change refuses a torn file :374). The intact-file pre-check is synchronous (`endsTornSync`), so a change is queued in the same turn as before (R379 lock test). `repo/txn.ts`: `TxnLog.refuseMixed` (:150; called in `created`, `replaced` and `append` before anything is recorded or written). It throws `MIXED_WRITE` (:91), "A change must not both append to a file and rewrite that same file (R503 a)." This holds in either order, with or without a trash between. The undo's end-of-file check (`offsetProblem`) is unchanged. | `queue-store.test.ts` "R503 a (FR-738)": crashes at before-changes, before-audit and before-marker-delete of the cut's change and of the append's change, and between the two (`mendSeams.afterMend`, test-only, NODE_ENV=test). Each undone crash also has the reopen's roll-back cut after 0 and 1 steps, then a second reopen. That is 15 cases, plain and sealed. Checks: the file is the torn original or the cut, never half; the entry is there only when committed; no marker; no refusal; no outside-change warning; a later add succeeds. **Failed first** (28 failures plain; among them the outside-change warning and "the cut and the add are one change"). Also the two-changes audit test (failed first). `rollback-rerun.test.ts` "R503 a" checks each order: refused, and the file, the marker and `.tmp` are as the first step left them; the change is undone. **Failed first** (the second step wrote). `watch-register.test.ts` "R503 a" checks two audited changes. **Failed first.** `review-held.test.ts` "R503 a" checks two tests: the hold, attach, discard and remove each cut first; a source deletion is not stopped. **Failed first.** | See the findings and the changed tests. |
| FR-737 (1) | Yes (unreachable by the app, as listed) | `repo/txn.ts` `undoEntries`: the `done` rule now covers later lines at or under a put-back trashed path (:267-271). | `rollback-rerun.test.ts` "R503 b 1": 3 shapes (a file created inside; one in a folder inside; two files). The first roll-back is cut after each step, then a second and a third run (hand-built marker lines at `undoEntries` level, since no app change records such a line). **Failed first** (the original `a.txt` was deleted by the re-run). | |
| FR-737 (2) | Yes | `repo/txn.ts`: `ownBytesAt` (:225) and its use (:259-266). The case: a trashed line's copy is gone, but the file at its path has the hash a LATER created/replaced line of the change recorded. Then the copy was deleted outside the app. `ok = false`, so the marker is kept and the outcome is `rollback-incomplete`. The later lines are still skipped, so nothing is deleted. Unreadable means `ok = false` too. | `rollback-rerun.test.ts` "R503 b 2": real API (trash, then write; crash before-audit; the kept copy deleted by hand). At the first and second reopens: the change's file stays, the marker is kept, `rolled-back-incomplete-write` is raised with the "could only be partly rolled back" text, there is no outside-change warning, and it is listed by `pendingWrites`. **Failed first.** A second test checks that a copy really put back still finishes; it passed before and after (guards R493). | It only identifies the change's own bytes where a later line recorded a hash. A file the change COPIED (no hash) or a folder made again cannot be told apart from a put-back original yet, so they behave as before. KG-1b's completion-hash line (FR-735) will make copies identifiable. |

Do existing sequences of `rollback-rerun.test.ts` change their result? For FR-737, **no**: every sequence left in the enumeration passes unchanged, and so do Q1 and the crash-in-reopen case. For FR-738, see the changed test below.

## Findings (read these)

1. **FR-738's "blocked" state does not reproduce for the queue.**
   - I probed the old code: a torn queue, then a crash at before-changes and at before-audit of the mend-and-add change, plain and sealed. I tried the reopen's roll-back cut after 0, 1 and 2 steps, plus an in-process undo failing at "replaced" or "append". No reopen ever refused (`txn-recovery-skipped-audit-unverifiable`), and no marker was left.
   - The reason: the cut is a byte prefix of the torn original that ends a line. So `offsetProblem`'s check (size at least prevSize, a newline at prevSize-1) always holds, whatever state the file is in.
   - The enumeration's blocked cases needed contents that are not prefixes of each other.
   - What the mix DID cause, on a single crash: the reopen raised "changed-outside-before-rollback". The researcher saw the banner "A file in … was changed outside the app while a change the app had not finished was waiting to be undone. … the outside change to that file was not kept." That was false. The cause: the append changed the file after the "replaced" line's hash.
   - After the split this no longer happens (tested).
   - I built R503 a as ruled all the same. The ruled remedy is sound and it closes the real symptom. I did NOT write the requested "two crashes, the reopening refuses" test, because that state cannot be produced. The probe's results are above.
2. **A second caller did the same mix: the watched-folder register** (`watch-register.ts`, the same cut-then-append in one change). The refusal would have broken it, so it got the identical split (op `project.watched-folder.repair`).
   - Callers I checked: every `tx.appendLine` (the audit-reasons store in `mutate.ts`, `review.ts` review file, `watch-register.ts`, `queue-store.ts`); the change log and audit appends through `onPlan`; and every `tx.writeFile`/`tx.copyFile` in `packages/library/src`. Only the queue and the register rewrite a file they append to.
   - I ran the test files of both, and of their callers (list under Runs).
3. **Find lines written INSIDE another change** (`appendFindLinesInTx`) cannot run a separate change. Here is how each case is handled:
   - The three held-file actions call the mend before their own change.
   - Inside a source's deletion (`recordRemovedLine`), a torn queue no longer stops the removal. The entry's "record-removed" line is not written, and the torn line stays until the queue's next change cuts it. This follows that function's existing rule: "A queue that cannot be read never stops the source's removal (its line then stays)."
   - The researcher-visible effect: in that rare case (a torn queue AND a held file for the source being deleted), the entry keeps its earlier state instead of "no-open-copy / record-removed". The reviewer may want to judge this. The alternative is a mend before every top-level change that can delete a source.
4. **Mixes the ruling does not cover:** [append, trash, append] at one path is still allowed by the transaction. The undo also refuses this one as unverifiable on some contents (RE-1f listed [append, trash, append] k=0). No app change does it today.
5. Old markers left on disk by an earlier version, with the mixed shape, are still handled by the unchanged undo. The enumeration can no longer produce them through the API.

## Tests changed (not loosened, but changed)

- `rollback-rerun.test.ts`, the R493 enumeration. The 26 sequences that both append and write the file whole ([replace, append], [append, trash, create], …) can no longer be built: the transaction refuses them. They are now each asserted **refused**: the `MIXED_WRITE` error, the path as before the change, and no marker (`refusedCase`).
- `EXPECTED_CASES` therefore falls from 23/17/81/58 (179 cases) to 17/11/36/21 (85 cases), plus `EXPECTED_REFUSED` 2/2/12/10.
- Of the 14 cases that failed before R493's fix, these remain in the enumeration: [trash,create], [trash,append], [trash,create,trash], [trash,create,replace], [trash,append,trash], [trash,append,append] and [append,trash,append].
- No other existing test was changed.

## Researcher-visible sentences

- **New or changed:** none. Two new audit ops exist: `project.find.repair` and `project.watched-folder.repair`. They are not shown on any screen.
- **What a researcher already in the FR-738 state sees after this change:**
  - There is no such state for the queue (finding 1). A project already blocked by a marker of that shape (from the register, or the enumeration's contents) stays blocked: nothing here unblocks it, and the undo is not loosened.
  - What changes is that no NEW change of that shape can be started.
  - A researcher who had the false outside-change warning from an earlier crash keeps nothing from it: it was a warning only.
- **FR-737 (2), what the researcher gets now** (all existing sentences, for KG-1c / FR-736 to judge):
  - Banner (`StatusBanner.tsx:80`, kind `rolled-back-incomplete-write`): "An interrupted change in {project} was undone when the library opened, so nothing half-saved was kept." This is **untrue here**: FR-736 is the place to fix it.
  - The warning's detail (`repo.ts:549-550`): "a change interrupted before it was audited could only be partly rolled back; the marker is kept and recovery is retried on the next open (transaction …)".
  - Any write to the project: `RecoveryPendingError`, "Project {id} refuses changes: an earlier change could not be fully undone, or its audit log could not be repaired when the library was opened. Check the library's integrity warnings, then reopen the library". In Find and acquire: "This project is waiting for the library to be reopened before anything can be written." Reopening cannot help here.
  - The list of interrupted changes offers "Roll it back". Choosing it answers (`pending-writes.ts:158-160`): "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library."
  - Nothing says that the kept copy is gone. R503 b's "a warning says the original could not be put back because the copy the app kept is gone" is left to FR-736, as the brief says.

## For the next tasks on this branch (KG-1b FR-735/FR-723, KG-1c FR-736/FR-729)

- `undoEntries` now has `ownBytesAt` (hash of later created/replaced lines at the trashed path). FR-735's completion-hash lines for copied files should feed it, so that a copied file left at the path with its copy deleted is also recognised.
- `changedSinceMarker` was NOT extended to "at or under" a put-back trashed folder. A file inside a folder that was trashed, made again and put back could still be listed as changed outside if such a marker ever existed. It is unreachable today. minor (deferred).
- The register's and the queue's mend helpers are separate copies (`endsTorn`/`endsTornSync` in each file), as their existing torn-line code was.

## NEEDS A RULING

- None blocking. For the coordinator to confirm: finding 1 (FR-738's stated blocked state does not reproduce for the queue; built as ruled anyway), finding 2 (the register split, which the ruled refusal requires) and finding 3 (a torn queue no longer gets its "record-removed" line inside a source deletion).

## Only a real Mac or service can show

- Nothing specific to this batch. It is library code; no screen or route changed.

## Runs (each alone, `nice -n 10`, single files, `@ao/library`)

- `src/repo/rollback-rerun.test.ts`: 14 passed (14)
- `src/repo/rollback-own-writes.test.ts`: 14 passed (14)
- `src/repo/pending-writes.test.ts`: 22 passed (22)
- `src/find/queue-store.test.ts`: 81 passed (81)
- `src/find/runner.test.ts`: 300 passed (300)
- `src/find/runner.linked-missing.test.ts`: 23 passed (23)
- `src/repo/watch-register.test.ts`: 18 passed (18)
- `src/repo/review-held.test.ts`: 58 passed (58)
- `src/repo/review-held.linked.test.ts`: 6 passed (6)
- `src/import/watch.test.ts`: 143 passed (143)
- `src/repo/restore-sealed-purposes.test.ts`: 12 passed (12)
- `src/repo/key-lock-race.test.ts`: 11 passed (11). It failed once before the synchronous pre-check was added: a lock overtook the register write. Fixed and re-run.
- `src/repo/key-read-race.test.ts`: 32 passed (32)
- `src/repo/lock-mid-read.test.ts`: 42 passed, **2 failed**: `exportBibliography`/`citeSources`, "CslBundleMissingError: No citation styles are available (the CSL bundle is not set up)". This is the worktree's environment (`pnpm fetch-csl` was not run here) and is unrelated to this batch.
- `pnpm --filter @ao/library typecheck`: clean.
- One concurrency slip: two of my single-file runs overlapped once (the background run of key-lock-race / lock-mid-read with the next batch). Both files were re-run alone afterwards with the results above.
