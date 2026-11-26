# Whole channels with automatic transcription — common brief for implementers (Rulings R668, R669)

You are the implementer of ONE task of an implementation plan, in your own git worktree, on your own branch. Other agents build other tasks at the same time in theirs. Your dispatch names your task number, your worktree and your branch.

## The project in four lines
"Alexandrine Oxiana" is a local-first research workbench for social scientists (a Mac desktop app): pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest; `packages/core`, `packages/library` (the engine), `packages/shared`, `packages/ui` (React 19, MSW), `apps/library-service` (Fastify), `services/media-worker` (Python 3.13), `e2e/` (Playwright). The owner is a researcher, not a programmer: every sentence on a screen is plain words, and the words fixed in the plan are fixed.

## Read first, in this order
1. The plan: `/home/user/AlexandrineOxiana/docs/superpowers/plans/2026-11-26-whole-channel-capture-and-transcription.md` — its head IN FULL (from the top through "Decisions the spec left to the builder": Goal, Architecture, Global Constraints, Review Focus, Waves, the decisions), then YOUR task in full, then the section near the end "The coordinator's rulings on the planner's four points, and one more". Read the "Interfaces" blocks of the tasks yours consumes from or produces for; do not build them.
2. The design the plan implements (plain words, approved by the owner): `/home/user/AlexandrineOxiana/docs/superpowers/specs/2026-11-25-whole-channel-capture-and-transcription-design.md`.
3. The house rules: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/impl-common-reader.md`, in full.
The plan and the design are NOT in your worktree (they live on the documents branch): read them at the paths above and do not copy them in.

## How to work
- Follow your task's steps in order. **Tests first:** write the tests the task names (same names, the assertions it pins), SEE THEM FAIL for the right reason, then implement. Names, signatures, JSON shapes, values and sentences in the plan are exact: other tasks are being built against them right now. If you believe one is wrong or cannot be built as written, do NOT silently change it: build as far as is safe and put it under "NEEDS A RULING" in your report (what the plan says, what you found with file:line, the options, your recommendation).
- The plan was written from reading the code; a line number or a helper's name in it may be slightly off. Find the real thing by reading. That is not a ruling matter; say what you found in one line.
- Never loosen, skip or delete an existing test. A test that asserted behaviour your task changes is changed and NAMED in your report.
- A test that waits waits for the true resting state and asserts it exactly: no sleep, no retry. Every wait in code under test goes through an injected sleep or a fake clock. Where a test asserts that a request was cancelled, keep the mock's `request` object and read `request.signal.aborted` when asserting (never store the signal alone). A promise a test holds back is released when the test ends (`onTestFinished`).
- Work ONLY in your worktree. NEVER `git stash`. Do not push. Do not edit anything under `docs/`. Add no dependency.
- Commits: as your task's last step says (a task may split into the commits its steps name), staged by path, each message ending with exactly the two trailer lines your dispatch gives you. No model name anywhere else.
- Verify with SINGLE FILES ONLY, each at `nice -n 10`, one command at a time, nothing left running (the machine has 4 cores and is shared; whole-suite runs under load only produce false failures, and the coordinator runs one full verification after the join): the commands are in the plan's Global Constraints. A time-limit failure is re-run alone before you believe it. `git status --short` is empty at the end.
- If an action is refused by a permission check, do not work around it: say so in your report.

## Report
Write `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC<your task number>-report.md`:
- what you built, per step, with file:line; each test and that it failed first;
- every researcher-visible sentence that is new or changed, word for word (or "exactly the plan's table");
- existing tests you changed, each named with why;
- **NEEDS A RULING** (may be empty);
- anything you found in the code that the plan did not expect;
- the runs (the last summary line of each).
Final message to the coordinator, at most 150 words: status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, tests added, what needs a ruling, the runs in one line. Exactly one final message.
