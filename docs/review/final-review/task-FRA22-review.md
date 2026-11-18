# Review — Task FR-A22 (R394: a file's embedded title is evidence only when it looks like a title)

Reviewer: fresh adversarial reviewer. Worktree `.claude/worktrees/fr-a22`, branch `fr-a22-junk-titles`, base 7537f63, head f8b6ce5. Worktree left clean (`git status --short` empty; all `*.probeFRA22.test.ts` deleted; no `git stash` used).

## Verdict: NOT APPROVED

The owner's defect is closed: the production code is dropped at extraction, and the Zotero item is created with no title conflict. That holds through `extractPdf`, `resolveItem` and the bulk Zotero engine. But the fix opens two new holes. First, the agreement rule (R394 c) now accepts titles of clearly different works without a word. Second, the shared filter takes away signs that the find-full-text file check relies on to refuse a file that is not the article. Both are wrong behaviour a researcher would meet: Important.

Counts: Critical 0 · Important 2 · Minor 8.

## What I ran (all at `nice -n 10`, single files)
- **Title-table probe:** about 300 inputs through `looksLikeTitle` and `isStockAuthor`: 150 real titles, 150 junk texts and 60 author strings.
- **Cost probe:** 12 hostile 2 MB titles and 3 hostile author names, timed.
- **`resolveItem` probe:** 16 pairs of a reference title and an embedded title, with a Zotero record and `lookup: null`. Run on head, then on base `resolve.ts` (put back with `git checkout HEAD --` afterwards). Three cases with no reference record.
- **`checkFileAgainstRecord` probe:** seven embedded titles, run on head and on base `pdf.ts`.
- **Guards taken out, one at a time, then put back:**
  - the 1,000-character cap;
  - `partOfTitle`;
  - the EPUB and MOBI wiring.
- **Test files run:** `title-like.test.ts`, `resolve-titles.test.ts`, and `extract.test.ts` with `title-like.test.ts`. All passed on head.

## Spec table
| Item | Status |
|---|---|
| 1. One rule in one place, used by every extractor that reads an embedded title | Built (`extract/title-like.ts`). Wired into PDF (XMP, then Info), DOCX, EPUB, MOBI (EXTH, then the PalmDB name) and HTML (meta, then `<title>`). There is no ODT extractor, and `exif.ts` reads no title. Correct. |
| 1. Identifier, code, file-name, stock-word and mostly-digits rules; one-word titles kept; digit-only titles dropped (and said so) | Built as briefed. See M1 and M2 for what slips through either way. |
| 2. Stock authors, exact words without regard to case | Built. See M5. |
| 3. Agreement before conflict; a title of another work stays a conflict | **Different, and too loose (I1).** |
| 4. Nothing else changes; no-reference path; both tests | Holds in `resolve.ts`. **Broken elsewhere: find-full-text file check (I2).** |
| 5. Pending entries untouched; what a later import does | Not touched. The report's account (an item imported before is "unchanged" and passed by: `bulk/run.ts:967`) matches the code I read. |
| Tests first, each guard held by a test | Mostly. The EPUB and MOBI wiring is held by no test (M6). |

## Findings

### I1 (Important): the agreement rule silently accepts titles of other works (R394 c not met)
`packages/library/src/import/resolve.ts:90`, `:97-106` and `:361-364`.

The embedded title "agrees", and is then not recorded, in two cases:
- when core's word-set similarity is ≥ 0.6 (`CROSS_SOURCE_AGREE`);
- when `partOfTitle` is true. Its `long.startsWith(short)` is not bounded at a word, and it accepts any three-word fragment, stop words included.

R394 c says a conflict is "a title-like embedded title that is clearly another work's". These pairs are clearly other works. The probe used a Zotero journal-article record and `lookup: null`; "status" is the status of `/title`.

| Reference (Zotero) | Embedded | Head | Base |
|---|---|---|---|
| A History of Modern Iran | A History of Modern India | single-source, ok, 0.9 | conflict, needs-review |
| Capital, Volume I | Capital, Volume II | single-source, ok | conflict |
| Capital, Volume II | Capital, Volume I | single-source, ok | conflict |
| Gender and Power in Rural China | Gender and Power in Rural India | single-source, ok | conflict |
| Social Capital and Civic Engagement in Italy | … in Germany | single-source, ok | conflict |
| The Politics of Memory in Postwar Europe | The Politics of Water in Postwar Europe | single-source, ok | conflict |
| A Theory of Justice | A Theory of Justice for Animals | single-source, ok | conflict |
| The Politics of Memory in Postwar Europe | The Politics of | single-source, ok | conflict |

These are exactly the wrong-file-attached cases R394 c wants shown to the researcher: a sibling volume, a companion country study, a series book. They are now auto-accepted, and nothing in the item records that the file names another work. Where the item stays a conflict, it does so correctly: another title altogether, a chapter's PDF carrying the book's title, a single word such as "History".

The brief's "keep its threshold" is ambiguous. The comparison sits in `resolve.ts`, whose own threshold is `AGREE = 0.9`. The implementer chose core's looser 0.6.

Direction:
- Drop the 0.6 similarity path, or use 0.9.
- Agree on normalized equality, or on containment bounded at words in which:
  - the shorter title is a prefix of the reference title followed by a subtitle mark in the original, or a cut-off (the embedded title is a prefix of the reference title); or
  - the shorter title is a run inside the reference title (a running head);
  - and the shorter title has at least three words that are not stop words.
- Do not treat an embedded title that is LONGER than the reference title as agreement unless the extra part follows a subtitle mark.
- Add the rows above as tests: each must stay a conflict.

### I2 (Important): the shared filter blinds the find-full-text file check (R282 a, R293 b as built)
`packages/library/src/extract/title-like.ts:19-39` (`STOCK_TITLES`), used through `extractPdf` and `extractEpub` by `packages/library/src/find/file-check.ts:467`.

The file check reads the embedded title as one of its signs that a downloaded file is "another kind" of document. "index", "front matter", "back matter" and "table of contents" are in its own `ADDED_KIND_LABELS` (`file-check.ts:178-190`). The extractor now drops exactly those titles before the check sees them.

The probe used the record "Rivers and Memory in Upland Villages" by Amara Okafor. The PDF's first page showed the title, then the author, then ordinary text, as a journal's front matter or table of contents lists its articles.

| Embedded title | Head | Base |
|---|---|---|
| Front Matter | **match** | other-kind |
| Index | **match** | other-kind |
| Back Matter | **match** | other-kind |
| Table of Contents | **match** | other-kind |
| Contents (not in the stock list) | other-kind | other-kind |

JSTOR titles such items literally "Front Matter", "Back Matter" and "Index". So a download that returns one of them would now be accepted as the article's full text and attached to the record. The whole-suite run missed it because no file-check test uses a stock-word embedded title as the only sign. The brief's own list asked for these words to be dropped, so this needs the coordinator's ruling.

Direction: let the extractors return the raw embedded title next to the filtered one, for example a `rawTitle` that only the file check reads, and keep the import's filter. Or leave section labels out of what the filter drops for the file check. Add the four rows above as file-check tests.

### Minor
**M1: junk still kept** (`title-like.ts:19`). The probe kept these:
- **Section and template words:** "Original Article", "Research Article", "Review Article", "Article", "Manuscript", "Author Manuscript", "Accepted Manuscript", "Abstract", "Introduction", "Chapter 1", "Page 1", "Template", "Paper Title (use style: paper title)", "Insert title here", "Your Title Here", "Title of the paper", "Document title", "Running head: …", "Proof", "Preview", "Word".
- **Sites and services:** "JSTOR", "IEEE Xplore", "www.annualreviews.org", "Downloaded from https://…", "ACS Paragon Plus Environment".
- **Other junk:** an e-mail address, dates ("15 January 2020", "January 2020"), "(Microsoft Word - draft.doc)" in parentheses, "CamScanner 01-02-2020", "Blank Page", "Front Cover", "Cover page", "Title page", "Frontmatter", "Unknown", "No title", "Unknown Title", "eBook", "Calibre".
- **Other languages' "untitled":** "Sans titre", "Sin título", "Senza titolo", "Unbenannt", "Titel", "無題", "无标题", "Без названия". This is allowed by the brief.

Each one, put against a Zotero title, gives the owner's false conflict: the probe showed "Original Article", "Author Manuscript", "www.cambridge.org" and "Antiquity 94 (377)" all coming out as conflict and needs-review.

Worth adding:
- the template, section and site words;
- the "untitled" equivalents (a short multilingual list is cheap);
- a URL with `www.`, and an e-mail address;
- a date alone.

Do NOT add "Book Review", "Erratum", "Corrigendum", "Contents", "Supplementary material" or "Appendix": they are true signs that the wrong file is attached (I2).

**M2: real titles dropped.** The loss is acceptable in general: only embedded evidence is lost, and with no reference record the file name usually gives the same title. Dropped in the probe:
- **One-word titles that are stock words:** "Cover", "Index", "Print", "Scan", "Blank", "Presentation", "Slide", "Layout", "Document", "Title", "Untitled", "Front Matter", "Full Text", "Table of Contents".
- **Short titles:** "It", "Us", "Q", "V.", "Z", "Er", "Mo", "Oz", "Pi", "π", "XX".
- **Single CJK characters:** "心", "我".
- **Two-syllable Korean titles:** "토지", "광장". Hangul is missing from the two-character rule, though Korean words are often two syllables.
- **Codes and numbers that are titles:** "1Q84", "S/Z", "M\*A\*S\*H", "R2-D2", "1984", "2666", "300", "24/7", "2 + 2 = 5", "ISO 9001:2015", "RFC 2616", "A/RES/70/1", "$2.00 a Day", "H1N1 in 2009".
- **Hyphenated or joined, no space:** "Fahrenheit-451", "Post-9/11", "SARS-CoV-2-pandemic-era", "Web3.0", "Infrastructure20212022", "Input/Output/Storage", "and/or/not".

Kept correctly: "Catch-22", "Fahrenheit 451", "DSM-5", "ICD-10", "UNSCR 1325", "GDPR", "COVID-19 and inequality", "9/11 Commission Report", "1,000 Years, 1,000 People", "#MeToo", "論語", "雪国", "Война и мир", Thai, Hindi, Greek, Hebrew and Arabic titles, and longer titles that mention a DOI or an ISBN.

Smallest corrections:
- add `\p{Script=Hangul}` to `NO_SPACE_SCRIPT` for the two-character rule;
- in `mostlyDigitsAndPunctuation`, count a run of digits as one character, so "ISO 9001:2015" and "RFC 2616" survive.

The rest is acceptable as briefed. A real conflict is hidden only when a junk-looking embedded title is in fact another work, which is rare.

**M3: an agreeing embedded title is not recorded** (`resolve.ts:361-364`). `/title` then reads "single-source" from Zotero, although the file corroborated it. Nothing recorded is untrue, but the evidence trail understates the support, and R394 c's "they AGREE" is implemented as "the file says nothing". Core's two checks (`checkCrossSource`, `draft-vs-evidence`) would need the containment rule to record such a title as corroborating evidence. That is a coordinator decision, already flagged in the report.

**M4: an embedded title equal to the file's name is dropped.** "Risk Society" in "Risk Society.pdf" with no reference record: the title still comes out "Risk Society", now from the file name. The method becomes embedded with no title, and confidence falls from 0.7 to 0.55. Both are below 0.9, so no decision changes. With a Zotero record, an equal embedded title is dropped and no longer corroborates.

Also, the extractors compare with `basename(path)`, not with `ResolveInput.fileName`. `attach.ts:307` passes `path: real`, so for a symbolic link the link target's name is compared. The effect is small.

**M5: stock authors.** "Anonymous" is dropped; it is a real attribution for anonymous works, harmless only because it is embedded data. Kept although they are program or machine names:
- "user1", "DELL", "HP", "Lenovo", "IT Department";
- "Canon", "Xerox", "ABBYY", "Acrobat", "Adobe Acrobat Pro";
- "pdfTeX-1.40.21", "Word", "InDesign", "Adobe InDesign CS6 (Macintosh)", "calibre", "Preview";
- "DESKTOP-ABC123" (the Windows default name);
- typesetters "SPi", "Aptara" and "Arbortext".

Real names were kept ("Will Owner", "Anne Unknown", "User Friendly Press", "Tex Avery", "Dorothy Pc"). "TPC" and "NPC" were dropped by the machine-name rule; that is acceptable. Direction:
- add the scanner, office and typesetting brands;
- add a version-suffix form (`pdfTeX-…`, `… CS6 (Macintosh)`) and `DESKTOP-[A-Z0-9]+`.

**M6: the EPUB and MOBI wiring is held by no test.** With base `epub.ts` and `mobi.ts` put back, `extract.test.ts` and `title-like.test.ts` passed: 150 passed, 2 skipped. Add one EPUB test (an OPF title "Untitled", creator "calibre"/"User") and one MOBI test, through `extractMetadata`.

**M7: only one test needs `partOfTitle`.** With `partOfTitle` forced to false, only "the title without its subtitle" failed. The running head (0.61) and the cut-off title pass through the 0.6 similarity alone. Once I1 is fixed, every agreement case needs its own test.

**M8: the examined text is bounded, but not at 1,000 characters.** `looksLikeTitle` folds the first 4,000 characters (`title-like.ts:100`). `STOCK_TITLE`, `STOCK_PREFIX` and the file-name comparison run on those 4,000; `hasWord`, the path test and the digits test run on the first 1,000; the identifier tests only on text of 200 characters or less. Every expression is anchored or linear, so the cost is bounded either way: the comment is slightly inaccurate, nothing more.

## Checked and sound
- **The owner's case:** "S0003598X20000800jra 900..915" is dropped. These are dropped too:
  - "PII: S0140-6736(20)30183-5", "doi:10.1016/…", "jmp_2020_0123 1..15", "ASR918386 1..24", "0001839219842562";
  - "1-s2.0-S0140673620301835-main", "annurev-soc-…", "SSRN-id1234567", "s41586-020-2012-7";
  - "Microsoft Word - Document3", "untitled.pdf", "tmp.dvi", "Layout 1", "Slide 1", "PowerPoint Presentation";
  - "C:\\Users\\…", "file:///…".
- **Through `resolveItem` and the bulk engine:** the item is created, its title is Zotero's, and no junk is mentioned anywhere.
- **No reference record:**
  - A good embedded title is used as before.
  - A junk embedded title falls to the file name: the owner's PDF saved by Zotero as "Lopez - 2020 - Subsistence and persistence agriculture in the Cent.pdf" gets that name's title, at confidence 0.5, needs-review.
  - A file named after the code gets the code from the file-name step. That step is outside this task.
- **Cost:**
  - 2 MB hostile titles take 0.2–74 ms each. With the cap removed, the bounded-time test fails (3,275 ms), so it holds the guard.
  - The regular expressions are anchored with bounded quantifiers: no catastrophic backtracking found.
  - Author names are already capped at 2,000 characters (`names.ts:12`).
- **Nothing else moved:**
  - Confidence numbers, other fields' review rules and the identifier step are unchanged (`resolve.ts` changed only in the step-2 branch).
  - Browser capture does not use `extractHtml`, so it is unaffected.
  - A dropped HTML file titled "Index" or "Untitled Document" falls to the file name; "Home" is kept. That is acceptable.
  - The dry run does not call `resolveItem`.
- **The changed test** (`<title>T</title>` became "Market Days") is justified: its point is parsing without `</head>`, and a one-letter title is no title under R394.
- **The report's point 5** (a later import passes by an item waiting for review) agrees with `bulk/run.ts:967`.

## Could not verify
- The owner's real PDFs.
- Whole suites, which I did not run.
- The media worker (no Python environment in the worktree).
- Whether pending review entries clear after an undo and re-import (the implementer did not check either).
