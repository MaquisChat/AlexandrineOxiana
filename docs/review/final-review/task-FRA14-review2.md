# Task FR-A14 — second look, scoped (R390, R408)

Reviewer: same as `task-FRA14-review.md`. Worktree `.claude/worktrees/agent-a0328b7cc1ec55b55`, branch `fr-a14-exports`, head 2ecaf4c (six commits on b1e3d29). Read: R390, R408, the report's "Round 2 (R390)" and "Round 3 (R408)" sections, and at head: `refman-export.ts` (`nameRule`, `scrubbedRef`, `underParticipantRules`, `buildExport`, `checkDestination`), `bibliography.ts` (`participantRules`, the `dest` check), `fs/inside-library.ts` (`exportDestinationInsideLibrary`), `project-export.ts` (the notes). I did not read the whole 956-line package line by line. Probes were `packages/library/src/export/r2.probeFRA14.test.ts` and a copy of the base writer (`refmanbase.probeFRA14.ts`). Both are deleted, and `git status --short` is empty. No `git stash` was used.

## Verdict: NOT APPROVED

The first round's five clauses are all built, and a test fails without each guard. One name still gets out: a participant's name inside a creator who is not a participant (I1). The other points are small.

## Per clause

**(a) R390 a: every written text goes through the name rule.** I made a pseudonymising, encrypted project in which `@maria.cocina` is coded P-001. In it I put: the probe post; an Instagram brand post with container "Repost from Maria Cocina"; a YouTube video with publisher "Maria Cocina"; a book with key `maria.cocina-notes`; a chapter with every bibliographic field set to "X Maria Cocina <field>", publisher "maria.cocina press", DOI `10.1234/maria.cocina` and URL `https://ex.org/maria-cocina`; a web page by the creator "Friends of Maria Cocina"; and an untouched book. I exported all three formats with `includeTags`, and the open export.
- Fixed: `T2 - Repost from P-001`; `PB - P-001`, with no "YouTube" in place of the stored publisher; the book's key is withheld and becomes `ref-d15a3b42`; every bibliographic field reads `X P-001 …` (place, edition, volume, issue, series, genre, medium, number); the DOI and URL are left out, not scrubbed (R408 b); the ISSN with no name is kept; BrandCo and the editor and translator keep their roles.
- No writer emits an abstract, note, language, archive location, `file` or `annote`. I checked this in `toBibtex`, `toRis` and `toCslJson`.
- Untouched sources are unchanged. Against the base writer (7b81976), three sources (two roles, a literal, a key-less page, a duplicate key, braces, `--`, DOI, URL with a space, a tag, `includeTags`) gave identical text and notes in all three formats. I ran this in a project whose list holds a name and in OPEN_GOV.
- Still leaked: see I1.

**(b) R390 b: tags.** The tag `maria.cocina interviews` reads `KW - P-001 interviews` on coded entries and on the untouched book. That book keeps its key `lee`.

**(c) R390 c and R408 c: destinations.**

| Destination | Result |
|---|---|
| reference export `<lib>/Exports/refs.ris` | written |
| reference export `Exports/sub/refs.ris` | written |
| bibliography `dest=<lib>/Exports` | written |
| bibliography `Exports/new` (new folder) | written |
| `Exports/../Projects/<p>/x` (both writers) | refused |
| `<lib>/exports/x.ris` (another case; this Linux disk is case-sensitive) | refused |
| `Exports` itself as the reference file | refused as a folder |
| a link inside `Exports` that leads to a project (both writers) | refused, nothing made |
| a link outside that leads to `Exports` | written |
| `<lib>/Exports` replaced by a link to a project folder | reference export refused |

- On macOS, `insideFolder` ignores case, so `exports` is the same folder (read only, not run).
- The earlier point-1 attacks still hold through the same `realOrNearest` and device/inode path: a parent that is a link, `..`, the root, and the rename that replaces a link rather than writing through it.
- An import from `Exports` is refused. The existing test `in-library.test.ts` "a BibTeX, RIS, CSL-JSON or Zotero RDF export file inside the library" writes into `<lib>/Exports` and gets the R368 a refusal, and it passes.

**(d) R390 d: no list of names.** In OPEN_GOV (unencrypted), P-001 with no details is linked to interviews whose only creator is the interviewer. One source gives "1 source was left out because it involves a participant …"; two give "2 sources were left out because they involve …". The per-source reason is `PARTICIPANT_NO_LIST_NOTE`, and the open export's `notes.txt` has its own sentence. The two cases are told apart by `rules.keepsNameList` (whether the project is encrypted) plus the participant link, not by an error's text. A code that is really missing (the existing Tomasa Ruiz test) keeps the old sentence. One gap remains (M1).

**(e) R390 e and R408 a: keys and the note.**
- The key is `ref-` plus the last eight characters of the id. The same video gets `ref-e92c6997` in a seven-source export and alone.
- Those eight characters are the 32 random bits of the `uuidv7` package (`nextUint32`, the last field). They hold no name and do not depend on position.
- If a key repeats (two ids with the same last eight, or a source whose own key is `ref-xxxxxxxx`), the uniqueness step appends `a`, `b` … in export order (M3).
- The note "In 6 sources …" was right for that export: four sources coded or scrubbed plus two with only a scrubbed tag. "In 1 source …" appears for the video alone, and no note appears when nothing was touched (the implementer's test).

**Each guard fails its tests when taken out** (one at a time, put back with `git checkout`):

| Guard removed | Tests that failed |
|---|---|
| `scrub` returns its input unchanged | 8 |
| tags not scrubbed | 1 (b) |
| no-list branch off | 1 (d) |
| key by position | 2 |
| "names replaced" note off | 1 |
| `Exports` allowance off | 2 (R408 c) |
| bibliography `dest` check off | 3 (R390 c) |

## Findings

### Important

**I1: A participant's name inside the name of a creator who is not a participant is written as it stands, and so is the key the app made from it.**
- Where: `refman-export.ts:331-336` (`nameRule.creator`) and `:388-390` (`textOf` blanks creators).
- Cause: `creator()` takes the creator from `toCslItem`. For a creator who is not a participant, `toCslItem` returns the stored name (`cslName`) without scrubbing it. `textOf` leaves creators out of the "changed?" comparison, so the source counts as untouched. The key check (`rule.names`) works on whole words, so it misses a name joined inside a longer key.
- Probe: a non-identifiable web page by `{literal: "Friends of Maria Cocina"}`, no key given. In all three formats and in the open export's `sources.bib` it comes out as `@online{friendsofmariacocinafan,`, `AU - Friends of Maria Cocina` and `"literal": "Friends of Maria Cocina"`.
- R390 a: "EVERY text the reference export writes for a source is put through the same name rule". The bibliography prints the same creator, because `toCslItem` does not scrub names it does not code. Core cannot be edited, so the fix belongs in the export.
- Smallest fix: in `creator()`, put a creator who is not coded through `scrub` (literal, family, given), and keep creators in the touched comparison. Such a source is then coded and its key withheld. Add a test with a literal creator.

### Minor

**M1: An encrypted project whose list holds no names still gets the old, false sentence.** In PSEUDO_GOV (encrypted), a participant with no details is linked to an interview by an interviewer only, and nothing else is in the list. The result is "A participant in this source has no participant code yet" and the note "1 source was left out because a participant in it has no participant code yet." The participant has the code P-001. The real reason is the same as R390 d's: there are no names to replace. This happens because `keepsNameList` is simply "the project is encrypted" (`bibliography.ts:111`). Smallest fix: treat an empty map plus a participant link as the no-list case too, with wording that does not claim the project is unencrypted.

**M2: In RIS, a code inside a page field is split as a page range.** `pages = "X Maria Cocina page"` came out as `SP - X P` and `EP - 001 page`: the hyphen of P-001 is read as a range. Unlikely in real data. Smallest fix: split only on a hyphen between digits, or scrub after splitting.

**M3: The uniqueness suffix brings position back on a rare collision.** If the last eight characters repeat (32 random bits; about 1% for 10,000 coded sources in one export), or a source's own key happens to be `ref-xxxxxxxx`, the key that comes second gets `a`, `b` … in export order. Acceptable; a note in the code would do.

**M4: The bibliography's default destination is not checked (existing behaviour, not this round).** With `<lib>/Exports` replaced by a link to a project folder, `exportBibliography` with no `dest` wrote `<p> - bibliography - apa - ….txt` into the project folder. Only a named `dest` is checked. Smallest fix: run `exportDestinationInsideLibrary` on the default `Exports` path too, so it refuses when `Exports` resolves elsewhere inside the library.

## Checked and sound

- R408 b: identifiers that name a participant are left out (DOI, URL), and identifiers that do not are kept (ISSN).
- A coded source keeps its own container and publisher, scrubbed (M5 of round 1).
- Untouched sources are byte for byte as before.
- The open export's notes cover both left-out reasons.
- Imports from `Exports` are refused.

## Could not verify

- A case-insensitive macOS volume for the `Exports` allowance; I read the code only.
- The whole suites; I ran single files at heavy load, and all of them behaved.
