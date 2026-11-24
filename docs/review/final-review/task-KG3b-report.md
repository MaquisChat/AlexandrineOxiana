# Batch KG-3b — report (FR-739, FR-733; R503 l, n)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-3b`, branch `kg-3b-locked-move`, 579bdcd..4216a0c. Four commits, not pushed. `git status --short` is empty.

## The items

| FR | Still present? | What changed (file:line) | Its test, and whether it failed first | Note |
|---|---|---|---|---|
| FR-739 (1) the picture route | Yes. The route opened the file and streamed it with no check per read. | `apps/library-service/src/media.ts:421`: the picture now goes through `guarded(…, readGuard(…))`. `guarded` moved from `routes/documents.ts` into `media.ts:367`, next to the stream it guards; `readGuard` (`media.ts:396`) holds the one check (same library open, project unlocked). `routes/documents.ts:140` now uses the same two functions, so there is one copy, not two; `guarded` is re-exported there for its existing test. | `media.test.ts` "FR-739 (1): a lock while a picture is being sent cuts it…" (a 12 MiB encrypted PNG on a real socket, paused after the first data, locked, resumed). It **failed first**: `expected 'end' to be 'aborted'`, because the whole picture arrived. | The brief asked for the picture's row in `packages/library/src/repo/lock-mid-read.test.ts`. That harness tests the library's readers, and the picture's reader there is `openAssetContent`, which already has its own row. The per-read guard is a service-level check, so no library row can show it. The failing-first row is therefore the service test above, modelled on the held file's mid-read test. Commit 0b49ec8. |
| FR-739 (3) a file under another project's key | Yes. `keyAtOpening` returned `undefined` for a foreign key id, which became `KeyNotAvailableError`, which the routes answer as 423 "locked". | `packages/library/src/asset-content.ts:123`: when the project is unlocked and the file's key id is not the project's, the opening throws `DecryptionError`. The routes already answer that as 409 with the existing sentence for an encrypted file that cannot be read. When locked, `projectDataKey` still throws `ProjectLockedError`, so the lock answers exactly as before. The comment at `:108-121` is corrected too: it no longer says a picture is sent to its end. | `asset-content.test.ts` "FR-739 (3)…" **failed first**: `expected KeyNotAvailableError … to be an instance of DecryptionError`. `media.test.ts` "FR-739 (3)…" covers the picture route and the media-ticket route; it **failed first** (`[423,…]` instead of `[409,…]`). I ran it against the old `asset-content.ts`, restored with `git checkout` and re-applied as a patch, not a stash. | The lock-mid-read harness runs unchanged and its `openAssetContent` and `openHeldFileContent` rows pass, so R492's rows hold. Commit 9f66057. |
| FR-739 (2) Close during a slow re-read | Yes: focus went to BODY. | `packages/ui/src/screens/import/ReviewQueue.tsx:1056`: closing a look while the queue is being read again (`itemsRef` null) sets `refocusAfterRead` to the looked-at card. When the read lands, focus goes to that card's heading, the queue's existing R313 e rule after a given-up decision. `:871`: the focus effect, when the card's "Look at the file" is not there, falls back to the card's heading, else the screen's heading. This is the same fallback every other target already uses. | `ReviewQueue.look.test.tsx` "FR-739 (2)…". The re-read is held back by a gate that `onTestFinished` releases. The test asserts `document.activeElement` is the h1 during the read, then the looked-at card's h4 once the read lands. It **failed first**: `expected <body> to be <h1 …>`. | The brief pointed to "R319's stand-in" as the place. There is no live control on a stand-in, and the whole found-files section is unmounted during a re-read, so the place the queue already uses is R313 e's rule (back to the card's heading after the read) plus the screen's heading in between. Commit e8b8c66. |
| FR-739 (4) the re-read finds the project locked | Yes: focus went to BODY, with or without a look open. | `ReviewQueue.tsx:478-483, :605-613`, and the `<div ref={unlockRef}>` around `UnlockProject`. A lock found after the queue was shown in this visit (any `forget()` once `readBefore` is true) moves focus to the unlock form's field when focus would otherwise be nowhere (on BODY). This is the place Find and acquire uses (R262 N5 a, R281 b). If focus is still on something that stays on screen (the heading, a link), it is left there. A locked project met when the screen opens is unchanged: nothing moves focus there. | Two tests in `ReviewQueue.look.test.tsx`: "FR-739 (4): the re-read finds the project locked while a look is open…" and "…the same without a look…". Both **failed first** with `expected <body> to be <input …>`. | Commit e8b8c66 holds points 2 and 4 together, because they touch the same lines of focus handling. |
| FR-733 a move refused at its own plan | Yes. `quiesce` stopped the transcription (`state.ts:1110`) before `executeMove` planned. | See the sequence below. `packages/library/src/move.ts`: a pure extraction of executeMove's first steps into `finishesSwitch` (`:513`) and `refuseUnaccepted` (`:524`); executeMove calls them at the same places, so its steps and their order are unchanged. Plus `acceptMovePlan` (`:564`, exported). `preflight`/`planWith` take an internal `checkPending` flag; `planMove` is unchanged. `apps/library-service/src/routes/libraries.ts:288-308`: the route calls `acceptMovePlan` before `quiesce`. On a refusal it answers as executeMove's refusals are answered (a line of the NDJSON stream, kept as the last failed move) and stops nothing. Test seam `afterMovePlan` (`server.ts`). | `transcription-jobs.test.ts`: "a move refused at its own plan… does not stop the transcription" **failed first** (`cancelled` was true). "an accepted plan stops the transcription before the first byte is copied (as before)" passed before and after, as intended. "a transcription that FINISHES between the plan and the stop…" **failed first**, because the seam did not exist and the run was cancelled. `move.test.ts` "acceptMovePlan (R503 l, FR-733)", 5 tests, **failed first** (the function did not exist). | Commit 4216a0c. 3e85e75 was not re-applied: no hook inside executeMove, its check for interrupted changes stays where it was, and the plain 409 of `quiesce` is still a plain 409. |

### FR-733: the move's sequence, before and after

**Before (579bdcd):**
1. `routes/libraries.ts:282`: `moving = true`.
2. `:285`: wait for changes already in flight.
3. `:291`: `state.quiesce(s)`. In `state.ts:1068-1130` it revokes tickets, stops the index rebuild and Zotero, drains other work, pauses batches, **stops the transcription (`:1110`) and drains it**, then stops the backup scheduler, watches, proxy/OCR queues and Find, and turns the disk cache off.
4. `:299`: the stream starts.
5. `:305`: `beforeExecuteMove` seam.
6. `:306`: `executeMove`. In `move.ts` it finishes an interrupted switch → `planMove` → progress "plan" → unknown / denied (audited) refusals → `readProjects` → `preflight` again → a fresh `walk` (the copy list) → copy → verify (another walk) → switch.
7. Reopen at the destination.

**After (4216a0c):**
1. `moving = true` (`:283`).
2. Wait for changes in flight (`:286`).
3. **`acceptMovePlan` (`:297`).** A refusal here stops nothing and answers as before (`:298-306`).
4. `afterMovePlan` seam (`:308`).
5. `quiesce`, unchanged (`:311`; the transcription is stopped at `state.ts:1110` as before).
6. The stream.
7. `beforeExecuteMove`.
8. `executeMove`, unchanged (`:326`; `move.ts:583-…`).
9. Reopen.

**What decides that it is correct.** Does the plan read anything that a running transcription could change between the plan and the stop?
- **Yes:** the write-ahead markers, because a change being written has its marker for a moment, and the file walk (count, sizes).
- **No:** what decides the refusals that matter here: the destination (empty, overlap), each project's governance and the residency decision, the projects' `project.json`, read-only mode.

So the smallest correct order is:
1. The pre-plan judges everything except interrupted changes.
2. Any failure that is not one of the move's own refusals is left to executeMove; an I/O race in the walk, for instance, must not refuse the move.
3. After the stop, executeMove takes its own plan again in full. That plan re-checks interrupted changes and re-walks the source.
4. The copy list is executeMove's own fresh walk after the stop, as before, so a transcription that finished in the window is copied (the third test shows it).

The pre-plan writes nothing, except the audit entry of a policy refusal. That entry is written once, by the same code executeMove uses (`refuseUnaccepted`), so a refused move is audited exactly as before (`move.test.ts`). A switch already decided (a crash during it) is accepted without a plan, as executeMove does.

**Differences a researcher or a client could notice:**
- A refused move now pauses no import, stops no watch and touches no queue. Before, all of that was paused and then restarted. This follows from planning before `quiesce`.
- The stream of a refused move no longer carries a `progress {phase:"plan"}` line before its error line. Nothing reads that line for a refusal: the screen reads the error, and the e2e "Move library" scenario passes.

A refusal for interrupted changes is still given after the stop, as before. Only that case still restarts the transcription.

## Sentences a researcher can see that are new or changed
- No new sentence.
- **Changed answer (FR-739 3):** a picture, recording or document sealed under another project's key, in an unlocked project, now gets the app's existing sentence for an unreadable encrypted file instead of "This project is locked. Its passphrase is needed." The sentence is "An encrypted file could not be read (damaged, or made with another key)." (409, `apps/library-service/src/errors.ts:155`).
- **Changed answer (FR-739 1):** a picture whose library is closed while it is being sent, before the first byte, now gets the document routes' existing "The library was closed while this file was being read." (409). Before, it got whatever the read failed with.

## NEEDS A RULING
None.

One judgement, open to the review: FR-739 (4) puts focus on the unlock field only when a lock is found after the queue was shown in this visit, and only when focus would otherwise be on the page. I left the screen's opening on a locked project unchanged, so that nothing new takes focus when the screen opens.

## What only a real Mac or a real service can show
- The picture cut-off on a real WebKit image load: does the app's picture element show a broken image or its error state when the stream is cut? The service side is proven here; the e2e run was Chromium only.
- The move with a real media worker and a real transcription. The tests use the stand-in worker.

## Runs (last summary line of each)
- `@ao/library-service` `src/media.test.ts`: **34 passed (34)**.
- `@ao/library-service` `src/documents-route.test.ts`: **24 passed (24)**.
- `@ao/library-service` `src/held-file-document.test.ts`: **10 passed (10)**.
- `@ao/library-service` `src/transcription-jobs.test.ts`: **28 passed (28)**.
- `@ao/library-service` `src/library-audit.test.ts`: **11 passed (11)**.
- `@ao/library-service` `src/open-library.test.ts`: **25 passed (25)**.
- `@ao/library-service` `src/server.test.ts`: **2 failed | 149 passed | 1 skipped (152)**. The 2 are "POST /cite…" and "R390 (c): POST /bibliography…", both failing with "The citation styles are not installed." That is the CSL bundle, which is not set up in this worktree; nothing to do with this batch.
- `@ao/library` `src/asset-content.test.ts`: **10 passed (10)**.
- `@ao/library` `src/asset-content-open.test.ts`: **3 passed (3)**.
- `@ao/library` `src/move.test.ts`: **75 passed (75)**.
- `@ao/library` `src/repo/lock-mid-read.test.ts` (run unchanged, 14m55s): every row passed except exportBibliography and citeSources. Those two fail with `CslBundleMissingError` at the unlocked reading, before any lock: the same missing CSL bundle, unrelated. The rows for `openAssetContent` and `openHeldFileContent` pass.
- `@ao/ui` `src/screens/import/ReviewQueue.look.test.tsx`: **15 passed (15)**.
- `@ao/ui` `src/screens/import/ReviewQueue.test.tsx`: **125 passed (125)**.
- `@ao/ui` `src/screens/import/ProjectReviewQueue.test.tsx`: **25 passed (25)**.
- Typechecks pass with no errors: `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`.
- `@ao/ui` `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours".
- `@ao/ui` build: "✓ built".
- e2e, Chromium (`--trace off`):
  - `maintenance.spec.ts` ("Move library"): **3 passed**.
  - `review-queue.spec.ts`: **11 passed**.
  - `import.spec.ts` (the picture route): **4 passed**.
  - `find-copies.spec.ts` (the found-file cards of the queue): **8 passed**.
  - The first e2e run's global setup built the worker's Python environment (`services/media-worker/.venv`, which git ignores).
