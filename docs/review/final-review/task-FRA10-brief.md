# Task FR-A10 — one rule for matching a participant's name (CRITICAL; Rulings R378 a, R379)

Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`. Report: `task-FRA10-report.md`. Common brief first: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-common.md`.

## What is wrong (review: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-wb1-review.md`, findings C1, I1, I2 — read them, with their probes)
A project can require that research participants appear only as codes ("P-001"). Two functions of `packages/core` replace a participant's name by its code inside free text:
- `scrubText` and `urlNamesParticipant` in `packages/core/src/citation/csl-map.ts` — for titles and addresses in citations and bibliographies (Ruling R88: "never a printed name"; read it: `grep -n -E "Ruling R88\b|^R88\b" …LEDGER.md …LEDGER-INDEX.md`);
- `pseudonymize` in `packages/core/src/naming.ts` — for a source's FOLDER name and an export's file names (R23, R32: folder names stay readable even in an encrypted project).
They do not agree with each other, and each misses names:
- **C1** — both match whole "words" only. Chinese, Japanese and Thai are written without spaces, so a name joined to the next characters is never replaced: participant `王小明` → the title `王小明访谈录` stays (in the citation AND in the folder name); `山田太郎さんへのインタビュー` likewise.
- **I1** — `pseudonymize` folds only case and NFC; the citation scrubber also folds accents and width. With the stored name "Lucía Fernández": "Entrevista a Lucia Fernandez" stays in the folder name; "ＬＵＣÍＡ talks" stays; `lucia_cocina` stays when the map has `lucia.cocina`.
- **I2** — a participant who is in the name map but is not a creator of the source is replaced only in the exact word order: "Lopez, Maria: her life; and LÓPEZ MARIA" stays in a title; addresses with `Maria%20Lopez`, `maria+lopez`, `lopez-maria` are kept.

## What to build
ONE rule for "this text names this participant", in one place in `packages/core`, used by BOTH functions (and by `urlNamesParticipant`):
1. **Folding:** case, accents (NFKD, combining marks dropped; the transliteration `csl-map.ts` already does), full-width and other compatibility forms — the same in both functions. Reuse `csl-map.ts`'s `fold`/`normName`; move them to a shared module if needed.
2. **No-space scripts:** when a name (after folding) contains characters of a script written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar — `packages/core/src/verify/evidence.ts` already has `NO_SPACE_SCRIPT` and `hasTokens` for exactly this: reuse them), it is matched as a SUBSTRING of the text, not as a whole word. For other scripts whole-word matching stays (a name "Ann" must not be replaced inside "Annual").
3. **Word order (titles and other free text):** a map entry of two or more words also matches in reversed order and as "Family, Given" (any single comma or white space between the parts); case and accents folded.
4. **Addresses:** `urlNamesParticipant` treats white space (a decoded `%20`), `+`, `-`, `.`, `_` and no separator alike, in either word order; the address is decoded safely first (a malformed escape must not throw: test it).
5. Keep what already holds: creators are coded and fail closed as now; a citation key is not copied when a participant is involved; nothing that is replaced today stops being replaced; whole-word names in Latin script are not matched inside longer words. Do not change the signature of any exported function; callers in `packages/library` must compile and pass unchanged.
6. Linear in the text's length for a fixed map: a title of 100,000 characters with a map of 500 names is handled in well under a second (a test with the bound the neighbouring tests use). No regular expression built from a name without escaping it.

## Tests first (in `packages/core`, beside the existing tests of the two functions; each seen to fail first)
Every example above, through BOTH `toCslItem`/`scrubText` and `pseudonymize` (the reviewer's probes: `toCslItem` of an interview with map `王小明 → P-001` gives a title without `王小明`; `pseudonymize("王小明访谈录", map)` replaces it; the three I1 strings; the I2 title and the three addresses). Negative cases: "Annual report" with a participant "Ann"; "Marianne" with "Maria"; a Latin name is not matched inside a longer Latin word; a no-space-script name of one character is NOT matched as a substring (too short to be a name on its own — match it only as a whole run; say so in the comment). The map built as `packages/library/src/repo/sources.ts` (about line 482) and `export/bibliography.ts` (about line 95) build it — read them, and add one test in `packages/library` showing a source's folder name and its bibliography entry agree for one no-space-script participant and one accented one.

## Verify
Core's and the library's whole suites, the type-check (see the common brief). Also run, without changing them: `pnpm --filter @ao/library exec vitest run src/export` and `src/repo`.
