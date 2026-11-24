# Task RE-9b — draft for the owner's page: what the rough-edges round changed (writing only; no code)

This brief stands alone. You write ONE new file and change nothing else. No git commands that change anything; no tests; no builds (the machine is busy with verification — read only, and keep shell use light).

## The setting
"Alexandrine Oxiana" is a local-first research workbench for social scientists (a desktop app for the Mac: a library of sources, a PDF reader with highlights, capture from the web, watched folders, Zotero import and sync, "Find and acquire" which looks for copies of references, citation, encryption of projects). Its owner is a researcher with little coding experience who tests the Mac build by hand. The owner's page is `/home/user/AlexandrineOxiana/docs/review/final-review-for-the-owner.md` — read ALL of it first, for what the owner already knows and for its voice (plain sentences, no jargon, "you" and "I", what to do next).

In its part 3 the page describes "the 94 small rough edges" found by the final review. The owner then said: "Fix the 94 rough edges". That round is now built, reviewed and joined (not yet in a Mac build: the next build will be **Mac build 10**; do not give a link, a date or a time for it — write "[BUILD 10 LINK]" where the coordinator must fill one in).

## What to read (sources of truth, in this order)
1. The round's rulings in the ledger, `/home/user/AlexandrineOxiana/docs/handoff/LEDGER.md`: every ruling from R460 to R497. Find them with `grep -n -E "Ruling R4(6[0-9]|7[0-9]|8[0-9]|9[0-7])" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-200` for the list, then read each in full (`sed -n '<line>p' … | cut -c1-9000`). Later rulings correct earlier ones (R478 corrects R472; R484 and R492 correct parts of R473 and R487; R491 withdraws R486 b): the LATER ruling is what is true.
2. The one-line index for orientation: `grep -n -E "^R4(6[0-9]|7[0-9]|8[0-9]|9[0-7]) " /home/user/AlexandrineOxiana/docs/handoff/LEDGER-INDEX.md`.
3. The list of rough edges and what became of each: `/home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md` (each line starts `- **FR-nnn**`); the round's batches are named in the rulings by FR numbers. The NEWLY listed, not-built items of this round are FR-722 to FR-740: read each of those in full.
4. The implementers' reports, for what a researcher SEES (new or changed sentences, buttons, screens): `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE*-report.md` (read the sections about wording and behaviour; skip test lists).
5. The decisions table: the section "Decisions of the rough-edges round and Mac build 9" in `/home/user/AlexandrineOxiana/docs/handoff/DECISIONS.md`.
Where a report and a later ruling disagree, the ruling wins. If you cannot tell whether something was finally built, say so in your notes at the end rather than guessing. One thing still being mended as you write (Ruling R497 c): on a source that came from a watched folder, "Bring in the new version…" — write it as working; the build will not be made until it does.

## What to write
The file `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE9b-draft.md`: a new part for the owner's page, in Markdown, headed `## 10. Added on 24 November: the rough edges are fixed — what changed, and what to check`. At most about 1,100 words. In this order:

1. **Three or four sentences**: the round is done (the 94 rough edges of part 3, built, each batch checked by a second reviewer, then everything tested together); it comes to you as Mac build 10 [BUILD 10 LINK]; nothing in it needs a decision from you before you use it; it is not yet in `main` (the approved state) — I will ask.
2. **"What you will notice"** — the changes a researcher can actually see or feel, grouped under the same kind of headings the page's part 4 uses (the library and projects; locked and encrypted projects; the PDF reader; recordings and transcripts; watched folders; Zotero; Find and acquire; getting a PDF through your library; closing the app). One line each, in plain words, naming the button or sentence where there is one (quote the app's words exactly as the rulings give them). Leave out changes that are invisible (tests, internal safety) except in item 3.
3. **"What became safer underneath"** — four to six lines, plain words, for the changes that protect the researcher's data without being visible (for instance: an interrupted change is now undone correctly even if the app is interrupted twice; a locked project's pictures are refused at once; a transcript's two files are stored together or not at all). Include the two older faults the reviews found and mended on the way (Rulings R492 and R493) — say honestly what each could have done before.
4. **"Things only you can check in build 10"** — a short checklist (at most eight items) of hands-on checks that could not be done without a Mac, each one action and what you should see. It MUST include: quitting with Cmd-Q while something is running (FR-731: does the small "Closing Alexandrine Oxiana" window appear when closing takes more than two seconds, and does the app end fully); "Look at the file" on a found file's card in the review queue; "Get a copy for this source" on a source whose linked file is on an unplugged drive; an optional tool (the speech model) installing — the fix of build 9, which you have not yet confirmed.
5. **"Known gaps found during the round (not fixed)"** — FR-722 to FR-740 in plain words, one line each, most serious first (FR-738 first: say plainly what the researcher would see and how unlikely it is), each with its number so it can be found. Merge trivial ones into a single line ("small points of wording and focus: FR-…").

## Rules of writing
Plain language for a non-programmer: no file names, no function names, no "commit", "branch" only for `main`, no ruling numbers in the body except in item 5's FR numbers and where a number helps the owner find something. Whole sentences. No time estimates. Do not invent: every statement must come from the sources above. Where the app's exact words are quoted, copy them character for character from the ruling that settled them.

## After the draft, in the same file under a line `---` and the heading `### Notes for the coordinator (not for the page)`
Anything you were unsure of (with the ruling or FR number), anything in the page's EARLIER parts that the round has now made untrue (quote the sentence and say which part), and any of the page's 27 open decisions that the round has settled or changed.

## Final message to the coordinator
At most 120 words: that the file is written, its word count, and the three most important notes.
