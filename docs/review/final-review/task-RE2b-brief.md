# Rough-edges round — batch RE-2b: the points of RE-2 that came back for a ruling (Ruling R461)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over from the implementer of batch RE-2, who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-2b`, branch `re-2b-projects`, at 22afe32 = batch RE-2 as built (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-2b &&`. A reviewer is reading batch RE-2 in ANOTHER worktree at the same time: do not touch that one. Do not push.

## Read
1. **Ruling R461, every clause:** `grep -n "Ruling R461" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-6000`.
2. The first implementer's report, its rows for FR-194 and FR-204/205 and its section "NEEDS A RULING": `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE2-report.md`.
3. The list entries: `grep -n -E "FR-194\b|FR-204\b|FR-205\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-2500`.
4. The code: `packages/ui/src/screens/NewProject.tsx` (the dialog: the form, the "found" panel, the "cannot tell" state, the recovery-code step), `packages/ui/src/screens/Library.tsx` (`holdClose`, `onRecoveryPending`, `checkUnresolved`, the notice), `packages/ui/src/screens/LibraryChooser.tsx`, and their tests (`NewProject.outcome.test.tsx`, `NewProject.test.tsx`, `Library*.test.tsx`, `LibraryChooser*.test.tsx`).

## The points (each: a test first, seen to fail; the smallest change; one commit)
- **(a) FR-194 — the "found" panel of an ENCRYPTED project holds the library's close**, exactly as the recovery-code step is held today (read how that hold works and reuse it; the recovery-code step itself must stay held). While the panel is shown for an encrypted project and the library is closed (by another window, the service, a move): the dialog stays, with the existing closed-library sentence and the button "Back to choosing a library"; "Open the project" is not offered once the library is closed. A project that is not encrypted is not held (nothing would be lost).
- **(b) FR-194 — "cannot tell" and a close.** When the library closes while a project's creation is in the "cannot tell" state (in the dialog or as the notice on the library screen), the CHOOSER shows, for this session only — nothing is written to disk or to the service — one notice per such project, through `UserText`: "When “<project>” was being created in “<library>”, the app could not tell whether it was made. When you open that library again, look for “<project>” in its list of projects before creating it again." with a button "Got it" that removes it. It is a status the screen reader hears once (polite), the names shown as the researcher typed them (a right-to-left name must not flip the sentence: see how FR-158 was done in this branch), focus not stolen; after "Got it" focus goes to a sensible place (the chooser's heading or the next notice). It goes when dismissed or when the app is closed; opening the library again does not remove it (the researcher still has to look). Where the notice's state lives (it must survive the Library screen's unmount but not a reload of the app) is yours to choose — say where and why.
- **(c) FR-204/205 — same-named new projects are told apart.** Where the dialog and the notice now say that more than one project with the entered name was found, list them: each "in the folder “<the folder's own name>”" — the LAST part of the project's folder only, through `UserText`, never a path — with its own button "Open this one" (an accessible name that says which: "Open the project in the folder “…”"). The encrypted case keeps its sentence about the passphrase and the recovery code. If the screen does not hold the folder's name for a project, say what it does hold and stop for a ruling rather than fetch more.
- Not yours: FR-348 (accepted as built), FR-537 (the reviewer settles it).

## Verify
As the round's brief says: your test files; `pnpm --filter @ao/ui test` once (the machine is heavily loaded: re-run alone what fails only on a time limit, and say which); `pnpm -r typecheck`; `pnpm --filter @ao/ui run lint:css`, `lint:colours`, `run build`; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE2b-report.md`: per point what changed (file:line), its test and that it failed first, the exact sentences, where the notice's state lives; what only a real browser or Mac can show; the runs. Final message, at most 150 words: status, head commit, the runs in one line, anything needing a ruling.
