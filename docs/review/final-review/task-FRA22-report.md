# Task FR-A22: a file's embedded title is evidence only when it looks like a title (R394)

Worktree `.claude/worktrees/fr-a22`, branch `fr-a22-junk-titles`. Commits:
- `82a509a` fix(library): an embedded title or author counts only when it looks like one (R394 a, b)
- `6879b1e` fix(library): an embedded title that is part of the reference title agrees with it (R394 c)
- `f8b6ce5` test(library): a Zotero import whose PDFs carry junk embedded titles creates the items (R394)

## Points 1 and 2: one rule for titles, one for stock authors (commit 82a509a)
- New module `packages/library/src/extract/title-like.ts`:
  - `looksLikeTitle(raw, fileName?)` (:99) and `embeddedTitle(raw, fileName?)` (:117). After trimming and folding white space, a title is dropped when it has no word made only of letters (3+, or 2+ in a script written without spaces); when it is only an identifier (DOI with or without a `doi:`/doi.org prefix, ISBN, ISSN, arXiv new and old style, a publisher's item code (a letter then 15+ letters and digits, some digits), UUID, 16+ hex digits, 12+ Latin letters and digits mixed with no space); when it ends in a known file extension or looks like a path; when it equals the file's own name without extension (no regard to case); when it is a stock text (`STOCK_TITLES`, :19, one English-only constant, alone or followed by a number, plus the prefixes "Microsoft Word - ", "Microsoft PowerPoint - ", "Adobe Photoshop"); or when more than half of its non-space characters are digits, punctuation or symbols. The comment says that other languages' stock words are not covered, and that a digits-only title ("1984") is dropped as an embedded title.
  - `STOCK_AUTHORS` (:125), `isStockAuthor` (:161), `keepCreators` (:168): exact words, no regard to case, plus a single word ending in "PC" or "Laptop". A parsed name is checked as "Given Family" and as a literal.
  - Only the first 1,000 characters are examined, and identifiers only up to 200 characters: without this cap the rule took about 1 s on a hostile 2 MB "title" (measured). With the cap, a test checks bounded time.
- Where it is applied, per kind of file:
  - **PDF** `extract/pdf.ts`: the XMP `dc:title`, else the Info Title, whichever looks like a title first. This replaces the old `JUNK_TITLE`, whose three patterns are covered by the new rule. Creators: XMP, else the Info Author, each through `keepCreators`. The Info Author is still read when XMP gives only stock names.
  - **DOCX** `extract/docx.ts`: `dc:title` and `dc:creator` from the core properties.
  - **EPUB** `extract/epub.ts`: the OPF `dc:title` and `dc:creator`.
  - **MOBI/AZW** `extract/mobi.ts`: the EXTH title, else the PalmDB name; the EXTH authors.
  - **HTML** `extract/html.ts`: the meta title (citation/DC/OpenGraph), else `<title>`; the creators.
  - **OpenDocument (.odt)**: no extractor exists (it is not dispatched), so nothing is read and nothing is filtered.
  - **Images, audio, video** (`extract/exif.ts`): no title or author is read today (only capture time, device, GPS and similar), so there is nothing to filter.
  - Each extractor calls the rule itself, so the callers that use `extractPdf` and `extractEpub` directly (`find/file-check.ts`) get the same rule.
- Tests (all failed first):
  - `extract/title-like.test.ts`: a table of 91 embedded titles, plus file-name, blank and bounded-time cases and the stock-author cases. Run against today's rule (a temporary stub with `JUNK_TITLE`): 68 failed. Real titles kept include one word, Catch-22, Fahrenheit 451, 20,000 Leagues…, 2001: A Space Odyssey, 100 Years of Solitude, all capitals, Chinese, Japanese, Arabic, Russian, a long title mentioning a DOI, On Liberty and Either/Or. "Maria Lopez" and "User Friendly Press" are kept.
  - `extract/extract.test.ts`, block "R394", 6 tests, all seen failing with the actual junk value:
    - through `extractMetadata` → `extractPdf`, with a PDF made in the test: the owner's Info Title and no XMP title give no title; a junk XMP title with a real Info Title gives the real one;
    - the file's own name is dropped;
    - stock authors are dropped and the Info fallback still works;
    - DOCX "Document1" by "User";
    - an HTML `<title>chapter3.pdf</title>`.
  - **Existing test changed:** `extract.test.ts` "review round 2 › text survives a page with no </head> and no <body>" used `<title>T</title>` and expected title "T". A one-letter title is no title under R394, so it now uses "Market Days". Its point, that the parser reads the title and text of a page without `</head>`, is unchanged.

## Point 3: agreement before conflict (commit 6879b1e)
- `import/resolve.ts`:
  - `partOfTitle` (near the top, after `AGREE`) and the step-2 branch where the reference title already decided the item (`else if (done() && extracted.title)`).
  - The embedded title AGREES with the reference title when, after `normalizeTitle`, one begins with or contains the other and the shorter has at least three words, or when core's cross-source similarity is ≥ 0.6 (`CROSS_SOURCE_AGREE`, the threshold of core's `conflicts`, kept).
- **Built differently from the brief's picture:** the brief places the comparison in `resolveItem`, but the conflict is raised in core's `verifyDraft`, by two checks. One is `checkCrossSource` (similarity < 0.6). The other is `draft-vs-evidence`: any trusted title evidence that is not equal and not ≥ 0.9 similar is a conflict, so a running head at 0.61 still came out as "Conflict". As the brief limits the change to `resolve.ts`, the embedded title is now recorded as title evidence only when:
  - it is equal or nearly equal (≥ 0.9), so it corroborates, as before; or
  - it clearly disagrees, which stays a conflict, as before.

  An embedded title that agrees only loosely is not recorded: the item's title is Zotero's either way, and its status is "single-source" from Zotero. Core is untouched. If the coordinator prefers "agreeing" embedded titles to be kept as evidence, core's two checks need the same containment rule (a decision outside this brief).
- Tests: `import/resolve-titles.test.ts`, 9 tests with `lookup: null` (no network):
  - **The owner's case:** no conflict, the title is Zotero's, `/title` is not "conflict", the overall result is not "needs-review", confidence ≥ 0.9, the only title evidence is Zotero's, and the code appears nowhere in the resolution. This test failed on the old extractors with the old code.
  - **Agreement cases, which agree:** the title without its subtitle, a running head, a title cut off by a length limit, and a difference in case, accents or punctuation. The first three failed first. The fourth already passed through similarity.
  - **Another work's title:** stays a conflict and needs review; the title is still Zotero's.
  - **A two-word part:** stays a conflict.
  - **No reference, junk embedded title:** the title comes from the file's name, the creators are empty and the junk is not mentioned. This failed on the old code.
  - **No reference, good embedded title:** it is used as today ("embedded" evidence and method).

## Point 4: the bulk engine (commit f8b6ce5)
- `import/zotero-local.test.ts`, "R394: three items whose PDFs carry junk embedded titles…":
  - Setup: the Zotero fixture's stored PDF and linked PDF, plus a third stored PDF added to the report item, each with a junk title (and "Administrator" as one author).
  - Each of the three items is journaled `created`, keeps Zotero's title, its `/title` is not in conflict and its only title evidence is Zotero's.
  - Run with `pdf.ts` and `resolve.ts` put back to the branch's base: it fails ("conflict").
- Identifier look-ups, confidence numbers of other paths and review rules for other fields are untouched (no code there changed).

## Point 5: items already waiting for review
Not changed by this task. What a later import of the same Zotero library does with them, from `import/bulk/run.ts` `item()` (≈ :950–980) and `updateInner`:
- The Zotero adapters are incremental. An item imported before, whether created or waiting for review, is matched by its Zotero key and version, and is never resolved again.
- **Zotero did not change the item:** the outcome is "unchanged". It is passed by, and the pending review entry and the title conflict stay as they are.
- **Zotero changed the item:** the update merges only the fields Zotero changed (R72, Z6). It neither re-reads the file's embedded data nor re-runs `resolveItem` or the verification of the title, so the conflict and its pending entry remain.

So the owner's 55 entries will not clear themselves. They are settled in the review queue, by keeping Zotero's title (one confirmation per item). I did not check whether undoing the whole batch and importing again would be cleaner (undo semantics with respect to the "deleted here" record were not checked), so I do not recommend it.

## What only a real Mac or real data can show
That the owner's own PDFs (other publishers' codes and stock words) are all caught. The rule is tested on synthetic PDFs only.

## Minor (deferred)
- minor (deferred): titles of one or two Latin letters ("It", "Up") are dropped as embedded titles, by the three-letter rule.
- minor (deferred): "Either/Or" is kept, because a path needs two or more slashes and no space, a leading slash, or a backslash. A slash-joined title of three or more parts with no spaces ("Input/Output/Storage") would be taken for a path.
- minor (deferred): the "three words" condition for agreement counts space-separated words. For Chinese and Japanese titles, agreement rests on core's bigram similarity alone.
- minor (deferred): the hostile-markup timing tests in `extract.test.ts` ("200,000 unclosed <title>", "~2 MB unclosed <dc:title>", limit 1000 ms) fail now and then under the machine's load (load average ≈ 35). They also failed on the unchanged code (1111 ms and 1687 ms), and pass when re-run alone.

## Runs
All runs at `nice -n 10`. The two whole suites and the typecheck outlasted the tool's foreground time limit and so finished in the background; each was waited on to the end. Load average was 35–49 throughout.

**Touched test files** (`pnpm --filter @ao/library exec vitest run …`):
- `title-like.test.ts`: 112 passed.
- `resolve-titles.test.ts`: 9 passed.
- `zotero-local.test.ts -t R394`: 1 passed.
- `extract.test.ts`: all pass except the two hostile-markup time limits. These also fail on the branch's base under this load.

**`pnpm -r typecheck`:** exit 0.

**`pnpm --filter @ao/library test`:** "Tests 21 failed | 3807 passed | 22 skipped (3850)". Every one of the 21 is a time or performance limit in a file this task did not change. The exception is `extract.test.ts`'s two hostile-markup tests, which fail on the unchanged code too. Each failing file was then re-run alone:
- **Passed alone:** `sidecar` 17/17, `transcript-segments` 20/20, `export/bibliography` 9/9, `citation/custom-styles` 31/31.
- **Failed again alone, only on time limits** (load ≈ 48):
  - `refman`: 8, the linear-parsing timings, a 200,000-record export and the torn Calibre database at 55 s;
  - `zotero-local`: 2, both note-conversion floods (my R394 test passes);
  - `html-strip`: 3, worker/latency timings;
  - `annotations-cap`: 3, N5/R161 budgets;
  - `extract`: 2, the hostile-markup timings.

**`pnpm --filter @ao/library-service test`:** "Tests 4 failed | 1021 passed | 1 skipped (1026)". Re-run alone:
- `main.test.ts`: 15/15 passed.
- `recovery-code.test.ts`: 10/10 passed.
- `find-browser-routes.test.ts`: 43/44. The one failure is R348 d, a countdown read under load ("Ready in 18 seconds." instead of "Ready in 20 seconds."). It is a timing failure, unrelated to embedded titles.

UI: not touched (no shared text or screen changed), so the UI suite and lints were not run.

**Git:** `git status --short` is empty. Head is `f8b6ce5`.

**Note on `git stash`:** before the coordinator's note, I used `git stash` twice, around 08:20 and 08:27 UTC, push then pop within seconds, to run tests against the old code. Each pop restored exactly the files I had set aside, and the shared stash list is empty now. Later comparisons used `git checkout <base> -- <files>` and then `git checkout HEAD -- <files>`.

## Round 2 (R410)

Implementer: a fresh session, worktree `.claude/worktrees/fr-a22`, branch `fr-a22-junk-titles`. Six commits on f8b6ce5, one per point; head **f5270ec**. No `git stash` used. To see a test fail on the old code I edited the line back temporarily (or put the base file in with `git show 7537f63:… >`) and restored it with `git checkout HEAD --`.

### (a) I1: agreement only where it is the same work — 0125dfe
- `packages/library/src/import/resolve.ts:89-135`: `SMALL_WORDS` (the brief's list), `SUBTITLE_MARK` (`:` `–` `—` `?` `!`, ` - `, `. `), `foldedWords` (each white-space chunk folded by core's `normalizeTitle`, with the position in the ORIGINAL text where its last letter or digit ends), `withoutSubtitle(short, long)` (rule ii and, swapped, iv), `runOfRealWords(part, whole)` (rule iii), `embeddedAgainstReference` → `"same" | "part" | "other"`. `CROSS_SOURCE_AGREE` (0.6) and `partOfTitle` are gone.
- `:384-387`: "same" (equal after folding, or similarity ≥ `AGREE` 0.9) and "other" are recorded as before the task (base 7537f63 recorded every embedded title; core then corroborates or calls a conflict); "part" (ii, iii, iv) is not recorded (R406 a).
- Tests, `resolve-titles.test.ts`: every row of the review's I1 table is a conflict (plus "A Theory of Justice for Animals" / "A Theory of Justice", a mid-word cut, and a two-real-word prefix with no subtitle mark). Each of these failed first (head: single-source). Each way of agreeing has its own test, checked by removing it one at a time: no similarity → the 0.9 test fails; no (ii) → the three without-subtitle tests (`:`, ` - `, `?`) fail; no (iii) → the running-head and cut-off tests fail; no (iv) → the record-lacking-subtitle test fails.
- **Limit (M7):** removing the "equal after folding" test alone changes nothing, and cannot. Equal titles always have similarity 1, so the similarity test covers them. In `resolve.ts`, "same" and "other" both record the title, so the equal-titles test is held by core's check (no conflict), not by this branch.
- **Expectations changed (round 1 tests):**
  - "a title cut off by a length limit" used "…of China throu", a cut inside a word. By R410 (iii), only a run of whole words agrees, so that example is now a conflict and sits in the conflict table. The cut-off test now cuts at a word ("…Plains of China").
  - The 0.9 example is now the reference title plus ": A Study" (similarity 0.94). The earlier "and" variant passed even with the similarity rule removed.
  - The running-head example is unchanged.
  - The case/accents test is kept. It now also asserts that the title is recorded as corroborating.

### (b) I2: the file check sees the embedded title as found — f6947bf
- `extract/types.ts:56-61`: `RawExtract.rawTitle`, the embedded title as found. It is set only when a title was found, and is the first one present in the extractor's reading order:
  - PDF: XMP, then Info (`pdf.ts:55-59`);
  - EPUB and DOCX: dc:title;
  - MOBI: EXTH 503, then the record-0 full name, then the PalmDB name;
  - HTML: the meta title, then `<title>`.
- `extract/index.ts:93`: the dispatcher drops `rawTitle`, so `extractMetadata` and the import never see it. A test asserts this.
- `find/file-check.ts:490, :513`: the evidence shown and `embedded` read `rawTitle`. Only `file-check.ts` reads it (grep).
- Tests, `file-check.test.ts`: the embedded titles "Front Matter", "Index", "Back Matter" and "Table of Contents" give other-kind (each failed first: `match: true`); "Contents" gives other-kind, as before; an EPUB whose OPF title is "Front Matter" gives other-kind (failed first).
- **Needs the coordinator's ruling.** The file check reads its embedded title in more places than clause 5. By the ruling's "the file check [reads] the one as found", its clause 8 also sees the raw title: "an embedded title of two or more content words that is not the record's is another document's". So a correct download whose PDF carries a production code is refused again, as on base:
  - My probe (deleted afterwards): the record "Rivers…", the title and author on page 1, and the embedded title "S0003598X20000800jra 900..915" or "Original Article" gives **title-absent**. With no embedded title it matches.
  - Under round 1 that file matched.
  - The smallest alternative: clauses 5 and 6 (kind and version signs) and the evidence read `rawTitle`, while clause 8 reads the filtered `title`. I did not build it, because the ruling says otherwise.

### (c) M1: the stock list — e31d61e
- `extract/title-like.ts:40-88`: the brief's titles are added to `STOCK_TITLES`. They are matched as the whole title, case and accents folded (`bare`, `:94`, so "Sin titulo" also matches), optionally followed by a number. Regex metacharacters in entries are now escaped (needed for "paper title (use style: paper title)").
- `:99`: `STOCK_PREFIX` gains "(Microsoft Word - …" in parentheses, "running head:" and "downloaded from ".
- `:105`: `WEB_OR_MAIL`, a "www.…" or "http(s)://…" address with no space, or an e-mail address alone.
- `:106-108`: `DATE_ONLY`, an English month name date or a numeric date.
- The module comment is updated.
- Tests: 60 new rows, all failing first. Kept as titles, tested: "Book Review", "Erratum", "Corrigendum", "Contents", "Supplementary material", "Appendix", and real titles that begin with a stock word ("Introduction to Sociology", "Unknown Pleasures", "Article 19 and the Right to Information", "May Day in Lagos, 1968", …).

### (d) M2 — 5727d30
- `title-like.ts:16`: Hangul is added to the two-character rule.
- `:151`: a run of digits counts as one character in the share of digits and punctuation.
- Tests: "토지", "광장", "ISO 9001:2015" and "RFC 2616" are kept (all four failed first). Still dropped: "900..915", "12345", "토", the owner's string, and the two citation lines already in the table.

### (e) M5 — b6c2112
- "anonymous" is removed from `STOCK_AUTHORS`.
- Added as exact words: dell, hp, lenovo, it department, canon, xerox, abbyy, acrobat, adobe acrobat pro, word, indesign, calibre, preview, spi, aptara, arbortext.
- To cover the review's "user1", "pdfTeX-1.40.21", "Adobe InDesign CS6 (Macintosh)" and "DESKTOP-ABC123", I added two narrow patterns beyond exact words (`title-like.ts:249-251`):
  - a version or platform after a stock name (`VERSION_SUFFIX`, stripped before the exact-word lookup);
  - `DESKTOP-[A-Z0-9]{4,}`.
- Tests: the 20 names, all failing first. Kept: "Anonymous" (failed first), "Will Owner", "Anne Unknown", "Dorothy Pc", "Desktop Publishing Group".

### (f) M6, M8 — f5270ec
- `extract.test.ts`, through `extractMetadata`:
  - EPUB: the OPF title "Untitled", creator "calibre" gives no title and no author, and no `rawTitle` property;
  - MOBI: the EXTH title "Untitled", author "calibre" gives the PalmDB name "salt_roads" and no author.
  - Both failed with base `epub.ts` and `mobi.ts` put back.
- `title-like.ts:158-162`: the one bound, `EXAMINED_CHARS = 1000`. `looksLikeTitle` and `isStockAuthor` cut the input to 1,000 characters first, then fold it; every test runs on that.
- Test: a 2 MB title and a 2 MB author are passed as a Proxy that allows only `slice` and records how many characters each slice reads. The largest read must be ≤ 1,000. It failed first: the old code read 4,000, and `isStockAuthor` used the whole text. The old timing test is kept.

### Runs (all at `nice -n 10`; load average 25–32)
- `vitest run src/extract src/import/resolve-titles.test.ts src/find/file-check.test.ts src/import/zotero-local.test.ts`: "Tests 2 failed | 468 passed | 2 skipped (472)". Both failures are time limits:
  - `extract.test.ts` "an OPF of ~2 MB of unclosed <dc:title>" (1,621 ms; limit 1,000). Alone it passes 3 of 5 times; failed alone at 1,088 and 1,008 ms. A probe shows this OPF yields no title at all, so the title filter does no work there. Round 1 reported the same test failing on base.
  - `zotero-local.test.ts` "a 1 MB <img> flood converts in under 1 s" (the note converter, untouched; 2,264 ms alone).
- `pnpm --filter @ao/library test`: "Tests 18 failed | 3944 passed | 22 skipped (3984)". All 18 are time or cost limits in files whose tested code I did not change:
  - `capture/html-strip` (3);
  - `import/refman` (9, linear-parsing timings);
  - `import/zotero-local` (1, noteToMarkdown nesting);
  - `index/annotations-cap` (5, N5 and R161 budgets).
  - Not re-run, as the brief says.
- `pnpm -r typecheck`: exit 0.
- `git status --short`: empty.

### What only real data can show
Whether the owner's real PDFs and real downloads are judged as the tests say.

### Minor (deferred)
- minor (deferred): "CamScanner 01-02-2020" (in the review's M1, not in the brief's list) is still kept as a title.
- minor (deferred): `DATE_ONLY` knows English month names only.
- minor (deferred): a title cut by a length limit inside a word is a conflict by R410 (iii) ("whole words"). This is now tested as such.
- minor (deferred): M3 (an agreeing part-title is not recorded as support) is left to FR-683, as R410 g says.

## Round 3 (R422)

Commit **4526817** (on f5270ec), one commit. No `git stash` used.

- **Change:** `packages/library/src/find/file-check.ts`, clause 8 ("another document's title", `const et`, near :618), now reads the import's FILTERED title `raw.title`. The module comment for clause 8 (:68-74) says which reading each clause takes.
- **Readings of the embedded title in `file-check.ts`:**
  - The evidence shown (`shown(raw?.rawTitle)`, :492) reads the title AS FOUND (`rawTitle`).
  - Clause 5, kind signs (`kindIn`: the title added to every zone; `aboutIn(embedded)`, "a document about the work"), reads AS FOUND. These are kind signs, and "Front Matter" and "Index" must count.
  - Clause 6, version signs (`embeddedVersion`: a volume or edition number in the title), reads AS FOUND. This is a version sign.
  - The "no place" reason path calls the same `kindIn` and `versionIn`, so it also reads AS FOUND.
  - Clause 8 asks "is this some document's title", so it reads FILTERED.
- **Tests, `file-check.test.ts`, describe "another document's title reads the filtered embedded title (R422)":**
  - Baseline, with no embedded title: a match.
  - Embedded "S0003598X20000800jra 900..915" gives a match, and the evidence shows the title as found. This test **failed first** (title-absent).
  - Embedded "Original Article": the same, also **failed first**.
  - Guards that already held, and still hold:
    - "A History of Modern India" against the record "Rivers of the Central Plains" gives title-absent. The same file with no embedded title matches.
    - The R410 b rows ("Front Matter", "Index", "Back Matter", "Table of Contents", "Contents", and an EPUB titled "Front Matter") all give other-kind.
- **Runs (`nice -n 10`):**
  - `vitest run src/find/file-check.test.ts src/extract src/import/resolve-titles.test.ts`: "Tests 394 passed | 2 skipped (396)". No time-limit failure this time.
  - `pnpm -r typecheck`: exit 0.
  - `git status --short`: empty.
- **Unsure:** nothing new. A string the filter keeps but which is still no title (for example "CamScanner 01-02-2020", deferred in round 2) would still count as another document's title in clause 8.

## Round 4 (R425)

Three commits on 4526817; head **d215275**. No `git stash` used. Every test marked "failed first" was run before its change.

### (a) M4: every embedded title as found, for the kind and version signs — c28e291
- **Field:** `RawExtract.rawTitle` is replaced by `rawTitles: string[]` (`extract/types.ts`). It holds every embedded title as found, in reading order:
  - PDF: [XMP, Info] (`pdf.ts`);
  - MOBI: [EXTH 503 (when it differs from the full name), the record-0 full name, the PalmDB name] (`mobi.ts`). `parseRecord0` now also returns `fullName`, a new optional field in its return; the parameters are unchanged.
  - HTML: [meta title, `<title>`];
  - EPUB and DOCX: [dc:title].
- **Dispatcher:** it still drops the field (`extract/index.ts`), and the extract test asserts that `rawTitles` is absent.
- **File check** (`find/file-check.ts`):
  - clause 5 (`kindIn` zones and `aboutIn`) and clause 6 (`embeddedVersion`) read every title in `embeddedAll`;
  - the evidence shows `rawTitles[0]`;
  - clause 8 is unchanged: it reads the filtered `raw.title` (R422).
- **Tests, `file-check.test.ts`, "every embedded title as found … (R425 a)":**
  - XMP "untitled" + Info "Front Matter" → other-kind, and the evidence is "untitled". **Failed first**: it gave a match.
  - XMP "untitled" + Info "Capital, Volume 2" → other-version. **Failed first**: title-absent. This is my own row.
  - Guards that already held: XMP "Front Matter" + Info a real title → other-kind; XMP "untitled" + Info a production code → a match by the text.
- **Tests, `extract.test.ts`:** `rawTitles` in reading order for PDF, MOBI and HTML. This is new wiring, so it was not a failing-first test.

### (b) M5: scanner stamps — d4710f1
- `title-like.ts`: `SCANNER_STAMP` matches "CamScanner", alone or followed by a date and an optional time, and "Scanned with/by CamScanner".
- Tests:
  - `title-like.test.ts`: five stamps are dropped (all **failed first**); "CamScanner and the Paperless Office" is kept.
  - `file-check.test.ts`: a right download whose embedded title is "CamScanner 01-02-2020" matches by its text (**failed first**: title-absent).

### (c) M7: the author patterns — d215275
- `VERSION_SUFFIX` strips a parenthesis only when it holds a platform word: windows, macintosh, mac, macos, os x, linux, x64, x86, 64-bit, 32-bit.
- `WINDOWS_MACHINE` needs a digit in the code.
- Tests:
  - Kept, all **failed first**: "IT Department (University of Oslo)", "Owner (ed.)", "Unknown (2019)", "Admin (IT)", "DESKTOP-PUBLISHING", "Desktop-Team".
  - Guards that held: dropped "Adobe InDesign CS6 (Macintosh)", "Acrobat (Windows)", "pdfTeX-1.40.21", "DESKTOP-ABC123"; kept "Mary Word", "Jane Canon", "Michael Dell", "Anonymous".

### Runs (`nice -n 10`)
- `vitest run src/find/file-check.test.ts src/extract src/import/resolve-titles.test.ts`: "Tests 421 passed | 2 skipped (423)". No time-limit failures.
- `pnpm -r typecheck`: exit 0.
- `git status --short`: empty.

### Unsure
- "Unknown 2019", with no parenthesis, is still dropped: a bare number after a stock name is read as a version, as "user1" is.
- Not built, as listed: M1, M2, M3, M6, M8.
