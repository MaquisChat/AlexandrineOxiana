# Task FR-A18: report (rules the app cannot read are now said on the screens; R379, R58)

Branch `fr-a18-unreadable-rules`, worktree `agent-a6ee131b0cb253cae`. Head **da348d8**. There are 4 commits on top of 7537f63:
- 15f1473: the service
- ce7b1e2: the Governance screen
- 519665f: the Capture screen
- da348d8: the Import wizard

`git status` is clean. Nothing was pushed.

## Point 1: the service says whether the engine can read the rules (15f1473)
- `packages/shared/src/api/governance.ts` (new, exported from `api/index.ts`):
  - `GovernanceReadability { readable: boolean; issues: string[]; warnings: string[] }`. All three fields are required.
  - The four screen texts.
- `apps/library-service/src/routes/governance.ts:69-87`: new `governanceReadability(yaml, roots)`.
  - It runs `parseGovernanceWithWarnings` and then `effectivePolicy`, which is the same strict read the library uses.
  - Unreadable: `issues` takes the `GovernanceParseError.issues` lines (for example `residencey: unknown key (check spelling) in governance.yaml`). When those are empty, as with invalid YAML or a top level that is not a mapping, it uses the first line of the message without the `governance.yaml:` prefix.
  - Every line goes through `scrubPaths(…, state.roots)` and is collapsed to a single line.
  - Readable: `issues: []`, and the warnings are cleaned the same way.
- GET (`:105`) and PUT (`:130`) spread these fields into their answers. PUT reports on the text just saved. That text is always readable, because the library refuses an unreadable one, but its warnings may not be empty.
- Nothing else in the route changed.
- **Built differently from the brief:** `issues` is always present (`[]` when readable), not only when the file is unreadable. This gives a stricter type.
- Tests in `apps/library-service/src/server.test.ts`, describe "FR-A18 …". All 4 failed first (`readable` was undefined).
  - The reviewer's probe file gives `readable:false`, with an issue naming `residencey`. Neither the temp folder nor the library path appears in the body, and no line has a newline or stack.
  - Text that is not YAML gives one single-line issue.
  - The old-form `manual_upload` key gives `readable:true` with the "…manual_upload: ignored…" warning. An ordinary file gives `{readable:true, issues:[], warnings:[]}`.
  - The PUT answer carries the warnings of an exception that waives nothing, and is empty after a save of an ordinary file. No path appears in it.

## Point 2: the Governance screen (ce7b1e2)
- `packages/ui/src/api/governance.ts`: `GovernanceFile` and `GovernanceSaved` now extend `GovernanceReadability`.
- `packages/ui/src/screens/GovernanceSettings.tsx`:
  - The `readability` state is set from GET (`:138`) and from the save answer (`:228`).
  - `<RulesReadability>` sits directly under the h1 (`:282`) and is defined at `:492-531`.
  - Unreadable: `role="alert"`, class `ao-warning`, the exact sentence, then the issues as `ul.ao-list`, each through `UserText`.
  - Readable with warnings: a `div.ao-hint` (not an alert) with "The rules were read, with these notes:" and the list.
  - The cards and the YAML editor are unchanged, and focus is not moved.
- Tests appended to `GovernanceSettings.test.tsx` (describe "rules the engine cannot read are said …"):
  - Test 1 (failed first): alert with its issue; cards render; `activeElement` is body; a corrected text saves and the alert goes.
  - Test 2 (failed first): note, not an alert; it goes after a save.
  - Test 3: with neither, nothing new is shown. This one passed before and after.
  - The existing 53 tests are unchanged and pass.

## Point 3: Capture and Import (519665f, da348d8)
**Capture**
- `api/capture.ts`: `policy()` now also takes the service's `readable:false` as unreadable (`:584-589`). It shares the strict `UNREADABLE_POLICY` constant (`:135`) with `capturePolicyFromYaml`'s fallback.
- `screens/Capture.tsx:743`: `<p className="ao-capture__note">` with the exact sentence, next to the downloader note, when `policy.readable` is false.
- **Not shown when the rules request itself failed.** That path already sets `readable:false` and shows its own error, so saying "cannot be read" there would be false.

**Import**
- `api/import.ts`: `ImportPolicy` is unchanged, so the existing `toEqual` tests and the ZoteroSync and ReviewQueue literals are untouched.
- New `ImportPolicyRead extends ImportPolicy { readable }` (`:292`). `policy()` returns it (`:338`); the service's `readable:false` gives the strictest reading.
- `screens/import/ImportWizard.tsx`: `rulesUnreadable` state (`:88`). The sentence is shown on the first step through the existing `ErrorNote` (`:271`). The controls stay strict.
- **What I found for the brief's question about the Library drop zone:** it does not read the policy. `Library.test.tsx` even asserts zero reads of the rules, so nothing was added there.

**Tests**
- Test helpers: `test/captureService.ts` gets an `unreadable` option and `test/importService.ts` a `governanceUnreadable` option. The mocked GET answers now carry the readability fields.
- `Capture.test.tsx`:
  - Service `readable:false` shows the sentence (failed first).
  - Rules the screen itself cannot parse show it too (failed first).
  - Readable rules do not show it.
  - A failed rules request does not show it.
- `ImportWizard.test.tsx`:
  - Unreadable shows the sentence and "Link in place" stays disabled (failed first).
  - Readable does not show it.

## End to end
No spec in `e2e/` edits a `governance.yaml` on disk, so per the brief none was added. A real Mac (WebKit) run was not done.

## Runs (all at nice -n 10)
- Touched files:
  - service `server.test.ts`: 117/117
  - UI (GovernanceSettings, Capture, capture api, ImportWizard, import api): 216/216
- Whole service suite: 1027 passed, 2 failed, 1 skipped (1030). Both failures are in files I did not touch, and each was re-run alone:
  - `main.test.ts` "refuses at once when standard input is closed…": **passes alone**.
  - `find-browser-routes.test.ts` "the pause after a hand-over…": **fails alone too**. It expects "Ready in 20 seconds." and gets "Ready in 19 seconds.", a wall-clock countdown under machine load. It has nothing to do with the rules.
- Whole UI suite, run under heavy load. Failures, each re-run alone:
  - PdfPages ×10: pass alone (17/17).
  - GovernanceSettings' Elicit box test: passes alone (56/56).
  - ToolsSetup: passes alone (29/29).
  - Library.reader: passes alone (9/9).
  - ReviewQueue "loads titles six at a time": fails alone as well. This is the test the house rules name as known to fail under load.
  - The suite's final summary line was cut off by my output filter (`head`), so I cannot give its exact totals.
- Other checks:
  - `@ao/shared` vitest: 52/52.
  - `pnpm -r typecheck`: exit 0.
  - `lint:css`: exit 0.
  - `lint:colours`: "ok: no hard-coded colours".
  - `@ao/ui build`: "✓ built" (chunk-size warning only).

## Minor (deferred)
- minor (deferred): when the current file is unreadable, a save still needs a reason, and the reason dialog shows the machine-built sentence (WB6 M6). Not touched.
- minor (deferred): the Import wizard's `.catch` fallback to STRICT, on a failed request, says nothing about the failure (as before).
- minor (deferred): ReviewQueue and ZoteroSync read `importApi.policy` but do not show the unreadable sentence. The brief names only the wizard's first step and the drop zone.

## Round 2 (R397)

Fresh implementer, same worktree and branch (`fr-a18-unreadable-rules`). It started at da348d8 and made 6 commits:
- a3341be: (a)
- b6287be: (b)
- c94619a: (c)
- 0f4b760: (d)
- 22b12d9: (e)
- dfb8511: (f)

### (a) I1: "no file" is not "an empty file", and the Governance screen can put the rules back (a3341be). Both halves are built.

**The library, `packages/library/src/repo/governance-edit.ts`**
- `readGovernance` now also returns `file: "present" | "missing"`. A missing file and a link that leads nowhere both give ENOENT, so both read as missing. `Repo.getGovernance` carries the field (`repo.ts`).
- `setGovernance`:
  - Before the lock, a missing or unreadable current file sets `unreadablePolicyFallback`, as before, for the unreadable case only.
  - Under the lock (`:156-173`), the file as it is now is classed `repair = "missing" | "unreadable"`.
  - The loosening and the new profile violations are then computed against `DEFAULT_GOVERNANCE` (`const from = cur ?? DEFAULT_GOVERNANCE`).
  - A repair ALWAYS needs a reason: `GovernanceLooseningError(loosened, fresh, repair)`. Its message is "The project's rules file is missing / cannot be read, so putting rules back needs a reason[: X is looser than the strictest rules …]". It still matches the screen's `/needs a reason/`, so the "Record a reason" dialog opens and records the reason with the approver: "reason (by)".
  - Audited as the rules' edit, with the reason, plus `rulesFile: "missing" | "unreadable"` (`repairedUnreadable: true` is kept).
  - The write goes through `runMutation` as before: crash-safe and audited.
  - The constant `UNREADABLE_GOVERNANCE` (the old pseudo-control in `loosened`) is removed. Nothing else used it.

**Built differently, for the coordinator to confirm**
- "Decided as a change from the defaults" is applied to the edit's decision: what counts as loosened, the profile violations, and the reason.
- The policy gate for the write itself is still evaluated under the NEW rules (`unreadablePolicyFallback: next`). This is what already happened for an unreadable file.
- Evaluating that gate under `DEFAULT_GOVERNANCE` would refuse every repair in a project that is not encrypted. The defaults require `encryption.atRest: required`, which gives an `encrypt` condition, and `enforceConditions` turns that into "Governance requires encryption at rest, but this project is not encrypted" (`mutate.ts:338-351`).
- No other change gets the fallback, so everything else stays refused (tested).

**The service, `routes/governance.ts`**
- GET answers `{yaml:"", readable:false, issues:["The rules file (governance.yaml) is missing from this project's folder."], warnings:[]}` for a missing file.
- An empty file is unchanged: readable, the defaults.

**Tests (through the real service, no mock)**
- `server.test.ts`, describe "FR-A18 round 2 (R397 a)". The missing and dangling-link tests failed first: `readable` was true.
  - A deleted file:
    - collection, tag and time-zone changes are each refused (403);
    - GET answers the sentence;
    - an unreadable text is refused with 400;
    - a save without a reason gets 400 VALIDATION "…needs a reason";
    - the three changes are still refused;
    - a save with "reason (Ana)" gets 200 and writes the file;
    - GET says readable;
    - the three changes are allowed;
    - the audit has the edit with `rulesFile: "missing"`, no path, and the audit verifies.
  - The same for the whole-branch review's probe file (`rulesFile: "unreadable"`).
  - A dangling link reads as missing.
  - An empty file stays readable.
  - In an encrypted project, rules as strict as the defaults still need a reason. A project that is not encrypted cannot save the defaults at all: `setGovernance` refuses rules the project cannot meet.
- `service-support.test.ts`:
  - New: the missing case at library level. It failed first.
  - Changed: "an unreadable governance.yaml can be replaced…". R397 changes its expectation: `loosened` was `["(unreadable governance.yaml)"]` and is now `loosenedControls(DEFAULT_GOVERNANCE, OPEN_GOV)` with `repair: "unreadable"`; the audit also has `rulesFile`.
- `GovernanceSettings.test.tsx`, "R397 a: a missing file…": the alert shows the issue; the save gets 400 "needs a reason"; the dialog takes the reason and the approver; the second PUT carries "Putting the rules back (Ana)"; the alert goes. This passed at once, because the screen already handled the flow. It confirms the screen side; it was not a test that failed first.
- Capture and Import already take the service's `readable:false`. Their round-1 tests cover the sentence.

### (b) M2 (b6287be)
- `governanceReadability`:
  - at most 20 lines, then "and N more.";
  - each line at most 300 characters (299 + "…");
  - the same bounds for warnings (my choice).
- The shared type's documentation says so.
- Tests: 60 unknown keys give 21 lines, the last "and 40 more."; a 100,000-character explicit key gives one issue of at most 300 characters, ending in "…". Both failed first: 60 issues, and one of 100,049 characters.

### (c) M3 (c94619a), tests only
- A value holding `<library>/secret-notes.txt` must not contain the temp path.
- A value `/Users/ana/private/consent.pdf` must come back as `<path>`.
- A double-quoted value with `\n` must read "first line second line".
- These pass against the code. A mutation check showed they hold it:
  - with `scrubPaths` removed, both path tests fail;
  - with the whitespace collapse removed, the newline test fails.

### (d) M4 (0f4b760)
- Before the path scrub, the issue text loses C0 and C1 controls, U+061C, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069 and U+FEFF (`HIDDEN_CHARS`). This runs after whitespace is collapsed, so a newline still becomes a space, and before the scrub, so a hidden character cannot split a path.
- Test: the probe key `"<img src=x onerror=alert(1)>‮\a​⁦"`. The issue keeps the angle brackets and has none of those characters. It failed first.
- UI test "R397 d": the issue is shown as text and no `img` exists. It passed at once (`UserText`).

### (e) M5 (22b12d9)
- `readGovernanceFile`, used by `Repo.getGovernance`, answers `file:"unopenable"` (empty text) for a file-system error other than ENOENT. `readGovernance` itself still throws, so `destroy.ts` and `getGovernanceText` (the project list's capture methods) keep failing closed as before.
- GET answers `readable:false`, issues `["The rules file could not be opened."]`. The retention GET is no longer a 500.
- A save over it gets **400 VALIDATION**: "The rules file could not be opened (something other than a readable file, such as a folder, is in its place), so it cannot be replaced from here. Remove it from the project's folder, then save the rules again." The read inside the lock does the same.
- Test: a folder in the file's place gives GET 200 with the issue, and the PUT gets 400 with no path and no "EISDIR". It failed first with a 500.
- The no-permission test is written with `it.skipIf(root)` and is **skipped here (runs as root)**.

### (f) M6 (dfb8511)
- `api/import.ts`, `policy()`: when the answer has no `readable` field, `readable` comes from its own strict parse (`readImportPolicy`). `importPolicyFromYaml` is unchanged in behaviour.
- Test: an answer without the field and with the probe text gives `readable:false` and the strictest policy; OPEN rules give `readable:true`. It failed first.

### Only a real Mac can show
- File permissions as a non-root user (the skipped half of (e)).
- WebKit. No end-to-end spec was added, per R395 b.

### Minor (deferred)
- minor (deferred): `GET /projects` (`routes/projects.ts` `captureMethods`) reads a MISSING file as the defaults, so the browser extension lists default capture methods while the engine refuses them. This goes with M7 / FR-673.
- minor (deferred): GET still parses the YAML twice (the `violations` block, then `governanceReadability`), as M2 noted.
- minor (deferred): M1 / FR-672 and M7 / FR-673, as R397 g lists.

### Use of git stash (before the coordinator's note)
- Once, before the coordinator's note, I used `git stash push` and then `git stash pop`, both in one command a few seconds apart. The purpose was to show that the library tests of (a) failed without the fix.
- After the pop, the working tree held exactly my 6 modified files. `git stash list` is empty now.
- I used no stash after the note.

### Runs (nice -n 10; load average about 30–36)
The whole suites ran detached, because the foreground limit is 10 minutes; logs are `fra18-*.log` in the scratchpad.

**Touched tests, R397 (all pass)**
- service: 14 tests in the R397 describes; the no-permission test is skipped as root
- library: service-support "Task 30 review round 1", 8 tests
- UI: GovernanceSettings FR-A18, 5 tests
- UI: import.test with ImportWizard, 60/60

**Whole suites**
| suite | result | failures |
|---|---|---|
| `pnpm -r typecheck` | exit 0 | — |
| `@ao/shared` | 52/52 | — |
| `@ao/library` | 3700 passed, 18 failed, 5 skipped | all timing or performance budgets |
| `@ao/library-service` | 1039 passed, 2 failed, 2 skipped | `find-browser-routes` countdown; `main.test` closed standard input |
| `@ao/ui` | 109 files passed, 4 failed (18 tests) | PdfPages ×15, `client.test` linear SSE, FindAcquire R342 j, ReviewQueue "six at a time" |

None of these failures is in a file I touched.
- `@ao/library` failures, by file: `html-strip`, `custom-styles`, `extract`, `refman`, `watch`, `zotero-local`, `annotations-cap`.

**Re-runs alone (the files together)**
- library: 15 still fail under this load, all timing budgets; `custom-styles` and `watch` passed.
- service: `main.test` passes. The `find-browser-routes` countdown fails again; it is the known R173 case.
- UI: PdfPages, `client` and ReviewQueue pass.
  - FindAcquire failed on a different R342 j test this time ("after Cancel…"), so it is flaky under load.
  - Nothing in FindAcquire or its API was changed.

**UI checks**
- `lint:css`: exit 0
- `lint:colours`: "ok: no hard-coded colours"
- `build`: "✓ built in 6.77s"

`git status --short` is empty. Nothing was pushed.

## Round 3 (R421)

Branch `fr-a18-unreadable-rules`, from dfb8511. Four commits: 5f06c20 (a), b9b0e5b (b), 83af01d (c), 6468cb1 (d). No stash was used and nothing was pushed. `git status` is clean.

### (a) M1: a reason that holds nothing a person can see is no reason (5f06c20)

**What changed**
- `governance-edit.ts`, `setGovernance`: a reason that is only `[\s\p{Cf}]` becomes "". Both a repair and an ordinary loosening then get `GovernanceLooseningError` ("…needs a reason").
- `ReasonDialog.tsx`: the new helper `seen()`. Both fields must hold a visible character, or "Record reason" stays disabled (and a submit does nothing).

**Tests (all three failed first)**
- Library, `service-support` "R421 a": the reason " ​⁠﻿­\n" is refused for an ordinary loosening (audit off) and for a repair of a missing file.
- Service: a repair PUT with the reason "​⁠ ﻿" gets 400 "needs a reason", and the file stays missing.
- UI, `ReasonDialog` "R421 a": the button stays disabled for an invisible reason and for an invisible approver.

**The approver field.** The save request has NO approver field. The route body is `{yaml, reason?, baseSha256?}` and the library's options are `{baseSha256, reason?}`. The approver exists only in the dialog, which sends "reason (approver)" inside `reason`. As instructed, no field was added (FR-692).

### (b) M2: a link whose target is missing cannot be opened (b9b0e5b)

**What changed**
- `governance-edit.ts`: new `readRulesBytes`. When `readFile` gives ENOENT but `lstat` finds an entry (a link to nothing), it throws a file-system error. Through that:
  - `readGovernanceFile` (the screen's GET; the import and Capture readers read the same GET) answers `unopenable`, with "The rules file could not be opened.";
  - `readGovernance` throws, so `destroy` fails closed as before;
  - the edit's read inside the lock refuses with `GOVERNANCE_UNOPENABLE_SAVE`.
- `GOVERNANCE_UNOPENABLE_SAVE` now names the link case: "…such as a folder or a link to a file that is not there… Remove it from the project's folder, then save the rules again."
- The engine's own `governanceOf` still says "missing" in its refusal for a dangling link. It refuses either way; not changed.

**Tests**
- Service "R421 b", dangling link: GET 200 with `readable:false` and the "could not be opened" issue. A save with a reason gets 400 with that sentence, not "That path is not allowed.", and no path. It failed first: GET said missing. The round-2 test "a symbolic link that leads nowhere is missing too" is REMOVED, because R421 changes its expectation; this test replaces it.

**A link whose target exists and is readable: unchanged**
- GET reads through it (`readable:true`, the target's text), and the engine allows changes under it.
- A save over it is refused with 400 VALIDATION "That path is not allowed." (the transaction's path guard does not write through a link); the target is untouched.
- Held by the test "R421 b: a symbolic link to a readable file outside the library…".

### (c) M3 (83af01d)
- `HIDDEN_CHARS = /[\p{Cc}\p{Cf}͏ᅟᅠㅤ︀-️]/gu`.
- The cut at 300 is now by code points: `[...line]`.
- Tests (both failed first):
  - the key "ab­c\U000E0041dㅤe️f͏gᅟhᅠi" gives "abcdefghi: unknown key…";
  - 298 × "k" followed by emoji gives exactly 300 code points, ending in "😀…", with no lone surrogate.

### (d) M4 (6468cb1)
- Test: 30 exceptions on unknown controls give 21 warnings, the last "and 10 more.".
- Checked: it fails (30 warnings) with `capped` removed from the warnings branch, and passes with it.

### Runs (nice -n 10)
- service `server.test.ts`: 134 passed, 1 skipped (the root-only permission test)
- library `service-support.test.ts`: 29/29
- UI (ReasonDialog, GovernanceSettings, import api): 86/86
- `pnpm -r typecheck`: exit 0
- `lint:css`: exit 0
- `lint:colours`: "ok: no hard-coded colours"

### Minor (deferred)
- minor (deferred): a link to a readable file is refused on save with "That path is not allowed.", which does not say why. This is existing behaviour.
- minor (deferred): the engine's refusal reason for a dangling link reads "governance.yaml is missing".
