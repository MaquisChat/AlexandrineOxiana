# FR-A10 — a fresh review of the WHOLE task as it stands (third reviewer)

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-review-common.md`. Then this.

## The task
FR-A10: ONE rule for recognising a participant's name, used everywhere a participant's name must be replaced by their code or kept out — citations and bibliographies (`packages/core/src/citation/csl-map.ts`), folder names (`packages/core/src/naming.ts`), addresses, export names — and for deciding which participant a name belongs to (`packages/library/src/repo/pseudonyms.ts` `assignCodes`). The rule itself: `packages/core/src/participant-names.ts` (new in this task).

It answers finding C1 (Critical) and I1, I2 of the whole-branch review, part 1: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-wb1-review.md`. **Re-run that review's probes first, against the code as it stands.**

**This task failed two reviews and was then re-scoped by the coordinator (Ruling R403, which corrects parts of R387).** You are the third reviewer and you review everything, not the last round only: the earlier reviewers have no room left, and two of the earlier findings were caused by the coordinator's own rulings. A ruling can be wrong: if the code does what a ruling says and the result harms a participant or a researcher, say so.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, base 7b81976. Head: see your dispatch.
- The whole task as one package: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/review-FRA10-whole.diff` (base..head). The rounds since the second review only: `review-FRA10-round3.diff`. Read the WHOLE package once; use the rounds' package to see what changed last.
- Briefs: `task-FRA10-brief.md`, `task-FRA10-round2-brief.md`, `task-FRA10-round3-brief.md` (same folder). The implementers' report: `task-FRA10-report.md` (sections per round; the last are "Round 4 (R403)", R416 and "Round 6 (R420 a)").
- The two earlier reviews: `task-FRA10-review.md`, `task-FRA10-review2.md`. For EACH of their findings: is it closed now, and did its correction hold (R403 withdrew two things R387 had ordered)?
- Rulings to read in full (`docs/handoff/LEDGER.md` in `/home/user/AlexandrineOxiana`): R378 (its part a), R380, R383, R387, R401, R403, R416, R420 (its part a).

## Attack hardest
1. **Soft boundaries (R403 a).** An invisible character inside a run of letters is both nothing and a separator; the longer match wins. Names with zero-width spaces, joiners, bidi isolates, soft hyphens inside them, between two names, between a name and an ordinary word, at the start and end of the text; overlapping matches; a name that is a prefix of another participant's name; what is left beside the code after replacing.
2. **Who is the same participant (R403 b).** `assignCodes` compares by a strict key (accents, voicing marks, "@" and punctuation kept). Two people must never become one (a consent or a withdrawal would act on both); one person must not silently become two where the strict key says they are the same (case, width, invisible characters, white space, a no-space script written apart, Hangul written apart). A handle and a name. Participants made before this task in an existing library: does anything re-match or merge them on open, on rebuild of the index, on restore?
3. **Parts of names (R403 c).** A single word of a compound name is a form only with four letters or more (two characters in a no-space script, two Hangul syllables); a run of words only when two of them stand alone. Look for a real name that now escapes (under-matching leaks a participant) and for ordinary text now destroyed beyond what the ruling accepts. The folder name and the citation must agree on the same name.
4. **Names that fold alike (R416).** Ana Peña (P-001) and Ana Pena (P-002): each one's own citation, folder name and export must show their OWN code; a text that matches neither exactly takes the first. The implementer's doubt: a name whose accent-keeping words do not line up with its folded words falls back to the whole-name comparison, then to the folded choice — find a name for which that prints another person's code.
5. **A whole name inside another creator's name (R420 a).** "Friends of Maria Cocina" → "Friends of P-001"; given "Dr. Maria" + family "Cocina" → the literal "Dr. P-001"; PARTS are not looked for inside another creator's name ("Maria Lopez" stays). Does a creator changed this way count as coded (the source's own citation key withheld)? What happens in a source LINKED to participants (it fails closed when a creator other than the interviewer has no code: is the order of the checks right)? Editors, translators, interviewers; a creator with only a handle; an empty map (nothing scanned).
6. **Every caller.** Grep for any place that still compares or replaces a participant's name by an older rule (`toLowerCase`, `localeCompare`, `normalize(` on a name, a hand-made regular expression) in `packages/core`, `packages/library`, `apps/library-service`, `apps/cli`, `packages/ui`: citations, the formatted bibliography, folder and file names, export names, addresses (`urlNamesAny`), reports, the review queue, search.
7. **Cost.** The rule must stay linear in the text: a 200,000-character title; 2,000 participants; a text made only of one repeated character of a no-space script. (Known and listed, do not report: many names sharing one first character — FR-678.)

## Known limits — do not report again
FR-657 and FR-664 (initials "M. Lopez"; a middle name in the text but not in the record; inflected forms; look-alike letters of another alphabet; small capitals; several layers of percent-encoding; punycode); FR-677 (offering a likely pair of participants to merge); FR-678. If you think one of them is in truth Critical or Important, say so with the evidence.

## Rules for you
Probes next to the code, named `*.probeFRA10c.test.ts`, run alone at `nice -n 10` (`pnpm --filter @ao/core exec vitest run <path>`; `@ao/library` likewise), every one deleted before you finish; `git status --short` empty at the end; no commits, no `git stash` (one list shared by every worktree), no installs, no whole suites. The machine is heavily loaded: a time-limit failure is re-run alone before you believe it, and the known timing tests ("linear in the text" and the like) failing at this load are not findings.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FRA10-review3.md`, as the common brief says. Final message of at most 150 words.
