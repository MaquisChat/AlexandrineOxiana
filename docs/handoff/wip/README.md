# Work in flight on 2026-11-11, 17:00 UTC (safety copies)

The account's usage limit stopped four agents in the middle of their tasks. Their branches exist only
in the coordinator's container, so their work is saved here as patches. **Delete this folder once the
tasks below are merged.** Nothing here is reviewed code; do not apply it to `main`.

Each `*-committed.patch` is `git diff --binary <base> <branch head>`; apply it on its base with
`git checkout -b <name> <base> && git apply --index --3way <file>`. Each `*-uncommitted.patch` is the
agent's unfinished edits on top of the commit named below.

| File | Task | Base | Branch head | State when stopped |
|---|---|---|---|---|
| `task-49-committed.patch` | 49 governed backups (R125) | `ad61439` | `23d4ee8` | Implementation finished; reviewed: 1 Critical, 4 Important (ledger, R138). Fix round 1 had not produced a commit. Does not apply cleanly on the current working branch (it predates the Task 41a merge); apply on its base, then merge. |

The reports and reviews these refer to (`task-34a-report.md`, `task-49-report.md`, `task-49-review.md`,
`task-45-report.md`, `task-45-review.md`) were working files outside git; their substance is in the ledger.
