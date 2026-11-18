# Review — Task FR-A10 (one rule for matching a participant's name; R378 a, R380, R383)

Reviewer: a fresh adversarial reviewer. Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, head a09a97e (base 7b81976).

## Verdict: NOT APPROVED

The three findings are closed for the shapes they named, and the shared module is a clear improvement. There is one Critical gap: an invisible format character inside a name (a soft hyphen, a zero-width character, a bidi mark or isolate) still lets the name through in BOTH functions. In the folder path, the caller's sanitiser then strips the bidi controls, so the plain name ends up on disk. There are also four Important gaps. In two of them the two functions still disagree; both were named in the dispatch, and both mean a real name is printed.

**Spec:** ✅ for the brief's own items (C1, I1, I2, R380, R383 (a), linear for the brief's size, no signature changed, library unchanged), with one exception: brief item 3, "the two functions agree", is ❌ (I1, I2 below).
**Quality:** needs fixes.

## What I ran (all at `nice -n 10`, single files, probes deleted, `git status --short` empty at the end)
- I re-ran the wb1 probes for C1, I1 and I2 against the head. All are closed:
  - `toCslItem` of 王小明访谈录 gives `author [{literal:P-001}]` and the title `P-001访谈录`.
  - `pseudonymize` gives `P-001访谈录` and `P-5さんへのインタビュー`.
  - The three I1 strings give `Entrevista a P-2 | P-2 talks | P-2 video`.
  - The I2 title gives `P-003: her life; and P-003`.
  - The three I2 addresses are dropped.
- I built a table of 82 (map entry → text) pairs. Each pair went through both `pseudonymize` and `toCslItem(...).title` and was checked for agreement. I also ran 25 addresses through `toCslItem(...).URL`.
- I ran 9 creator-path cases with the folder map built exactly as `sources.ts:483-491` builds it, and set the citation beside each.
- Collision, touching, overlap and `@` cases.
- Cost probes: a 1 MB title; maps of 5,000 names; a 200-word name; a 500,000-character Han run; Hangul runs; a 900 KB address. I also timed the old `pseudonymize` against the new one, and checked that output is byte-identical when no participant is involved.
- I took out 11 guards one at a time and ran `naming.test.ts`, `citation.test.ts` and `src/verify` (230 tests) for each, then restored the file.
- `@ao/library` `src/export/bibliography.test.ts`: 10 passed. `@ao/core` and `@ao/library` typecheck: clean.

## The table (selected rows; "both" = `pseudonymize` and the citation title give the same)

| map entry | text | result | defensible? |
|---|---|---|---|
| Maria 王 | Maria王访谈 / 王 Maria interview | P-001访谈 / P-001 interview (both) | ✓ |
| 山田 太郎 | 山田太郎さん | P-001さん (both) | ✓ |
| **山田 太郎** | **太郎山田さん** | **folder P-001さん, citation 太郎山田さん** | ✗ I1 |
| やまだ たろう | ヤマダタロウ | kept (both) | hiragana ≠ katakana; Minor |
| สมชาย ใจดี | สมชายใจดีพูด; สม​ชาย​ใจดี (ZWSP) | P-001พูด; P-001 (both) | ✓ |
| O'Brien | O’Brien / OBrien | P-001 (both) | ✓ |
| Jean-Luc Picard | Jean Luc Picard; Picard, Jean-Luc; JeanLuc | P-001; P-001; JeanLuc | partial join; Minor |
| Ahmed al-Sayed | Ahmed Al Sayed / Alsayed Ahmed | P-001 / kept | partial join; Minor |
| van der Berg, Jan van der Berg, Juan de la Cruz | Vanderberg; "Berg, Jan van der"; "Cruz, Juan de la" | all replaced | ✓ |
| Siti binti Ahmad / McDonald | Siti Ahmad / Mc Donald | kept | subset / split; see I4 |
| Maria Lopez | M. Lopez; Lopez M.; Maria Isabel Lopez | kept (both) | initials; extra middle name; I4 |
| Maria Isabel Lopez | Maria Lopez | kept (both) | a missing middle name; I4 |
| **Lucía Fernández Ruiz** | **Entrevista a Lucía Fernández** | **kept (both)** | I4 |
| Lucía Fernández Ruiz | Ruiz Lucía Fernández / Lucía Ruiz Fernández | P-001 / kept | a permutation that is neither a rotation nor the reverse; Minor |
| Maria Lopez | Maria\nLopez, \t, NBSP | P-001 (both) | ✓ |
| **Maria** | **Ma­ria, Ma​ria, Ma‍ria, Ma⁠ria, Mar‎ia** | **kept (both)** | ✗ C1 |
| Maria | ‮airaM‬ (RLO) | kept | bidi override; part of C1 |
| Maria | Mari︀a (a variation selector) | P-001 | ✓ (it is \p{M}) |
| José / José | NFD / NFC | P-001 (both) | ✓ |
| Maria | 𝐌𝐚𝐫𝐢𝐚 / Ⓜⓐⓡⓘⓐ | P-001 | ✓ |
| Maria | ᴍᴀʀɪᴀ (small caps) | kept | no NFKD mapping; Minor |
| Yıldız / İpek / Strauß / Νίκος / Οδυσσέας | YILDIZ, Yildiz / ipek / Strauss, STRAUẞ / ΝΙΚΟΣ / Οδυσσεας | all P-001 | ✓ |
| Maria | Маria (Cyrillic М) | kept | a look-alike; attacker-only; Minor |
| محمد | مُحَمَّد / مـحـمـد (tatweel) | P-001 / kept | tatweel; Minor |
| حسن | الحسن | kept | the article joined; defensible |
| علی‌رضا (with ZWNJ) ↔ علیرضا | | the key with ZWNJ matches both; the key without ZWNJ misses the ZWNJ text | asymmetric; part of C1 |
| علي | علی (Arabic vs Persian yeh) | kept | Minor |
| דוד | דָּוִד | P-001 | ✓ |
| अनिल | अनिल का | P-001 का | ✓ |
| क्षमा | क्‍षमा (ZWJ) | kept | part of C1 |
| @maria.cocina | maria_cocina / MariaCocina | P-001 | ✓ |
| maria2024 | maria 2024 | kept (titles); dropped in addresses | Minor |
| 김민수 | 김민수의, 김민수가 | P-001의, P-001가 | ✓ R380 |
| 김민수 | 민수김 / 김민 수 / 박김민수 | kept | ✓ R380 |
| 김 민수 | 민수 김 | P-001 | ✓ |
| 김민수 | 김민수2024 인터뷰 | kept (a Hangul run followed by digits is not "all Hangul") | Minor (王小明2024 → P-12024) |
| Ann / Maria / Rose | Annual; Marianne Mariana; Rosemary | kept | ✓ |
| 王 | 王小明 / 王 小明 | kept / P-001 小明 | ✓ one-character rule |
| 小明 | 小明白了 | P-001白了 | over-scrub; deferred by the implementer |

Addresses: `%20`, `%2B`, `%2520`, `%252520` (3 levels), `MariaLopez`, `mariaLopez2024`, `%4Daria`, `%C2%A0`, `%E2%80%8B` (ZWSP, decoded and treated as a separator), a trailing malformed `%E0%A4`, `marialopez.com`, `instagram.com/maria.cocina/`, `mariacocina2`, `li-wei` and encoded Han and Hangul are all **dropped**. These are **kept**:
- `Ma%C2%ADria-Lopez`: the soft hyphen, C1.
- `%25252520`: four levels of encoding. Minor.
- The real punycode host `xn--maralpez-e2a6d.example` (= maríalópez.example). Minor.
- `lopezmariagarcia`: deferred by the implementer.
- `Maria%u0020Lopez` and `Maria&#32;Lopez`: non-standard escapes. Minor.

`%ZZMaria-Lopez` is also kept, correctly: "ZZMaria" is a different word.

## Findings

### C1 — Critical: a name with an invisible format character inside it is not replaced in either function, and in a folder name the sanitiser then rejoins it into the plain name
- **Where:** `packages/core/src/participant-names.ts:35-41` (`fold`) and `:146-155` (`tokenize`): a character of category Cf is neither a word character nor folded away, so it splits the word. The rejoining is in `packages/core/src/naming.ts:33` and `:54` (`sanitizeSegment` strips `BIDI_CONTROLS` after `pseudonymize` has run; `sourceFolderName` calls it at `:86`).
- **Probe:** map `Lucía / Fernández / Lucía Fernández → P-002`, as `sources.ts` builds it.
  - The title `"Entrevista a Lu‪cía Fer⁦nández"`: `pseudonymize` returns it unchanged, and `sourceFolderName` gives the folder **`"2026 P-002 - Entrevista a Lucía Fernández [ab12]"`**. The participant's full name is in plain text on disk, in a project whose folder names stay readable when encrypted (R23, R32).
  - `"Entrevista a Luc‎ía Fernández"` (an LRM, which the sanitiser keeps) gives the folder `… Luc‎ía P-002`, which displays as "Lucía".
  - A soft hyphen (`Luc­ía`), a ZWSP, ZWJ or word joiner inside "Maria", and an RLO-reversed "airaM": all kept by both `pseudonymize` and `toCslItem`.
  - In addresses, `Ma%C2%ADria-Lopez` is kept.
  - The same gap splits Devanagari conjuncts written with a ZWJ (`क्‍षमा`) and Persian names written with a ZWNJ (`علی‌رضا` in the text against `علیرضا` in the map).
- **Why it matters:** the dispatch names this attack ("a soft hyphen, zero-width characters or bidi marks placed INSIDE it — an attacker's, or a copy-paste's"). Soft hyphens are common in copied web text. ZWJ and ZWNJ are part of ordinary Indic and Persian spelling. Platforms put bidi isolates around user names. Every such shape leaves the name in the citation, and in the folder the name is not merely kept but cleaned up into its plain form. This breaks R88 ("name matching normalised everywhere") and R23/R32.
- **Direction:** fold the default-ignorable code points away in `fold`, before NFKD: `\p{Default_Ignorable_Code_Point}` (soft hyphen, U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+FEFF, the Mongolian vowel separator). `tokenize` already gives a character that folds to "" to the word around it, so the name becomes one word again. Mind that this property also holds the Hangul fillers U+115F/U+1160, which the `CHOSEONG` range contains. Test the strings above through both functions and through `sourceFolderName`.

### I1 — Important: the two functions disagree on a map entry written with a space between no-space-script words ("山田 太郎"): the folder name replaces "太郎山田", the citation does not
- **Where:** `csl-map.ts:270-273`. The map key goes through `normName`, which now joins no-space words without a space (`participant-names.ts:49-50`). `n.split(" ")` then gives ONE word, so `patterns` makes no rotation. `naming.ts:195-197` uses `words(name)` instead, which gives two words, so it makes the rotations.
- **Probe:** with map `山田 太郎 → P-001`:
  - `pseudonymize("太郎山田さん")` gives `P-001さん`;
  - `toCslItem(...).title` gives `太郎山田さん`.

  The same holds for "王 小明" and "小明王", and for "太郎 山田" written apart.
- **Breaks:** the brief's item 3 and R378 (a), "one rule … in either word order". A participant whose details or map entry holds the name with a space is printed in the bibliography.
- **Direction:** build the forms in one place, through one function that both callers use (map entry → forms), so they cannot drift. Make the rotations from the words as written, before the no-space join.

### I2 — Important: a bare Chinese or Japanese given or family name is replaced in the folder name but never in a citation (the R88 floor counts characters)
- **Where:**
  - `csl-map.ts:192-193` (`bareMinLength: 4`) with `participant-names.ts:207` (`[...ws[0]].length < min`);
  - `sources.ts:487-489`, which gives the folder map `c.family` and `c.given` with no floor.
- **Probe:** creator `{family:"王", given:"小明"}`, map `王小明 → P-001`:

  | title | folder name | citation |
  |---|---|---|
  | `小明的故事` | `P-001的故事` | **`小明的故事`** |
  | `王老师和小明` | `王老师和P-001` | **`王老师和小明`** |

  Creator `山田/太郎` and the title `太郎の話` give the same split. Every Han or kana given name has fewer than 4 characters, so in citations it is never replaced on its own. Naming a Chinese or Japanese interviewee by the given name alone is the commonest way a title does it.
- **Pre-existing in part:** for Latin "Li" (`Li family history`: folder `P-001 family history`, citation `Li family history`) this is the R88 floor as ruled. For CJK, the C1 fix made the folder replace these names while the citation still leaks them.
- **Needs the coordinator's ruling:** should the floor be measured per script (for example, a no-space-script name of 2 or more characters counts as a full name, as `participant-names.ts` itself treats it)? And should the folder and the citation share one floor?

### I3 — Important (for a ruling; pre-existing, in the map builders): a participant's name held only in the fieldwork details is coded in the bibliography but left in the folder name
- **Where:** `export/bibliography.ts:95-103` adds every detail whose key matches `/name|handle|user|alias|account/` (fullName and the like) to the map. `repo/sources.ts:470-492` reads the same `data` (`readFullData`, :473) but builds the folder map from the pseudonym map and the creators only.
- **Effect:** a news story about a participant who is not its creator, titled "Lucía Fernández Ruiz habla", is coded in a copied citation and printed in plain text in its folder name. This is exactly the I2 scenario of wb1 ("the map is deliberately extended with every participant's name details … the ordinary path").
- **Evidence:** from reading only; I did not probe it through the library (it needs a participant with details in an encrypted project).
- **Direction:** one helper in the library that builds "the participant names of this project" for both callers, and a library test with a details-only participant. Brief item 3 asks for agreement, so this is either in FR-A10's scope or a separate task.

### I4 — Important (for a ruling): a name written with one of its parts missing or added is not replaced, and part of a name is left beside the code
- **Probe:**
  - Map `Lucía Fernández Ruiz` (a details full name, not a creator): `"Entrevista a Lucía Fernández"` is kept by both functions. A Spanish or Portuguese name without its second surname is how the press writes it.
  - A creator `{given:"Lucía", family:"Fernández Ruiz"}`, the same title: both functions give `Entrevista a P-001 Fernández`. The first surname is left beside the code, in the folder name and in the citation.
  - `Maria Lopez` ↔ `Maria Isabel Lopez` (in either direction), `M. Lopez`, `Lopez M.` and `Siti binti Ahmad` → `Siti Ahmad` are all kept.
- **Not a regression,** and not asked by the brief. But the dispatch asks to "say plainly which shapes still leave a name": these are the commonest real-world shapes left.
- **Direction:** a ruling. Either list it as a limit beside FR-657, with the guide's sentence, or have the rule also match each contiguous run of two or more words of a name of three or more words, plus each single family-name word of a compound family name, under the R88 floor.

### Minor
- **M1.** Rotation and join collisions give one participant the other's code: `participant-names.ts:198-203`, where the first pattern added wins, through `seen`.
  - Map `{Maria Lopez → P-001, Lopez Maria → P-002}`: "Lopez Maria" becomes P-001. With the map in the reverse order, BOTH become P-002.
  - Map `{Ann Marie → P-001, Annmarie → P-002}`: "Annmarie" becomes P-001.
  - In a citation, a creator "Lopez Maria" is coded P-002 while the title says P-001.

  No name leaks, but the folder name and the citation can disagree on the code, because their maps are built in different orders. Direction: add every form's exact words before any variant.
- **M2.** Cost grows with the number of names that share a first unit. `findAll` scans `byFirst.get(w)` linearly (`:298-305`). With a map of 5,000 names `王X`, a 500,000-character run of 王 takes **49.7 s**; `王小X` takes 35.0 s. A 1 MB "maria maria …" against one 51-word name takes 2.8 s, which is O(n·m²).
  - These maps and texts are unrealistic. 500 names and 1 MB take 0.33 s, and the brief's bound holds.
  - `patterns()` is rebuilt for every field of every item: one `toCslItem` with 5,000 three-word names takes about 430 ms, so a bibliography of 200 sources takes about 90 s. `pseudonymize` with 20,000 keys is 3.5× slower than the old regular expression (208 ms against 59 ms per call).

  Direction: build the index once per map (cache it in `toCslItem`), and use a trie over units instead of a list per first unit.
- **M3.** Guards with no test that fails without them. Each was removed in turn and all 230 tests still passed:
  - `hangulPrefixOf`'s `CHOSEONG.test(rest[0])` (`:193`). For one-word names the check is repeated at `:312`, but for a name of several words it is the only guard. Without it, "김 미" would replace "김 민의".
  - The final-sigma fold (`:41`).
  - `safeDecode`'s ASCII fallback for a malformed run (`:363`).
  - The mark-span extension inside a word (`:138`). `pseudonymize` NFC-normalises first, so only the citation path, with NFD text, depends on it.
- **M4.** A handle used as a map key now replaces the bare word everywhere in folder names, as citations already did. Map `@la → P-1` blanks the Spanish article "la" in every folder name. This is the fail-safe side and now agrees with citations; it is noted because `pseudonymize` used to require the "@".
- **M5.** Shapes still kept, each defensible alone:
  - hiragana against katakana;
  - small caps (ᴍᴀʀɪᴀ);
  - Cyrillic or Greek look-alikes;
  - Arabic tatweel; ي against ی;
  - a three-word name in the orders ACB and BAC;
  - an address encoded 4 times;
  - a punycode host;
  - `%uXXXX` and `&#NN;` escapes;
  - `김민수2024`;
  - `maria 2024` against the map entry `maria2024` in titles.

  Folding tatweel, and treating kana as one script, would be cheap.
- **M6. Outside the task, seen on the way.**
  - A Korean creator `{family:"김", given:"민수"}` with the map key `김민수` makes `toCslItem` throw `ParticipantCodeMissingError`: `normName("김 민수")` keeps the space, because Hangul is not a no-space script. This fails closed. It is pre-existing.
  - `pseudonyms.ts:64` (`assignCodes`) looks keys up by `toLowerCase()` only, so "Lucia Fernandez" gets a new participant code where "Lucía Fernández" exists. That is the same folding gap, in identity rather than in scrubbing.

## The implementer's own doubts
- **Korean:** resolved by R380 and R383 (a), and built as ruled. I checked the middle, the end, one syllable, "김미" against "김민", the form written apart and an encoded address.
- **2-or-more-character no-space names over-scrub** (小明白了 → P-001白了): real. It is the fail-safe side, as noted.
- **A partly joined slug** (`lopezmariagarcia`): real. Minor.
- **Kana voicing folded:** real (ハナコ is replaced by the entry バナコ). Over-match, the fail-safe side.

## Checked and sound
- The wb1 C1, I1 and I2 probes are closed in both functions and in `urlNamesParticipant`, and the library test shows that the folder and the bibliography agree for the two creators it covers.
- Spans: surrogate pairs (𝐌𝐚𝐫𝐢𝐚) are replaced whole. A name at the very start or end, two names touching (`王小明李华` → `P-001P-002`), overlapping candidates (`王小明华` → `P-001华`, the leftmost wins) and NFD combining marks leave nothing of the name beside the code. "@" and "@@" go with the name.
- Folder length: `sourceFolderName` caps the title with `sanitizeSegment(…, 100)` after pseudonymising, and project export calls `sanitizeSegment`, so a longer result ("Li " ×100 → 800 characters) is cut and never left over-long. Cutting only removes text, so it cannot bring a name back.
- No participant involved: `pseudonymize` gives byte-identical results to the old code on NFC, NFD, full-width, ligature, Han, control-character and empty-map inputs. `toCslItem` with no forms skips scrubbing and keeps the URL, as before. No exported signature changed. `normName` is used only inside `csl-map.ts` and its test (no duplicate finder or verification imports it), and its one change (no-space words joined) is applied to both sides of the creator lookup.
- A malformed escape never throws, including a 900 KB `%25` chain (38 ms). The fold cache is capped at 65,536 entries. A 200-word name with rotations is handled in 0.2–0.3 s on 400 KB. Hangul runs of 500,000 characters with a 60-syllable name take 0.4 s, so the `maxPrefix` cap holds.
- Guards that do have a failing test when removed: the one-character rule, the 2-syllable rule, the no-space join in `normName`, the `maxPrefix` cap (through the linear test), the 3-level decode, and "@" going with the name.

## Could not verify
- I3 through the library (from reading only).
- Real-world frequency of the C1 characters inside names. The effect is shown; the likelihood is a judgement.
