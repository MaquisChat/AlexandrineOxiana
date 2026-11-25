## 14. Added on 25 November: every screen gives up politely, and the move refuses a leftover folder

After build request 13, two more pieces were built for the next Mac build (build request 14). The first: nearly every screen that gets no answer from the app's own service now gives up after twenty seconds, as part 13's five screens do. The second: "Move library" refuses a folder holding the leftover copy of a move that did not finish, and says why. Reviewers who had not built the work tried to break it: the screens through three reviews (sent back once), the move through two (the first rejected an earlier version). I read the last mends of each piece myself.

[WHERE IT STANDS]

### What you will notice

**A. The other screens no longer wait for ever**

These screens now give up too: the governance screens (the project's rules, the audit log, fieldwork), "Your library", Search sources, Optional tools, the extension's pairing, your name as researcher, the transcript viewer, the reader, capture, the import wizard, the review queue, a source's detail panel, the new-project dialog and the appearance settings. They say "The library service did not answer in time." with "Try again", or, where the request could not be made at all, "The library service could not be reached." Each page shows one sentence and one "Try again", which reads again everything still missing.

What is new or different on some screens:
- **The audit log** now says "Reading the audit log…" while it reads.
- **The reader** says, under the heading "Library service did not answer": "The library service did not answer in time, so this PDF cannot be shown. Try again in a moment." Its button stays "Open again". For a PDF, only the START of the answer has the limit: once the file has begun to arrive, it is never cut off, however slowly it comes.
- **The import wizard** says "The import could not be read. The library service did not answer in time." If the project's rules could not be read, the Options step now says why its options are fixed: "This project's rules could not be read, so the strictest options are used. Try again to read them."
- **The new-project dialog:** "Create project" pressed again reads the projects first, so nothing is created twice.
- **Nothing unread can be saved over:** your name's field stays off until it is read, and a source's "Edit details" and "Recheck" stay off until its details are read.
- **The transcript viewer** leaves the Version box empty when its versions could not be read; it no longer says "No transcript yet".
- **The list of libraries** says "No libraries yet" only when it was read and is empty.

**Missing files has no limit, on purpose:** its check reads a sample of your files, which can rightly take longer, and "Try again" would start it over.

**B. "Move library" refuses a leftover folder**

This is only for a move that stopped before the switch, leaving an unused copy at the new place.

- **After such a stop, the Move dialog says:** "The move stopped before the library was switched. Nothing of the library was deleted, and it stays where it was. The copy made at {new folder} is not used and can be deleted. To move the library, choose another, empty folder."
- **If the library's own folder could not be written to,** it does not send you to another folder, where the same would happen: "The move stopped before the library was switched, because the library's old folder could not be written to ({cause}). Nothing of the library was deleted, and it stays where it was. The copy made at {new folder} is not used and can be deleted. Free space or restore access at the library's folder before moving the library again." ({cause} is "the disk is full", "permission was refused" or "the disk can only be read".)
- **Choosing that folder again is refused,** by the dialog's check and by the app's engine itself; nothing there is ever copied over or deleted. Where the app can prove the folder is only a leftover: "The library cannot be moved there. That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first." Where it might hold the library, deleting is never advised: "The library cannot be moved there. That folder holds a library whose move there has not finished. Choose another, empty folder. To finish that move, open the library at that folder."
- **The dialog now shows why a folder is refused.** Before, it said only "The library cannot be moved there." A folder that is simply not empty reads: "The library cannot be moved there. The destination folder is not empty; choose an empty folder"
- **The leftover folder, opened, says what it is:** "Read-only — this folder holds the copy of a move that did not finish. The library is still at {library's folder}, and nothing here is the library. This folder can be deleted." If the library's folder cannot be seen (an unplugged drive), it says as before: "Read-only — a move into this folder has not finished. Changes are off."

This replaces part 12's note on FR-068 and part 13's paragraph on it.

### What became safer underneath

- **The screens:** only readings have the limit; saving, attaching, starting an import, creating a project or accepting a match never do, so "Try again" never starts anything twice. A reading given up is cancelled, and a late answer changes nothing.
- **The move:** the dialog's check and the move itself decide by one rule. A stopped move is carried on only for that very move, from the library's own folder, on this computer; anything else is refused with nothing written.
- **The move:** its mark in the old copy now carries the move's own number, so another move's mark is never taken for it. A resumed copy refuses shortcuts (symbolic links) before writing, so it never writes outside the folder.
- **The move:** a leftover folder no longer warns, untruly, that its change log was "changed outside the app".

[FR-757]

The reviews caught these on the way:
- on capture, a list that got no answer removed the screen, losing what you typed;
- a governance page could show two sentences and two "Try again";
- governance could say "The project named in the address is not in this library" of a list never read;
- "No transcript yet" was shown for versions never read;
- the import wizard used the strictest options without saying why;
- the review queue's one-sentence rule had no test;
- the first version of the move fix could make a stale copy the library, without your later changes; it was rejected and rebuilt;
- a refusal advised deleting a folder that might be the library;
- after a full disk at the library's folder, the dialog sent you to another folder, to fail again.

### Things only you can check in the next Mac build

- [ ] Use the screens named in A as usual. Nothing should look different. If you ever see "The library service did not answer in time.", press "Try again" and tell me where.
- [ ] Open a large PDF, ideally from an external drive. It should open, even slowly, and never say "Library service did not answer" while it arrives.
- [ ] In "Move library", choose a folder that holds something and press "Check destination". It should say "The library cannot be moved there. The destination folder is not empty; choose an empty folder", and nothing about a move that stopped.
- [ ] If you still have a folder left from a move that stopped in an earlier build, choose it in "Move library": it should be refused with one of the two sentences in B. Opened, it should say it is not the library.
- [ ] Part 13's list still applies, with the checks of part 12 it names.

### Still open

This list replaces part 13's "Still open".

**FR-756's leftovers (unlikely to meet):**
- **Missing files** needs a check that shows its progress.
- **Two live connections** (governance's and the reader's) do not reconnect by themselves. Very unlikely.
- **Four untidy but true points:** the page's sentence can appear inside a source's panel; the chooser's words about a refused list can vanish after you act; a held file's own message is hidden while its re-read gets no answer; on Find and acquire, a source's panel can repeat the screen's sentence. Rare.

**Earlier (unlikely to meet):**
- **FR-755:** a finishing cut short by Quit leaves its message missing; after a move of some projects, the library they left does not say where they went.
- **"Look up again":** your press can wait behind the automatic pass; while a project is locked, another project's attach may ask its service early.

**Listed, not built:**
- **FR-757:** a test of Find and acquire that fails now and then on GitHub. Being mended.
- **FR-760:** two small points of the move, older than this work; nothing is lost.
- **FR-759:** locking an encrypted project during an attach's lookup may leave one answer in memory. You would not see it.
- **FR-753, FR-758, FR-762:** small corners you would not see. **FR-761:** whether the audit log can show events out of order; to be checked.
- **FR-751, FR-754:** two sentences to correct (a destruction certificate after a crash; a backup warning that points to a missing button).
- **FR-752:** in an encrypted project, a source's title is readable in its folder name. Still being checked.

---

### Notes for the coordinator (not for the page)

**Unsure, or not finally built**
1. **FR-757:** no `task-FR757-report.md` existed when I finished (only `task-FR757-ci289-log.txt`). The `[FR-757]` line is a placeholder, and the "Still open" FR-757 line says "Being mended."; change both once the report exists.
2. **Review counts.** I counted FR-756 as three reviews (R605 + its second look R617; R623 for the remainder) and FR-068 as two looks by one reviewer (R607 rejected the first version; R612 approved the strict one). Mends after R612 and R623 were read by the coordinator (R619, R624), not reviewed. Check this matches how part 13 counted.
3. **The ordinary "not empty" sentence has no final full stop** (mend report R612, uncertain 5: "older than this work"). I quoted it exactly, without one. The owner may find it odd in the check-box.
4. **The leftover folder with the library's folder unreachable** (mend report, uncertain 3, not ruled): besides the general banner, the opening still gives the finishing's note "…could not be finished now because its old copy at {place} cannot be reached. Connect the drive…", although once the drive is back the folder would be judged stale and still not finished. Not on the page; consider a Still-open line.
5. **The reader route** says "so this PDF cannot be shown" even when the reading given up was the source's, not the PDF's (R605 M9, accepted). Not on the page.
6. **Which screens "give up"**: I wrote "nearly every screen". Missing files is the known exception; reads inside the choose-person and choose-works dialogs are out of scope (R601 c); side readings are given up silently. The move screen has no first read (FR756b report 1f).
7. **"The two live connections"** are my plain reading of R624's "the two streams without a reconnect" = the governance route's and the reader hand-off's streams (remainder report, "Listed, not built"). Check.
8. Capture: a FAILED list (not only one given up) with a project in the address also no longer says "not one of this library's projects" (R613, accepted). I wrote "got no answer", which covers both.
9. "Each page shows one sentence and one "Try again"" (A) has one known exception: on Find and acquire a source's panel has no page host and can show a second alert with the same words (R623, listed; it is in "Still open" as an untidy point). The part is 1,622 words, a little over the 1,600 aim; FR-755's and "Look up again"'s leftovers from part 13 were kept so that nothing drops off the replaced list.

**Sentences elsewhere on the page that this work makes untrue or stale** (10)
1. Top of the page, "*Updated 25 November 2026, just after midnight Central: part 13, at the end, is new…" — needs a new line for part 14 and build 14.
2. Part 2, decision 12, "**What it is:** If a request never gets an answer, a screen's first read can stay at "Reading…" for ever…" — its note "(…The other screens follow.)" is now done, except Missing files. Its options ("give up after a time and try once more by itself") differ from what was built (give up and offer "Try again"); the decision may now be moot, and "**My recommendation:** First note on your Mac…" too.
3. Part 4, "- [ ] Note whether any screen ever stays at "Reading…". (FR-575, FR-595) *(Part 13 says which screens…" — should point to part 14 too.
4. Part 9, "- [ ] **1. Install Mac build 13** (part 13 says where…" — stale once build 14 exists.
5. Part 12, "Still open", "- **FR-068 (added 24 November, 9:20 pm Central; CORRECTED…" — "the copy it made stays at the new place, unused, and nothing says so" is now untrue; needs a "(superseded: part 14, B)" note.
6. Part 13, "The same check then ran once more on the build request itself… a builder is finding the cause now" — stale once FR-757 is mended.
7. Part 13, "Still open", "- **The same "never wait for ever" fix for the other screens (FR-756).** Built for the governance screens…" — now built and in build 14; "Until then those screens can still sit at their loading words" is no longer true except Missing files.
8. Part 13, "Still open", "- **Moving into a stopped move's folder (FR-068).** Built, and approved at its second review…" — now in build 14. Also not quite true as built: "The leftover folder, when opened, will say … that it can be deleted" holds only where the library's own folder is seen; and "or delete the leftover one first" is not what the dialog says in the second refusal case.
9. Part 13, "Still open", "- **FR-756:** the list of libraries can show "No libraries yet" beside "could not be reached"…" — mended (remainder item 6).
10. Part 13, "Still open", "- **FR-757:** a test of Find and acquire failed once…" — stale already (R622: it failed GitHub's check, from a real request to arxiv.org); replaced by part 14's list.

**Sources that contradict each other** (the later ruling wins, and I followed it)
- **The refusal's sentence:** R607 (a) gave "…or delete that folder first." to every refused case; R610 (1) kept it only where the old place is the living library; R612 I-A widened it to marks of another library or another move, and gave the rest the "To finish that move, open the library at that folder." sentence. Built per R612 and R619. The strict report's first section ("In every refused case: … The reason is 'That folder holds the copy…'") describes the superseded state; its "Mend round" table is the final one.
- **The cause sentence:** R612 m-A's wording ends "Free space or restore access there before moving the library again."; the builder changed "there" to "at the library's folder" (allowed by R612, confirmed in R619). The page quotes the code.
- **Missing files:** the builder recommended a two-minute limit (FR756b report 1e); R601 (a) ruled no limit. The page follows R601.
- **The reader's new sentences** were "accepted subject to the review's check" in R603; R605 M9 accepted them. No conflict in the end.
- **Part 13's FR-068 paragraph** says "You choose another, empty folder, or delete the leftover one first." This contradicts R610 and R612, where a folder that might be the library is never called deletable.
- **Test counts differ** (R617 says 39 files, 981 tests; the fix report says 39 files, 929). This is not on the page.
