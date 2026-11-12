# Common brief for implementers (read first; your dispatch and your task brief add the specifics)

## Where this fits
Alexandrine Oxiana is a local-first research workbench for social scientists, a pnpm monorepo (pnpm 10, Node 22, TypeScript strict, ESM, Vitest):
- `packages/core` — pure domain logic (policy engine, audit, verification, citations).
- `packages/library` — the library engine on Node: governed, audited, crash-safe writes to a folder of files; a rebuildable SQLite index; import, capture, export, backups.
- `packages/shared` — types for data crossing the service boundary.
- `apps/library-service` — a Fastify service on 127.0.0.1 over the library (bearer token, Host and Origin checks).
- `packages/ui` — a React 19 + Vite interface that talks ONLY to the service.
- `apps/cli`, `apps/browser-extension` (MV3), `services/media-worker` (Python 3.13: downloads, transcription, OCR), `e2e/` (Playwright: the real UI against the real service and worker), `apps/desktop` (the shell, not built yet).
The work is done task by task: an implementer (you) in an isolated git worktree, then an adversarial reviewer who probes, then fix rounds, then the coordinator merges.

## First
1. You are in your own git worktree. Run `git merge --ff-only claude/amanuensis-handoff-0x6u5m` (the local working branch; your worktree starts from an older commit). If it cannot fast-forward, stop and report.
2. `pnpm install --frozen-lockfile`. Only if your task needs them: `pnpm fetch-csl` (citation styles), `pnpm setup:py` (the worker's Python environment), `pnpm --filter @ao/ui run build` (before end-to-end runs).

## Read
1. `CLAUDE.md` and the "Conventions" part of `docs/handoff/PROCESS.md`.
2. Your task's section in `docs/PLAN.md` (Accept, Verify) and your task brief.
3. Every ruling your brief names, IN FULL, from `docs/handoff/LEDGER.md`. Its lines are long, so read them with `grep -n -E "Ruling R(26|96)\b" docs/handoff/LEDGER.md | cut -c1-3500` (adjust the numbers). `docs/handoff/LEDGER-INDEX.md` has one line per ruling up to R119. Rulings bind; where a ruling and older text differ, the ruling wins, and a later ruling wins over an earlier one.

## Standing rules (reviewers probe every one)
- **Library:** every change to a library is evaluated by the policy engine first, audited, and crash-safe through the transaction marker (R26). Governance fails closed. Originals are never modified. No absolute paths are stored in a library. Writes are atomic.
- **Service:** 127.0.0.1 only; bearer token; Host and Origin checks; no secret in a URL, a log line or an error; errors are `{error:{code,message,reason?}}` in plain language with no file-system paths (R96).
- **UI (R113):** colours from theme tokens only (`pnpm --filter @ao/ui run lint:css` and `lint:colours`); every text from a source, a file, the service or the user goes through `UserText` — never `innerHTML` or `dangerouslySetInnerHTML`; archived HTML only through `SnapshotFrame`; accessible names, labels, keyboard operation, visible focus, nothing by colour alone; dialogs move focus in, trap it, restore it and make the background inert, and their tests assert `document.activeElement` (R145); stale answers (after the project, source or query changed, after a lock, after unmount) are dropped; a double click sends one request; failures are in plain language.
- **Tests:** write each test first and watch it fail for the right reason, then build; say in your report whether each failed first. Tests never reach the network. Temporary data only under `os.tmpdir()`. A test-only switch is honoured only when `NODE_ENV=test` (R47).
- **Dependencies:** add none unless your brief says so; any that is added is pinned to an exact version.
- **Machine:** it is shared with other agents and often heavily loaded. Re-run a timing-sensitive failure alone before believing it. Never loosen a timing limit, skip or delete a test to get a pass. A UI test, ReviewQueue "loads titles six at a time", is known to fail under load and pass alone.
- **End-to-end:** `pnpm e2e -- --app-only --trace off` (always `--trace off`). A product defect that is not yet fixed runs as an expected-failure test (`expectDefect(Dn)` in the specs); when you fix one, turn its test into a normal passing one.

## Working rules
- Stay inside the files and packages your brief names. If the task cannot be done without going outside them, or turns out much larger than described, stop on that point and report it.
- Commit on your worktree branch in small commits with a Conventional prefix (`feat(ui): …`, `fix: …`, `test: …`), staging by path, early and often (a usage limit can stop you at any moment), ending every commit message with the commit trailers your own session instructions give you. Do not push.
- No sub-agents. Do not ask anyone to review your work. Do not edit `docs/PLAN.md` or anything under `docs/handoff/`. No model identifiers in files or commit messages.
- Before reporting, run the verification commands your brief names and give the final output line of each.

## Report
Write the full report to the scratchpad path your dispatch names (the main checkout is not writable from your worktree): what you built or changed (file:line); each test and whether it failed first; every route, file format or shared type you changed; verification commands with their final output lines; anything you were unsure of; one line `minor (deferred): …` for each thing knowingly left.
Final message to the coordinator (max 150 words): status (DONE / DONE_WITH_CONCERNS / BLOCKED), branch and head commit, one line of test results, anything that needs the coordinator's ruling, concerns.
