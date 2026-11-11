#!/usr/bin/env node
// Builds the two self-contained review pages in docs/review/:
//   citations.html     the citation snapshots, style by style (parsed from the snapshot .txt files)
//   code-colours.html  the twelve qualitative-code colours (parsed from tokens.css, codePalette.ts, codeGlyphs.ts)
// Usage: pnpm review-pages     (Node only, no dependencies)
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---------------------------------------------------------------------------------------------
// Shared page chrome (system serif, calm, light/dark chrome, phone friendly)

const CHROME_CSS = `
:root{color-scheme:light dark;--pg-bg:#faf8f3;--pg-ink:#22201c;--pg-muted:#5d584e;--pg-line:#d9d4c7;--pg-card:#ffffff;--pg-soft:#f0ece2;--pg-accent:#1f5e63;--pg-flag-bg:#fdf0dc;--pg-flag-ink:#6b3a05;--pg-flag-line:#e0b87c}
@media (prefers-color-scheme:dark){:root{--pg-bg:#171714;--pg-ink:#ebe8df;--pg-muted:#aaa598;--pg-line:#3a3832;--pg-card:#201f1c;--pg-soft:#2a2925;--pg-accent:#8ccbc6;--pg-flag-bg:#3a2a14;--pg-flag-ink:#f2c994;--pg-flag-line:#6b4a22}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--pg-bg);color:var(--pg-ink);font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.65}
main{max-width:56rem;margin:0 auto;padding:2rem 16px 5rem}
h1{font-size:2rem;line-height:1.2;margin:0 0 .5rem}
h2{font-size:1.5rem;line-height:1.25;margin:3.2rem 0 .75rem;padding-top:1rem;border-top:1px solid var(--pg-line)}
h3{font-size:1.15rem;margin:0 0 .4rem}
p,li{overflow-wrap:anywhere}
a{color:var(--pg-accent)}
.lead{color:var(--pg-muted);margin:0 0 1.5rem}
.box{background:var(--pg-soft);border:1px solid var(--pg-line);border-radius:8px;padding:1rem 1.25rem;margin:1.25rem 0}
.box h2,.box h3{border:0;margin:0 0 .4rem;padding:0}
.box ul,.box ol{margin:.4rem 0 0;padding-left:1.3rem}
.box li{margin:.3rem 0}
code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
nav.toc ul{margin:.4rem 0 0;padding-left:1.3rem}
small,.muted{color:var(--pg-muted)}
`;

const page = (title, body, css) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CHROME_CSS}${css}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

const outDir = join(ROOT, "docs", "review");
mkdirSync(outDir, { recursive: true });

const head = git("rev-parse --short HEAD");
const snapCommit = git("log -1 --format=%h -- packages/core/src/citation/__snapshots__") || head;
const snapDate = git("log -1 --format=%cs -- packages/core/src/citation/__snapshots__");

// ---------------------------------------------------------------------------------------------
// PAGE 1: citations

const STYLES = [
  { file: "apa", prefix: "APA", name: "APA 7", check: [
    "Author order, surnames first, and the initials: are they in the form APA uses (for example “Quispe, M. J., & Ortega, D. K.”)?",
    "Where the year sits: in parentheses right after the authors.",
    "Title capitalisation: only the first word and proper nouns capitalised (sentence case). Italics on the book, journal and video titles, and on the journal volume.",
    "Volume, issue and page form: 41(2), 115–134. Pages for the book chapter after the container title.",
    "DOI as a full https://doi.org/ link; URL for the video and the reel.",
    "Two authors joined by “&”; two editors in “In R. Mendel & O. Haddad (Eds.), …”. Nothing here reaches “et al.” (the test has at most two authors), so that rule is not tested by this page.",
    "The Spanish title with its English translation in square brackets (APA-5): is the bracketed part right, and should it be italic?",
    "The “[Video]” and “[Field photograph]” descriptions, and the platform name after them.",
    "The in-text form with a locator: “p. 12” for pages, a time range for the videos.",
  ] },
  { file: "chicago-author-date", prefix: "CHI", name: "Chicago author-date", check: [
    "Author order: first author surname-first, second author given-name first (“Quispe, María José, and Daniel K. Ortega”). Full given names rather than initials.",
    "The year directly after the author, followed by a full stop.",
    "Title capitalisation: headline style (major words capitalised). Quotation marks for article and chapter titles, italics for books and journals.",
    "Volume, issue and pages: “41 (2): 115–34”, with the page range shortened.",
    "DOI as a link, with a final full stop.",
    "Chapter: “In …, edited by …”, and whether the page range of the chapter should appear.",
    "In-text: no comma between author and year; a page locator after a comma; “at” before the time range for videos.",
    "The Spanish title with its English translation in square brackets, and the platform and date after it for the reel (CHI-5).",
    "Whether the city of publication is left out of the book entry.",
  ] },
  { file: "modern-language-association", prefix: "MLA", name: "MLA 9", check: [
    "Author order and names: full given names, second author given-name first.",
    "The year is not in the in-text citation; it sits near the end of the entry, after the publisher or container.",
    "Title capitalisation: headline style. Quotation marks for the article and chapter, italics for the journal and book.",
    "Volume, issue and pages: “vol. 41, no. 2, June 2021, pp. 115–34”.",
    "DOI or URL form at the end of the entry.",
    "In-text citations: author only, with the page number and no comma (“(Quispe and Ortega 12)”); a time range for videos.",
    "Dates written as “2 Mar. 2024”.",
    "The video entries: the position of the title (italic or in quotation marks), the platform, and the word “Video.” (MLA-4, MLA-5).",
    "The Spanish title with its English translation in square brackets.",
  ] },
  { file: "american-sociological-association", prefix: "ASA", name: "ASA", check: [
    "Author order: first author surname-first, second author given-name first; full given names.",
    "The year directly after the author, followed by a full stop.",
    "Title capitalisation and italics, for the book, the chapter’s container and the journal. Are they consistent between entries (ASA-3)?",
    "Volume, issue and pages written as “41(2):115–34”, with no spaces.",
    "DOI form: “doi:10.5555/…”.",
    "Chapter: “Pp. 45–67 in …, edited by R. Mendel and O. Haddad”, with place and publisher.",
    "In-text: year, then a colon and the page (“2021:12”). With a time range the result has two colons (“2023:0:38–0:46”): readable?",
    "Whether the video and reel entries should name the platform, give a URL or give an access date (ASA-4, ASA-5).",
    "The Spanish title with its English translation in square brackets.",
  ] },
  { file: "harvard-cite-them-right", prefix: "HAR", name: "Harvard (Cite Them Right)", check: [
    "Author order and initials: “Quispe, M.J. and Ortega, D.K.”, with initials unspaced.",
    "The year in parentheses directly after the author, with no full stop before it.",
    "Title capitalisation: sentence case. Italics on books and journals; quotation marks for articles and chapters, with the comma inside the closing mark.",
    "Volume, issue and pages: “41(2), pp. 115–134”.",
    "DOI or URL written as “Available at: …”, with “(Accessed: …)” for the web items.",
    "The format of the access date (HAR-4, HAR-5).",
    "Chapter: “in R. Mendel and O. Haddad (eds.) …”, then place, publisher and pages.",
    "In-text: a comma between author and year, then “p. 12”.",
    "The Spanish title with its English translation in square brackets.",
  ] },
];

// What went in: transcribed from the FIXTURES in packages/core/src/citation/citation.test.ts
// (and the options OPTS: citation language en, translated titles appended, script original).
// The reel's creator is a research participant: the test replaces the name with the code P-014,
// and this page does not show the real name or handle.
const SOURCES = [
  { key: "journalArticle", label: "Journal article", type: "article-journal", fields: [
    ["Title (en)", "Fermentation and food sovereignty in the Andes"],
    ["Author 1", "given “María José”, family “Quispe”"],
    ["Author 2", "given “Daniel K.”, family “Ortega”"],
    ["Journal", "Journal of Ethnobiology"],
    ["Volume / issue / pages", "41 / 2 / 115–134"],
    ["Issued", "2021-06"],
    ["DOI", "10.5555/joe.2021.0042"],
    ["ISSN", "0278-0771"],
    ["Locator in the “with locator” line", "page 12"],
  ] },
  { key: "book", label: "Book", type: "book", fields: [
    ["Title (en)", "The art of fermentation"],
    ["Author", "given “Sandor Ellix”, family “Katz”"],
    ["Publisher", "Chelsea Green Publishing"],
    ["Place", "White River Junction, VT"],
    ["Issued", "2012"],
    ["ISBN", "9781603582865"],
    ["Locator", "page 12"],
  ] },
  { key: "chapter", label: "Book chapter", type: "chapter", fields: [
    ["Title (en)", "Kitchen ferments as household knowledge"],
    ["Author", "given “Aiko”, family “Tanaka”"],
    ["Editor 1", "given “Ruth”, family “Mendel”"],
    ["Editor 2", "given “Omar”, family “Haddad”"],
    ["Book (container)", "Ferment and society"],
    ["Publisher / place", "Routledge / London"],
    ["Pages", "45–67"],
    ["Issued", "2019"],
    ["Locator", "page 12"],
  ] },
  { key: "youtubeVideo", label: "YouTube video", type: "video", fields: [
    ["Title (en)", "How to start a sourdough culture"],
    ["Channel (creator)", "Fermentology Lab (handle @fermentologylab)"],
    ["Issued", "2023-05-01"],
    ["Accessed", "2026-11-01"],
    ["URL", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["Platform / post id", "youtube / dQw4w9WgXcQ"],
    ["Locator", "time range 0:38–0:46"],
  ] },
  { key: "instagramReel", label: "Instagram reel", type: "social-post", fields: [
    ["Title (es, original)", "Receta de la abuela, sin filtros"],
    ["Title (en, translated)", "Grandma's recipe, no filters"],
    ["Creator (uploader)", "a research participant: the app shows the code P-014 instead of the name and handle, so they are not shown here"],
    ["Issued", "2024-03-02"],
    ["Accessed", "2026-10-30"],
    ["URL", "https://www.instagram.com/reel/C4abc123XyZ/"],
    ["Platform / post id", "instagram / C4abc123XyZ"],
    ["Locator", "time range 0:38–0:46"],
  ] },
  { key: "fieldPhoto", label: "Field photograph", type: "field-photo", fields: [
    ["Title (en)", "Clay fermentation jars at a market stall"],
    ["Photographer", "given “Ana”, family “Castillo”"],
    ["Issued", "2025-08-14"],
    ["Locator", "none (the snapshot has no “with locator” line for this source)"],
  ] },
];

// Concrete reasons to look twice. Each is phrased as a question, not as a ruling.
const ISSUES = {
  "APA-5": "The bracketed English translation sits inside the italic title in the HTML (the italics end after the closing bracket); is the translation meant to be italic?",
  "CHI-3": "The chapter entry has no page range (45–67) although the input has one and the other four styles print it; should Chicago show it?",
  "MLA-4": "The YouTube title is in italics while the reel title (MLA-5) is in quotation marks, and a bare “Video.” trails the URL; is that the intended MLA form?",
  "ASA-3": "The book title in ASA-2 is in title case, but the chapter’s container title here is in sentence case; does ASA treat them differently?",
  "ASA-4": "The entry has no URL, while the reel entry (ASA-5) has a URL and no platform name; should both carry the same elements?",
  "ASA-5": "The reel entry prints the URL but not “Instagram” and not the word “Video”, unlike the YouTube entry; is that complete?",
  "HAR-4": "The access date reads “November 1, 2026” (month first); is that the form Cite Them Right uses?",
  "HAR-5": "The access date reads “October 30, 2026” (month first); same question as HAR-4.",
};

function parseSnapshot(file) {
  const text = read(`packages/core/src/citation/__snapshots__/${file}.txt`).replace(/\r\n/g, "\n");
  const entries = {};
  for (const block of text.split(/\n(?=## )/).slice(1)) {
    const nl = block.indexOf("\n");
    const name = block.slice(3, nl).trim();
    if (name.startsWith("all six")) continue;
    const e = { name };
    const bi = block.indexOf("\nhtml:");
    const plain = block.slice(nl + 1, bi < 0 ? undefined : bi);
    for (const line of plain.split("\n")) {
      let m;
      if ((m = /^citation:\s+(.*)$/.exec(line))) e.citation = m[1];
      else if ((m = /^with locator:\s+(.*)$/.exec(line))) e.locator = m[1];
      else if ((m = /^bibliography:\s+(.*)$/.exec(line))) e.bibliography = m[1];
    }
    if (bi >= 0) {
      const html = block.slice(bi + "\nhtml:".length);
      const m = /<div class="csl-entry">([\s\S]*?)<\/div>/.exec(html);
      if (m) e.html = m[1];
    }
    entries[name] = e;
  }
  return entries;
}

// The snapshot html is the citation engine's own markup (&#38; entities, <i>, <b>, <sup>, <sub>).
// Allow exactly those tags and the entity form; escape anything else.
function safeHtml(s) {
  return s
    .split(/(<\/?(?:i|b|sup|sub)>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("");
}

function buildCitations() {
  const parsed = STYLES.map((st) => ({ ...st, entries: parseSnapshot(st.file) }));
  const nEntries = {};
  let hasItalics = 0;
  let totalEntries = 0;

  const styleSections = parsed
    .map((st) => {
      const cards = SOURCES.map((src, i) => {
        const e = st.entries[src.key];
        if (!e) throw new Error(`snapshot ${st.file} lacks ${src.key}`);
        const id = `${st.prefix}-${i + 1}`;
        totalEntries++;
        if (e.html && /<i>/.test(e.html)) hasItalics++;
        const issue = ISSUES[id];
        return `<article class="entry${issue ? " flagged" : ""}" id="${id}">
<header><span class="eid">${id}</span><h3>${esc(src.label)}</h3></header>
<p class="in"><span class="lab">Went in:</span> ${src.fields.map(([k, v]) => `<span class="fld"><b>${esc(k)}</b> <span dir="auto">${esc(v)}</span></span>`).join("")}</p>
<div class="out">
<p class="lab">Bibliography entry (formatting as in the snapshot)</p>
<p class="bib" dir="auto">${e.html ? safeHtml(e.html) : esc(e.bibliography)}</p>
<p class="lab">In-text citation (plain text)</p>
<p class="cite" dir="auto">${esc(e.citation)}</p>
${e.locator ? `<p class="lab">In-text citation with locator (plain text)</p><p class="cite" dir="auto">${esc(e.locator)}</p>` : ""}
</div>
${issue ? `<p class="issue"><b>Possible issue &mdash; please check.</b> ${esc(issue)}</p>` : ""}
</article>`;
      }).join("\n");
      nEntries[st.prefix] = SOURCES.length;
      return `<section id="${st.prefix.toLowerCase()}">
<h2>${esc(st.name)} <small class="mono">${st.prefix}-1 to ${st.prefix}-${SOURCES.length}</small></h2>
<div class="box"><h3>What to check</h3><ul>${st.check.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>
${cards}
</section>`;
    })
    .join("\n");

  const sourcesSection = `<section id="sources"><h2>The six test sources</h2>
<p class="muted">These are the inputs used by every style. Entry number <i>n</i> in each style comes from source <i>n</i>, so APA-3, CHI-3, MLA-3, ASA-3 and HAR-3 are the same source.</p>
${SOURCES.map(
  (s, i) => `<div class="src"><h3>${i + 1}. ${esc(s.label)} <small class="mono">${esc(s.type)}</small></h3><dl>${s.fields
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(v)}</dd>`)
    .join("")}</dl></div>`,
).join("\n")}
</section>`;

  const compare = `<section id="compare"><h2>Side by side, source by source</h2>
<p class="muted">The same bibliography entries as above, grouped by source so the five styles sit together. Plain text, as in the snapshots; italics are shown in the style sections above.</p>
${SOURCES.map(
  (s, i) => `<div class="cmp"><h3>${i + 1}. ${esc(s.label)}</h3><table><thead><tr><th>Id</th><th>Bibliography</th><th>In text</th></tr></thead><tbody>${parsed
    .map((st) => {
      const e = st.entries[s.key];
      const id = `${st.prefix}-${i + 1}`;
      return `<tr><td class="mono"><a href="#${id}">${id}</a></td><td dir="auto">${esc(e.bibliography)}</td><td dir="auto">${esc(e.citation)}</td></tr>`;
    })
    .join("")}</tbody></table></div>`,
).join("\n")}
</section>`;

  const flagged = Object.keys(ISSUES);
  const body = `<h1>Citation outputs: please review</h1>
<p class="lead">The citations the app produces for six test sources, in five styles.</p>

<div class="box"><h2>What this page is</h2>
<p>The app formats a source as a bibliography entry and as an in-text citation. Its tests keep a saved copy of that output for APA, Chicago author-date, MLA, ASA and Harvard (Cite Them Right). Each saved copy is marked <b>PENDING HUMAN REVIEW</b>: nobody has yet checked it against the style guides. This page lays those saved copies out so you can check them by eye, next to the facts that went in. Nothing here was edited by hand; the entries are the saved files, word for word.</p>
<p><b>How to respond.</b> Reply in the chat with an entry id and what is wrong, for example <i>&ldquo;APA-3: the year should be in parentheses&rdquo;</i>. If an entry is fine, you do not need to say anything; if you checked a whole style and it is fine, say so (&ldquo;ASA: all correct&rdquo;).</p>
<p><b>Generated from</b> commit <code>${esc(head)}</code>. The saved snapshot files were last changed in commit <code>${esc(snapCommit)}</code> (${esc(snapDate)}). To regenerate after the snapshots change: <code>pnpm review-pages</code>.</p>
<p><b>Formatting.</b> The snapshots keep both a plain-text line and the engine&rsquo;s HTML for every bibliography entry, so italics are shown exactly as the app produces them (${hasItalics} of ${totalEntries} entries contain italics; none of the others carry any formatting). The in-text citations are plain text only: the snapshots hold no formatting for them, and none is expected.</p>
<p><b>Possible issues.</b> ${flagged.length} entries are marked <span class="tag">Possible issue &mdash; please check</span>. Each has one concrete reason, phrased as a question. They are guesses from reading the output, not rulings; the style guides decide.</p>
<p><b>Privacy.</b> The Instagram reel&rsquo;s creator is a research participant. The app shows the participant code (P-014) instead of the name, and so does this page.</p>
</div>

<nav class="toc box"><h2>Contents</h2><ul>
<li><a href="#sources">The six test sources</a></li>
${parsed.map((st) => `<li><a href="#${st.prefix.toLowerCase()}">${esc(st.name)}</a> (${st.prefix}-1 to ${st.prefix}-${SOURCES.length})</li>`).join("\n")}
<li><a href="#compare">Side by side, source by source</a></li>
</ul>
<p class="muted">Possible issues: ${flagged.map((f) => `<a href="#${f}">${f}</a>`).join(", ")}.</p></nav>

${sourcesSection}
${styleSections}
${compare}`;

  const css = `
.tag{background:var(--pg-flag-bg);color:var(--pg-flag-ink);border:1px solid var(--pg-flag-line);border-radius:4px;padding:0 .4em;font-size:.85em}
.src{margin:1rem 0}
.src dl,.entry .in{margin:0}
.src dl{display:grid;grid-template-columns:minmax(8rem,14rem) 1fr;gap:.15rem 1rem;font-size:.92rem}
.src dt{color:var(--pg-muted)}
.src dd{margin:0;overflow-wrap:anywhere}
.entry{background:var(--pg-card);border:1px solid var(--pg-line);border-radius:8px;padding:1rem 1.25rem;margin:1.25rem 0;scroll-margin-top:1rem}
.entry.flagged{border-left:5px solid var(--pg-flag-line)}
.entry header{display:flex;gap:.75rem;align-items:baseline;flex-wrap:wrap}
.entry header h3{margin:0}
.eid{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:bold;background:var(--pg-soft);border:1px solid var(--pg-line);border-radius:4px;padding:0 .5em;font-size:.95rem}
.entry .in{font-size:.85rem;color:var(--pg-muted);margin:.5rem 0 .75rem}
.fld{display:inline-block;margin:0 1rem .1rem 0}
.fld b{font-weight:normal;font-style:italic}
.lab{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--pg-muted);margin:.7rem 0 .1rem}
.bib{margin:0;padding-left:2em;text-indent:-2em;font-size:1.05rem}
.cite{margin:0;font-size:1.05rem}
.issue{margin:.9rem 0 0;padding:.6rem .8rem;background:var(--pg-flag-bg);color:var(--pg-flag-ink);border:1px solid var(--pg-flag-line);border-radius:6px;font-size:.95rem}
.cmp{overflow-x:auto;margin:1rem 0}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{border:1px solid var(--pg-line);padding:.4rem .6rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:var(--pg-soft)}
td:first-child{white-space:nowrap}
@media (max-width:600px){body{font-size:17px}.src dl{grid-template-columns:1fr}.src dt{margin-top:.4rem}.entry{padding:.8rem 1rem}table{font-size:.8rem}}
`;
  writeFileSync(join(outDir, "citations.html"), page("Citation outputs review", body, css));
  return { nEntries, flagged, hasItalics, totalEntries };
}

// ---------------------------------------------------------------------------------------------
// PAGE 2: code colours

function cssBlock(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) throw new Error("tokens.css block not found: " + selectorRe);
  const vars = {};
  for (const [, k, v] of m[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[k] = v.trim();
  return vars;
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => {
  const [r, g, b] = hexRgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function buildColours() {
  const tokens = read("packages/ui/src/theme/tokens.css");
  const light = cssBlock(tokens, /:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/);
  const dark = cssBlock(tokens, /\n\[data-theme="dark"\]\s*\{([^}]*)\}/);
  const glyphSrc = read("packages/ui/src/components/codeGlyphs.ts");
  const glyphs = [...glyphSrc.matchAll(/\{ name: "([^"]+)", d: "([^"]+)" \}/g)].map((m) => ({ name: m[1], d: m[2] }));
  const palSrc = read("packages/ui/src/theme/codePalette.ts");
  const names = [...palSrc.matchAll(/^\s*\{ name: "(\w+)", light:/gm)].map((m) => m[1]);
  const swatchSrc = read("packages/ui/src/components/CodeSwatch.css");
  const strokeW = /stroke-width:\s*([\d.]+)/.exec(swatchSrc)?.[1] ?? "0.6";
  const minDe = /CODE_MIN_DELTA_E\s*=\s*(\d+)/.exec(palSrc)[1];
  const minDeCvd = /CODE_MIN_DELTA_E_CVD\s*=\s*(\d+)/.exec(palSrc)[1];
  const minContrast = /CODE_MIN_CONTRAST\s*=\s*(\d+)/.exec(palSrc)[1];
  const lightChipMin = /LIGHT_CHIP_MIN\s*=\s*([\d.]+)/.exec(palSrc)[1];
  if (names.length !== 12 || glyphs.length !== 12) throw new Error(`expected 12 names/glyphs, got ${names.length}/${glyphs.length}`);
  for (const t of [light, dark]) for (let i = 1; i <= 12; i++) if (!t[`--code-${i}`]) throw new Error(`missing --code-${i}`);

  const code = (t, i) => t[`--code-${i + 1}`];
  const glyphSvg = (i, t, size) =>
    `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false" class="g"><path d="${esc(glyphs[i].d)}" fill-rule="evenodd" fill="${esc(code(t, i))}" stroke="${esc(t["--line-control"])}" stroke-width="${strokeW}"/></svg>`;
  const ids = Array.from({ length: 12 }, (_, i) => `C${i + 1}`);

  const panelVars = (t) => Object.entries(t).map(([k, v]) => `${k}:${v}`).join(";");

  const bigGrid = (cls, t) =>
    `<div class="panel ${cls}" style="${esc(panelVars(t))}"><div class="surf"><ul class="grid">${names
      .map((n, i) => `<li><span class="cid">${ids[i]}</span><span class="sw">${glyphSvg(i, t, 24)}<span class="nm">${esc(n)}</span></span></li>`)
      .join("")}</ul></div></div>`;

  const chips = (cls, t) =>
    `<div class="panel ${cls}" style="${esc(panelVars(t))}"><div class="surf"><ul class="chips">${names
      .map(
        (n, i) =>
          `<li><span class="cid">${ids[i]}</span><span class="chip"><span class="sw">${glyphSvg(i, t, 16)}<span class="nm">${esc(n)}</span></span></span><span class="chip coltext" style="color:${esc(code(t, i))}"><span class="nm">${esc(n)}</span></span></li>`,
      )
      .join("")}</ul></div></div>`;

  const smallRow = (cls, t, size, gap) =>
    `<div class="panel ${cls}" style="${esc(panelVars(t))}"><div class="surf"><div class="row" style="gap:${gap}px">${names.map((n, i) => glyphSvg(i, t, size)).join("")}</div></div></div>`;

  // contrast of each code colour on the backgrounds
  const crow = (t, i) =>
    ["--bg", "--surface", "--chip"].map((k) => {
      const c = contrast(code(t, i), t[k]);
      return { k, c };
    });
  const contrastTable = (label, t, min) =>
    `<h3>${label}</h3><div class="cmp"><table><thead><tr><th>Id</th><th>Name</th><th>Colour</th><th>on bg</th><th>on surface</th><th>on chip</th></tr></thead><tbody>${names
      .map((n, i) => {
        const cells = crow(t, i)
          .map(({ c }) => `<td class="${c < min ? "low" : ""}">${c.toFixed(2)}${c < min ? " (below 3)" : ""}</td>`)
          .join("");
        return `<tr><td class="mono">${ids[i]}</td><td>${esc(n)}</td><td class="mono">${esc(code(t, i))}</td>${cells}</tr>`;
      })
      .join("")}</tbody></table></div>`;

  const belowLight = [];
  for (let i = 0; i < 12; i++) for (const { k, c } of crow(light, i)) if (c < Number(minContrast)) belowLight.push(`${ids[i]} on ${k.slice(2)} (${c.toFixed(2)})`);
  const belowDark = [];
  for (let i = 0; i < 12; i++) for (const { k, c } of crow(dark, i)) if (c < Number(minContrast)) belowDark.push(`${ids[i]} on ${k.slice(2)} (${c.toFixed(2)})`);

  const body = `<h1>Code colours: please look</h1>
<p class="lead">The twelve colours the app gives to qualitative codes, drawn the way the app draws them.</p>

<div class="box"><h2>What this page is</h2>
<p>In the app, every code has a colour, a shape and a name; the shape and name are there so that a code is never told apart by colour alone. This page draws all twelve on the light theme&rsquo;s backgrounds and on the dark theme&rsquo;s backgrounds, side by side, then as text chips, then in one small row like a crowded transcript margin. The colours, shapes and names are read straight from the app&rsquo;s files; none is approximated.</p>
<p><b>How to respond.</b> Reply in the chat with swatch ids, for example <i>&ldquo;C4 and C5 look the same to me in the dark theme&rdquo;</i>. Say which theme and which section.</p>
<p><b>The two demo panels are fixed.</b> The light panels always use the app&rsquo;s light theme and the dark panels its dark theme, whatever your device is set to. Only the page around them follows your device.</p>
<p><b>Source files.</b> <code>packages/ui/src/theme/tokens.css</code> (colours and backgrounds), <code>packages/ui/src/theme/codePalette.ts</code> (names and rules), <code>packages/ui/src/components/codeGlyphs.ts</code> and <code>CodeSwatch.tsx</code> (shapes and drawing). Generated from commit <code>${esc(head)}</code>; regenerate with <code>pnpm review-pages</code>.</p></div>

<div class="box"><h2>What to check</h2><ul>
<li>At small size (the last section), in both themes: can you tell every pair apart? Name any two that look the same to you.</li>
<li>Is any colour hard to read against its background, in either theme?</li>
<li>Do the shapes help you tell neighbours apart, especially two similar colours (for example C1 and C2, or C5 and C6)?</li>
<li>Does each colour keep its identity between light and dark (the red one is still &ldquo;the red one&rdquo;)?</li>
<li>If you have colour-blindness or know someone who has, which pairs are hard?</li></ul></div>

<div class="box"><h2>Known compromises</h2>
<p>Stated in <code>codePalette.ts</code> and <code>tokens.css</code>:</p><ul>
<li>The rule for every colour: at least ${esc(minContrast)}:1 contrast against the theme&rsquo;s page background (<code>--bg</code>) and card background (<code>--surface</code>); in the dark theme also against the chip background (<code>--chip</code>).</li>
<li><b>Light theme, chip background: relaxed.</b> The 3:1 rule is not applied to <code>--chip</code> in the light theme. The file says no light palette reaching 3:1 there also kept the colours far enough apart under colour-blindness simulation. Light colours are asked to reach only ${esc(lightChipMin)}:1 on the chip, and the shape is outlined to stay visible.</li>
<li>Any two colours must differ by at least ${esc(minDe)} (CIEDE2000) with normal vision and ${esc(minDeCvd)} under simulated red-green and blue-yellow colour blindness.</li>
<li>The palette was fitted by a program, not chosen by eye, within colour-family limits per theme (the file&rsquo;s own words).</li>
<li>From the 13th code on, colours and shapes repeat and a small number badge tells them apart. Only the first twelve are shown here.</li></ul>
<p>Measured here from the actual values (WCAG contrast ratio): ${belowLight.length ? `light theme below 3:1: ${esc(belowLight.join("; "))}` : "light theme: nothing below 3:1"}; ${belowDark.length ? `dark theme below 3:1: ${esc(belowDark.join("; "))}` : "dark theme: nothing below 3:1"}. Full table at the bottom.</p></div>

<nav class="toc box"><h2>Contents</h2><ul>
<li><a href="#full">1. The twelve codes, light and dark</a></li>
<li><a href="#chips">2. As chips in a list</a></li>
<li><a href="#small">3. All twelve in one small row</a></li>
<li><a href="#ratios">4. Contrast numbers</a></li></ul></nav>

<section id="full"><h2>1. The twelve codes, light and dark</h2>
<p class="muted">Colour, shape, name, as <code>CodeSwatch</code> draws them, on the card background (<code>--surface</code>) over the page background (<code>--bg</code>).</p>
<div class="pair"><div><h3>Light theme</h3>${bigGrid("light", light)}</div><div><h3>Dark theme</h3>${bigGrid("dark", dark)}</div></div></section>

<section id="chips"><h2>2. As chips in a list</h2>
<p class="muted">Each code on the chip background (<code>--chip</code>) used for tags in lists. The files define no separate tinted background per code, so the plain chip background is used. Left: the swatch (colour, shape, name in the theme&rsquo;s ordinary text colour). Right: the name written in the code colour itself, which is harder to read and is shown only so you can judge it; it is not something the app is known to do.</p>
<div class="pair"><div><h3>Light theme</h3>${chips("light", light)}</div><div><h3>Dark theme</h3>${chips("dark", dark)}</div></div></section>

<section id="small"><h2>3. All twelve in one small row</h2>
<p class="muted">Shapes only, left to right C1 to C12, as in a crowded margin. First at 12 px (the app&rsquo;s smallest swatch size, 1em at 12px text), then at 9 px with tighter spacing.</p>
<div class="pair"><div><h3>Light theme, 12 px</h3>${smallRow("light", light, 12, 4)}<h3>Light theme, 9 px</h3>${smallRow("light", light, 9, 2)}</div>
<div><h3>Dark theme, 12 px</h3>${smallRow("dark", dark, 12, 4)}<h3>Dark theme, 9 px</h3>${smallRow("dark", dark, 9, 2)}</div></div>
<p class="muted">Order: ${names.map((n, i) => `${ids[i]} ${esc(n)} (${esc(glyphs[i].name)})`).join(", ")}.</p></section>

<section id="ratios"><h2>4. Contrast numbers</h2>
<p class="muted">WCAG contrast ratio of each code colour against the three backgrounds, computed here from the hex values. The rule is ${esc(minContrast)} or more; the light theme&rsquo;s chip column is the documented exception.</p>
${contrastTable("Light theme", light, Number(minContrast))}${contrastTable("Dark theme", dark, Number(minContrast))}
<p class="muted">Backgrounds: light bg ${esc(light["--bg"])}, surface ${esc(light["--surface"])}, chip ${esc(light["--chip"])}; dark bg ${esc(dark["--bg"])}, surface ${esc(dark["--surface"])}, chip ${esc(dark["--chip"])}.</p></section>`;

  const css = `
.pair{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem}
@media (max-width:760px){.pair{grid-template-columns:1fr}}
.panel{border-radius:8px;border:1px solid #8884;padding:14px;background:var(--bg);color:var(--ink);font-family:Georgia,'Times New Roman',serif;line-height:1.4}
.panel .surf{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px}
.panel ul{list-style:none;margin:0;padding:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:10px 8px}
.grid li,.chips li{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.cid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.75rem;color:var(--muted);min-width:2.2rem}
.sw{display:inline-flex;align-items:center;gap:.35em}
.nm{color:var(--ink);font-size:1rem}
.g{flex:none;display:block}
.chips{display:grid;gap:8px}
.chip{display:inline-flex;align-items:center;background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:.95rem}
.chip.coltext .nm{color:inherit}
.row{display:flex;align-items:center;flex-wrap:nowrap;overflow-x:auto;padding:4px 0}
h3{margin-top:1rem}
.pair h3{margin:0 0 .5rem}
.pair>div>h3:not(:first-child){margin-top:1rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{border:1px solid var(--pg-line);padding:.35rem .6rem;text-align:left}
th{background:var(--pg-soft)}
td.low{background:var(--pg-flag-bg);color:var(--pg-flag-ink)}
.cmp{overflow-x:auto}
@media (max-width:600px){body{font-size:17px}.panel{padding:8px}.panel .surf{padding:8px}table{font-size:.78rem}th,td{padding:.25rem .4rem}}
`;
  writeFileSync(join(outDir, "code-colours.html"), page("Code colours review", body, css));
  return { belowLight, belowDark };
}

const c = buildCitations();
const k = buildColours();
console.log(`citations: ${c.totalEntries} entries (${JSON.stringify(c.nEntries)}), ${c.hasItalics} with italics, flagged ${c.flagged.join(",")}`);
console.log(`colours: below 3:1 light=[${k.belowLight.join("; ")}] dark=[${k.belowDark.join("; ")}]`);
