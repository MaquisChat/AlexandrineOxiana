# Common brief for task reviewers (read first; your dispatch adds the specifics)

## Where this fits
Alexandrine Oxiana is a local-first research workbench for social scientists, a pnpm monorepo (Node 22, TypeScript strict, Vitest): `packages/core` (pure domain logic: policy engine, audit, verification), `packages/library` (the library engine: governed, audited, crash-safe writes to a folder of files; a rebuildable SQLite index), `packages/shared` (types crossing the service boundary), `apps/library-service` (a Fastify service on 127.0.0.1 over the library), `packages/ui` (React; talks only to the service), `apps/cli`, `apps/browser-extension`, `services/media-worker` (Python), `e2e/` (Playwright), `apps/desktop`.
Work is done task by task: an implementer in an isolated git worktree, then you — an adversarial reviewer who probes — then fix rounds, then the coordinator merges. Give two verdicts: spec compliance, and quality.

## Read
1. What the implementer was told: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/impl-common.md` (standing rules) and the task brief named in your dispatch; the task's section in `docs/PLAN.md` of the worktree (Accept, Verify).
2. The implementer's report and the review package named in your dispatch (one file: the commits, a stat, the diff with context). Read the package once, in full.
3. Every ruling your dispatch names, IN FULL, from the worktree's `docs/handoff/LEDGER.md` (long lines: `grep -n -E "Ruling R(26|96)\b" docs/handoff/LEDGER.md | cut -c1-3500`, adjusting the numbers). A commit message or report naming a ruling is a claim to check, not evidence.

## How to review
1. **Spec:** each Accept item and each "Do" item of the brief — built, missing, or different (and is the difference justified in the report?). Anything built that was not asked for.
2. **Probe, don't just read.** For anything risky write a scratch test that tries to break it: a crash or thrown error half-way (the neighbouring tests show the crash-point helper), two calls at once, a locked or encrypted project, a read-only library, hostile or odd input (control characters, bidi marks, very long strings, `..`, symbolic links, names differing only by case), a missing or wrong Origin, Host or token, a response the UI does not expect.
3. **Standing rules:** every library change is evaluated by the policy engine, audited, and crash-safe (R26); governance fails closed; originals never modified; no absolute paths stored; the service is 127.0.0.1 only with bearer token and Host and Origin checks, no secret in a URL, log or error, errors in plain language without paths (R96); UI rules R113 and R145 (tokens for colour, `UserText` for any outside text, never `innerHTML`, accessible names, keyboard, focus managed and asserted through `document.activeElement`, stale answers dropped, one request per action).
4. **Contract:** for every request the UI makes, open the handler and compare path, method, body, each response field read, each error code handled. UI tests mock the service, so a mismatch is the likeliest real defect.
5. **Tests:** do they assert behaviour or implementation? For each new test: would it fail if the behaviour were removed? What risky logic has no test?
6. **The report's own doubts** ("unsure", "needs a ruling", "deferred"): is each real, and is any worse than the implementer thought?

## Rules for you
- Work in the worktree your dispatch names. Probe files sit next to the code under test and carry the task id in their name (`*.probe<task>.test.ts` or `.tsx`); ALL are deleted before you finish, and `git status --short` there must show none of your files. Run single test files (`pnpm --filter <package> exec vitest run <path>`; packages: `@ao/core`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`, `@ao/shared`), plus `typecheck` and the UI lints if relevant. No whole suites, installs, builds or end-to-end runs. Temporary data only under `os.tmpdir()`. Nothing reaches the network.
- The machine is shared and heavily loaded: re-run a timing-sensitive failure alone before believing it.
- Do not modify, stage or commit tracked files. No sub-agents. No fixes.
- Severity: **Critical** = data loss or corruption, a privacy or security breach, a governance or audit bypass, a half-written change presented as real, a secret exposed. **Important** = wrong behaviour a researcher would meet, a contract mismatch, a ruling not met, risky logic untested, an accessibility failure that blocks keyboard or screen-reader use. **Minor** = the rest.

## Report
Write the full review to the file your dispatch names (if it is not writable, to the same file name under `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/`, and say so): a spec table; findings with id (`C1`, `I1`, `M1`…), file:line, what is wrong, the failing input or probe output, the ruling it breaks, and a direction (not a patch); "checked and sound"; "could not verify".
Final message to the coordinator (max 160 words): Spec ✅/❌; quality Approved / Needs fixes; counts by severity; one line per Critical and Important finding; anything that needs the coordinator's ruling.
