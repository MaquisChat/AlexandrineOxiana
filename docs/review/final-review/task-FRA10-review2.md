# Review, round 2 (scoped) — FR-A10 round 3 (R387), head b1fa2c0

Reviewer: the reviewer of `task-FRA10-review.md`. Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, `a09a97e..b1fa2c0`.
I did not use `git stash`. Probes were deleted afterwards, and `git status --short` is empty.

## Verdict: NOT APPROVED

Every clause of R387 is built, and every new guard is held by a test that fails without it: 19 of 19 guards taken out one at a time. The probes of the first review are closed. **But folding the invisible characters away opened the opposite gap.** The tokenizer now also folds them away where they stand BETWEEN two words, so the two words become one. A name glued to the next word by a zero-width space, a word joiner, an LRM or a bidi isolate is no longer replaced. In round 2 it was. In a folder name the sanitiser then strips the isolates and leaves the plain name on disk: the same failure as the first review's C1, by the opposite route.

I also show the harm the coordinator asked about in `assignCodes`: the folded lookup merges distinct people into one participant.

## What I ran (`nice -n 10`, single files)
- **Core:** the whole table again, 88 rows. Each row goes through `pseudonymize`, `toCslItem(...).title` and `sourceFolderName`, and is checked for agreement. Plus 6 addresses, M1 in both map orders, M2 with the map changed in place, M6, and the creator floors.
- **Library** (`src/export`, encrypted pseudonymising projects):
  - details-only participants (王 小明 / 김 민수 / placeName), with the folder name and the bibliography compared;
  - five pairs of creators added in turn to test `assignCodes` merges;
  - creators with a particle in the family name, with the folder name and the bibliography compared.
- **Cost:** doubling probes, counted rather than judged against time limits. The machine was at load 30–40.
- **Mutations:** 19 guards, each removed alone, with `naming.test.ts` and `citation.test.ts` (the participant-name tests) run each time, then the file restored with `git checkout`.
  - The (b) mutation did not apply as written (a multi-line sed). (b) is held by the citation test the report says failed first; my agreement probes confirm the behaviour.
  - Every other guard failed at least one test when removed: (a) the fold, "@"/invisible characters going with the name, overrides; (c) the no-space and Hangul floors; (e) runs, the run guard, family words; (f) exact forms first, the cache check, tatweel, kana, the Hangul join, Hangul written apart; and the four M3 guards (choseong, sigma, ASCII fallback, mark span).

## Clause by clause
- **(a) C1: built, with one new gap (C1 below).**
  - Every probe of the first review now becomes the code in all three paths, and the whole original span, invisible characters included, is replaced:
    - Ma­ria, Ma​ria, Ma‍ria, Ma⁠ria, Mar‎ia;
    - `Lu‪cía Fer⁦nández`;
    - ‮airaM‬ (the PDF is left after the code: harmless);
    - क्‍षमा; علی‌رضا in both directions; `Ma%C2%ADria-Lopez`.
    - In the folder name, neither "Luc" nor "Fern" remains.
  - **Hangul fillers:** folding them away is right. NFKD of a written syllable never gives one, `김ㅤ민수의` becomes `P-001의`, and R380 still holds (김민수의, 박김민수, 민수김 as before).
  - **What it breaks:**
    - An emoji ZWJ sequence after a name is unharmed (`Maria👩‍💻` gives `P-001👩‍💻`).
    - A VS16 right before or after a name is absorbed into the span (`❤️Maria` gives `❤P-001`: the heart shows as text). Cosmetic.
    - Text between two names: see C1.
- **(b) I1: built.** `nameForms` is the only place forms are made, and both callers use it. 山田 太郎/太郎山田さん, 王 小明/小明王 and 太郎 山田/山田太郎さん now agree.
- **(c) I2: built as ruled.**
  - Citations: 小明的故事 gives P-1的故事; "Li family" is kept; "Historia de la ciudad" is kept (de, la under the floor); 민수 is coded and 민 is kept.
  - Folder names stay stricter (see I2 for what that does to particles).
- **(d) I3: built.** Through the library, a details-only participant ("王 小明", "김 민수"):
  - `关于小明王的报道` gives the folder `关于P-001的报道` and the bibliography `关于P-001的报道`;
  - `김민수씨와의 대화` gives `P-001씨와의 대화` in both.
  - `participantRules` keeps its name and signature.
- **(e) I4: built.**
  - "Entrevista a Lucía Fernández" gives `Entrevista a P-001`, and "Fernández Ruiz habla" gives `P-001 habla`.
  - The particle-only run guard is right, but defeated in folder names (I2).
  - New wrong replacements are listed below.
- **(f) Minor points:**
  - **M1: built.** Both map orders give `P-002; P-001` in both functions.
  - **M2: built.** A map changed in place is read afresh: an entry added, removed and re-added, or its value changed all show at once. Equal but distinct maps each get their own build, which is correct.
    - Note: `sources.ts` makes a fresh `participantNames` map for every new source, so the folder path pays a full build each time. That is milliseconds for real maps.
  - **M3: built.** All four guards' tests fail without them.
  - **M5: built** (ﾔﾏﾀﾞﾀﾛｳ and ヤマダタロウ match やまだ たろう; مـحـمـد matches محمد).
  - **M6, Hangul written apart: built.** `{김, 민수}` is coded P-1, where it used to throw.
  - **M6, `assignCodes`: harmful.** See I1.

## Findings

### C1 — Critical: an invisible character used as a word boundary now glues a name to the next word, so the name is not replaced; in a folder name the isolates are then stripped and the plain name remains
- **Where:** `packages/core/src/participant-names.ts:258-264` (`tokenize`): a character that folds to "" extends the current word, and the next letter continues it. `fold`'s IGNORABLE removal (:61) is right inside a name and wrong at its edge.
- **Probe** (the map holds one entry; each result is from `pseudonymize`, `toCslItem` and `sourceFolderName`, which all agree):

  | entry | text | result |
  |---|---|---|
  | Lucía | `Lucía​habla` | kept |
  | Maria Lopez | `Maria​Lopez​habla` | kept |
  | Ana | `Ana​Luis` | kept |
  | Maria | `Maria‎שלום` | kept |
  | Maria | `#Maria⁠Day` | kept |
  | Maria | `⁨Maria⁩⁨Lopez⁩` | kept; **the folder name is `2026 P-9 - MariaLopez [ab12]`** |

  The address `Luc%C3%ADa%E2%80%8Bhabla` is kept too.
- **Why Critical:** these shapes were replaced at a09a97e, where a ZWSP was a separator, so this is a regression on the privacy rule. A ZWSP or an isolate at a word boundary is its ordinary use. Platforms put an isolate around each name, and pages put a ZWSP where a line may break. The folder name ends up holding the name readably.
- **Smallest fix:** in `findAll`, tokenize a second time with the default-ignorable characters as separators, and merge the hits with the existing `mergeHits`, letting the longer hit win on overlap. Or keep ONE tokenization that records each ignorable inside a word as a soft boundary, where a pattern may also start or end. Test the six strings above through all three paths, and `⁨Maria⁩⁨Lopez⁩` through `sourceFolderName`.

### I1 — Important: `assignCodes` by the folded name merges distinct people into one participant (the coordinator asked for harm: here it is)
- **Where:** `packages/library/src/repo/pseudonyms.ts:99-103` (`normName`: accents, voicing marks and "@" are dropped).
- **Library probe** (encrypted pseudonymising project, one source per creator, added in turn):

  | first creator | second creator | result |
  |---|---|---|
  | Lê Thị Hương | Lê Thị Hường | both P-001 |
  | Ana Peña | Ana Pena | both P-002 |
  | handle `@maria` | literal `María` | both P-003 |
  | ハナコ | バナコ | both P-004 |
  | `@maria.cocina` | Maria Cocina | both P-005 |

  Ten creators gave 5 participants.
- **Harm:** the second person gets no participant record of her own. Her source is linked to the first person's participant id, so the first person's consent and legal basis stand for her, and a withdrawal by either one acts on both. That is a consent and governance error, not a scrubbing one. Hương and Hường, and Hùng and Hưng, are distinct, common Vietnamese given names; Peña and Pena are distinct surnames.
- **Over-matching:** it is the safe side for SCRUBBING, and unsafe for IDENTITY. A duplicate code is the safe side there. My first review's M6 direction was wrong on this point.
- **Smallest fix:** identity uses a strict key:
  - NFKC and case folding, invisible characters removed, white space collapsed, no-space and Hangul words joined;
  - accents, voicing marks, "@" and punctuation KEPT.

  At most, a folded-only match could be offered for the researcher to confirm. The test "Lucía Fernández" / "LUCIA Fernandez" then expects two participants unless the researcher confirms one. **Needs the coordinator's ruling**, because it reverses what R387 (f) asked.

### I2 — Important: in folder names, each word of a compound family name is replaced at any length, so "de", "la", "van" and "der" are blanked in every title of that participant's sources
- **Where:** `packages/core/src/participant-names.ts:174-175` (`creatorNameTexts` adds every family word as bare), with `packages/library/src/repo/pseudonyms.ts:64` and the folder path, which has no floor (R387 c). The run guard of `:144` ("de la" is not a name) does not reach these single words.
- **Library probe:**

  | creator | title | folder name | bibliography |
  |---|---|---|---|
  | {Juan, de la Cruz} | "Historia de la ciudad y la Cruz Roja" | `Historia P-001 P-001 ciudad y P-001 Roja` | `Historia de la ciudad y P-001 Roja` |
  | {Jan, van der Berg} | "Der Berg ruft van Gogh" | `P-002 ruft P-002 Gogh` | `P-002 ruft van Gogh` |

- **Effect:** no privacy loss, but folder names that read as nonsense for every Spanish, Portuguese, Dutch or German participant with a particle. The implementer's own guard shows this was not meant.
- **Smallest fix:** in `creatorNameTexts`, add a family word on its own only when `standsAlone(w, 4)`, the same test as the run guard. "Fernández" and "Ruiz" stay; "de", "la", "van" and "der" go.

### Minor
- **M1. Runs create ordinary-phrase codes** (citation and folder alike; the safe side, but visible):

  | name | text | result |
  |---|---|---|
  | Maria de Lopez | "Ave Maria de Guadalupe" | `Ave P-001 Guadalupe` |
  | Maria de Lopez | "Calle de Lopez" | `Calle P-001` |
  | Juan de la Cruz | "la Cruz Roja" | `P-001 Roja` |
  | Juan de la Cruz | "San Juan de Dios" | `San P-001 Dios` |
  | Jan van der Berg | "Der Berg ruft" | `P-001 ruft` |

  Smallest fix: a run must hold at least TWO words that stand alone (`:144`, `filter(...).length >= 2` instead of `some`). "Lucía Fernández" and "Fernández Ruiz" stay forms; "Maria de", "la Cruz" and "der Berg" go.
- **M2. "Lucía Ruiz Fernández" gives `Lucía P-001`:** the run "Fernández Ruiz" is matched reversed, and the given name is left beside the code. Before this round the whole name was kept, so this is not worse. It is still a partial name, inside the stated limit.
- **M3. `mergeHits` is quadratic in the number of hits inside a bidi override** (`:452-456`: `all.some` over a growing list). By count, E hits cost E²/2 overlap checks. Measured: RLO + "airaM " ×10,000 took 1.2–1.9 s, ×20,000 took 2.5–7.7 s. Smallest fix: both lists are sorted, so merge them in one pass.
- **M4. The per-first-unit list scan of the first review is unchanged:** 2,000 names `王X` over a run of 200,000 王 took 43 s. That is linear in the text, times the number of names sharing a first unit. It was not part of R387; it belongs with FR-664 or a trie later.
- **M5. Folder names now also code a participant's `placeName`-like details** (`pseudonyms.ts:60`: `NAME_KEY` matches "placeName", "accountNumber"…). "Fiesta en Allariz" gives `Fiesta en P-001` in the folder, as the bibliography already did. The safe side; it is noted because it is new for folders.
- **Still sound:** I re-checked that the brief's linear bound holds by count (Latin text 250k → 500k → 1M grows linearly; a ZWSP run grows linearly), and that building the index grows linearly with the map (1,000 → 2,000 three-word names; 100 → 400 ten-word names). Forms per name are bounded: a 10-word name gives 492 forms; an 11-word name gives 24, because it gets no runs.

## Shapes that still leave a name with no code
- **New in this round (C1):** a name glued to the next word by a zero-width space, a word joiner, an LRM or RLM, or bidi isolates.
- **Stated limits** (R387, FR-657, FR-664): initials (M. Lopez); an extra middle name in the text (Maria Isabel Lopez); a part dropped from the middle (Siti Ahmad); an order that is neither a rotation nor the reverse (Ruiz Lucía; Lucía Ruiz Fernández leaves "Lucía"); inflected Latin forms; small capitals (ᴍᴀʀɪᴀ); look-alike letters of another script (Маria); an address encoded 4 or more times; punycode hosts; `%uXXXX` and `&#NN;` escapes; a slug with an extra word (lopezmariagarcia).
- **Smaller, unlisted:**
  - an Arabic article joined to the name (حسن in الحسن);
  - ي against ی;
  - McDonald written "Mc Donald";
  - a Hangul name followed by digits (김민수2024);
  - `maria 2024` against the entry `maria2024` in titles;
  - a lone Latin given or family name under 4 letters in citations (ruled).
