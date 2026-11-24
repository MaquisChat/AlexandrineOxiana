# Rough-edges round — batch RE-3: The Library screen, import, the chooser, workspace tags, Move library, capture settings (screens)

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-3-library-ui`, branch `re-3-library-ui`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-3-library-ui &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE3-report.md`.

## Your items (17 list numbers in 10 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-151, FR-152, FR-153 (UI — screens): Library screen: a later ?project= change ignored after an address-driven selection; 'Load more' in the gap uses an old offset; a failed reload after a refused resolve leaves the old list. - size S
- FR-155 (UI — screens): 'Try saving again' offered for a load error (Appearance). - size S
- FR-162 (UI — screens): The collection tree's twisty cannot be clicked with a mouse. - size S
- FR-165 (UI — screens): Workspace tags: 409 wording, no confirmation for a rename, no reload after a failure. - size S
- FR-166, FR-167 (UI — screens): A lost move error means a long poll on the Move library screen. - size S
- FR-170 (UI — screens): `ImportReport.created` not shown; older batches have no created ids. - size S
- FR-361 (UI — screens): The library chooser's headings use the D7 right-to-left pattern. - size S
- FR-362, FR-363 (UI — screens): Import: a report opened by its address has no wizard state; focus jumps to the report's heading at the end of a run even if the researcher moved it. - size S
- FR-389, FR-390, FR-391 (UI — screens): Capture settings: the locked/read-only reason not updated live; comma-separated fields keep a draft after their reason is cancelled; the Move-library dialog hint shows outside the desktop app. - size S
- FR-412, FR-413 (UI — screens): The libraries notice overstates partial damage; the watched-folders warning can go stale in a session. - size S

## For this batch
- FR-166, FR-167: the Move library screen was changed by Task FR-A19 (R389, R409): check first what is still true.
- FR-412, FR-413: wording must say exactly what is damaged and what still works.
