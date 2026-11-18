# Final review, Task FR-C1 — tests for guards of the library and the service (implementer's dispatch)

You are the implementer of **Task FR-C1** of the final review of the project "Alexandrine Oxiana" (a local-first research workbench; pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest; `packages/library` is the library engine with governed, audited, crash-safe writes; `apps/library-service` a Fastify service on 127.0.0.1). You work in your own git worktree (your current directory).

**Before anything else — your base:** `git reset --hard claude/pdf-reader-highlights`. Then `pnpm install --frozen-lockfile`, `pnpm fetch-csl`. Then read, IN FULL, `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/impl-common-reader.md` (how this project is built and tested) and Ruling R362 (`grep -n -E "Ruling R362\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000`, clause i).

## Your task: TESTS ONLY — no product code changes
The project's reviews found guards that protect a researcher's data, privacy or the record of where things came from, but that NO TEST would catch if someone removed them. You add those tests. For each item below: read its entry in `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/final-review-triage.md` (section "Group C") and in `final-review-list.md` (same folder; it gives the line of the decision log `/home/user/AlexandrineOxiana/docs/handoff/LEDGER.md` — read the context: `sed -n '<line>p' … | cut -c1-3000`); find the guard in the code; write the test; **prove it can fail: take the guard out (a scratch edit), see the test fail for that reason, put the guard back** — say in your report, per test, the mutation and the failure. A test that passes without its guard is not done.

1. **FR-101** — per-path tests for the capture rules: "needs review", "incomplete", and a missing legal basis (the governance of captures, Ruling R83 and its neighbours; decision-log line 139).
2. **FR-141** — an ENCRYPTED project's Zotero-web import keeps a location only on the allowed path (R83; log line 212).
3. **FR-235** — two existing assertions on the key file's wrappings accept any object (log line 466): make them assert the real shape (the wrappings of an encrypted project's key: what each must hold), so that a wrong or empty wrapping fails.
4. **FR-331** — the per-route "interface only" checks (routes the browser extension must not reach) sit behind a global check and are untested (log line 617): a test per such route that the extension's token is refused by the ROUTE's own check when the global one is taken out (the mutation), and by the global one as built.
5. **FR-365** — the branch where the Backups folder is unreadable at the moment of the check (log line 691).
6. **FR-426** — confirm by a test that storing a transcript writes `asset.derive` as the audit record of its processing decision (log line 885) — the test states what the audit holds; if it is NOT that record, STOP on this item and report (a finding, not a test).
7. **FR-427** — a crash-point test for the detail added by Tasks 71/72 (log line 902: read it for what "M2" is) — the library's crash-point tests are the model (the transaction marker, Ruling R26).
8. **FR-531** — a free-copy lookup still in flight when the service closes ends by its own time limit: probe by a test that it then WRITES NOTHING and holds nothing open (log line 1480; Ruling R247 c).
9. **FR-547** — the record-facts cache of "Find and acquire" is dropped at a project's lock and at the close (log line 1533; Ruling R333): a test that fails without each drop (sensitive answers must not survive a lock).
10. **FR-421** — tests that are skipped when run as root never run in this project's verification, which runs as root (log line 874). Add a script (`scripts/`, plain Node, with its own test under the existing scripts' tests) and a root `package.json` script `test:nonroot` that, when run as root, runs exactly those skipped test files as an unprivileged user (find how they detect root — `process.getuid`, `it.skipIf` — and list the files by that; use what the machine has: `setpriv`, `runuser` or `su` to a system user such as `nobody`, with a readable copy or readable permissions of what the tests need; say what you chose and why) and fails if any of them is skipped or fails; when not run as root it says so and runs them directly. Run it and report its output. If it cannot be done without changing product code or the repository's permissions in a way that stays, STOP on this item and report.

**If a test you write shows the product is WRONG** (the guard is missing or broken): do not fix the product — keep the failing test OUT of the commit, and report it as a finding with the evidence.

## Files
Test files beside the code they test (in `packages/library`, `packages/core`, `apps/library-service`), the new script and its test, the root `package.json` (one script). No product code. No new dependency.

## Verify (each at `nice -n 10`, in the foreground; give the final output line of each)
Each test file you touched, by name · `pnpm --filter @ao/library test` and `pnpm --filter @ao/library-service test` once at the end (if under 4.5 GB of disk are free, the library's backup test fails for that reason — say so) · `pnpm test:scripts` · `pnpm test:nonroot` · `pnpm -r typecheck`.

## Report
Full report to `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/task-FRC1-report.md`: per item — the guard (file:line), the test (file, name), the mutation and how the test failed under it; items stopped and why; findings (a product defect a test showed); the runs. Commit on your worktree's branch. Final message to the coordinator (max 150 words): status (DONE / DONE_WITH_CONCERNS / BLOCKED), branch and head commit, how many of the ten items have a test proven by mutation, the runs in one line, any finding. Exactly one final message.

Seven such tasks run at once on this machine: run tests at `nice -n 10`, in the foreground, only what is named; a timeout in a file you did not touch is re-run once alone and both runs reported; leave nothing running. Do not push. Commits end with the trailers YOUR OWN session's instructions give; no model identifiers anywhere else. If a point contradicts the code as built in a way you cannot resolve within the ruling, stop at that point and report it; finish the others.
