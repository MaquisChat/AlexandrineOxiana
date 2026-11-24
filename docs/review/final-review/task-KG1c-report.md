# Batch KG-1c: report (FR-736, FR-729; R503 d, e; R509; R519; R525)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from b72caae. Not pushed.
No permission check refused anything. `git stash` was never used.

Commits (one per point):
- `532a2a8` R525 (2): the kind `changed-outside-before-rollback` removed.
- `fd264d1` FR-736: every sentence true of the state; the list names what is in the way.
- `15a0165` R509: "Close this change as it is".
- `1804b9c` FR-729: recovery's warnings kept until dismissed. **Head 1804b9c**; `git status --short` empty.

## 1. Inventory: every state of an interrupted change after KG-1b, and what was said (before → now)

Places: **Banner** (`StatusBanner`), **List** (the "Interrupted changes" dialog opened by "Resolve…"), **Roll it back** (its answer), **Write** (a write refused: service sentence; Find and acquire; an import's stop note), **CLI** (`ao` prints `Warning: <project>: <library detail>` and the library's own error message).

| State | Place | Before (word for word) | True there? | Now |
|---|---|---|---|---|
| A. Undone completely at the opening | Banner | "An interrupted change in {project} was undone when the library opened, so nothing half-saved was kept." | yes | unchanged; now kept until dismissed (FR-729), with "Dismiss" |
| A | CLI | "a change interrupted before it was audited was rolled back (transaction …)" | yes | unchanged at the opening; at a later opening (kept): "a change interrupted before it was audited was rolled back when the library was opened" |
| B. Incomplete, a step failed / file could not be read (`could-not-look`) — may pass | Banner | the sentence of A ("was undone … nothing half-saved was kept") | **no** | `try-again` sentence (§2) + "Resolve…" (before: NO "Resolve…" was offered at all for this kind) |
| B | List | nothing about what failed | unhelpful | `could-not-look`: its cause sentence with the path; a step failed: none (the answer says it) |
| B | Roll it back | "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library." — but the screen showed instead "That choice is no longer possible for this change: something changed in the meantime (it may have been resolved elsewhere). The list now shows what can be done." (every 409 CONFLICT was shown so) | the library's yes; **the screen's no** | the library's sentence, unchanged, now shown as it is (marked `reason: "rollback-incomplete"`) |
| C. Incomplete, something in the way the researcher can remove: `hand-changed-file` (a created OR rewritten file changed by hand), `path-occupied` | Banner | sentence of A | **no** | `in-the-way` sentence + "Resolve…" |
| C | List | nothing | unhelpful | the cause sentence with the library-relative path (UserText) |
| C | Roll it back | "…a step failed. … try again, or reopen the library." | **no** (no step failed; reopening cannot help) | `in-the-way` answer |
| D. Incomplete and NEVER completable: `kept-copy-gone` | Banner | sentence of A | **no** | `lost` sentence + "Resolve…" |
| D | List | nothing | unhelpful | the cause sentence with the path, "You can close this change as it is.", and the button "Close this change as it is" (R509) |
| D | Roll it back | "…a step failed. … try again, or reopen the library." | **no** | `lost` answer |
| B/C/D, a choice to roll back recorded earlier that still fails at the next opening (kind `incomplete-write-pending`) | Banner | "An interrupted change in {project} could not be finished or undone yet. It is tried again when the library is next opened with write access." | no for C, D | the state's sentence (the warning now carries the state) |
| B/C/D | Write (service) | "This project refuses changes until an interrupted change is resolved; see the library's integrity warnings." | roughly | shared `RECOVERY_PENDING_TEXT` (§2) |
| B/C/D | Write (Find and acquire) | "This project is waiting for the library to be reopened before anything can be written." | **no** | `RECOVERY_PENDING_TEXT` (same sentence as the service) |
| B/C/D | Write (import stop note) | "The import stopped because an earlier change in this project could not be undone. Close and reopen the library, then resume the import." | no for C, D | §2 |
| B/C/D | Write (CLI, library error) | "Project {id} refuses changes: an earlier change could not be fully undone, or its audit log could not be repaired when the library was opened. Check the library's integrity warnings, then reopen the library" | no for C, D | §2 |
| B/C/D | Write (protocol documents) | "The project refuses changes until an interrupted change is resolved; nothing of this file was kept." | yes | unchanged |
| B/C/D | Banner `source-change-unfinished` (a named source read) | "A change to a source in {p} did not finish and could not be undone. Close the library and open it again to put it back." (+ plural) | no for C, D | §2; now also offers "Resolve…" |
| B/C/D | CLI detail of that warning (`SOURCE_CHANGE_UNFINISHED`) | "A change to this source did not finish and could not be undone. Close the library and open it again to put it back." | no for C, D | §2 |
| B/C/D | CLI detail of the incomplete undo | "a change interrupted before it was audited could only be partly rolled back; the marker is kept and recovery is retried on the next open (transaction …)" | no for C, D (a retry cannot help) | by state (§2); B keeps it |
| In-process: a change's own undo fails in the running app | Banner | **nothing at all** (writes refused, "see the integrity warnings" pointed at no warning) | — | the warning is raised at once with its state (B/C/D sentence, "Resolve…") |
| E. Old mixed-shape marker refused every time by the end-of-file check (15 of KG-1a-fix's 94 cases), status `unverifiable` | Banner | "An interrupted change in {project} was left as it is, because its audit log could not be checked first. It is tried again on the next open." | **no** (retrying never helps) | **unchanged — NEEDS A RULING 1** |
| E | List | "The app cannot confirm whether this change was finished: …" + "The way forward is to restore the project from a backup made before this change." (no choice) | yes | unchanged — NEEDS A RULING 1 |
| any, read-only library | Banner | "An interrupted change in {p} could not be finished or undone yet. It is tried again when the library is next opened with write access." / "…It can be put back only when the library is opened for changes." | yes (the state is not known read-only: no undo is run) | unchanged |

## 2. Researcher-visible sentences, new or changed — FOR THE REVIEW (word for word)

All shared ones live once in `packages/shared/src/api/interrupted-changes.ts`. {p} = project name (always through `UserText`); {f} = library-relative path, shown ONLY in the list, through `UserText`.

**Banner, incomplete undo, by state** (`INCOMPLETE_ROLLBACK_BANNER`; kinds `rolled-back-incomplete-write` and `incomplete-write-pending` with a state):
1. try-again: "An interrupted change in {p} could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to {p} are off until it is undone. Choose “Resolve…” to try again."
2. in-the-way: "An interrupted change in {p} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to {p} are off until it is undone. Choose “Resolve…” to see which file to move."
3. lost: "An interrupted change in {p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to {p} are off until you close the change. Choose “Resolve…” to see what was lost."

**List, per cause** (`ROLLBACK_CAUSE_TEXT`):
4. hand-changed-file: "{f} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (your version is kept there), then choose “Roll it back”."
5. path-occupied: "A file this change removed cannot be put back at {f}, because another file is there now. Move that file somewhere outside the library, then choose “Roll it back” to put the removed file back."
6. kept-copy-gone: "The file this change removed from {f} cannot be put back: the copy the app kept of it is gone, so it is lost."
7. could-not-look: "The app could not read {f}, so it left it as it is. Make sure the file can be read, then choose “Roll it back”."
8. (beside 6 when closing is offered) "You can close this change as it is."

**"Roll it back" answers** (`ROLLBACK_INCOMPLETE_ANSWER`):
9. try-again (unchanged words, now shown): "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library."
10. in-the-way: "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again."
11. lost: "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back."

**A write refused** (`RECOVERY_PENDING_TEXT`, the service's 409 and Find and acquire's "recovery-pending"):
12. "This project takes no changes until a problem found when the library was opened is resolved. The warning at the top of the library says what to do."
13. Import stop note (`RECOVERY_NOTE`; it must end ", then resume the import." for the batch to drop it on resume): "The import stopped because an earlier change in this project could not be undone. Do what the warning at the top of the library says, then resume the import."
14. CLI / library error (`RecoveryPendingError`): "Project {id} refuses changes until an interrupted change is resolved or its audit log is repaired. The library's integrity warnings say which, and what to do."

**A source whose change did not finish:**
15. Banner: "A change to a source in {p} did not finish and could not be undone yet. Choose “Resolve…” to see what can be done." / "Changes to {n} sources in {p} did not finish and could not be undone yet. Choose “Resolve…” to see what can be done."
16. Its detail (CLI; `SOURCE_CHANGE_UNFINISHED`): "A change to this source did not finish and could not be undone yet. The app's list of interrupted changes says what can be done."

**CLI details of an incomplete undo at the opening** (library `INCOMPLETE_DETAIL`; try-again keeps the old text):
17. in-the-way: "a change interrupted before it was audited could only be partly rolled back, because a file changed or put there outside the app is in the way; the marker is kept, and the roll-back completes once that file is moved away (the app's list of interrupted changes names it)"
18. lost: "a change interrupted before it was audited could only be partly rolled back: the copy the app kept of a file it removed is gone, so that file cannot be put back; the marker is kept until the change is closed in the app's list of interrupted changes"
19. in-process failure: "a change that failed could only be partly rolled back; the marker is kept and recovery is retried on the next open (transaction …)"

**Closing (R509)** — list dialog:
20. Button: "Close this change as it is"
21. Question (takes the focus): "Close this change as it is?" then per lost file "What it removed from {f} cannot be put back." [+ "It belonged to the source {title}." where the title can be read] + one of "Nothing is at that place now." / "A file is at that place now; it stays as it is." / "Something else is at that place now; it stays as it is." then "Closing deletes nothing. The project takes changes again, and a warning about what was lost stays until you dismiss it."
22. Buttons: "Yes, close it as it is" / "Cancel"; busy: "Closing the change…"
23. After closing (role=status): "The change was closed as it is. Nothing was deleted, and the project takes changes again."
24. Library's refusal for a cause that may pass or can be removed: "Only a change that can never be undone completely can be closed as it is; this one can still be rolled back."
25. Library's refusal while the app still keeps a copy of the change: "This change cannot be closed yet: the app still keeps a copy of a file it could not put back, and closing would let that copy go. Choose “Roll it back” to try again."
26. The dialog's intro, last sentence changed: "A change is never kept half-written, unless it can never be undone completely and you close it as it is." (was "A change is never kept half-written.")
27. Banner after closing (kept until dismissed; kind `interrupted-change-closed`): "An interrupted change in {p} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone: that file is lost. The closing is recorded in the audit log of {p}."
28. CLI detail of 27: "an interrupted change was closed as it was; a file it had removed could not be put back"

**FR-729:**
29. Banner button on a kept warning: "Dismiss" (accessible name "Dismiss this warning about {p}"); its failure falls back to "The warning could not be dismissed."
30. Damaged record, banner (kind `recovery-warnings-set-aside`, new): "The library's record of earlier warnings about interrupted changes could not be read, so some of those warnings may not be shown again. The damaged record is kept in the library's work folder." (true read-only too). Its CLI detail: "the record of earlier warnings about interrupted changes could not be read; it was set aside in the library's work folder and a new record was started" (read-only: "…; it is left as it is (the library is open read-only)").

Removed (R525): "A file in {project} was changed outside the app while a change the app had not finished was waiting to be undone. When the library opened, the app undid its unfinished change, and the outside change to that file was not kept."

## 3. Table per item

| FR | still present? | what changed | its test, failed first? | note |
|---|---|---|---|---|
| R525 (2) | yes | `audit-store.ts` kind removed; `StatusBanner.tsx` sentence removed; expectations removed in 8 test files | n/a (removal); typecheck and the touched files pass | **`rollback-rerun.test.ts` was touched**: two lines that named the removed kind (an assertion `.not.toContain(...)` and a `failures.push` guard) — removing the kind from the type makes them type errors. Nothing else in that file changed. |
| FR-736 | yes (all of §1) | shared `interrupted-changes.ts`; `txn.ts` `UndoResult.stepFailed`, `RecoveryResult.stepFailed`; `state.ts` `rollbackAttempts`; `repo.ts` the warning's `rollback` state + `INCOMPLETE_DETAIL`; `pending-writes.ts` list `rollback`/`causes`, answers by state; `mutate.ts` in-process warning; `errors.ts`; `space.ts`; service `errors.ts` (shared sentence, `reason: "rollback-incomplete"`), `state.ts` (`state` on warnings, no paths), `routes/libraries.ts` (list `rollback`, `causes` with paths); UI `StatusBanner.tsx`, `PendingWritesDialog.tsx`, `api/library.ts` | `rollback-words.test.ts` (new, 9; **8 failed first**); `StatusBanner.test.tsx` (11 failed first); `PendingWritesDialog.test.tsx` (5 failed first); service `server.test.ts` "FR-736" (written after the code; passes) | changed tests that asserted the gap: `StatusBanner.test.tsx` (ONE/SEVERAL, `SOURCE_CHANGE_UNFINISHED`), `sources-read-race.test.ts` (`UNFINISHED`), `disk-full.test.ts` (`REFUSING`) |
| FR-736 / R509 close | n/a (new act) | core `engine.ts` action `close-change` (allowed in every profile); `txn.ts` `ResolveRecord.close` (+ reader check); `pending-writes.ts` `closePendingWrite`, `canClose`, `lost`, `decideClose`, `keptCopiesLeft`; `repo.ts` `Repo.closePendingWrite`; route `POST /libraries/pending-writes/:txn/close` (body `projectId`); list gets `canClose`, `lost` (path, what is there now, source title where readable); UI button, inline confirmation, Escape, busy, failure, sentence after; banner sentence 27 | `engine.test.ts` (4 failed first); `pending-writes-close.test.ts` (new, 8; **8 failed first**); `PendingWritesDialog.test.tsx` R509 block (4 failed first); `StatusBanner.test.tsx` (1 failed first); service "R509" (failed first: no `canClose`) | see "How closing works" |
| FR-729 | yes (in memory only) | `kept-warnings.ts` (new); `repo.ts` calls it at writable and read-only openings; `Repo.dismissRecoveryWarning`; `IntegrityWarning.keptId`; close keeps its warning; service `keptId` on warnings + `POST /libraries/recovery-warnings/:id/dismiss`; UI "Dismiss" (not in a read-only library) | `kept-warnings.test.ts` (new, 7; written right after the module; **all 7 fail with the two calls in `repo.ts` taken out**, checked by a scratch edit restored at once); UI and service tests written after the code | changed tests that asserted in-memory-only: `repo.test.ts` (3: `keptId` on the warning, two kept warnings at the third opening, `.tmp` holds only `recovery-warnings.json`), `annotations.test.ts` (1: each opening's warning still said at the next) |

## How closing works (R509) — for the review
- Offered only when the change is `uncommitted`, no keep is recorded, and its LATEST undo attempt (at this opening, a recorded choice retried at the opening, "Roll it back", or the change's own undo in this process — kept in memory by transaction) was incomplete only with `kept-copy-gone` causes and no unnamed failed step. Not for `hand-changed-file`, `path-occupied`, `could-not-look` or a failed step. Not in a read-only library (and the library refuses with `ReadOnlyLibraryError`).
- Order: the project named by the screen must be the marker's (else 404) → policy (`close-change`, against `governance.yaml` as written; unreadable or unparseable → deny, fail closed; a deny is recorded in the **library's** audit log, because an entry in the project's log after the change's start would make the change's own undo unverifiable; nothing else written) → the choice recorded in the marker first as `{choice: "roll-back", close: true}` (build 10's reader ignores `close` and reads a roll-back; it refuses an unknown choice) → the undo run once more → still `lost` (else refused with the state's answer) → no copy of the change still kept (else refused, sentence 25) → `txn.resolve` appended to the project's log with `decision: allow`, `choice: "close"`, `notPutBack: [paths]` → marker removed → the same settling as "Roll it back" (warnings settled, writes resume unless something else holds the project, the anchor as R131 d) → the "closed" warning, kept until dismissed.
- Nothing is deleted: the change's own file (or nothing, or a hand file) stays at the path; tested by a snapshot of every file of the library before and after.
- A crash after the marker's record and before the audit entry: the next opening retries it as a roll-back (incomplete, `lost`), and the list offers to close it again. A crash after the audit entry: the next opening removes the marker (R131 c), but the "closed" warning is not raised (the audit log holds the closing). minor (deferred).
- A locked encrypted project: the list route needs only an open library, so it is reachable while the project is locked; the close evaluates only `governance.yaml` and appends to the project's audit log as "Roll it back" does, so it works while locked (as "Roll it back" does today). The source's title is left out of the confirmation while locked (it cannot be read).

## FR-729 — what was built and why
- Read first: integrity warnings had NO dismissal; "comes back" (R473/R484) meant re-raised at each opening while its cause stands. Kept now: the two EVENT warnings of recovery — a change undone completely at the opening, and a change closed as it was. Not kept in the file: the incomplete undo (it is a standing state, raised again at every writable opening from the marker and shown in the list; a stored copy would go stale and untrue once resolved). The outside-change warning no longer exists (R525).
- File `<Library>/.tmp/recovery-warnings.json` beside the markers, written whole and atomically (`writeSmallFileAtomic`, 0600): `{ formatVersion: 1, warnings: [{ id, kind, projectId, at }] }` — a project's id only: no name, title or path, so a locked project's warning holds nothing a lock hides; its name is shown as every warning's is today (from the project as listed; a project's name is not sealed).
- Damaged or unreadable: never stops the opening; writable: set aside as `recovery-warnings.damaged-<time>-<random>.json` in `.tmp/` (the anchors file's pattern, with a name that cannot collide) and one warning; read-only: left as it is, the same warning.
- Read-only library: shows the kept warnings, writes nothing, offers no "Dismiss" (the screen disables changes in a read-only library elsewhere too); the library refuses a dismissal there.
- A moved library DROPS them: a move copies no part of `.tmp/` (the move is allowed only with no interrupted change; the old place keeps its record). A restored project does not carry them (backups are of projects; the record is the library's). See NEEDS A RULING 2.
- An older build: its sweep of `.tmp/` removes only `capture-`, `worker-`, `batch-`, `find-` folders, `trash-*` when no marker is left, and orphan `txn-*.orig-N` backups (read at `main`); the file is none of these. The move's marker count matches `^txn-.*\.json$` only. The integrity check reads only the files the library records: tested quiet.

## NEEDS A RULING
1. **Closing an old mixed-shape marker (state E).** The brief's inventory calls the 15 old-shape cases "never completable, and closable"; I did NOT build it. Those markers are `unverifiable` (R131 a: no choice is offered, "acting on offsets the audit record cannot back would destroy committed history"), nothing of them has been undone, and the same status covers markers whose change may in fact have been FINISHED (an anchor past the change's start; a prefix that does not verify). Closing one would keep a half-written change as it stands. Options: (a) offer the close only where the sole problem is the end-of-file check (`offsetProblem`) of an old-shape marker, with a confirmation that says the change is left exactly as it stands and may be half-written; (b) keep "restore from a backup" as the only way. Recommendation (a), confirmation words: "Close this change as it is? The app cannot undo it safely, so it stays exactly as it was left, and may be half-written. Closing deletes nothing, and the project takes changes again." Its banner today says "It is tried again on the next open." (untrue for these) — proposed: "An interrupted change in {p} was left as it is, because its audit log could not be checked first. Choose “Resolve…” to see what can be done."
2. **A moved library drops the kept warnings** (above). If they should travel, the move must copy `.tmp/recovery-warnings.json` — a change to the move path (R466), not made here.

## minor (deferred)
- The move's refusal while a marker exists still says "Some changes are still being written. Try the move again in a moment." — untrue while an undo is incomplete.
- A change that removed both a folder and a file inside it, whose folder's kept copy is gone, leaves the inner file's copy kept: closing is then refused (sentence 25), so such a project stays blocked; rare, no app change is known to do it.
- One-time warnings of the opening outside this round's list (`trimmed-incomplete-audit-line`, `audit-recorded-late`) are still in memory only.
- The read-only banner of a pending change cannot say its state (no undo runs read-only).

## What only a real Mac or a real service can show
- APFS keeping the identity on which `kept-copy-gone` rests (KG-1b's point).
- A permission-denied read at undo (`could-not-look`), tested through the seam.
- How the new banners and the inline close confirmation read in WebKit; no end-to-end spec drives them.

## Runs (each alone, `nice -n 10`, single files)
`@ao/library`: rollback-words 9/9 · pending-writes-close 8/8 · kept-warnings 7/7 · pending-writes 22/22 · rollback-hand-put 22/22 · rollback-own-writes 14/14 · **rollback-rerun 19/19 (once, at the head)** · repo 61/61 · annotations 42/42 · recovery-code 27/27 · sources-read-race 13/13 · watch-register 30/30 · anchor-missing 3/3 · attention 34/34 · library-audit 9/9 · source-record 5/5 · sources-confirm-bound 6/6 · workspace-tags 10/10 · seams-inert 3/3 · fieldwork 31/31 · txn-completion 9/9 · key-lock-race 11/11 · move 70/70 · disk-full 14/14 · find/runner 300/300 · find/queue-store 81/81 · export/backup 23/23 · restore-governed 63/63 · zotero-local 85/85 · reconnect 45/45 · lock-mid-read 44/44 · retention 23/23.
`@ao/core`: governance/engine 144/144. `@ao/library-service`: server.test.ts 155 passed, 1 skipped (156). `@ao/ui`: StatusBanner 63/63 · PendingWritesDialog 20/20 · dialogs.r145 42/42 · screens/Library 46/46. `@ao/cli`: cli.test 40/40.
Typechecks clean: shared, core, library, library-service, ui, cli. `lint:css` clean; `lint:colours` "ok: no hard-coded colours". `@ao/ui build`: built.
**End to end: no spec opens a library with an interrupted change** (`grep -ln "interrupted\|did not finish" e2e/*.spec.ts` finds only first-use.spec.ts, where "interrupted" is about typing; no spec names the pending-writes routes, "Resolve…" or "Roll it back"), so none was run.
