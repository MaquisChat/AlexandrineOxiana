# PROCESS — how this project has been built

## Workflow: subagent-driven development (SDD)
- **Plan.** `docs/superpowers/plans/2026-11-09-phase-1-foundation.md` has 37 tasks, each with files, interfaces, tests and a commit message.
- **Controller.** The main session acts as controller. It never writes product code itself. For each task it:
  1. Generates a brief from the plan with `bash <skills>/subagent-driven-development/scripts/task-brief <plan> <N>`. This writes `.superpowers/sdd/2026-11-09-phase-1-foundation/task-N-brief.md`. The script reads `### Task N:` headings, so it works for the original plan only; tasks in `docs/PLAN.md` get a hand-written brief that quotes the rulings named in the task's `[ledger: …]` tag.
  2. Records binding rulings in the ledger, `docs/handoff/LEDGER.md`, which is committed; new rulings continue from R120. (The old git-excluded `.superpowers/sdd/2026-11-09-phase-1-foundation/progress.md` existed only in the previous session's container.) Each ruling is numbered `Ruling RNN` and states what it costs if wrong. Briefs, reports and review packages for the current plan are working files under `.superpowers/sdd/PLAN/` (git-ignored).
  3. Dispatches an **implementer** subagent (opus) with the brief plus the rulings.
  4. Generates a review package with `bash <skills>/.../review-package <plan> <BASE> <HEAD>`, which writes `review-BASE..HEAD.diff`.
  5. Dispatches a **reviewer** subagent (opus). Reviewers run adversarial probes in scratch files, delete them afterwards, and report findings as Critical, Important or Minor with file:line and a failing input.
  6. Turns the findings into a ruling, sends a fix round back to the same implementer (via SendMessage), then has the same reviewer re-review.
- **Fix rounds.** Up to three rounds with the same implementer; rounds four and five go to a fresh implementer on a more capable tier. Then the controller adjudicates what is left and records it in the ledger. Small final rounds may be verified by the controller running the targeted tests itself.
- **Parallel work.** Independent tasks run in isolated git worktrees (`.claude/worktrees/agent-*`, excluded locally via `.git/info/exclude`) on branches `claude/eager-sagan-ndp8ku-tNN`. The controller merges each branch after its review is clean, using `--no-ff`, regenerating `pnpm-lock.yaml` with `pnpm install --no-frozen-lockfile`.
- **Integration.** After a merge, an integration step adds the service-side gaps that the UI tasks found (R111, R118).

## Conventions
- **Stack.** pnpm 10 monorepo, Node 22, TypeScript strict, ESM, Vitest, dependencies pinned exactly (the rule; the root `package.json` dev tools still use `^` ranges). A Python 3.13 media worker.
- **TDD.** Tests are written first and watched failing. Reports must state whether each test failed first.
- **Commit messages.**
  - Use a Conventional prefix: `feat(...)`, `fix: Task N review round K ...`, or `merge: Task N ...`.
  - End every commit with:
    ```
    Co-Authored-By: <as given by the session's own instructions>
    Claude-Session: <as given by the session's own instructions>
    ```
    That is, the trailers of the session making the commit; never copy a previous session's link.
  - Apart from those trailers, never put a model identifier in code, commit messages or docs.
- **Branches.** Develop on the session's working branch (currently `claude/amanuensis-handoff-0x6u5m`). `main` is the approved state and changes only with the owner's approval; the `claude/eager-sagan-ndp8ku*` branches are frozen. Never open a PR unless asked.
- **After each task.** Push the working branch after every completed task, and update the status table in `docs/PLAN.md` section 8 in the same commit or the next.
- **UI.**
  - Theme tokens only (`lint:css`, `lint:colours`).
  - Use `UserText` for user or source text (`dir="auto"`). No `innerHTML`.
  - Archived HTML only via `SnapshotFrame`. Codes via `CodeSwatch` (colour plus shape plus name).
  - Accessible labels, keyboard support and visible focus everywhere.
- **Service.**
  - A thin layer over `@ao/library`.
  - Every mutation is governed: policy evaluated, audited, R26 txn-safe.
  - Errors are shaped `{error:{code,message,reason?}}`, with paths scrubbed.

## What worked
- Adversarial reviewers caught many real Critical issues: XSS/mXSS, data loss, participant-code mixups, location leaks, and audit tamper gaps. Keep reviews adversarial and probe-based.
- Rulings with "cost if wrong" kept decisions consistent across about 120 dispatches.
- Parallel worktrees for UI tasks saved hours.

## What didn't and what to avoid
- **Container restarts and usage limits killed agents mid-task.** Always tell implementers to commit early. To resume, send the existing agent a message instead of starting a new one. Uncommitted work survives in the worktree.
- **The stop hook repeatedly asks to commit uncommitted changes.** Those changes belong to running agents. Don't commit an agent's half-finished work.
- **Merging parallel branches silently duplicated code** (two `ndjson()` functions in `client.ts`). Always typecheck after a merge.
- **Load-sensitive timing tests flake** when several suites run at once. Re-run them alone before acting.
- **`/fast` needs usage credits** on this account.
- **The 2026-11-11 handoff was committed but not pushed,** so the next session (a fresh clone) could not see it. A handoff is not done until it is on GitHub.
- **Reviewer probes once created libraries outside temp directories** (`/nonexistent-root-dir`, `/root/.ssh/x y` in the old container). Tell reviewers to use `os.tmpdir()`.
