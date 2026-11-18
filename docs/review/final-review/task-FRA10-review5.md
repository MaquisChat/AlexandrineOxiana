# Review 5 (scoped, rounds 5 and 6, R437 and R438): FR-A10

Reviewer: the round-4 reviewer. Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, e74ed5a..e354ae4 (three commits).

I read:
- R437 and R438 in full;
- the package `review-FRA10-round5.diff` (582 lines, in full);
- the code around each change.

I did not use `git stash`, made no commits and modified no tracked file. Two probe files (`*.probeFRA10e.test.ts`, one in core, one in the library) were run alone at `nice -n 10` and then deleted. `git status --short` is empty, and the head is e354ae4.

## Verdict: APPROVED WITH SMALL POINTS (two points need the coordinator's ruling)

The three changes do what was ruled:
- **(a) Runs inside a given/family creator.** My round-4 I1 table is closed: every row is unchanged, and the citation key is kept.
- **(b) The profile capture asks for one key.** My round-4 C1 is closed.
- **R438 (a handle is one identity with or without its "@").** The posts, the profile's own source, the folder, the collection and the citation are one participant.

Nothing leaks that leaked before round 4. Two of the points below are leaks or over-reach that R437 a's own wording opens or leaves. That makes them rulings to make, not defects in how the round was built.

## What I ran (all `nice -n 10`, single files, load about 5 to 7)
- **Core:** `src/naming.test.ts src/citation` passed 215/215.
- **Library:** `src/repo/pseudonyms.test.ts src/capture/profile-capture.test.ts src/export/bibliography.test.ts` passed 75/75.
- **Core probe:**
  - my round-4 I1 table;
  - 22 leak and seam rows: short forms, swapped fields, one-field creators, a soft boundary at the seam, padded fields, inner double spaces, NFD, Han at the seam, a handle, RLO;
  - the `part` flag: a run of one participant that is the whole name of another, in both map orders, and a same-code whole name and its rotation or joined form;
  - a longer refused run against a shorter allowed match;
  - R438 text and addresses for the key "@fake.dancer".
- **Library probe:** `creatorKey` on 10 handle shapes, and `assignCodes` merges and splits (a literal "@maria", a literal "maria", legacy keys without "@", full-width "＠", invisible-only handles).

## Findings

### I1. Important, for the coordinator's ruling: a creator with ONLY a family name (or only a given name) holding a two-word run of the participant's name is printed again
- **Where:** `packages/core/src/citation/csl-map.ts:111`, which passes `if (!given || !family) return tryText(given ?? family, () => false);`.
- **Probe**, with the map `{"Lucía Fernández Ruiz" → P-005}`:
  - `{family: "Lucía Fernández"}` is printed as `{family: "Lucía Fernández"}` with the key `key`;
  - `{given: "Lucía Fernández"}` is printed the same way;
  - the literal `"Lucía Fernández"` gives `P-005`.

  Round 4 (R427 b) gave P-005 for all three.
- **Why it matters:** such creators are real data, not a curiosity:
  - the Zotero import makes `{family: l}` when the first-name box is empty (`packages/library/src/import/zotero-common.ts:258`). That is where a full name typed into the last-name box ends up;
  - BibTeX "Lucía Fernández, " also gives a family name only (`refman.ts:862`).

  A creator with only one field has no given/family structure to read, any more than a literal does. R427 b called such a creator "most likely the participant under her usual short name". R437 a's "takes words from BOTH fields" cannot be met by a one-field creator, so the implementer read it as "no run". That is the open side.
- **Smallest fix:** treat a one-field creator as one text, as R437 a does for a literal: `tryText(given ?? family)` with no `runSpan`. One test row each for family only and given only.

### I2. Important, for the coordinator's ruling: the "family given" reading lets a run join the family name's LAST word to the given name, so another person is coded
- **Where:** `csl-map.ts:112`, the second try `tryText(`${family} ${given}`, across(family))`.
- **Probe:** with the same map, `{given: "Lucía", family: "Ortega Fernández"}` prints **`Ortega P-005`**:
  - the "given family" reading, "Lucía Ortega Fernández", has no run of the participant's name;
  - the reversed reading, "Ortega Fernández Lucía", contains "Fernández Lucía", which crosses the seam and is a rotation of the run "Lucía Fernández".

  Lucía Ortega Fernández (first surname Ortega) is in all likelihood another person. Her citation is broken, and the code betrays that the participant's name is "Lucía … Fernández": the harm of round-4's I1 by another road. Spanish double surnames make this ordinary.
- **Why the second reading is not needed for runs:** run forms already carry their rotations (`ordersOf` in `nameForms`). So the first reading already finds "Fernández Lucía" for swapped fields: the probe gives `{given: "Fernández", family: "Lucía"}` → P-005. For runs, the second reading adds only spans that are not contiguous in the creator's own order.
- **Smallest fix:** in the second reading, refuse every run (`() => false`); whole names still count there. Add the probe row as a test. Swapped fields are still coded through the first reading.

### Minor
- **M1. A full-width "＠" is no longer read as "@" in a handle.**
  - `creatorKey` strips `/^@+/` only (`packages/library/src/repo/pseudonyms.ts:45`). So "＠x" gets the key "@＠x" (strict key "@@x"), while "@x" gets "@x".
  - Probe: two participants, `[["@＠x","P-001"],["@x","P-002"]]`. Before R438, NFKC made them one.
  - This is a split, not a merge (the safe side), and full-width "＠" is rare (CJK input).
  - Fix: `normalize("NFKC")` the handle before stripping, or strip `[@＠]+`.
- **M2. Handles made only of invisible characters now merge.**
  - `creatorKey(h("​"))` is `"@​"`, whose strict key is "@" and not empty. So R427 d's "compared as written" guard no longer applies.
  - Probe: the handles "​" and "⁠" are one participant, P-001.
  - This is pathological input, but it is the very case R427 d's test guards for literals.
  - Fix: strip invisible characters before testing whether a handle is empty, so it falls through to the literal; or keep the as-written comparison when the key minus its "@" has an empty strict key.
- **M3. The same-code whole name is refused inside one field when a run of the same folded units was indexed first.**
  - Where: `participant-names.ts:473-476`. The deduplication skips a whole-name rotation or joined form that equals an earlier run candidate, so `part` stays true.
  - Probe, with the map `{"Lucía Fernández Ruiz" P-005, "Lucía Fernández" P-005}`:
    - `{given: "Pedro", family: "Fernández, Lucía"}` is printed;
    - `{given: "Pedro", family: "LucíaFernández"}` is printed;
    - `{given: "Pedro", family: "Lucía Fernández"}` is coded, because the as-written form carries `written`.
  - R437 a says a whole name is replaced wherever it stands. The case is contrived.
  - Fix: set `had.part = false` before the deduplication check.
- **M4. Two guards have no test that fails without them** (judged by reading):
  - `if (!f.part) had.part = false`. Probe: `{Juan Carlos Pérez P-002, Juan Carlos P-007}` gives `P-007` in both map orders, which is right, but nothing asserts it;
  - stripping `runSpan` on the bidi-override path (`participant-names.ts:204-205`). Probe: an RLO "fernández lucía" with `runSpan: () => false` gives `P-005`, which is right, but nothing asserts it.
- **M5. The initials limit, as already stated.** `{given: "L.", family: "Fernández Ruiz"}` is printed, because the run lies wholly inside the family field. This is the limit already listed for initials ("M. Lopez"). It is no worse than before R427 b, but a title saying "L. Fernández Ruiz" would be coded beside it. Leave it with FR-699.

## Checked and sound
- **(a), my I1 table:**
  - Juan Carlos Onetti, María José Ortega, Anna Maria Schmidt and Pedro Fernández Ruiz are printed as they are, with the key `key`;
  - the literal "Fernández Ruiz Abogados" gives `P-005 Abogados`, as ruled.
- **(a), the participant's own short forms are coded:**
  - given Lucía with family Fernández, and the same swapped;
  - given "Lucía Fernández" with family Ruiz (her whole name);
  - a family field holding her whole name;
  - a ZWSP at the end of the given name or the start of the family name;
  - fields padded with spaces, NFD fields, and "Ana Lucía" with "Fernández Gómez" (`Ana P-005 Gómez`).
  - In a linked source her short form is coded, not refused.
- **(a), the offsets:** `tryText` matches on the joined trimmed fields themselves, so the offsets agree. NFD lengths are counted in the same string, and inner double spaces cause no shift: "Fernández  Pérez" gives `P-005  Pérez`.
- **(a), the matcher:** `runSpan` is asked only for `part` patterns. A pattern that is a run of one participant and the whole name of another counts as whole (P-007). A refused longer run does not hide a shorter allowed match at the same place: `{Ana María Gómez Ruiz P-001, Ana María P-009}` with given "Ana María" and family "Gómez" gives P-009. Runs at later tokens are tested on their own spans. The bidi path ignores `runSpan`, as ruled.
- **(b), C1 closed:**
  - the capture looks up `[creatorKey(profileCreator)]` only, and `createProfileSource` writes that same creator;
  - the implementer's three capture tests cover a participant "fake.dancer" (literal) against the profile "@fake.dancer" (two records; folder `tiktok-P-002`), an existing handle (one record), and the posts with the profile;
  - a profile with neither handle nor display name still fails closed, as before.
- **R438:**
  - `assignCodes` is the only writer of the map, and `creatorKey` its only key. `participantNames` feeds only folder names and citations, never identity.
  - A handle without "@" enters the map by no other road. The handle shapes " @x ", "@ x", "x " and "@@x" each give "@x"; "@" and "@@" fall through to the literal.
  - For the key "@fake.dancer", "fake.dancer" without "@", "Fake Dancer", "fakedancer" and the TikTok address are replaced in the title, the citation and the folder name, and `urlNamesAny` finds it in both address shapes.
  - A literal "maria" and a handle "maria" are now two people, as ruled.
  - The one merge R438 adds: the LITERAL "@maria" (or given "@maria") now joins the handle "maria". Before, it joined the handle "@maria" already. The text is written as a handle, so I judge this the same account, not two people. The coordinator may want to confirm it.
  - A legacy entry "maria" from a handle without its "@" gives a new participant, as ruled (listed, FR-702).

## Could not verify
- Guards by taking them out: editing tracked files is forbidden here, so M4 is judged by reading. The report says the runSpan filter's four table rows failed before the change.
- The whole profile-capture flow: I did not run a capture myself. I relied on the implementer's three capture tests (in the 75 that passed) and on reading `profileCreator` and its two callers.
