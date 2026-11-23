# Owner's hands-on checklist

This is the hands-on test of Alexandrine Oxiana on your Mac. There are eleven scenarios. Each is a short list of checks. Each check says what to do, then what you should see. Tick the box when it is right. If it is not right, do not tick it; write it down (see "What to send back" at the end).

Words in **bold** are the exact words you can see on the screen: buttons, links, headings and messages. Install and open the app first with `docs/first-run.md`, but stop that guide before the step where it creates a library: scenario 1 does that.

## Before you start

- **Use a test library, not real research data.** This is a pre-release build. It can have faults, and some of the checks delete things on purpose (an import is undone, an old copy of a library is deleted).
- **The build is unsigned.** macOS asks you to allow it once ("Open Anyway": see `docs/first-run.md`).
- **How long it takes.** An estimate: about three hours in all, best split over two or three sittings. Scenarios 1, 2 and 5 take about 45 minutes; 3 and 4 about an hour; 6, 7 and 8 about 45 minutes; 9, 10 and 11 about an hour and a half plus download time.
- **Things you must prepare.** A PDF of a journal article that prints its DOI (scenario 2). A small Zotero data folder of five to twenty items (scenario 3). A folder holding the `.HEIC` and `.MOV` files of one iPhone Live Photo taken with location on (scenario 4). A plain text file you will make from a block given in scenario 8. Three more PDFs (scenario 7). For scenario 9, the web address of a short public YouTube video with speech in it. For scenario 10, a browser with the extension installed (see the note at the top of scenario 10), and the web address of a profile, channel or playlist that you may capture; a YouTube playlist of your own with three or four videos is best (see scenario 10).
- **Choosing folders and files.** Wherever a screen asks for a folder or file, it has a button **Choose folder…** or **Choose file…** beside the box; it opens the usual macOS window, and the path you choose is put in the box for you. You can still type a full path instead (it starts with `/`; replace `yourname` in the examples with your own user name). macOS may ask whether the app may access your Documents or Desktop folder; allow it if you want the app to read there.
- **If something is different.** Every check says what you should see. If you see something else, do not tick it: write it down (see "What to send back"). That includes a message you did not expect and a screen that does not look like the words here.
- **Scenarios 9, 10 and 11.** They need an internet connection, optional tools that you install from the app, and real web addresses that you choose. Each says at its top what it needs and what cannot be checked by hand.
- **Closing the app.** To close the app, close its window and wait until it has gone. When you start it again it opens the library that was open last time by itself; you do not need to choose it again.

## Scenario 1. A library, and an IRB + GDPR project with encryption

- [ ] 1.1 Open the app. You should see a page headed **Choose a library**, saying "No libraries yet. Open a library folder, or create a new library below." (If you already have libraries listed, that sentence is not shown: go on.)
- [ ] 1.2 Next to **Library folder** click **Choose folder…** and pick a new, empty folder (or type a new folder path, for example `/Users/yourname/Documents/Fieldwork library`), in **New library name** type `Fieldwork library`, and click **Create a new library in that folder**. You should see the library open with the heading **Fieldwork library**.
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

## Scenario 3. Bulk import of a Zotero data folder: collections, review, report, undo, import again

Needs a small Zotero data folder (five to twenty items; not your whole library). Zotero keeps its data in `/Users/yourname/Zotero` unless you moved it. Zotero may stay open; the app never changes it. Use a new, empty project: click **New project**, type `Market studies` in **Project name**, tick no compliance profile, make sure **This project holds identifiable information about people** and **Encrypt this project** are not ticked, and click **Create project**. (Do not use **River memory**: it already holds the article from scenario 2, which would change the counts below.)

- [ ] 3.1 In the library screen click **Import** (at the top). You should see a page headed **Bulk import** with a section **Source** and a choice **Import from**.
- [ ] 3.2 Under **Import from** choose **Zotero library**. Next to **Zotero data folder** click **Choose folder…** and pick your Zotero folder (or type its path; the page also lists **Zotero data folders found on this computer**, each with a **Use** button). Click **Scan**. You should see "Scanning… nothing is changed yet." and then a section **Scan results** with the counts **Items**, **Likely duplicates**, **Already imported** and **Unreadable**, and the words "Nothing has been imported or changed yet."
- [ ] 3.3 If a section **Files outside the source folder** appears (your Zotero items link to files outside its data folder), tick **Approve this folder and its subfolders** for each folder you recognise. If it does not appear, go on.
- [ ] 3.4 Click **Next**. You should see **Review**, which says items identified with a confidence of 90% or more are accepted on their own. Click **Next** again. You should see **Options**, with these chosen: **Copy into the library**, **Folders become collections**, **Merge into the existing source**, and **OCR scanned PDFs** ticked, **Transcribe audio and video** not ticked. If some of your items link to files outside Zotero's data folder you also see an unticked box such as "Keep the 2 files Zotero links to where they are, as links": leave it unticked.
- [ ] 3.5 Click **Start import**. You should see **Run** with an **Import progress** bar, and then **Report and undo** saying "Import 1. The import finished." and a table with **Created** and, if some items are uncertain, **Waiting for review**.
- [ ] 3.6 In the same table you should see **Files copied into the library** and **Files left as links**. With the box in 3.4 unticked and your outside folders approved in 3.3, **Files left as links** is 0. A section **Notes about files** may list files that were not copied.
- [ ] 3.7 If **Waiting for review** shows a number above 0, click **Open the review queue (N items)**. You should see a page headed **Review queue** with the waiting items listed (one is chosen), a section **Why it needs review** and a section **Candidate matches**, and at the top a link **Back to the import's report and undo**. (If it is 0, say so when you report; checks 3.7 to 3.9 cannot be done.)
- [ ] 3.8 Click **Edit** (among the buttons that decide the item). A form opens with a field **Title**. Change the title, then click **Save and accept**. You should see the item leave the waiting list. Decide any other waiting item the same way (**Accept** is enough). When no item is left you should see "Nothing is waiting for review in this import."
- [ ] 3.9 Click **Back to the import's report and undo**. You should see **Report and undo** again, with "Import 1. The import finished." and the button **Undo import**.
- [ ] 3.10 Click **Back to library**. You should see your imported sources in the **Sources** list ("N sources") and your Zotero collections in the **Collections** list at the left, with sub-collections inside their parent. The title you edited is shown, and no source carries a **Needs review** badge.
- [ ] 3.11 Click one of your collections. You should see only its sources, and the count changes. Click **All sources** to see them all again.
- [ ] 3.12 Click **Import** (at the top). In the section **Recent imports** you should see a link that begins "Import 1 —" and ends "(finished)". Click it. You should see the same report, with **Undo import**.
- [ ] 3.13 Click **Undo import**. You should see a dialog asking "Remove N imported sources?" (N is the number of **Created** plus **Waiting for review**), with **Cancel** selected.
- [ ] 3.14 In the dialog click **Undo import**. You should see "Removed N sources and restored 0 sources that had been merged or updated." and "Import 1. This import was undone."
- [ ] 3.15 Click **Back to library**. You should see the project **Market studies** with no sources, and no collections made by the import.
- [ ] 3.16 Import again: click **Import**, choose **Zotero library**, choose or type the same folder, click **Scan** (approve the outside folders again if asked). You should see the same number of **Items** as before and **Already imported** at 0. Click **Next**, **Next**, **Start import**. You should see "Import 2. The import finished." with the same **Created** count as the first time.

## Scenario 4. Import a phone's Live Photo: one source, viewing copies, location coarsened

Needs the Optional tool **Video tools (ffmpeg)** installed first (do scenario 9's check 9.2 first, or install it now from **Optional tools**; it needs an internet connection). Without it the viewing copies are not made ("proxy pending"). Needs a folder with the `.HEIC` and `.MOV` files of one Live Photo that has a location, for example `/Users/yourname/PHONE/DCIM/100APPLE/IMG_0001.HEIC` and `IMG_0001.MOV`. Getting those two files from your iPhone onto the Mac is not covered here: if you do not know how, ask for help before you start this scenario.

- [ ] 4.1 Click **New project**. Type `Harbour walk` in **Project name**, tick no compliance profile, make sure **This project holds identifiable information about people** is not ticked, tick **Encrypt this project**, type a passphrase twice, click **Create project**, and save the recovery code as in scenario 1. Then click **Governance and records**. You should see **Encryption at rest** set to `required` and, under **Sharing and export**, **Location metadata in shared copies** set to `coarsen`. If either says anything else, note it and send it back. Click **Back to library**.
- [ ] 4.2 Click **Import**, choose **Camera or phone folder**, click **Choose folder…** beside the box **Camera or phone folder** and pick the folder that holds the two files (or type its path), and click **Scan**. You should see **Scan results** counting "image: 1, video: 1" and a note that pairing happens during the import.
- [ ] 4.3 Click **Next**, **Next**, then **Start import**. You should see **Report and undo** with **Created** 1 and no **Failed** row, and a section **Project rules applied** listing "store: allow_with_conditions".
- [ ] 4.4 Click **Back to library**. You should see "1 source" with its type shown as **Field photo**, titled with the date, the phone model and the file name (for example "2026-03-14 iPhone 15 Pro - IMG_0001").
- [ ] 4.5 The viewing copies are made in the background: give it up to a minute. Click the source's title. In the panel that opens you should see two files listed with "proxy · … · encrypted" (one for the photo, one for the video). If they are not there after a few minutes, check that **Video tools (ffmpeg)** shows **Installed** under **Optional tools**.
- [ ] 4.6 In the same panel, under **Pictures**, you should see the photo's viewing copy as a picture, captioned "Viewing copy:" followed by its file name. This is the first time the picture is checked in the real Mac window: if you see "could not be shown" or an empty frame instead, report what you see.
- [ ] 4.7 In Finder, open the library folder, **Projects**, the project, **Sources**, and the source's folder. You should see that every stored file name ends in `.enc` (stored encrypted), and that the phone's own file names (`IMG_0001.HEIC`) do not appear as ordinary files. The app cannot yet show you the coarsened location itself; this check only shows the copies exist and are encrypted.

## Scenario 5. Dark theme and another typeface survive closing and reopening

- [ ] 5.1 In the library screen click **Appearance**. You should see a page headed **Appearance** with **Theme**, **Typefaces**, **Size and spacing**.
- [ ] 5.2 Under **Color theme** choose **Dark**. You should see the whole app turn dark at once. (The theme starts at **Follow system**: if your Mac is already in dark mode, nothing changes yet. Then choose **Light** first and watch it change, then **Dark**.)
- [ ] 5.3 Under **Typefaces** open the **Interface typeface** list and choose "Atkinson Hyperlegible (bundled, readability)". You should see the app's text change to a plainer, sans-serif face.
- [ ] 5.4 Close the app's window, wait until it has gone, and open the app again. You should see your library open by itself, with the app still dark and still in the new typeface.
- [ ] 5.5 Click **Appearance**. You should see **Dark** chosen and **Atkinson Hyperlegible** in **Interface typeface**.
- [ ] 5.6 Open the app's settings folder (see `docs/first-run.md`: `~/Library/Application Support/org.alexandrineoxiana.desktop`) and its `settings` folder. You should see a file `appearance.json` there, and no such file anywhere inside your library folder.
- [ ] 5.7 Set the theme back to your preference.

## Scenario 6. Move the library, check it, delete the old copy; rename it outside the app and find it again

- [ ] 6.1 Make sure the library has at least one source (select **River memory**, which holds the article from scenario 2). With that project selected, click **Governance and records** in the library screen. You should see a row of links across the top of the page: **Governance**, **Audit log**, **Fieldwork**, **Move library** and **Missing files**. Click **Move library**. You should see a page headed **Move library**.
- [ ] 6.2 Next to **Destination folder** click **Choose folder…**. The window says at its top "Choose an empty folder for the library"; make a new folder in it with **New Folder** (for example `Fieldwork library moved` inside **Documents**) and choose it. (You can also type a folder that does not exist yet, for example `/Users/yourname/Documents/Fieldwork library moved`; the folder `Documents` must exist.) Under the box the page says "The folder must be new or empty. In the dialog you can make one with New Folder." Click **Check destination**. You should see a **Move plan** saying how many files and how many MB it will move and "to a destination of kind …", and a table with each project and the word **Allowed**. Nothing has been copied yet.
- [ ] 6.3 In the **Move plan** click **Move library**. You should see **Progress** with the words "Copying: N of M files" (a small library may finish too fast to see this), and then a message "All N files were copied and verified." and "The library now opens from" your new folder.
- [ ] 6.4 In Finder check both folders exist: the old library folder (still there) and the new one.
- [ ] 6.5 Click **Delete old copy**. You should see a dialog **Delete old copy** with a box **Type delete to confirm** and the button **Delete the old copy** greyed out. Type `delete`: the button becomes available. Click it. You should see "The old copy was deleted."
- [ ] 6.6 In Finder the old folder has gone and the new one remains. Click **Back to library**. You should see the library opens with its source list as before.
- [ ] 6.7 Close the app's window and wait until it has gone. In Finder rename the library's folder (the new one), for example by adding ` (renamed)` to its name. Open the app again. You should see, straight away and without **Choose a library**, a page headed "Library not found: " followed by the library's name, and "Last seen at" the old path, with buttons **Locate library…**, **Search for library**, **Wait for the drive** and **Open a different library**.
- [ ] 6.8 Click **Search for library**. You should see "Searching drives and cloud folders…", then "Search finished." and a list with the renamed folder's path and a button **Use this library**. If it says "Search finished. The library was not found.", click **Locate library…** instead, click **Choose folder…** beside **Library folder** and pick the renamed folder (or type its full path), and click **Reconnect**; note in your report that Search did not find it, and where the folder was. (Search looks through external and network drives, iCloud, Dropbox, Google Drive and OneDrive, then your home folder down to four levels, so a renamed folder in Documents should be found. macOS may ask whether the app may access folders such as Documents: allow it.)
- [ ] 6.9 Click **Use this library**. You should see the library open with its name as the heading and its source still in the list.

## Scenario 7. Delete the search index; the app rebuilds it; nothing is lost

Needs a library with a new project that holds only three sources (so that "3 sources" is right). Click **New project**, name it `Harbour records`, tick no profile, leave the identifiable and encryption boxes unticked, then attach three PDFs with **Choose files…** (their titles should differ, for example "Tide notes", "Harbour ledger", "Salt marsh survey").

- [ ] 7.1 You should see all three in the **Sources** list. Type a word of one title (for example `ledger`) in **Search sources**: only that source is shown. Clear the box.
- [ ] 7.2 Close the app's window and wait until it has gone. In Finder open the library folder. Delete the file `library.sqlite`, and also `library.sqlite-wal` and `library.sqlite-shm` if they are there. Do not touch any other file.
- [ ] 7.3 Open the app again. You should see your library open by itself (not **Choose a library**), and a new `library.sqlite` appear in the folder.
- [ ] 7.4 Select the project. A banner "Index rebuilding" may show for a moment, saying that search results may be incomplete until it finishes; it goes by itself. You should see its three sources listed again and "3 sources". Type `ledger` in **Search sources**: only that source is shown.
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

- [ ] 8.1 In a new project (for example `Markets in eight scripts`, no profiles), click **Import**, choose **Reference file**, choose **CSL-JSON** in **Format**, click **Choose file…** beside **File path** and pick `titles.json` on your Desktop (or type `/Users/yourname/Desktop/titles.json`), and click **Scan**. You should see **Scan results** with 8 **Items**.
- [ ] 8.2 Click **Next**, **Next**, **Start import**. You should see **Report and undo** saying "Import 1. The import finished." Click **Back to library**.
- [ ] 8.3 You should see "8 sources" in the list, each title in its own script, with no empty squares or broken letters: Arabic, Hebrew, Chinese, Japanese, Korean, Devanagari (Hindi), Greek and Cyrillic (Russian). This is also where the app's typefaces are checked in the Mac window for the first time: if some text looks as if it is in a different typeface from the rest of the app, report what you see.
- [ ] 8.4 The Arabic and Hebrew titles read from right to left (the words run from the right-hand end). The other six read from left to right. The rest of the screen (column headings, buttons) stays left to right.
- [ ] 8.5 Take a screenshot of the list.
- [ ] 8.6 Click each title in turn. You should see the panel with that title as a heading, in the right script.
- [ ] 8.7 Click the Arabic title again and look at the heading in the panel. It should be aligned to the right, as right-to-left text is.
- [ ] 8.8 Take a screenshot of the Arabic source's panel.

## Scenario 9. Capture a video link; open its transcript; edit a flagged segment; transcribe again

Needs an internet connection (the tools download from their publishers, and the downloader reads the video from YouTube), a web address that you choose (a short public YouTube video with speech in it, one you may save), and the optional tools installed in the first checks below. Saving videos from a platform may conflict with its terms of service. **What cannot be checked by hand:** whether the transcript has a flagged segment depends on the video (the app flags text that may be invented over silence, repeated, or uncertain). If yours has none, say so in your report and use any segment for the editing checks.

You need these Optional tools installed (checks 9.2 and 9.3 install them): **Video tools (ffmpeg)**, **Video downloader** and one **Speech model**. Each download contacts only its publisher. Scenario 4 also needs ffmpeg.

- [ ] 9.1 Click **Optional tools** at the top of the library screen. You should see a page headed **Optional tools** with the groups **Speech recognition**, **Saving from the web**, **Video conversion** and **Scanned documents**. Each tool shows what it is for, "Without it:", whether it is **Not installed**, its "Download size:" and "Downloads from:".
- [ ] 9.2 On **Video tools (ffmpeg)** click **Install**. You should see a progress line "Installing… N%" with a bar and a **Cancel** button, and at the end the card says **Installed**. (If ffmpeg is already on your Mac, for example from Homebrew, the card says **Installed** at once with "Found on this computer (not the app's own copy)…" and has no **Install**, **Update** or **Remove** button: go on.)
- [ ] 9.3 Do the same for **Video downloader** (it includes two parts) and **Speech model: tiny** (the smallest and quickest). Each should end as **Installed**. (**Image downloader** is only needed for photo posts, in the optional check 9.20.)
- [ ] 9.4 On **Text recognition (OCR)** you should see **Not available on this computer** and a reason beginning "No tesseract build is published for this platform yet". This is expected on a Mac for now. (If tesseract is already on your Mac, the card says **Installed** instead.)
- [ ] 9.5 On a tool that the app installed, you should see **Update** and **Remove** buttons. Do not remove ffmpeg: scenario 4 needs it.
- [ ] 9.6 Click **Back to library**, then **New project**. Type `Video notes` in **Project name**, tick no compliance profile, make sure **This project holds identifiable information about people** and **Encrypt this project** are not ticked, and click **Create project**. With it selected click **Governance and records**. You should see a card **Capture methods** with a group "How sources may come in from the web", holding **Browser capture: pages and posts saved with the browser extension**, **Downloader: videos and posts saved from their links on the Capture screen** and **A platform's official interface (API)**, none ticked.
- [ ] 9.7 Tick **Downloader: videos and posts saved from their links on the Capture screen**. You should see a dialog **Record a reason** saying that allowing it "loosens the project's rules, so it needs a reason", with the fields **Reason** and **Approved by**. Fill them in and click **Record reason**. The box is now ticked and a note "What a capture from the web also needs before it will run:" says "Nothing else under these rules." Click **Save changes**. You should see **Saved.**
- [ ] 9.8 Click **Back to library**, then **Capture from the web** (at the top, beside **Import**). You should see a page headed **Capture**, "Project: Video notes", and no note saying the project's rules do not allow capture with the downloader.
- [ ] 9.9 In **Links, one per line** paste the address of your video. You should see "1 link (at most 500 at once)" and under it your address with "YouTube — video".
- [ ] 9.10 Under **Transcription** choose **Transcribe**. In **Transcription model** choose "Tiny (quickest, least accurate)". (A model that is not installed shows "(not installed)" beside it and a link "Install it from the Optional tools screen".)
- [ ] 9.11 Click **Capture links**. You should see "Starting…" and then a section **Capture queue** with the heading "1 link", a bar **Links captured**, and your address with a status that moves from "Waiting" to "Capturing now" to "Saved". "Capturing now" includes making the transcript, so it can last several minutes. At the end you should see "Finished. Of 1 link: 1 done." If the status is "Saved; needs review", the video is saved but something about it needs your decision (see scenario 11). If it is "Failed" or "Saved in part", the reason is written under the link: copy it into your report.
- [ ] 9.12 Click **Back to library** and select **Video notes**. You should see the video as a new source in the **Sources** list. Click its title. In the panel you should see a link **Open the transcript**. (The transcript is made as part of the capture, so once the status said "Saved" it should be there. If the link says **Play the recording and transcribe it** instead, no transcript was made: copy the note under the link in the capture queue into your report.)
- [ ] 9.13 Click **Open the transcript**. You should see a page headed "Transcript:" followed by the video's title, a **Recording** player, a list **Version** with an entry such as "Speech recognition (…), …" (with "— N segments flagged" when some are flagged), and a list of segments, each with a time, a language, its text and an **Edit** button.
- [ ] 9.14 Click the time at the left of a segment. You should see the recording play from there, and the segment marked "Now playing".
- [ ] 9.15 Look for a segment marked "Flagged for review:" with a reason after it (for example "Repeated text", "Low confidence" or "Possibly invented text over silence").
- [ ] 9.16 Click **Edit** beside that segment (or any segment). A box "Text of the segment at …" opens. Change a word and click **Done**. You should see "Edited, not saved" beside the segment, and at the top "Edits not saved yet." with the buttons **Save edits as a new version** and **Discard edits**.
- [ ] 9.17 Click **Save edits as a new version**. You should see "Saved as a new version. The version it was edited from is kept."
- [ ] 9.18 Open the **Version** list. You should see an entry "Edited by a person, …" (chosen now) and the earlier "Speech recognition" entry. Under the list you should see a note beginning "This version was edited by a person.", and the segment you changed marked "Edited by a person — not checked". Choose the "Speech recognition" entry: you should see your original wording and its flag again.
- [ ] 9.19 Under **Transcribe again** choose a **Speech model** that is installed and click **Re-transcribe**. You should see "Transcribing with the … model. This can take several minutes.", a progress bar and a button **Stop transcribing**. When it ends you should see "The new transcript is ready" and a new "Speech recognition" entry in **Version**; the older entries, including your edit, are still listed.
- [ ] 9.20 Optional, only if you have a public Instagram or TikTok post to try (it needs **Image downloader** for a photo post: install it as in 9.3): paste its address in **Links, one per line** and click **Capture links**. If the queue says the post needs you to be signed in, tick **Use my browser session**, choose your **Browser**, and read the dialog **Use your browser session?**; **I understand, use my browser session** records your answer once for this project. Whether a post can be saved depends on the platform and on your sign-in: report the words the queue shows, whatever happens.

## Scenario 10. Capture a profile twice; the missing item is flagged as removed; pair the browser extension

Needs an internet connection, the tools and the project **Video notes** from scenario 9 (checks 9.1 to 9.7), and the address of a profile, channel or playlist that you may capture. **What cannot be checked by hand:** that a removed post is noticed. You cannot make a post disappear from someone else's profile, so use a YouTube playlist of your own with three or four short videos, which you can change yourself between the two captures, and one that the downloader can read without signing in (for example a public one). Do checks 10.1 to 10.6 in one sitting.

- [ ] 10.1 Select **Video notes** and click **Capture from the web**. Under **Capture profile**, paste your playlist's address in **Profile, channel or playlist link**. You should see under it a hint naming "YouTube — whole playlist". Leave **Posts from**, **Posts until** and **Maximum number of items** empty, and leave **Content types** empty ("None chosen: the profile's main list."): setting a date or a maximum turns off the detection of removed items for that capture, and the page says so ("With a maximum of N items, removed-item detection is off for this capture.").
- [ ] 10.2 Click **Capture profile**. In the **Capture queue** you should see "Profile capture:" followed by the address, "Listing the profile…", then the videos one by one with their statuses (for example "Saved"), under a bar **Posts captured**. At the end you should see "The profile capture finished." and a line such as "Finished: 3 new posts saved, 0 already in the project, 0 saved in part, 0 not saved." (your numbers).
- [ ] 10.3 Click **Back to library** and select **Video notes**. You should see one new source for each video and one more for the playlist itself; at the left, a collection named "Profile: …" holds them.
- [ ] 10.4 On YouTube, in your browser, remove one video from your playlist.
- [ ] 10.5 Back in the app, open **Capture from the web** again, paste the same playlist address under **Capture profile** and click **Capture profile**. At the end you should see a line such as "Finished: 0 new posts saved, 0 already in the project, 0 saved in part, 0 not saved, 1 post no longer on the platform." (The videos the app already has are not counted again, so "already in the project" stays 0. A part such as "N posts edited since the last capture" may also appear if the videos changed. If you see "Removed posts were not looked for in this run", say so in your report.)
- [ ] 10.6 Click **Back to library** and select **Video notes**. In the **Sources** list the row of the removed video shows the mark "No longer available at its source, noticed on <date>", and the other videos show no such mark. Click that source: the same mark is under its title, and its files are still there. The capture queue's line from 10.5 still gives the count.

**The extension.** You need it installed in Chrome, Edge or Firefox (not Safari). See `docs/first-run.md`, "Pairing the browser extension". The GitHub run page you downloaded the app from lists an artifact called `alexandrine-oxiana-browser-extension`: download it and follow that section. If the page lists no such artifact, you are on the run of the first build, which had none: download the app again from the newest run with a green tick.

- [ ] 10.7 Allow browser capture in the project **Video notes**: select it, click **Governance and records**, and in the card **Capture methods** tick **Browser capture: pages and posts saved with the browser extension**. In the dialog **Record a reason** fill in **Reason** and **Approved by** and click **Record reason**, then click **Save changes**. You should see **Saved.**
- [ ] 10.8 Click **Back to library**, then **Browser extension**. You should see a page headed **Browser extension** with a section **Pair a browser**, three steps, a **Port** number (a number the app uses to talk to the browser on this computer), and a list **Paired browsers** saying "No browser is paired yet." (or listing earlier ones).
- [ ] 10.9 Click **Show a pairing code**. You should see a code of six digits split in two groups of three, and "Valid for" a countdown.
- [ ] 10.10 In your browser click the extension's icon. You should see **Pair with the desktop app** with the boxes **Port** and **Pairing code**. Type the port and the six digits, and click **Pair**. The popup should say "Pairing done. Choose a project below."
- [ ] 10.11 Look back at the app. You should see "The code was used:", the extension's address (it begins `chrome-extension://` or `moz-extension://`, not the browser's name), "was paired, and the code can't be used again. Show a new code to pair another browser." and, under **Paired browsers**, an entry with the same address and "Paired" with a date.
- [ ] 10.12 Open any ordinary web page in a tab. Click the extension's icon, choose **Video notes** in **Project** (if it says "No project allows browser capture", check 10.7), make sure **Also download media with the downloader** is not ticked (the popup remembers your last choice), and click **Capture this page**. Keep the tab in front until the popup's message begins "Captured: saved to your library." (a note may follow it, for example that the screenshot was made smaller).
- [ ] 10.13 Back in the app, select **Video notes**. You should see a new source for the page in the **Sources** list.
- [ ] 10.14 Close the app's window, wait until it has gone, and open the app again. It opens your library by itself. Click **Browser extension**. You should see the same **Port** number as in 10.8 and the browser still listed under **Paired browsers**, with no "Old port" note.
- [ ] 10.15 In the browser, open a different ordinary web page, click the extension's icon (it still says "Paired with the desktop app (port N)."), choose **Video notes**, check that **Also download media with the downloader** is still not ticked (the popup kept your choice from 10.12), and click **Capture this page**. You should see a message that begins "Captured: saved to your library." without pairing again. **What cannot be checked by hand:** the app keeps its port unless another program has taken it, which you cannot arrange. If you do see "This app's port changed." on the **Browser extension** page, or the popup says "The desktop app is not answering on port N.", follow `docs/first-run.md`, "After you quit and reopen the app" (**Use a different port**, then **Check and save**), and say in your report what you saw.
- [ ] 10.16 On the **Browser extension** page click **Revoke** next to the extension's entry, then **Revoke pairing** in the dialog **Revoke this browser?**. You should see "Revoked" followed by the extension's address and "It cannot capture until it is paired again."

## Scenario 11. A DOI and title conflict appears in the project's review queue; choosing a value shows "Confirmed by you"

Needs only the library you have. **What cannot be checked by hand:** a conflict appears only when a captured page's own data and the platform's data disagree about a field, such as the title or the DOI, and the app cannot make that happen on request (the automated test plants one with the library's own code while the service is stopped). The one way to try is the browser extension (scenario 10) on a YouTube video page, with **Also download media with the downloader** ticked. If the page's data and the platform's data disagree, the source's panel shows a **Conflict** badge beside that field; it does not appear in the review queue. You can click that badge and confirm a value there as in 11.4, and the badge then says **Confirmed by you**. Usually they agree, so you may get none. Checks 11.1 and 11.2 can be done now. Checks 11.3 to 11.6 can be done only if the **Review queue** has an entry under **From captures**: a capture from the Capture screen leaves one when a field could not be checked (**Unverified**) or is in conflict. If none does, leave 11.3 to 11.6 unticked and say so in your report.

- [ ] 11.1 Select a project (for example **Video notes**) and look at the links at the top of the library screen. You should see **Review queue** (or "Review queue (N waiting)" when something is waiting), after **Import** and **Capture from the web**. Click it. You should see a page headed **Review queue**. If nothing is waiting it says "Nothing is waiting for review in this project."; otherwise it lists the waiting entries in groups headed by the import they came from, **Added by hand**, **From captures** or **After a consent withdrawal**.
- [ ] 11.2 Go back to the library. A source that is waiting for a decision (for example a file you attached whose outcome said "needs review") carries a **Needs review** link in the **Sources** list. Click it. You should see the review queue showing only that source, with a link "Show every entry waiting in this project". (If no source carries it, say so; this check cannot be done.)
- [ ] 11.3 Only if the **Review queue** has a group **From captures**: click its entry. You should see a section **Captured source**, a section **Why it needs review** saying which fields disagree, and a section **Fields to check** with a row for each field (for example "DOI" or "Title") and a badge beside it: **Conflict** where the sources disagree, or **Unverified** where the value could not be confirmed by any source.
- [ ] 11.4 Click one **Conflict** (or **Unverified**) badge. You should see a dialog headed with the field's name and "evidence", listing what each source gave, and, when there are several values, a question "Which value is right?" with one choice for each value and the source it came from. Choose one (with a single value there is nothing to choose) and click **Confirm this value**. The dialog closes and the badge now says **Confirmed by you**.
- [ ] 11.5 Do the same for every other field in the list. The page says "Keeping the value shown is confirming it. Once every field here is confirmed, the entry leaves the queue." When the last one is confirmed, you should see the entry leave the queue ("Nothing is waiting for review in this project.", if it was the only one).
- [ ] 11.6 Click **Back to library**. You should see that the source no longer carries **Needs review**. Click its title: the fields you decided show **Confirmed by you**, and the value you chose is the one shown.

## What to send back

For each check that did not turn out as described, send:

1. **The scenario and check number**, for example "6.9".
2. **What you saw**, in a sentence or two: the exact words on the screen if there are any (copy any error message).
3. **A screenshot** of the whole window at that moment.

Also tell me:

- which checks you could not do, and why;
- anything that felt confusing, even if it worked;
- which build you tested: the name of the GitHub run you downloaded from.

"Tell me" and "send" in this checklist mean the person who gave you this build.

If a check says something that is not what you see, that is worth reporting even when it looks small.
