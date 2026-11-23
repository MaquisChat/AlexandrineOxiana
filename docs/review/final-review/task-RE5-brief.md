# Rough-edges round — batch RE-5: The service: pairing, the capture queue, transcription runs; the extension's wording

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-5-service`, branch `re-5-service`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-5-service &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE5-report.md`.

## Your items (14 list numbers in 9 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-244 (UI — screens): Pairing screen wording differs from the extension's. - size S
- FR-329 (Service): During a library move the device-only routes are refused with the move's wording. - size S
- FR-335 (Service): A pairing code's `confirming` has no time limit; the page's countdown then calls it expired. - size S
- FR-337, FR-338 (Service): Pairing: an unreadable list is reported as 'not in the list'; revoking any browser clears that warning even when the paired one is still missing. - size S
- FR-342 (Docs): Owner checklist 10.6: the popup's message can run on after 'Captured: saved to your library.' - size S
- FR-370, FR-371 (Service): Addresses a lock cut from a capture queue are listed only on the open screen; nothing reminds after unlock (typed lists can be lost from view). - size M
- FR-385, FR-386, FR-392 (Service): Transcription runs: a move does not carry a running transcription on; Stop on a run waiting for an unlock; a run spanning a lock and unlock waits for the next unlock or launch. - size M
- FR-393 (Service): After a lock at the store step, the first try's file remains as an extra version beside the rerun's. - size S
- FR-584, FR-588 (Find and acquire — browser extension): Extension wording: 'does not let the extension read this tab' also for a closed tab or slow injection; 'did not give the PDF a second time' also for a PDF whose mark is not at byte 0. - size S

## For this batch
- FR-342 is about a document for the owner (`docs/review/final-review-for-the-owner.md` holds the Mac checklist now; the older checklist files are under `docs/`): find the line the entry means and mend the wording there, or say that it no longer exists.
- FR-385, FR-386, FR-392: transcription runs across a move, a lock and an unlock. If carrying a running transcription across a library move is more than a few hours, make the smaller truthful thing (the run ends with a sentence that says it was stopped by the move and can be started again) and describe the larger one (NEEDS A RULING).
- FR-584, FR-588 are in `apps/browser-extension`: its unit tests are `pnpm --filter @ao/browser-extension test`.
