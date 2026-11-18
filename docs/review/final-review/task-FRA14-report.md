# Task FR-A14 report: exports (R379; WB4 I1, I2, I4)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a0328b7cc1ec55b55`, branch `fr-a14-exports`. Three commits, one per point, on top of 7b81976:
- 26ceaa4 (I1)
- fbae671 (I2)
- b1e3d29 (I4), which is the head.

Status: DONE.

## Point 1 (I1): a reference export never writes inside the library
**What changed**
- `packages/shared/src/api/sources.ts:120`: new entry `IN_LIBRARY_TEXT.exportFile`, with the exact text "That place is inside this library's own folder. Choose a place outside the library."
- `packages/library/src/export/refman-export.ts:481` `checkDestination`, called first in `writeRefmanExport` (:500). It checks three things:
  - `insideLibrary(outputPath, repoLibrary(repo))` from `fs/inside-library.ts`: real path, links followed, a path that does not exist yet by its nearest existing parent, plus the device/inode check. On a match it throws `InvalidInputError(IN_LIBRARY_TEXT.exportFile)`.
  - `lstat`: a symbolic link throws `EXPORT_FILE_IS_LINK` (:69).
  - `lstat`: an existing folder throws `EXPORT_FILE_IS_FOLDER` (:67).
- The check runs before `buildExport`. A refused destination is therefore never evaluated, written or audited.
- The service already maps `InvalidInputError` to a 400 VALIDATION answer. The command line already prints the message on stderr and exits 1. Neither needed a code change; both now get the check through the library function.

**Tests (all failed first)**
- `refman-export.test.ts`, describe "R379 (FR-A14, I1)":
  - The reviewer's probe: the original's absolute path and `governance.yaml`, in all three formats. Both are refused, both files are byte-identical afterwards, and the audit log is unchanged with no `export.refman` event.
  - Refused: a link outside the library that leads into it; a file link to the rules file; a `..` path that resolves inside; a new file in a new folder under the library (the folder is not created).
  - An existing folder and a symlink are refused in plain words; the link's target is unchanged.
  - A destination outside the library still works.
  - Failed first: three of the four tests (the probe tests resolved instead of rejecting). The outside-destination test passed before and after, as intended.
- `apps/library-service/src/server.test.ts`, "R379 (FR-A14): POST /export/refman refuses an outputPath inside the library": the rules file gets 400 `{VALIDATION, sentence}` and is unchanged; a relative path is still 400; an outside path is 200. Failed first: it got 200.
- `apps/cli/src/cli.test.ts`, "R379 (FR-A14): export --output inside the library is refused": exit 1, the sentence on stderr, the rules file unchanged. Failed first: it exited 0.

## Point 2 (I2): R88's participant rules reach the reference exports
**What changed**
- `bibliography.ts:95`: `participantRules` is now exported. Nothing else in it changed.
- `refman-export.ts`, `buildExport`:
  - It reads the rules once (:396) and builds each source's `ToCslOptions` exactly as the bibliography does: `requireParticipantCodes = requireCodes && identifiable`.
  - `underParticipantRules` (:336) calls core's `toCslItem`. If it throws `ParticipantCodeMissingError`, the source is left out: `excluded` gets `{sourceId, reason: PARTICIPANT_CODE_MISSING_NOTE}` (:73) and a note counts it ("N source(s) were left out because a participant in it has no participant code yet.").
  - A source counts as touched by the rules when it is linked to participants, or when its CSL item differs from `toCslItem` run without the map. For a touched source, `codedRef` (:317) takes from that item:
    - the creators (participants as `{literal: code}`)
    - the title, container, publisher and bibliographic text (address included), all scrubbed
    - the URL (dropped when it names a participant)
  - Type, date, DOI/ISBN/ISSN/arXiv and tags still come from the source.
  - The citation key of a touched source is withheld. The writer makes `ref<n>` as it does for a source without a key. In the probe the key is `ref1`, which holds no name. A note says so.
  - A source the rules do not touch goes through the old path unchanged.
- `project-export.ts`: `sources.bib` and `sources.csl.json` get the same behaviour through `buildExport`. A note in `notes.txt` (:464) says when a source is missing from them because it failed closed.
- `csl-map.ts` and `naming.ts` are not edited.

**Tests: new file `packages/library/src/export/refman-participants.test.ts`**
- The reviewer's probe (PSEUDO_GOV, encrypted, `@maria.cocina`, key `mariacocina2026`): BibTeX, RIS and CSL-JSON hold P-001 and `ref1`. Neither "maria" nor "mariacocina2026" appears anywhere (whole text, case-insensitive). The literature source keeps `adams2001published` and "Adams". The bibliography prints P-001 for the same source.
- The open-format export's `sources.bib` and `sources.csl.json` hold P-001 and nothing of the name or the key.
- A required code is missing (a second creator added by `updateSource` gets no code): the source is excluded by id, counted in a note, and absent from every format. The open export's note says it too.
- A project that does not pseudonymise: the BibTeX output equals the exact old text, and the CSL-JSON keeps the key and the literal name.
- Failed first: three of the four (no P-001; the excluded count was 2, not 1). The non-pseudonymising test passed before and after, as intended.
- Existing tests unchanged; the whole `src/export` folder passes (237).

## Point 3 (I4): the exported `source.json` carries no absolute path
**What changed**
- `project-export.ts:100` `exportedRecord`. For a linked asset, in the exported `source.json` only:
  - `linked` (`absolutePath` and `libraryRelativePath`) is dropped.
  - `linkedInPlace: true` is added.
  - `path` becomes the file's place in the export (`files/<name>`, recorded in `copyOut`, :399). When the file is not in the export (a located medium without a proxy, or destroyed), `path` is its exported (pseudonymised) name alone; `notes.txt` already says why.
- The library's own record is untouched; a test checks this.
- **Built differently from the brief:** the brief speaks of marking "why its file is not in the export". In fact the open export DOES copy a linked file into `files/`, from its absolute path (:392, :430). So the record says where the file is in the export, not that it is missing. The export had no existing wording about linked files, so `linkedInPlace: true` is the only new marker.

**Tests (`project-export.test.ts`, describe "R379 (FR-A14, I4)"; both failed first)**
- The reviewer's probe: no `absolutePath` or `libraryRelativePath`, no string value starting with `/` or `..`, nothing of the temporary folder's name. Path is `files/interview-notes.pdf` with `linkedInPlace: true`, and the file is in the export.
- A whole export with a linked file and a copied file: every exported text file (.json/.md/.bib/.txt, at least 5) is searched for the temporary folder's absolute path and its realpath. Neither is found.

**What else the grep of the export found**
- The open export writes only `sources.csl.json`, `sources.bib`, `notes.txt`, and per source `source.json`, `<name>.md` and files. It writes no batch records, journals or manifests.
- `source.folder` and the paths of copied assets are library-relative.
- EXIF metadata drops the `File:` and `SourceFile` groups (`extract/exif.ts:167`), so no directory reaches it.
- `lib.root` is used only for reading and for the work folder, never written into the export.
- The result's `path` (the export folder) goes back to the caller and is not written into the export.
- Asset `acquired.address` may keep session-like URL segments; that is the reviewer's M1, not touched.

## What only a real Mac can show
- Case-insensitive APFS and the `/System/Volumes/Data` firmlink for the inside-library check. These come from the existing `insideLibrary` (device/inode check), which is tested only on Linux here.

## Minor (deferred)
- A coded source's tags, exported only with `includeTags`, are not scrubbed by the participant rules.
- A coded source's creators are grouped by CSL role (author, interviewer, contributor, editor, translator). Within a role their order is kept, but across roles it may differ from the record's order.
- In a project that does NOT pseudonymise but holds participants with name details, the reference export now codes them, as the bibliography always has. This is the "same rules" the brief asks for; byte-for-byte output is kept for projects with no participants or pseudonym entries.
- There is a short window between the destination check and the atomic rename in which a parent folder could be swapped for a link. The researcher names the path, and the same holds for the imports.
- `exportBibliography`'s `dest` folder is not checked against the library. It writes a new, dated file and never overwrites, but a dest inside a source folder is possible.
- The open export's Markdown and `source.json` keep real names, as designed (R90 c; FR-649 for the owner).

## Runs (each at nice -n 10)
- Touched files: `refman-export.test.ts` and `refman-participants.test.ts` 24/24; `project-export.test.ts` 18/18; `src/export` 237 passed.
- Service `-t "R379|POST /cite"`: 2 passed.
- CLI describe "import, export, secrets and maintenance": 17 passed.
- Whole suites:
  - `pnpm -r typecheck`: EXIT 0
  - `@ao/library test`: Tests 3727 passed | 5 skipped (3732)
  - `@ao/library-service test`: Tests 1026 passed | 1 skipped (1027)
  - `@ao/cli test`: Tests 77 passed (77)
- No screen was changed, so no UI lint, build or end-to-end run.
- `git status --short` is empty at the end.

## A note on the shared scratchpad
My first verification batch wrote to the generic names `tc.log`, `lib.log`, `svc.log`, `cli.log` and `shared.log` in the scratchpad. Some of those names already existed. I stopped that batch within seconds and reran under `fra14-*.log`. Older logs of other tasks under those generic names may have been overwritten.

## Round 2 (R390)

Implementer: fresh, in worktree `.claude/worktrees/agent-a0328b7cc1ec55b55`, branch `fr-a14-exports`, from b1e3d29. Five commits, one per point:
8a194d2 (a), a7e6872 (b), 95cd1cf (c), bfa65c7 (d), e5bda61 (e). Core files (`csl-map.ts`, `naming.ts`, `participant-names.ts`, `core/src/index.ts`) not touched.

### (a) I1, M2, M5 — every text goes through the name rule (8a194d2)
- `packages/library/src/export/refman-export.ts`: `nameRule` (about :315) takes the rule from `toCslItem` itself, since `scrubText` / `urlNamesParticipant` are not exported from `csl-map.ts` (and that file may not be edited): `scrub(t)` = the publisher `toCslItem` writes for the same source as a plain document (type `other`, so no platform branch) with `publisher = t` — i.e. `scrubText` with the project's names AND that source's coded creators' forms, exactly the bibliography's rule; `names(t)` = the address rule (`t` as the URL; `toCslItem` drops it when it names a participant); `creator(c)` = the creator as `toCslItem` writes it (coded, failing closed the same way), with the source's own role and order kept. `scrubbedRef` (about :340) applies them to every field; `underParticipantRules` (about :370) decides "touched" from the written fields: linked to participants, OR `toCslItem`'s item differs from the plain one, OR any written text differs under the rule, OR the source's own key names a participant. A touched source is written from `scrubbedRef` (its own container/publisher scrubbed, not the platform's name) with its key withheld; an untouched one from `refOf` as before. With no names to replace (empty map, no participant link) nothing is computed: byte for byte as before. `codedRef` and its CSL-field table removed.
- Tests (`refman-participants.test.ts`, describe "R390 (a)"): the reviewer's probes (Instagram repost container "Repost from Maria Cocina", YouTube publisher "Maria Cocina", book key `maria.cocina-notes`) in all three formats, whole output lowercase never "maria"/"cocina", "Repost from P-001", `PB  - P-001`, no "YouTube", BrandCo kept as AU in both; the open export's `sources.bib`/`sources.csl.json`; every bibliographic field + identifiers + URL naming her; an untouched source in the map project byte-identical (text and notes) to the same source in an OPEN_GOV project. Three failed first (name printed), the byte-for-byte one passed before and after (guard).

Every field the writers emit, and its treatment in a project with names to replace:
- BibTeX: header line (constant, not text) · entry type (not text) · key (withheld when touched → `ref-<id>`; kept when untouched) · title (scrubbed) · author/editor/translator (coded, fail closed as toCslItem) · date/year (not text: EDTF date) · journal/booktitle = container (scrubbed) · publisher (scrubbed) · address = publisherPlace (scrubbed) · edition, volume, number, issue, pages, series, pagetotal (scrubbed) · doi (withheld when it names a participant) · isbn (each withheld when it names one) · issn (withheld when it names one) · url (withheld when it names one) · eprint = arXiv id (withheld when it names one) · archiveprefix (constant) · keywords = tags (scrubbed, point b).
- RIS: TY (not text) · ID (key, as above) · TI (scrubbed) · AU/ED/A4 (coded) · PY (not text) · T2 (scrubbed) · PB (scrubbed) · CY (scrubbed) · ET, VL, IS, SP/EP, T3 (scrubbed) · DO (withheld) · SN isbn/issn (withheld) · UR (withheld) · KW (scrubbed).
- CSL-JSON: id, citation-key (key, as above) · type (not text) · title (scrubbed) · author/editor/translator (coded) · issued (not text) · container-title, publisher, publisher-place, volume, issue, page, edition, number-of-pages, collection-title, collection-number, genre, medium, number (scrubbed) · DOI, ISBN, ISSN, URL (withheld when naming) · keyword (scrubbed).
- Notes and abstracts: not written by any writer.
- Built differently from the brief's letter: the identifiers (DOI, ISBN, ISSN, arXiv id) are WITHHELD when they name a participant (the address rule) rather than scrubbed — scrubbing `10.1234/maria.cocina` would print a false identifier `10.1234/P-001`. Withholding one also marks the source touched.

### (b) I2 — tags (a7e6872)
- `underParticipantRules` scrubs each tag name with the same rule on every entry, coded or not; a tag alone does not make a source coded (its key stays), but counts for the note of (e).
- Test "R390 (b)": tag `maria.cocina interviews` on a coded post, a key-touched book and an untouched book → `KW  - P-001 interviews` three times, no "maria"/"cocina", the untouched book keeps `ID  - lee`. Failed first (name printed).

### (c) I3 — the bibliography's destination (95cd1cf)
- `packages/library/src/export/bibliography.ts` `exportBibliography` (about :240): `insideLibrary(dest, repoLibrary(repo))` → `InvalidInputError(IN_LIBRARY_TEXT.exportFile)` before any evaluation, folder, write or audit. Any explicit `dest` inside the library is refused, the library's own `Exports/` named explicitly included (the default with no `dest` still writes there). No caller passes `Exports/` as `dest` (UI none; the CLI has no bibliography command). The route needs no change (the error maps to 400 VALIDATION).
- Tests: `bibliography.test.ts` "R390 (c)": the probe (`<project>/sources/zz-new`, encrypted PSEUDO_GOV) refused, folder not made, no `export.bibliography` event; a link outside into the project folder (and into a new folder under it), and `<lib>/Exports` → refused; outside still written and audited. `apps/library-service/src/server.test.ts` "R390 (c)": `POST /bibliography` with dest inside → 400 `{VALIDATION, sentence}`, folder not made; outside → 200. Both refusal tests and the route test failed first (resolved/200).

### (d) I4 — the true note (bfa65c7)
- `participantRules` (`bibliography.ts` about :95) now also returns `keepsNameList` (= the project is encrypted; additive field). `buildExport`: a fail-closed source with `participantIds` in a project with `!keepsNameList` → reason `PARTICIPANT_NO_LIST_NOTE` (exact sentence of the brief) and the note `EXPORT_NOTES.noList` (exact, singular/plural); every other fail-closed case keeps `PARTICIPANT_CODE_MISSING_NOTE` and its note. `project-export.ts` (about :470): the open export counts those by reason and says in `notes.txt` "N source(s) is/are not in sources.bib and sources.csl.json because it involves / they involve a participant and this project keeps no list …" with the same remedy (before this, such sources would have been dropped from its notes silently, since it counted only the old reason).
- Test "R390 (d)": OPEN_GOV, unencrypted, P-001 (no details) linked to an interview → excluded with the new reason and note in all formats, plural with two, and the open export's note; the really-missing-code case is the existing test (PSEUDO_GOV, Tomasa Ruiz), unchanged and passing. Failed first (constant undefined; before it, the old sentence).

### (e) M1, M3 (e5bda61)
- M1, BUILT DIFFERENTLY: the plain key is `ref-` + the LAST eight characters of the id, lower case (not the first eight). Ids are UUIDv7: the first eight hex digits are the top of the creation timestamp and change only every ~65 s, so every source made within about a minute would share them; the uniqueness step would then add a, b, c… by position — the very instability M1 fixes. The last eight are random. Needs the coordinator's confirmation.
- M3: note `In N sources participants' names were replaced by their codes.` (singular `In 1 source …`), counted for a source where a creator was coded, a written text or tag name was scrubbed, or an address/identifier withheld; NOT for a source whose only change is its withheld key (that has its own note, kept).
- Tests "R390 (e)": keys stable across [post, repost, video] and [video] alone, = `ref-<last 8>`; key-withheld note still there; M3 exact plural/singular, none when untouched. Failed first. Changed existing test: `refman-participants.test.ts` "the reviewer's probe: BibTeX, RIS and CSL-JSON hold P-001…" expected `ref1`; now expects `ref-<post id's last 8>` (M1 changes that key by design).

### Not shown here
- A real macOS volume (case folding of `insideLibrary` for the bibliography's dest) — by the shared check only, Linux here.

minor (deferred): the open-format export does not repeat M3's "names were replaced" note in `notes.txt` (the reference export result carries it).
minor (deferred): M4 (`path` two meanings) is FR-666 per R390.
minor (deferred): `nameRule` calls `toCslItem` once per text field per source in a project with names to replace (cheap, but a direct export of `scrubText` from core would be cleaner once the other agent's `participant-names.ts` lands).

### Runs (all at nice -n 10; machine load average 35–45 throughout)
- Touched files: `refman-participants.test.ts` 12/12, `refman-export.test.ts` + `project-export.test.ts` + `bibliography.test.ts` with it: 60/60; `src/export/` whole folder 250/250; service `server.test.ts -t "R390|R379"` 2/2.
- `pnpm -r typecheck`: exit 0.
- `@ao/cli` whole: 75 passed, 2 failed (cli.test.ts R67 time-out 120 s; prompt.test.ts "two different passphrases" got 'cancelled') — each re-run alone: passed (1/1, 6/6).
- `@ao/library-service` whole: 1023 passed, 4 failed, 1 skipped (annotations-routes locked 423 and main.test port: time-outs; open-library D8 locked rebuild; find-browser "the pause after a hand-over": "Ready in 17 seconds." vs 20, a wall-clock countdown). Re-run of those four files together: 106/107, only find-browser fails, again on the countdown seconds. None touches exports.
- `@ao/library` whole: 3725 passed, 13 failed, 5 skipped. All 13 are speed or time-limit assertions in files this round did not touch (html-strip, custom-styles sandbox pool, import/refman linear parsing "< 1 s" got 1.6–3.5 s, zotero-local "< 1 s", annotations-cap budgets). Re-run each file alone: custom-styles 31/31; the other four fail again on the same time limits (html-strip 3, refman import 4, zotero-local 2, annotations-cap 3), all under the same load. A quiet machine is needed to judge them; no code they exercise changed.
- `git status --short` empty; head e5bda61.

### Process note
- Before the coordinator's standing note, I used `git stash push` / `git stash pop` once, in one command (to see the route test fail without the fix). The pop gave back exactly my own change: afterwards the worktree held only my three files, and commit 95cd1cf has them. The stash list is empty now. I have not used it since.

## Round 3 (R408)

One commit, 2ecaf4c (on e5bda61). R408 (a) and (b) confirmed as built; (c) changed:
- `packages/library/src/fs/inside-library.ts` (end): new `exportDestinationInsideLibrary(path, lib)`. It resolves the real path once (`realOrNearest`: links followed, a path not there yet by its nearest existing parent plus the remaining names). It allows the path when that real path is `<real root>/Exports` or inside it (`insideFolder`, which ignores letter case only on darwin/win32, as before); otherwise it applies `realInsideLibrary` (by name, then device/inode). So a link named `Exports` that leads elsewhere, or `Exports/../Projects/…`, resolves out of `Exports` and stays refused. A second spelling of the library (a bind mount or firmlink) is also still refused (conservative). The comment says a file in `Exports` is in the clear and the import refuses files from inside the library (R368 a).
- Used by `exportBibliography` (`bibliography.ts`, the `dest` check) and `checkDestination` (`refman-export.ts`); the comments of both name R408 c.
- Tests (both new "allowed" tests failed first, refused): `refman-export.test.ts` "R408 (c)": refused first: `Exports/../Projects/<p>/x.bib`, the project's folder, `Backups/x.bib`, the root, a link `Exports` → the project folder (nothing made there). Then `<lib>/Exports/refs.bib` is written. `bibliography.test.ts`: `dest = <lib>/Exports` and `<lib>/Exports/sub` are written, and so is `<lib>/Exports/new/deeper` with no `Exports` folder at all. The changed round-2 test now expects Backups, the root and `Exports/../Projects` refused (it had expected `<lib>/Exports` refused, which R408 reverses). A link `Exports` → a project's folder is refused, nothing made. All earlier refusals (an original, the rules file, a project's folder, links in, `..`) still pass.
- Not changed: `writeRefmanExport` still makes no parent folder (true for any destination), so a reference file under a not-yet-existing `Exports/sub/` fails to write (ENOENT), as an outside path with a missing folder always did. The "folder may not exist yet" case is therefore tested through the bibliography, which makes its folder.
- Runs: `vitest run src/export` 253/253; CLI `cli.test.ts -t "R368 a|export"` 17/17; service `server.test.ts -t "R390|R379|POST /cite"` 3/3; `pnpm -r typecheck` exit 0; `git status --short` empty. No `git stash` used.
