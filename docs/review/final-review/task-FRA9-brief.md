# Final review, Task FR-A9 — a dialog is never confirmed by the key that opened it (implementer's dispatch)

You are the implementer of **Task FR-A9** of the final review of the project "Alexandrine Oxiana" (a local-first research workbench; a pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest; `packages/ui` is the React 19 interface). You have none of the earlier context; this brief is everything.

**Where you work:** the existing git worktree `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a6ee131b0cb253cae`, already on your branch `fr-a9-dialogs` (head 320dbbe), with dependencies installed and the interface built — do NOT reset it, do not install. Every Bash command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/agent-a6ee131b0cb253cae`. Nobody else works there. Stay out of every other folder; do not push. The machine restarts now and then: COMMIT after each dialog. Another long test run is using this machine: run everything at `nice -n 10`, and a time-limit failure in a test you did not touch is re-run once alone before you believe it.

Read first, in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/impl-common-reader.md` (the house rules: tests first; colours from tokens; outside text through `UserText`; focus asserted through `document.activeElement`). Your contract is Ruling R376 clause (c): `grep -n -E "Ruling R376\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-4000`.

## The defect
A dialog is opened by pressing Enter on a button. In a browser, Enter on a button acts on key-DOWN and repeats while held. Some dialogs put first focus on their CONFIRMING button — so a held Enter, or Enter pressed twice, on the button that opens the dialog also confirms it: a participant deleted, a pairing revoked, a privacy acknowledgement given, without a look. A reviewer's probe showed it (`{Enter>4}{/Enter}` on the opener → the confirm handler called 3 times; `{Enter}{Enter}` → once).

The dialogs (all in `packages/ui/src`):
1. **`ChoiceDialog`** in `components/ReasonDialog.tsx` (about line 162; the danger action is its first button). Used by `screens/Fieldwork.tsx` ("Delete participant"), `screens/ExtensionPairing.tsx` ("Revoke pairing", "Reset the list"), `screens/AppearanceSettings.tsx` (two resets). ONE change in `ChoiceDialog` covers them all.
2. **The capture screen's "Use your browser session?"** dialog (`screens/Capture.tsx`, about lines 137–150; first focus is "I understand, use my browser session").
3. **The watched folders' two dialogs** (`screens/WatchedFolders.tsx`, about lines 1145–1190): `RemoveDialog` ("Stop watching", danger, first) and the download dialog ("Download and import", first).

## The fix (the mechanism exists — use it, do not invent another)
`DialogShell` (in `components/ReasonDialog.tsx`) takes `initialFocus`: a ref to an element of the dialog that gets focus on open instead of the first control. `components/FieldEvidencePopover.tsx` shows the pattern: `const heading = useRef<HTMLHeadingElement>(null)`, `<DialogShell … initialFocus={heading}>`, and the heading `<h2 id=… ref={heading} tabIndex={-1} …>`. The focus trap (`useTrap`) already sends Shift+Tab from that element to the dialog's last control and Tab on to the first. Enter on a heading does nothing, so a held or repeated Enter confirms nothing; Tab then Enter (or Space, or a click) confirms once.
Give each of the dialogs above first focus on its HEADING in exactly this way. If one of them does not use `DialogShell`, use whatever it uses to the same effect (say what). Do not reorder buttons, do not change any wording, do not add timers or key bookkeeping. If the heading shows a visible focus ring that looks wrong, leave it — do not add CSS — and say so in your report.

Then make the list complete: grep every user of `DialogShell`, `useTrap(`, `role="dialog"`, `role="alertdialog"` and `<dialog` in `packages/ui/src` and write a table in your report — dialog, file:line, where first focus lands, safe or not and why. Safe means: first focus is on a heading, a safe button (Cancel, Close), a field where a word must be typed before the confirm is enabled, or radios outside a `<form>`. Fix ONLY the ones above, plus any other you find whose first focus is a control that confirms, acknowledges or decides (tell me which and why in your final message).

## Tests first (each seen to FAIL for the right reason before the change; `@testing-library/user-event` as the neighbouring tests use it)
For `ChoiceDialog` itself (in `components/ReasonDialog.test.tsx`) and for each using screen's dialog where a test file exists (`Fieldwork.test.tsx`, `ExtensionPairing.test.tsx`, `AppearanceSettings.test.tsx`, `Capture.test.tsx`, `WatchedFolders.test.tsx` — one test per dialog is enough on the screens; the full set on `ChoiceDialog`, the capture dialog and the two watched-folder dialogs):
- the opener focused, Enter held (`{Enter>4}{/Enter}`): the dialog is open, the confirm handler (or the request it makes) was NOT called, `document.activeElement` is the dialog's heading;
- Enter pressed twice on the opener: not confirmed;
- Tab from the heading reaches the first control; Enter there confirms exactly once;
- Shift+Tab from the heading reaches the dialog's last control;
- Escape closes it and focus returns to the opener;
- the dialog still has its accessible name (`getByRole("dialog", { name: … })`).
Existing tests that relied on first focus being the confirming button: change only what must change (an added Tab, or a click instead of a bare Enter) and list each such change in your report. Never loosen an assertion, never skip a test.

## End-to-end
`grep -rn "Stop watching\|Download and import\|browser session\|Revoke pairing\|Reset the list\|Delete participant" e2e/` — for each spec that drives one of these dialogs, read how it confirms. A click on the confirming button is unaffected. If a spec presses Enter right after opening, give it the Tab it now needs. Run each spec that drives one of these dialogs, once: `nice -n 10 pnpm e2e -- --app-only --trace off <spec path>` (if that form does not take a path, read `e2e/package.json` / the root script and use what it does take; say what you ran). If a spec fails for a reason that is not your change (a time limit under load), run it once more alone and report both results.

## Verify (each at `nice -n 10`, foreground; give the final summary line of each)
The test files you touched, by name (`pnpm --filter @ao/ui exec vitest run <paths>`) · `pnpm --filter @ao/ui test` once · `pnpm --filter @ao/ui run lint:css` · `pnpm --filter @ao/ui run lint:colours` · `pnpm --filter @ao/ui run build` · `pnpm -r typecheck` · the end-to-end specs above. Leave nothing running.

## Rules
Files you may change: the four components/screens named above (and any further dialog you find unsafe), their test files, and end-to-end specs only as said. No product behaviour changes other than where first focus lands. No new dependency. Commits on `fr-a9-dialogs`, one per dialog, each message ending with the trailers YOUR OWN session's instructions give; no model identifiers anywhere else. `git status --short` empty at the end.

## Report
Write `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/task-FRA9-report.md`: per dialog what changed (file:line), its tests and that each failed first; the table of every dialog and its first focus; existing tests and specs changed and why; the runs. Final message to the coordinator (max 150 words): status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, the runs in one line, any dialog beyond the list that you fixed or think unsafe, anything unsure. Exactly one final message.
