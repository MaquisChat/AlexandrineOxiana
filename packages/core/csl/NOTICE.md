# CSL styles and locales: attribution

The citation engine (`@ao/core`, `src/citation/`) uses citation styles and locale files from the
**Citation Style Language** project, <https://citationstyles.org/>:

| Bundled as | Source | Pinned commit | License |
| --- | --- | --- | --- |
| `styles.zip` (`styles/`, `dependent/`, `index.json`, `renamed-styles.json`) | <https://github.com/citation-style-language/styles> | `af0aea3fffd44fe798cce9285598d0d5cf62ef23` (2026-11-06) | CC BY-SA 3.0 Unported |
| `locales/` | <https://github.com/citation-style-language/locales> | `8bef426f89f38c0789223c50e53ec2197bc50bb3` (2026-10-20) | CC BY-SA 3.0 Unported |

All the styles and locale files are released under the Creative Commons Attribution-ShareAlike 3.0
Unported license (<https://creativecommons.org/licenses/by-sa/3.0/>); the full legal text is in
`LICENSE-CC-BY-SA-3.0.txt` next to this file and inside `styles.zip`. They are redistributed
unmodified: the listings of authors, contributors and translators in each file's metadata are kept
as is. Only `index.json` (each style's id, title, file and independent parent, read from the styles)
is added by `scripts/fetch-csl.mjs`.

Styles that researchers import themselves (`<Library>/styles/`) keep whatever license their own
metadata states.

The citation processor is citeproc-js (Frank Bennett), npm `citeproc` 2.4.63, licensed under the
Common Public Attribution License 1.0 (or later) or the GNU Affero General Public License 3.0 (or later), at the user's option (dual-licensed;
see its `LICENSE`).

**Open decision before distribution:** citeproc-js may be used under either the CPAL-1.0 or the
AGPL-3.0, and which of the two this application takes (with its attribution or source-offer
duties) is a decision for the project owner that has not been made yet (R87). It must be made
before the application is distributed.
