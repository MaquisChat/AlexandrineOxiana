# Review 3 (the whole task) — FR-A10, one rule for recognising a participant's name

Reviewer: a fresh adversarial reviewer. Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, `7b81976..b9c7cec` (17 commits). I read the whole package once, the round-3 package, the three briefs, the report, both earlier reviews, wb1, and rulings R378 (a), R380, R383, R387, R401, R403, R416 and R420 (a) in full.
I did not use `git stash`. Three probe files (`*.probeFRA10c.test.ts`) were written, run alone at `nice -n 10`, and deleted. `git status --short` in the worktree is empty.

## Verdict: NOT APPROVED

The rule itself is now sound. Every probe of wb1 and of both earlier reviews is closed, and the three paths agree on every row I tried: the folder title, the citation title and `sourceFolderName`. That held across 70 rows. Cost is linear.

Two things stop approval:
- **I1.** On a library made before this task, the new joining of Hangul and Han words points an existing participant's source at ANOTHER participant record. This happens both in citations and in `assignCodes`, and it was correct at base.
- **I2.** The exact-participant choice of R416 does not reach lone names or names recorded as separate details, so another person's code is printed.

There is also one point for the coordinator's ruling: **I3.** A run of a participant's name inside another creator's name is printed, while the same text is coded in the title of the same entry.

## What I ran (all `nice -n 10`, single files, load 16–30)
- **The touched test files at head:** core `naming.test.ts` and `citation.test.ts` passed 195/195. Library `src/export/bibliography.test.ts` passed 27/27.
- **Core probe (70 rows):** each row went through `pseudonymize`, `toCslItem().title` and `sourceFolderName` together, and was checked for agreement. The rows cover:
  - the probes of wb1, review 1 and review 2;
  - soft boundaries at the start, end and middle, between two names, overlapping, a name that is a prefix of another, a soft hyphen in ordinary words, Han and Hangul with invisible characters, format characters that are not default-ignorable, a combining grapheme joiner, and handles;
  - R416 pairs (Peña/Pena, María, hyphenated, apostrophes, ß/ss, Turkish ı, Hangul), in both map orders;
  - R420 cases: a linked source, `requireParticipantCodes`, interviewer, editor and translator, handle only, literal plus handle, given or family only, soft and RLO text, reversed order with a comma, a part of a 3-word name, and a one-word map entry.
- **Library probe of `assignCodes`** with a stub change: legacy duplicate records, Turkish case, handle against literal, NFD, ZWNJ, Latin+Han, two people in one batch, and `participantNames` with name details split into parts.
- **Cost:** 2,000 participants (20 of them with 10-word names), texts of 50k, 100k and 200k characters (ZWSP-joined single letters, soft-hyphenated words, Latin, one repeated Han character, an RLO run, many short overrides), and `toCslItem` with a 200k title.
- **Not run (refused by this session's permission rule):** taking guards out by editing tracked files. Guard coverage below is judged by reading which test fails without each guard, not by mutation.

## The findings of the earlier reviews
| finding | status |
|---|---|
| wb1 C1 (no-space scripts), I1 (folding), I2 (word order, addresses) | **closed**: `P-001访谈录`; `Entrevista a P-002; P-002 talks; P-002 video`; `P-003: her life; and P-003`; the three addresses dropped |
| R1 C1 (an invisible character inside a name) | **closed** for the default-ignorable characters (soft hyphen, ZWSP, ZWJ, WJ, LRM, BOM, MVS, CGJ, tag characters, isolates, RLO). Two non-ignorable format characters are kept: see M5 |
| R1 I1 (forms built differently) | closed (one `nameForms`; all rows agree) |
| R1 I2 (the CJK lone-name floor) | closed |
| R1 I3 (names only in the details) | closed (`participantNames`, library test) |
| R1 I4 (partial names) | closed within R403 c. See I3 for creators |
| R1 M1 (collisions), M2 (cache), M3 (guards), M5 (tatweel, kana), M6 (Hangul written apart) | closed. **But the M6 join is what causes I1 on old data** |
| R2 C1 (an invisible character between words glues a name to the next word) | **closed**: all six rows replaced in all three paths. `⁨Maria⁩⁨Lopez⁩` with two entries gives the folder `P-001P-002` |
| R2 I1 (`assignCodes` merges people by the folded key) | **closed** for the five pairs; strict key as R403 b. New: I1 below (legacy duplicates) |
| R2 I2 (particles blanked in folder names) | closed (`Historia de la ciudad y la P-001 Roja`) |
| R2 M1 (runs of particles), M3 (quadratic merge) | closed. M2 and M4 are listed limits (FR-664, FR-678); M5 is noted |

## Findings

### I1 — Important: on a library made before this task, two records whose names the new join makes equal: the source of the second is cited, and new sources are linked, under the FIRST
- **Where:**
  - `packages/library/src/repo/pseudonyms.ts:105-108`: `lookup` returns the first entry whose `identityKey` is equal, even when an entry equal as written exists.
  - `packages/core/src/participant-names.ts:655-665`: `mapCode`'s `strictKeys` and `mapKeys`; the first entry of a key wins.
  - `normName` (`:90`) now joins Hangul and no-space words too.
- **How the data arises:** at base, `assignCodes` compared keys by `toLowerCase` only. So a participant written "김 민수" in one source and "김민수" in another got two records (P-001, P-002), each with its own sources. The same happens for "山田 太郎" / "山田太郎", and for keys that differ by full-width forms, an invisible character or double spaces. R387 M6 shows this is common.
- **Probe, with map `{"김 민수" → P-001, "김민수" → P-002}`:**
  - `toCslItem` of an existing source by the literal "김민수" (linked to P-002) gives the author `P-001`. At base it was `P-002`: the base `normName` did not join Hangul. The same holds for `山田 太郎` / `山田太郎`.
  - Its folder title gives `P-002의 인터뷰`, so **the author and the title of one entry disagree.**
  - `assignCodes` for a new source by "김민수" returns P-001 and links the new source to P-001's record, though the key "김민수" → P-002 exists. The same happens for "Ana  Peña"/"Ana Peña" and "ＡＮＡ"/"ana".
  - `pseudonymCodeFor` (`repo/repo.ts:1261-1268`, profile capture) still compares by NFC + lowercase. So a profile can be filed under one participant's code while its source is linked to the other.
- **Harm:** consent and withdrawal act per record. A withdrawal recorded on P-002 does not reach the new source linked to P-001, and the bibliography prints P-001 for a source whose record is P-002. "Another person's code printed for someone", and a consent link to the wrong record, on existing data.
- **Direction:**
  - In `lookup` and `mapCode`, an entry equal as written (NFC) wins, then the strict key, then the folded key.
  - A library test with a pseudonym map holding both spellings.
  - Pairs the strict key now joins are candidates for FR-677's offer to merge.

### I2 — Important: R416's exact choice does not reach lone names or names whose parts are recorded separately, so another participant's code is printed
- **Where:**
  - `participant-names.ts:426-479` (`patterns`): candidates are compared only when their FOLDED units are identical.
  - `pseudonyms.ts:46-53` adds each name detail (`firstName`, `lastName`, …) as its own entry, and each current creator's lone family and given names.
- **Probe:**
  - **Name parts recorded as separate details:** map `{Ana → P-001, Peña → P-001, "Ana Pena" → P-002}` (P-001 recorded with `firstName`/`lastName`). The text "Entrevista a Ana Peña" gives **`Entrevista a P-002`** in both the folder name and the citation. This is P-001's exact name with P-002's code: the only two-word pattern is P-002's, so no candidate is compared.
  - **The current creator's lone family name:** in the citation of a source by Ana Pena (P-002), with the map `{Ana Peña → P-001, Ana Pena → P-002}`, the title "La familia Peña; Peña y Pena" gives `La familia P-002; P-002 y P-002`. The folder name does the same through `participantNames`, as `P-002 y P-002 hablan`.
- **Harm:** no name leaks, but a code that belongs to another person is printed. This is what R416 was meant to end. It needs two participants whose names fold alike, one of them recorded by name parts, or a lone family name in a title. That is narrow, so the coordinator may grade it lower.
- **Direction:** carry the strict letters on every form, including bare and detail entries. When a match's span has an exact strict match among the forms of OTHER patterns of equal length (Peña against Pena), prefer that participant. Or simpler: when two map codes fold alike, treat each one's separate parts as a "mixed" candidate set.

### I3 — Important, for the coordinator's ruling (R420 a is followed as written): a run of a participant's name inside another creator's name is printed while the same text is coded in the title of the same entry, which links the code to the name
- **Where:** `csl-map.ts:222-243` (`creatorWithWholeNames`) with `participant-names.ts:670` (`wholeOnly` drops `part` and `bare`).
- **Probe:** map `{"Lucía Fernández Ruiz" → P-005}`, a web page by the literal "Amigos de Lucía Fernández", with the title "Amigos de Lucía Fernández". `toCslItem` gives:
  - the title **`Amigos de P-005`**;
  - the author **`Amigos de Lucía Fernández`**;
  - the citation key copied (`key`).

  The printed entry shows the participant's given name and first surname (how the press names her, review 1 I4) next to her code. So it both prints the name and tells the reader that P-005 is that person. The same happens with a coded creator's lone name: "Amigos de Rosa" is kept as author and coded in the title.
- **Why a ruling:** R420 a excludes parts in creators, so as not to rewrite authors who merely share a first name. That reason holds for a lone given name. It holds less for a run of two words that each stand alone (R403 c), which the title already treats as the participant.
- **Direction (the coordinator's choice):**
  - Let `wholeOnly` keep `part` forms (runs), and drop only `bare`.
  - Or, where a creator's text is scrubbed in the title, read it with the same forms in the creator, so title and author agree.

### Minor
- **M1. In a linked source (or with `requireParticipantCodes`), a creator that R420 would code is refused instead** (`csl-map.ts:312-317`). The fail-closed check runs in the first pass, before the whole-name read.
  - "Friends of Maria Cocina" in a source linked to participants throws `ParticipantCodeMissingError`, even with a coded interviewee beside it.
  - This is a refusal, not a leak, and it was refused at base too. R420's "counts as coded for all that follows" leaves open whether it should pass. **Ruling wanted** (no change is also defensible).
- **M2. The interviewer's own name is rewritten when it contains a participant's whole name.** `{role: interviewer, given: "Maria", family: "Cocina Smith"}` gives `P-001 Smith`, and the citation key is withheld. This over-scrubs the researcher's name, on the safe side.
- **M3. R420 widens FR-637.** With the handle `@maria` in the map, `{Maria, Montessori}` is coded `P-001` (by `codeFor`, which already happened at base). Its whole forms then rewrite another creator, "Maria Montessori Institute", as `P-001 Institute`. This is on the safe side, but a one-word handle now rewrites real organisations too. Belongs with FR-637.
- **M4. Case folding is not Turkish-aware** (`identityKey` uses `toLowerCase`).
  - "AYŞE YILMAZ" against "Ayşe Yılmaz" gives a new participant (one person becomes two).
  - With the map `[Ayse Yilmaz P-002, Ayşe Yılmaz P-001]`, the text "AYŞE YILMAZ" gets **P-002**. No candidate is exact, so the first by map order is used, as ruled.
  - The capital `I` folds to `i`, never to `ı`, so a Turkish name in capitals never equals its own spelling. Say it in the limits, or fold `ı` to `i` in the strict key only for comparison (a ruling).
- **M5. Non-default-ignorable format characters still split a name.** `Ma￻ria` (interlinear annotation terminator) and `Ma؅ria` are kept in all three paths, and `sanitizeSegment` keeps U+FFFB in the folder. I could not verify whether the operating systems render them invisibly. Cheap to close: also treat `\p{Cf}` as soft.
- **M6. Soft hyphens in ordinary words are read as boundaries.** "Ana­ly­se der Daten" with the entry "Ana" gives `P-001­ly­se der Daten`, and "Mari­a­nne" with "Maria" gives `P-001­nne`. This is the ruled price of R403 a. It is noted because soft hyphens are common in copied German and Dutch web text (over-scrub, safe side).
- **M7. The cost per character grows with the longest first unit of the map** (the key concatenation in `at`, `participant-names.ts:765-773`).
  - The text "a​" × 25k/50k/100k (50k/100k/200k characters) against a map whose longest joined form is 100 letters takes 1.4 / 2.7 / 4.8 s at load ~20. That is linear in the text, but about 100× ordinary text (200k of Latin: 51 ms; Han: 142 ms; RLO run: 463 ms; 2,000 participants built in 1.0 s).
  - Direction: build the first-unit lookup as a trie, with FR-678.
- **M8. A guard with no test that fails without it** (judged by reading): `identityKey`'s removal of invisible characters for `assignCodes`. No library test has a creator name with an invisible character (the core R416 test passes through `strictLetters` either way). The same goes for `lookup`'s lowercase fallback for keys made only of invisible characters.
- **M9. Partial joins** ("Seán O'Brien" against "Sean OBrien" is kept; "@mariacocinafans") are the listed limit of "lopezmariagarcia". East Asian romanised names (Vietnamese "Lê Văn Nam", pinyin "Wang Li Na") get no partial forms under R403 c's 4-letter floor. That is as ruled, and stated here so the owner knows.

## The implementer's own doubts
- **"Strict and folded word counts may not line up":** I tried hyphens, apostrophes (' and ’), ß, NFD, full-width, Hangul, Han, ZWNJ and 3-word names in both map orders. All picked the exact participant, and I found no name that misaligns. The real gaps are elsewhere (I2, M4).
- **"A creator whose joined text holds a whole name is printed as a single literal":** real and as ruled. A style can no longer invert it.
- **"A literal plus a handle is read by its literal only":** confirmed. Only the literal is printed, so nothing leaks.

## Checked and sound
- **Soft boundaries (R403 a):**
  - a name at the start, middle or end beside ZWSP, WJ, LRM, isolates or a soft hyphen;
  - across two or three invisible characters (`Ma​ria­Lo‍pez​habla` gives `P-001​habla`);
  - two names touching through isolates (`P-001P-002`); the longer name wins (`Ana­bel` gives P-002 with Ana/Anabel);
  - Han with ZWSP or a soft hyphen inside (`P-001访谈`), and a one-character Han name still not alone across ZWSP;
  - Hangul across invisible characters (`P-001의`), and `박​김민수의` gives `박​P-001의` (a word starting after a soft boundary; the safe side);
  - handles (`@maria​.cocina` gives `P-001`); the isolates around a name stay outside the span, and the folder sanitiser strips them.
- **Identity (R403 b):**
  - the five pairs give two participants;
  - case, double spaces, NFD/NFC, ZWNJ, and Hangul or Han written apart give one;
  - nothing re-matches participants on open, index rebuild or restore: `assignCodes` runs only in `writeNewSource`. The only legacy effect is I1.
- **Parts (R403 c):** `creatorNameTexts` and the run guard as ruled. The folder name and the citation agree on every row.
- **R416:**
  - Peña/Pena, María, hyphenated, apostrophe, ß/ss and Hương/Hường pick the exact participant in either map order, in folder and citation;
  - `codeFor` uses the strict key first;
  - addresses are unaffected (tested only).
- **R420 a:**
  - literal, handle, given/family (both orders), editor, translator, soft and RLO text are coded;
  - the citation key is withheld whenever a creator is changed;
  - an empty map leaves creators untouched; parts are not looked for (as ruled).
- **Linear in the text:** in every shape I doubled, time grew linearly.
- **No other caller compares participant names by an older rule,** in `apps/library-service`, `apps/cli` or `packages/ui`. In the library, the only one left is `pseudonymCodeFor` (I1). `project-export.ts` still uses the map alone (deferred to FR-A14 by the report).

## Could not verify
- **Guards by mutation:** editing tracked files was refused by this session's permission rule. Coverage was judged by reading which test each guard's removal would fail.
- **I1 through a real old library:** shown with `assignCodes` and `toCslItem` on a map shaped as the old code made it, not by opening a library written by the base code.
- **How U+FFF9–U+FFFB and U+0600–U+0605 render** in Finder, Explorer and the UI (M5).
