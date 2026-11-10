# 0012. Citations: CSL bundle, multilingual titles and participant codes

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

Spec 8.1 asks for CSL citations through citeproc-js with the full style repository bundled, custom styles that researchers can import, locators (including timestamps), and multilingual titles: original script, romanized and translated. Field material is cited as the researcher's own, and research participants must never be identifiable in a citation (spec 4.4, R86).

Constraints:

- `@ao/core` is platform-neutral. It may not read files.
- The CSL styles and locales are CC BY-SA 3.0, and the styles repository is about 90 MB unpacked.
- No CSL style knows our title variants. A style receives one `title` string.

## Decision

### Bundle

- `scripts/fetch-csl.mjs` downloads pinned commits of `citation-style-language/styles` and `citation-style-language/locales`.
  - Each is pinned by commit and by the sha256 of its tar archive. The pin is the uncompressed tar: `git archive` output for a commit is deterministic, while the gzip framing of GitHub's tarballs is not guaranteed to stay byte-identical.
  - The script tries codeload.github.com first. If that fails, it builds the same tar with `git fetch --depth 1` and `git archive`, and checks the same hash.
  - It fails closed: on a mismatch nothing is written and the script exits 1.
- It writes:
  - `packages/core/csl/styles.zip`, which holds every style, an `index.json` (id, title, file, parent), `renamed-styles.json`, and the licence and notice;
  - `packages/core/csl/locales/`.
- These files are about 15 MB and are generated, not committed. `pnpm fetch-csl` runs in CI and in setup.
- `LICENSE-CC-BY-SA-3.0.txt` and `NOTICE.md` are committed next to the bundle and copied into the zip.
- Core reads the bundle through an injected `CslLoader`. `zipCslLoader(bytes, localeFn)` uses fflate, which is pure JS. The app sets the loader once with `setCslLoader`.
- A dependent style renders with its independent parent. Renamed style ids resolve to their current id.

### Rendering

- citeproc-js 2.4.63 is pinned exactly.
- `lang` is forced over the style's default locale. A locale that is missing falls back to en-US.
- `html` output is citeproc's html format, which escapes every field value. The only extra markup is citeproc's own `csl-bib-body` wrapper. `rtf` output is an RTF fragment.

### Titles

- `script: 'romanized'` uses the romanized variant when one exists, otherwise the original.
- `translatedTitles: 'append'` gives `"<original> [<translated>]"`. This happens only when both of these hold:
  - the original title's language differs from the citation language (compared by primary subtag, so `en-GB` matches `en`);
  - a translated variant in the citation language exists.
- When romanizing, the romanized form is shown and the translation is appended to it.
- The item's CSL `language` is set to the original's language, so citeproc-js does not title-case non-English titles.

We chose the bracketed append because APA 7, MLA 9 and Chicago all accept or recommend a bracketed English translation after a non-English title. A plain string works with every CSL style, whereas CSL-M's multilingual fields work only with styles written for them. `'off'` leaves the title as stored.

### Platforms

These follow the CSL convention the styles expect (R87):

- A video's platform is its `publisher`. APA then gives "[Video]. YouTube.", and MLA and Chicago italicize the video's title as a standalone work.
- A social post's platform is its `container-title`.
- A social post that is a video gets genre "Video", unless the source sets its own genre. A post counts as a video when its original media is a video, when it is on TikTok, or when its URL is an Instagram reel.

### Engine state, locators and imported styles (R88)

- **Engine state.** citeproc-js keeps rendered items in its registry by id. An engine is kept per style and language, because building one takes about half a second. Every render first empties the item registry and the citation state, so a render never shows an item as it was before an edit.
- **Input checks.** A `lang` that is not a language tag falls back to en-US. Locators are reduced to plain text (letters, digits and the punctuation locators use) before citeproc sees them, so `<i>3</i>` cannot become markup in html or rtf.
- **Imported styles.** These are untrusted, and citeproc-js has no limits of its own. They are never rendered in-process: core throws `CustomStyleSandboxError`.
  - `@ao/library` renders them in a pool of `worker_threads` workers (R89). At most 2 run at once, and further renders wait their turn.
  - Each style keeps one warm worker, whose engine is reused with fresh state for every render. A warm worker is ended after 60 s idle, or when its slot is needed for another style.
  - Limits: 10 s to start a worker and build its engine; 5 s per render, counted from when the worker begins it; 256 MB of heap.
  - A timeout, a heap overrun or an error ends the worker.
  - This covers the import probe, every render with an imported style, and files dropped into `styles/` by hand (checked when listed).
  - A verdict on a dropped file is remembered by sha256 only when it is deterministic: usable, too complex, or refused by citeproc. A timeout is never remembered.
  - A memoised walk of the macro graph refuses styles whose macros call themselves, or that would expand more than 1,000,000 macro calls. That cap is a backstop only: the bundled styles reach about 225,000, and a test keeps every bundled style under it. The sandbox's limits are the real guard.
  - Bundled styles render in-process.

### Participants

- `toCslItem` takes the project's pseudonym map (handle or name → participant code).
- Names are compared folded (R88, R89): ł ø đ ß æ œ þ ı transliterated, then NFKD, combining marks removed, lowercase, words only. So "@Lucía.Cocina", "lucia cocina" and full-width forms are the same name, and so are "Wałęsa" and "Walesa". A name written as one word ("marialopez") matches in titles and URLs.
- A creator who matches the map under any name form becomes `{ literal: <code> }`. Name forms are: handle, literal, "given family", "family given", family, and given.
- Every map entry, and every coded creator's name forms, are replaced by the code in the title, container, publisher and the other text fields. Matching is on whole words. Longer forms win, and an `@` in front is included.
- A bare given or family name shorter than 4 letters is replaced only together with the other part of the name. So "Li" alone is kept, while "Rose Li" and "Li, Rose" are replaced.
  - Longer bare names are always replaced, even where the word means something else: "Rose gardens" becomes "P-040 gardens". This over-scrubbing is the fail-safe side of the tradeoff.
  - Short first names alone can still appear in a title. Projects that need more should keep names out of titles; R64 flags them at import.
- A URL that carries any name form, as whole words in any slug form (joined, `-`, `.` or `_`), is left out. There is no length floor.
- The citation key is not copied when participants are involved.
- `Participant.details` is never an input to `toCslItem`.
- A source with `participantIds` but no pseudonym map is an error outright (R89).
- A creator other than the interviewer who has no code is an error, never a printed name (`ParticipantCodeMissingError`). This applies to every source with `participantIds`, and to any source when `requireParticipantCodes` is set. The interviewer is excluded, because the interviewer is the researcher.
- Wiring the project's governance into these options (`requireParticipantCodes` and the pseudonym map) is carried to Tasks 32 and 36.

### Custom styles

- `addCustomStyle` lives in `@ao/library` and writes to `<Library>/styles/<id>.csl`.
- The write is governed: it is evaluated as a `store` with no identifiable data or location, and a deny is audited.
- The write is atomic, with mode 0600, and is audited as `style.add` (id, sha256, bytes).
- It refuses:
  - DOCTYPE and ENTITY;
  - input over 1 MB;
  - XML whose root is not `<style>` in the CSL namespace;
  - independent styles that citeproc-js cannot load;
  - dependent styles whose parent is unknown.
- Ids never shadow a bundled style: they get a `custom-` prefix. A different style with the same id gets `-2`, `-3`, and so on. Re-importing the same bytes returns the existing id.

## Consequences

- Every CSL style can show translated titles without changes. Styles that would rather print the translation elsewhere, for example after the container, cannot be served this way. That would need CSL-M or a per-style override.
- Snapshots of APA, Chicago author-date, MLA, ASA and Harvard (Cite Them Right) are committed with a "PENDING HUMAN REVIEW" header. They must be checked against the style guides.
- R87 added optional bibliographic fields to `Source`: volume, issue, page, edition, numberOfPages, publisherPlace, collectionTitle, collectionNumber, and genre/medium overrides. Lookups, the Zotero, BibTeX, RIS and CSL-JSON importers and the exporters carry them. Before this, a journal article without volume, issue or pages rendered as "ahead of print" in Chicago and as "[Preprint]" in Harvard.
- ASA prints no URL for a video and only the title for a field photo. Those are the ASA style's own rules for `motion_picture` and `graphic`, not missing fields. It also prints no platform for a social post, because the style reads `publisher` for posts, while APA, Chicago, MLA and Harvard read `container-title`. Setting both would print "Instagram" twice in those four styles.
- Updating the styles means bumping the commit and the sha256 pins in `fetch-csl.mjs` and in `NOTICE.md`.
- **Open decision:** citeproc-js is dual-licensed CPAL-1.0 / AGPL-3.0. Which licence the application takes is the project owner's decision. It has not been made yet and must be made before distribution (R87).
