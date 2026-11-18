# Final review — reviewing a fix task (common brief for the reviewers; your dispatch names the task)

You are a fresh, adversarial reviewer of ONE fix made after a whole-branch review of the project "Alexandrine Oxiana" (a local-first research workbench for social scientists; a pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest: `packages/core` pure domain logic, `packages/library` the library engine with governed, audited, crash-safe writes, `packages/shared`, `apps/library-service` a Fastify service on 127.0.0.1, `packages/ui` React 19, `apps/cli`, `apps/browser-extension`, `apps/desktop` Tauri 2, `services/media-worker` Python, `e2e/`). The people it protects are research participants and the researcher's own work. You did not build this and have none of its history: what you need is in the files your dispatch names.

## Read
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/review-common-reader.md` — how reviews are done here (probe, don't just read; the standing rules; severity; the rules for you: probe files next to the code named `*.probe<task>.test.ts`, run alone at `nice -n 10`, ALL deleted before you finish; no whole suites, installs, builds or end-to-end runs; no fixes; no sub-agents). Where it names "the reader's plan" and "the task's section", yours are the task's brief and its ruling.
2. The finding this task fixes, in the whole-branch review your dispatch names — with its probe. **Re-run that probe first, against the fixed code.**
3. The task's brief (what the implementer was told), the implementer's report, and the review package (one file: the commits, a stat, the diff with context) — read the package once, in full.
4. Every ruling your dispatch names, in full, from `/home/user/AlexandrineOxiana/docs/handoff/LEDGER.md` (lines are long: `grep -n -E "Ruling R379\b" … | cut -c1-9000`).

## What to answer
- **Is the finding closed — every way in, not only the probe's?** List every path by which the wrong thing could still happen (other callers, other entry points: the screens, the service's routes, the command line, background work, a resume after a crash, a restore, an encrypted or locked project, a read-only library) and try each.
- **Did the fix break or weaken anything?** What worked before and must still work; what an honest researcher loses; any rule now stricter or looser than the ruling says.
- **Is each guard held by a test that fails without it?** Take the guard out, see the test fail, put it back (your worktree must end clean: `git status --short` empty).
- **The implementer's own doubts and the points it left** — is each real, is any worse than it thought?
- Anything else wrong in the changed lines. Do not review code the task did not touch, except where the fix depends on it.

## Report
Write the review to the file your dispatch names: verdict (APPROVED / APPROVED WITH SMALL POINTS / NOT APPROVED); what you ran; findings by severity — **Critical** (data loss or corruption, a privacy or security breach, a governance or audit bypass, a half-written change presented as real, a secret exposed), **Important** (wrong behaviour a researcher would meet, a ruling not met, risky logic untested), **Minor** — each with file:line, the failing input or probe output, and a direction (not a patch); "checked and sound"; "could not verify".
Final message to the coordinator (max 150 words): the verdict; counts by severity; one line per Critical and Important finding; anything needing the coordinator's ruling. Exactly one final message.
