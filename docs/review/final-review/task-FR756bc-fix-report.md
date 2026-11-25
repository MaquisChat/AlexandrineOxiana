# FR-756, the other screens — fix round after the review (R605)

Worktree `.claude/worktrees/kg-7`, branch `fr-756-screens`, from b8a320d. Not pushed. **Status: built.** Every finding has its own commit:

| commit | finding |
|---|---|
| 97efd55 | I1 capture route |
| bc47e39 | M1 governance route |
| 1e497d4 | I2 one sentence, one "Try again" per page (adds `components/PageReads.tsx`) |
| 7caeb94 | I3 transcript viewer |
| dca09a6 | M2 import wizard |
| 2c1a7b1 | M3 leaving a screen cancels its reads (adds `components/leaveSignals.ts`) |
| 03a038c | M4 search sources |
| 82abf5d | M5 re-read after an act |
| aab8963 | M6 shared limited read (adds `allOrCancel` to `api/firstRead.ts`) |
| 0838e05 | M7 capture "Reconnect" |
| de02a65 | M11 missing tests (adds `asksInTurn`, `REFUSED_READ` to `test/service.ts`) |

M1 was committed before I2 because the I2 mirror test (a failed list with `?project=`) needs M1 to be true.

Additions to shared code. Each is an addition; no existing export changes meaning:
- `api/firstRead.ts:76` `allOrCancel(signal, reads)`.
- `test/service.ts` `asksInTurn(path, steps, answer?)` and `REFUSED_READ`.
- New `components/PageReads.tsx` (`usePageHost`, `usePageRead`, `PageReads`).
- New `components/leaveSignals.ts` (`useLeaveSignal`, `useLatestRead`).

`api/client.ts` is unchanged. `screens/import/ReviewQueue.tsx`, the library screen and the Find screens are not touched.

## Important

### I1 — capture route keeps the working screen
- **Tests** (`screens/Capture.firstReads.test.tsx`, "Capture route: the list of projects with a project in the address (FR-756, R605 I1)"):
  - "a list given up at the limit leaves the working Capture screen as it was: links being typed are not lost, and nothing says the project is not one of the library's". It holds the route's ask, which is the second `/projects` ask. It types a link, waits past the limit, and reads the field. **Failed first**: two alerts, and the screen was gone.
  - "a list that failed with no answer leaves the Capture screen too, and never says the project is not one of the library's". **Failed first**.
- **Mend:** `screens/Capture.tsx:1194` — the route's failure branch no longer calls `setProjects([])`. A list that was not read (given up, or failed) stays unknown. The project in the address keeps its working screen, and "not one of this library's projects" is said only of a list that was read.
- **Compared with 8155fe1:**
  - A held list behaves as it did before: the screen keeps working.
  - A FAILED list used to empty the list, unmount the screen and say "not one of…". It no longer does. R605 I1 says "nothing says … of a list that was not read", and M1 rules the same for the governance route, so I applied it to failures too. **Uncertain:** this changes what a failed list shows on capture. See below.
- Without `?project=`, a failed or given-up list shows the same as before: "Choose a project" and no screen.

### I2 — one sentence and one "Try again" per page
- **Mechanism:** `components/PageReads.tsx`.
  - The route is the page's host (`usePageHost`). The screen inside reports its unanswered sentence, whether a read is still out, and its retry (`usePageRead`).
  - While the route's own read is unanswered, the route shows the page's one alert: `oneNoAnswerSentence` over the route's and the screen's sentences. The screen hides its own sentence and button (`yields`).
  - Otherwise the screen shows its own alert as before.
  - Either "Try again" calls `retryAll`, which reads again every part of the page that is unanswered or still out.
  - A screen shown alone, with no host (its own tests), is unchanged.
- **Governance:**
  - The host is at `routes/governance.tsx:121-130`, and the alert and button at `:183-191`.
  - The route now passes its `firstReadMs` on to the three screens (`:30-32`).
  - The screens:
    - `GovernanceSettings.tsx:166` (render `:300-306`)
    - `AuditLog.tsx:495`
    - `Fieldwork.tsx:193`
- **Capture:** the host is at `Capture.tsx:1209`; the screen is at `:498` (render `:858-879`).
- **Tests** (`screens/governance.firstReads.test.tsx`, "FR-756, R605 I2: …"):
  - "on $path: the list given up at the limit and the screen's read failed with no answer say “could not be reached” alone, with one “Try again”, which reads both again". This is the reviewer's probe, run for `/governance`, `/audit` and `/fieldwork`. All three **failed first** with two alerts.
  - "the mirror: the list failed with no answer and the screen's read given up …". **Failed first**.
  - "both given up at the limit say “did not answer in time” alone, with one “Try again”". It passed before the mend, but only because the screen still had the 20 s limit then.
  - "the screen's read failed while the list is still out: the screen's alert alone; its “Try again” reads the list still out again too". **Failed first**.
- **Capture tests** (`Capture.firstReads.test.tsx`, "Capture route and screen: one sentence and one “Try again” for the page (FR-756, R605 I2)"):
  - The probe: the route's list given up, and the screen's rules failed. **Failed first**.
  - Its mirror. **Failed first**.
- **Which route + screen pairs can double:**
  - **Governance route + rules / audit log / fieldwork: can.** Mended.
  - **Capture route + Capture: can** (since I1 keeps the screen up under a given-up or failed list). Mended.
  - **Reader route + reader: cannot.** The route shows the screen only once both of its reads are answered. A read again ("Open again") sets "Opening the source…", which unmounts the screen. A failed read replaces the screen with the route's failure view. So the route never has an unanswered read while the screen is shown.
  - **Import route + wizard: cannot.** `importRoute` makes no read for the wizard path (`routes/import.tsx:24-35`). Its `ReviewRoute` reads only while picking, shows no wizard, and is not limited (untouched, not mine).
  - Within the wizard itself, the one-"Try again" rule also covers M2's button (below).

### I3 — the transcript Version box
- **Tests** (`screens/TranscriptViewer.firstReads.test.tsx`):
  - "a versions read that hangs is given up at the limit…" now also checks the box after the give-up, `versionBox()` = `[""]`. **Failed first** (`"No transcript yet"`).
  - "a versions read that failed with no answer never shows “No transcript yet” in the Version box (R605 I3)". **Failed first**.
  - "a versions read that refused with the service's own words never shows “No transcript yet” …". **Failed first**.
- **Mend:** `TranscriptViewer.tsx:217-222` adds the state `versionsUnread`. In the catch (`:294`) the list is no longer set to `[]`. A read that failed before the versions were ever read sets `versionsUnread` instead. The box's empty option (`:775`) shows `""`. "Try again" (`readAgain`, `:373-376`) clears it, so "Loading…" comes back.
- A list read and found empty still says "No transcript yet".

## Minor

- **M1** (`governance.firstReads.test.tsx`, "FR-756, R605 M1: …"):
  - Tests:
    - "a list that failed, then was given up on “Try again”: never “not in this library”, and the project's screen stays"
    - "a list given up, then failed on “Try again”: …"
  - Both **failed first**.
  - Mend: `routes/governance.tsx:105-113`. A failed or given-up list no longer touches `projects`: unread stays unread, and a list read earlier stays as it was. "The project named in the address is not in this library. Choose a project from the list." is said only of a list that was read and lacks the project (the existing test `routes/governance.test.tsx` "an unknown project in the address…" still passes).
- **M2** (`screens/import/ImportWizard.firstReads.test.tsx`, "Import wizard: rules that could not be read are said where the options are forced (FR-756, R605 M2)"):
  - Tests: "rules given up at the limit: …" and "rules failed with no answer: the Options step says the strictest options are used, with “Try again”, which reads them and shows the options they allow". Both **failed first**.
  - Mend: `ImportWizard.tsx:45` (sentence), `:121-123` (state), `:183-190` (the catch sets it; `rulesTry` reads again), `:202` (`readAgain` reads the rules too), and the Options step note and "Try again" (`:380-395`).
  - The existing note `IMPORT_RULES_UNREADABLE_TEXT` ("This project's rules cannot be read, so nothing can be imported here. Correct them on the Governance screen.") is about a rules file the engine cannot parse, so it is not true here. The NEW sentence is used.
  - There is one "Try again" on the page: the one above (open/projects) also reads the rules again, and the Options step's button shows only when that one does not.
- **M3:** one test per screen, each "…: the request's signal is aborted when the screen is left". All six **failed first**.
  - Tests:
    - `governance.firstReads.test.tsx` (rules, audit log, fieldwork)
    - `YourLibrary.test.tsx`
    - `SearchSources.test.tsx`
    - `ImportWizard.firstReads.test.tsx` (StepRun, the check on arrival)
  - Mends:
    - `components/leaveSignals.ts`: `useLeaveSignal` is an outer signal aborted at unmount. `useLatestRead` does the same, and also cancels a read still out when a newer one replaces it.
    - `GovernanceSettings.tsx:141-147`, `AuditLog.tsx:472-476`, `Fieldwork.tsx:161-172` use `useLatestRead`.
    - `YourLibrary.tsx:300-308` and `StepRun.tsx:60-65` use `useLeaveSignal`.
    - `SearchSources.tsx:253-293` uses a per-project controller, aborted at a project change and at unmount (M4).
- **M4** (`SearchSources.test.tsx`):
  - Tests:
    - "Search sources: the project left (FR-756, R605 M4) › a give-up of the read of the project left never shows on the project chosen": A held, then switch to B held, then A's limit passes. **Failed first**.
    - "… given up before the switch › its alert goes when another project is chosen: the loading words for the project chosen". **Failed first**.
  - Mend: `SearchSources.tsx:286-296`. Choosing another project aborts the reads of the one left (whose catch then says nothing) and clears its alert.
- **M5** (`governance.firstReads.test.tsx`, "FR-756, R605 M5: …"):
  - Tests:
    - "fieldwork: a refused act keeps its message when the re-read after it is given up; the give-up is the screen's alert with “Try again”, which reads again". **Failed first**: no "Try again", and the act's message was replaced.
    - "the audit log: after a set-aside, a re-read of the log given up keeps the screen's earlier message and says the give-up with “Try again”". **Failed first**.
  - Mend: the sentence of a read that got no answer is kept apart from `error`:
    - `Fieldwork.tsx:113-117` and `:184-189`; render `:270-280` (loading view) and `:296-304` (records view)
    - `AuditLog.tsx:463-467` and `:482-488`; render `:532-542`
  - An answered log read still clears the screen's alerts, as before (noted in the test).
- **M6:**
  - Tests:
    - `governance.firstReads.test.tsx` "a records request that fails cancels the two still out, long before the limit": **failed first**.
    - `routes/reader.firstReads.test.tsx` "a source read that fails cancels the read of the libraries still out, long before the limit": **failed first**.
    - `api/firstRead.test.ts` "allOrCancel (R605 M6)": two tests. They were written after `allOrCancel` existed in the working tree; a planted fault (the cancel removed) made the first fail.
  - Mend: `api/firstRead.ts:76-93` `allOrCancel`, used at `Fieldwork.tsx:166-172` and `routes/reader.tsx:200-202`.
- **M7** (`Capture.firstReads.test.tsx` "“Reconnect” also makes again the first reads still out (R605 M7)"):
  - **Failed first** (rules asked once).
  - Mend: `Capture.tsx:900-906`. The press calls the page's `retryAll`: Capture's first reads still out or unanswered, and on the route its list too.
- **M11:** the tests not already brought by the above:
  - "a late answer of the read given up, after “Try again”, changes nothing (its request was cancelled)".
  - "an answered failure after a give-up takes the give-up's sentence away (rule ii)".
  - Each is on the rules, audit log, fieldwork and the governance route's list (`governance.firstReads.test.tsx`), and on Your library, Search sources, the tools screen, the pairing list and the researcher's name (each screen's own test file).
  - These test behaviour that already held, so they passed when written.
  - Planted faults: with the request's signal dropped, the late-answer test failed on the audit log, Your library, Search sources, tools, pairing and researcher name (each run, then restored).
  - Rule (ii) cannot be made to fail through "Try again": the press clears the sentence before it reads again, which is also the reason given in the c report.
- **M8, M9, M10:** nothing done, as ruled.

## Every sentence shown (word for word)

**NEW:**
- "This project's rules could not be read, so the strictest options are used. Try again to read them." (import wizard, Options step, M2)

Existing words, now shown in new places:
- "The library service did not answer in time." / "The library service could not be reached." (one per page, I2)
- "Try again" (button)
- The empty Version option `""` replaces "No transcript yet" for versions never read (I3; no words).

Unchanged and still said where true:
- "The project named in the address is not in this library. Choose a project from the list."
- "The project in this address is not one of this library's projects. Choose a project."
- "Progress updates are not available right now. Captures keep running in the library service; the queue below may not show their latest state." with "Reconnect"
- "No transcript yet"
- "Loading…"
- "Loading the project's rules…"
- "Reading this project's rules…"
- "Reading the Search sources settings…"
- "Choose a project first."

## Test files run (each alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

Final state (after de02a65):

| area | file | tests |
|---|---|---|
| api | `api/firstRead.test.ts` | 6 |
| | `api/client.test.ts` | 43 |
| components | `components/MissingToolNotice.capture.test.tsx` | 4 |
| | `components/MissingToolNotice.hookups.test.tsx` | 8 |
| routes | `routes/governance.test.tsx` | 20 |
| | `routes/import.test.tsx` | 18 |
| | `routes/reader.find.test.tsx` | 22 |
| | `routes/reader.firstReads.test.tsx` | 5 |
| | `routes/reader.test.tsx` | 13 |
| | `routes/tools.test.tsx` | 9 |
| | `routes/transcript.test.tsx` | 4 |
| screens | `screens/Library.reader.test.tsx` | 9 |
| | `screens/AppearanceSettings.reset.test.tsx` | 10 |
| | `screens/AppearanceSettings.test.tsx` | 24 |
| | `screens/MissingFiles.test.tsx` | 5 |
| | `screens/MoveLibrary.test.tsx` | 26 |
| import | `screens/import/ImportWizard.firstReads.test.tsx` | 13 |
| | `screens/import/ImportWizard.test.tsx` | 56 |
| | `screens/import/StepReport.test.tsx` | 25 |
| | `screens/import/StepScan.test.tsx` | 3 |
| | `screens/import/StepSource.shell.test.tsx` | 7 |
| | `screens/import/ReviewQueue.look.test.tsx` | 18 |
| capture | `screens/Capture.firstReads.test.tsx` | 14 |

| | `screens/Capture.test.tsx` | 65 |
| governance | `screens/governance.firstReads.test.tsx` | 32 |
| | `screens/AuditLog.test.tsx` | 18 |
| | `screens/Fieldwork.test.tsx` | 31 |
| | `screens/GovernanceSettings.test.tsx` | 65 |
| transcript | `screens/TranscriptViewer.firstReads.test.tsx` | 11 |
| | `screens/TranscriptViewer.test.tsx` | 66 |
| settings | `screens/YourLibrary.test.tsx` | 59 |
| | `screens/SearchSources.test.tsx` | 42 |
| | `screens/ToolsSetup.test.tsx` | 34 |
| | `screens/ExtensionPairing.test.tsx` | 71 |
| | `screens/ResearcherName.test.tsx` | 8 |
| reader | `screens/Reader.firstReads.test.tsx` | 4 |
| app | `App.test.tsx` | 16 |
| | `dialogs.r145.test.tsx` | 42 |
| | `reachability.test.tsx` | 3 |

39 files, 929 tests, all passed. No time-out was seen.

Checks:
- `pnpm --filter @ao/ui run typecheck`: clean.
- `lint:css`: clean.
- `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
- `git status --short`: empty. No process left.

## Uncertain

- **Capture, a FAILED list with `?project=`** (I1): the screen now stays and "not one of this library's projects" is no longer said of it. This is a change from 8155fe1. I followed R605 I1's "nothing says … of a list that was not read" and M1's ruling for the governance route. If a failed list should keep its old display, revert `Capture.tsx:1194`'s branch for non-give-up failures (the I1 failure test would then need to go).
- **I3 and a REFUSED versions read** (a 500 with the service's words): the brief says "(or failed)", so it also no longer says "No transcript yet". Its error sentence is shown as before.
- **The page's one alert sits where the route's alert was** (under the picker), not inside the screen, when the route's list is unanswered. The screen shows only its heading (and, on the audit log, its other sections) meanwhile.
- **The audit log:** an answered page read still clears a "Verify integrity" failure's message (pre-existing). M5 keeps that message only across a give-up.
- **M2:** the note shows on the Options step only, where the options are forced. The Review step lists the strict rules without saying why.
- **Capture's own "Try again"** now also makes again a first read still out (it called `readAgain(false)` before). This follows I2's "reads again everything still out".
