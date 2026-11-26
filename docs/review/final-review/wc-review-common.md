# Whole channels with automatic transcription — common brief for reviewers (Rulings R668, R669)

You are a reviewer who did NOT build the work in front of you. Your job is to find what is wrong with it: try to break it. An approval you could not defend line by line is worth nothing. Your dispatch names the task number, the worktree, the branch and the commit range.

## The project in four lines
"Alexandrine Oxiana" is a local-first research workbench for social scientists (a Mac desktop app): pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest; `packages/core`, `packages/library` (the engine), `packages/shared`, `packages/ui` (React 19, MSW), `apps/library-service` (Fastify), `services/media-worker` (Python 3.13), `e2e/` (Playwright). The owner is a researcher, not a programmer. Ten tasks of one plan are being built by separate implementers at the same time, each against the names, shapes and sentences the plan pins.

## Read first
1. The plan: `/home/user/AlexandrineOxiana/docs/superpowers/plans/2026-11-26-whole-channel-capture-and-transcription.md` — its head in full (through "Decisions the spec left to the builder"), the task under review in full, the "Interfaces" of the tasks that consume what it produces, and the section near the end "The coordinator's rulings on the planner's four points, and one more".
2. The design the plan implements: `/home/user/AlexandrineOxiana/docs/superpowers/specs/2026-11-25-whole-channel-capture-and-transcription-design.md`.
3. The house rules the implementer had: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/impl-common-reader.md`.
4. The implementer's report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC<N>-report.md`. Test its claims; do not take them on trust.
5. The diff: `git -C <worktree> diff <range>` and the files around it.

## What to check
1. **The contract.** Every name, signature, JSON shape, value and sentence the plan pins for this task: is it there, exactly (sentences character for character, including curly quotes, en dashes and ellipsis characters)? Anything other tasks consume that differs from the plan is at least Important, because they are being built against the plan right now.
2. **Behaviour.** Does it do what the task's rules say, in every case the rules name? Look for the cases the rules imply and the tests skip: empty lists, the first and the last item, two things at once, a failure in the middle, a lock / close / move while it runs, an encrypted project, a read-only library, a repeat of the same call.
3. **The tests.** Is each test the plan names there, does it assert what its name says, and would it FAIL if the code were wrong? Pick the three most important and prove it by breaking the code locally (then restore: `git -C <worktree> checkout -- <file>`; `git status --short` must be empty when you finish). Is any test uncertain (a real timer, an assertion that something "has not happened yet", a stored signal without its request)? Was any existing test loosened, skipped or deleted? Each changed existing test must be named in the report with a reason that holds.
4. **The house rules.** Every library mutation governed, audited, crash-safe; nothing identifying kept in memory after a lock; no secret, no absolute path stored; in screens: theme tokens only, `UserText` for outside text, accessible names, focus asserted through `document.activeElement`, stale answers dropped, a double click sends one request. Plain-word sentences; a sentence shown by service and screen lives once.
5. **What it does to the rest.** Existing behaviour that must not change (named in the task and in your dispatch): prove it still holds by running the existing test files of the code that changed.
6. **What only a real Mac or a real platform can show**: list it; do not guess.

## How to work
- You may run tests in the worktree: SINGLE FILES ONLY, at `nice -n 10`, one command at a time, nothing left running (commands in the plan's Global Constraints). You may write probe tests and break code to prove a point; remove every probe and restore every file. Commit nothing, push nothing, `git stash` never. If the implementer or another agent is still working in the worktree, your dispatch says so: then read only.
- If an action is refused by a permission check, do not work around it: say so.

## Report
Write `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC<N>-review.md`: a verdict (READY / READY WITH FIXES / NOT READY); findings by severity (Critical, Important, Minor), each with file:line, what happens, how you know (the probe or the reading), and the smallest fix; the contract check (what you compared, what differs); the three mutations and what the tests did; what you could not check. Short: no praise, no summary of what the code does.
Final message to the coordinator, at most 180 words: the verdict, each Critical and Important in one line, the count of Minors, what you could not check.
