# FR-756, the other screens: adversarial review (`fr-756-screens` b8a320d, diff 8155fe1..HEAD)

Reviewed in `.claude/worktrees/kg-7`. Nothing on the branch was changed. Probe tests were written, run and removed. Each fault was planted in a copy and the file restored byte for byte (checked). `git status --short` is empty.

## Verdict: NOT APPROVED (three Important findings, eleven Minor; no Critical)

What held:
- Every `readWithin` and `answerWithin` call the diff adds is a read. No act has the limit.
- The import's "Opening the import…" read and the run step's arrival check are plain GETs. Starting, resuming or claiming is never retried by "Try again".
- Late answers are cancelled through the signal.
- `answerWithin` gives up an answer that never begins and never cuts one that has begun (proved with a planted fault, below).
- The four streams are given up at the limit and opened afresh with a pause. An open, quiet stream is never dropped, and all four tests watch the request's signal.
- Each planted fault made its tests fail.
- `ReviewQueue.tsx` is untouched.

The faults found are untrue screens and the R602 M1 rule broken where a route and its screen share a page.

## Important

**I1 — Capture route: a list of projects given up tears down a working Capture screen and says the project is not in the library.**
- Screen: capture (`/capture?project=P1`).
- Sequence (probed):
  1. The route's `GET /projects` is held; the Capture screen's own reads answer.
  2. The Capture screen shows itself, and the researcher may be typing links.
  3. At the limit the route's give-up runs `setProjects([])` (`screens/Capture.tsx:1180`). Then `unknown` becomes true (`:1193`) and `projectId` becomes `""` (`:1194`).
- Shown: the Capture screen is **unmounted**, so typed links are lost. Two alerts appear: "The library service did not answer in time." and "The project in this address is not one of this library's projects. Choose a project."
- Should be: the Capture screen stays. Only the route's sentence and "Try again" are shown, and never "not one of this library's projects", because the list was not read.
- Before this work a hang there left the screen working, so this is a regression. It is the same untruth the governance route's builder avoided (`routes/governance.tsx:102`) and R601 (b) ruled out.
- Smallest mend: in the give-up branch, set the error and `unanswered` but **not** `setProjects([])`, as `routes/governance.tsx:102-105` does. Add a test with `?project=` and only the route's read held. The probe must hold the SECOND `/projects` ask: the child's effect asks first.
- Once mended, the page is subject to R602 M1, like I2.

**I2 — Governance route and its screen show two sentences and two "Try again" at once (R602 M1 broken).**
- Screens: the governance screens (rules, audit log, fieldwork) at `/<screen>?project=p1`.
- Sequence (probed on `/audit?project=p1`):
  1. `GET /projects` is held.
  2. `GET /projects/p1/audit` fails (`Response.error()`).
- Shown: the alerts read `["The library service did not answer in time.", "The library service could not be reached."]`, with **2** "Try again" buttons.
- Should be: "The library service could not be reached." alone, with one "Try again" that makes both reads again.
- Cause: branch (b) was built before R602 and was not brought up to M1 at the merge. The route (`routes/governance.tsx:172`) and the screen (`screens/AuditLog.tsx:518`, and likewise `GovernanceSettings.tsx:286` and `Fieldwork.tsx:246`) each say their own sentence.
- Smallest mend: the route passes its unanswered sentence down, or takes the screen's up through a callback, and renders one `oneNoAnswerSentence` and one "Try again". Or the screen hides its sentence and button while the route's list is unanswered and adopts the route's "Try again". Add a test.

**I3 — Transcript viewer: a versions read given up says "No transcript yet".**
- Screen: transcript viewer.
- Sequence (probed): `GET …/transcripts` is held to the limit.
- Shown: the alert "The library service did not answer in time." and, in the Version box, **"No transcript yet"**. `setVersions((v) => v ?? [])` runs on every unanswered failure (`screens/TranscriptViewer.tsx:289`), and the box renders `[]` as "No transcript yet" (`:770`).
- Should be: nothing that claims the source has no transcript, since the versions were never read.
- The test "a versions read that hangs … in place of a waiting list" does not check the box. A failed read did the same before, but a give-up should not repeat it (rule 5).
- Smallest mend, no new words: `{!versions?.length && <option value="">{unanswered.versions && !versionsRead.current ? "" : versions ? "No transcript yet" : "Loading…"}</option>}`. Or do not set `[]` for an unanswered read while `!versionsRead.current`, keeping the empty option. Add an assertion on the box after the give-up.

## Minor (eleven)

- **M1 (matters most):** the governance route gives a false "not in this library" after a failure and then a give-up (`routes/governance.tsx:106`, by reading the code). A failed list sets `projects` to `[]`. "Try again" then gives up, and that path leaves the earlier `[]` in place. "The project named in the address is not in this library" therefore stays beside "did not answer in time". Mend: in the TryAgain press, `setProjects(undefined)`, or in the give-up branch reset `[]` back to `undefined` when it came from a failure. The bare failure case is older and ruled for the remainder (R601 b).
- **M2 (matters most):** the import wizard takes given-up rules strictly and says nothing (`ImportWizard.tsx:226`). The Options step forces "Copy into the library" and similar defaults, with no word why. A failed read does the same today, so it is kept, but the researcher cannot tell that the rules were not read. Suggest the existing unreadable-rules note, or a sentence, in the remainder.
- **M3:** leaving a screen does not cancel a held read. `GovernanceSettings.tsx:142`, `AuditLog.tsx:470`, `Fieldwork.tsx:159`, `YourLibrary.tsx:305`, `SearchSources.tsx:260` and `StepRun.tsx:63` pass no outer signal, so the request lives up to 20 s after unmount. A late answer sets state only on an unmounted component, which is harmless. R586 M7 precedent. The governance screens are keyed by project, so a project switch cannot leak state.
- **M4:** Search sources, by reading the code. The address's project changes while A's read is out and B's is also out. A's give-up passes `seq >= applied.current` (`:272`), because nothing has been applied yet, and shows "did not answer in time" on B until B answers. Mend: compare `project` with `projectRef.current` in that branch, or abort the older read on a project change.
- **M5:** a re-read after an act on Fieldwork (`:202`) or the audit log's set-aside (`AuditLog.tsx:284`) can be given up. On Fieldwork it then overwrites the act's own error with "did not answer in time", and the main branch has no "Try again" (only the unread branch has one).
- **M6:** `Promise.all` inside one `readWithin` (Fieldwork, the reader route). When one request fails at once, the others are not cancelled until they settle or the limit passes. `readWithin` aborts only at the limit or the outer abort.
- **M7:** capture's stream that never opens: three tries (about 60 s), then the existing "Progress updates are not available right now…" with "Reconnect". The words are true. It never recovers by itself; a press is needed (probed: 3 attempts in 12× the limit, a 4th only after the press). The press does not remake given-up first reads (`again` is false on the first opening after it); their own "Try again" does.
- **M8:** reader. A range asked for during the opening keeps the limit on its answer beginning even if the document opens meanwhile. `opening` is read when the range is asked.
- **M9:** the reader route's "…did not answer in time, so this PDF cannot be shown." is said when the read given up was the source's. It follows the existing unreachable sentence.
- **M10:** import wizard. When the opening is given up, the Source step is shown under the alert, as if a new import were being set up. It is the same as for a failed opening today. No import can be started twice by "Try again": it only re-reads.
- **M11, tests missing:**
  - cancellation at unmount (b screens);
  - a late answer after "Try again" on the b screens (relied on through `readWithin`, not tested);
  - the capture route with `?project=` (I1);
  - the route and its screen together (I2);
  - the transcript Version box after a give-up (I3);
  - rule (ii) on the b screens (an answered failure after a give-up), which is guarded only by code shape.

## Every `readWithin` / `answerWithin` call added: read or act

| file:line | request | read/act |
|---|---|---|
| routes/governance.tsx:90 | GET /projects | read |
| screens/GovernanceSettings.tsx:142 | GET …/governance (also "Reload", and after the time-zone save and destroy) | read |
| screens/AuditLog.tsx:470 | GET …/audit | read |
| screens/Fieldwork.tsx:159 | GET participants, sessions, consents | read |
| screens/YourLibrary.tsx:305 | GET /settings/your-library | read |
| screens/SearchSources.tsx:260 | GET /settings/search-sources | read |
| screens/ToolsSetup.tsx:134 | GET /tools | read |
| screens/ExtensionPairing.tsx:185 | GET /extension/pairings | read |
| screens/ResearcherName.tsx:29 | GET /settings/researcher | read |
| screens/TranscriptViewer.tsx:265 / :301 / :341 | GET versions / source / transcript | read |
| routes/reader.tsx:201 | GET source and GET /libraries | read |
| screens/Reader.tsx:359 (`answerWithin`) | GET byte ranges while opening | read |
| screens/Capture.tsx:426 / :452 / :1176 | GET /projects / governance / /projects (route) | read |
| screens/import/ImportWizard.tsx:137 / :160 / :220 | GET /projects / …/imports (opening) / governance | read |
| screens/import/StepRun.tsx:63 | GET …/imports (arrival check and recheck; no claim, start or resume) | read |

No act (save, attach, start, resume, capture, pairing code, media ticket) has the limit.

## Sentences shown per screen, and whether each is true there

| screen | on give-up | true? |
|---|---|---|
| Rules / Audit log / Fieldwork | "The library service did not answer in time." + Try again | yes, alone. With the route's list sentence: two sentences (I2) |
| Governance route | the same + Try again | yes. After failure then give-up, "not in this library" stays (M1) |
| Your library, Search sources, Tools, Pairing list | the same + Try again | yes |
| Researcher name | the same + Try again; the field and Save stay off (probed: no PUT possible) | yes |
| Transcript viewer | one sentence by R602 M1 + Try again | the alert yes; "No transcript yet" in the box is untrue (I3) |
| Reader route and screen (new) | heading "Library service did not answer"; "The library service did not answer in time, so this PDF cannot be shown. Try again in a moment." + "Open again" | yes for the PDF. At the route it was the source read (M9) |
| Review queue look | the same reader state, by the default prop, + "Open again" | yes |
| Capture | one sentence + Try again; rules taken strictly while shown | yes |
| Capture route | the sentence + Try again; with `?project=`, also "not one of this library's projects" and the screen removed | untrue (I1) |
| Import wizard (new composition) | "The import could not be read. The library service did not answer in time." + Try again; projects: the sentence alone | yes. Rules given up are silent (M2) |
| Run step | after its tries: "Progress updates are not available right now…" + "Check again" + "The library service did not answer in time." | yes |

## Planted faults (each in a copy, run, restored)

| fault | result |
|---|---|
| `events()`: `clearTimeout(timer)` removed | the four "never dropped" tests fail (transcript, reader route, capture, import run) |
| Governance rules without `readWithin` | 1 failed (governance.firstReads) |
| Tools without `readWithin` | 1 failed (ToolsSetup.test) |
| Researcher name without `readWithin` | 1 failed (ResearcherName.test) |
| Transcript source without `readWithin` | 1 failed (TranscriptViewer.firstReads) |
| Reader PDF: `answered` a no-op (the whole read limited) | the trickle test fails (body in 4 pieces over 900 ms against a 300 ms limit): a begun answer is never cut |
| Capture rules without `readWithin` | 1 failed |
| Import opening without `readWithin` | 2 failed |

## Tests run (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

51 files, 1261 tests, all passed:
- App 16
- api: capture 42, client 43, firstRead 4, import 7, library 10, reader 2
- MissingToolNotice: capture 4, hookups 8, plain 10
- dialogs.r145 42
- reader: pdfjs 14, rangeTransport 7
- routes: governance 20, import 18, reader.find 22, reader.firstReads 4, reader 13, tools 9, transcript 4
- AppearanceSettings: reset 10, plain 24
- AuditLog 18
- Capture: firstReads 9, plain 65
- ExtensionPairing 69
- Fieldwork 31
- GovernanceSettings 65
- Library: firstReads 11, reader 9
- Reader: find 25, firstReads 4, highlights 31, keyboard 43, plain 59
- ReaderHandover 3
- ResearcherName 6
- SearchSources 37
- ToolsSetup 32
- TranscriptViewer: firstReads 9, plain 66
- YourLibrary 56
- governance.firstReads 10
- import: ImportWizard.firstReads 10, ImportWizard 56, ProjectReviewQueue 26, ReviewQueue.look 18, ReviewQueue 125, StepReport 25, StepScan 3, StepSource.shell 7

No flake was seen. `screens/Reader.test.tsx` passed in its one run, so the builders' flake was not reproduced.

Checks:
- `pnpm --filter @ao/ui run typecheck`: clean.
- `lint:css`: clean.
- `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
