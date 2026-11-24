# Rough-edges round — batch RE-4: Dialogs and focus, the player, the optional tools

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-4-dialogs-player`, branch `re-4-dialogs-player`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-4-dialogs-player &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE4-report.md`.

## Your items (15 list numbers in 10 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-203 (UI — screens): DialogShell's focus trap restores focus before `inert` is removed, so focus can fall to the page on close. - size S
- FR-234, FR-601 (UI — screens): R145: re-check every dialog and popover for focus on open, Tab/Shift+Tab and close (assistive technology). - size M
- FR-259, FR-260 (UI — screens): Player: a resume seek that never lands is ignored for good; three idle expiries near one spot give 'may be damaged' (Try again recovers). - size S
- FR-261 (UI — screens): A request that never reached the service is treated as 'may still be going'. - size S
- FR-266 (UI — screens): The 503 sentence says 'nothing was queued' twice. - size S
- FR-291 (UI — screens): The Optional tools screen says each download 'contacts only the tool's publisher' (ToolsSetup.tsx:511) - loose for models hosted by a third party; the first-use banner does list the real hosts (FirstUseTools.tsx:318). - size S
- FR-315, FR-316 (UI — screens): After confirming a download focus lands on the page body; the banner's buttons sit inside its polite status region. - size S
- FR-217, FR-218, FR-219 (Service): A tamper found mid-stream gives a cut recording; the player shows only its generic 'stopped at the same place… may be damaged' after retries (MediaTicketPlayer.tsx:174-176), never 'changed outside the app'. - size M
- FR-350 (Service): A stream error part-way through `bytes()` is reported as 'the service could not be reached'. - size S
- FR-254 (Desktop shell): Model 'could not be read/loaded' messages give no next step. - size S

## For this batch
- FR-234, FR-601 (R145): deliver ONE table-driven test that opens every dialog and every popover of `packages/ui` (find them all: `DialogShell`, every `role="dialog"`, `role="alertdialog"`, popovers and menus) and asserts, through `document.activeElement`: where focus lands on open, that Tab and Shift+Tab stay inside, that Escape (where allowed) and the close control return focus to the control that opened it (or to a named fallback when that control is gone). Fix what fails; list every dialog and popover in the report with its result. Task FR-A9 (R376 c, R377: a dialog is never confirmed by the key that opened it) is in place: keep it.
- FR-217, FR-218, FR-219: the player must be able to say "changed outside the app" when that is what the service found; the service must give it a way to know (a code, not a sentence parsed). No path in any message.
- FR-254: the entry says "Desktop shell"; the sentences may live in the screens or the service: find them. Each gets a next step the researcher can take.
