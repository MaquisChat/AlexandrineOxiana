# Rough-edges round — batch RE-2: Projects, governance and fieldwork (screens)

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-2-projects`, branch `re-2-projects`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-2-projects &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE2-report.md`.

## Your items (15 list numbers in 13 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-156 (UI — screens): Governance: a profile toggle uses the debounced parsed config, so a just-typed change to `profiles` can be overwritten in the editor (visible before Save). - size S
- FR-157 (UI — screens): Folder-name pseudonymisation flags fail open for an older batch with no 'created' ids (an advisory flag not shown). - size S
- FR-158 (UI — screens): A right-to-left project name flips the whole banner sentence. - size S
- FR-160 (UI — screens): No control to detach a consent form attached to a consent record by mistake. - size M
- FR-163 (UI — screens): Governance screens do not mark locked projects or offer to unlock. - size S
- FR-168 (UI — screens): The re-attach offer on Fieldwork neither takes focus nor names the file. - size S
- FR-180 (UI — screens): An unsettled 'unknown outcome' notice calls a project just confirmed 'recovery code not shown' when the same name is created again (a false warning, safe direction). - size S
- FR-182 (UI — screens): The 'cannot tell' new-project notice never re-checks by itself. - size S
- FR-187, FR-188 (UI — screens): DMP projects are created with three presence violations by design; a first-run hint would help. - size S
- FR-194 (UI — screens): A library close during the new-project 'found' panel, 'cannot tell' state or form unmounts the dialog; the 'cannot tell' notice is lost (the recovery-code step itself is held). - size M
- FR-204, FR-205 (UI — screens): When two new projects with the entered name appear, the dialog and notice take the last; should list them. - size S
- FR-348 (UI — screens): A project recheck left by leaving the library is no longer shown on return, though it runs on. - size S
- FR-537 (UI — screens): Governance's 'Saved.' is cleared at once by the screen's own re-read. - size S

## For this batch
- FR-160: a control to detach a consent form attached by mistake. It is a library change: decided by the policy engine, audited, crash-safe, confirmed by the researcher in a dialog that names the form and the record (Fieldwork already has an explicit, confirmed RE-attach for a form detached before, R119: read it first — the detach may exist in the library already). If no governed detach exists in `packages/library` and building one is more than a few hours, describe it and stop (NEEDS A RULING).
- FR-187, FR-188: a first-run hint, not a change of what the rules require.
- FR-194: the recovery-code step itself is held and must stay held.
