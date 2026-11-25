# FR-756, the other screens (b) — report

Worktree `.claude/worktrees/kg-7`, branch `fr-756-other-screens`, from 8155fe1. Not pushed. Six commits:

| commit | screen(s) |
|---|---|
| 357d8ce | governance: the project's rules, the audit log, fieldwork, the governance route's list of projects (+ `components/TryAgain.tsx`, `api/governance.ts` optional signals) |
| 57869ed | "Your library" |
| e7bd228 | Search sources |
| d4bcbb2 | Optional tools |
| 2795da8 | the extension's pairing screen |
| 5862c40 | appearance: the researcher's name |

**Status: built, with one screen left for a ruling (missing files, below) and one with nothing to mend (the move screen).**

## How it is done (the same on every screen)

- Every first read the screen needs goes through `readWithin(…, firstReadMs)` (20 s by default, `FIRST_READ_TIMEOUT_MS`), with the request's signal passed in, so the request is cancelled when the read is given up and a late answer changes nothing.
- Each screen gets a `firstReadMs?: number` prop (default `FIRST_READ_TIMEOUT_MS`). This is the prop shape FR-750's screens use. Tests pass `firstReadMs={300}`. No other seam was added.
- A read given up at the limit shows the screen's EXISTING alert (same element, same class) with "The library service did not answer in time." (`SERVICE_NO_ANSWER`, the error's own message). It is never run together with "could not be reached": where a screen used `errorText`/`toolsErrorText`, a no-answer error now takes the error's message directly.
- A read that FAILS shows exactly what it showed before. "Try again" is added where the service could not be reached (`isUnreachable`, as FR-750). A refusal with an answer gets no "Try again", except on the researcher's name, where the brief asks for it on any failure.
- "Try again" comes from a new small component, `packages/ui/src/components/TryAgain.tsx`: a real `<button>` labelled "Try again". Pressed, the screen clears its alert and reads again, so the loading words come back where the screen has them. When the button goes away, focus goes to the screen's heading (`tabIndex={-1}` added where it was missing) rather than to the page. If the read is given up again, the alert and the button come back.
- Additions to shared code (no existing meaning changed): `api/governance.ts` `projects`, `getGovernance`, `audit`, `participants`, `sessions` and `consents` take an optional `{ signal }`. `yourLibraryApi.read` and `searchSourcesApi.read` take an optional `{ signal }`. `api/firstRead.ts`, `api/client.ts` and `test/service.ts` are unchanged; the tests use `hang()` from `test/service.ts`.
- No event stream was touched. The governance route's stream is left as it is (R597).

## Per screen

### 1a. Governance — the project's rules (`screens/GovernanceSettings.tsx`)
- **First reads:** `GET …/governance` blocks the screen ("Loading the project's rules…"). `GET …/protocol/documents` (ProtocolDocuments) and `GET …/retention` (RetentionDue) do not block it: they are side sections, unchanged. A hang leaves their section empty, and a failure says their own sentence.
- **Mend:** `:142` readWithin; `:150` `loadUnreachable`; `:286` TryAgain under the alert (the press clears `loadError`, so "Loading the project's rules…" shows meanwhile). The h1 takes focus (`tabIndex=-1`, ref) in all three render paths. "Reload" (after a conflict) goes through the same `load` and so has the limit too.
- **Tests** (`screens/governance.firstReads.test.tsx`, "FR-756: Governance (the project's rules)"):
  - "a read of the rules that never settles is given up at the limit: the alert and “Try again”; pressed, it reads again, the loading words meanwhile, and focus is not lost". It failed first: no "Try again".
  - "a read of the rules that FAILS says what it said before, now with “Try again”". It failed first.
  - "a read of the rules refused with an answer says its sentence as before, with no “Try again”". A guard: it passed before and after.

### 1b. The audit log (`screens/AuditLog.tsx`)
- **First reads:** `GET …/audit` (the page) blocks the table. **This screen has no loading words**: while the page is unread, it shows only the heading, "Verify integrity", the empty "Needs attention" section and the library's log section. No loading words were added (that would be a new sentence). `GET …/attention` (NeedsAttention) does not block and is unchanged: a hang leaves the "Needs attention" section empty under its heading, and a failure shows its own alert. The library's audit log is read only when its button is pressed, so it is not a first read.
- **Mend:** `:470` readWithin; `:519` TryAgain under the existing alert; the h1 takes focus.
- **Tests:** "a read of the log that never settles is given up at the limit: the alert and “Try again”; pressed, the log is shown and focus is not lost" and "a read of the log that FAILS says what it said before, now with “Try again”". Both failed first.

### 1c. Fieldwork (`screens/Fieldwork.tsx`)
- **First reads:** participants, sessions and consents are read together (`Promise.all`) and block the screen ("Loading…"). One `readWithin` covers all three, each request with the signal. The re-read after each act goes through the same `load`, so it has the limit too.
- **Mend:** `:159` readWithin; `:247` TryAgain in the loading branch; the h1 takes focus in both render paths.
- **Tests:** "a read of the records that never settles is given up at the limit: the alert and “Try again”; pressed, it reads again, the loading words meanwhile, and the records are shown" and "a read of the records that FAILS says what it said before, now with “Try again”". Both failed first.

### 1d. The governance route's list of projects (`routes/governance.tsx`)
This read is not on the brief's list, but it is a first read of all five governance screens.
- **First reads:** `GET /projects` blocks only when the address names no project ("Choose a project first." for ever on rules, audit and fieldwork). With `?project=` the screen shows itself. `GET /libraries` (the library's mode, on rules and fieldwork) does not block and is unchanged: a hang or failure leaves the read-only reason unsaid, and the service still refuses. The event stream is unchanged.
- **Mend:** `:90` readWithin, cancelled on clean-up; `:102` a give-up shows its sentence and leaves `projects` unread, so the project named in the address is still shown and "not in this library" is NOT said. A failed read keeps today's path: `projects=[]` and `errorText`. `:174` TryAgain (`listTry` re-runs the read); focus goes to the project picker.
- **Tests:**
  - "a list that never settles is given up at the limit: the alert and “Try again” (not “not in this library”); pressed, the project's screen is shown"
  - "a list given up at the limit leaves the project named in the address shown, never “not in this library”"
  - "a list that FAILS says what it said before, now with “Try again”"
  - All failed first.

### 1e. Missing files (`screens/MissingFiles.tsx`) — NOT BUILT: a question
- **First read:** `GET /libraries/integrity` ("Checking the library…") blocks the screen. It only reads, and writes nothing (`packages/library/src/reconnect.ts` checkIntegrity: "Reads only; writes nothing").
- **Why it was not built:** it is not a quick read. It hashes a sample (5%) of the library's files, and it waits for its turn in the write queue (`apps/library-service/src/routes/libraries.ts:418-437`). A large library on a slow or external drive, or a check queued behind a long import, may legitimately take more than 20 s. With the limit, the screen would say "did not answer in time", and "Try again" would start the hashing again from the beginning. So a slow but working check could never finish on screen.
- **Options:**
  - (a) A longer limit for this read only, for example two minutes.
  - (b) No limit, with the reason noted.
  - (c) The 20 s limit as for the others, accepting the risk.
- **Recommendation:** (a), with the existing sentences and "Try again" exactly as on the other screens.

### 1f. The move screen (`screens/MoveLibrary.tsx`) — nothing to mend
- **First reads: none.** The screen shows its form at once. Its requests are "Check destination" (a POST plan on a press), the move (an act) and the status polling after a move. None is a first read. **The file is not changed**, so it merges cleanly with the other branch.

### 2. "Your library" (`screens/YourLibrary.tsx`)
- **First reads:** `GET /settings/your-library` blocks the screen ("Reading the Your library settings…"). It had a 60 s give-up (`within`) that left the request running and said "The Your library settings could not be read.".
- **Mend:** `:305` readWithin (20 s, request cancelled). A give-up now says "The library service did not answer in time." (R586 M5). A failure says `sentenceOf(err, loadFailed)` as before. `:681` TryAgain. The heading already had `tabIndex=-1`; it got a ref. The re-reads after a save or a conflict use the same `read` and have the limit; they set the alert only while nothing is confirmed, as before.
- **Tests** (`screens/YourLibrary.test.tsx`, "Your library: a first read that never settles (FR-756, R584, R586)"):
  - "is given up at the limit: the alert and “Try again”; pressed, it reads again, the loading words meanwhile, and the settings are shown with focus kept". It failed first.
  - "a read that FAILS says what it said before, now with “Try again”". It failed first.
  - "a read refused with an answer says its sentence as before, with no “Try again”". A guard.

### 3. Optional tools (`screens/ToolsSetup.tsx`)
- **First reads:** `GET /tools` blocks the list ("Reading the list of tools…"). It already had an alert with "Try again" on any failure. The job reads (`GET /tools/jobs/:id`) are polling after a start, not first reads, and are unchanged.
- **Mend:** `:134` readWithin with the screen's own abort signal. A give-up says the error's message alone: `toolsErrorText` would have joined it to "could not be reached". `:540` the existing "Try again" is now TryAgain: the press clears the alert, so the loading words show while it reads, and focus goes to the h1 (now `tabIndex=-1`). This last part changes the existing "Try again" for failed reads too: before, the alert stayed up during the retry.
- **Tests** (`screens/ToolsSetup.test.tsx`, "the optional tools screen: a first read that never settles (FR-756, R584, R586)"):
  - "is given up at the limit: the alert (its sentence alone) and “Try again”; pressed, it reads again, the loading words meanwhile, and the tools are shown with focus kept". It failed first.
  - "a read that FAILS says what it said before, with “Try again”". A guard: it passed before and after.

### 4. Search sources (`screens/SearchSources.tsx`)
- **First reads:** `GET /settings/search-sources[?project=]` blocks the screen ("Reading the Search sources settings…"). `GET /projects`, read for the project's name in the rules note, does not block and is unchanged: it is silent, and the note simply has no name. The key-status reads (`GET /secrets/*`, KeyField) belong to each key field, after the settings are shown, and are unchanged.
- **Mend:** `:260` readWithin. `:266` a give-up is not taken for "the project could not be read": no project sentence, and no second read without the project. It goes straight to the screen's alert, while a failure keeps today's path. `:638` TryAgain: it reads again with the project and clears both sentences meanwhile. The heading got a ref.
- **Tests** (`screens/SearchSources.test.tsx`, "Search sources: a first read that never settles (FR-756, R584, R586)"):
  - "is given up at the limit: the alert and “Try again”; pressed, it reads again (with the project), the loading words meanwhile, and the settings are shown with focus kept". It failed first.
  - "a read that FAILS says what it said before, now with “Try again”". It failed first.
  - "a read refused with an answer says its sentence as before, with no “Try again”". A guard.

### 5. The extension's pairing screen (`screens/ExtensionPairing.tsx`)
- **First reads:** `GET /extension/pairings` blocks only the "Paired browsers" section ("Reading the list…"). "Show a pairing code" does not need it and stays usable; the test asserts this. The code-status polling happens after a code is issued (an act) and is unchanged.
- **Mend:** `:185` readWithin with the screen's abort signal. It applies to every list read, including the quiet re-reads while the "port changed" notice shows; a give-up there stays quiet, as a failure does. `:645` TryAgain under the list's alert; focus goes to the "Paired browsers" heading, which already took focus. A no-answer error shows its own message instead of `errorText`.
- **Tests** (`screens/ExtensionPairing.test.tsx`, "the pairing screen: a first read of the list that never settles (FR-756, R584, R586)"):
  - "is given up at the limit: the alert and “Try again” (pairing stays usable); pressed, it reads again, the loading words meanwhile, and the list is shown with focus kept". It failed first (checked by putting back the old file).
  - "a read that FAILS says what it said before, now with “Try again”". It failed first.
  - "a read refused with an answer says its sentence as before, with no “Try again”". A guard.

### 6. Appearance — the researcher's name (`screens/ResearcherName.tsx`)
- **First reads:** `GET /settings/researcher` gates only the name field and its Save button. The rest of the appearance screen (`AppearanceSettingsScreen`) does not need it. The screen's own settings read, in `theme/AppearanceProvider.tsx` `client.appearance.get()`, has no limit and is unchanged. If it hangs, the screen shows the defaults, stays usable, and says nothing. Not on my list; noted below.
- **Mend:** `:29` readWithin, cancelled on clean-up. A give-up shows "The library service did not answer in time."; a failure shows the existing sentence. `:86` TryAgain on a give-up OR any failure, as the brief asks, shown only while the name is unread. It does not appear for a failed save. `readTry` re-runs the read. The h2 "Researcher name" takes focus (`tabIndex=-1`). The field and Save stay off until the name is read (41b2 M9 unchanged).
- **Tests** (`screens/ResearcherName.test.tsx`, "researcher name: a first read that never settles (FR-756, R584, R586)"):
  - "is given up at the limit: the alert and “Try again”, the field still off; pressed, it reads again and the field is on with the name, focus kept". It failed first.
  - "a read that FAILS says what it said before, now with “Try again”; pressed, the field is on". It failed first.
  - "a refused save is not offered as “Try again” for the read". A guard.

## Every sentence shown (word for word)

**No new sentence was written.** Each one below already existed in the app.
- "The library service did not answer in time." (`SERVICE_NO_ANSWER`, existing). It is newly shown on every screen above when a read is given up. On "Your library" it replaces, for the give-up only, "The Your library settings could not be read." (shown at 60 s before, now at 20 s).
- "The library service could not be reached." (existing): failed reads, as before.
- Button "Try again" (existing words): newly added on the rules, audit log, fieldwork, governance list, Your library, Search sources, pairing list and researcher name. On the tools screen it was already there.
- Loading words, unchanged: "Loading the project's rules…", "Loading…", "Reading the Your library settings…", "Reading the Search sources settings…", "Reading the list of tools…", "Reading the list…", "Choose a project first.".
- Researcher name, failed read (unchanged): "Your name as researcher could not be read, so it cannot be changed here now. Nothing was changed."

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

- New or changed test files:
  - `screens/governance.firstReads.test.tsx` (new): 10 passed
  - `screens/YourLibrary.test.tsx`: 56
  - `screens/SearchSources.test.tsx`: 37
  - `screens/ToolsSetup.test.tsx`: 32
  - `screens/ExtensionPairing.test.tsx`: 69
  - `screens/ResearcherName.test.tsx`: 6
- Other files for the changed screens and the governance api:
  - `screens/GovernanceSettings.test.tsx`: 65
  - `screens/AuditLog.test.tsx`: 18
  - `screens/Fieldwork.test.tsx`: 31
  - `routes/governance.test.tsx`: 20
  - `screens/MoveLibrary.test.tsx`: 26
  - `screens/MissingFiles.test.tsx`: 5
  - `dialogs.r145.test.tsx`: 42
  - `routes/tools.test.tsx`: 9
  - `App.test.tsx`: 16
  - `reachability.test.tsx`: 3
  - `screens/AppearanceSettings.test.tsx`: 24
  - `screens/AppearanceSettings.reset.test.tsx`: 10
  - All passed.
- `@ao/ui` typecheck: clean. `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
- One run of `SearchSources.test.tsx` printed an MSW "unhandled request" line. It came from my new test ending before the key fields' read. Mended: the test now waits for that read, as the file's `show()` does. Two full runs after that were clean.
- No browser scenario was run (none asked). `git status --short` is empty; no process left.

## Uncertain, left out, and found beyond the list

- **Missing files:** needs a ruling (1e).
- **The audit log has no loading words.** While its page is read, and after "Try again", nothing says it is reading. Adding words would be a new sentence; my suggestion is "Reading the audit log…".
- **The governance route, a FAILED list with a project in the address** (pre-existing, unchanged because a failed read must show what it showed before): it sets the projects to none, so it also says "The project named in the address is not in this library. Choose a project from the list." and shows "Choose a project first.". This is untrue: the list was not read. The give-up path does not do this.
- **Side reads left without a limit** (they block nothing): the rules' protocol documents and retention; the audit log's "Needs attention" (a hang leaves its section empty); the governance route's library mode; Search sources' project name; the appearance settings read in `AppearanceProvider`. If that last one hangs, the screen shows defaults and no alert. It has its own alert and "Try loading again" for a failure, but not for a hang.
- **Same fault, beyond my list, not mended:**
  - `theme/AppearanceProvider.tsx:105`: as above.
  - `screens/SourceDetail.tsx:508` "Loading…": a source's detail. Opened inside the library screen and from watched folders. Its read has no limit.
  - `screens/NewProject.tsx` "Reading the library's projects…": a read inside the create flow.
  - `components/ChoosePersonDialog.tsx` and `ChooseWorksDialog.tsx`: reads made on demand inside dialogs, possibly from outside services; arguably not first reads of a screen.
- **A late answer is cancelled:** every limited read passes `readWithin`'s signal to its request.
- **Two extra changes to existing behaviour, noted:** the tools screen's existing "Try again" now shows the loading words and moves focus to the heading. On "Your library" a hung read now gives up at 20 s instead of 60 s, with the R586 sentence instead of "could not be read".
