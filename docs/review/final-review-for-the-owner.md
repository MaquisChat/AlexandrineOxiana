# The final review — what I need from you

*Updated 24 November 2026, 7 pm Central: MAC BUILD 12 EXISTS — GitHub gave the build a Mac this time and every check passed, the test of Quit among them. Part 12 says where to download it. It replaces build 10.*

*Updated 25 November 2026, 11:37 am Central: part 15, at the end, is new and short — build request 15 (after a stop nothing more is asked; after a lock nothing about the project stays in memory) passed GitHub's check and **is merged to `main` on your word**. It also tells you two things that are yours to decide. **There is still no Mac build of build 14 or 15** (GitHub gives no Mac during the day; I ask again this evening) — Mac build 13 remains the build to use.*

*Updated 25 November 2026, 8:45 am Central: part 14, at the end, is new — nearly every screen now gives up politely when the app's service does not answer, "Move library" refuses a leftover folder and says why, and a stopped download asks nothing more. Build request 14 passed GitHub's check and **is merged to `main` on your word**. **Mac build 14 does not exist yet** (GitHub has not provided a Mac; I keep trying) — Mac build 13 remains the build to use. Start at part 14.*

*Updated 25 November 2026, just after midnight Central: part 13, at the end, is new — the move fix, the screens that no longer wait for ever (the first five), and "Look up again" are built, reviewed, tested together and pushed as build request 13. **Mac build 13 exists and replaces build 12** (part 13 says where). It asks whether I may merge. Start there.*

*Updated 24 November 2026, evening: part 12, at the end, is new — closing the library safely (FR-749) and your decision 31 (b) are built, reviewed, tested together and pushed as build request 12; it has four small choices for "Look up again" and asks whether I may merge. Start there.*

*Updated 24 November 2026, mid-afternoon: the known-gaps round is merged to `main` on your word, and decision 31 is decided ((b) now, (c) next); part 11 says so.*

*Updated 24 November 2026, later: part 11, at the end, is new — the known gaps of part 10 are built and pass GitHub's check, but there is no Mac build of them yet: GitHub has not given the build a Mac. Build 10 stays the build to use. Start at part 11; it also has a new decision (31).*

*Updated 24 November 2026: part 10, at the end, is new — the 94 rough edges are fixed and come to you as Mac build 10. Start there.*

*Updated 17 November 2026: part 6, at the end, is new — four more decisions (22–25) after the last review of the whole branch.*

*15 November 2026. How to answer: reply in the chat with the numbers of part 2 (for example "1: no author; 4: 12 characters; 13: keep the check") and a yes or no to part 3. The checklist of part 4 needs a new Mac build and can wait for it.*

## 1. Where things stand

- All the app's features are built on the working branch. Everything was tested on Linux; nothing of the newest feature (Find and acquire) has run on a Mac yet.
- Along the way the project's reviews set aside 616 small points for a final review. They are now sorted.
- 7 are real problems, being fixed now: (1) reasons you type in an encrypted project were readable in its change log; (2) a file waiting for your check could be dragged onto a source from inside the library's own folder, skipping the check; (3) in the review queue a quick double press could decide the next entry unseen; (4) signing out of your library could say "done" while the sign-in window stayed signed in; (5) names of collections, tags and consent texts in an encrypted project are readable without the passphrase (a note is being added; sealing them is your decision, part 2); (6) pausing a recording just as its access renews was ignored and it started playing again; (7) a BibTeX file with a line starting with "@" inside an abstract lost the rest of that entry without a warning.
- 16 missing tests are being added. The 94 small rough edges are fixed (24 November; part 10). 83 points are yours (parts 2 and 4). 386 are left as documented notes. 29 were already settled.

## 2. Decisions I need from you

### Privacy and data

1. **Author name on your annotations**
   **What it is:** When you highlight or note in the PDF reader, the app stores your computer's account name as the author. That name is also written into a project export's byline. For many people it is their real name. The setting for a display name was never built.
   **Your options:** (a) annotations carry no author; (b) you type a name once in Settings and that is used; (c) no author unless you have typed a name in Settings.
   **My recommendation:** (c): nothing of yours goes into an export unless you put it there. Until you choose, your computer's login name goes into exports.
   <sub>(FR-591, FR-138)</sub>

2. **Names inside an encrypted project**
   **What it is:** The names of an encrypted project's collections and tags, and the text describing what a consent covers, are stored in the readable part of the project — anyone who gets a copy of the folder can read them without your passphrase. The same holds for the reason you record when you make an exception to the project's rules, and the approver's name you give with it: they are kept in the project's rules file. I am adding a note that says so wherever you type such a name or reason. Sealing them as well is possible but is a larger change (it affects what the app can show while a project is locked, and the form of the rules file).
   **Your options:** Seal them as well (all of them, or only the exceptions' reasons and approvers), or keep the notes and leave them readable.
   **My recommendation:** Decide after you have used an encrypted project for real; the note is there meanwhile.
   <sub>(FR-053)</sub>

3. **The project's own name**
   **What it is:** An encrypted project's name stays readable, both inside the project and as its folder name, so that a locked project can be shown by some name.
   **Your options:** Accept that and say so in the guide; or give encrypted projects neutral folder names.
   **My recommendation:** Accept it and say so in the guide (the guide's sentence is being added with the note of decision 2). A neutral folder name makes your own folders harder to tell apart.
   <sub>(FR-238)</sub>

4. **Passphrase strength**
   **What it is:** An encrypted project accepts any passphrase, however short; neither the dialog nor the service sets a minimum.
   **Your options:** A minimum length (for example 12 characters), a strength meter, or knowingly none.
   **My recommendation:** A minimum of 12 characters, said plainly in the dialog. It is a small change and a short passphrase is the weakest point of an encrypted project.
   <sub>(FR-197, FR-198, FR-199)</sub>

5. **How far the change log can be trusted**
   **What it is:** The app keeps a chained log of changes. A change correctly chained and added while the app is closed is believed when the app next opens; a reviewer forged a "destroyed" entry that way. Also, after the project's identity is renewed, a lost marker of the old log is no longer reported.
   **Your options:** Pay for a stronger log (a keyed chain, or a marker kept outside the library), or accept this and document that someone with access to the folder and the know-how can forge entries.
   **My recommendation:** Accept and document it for now. The stronger log belongs with the signed checkpoints already planned for a later phase (decision 16); it matters most when a library is shared or synced, which is not built yet.
   <sub>(FR-369, FR-403)</sub>

6. **Reopening the library after an interrupted change**
   **What it is:** If an interrupted change cannot be settled because its log marker is missing or does not match, the project stays blocked until the library is closed and opened again.
   **Your options:** Confirm that "reopen the library" is an acceptable step for a researcher, or ask for a button that unblocks it.
   **My recommendation:** Accept the reopening: the case is rare, and the screen already says what to do.
   <sub>(FR-171)</sub>

7. **The browser extension's link to the app**
   **What it is:** The extension sends its secret pairing code to whatever program answers on its saved local port. It cannot tell the app from another program on your computer.
   **Your options:** Have the extension first check a proof from the app (more work), or accept the limit (only programs running as you could exploit it).
   **My recommendation:** Accept the limit for now. A program already running under your account can do far more than this; and what the code allows is limited (capturing pages, and sending a PDF that then waits for your check).
   <sub>(FR-356, FR-372)</sub>

### Behaviour

8. **Which date a capture note shows**
   **What it is:** A note added with a capture uses this computer's date, not the date in the project's own time zone, which the project's rules say should govern. It differs when you work away from the project's zone.
   **Your options:** The project's date, or this computer's date.
   **My recommendation:** The project's date, as everywhere else in the app.
   <sub>(FR-388)</sub>

9. **What "Copy citation" copies**
   **What it is:** The button copies the in-text form (author and year in brackets), not an entry for a reference list.
   **Your options:** Keep the in-text form; copy the reference-list entry; offer both.
   **My recommendation:** No recommendation — it depends on how you work.
   <sub>(FR-236)</sub>

10. **Zotero library names**
   **What it is:** The Library screen names a linked Zotero library by its number ("Zotero library user:42"). The names are remembered only while the Zotero screen is open.
   **Your options:** Store the names with the links so the Library screen can show them, or leave the numbers.
   **My recommendation:** Store the names; it is small and a number tells you nothing.
   <sub>(FR-506)</sub>

11. **Marking automatic Zotero syncs**
   **What it is:** The sync history does not say which syncs ran by themselves.
   **Your options:** Add the word "automatic" to those rows, or leave them as they are.
   **My recommendation:** Add the word; it is small.
   <sub>(FR-520)</sub>

12. **Screens that wait for ever**
   **What it is:** If a request never gets an answer, a screen's first read can stay at "Reading…" for ever. This was seen once in the web view the Mac uses. The app has no give-up. *(From build request 13 it has one on Find and acquire, Watched folders, Zotero sync, the opening screen and the library screen: part 13. The other screens follow.)* *(They have followed: from build request 14 nearly every screen gives up after twenty seconds and offers "Try again" — part 14, A. A screen does not try again by itself; you press "Try again". If that is enough for you, this decision needs no answer.)*
   **Your options:** Make every screen give up after a time and try once more by itself, or leave it as is.
   **My recommendation:** First note on your Mac whether any screen ever stays at "Reading…" (box in part 4), then decide.
   <sub>(FR-575, FR-595)</sub>

13. **Does "Add the PDF showing in the sign-in window" count as your confirmation?**
   **What it is:** In the library's sign-in window you can add the PDF you are looking at. Today the app still asks for a separate check after you press the button, even though you were looking at that very PDF.
   **Your options:** Add the file at once; or keep the separate check (today).
   **My recommendation:** Keep the separate check. It is your own rule of 14 November (a found file is never attached without your confirmation), and the check also compares the file with the record.
   <sub>(FR-532)</sub>

14. **"Use all the files that look right" — already decided**
   **What it is:** A button that would approve many found files with one press, and an order for waiting files, were not built.
   **Your options:** You decided on 14 November that every found file is approved one by one; nothing to do unless you have changed your mind.
   **My recommendation:** Keep your decision.
   <sub>(FR-511, FR-522)</sub>

15. **"In my own browser" for the other links**
   **What it is:** "Get through my library in my own browser" works for your library's sign-in. The other places listed under "Where to get it" (a publisher's or a repository's page) can be opened in your browser, but the extension cannot send their PDF back to the waiting work; you would add that file to the record by hand.
   **Your options:** Ask for it, or leave it out.
   **My recommendation:** Leave it out until you miss it in real use.
   <sub>(FR-568)</sub>

### Scope: what is left for later

16. **Features deliberately left for a later phase**
   **What it is:** Signed checkpoints in the change log, a destruction certificate inside the verification report, checks on timestamps of synced changes, a lighter way to read very large Zotero files, and a few Zotero leftovers are not built.
   **Your options:** Confirm they stay for a later phase.
   **My recommendation:** Nothing to do now; confirm they wait.
   <sub>(FR-607)</sub>

17. **Reading scanned PDFs (OCR)**
   **What it is:** Text recognition for scanned PDFs has no fixed build until the automatic builds make it for both kinds of Mac. Until then the tools screen shows OCR as unavailable.
   **Your options:** Need it in the first release (this needs that build work), or leave it for later.
   **My recommendation:** No recommendation — it depends on how you work.
   <sub>(FR-288, FR-324)</sub>

18. **An Intel-Mac build**
   **What it is:** The project still carries unused settings for Intel Macs.
   **Your options:** Say an Intel build is wanted and keep them; or remove them.
   **My recommendation:** Remove them unless you or a colleague will use the app on an Intel Mac (you chose Apple Silicon only at the start).
   <sub>(FR-326)</sub>

19. **WorldCat lookup**
   **What it is:** Looking references up in WorldCat is not built; it needs a key from an institution.
   **Your options:** Say whether your institution's key is available and whether you want it.
   **My recommendation:** Leave it out unless your institution gives you a key.
   <sub>(FR-609)</sub>

20. **File names in other scripts**
   **What it is:** Titles in non-Latin scripts are not converted to Latin letters when they become file names, so those file names stay in the original script.
   **Your options:** Accept file names as they are, or ask for Latin-letter fallbacks.
   **My recommendation:** Accept them as they are; macOS handles such names, and a conversion can mangle a title.
   <sub>(FR-610)</sub>

### Release housekeeping

21. **Licences and the source address**
   **What it is:** Before release: the exact licence terms of one bundled library (LibRaw) need checking; the About text names no public source address; an older list on `main` still names a download tool under a licence (GPL-2.0-only) that must not ship; the runtime Node.js is on no licence list.
   **Your options:** Supply the public source address and have the licence list checked.
   **My recommendation:** Do both before release.
   <sub>(FR-446, FR-447, FR-299)</sub>

## 3. The 94 small rough edges

*24 November: you said "Fix the 94 rough edges", and they are fixed — part 10 says what changed. The text below is kept as it was written on 15 November; two of its examples are overtaken: the export's statement about a destroyed file is now mended, and a source whose linked file is missing now offers "Get a copy for this source".*

These are small flaws a researcher could meet but that lose nothing important: wrong or confusing wording, a missing next step in a message, a screen that does not refresh, focus that lands in the wrong place, a few small gaps in what is shown. Examples:

- Creating a library in a Mac folder that holds only the Finder's hidden `.DS_Store` file is refused as "not empty". **Fixing now regardless.**
- An export of a restored copy can state as fact that a file "was destroyed under the retention rule" when the evidence is unverified. (I tried to fix this now; it needs the restore to record more first, so it stays in this list.)
- A source whose linked original file is missing is treated as already having a file, so Find and acquire never fetches a copy for it. (This was left so on purpose: the file may only be on a drive that is not connected. Say if you want it changed.)
- The list of collections cannot be opened or closed by clicking its little arrow with a mouse.
- A project name written right to left flips the whole banner sentence.
- After a download is confirmed in the optional tools screen, keyboard focus lands on the page body.
- There is no sign that the app is waiting when you close it while helpers finish (up to 95 seconds).
- Two Zotero report lines overlap in what they count, and one says "the app was closed" for a sync whose end could not be written.
- The Optional tools screen says each download contacts "only the tool's publisher", which is loose for models hosted by someone else.
- Find and acquire shows "service cannot be reached" twice.
- A recording changed outside the app stops with a generic "may be damaged" message rather than saying it was changed outside the app.

**Do you want these fixed before the project is called finished?** My recommendation: yes, in four or five batches by area, each reviewed like every other change. It is roughly as much work as the browser-extension fallback was. If you would rather stop here, they stay written down in the project's notes and nothing is lost.

<sub>(FR-030, FR-047, FR-410, FR-504, FR-527, FR-162, FR-158, FR-315, FR-297, FR-463, FR-467, FR-477, FR-291, FR-576, FR-217, FR-218, FR-219 and 77 others in the triage's list)</sub>

## 4. Things only you can check

*Use Mac build 13 for these (part 13 says where to download it). Note your findings beside each box.*

### Installing and opening the app on your Mac

- [ ] Download the app the way a researcher would and open it from Finder. Note every warning you get, including whether you need "Open Anyway". (FR-272, FR-334)
- [ ] Try opening the app again while it is still closing, and note what happens. (FR-272, FR-334)
- [ ] Look at the release page where you download the app, and note anything missing or confusing. (FR-272, FR-334)
- [ ] With the app running, launch it a second time. Note whether the first window simply comes forward. (FR-302)
- [ ] Note every macOS prompt that asks for access to a folder, and when it appears. (FR-344)
- [ ] On "Choose a library", look at the line "Free space on that disk" for a folder on your main disk and compare it with what Finder says is available. The app's figure may be lower: Finder counts space macOS can free on demand, the app does not. Note both figures. (FR-706)
- [ ] On the same screen, press "Use this folder" and note the folder it suggests (it should be in your home folder, not in Documents), and whether any macOS prompt appears before you press anything. (FR-706)
- [ ] If you can find it, note where on your Mac the app keeps its saved page data; if you cannot tell, say so. (FR-345)
- [ ] Answer the first-use banner, quit the app and open it again. Note whether the banner comes back. (FR-346)
- [ ] Move the library to a place whose parent folder does not exist yet. Note whether the app creates it or refuses. (FR-347)
- [ ] When I ask, run the Mac test job once, or let me run it, and confirm it passes (it covers the Back button in the real window). (FR-310, FR-323, FR-237)
- [ ] After the merge to `main`, confirm the job that builds the tool bundle succeeds on GitHub at least once. (FR-289, FR-320)

### The PDF reader

- [ ] Open a large scanned PDF (300 MB or more) with Activity Monitor open, scroll through it quickly, and note whether the app slows down, uses a lot of memory or closes. (FR-437)
- [ ] Note whether momentum scrolling on the trackpad feels normal. (FR-455)
- [ ] With a PDF open, lock the project and note how long the reader takes to close. (FR-437, FR-455)
- [ ] Select text by dragging with the trackpad past six pages, and note whether the selection holds. (FR-455, FR-471)
- [ ] Select and highlight text containing joined letters (such as "fi") and text written right to left. Note any wrong selection. (FR-455, FR-471)
- [ ] Highlight some text, then press Tab to move to the colour toolbar. Note whether the highlighted tint stays. (FR-471)
- [ ] Zoom a PDF in beyond about 220% on your Retina screen and say whether the text is sharp enough. (FR-436)

### Photos and recordings

- [ ] Open a source that has a photo or a proxy picture and check that the picture shows. (FR-597)

### Watched cloud folders

- [ ] Watch a folder in each cloud drive you use (iCloud, Dropbox, OneDrive, Google Drive) and note anything odd. (FR-438, FR-439, FR-441, FR-448, FR-479, FR-481, FR-487)
- [ ] Use the folder chooser and note any privacy prompt that appears. (FR-438, FR-479, FR-481)
- [ ] Put a file in the watched folder that is online-only and that you have never opened. Note whether the app handles it. (FR-438, FR-439)
- [ ] Pause or quit the cloud drive's app while the folder is being scanned. Note whether the app waits, hangs or recovers. (FR-438, FR-441)
- [ ] Drop a PDF into a watched folder and time how long until it comes in. The goal is within 10 seconds. (FR-481, FR-487)

### Zotero

- [ ] Sync your real Zotero library once and note how long it takes. (FR-444, FR-450)
- [ ] During that sync, watch Activity Monitor and note how much memory the app uses. (FR-450)
- [ ] After a sync, change a collection and delete an item in Zotero, sync again, and note whether the app notices both. (FR-444)
- [ ] If you are in Zotero groups, note whether the groups total shown looks right. (FR-444)

### The search services

- [ ] In Search sources, press "Test" for each service and note any that fail. (FR-470, FR-480, FR-501, FR-516, FR-608)
- [ ] Look up a handful of real references and note anything that fails or looks wrong. (FR-470, FR-480, FR-501, FR-516, FR-608)
- [ ] Get a free OpenAlex key and add it; note whether lookups improve. (FR-458)
- [ ] Try your library's sign-in once and note how it asks you to sign in. (FR-458)
- [ ] Tell me whether your network uses a "fake-IP" proxy or a local NAT64 tool; if so, library files may all be refused. (FR-551)

### Find and acquire with your own references

- [ ] Run Find and acquire on 20 to 30 of your own references. Note which held files were in fact the right file. (FR-478, FR-502, FR-505)
- [ ] Decide a run of found files one after another and note whether the short pause after each decision feels slow. (FR-536)
- [ ] While deciding found files, scroll and then press a button right away. Note whether presses are refused too often. (FR-535)
- [ ] Note whether any screen ever stays at "Reading…". (FR-575, FR-595) *(Part 13 says which screens now give up after twenty seconds and offer "Try again".)* *(Part 14, A, names the rest.)*

### Getting a PDF through your library (the app's own sign-in window)

- [ ] Sign in through your library in the app's window. Note anything that fails or loops. (FR-533, FR-538, FR-541, FR-559, FR-589, FR-590)
- [ ] Fetch three PDFs from three different publishers. Note which work and which do not. (FR-533, FR-538, FR-541, FR-559)
- [ ] Quit and reopen the app with "Stay signed in" on, then off. Note whether you are still signed in each time. (FR-533, FR-541, FR-559)
- [ ] Note what kind of sign-in your library uses (for example EZproxy or a university single sign-on page) and whether any step fails. (FR-589, FR-590)

### The browser extension (capture, and sending a PDF from your own browser)

- [ ] Download the extension and note whether you had to unzip it twice. (FR-343)
- [ ] Install the extension in each browser you use (Chrome, Edge, Firefox) and pair it. Note any problem. (FR-353, FR-354)
- [ ] Restart Firefox and note whether the extension asks to pair again. (FR-354)
- [ ] Try "get through my library in my own browser" in Firefox and note whether it works. (FR-569)
- [ ] Try it with a slow PDF in Chrome and note whether it finishes or gives up. (FR-585)

### With VoiceOver on

- [ ] In the PDF reader, select and highlight text with VoiceOver on, and note what is said. (FR-437, FR-455, FR-471)
- [ ] Add references with VoiceOver on and listen to what is said when the status line replaces "Added 2 references." (FR-482)
- [ ] Note whether your own result is the first thing said. (FR-483)
- [ ] Note how a work in the results list is read out. (FR-492)
- [ ] If the library chooser ever shows a notice that begins "When “…” was being created in “…”, the app could not tell whether it was made", note whether VoiceOver reads it out when the chooser appears. (FR-194)

## 5. What happens next without waiting for you

As of 24 November: the rough-edge fixes are built, tested together, in Mac build 10 and on `main` (your word of 24 November). Next I build the known gaps the round found (part 10, at its end). Parts 9 and 10 list what I need from you.

## 6. Added on 17 November: the last review of the whole branch

**Where things stand now.** The seven problems of part 1 are fixed, re-reviewed, tested together and merged on the working branch (eight pieces of work; 7,986 unit tests, 222 browser scenarios and 10 desktop scenarios passed). A ninth small fix is being tested: some older confirmation boxes (delete a participant, revoke a pairing, stop watching a folder, and a few more) could be confirmed by holding the Enter key on the button that opens them.

**Then seven independent reviewers each read one part of the whole program, as it stands, looking for anything the task-by-task reviews missed.** Much held up under attack: who may call the service, the desktop shell, the browser extension, secrets, backups and restores. But they found **3 critical and 18 important problems**. The most serious, in plain words:

- **A participant's name could still appear where a code should.** Names written in Chinese, Japanese or Thai, names typed without their accents, and names in reversed order ("Lopez, Maria") were not always replaced by the participant's code in a title, a web address or a folder's name; and the BibTeX, RIS and CSL-JSON exports did not apply the rule at all.
- **A recording's file name could be sent to an online service.** When a file is imported, the app tries to identify it; for a file named like "Author Year Title" it sent that title and author to OpenAlex as a search. For a paper that is harmless. For a recording named "Gonzalez 2024 Interview about her eviction.m4a" it sends a participant's name and circumstances to a third party — and it happened under the default rules.
- **In an encrypted project, locking the project at the very moment a change was being saved** could save that change's history line under an empty key, readable by anyone holding the folder.
- **A reference export could be told to write over a file inside the library**, even an original.
- Others: a photo's free-text comment survived into the copies made with the location removed; the certificate of a destruction did not mention an old copy of the library left behind by a move; rules the app cannot read looked normal on the Rules screen; "Move library" could say "Nothing was copied or changed" when the move was in fact running; on the Fieldwork screen a doubled press could create a second consent record that can never be deleted; and a few more.

All are confirmed by a test that shows the problem. **The four most serious are being fixed now.** Nothing here has reached the approved version (`main`).

### Four more decisions

22. **Looking titles up online**
   **What it is:** To stop the leak above, the fix makes the app stricter: for audio, video and photos it never searches online by title; and in a project that says it holds identifiable data (which is the default for a new project) it no longer searches by title for documents either. Look-ups by an identifier found in the file (DOI, ISBN) continue. The cost: in such a project, a paper with no DOI in it is no longer recognised from its title; you fill in or confirm its details yourself.
   **Your options:** (a) Leave it strict. (b) Add a tick box at each import: "These are published works: look their titles up online", off unless you tick it. (c) Make it a setting of the project.
   **My recommendation:** (b): you decide per import, knowing what the files are.
   <sub>(FR-643)</sub>

23. **Two switches on the Rules screen that change nothing**
   **What it is:** "Every source records its consent status" and "Keep an append-only, hash-chained audit log" are shown as switches, but the app does both always, whatever the switch says. Nothing unsafe follows, but unticking the second suggests the log stops, which it does not.
   **Your options:** (a) Show both as fixed facts ("always on"). (b) Give the first one teeth: refuse to store an identifiable source whose consent status is "unknown".
   **My recommendation:** (a) now; (b) only if your ethics board expects it.
   <sub>(FR-634, FR-635)</sub>

24. **What the open-format export holds**
   **What it is:** The export of a whole project in open formats names its folders by participant codes, but the records inside (each source's data file and its readable page) hold the real names: the export is your own data, complete. After the fix its reference lists (BibTeX and CSL-JSON) will use codes.
   **Your options:** (a) Leave it so and say it plainly in the export's own read-me and in the guide. (b) Plan a separate de-identified export for sharing with others (new work, for later).
   **My recommendation:** (a) now; (b) as a later feature if you share exports.
   <sub>(FR-649)</sub>

25. **The size of this last round**
   **What it is:** Fixing the 3 critical and 18 important findings is about eleven pieces of work, each built, re-reviewed and tested like the earlier ones — clearly more than the single extra fix I expected. The four most serious are under way.
   **Your options:** (a) Carry on with the other seven at the same pace. (b) Finish the four, then stop and wait for you.
   **My recommendation:** (a). They are all problems a researcher or a participant could meet.
   <sub>(Rulings R378, R379)</sub>

**One more thing only a Mac build can settle:** the helper program for audio, video and text recognition is built from Python packages whose exact versions are not all fixed. They will be fixed, with checksums, when the first Mac build can run (it cannot be proved without one). <sub>(FR-650)</sub>

**For your checklist (part 4):** open "Stop watching" and "Delete participant" with the keyboard and see that the box's title is highlighted when it opens. <sub>(FR-633)</sub>

## 7. Added later on 17 November: the fixes, what you found, and what name matching cannot do

**Where the last round stands: it is finished.** You said to carry on, so all eleven fixes of part 6 were built, plus the three things you found yourself: fourteen pieces of work. Each was built, read by an independent reviewer who tried to break it, and corrected until the reviewer had nothing serious left. They were then tested together once, on a quiet machine — 9,224 unit tests, 222 browser scenarios, the desktop scenarios and the rest, all passing — and merged on the working branch. Nothing has gone to the approved version (`main`); that waits for your word. **Your Mac app does not have these fixes yet:** a new build needs GitHub's runs, which are still not starting (see part 5).

**What you found with the app on your Mac — thank you, these are exactly the things only a real library shows.**

- **"97 of 98 items" during a Zotero import of thousands.** The second number counted only what the app had looked at so far, not the whole. Fixed: it shows the real total as soon as the app knows it, and until then says "N items so far" instead of a made-up total.
- **The import that stopped with 213 failures.** I reproduced it here: the most likely cause is that **the disk holding the library filled up**. The app first copies the Zotero database into the library and then the files; when no room is left every item fails ("could not be imported") and the import stops. You have since confirmed that this is what happened. Fixed in the code: before an import starts the app checks that the files will fit and says so plainly if they will not; a disk that fills on the way stops the import at once, with a plain sentence, and it can be resumed once there is room; and the report groups failures by their cause instead of 213 identical lines. **Please do not undo that import yet.** Once the fix is in your app, the clean path is to undo it and import again.
- **"Two sources disagree about the title": the real title against "S0003598X20000800jra 900..915".** That second "title" is a production code a publisher left inside the PDF. Fixed: a title that is plainly a file code, not words, is ignored, so it raises no conflict for you to settle.

**One addition you asked for, built and merged: a suggested folder and the free space on "Choose a library".** Under the "Library folder" box the app now offers a folder in your home folder (`Alexandrine Oxiana`, next to where Zotero keeps its own) with a "Use this folder" button; the box stays empty until you pick, type or press it. Once a folder is in the box the app says how much free space its disk has, rounded down, and adds a note when it is under 10 GB, because an import copies its files into the library. It suggests the home folder, not Documents, for three reasons: iCloud can keep Documents in step without the app being able to tell; a Mac asks your permission the moment a program looks into Documents; and it is the convention Zotero already follows. If the disk does not answer (a network drive that has dropped out) the app shows no figure instead of a guess. <sub>(FR-706; Rulings R447–R450)</sub>

**One more decision**

26. **A log file for the Mac app**
   **What it is:** When something fails in the built app, as with your import, the app keeps no record of what went wrong; I had to guess and reproduce. A log file kept only on your Mac, limited in size, with the same messages the service already writes when a developer runs it (no passwords, no keys, no contents of files), would let you send me the few lines around a failure.
   **Your options:** (a) Build it (small). (b) Leave the app without one.
   **My recommendation:** (a).
   <sub>(FR-686)</sub>

**What the app can and cannot recognise as a participant's name.** After this round one rule decides it everywhere (citations, bibliographies, reference exports, folder names, web addresses). You should know its limits before you share anything.

- **It recognises** the name as you recorded it and the participant's handle; the name in either order ("Maria Lopez", "Lopez, Maria"); typed without its accents or in other capitals; in scripts written without spaces (Chinese, Japanese, Thai); with invisible characters inside it; a family name or a given name standing alone when it has four letters or more (so "Rose gardens" becomes "P-001 gardens" if a participant is called Rose: too much is replaced sooner than too little); and the whole name inside a longer text.
- **It does not recognise** initials ("M. Lopez"); a short name standing alone ("Li" by itself), or two short names together when the record holds three ("Li Na" for a participant recorded as "Wang Li Na", "Văn Nam" for "Lê Văn Nam": only the whole name is replaced, so record such a person also under the short form they go by); a nickname or short form you did not record ("Mari" for "Maria"); a misspelling; a name whose ending changes with grammar, as in Slavic languages or Finnish ("Marii", "Lopezovi"); a Turkish name typed all in capitals; or letters borrowed from another alphabet that only look the same.
- **Inside another author's name** it replaces the participant's whole name ("Friends of Maria Lopez"), and a part of two words or more when that part is the author's own first and last name together (a participant recorded as "Lucía Fernández Ruiz" who signs a post as "Lucía Fernández") or stands in the name of an organisation. It does not replace a first name alone ("Friends of Rosa" stays), nor a double first name or a double family name that another person merely shares ("Juan Carlos Onetti" stays when a participant is called Juan Carlos Pérez), so that authors who share part of a name with a participant are not rewritten.
- **A social-media handle** is the same person with or without its "@". A handle and a plain name are never taken for the same person: the account "@maria" is not the participant "Maria" unless you record that handle for her.
- **Two people whose names differ only by an accent** ("Peña", "Pena") are kept as two participants, each with their own code and consent. If they are one person, merge them yourself.
- **So:** the app says how many names it replaced, but it cannot promise that none is left. Read a bibliography or an export once before it leaves your hands.
   <sub>(FR-664, FR-677, FR-698, FR-699, FR-702; Rulings R403, R416, R420, R427, R437, R438, R440)</sub>

<!-- coverage, part 7: FR-664, FR-677, FR-686, FR-698, FR-699, FR-702, FR-706; defect D31; tasks FR-A21, FR-D31, FR-A22 -->

<!-- coverage: FR-591, FR-138, FR-238, FR-197, FR-198, FR-199, FR-369, FR-403, FR-171, FR-356, FR-372, FR-388, FR-575, FR-595, FR-436, FR-506, FR-520, FR-511, FR-522, FR-532, FR-536, FR-551, FR-458, FR-568, FR-607, FR-609, FR-610, FR-446, FR-447, FR-299, FR-326, FR-288, FR-324, FR-289, FR-320, FR-543, FR-236, FR-343, FR-272, FR-334, FR-344, FR-345, FR-346, FR-347, FR-302, FR-310, FR-323, FR-237, FR-353, FR-354, FR-437, FR-455, FR-471, FR-438, FR-439, FR-441, FR-448, FR-479, FR-481, FR-487, FR-444, FR-450, FR-470, FR-480, FR-501, FR-516, FR-608, FR-478, FR-502, FR-505, FR-482, FR-483, FR-492, FR-533, FR-538, FR-541, FR-559, FR-589, FR-590, FR-535, FR-569, FR-585, FR-597 (plus FR-053 from the problems list, in decision 2). FR-543 is a test-set-up choice of the coordinator's and is not on the page. -->

## 8. Added on 18 November: merged to `main`, and Mac build 5

**It is merged.** You asked me to check and merge. `main` now holds everything built so far, and its files are identical to the branch that was verified.

**Your Mac build was build 9 (24 November 2026) when this part was written; **build 12 (part 12) now replaces it** (builds 9 and 10 came in between; there was no build 11). Build 9 replaced build 8.** It is the first Mac build with the PDF reader, Zotero account sync, cloud folders, Find and acquire, and every fix since your build 4. It passed every start-up check on GitHub's Mac, in both the debug app and the release app from the disk image.

- **Why build 9.** In build 8 you found that nothing on the Optional tools screen would install ("The download did not finish…"). The fault was the app's: the helper that downloads the tools looked for its list of trusted certificate authorities in a place that exists on the machine that built the app and not on your Mac, so it trusted nobody and refused every connection. Build 9 carries that list inside the app, and its build proves it from inside the finished app ("118 authorities from the app's own list"). If an install fails now, the message says whether it is the connection or a certificate that could not be verified (a VPN, a security program or a network that inspects secure connections can cause that).
- **Where (build 9):** GitHub → Actions → "Desktop (macOS)" → run 12 → Artifacts → `alexandrine-oxiana-macos-apple-silicon`. Direct link to the run: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45291457721 — the disk image's checksum (SHA-256) is `1415478b68f59901b1b15a2938b490ca4623e981cb1cb798606fe9c22526852f`. Quit the app, then replace it with the one in this disk image.
- **Build 9 is build 8 plus that one fix — with one thing I have to add (24 November).** The app's own code differs only by the fix. But seven of the ready-made libraries inside the helper that handles media and downloads were picked up in slightly newer versions when build 9 was made (among them the speech-recognition engine, 4.9.0 → 4.9.1), because the build takes the newest version of such libraries on the day. Every check of build 9 passed with them, and nothing suggests a problem; it is a gap in how the build is made (listed as FR-730), not a fault you should see. The rough-edge fixes of 23–24 November are not in build 9; they come in the build after it.
- **Build 8, for the record:**

  - **Where it was:** GitHub → Actions → "Desktop (macOS)" → run 10 → Artifacts → `alexandrine-oxiana-macos-apple-silicon` (209 MB). The browser extension is beside it. GitHub keeps both until 18 December 2026. Direct link to the run: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/44271123395
  - Runs 6, 8 and 9 also show a download of the same name, but those builds failed their checks: two crash at start-up, and the third lacks the last check's proof. Do not use them.
- **What it took.** Build 5 crashed within two seconds of starting on a Mac: at every start the app asked Apple's web engine to clear the sign-in window's saved data before the web engine had been started. That is mended. One check then could not complete on a Mac, the one proving that a web page shown in the sign-in window cannot reach anything of the app; its method relied on an error page that only Linux shows. With the method mended the check passed: on a Mac too, every attempt by such a page was refused.
- **The checklist in part 4 is for this build.**
- **These Mac fixes are on `main`** since 23 November, on your word.
- **One thing to know when you try "Get through my library" (FR-715):** on a Mac, if your library's site cannot be loaded (no network, a wrong address, the site down), the sign-in window stays blank with no message. Deciding what it should say is on the list.

**Before you import again:** undo the import that stopped when the disk filled, then import again with enough free space, or choose "leave the files where they are".

**What GitHub's check found before I merged.** It took several rounds, because GitHub's machines are slower and run at other times of day than this one:

- Seven tests that failed only by timing. Five read an entry before the app had finished writing it, one failed only in the last ten minutes of a day, and one read a status line a moment early. All seven were faults of the tests, not the app, and all are mended.
- GitHub's own package server stalled three runs. The check now falls back to a second server.
- **One real fault in the app, now mended.** The function every file copy goes through could, in a window of a few milliseconds, be left waiting for ever if the file being copied failed to read. An export or import would then never finish, and the app's background service would stop. It could happen when an encrypted project was locked mid-export, or with a damaged or missing file. It was rare, which is why earlier tests never met it. The same mistake was in backup and restore. All three places are mended, reviewed twice, and covered by tests that fail without the fix.

**One more decision for you (27).** The app's background service has no last-resort handler: if any unhandled error ever happens there, the service stops without a word and the screens fail one by one. I recommend deciding this together with decision 26 (the log file): record the error where you can find it, and have the app start the service again. (FR-711)

**Listed, not built:** when both a setting and the project's rules forbid a step in Find and acquire, the app names one in one place and the other in another (FR-709); a sweep for other tests that depend on the clock (FR-710); a rare false alarm in the desktop test harness (FR-712).

## 9. Added on 23 November: what I need from you

Everything built up to 23 November is on `main`, checked by GitHub and on a Mac. The rough-edge fixes of 24 November are in Mac build 10 and, by your word, on `main` too (part 10). What is left is yours. In the order I would do it:

- [ ] **1. Install Mac build 13** (part 13 says where: run 20's download). It replaces builds 8, 9, 10 and 12: build 9 mended the optional tools' downloads, build 10 added the rough-edge fixes, build 12 added the known gaps, the safe closing of the library and attaching without the wait, and build 13 adds the move fix, the screens that no longer wait for ever, and "Look up again". *(Build request 14 is on its way: when part 14 names Mac build 14, install that one instead.)*
- [ ] **2. Undo the import that stopped when the disk filled, then import again** with enough free space, or with "leave the files where they are".
- [ ] **3. Work through the hands-on checklist in part 4** (51 boxes, about ten areas). Tell me what you find, in any form; a sentence per problem is enough. Three areas matter most because nothing but your Mac can test them: "Get through my library" (the sign-in window), watched cloud folders, and the macOS prompts.
- [ ] **4. Answer the decisions.** There are 30 (28, 29 and 30 are new, in part 10); two are already answered (14 and 25). Each has my recommendation. The quickest reply is "accept all your recommendations except numbers …". They are in part 2 (1–21), part 6 (22–25), part 7 (26), part 8 (27) and part 10 (28–30).
- [x] **5. Say whether the 94 small rough edges should be fixed** (part 3). You said yes on 23 November; they are fixed (part 10).
- [ ] **6. Tell me how much usage I may spend**, and remind me to stop at any usage warning. As a guide from the last round: a small reviewed fix costs about 1% of a week, a fix with two review rounds 2–3%, a hard one 5% or more.

Not urgent, when you have time:

- [ ] **7. Look at the two older review pages**, `docs/review/citations.html` (8 citation entries are flagged for you) and `docs/review/code-colours.html`, and tell me what to change.
- [ ] **8. Decide about an Apple Developer account.** Without it the app is not signed by Apple: macOS warns when you open it and you must choose "Open Anyway". It is needed only before the app is given to anyone else.
- [x] **9. On GitHub, make `main` the default branch.** Done by you on 23 November.

What I do once I have your answers: fix what your tests find, apply the decisions, then close the project out (a last check of the guide and the notes).

## 10. Added on 24 November: the rough edges are fixed — what changed, and what to check

The 94 rough edges of part 3 are fixed. They were built in seven batches, and a second reviewer checked each batch and tried to break it. Then everything was tested together. They come to you as **Mac build 10**, and nothing in it needs a decision from you before you use it.

- **Where:** run 13 of "Desktop (macOS)" on GitHub: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45321193812 — at the bottom of that page, under "Artifacts", download `alexandrine-oxiana-macos-apple-silicon`, unzip it and open the `.dmg` inside. Its SHA-256 is `de3f679d60def4bc9671800025054c31d3fc592661f8950bdd6563f8520999f9`.
- **It replaces builds 8 and 9.** It contains build 9's download fix and everything below.
- **It passed every check on GitHub's Mac** (24 November): the app starts, reaches its helpers, and stops cleanly; and the new "Closing Alexandrine Oxiana" window appeared there two seconds into a slowed quit, as it should.
- **It is in `main`** (the approved version) since 24 November, shortly before 11 pm Central on the 23rd: you said "Merge and keep building please". GitHub's check of `main` has been red since then for a reason outside the app (a package mirror missing a file; see the end of this part and part 11).
- **What I built next, as you asked:** the known gaps at the end of this part (FR-717 to FR-741). They are done: part 11.

### What you will notice

**The library and projects**
- A collection's little arrow now opens and closes it with a mouse click.
- Renaming a workspace tag asks you first.
- An import's report shows "Collections created" and "Tags created". For older imports too, the review queue now warns that names may come from folder names.
- A new project whose rules need things only you can give (such as a destruction date) lists them as soon as it is created, with "Open Governance".
- On Fieldwork you can detach a signed form ("Detach the form…"). The app asks for a reason.
- A project name written right to left no longer flips the banner.
- An interrupted change is reported once per project: "A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back." *(The next build changes these words: part 11, "When a change was interrupted".)*

**Locked and encrypted projects**
- The project picker marks a locked project "(locked)", and Governance, Audit log and Fieldwork link you to unlock it.
- After you unlock a project, Capture tells you what the lock cut: "A lock stopped N links in this project from being captured. The links were not kept while the project was locked: add them again to capture them."

**The PDF reader**
- When a highlight in Chinese or Japanese text crosses a line break, the lines are joined without an added space.
- If a source's linked PDF is missing but a copy has been added, the reader opens the copy.

**Recordings and transcripts**
- If a recording's file has changed, the player stops with: "The recording stopped: its file is no longer as the app stored it — it was changed outside the app, or it is damaged — so it cannot be played from here. Check the verification report."
- After a long pause, a recording plays again without a false "may be damaged".
- When you move the library, a running transcription stops and carries on after the move.
- In Optional tools, the sentence now reads "Each download contacts only the addresses listed with the tool".

**Watched folders**
- During a folder's first look the screen shows "Watching — looking through the folder…".
- A line counts the files that were not brought in again because they were already in the library.
- A source opened just after it came in from a watched folder shows where it came from straight away (before, only a few seconds later), and its two buttons work from that moment.

**Zotero**
- Imports and syncs now say that removals in Zotero are not copied here: for example, a tag you take off there stays on here.
- A sync whose end was never written no longer claims the app was closed.

**Find and acquire**
- A source whose linked file is on a disconnected drive now says: "Its linked file cannot be found at the moment; the drive it is on may not be connected." It offers "Get a copy for this source". "Use this file" then adds the copy beside the link, and the link stays.
- Each found-file card has "Look at the file". It opens the file in the reader, to look at only; nothing is added to your library.
- "Service cannot be reached" appears once, not twice.

**Getting a PDF through your library**
- If you press a button while its last request is still under way, the app tells you to wait ("Wait until the test has started.").
- A late answer can no longer close a newer sign-in window.

**Closing the app**
- If closing takes more than two seconds, a small window "Closing Alexandrine Oxiana" says: "Your library is being closed safely. This can take up to a minute and a half." It does not take the keyboard.

### What became safer underneath
- An interrupted change is undone correctly even if the app is interrupted twice. **This mends an older fault:** an undo that ran a second time could delete a source's original annotations and still report success.
- A lock now reaches a file at the very moment it is opened. **This mends an older fault:** a lock at exactly that moment let one whole picture through. Your documents had a separate guard.
- If something put there by hand blocks an original the app must put back, the original is kept and the change is left unfinished. Before, the original could be deleted.
- The app no longer reports its own writes as "changed outside the app". Real outside changes are still reported.
- A transcript's two files are stored together or not at all.

### Things only you can check in build 10 (still the build to use; part 11 has the list for the next one)
- [ ] Start something long, such as a transcription, then quit with **Cmd-Q**. Does "Closing Alexandrine Oxiana" appear if closing takes more than two seconds, and does the app end completely? (FR-731)
- [ ] In the review queue, press "Look at the file" on a found PDF. You should be able to read it but not add anything. Close it and note where the keyboard focus lands.
- [ ] Unplug the drive that holds a source's linked file and press "Get a copy for this source". After "Use this file", the reader should open the copy.
- [ ] In Optional tools, install "Speech model: tiny". This is build 9's fix, which you have not yet confirmed.
- [ ] Highlight lines in a Chinese or Japanese PDF. The highlighted text should read correctly.

### Three more decisions for you (28, 29, 30)

28. **Links waiting to be captured when a project is locked**
   **What it is:** If you lock an encrypted project while links are still waiting to be captured, the app forgets them (nothing of an encrypted project is kept readable or in memory at a lock) and tells you after the unlock how many were dropped, so you can add them again.
   **Your options:** (a) Leave it so. (b) Keep the waiting links sealed inside the project and offer them again after the unlock.
   **My recommendation:** (a) for now: (b) means writing a queue of web addresses into the project at every lock, a new kind of stored data with its own rules; worth it only if you lock projects in the middle of capturing often.
   <sub>(FR-719)</sub>

29. **Tool downloads on a network that inspects secure connections**
   **What it is:** Build 9 made the optional tools download with the app's own list of trusted certificate authorities. On a network that re-signs secure connections with its own authority (some universities, some security programs), the download is still refused, with a message that says why, because the app does not look in your Mac's keychain where such an authority is installed.
   **Your options:** (a) Leave it so: on such a network you download the tool on another network. (b) Let the app also trust what your Mac's keychain trusts: it needs one more ready-made library in the app, and it means that whoever controls such a network could see and change what is downloaded (the app still checks each download's fingerprint against the one it expects).
   **My recommendation:** (a) unless you meet the problem: you said no such network is in your way.
   <sub>(FR-722)</sub>

30. **Logging out or shutting down while the app is open**
   **What it is:** From the next build, Quit (Cmd-Q, the Dock's Quit) closes the app the safe way: it waits for its helper programs and shows "Closing Alexandrine Oxiana" if that takes more than two seconds. When macOS itself asks the app to quit — you log out, restart or shut down — the app still ends at once, as it always has; its helpers then stop by themselves, and nothing is lost by that (every change is made so that an interruption is undone or completed the next time the library is opened).
   **Your options:** (a) Leave it so. (b) Make the app hold the logout until it has closed safely; macOS would then tell you the app interrupted the logout, and you would log out again once it has closed. (c) Ask macOS to wait for the app without cancelling; this can only be tried on a real Mac.
   **My recommendation:** (a) now; (c) later if you ever see a "the last change was not finished" notice after a shutdown.
   <sub>(FR-731)</sub>

### What I was building next (24 November, 2:30 am Central)

*This was the state in the night. All of it is now done: part 11.*

### Known gaps found during the round (not fixed)

*24 November, later: all of these but FR-722 (your decision 29) are now built — part 11 says what became of each, and what is still open. The list is kept as it was written. One line of it was wrong: FR-738 does not need "two crashes in a row" in any build after build 10 — it can no longer happen there at all; part 11 says what remains of it.*
- **FR-738:** after two crashes in a row, the second at one exact moment of Find and acquire's own repair, that project would stay blocked: each time the library opens, the app tries to undo the change and refuses. Nothing is lost. It is very unlikely.
- **FR-735, FR-736:** when a file put there by hand is in the way, the original is kept, but the app cannot yet put it back itself, and its messages do not tell you what to do.
- **FR-722:** a network that inspects secure connections (some universities) still refuses tool downloads. The app's message says why.
- **FR-729:** warnings shown when a library reopens are gone after a restart.
- **FR-733:** a move refused at its start restarts a running transcription.
- **FR-727, FR-728:** a broken shortcut counts as a present file, and a waiting entry is not judged again when a file arrives some other way.
- **FR-723, FR-737:** rare cases in undoing an unfinished change.
- **FR-724, FR-732:** small inaccuracies in an export's notes about left-out files.
- Small technical points, and small points of wording, focus and speed: FR-725, FR-726, FR-730, FR-734, FR-739, FR-740, FR-741.

## 11. Added on 24 November: the known gaps are built — what changed, and what to check

You said "keep building". The 23 known gaps of part 10 are built; the other two of the 25 are your decisions 28 and 29 and stay so. A second reviewer checked each batch and tried to break it; several were sent back and mended, and then everything was tested together. Nothing in it needs a decision from you before you use it.

- **Where it stands:** built, tested together on my side, and green in GitHub's own check: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45464905103
- **There is no Mac build of it yet.** I asked for Mac build 11 twice. GitHub cancelled the Mac job four times, each time about fifteen minutes after it was queued, without ever giving it a Mac; nothing of the build ran, so this says nothing about the app. The last time a Mac was given was for build 10, the night before. I cannot see GitHub's reason from here; the cancelled job's page may show it: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45464905098 (the job "apple-silicon (macos-15)"). I will ask again with the next change (FR-749, below) and put the download here when it exists. *(Asked again as build request 12: part 12.)*
- **Until then, build 10 is the build to use** (part 10 says where). What follows describes the next build. *(That build now exists: Mac build 12, part 12.)*
- **It is in `main`** (the approved version) since 24 November, about 3 pm Central: you said "merge". The app's code in `main` is, file for file, the code that was tested and that passed GitHub's check. GitHub's check of `main` itself passed on that merge (4:13 pm Central): https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45487722814

### What you will notice (in the next Mac build)

**Quitting the app**
- Quit (Cmd-Q, the Dock's Quit) now closes the app the safe way. If that takes more than two seconds you see the "Closing Alexandrine Oxiana" window. Logging out, restarting or shutting down still ends the app at once (decision 30).

**The library and projects**
- If "Move library" is refused (for example, the destination is not empty), a running transcription is no longer stopped: it goes on.
- The warning that the watched folders were not started goes away by itself once their list can be read again.

**Locked and encrypted projects**
- A file sealed with another project's key no longer says the project is locked: "An encrypted file could not be read (damaged, or made with another key)."

**Watched folders**
- "Bring in the new version…" and "Keep the library's copy as it is" now say what happened: "The disk is full. Free some space and try again.", or "Watching of this folder stopped before this could be done, so nothing was changed. Try again."

**Find and acquire and linked files**
- A linked file whose place now holds a shortcut (a symbolic link, even to a real file) or a folder counts as missing. It appears under Missing files and in Find and acquire, and the reader says "File not found".
- An entry waiting for a copy says "In your library" once its source has a file by another route.

**Getting a PDF through your library**
- Leaving Find and acquire while a sign-in window was opening could leave a stuck sign-in that blocked every "Get through my library" for up to half an hour. That is mended.

**Exports**
- An export's notes about left-out files are more exact: where a record is missing they name it, instead of saying the audit log "does not hold together".

**The PDF reader**
- More Chinese and Japanese highlights join correctly across a line break (full-width spaces, split numbers, superscript note marks).

**The browser extension's pairing**
- A pairing the app cannot save in time is refused with "…so the browser is not paired. Show a new code in the desktop app and pair again."

### When a change was interrupted

This is the largest part of the round, and I hope you never meet it: the app was closed or crashed in the middle of a change and cannot simply undo it.

**The app never deletes, overwrites or moves a file it can tell is not its own: it waits, and tells you which file is in the way.**

- The warning has "Resolve…". The list names the file and its place, for example: "{file} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”."
- You move that file out of the library and choose "Roll it back".
- Where the app's own kept copy of a removed file is gone, you can choose "Close this change as it is". The app says plainly whether that file is lost or merely cannot be confirmed, and: "Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it."
- Such warnings now stay until you press "Dismiss", also after a restart.

**The honest limit.** A change that an older build (up to 10) left stuck at one exact step cannot be closed this way: the app keeps the only copy of the earlier state, and closing would delete it. A backup made before that change is the way. No build from 11 on can produce that state. This corrects what I told you in the chat during the night, that such a change could be closed.

### What became safer underneath

- Every ready-made library inside the media helper is pinned to exactly what build 10 holds, and the build fails if anything differs. Builds no longer change by themselves (the speech engine had moved on its own between builds 8 and 9).
- A move of the library never has a folder watch running during the copy.
- A lock now also cuts off a picture that was being sent.
- Find and acquire's queue no longer reads every record again after each opening.
- A browser pairing that could not be saved in time is taken back, never left half-made.

The reviews caught, on the way: watches restarted in the middle of a move; a ruling of mine that would have moved a hand-placed file into a folder the app empties; and a guard that, in one contrived sequence, would have let a close delete the only copy of a file.

### Things only you can check in the next Mac build (no build 11 was ever made; part 12's list is the one to use)

- [ ] Start a transcription, then quit with **Cmd-Q**. You should see "Closing Alexandrine Oxiana" if closing takes more than two seconds, and the app should end completely. GitHub's Mac has not yet run its test of a quit sent as a system request, because no Mac build has run. Your own Cmd-Q is the last word.
- [ ] The same with the Dock's Quit.
- [ ] In Optional tools, install "Speech model: tiny" (still unconfirmed since build 9).
- [ ] Replace a linked file with a folder, or unplug its drive. Missing files and Find and acquire should list it, and the reader should say "File not found".
- [ ] Start "Move library" to a folder that is not empty while a transcription runs. The move is refused and the transcription goes on.

### Still open

**Your decisions (part 10):**
- 28, links waiting when a project is locked: I recommend (a), leave it so.
- 29, tool downloads on a network that inspects secure connections: I recommend (a), unless you meet the problem.
- 30, logging out or shutting down: I recommend (a) now; (c) later if you ever see a "the last change was not finished" notice after a shutdown.
- **31 (new, below), attaching a file when a metadata service says "too many requests": DECIDED on 24 November — you said "b now and c next", and that the message reads "Waiting for lookup service response." (b) is being built now; (c), "look up again", is the piece after it.** *(Both are built: (b) in build 12, (c) in build request 13 — part 13.)*

**Listed in this round, not built (most serious first):**
- **FR-749:** a library closed while a file is still "Attaching…" is written into after its lock is released. Being fixed and reviewed now; it comes with the next build (see "What GitHub's own check found", below). *(Built since: part 12.)*
- **FR-738:** a library already holding a change stuck by an older build stays blocked; a backup is the way. Very unlikely (a crash at that one step under build 10 or earlier). In two rare shapes the app also refuses a close that would be safe.
- **FR-746:** the "never touch what is not its own" rule does not yet cover a hand-put file where the app only adds to its own logs, or inside a folder the change made. Far-fetched.
- **FR-745:** with a shortcut or folder at a linked file's place, Find and acquire still suggests a disconnected drive; whether to follow such a shortcut is a choice with a safety side.
- **FR-744:** after two failed saves and a restart, a pairing can be listed again; nobody can use it.
- **FR-742:** a few build tools and the Linux side of the helper's build are not yet pinned.
- **FR-743:** after an older kind of restore, an export can call false-dated evidence verified. Very narrow.
- **Small points:** FR-717, FR-725, FR-729, FR-734 and FR-740 each keep a small leftover of wording, timing or a rare join.
- **Tests only:** FR-747 and FR-750 are three tests that failed once on a heavily loaded machine and pass alone; they are watched, not changed. *(Corrected since: FR-750 was a real weakness of the screen, not only of its test — a first reading that never got an answer left it waiting for ever. Mended: part 13.)*

### What GitHub's own check found after the push

The round passed every test on my side, and then GitHub's check of the same code failed twice. Both were followed up rather than run again until green.

- **A test of Find and acquire** depended on timing and failed on GitHub's slower machine. The app was right and the test's order was wrong. The test is mended.
- **The desktop test attached a file and waited more than a minute.** The app had asked a public metadata service about the file, was told "too many requests", and waited as long as the service asked. That is what the app does today, in build 10 as well; it is decision 31 below. The test now switches the lookups off for its project through the real settings screen, so it no longer depends on a public service.
- **A guard** now fails any unit test that reaches the internet without having prepared for it. It found one more such test, which is mended.
- **A fault in the app, older than this round, came to light on the way** (FR-749): if you close the library, or open another one, while a file is still "Attaching…", the close finishes at once and the attach later writes the new source into the library after its lock has been released. In the test nothing was lost. But another device or the command line could be using the library at that moment, and the app's own rule is that nothing is written into a library after its lock is released. The fix is being built and reviewed now and comes with the next build: a closed library refuses every write, and a close cancels an attach that has not written anything yet, with a plain message. Quit will then also no longer wait a minute in that case.

### One more decision for you (31)

31. **Attaching a file when a metadata service says "too many requests"**
   **What it is:** When you attach a file, the app first asks public services (Crossref, OpenAlex, Open Library, the Library of Congress) for its details. If one answers "too many requests", the app waits as long as that service asks, up to a minute per try, and then asks again. Measured with a stand-in: one minute for a plain PDF with one such answer; three minutes if every service keeps answering so; nine minutes for a PDF with a DOI. Several files wait one after another. All you see meanwhile is "Attaching…" with the buttons off: no progress and no Cancel. One of these services appears to have changed its limits for requests without a key (its answers now carry a shared allowance), so this may happen more often than it used to. When a lookup fails outright (no network), the file comes in within seconds marked "needs review", and nothing looks that record up again later.
   **Your options:** (a) Wait, as now. (b) Bring the file in at once, marked "needs review", whenever a service asks to wait: small to build; the record then holds only what the file itself says, and you fill in the rest by hand. (c) As (b), and add "look up again", which completes such a record later: a medium piece of work. (d) Keep waiting, but for about ten seconds at most, with "Looking up the details…" and a Cancel.
   **My recommendation:** (b) now and (c) next. A file you chose should be in your library at once; what the services know can follow.
   **Decided, 24 November:** (b) now and (c) next, with your words: the file comes in at once, marked "needs review", and the line reads "Waiting for lookup service response." One thing to know until (c) is built *(it is now: part 13)*: nothing looks such a record up again by itself yet, so "waiting" becomes literally true with (c); until then you complete the record by hand in the review queue, or it stays as it is.
   <sub>(FR-748)</sub>

## 12. Added on 24 November, evening: closing the library safely, and attaching without the wait

After the merge you asked for, two more pieces are built. The first mends an older fault: a library closed while a file was still "Attaching…" was written into after its lock was released. The mend covers everything that can still be running when a library closes. The second is your decision 31 (b): attaching a file no longer waits for a metadata service that says "too many requests". Each was checked by reviewers who had not built it and tried to break it: the first through four reviews, the second through two, and both were sent back before they were approved. They were tested together and are pushed as build request 12.

- **Tested together on my side:** every step passes. The first full run caught two faults of the close work, and both were mended before anything was pushed (they are in the list of what was caught, below); the second full run passed everything except one of 224 browser scenarios, which failed once in one browser for a cause that is older than this work and is now understood (FR-750, under "Still open").
- **GitHub's own check passed** (24 November, 7:40 pm Central): https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45520284119
- **Mac build 12 exists** *(since 25 November, 12:50 am Central, Mac build 13 replaces it: part 13)* — it was the build to use (it replaces build 10; there never was a build 11). Run 18 of "Desktop (macOS)" on GitHub: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45520284023 — at the bottom of that page, under "Artifacts", download `alexandrine-oxiana-macos-apple-silicon`, unzip it and open the `.dmg` inside. Its SHA-256 is `5c418d3874c28ccc6edaa28cb36d5bca7e6883769b35aeee4a5308274b9e7b44`. GitHub gave the job a Mac this time, after five refusals during the day. Every check of the build passed: the app starts from the disk image and its helpers start, answer and stop; every ready-made library inside the media helper is the pinned version (56 of 56); and, for the first time on a Mac, **the test of Quit ran and passed**: a quit sent as a system request closed the app the orderly way twice, and when closing was slowed the window "Closing Alexandrine Oxiana" appeared after two seconds.
- **It is in `main`** (the approved version) since 24 November, about 7:50 pm Central: you said "merge when ready", and I merged once GitHub's check was green. The app's code in `main` is, file for file, the code Mac build 12 was made from.

### What you will notice

**Attaching a file**
- When a lookup service answers "too many requests", the file is in your library at once, marked "needs review". Its line in "Attached files" reads: "{file} — Stored; it needs review: Waiting for lookup service response."
- In the review queue the same sentence stands first under "Why it needs review".
- The other services are still asked; if one confirms the file, it comes in as usual.
- A service that asked to wait is left out for every file until the time it named (an hour at most).
- Bulk Import and Zotero still wait, as before, with their own progress.

**Closing the library, or opening another, while something is running**
- A file still "Attaching…" is not added, and its line says: "The library was closed or went offline before {file} was attached, so nothing was changed. Attach it again when the library is open."
- "Bring in the new version…" or "Keep the library's copy as it is", cut the same way, says: "The library was closed or went offline before this could be done, so nothing was changed. Try again when the library is open."
- A file a watched folder was bringing in stays in its folder and is brought in next time.
- A Bulk Import is left paused, with no file marked failed, and can be resumed after you open the library again.
- A backup is cancelled: no backup is made, nothing is recorded, and no "backup failed" warning appears when you open the library again.
- Quit no longer waits a minute for a file whose lookup was waiting.
- If the library was closed under a save, Governance and "Your library" say "That library has been closed, so nothing was changed.", not "changed elsewhere", and "Your library" keeps what you typed.

### What became safer underneath

- Once a library is closed, nothing is written into it: the app's own rule, now enforced in one place for every kind of change.
- A close lets a change that is already being written finish first.
- In an encrypted project, the keys are wiped only after that.
- A data destruction caught by a close stops cleanly and is finished the next time the library is opened. A destruction that did happen is never answered with "nothing was changed".
- Nothing more is sent to a lookup service once the library begins to close.
- A lookup service that asked to wait is not asked again before its time, also when several files are attached at once.

The reviews caught these on the way:
- a Bulk Import cut by a close had its remaining files marked failed;
- a backup cut by a close was recorded as failed;
- a destruction that had happened could be answered "nothing was changed";
- a change of mine to the retry record would have let an attempt that crashes the app be made again at every opening;
- the first build of the "do not wait" rule still asked a service again when files overlapped, and slowed Bulk Import down.

And the full test run, after all the reviews, caught two more, both mended before the push:
- "Move library" left the old copy's search index open, so the old copy was not the exact copy the move checks for (the index can be rebuilt; nothing of yours was touched);
- an integrity check that was waiting when the library was moved said the library was "closed" where it should say it was moved.

### Things only you can check in Mac build 12

- [ ] Attach several PDFs at once. They should be in within seconds. A line ending "Waiting for lookup service response." is this case, not an error.
- [ ] Start a Bulk Import of a folder, close the library while it runs, then open it again. The import should be shown as paused (or "interrupted"), "Resume" should carry it on, and no file should be marked failed.
- [ ] Attach a large file and close the library at once. The file is either there, complete, or its line says nothing was changed; never half.
- [ ] Quit with **Cmd-Q** while something long runs (a transcription), and once with the Dock's Quit: the app should end completely, with "Closing Alexandrine Oxiana" shown if closing takes more than two seconds. GitHub's Mac passed its own test of this (above); your own Cmd-Q is the last word.
- [ ] In Optional tools, install "Speech model: tiny" (still unconfirmed since build 9).
- [ ] The checks of part 11's list that are not repeated here still apply to this build: a linked file replaced by a folder, and "Move library" to a folder that is not empty while a transcription runs.

### Decision 31 (c): four choices

With (c), an entry that is waiting is looked up again later, and what the service says appears on the entry as suggested matches. Nothing in the record changes until you accept one.

31c-1. **Automatic, or by hand only**
   **What it is:** Waiting entries can be looked up by themselves while the library is open, and with a "Look up again" button.
   **Your options:** (a) both; (b) by hand only.
   **My recommendation:** (a). The automatic tries are limited in number and only add suggested matches.

31c-2. **May a later answer fill a record by itself?**
   **Your options:** (a) never: it stays a suggestion; (b) allow it for a perfect match.
   **My recommendation:** (a), never.

31c-3. **"Look up again" before the service's named time**
   **Your options:** (a) the button waits: it is off and says when it can be used; (b) it sends one request at once, as your own act.
   **My recommendation:** (a).

31c-4. **Lookups that failed outright** (for example, no network)
   **Your options:** (a) not covered; (b) kept from now on and offered by hand only; (c) also tried again automatically.
   **My recommendation:** (b).

I build my recommendation for each unless you say otherwise before the build starts. *(Built so: part 13, "the four choices, as built", which also says how each can still be changed.)*

### Still open

- **FR-068 (added 24 November, 9:20 pm Central; CORRECTED at 9:50 pm — what stood here was wrong on the main point):** I wrote that after a move that stopped, running it again to the same folder could finish without copying your later changes, and gave advice to avoid that. **In build 12 that cannot happen through the app:** the Move dialog always checks the destination first, and it refuses a folder that already holds the stopped move's copy ("not empty"). The fault the review proved needs a request that skips that check, which the app's screens never send. **So there is nothing for you to avoid, and the advice is withdrawn.** What is true in build 12: after a move that stops at that one late step, the copy it made stays at the new place, unused, and nothing says so; to move the library you must choose another, empty folder, and the leftover folder can be deleted. The fix being built makes the engine refuse such a request by itself (not only because the dialog checks), tells you after such a stop that the copy at the new place is not used and can be deleted, and makes the leftover folder say what it is when opened. *(Changed at 10:20 pm: a first version of the fix let the move be run again into the same folder; its review found that unsafe, so the app will go on refusing, as it does today, and say why.)* *(Superseded from build request 14: the app's engine now refuses that folder too, the dialog says why, and the leftover folder says what it is — part 14, B.)*
- **FR-755 (the first thing I build next) — corrected at 7:30 pm Central; what I wrote here before was wrong on one point:** if "Move library" fails at its very last steps — or if the app is killed or the Mac goes down in those last moments of a move — the library is left half-switched. **Nothing is lost:** the new place holds the whole copy, checked file by file before the switch began, and the old copy is untouched. But I wrote that the move "then finishes when the library is opened". It does not: today the app has no way to finish such a move, and the library opens only read-only, at the old place and at the new one, from then on. That is older than this work (it has been so since the move was built) and no review had caught it; the worker building this fix found it by trying it. The fix, being built now: opening the library at its new place finishes the move and tells you so; and a move that fails late closes the library and says where to open it. Until that build: if a move ever ends with the library read-only and the words "a move into this folder has not finished", stop and tell me — do not delete either copy. *(Built, with three reviews: part 13, A. The advice above — stop and tell me — is for build 12 only.)*
- **FR-750 (built with it):** the Find and acquire screen can sit at "Reading the projects…" with no error and no "Try again" when its very first requests fail. Seen three times in the test browser, never on a Mac so far; the cause is found. *(Corrected and built: the cause was a request that never got an answer, not one that failed — part 13, B.)*
- **FR-749:** a close waits without a time limit for a change being written, so a change stuck on a vanished network drive holds the close (Quit still gives up after a minute and a half). Unlikely.
- **FR-749:** a picture or text-recognition job already running at a close can make and remove a scratch folder after it. The app stops these queues first, so you should not meet it.
- **FR-749:** a Bulk Import that does not pause in time may remove its own scratch folder late. Rare.
- **FR-749:** a forced exit during a very large cancelled backup can leave a partial file until the next backup. Very unlikely.
- **Decision 31 (b):** the hold on a service is kept in memory, so after the library is closed and reopened one request can go early. Until (c) is built, nothing looks a waiting record up again by itself. *(Both closed by build request 13: part 13.)*
- **FR-753:** two small corners of that hold: one request can go early when answers arrive out of order, and a file can wait a moment longer than needed. Nothing is lost.
- **FR-751:** a destruction certificate's status can say a backup "was not removed by the app" when it was. A wording to correct.
- **FR-752:** in an encrypted project, a source's folder name and one of its files hold its title in the clear. Whether this is as designed or a gap is being checked; it is not yet judged.
- **FR-754:** the "automatic backup failed" warning says "make one now from the project's settings", but no screen offers a backup by hand. A sentence to correct, or a button to add.
- **FR-747:** a test only.

## 13. Added on 25 November, just after midnight: the move finished safely, screens that no longer wait for ever, and "Look up again"

After build 12, three more pieces were built for the next Mac build (build request 13). The first mends the fault I told you about at 7:30 pm. A "Move library" that stopped at its very last steps left the library read-only for good. Now the move is finished when you open the library at its new place. The second: a screen that gets no answer from the app's own service no longer waits for ever. After twenty seconds it says so and offers "Try again". So far this covers Find and acquire, Watched folders, Zotero sync, the opening screen and the library screen. The third is your decision 31 (c), "Look up again", built with my recommendation for each of its four choices, since you did not change them. Reviewers who had not built the work checked each piece and tried to break it. The move fix went through three reviews. Find and acquire's part went through one. The opening screen's went through two. "Look up again" went through four: two for the part that does the lookups and two for the screen and what drives it. Every piece but Find and acquire's was sent back at least once before it was approved.

- **Tested together on my side:** every step passes: the tests of every part, the service, the Mac shell's own tests, a Linux build, the app started and quit, and 228 of 228 browser scenarios. The first full run had two of those scenarios fail. I read both before believing them: the test harness had opened the next page while the page before was between two of its own readings. Nothing in the app was at fault; I mended the harness, and the whole browser step was run again and passed.
- **Pushed as build request 13** at 12:35 am Central on 25 November.
- **GitHub's own check passed** on this code: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45557680438 (green at 1:02 am Central, after an hour). **Afterwards one test failed on GitHub, twice**: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45561718000. It is one of about 11,600 tests, a test of Find and acquire (listed as FR-757). *(Corrected at 5:57 am Central on 25 November. I wrote here that this test failed every time and that the date and time caused it. Both were wrong; I had guessed and not yet tested the guess. The test fails about one run in four, and what it caught is a small fault in the app itself, older than this build: when a download of a free copy was stopped at one exact moment — by stopping the search, or by locking or closing the library — the app could still open a connection to the site it was about to download from. An independent review measured how far that went: the app could look up the site's name and connect to it, so the site could see that your computer connected; no request was sent, nothing about what you were looking for went out, and nothing was downloaded or kept. The mend is three lines, the review confirmed it, and it comes with build request 14. So Mac build 13 has this small fault, as the builds before it have; it is safe to use.)* Because GitHub's check fails often until the mend is in, I do not recommend merging build 13 by itself; build request 14 is otherwise ready.
- **Mac build 13 exists, and it is the build to use now** (it replaces build 12). Run 20 of "Desktop (macOS)" on GitHub: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45561718089 — at the bottom of that page, under "Artifacts", download `alexandrine-oxiana-macos-apple-silicon` (you must be signed in to GitHub). The disk image's SHA-256 is `cc6d1f090860486c8706511a2a6b396cc99c0f6a32253f0022cf2059d7250288`. GitHub's Mac built it at 12:36 am Central on 25 November and ran every check on it: the app starts from the disk image, its helpers start and stop cleanly, Quit by a system request goes the orderly way (2 of 2 runs), and nothing is left running.
- **It is not in `main`** until you say so. *(Changed at 3:15 am: my recommendation is now to merge build request 14 instead, which holds all of this plus the mend of that test — part 14 will ask.)*

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
- [ ] Turn Wi-Fi off and attach a PDF. Its entry should say, under the matches: "Not looked up: a lookup service could not be reached. You can use Look up again." (I could not try this on a Mac; if it says something else, tell me the words.) Turn Wi-Fi back on. After a few minutes the entry should still say the same, because failed lookups are not retried by themselves. Then press "Look up again": the sentence should give way to matches, or to "The lookup service has now answered, but it found no match for this item."
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
   **To switch later to "one request at once, as your own act":** small, a few edits and one review (the press would have to pass the hold that is now kept across reopenings).

31c-4. **Lookups that failed outright** (for example, no network)
   **Built:** (b) kept from now on and offered by hand only. They are never retried by themselves.
   **To switch later to also trying them automatically:** very small, a one-line change.

### Still open

This list replaces part 12's entries on FR-755, FR-750 and decision 31 (b). The rest of part 12's list stands.

**Being built beside this build, not in it:**
- **The same "never wait for ever" fix for the other screens (FR-756).** Built for the governance screens, "Your library", search sources, tools, the extension's pairing, the researcher's name, the transcript viewer, the reader, capture and the import; a review sent it back, it has been mended, and it is at its second review. A last small piece follows (the review queue, a source's detail, a new project, the appearance settings). Missing files gets no time limit, since its check rightly takes long; it needs a check that shows its progress. Until then those screens can still sit at their loading words if the service never answers. Seen only in the test browser, never on a Mac. *(Built and in build request 14, except the missing-files check: part 14, A.)*
- **Moving into a stopped move's folder (FR-068).** Built, and approved at its second review with small points that are being mended; it comes with the build after this one. What it does: if you ask to move the library into a folder that holds the copy of an earlier move that did not finish, the app refuses and says so. Nothing is copied over or deleted there. The leftover folder, when opened, will say what it is: that it is not the library, and that it can be deleted. This replaces the last sentence of part 12's FR-068 note. Running the move again into the same folder will not be offered. You choose another, empty folder, or delete the leftover one first. *(In build request 14. Two things in this paragraph are not quite how it was built — when the leftover folder says it can be deleted, and what the dialog advises you to do: part 14, B, has the exact words.)*

**Left over from this round (unlikely to meet):**
- **FR-755:** if the opening that finishes a move is itself cut short (by Quit), the move is finished but its message is missing. After a move of some projects, the library they came from does not say where they went (the Move dialog does).
- **"Look up again":** your press can wait behind the entry the automatic pass is busy with, minutes at worst. While an encrypted project is locked, the times its services named are unknown, so an attach to another project may ask such a service early.
- **FR-756:** the list of libraries can show "No libraries yet" beside "could not be reached" when it was not read. *(Mended in build request 14.)*

**Listed, not built:**
- **FR-759:** locking an encrypted project while an attach's lookup is still out may leave that one answer in memory. It is mended for "Look up again"; for an attach it is still to be checked. You would not see it.
- **FR-753:** two small corners of the hold on a service: one request can go early when answers arrive out of order, and a file can wait a moment longer than needed. Nothing is lost.
- **FR-757:** a test of Find and acquire failed once; it may hide a rare case where a service is asked a little before its time. Being looked into. *(Found since: see the corrected note under "GitHub's own check" in "Where it stands" above — a stopped download could still start one more request. Mended in build request 14.)*
- **FR-758:** in a case the app does not reach today, the time of the last real try is not recorded. Cosmetic.
- **FR-751:** a destruction certificate can say a backup "was not removed by the app" when it was. Only after a crash at that very step; a wording to correct.
- **FR-752:** in an encrypted project, a source's folder name and one of its files hold its title in plain text. Still being checked: as designed, or a gap. You would only see it by looking inside the library folder.
- **FR-754:** the "automatic backup failed" warning says "make one now from the project's settings", but no screen offers that. You would meet it only if an automatic backup fails.
- **FR-760:** two small points of the move that are older than this work: moving the library that stayed behind after a move of some projects into that move's new place answers "done" although nothing moved; and one check after an upgrade from an older build rests on the later checks. Nothing is lost in either.

## 14. Added on 25 November, morning: every screen gives up politely, the move refuses a leftover folder, and a stopped download asks nothing more

After build request 13, three more pieces were built for the next Mac build (build request 14): two planned, and the mend of a small fault that one of the tests caught. The first: nearly every screen that gets no answer from the app's own service now gives up after twenty seconds, as part 13's five screens do. The second: "Move library" refuses a folder holding the leftover copy of a move that did not finish, and says why. Reviewers who had not built the work tried to break it: the screens through three reviews (sent back once), the move through two (the first rejected an earlier version). I read the last mends of each piece myself. The third: a download that is stopped no longer connects to the site it was about to ask (under "What became safer underneath").

- **Tested together on my side:** every step passed at the first run: the tests of every part (11,834 of them), the service, the Mac shell's own tests, a Linux build, the app started and quit, the desktop scenarios, and 228 of 228 browser scenarios.
- **Pushed as build request 14** at 7:28 am Central on 25 November.
- **GitHub's own check is green** on exactly this code: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45623952522 (green at 8:38 am Central, after 70 minutes). The test that failed on build request 13 passed.
- **It is in `main`.** At 8:28 am Central you wrote "merge build 14 to main when the check is green"; I merged exactly build request 14 at 8:43 am. `main`'s own check passed too, at 9:45 am Central: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45637345358
- **Mac build 14 does not exist yet.** GitHub has not given the build a Mac: three attempts (7:28, 7:46 and 8:05 am Central) each waited fifteen minutes and were cancelled by GitHub with nothing run. Nothing on our side changed since Mac build 13, which got a Mac within seconds; GitHub's status page reports no incident, and its documentation says queued jobs can be dropped when its machines are busy. I try again at intervals and will put the download and its SHA-256 here. *(Added at 9:02 am: the build started from `main` was dropped the same way. Yesterday GitHub also gave no Mac during the day, and gave one at once in the evening and at night; so Mac build 14 will most likely exist this evening, about 7 pm Central.)* *(Added at midday: the Mac build made this evening will be of build 15, which contains all of build 14: part 15.)* **Until then Mac build 13 is the build to use** (part 13 says where); it lacks only what this part describes.

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

- **Find and acquire: a stopped download asks nothing more (FR-757).** After build request 13 was pushed, one test failed on GitHub. It had caught a small fault of the app, older than this work: when a download of a free copy was stopped at one exact moment — by stopping the search, or by locking or closing the library — the app could still connect to the site it was about to download from. The site could see that your computer connected; no request was sent, nothing about what you were looking for went out, and nothing was downloaded or kept. Now a download checks whether it was stopped right before every request. A builder reproduced it and proved the cause (my own first guess, the date and time, was wrong); a reviewer who had not built the mend measured what could go out and confirmed the mend.

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
- **FR-765 (built and reviewed since; it comes with the next build):** when you lock a project or move the library while a lookup is under way, that lookup could still send its retries. It repeats a question the service was already asked before the lock, so nothing new goes out — but nothing at all should be asked after a lock. Found by the review of FR-757.
- **FR-764 (built with it):** the same kind of gap as FR-757 in three more places (a Zotero sync stopped while it waits to retry a file; two spots of the lookup): after a stop the app could still connect to the service once, without sending a request.
- **FR-767 (being built now):** the fault of FR-759 below, on four more paths — bulk import, watched folders, the Zotero import and Zotero sync. Found by reading; each is being proved first, then closed.
- **FR-768:** when one project's lookup is stopped, another project's next lookup at the same service can wait a few seconds longer than it needs to. Nothing is asked too early.
- **FR-766:** a leftover move folder opened while the library's own drive is unplugged says the move "could not be finished now" and to connect the drive; with the drive back it will say, rightly, that it is a leftover that can be deleted. Rare, and nothing is lost.
- **FR-763 (mended; it comes with the next build):** one test compared a fixed date with today's date and would have begun to fail by itself on 11 December. A fault of the test, not of the app. Every test was then run with the clock moved a year ahead; nothing else turned up.
- **FR-760:** two small points of the move, older than this work; nothing is lost.
- **FR-759 (checked, true, mended; it comes with the next build):** locking an encrypted project while a file was being attached could leave one answer about that file's source in the app's memory after the lock. Nothing was written to disk or sent anywhere, and you would not see it.
- **FR-753, FR-758, FR-762:** small corners you would not see. **FR-761:** whether the audit log can show events out of order; to be checked.
- **FR-751, FR-754:** two sentences to correct (a destruction certificate after a crash; a backup warning that points to a missing button).
- **FR-752:** in an encrypted project, a source's title is readable in its folder name. Still being checked.

## 15. Added on 25 November, midday: after a stop nothing more is asked, and after a lock nothing is kept

A short part. Build request 15 holds two safety mends that the review of the stopped download (part 14) led to, and one mended test. **Nothing on any screen changes.**

- **Tested together on my side:** every step passed at the first run (11,864 tests, 228 of 228 browser scenarios, the desktop scenarios, the app started and quit).
- **Pushed as build request 15** at 10:21 am Central on 25 November.
- **GitHub's own check is green** on exactly this code: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45652933197 (green at 11:34 am Central).
- **It is in `main`.** At 10:17 am Central you wrote "merge build 15 to main when the check is green"; I merged exactly build request 15 at 11:37 am Central.
- **No Mac build yet, of build 14 or of build 15.** GitHub gives this project no Mac during the US working day and gives one at once in the evening; I ask again at 6:30 pm Central. The build made then will be build 15, which contains all of build 14. Until then Mac build 13 is the build to use.

### What it mends

**A. After a stop, nothing more is asked (FR-765, FR-764).** When "Find and acquire" is stopped — by you, by locking a project, by moving or closing the library — the lookups it had under way end at once: no retry, no following of a redirect, no new request. A stopped Zotero sync ends its wait and asks nothing more. Before, a lookup already under way could still send its retries after the stop. Lookups of your other projects go on undisturbed.

**B. After a lock, nothing about the project stays in memory (FR-759, FR-767).** If an encrypted project was locked while the app was still waiting for an answer about one of its sources, that answer arrived after the lock and stayed in the app's memory. Nothing was written to disk or sent anywhere. This was real when attaching a file, in a bulk import, for watched folders, in the Zotero import and in Zotero sync; each was first proved by a test, then closed by one shared fix.

**C. A test that would have begun to fail by itself on 11 December** (it compared a fixed date with the day's date) is mended. A fault of the test, not of the app; every test was then run with the clock a year ahead and nothing else turned up.

A builder did the work; a reviewer who had not built it went through it twice and tried to break it (among other things: two projects asking the same service at the same moment, one of them locked — the other still got its answer).

### Things only you can check

Nothing new to see. Part 14's list holds, with the Mac build of build 15 once it exists.

### Two things I want you to know

1. **In an encrypted project, some words stay readable on the disk.** Each source's files and details are encrypted. Its year, first author and a short title stay readable in the names of its folder and files. The specification designed it so, to keep the library readable by a person, and an earlier ruling accepted the cost. Where participants' names are replaced by codes, the code appears there, not the name. A project that must hide its titles cannot do so today. **Your decision:** leave it as designed (nothing to do), or have coded folder names added for projects that need them (a new piece of work, not a small one).
2. **A new button is coming with build 16: "Back up now"**, on a project's Governance screen. An existing warning already told you to make a backup "from the project's settings", and no such place existed. The warning will name the button. If you would rather have no button and a shorter warning, say so.

### Still open

Being built now for build 16, each reviewed by someone who did not build it:

- **Nothing is asked for a locked project during imports either (FR-769)** — bulk import, the Zotero import and sync, attaching, and "Look up again". Built and reviewed.
- **The move:** two rare corners, and a truer sentence for a leftover folder whose library drive is unplugged (FR-760, FR-766). Built and reviewed.
- **The Governance screen says the state of backups in sentences**, where it showed a code (FR-751). Built and reviewed.
- **Live connections that went silent — after the Mac slept, for example — are opened again** on every screen that has one; the missing-files check shows its progress and has a "Stop". Being built.
- **Small tidying of the "did not answer in time" sentence** on four screens, and the button above. At its review.

Listed, not built:

- **FR-770:** a destruction certificate, which an ethics board may read, gives the state of the backups as a code, not a sentence.
- **FR-771:** whether a Zotero import's own requests to Zotero stop when its project is locked; to be checked.
- **FR-752** is answered above (point 1). **FR-761** was checked and is not a fault: the audit log is newest-first on purpose.
