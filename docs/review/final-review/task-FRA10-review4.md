# Review 4 (scoped, round 4 only, R427): FR-A10, one rule for recognising a participant's name

Reviewer: a fresh adversarial reviewer. Worktree `.claude/worktrees/agent-a45f6da14291d4e55`, branch `fr-a10-names`, b9c7cec..e74ed5a (four commits).
I read:
- both briefs;
- review 3;
- rulings R427 (every clause), R434, R403, R416 and R420 in full;
- the round's package (797 lines, once, in full);
- the report's "Round 7 (R427)" section.

I did not use `git stash`, and I modified no tracked file. Two probe files (`*.probeFRA10d.test.ts`, one in core, one in the library) were run alone at `nice -n 10` and then deleted. `git status --short` is empty, and the head is still e74ed5a.

## Verdict: NOT APPROVED

What the round was asked to build is built:
- (a) The more exact match wins. Review 3's I1 is closed on all four pairs, in both map orders: the author, the title, the folder name and `assignCodes`.
- (b) Runs of a name are coded inside creators.
- (c) Format characters are soft boundaries.
- (d) Two guard tests.

Two things stop approval:
- **C1.** The profile capture's look-up still files a profile under another participant's code. `assignCodes` links the same profile's source to a new participant. This was already true at base and this round did not cause it. But R427 a names this look-up, and R434 asks exactly this question.
- **I1.** R427 b, applied as written, now rewrites authors who only share a two-word given name or a compound family name with a participant: "Juan Carlos Onetti" is printed as "P-002 Onetti". This needs the coordinator's ruling.

## What I ran (all `nice -n 10`, single files, load about 3 to 9)
- **Core:** `src/naming.test.ts src/citation` passed 218/218. That run included my probe's 10 tests; the round's own count is 208.
- **Library:** `src/repo/pseudonyms.test.ts src/export/bibliography.test.ts` passed 38/38.
- **Core probe:** review 3's I1 rows for "김 민수"/"김민수", "山田 太郎"/"山田太郎", "Ana  Peña"/"Ana Peña" and "ＡＮＡ"/"ana", in both map orders. For each I checked the author, the title, `pseudonymize`, `sourceFolderName` and `mapCode`, plus a third spelling equal to both by the strict key. I also ran:
  - attacks on the "as written" step: "@" in front, an invisible character in the span, a rotation, a handle and a name held by two participants, a coded creator against the map;
  - leaks and over-reach for (b), 19 rows;
  - (c) with Arabic U+0600/U+0605/U+06DD, U+070F, U+08E2, Kaithi U+110BD, U+FFF9 to U+FFFB, a ZWJ emoji sequence, a tag-sequence flag, and Arabic names;
  - the cost of 50k, 100k and 200k characters of "a؅";
  - 14 agreement rows.
- **Library probe:** `pseudonymCodeFor` against `assignCodes` in a real encrypted project, and `participantCodeOf` on 11 keys.
- **Guards (d):** judged by reading. My instructions forbid editing tracked files, so I took no guard out.

## Findings

### C1. Critical (pre-existing at base, not introduced by this round; in scope because R427 a names this look-up). The profile capture files a profile under one participant while its source is linked to another
- **Where:**
  - `packages/library/src/repo/repo.ts:1262-1271` (`pseudonymCodeFor`, which tries each of `names` in turn);
  - `packages/library/src/capture/profile-capture.ts:373`: `names = [label, label without "@", "@"+label, profile.handle]`;
  - `packages/library/src/repo/pseudonyms.ts:32-35`: `creatorKey` is the handle, as written.
- **Probe (real encrypted project, `PSEUDO_GOV`):**
  1. A source by the interviewee "Maria" gives P-001.
  2. `pseudonymCodeFor(["@maria", "maria", "@maria"])` returns **P-001**: the second name, with the "@" stripped, equals "Maria" by the strict key.
  3. A source by `{role: uploader, handle: "@maria"}` is then linked to a **new participant P-002**.
  4. Probe output: `["profile","P-001",[[false,"P-001"],[true,"P-002"]]]`.
- **What the researcher meets:** the profile's folder is `profiles/<platform>-P-001` and its collection is labelled P-001, while its sources hang on P-002's record. If P-001 already has a profile on that platform, its `profile.json` is read and its `profileSourceId` reused. Consent and withdrawal act per record.
- **Base:** the old comparison (NFC + lower case, membership in `names`) gave the same answer. This round's strict key also widens it slightly (full-width letters, doubled spaces, invisible characters).
- **R427 a:** the clause asks that the profile capture use "the same identity look-up as `assignCodes` (one function)". The function is now shared, but its input is not the same: `assignCodes` looks up the creator's handle only, while the profile capture also tries the handle without "@".
- **Direction (coordinator's choice):**
  - look up `creatorKey` of the very creator `createProfileSource` will write, and nothing else;
  - or keep the variants only when the map entry they find is itself a handle-shaped key, and add a library test like the probe.

### I1. Important, for the coordinator's ruling: inside a creator with no code, a run that is a whole two-word GIVEN name or a whole compound FAMILY name is now replaced, so unrelated authors are rewritten
- **Where:**
  - `packages/core/src/participant-names.ts:700` (`indexesOf` now drops only `bare`);
  - run forms from `nameForms` (`:207-215`) carry no `bare`, even when the run is exactly the participant's given or family name.
- **Probe (`toCslItem`, webpage, author):**

  | participant | creator | printed |
  |---|---|---|
  | "Juan Carlos Pérez" | given "Juan Carlos", family "Onetti" | **`P-002 Onetti`** |
  | "María José Quispe" | given "María José", family "Ortega" | `P-001 Ortega` |
  | "Anna Maria Weber" | given "Anna Maria", family "Schmidt" | `P-003 Schmidt` |
  | "Lucía Fernández Ruiz" | given "Pedro", family "Fernández Ruiz" | `Pedro P-005` |
  | "Lucía Fernández Ruiz" | literal "Fernández Ruiz Abogados" | `P-005 Abogados` |

  The same happens through a coded creator's forms. In every row the citation key is withheld.
- **Harm:**
  - A real scholar's citation is broken, and another person's code is printed for them.
  - Worse, anyone who knows the cited work can read off the participant's given name, or family name, from "P-002 Onetti" or "Pedro P-005". That helps re-identify the participant.
  - Compound given names (María José, Juan Carlos, Jean-Pierre written apart, Anna Maria) and shared compound family names (siblings, parents) are common.
- **Is it what was ruled?**
  - R427 b's text says runs of two or more words that are forms by R403 c are replaced, and "Juan Carlos" and "Fernández Ruiz" qualify.
  - But R427 b also lists "a given name alone, a family name alone" as single names that are not looked for. A compound given or family name is both at once, and the ruling did not decide which wins.
  - The implementer's one changed expectation, "Diaz Ruiz Foundation" becoming "P-004 Foundation", is this same case: correct by the letter of R427 b, wrong by its stated purpose.
  - Titles already replaced such runs before this round (R403 c), so the creator now agrees with the title.
- **Direction:** a run counts inside a creator only when it crosses the given/family boundary of the participant's name. For a map string with no structure, use the coded creator's given/family where one is known. Or rule that the letter stands and list it with FR-699.

### Minor
- **M1. Outside the round, noted for the coordinator: a Hangul name written apart at every syllable is not replaced in text.**
  - Map `{"김 민수" → P-001}`: the title "김 민 수 habla" stays as written in `pseudonymize`, the folder name and the citation title. Yet the author "김 민 수" is coded P-001 by the strict key.
  - The forms split a joined Hangul name at one point only (`nameForms` `:197-205`, unchanged by this round), so this is pre-existing by reading.
  - It is a leak of the name, but a rare way of writing a name. It belongs to the M6 line of R387 and would need a task of its own.
- **M2.** `pseudonymCodeFor`'s doc comment says "by the SAME identity look-up as `assignCodes`". That holds for each name, but not for the list of names (see C1).
- **M3.** (c) has the ruled price of R403 a, now also for format characters. "Maria؅na" gives `P-001؅na`, and the Arabic "محمد؀علي" (a number sign between two words) is read as the one name "محمد علي". Both err on the safe side; "Ma؅riana" and "Ana؅lyse" are kept.

## Clause by clause

### (a) Review 3's I1: closed
- Both spellings of each of the four pairs, in either map order: the author, the title, `pseudonymize`, the folder name and `mapCode` each give each spelling its own code.
- The third spelling ("김 민 수", "山田　太郎", "ANA PEÑA", "Ana") takes the map's first entry by the strict key, and `participantCodeOf` agrees.
- The library test with a rewritten encrypted map shows `assignCodes` and `pseudonymCodeFor` agree on each single name.
- **"As written" never picks a worse match.** Equal as written (NFC) implies equal by `identityKey` (NFKC of NFC), so this step only chooses among the strict ties. The probes:
  - with `{"@ana" P-001, "Ana" P-002}`: "@ana" and "@Ana" give P-001; "Ana" and "ana" give P-002;
  - with `{"Ana Peña" P-001, "Ana  Peña" P-002}`: "Ana​ Peña", "Peña, Ana" and "ANA PEÑA" give the map's first, as before;
  - with `{"@maria" P-001, "maria" P-002}`: the text, the handle creator and the literal creator each get their own code;
  - a coded creator "Ana Pena" (P-002) with the title "Ana Peña y Ana Pena" gives `P-001 y P-002`.
- **No identity path uses the folded key:** `assignCodes` and `pseudonymCodeFor` both go through `participantCodeOf` (as written, then strict). The folded step of `mapCode` serves only the citation's coding of creators (the replacing side).

### (b) Review 3's I3: closed
- **Coded:** "Amigos de Lucía Fernández", its reversed forms ("Amigos de Fernández, Lucía", "Fernández Lucía"), the run across a ZWSP, the run without accents, an editor's literal, a translator's given/family, swapped given/family, the handles `@lucia.fernandez` and `@luciafernandez`, and "Fernández Ruiz, Lucía". All give the code, with the key withheld.
- **Kept:** "Maria Lopez" (participant "Maria Cocina"), "Amigos de Rosa", and "Ana Paz Roca" (the short words of "Ana Paz Vidal"). So single names and short runs are not replaced. The over-reach is I1.

### (c) Review 3's M5: closed
- `Ma￻ria`, `Ma؅ria`, `Mar܏ia` and `Ma࣢ria` give P-001 in all three paths.
- A name beside U+0600 digits, U+06DD, U+110BD, U+FFF9/U+FFFA, a ZWJ family emoji or a tag-sequence flag is replaced, and the neighbouring characters are kept.
- The cost is linear: 200k characters in 59 to 70 ms.
- R434's point (identity keeps non-ignorable format characters) does no harm I could find:
  - "Ma؅ria" becomes its own participant;
  - once that participant is in the map, the as-written step gives each spelling its own code in text and citation ("Ma؅ria y Maria" gives `P-002 y P-001`);
  - the only cost is one person becoming two, which the researcher merges (the side R403 b chose).

### (d) Review 3's M8: closed (judged by reading)
- Taking `identityKey`'s `.replace(IGNORABLE, "")` out makes "Ma​ria Cocina" differ from "Maria Cocina", so the first test gets P-002.
- In the second test, "​ ​" is found by the as-written step. The fallback guard is what keeps "⁠ ⁠" from equalling it, so with the fallback replaced by `identityKey(k) === n`, the second half fails.
- Both agree with the implementer's report of each mutation.

### What must still hold
- All of these pass: the touched files, the R416 pairs, R403 a (`⁨P-001⁩⁨P-002⁩`; folder `P-001P-002`), R403 c ("Juan de la ciudad" kept), and R420's whole names.
- The 14 agreement rows (the folder title, the citation title and `sourceFolderName`) agree on every row. They include Han, both Hangul spellings, Peña/Pena, ZWSP, U+FFFB, isolates, a handle, a reversed name with a comma, and full-width against ASCII.

## Could not verify
- **Guards by taking them out:** not done, because editing tracked files is forbidden in this dispatch. Judged by reading.
- **C1 through the real profile-capture flow:** I did not run the capture end to end. I reproduced it with the capture's own `names` construction, `pseudonymCodeFor`, and `addSource` of the creator `createProfileSource` writes.
