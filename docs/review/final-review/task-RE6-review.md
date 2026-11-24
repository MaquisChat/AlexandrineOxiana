# Review of RE-6 (Zotero, watched folders, the PDF reader)

Worktree `.claude/worktrees/re-6-zotero-folders`, branch `re-6-zotero-folders`, base 567d98d, head cf70b84 (10 commits). Reviewer: fresh, adversarial. Nothing fixed, nothing committed; probes deleted; `git status --short` empty.

**Verdict: APPROVED WITH SMALL POINTS.** One Important point (FR-132: the web import's wizard summary does not carry the new note). It is a one-line fix. Everything else is Minor. The coordinator needs to rule on what `ao zotero check-key` should clear (the facts are below).

## What I ran (all at `nice -n 10`)

- `geometry.probeRE6.test.ts` (ui): 25 strings through `normaliseQuote` and `joinQuotes`: Japanese, Chinese, mixed Latin and CJK, CJK then a digit, full-width forms, Korean, Arabic, Hebrew, English, CRLF line ends, blank lines, an ideographic space, RLM and ZWSP marks, CJK Extension B, Bopomofo, and hyphens. Results under FR-454.
- `zotero.probeRE6.test.ts` (cli), four cases:
  - a second library registered with a `key-refused` pause: `check-key` clears both libraries.
  - a damaged settings file: `check-key` sets it aside silently.
  - a settings file of a newer version: left as it is, nothing printed.
  - a damaged `libraries.json`: nothing is cleared, nothing is printed.
- The touched tests `geometry.test.ts` and `StepReport.test.tsx` (38 passed).
- Grep of `e2e/*.spec.ts` for every changed sentence.
- Both probes were deleted.

## Findings

### Important

**I1 — FR-132: the "Zotero (web)" wizard's summary does not say that what was taken away in Zotero stays here.**
- `ZOTERO_NOTES.removalsKept` is said in a dry run only by the local adapter (`zotero-local.ts:614`, `if (ctx.dryRun) … removalsKept("zotero-local")`).
- The web adapter's end-of-scan notes (`zotero-web.ts:1255-1262`) never call it, although its dry run goes through the same wizard summary.
- So for a web import the statement appears only in the report of a later run (`run.ts:1127`), after the fact.
- The brief asked for it in "the import's report and the wizard's summary", for local and web imports alike.
- Direction: the same line in the web adapter, with `removalsKept("zotero-web")`, and a test.

### Minor

**M1 — FR-507: `check-key` now reads the settings file and can set it aside without saying so.**
- Probe: a damaged `zotero-sync.json`, then `ao zotero check-key`. It exits 0 and prints only "This key can read your library."
- Meanwhile the file has become `zotero-sync.json.unreadable-<stamp>`, `notices.json` has been written, and automatic sync is off for every library.
- The cause is the read in `clearZoteroKeyPauses` (`zotero-sync-settings.ts:559`). Before this change, `check-key` never touched the file. `ao zotero sync` says `settingsSetAside` for the same event; `check-key` says nothing.
- An unreadable or busy file is also swallowed (`zotero.ts:22`, `.catch(() => undefined)`), so the researcher is not told the pauses stay.
- Direction: pass `onSetAside` and say `ZOTERO_SYNC_SENTENCES.settingsSetAside` after the summary, as `sync` does. When the clearing could not be written, say so as well.

**M2 — FR-507: the libraries come from `libraries.json`, not from the settings file.**
- Probe: a damaged registry, then `check-key`. The `key-refused` pause stays and nothing is printed.
- A library that has settings but was forgotten from the registry is skipped too.
- The pauses live in `zotero-sync.json` under `libraries[<id>]`. That file is the exact set to clear, and one locked read-modify-write could do it.
- See the facts for the ruling below.

**M3 — FR-507: nothing says that syncing is on again.**
- The app's screen shows the rows un-paused after the check.
- The command line prints only the key summary, with or without the `--json` option. The JSON carries no field for it either.
- Direction, if wanted: a shared sentence giving how many links were turned on again.

**M4 — FR-463: the rows can still add up to more than "Items" in other cases.**
- The note explains only the back-and-updated overlap (`report.ts:116-117`).
- An item with a field in conflict that also took other changes is counted in "Changed in Zotero and here — waiting for you" and in "Updated" (`batch.ts:391-393`, `conflictsQueued` counted beside the `updated` outcome).
- "Cleared in Zotero, kept here" counts items that are also in "Updated" or "Unchanged".
- Neither overlap is said. The entry named only the back-and-updated overlap, so this is beyond its letter.

**M5 — FR-132: the note is shown when nothing was left out.**
- Every local dry run says it, including the first import of a Zotero library, where no item can "come in again".
- Every later account-sync report carries it (any `unchanged` item triggers it), even when nothing was removed in Zotero.
- The web wording omits "An item put into another collection … is not put into it here". That sentence is also true for a web import with structure "none" (`newMemberships`, `run.ts:1421`).
- The note is a standing caveat rather than a count, so this is wording only.

**M6 — FR-454: edge cases of the join.** Probe output:
- CJK then a digit or a Latin word: `"第\n3章"` gives `"第 3章"`. The space comes from the line break, not from the source. This matches the brief's "mixed text keeps its spaces", but a Japanese reader would expect `第3章`.
- An RLM or ZWSP mark before the break stops the join: `"日本‏\n語"` gives `"日本‏ 語"`.
- Bopomofo is not in the set: `"ㄅ\nㄆ"` gives `"ㄅ ㄆ"`.
- An ideographic-space paragraph indent at the start of a line is dropped: `"。\n　次"` gives `"。次"`. Before the change it was `"。 次"`.
- The class `＀-￯` also covers half-width Hangul.
- Sound: English (`"The quick\nbrown  fox"` gives `"The quick brown fox"`), Korean, Arabic and Hebrew keep their space. Pure Japanese and Chinese join, full-width punctuation at a line end included. CRLF and trailing spaces before the break are handled. Pages are joined the same way. Hyphenated Latin words behave as before (`"self-\nevident"` gives `"selfevident"`, which is old behaviour).
- Not covered: a CJK line whose text ends in a space before the next line. In `geometry.ts:236` that adds no `\n`, so the space stays. Only a real PDF shows whether pdf.js gives such text.

**M7 — FR-467:** the undo QUESTION still says "Take the Zotero mark off" for a mark that will give back the bin mark. The implementer says so too.

**M8 — FR-477:**
- A record of a run that is still going in another process stays without an end. Example: `ao zotero sync` running while the app shows the history. `runningZoteroSyncRuns` is per process, so the record reads "has no recorded end: the app may have been closed during it…".
- That is still not true, but it is no worse than the old "The app was closed".
- Every place that shows the line (Zotero screen, Library line, command line) goes through the shared `zoteroSyncStatusLine`.

**M9 — FR-475:** the origin route now sorts origins by watch id (`routes/watched-folders.ts:65`) instead of keeping the register's order. This is harmless as far as I can see, and the report did not mention it.

## The facts for the ruling on what `ao zotero check-key` should clear (FR-507)

- **What the app does.** `POST /zotero/key-check` (`routes/zotero-sync.ts`):
  - after a check that worked, only for the library open in the app, and only when it is open read-write;
  - in one locked read-modify-write of this computer's `zotero-sync.json`, it clears `key-refused` on every link, and `library-gone` where the key now reads that Zotero library;
  - `undone` is never cleared (R248 d, R265);
  - a failed check clears nothing;
  - a file that cannot be read or written is logged and left; the check's answer stands.
- **What is written, and where.**
  - Only `<appConfigDir>/zotero-sync.json`: device data, one file for every library, under the cross-process lock of R299 c.
  - Nothing in any library. The policy engine is not involved and nothing is audited, in the app or the command line; that is correct for device data.
  - No path and no key is printed.
  - A running app sees the change at its next scheduler tick (`routes/zotero-sync.ts:315` reads the settings every tick).
- **What the command line does now.** For every library in `libraries.json`, the same rule (shared function `clearZoteroKeyPauses`), one write per library.
- **The other cases you asked about:**
  - A library open in the app at that moment: safe. The lock serialises the two writers, and no pause written by the app is lost.
  - A library on a drive that is not connected: irrelevant, because the library is never opened.
  - A locked or encrypted library: irrelevant for the same reason.
  - A library the app holds read-only: the command line clears it and the app would not. That is harmless, since a read-only library runs no sync.
  - A pause with another cause than the key: `undone` is kept. A `library-gone` whose Zotero library the key still cannot read is kept.
  - A damaged settings file: set aside silently (M1).
  - A damaged registry: nothing cleared, silently (M2).
  - Settings of a newer version: left as they are, silently.
- **My recommendation.** Clear across every library in the settings file itself (its `libraries` keys), not the registry. Use one locked write. The key is this computer's, and so are the refusals that set the pauses; `recordedBackoff` already reasons the same way. Keep `undone` and an unreadable `library-gone`. Then print one line naming how many links were turned on again, and the `settingsSetAside` sentence when the read set the file aside.

## End-to-end specs: assertions on the changed wording

None that I can see will fail.
- `e2e/watched-folders.spec.ts:271` (`toHaveText("Watching", {timeout: 30_000})`) now passes only once the first look has ended. For the specs' small temporary folders that is well inside 30 s.
- The count lines are found with `filter({ hasText })` (`:275`), so the new "already in the library" line does not disturb them.
- `:565` lists "files that did not come in", not the counts.
- `e2e/import.spec.ts:165` matches `/Not imported from Zotero: 1 standalone note/` only, so the new note does not match it.
- `e2e/zotero-sync.spec.ts` builds every status line from the shared `zoteroSyncStatusLine`.
- No spec asserts "took the Zotero mark off", "The app was closed", the report's notes in full, or `check-key` output.

## Per item

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-454 | CJK lines joined with nothing between; pages likewise | holds | M6 edge cases; English, Korean and RTL unchanged |
| FR-132 | said in the wizard's summary and the report | partly | I1: missing in the web wizard; M5 |
| FR-463 | a note says the double count | holds | M4: the other overlaps remain |
| FR-467 | `restoredMarks`, "put back the Zotero mark … had before" | holds | M7; the service passes `reverted` through unchanged |
| FR-477 | a record with no end no longer says "the app was closed" | holds | M8 |
| FR-507 | `check-key` clears as the app does | partly | for every library in the registry; M1–M3; ruling needed |
| FR-508 | shared sentence `settingsSetAside` | holds | the banner and the command line use the one sentence |
| FR-512 | stopped by the rules mid-run gives `rules-denied` | holds | flag carried in `BatchResult`; set only for state `failed` |
| FR-472 | `scanning` true during the first look | holds | shown as "Watching — looking through the folder…" until the checks and the first listing end (at most the 30 s limit), then plain "Watching" or "cannot be reached" |
| FR-475 | origin answered from the watch's memory | holds | `origins` is implemented only by `watchFolder`; two test stubs updated; nothing else implements `FolderWatch`; a locked project still fails at the disk read first; M9 |
| FR-476 | a line for files already in the library | holds | live per-file count |

## Checked and sound

- FR-512: `deniedByRules` is set only for `PolicyDeniedError`, or for a `BatchRefusedError` with `denied`, in the run's stop handler, and travels only with a failed state. A locked project still wins.
- FR-467: an earlier bin batch that was undone first gives `unmarked`. Pinned by a test.
- FR-472: `firstLook` is cleared after the start's checks, after the not-answering path, and in `tryResume`'s `finally`. `touch()` follows, so the screen is told. Only `stateLine` reads `scanning`.
- FR-132: the run-level note is deduplicated (`note()`), so a resumed batch does not repeat it.
- House rules: no new path, no secret, no colour, no `innerHTML`. Every new screen text goes through the existing list and line rendering.

## Could only judge by reading

- That each new test fails without its fix (taken from the implementer's report and the shape of the assertions; I did not remove the guards). The FR-512 test (230 items, 120 s) I did not run.
- FR-454 with real pdf.js text from a CJK PDF.
- FR-472 with a real cloud folder that never answers.
- FR-507 against a real Zotero key.
