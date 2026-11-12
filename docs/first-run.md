# First-run guide: installing and opening Alexandrine Oxiana on your Mac

This guide is for you, the researcher. It assumes no programming knowledge. It covers the pre-release Mac build: how to get it, how to open it the first time, what it puts on your disk, and what to do if something goes wrong. When you are ready to test, use the hands-on checklist in `docs/owner-checklist.md`.

## What the app is

Alexandrine Oxiana is a research workbench that keeps everything on your own computer. You collect sources (articles, recordings, photos, web pages), keep notes about them, and the app records where each item came from and what rules (ethics, data protection) apply to it. Your work lives in an ordinary folder that you can see, copy and back up. Some features, such as looking up a DOI online, contact public services, and only where the project's rules allow it.

## What you need

- A Mac with an Apple chip (M1 or later). To check: choose **Apple menu > About This Mac**. It must say "Chip: Apple M…". A Mac that says "Processor: …Intel…" cannot run this build. Intel Macs are not supported.
- macOS 15.0 or later.
- A GitHub account that can see the project's repository (the download is kept there).
- An internet connection for the download, and later for the optional tools (see below).

## Getting the download

The Mac app is built by GitHub, not by you. You only collect the result.

1. Sign in to GitHub and open the project's repository.
2. Click **Actions** (at the top of the page).
3. In the list on the left, click **Desktop (macOS)**.
4. Open the newest run that has a green tick (click its name).
5. Scroll to the bottom of the run's **Summary** page. Under **Artifacts**, click `alexandrine-oxiana-macos-apple-silicon`.
6. It downloads as a `.zip` file. Inside it is the disk image (a `.dmg` file named like `Alexandrine-Oxiana-0.0.0-apple-silicon.dmg`) and a small `.sha256` file that you can ignore.

GitHub keeps each download for 30 days. After that, ask for a new build.

## Installing

1. Open the downloaded `.zip` (Safari may already have unpacked it into a folder).
2. Open the `.dmg` inside it.
3. Drag **Alexandrine Oxiana** onto **Applications**.

## Opening it the first time ("Open Anyway")

This build is signed only "ad hoc", not with a paid Apple developer certificate. So macOS refuses to open it at first and asks you to allow it once. This is expected. You do it once per download; after that the app opens normally.

1. Open **Alexandrine Oxiana** from Applications. macOS says it cannot check the app for malicious software. Click **Done** (not "Move to Trash").
2. Open **System Settings > Privacy & Security** and scroll down to **Security**.
3. Next to the message that Alexandrine Oxiana was blocked, click **Open Anyway**. Confirm with your password or Touch ID, then click **Open**.

The **Open Anyway** button is offered only for a while (about an hour) after the blocked attempt. If it has gone, open the app again from Applications and repeat step 3. On macOS 15 the older way (Control-click the app, then Open) no longer skips this step.

## The first screen, and creating a library

When the app starts you may see "Connecting to the library…" for a moment, then a screen titled **Choose a library**. On a first run it says: "No libraries yet. Open a library folder, or create a new library below."

A **library** is the folder that holds all your projects. To make one:

1. In the box labelled **Library folder**, type the full path of a new folder, for example `/Users/yourname/Research library` (it must start with `/`). Or click **Choose folder…** and pick a folder. If the folder does not exist, the app creates it. If it exists, it must be empty (otherwise the app says the folder is not empty).
2. In the box labelled **New library name**, type a name.
3. Click **Create a new library in that folder**.

The library opens, showing its name as the page heading. To make your first project, click **New project** at the left. The dialog asks for a **Project name**, the **Compliance profiles** that apply (**University IRB**, **GDPR**, **HIPAA**, **Funder DMP**), whether the project holds identifiable information about people, and whether to encrypt it. If you encrypt a project you choose a passphrase, and the app then shows a recovery code once. Write the recovery code down somewhere safe before you tick **I have saved the recovery code**: without the passphrase or the recovery code, no one can open the project.

### Every time you open the app, at present

At present each time the app starts, it shows **Choose a library** with your libraries listed. Click **Open** next to the one you want. This is related to known problem D5 in the test checklist, which is being fixed: the app should show **Library not found** at once for a library that has moved, instead of **Choose a library**.

## Where the library lives

The library is the folder you chose. It is an ordinary folder: you can see it in Finder. Inside it:

- `library.json`: the library's name and its identity.
- `library.sqlite`: the search index. It is only a quick lookup built from your files, so it can be rebuilt. (The app has no button to rebuild it yet: known problem D8.)
- `Projects/`: one folder per project. Inside a project folder are `project.json` (the project's details), `governance.yaml` (its rules, in readable text), the audit log (a tamper-evident record of changes), and `Sources/`. Each source has its own folder with `source.json` (everything known about it), `original/` (the file exactly as you added it) and `derived/` (things the app made from it, such as transcripts or viewing copies).
- `Exports/` and `Backups/`: where exports and backups go.
- Two hidden folders, `.cache` and `.tmp`, for the app's own use.

In an encrypted project the files are stored scrambled (their names end in `.enc`) and can be opened only through the app with the passphrase or recovery code. The project's names and structure stay readable.

**Backing up or moving the library.** Because it is an ordinary folder, you can back it up by copying the whole folder to another drive, but only while the app is closed. Do not drag or rename the folder while the app is open. To move the library to another place, use the app's own function: in the library, select a project, click **Governance and records**, then **Move library**. It copies the library, checks every file at the new place, switches to it, and deletes the old copy only when you confirm. If you rename or move the folder yourself while the app is closed, the app shows **Library not found** the next time (at present you first see **Choose a library** and click **Open** next to it, known problem D5) and offers **Locate library…** and **Search for library** to find it again. For an encrypted project, keep a copy of the passphrase or recovery code separate from the backup.

## Where the app keeps its own settings

The app's own files are not in your library. On a Mac they are in:

`~/Library/Application Support/org.alexandrineoxiana.desktop`

(`~` means your home folder. To open it from Terminal, type `open ~/Library/Application\ Support/org.alexandrineoxiana.desktop`.) Inside it:

- `settings/`: the list of your libraries and where they were last seen, your appearance choices, your researcher name, the browsers you have paired, and some safety records for the audit logs that are deliberately kept outside the library.
- `tools/` and `models/`: the optional tools and speech models you download (next section).

This folder name is provisional: the project's owner still has to confirm it before the first release, and if it changes, settings would have to be moved.

## Optional tools: nothing is downloaded until you ask

Some features need extra programs that are not included with the app, so that its own download stays small. The app never downloads any of them unless you ask.

When you open a library for the first time, a banner appears: "Some features need optional tools that are not included with the app: would you like to choose which to download?" It has two buttons:

- **Choose tools…** opens a dialog titled **Optional tools**. It asks "What will you do?" with four choices: **Work with recordings**, **Save videos from the web**, **Save picture posts from the web**, **Read scanned documents**. The tools that match are offered, with their download size and the web addresses they contact. Nothing downloads until you click the button that starts the download (it reads "Download N tools (size)", or "Download selected tools" while nothing is ticked).
- **Not now** hides the banner and the app remembers your answer. You can change your mind later: click **Optional tools** at the top of the library screen.

What each tool is for:

- **Speech model** (tiny, small, medium, large-v3): turns recordings into written transcripts. Bigger models are slower and more accurate. One is marked as the app's default.
- **Video downloader**: saves videos, subtitles and details from YouTube, TikTok, Instagram and other sites when you paste a link. It has two parts (yt-dlp and a small JavaScript runtime) and is always the latest release. Downloading from platforms may conflict with their terms of service.
- **Image downloader**: saves photos and carousels from Instagram and TikTok posts.
- **Video tools (ffmpeg)**: makes viewing copies of videos, including copies that leave out or blur a recorded location. Without it, media that carries a location stays "proxy pending" and is left out of exports.
- **Text recognition (OCR)**: makes the text of scanned PDFs searchable. On this Mac build it is shown as not available: no ready-made version exists yet for Macs, and the app uses one already installed on your Mac if there is one.

Each download is checked against a checksum recorded in the app before it is used (the video downloader, which is always the latest release, is checked against the checksums its authors publish). The **Optional tools** screen lets you **Install**, **Update**, **Remove**, or **Cancel** a download in progress.

## Pairing the browser extension

The browser extension lets you capture the web page you are looking at into a project. It works in Chrome, Edge and Firefox (version 128 or later), not in Safari. It is not in any browser's store.

**Getting the extension.** The extension is meant to be a download on the same run page as the Mac app: an artifact called `alexandrine-oxiana-browser-extension`, next to `alexandrine-oxiana-macos-apple-silicon` under **Artifacts**.

- If that artifact is on the run page you downloaded from, download it and unzip it. Then load the unzipped folder into your browser:
  - **Chrome (or Edge):** open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the unzipped folder.
  - **Firefox:** open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on**, and pick the file `manifest.json` in the unzipped folder. Firefox forgets it when it closes.
- If it is not there (the build of 2026-11-12 has no such artifact), the extension cannot be installed without a developer's help. Ask the person who gave you this guide, and leave this section until you have it.

**Known problem D13 (being fixed): pair again after every reopen.** The app takes a new port each time it starts, and the extension keeps the one it was paired with. After you quit and reopen the app, the popup still says it is paired, but every capture fails with "The desktop app is not answering on port N. Is it open?". The way round for now: in the popup click **Unpair**, in the app click **Show a pairing code**, and pair again with the new port and code (steps below). For the test, do scenario 10 of the checklist in one sitting, without quitting the app.

**Known problem D11 (being fixed): letting a project accept browser captures.** A new project does not allow browser capture or the downloader, and the Governance form has no control for it yet. The extension's popup says "No project allows browser capture." until you allow it. The only way for now is a workaround that will go away: in the app, select the project, click **Governance and records**, then **View governance.yaml**, and add this line at the end of the text:

`captureMethods: [manual_upload, zotero_import, refman_import, calibre_import, device_import, browser_capture, downloader]`

Click **Save changes**. The app says "This change loosens the project's rules, so it needs a reason" and opens a dialog **Record a reason** with the fields **Reason** and **Approved by**. Fill them in and click **Record reason**; you should then see **Saved.** The reason is kept in the audit log. A project that is encrypted and locked, or that holds identifiable data, can still refuse a capture; use a plain project.

**Pairing.**

1. In the app's library screen, click **Browser extension**. The page has a section **Pair a browser**.
2. Click **Show a pairing code**. A code of six digits appears, with "Valid for" a countdown. The code works once, for 5 minutes, and stops after 5 wrong tries. The page also shows the **Port** number.
3. In your browser, click the extension's icon. Its popup, **Pair with the desktop app**, has two boxes: **Port** and **Pairing code**. (The popup's own hint says "open Settings → Browser extension"; the app has no Settings menu: the place is the **Browser extension** link at the top of the library screen.) Type the port and the six digits, then click **Pair**.
4. The popup says "Pairing done. Choose a project below." and the app says "The code was used: a browser was paired, and the code can't be used again." The extension is listed under **Paired browsers** by its address, which begins `chrome-extension://` or `moz-extension://`.

To undo a pairing, click **Revoke** next to the entry in **Paired browsers** and confirm with **Revoke pairing**. In the popup, **Unpair** removes it from the browser's side.

## Quitting

Close the app's window. The app quits when its window closes, and it also stops the helper programs it started. Closing can take a few seconds, longer if an import is running. Wait until the window has gone before you open the app again or touch the library folder.

## Removing the app, and what stays on disk

To remove the app, drag **Alexandrine Oxiana** from Applications to the Trash. This leaves behind:

- your **library folders**, wherever you made them (your research data: deliberately not touched);
- the app's own folder, `~/Library/Application Support/org.alexandrineoxiana.desktop` (settings, downloaded tools and speech models). Delete it if you want everything gone. The app's web view also keeps some data of its own (for example your answer to the optional-tools banner) in a place this guide cannot name, so deleting that folder may not bring the banner back. Keep your passphrases and recovery codes: they are what opens an encrypted project.

## If something goes wrong

- **macOS will not open the app.** Follow "Opening it the first time" above. If **Open Anyway** is not there, open the app again from Applications and look again.
- **A small window titled "Alexandrine Oxiana could not start" appears.** The app's helper program did not start. The window gives a reason. Close it, try once more, and if it appears again, send a screenshot of the window.
- **The library says "Library not found".** (At present you first see **Choose a library**; click **Open** next to the library and then you see it.) The folder is not where it was last seen (for example, an external drive is not connected, or the folder was renamed). Connect the drive, or click **Locate library…** and type the new full path, or **Search for library**.
- **A banner says "Read-only (locked by …)".** The library is locked by another device. The banner goes on: "Changes are off until the library is closed there."
- **An optional tool will not download.** Check your internet connection, then click **Try again** on the tool's card. The message names the tool and the reason.
- **You forgot a passphrase.** Use the recovery code you saved. There is no other way in.
