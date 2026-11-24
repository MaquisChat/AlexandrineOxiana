# Rough-edges round — batch RE-4b: the review's points on RE-4 (Rulings R462 a, R467)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over from the implementer of batch RE-4, who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-4-dialogs-player`, branch `re-4-dialogs-player`, at d04061f = batch RE-4 as built and reviewed (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-4-dialogs-player &&`. Do not push.

## Read
1. **Rulings R467 and R462, every clause:** `grep -n -E "Ruling R467|Ruling R462" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-8000`.
2. **The review, in full** — it has the evidence, the probes and file:line for every point (I1, I2, M1–M10): `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE4-review.md`. The reviewer's probes are your first tests.
3. The first implementer's report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE4-report.md`.
4. The code the review names: `packages/ui/src/components/MediaTicketPlayer.tsx`, `packages/ui/src/dialogs.r145.test.tsx` (the table), `apps/library-service/src/media.ts`, `packages/shared/src/api/media.ts`, `packages/ui/src/api/client.ts`, `packages/ui/src/screens/ToolsSetup.tsx`, `services/media-worker/ao_worker/transcribe.py`, `packages/ui/src/components/CitePanel.tsx` (or wherever the citation style list is).

## The points (each: a test first, seen to fail; the smallest change; one commit)
- **I1 (FR-260) — an expired ticket is told from the TICKET, not from the last press.** Use the ticket's own age against the lifetime the service gives (read what the ticket's answer carries and the shared constant; do not invent a second clock). In the usual order — a long pause, then Play or a seek, then the failure — the player renews the ticket without counting a failure and never says "may be damaged"; a ticket that fails while young still counts, so it cannot renew for ever. The reviewer's probe of that order is the test; keep the first implementer's tests passing.
- **I2 (FR-234/601) — the dialogs opened from the screens that use them.** Extend the table (or add a second one) so that each dialog and popover is opened FROM ITS REAL SCREEN by the control a researcher uses — the reviewer lists about fourteen places the first table missed (MoveLibrary, GovernanceSettings, ExtensionPairing, Fieldwork, AppearanceSettings, FindAcquire…): find them all yourself too (`grep -rn "DialogShell\|ReasonDialog\|ConfirmDialog\|role=\"dialog\"\|role=\"alertdialog\"" packages/ui/src --include=*.tsx | grep -v test`). For each: focus on open, Tab and Shift+Tab stay inside, Escape (where allowed) and the close control give focus back to the opener — or, when the opener is gone after the act (a row that was deleted, a button that disappears), to a NAMED sensible place (the screen's or the section's heading), never the page body. Mend every fault the table shows, beginning with the reviewer's: after "Delete old copy" is confirmed on the Move library screen, focus falls to the body. List every dialog and popover with its screen and result in your report. Task FR-A9's rule stays (a dialog is never confirmed by the key that opened it: R376 c).
- **M1** a change in the file's HEADER is marked like a change in its body; the player has ONE sentence for a changed file — the ruled one (R462 a): "The recording stopped: its file is no longer as the app stored it — it was changed outside the app, or it is damaged — so it cannot be played from here. Check the verification report."
- **M2** the mark outlives the ticket's idle sweep long enough for the player to read it once (bounded in time and in number; nothing of the file or its path in it).
- **M3** a recording whose raw data the APP destroyed while it plays is not "changed outside the app": the service's code tells the two apart, and the player says what the app says elsewhere of a destroyed file (find that sentence; do not write a new one unless there is none). Prove it with a test that destroys the raw data mid-stream.
- **M4** the revoke the player waits on is bounded by the client's usual limit; after it the player goes on as if no code came (the generic sentence), never "Reconnecting" for ever.
- **M5** for a changed file no "Try again" is offered; the sentence and the controls agree.
- **M6 (FR-350)** `byteRange` and the line-by-line (NDJSON) reader say "The library service's answer was cut off before it finished." for an answer cut part-way, as `bytes()` does; "could not be reached" only for an answer that never began.
- **M7 (FR-291)** the two sentences that still say "publisher": mend the loose ones the same way; the one where the publisher is all that is known stays — say which is which.
- **M8 (FR-254)** the next step fits the case: for a models FOLDER that cannot be read, the sentence says to check that the folder can be read (no path in it), not to install the model again.
- **M9** the new service test that sleeps and retries waits for the true state instead.
- **M10** the citation style list does not close when its scrollbar is dragged with the mouse, and still closes when focus really leaves it (Tab, a click elsewhere).

## Verify
As the round's brief says: your test files; `pnpm --filter @ao/ui test`, `pnpm --filter @ao/library-service test` once each (the machine is heavily loaded: re-run alone what fails only on a time limit, and say which; `find-browser-routes.test.ts` "the pause after a hand-over…" is known to fail under load and is being mended by another agent); the media helper's tests for the file you changed if its venv is there (`node scripts/run-pytest.mjs` — read it for how to pass a file; if there is no venv, say so); `pnpm -r typecheck`; `lint:css`, `lint:colours`, `run build`; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE4b-report.md`: per point what changed (file:line), its test and that it failed first; the table of every dialog and popover with its screen and result; the exact sentences; what only a real browser or Mac can show; the runs. Final message, at most 200 words: status, head commit, how many dialogs the table now opens from their screens and how many faults it found, the runs in one line, anything needing a ruling.
