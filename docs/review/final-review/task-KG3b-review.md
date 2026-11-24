# KG-3b — adversarial review (FR-739, FR-733; R503 l, n)

Worktree `.claude/worktrees/kg-3b`, branch `kg-3b-locked-move`, 579bdcd..4216a0c (four commits). Reviewer changed no product code and made no commits. Each probe was deleted, the one scratch edit was restored with `git checkout`, and `git status --short` is empty at the end.

**Verdict: APPROVE WITH SMALL POINTS.** One Important finding (focus), three Minor. Nothing Critical. The move's other steps and their order are unchanged, and no writer runs during the copy that did not run before.

## What I ran (single files, `nice -n 15`)
- `@ao/library` `src/repo/lock-mid-read.test.ts`, unchanged: **44 passed (44)** in 883 s. The two bibliography rows (exportBibliography, citeSources) now pass too, because the citation styles are in the worktree.
- `@ao/library` `move.test.ts` **75/75**, `asset-content.test.ts` **10/10**, `asset-content-open.test.ts` **3/3**.
- `@ao/library-service` `media.test.ts` **34/34**, `transcription-jobs.test.ts` **28/28**, `held-file-document.test.ts` **10/10**.
- `@ao/ui` `ReviewQueue.look.test.tsx` **15/15**.
- e2e `maintenance.spec.ts` (Chromium, `--trace off`), run by me after the last commit (the interface was built at 05:51:28, after 4216a0c at 05:51:12): **3 passed**, "Move library" scenario 6 included.
- Probes:
  - `ReviewQueue.look.probeKG3b.test.tsx` (I1);
  - `move.probeKG3b.test.ts`: a timing run on 50,000 files, and a crash marker together with a policy refusal (M2, M3);
  - a scratch edit of `media.ts` that removes the picture guard (the FR-739 (1) test fails).

## Findings

### Important
**I1 — FR-739 (2): the second focus move takes focus from where the researcher has put it.** `packages/ui/src/screens/import/ReviewQueue.tsx:1056`, consumed at `:549-552`.
- Closing a look during a slow re-read sets `refocusAfterRead` unconditionally (`if (!list)`). When the read lands, `setFileFocus({to: back})` focuses the card's heading whatever has focus at that moment.
- Probe: the look is closed during the held re-read, and focus goes to the h1 (correct). The researcher then clicks a control elsewhere ("Elsewhere in the app", a button outside the screen). The read is released. Focus result: `H4 A Second Record`; the probe expected the button. The probe FAILS.
- The brief's rule is "never steal focus from where the researcher has put it". The existing R313 e path (`:947`) checks focus when it records the target. Neither path checks focus again when the read lands. The new path is the one that asks for the second move.
- The new test asserts only the case where focus stays on the h1, so no test covers this.
- Direction: when the read lands, move focus to the card's heading only if focus is still on the place it was put during the read (the h1) or on the body. Add a test in which focus is moved elsewhere in between.

### Minor
**M1 — FR-733: a move refused at the pre-plan restarts nothing that `state.moving` made skip during the plan** (`apps/library-service/src/routes/libraries.ts:297-306`). Judged by reading only.
- From `:283` on, `moving` is true. `attachWorker`, `resumeWorkerJobs`, `resumeProject`, `resumeFind`, `runScheduledBackups` and `retryWaitingWork` return early while it is (`state.ts:1567, 1580, 1610, 1492, 1764`; `tools.ts:90`).
- The old refusal (from inside `executeMove`) ran `state.activate(s)`, which attaches the worker again and resumes pending work. The new refusal path only clears `moving`.
- Effect: if the media worker becomes ready during the pre-plan (for example, a move asked right after launch), the pending worker jobs, viewing proxies and OCR are not resumed until the next open or unlock.
- The window is narrow, but the pre-plan walks the whole library (M3), so it can last seconds.
- Direction: after a refused pre-plan, re-run what `moving` made skip (attach the worker if it arrived meanwhile), or take `moving` only after the plan is accepted. The second is a larger change.

**M2 — FR-733: a library with a real interrupted change now answers a policy refusal, audited, where it answered "pending-writes".**
- `acceptMovePlan` leaves out the whole interrupted-change check (`move.ts:323`, `checkPending=false`), including `recoveryPendingProjects(repo)`. That check reads the repo's in-memory state, which a running transcription does not change.
- Probe, with a crash marker in `.tmp` and a HIPAA project moved to OneDrive:
  - old order (`executeMove`): `pending-writes`, 0 audit entries;
  - new pre-plan: `policy-denied`, 1 audit entry (a true refusal, so nothing is false).
- A different reason is shown. A project that is recovery-pending gets an attention mark instead of an audit entry (`recordOrMark` → `RecoveryPendingError`). Neither is wrong, but neither is the old answer, and the report does not say so.
- Direction: keep the repo's recovery-pending check in the pre-plan, and leave out only the marker files.

**M3 — FR-733: the plan is taken twice.**
- Probe: 50,018 files on local disk. `acceptMovePlan` takes 1.1–2.3 s and `planMove` 1.8–1.9 s. A move now walks the source four times (pre-plan, plan, the copy list, verify) where it walked three.
- During the extra walk the transcription and other work keep running, as intended.
- This is acceptable next to the copy, but it lengthens the M1 window and the report does not mention it. It will be slower on a network or cloud disk.
- Direction: say it in the notes. No change needed.

## FR-733 — the whole move, before and after (checked against the code)
**Before:**
1. `state.moving = true` (`libraries.ts:283`): from here new changes are refused 503 and background starts are gated.
2. Wait for changes in flight.
3. `state.quiesce` (`state.ts:1071-1137`): revoke tickets; stop the index rebuild and Zotero; drain background work except the transcription; suspend batches; **interrupt and drain the transcription (`:1110`)**; stop the backup scheduler, watches, proxy/OCR queues and Find; turn the disk cache off.
4. The stream starts, then `executeMove`: finish an interrupted switch, or plan (`planMove`: `preflight` with markers, locate, readProjects, governance, walk) → "plan" progress → `refuseUnaccepted` (refusals audited) → `readProjects` → `preflight` → a fresh walk → copy → verify → switch.

**After:** the same, with `acceptMovePlan` (`:297`) and the `afterMovePlan` seam inserted between step 2 and step 3.
- The diff of `executeMove` was read line by line. It is a pure extraction. `finishesSwitch` keeps the same condition. `refuseUnaccepted` is the old block verbatim, and `executeMove` calls both at the same points. Its steps and their order are unchanged.
- `acceptMovePlan` is NOT a copy: it calls the same `planWith`, `finishesSwitch` and `refuseUnaccepted`, so the two cannot drift apart. It differs only in `checkPending` (see M2) and in swallowing errors that are not move refusals.
- Writers: no write queue is held. What stops writers is the `moving` flag (refuses requests, gates background starts) and `quiesce` (stops running work). Both are still taken before `executeMove`'s plan and copy, so **no writer runs during the copy that did not before.**
- In the window between the plans, running work goes on: a transcription, captures, rechecks, an import batch, a Zotero sync already running, Find, the proxy/OCR queues and the watches, exactly as during the old window before `quiesce`.
- The copy list is `executeMove`'s own walk after the stop. The third service test shows that a transcription finishing in the window is stored once and moved: 2 versions in the moved library, 1 run, not cancelled.
- Accepted, then refused by the second plan: the transcription has been stopped, and the old catch path runs `activate`, `resumeBatches` and `restartStoppedWork`. The existing FR-385 test shows the run starts again and is stored once.
- Two moves at once: `moving` is set synchronously before the first await, and the preHandler answers 409. Unchanged.
- Route answers: no existing test assertion was changed (the diff only adds tests). A refused plan is still a 200 stream with an error line, kept as the last failed move. Its only difference is that the stream carries no `progress {phase:"plan"}` line, which the report states.
- A crash between the plans: the pre-plan writes nothing but a refusal's audit entry, through the repo's serial queue.

## FR-739
- **(1) Picture route.** `guarded` and `readGuard` now live once in `media.ts:367/396`. `documents.ts` imports and re-exports them, so there is one code path, not a copy.
  - Guard removed by a scratch edit: the FR-739 (1) test fails (`expected 'end' to be 'aborted'`). Restored.
  - The implementer's reason for no harness row is right: the harness tests library readers, and `openAssetContent` already has its row there. The per-read check is a service check.
  - Every route that sends an encrypted project's bytes: `sendContent` has only three callers (pictures, now guarded; documents and held files, guarded; `/media/:ticket`, cut by revoking the ticket at a lock, plus the before-first-byte check).
  - There are no preview or thumbnail routes.
  - The transcript routes return one JSON body read whole, so there is no stream to cut.
  - Exports write to disk.
  - Nothing beyond what R496 accepted.
- **(3) A file under another project's key.** `keyAtOpening` calls `projectDataKey` first. A locked or locking project throws `ProjectLockedError` before the key id is compared, so a lock still answers 423 and says nothing about the file.
  - The 409 is given only to an unlocked project. It reveals nothing a lock must hide.
  - The sentence is the existing one in `errors.ts:155`, word for word: "An encrypted file could not be read (damaged, or made with another key)."
  - Callers checked: `documents.ts` `openFailure` (falls through to the 409), media `readFailure`, and the ticket serve. In the ticket serve the error marks the ticket "changed", which is acceptable: a foreign file put in place is a change made outside the app.
  - `find.ts` and `your-library.ts` do not open these readers.
  - R492's tests and the harness pass unchanged.
- **(4) A lock found during the visit.** Focus goes to the unlock field only when it is on BODY, and the screen's opening on a locked project is unchanged. That choice is sound: it matches Find and acquire and takes nothing from a researcher whose focus is still placed.
  - A screen reader lands on "Passphrase or recovery code, secure edit", inside the region named "<project> is locked".
  - R319's stand-in and R303 b's Tab order: lines untouched, and the existing tests pass.
- **(2)** See I1.

## Table
| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-739 (1) | the picture is cut by a lock, by the same code | holds | the test fails without the guard (scratch edit) |
| FR-739 (2) | focus goes to the h1, then the card's heading | partly | I1: the second move takes focus the researcher moved |
| FR-739 (3) | a foreign key gives 409 with the existing sentence; a lock still gives 423 | holds | harness 44/44; R492's tests pass |
| FR-739 (4) | the unlock field, only when focus is on the page | holds | judgement accepted |
| FR-733 | the plan is accepted before the stop; executeMove unchanged | holds, with M1–M3 | no new writer during the copy; e2e passes |

## Judged by reading only
- M1: the worker becoming ready during the pre-plan. There is no seam to hold the pre-plan open.
- That nothing beyond the three `sendContent` callers sends stored bytes.
- The screen-reader announcement.
