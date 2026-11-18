# Task FR-A9 report (branch fr-a9-dialogs, head c6d210b)

## Commits (one per dialog)
1. 6abb125 ChoiceDialog: components/ReasonDialog.tsx ChoiceDialog (~l.168): `heading` ref, `initialFocus={heading}`, `<h2 ref tabIndex={-1}>`. Covers Fieldwork "Delete participant", ExtensionPairing "Revoke pairing" and "Reset the list", AppearanceSettings two resets.
2. 5ec1b00 Capture AckDialog: screens/Capture.tsx ~l.121-140. It does not use DialogShell but `useTrap`; the same mechanism (`useTrap(onCancel, busy, heading)`, third argument) plus the heading ref/tabIndex.
3. 7e57d69 WatchedFolders RemoveDialog ("Stop watching"): DialogShell `initialFocus` + heading.
4. e1637ef WatchedFolders DownloadDialog: same. Its existing effect that focuses Cancel when nothing is left to download (bytes 0) still runs after and wins: safe button.
5. c6d210b (beyond the list) PendingWritesDialog inline question (components/PendingWritesDialog.tsx Item): see below.

## Tests (each seen to fail first, for the right reason)
- ReasonDialog.test.tsx: new "ChoiceDialog opened from the keyboard" x (plain, StrictMode): held Enter (confirm called 3 times before), Enter twice (1 time before), Tab then Enter once (focus was on Go before), Shift+Tab reaches Cancel, Escape returns to opener, accessible name. The last two already passed (Shift+Tab from first = last; Escape): kept as regression guards. Changed existing "moves focus inside on open": now expects the heading.
- Fieldwork.test.tsx, ExtensionPairing.test.tsx, AppearanceSettings.reset.test.tsx (2 tests: appearance reset, list reset; AppearanceSettings.test.tsx has no dialog tests): one test each, held+doubled Enter, heading focus, Tab then Enter once. Seen failing with the ReasonDialog change stashed (dialog was confirmed and closed / focus on the button).
- Capture.test.tsx: three new tests (opener is a checkbox, opened with Space, then held and doubled Enter; Tab+Enter records once; Shift+Tab reaches Cancel, Escape returns to the box). Failed first (dialog confirmed / focus on confirm).
- WatchedFolders.test.tsx: two new tests (Stop watching via held Enter on its button; Download via Space on the radio, then held Enter). Failed first with the component change stashed.
- PendingWritesDialog.test.tsx: two new tests; both failed first (rolled back / acknowledged by the key).

## Existing tests changed (only what had to change)
- ReasonDialog.test.tsx "moves focus inside on open": Go button -> heading.
- Capture.test.tsx openAndWalk (3 tests use it): on open the heading, then an added Tab to reach confirm; rest unchanged. "opened by the service's refusal": first focus asserted on the heading (rest unchanged).
- WatchedFolders.test.tsx "each dialog keeps focus on open, Tab, Shift+Tab and close": Download and Remove parts: heading first, one added Tab. "a burst of status events...": one added Tab before reaching Cancel.
No assertion loosened, nothing skipped.

## Every dialog and its first focus
| Dialog | file:line | First focus | Safe? |
|---|---|---|---|
| DialogShell (shared) | components/ReasonDialog.tsx:54 | the given `initialFocus`, else first control | depends on user |
| ReasonDialog "Record a reason" | ReasonDialog.tsx:77 (used GovernanceSettings:465) | Reason textarea | safe: field, Enter adds a newline; confirm disabled until both fields typed |
| ConfirmDialog (typed word) | ReasonDialog.tsx:119 (MoveLibrary:272, GovernanceSettings:1111) | the typing input | safe: a word must be typed first |
| ChoiceDialog | ReasonDialog.tsx:168 | heading (FIXED, was danger button) | now safe |
| ReasonOptionalDialog | ReasonDialog.tsx:187 (Fieldwork:427) | optional-reason textarea | safe: Enter in a textarea is a newline; confirm is a submit button not focused |
| FieldEvidencePopover | components/FieldEvidencePopover.tsx:194 | heading | safe (already) |
| ChoosePersonDialog | components/ChoosePersonDialog.tsx:129 | Cancel while loading, then first radio (outside a form) | safe: radios, "This is the person" is a separate button |
| ChooseWorkDialog | components/ChooseWorkDialog.tsx:118 | first radio | safe: radios outside a form |
| ChooseWorksDialog | components/ChooseWorksDialog.tsx:223 | first control (filter field; list is checkboxes) | safe: fields/checkboxes, Space only toggles |
| FirstUseTools | components/FirstUseTools.tsx:258 | first activity checkbox | safe: Enter does nothing on a checkbox, Space toggles a choice, nothing is confirmed (note: not a heading; I judged it a choice, not a decision) |
| PendingWritesDialog | components/PendingWritesDialog.tsx:231 (own trap) | heading "Interrupted changes" | safe |
| PendingWritesDialog inline question (Roll back / Keep) | PendingWritesDialog.tsx Item | was "Yes, roll it back"/"Yes, keep it" or the "I understand" checkbox; FIXED: the question text | now safe |
| AnnotationList `Question` | reader/AnnotationList.tsx:600 | the safe "no" button, by design | safe (safe button) |
| AuditLog SetAsideDialog | screens/AuditLog.tsx:142 | Reason textarea | safe: typed reason needed first |
| ReviewQueue "Reviewed after the withdrawal" | screens/import/ReviewQueue.tsx:1598 | Reason textarea | safe: typed reason needed first |
| Capture AckDialog | screens/Capture.tsx:137 | heading (FIXED, was confirm) | now safe |
| WatchedFolders AddDialog | screens/WatchedFolders.tsx:1084 | Collection select (a field) | safe. Note: after a refusal and a new folder choice, "Start watching" is focused deliberately, after the person picked a folder in the system picker; left (not a held-key path from a button in this dialog's opener) |
| WatchedFolders DownloadDialog | WatchedFolders.tsx:1145 | heading (FIXED); Cancel when nothing to download | now safe |
| WatchedFolders RemoveDialog | WatchedFolders.tsx:1177 | heading (FIXED) | now safe |
| NewProject | screens/NewProject.tsx:391 (own trap) | name field; heading when "created" | safe: field |
| NewRecoveryCode | screens/NewRecoveryCode.tsx:181 (own trap) | passphrase field | safe: field |
| StepReport undo (alertdialog) | screens/import/StepReport.tsx:385 | Cancel | safe: safe button |

## Beyond the list
PendingWritesDialog: pressing "Roll it back" / "Keep it" opened an inline question and moved focus to "Yes, roll it back" / "Yes, keep it" (or the "I understand" checkbox for an unconfirmable change). A held or repeated Enter on the first button therefore answered an irreversible question. Fixed the same way: focus on the question text (a `tabIndex -1` span); Tab reaches the acknowledgement or "Yes".

## Visible focus ring
Headings are focused by script (tabIndex -1); I added no CSS. I did not view them in a browser; if a ring looks odd it is left, as asked.

## E2E
`grep` found only e2e/watched-folders.spec.ts driving a changed dialog ("Stop watching", by click at lines 729 and 789: unaffected). reader-highlights.spec.ts "Keep it" belongs to the annotation `Question` (unchanged). No spec drives the others. No spec changed.
Ran: `pnpm e2e -- --app-only --trace off e2e/watched-folders.spec.ts` (UI rebuilt first): 26 passed (chromium and webkit), 4.2m, first run.

## Runs
- The 7 touched test files (ReasonDialog, PendingWritesDialog, Fieldwork, ExtensionPairing, AppearanceSettings.reset, Capture, WatchedFolders): 7 files, 220 tests passed.
- `pnpm --filter @ao/ui test`: 113 files, 2157 tests passed.
- lint:css clean; lint:colours "ok: no hard-coded colours"; ui build "built in 5.38s"; `pnpm -r typecheck`: no errors.
- git status --short empty.
