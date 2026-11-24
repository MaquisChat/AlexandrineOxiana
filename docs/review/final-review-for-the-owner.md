# The final review — what I need from you

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
   **What it is:** If a request never gets an answer, a screen's first read can stay at "Reading…" for ever. This was seen once in the web view the Mac uses. The app has no give-up.
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

*Use Mac build 10 for these (part 10 says where to download it). Note your findings beside each box.*

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
- [ ] Note whether any screen ever stays at "Reading…". (FR-575, FR-595)

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

**Your Mac build was build 9 (24 November 2026) when this part was written; **build 10 (part 10) now replaces it.** Build 9 replaced build 8.** It is the first Mac build with the PDF reader, Zotero account sync, cloud folders, Find and acquire, and every fix since your build 4. It passed every start-up check on GitHub's Mac, in both the debug app and the release app from the disk image.

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

- [ ] **1. Install Mac build 10** (part 10 says where: run 13's download). It replaces builds 8 and 9: build 8 could not install any optional tool, build 9 mended that, and build 10 adds the rough-edge fixes.
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
- **It is in `main`** (the approved version) since 24 November, shortly before 11 pm Central on the 23rd: you said "Merge and keep building please". GitHub's check of the merged state is running as I write; I will tell you its result.
- **What I build next, as you asked:** the known gaps at the end of this part (FR-717 to FR-741), most serious first.

### What you will notice

**The library and projects**
- A collection's little arrow now opens and closes it with a mouse click.
- Renaming a workspace tag asks you first.
- An import's report shows "Collections created" and "Tags created". For older imports too, the review queue now warns that names may come from folder names.
- A new project whose rules need things only you can give (such as a destruction date) lists them as soon as it is created, with "Open Governance".
- On Fieldwork you can detach a signed form ("Detach the form…"). The app asks for a reason.
- A project name written right to left no longer flips the banner.
- An interrupted change is reported once per project: "A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back."

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

### Things only you can check in build 10
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

### What I am building next, and GitHub's check (24 November, 2:30 am Central)

- **Building now, as you asked ("keep building"):** the known gaps listed below, except decisions 28 and 29 — 23 items in nine batches. Seven batches are built and with their second reviewers now; two more follow on the same code. Then everything is tested together and comes to you as Mac build 11. Nothing reaches `main` without your word.
- **Two things build 11 will change that you will notice:** Quit goes the safe way (decision 30 above), and every ready-made library inside the media helper is pinned to exactly what build 10 holds, so a build no longer changes by itself.
- **GitHub's own check:** green on the working branch since 12:11 am Central, with the whole rough-edges round in it. On `main` it is red for a reason outside the app: one of Ubuntu's package mirrors was missing a file for hours, so the check could not install its tools on most of GitHub's machines. I have re-run those jobs now that the mirror has had time to catch up, and I added a third download source to the check on the working branch; that small change reaches `main` with the next merge you approve.

### Known gaps found during the round (not fixed)
- **FR-738:** after two crashes in a row, the second at one exact moment of Find and acquire's own repair, that project would stay blocked: each time the library opens, the app tries to undo the change and refuses. Nothing is lost. It is very unlikely.
- **FR-735, FR-736:** when a file put there by hand is in the way, the original is kept, but the app cannot yet put it back itself, and its messages do not tell you what to do.
- **FR-722:** a network that inspects secure connections (some universities) still refuses tool downloads. The app's message says why.
- **FR-729:** warnings shown when a library reopens are gone after a restart.
- **FR-733:** a move refused at its start restarts a running transcription.
- **FR-727, FR-728:** a broken shortcut counts as a present file, and a waiting entry is not judged again when a file arrives some other way.
- **FR-723, FR-737:** rare cases in undoing an unfinished change.
- **FR-724, FR-732:** small inaccuracies in an export's notes about left-out files.
- Small technical points, and small points of wording, focus and speed: FR-725, FR-726, FR-730, FR-734, FR-739, FR-740, FR-741.
