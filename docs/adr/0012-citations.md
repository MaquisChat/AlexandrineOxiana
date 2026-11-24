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
  - Limits: 10 s to start a worker and build its engine; 5 s per render, counted from when the worker begins it; a heap cap of 256 MB.
  - The heap cap is overridden by a process-wide Node memory setting (`--max-old-space-size`, on the command line or in `NODE_OPTIONS`): where one is set, every worker's real cap is that setting, whatever the sandbox asks for (R503 k, FR-740). The desktop app starts the service with `--max-old-space-size=512`, the service's memory ceiling, so in the app the cap is 512 MB; a style that allocates without end still ends only its worker, later than at 256 MB. The time limits always hold.
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
- **Licence decision (R124, closes the open decision in R87):** on 2026-11-11 the project owner chose to use citeproc-js under CPAL-1.0. The project's own licence is not chosen yet. AGPL-3.0 is the likely later choice and must stay possible. No project LICENSE file is added and nothing is published until the owner decides (gate in Task 56, which re-checks this).

### What CPAL-1.0 requires of this application

This records what the licence texts say. It is not legal advice. Anything marked "our reading" is our interpretation, not the text, and where the text is unclear we say so.

**Sources.**

- The package shipped in `node_modules/.pnpm/citeproc@2.4.63/node_modules/citeproc/` has a `LICENSE` (the same text is the header of `citeproc_commonjs.js`) that holds only the copyright line and the EITHER/OR grant. It has no CPAL text and no Exhibit B. `README.rst` and `package.json` say nothing about attribution.
- The CPAL-1.0 text is `packages/core/csl/LICENSE-CPAL-1.0.txt`, saved unchanged from the SPDX licence list (URL and sha256 in `NOTICE.md`). Section numbers below are its own.
- Upstream (<https://github.com/Juris-M/citeproc-js>, raw files on branch `master`, checked 2026-11-11): `LICENSE` and `README.rst` exist and `LICENSE` is the same short grant. `README.md`, `NOTICE`, `NOTICE.md`, `COPYING`, `ATTRIBUTION`, `ATTRIBUTION.md`, `attribution.txt`, `LICENSE.txt`, `LICENSE.md` and `CPAL.txt` all returned 404. The first 80 lines of `citeproc.js` and `citeproc_commonjs.js` are the same grant as the `LICENSE`. The word "attribution" appears there only in the name "Common Public Attribution License". **Upstream ships no Exhibit B and no attribution notice.**

**The choice of licence (shipped `LICENSE`).**

> "under EITHER * the terms of the Common Public Attribution License (CPAL) as published by the Open Source Initiative, either version 1 of the CPAL, or (at your option) any later version; OR * the terms of the GNU Affero General Public License (AGPL) as published by the Free Software Foundation, either version 3 of the AGPL, or (at your option) any later version."

- The text does not say that taking one licence prevents taking the other later. Our reading: the choice is the recipient's, so CPAL-1.0 now does not on this text prevent AGPL-3.0 for a later release. A copy already distributed is not addressed.
- CPAL Section 6.2: "Once Covered Code has been published under a particular version of the License, You may always continue to use it under the terms of that version."
- CPAL Section 13: "Multiple-Licensed means that the Initial Developer permits you to utilize portions of the Covered Code under Your choice of the CPAL or the alternative licenses, if any, specified by the Initial Developer in the file described in Exhibit A."
- Unclear: Sections 1.6, 1.10 and 5 tie "Initial Developer", "Original Code" and the licence's reach to "the notice in Exhibit A", and the upstream files carry the grant above, not an Exhibit A notice. The text does not say whether that grant counts as the Exhibit A notice. We treat it as doing so, because the upstream authors offer the code under CPAL in it. This is for the owner or a lawyer.
- What we do: record the choice (this ADR, `NOTICE.md`, R124).

**What triggers obligations.**

- Section 1.0.1: "'Commercial Use' means distribution or otherwise making the Covered Code available to a third party."
- Section 3.6: "You may distribute Covered Code in Executable form only if the requirements of Section 3.1-3.5 have been met for that Covered Code". Section 1.5: "'Executable' means Covered Code in any form other than Source Code." Section 1.11 defines Source Code as "the preferred form of the Covered Code for making modifications to it".
- Section 15 (External Deployment): "The term 'External Deployment' means the use, distribution, or communication of the Original Code or Modifications in any way such that the Original Code or Modifications may be used by anyone other than You, whether those works are distributed or communicated to those persons or made available as an application intended for use over a network. As an express condition for the grants of license hereunder, You must treat any External Deployment by You of the Original Code or Modifications as a distribution under section 3.1 and make Source Code available under Section 3.2."
- Our reading: giving the application to a researcher is a distribution, and that is the trigger. An application installed on the researcher's own computer is "distributed" to them, so Section 15 reaches it, but it adds only that this counts as a distribution under Section 3.1. The service on 127.0.0.1 (R96) is not made available to others over a network. Not unclear in outcome, but note that Section 3.2 speaks only of Modifications, so Section 15 asks for little where there are none.
- Nothing is triggered by using citeproc-js while developing. Nothing is distributed until the owner publishes (R124).

**Notices that travel with the app.**

- Section 3.1: "You must include a copy of this License with every copy of the Source Code You distribute." Section 3.5: "You must duplicate the notice in Exhibit A in each file of the Source Code." and "You must also duplicate this License in any documentation for the Source Code where You describe recipients' rights or ownership rights relating to Covered Code."
- Section 3.6, for the executable form: "You may distribute Covered Code in Executable form only if ... You include a notice stating that the Source Code version of the Covered Code is available under the terms of this License, including a description of how and where You have fulfilled the obligations of Section 3.2. The notice must be conspicuously included in any notice in an Executable version, related documentation or collateral in which You describe recipients' rights relating to the Covered Code."
- Section 3.2 (what it says about availability): "Any Modification which You create or to which You contribute must be made available in Source Code form under the terms of this License". It names Modifications only.
- Unclear: whether citeproc-js inside the packaged app counts as Source Code or as an Executable. The bundled JavaScript is close to the preferred form for modifying, but a bundler may transform it. We therefore meet both sets of duties.
- What we do: ship `LICENSE-CPAL-1.0.txt` and citeproc-js's own `LICENSE` beside the citation bundle and inside the packaged app; keep the header of `citeproc_commonjs.js` untouched; state in the About screen and in `NOTICE.md` that the source of citeproc-js is available under the CPAL, give its repository URL and the pinned version (2.4.63), and say the project makes no Modifications to it.

**Attribution.**

- Section 14(a): "the Original Developer may include in Exhibit B ('Attribution Information') a requirement that each time an Executable and Source Code or a Larger Work is launched or initially run (which includes initiating a session), a prominent display of the Original Developer's Attribution Information (as defined below) must occur on the graphic user interface employed by the end user to access such Covered Code (which may include display on a splash screen), if any."
- Section 14(b): "'prominent' shall mean display for sufficient duration to give reasonable notice to the user of the identity of the Original Developer". The Original Developer may specify in Exhibit B "that the above attribution requirement only applies to an Executable and Source Code resulting from the Original Code or any Modification, but not a Larger Work."
- Section 14(c): "If Exhibit B does not include any Attribution Information, then there are no requirements for You to display any Attribution Information of the Original Developer."
- So the duty exists only if the Original Developer filled in Exhibit B. **Upstream provides no filled-in Exhibit B** (see Sources). Our reading: on Section 14(c) the licence then requires no attribution display, on launch or anywhere. The shipped and upstream files do not name any "Original Developer" either. The unfilled generic Exhibit B in the SPDX text reads "Attribution Copyright Notice: _______________________".
- We show an attribution regardless, because it is courteous, costs little, and keeps us safe if a lawyer reads the missing Exhibit differently: on the About screen (built with the desktop shell, PLAN Task 37c), not on each launch. The text is in `NOTICE.md`: the copyright line, the name citeproc-js, its repository URL and "used under the Common Public Attribution License 1.0".
- Unclear: whether an Exhibit B published elsewhere than upstream's files (for example on the project website) would bind us. We found none in the places above.

**Modifications and larger works.**

- We do not modify citeproc-js: it is pinned exactly and used as installed. Section 1.9 defines Modifications as "any addition to or deletion from the substance or structure of either the Original Code or any previous Modifications". Section 3.1: "The Modifications which You create or to which You contribute are governed by the terms of this License". Section 3.3: "You must cause all Covered Code to which You contribute to contain a file documenting the changes You made". Any change we ever make to citeproc-js must meet Sections 3.1 to 3.5 for that change; the CSL styles are separate.
- Section 1.7: "'Larger Work' means a work which combines Covered Code or portions thereof with code not governed by the terms of this License." Section 3.7: "You may create a Larger Work by combining Covered Code with other code not governed by the terms of this License and distribute the Larger Work as a single product. In such a case, You must make sure the requirements of this License are fulfilled for the Covered Code." Section 3.6: "You may distribute the Executable version of Covered Code or ownership rights under a license of Your choice, which may contain terms different from this License, provided that You are in compliance with the terms of this License and that the license for the Executable version does not attempt to limit or alter the recipient's rights in the Source Code version from the rights set forth in this License."
- Our reading: the project's own code is not Covered Code, so it can carry a different licence, AGPL-3.0 included, so long as the citeproc-js part stays under its own terms and the rules above are met. The text does not mention AGPL. Whether the FSF or a court would see CPAL-1.0 and AGPL-3.0 code in one product as compatible is not answered by the text. The simplest path is that, on the grant, an AGPL-3.0 release could take citeproc-js under AGPL-3.0 instead.

**Metadata discrepancy.** The package's `package.json` gives `"license": "CPAL-1.0 OR AGPL-1.0"`. Its `LICENSE` says "either version 3 of the AGPL". This is an upstream metadata inconsistency. Our reading: the `LICENSE` text governs, and AGPL-1.0 is a slip in the metadata. We have not asked upstream.

**What we do.**

- The licence text ships as `packages/core/csl/LICENSE-CPAL-1.0.txt` beside the citation bundle, and inside the packaged app together with citeproc-js's `LICENSE`, `NOTICE.md` and the CC BY-SA text.
- The attribution is shown on the About screen. It is shown at launch only if a later reading of Exhibit B or a lawyer says Section 14(a) applies. On the text we found it does not.
- Open for the owner or a lawyer: (1) whether the upstream grant stands in for the Exhibit A notice (Sections 1.6, 1.10, 5); (2) whether bundled citeproc-js is Source Code or an Executable (Sections 1.5, 1.11); (3) whether CPAL-1.0 code and an AGPL-3.0 project can share one product; (4) whether a copy distributed under CPAL-1.0 can be re-taken under AGPL-3.0. Task 56 re-checks all four before first release.
