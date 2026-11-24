# Rough-edges round — batch RE-3b: the review's points on RE-3 (Rulings R465 b, R468)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over from the implementer of batch RE-3, who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-3-library-ui`, branch `re-3-library-ui`, at 987753a = batch RE-3 as built and reviewed (dependencies and citation styles installed; only `packages/ui` is changed by this batch). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-3-library-ui &&`. Do not push.

## Read
1. **Rulings R468 and R465, every clause:** `grep -n -E "Ruling R468|Ruling R465" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-8000`.
2. **The review, in full** — the evidence, the probes and file:line for every point (I1, I2, M1–M7): `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE3-review.md`. The reviewer's probes are your first tests.
3. The first implementer's report (what was built, and its section "NEEDS A RULING" for FR-413): `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE3-report.md`.
4. How the app's dialogs are built and tested (`packages/ui/src/components/ReasonDialog.tsx` with `DialogShell`, and the rule that a dialog is never confirmed by the key that opened it: `grep -n "Ruling R376" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-4000`).

## The points (each: a test first, seen to fail; the smallest change; one commit)
- **I1 (FR-165) — the confirmation before a workspace tag is renamed is one of the app's own dialogs.** Built with the app's dialog shell (not a hand-made panel): focus goes into it when it opens; it has an accessible name that says which tag and to what; Escape closes it as Cancel does; it is never confirmed by the key that opened it (Enter in the name field opens it — the same Enter must not confirm it: R376 c, by the mechanism the other dialogs use); after confirm, cancel or a failed rename, focus is back on that tag's rename control (its name field or button — say which and why). Tests through `document.activeElement`.
- **I2 (FR-390) — a cancelled reason clears the comma-separated field's draft WITHOUT remounting the field.** Take out the key-by-cancel-count; reset the draft another way; after Cancel focus is on the field, as before the fix. The test asserts both: the draft is the stored value again AND `document.activeElement` is the same field element as before.
- **M1 (FR-389)** the rules' form reads the project list and the library's mode once on opening and once per real change — count the requests in a test.
- **M2 (FR-153)** when the reload after a SUCCESSFUL resolve fails, the stale "Roll it back" is not left offered: what the screen cannot know it does not show; it says the list could not be read again and offers the screen's usual way to try.
- **M3 (FR-412)** "Any libraries it could still read are listed…" (true also when none could be read) — keep the rest of the notice.
- **M4 (FR-170)** "Collections created" and "Tags created" stand in a place of their own in the import report (their own small table or list under its own heading), not inside "Items by outcome"; put the misplaced doc comment right.
- **M5 (FR-152)** the guard inside the "Load more" handler gets a test of its own that fails without it.
- **M6 (FR-155)** after "Try loading again" focus is not lost (it stays on the control, or goes to the loaded section's heading when the control is gone).
- **M7 (FR-162)** the collection tree's twisty has a clickable area of at least 24 by 24 CSS pixels (padding or a minimum size; tokens and the existing class; the tree's layout must not shift) — and `lint:css` passes.
- **FR-413 (R465 b)** the watched-folders warning becomes a statement about the opening: "This computer's list of watched folders could not be read when this library was opened, so its watched folders were not started then. Files put in them are not imported until they run. Open the library again to start them all." (`StatusBanner.tsx`, `WARNINGS["watched-folders-unreadable"]`; if the service or `packages/shared` also holds this sentence, it lives in ONE place.)

## Verify
As the round's brief says: your test files; `pnpm --filter @ao/ui test` once (the machine is heavily loaded: re-run alone what fails only on a time limit, and say which); `pnpm -r typecheck`; `pnpm --filter @ao/ui run lint:css`, `lint:colours`, `run build`; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE3b-report.md`: per point what changed (file:line), its test and that it failed first; the exact sentences; what only a real browser or Mac can show; the runs. Final message, at most 150 words: status, head commit, the runs in one line, anything needing a ruling.
