# Owner's hands-on checklist

This is the hands-on test of Alexandrine Oxiana on your Mac. There are eleven scenarios. Each is a short list of checks. Each check says what to do, then what you should see. Tick the box when it is right. If it is not right, do not tick it; write it down (see "What to send back" at the end).

Words in **bold** are the exact words you can see on the screen: buttons, links, headings and messages. Install and open the app first with `docs/first-run.md`, but stop that guide before the step where it creates a library: scenario 1 does that.

## Before you start

- **Use a test library, not real research data.** This is a pre-release build. It can have faults, and some of the checks delete things on purpose (an import is undone, an old copy of a library is deleted).
- **The build is unsigned.** macOS asks you to allow it once ("Open Anyway": see `docs/first-run.md`).
- **How long it takes.** An estimate: about three hours in all, best split over two or three sittings. Scenarios 1, 2 and 5 take about 45 minutes; 3 and 4 about an hour; 6, 7 and 8 about 45 minutes; 9 and 10 about 45 minutes plus download time.
- **Things you must prepare.** A PDF of a journal article that prints its DOI (scenario 2). A small Zotero data folder of five to twenty items (scenario 3). A folder holding the `.HEIC` and `.MOV` files of one iPhone Live Photo taken with location on (scenario 4). A plain text file you will make from a block given in scenario 8. Three more PDFs (scenario 7). A browser with the extension installed (scenario 10): see the note at the top of scenario 10.
- **Typing paths.** Several screens ask for a full path, such as `/Users/yourname/Documents/Fieldwork library`. A full path starts with `/`. In the examples, replace `yourname` with your own user name. Outside the library chooser and the file drop area there is no button to pick a folder or file; you must type the whole path (known problem D12). macOS may ask whether the app may access your Documents or Desktop folder; allow it if you want the app to read there.
- **Which defects you will meet.** The first Mac build has twelve known open problems, called D1 to D8 and D10 to D13 (there is no D9 open). Where one affects a check, you will see a line "Known problem D<n> (being fixed)" under that check saying what you will see instead. Do not report those again. If a later build has fixed one, the check simply works: tick it.
- **Tasks not yet in this build.** The numbered scenarios are those of the project's plan. Scenarios 9, 10 and 11 depend on screens that are only partly in this build; each says so at its top.
- **Closing the app.** To close the app, close its window and wait until it has gone. Related to known problem D5: at present each time you start the app it shows **Choose a library**, and you click **Open** next to your library.

## Scenario 1. A library, and an IRB + GDPR project with encryption

- [ ] 1.1 Open the app. You should see a page headed **Choose a library**, saying "No libraries yet. Open a library folder, or create a new library below." (If you already have libraries listed, that sentence is not shown: go on.)
- [ ] 1.2 In **Library folder** type a new folder path (for example `/Users/yourname/Documents/Fieldwork library`), in **New library name** type `Fieldwork library`, and click **Create a new library in that folder**. You should see the library open with the heading **Fieldwork library**.
  - Known problem D12 (being fixed): you type the folder's full path (or use **Choose folder…**); other screens later have no picker at all.
- [ ] 1.3 While you typed, nothing popped up over the screen. A little after the library opens (up to a minute), a banner appears: "Some features need optional tools that are not included with the app: would you like to choose which to download?" with **Choose tools…** and **Not now**. Do not open **Optional tools** yet: opening that screen counts as answering the banner, and it then goes away.
- [ ] 1.4 Click **Choose tools…**. You should see a dialog **Optional tools** with "What will you do?" and the choices **Work with recordings**, **Save videos from the web**, **Save picture posts from the web**, **Read scanned documents**.
- [ ] 1.5 Press the Escape key. The dialog closes and the banner stays. Click **Not now**. The banner disappears. It does not come back when you open the library again.
- [ ] 1.6 Click **New project**. You should see a dialog headed **New project** with **Project name**, **Compliance profiles**, and **Data and encryption**.
- [ ] 1.7 Type `Riverbank oral histories` in **Project name** and tick **University IRB** and **GDPR**. You should see **This project holds identifiable information about people** ticked, **Encrypt this project** ticked and greyed out (you cannot untick it), and the words "Encryption is required."
- [ ] 1.8 Type a passphrase (at least something you will remember for this test) in **Passphrase** and again in **Passphrase again**, then click **Create project**. You should wait a few seconds (the encryption takes time), and then a dialog headed **Save the recovery code** appears.
- [ ] 1.9 The dialog says it is shown only once ("This is the only time it is shown") and shows the code as eight groups of four letters and digits joined by hyphens. Write the code down on paper.
- [ ] 1.10 The **Done** button is greyed out. Press the Escape key: the dialog stays open.
- [ ] 1.11 Tick **I have saved the recovery code**, then click **Done**. You should see **Riverbank oral histories** listed at the left under the projects list and marked as the chosen one, the code gone from the screen, and a **Lock project** button at the top.
- [ ] 1.12 In Finder open the library folder, then **Projects**, then the project's folder. You should see a readable `project.json`, a `manifest.json`, and folders named `keys` and `changes`.
- [ ] 1.13 Click **Lock project**. You should see the project's place taken by a screen saying "Riverbank oral histories is locked", with a box **Passphrase or recovery code** and an **Unlock** button, and no **Search sources** box.
- [ ] 1.14 Type a wrong passphrase and click **Unlock**. You should see the message "That passphrase didn't unlock this project. Nothing was changed." and the project stays locked.
- [ ] 1.15 Type the right passphrase and click **Unlock**. After a few seconds you should see the **Search sources** box again and no error.
- [ ] 1.16 Click **Lock project** again, then unlock with the recovery code you wrote down (type it with its hyphens). You should see the project open as before.

## Scenario 2. Attach a PDF with a DOI; the title is filled in; copy a citation

Needs an internet connection (the app looks the DOI up) and a PDF of a journal article that prints its DOI.

- [ ] 2.1 Click **New project**. Type `River memory` in **Project name**. Tick no compliance profile. Make sure **This project holds identifiable information about people** is not ticked and **Encrypt this project** is not ticked, then click **Create project**. You should see **River memory** selected, with no recovery code asked for.
- [ ] 2.2 With **River memory** selected, look for the drop area. You should see the words "Drop PDFs, EPUBs, images, audio or video here to attach them." with the buttons **Choose files…** and **Attach files…**.
- [ ] 2.3 Click **Choose files…** and choose your PDF (or drag the PDF onto the drop area). You should see a line with the file's name followed by "Added as a new source".
- [ ] 2.4 Look at the **Sources** list. You should see one source titled with the real title of the article (the title was looked up from its DOI), not the file's name.
- [ ] 2.5 Click the source's title. You should see a panel opening with the title as a heading, and the DOI among the identifiers.
- [ ] 2.6 In the **Cite** part of the panel you should see "Using: American Psychological Association 7th edition". Click **Copy citation**. You should see the citation shown in the panel (an in-text citation such as "(Author, 2021)") and the word "Copied."
- [ ] 2.7 Open any text document (not the app) and paste (Command-V). You should get exactly the citation the panel showed.

## Scenario 3. Bulk import of a Zotero data folder: collections, report, undo, review, import again

Needs a small Zotero data folder (five to twenty items; not your whole library). Zotero keeps its data in `/Users/yourname/Zotero` unless you moved it. Zotero may stay open; the app never changes it. Use a new, empty project: click **New project**, type `Market studies` in **Project name**, tick no compliance profile, make sure **This project holds identifiable information about people** and **Encrypt this project** are not ticked, and click **Create project**. (Do not use **River memory**: it already holds the article from scenario 2, which would change the counts below.)

This scenario does the undo before the review. The plan's order is review, then report and undo; the build cannot do that yet (D1), so the order is changed.

- [ ] 3.1 In the library screen click **Import** (at the top). You should see a page headed **Bulk import** with a section **Source** and a choice **Import from**.
- [ ] 3.2 Under **Import from** choose **Zotero library** and type your Zotero folder's path in **Zotero data folder**. Click **Scan**. You should see "Scanning… nothing is changed yet." and then a section **Scan results** with the counts **Items**, **Likely duplicates**, **Already imported** and **Unreadable**, and the words "Nothing has been imported or changed yet."
  - Known problem D12 (being fixed): you must type the Zotero folder's full path; there is no picker.
- [ ] 3.3 If a section **Files outside the source folder** appears (your Zotero items link to files outside its data folder), tick **Approve this folder and its subfolders** for each folder you recognise. If it does not appear, go on.
- [ ] 3.4 Click **Next**. You should see **Review**, which says items identified with a confidence of 90% or more are accepted on their own. Click **Next** again. You should see **Options**, with these chosen: **Copy into the library**, **Folders become collections**, **Merge into the existing source**, and **OCR scanned PDFs** ticked, **Transcribe audio and video** not ticked.
- [ ] 3.5 Click **Start import**. You should see **Run** with an **Import progress** bar, and then **Report and undo** saying "Import 1. The import finished." and a table with **Created** and, if some items are uncertain, **Waiting for review**.
  - Known problem D4 (being fixed): if some of your Zotero items point to files kept outside Zotero's data folder, those files stay linked where they are rather than being copied in, and the report does not say so.
- [ ] 3.6 Click **Undo import**. You should see a dialog asking "Remove N imported sources?" (N is the number of **Created** plus **Waiting for review**), with **Cancel** selected.
- [ ] 3.7 In the dialog click **Undo import**. You should see "Removed N sources and restored 0 sources that had been merged or updated." and "Import 1. This import was undone."
- [ ] 3.8 Click **Back to library**. You should see the project **Market studies** with no sources, and no collections made by the import.
- [ ] 3.9 Import again: click **Import**, choose **Zotero library**, type the same folder, click **Scan**. You should see the same number of **Items** as before and **Already imported** at 0. Click **Next**, **Next**, **Start import**. You should see "Import 2. The import finished." with the same **Created** count as the first time.
- [ ] 3.10 If **Waiting for review** shows a number above 0, click **Open the review queue (N items)**. You should see a page headed **Review queue** with the waiting items listed (one is chosen), a section **Why it needs review** and a section **Candidate matches**. (If it is 0, say so when you report; this check cannot be done.)
- [ ] 3.11 Click **Edit** (among the buttons that decide the item). A form opens with a field **Title**. Change the title, then click **Save and accept**. You should see the item leave the waiting list. When no item is left you should see "Nothing is waiting for review in this import."
  - Known problem D1 (being fixed): after the review queue there is no link back to the import's report or its **Undo import**. Use **Back to library**.
- [ ] 3.12 Click **Back to library**. You should see your imported sources in the **Sources** list ("N sources") and your Zotero collections in the **Collections** list at the left, with sub-collections inside their parent. The edited title is shown.
  - Known problem D2 (being fixed): the item you accepted in the review queue still shows a **Needs review** badge in the list.
- [ ] 3.13 Click one of your collections. You should see only its sources, and the count changes. Click **All sources** to see them all again.

## Scenario 4. Import a phone's Live Photo: one source, viewing copies, location coarsened

Needs the Optional tool **Video tools (ffmpeg)** installed first (do scenario 9's check 9.2 first, or install it now from **Optional tools**; it needs an internet connection). Without it the viewing copies are not made ("proxy pending"). Needs a folder with the `.HEIC` and `.MOV` files of one Live Photo that has a location, for example `/Users/yourname/PHONE/DCIM/100APPLE/IMG_0001.HEIC` and `IMG_0001.MOV`. Getting those two files from your iPhone onto the Mac is not covered here: if you do not know how, ask for help before you start this scenario.

- [ ] 4.1 Click **New project**. Type `Harbour walk` in **Project name**, tick no compliance profile, make sure **This project holds identifiable information about people** is not ticked, tick **Encrypt this project**, type a passphrase twice, click **Create project**, and save the recovery code as in scenario 1. Then click **Governance and records**. You should see **Encryption at rest** set to `required` and, under **Sharing and export**, **Location metadata in shared copies** set to `coarsen`. If either says anything else, note it and send it back. Click **Back to library**.
- [ ] 4.2 Click **Import**, choose **Camera or phone folder**, type the folder's path (the folder that holds the two files) in the box **Camera or phone folder**, and click **Scan**. You should see **Scan results** counting "image: 1, video: 1" and a note that pairing happens during the import.
  - Known problem D12 (being fixed): you must type the folder's full path; there is no picker.
- [ ] 4.3 Click **Next**, **Next**, then **Start import**. You should see **Report and undo** with **Created** 1 and no **Failed** row, and a section **Project rules applied** listing "store: allow_with_conditions".
- [ ] 4.4 Click **Back to library**. You should see "1 source" with its type shown as **Field photo**, titled with the date, the phone model and the file name (for example "2026-03-14 iPhone 15 Pro - IMG_0001").
- [ ] 4.5 The viewing copies are made in the background: give it up to a minute. Click the source's title. In the panel that opens you should see two files listed with "proxy · … · encrypted" (one for the photo, one for the video). If they are not there after a few minutes, check that **Video tools (ffmpeg)** shows **Installed** under **Optional tools**.
  - Known problem D3 (being fixed): the source screen shows only the names of the viewing copies, no picture of them.
- [ ] 4.6 In Finder, open the library folder, **Projects**, the project, **Sources**, and the source's folder. You should see that every stored file name ends in `.enc` (stored encrypted), and that the phone's own file names (`IMG_0001.HEIC`) do not appear as ordinary files. The app cannot yet show you the coarsened location itself; this check only shows the copies exist and are encrypted.

## Scenario 5. Dark theme and another typeface survive closing and reopening

- [ ] 5.1 In the library screen click **Appearance**. You should see a page headed **Appearance** with **Theme**, **Typefaces**, **Size and spacing**.
- [ ] 5.2 Under **Color theme** choose **Dark**. You should see the whole app turn dark at once. (The theme starts at **Follow system**: if your Mac is already in dark mode, nothing changes yet. Then choose **Light** first and watch it change, then **Dark**.)
- [ ] 5.3 Under **Typefaces** open the **Interface typeface** list and choose "Atkinson Hyperlegible (bundled, readability)". You should see the app's text change to a plainer, sans-serif face.
- [ ] 5.4 Close the app's window, wait until it has gone, and open the app again. Open your library. You should see the app still dark and still in the new typeface.
- [ ] 5.5 Open your library again and click **Appearance**. You should see **Dark** chosen and **Atkinson Hyperlegible** in **Interface typeface**.
- [ ] 5.6 Open the app's settings folder (see `docs/first-run.md`: `~/Library/Application Support/org.alexandrineoxiana.desktop`) and its `settings` folder. You should see a file `appearance.json` there, and no such file anywhere inside your library folder.
- [ ] 5.7 Set the theme back to your preference.

## Scenario 6. Move the library, check it, delete the old copy; rename it outside the app and find it again

- [ ] 6.1 Make sure the library has at least one source (select **River memory**, which holds the article from scenario 2). With that project selected, click **Governance and records** in the library screen. You should see a row of links across the top of the page: **Governance**, **Audit log**, **Fieldwork**, **Move library** and **Missing files**. Click **Move library**. You should see a page headed **Move library**.
- [ ] 6.2 Type a folder that does not exist yet (for example `/Users/yourname/Documents/Fieldwork library moved`; the folder `Documents` must exist) in **Destination folder** and click **Check destination**. You should see a **Move plan** saying how many files and how many MB it will move and "to a destination of kind …", and a table with each project and the word **Allowed**. Nothing has been copied yet: the folder does not exist in Finder.
  - Known problem D12 (being fixed): you must type the destination's full path; there is no picker.
- [ ] 6.3 In the **Move plan** click **Move library**. You should see **Progress** with the words "Copying: N of M files" (a small library may finish too fast to see this), and then a message "All N files were copied and verified." and "The library now opens from" your new folder.
- [ ] 6.4 In Finder check both folders exist: the old library folder (still there) and the new one.
- [ ] 6.5 Click **Delete old copy**. You should see a dialog **Delete old copy** with a box **Type delete to confirm** and the button **Delete the old copy** greyed out. Type `delete`: the button becomes available. Click it. You should see "The old copy was deleted."
- [ ] 6.6 In Finder the old folder has gone and the new one remains. Click **Back to library**. You should see the library opens with its source list as before.
- [ ] 6.7 Close the app's window and wait until it has gone. In Finder rename the library's folder (the new one), for example by adding ` (renamed)` to its name. Open the app again. You should see **Library not found** straight away, naming your library.
  - Known problem D5 (being fixed): instead you see **Choose a library**, with your library listed with the path where it was. The next check covers both.
- [ ] 6.8 If you saw **Choose a library**, click **Open** next to the library. You should see a page headed "Library not found: " followed by the library's name, and "Last seen at" the old path, with buttons **Locate library…**, **Search for library**, **Wait for the drive** and **Open a different library**.
- [ ] 6.9 Click **Search for library**. You should see "Searching drives and cloud folders…", then "Search finished." and a list **Libraries found** with the renamed folder and a button **Use this library**. If it says "Search finished. The library was not found.", click **Locate library…** instead, type the renamed folder's full path in **Library folder**, and click **Reconnect**; note in your report that Search did not find it, and where the folder was. (Search looks through external and network drives, iCloud, Dropbox, Google Drive and OneDrive, then your home folder down to four levels, so a renamed folder in Documents should be found. macOS may ask whether the app may access folders such as Documents: allow it.)
  - Known problem D12 (being fixed): in the **Locate library…** form you must type the full path.
- [ ] 6.10 Click **Use this library**. You should see the library open with its name as the heading and its source still in the list.

## Scenario 7. Delete the search index; the app rebuilds it; nothing is lost

Needs a library with a new project that holds only three sources (so that "3 sources" is right). Click **New project**, name it `Harbour records`, tick no profile, leave the identifiable and encryption boxes unticked, then attach three PDFs with **Choose files…** (their titles should differ, for example "Tide notes", "Harbour ledger", "Salt marsh survey").

- [ ] 7.1 You should see all three in the **Sources** list. Type a word of one title (for example `ledger`) in **Search sources**: only that source is shown. Clear the box.
- [ ] 7.2 Close the app's window and wait until it has gone. In Finder open the library folder. Delete the file `library.sqlite`, and also `library.sqlite-wal` and `library.sqlite-shm` if they are there. Do not touch any other file.
- [ ] 7.3 Open the app again and open your library (**Choose a library**, then **Open**). You should see the library open, and a new `library.sqlite` appear in the folder.
  - Known problem D5 (being fixed): the app shows **Choose a library**, which is why you click **Open** here.
- [ ] 7.4 Select the project. You should see its three sources listed again and "3 sources". Type `ledger` in **Search sources**: only that source is shown.
  - Known problem D8 (being fixed): the library opens but the project shows no sources, because the app does not rebuild the missing index and has no button to do it. Do not worry: the files are still on disk.
- [ ] 7.5 In Finder open the library folder, **Projects**, the project, **Sources**. You should see three source folders, as before. Nothing was lost.

## Scenario 8. Titles in eight scripts, right to left for Arabic and Hebrew

You make a small file with eight titles, then import it. Open Terminal, paste the whole block below, and press Return. It makes the file `titles.json` on your Desktop.

```
cat > ~/Desktop/titles.json <<'EOF'
[
{"id":"t0","type":"book","title":"الأسواق غير الرسمية في القاهرة","issued":{"date-parts":[[2020]]}},
{"id":"t1","type":"book","title":"שווקים וזיכרון בירושלים","issued":{"date-parts":[[2021]]}},
{"id":"t2","type":"book","title":"上海的街头市场与城市记忆","issued":{"date-parts":[[2022]]}},
{"id":"t3","type":"book","title":"東京の市場と記憶","issued":{"date-parts":[[2023]]}},
{"id":"t4","type":"book","title":"서울의 전통 시장과 기억","issued":{"date-parts":[[2024]]}},
{"id":"t5","type":"book","title":"दिल्ली के बाज़ार और स्मृति","issued":{"date-parts":[[2025]]}},
{"id":"t6","type":"book","title":"Οι αγορές της Αθήνας","issued":{"date-parts":[[2026]]}},
{"id":"t7","type":"book","title":"Рынки Москвы и память города","issued":{"date-parts":[[2027]]}}
]
EOF
```

- [ ] 8.1 In a new project (for example `Markets in eight scripts`, no profiles), click **Import**, choose **Reference file**, choose **CSL-JSON** in **Format**, type `/Users/yourname/Desktop/titles.json` in **File path**, and click **Scan**. You should see **Scan results** with 8 **Items**.
  - Known problem D12 (being fixed): you must type the file's full path; there is no picker.
- [ ] 8.2 Click **Next**, **Next**, **Start import**. You should see **Report and undo** saying "Import 1. The import finished." Click **Back to library**.
- [ ] 8.3 You should see "8 sources" in the list, each title in its own script, with no empty squares or broken letters: Arabic, Hebrew, Chinese, Japanese, Korean, Devanagari (Hindi), Greek and Cyrillic (Russian).
  - Known problem D6 (being fixed): in the Safari-type web view that macOS uses, one of the app's typefaces may fail to finish loading, which can make some text appear in a fallback typeface. It is not yet known whether the Mac window shows this: report what you see.
- [ ] 8.4 The Arabic and Hebrew titles read from right to left (the words run from the right-hand end). The other six read from left to right. The rest of the screen (column headings, buttons) stays left to right.
- [ ] 8.5 Take a screenshot of the list.
- [ ] 8.6 Click each title in turn. You should see the panel with that title as a heading, in the right script.
- [ ] 8.7 Click the Arabic title again and look at the heading in the panel. It should be aligned to the right, as right-to-left text is.
  - Known problem D7 (being fixed): the heading of a right-to-left title is laid out left to right (aligned to the left) even though the letters read from the right. The titles in the list (8.4) may be aligned to the left in the same way; that is the same problem.
- [ ] 8.8 Take a screenshot of the Arabic source's panel.

## Scenario 9. Capture a YouTube and an Instagram link; open the transcript; edit a flagged segment

This needs an internet connection, real tools on your Mac and real web addresses. **It cannot be done by hand in this build.** The Capture screen and the transcript screen exist in the build, but no button or link in the library screens opens either of them, so you cannot reach them by clicking. Known problem D10 (being fixed): nothing in the interface links to the Capture screen or to the transcript viewer, and the desktop app has no address bar. The checks below cover what does exist today: the tools this scenario will need.

Before the scenario can be done you will need these Optional tools installed (the checks below install them): **Video downloader**, **Image downloader**, **Video tools (ffmpeg)** and one **Speech model**. Each download contacts only its publisher and needs an internet connection.

- [ ] 9.1 Click **Optional tools** at the top of the library screen. You should see a page headed **Optional tools** with the groups **Speech recognition**, **Saving from the web**, **Video conversion** and **Scanned documents**. Each tool shows what it is for, "Without it:", whether it is **Not installed**, its "Download size:" and "Downloads from:".
- [ ] 9.2 On **Video tools (ffmpeg)** click **Install**. You should see a progress line "Installing… N%" with a bar and a **Cancel** button, and at the end the card says **Installed**. (If ffmpeg is already on your Mac, for example from Homebrew, the card says **Installed** at once with "Found on this computer (not the app's own copy)…" and has no **Install**, **Update** or **Remove** button: go on.)
- [ ] 9.3 Do the same for **Video downloader** (it includes two parts), **Image downloader** and **Speech model: tiny** (the smallest and quickest). Each should end as **Installed**.
- [ ] 9.4 On **Text recognition (OCR)** you should see **Not available on this computer** and a reason beginning "No tesseract build is published for this platform yet". This is expected on a Mac for now. (If tesseract is already on your Mac, the card says **Installed** instead.)
- [ ] 9.5 On a tool that the app installed, you should see **Update** and **Remove** buttons. Do not remove ffmpeg: scenario 4 needs it.

## Scenario 10. Capture a profile twice; the missing item is flagged as removed; pair the browser extension

Needs an internet connection. **The profile capture cannot be done by hand in this build**, for the same reason as scenario 9 (known problem D10: no way to open the Capture screen). What can be tested today is pairing the browser extension and capturing a page with it.

**The extension.** You need it installed in Chrome, Edge or Firefox (not Safari). See `docs/first-run.md`, "Pairing the browser extension". If the GitHub run page you downloaded the app from lists an artifact called `alexandrine-oxiana-browser-extension`, download and unzip it, and follow that section. If it does not (the build of 2026-11-12 has none), the extension cannot be installed without a developer's help: skip checks 10.2 to 10.8 and say so in your report. Do this whole scenario in one sitting without quitting the app (known problem D13, below).

- [ ] 10.1 Allow browser capture in the project **River memory**: select it, click **Governance and records**, click **View governance.yaml**, and add this line at the end of the text: `captureMethods: [manual_upload, zotero_import, refman_import, calibre_import, device_import, browser_capture, downloader]`. Click **Save changes**. The app says "This change loosens the project's rules, so it needs a reason" and opens a dialog **Record a reason** with the fields **Reason** and **Approved by**: fill them in and click **Record reason**. You should then see **Saved.**
  - Known problem D11 (being fixed): the Governance form has no control for capture methods, so a new project allows neither browser capture nor the downloader, and the only way is this edit of the `governance.yaml` text. It is a workaround that will go away when the form has the control.
- [ ] 10.2 Click **Back to library**, then **Browser extension**. You should see a page headed **Browser extension** with a section **Pair a browser**, three steps, and a list **Paired browsers** saying "No browser is paired yet." (or listing earlier ones).
- [ ] 10.3 Click **Show a pairing code**. You should see a code of six digits split in two groups of three, "Valid for" a countdown, and a **Port** number.
- [ ] 10.4 In your browser click the extension's icon. You should see **Pair with the desktop app** with the boxes **Port** and **Pairing code**. Type the port and the six digits, and click **Pair**. The popup should say "Pairing done. Choose a project below."
  - Known problem D13 (being fixed): the paired browser stops working each time the app is reopened, because the app takes a new port at every start and the extension keeps the old one. After a reopen the popup still says "Paired with the desktop app (port N)" but every capture fails with "The desktop app is not answering on port N. Is it open?". The way round for now: in the popup click **Unpair**, in the app click **Show a pairing code**, and pair again with the new port and code.
- [ ] 10.5 Look back at the app. You should see "The code was used: a browser was paired, and the code can't be used again. Show a new code to pair another browser." and, under **Paired browsers**, an entry with the extension's address (it begins `chrome-extension://` or `moz-extension://`, not the browser's name) and "Paired" with a date.
- [ ] 10.6 In the popup, choose **River memory** in **Project** (if it says "No project allows browser capture", check 10.1). Open any ordinary web page in a tab, click the extension's icon and click **Capture this page**. Keep the tab in front until the popup says "Captured: saved to your library."
- [ ] 10.7 Back in the app, select **River memory**. You should see a new source for the page in the **Sources** list.
- [ ] 10.8 On the **Browser extension** page click **Revoke** next to the extension's entry, then **Revoke pairing** in the dialog **Revoke this browser?**. You should see "Revoked" followed by the extension's address and "It cannot capture until it is paired again."

## Scenario 11. A planted DOI and title conflict appears in the review queue; choosing a value shows "confirmed by you"

**Nothing in this scenario can be tested in this build.** It depends on the verification badges (Task 34d), which are not in this build, and on a way to plant a conflict, which exists only in the automated test. There are no checks to do. Leave it for the next build.

## What to send back

For each check that did not turn out as described, send:

1. **The scenario and check number**, for example "6.9".
2. **What you saw**, in a sentence or two: the exact words on the screen if there are any (copy any error message).
3. **A screenshot** of the whole window at that moment.

Also tell me:

- which checks you could not do, and why;
- anything that felt confusing, even if it worked;
- which build you tested: the name of the GitHub run you downloaded from.

Do not report the "Known problem" lines again. If one of them looks different from its description, do report that.
