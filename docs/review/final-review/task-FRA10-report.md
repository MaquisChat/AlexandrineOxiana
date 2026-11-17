# Task FR-A10: report (one rule for matching a participant's name; R378 a, R379)

Status: DONE_WITH_CONCERNS (one question for the coordinator, Korean; see the end).
Branch `fr-a10-names`, worktree `.claude/worktrees/agent-a45f6da14291d4e55`. Commits:
- c0ce773 fix(core): one participant-name rule for citations and folder names (C1, I1)
- eeb2c92 fix(core): either word order, addresses with any separator (I2)
- 3361118 test: linear bound, and folder name and bibliography agree (core + library)

## What changed
- **New `packages/core/src/participant-names.ts`**: the single rule. It is not exported from the package index; `normName` is still re-exported through `citation/index.ts` as before.
  - `fold` / `words` / `normName` (:30, :38, :44) moved here from csl-map.ts and are otherwise unchanged, with two additions:
    - a final sigma folds to σ, because folding one character at a time cannot tell that a sigma is final;
    - `normName` joins words of a no-space script without a space, so "山田 太郎" = "山田太郎" (needed so that a creator with family 山田 and given 太郎 is coded by the map key 山田太郎).
  - `tokenize` (:118) folds the text one code point at a time and keeps each folded unit's span in the original text. A combining mark goes into the span of the letter before it, so "josé" is replaced as a whole. Each character of a no-space script (`NO_SPACE_SCRIPT` from verify/evidence.ts, reused) is a unit of its own; other letter and digit runs are whole words.
  - `patterns` (:174):
    - each form, plus every rotation ("Family, Given", e.g. "Fernández Ruiz, Lucía"), the full reverse, and the joined form of each;
    - indexed by first unit, longest first;
    - the bare-short-name floor (`bareMinLength`) is applied here.
  - `findAll` (:217) scans left to right with a map lookup per unit, so it is linear in the text for a fixed map. No regular expression is built from a name.
  - A name of ONE no-space-script character matches only when it stands alone, not touching another such character (comment at the top of the file and in `findAll`).
  - `scrubNames` (:246): an "@" in front goes with the name, as before. `namesAny` (:261).
  - `urlNamesAny` (:283):
    - `safeDecode` decodes only runs of valid `%XX` escapes; for a malformed run it decodes the ASCII escapes and leaves the rest as written, so it never throws;
    - the address is decoded up to 3 times (for double encoding), and "+" is read as a space;
    - letters and digits are split ("lopezmaria2024", which keeps the old rule that a digit may follow);
    - no length floor.
- **`citation/csl-map.ts`**: the header comment is updated.
  - `scrubText` (:192) = `scrubNames(text, forms, { bareMinLength: 4 })`, the same bare-name rule as before.
  - `urlNamesParticipant` (:200) = `urlNamesAny`.
  - Creator coding, failing closed, and the citation key are unchanged.
- **`naming.ts` `pseudonymize`** (:193): the signature is unchanged and it still returns NFC. Map keys become forms through `words()`, with no bare floor (as before, every map key is used), and the matching is done by `scrubNames`. The old regular expression, `escapeRe` and the "matched handle has no mapping" throw are gone.
- No caller in `packages/library` changed.

## Tests (all written first)
- `packages/core/src/naming.test.ts`:
  - :362 "pseudonymize: the participant-name rule shared with citations" (C1, the one-character rule, the three I1 strings, and the negatives Ann/Annual, Maria/Marianne, Rose/Rosemary) failed first: C1 and I1 failed; the negative and one-character cases passed, as expected.
  - :400 word order (I2) failed first.
  - :408 linear bound (< 1000 ms; there is no neighbouring timing test in core, so I used the brief's "under a second") passed on its first run. It guards the bound and shows no defect.
- `packages/core/src/citation/citation.test.ts`:
  - :471 C1 through `toCslItem`:
    - the reviewer's probe 王小明访谈录;
    - 山田太郎さんへのインタビュー with family/given;
    - a map entry that is not a creator;
    - the one-character rule.
    The two C1 tests failed first. The I1 strings through citations passed at once: the citation scrubber already folded, and the finding was about `pseudonymize`.
  - :513 I2:
    - the title "Lopez, Maria: her life; and LÓPEZ MARIA";
    - 3-word rotations;
    - the addresses %20, +, lopez-maria, lopez_maria, lopezmaria2024, encoded accents with %2B, double-encoded %2520;
    - a negative (marianne-lopezia kept);
    - a malformed escape does not throw;
    - a CJK name in an encoded address.
    These failed first (4 of 4 tests).
  - :755 linear bound with a 100,000-character address, through toCslItem. It passed first.
- `packages/library/src/export/bibliography.test.ts:157`: in an encrypted pseudonymising project, a 王小明 source and a Lucía Fernández source (title "Entrevista a Lucia Fernandez") give folder names `… P-001访谈录 …` / `Entrevista a P-002`, and the bibliography gives the same codes in the same titles.
  - I saw it fail against the old core files: "folder … not to contain 王小明".
  - It uses type `book`, because APA and Chicago give a recorded interview no reference-list entry (the bibliography came out empty for type interview).
- **Existing tests changed** (both asserted the old, narrower matching that the unified rule replaces):
  - `naming.test.ts:217`: `pseudonymize("x@maria.cocina")` was expected unchanged; it is now `"xP-014"`, the citation rule, where "@" goes with the name.
  - `naming.test.ts:319`: "does not match a handle followed by a combining mark" (`@josé` with key `@jose` kept) is now "folds accents …" (→ `P-001`; `@josés` is still kept).

## Built differently from the brief
- `hasTokens` itself is not called. Its semantics (a no-space-script character as a boundary, whole Latin words) are carried by the unit tokenizer, because the matcher needs spans to replace, not a yes/no.
- Kana voicing marks are folded away, as the existing `fold` did (バ = ハ). This over-matches slightly, which is the fail-safe side. I kept it so that creator coding does not change.
- Words may be separated by any non-letter characters, not only a single comma or space. This is the existing scrubText behaviour, and it is a superset of the brief's rule.

## Runs (all at nice -n 10)
- core touched files: `vitest run src/naming.test.ts src/citation/citation.test.ts`: Tests 113 passed (113)
- library touched file: `vitest run src/export/bibliography.test.ts`: Tests 10 passed (10)
- core whole suite (`pnpm --filter @ao/core exec vitest run`; core has no `test` script): Test Files 14 passed (14), Tests 677 passed (677)
- library `vitest run src/export src/repo`: Test Files 32 passed (32), Tests 615 passed (615)
- library whole suite `pnpm --filter @ao/library test`: Test Files 106 passed | 1 skipped (107), Tests 3718 passed | 5 skipped (3723)
- `pnpm -r typecheck`: every package Done, no errors
- `git status --short`: empty

## Needs the coordinator's ruling
- **Korean (Hangul)** is not in `NO_SPACE_SCRIPT` and is written with spaces. But Korean particles attach to names ("김민수의 인터뷰", "김민수씨"), so such a name is still not replaced there (whole-word rule). Should Hangul names also match as a prefix of a word, or as a substring? I did not decide this.

## minor (deferred)
- minor (deferred): a no-space-script name of 2+ characters (for example a given name 小明 that sources.ts adds as a map key) is replaced wherever those characters occur. This over-scrubs ordinary words, which is the fail-safe side the brief chose.
- minor (deferred): an address is matched only on whole folded units; a partly joined three-word slug ("luciafernandez-ruiz") is not found, as before.
- minor (deferred): kana voicing marks are folded (see above).
- Nothing here needs a real Mac or a network service.

## Round 2 (R380)
Commit a09a97e, fix(core): Korean particles and honorifics.

- **`packages/core/src/participant-names.ts`**:
  - **Header:** two lines added, the Korean rule and the limit: "inflected forms in Latin script ("Marian", "Marias") are not matched (FR-657)".
  - **Pattern flag `prefix`:** set when the pattern's last unit is all Hangul and the whole name has at least 2 syllables.
  - **Matching (`matchEnd`):** the last unit may match the start of a token when two things hold (`hangulPrefixOf`):
    - the rest of the token is all Hangul;
    - the rest begins on a new syllable, that is, with a choseong after NFKD.
    So "김미" is not taken at the start of "김민".
  - **Where the code ends:** the replaced span ends at the prefix's original offset (`origEnd`), so the particle stays after the code.
  - **One-word names inside a longer token:** they are found through a second index of the token's prefixes that end on a syllable boundary, longest first. The tries are capped at the longest such name, so the scan stays linear.
  - **Where it applies:** `scrubText`, `pseudonymize` and `urlNamesParticipant` all go through this one matcher, so it applies to addresses that hold Hangul after decoding.
  - **Never matched:** in the middle or at the end of a run. "박김민수" is a compound, or another person's name with this one inside it, and is kept.
- **Choice made for an ambiguous point:** for a name of several words, the allowance holds on the last word when the WHOLE name has at least 2 syllables. So "김 민의" is matched by "김 민", because the name is 2 syllables in all even though the last word is 1. This is the safe side. If the ruling meant that the last word itself must have 2 syllables, this needs a one-line change.
- **Tests, each seen to fail first** (4 tests failed before the change; the negative tests passed):
  - `naming.test.ts`, "pseudonymize: Korean particles and honorifics (R380)":
    - 김민수의 인터뷰, 김민수씨와의 대화;
    - the negatives: middle, end, one syllable, "김미" against "김민";
    - "김 민수의" written apart, and "김씨 민수" kept;
    - Marianne and Marias kept.
  - `citation.test.ts`, "R380: …": the two strings through toCslItem, the negatives, a creator's own title, and an address holding encoded Hangul.
  - `naming.test.ts`, the linear bound with Hangul (a 50,000-character run plus 50,000 characters of short runs, 500 Hangul names, under 1000 ms). It passed on its first run; it guards the bound.
- **Guide:** `docs/first-run.md` has no paragraph about participant codes, so nothing was added to it.
- **Runs:**
  - touched files: 121 passed (121);
  - core whole suite: Test Files 14 passed, Tests 685 passed (685);
  - library `src/export` and `src/repo`: Test Files 32 passed, Tests 615 passed (615);
  - `pnpm -r typecheck`: no errors;
  - `git status`: empty.

## Round 3 (R387)
A fresh implementer, branch `fr-a10-names`, from a09a97e. Six commits, one per point:
- a03f129 (a) invisible characters
- 8931640 (b) one forms function
- 83c77b8 (c) the lone-name floor by script
- 3ed638e (d) one list of participant names in the library
- fb861fe (e) partial names
- b1fa2c0 (f) M1, M2, M3, M5, M6

Every new test was written first. I saw each fail for the right reason before the change, except where noted.

### (a) C1: invisible characters
- **Fold:** `participant-names.ts:56` `IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu` is removed first in `fold` (:61), before transliteration and NFKD.
- **Tokenizer:** it already gave a character that folds to "" to the word around it, so the name is one word again and its whole span, invisible characters included, is replaced.
- **"@" goes with the name:** `scrubNames` also takes an "@" and invisible characters just before the name into the span, so a bidi-wrapped handle `⁨@maria.cocina⁩` becomes `P-005`.
- **Bidi overrides:** `overrideHits` (:417) reads the content of an LRO/RLO override (up to PDF, a new line or the end) also in reverse, by grapheme. A name found there is replaced over the original characters, so `‮airaM‬` is replaced too. This went beyond the review's direction, which covered folding only; the review counted the RLO string as part of C1.
- **Hangul fillers (decision):** U+115F, U+1160, U+3164 and U+FFA0 are folded away like every other default-ignorable character.
  - Why: NFKD of a written syllable never yields a filler, so the Korean rule (R380), which reads syllables from NFKD, never needs one.
  - A filler typed inside a name ("김ㅤ민수") must not split it. Tested: `김ㅤ민수의` and `김ﾠ민수` become the code.
- **Tests:** `naming.test.ts` "R387 (a)" (5 tests) and `citation.test.ts` "R387 (a)" (4 tests); 9 of 9 failed first. They cover:
  - every string of the C1 probe through `pseudonymize`, `sourceFolderName` and `toCslItem`. The folder name is exactly `2026 P-002 - Entrevista a P-002 [ab12]` and holds neither "Luc" nor "Fern";
  - the address `Ma%C2%ADria-Lopez`;
  - Devanagari with a ZWJ;
  - Persian with a ZWNJ, in both directions;
  - a bidi-wrapped handle;
  - a creator whose given name holds a soft hyphen.

### (b) I1: one function makes a name's forms
- **`nameForms(name | creator, code, bare)`** (`participant-names.ts:129`, exported from the core index with `creatorNameTexts`, `CreatorName` and `NameForm`):
  - the name as written, its rotations and reverse made from the words AS WRITTEN, and each order joined;
  - for a creator, the forms of each of its name texts.
- **Callers:** `csl-map.ts` (map entries and coded creators) and `naming.ts` both use it; neither builds forms itself. `patterns()` only indexes the forms now.
- **Tests:** "R387 (b)" in both files (`山田 太郎`/`太郎山田さん`, `王 小明`/`小明王`, `太郎 山田`/`山田太郎さん`). The citation test failed first; the folder name already did it.

### (c) I2: the lone-name floor by script
- **The rule:** `standsAlone` (:332) gives a no-space script 2 characters, Hangul 2 syllables, other scripts `bareMinLength` (4). It applies only in citations (`scrubText`, `bareMinLength: 4`).
- **The folder name:** `pseudonymize` keeps "every map key, any length", as at base 7b81976, where the old regular expression replaced every key as a whole word.
- **Header comment:** states the one ruled difference.
- **Tests:**
  - citation: 小明的故事 and 王老师和小明 failed first;
  - also passing: 太郎の話; 王老师的课 kept (a one-character family name); Hangul 민수 replaced and 민 kept; "Li family history" kept;
  - folder: the same strings, and "Li family history" becomes `P-003 family history`.

### (d) I3: names kept only in the fieldwork details
- **`participantNames(map, participants, creators?)`** (`packages/library/src/repo/pseudonyms.ts:49`, with `NAME_KEY` moved there): the pseudonym map, the participants' name details, and the coded creators' `creatorNameTexts`.
- **Callers:**
  - `repo/sources.ts:470-480`: the folder map. It now reads the details from `readFullData`, which it already called.
  - `export/bibliography.ts`: `participantRules` keeps its name and signature; only its inside changed.
- **Test:** `bibliography.test.ts` "R387 (d)". A participant whose full name is only in the details, and a source about her by another author, in an encrypted pseudonymising project. The folder name and the bibliography hold `P-001 habla` and no part of the name. It failed first; the folder held the plain name.

### (e) I4: partial names
- **Runs of words:** `nameForms` gives a name of 3 to 10 words every run of 2 or more of its words, in order, with the same rotations and joins.
- **Family words:** `creatorNameTexts` gives each word of a family name of several words as a bare (lone) family name: under the floor in citations, any length in folder names.
- **Built differently from the ruling: one guard.** A run is not a form when EVERY word in it is shorter than a lone name may be (R88's floor by script). Otherwise "de la" of "Juan de la Cruz" would blank "Historia de la ciudad". **Needs the coordinator's ruling** (see the end).
- **The 10-word cap:** keeps the number of forms bounded. The review's 200-word name gets no runs.
- **Tests:**
  - core: "R387 (e)" in both files (4 failed first);
  - library: "R387 (e)", a creator {Lucía, Fernández Ruiz}, title "Entrevista a Lucía Fernández y Ruiz habla". The folder name and the bibliography give `Entrevista a P-001 y P-001 habla`. It failed first: the folder kept "Ruiz".
- **"Siti binti Ahmad" → "Siti Ahmad":** not covered, because a part dropped from the middle is not a run. A stated limit, with a test that shows it is kept.
- **Limits in the header:** initials, a middle name not in the record, a part dropped from the middle, an order that is neither a rotation nor the reverse, and names over 10 words.

### (f) Minor points
- **M1:** `patterns` indexes every exact form before any variant (:370).
  - Tests: Maria Lopez/Lopez Maria and Ann Marie/Annmarie, in both map orders, through both functions. In a citation, a creator "Lopez Maria" is coded P-002 and the title says P-002.
  - Failed first.
- **M2:** a name map's forms, index and `normName` keys are cached by the map's identity (`cacheOf`, `mapKeys` :499).
  - The cache is checked against the map's entries on every call (O(entries) reference compares), so a map changed after use is read afresh. A test shows this.
  - `NameSet {map, forms}` lets `toCslItem` pass the cached map plus the source's own creator forms. The map wins on equal length.
  - Timings (load average 33–42):
    - `pseudonymize`, 20 calls with 20,000 three-word names: before, 143.8 s in all (7.2 s per call); now 3 ms per call after one build of 14.0 s;
    - `toCslItem`, 5,000 names: the review gave 430 ms per call; now 1.5 ms per call after one build of 5.3 s.
    - The one build is slow because three-word names now have their runs (e).
  - Tests: 5,000 names in both files. Each has a 120 s test time-out for the one build, and its own time limit around the calls only (1000 ms for 20 folder names, 3000 ms for 200 citations).
  - The brief's linear bound tests still hold when run alone; see the runs.
- **M3:** four tests, each seen to FAIL with its guard removed (removed one at a time, then restored):
  - the choseong check in `hangulPrefixOf` ("김 미" in "김 민의");
  - the final-sigma fold (ΝΙΚΟΣ/Νίκος);
  - `safeDecode`'s ASCII fallback (`%4D%61%72%69%61%E0%A4`);
  - the mark span (NFD "Habla Luciá").
- **M5:** tatweel folds to nothing; katakana folds to hiragana, after NFKD, so half-width forms are included. Tests in both directions. Failed first.
- **M6:**
  - `normName` joins Hangul words. So `toCslItem` of a creator `{family:"김", given:"민수"}` finds the key `김민수` and prints P-001, where before it threw `ParticipantCodeMissingError`.
  - A one-word Hangul name also matches written apart at each syllable boundary, with its rotation (no joined forms there, to keep the index small).
  - `assignCodes` (`pseudonyms.ts:99`) finds an existing key by `normName`. A key with no letters or digits is still compared lowercased, as before.
  - Library test: "Lucía Fernández" then "LUCIA Fernandez" give one participant and one code. Failed first (P-002).
  - **Needs the coordinator's ruling:** `normName` also drops "@" and punctuation, so `@maria.cocina` and "Maria Cocina" are now the same participant in `assignCodes`, as they already were in citations (`codeFor`).
- Existing tests of rounds 1 and 2: none changed. The `assignCodes` tests are unchanged too; there are none of its own.

### Incident (no lasting harm)
I used `git stash` to show a library test failing without one change. The stash stack is shared by every worktree of the repository. My `stash pop` took another agent's stash: branch `fr-a17-find-not-fetched`, holding `packages/library/src/find/runner.ts`, pushed at 07:48:27.
- I found it as a dangling commit (816e3e14), put it back on the stack with `git stash store` under its original message, and removed its change from my worktree.
- `git stash list` again shows it as `stash@{0}`, and my worktree held none of it.
- The other agent's `git stash pop` will find it. If that agent popped during the minutes it was missing, it found nothing.
- I used no stash after this.

### Runs (all at nice -n 10; load average 30–42 throughout)
- R387 tests, both core files: 35 passed.
- `src/export/bibliography.test.ts`: 13 passed.
- Core whole suite: 714 passed, 6 failed, all on time limits:
  - 4 or 5 tests of "rendering with the bundled styles" hit the 5 s time-out. One of them failed the same way with my changes removed, so it comes from the load.
  - The two linear-bound tests, 1299 ms and 1860 ms against 1000 ms in the full parallel run. Re-run alone they passed: Latin 303–401 ms; Hangul 603–691 ms after a small reduction of the Hangul forms (round 2 measured about 500 ms here).
- Library whole suite (`pnpm --filter @ao/library test`): Test Files 6 failed | 100 passed | 1 skipped (107); Tests 13 failed | 3708 passed | 5 skipped (3726).
  - Every failure is a time limit, in a file this round does not touch: capture/html-strip, extract, index/annotations-cap, import/refman, import/zotero-local, lookup.
  - Those 6 files re-run once alone, at load 43: 28 failed | 332 passed, all time limits again (the machine was more loaded than before).
  - Every test of export/ and repo/ passed.
- `pnpm -r typecheck`: every package Done, exit 0.
- `git status --short`: empty.

### Needs the coordinator's ruling
1. (e) The guard that a run of particles only ("de la") is not a form. If the ruling meant every run without exception, take out the `run.some(standsAlone)` condition in `nameForms`.
2. (M6) `assignCodes` now folds as `normName` does, which also joins a handle with the same words written as a name.

### What only real use can show
Nothing here needs a Mac or a network service. How often these characters and shapes occur in real titles is a judgement.

### minor (deferred)
- The first build of a very large map is slow: 5,000 three-word names take about 5 s under load. Real maps are small.
- `export/project-export.ts` still pseudonymises export file names with the pseudonym map alone (it does not use `participantNames`). The names it renames are folder names that are already coded. That file belongs to FR-A14 now.
- The module header's "Folding" bullet does not repeat what `fold`'s own comment says (invisible characters, tatweel, kana).
- LRO/RLO handling reverses by grapheme and ignores nested embeddings.

## Round 4 (R403)

Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, b1fa2c0..7315970. I did not use `git stash`.

### (a) C1: an invisible character is both nothing and a boundary (commit bd11ecf)
- `packages/core/src/participant-names.ts` `tokenize` (:268): still ONE pass. A default-ignorable character inside a run of letters ends the unit before it, and marks the next unit `soft`. The character is in neither unit's span. A combining mark still extends the letter before it. Between two no-space-script characters, an ignorable still keeps them glued: a one-character Han name stays "not a run of its own", as in round 3.
- `findPlain` (:580):
  - Tokens joined by soft boundaries form one word (`wordEnd`, `hangulRest`).
  - A unit may be read across soft boundaries (`unitEnd`), and a match may begin at any token. Each token starts at a word start or at a soft boundary.
  - First units are looked up as the concatenation of tokens up to the index's `maxFirst` length. This keeps the scan linear.
  - The Hangul prefix rule (R380) reads across soft boundaries (`hangulPrefixEnd`, which replaces `hangulPrefixOf`).
  - The longer match wins: the later end, then more words, then the first found / first index.
- `origEnd` no longer takes trailing invisible characters into the span.
- `scrubNames` no longer swallows invisible characters before a name. An "@" still goes with the name. The brief's rule is "the span is the name with the invisible characters inside it, not those at its edges".
- Tests:
  - `naming.test.ts` "R403 (a)…": the review's six rows through `pseudonymize` and `sourceFolderName`; ⁨Maria⁩⁨Lopez⁩ with two entries gives the folder `P-001P-002`; Marianne / Anabel kept; Ana​bel with Anabel / Ana / Ana only (with the "price" comment); the edge span.
  - `citation.test.ts` "R403 (a)…": the six rows through `toCslItem().title`; a creator's own name; the address `Luc%C3%ADa%E2%80%8Bhabla` (URL dropped); Ana​bel; Marianne.
  - All of these failed first, except the two Marianne/Anabel negatives, which already held.
  - Round 3's inside-the-name cases (soft hyphen, ZWSP, ZWJ, WJ, LRM, BOM, MVS, bidi embeddings, क्‍षमा, علی‌رضا, Hangul fillers, the RLO case) pass unchanged.
- **Expectations changed (two tests):**
  - `naming.test.ts` "R387 (a) … a Devanagari conjunct with a ZWJ, a Persian name with a ZWNJ, a bidi-wrapped handle";
  - `citation.test.ts` "R387 (a) … Devanagari with a ZWJ, Persian with a ZWNJ against the entry without it, a bidi-wrapped handle".
  - In both, `Video by ⁨@maria.cocina⁩` now gives `Video by ⁨P-005⁩` (it gave `Video by P-005`). The isolates at the handle's edges stay, as the brief's span rule says. The folder sanitiser strips them anyway.
- Cost, by count and doubling (not by a limit):
  - `"ma​"` and `"x​"` × 50k/100k/200k/400k took 1.2/2.1/4.7/9.8 s at load ~45: linear.
  - A min-of-8 bench of the two existing 100k-character inputs, old code against new: Hangul 168 vs 187 ms, Latin 21 vs 37 ms.

### (b) I1: identity is strict (commit aba8fc2)
- `packages/library/src/repo/pseudonyms.ts` `identityKey` (:99), beside `assignCodes`:
  - NFKC, `toLowerCase`, default-ignorables removed, white space collapsed and trimmed;
  - a space between two no-space-script characters, or two Hangul characters, removed;
  - accents, voicing marks, "@" and punctuation kept.
- The comment says why it is NOT `fold`. `lookup` (:127) uses it, and `normName` is no longer imported there.
- The no-space script set is copied from core's `NO_SPACE_SCRIPT`, which core does not export. I did not change core's exports.
- Tests (`bibliography.test.ts` "R403 (b)…", encrypted pseudonymising project, one source per creator in turn):
  - Lê Thị Hương / Hường, Ana Peña / Pena, @maria / María, ハナコ / バナコ, @maria.cocina / Maria Cocina: two participants, each source linked to its own. All five failed first.
  - Case only, two spaces / one, 김 민수 / 김민수, 山田 太郎 / 山田太郎: one participant each.
- **Expectation changed:** "R387 (M6): a creator written without accents is the participant already coded with them (assignCodes folds)" is renamed "R403 (b), changed from R387 (M6): … a participant of her own" and now expects two participants with different links.
- The Hangul written-apart test of round 3 is in core (`naming.test.ts` M6) and is unchanged. Round 3 had no library test for it, so I added one (김 민수 / 김민수 → one). A {family 김, given 민수} creator's `creatorKey` is "민수 김" (given first), which matches neither "김민수" nor "김 민수". It did not under R387 either.

### (c) I2, M1: a part of a name only when it could be a name by itself (commits 5842064, 7b402cc)
- `creatorNameTexts` (:188): a family word is added only if `standsAlone(w, 4)`.
  - The family name as a whole and the given name stay at any length. This is exactly base 7b81976's `sources.ts` list: handle, bare handle, literal, family, given, "given family". The bare handle is covered by the "@" rule.
- The run guard (:152) is now `filter(...).length >= 2`.
- Tests:
  - `naming.test.ts` / `citation.test.ts` "R403 (c)…": `creatorNameTexts` for {Juan, de la Cruz}, {Jan, van der Berg}, {Lucía, Fernández Ruiz}, {Li, de la O}.
  - Kept: Maria de Lopez in "Ave Maria de Guadalupe" and "Calle de Lopez"; Juan de la Cruz in "la Cruz Roja" and "San Juan de Dios"; Jan van der Berg in "Der Berg ruft".
  - Still replaced: "Lucía Fernández", "Fernández Ruiz", and Fernández and Ruiz alone.
  - `bibliography.test.ts` "R403 (c)…" (library, folder and bibliography). The folder name and the bibliography both give "Historia de la ciudad y la P-001 Roja" and "Der P-001 ruft van Gogh" (sensible: only Cruz / Berg coded), and "P-001 habla y P-001 calla".
  - All failed first, except the Fernández Ruiz row.
- **Expectation changed:** `naming.test.ts` "R387 (e) … a run made only of short particles is not a name ('de la' of 'Juan de la Cruz')". "Juan de la ciudad" and "la Cruz del sur" are now kept (they gave `P-002 ciudad` and `P-002 del sur`).
- 7b402cc only fixes the type of a test helper.

### (d) M3: mergeHits in one pass (commit 7315970)
- `overrideHits` (:443) adds each override's hits in reverse, so the list is sorted by start. `mergeHits` (:486) walks both sorted lists once. It is exported (with `Hit`) for its test only; core's index is unchanged.
- Test `naming.test.ts` "R403 (d)…": hits whose start and end count their reads.
  - Under the old code the ratio for doubled input was 3.997, so it failed first (run at 1k/2k/4k; 10k+ did not finish in minutes).
  - Now the ratio is under 2.2.
  - Plus a correctness case, and RLO + "airaM " × 2,000 → 2,000 codes.

### Runs (nice -n 10, load 38–50)
- Core whole suite: 742 passed, 4 failed. All four are "rendering with the bundled styles" tests (5 s timeouts) in a file whose rendering code I did not touch.
- Speed-limit tests: "pseudonymize: linear with Hangul names (R380)", "pseudonymize: linear in the text" and "toCslItem: linear in the title" fail now and then at >1000 ms. **The unchanged b1fa2c0 code fails the same tests alone at this load** (1308–1735 ms), and the bench above shows the new code on par.
- Core type-check: clean.
- Library and `pnpm -r typecheck`: see below.

### For the coordinator
- **Strict identity, folded display:** with strict identity, two participants whose names fold alike (Ana Peña P-001, Ana Pena P-002) are still told apart nowhere else.
  - `toCslItem`'s `codeFor` finds a creator's code through `mapKeys`: folded, first entry wins.
  - A title is scrubbed with forms deduplicated by folded words.
  - Probe: `mapKeys` gives "ana pena" → P-001, and `pseudonymize("Entrevista a Ana Pena", map)` → "Entrevista a P-001".
  - So Ana Pena's citation, and the title in her folder name, show P-001, while her participant and the folder's creator part are P-002.
  - No name leaks, but codes are shown for the wrong person. R403 does not cover it. Fixing it means codeFor trying the strict key first and an exact-form priority in the forms. Needs a ruling.

minor (deferred): the brief's no-space glue across an ignorable is kept, so a one-character Han name next to "王​小" is still not alone. On a tie between "Maria Lopez" (P-001) and "MariaLopez" (P-002) over "Maria​Lopez", the two-word form wins.
- Library whole suite (`pnpm --filter @ao/library test`): 3718 passed, 15 failed, 5 skipped.
  - All 15 failures are speed or time limits in files I did not touch: the N5 search budget, R161 annotation indexing, the stripHtmlSnapshot pre-scan and its worker queue, OPF/BibTeX/RIS/CSL-JSON/Zotero linear parsing, the R75/R77 adapter floods, and one 5 s timeout. The load was 40–50.
  - `src/export/bibliography.test.ts`, run alone: 22/22 passed after (b). Its R403 (c) cases passed after (c).
- `pnpm -r typecheck`: all nine packages Done.
- `git status --short`: empty. Head 7315970.

## Round 5 (R416)

Commit 231286f, on 7315970. I did not use `git stash`.

### What changed
- **`identityKey` moves to core.** It now lives in `packages/core/src/participant-names.ts` and is exported from `@ao/core`. The library's `pseudonyms.ts` imports it and keeps the "why not fold" comment beside `assignCodes`.
- **Each form carries its strict forms.** `nameForms` and `ordersOf` give every `NameForm` two new optional fields:
  - `strict`: the form's strict words in the form's order, run together (rotations and runs are permuted the same way; the split Hangul variants are aligned by syllable);
  - `full`: `identityKey` of the name as written.
- **Candidates are kept per pattern.** In `patterns`, each folded pattern keeps its candidates, and `mixed` is true when they hold more than one code.
- **The code is chosen at the match.** At a match on a `mixed` pattern, `exactCode` compares in this order:
  1. the `identityKey` of the span (with an "@" in front, as the span takes it) against each candidate's `full`;
  2. the span's strict letters against each candidate's `strict`;
  3. otherwise the first candidate, which is the folded match as before.
  - The index is still built once per map. For a single code, the extra work per match is one flag test.
- **A creator's code.** `csl-map.ts` `codeFor` uses the new `mapCode(map, text)`. For each form, the strict key is tried first, then the folded key. Both key maps are built once per map.
- **Addresses: nothing changes.** `urlNamesAny` only tests whether an address names a participant, so which participant it names does not matter (said in its comment).

### Tests (all failed first, except Lucía, which already held)
- `naming.test.ts` "R416…": the Peña/Pena pair in both map orders:
  - "ANA PEÑA" → P-001;
  - a soft hyphen inside "Ana Pena" → P-002;
  - "Pena, Ana" → P-002 and "Peña, Ana" → P-001;
  - "Ana Pêna" matches neither exactly, so it gets the map's first code.
  - Also the Hương/Hường and ハナコ/バナコ pairs, and "Lucía Fernández" still replacing "Lucia Fernandez".
- `citation.test.ts` "R416…": both creators and both names in one title. The authors are [P-001, P-002] in both map orders, and the title is coded per span. Also each creator alone, Hường, バナコ, and Lucía.
- `bibliography.test.ts` "R416…": two sources, by Ana Peña and Ana Pena. Each folder name and each bibliography entry carries its own code and not the other's.

### Runs (load ~45)
- Touched files: core 187/187, `bibliography.test.ts` 26/26.
- Core whole suite: 746 passed, 5 failed. The failures are four "rendering with the bundled styles" 5 s timeouts and "pseudonymize: linear in the text" at 1197 ms. That linear test passed in the touched-file run.
- `pnpm --filter @ao/library exec vitest run src/export src/repo`: 631/631.
- `pnpm -r typecheck`: all nine packages Done.
- `git status --short`: empty.

### Unsure
- The strict words are aligned with the folded words by count. If a name's strict and folded word counts differ (an unusual mix of marks or punctuation), that name's forms carry no strict letters. Only the `full` comparison is then possible, and otherwise the folded first candidate decides, as before.

## Round 6 (R420 a)

Commit b9c7cec, on 231286f. I did not use `git stash`. The "## Round 5 (R416)" section is above.

### What changed
- **`packages/core/src/citation/csl-map.ts`:**
  - **`toCslItem` now looks at the creators in two passes.**
    - First pass: every creator's code (`codeFor`, unchanged), the coded creators' forms, and the `requireCodes` error, as before.
    - Second pass: the names. A creator with no code goes through the new `creatorWithWholeNames`, which reads the text `cslName` would print, in this order:
      - for a given/family creator, the joined "given family", else "family given";
      - otherwise the literal, else the handle.
    - That text is read with `scrubNames(text, { map, forms, wholeOnly: true })`. If anything is replaced, the creator becomes `{ literal: <scrubbed> }` and `anyCoded` is set, so the citation key is withheld.
  - Because of the two passes, a coded creator anywhere in the list counts, even after the uncoded one.
  - There is no scan when the map and the coded forms are both empty.
- **`packages/core/src/participant-names.ts`:**
  - `NameForm.part` marks the runs of R387 e.
  - `NameSet.wholeOnly` drops `bare` and `part` forms. Every order of a whole name and its joined form stay, so "family given" is included.
  - The map's whole-only index is cached per map under its own key.
  - R416's exact choice applies, since this goes through the same patterns.
- Titles and the other fields are unchanged.
- `cslName` is the only place in core that turns a creator into text. The library's exports go through `toCslItem`.

### Tests (citation.test.ts "R420 (a)…"; bibliography.test.ts "R420 (a)…")
- **Failed first:**
  - Friends of Maria Cocina → Friends of P-001;
  - Friends of @maria.cocina → Friends of P-001;
  - {Dr. Maria, Cocina} → literal "Dr. P-001";
  - the one-word entry "Friends of Lucía" → P-002;
  - the citation key withheld;
  - 北京王芳文化研究会 → 北京P-003文化研究会;
  - a coded creator's whole forms used by an uncoded creator listed before it, while "Diaz Ruiz Foundation" and "Amigos de Rosa" (parts) stay;
  - Peña/Pena → each its own code;
  - the library's formatted bibliography (apa, chicago-author-date) prints "Friends of P-xxx" and no "cocina". I checked this by putting the old core back temporarily (by file copy) and seeing it fail.
- **Guards that held before:**
  - {Maria, Lopez}, "Maria Lopez Institute" and {Juan, Cocina} stay;
  - an empty map leaves the creator untouched;
  - the key is kept for Juan Cocina.

### Runs (load ~45)
- Core whole suite: 756 passed, 3 failed. All three are "rendering with the bundled styles" 5 s timeouts.
- `pnpm --filter @ao/library exec vitest run src/export`: 247/247.
- `pnpm -r typecheck`: all nine packages Done.
- `git status --short`: empty.

### Unsure
- A given/family creator whose joined text holds a whole name is printed as a single literal, so a style can no longer sort or invert it by family name. This is as ruled.
- A creator whose handle holds a whole name but who also has a literal is read by its literal only, since `cslName` prints the literal.

## Round 7 (R427)

Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, b9c7cec..e74ed5a (four commits, one per point). I did not use `git stash`, and I did not push. To take a guard out I edited the line, ran the test, and restored the file with `git checkout HEAD -- <file>` (the file held no uncommitted work of mine).

### (a) I1: the more exact match wins (commit 1f5b3c3)
- `packages/core/src/participant-names.ts`:
  - `asWritten` (:122) is NFC with the ends trimmed.
  - **Level 1 in `mapCode`** (:676–695), which `csl-map.ts` `codeFor` uses. A new cached `writtenKeys` map (:640) is tried first, then `strictKeys` (`identityKey`), then `mapKeys` (folded). In each map the first entry of a key wins. `mapKeys` itself is unchanged.
  - **Choosing among candidates when names are replaced in text:**
    - `NameForm.written` and `Candidate.written` are set on the form as written only (`ordersOf`, `nameForms` :194).
    - `patterns` keeps it and compares it when deduplicating candidates.
    - `exactCode` (:503–512) first tries a candidate whose `written` equals the span as written (with a leading "@" when the span takes one), then R416's strict choice (`full`, then `strict`), then the first candidate.
- `packages/library/src/repo/pseudonyms.ts`:
  - **The new exported `participantCodeOf(map, key)`** (:97) is the one identity look-up. It tries an entry equal as written (NFC, trimmed), then the first entry equal by `identityKey`. A key with an empty strict key keeps the old as-written, lowercased comparison. It never uses the folded key.
  - `assignCodes`' `lookup` (:122) calls it.
- `packages/library/src/repo/repo.ts` `pseudonymCodeFor` (:1257–1272) calls `participantCodeOf` for each of `names` in turn.
- **Tests:**
  - `citation.test.ts` "R427 (a)…" (:1004). The three pairs ("김 민수"/"김민수", "Ana  Peña"/"Ana Peña", "ＡＮＡ"/"ana") in both map orders: `toCslItem` gives author P-002 for the P-002 spelling and P-001 for the other, and the titles agree. A spelling equal to neither as written but equal to both by the strict key ("김 민 수", "ANA PEÑA", "Ana") takes the map's first entry.
  - New `packages/library/src/repo/pseudonyms.test.ts`:
    - `assignCodes` alone, for the same pairs in both orders: the right code, the right participant id, `changed` false, and no participant made. The strict-only spelling takes the first entry.
    - A real encrypted library. Two participants are made, then the pseudonym map is rewritten (encrypted with the project key) holding both spellings, the way the old code would have left it. `pseudonymCodeFor` gives P-002, P-001 and the first entry, each equal to `assignCodes`' answer. New sources by each spelling link to their own participant's id, and the count stays at 2.
- **Seen to fail first:**
  - Core authors: "expected P-001 to deeply equal P-002" for all three pairs.
  - After the `mapCode` change, before the candidate change: the titles of "Ana  Peña" and "ＡＮＡ" failed ("Entrevista a P-001" vs "…P-002"; "P-001 habla" vs "P-002 habla"). The Hangul title already held, by R416's `full` (as the brief expected).
  - Library: all three `assignCodes` rows failed ("expected ['P-001'] to deeply equal ['P-002']"). All three library rows failed at `pseudonymCodeFor` (old lowercase comparison: undefined for "김 민 수", P-002 instead of P-001 for the other two).
  - The three strict-only rows passed before the change, as they should (the first entry already won). That is said in their names.
- **Behaviour to note:** `pseudonymCodeFor` used to return the first MAP entry matching any of `names`. It now returns the code for the first NAME in the list that finds one. The list starts with the profile's label as written. The profile-capture tests pass (41/41 together with the new file).

### (b) I3: runs inside a creator with no code (commit f302e6d)
- `participant-names.ts`: `NameSet.wholeOnly` is renamed `noSingleNames` (:625–629). `indexesOf` (:700) now drops only `bare` forms. `part` forms (runs of two or more words that pass R403 c, and their joined variants) are kept.
- `csl-map.ts`: `creatorWithWholeNames` comment (:213–222) and `toCslItem` (:319) updated.
- **Tests** (`citation.test.ts` "R427 (b)…", :980):
  - **Failed first:**
    - "Amigos de Lucía Fernández" (author and title) gives "Amigos de P-005", with the key withheld. It failed with the author still printed.
    - `{Lucía, Fernández}` gives the literal "P-005". It failed with the name still printed.
  - **Guards that already held:** `{Maria, Lopez}` against "Maria Cocina", and "Amigos de Rosa" beside the coded "Rosa Díaz" (FR-699).
- **Expectation changed (one test):** round 6's `citation.test.ts` "a coded creator's whole forms…" (:952, renamed "…not its single names (changed by R427 b…)"). "Diaz Ruiz Foundation" now gives "P-004 Foundation", because "Diaz Ruiz" is a two-word run of "Rosa Diaz Ruiz" whose words both stand alone. "Amigos de Rosa" still stays. Every other round 6 test passes unchanged, including the library's R420 a bibliography test (27/27).

### (c) M5: every format character is a soft boundary (commit f45b32f)
- `participant-names.ts`: `SOFT_ONE` and `SOFT` (:47–53) are `[\p{Default_Ignorable_Code_Point}\p{Cf}]`.
  - `fold` drops `SOFT` (:76).
  - `tokenize` (:344) and `origEnd` (:532) test `SOFT_ONE`.
  - The header comment is updated.
- **`identityKey` and `strictWords` are UNCHANGED.** They still remove only default-ignorables, so identity (assignCodes) does not change for names with U+0600–0605 or U+FFF9–FFFB. The brief asked only for the replacing paths. Say if identity should also drop them.
- **Tests:**
  - `naming.test.ts` "R427 (c)…" (:674): `Ma￻ria habla` and `Ma؅ria habla` through `pseudonymize` and `sourceFolderName` (the folder is "2026 P-009 - P-001 habla [ab12]").
  - `citation.test.ts` "R427 (c)…" (:970): the same two rows through `toCslItem().title`.
  - All four failed first: the text was kept as written.
- The cost tests in `naming.test.ts` and `citation.test.ts` (the "linear" ones) passed in every run of this round.

### (d) M8: two library tests (commit e74ed5a)
- `pseudonyms.test.ts` "R427 (d)…" (:90):
  - **First test:** "Ma​ria Cocina" finds P-001 ("Maria Cocina") in `assignCodes`. No participant is made.
  - **Second test:** the key "​ ​" finds its own entry. "⁠ ⁠" (also only invisible characters and spaces) is a new participant, P-002.
- **Each guard taken out, then restored:**
  - Without `identityKey`'s `.replace(IGNORABLE, "")`, the first test failed ("expected ['P-002'] to deeply equal ['P-001']").
  - With `participantCodeOf`'s fallback replaced by `identityKey(k) === n`, the second test failed ("expected ['P-001'] to deeply equal ['P-002']").

### Runs (all at nice -n 10, load about 20–30)
- `pnpm --filter @ao/core exec vitest run src/naming.test.ts src/citation`: `Tests  208 passed (208)`.
- `pnpm --filter @ao/library exec vitest run src/export src/repo`: `Test Files  33 passed (33)`, `Tests  643 passed (643)`.
- `pnpm -r typecheck`: all nine packages Done.
- Core whole package (`vitest run`; core has no `test` script): `Test Files  14 passed (14)`, `Tests  772 passed (772)`.
- Library whole suite (`pnpm --filter @ao/library test`, load about 11): `Tests  1 failed | 3745 passed | 5 skipped (3751)`.
  - The one failure is a time limit in a file I did not touch: `src/import/refman.test.ts` "adversarial inputs: linear parsing … Zotero RDF: many items", at 1306 ms against a 1 s limit.
  - Run again on its own: `Tests  37 passed | 101 skipped (138)`.
- `git status --short`: empty. Head e74ed5a.

### Unsure / for the coordinator
- **(c):** the strict identity key still keeps non-default-ignorable format characters. So "Ma؅ria" and "Maria" are two participants for `assignCodes`, while the replacing treats them as one name. This is the safe direction for identity (no merge), but it is a rule split. I kept it because the brief named only the replacing paths.
- **(a):** `pseudonymCodeFor` now picks by the order of `names`, not by the map's order (see above).
- minor (deferred): none new. I2, M1–M4, M6, M7 and M9 are untouched, and no change of this round alters them. One exception, under (b): runs now also reach the coded creators' forms, so M3's one-word-handle over-scrub (with FR-637) can now also come through a two-word run of the handle's creator's name. That is on the safe side.

## Round 8 (R437)

Commits e74ed5a..5653c26: 10cb4be (a), 5653c26 (b). I did not use `git stash`, and I did not push.

### (a) I1: a run inside a given/family creator counts only across the two fields (commit 10cb4be)
- **`packages/core/src/participant-names.ts`:**
  - A new `ScrubOptions.runSpan(start, end)` (:262–268) lets a caller refuse a RUN by its span. It is only ever asked about a `part` form, never a whole name.
  - `Pattern.part` (:412) is true only when every candidate of the pattern is a run. If one candidate is a whole name, the pattern counts as whole (:473).
  - `findPlain` checks `allowed(p, i, end)` (:799–801) inside the candidate choice (:815, :828). A refused run is therefore never chosen, and a shorter whole name or another pattern at the same token can still win. This is a filter on the matched span. Nothing about how matches are reported changed.
  - In the reversed reading of a bidi override, `runSpan` is not passed (:730). Runs count there, which is the over-scrub side.
- **`packages/core/src/citation/csl-map.ts` `creatorWithWholeNames` (:233–241):**
  - For a creator with given and family names, both texts are read:
    - "given family": a run must start inside the given name and end past its following space;
    - "family given": the same test, with the family name first.
  - A creator with only one of the two fields gets `runSpan = () => false`, so whole names only.
  - Literals and handles: no `runSpan`, so runs count as under R427 b.
- **Tests** (`citation.test.ts` "R437 (a)…", :1004):
  - **Failed first:**
    - The four rows (Juan Carlos/Onetti, María José/Ortega, Anna Maria/Schmidt, Pedro/Fernández Ruiz) failed with "P-002 Onetti", "P-002 Ortega", "P-002 Schmidt" and "Pedro P-002". They now stay unchanged, with the key kept.
    - The same through a coded creator ("@jc.perez", Juan Carlos Pérez) failed and now passes.
  - **Guards in one test:**
    - These held before: Lucía/Fernández gives "P-005"; swapped fields give "P-005"; "Dr. Maria"/Cocina gives "Dr. P-001"; family-only "Lucía Fernández Ruiz" (a whole name) gives "P-005".
    - Family-only "Fernández Ruiz" stays unchanged. This is clause 4: it is a new expectation and failed first.
  - "Fernández Ruiz Abogados" gives "P-005 Abogados". It held before and is now on record.
  - The round 4 and round 6 tests pass unchanged. "Diaz Ruiz Foundation" giving "P-004 Foundation" stands.

### (b) C1: the profile capture looks up one key (commit 5653c26)
- **`packages/library/src/capture/profile-capture.ts`:**
  - `profileCreator(c, profile)` (:179) is the one creator a profile's source carries. `createProfileSource` (:786) now uses it.
  - The look-up passes only `creatorKey(profileCreator(...))` (:381–386): the handle as written, else the display name.
  - `createProfileSource` writes one shape only, so there is no branch to follow.
- **`repo.ts`:** `pseudonymCodeFor`'s doc comment (:1257–1263) now says it tries the names given and that the capture passes exactly one (review M2).
- **Tests** (`profile-capture.test.ts` "R437 (b)…", :555, a real encrypted `PSEUDO_GOV` project):
  - **Failed first:** an interviewee "fake.dancer" gives P-001. The capture of "@fake.dancer" then files under `tiktok-P-002`, the same code as its own profile source's participant. It failed with `['tiktok-P-001']`.
  - **Held before:** a participant with the recorded handle "@fake.dancer" gives P-001, and the profile is filed under `tiktok-P-001`.
  - I first also asserted a single participant in that test. That assertion failed, and I removed it (see below).

### For the coordinator (unsure)
- **The posts' creators are a different record from the profile.** The fake TikTok posts carry the uploader handle "fake.dancer" (no "@": `snapshot.ts` :201 takes yt-dlp's `uploader`). The profile source carries "@fake.dancer". Under R403 b those are two participants, so a profile's posts and its profile source hang on different records.
  - This is not caused by this round. R403 b's strict "@" already did it, and R437 b names only the profile source.
  - It is why I dropped the one-participant assertion.
  - R437's sentence "its sources always belong to one record" may mean the posts too. That needs a ruling (the fix would be in how snapshot.ts writes the handle, or in the capture's key).
- In a bidi override's reversed reading, runs inside a given/family creator still count (over-scrub, the safe side).

### Runs (nice -n 10, load about 10–13)
- core `src/naming.test.ts src/citation`: `Tests  215 passed (215)`.
- library `src/export src/repo src/capture/profile-capture.test.ts`: `Test Files  34 passed (34)`, `Tests  677 passed (677)`.
- `pnpm -r typecheck`: all nine packages Done.
- `git status --short`: empty. Head 5653c26.

## Round 9 (R438)

One commit on 5653c26 (head given below). I did not use `git stash`, and I did not push.

### What changed
- **`packages/library/src/repo/pseudonyms.ts` `creatorKey`:**
  - A creator WITH a handle gets the key "@" + the handle: leading "@"s stripped, ends trimmed, NFC.
  - A creator without a handle keeps its key as before: the literal, else "given family".
  - `participantCodeOf` and `assignCodes` are unchanged. There is no fallback to an entry recorded earlier without the "@".
- **Other users, checked by grep:**
  - Only `assignCodes` writes to the pseudonym map (`sources.ts` → `savePseudonyms`).
  - The profile capture uses `creatorKey(profileCreator(...))`, so the posts' creator ("fake.dancer") and the profile's own creator ("@fake.dancer") now give the same key.
  - `participantNames` feeds the replacing side (the handle as written, through `creatorNameTexts`), not identity. Both spellings fold to the same words, so nothing there needed changing.
  - No other road writes a handle as a key.

### Tests
- **`pseudonyms.test.ts` "R438…":**
  - The handles "fake.dancer", "@fake.dancer" and "@@fake.dancer " give ONE participant and one map entry, "@fake.dancer". This failed first: P-001, P-002, P-003.
  - Guard: the literal "fake.dancer" keeps the key "fake.dancer". `{handle "@ana"}`, `{literal "Ana"}` and `{handle "ana"}` give P-001, P-002 and P-001: a name and a handle are two people.
  - The "ana" row of that guard failed first: the bare handle "ana" was the literal's P-002. That is the new rule.
- **`profile-capture.test.ts`:**
  - **New test "R438…"**, a real capture of the fake TikTok profile. One participant, P-001: the profile source, the post (whose handle is "fake.dancer") and the folder `tiktok-P-001`. The post's folder has no "fake" in it. The stored map is exactly `{"@fake.dancer": "P-001"}`, and `toCslItem` of the post with that map gives the author P-001.
    - It failed first with participants ["P-001", "P-002"].
    - The project withholds identifiable exports, so the citation is checked through core's `toCslItem` with the stored map, not through `exportBibliography`.
  - **The dropped one-participant assertion is back** in R437 b's second test. It failed first (2 participants) and now passes.
- **Guards still holding:**
  - R437 b's first test: a participant recorded by the literal "fake.dancer" is another person, and the profile gets P-002.
  - The R403 b handle/name pairs in `bibliography.test.ts` ("@maria / María", "@maria.cocina / Maria Cocina").
- **Expectation changed:** none of the earlier tests.

### Runs (nice -n 10)
- core `src/naming.test.ts src/citation`: `Tests  215 passed (215)`.
- library `src/export src/repo src/capture/profile-capture.test.ts`: `Test Files  34 passed (34)`, `Tests  680 passed (680)`.
- `pnpm -r typecheck`: nine of nine Done, no errors.
- `git status --short`: empty.

## Round 10 (R440)
- a: csl-map.ts creatorWithWholeNames, `tryText(given ?? family)` + comment. Test "R440 (a)" in citation.test.ts. Failed first. The old R437 guard (`{family:"Fernández Ruiz"}` stays) contradicted (a), so I changed that one assertion to P-005 and its title.
- b: csl-map.ts, second reading `() => false` + comment. Test "R440 (b)" failed first; the two guards passed before and after.
- c: pseudonyms.ts creatorKey, `/^[@＠]+/u`. Test in pseudonyms.test.ts failed first.
- d: pseudonyms.ts creatorKey, `handle && identityKey(handle)`. Two tests failed first.
- e: participant-names.ts patterns, `if (!f.part) had.part = false` moved first in `if (had)`. Test "R440 (e)" failed first.
- f1: NOT DONE. `{Juan Carlos Pérez P-002, Juan Carlos P-007}` with `{given:"Juan Carlos", family:"Onetti"}` gives "P-007", not "P-007 Onetti" (the creator is coded whole by codeFor). Test dropped, nothing committed.
- f2: scrubNames bidi-override test in naming.test.ts: passes; fails with the runSpan strip removed; guard restored.
- Runs: core 2 files / 220 passed; library 3 files / 78 passed; `pnpm -r typecheck` exit 0. No time-limit failures.
