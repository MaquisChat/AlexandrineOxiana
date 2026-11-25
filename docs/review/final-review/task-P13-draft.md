## 13. Added on 24 November, late evening: the move finished safely, screens that no longer wait for ever, and "Look up again"

After build 12, three more pieces were built for the next Mac build (build request 13). The first mends the fault I told you about at 7:30 pm. A "Move library" that stopped at its very last steps left the library read-only for good. Now the move is finished when you open the library at its new place. The second: a screen that gets no answer from the app's own service no longer waits for ever. After twenty seconds it says so and offers "Try again". So far this covers Find and acquire, Watched folders, Zotero sync, the opening screen and the library screen. The third is your decision 31 (c), "Look up again", built with my recommendation for each of its four choices, since you did not change them. Reviewers who had not built the work checked each piece and tried to break it. The move fix went through three reviews. Find and acquire's part went through one. The opening screen's went through two. "Look up again" went through four: two for the part that does the lookups and two for the screen and what drives it. Every piece but Find and acquire's was sent back at least once before it was approved.

[WHERE IT STANDS]

### What you will notice

**A. "Move library" when it stops at the very end**

A normal move is unchanged. What follows is only for a move that stops after the copy was checked and while the library was being switched to its new place. That happens if a step fails then, or if the app is killed or the Mac goes down in those last moments.

- The move does not carry on with the library half-switched. The library is closed, and the Move dialog says: "The move did not finish, so the library has been closed. Open it at its new place, {new folder}, and the move will be finished then; nothing is lost." ({new folder} is the folder you chose.)
- If the move was taking only some projects to a new library, it says: "The move of the projects did not finish, so the library has been closed. Open the new library first, at its new place, {new folder}: the move will be finished then. Until then the library they came from opens only read-only; after that it opens again for the projects that stayed. Nothing is lost."
- When you open the library at its new place, the move is finished first. The same happens when the app reopens that library at its start. First the app checks every file at the new place again against the move's own record. This takes as long as the move's own check did, roughly one to two minutes per 10 GB on an external drive. The opening waits for it. Then, shown once: "The move of this library to this folder had not finished. It was finished when the library was opened here; nothing was lost."
- If it cannot be finished yet, the library opens read-only and says why, for example: "The move of this library to this folder has not finished, and it could not be finished now because the disk is full. The library is open read-only, and both copies are kept; opening it again will try again." Other versions name other causes: the folder cannot be written to; the library is open in another program or on another computer; a step failed; the old copy's drive is not connected; or a newer version of the app saved the library.
- If files at the new place were changed by hand since the copy was checked, the move is not finished. The library opens read-only and says how many files no longer match, and whether the old copy is still whole. Where the app cannot finish a move at all (its record is damaged, or something was changed by hand), the warning ends: "Both copies are kept as they are, and this library is open read-only. Tell the developer before changing or deleting either copy."
- If you open the old place of such a move instead, it is read-only and names the new place: "Read-only — this is the old copy of a library whose move has not finished. Open the library at its new place, {new folder}, and the move will be finished then; nothing is lost." The old copy of a move that did finish says, as before: "Read-only — this is the old copy of a library that was moved. Changes are off." It says this also while the new place's drive is unplugged.
- An old copy cannot be deleted while its move is unfinished: "The move of this library has not finished, so its old copy cannot be deleted yet. Open the library at its new place first; the move is finished then." Nor while the new place cannot be reached: "The old copy cannot be deleted now: the library's new place cannot be reached, so the app cannot tell whether its move has finished. Connect the drive the new place is on and try again."

**B. Screens that got no answer**

- On Find and acquire, Watched folders and Zotero sync, a screen whose first reading of the library gets no answer within twenty seconds says: "The library service did not answer in time." Below it is a "Try again" button that reads again what is missing. Before, Find and acquire could stay at "Reading the projects…" for ever.
- Where the request could not be made at all, the screen says, as before: "The library service could not be reached." It now has the same "Try again".
- A screen shows one of the two sentences at a time, never both, and one "Try again".
- The opening screen ("Connecting to the library…") gives up after twenty seconds too. It then shows only "The library service did not answer in time." with "Try again". It does not show the list of libraries, because the app does not yet know whether a library is already open. The list of libraries ("Loading libraries…") gives up after twenty seconds in the same way.
- In the library itself, "Loading projects…" and "Loading sources…" give way to the same sentence and "Try again". So does the side panel's list of collections and tags.
- Whatever is still missing is also read again by itself as soon as the screen's connection to the service opens anew.
- A refusal the screens already explained, for example a locked project, shows its own sentence as before, with no "Try again".

**C. "Look up again"** (your decision 31 (c))

This is for entries in the review queue that came in while a lookup service said "too many requests" (the line "Waiting for lookup service response." from build 12). It also covers entries whose lookup failed outright, for example with no network, from now on.

- **By itself:** while the library is open, waiting entries are looked up again at the opening, when an encrypted project is unlocked, and every ten minutes. They are taken one at a time. No service is asked before the time it named. Each lookup is tried by itself at most five times: about 15 minutes after the attach, then 1, 4, 12 and 24 hours after the try before (or later, if the service names a later time).
- **By hand:** an entry that still has something to look up has a "Look up again" button at the end of "Why it needs review". Before the service's time the button is off and reads "Look up again (after {time})". It turns on by itself when the time comes. While it works it reads "Looking this up again…".
- **What the entry then says** (word for word):
  - while still waiting: "Waiting for lookup service response."
  - under the matches, while nothing has been asked yet: "Not looked up yet: the lookup service asked to wait."
  - found: "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one."
  - where the match came from an identifier found in the file, added: "The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first."
  - nothing found: "The lookup service has now answered, but it found no match for this item."
  - the project's rules no longer allow it: "This project's rules no longer allow this lookup, so it was not looked up again."
  - after five tries that were all told to wait: "The lookup service asked to wait each time it was tried ({n} tries), so the app has stopped trying by itself. You can still use Look up again."
  - a lookup that failed outright, under the matches, whatever else is shown: "Not looked up: a lookup service could not be reached. You can use Look up again." Where this shows, "No candidate matches were found." does not.
- An entry can have several lookups. It shows every sentence that is true of it, each once.
- New matches are added after the ones already shown. **Nothing in the record changes until you press "Use this match"** (or decide the entry another way), and the match you press is the one accepted.
- A queue you have open does not refresh by itself when the automatic pass adds matches. You see them when you open the entry again.

### What became safer underneath

- **The move:** a move is finished only if every file at the new place still matches the move's own record. The change logs at the new place must begin with exactly what was checked, so a log emptied or cut short by hand stops the finishing. Every mark the move left in the old copy must still be there. When the finishing refuses, both folders are left exactly as they were.
- **The move:** a copy of the new folder made by hand is never finished as if it were the library. Once any part of the old library is marked as moved, a late failure closes the library, so nothing more can be written into a copy that is about to be left behind. After a half-finished move of some projects, the library they came from opens read-only until the new library has been opened. So a backup that runs at the opening cannot block the move.
- **The screens:** a reading that was given up is cancelled, and a late answer changes nothing. Only readings have the limit; a move, an import or an export never does.
- **"Look up again":** each request to a public service is written into the project's change log before it leaves, with ids and counts only, never a title. Each look-up reads the entry again just before it writes, so an entry you have already decided is never reopened. Only one look-up of an entry runs at a time; a second press sends nothing.
- **"Look up again":** a service that asked to wait is now held back also after the library is closed and opened again, after the app is restarted, and when an encrypted project is unlocked. **This closes part 12's open item on decision 31 (b)**, where after a close and reopen one request could go early.
- **"Look up again":** nothing a look-up brought back stays in memory after an encrypted project is locked. The automatic look-ups stop at a move or a close.

The reviews caught these on the way:
- after a move of some projects that failed late, the old library could still be written to, and a change made there would have been left behind;
- a file removed by hand at the new place, days later, and the move would still have been finished with "nothing was lost";
- after a move of some projects that stopped part-way, simply quitting and starting the app could leave the move stuck for good;
- a change log emptied by hand at the new place would not have been noticed;
- the screens called a service that was only slow "could not be reached" (so there are now two sentences), and a stale "did not answer in time" followed you to the next project;
- the opening screen's own browser test was unreliable;
- two look-ups of one entry at once could turn a "found" back into "waiting";
- after a close and reopen, a service that had asked to wait was asked again too early;
- a late answer stayed in memory after an encrypted project was locked;
- a lookup that failed outright was never mentioned beside one that answered, so the screen said "No candidate matches were found.", which was only partly true;
- a double press sent the same requests twice.

### Things only you can check in the next Mac build

- [ ] Move a library to a new, empty folder, as usual. The move should finish without any new message. The library should open at its new place, and you should be able to change something there. If you open the old folder, it should say "Read-only — this is the old copy of a library that was moved. Changes are off."
- [ ] If your review queue still holds entries from build 12 that read "Waiting for lookup service response.", open the library and leave it open for a while (up to half an hour). Each such entry should change by itself: it shows matches with "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one.", or says it found no match. Check that the record itself has not changed until you press "Use this match".
- [ ] Turn Wi-Fi off and attach a PDF. Its entry should say, under the matches: "Not looked up: a lookup service could not be reached. You can use Look up again." Turn Wi-Fi back on. After a few minutes the entry should still say the same, because failed lookups are not retried by themselves. Then press "Look up again": the sentence should give way to matches, or to "The lookup service has now answered, but it found no match for this item."
- [ ] An ordinary entry that has nothing waiting should show no "Look up again" button.
- [ ] Use Find and acquire, Watched folders and the opening screen as usual. Nothing should look different. If you ever see "The library service did not answer in time.", press "Try again", and tell me where it happened.
- [ ] The checks of part 12's list still apply to this build (Cmd-Q and the Dock's Quit, Bulk Import closed and resumed, "Speech model: tiny").

### "Look up again": the four choices, as built

You had these since 4:25 pm, with my recommendation as what is built unless you said otherwise. You did not change them, so each is built as recommended. Each can still be changed:

31c-1. **Automatic, or by hand only**
   **Built:** (a) both. Waiting entries are looked up by themselves while the library is open, and with the "Look up again" button.
   **To switch later to by hand only:** very small, a one-line change.

31c-2. **May a later answer fill a record by itself?**
   **Built:** (a) never. It stays a suggested match until you accept it.
   **To allow it later for a perfect match:** a real piece of work, a new way of writing a record that would need its own review.

31c-3. **"Look up again" before the service's named time**
   **Built:** (a) the button waits. It is off and says when it can be used.
   **To switch later to "one request at once, as your own act":** small, two edits.

31c-4. **Lookups that failed outright** (for example, no network)
   **Built:** (b) kept from now on and offered by hand only. They are never retried by themselves.
   **To switch later to also trying them automatically:** very small, a one-line change.

### Still open

This list replaces part 12's entries on FR-755, FR-750 and decision 31 (b). The rest of part 12's list stands.

**Being built beside this build, not in it:**
- **The same "never wait for ever" fix for the other screens (FR-756).** Built for the governance screens, "Your library", search sources, tools, the extension's pairing, the researcher's name, the transcript viewer, the reader, capture and the import; a review sent it back and it is being mended. A last small piece follows (the review queue, a source's detail, a new project, the appearance settings). Missing files gets no time limit, since its check rightly takes long; it needs a check that shows its progress. Until then those screens can still sit at their loading words if the service never answers. Seen only in the test browser, never on a Mac.
- **Moving into a stopped move's folder (FR-068).** What will be built: if you ask to move the library into a folder that holds the copy of an earlier move that did not finish, the app refuses and says so. Nothing is copied over or deleted there. The leftover folder, when opened, will say what it is: that it is not the library, and that it can be deleted. This replaces the last sentence of part 12's FR-068 note. Running the move again into the same folder will not be offered. You choose another, empty folder, or delete the leftover one first.

**Left over from this round (unlikely to meet):**
- **FR-755:** if the opening that finishes a move is itself cut short (by Quit), the move is finished but its message is missing. After a move of some projects, the library they came from does not say where they went (the Move dialog does).
- **"Look up again":** your press can wait behind the entry the automatic pass is busy with, minutes at worst. While an encrypted project is locked, the times its services named are unknown, so an attach to another project may ask such a service early.
- **FR-756:** the list of libraries can show "No libraries yet" beside "could not be reached" when it was not read.

**Listed, not built:**
- **FR-759:** locking an encrypted project while an attach's lookup is still out may leave that one answer in memory. It is mended for "Look up again"; for an attach it is still to be checked. You would not see it.
- **FR-753:** two small corners of the hold on a service: one request can go early when answers arrive out of order, and a file can wait a moment longer than needed. Nothing is lost.
- **FR-757:** a test of Find and acquire failed once; it may hide a rare case where a service is asked a little before its time. Being looked into.
- **FR-758:** in a case the app does not reach today, the time of the last real try is not recorded. Cosmetic.
- **FR-751:** a destruction certificate can say a backup "was not removed by the app" when it was. Only after a crash at that very step; a wording to correct.
- **FR-752:** in an encrypted project, a source's folder name and one of its files hold its title in plain text. Still being checked: as designed, or a gap. You would only see it by looking inside the library folder.
- **FR-754:** the "automatic backup failed" warning says "make one now from the project's settings", but no screen offers that. You would meet it only if an automatic backup fails.

---

### Notes for the coordinator (not for the page)

**Unsure, or not finally built**
1. "Look up again", the service and page: R608 approved them on condition of three mends (n1, n2, n3), with no further look. Only n1 is on `d31c-service-page` (28328bf, "a refused lookup no longer says it could not be reached"). I found no commit for n2 (a watched folder's bring-in at opening waits for the holds) or n3 (the pass skips held entries without reading). R609 says the branch is merged for real only once all three are in. The draft assumes all three are in and joined. If they are not, the "What became safer" line on holds still stands, but check the "caught" list.
2. 31c-3's "two edits" to switch is from the first review's part E, written before R600 I1. Since then the carried hold (`holdUntil`) also makes a press answer "not yet". Switching to "at once" may now need more than two edits (the press would have to bypass the client's hold). I kept "small, two edits"; please confirm or soften it.
3. The "Turn Wi-Fi off and attach a PDF" check assumes that a macOS offline error counts as "failed outright" (design T1, `why:"failed"` from `resolve.ts:402`). It also assumes the file then goes to review with the failed lookup kept. Not proved on a Mac. If the attach also leaves a lookup "waiting", that entry would show both sentences.
4. The tries schedule (15 min, 1, 4, 12, 24 h; five tries) is from `task-D31c-engine-report.md` §4. Its line "Researchers' tries count in `tries` too" was undone by R585 M3 and R592: presses never count. The draft says only "tried by itself at most five times".
5. The move sentences are quoted from `kg-join` (`StatusBanner.tsx`, `shared/src/api/library-move.ts`, `move.ts:1400-1404`), not from the report alone. The disk-full sentence's ending was changed by R583 M4; the report gives only the new ending, and the full sentence is from the code. I wrote "{new folder}" where the code has `{newRoot}`/`${v.newRoot}`, as part 11 wrote "{file}". The files-differ sentence is built with `files(n)`, so I described it rather than quoting it.
6. FR-756 first piece: R609's N1–N4 are "ruled to FR-756's remainder"; I listed N1 and N2 for the owner. Whether the stream's opening limit is on for Find, Watched folders and Zotero in this build is from the FR756a report's "After R597" (63612e2). I assumed it is part of 8063f77, which is joined.
7. FR-068's planned words (R607 (a), (d)) are ruled but not built or reviewed, so I did not quote them, as briefed.
8. The "4:25 pm" time for the four choices is from R577 ("the owner has had them since 4:25 pm Central").

**Sentences elsewhere on the page that this work makes untrue or stale (10)**
1. Part 2, decision 12 ("Screens that wait for ever"): "The app has no give-up." This is no longer true for Find and acquire, Watched folders, Zotero sync, the opening screen and the library screen.
2. Part 4, line 243: "Note whether any screen ever stays at 'Reading…'." Partly stale for those screens; the box could point to part 13.
3. Part 11, "Still open": "**Tests only:** FR-747 and FR-750 are three tests that failed once … they are watched, not changed." FR-750 turned out to be a real weakness of the screen (R574, R579) and is now mended.
4. Part 11, decision 31 "Decided" paragraph: "nothing looks such a record up again by itself yet …; until then you complete the record by hand". It is qualified by "until (c) is built", but is now superseded.
5. Part 11, "Still open", decision 31 line: "(c), 'look up again', is the piece after it." Now built.
6. Part 12, "Decision 31 (c): four choices", ending "I build my recommendation for each unless you say otherwise before the build starts." Now built; part 13's section supersedes it.
7. Part 12, "Still open", FR-068: the last sentence, "The fix being built … lets you run the move again to the same folder (it copies and checks again) …". This is UNTRUE since R607: the copy-again path is taken out, and the engine refuses such a folder. Part 13 says so in one sentence; part 12's note itself should get a pointer.
8. Part 12, "Still open", FR-755: "today the app has no way to finish such a move … The fix, being built now … Until that build: … stop and tell me". Superseded by part 13 A.
9. Part 12, "Still open", FR-750: "can sit at 'Reading the projects…' … when its very first requests fail". The cause was corrected by R579 (reads that never settle, not reads that fail), and it is now mended.
10. Part 12, "Still open", decision 31 (b): "the hold on a service is kept in memory, so after the library is closed and reopened one request can go early. Until (c) is built, nothing looks a waiting record up again by itself." Both halves are closed by this build (R600 I1, R606, R608).
(Also the header line 5, "it has four small choices for 'Look up again' and asks whether I may merge": historical, not untrue. Part 12's sentence "A service that asked to wait is left out for every file until the time it named" is still true, and now also across reopenings.)

**Sources that contradict each other (the later ruling wins)**
- FR-755's sentence: R573 said a late-failed move "is completed when the library is opened again (the journal's resume)". R578 found this false and ruled that the opening of the new place finishes it. Part 12's 7:30 pm correction follows R578.
- FR-755's split sentence: R588 has "Open the new library at its new place … The library they came from can be opened again for the projects that stayed; nothing is lost." R590 N1 replaced it with "Open the new library first … Until then the library they came from opens only read-only …". The code has the R590 form; the draft uses it.
- FR-755 words for an old copy whose new place cannot be read: as first built (R590 N4) it said "has not finished". R596 (b) corrected it to the plain "moved" words; the code follows R596.
- FR-755, which audit-log lines the finishing may write itself: R588 (a) allowed audit logs on presence alone. R590 N2 overruled that (the "begins with what was verified" rule), and R599 M-1 widened it to `audit.anchor-missing` and to the library's own log.
- FR-750's sentence: R579 ruled one sentence, "could not be reached", for a read given up. R586 M5 corrected this to two sentences ("did not answer in time" for a give-up). R602 M1 then ruled one sentence per screen, "could not be reached" winning in a mix, and R605 I2 extended that to the whole page.
- FR-750's cause: R574 said a first read that FAILS leaves the screen waiting. R579 corrected it to a read that never settles.
- FR-068: R599 (2) ruled "copy again into the stale folder". R604 (c) corrected the severity and what the owner was told. R607 withdrew the copy-again path: the engine refuses. The draft follows R607.
- "Look up again", failed lookups: the design (§4) proposed "A lookup service could not be reached."; R577 ruled "Not looked up: a lookup service could not be reached. You can use Look up again." The service-and-page report says it is shown only when "failed" is the only state; R600 I3 ruled it shown whatever the state, and R608 n1 narrowed it to failures with no later outcome.
- "Look up again", tries: the engine report says a researcher's presses count as tries; R585 M3 and R592 say they never do.
- 31c-3's cost to switch: see Unsure 2 (the review's part E predates R600 I1).
