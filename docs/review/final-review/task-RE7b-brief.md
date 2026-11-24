# Rough-edges round — task RE-7b: a source whose linked file cannot be found (FR-504, FR-527; Ruling R470 a)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over one point from the implementer of batch RE-7 (Find and acquire and the desktop shell), who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-7b`, branch `re-7b-find`, at 7a8f5ee = batch RE-7 as built (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-7b &&`. Two other agents are building other points of this batch in their own worktrees, and a reviewer is reading the batch in a fourth: stay in yours. Do not push.

## Read
1. **Ruling R470, its part (a), and R460 c:** `grep -n -E "Ruling R470|Ruling R460" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-7000`. And what a found file may and may not do: `grep -n -E "Ruling R301\b|Ruling R303\b" …/LEDGER.md | cut -c1-5000` (a found file is NEVER attached without the researcher's confirmation; "Use all the files that look right" queues them for approval one by one).
2. The first implementer's findings, with files and lines — the section "NEEDS A RULING", FR-504 / FR-527, of `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7-report.md`.
3. The list entries: `grep -n -E "FR-504\b|FR-527\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-2500`.
4. The code: `packages/library/src/find/runner.ts` (`copyOn`, about :2070; how an entry rests and with which reasons), `packages/library/src/repo/review.ts` (`sourceHasFile` about :516, `holdMismatchedFile` about :623, `HeldFileSourceHasFileError`), the reason codes and their sentences in `packages/shared`, the service's Find routes (`apps/library-service/src/routes`), the screen `packages/ui/src/screens/FindAcquire.tsx`, the Missing files screen, and how a linked original is told from a stored one and how its reachability is checked elsewhere (the Missing files code already does it: reuse it).

## What to build (tests first, each seen to fail; one commit per step)
1. **The copy step tells a linked original it cannot reach.** When an entry's record has no file but a LINKED original whose file is not there now, the entry does not rest as "in the library": it rests with its own reason (a new code in `packages/shared`, its sentence there, shown through the screen's usual place for a reason): "Its linked file cannot be found at the moment; the drive it is on may not be connected." A linked original that IS reachable, and a stored one, rest as today. Nothing is fetched because of this alone.
2. **"Get a copy for this source"** — an act on that entry (a route of the app's own with the token and checks every route has; not among the extension's routes; the project's rules and the researcher's Search sources file decide what may be asked, as for every copy). Only after that press does the copy part look for a copy for that entry, despite the linked original. The entry remembers the pick across a restart exactly as it remembers its other states.
3. **The hold and the attach accept such a record** — a record whose ONLY original is a linked one whose file is missing is no longer refused with `HeldFileSourceHasFileError`; a record with a reachable or stored file still is.
4. **"Use this file" ADDS the found copy beside the linked original.** The link is never replaced, changed or removed; the Missing files screen still lists the linked file as missing; the found copy becomes a stored file of the source through the same governed, audited, crash-safe change as any accepted found file (the audit says a copy was added, not that a file was replaced). If the linked file comes back later, both are there. Nothing is attached without the confirmation.
5. **The row in the screen** — the reason, the act (a button whose accessible name says which source), the usual states after it; the reason through `UserText` where it carries outside text.
6. The runner's tests wait for the TRUE resting state of an entry (five tests of this file were mended for reading too early, and another agent is mending more of them right now in `runner.test.ts`: add your tests at the END of the file's relevant `describe` or in a new test file `runner.linked-missing.test.ts` to keep the two changes apart).

If any step needs a decision this brief does not make (for instance what the source's "file" is for the reader when it has both), stop that step and say exactly what must be decided.

## Verify
Your test files; `pnpm --filter @ao/library exec vitest run src/find src/repo/review` (name the files that exist); `pnpm --filter @ao/library-service test` and `pnpm --filter @ao/ui test` once each (heavily loaded machine: re-run alone what fails only on a time limit, and say which); `pnpm -r typecheck`; `lint:css`, `lint:colours`, `run build` for the screen; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7b-report.md`: per step what changed (file:line), its tests and that they failed first, the exact sentences, anything built differently and why. Final message, at most 180 words: status, head commit, the runs in one line, anything needing a ruling.
