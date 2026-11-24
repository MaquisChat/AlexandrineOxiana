# Rough-edges round — batch RE-6: Zotero, watched folders, the PDF reader

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-6-zotero-folders`, branch `re-6-zotero-folders`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-6-zotero-folders &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE6-report.md`.

## Your items (11 list numbers in 7 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-132 (Core/library): Zotero import leaves out standalone notes, attachment notes, linked URLs, embedded images, and does not apply membership/tag/annotation removals on update; counted in the report (zotero-local.ts:84-85) but easy to miss. - size M
- FR-463, FR-467, FR-477 (Zotero): Zotero report wording: 'Updated' and 'Back in Zotero' overlap (rows exceed 'Items'); undoing a deletion mark that restores a bin mark says 'took the Zotero mark off'; a sync whose end could not be written reads 'the app was closed'. - size S
- FR-507, FR-508 (Zotero): `ao zotero check-key` does not clear a link's pause as the app does; the damaged-settings sentence is the command line's own. - size S
- FR-512 (Zotero): A Zotero batch stopped by the rules mid-run is recorded 'error' with no reason. - size S
- FR-472 (Cloud/watched folders): 'Watching' shown for up to 30 s while a watch's first call on a folder that never answers is in flight. - size S
- FR-475, FR-476 (Cloud/watched folders): A source opened within ~5 s of import shows no origin line until reopened; a same-content conflict copy is counted but has no line on the screen. - size S
- FR-454 (Reader (PDF)): A space is put between lines of Chinese or Japanese text in a quote. - size S

## For this batch
- FR-132: a matter of saying it where the researcher will see it (the import's report and the wizard's summary), not of importing more.
- FR-507, FR-508: the command line is `apps/cli` (`pnpm --filter @ao/cli test`): it must do what the app does and say it in the service's shared sentences.
- FR-454: `packages/ui` reader code; a quote made of Chinese or Japanese lines joins them with nothing between; mixed text keeps its spaces. Tests with real strings.
