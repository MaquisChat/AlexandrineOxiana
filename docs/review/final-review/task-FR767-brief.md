# Task — the fix round of "nothing is asked after a stop", and FR-767 (no sensitive answer kept after a lock, on every path)

You are the implementer of one small piece, in a git worktree, continuing a branch another implementer built and a reviewer has read. You have none of their context: everything you need is here or in the files named here.

## Where you work
- Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/kg-3b`, branch `fr-765-nothing-after-stop`, head `bb9e1b8`. Check first: `git status --short` is empty and `git rev-parse --short HEAD` says `bb9e1b8`. Commit ON TOP; never amend or rebase what is there. Touch no other worktree or branch. Do not push. NEVER `git stash`.

## Read first
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md` — its sections "For each item", "Verify" and "Report" hold for you (tests first and seen to fail; the smallest change; single test files only at `nice -n 10`; how to report). Where it says "your batch", read "this task"; of its "Read first" list, read only `task54-fix-common.md` and `impl-common-reader.md` (the house rules), in full.
2. The work so far: `git log --oneline 815c80a..bb9e1b8` and `git show bb9e1b8` (FR-759's mend — the model for part C below).
3. The review of it, in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR765-review.md` — its Minor findings 3 and 4 and its answer **I** are your work.
4. Background for C: the lookup client (`packages/library/src/lookup/http.ts`) keeps answers in memory; answers about an ENCRYPTED project's sources are "sensitive" and must not stay in memory once that project is locked (find the rule in the code's comments near `purgeSensitive`, and Rulings R30, R50 and R600 in `/home/user/AlexandrineOxiana/docs/handoff/LEDGER.md`: `grep -n "Ruling R600\b" … | cut -c1-6000`). The lock route purges at the lock — but a lookup still in the air lands AFTER that purge, and its answer then stays. FR-759 closed this for the attach route (`apps/library-service/src/routes/sources.ts`, the `finally` that purges when the project is encrypted and no longer unlocked) and R600 I2 closed it for "Look up again".

## A. Review finding 3 — a timer left behind after a Zotero sync is stopped
`packages/library/src/import/zotero-web.ts` ≈ :359, :374: after a stop, the default sleep's `setTimeout` (up to 120 s) is neither cleared nor unref'd. It sends nothing, but it can keep a short-lived process (the command-line tool) alive for up to two minutes. Wanted: the stop clears it. Test first (the timer is gone after the stop — for example with fake timers and the pending-timer count, or an injected sleep that records its clean-up).

## B. Review finding 4 — a misleading debug note (only if it is a line or two)
A run's free-copy lookup that is ended by the run's STOP writes the debug note "free copy via … skipped: it could not be reached". Wanted: no such note for a lookup ended by the stop (it was not unreachable). If this needs more than a couple of lines, leave it and say so.

## C. FR-767 — the FR-759 leak on the other paths (the main part)
The reviewer found, BY READING ONLY, that these hand the session's lookup client to work that may look things up for an encrypted project, and none purges when that work ends:
- Bulk Import — `apps/library-service/src/state.ts` ≈ :1091
- the watched-folder bring-in — `state.ts` ≈ :1147
- Zotero web import and its resume — `apps/library-service/src/routes/import.ts` ≈ :120, :174; `state.ts` ≈ :1398
- Zotero sync — `apps/library-service/src/routes/zotero-sync.ts` ≈ :243
(Line numbers may have moved; find the code by reading. Look also for any path the reviewer missed that hands `s.http` or a lookup context to background work for a project.)

For EACH path:
1. **Is it true?** Write the test first, on the pattern of `apps/library-service/src/close-during-attach.test.ts` "FR-759 …": an encrypted, unlocked project; the path's lookup held in the air; the project locked; the answer released; the work ends — then assert that NO sensitive entry is left in the client's memory. See it fail. If the path cannot leak (the lock waits for that work, the work refuses at the lock before any answer lands, or it never looks anything up for that project), say so with the evidence, keep the test if it shows that, and change nothing there.
2. **Mend** as FR-759: when the path's work for that project ends (success, failure or cancel), purge the sensitive answers if the project is encrypted and no longer unlocked (or is gone). ONE shared helper used by every path and by the attach route — not five copies. Do not change what a person sees, any route's shape, or the lock route itself.
The reviewer accepted that the purge is coarse (it drops every sensitive answer, also another unlocked project's, which is then simply looked up again): keep it so.

## Not yours
Review finding 1 (a stopped caller uses up a pacing slot) is listed for later: do not touch `throttle`. Finding 2 is accepted as it is.

## Limits
- One commit for A (+B), one for C; plain messages that say what is now so, ending with the trailers your dispatch names.
- No sentence a person sees changes. If one must, stop that point and put it under NEEDS A RULING with the exact words.
- If C turns out plainly much larger than "one helper, a call at each path, a test at each path" — for example a path whose work has no clear end — build what is clear, and put the rest under NEEDS A RULING with what you found.

## Runs (single files, `nice -n 10`, one at a time; prefix `NODE_OPTIONS="--use-openssl-ca"`)
Every test file you added or touched; `close-during-attach.test.ts`; the service's test files of each path you changed (bulk import, watches, Zotero import, Zotero sync) and `server.test.ts`; `packages/library/src/import/zotero-web.test.ts`; the new timing-sensitive tests 20 times each; typecheck of `@ao/library`, `@ao/library-service`, `@ao/cli`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR767-report.md`, at most 500 words: a table (A, B, and one row per path of C: true? / what changed, file:line / its test, and that it failed first), NEEDS A RULING, what you could not show, the runs. Final message: at most 180 words — status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, per path of C whether it was true, the runs in one line, anything uncertain. If an action is refused by a permission check, do not work around it: say so.
