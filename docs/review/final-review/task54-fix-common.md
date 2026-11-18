# Final review — fix tasks after the whole-branch review (common brief; your dispatch names your task)

You are the implementer of ONE fix task in the project "Alexandrine Oxiana": a local-first research workbench for social scientists (a researcher's library of sources, files, interviews, consent forms kept as a folder of plain files on their own Mac). A pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest: `packages/core` (pure domain logic), `packages/library` (the library engine: governed, audited, crash-safe writes), `packages/shared` (types and texts crossing the service boundary), `apps/library-service` (Fastify on 127.0.0.1), `packages/ui` (React 19), `apps/cli`, `apps/browser-extension`, `apps/desktop` (Tauri 2), `services/media-worker` (Python), `e2e/` (Playwright). You have none of the earlier context: your task's brief and the files it names are everything.

## Where you work
The git worktree your dispatch names — it is ALREADY on your task's branch, at the finished branch's head, with dependencies installed. `cd` there first, and start every Bash command with that `cd`. Do NOT reset it, do not install, do not switch branches. Nobody else works there. Stay out of every other folder (you may READ files under `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/` and `/home/user/AlexandrineOxiana/docs/handoff/`). Do not push. The machine restarts now and then: COMMIT after each point, so that nothing is lost. Other long runs share the machine: run everything at `nice -n 10`; a time-limit failure in a test you did not touch is re-run once alone, and both results reported.

## Read first
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/impl-common-reader.md`, in full — the house rules (tests first; every library change decided by the policy engine, audited, crash-safe; no absolute path stored; errors in plain language without paths or secrets; in the screens: colours from tokens, outside text through `UserText`, never `innerHTML`, focus asserted through `document.activeElement`). Where it names "the reader's plan", yours is your task's brief.
2. Your task's brief, and the finding it fixes in the review file it names (the evidence, the probe, the file:line).
3. Every ruling your brief names, in full: `grep -n -E "Ruling R379\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000` (adjust the number; lines are long).

## How
- **Never use `git stash`** (not `stash`, `stash pop`, `stash apply`): the stash is ONE list shared by every worktree of this repository, and other agents are working in theirs — a pop takes whatever is on top, yours or not. To see a test fail on the old code, make the test first and run it before you write the fix; if you must set work aside, make a temporary commit on your own branch and undo it with `git reset --soft HEAD~1`.
- **Tests first.** For each point: write the test that shows the defect (the reviewer's probe is your first test), SEE IT FAIL for the right reason, then make the smallest change that makes it pass. Never loosen an existing assertion or time limit, never skip a test. An existing test that asserted the defective behaviour is changed and named in your report.
- The smallest change that fully meets the ruling. No refactoring beyond it, no new dependency, no change of an exported function's signature unless the brief says so. Comments say what the code does and why (name the ruling); no history.
- What you cannot prove here (a real Mac, a real network service) you say plainly; you do not claim it.
- If the task turns out to need a decision the brief does not make: stop that point, do the others, and say exactly what must be decided.

## Verify (each at `nice -n 10`, in the foreground; give the final summary line of each)
The test files you touched, by name (`pnpm --filter <package> exec vitest run <paths>`; packages `@ao/core`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`, `@ao/shared`) · the whole suite of each package you changed, once (`pnpm --filter <package> test`) · `pnpm -r typecheck` · if you changed a screen: `pnpm --filter @ao/ui run lint:css`, `lint:colours`, `run build`, and any end-to-end spec that drives what you changed (`pnpm e2e -- --app-only --trace off <spec path>`). Leave nothing running. `git status --short` empty at the end.

## Commits and report
Commits on your branch, one per point, each message ending with the trailers YOUR OWN session's instructions give; no model identifiers anywhere else.
Write your report to the file your brief names (under `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/`): per point what changed (file:line), its test and that it failed first; anything built differently from the brief and why; what only a real Mac or a real service can show; "minor (deferred)" points you saw and did not touch; the runs.
Final message to the coordinator (max 150 words): status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, the runs in one line, anything that needs the coordinator's ruling. Exactly one final message.
