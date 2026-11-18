# Review — FR-A18 round 2 (Ruling R397): scoped second look

- Reviewer: the reviewer of round 1.
- Worktree `agent-a6ee131b0cb253cae`, branch `fr-a18-unreadable-rules`, head dfb8511 (six commits on da348d8).
- Read: the R397 ruling, the report's "Round 2 (R397)" section, the whole package.
- The probes (`apps/library-service/src/server.probeFRA18.test.ts`, `packages/library/src/repo/repair.probeFRA18.test.ts`) are deleted. Every mutation was undone with `git checkout -- <file>`; no stash was used. `git status --short` is empty.

## Verdict: APPROVED WITH SMALL POINTS

- Every clause (a)–(f) is built, and each guard is held by a test that fails without it (mutations below).
- **The repair door is sound.**
  - It opens only for `setGovernance`, and only while the engine cannot read the current file at decision time.
  - Without a reason it lets nothing through.
  - Every other change stays refused.
  - It is crash-safe: an interrupted repair rolls back to "missing".
  - Its audit entry is marked and verifies.
- Three Minor points (M1–M3) and two small test gaps (M4, M5); none blocks.

## Runs
1. **Service probe: the 23 shapes again**, plus a loop link, Unicode tag characters and other invisible characters, 30 warnings. Each GET was followed by a real change (POST collections):
   - **`readable` agrees with the engine in every row.** The one exception is the empty file in a project that is not encrypted: it is readable, and the engine refuses for encryption, which is the accepted FR-672.
   - Missing file and dangling link: `readable:false` with "The rules file (governance.yaml) is missing from this project's folder."
   - Folder and loop link: GET 200, `readable:false`, "The rules file could not be opened."; the retention GET answers 200.
   - Empty file: readable.
   - 60 unknown keys: 21 lines, the last "and 40 more.". 30 unknown-control exceptions: 21 warnings, the last "and 10 more.".
   - 100,000-character explicit key: one issue of 300 characters ending in "…".
   - No answer contained the temp path.
2. **Service saves:**
   - Missing or unreadable file, no reason: 400 "…is missing / cannot be read, so putting rules back needs a reason: consent.requireLegalBasis is looser than the strictest rules; …". That sentence is true: the loosening is computed against `DEFAULT_GOVERNANCE`.
   - With a reason: 200, then GET readable and the change is allowed.
   - Over a folder or a loop link: 400, in plain words, no path, no errno.
   - Over a dangling link: see M2.
3. **Library probe:**
   - Blank reason ("   "): refused. Zero-width-space reason: **accepted** (M1).
   - Two repairs at once: one 200, one `GovernanceConflictError`.
   - **Crash during a repair:**
     - at `before-changes` or `before-audit`: on reopen the file is **missing again**, warning `rolled-back-incomplete-write`, no pending write, a tag still refused, audit verifies;
     - at `before-marker-delete`: committed, file present, tag allowed, audit verifies;
     - unreadable file with a crash at `before-audit`: the unreadable text is restored.
     - The transaction log records the missing file as `created`, so the rollback deletes it rather than leaving an empty file, which would read as the defaults.
   - Locked project: `ProjectLockedError`, nothing written.
   - Present empty file (the defaults) in an encrypted project: an ordinary loosening still needs a reason, and an edit as strict as the defaults goes through with no reason. **The door is shut for a present, readable file.**
   - File missing again right after a repair: GET says missing, a tag is refused, and the next repair again needs a reason.
   - Audit entry of a repair: `{"op":"project.governance","loosened":[…],"repairedUnreadable":true,"rulesFile":"unreadable","reason":"repair",…}`. It holds no path and nothing of the unreadable file (which had a "SECRET-PARTICIPANT" value and a home path), and it verifies.
     - The **change log** does hold the old text as its before-image. This is the existing design for every rules edit (0600 in an unencrypted project, sealed in an encrypted one); it is not introduced here.
4. **Mutations, each reverted** (single test files, `-t "R397"`; each mutation fails the test named):

| Mutation | Test(s) that fail |
|---|---|
| GET without the `missing` branch | 3 tests |
| `repair \|\|` removed from the reason condition | "even rules as strict as the defaults need a reason" |
| no fallback for a missing file | 2 tests |
| `MAX_LINES` 2000 | the b test |
| `MAX_LINE_CHARS` 300000 | the other b test |
| hidden-character removal off | the d test |
| `readGovernanceFile` rethrows | the e test |
| the import reader always readable | the f test |
| (c) | Not re-mutated by me. The report's own mutation is consistent with the three tests I read (`server.test.ts`, describe "R397 b–d"). |

## Clause by clause
- **(a) First half: built and held.** Missing, dangling-link and empty cases are as ruled.
- **(a) Second half: built and held.**
  - Is judging the write itself under the NEW rules sound? **Yes.**
    - The fallback (`mutate.ts decide`) is used only when `governanceOf` throws at decision time, under the serial lock.
    - Only `setGovernance` passes it, and only `repairing` saves.
    - The write still needs a reason. It must pass the project-state checks (encryption) and the version check (409 on a race), and it is audited with `rulesFile`.
    - Under `DEFAULT_GOVERNANCE`, the encrypt condition would refuse every repair in a project that is not encrypted, so the ruled remedy would not exist.
    - "Decided as a change from the defaults" is met where it matters: the loosening list, the dialog's sentence, and the reason required even when nothing is loosened.
    - A race in either direction fails closed:
      - present-readable before the lock and missing under it: refused;
      - missing before the lock and empty under it: the fallback is unused, because the engine can read the file.
  - The approver: the service never checks one. Only the screen's dialog asks for it, as for every loosening (M1).
- **(b)** Built and held for issues. For warnings it is built (probe: 21 lines) but not tested (M4).
- **(c)** Held by three tests.
- **(d)** Built and held for the listed set. The set misses several invisible characters (M3).
- **(e)** Folder and loop link answer 200 with the sentence; a save over them is refused in plain words; tested. The no-permission case was not run as root. By reading the code, `readMaybe` rethrows EACCES, `isFsError` catches it, and the result is `unopenable`; the save goes through the same `readForEdit`. The `skipIf(root)` test exists.
- **(f)** Built and held.

## Findings

### Minor

**M1 — A reason that is only a zero-width space is accepted, and no approver is ever checked by the service.**
- Where: `packages/library/src/repo/governance-edit.ts` (`reason = opts.reason.trim()`); the dialog's check is `ReasonDialog.tsx:82` (`trim() !== ""`).
- Evidence: a repair with reason `"​"` returns 200 at both the library and the service. The dialog would also accept U+200B in both its fields.
- Effect: R397 says "ALWAYS with a reason and an approver"; only the screen asks for an approver.
- Smallest fix: count a reason as empty when it holds nothing but whitespace and `\p{Cf}`, in `setGovernance` and in the dialog. Whether the service should require an approver for a repair is the coordinator's ruling: today no route has one.

**M2 — A dangling link is said "missing", but the save that is meant to repair it fails with "That path is not allowed."**
- Where: `governance-edit.ts readGovernance` (ENOENT through the link reads as missing); the write is refused by the transaction's path guard (`mutate.ts TxImpl.guard`).
- Evidence:
  - GET says missing;
  - PUT without a reason → 400 "needs a reason";
  - PUT with a reason → **400 VALIDATION "That path is not allowed."**;
  - the file stays unreadable and everything stays refused.
- It fails closed, but the alert sends the researcher to a save that cannot work, and the words do not say why. The round-2 test for the link checks only the GET.
- Smallest fix: `lstat` in `readGovernance`. A link whose target is missing becomes `unopenable`: "could not be opened…; remove it from the project's folder", the same as the folder case.

**M3 — The hidden-character set is incomplete; the 300-character cut can split a pair.**
- Where: `apps/library-service/src/routes/governance.ts` `HIDDEN_CHARS`.
- Evidence: U+00AD (soft hyphen), U+034F, U+180E, U+3164 (a blank filler), U+FE0F and the Unicode tag characters U+E0000–E007F (invisible, able to carry hidden text) all pass into the issue. The regex has no `u` flag, so characters outside the BMP cannot be matched as written.
- The cut `slice(0, 299)` can leave a lone surrogate.
- Smallest fix: `/[\p{Cc}\p{Cf}͏ᅟᅠㅤ︀-️]/gu`. That covers the bidi marks, zero-width characters, soft hyphen and tag characters. Cut by code points.

**M4 — The bounds on warnings are not tested.**
- Only issues are tested. Removing `capped` from the warnings branch would pass every test (the probe confirms the behaviour today).
- Smallest fix: one test with 30 unknown-control exceptions → 21 warnings, the last "and 10 more.".

**M5 — The new Governance-screen tests passed at once.**
- The "R397 a" and "R397 d" screen tests confirm behaviour that already existed; they hold nothing new. No action needed beyond noting it.

## Checked and sound
- **Other changes while the file is missing:** collection, tag and time zone are refused (the service test).
  - Capture, import, export and destruction go through the same `decide` without the fallback, so they are refused too. Destruction's date read (`destroy.ts:203`) parses `""` as the defaults, but the destruction itself is a `runMutation` and is refused there.
  - The profile chooser and restore do not pass the fallback. The command line does not edit rules.
- **Read-only library:** `assertWritable` comes first in `setGovernance` and in `runMutation`.
- **During a move:** writes are refused by the existing quiesce, which this round does not touch.
- **The reason dialog's sentence** matches what is loosened (compared with the defaults), and still matches the screen's `/needs a reason/`.
- **The `UNREADABLE_GOVERNANCE` removal:** nothing else used it, and the type-check passed in the report's run.

## Could not verify
- The no-permission half of (e), because this runs as root; the code path above was checked by reading only.
- WebKit, and a screen reader.
