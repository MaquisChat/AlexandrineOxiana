# Task FR-A14 review (exports: R379 / WB4 I1, I2, I4)

Reviewer: fresh, adversarial. Worktree `.claude/worktrees/agent-a0328b7cc1ec55b55`, branch `fr-a14-exports`, head b1e3d29 (base 7b81976). Read: the common brief and reader rules, WB4 I1/I2/I4, the brief, the report, the whole package (964 lines), R379 (FR-A14 bullet), R388, R88, R90, R92 and the index lines for R77/R88/R90/R92. Also read `fs/inside-library.ts`, `fs/atomic.ts` (`writeFileAtomic`), `core/citation/csl-map.ts` `toCslItem` (read only), `bibliography.ts` `exportBibliography`, the CLI `export` command, the service's `citations.ts`, `move.ts` preflight, `core/model/asset.ts`, `source.ts`.

## Verdict: NOT APPROVED

Spec: point 1 ✅ and point 3 ✅ as briefed; point 2 ❌ — participant names that the rules know still get out of a reference export through fields `toCslItem` never emits (I1, I2). One writer of the same class as point 1 is left open (I3). Quality: Needs fixes.

## What I ran (each alone, `nice -n 10`; probe files `packages/library/src/export/refman*.probeFRA14.*`, all deleted; `git status --short` empty at the end)

1. The WB4 probes again, against the fix: the original's path and `governance.yaml` as `outputPath` → refused, byte-identical (the implementer's test is that probe; it passes). The `@maria.cocina` / `mariacocina2026` source → P-001 and `ref1` in all three formats. The linked file → no `absolutePath` in `source.json`.
2. Point 1 attacks (results below under "checked and sound").
3. Point 2 attacks: a pseudonymising, encrypted project (PSEUDO_GOV) with the probe post, a tag `maria.cocina interviews`, a non-identifiable brand post on Instagram whose `container` is "Repost from Maria Cocina", a YouTube video whose `publisher` is "Maria Cocina", a book with key `maria.cocina-notes`; all three formats with `includeTags`, and the open-format export's `sources.bib`. Control: the same container on an `article-journal` → the rules scrub it to "Repost from P-001" (so the name is one the rules know).
4. Byte-for-byte: a copy of the base's `refman-export.ts` (7b81976) against the head on three sources (two creators of two roles, a literal, a key-less page, a duplicate key, braces, `--`, a DOI, a URL with a space, a tag, `includeTags`), in OPEN_GOV and in PSEUDO_GOV (encrypted, no participant): text and notes identical in all three formats.
5. R388 b: an encrypted, identifiable project that does NOT pseudonymise, a participant with `details.name = "Ann Adams"`, a published book by Ann Adams and an identifiable interview by Maria Lopez. And an unencrypted OPEN_GOV project with a participant without details linked to an interview.
6. Point 3: a whole open-format export with a linked file, every `.json/.md/.bib/.txt` searched for the temporary folder (as given and its real path), the home folder and `"../`.
7. Guards out, tests in: (a) `insideLibrary` and the link check removed → the 3 refusal tests of `refman-export.test.ts` fail; (b) `underParticipantRules` always `null` → both P-001 tests fail; (c) the `participantIds` branch removed → both P-001 tests fail (the "plain" `toCslItem` call then throws); (d) `exportedRecord` returning `sf` → both I4 tests fail. Each put back with `git checkout`.

## Findings

### Critical
None.

### Important

**I1 — A participant's name in a social post's `container` or a video's `publisher` is printed verbatim by all three reference exports and by the open-format export's `sources.bib` / `sources.csl.json` (R88 "never a printed name"; R379 FR-A14 "titles and addresses scrubbed").**
`refman-export.ts:336-347` (`underParticipantRules`) decides "untouched" by comparing two `toCslItem` outputs; `toCslItem` (`csl-map.ts`, the platform branch) replaces a social post's container by the platform name ("Instagram") and a video's publisher by "YouTube" and never reads `s.container` / `s.publisher` there. So a name in those fields changes neither output; the source is judged untouched and `refOf` (`:356`) writes the stored field. Probe (PSEUDO_GOV, encrypted, `@maria.cocina` mapped to P-001):
- non-identifiable Instagram post, creator "BrandCo", container "Repost from Maria Cocina" → BibTeX `booktitle = {Repost from Maria Cocina}`, RIS `T2  - Repost from Maria Cocina`, CSL-JSON `"container-title": "Repost from Maria Cocina"`, and the same line in the open export's `sources.bib`;
- YouTube video, channel "BrandCo", publisher "Maria Cocina" → RIS `PB  - Maria Cocina`;
- control: the same container on an article → `T2  - Repost from P-001`.
The same blind spot holds for any field the writers emit that `toCslItem` does not (see I2, M2). Direction: decide "touched" from the fields the export itself writes (scrub each emitted text field with the same forms, or compare the export's own Ref built with and without the map), not from `toCslItem`'s output alone; and for a coded source keep the scrubbed stored container/publisher rather than silently swapping in the platform name (see M5). Test: a name in each emitted text field of an otherwise untouched source.

**I2 — With `includeTags` (`--include-tags`, the route's `includeTags`), tag names are written verbatim — for a coded source too.**
`refman-export.ts:370` and `codedRef` (`:317`) never pass tags through the rules. Probe: tag "maria.cocina interviews" on the coded post → BibTeX `keywords = {maria.cocina interviews}`, RIS `KW  - maria.cocina interviews`, CSL-JSON `"keyword": "maria.cocina interviews"`, while the same entry's author is P-001. The implementer listed this as a deferred Minor; it is the R88 rule broken in a code-requiring project, through an option the CLI and the service offer (R64 made tags opt-in because tag names identify people — opting in to tags is not opting out of R88). The open-format export passes no `includeTags`, so it is not affected. Direction: scrub tag names with the rules' forms (or leave tags out of coded sources / out of exports in a project that requires codes, with a note).

**I3 — Another writer of point 1's class: the bibliography's `dest` writes inside the library, creating folders — a plaintext file inside an encrypted project.**
`bibliography.ts:245-246` (`exportBibliography`): `dest` is checked only for being absolute by the route (`routes/citations.ts:70-71`, `POST /bibliography`); then `mkdir(dest, {recursive: true})` and a write. Probe (PSEUDO_GOV, encrypted): `dest = <project>/sources/zz-new` → written `Lib/Projects/<p>/sources/zz-new/<p> - bibliography - apa - modified ….txt`, the folders created, a plaintext file in an encrypted project's folder, no governed store decision (only `export.bibliography` audited). On a Mac `sources` is `Sources`, so the new folder lands among the source folders. It never overwrites (dated, collision-suffixed name), so no original is lost — hence Important, not Critical. The implementer named it as deferred. Survey of every other researcher-named destination: the reference export (fixed here), the open-format export (refuses inside the library, R92 I1; no route or CLI caller), the library move (`move.ts:328`, real path of nearest parent, by name with case folded; no inode check), backups (fixed `Backups/`, no researcher destination), audit log and destruction certificates (GET routes that return content, no file written), the CLI (`--output` of `export` is its only file/folder option). No search-log export, "save a copy" or diagnostics bundle writer exists. Direction: `insideLibrary` on `dest` unless it is the library's own `Exports/` (the default), or refuse any `dest` inside the library other than `Exports/`.

**I4 — In a project that cannot pseudonymise (unencrypted), every source linked to a participant now leaves the reference exports and the open export's `sources.bib` / `sources.csl.json`, with a note that is false and cannot be acted on.**
`toCslItem` throws when a source has `participantIds` and the pseudonym map is empty (`csl-map.ts:322`, R89). An unencrypted project can never have a map (probe: `createParticipant` with details is refused there: "Pseudonymized names need the encrypted pseudonym map, but this project is not encrypted"). Probe (OPEN_GOV, unencrypted, not identifiable): participant P-001 (a code, no details) linked to an interview whose only creator is the interviewer → `excluded` with "A participant in this source has no participant code yet, so it cannot be exported." and the note "1 source was left out because a participant in it has no participant code yet." The participant HAS a code; no name is anywhere in the entry; the researcher can do nothing to bring it back. Before the fix it was exported. It is what the bibliography already does (`citeSources` throws for the same source), so it is "the same rules" — but R388 b only weighed participants with name details, and an honest researcher in an ordinary project loses entries. Needs the coordinator's ruling: either R89's fail-closed applies only where codes are required or names are present (the entry carries none here), or the note must say the true reason and what to do.

### Minor

**M1 — `ref<n>` is not stable: the same key names different sources in two exports.** `refman-export.ts:427`: `n` is the position in this export. Probe: export [A, B] → A `ref1` (P-001), B `ref2` (P-002); export [B] alone → B is `ref1`. A LaTeX document with `\cite{ref1}` silently cites another source after a re-export. As briefed ("as for a source without a key"), but now it applies to every participant source. Direction: a key holding no name but stable for the source, e.g. the code(s) plus year, or the short id the source folder already carries (`[jn6s]`).

**M2 — An untouched source's own key (and any other field `toCslItem` does not emit — DOI, ISBN list, arXiv id) is copied even when it holds a mapped name.** Probe: a book by Adams with key `maria.cocina-notes` → `@book{maria.cocina-notes,`. Contrived, but it is the same blind spot as I1; folding the key into the "touched" decision (scrub check on the key) closes it.

**M3 — R388 b's change is told only half.** Probe (encrypted, identifiable, not pseudonymising; participant details `name: Ann Adams`): a published book by Ann Adams → `@book{ref1, title = {P-001 on books}, author = {{P-001}}}`; the only note is "1 citation key was not exported because the source involves a participant …". Nothing says that names and the title were replaced by codes, and "involves a participant" is untrue for a namesake author (over-scrubbing is R88's chosen side; the note should still be true). Direction: a note that participant names were printed as their codes, without "involves".

**M4 — The exported `source.json` gives `path` two meanings.** `project-export.ts:100`: a linked asset's `path` is now export-relative (`files/linked.pdf`) while a copied asset's stays library-relative (`Projects/<p>/Sources/…`). Nothing reads it back (no importer or restore reads an open export's `source.json`; the restore reads backups), so no break; but a reader of the export cannot use one rule. Direction: say it in the header/notes, or give copied assets their export place too (or a separate `exportedAs`).

**M5 — A coded source loses its stored container/publisher for the platform name, and creators are regrouped by CSL role.** `codedRef` (`:317-320`) takes `container-title` / `publisher` from `toCslItem`, which uses "Instagram"/"YouTube" for platform posts/videos; creator order changes across roles (implementer's own note). Acceptable as "the rules' output", worth one line in the notes or header.

## Checked and sound

- **Point 1, the library function** (`checkDestination`, `refman-export.ts:481`, called before `buildExport`, so nothing evaluated, written or audited when refused):
  - a link outside → inside (test); a PARENT that is a link into the project folder → refused (probe); `..` (test); a new file in a new folder (test; folder not created); the library root itself → refused; a relative `governance.yaml` with the cwd in the project → refused (resolved against `process.cwd()` by both the check and the write, consistently); the CLI resolves `--output` against the user's cwd first (`session.ts:24`), the service refuses a relative `outputPath` (400, unchanged).
  - letter case: `insideFolder` folds case and NFC on darwin/win32, and the device/inode walk catches a second spelling (bind mount, `/System/Volumes/Data`, a case-insensitive volume on Linux) — by reading; only Linux here.
  - a dangling link as a parent pointing to a missing folder inside → not judged inside, but the write fails (ENOENT): nothing created.
  - a HARD link outside to `governance.yaml` → not detected (stated limit of `inside-library.ts`), but harmless here: `writeFileAtomic` writes `<dest>.tmp-…` and renames over the outside NAME; the library file kept its bytes (probe).
  - the destination swapped for a link after the check: `rename` replaces the link itself, never writes through it (probe: the rules file unchanged). The remaining window is a PARENT folder swapped for a link between check and rename — needs another process; the researcher names the path (implementer's own note; same for the imports).
  - read-only library: the route uses `requireSession`, the check runs regardless; a locked project fails in `getSource` after the check.
  - service: `InvalidInputError` → 400 VALIDATION with the sentence (test); CLI: exit 1, sentence on stderr (test). The sentence matches the brief exactly.
- **Point 2:** the probe post → P-001, `ref1`, URL naming the handle dropped, in all three formats and the open export; a source failing closed is excluded by id, counted in a note, absent from the text; the audit records only counts. No project without participant/map hits changes by a byte (probe 4). The excluded entry and notes name no one.
- **Point 3:** no exported text file holds the temporary folder (as typed or real), the home folder or a `"../` path (probe 6); `linkedInPlace: true` with the export path; the library's record untouched (test). No importer or restore reads an open export's `source.json`, so the missing `linked` field breaks nothing; the record still satisfies the `Asset` refinement (`path` a valid relative path when `linked` is absent).
- Each guard is held by a test that fails without it (run 7).

## Could not verify

- A real macOS volume (case-insensitive APFS, the firmlink) — by reading `inside-library.ts` only.
- Whether a stray folder/file written into `Projects/<p>/Sources/` by I3 trips the index rebuild or the integrity check (not traced).

## For the coordinator

- I4 needs a ruling: does R89's "participants but no map → fail closed" belong in an unencrypted project's exports, where no map can exist and the entry carries no name?
- M1: the brief asked for `ref<n>`; a stable name-free key is a small change if you want it.
