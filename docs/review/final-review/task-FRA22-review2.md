# Review, round 2 — Task FR-A22 (R410, R422)

Reviewer: the same reviewer as round 1, on a scoped second look. Worktree `.claude/worktrees/fr-a22`, head 4526817. Every probe has been deleted, every guard I took out has been put back, and `git status --short` is empty. No `git stash` was used.

## Verdict: APPROVED WITH SMALL POINTS

Both Important findings from round 1 are closed:
- **I1:** every row of my table is a conflict again.
- **I2 / R422:** "Front Matter", "Index", "Back Matter" and "Table of Contents" mark the wrong kind of document again. A right download that carries the owner's code or "Original Article" now matches by its text, and a wrong download with a junk title is still refused.

Each new guard is held by a test. Eight Minor points remain:
- three are what R410's own rules allow (M1, M2), or core's folding (M3);
- five are small defects in the new lists and in the PDF's title as found (M4–M8).

## What I ran (`nice -n 10`, single files)
- **Agreement probe:** `resolveItem` with a Zotero record and `lookup: null`, 38 pairs of reference and embedded titles: 20 different works and 18 that are the same work.
- **File-check probe:** `checkFileAgainstRecord` with 20 PDFs, made with Info and XMP titles set separately.
- **Title and author probe:** 70 titles and 37 author names through `looksLikeTitle` and `isStockAuthor`.
- **Guards taken out, one at a time, then put back:**
  - `VERSION_SUFFIX`: 3 tests fail;
  - `WINDOWS_MACHINE`: 1 test fails;
  - clauses 5 and 6 and the evidence reading the filtered title instead of the title as found: 7 tests fail;
  - clause 8 reading the title as found: the 2 R422 tests fail.

## 1. Agreement (R410 a)

### My round-1 table
Each row is now a conflict that needs review:
- Iran / India;
- Volume I / Volume II, both ways round;
- Rural China / India;
- Italy / Germany;
- Memory / Water;
- "A Theory of Justice" / "… for Animals";
- "The Politics of".

### Different works that still agree
These are all allowed by R410's wording, so they need the coordinator's ruling rather than counting as defects.

**M1 — rule (i), similarity ≥ 0.9.** The word-set measure counts two titles of ten or more words that differ by one word as about 0.9 or more. Both of these come out single-source, ok:
- "A Social History of Rural Labour in **Northern** Italy from the Late Nineteenth Century to the Second World War" against "… **Southern** Italy …";
- "Collected Papers of the Royal Anthropological Institute of Great Britain and Ireland Volume **1**" against "… Volume **2**".

Shorter series pairs stay conflicts: "Cambridge History of China: Volume 1" against "…: Volume 2", and "Annual Report 2019" against "2020".

Smallest fix: under rule (i), treat a pair as "same" only when both titles hold the same numbers. Better still, require that no content word appears in only one of them; that leaves the 0.9 for word-order and punctuation differences.

**M2 — rules (ii) and (iv) with a short title, and rule (iii).** These agree:
- "Justice" against "Justice: What's the Right Thing to Do?";
- "Capital" against "Capital: The Eruption of Delhi";
- "Introduction" against "Introduction: Markets and Memory in Lagos";
- the record "Cambridge History of China: Volume 2" against the embedded series title "The Cambridge History of China";
- "Oil and Politics in the Middle East: …" against "Politics in the Middle East", a different textbook;
- "Women and Gender in the Middle East and North Africa" against "… in the Middle East".

Rule (iv) with a one-word record is the classic "Capital" case, and it cannot be told apart from "Justice". Accept it, or have the coordinator ask for two real words in the shorter title under (ii) and (iv). That would make "Capital" against "Capital: A Critique…" a conflict.

### The same work that is now a conflict (the owner settles it by hand)
**M3.** These came out as conflicts:
- **A cut inside a word:** "…Plains of China throu". The owner's report quotes "…throu…" **from Zotero**: it is the review screen's own shortening of Zotero's title, while the PDF held "S0003598X20000800jra 900..915". So the owner's data says nothing about PDFs whose titles are cut inside a word. Making such a cut a conflict follows R410 iii ("whole words"), and real cases are rare. Accepted.
- **"Neolithic-Bronze Age"** against "Neolithic to Bronze Age": core's `normalizeTitle` joins the hyphenated words into one. This already happened on the base code and is not this task's doing.
- **"Markets and Memory (2nd edition)"** against "Markets and Memory": a parenthesis is not a subtitle mark.
- **"Water access in peri-urban areas: a review"** against "…: A Review of the Evidence": a record that is itself cut short, which no rule covers.
- **A running head with the author's name:** "Lopez et al. Subsistence and persistence".

Smallest fix: let `SUBTITLE_MARK` accept ` (`. Leave the comma out: it would make "Capital, Volume I" agree again.

The good cases agree:
- the title without its subtitle, after a colon, a full stop or an en dash;
- the running head "Agriculture in the Central Plains of China";
- a cut at a word, including one ending in "…";
- an all-capitals short title;
- the reverse direction (rule iv).

The implementer says the "equal after folding" test can never fail alone. I agree: titles equal after `normalizeTitle` always have similarity 1.

## 2. The file check (R410 b, R422)
| PDF | Head |
|---|---|
| right file, Info "Front Matter" / "Index" / "Table of Contents" | other-kind ✔ |
| right file, Info "S0003598X20000800jra 900..915" / "Original Article" / "Author Manuscript" / "Proof" / a file name | match ✔ |
| wrong file, Info code or "Original Article" | title-absent ✔ (as with no title) |
| wrong file that cites the record's title in its body, Info code | title-absent ✔ |
| a table of contents listing the record, Info code | other-kind ✔ |
| right file, Info "Book Review" | other-kind ✔ |
| **right file, XMP "untitled" + Info "Front Matter"** | **match** (base: other-kind) — M4 |
| **right file, Info "CamScanner 01-02-2020"** | **title-absent** — M5 |

`rawTitle` reaches nothing but the file check:
- the dispatcher in `extract/index.ts:93` drops it;
- `grep` finds it read only at `file-check.ts:492` and `:515`.

The evidence shown passes through `shown()` (`file-check.ts:253`): control and bidi characters are removed and the text is cut to the evidence limit. The probe confirms it: "Front‮ Matter‏ <script>" is shown as "Front Matter <script>", as text. R301 and R303 are untouched: the round changed only how `file-check.ts` reads the embedded title; the check still only labels, and nothing is attached without the researcher.

**M4 — the PDF's title as found is the XMP title alone** (`extract/pdf.ts:58`, `rawTitle = xmpTitle ?? infoTitle`). An XMP title of "untitled" hides an Info title of "Front Matter", so the front matter matches as the article. On the base code the old filter skipped "untitled" and the check saw "Front Matter". The case is rare, but it is a regression. Smallest fix:
- either let clause 5 and clause 6 read both titles as found, the XMP one and the Info one;
- or set `rawTitle` to the first title that is not a file name or "untitled".

**M5 — CamScanner** (the implementer's doubt, confirmed). "CamScanner 01-02-2020", "CamScanner" and "Scanned with CamScanner" are kept as titles. A right download carrying one of them is refused as "title-absent", and an import with a Zotero record gets a false conflict. Smallest fix: add `camscanner` with an optional date or time after it, and "scanned with camscanner", to the stock texts.

## 3. Stock lists (R410 c, e)

**M6 — `DATE_ONLY` drops real titles** (`title-like.ts:106-108`): "August 1914" (Solzhenitsyn), "July 1914", "March 1917", "October 1917", "November 1918" and "September 11, 2001". It is only a suggestion from the file that is lost; with no reference record, the file name still gives the title. Smallest fix: take the bare "Month YYYY" form out of `DATE_ONLY`, and require a day or an all-numeric date.

**M7 — the author patterns reach too far** (`title-like.ts:249-251`):
- `VERSION_SUFFIX` strips ANY parenthesis, so "IT Department (University of Oslo)", "Owner (ed.)", "Unknown (2019)" and "Admin (IT)" are dropped.
- `WINDOWS_MACHINE` matches "DESKTOP-PUBLISHING" and "Desktop-Team".

Smallest fix: strip a parenthesis only when it holds a platform word (Windows, Macintosh, Mac, Linux, x64 …); require a digit in the `DESKTOP-` code. Real persons are kept: "Mary Word", "Jane Canon", "Michael Dell" and "Anonymous".

**M8 — one-word real titles now dropped:** "Proof" (Auburn's play), "Abstract" (an art book), "Introduction", "Index", "Cover", "Word", "Preview", "Manuscript". With a number: "Article 19", "Article 370", "Chapter 11", "Page 3". These losses do not matter: the reference manager's title stands, and with no record the file name names the work. Accepted as briefed.

Missed junk, for later: "Final", "Draft", "draft v3", "Journal Pre-proof", "Uncorrected proof" and "Page 1 of 20" are kept.

## Checked and sound
- Each way of agreeing has its own test, and each test fails when its rule is taken out (the implementer's check, which my probe confirms).
- The EPUB and MOBI wiring is tested.
- The single 1,000-character bound applies to titles and to authors, and its test reads through a Proxy.
- Hangul titles of two syllables, "ISO 9001:2015" and "RFC 2616" are kept.
- "Book Review", "Erratum", "Contents", "Appendix" and "Supplementary material" are kept, and are still signs of another kind in the file check.

## Could not verify
The owner's real PDFs and real downloads.
