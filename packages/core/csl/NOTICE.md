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

**Licence decision:** on 2026-11-11 the project owner chose to use citeproc-js under the CPAL-1.0 (R124).
The full CPAL-1.0 text is in `LICENSE-CPAL-1.0.txt` next to this file, saved unchanged from
<https://raw.githubusercontent.com/spdx/license-list-data/main/text/CPAL-1.0.txt>
(sha256 `54cef60295bdffd5d41904338632538db1f3cdcd4c5f7ea5bb021d04eef14d92`).

citeproc-js, its `LICENSE` and its upstream repository (<https://github.com/Juris-M/citeproc-js>) carry no
filled-in Exhibit B, so the licence (Section 14(c)) requires no attribution display. We show this notice
regardless, on the About screen:

> Copyright (c) 2009-2019 Frank Bennett. citeproc-js, <https://github.com/juris-m/citeproc-js>, used under the Common Public Attribution License 1.0.

The source of citeproc-js is available under the CPAL at the repository above (version 2.4.63 of the npm
package `citeproc`). This application makes no Modifications to it. What the licence requires, with quotes
and section numbers, is in `docs/adr/0012-citations.md`.

The project's own licence is not yet chosen; that is an owner decision before any publication.
