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

### Participants

- `toCslItem` takes the project's pseudonym map (handle or name → participant code).
- A creator who matches the map under any name form becomes `{ literal: <code> }`. Name forms are: the handle with or without `@`, literal, family, given, "given family", and "family, given".
- The same name forms are replaced by the code in the title, container and publisher, using core `pseudonymize`.
- A URL that contains a name form is left out.
- `Participant.details` is never an input to `toCslItem`.
- With `requireParticipantCodes` (projects that pseudonymize names), an uncoded creator is an error rather than a name. The interviewer is excluded, because the interviewer is the researcher.

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
