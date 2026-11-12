# HANDOFF — read this first

*Updated 2026-11-11 by the next coordinator. The open-task list below is superseded by `docs/PLAN.md`. Corrections made to this file are listed in `docs/PLAN.md` section 12 and in the git history.*

## Current state (kept up to date by the coordinator; last updated 2026-11-12 11:50 UTC)

Read this block first; the rest of this file is the 2026-11-11 morning snapshot.

- **Where the work is:** branch `claude/amanuensis-handoff-0x6u5m`, pushed after every completed task. `main` is the owner-approved state (still at `0ad6506`; nothing has been merged to it yet).
- **What to do next:** `docs/PLAN.md` section 8 is the task table (status and commit per task); section 9 lists what waits for the owner. The tail of `docs/handoff/LEDGER.md` (from "Checkpoint 2026-11-11") is the running record: every dispatch, review result, ruling (R120 onward, now to R155) and deferred minor.
- **Merged and verified (in order):** Milestone I (Tasks 38–42), 43, 60, 52, 37e, 45, 34a, 44, 34e, 61, 37d, 34c, 34b, 37b, 37a, 50, 48a, 48b, 37c, 58, 37h, 48c, 37j, 37f (the Mac workflow, written but never run).
**State at 2026-11-12 17:05 UTC:** Tasks 62, 67, 68 (with its test fix), 50b, 69, 70 and 37k are merged and pushed; GitHub's run on the push of 50b, 69 and 70 is in progress. Next: when it is green, raise "request" in `apps/desktop/mac-build-request.json` to 3 (a commit of its own) and send the owner `docs/first-run.md` and `docs/owner-checklist.md` with the download's address; then merge Tasks 34f and 47 (approved, verified together on the integration checkout, head 21a7e89). Open defects: D18, D19, D20 (after the owner's tests). The final review (Task 54) waits for the owner's tests; its list is in the ledger (search "final review's list").

**Owner's priority (2026-11-12): the Mac build first.** Its path is Tasks 67, 68 and 50b merged, Task 34f reported; then, once GitHub's run on the last of those merges is green (the owner: "late evening is fine, go ahead and run the checks"), raise "request" in `apps/desktop/mac-build-request.json` to 3. Task 47 and the guide (37k) are not on that path; the final review (54) waits until after the owner's hands-on tests.

- **After every pushed merge, read GitHub's result before pushing the next (R173).** On 2026-11-12 four merges were pushed onto a red branch because the controller did not look; the cause was two racy tests that pass on this loaded machine and fail on GitHub's quiet one (fixed in 050f08e; run 197 green). Local verification on the integration checkout does not replace GitHub's run.
- **State at 2026-11-12 11:50 UTC:** the Mac build works (run 2 of "Desktop (macOS)" is green; Apple Silicon only, R169; a build is requested by raising "request" in `apps/desktop/mac-build-request.json`, R168; the download is that run's artifact, unsigned, R151; the next build also produces the browser extension's download, Task 65). That build is from this morning: it lacks everything merged since. Merged today, in order: 37f, 37i (the owner's guide and checklist, `docs/first-run.md` and `docs/owner-checklist.md`), 46c, 57, 65, 51, 46a, 34d, 46b, 49, 63. Defects D1–D8 are all closed and no end-to-end step is an expected failure. Approved, taking the working branch once more before verification: 66 (D13). In a fix round: 62 (three Important; then it takes the working branch). Building: 64 (D10–D12), 67 (one project-wide review queue, D14), 50b (restore decided by the policy engine; D15). Not started, in the order they become possible: 68 (D16 and a way out of an unreadable settings file; after 66, to its implementer), 47 (shared API types), 34f (scenarios 9–11; after 62, 64, 67), 37k (revise the guide; the changed sentences are listed in the reviews of 66 and 64), then a new Mac build for the owner's full checklist run, 53–56. Open defects: D10–D16, each with its task. Verification before a merge is done on the integration checkout (`.claude/worktrees/agent-a43a7756acd4b0b1a`) with the script kept in the coordinator's scratch folder (typecheck, root tests, script tests, lints, interface build, app end-to-end run, and the desktop build, scenario and launch check); R173 says what counts when the machine is loaded. A branch that conflicts with the working branch is brought up to date by its own implementer, never by the controller in the merge. Remove a merged task's worktree once nothing uncommitted is in it (the disk is small); some are locked by the agent harness and stay. If an agent is stopped again, a fresh one continues from the task's worktree branch with the hand-over files in the coordinator's working folder (`takeover-common.md` and one brief per task) or, failing those, from the task's PLAN section and its last ledger entries.
- **How tasks run:** each implementer works in its own git worktree under `.claude/worktrees/` on a local branch `worktree-agent-<id>`; an adversarial reviewer probes it; the coordinator merges with `--no-ff` after review, verifies, records the result in the ledger and the PLAN table, and pushes. The standing briefs every implementer and reviewer is given are `docs/handoff/BRIEF-implementer.md` and `docs/handoff/BRIEF-reviewer.md`; each task adds a short brief of its own built from its PLAN section and the rulings it names. **Worktree branches exist only in the coordinator's container until merged.** If a session ends with tasks "in progress" in the PLAN table, that work is lost unless its branch still exists: check `git branch --list 'worktree-agent-*'` and the ledger's last lines for each task, and re-dispatch what is missing.
- **Checks to run before trusting the tree:** `pnpm install --frozen-lockfile && pnpm fetch-csl && pnpm setup:py && pnpm -r typecheck && pnpm test`, then `pnpm --filter @ao/ui run build && pnpm e2e -- --trace off`. The service is started with its token on standard input (see the commands table below).
- **Machine limits learned:** this container has four processors. More than about ten agents at once pushes the load past 25 and tests with explicit time limits fail for slowness; verify merges at raised priority (`nice -n -15 …`) and re-run a timing failure alone before believing it. Default test time-outs are hang detectors (R150); explicit limits are never loosened.
- **CI on GitHub:** one job per push to a working branch; docs-only pushes start no run; a run in progress is allowed to finish and only the newest waiting run is kept. The repository is private, so runners have two processors and a full run takes about 30 minutes; macOS minutes count ten times. Last green run: 186 at `376abcc`.

## Project and status
**Alexandrine Oxiana** is a local-first research workbench for social scientists. It combines Zotero-style references, Obsidian-style notes and Scrivener-style writing, with three further features:
- Archival capture of web, Instagram, TikTok and YouTube material, plus transcription.
- Full provenance on every item.
- Explicit per-project ethics governance (IRB, GDPR, HIPAA and DMP profiles).

The full spec is in `docs/handoff/SPEC.md`. **Phase 1 (foundation)** is being built from `docs/superpowers/plans/2026-11-09-phase-1-foundation.md`, which has 37 tasks. Status:
- **Tasks 1–33, 35 and 36 are complete.** The final fix rounds of Tasks 31, 32, 33, 35 and 36 and the last integration commits were never re-reviewed (PLAN Tasks 41a, 41b).
- **Task 34** (capture, transcript and verification screen) and **Task 37** (Tauri desktop shell, packaging, end-to-end tests) have not started.
- After those two, a **final whole-branch review** is still owed.

The original work was built on branch `claude/eager-sagan-ndp8ku`, which is now frozen. `main` was created at `0ad6506` and is the approved state; it changes only with the owner's approval. `handoff/2026-11-11` was pushed at `0832c77` (the snapshot with these documents added) and merged into the working branch, `claude/amanuensis-handoff-0x6u5m`, where work continues. Push the working branch after every completed task.

## What was done this session
- Brainstormed and approved the spec, wrote the plan, then ran subagent-driven development (SDD) through 35 of 37 tasks.
- Every task went through: implementer → spec and quality reviewer (adversarial probes) → fix rounds → re-review.
- The 119 binding rulings are in `docs/handoff/LEDGER.md`. Key ones are summarised in `DECISIONS.md`.
- Tasks 31, 32, 33, 35 and 36 were built in parallel git worktrees, then merged. Merge commits on main:
  - b52be59 (T32)
  - dcfa295 (T31)
  - 0432261 (T33)
  - 1f6f443 (T35)
  - e80ca54 (T36)
- Latest integration commits on main (HEAD 0ad6506):
  - e5102ed: shared rules in the service, plus the extension routes
  - 4e10e85: links-route hardening (R116)
  - 4cad0e3, 41f5308: R118 gaps, including R27 resolve-pending-write
  - f9340e5, 3579f11, 0ad6506: R117/R119 carry-overs, plus a researcher-name setting

## Open tasks (priority order) — superseded by docs/PLAN.md
Kept for history only; use `docs/PLAN.md` for what to do next.

1. **Review the last integration batch** (commits 0432261..0ad6506 on main).
   - What it covers: the three UI branches merged, plus the R118 service gaps (`profiles` in GET /projects, workspace tag rename/delete, lock-holder hostname, batch-created ids, `outsideFiles.file`, review titles, R27 resolve-pending-write) and the carry-overs (MoveLibrary status polling, consent re-attach, researcher-name setting).
   - Its implementer reported success by pushing, but **no reviewer has seen it yet**.
   - Next step: generate a review package (see PROCESS.md) for `e5102ed..0ad6506` and dispatch a reviewer. Pay special attention to R27 (it must never apply a half-written change) and to the unified router.
2. **Task 34: capture screen, transcript viewer, verification badges.**
   - Brief: create it with `bash <skill>/scripts/task-brief docs/superpowers/plans/2026-11-09-phase-1-foundation.md 34`.
   - It modifies `packages/ui/src/screens/SourceDetail.tsx` (Task 33).
   - Rules: archived HTML only through `components/SnapshotFrame.tsx` (R101); codes only through `CodeSwatch` with shape glyphs (R103); R113 UI rules; R109 CSP.
3. **Task 37: desktop shell (Tauri 2), packaging and e2e.**
   - Carry-overs:
     - The service sidecar runs with `--max-old-space-size=512` (R64/R96).
     - Done in Task 37b: the service takes its token as one line on standard input and refuses to start if one is in the environment or the arguments (R98). The shell must start it that way; the worker's own token is still passed in its environment and moves to standard input with the shell (Task 37c).
     - Native file and folder pickers and drop paths (FileDrop notes, R113).
     - Worker sidecar via PyInstaller.
     - An e2e test through `scripts/run-e2e.mjs --desktop-only`.
4. **Final whole-branch review** on the most capable model, pointed at the ledger's "deferred minors" and rulings. Then use the `superpowers:finishing-a-development-branch` skill.
5. **User-owed items** (not blockers for coding):
   - Choose the citeproc-js licence (CPAL-1.0 or AGPL-3.0).
   - Human review of `packages/core/src/citation/__snapshots__/*.txt` (5 styles, headed PENDING HUMAN REVIEW).
   - Visual check of the code palette.
   - Test real Zotero web downloads (storage hosts unverified, R79).
   - Test the OS keyring on a real machine.
   - Test the extension in Firefox.

## Known bugs, failing tests, risky areas
- **Test results at handoff:** see "Checkpoint results" at the bottom of this file.
- **GitHub CI was red on every push from `4cad0e3`** until the Task 38 fix.
- **Load-sensitive timing tests** can flake on a busy machine. Known ones:
  - refman "Zotero RDF: many items" (1 s limit)
  - custom-styles sandbox timeout
  - bulk/device timeouts

  Re-run them on their own before treating a failure as real. Don't loosen them.
- **`test:scale`** (10k import, under 120 s and 500 MB) runs separately: `pnpm test:scale`. It took 79–101 s in the earlier container and 117.8 s at the 2026-11-11 checkpoint on a different machine, against the 120 s limit. Do not loosen it (PLAN Task 42 measures it on GitHub's machines).
- **Risky areas**, all with tests:
  - Transaction/crash recovery (`packages/library/src/repo/txn.ts`, `mutate.ts`)
  - The HTML snapshot stripper and pre-scan (`packages/library/src/capture/html-strip.mjs`, parse5 internals pinned at 8.0.1)
  - Library move/quiesce (`apps/library-service/src/state.ts`)
  - Participant codes and pseudonyms (`repo/fieldwork.ts`, `repo/pseudonyms.ts`, `repo/withdrawn.ts`)
- **Deferred minors** are listed per task in the LEDGER (grep "Deferred" / "deferred"). They are for the final review.
- **Unverified hosts:** the Zotero storage-host allowlist (R79) and the LoC SRU endpoint (R51).

## Commands
**Requirements:** Node 22, pnpm 10.28, Python 3.13, ffmpeg. tesseract and ghostscript come via apt.

| Purpose | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Set up the Python media worker venv | `pnpm setup:py` (check root package.json scripts) |
| Fetch test fixtures (DNG/CR3) | `node scripts/fetch-fixtures.mjs` |
| Build the CSL style bundle (gitignored; needed by citation tests) | `pnpm fetch-csl` |
| Fetch fonts (checks pinned sha256) | `node packages/ui/scripts/fetch-fonts.mjs --check` |
| Typecheck | `pnpm -r typecheck` |
| Run all tests | `pnpm test` |
| Python worker tests | `pnpm test:py` |
| Build-script tests | `pnpm test:scripts` |
| 10k import scale test | `pnpm test:scale` |
| Extension e2e | `pnpm e2e -- --extension-only e2e/extension.spec.ts --trace off` |
| UI build | `pnpm --filter @ao/ui run build` |
| UI colour/CSS rules | `pnpm --filter @ao/ui run lint:css && pnpm --filter @ao/ui run lint:colours` |
| Run the service | `pnpm --filter @ao/library-service start` (prints `AO_SERVICE_READY port=<n>`; the access token, at least 32 characters, is written as one line to its standard input, for example `printf '%s\n' "$TOKEN" \| pnpm --filter @ao/library-service start`; it refuses to start if a token is in the environment or the arguments, R98) |
| CLI | `pnpm ao --help` (see `apps/cli/README.md`) |

## Start here (next agent)
1. Read this file, then `PROCESS.md`, then skim `DECISIONS.md`. Treat `LEDGER.md` as the binding rule book; grep it by ruling number.
2. Check out the working branch (`git checkout claude/amanuensis-handoff-0x6u5m && git pull`), not `claude/eager-sagan-ndp8ku`, which is frozen. Run `pnpm install && pnpm fetch-csl && pnpm -r typecheck && pnpm test`.
3. Take the next task from `docs/PLAN.md`, using the SDD process in PROCESS.md: brief → implementer → reviewer → fix rounds → append new rulings directly to `docs/handoff/LEDGER.md` (there is no git-excluded copy any more).
4. Never commit model identifiers. Commit trailers are in PROCESS.md.

## Checkpoint results (2026-11-11, at 0ad6506 plus these docs)
- `pnpm -r typecheck`: **pass** (all 7 packages).
- `pnpm --filter @ao/ui run build`: **pass**.
- `pnpm test`: **2053 passed, 2 failed, 1 skipped** (103 files). Both failures are in `apps/cli/src/cli.test.ts`, and both come from one stale test expectation (failure 1); the second is a knock-on.
  1. *"R67 in the CLI: --dry-run lists outside files…"*: the dry-run `outsideFiles` entries now carry an extra `file` field (R118 e, commit 4cad0e3). The test expects the exact old shape `{item, folder}`.
  2. *"export writes the chosen file atomically…"*: the `--json` export result no longer matches `{format:'ris', exported:1, …}`. This is NOT a separate regression: it fails only because failure 1 aborts its test before the "RefsB" import it relies on (`apps/cli/src/cli.test.ts`: the import near line 571 feeds the export near line 587).
  - **Next step:** one corrected expectation fixes both (PLAN Task 38). Keep CLI JSON stable where it is documented in `apps/cli/README.md`.
- Results added by the next coordinator on 2026-11-11: `pnpm test:py` 79 passed; `pnpm test:scale` passed at 117.8 s; extension end-to-end 4/4; UI build, font, CSS and colour checks pass.
