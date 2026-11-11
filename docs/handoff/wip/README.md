# Work in flight on 2026-11-11, 17:00 UTC (safety copies)

The account's usage limit stopped four agents in the middle of their tasks. Their branches exist only
in the coordinator's container, so their work is saved here as patches. **Delete this folder once the
tasks below are merged.** Nothing here is reviewed code; do not apply it to `main`.

Each `*-committed.patch` is `git diff --binary <base> <branch head>`; apply it on its base with
`git checkout -b <name> <base> && git apply --index --3way <file>`. Each `*-uncommitted.patch` is the
agent's unfinished edits on top of the commit named below.

| File | Task | Base | Branch head | State when stopped |
|---|---|---|---|---|
| `task-34a-committed.patch` | 34a media and transcript routes (R135) | `ad61439` | `0dd43ae` | Implementation finished and reported; the adversarial security review had only just begun. Report: see the ledger. |
| `task-49-committed.patch` | 49 governed backups (R125) | `ad61439` | `23d4ee8` | Implementation finished; reviewed: 1 Critical, 4 Important (ledger, R138). Fix round 1 had not produced a commit. Does not apply cleanly on the current working branch (it predates the Task 41a merge); apply on its base, then merge. |
| `task-45-committed.patch` | 45 end-to-end scenarios 3, 4, 6, 8 | `93dd168` | `cdc42d7` | Scenarios finished; reviewed: 3 Important in the test code (ledger, R136, R137). Fix round 1 under way. |
| `task-45-uncommitted.patch` | 45, fix round 1 in progress | on `cdc42d7` | | Unfinished edits (4 files). |
| `task-51-uncommitted.patch` | 51 job records in files (R31) | on `668a86c` | | Early: first tests and the start of the journal module (3 files). Nothing committed. |

The reports and reviews these refer to (`task-34a-report.md`, `task-49-report.md`, `task-49-review.md`,
`task-45-report.md`, `task-45-review.md`) were working files outside git; their substance is in the ledger.
