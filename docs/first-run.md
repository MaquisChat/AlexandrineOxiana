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

When the app starts you may see "Connecting to the library…" for a moment. On a first run you then see a screen titled **Choose a library**, which says: "No libraries yet. Open a library folder, or create a new library below."

A **library** is the folder that holds all your projects. To make one:

1. In the box labelled **Library folder**, click **Choose folder…** and pick a folder in the window that opens. Or type the full path of a new folder, for example `/Users/yourname/Research library` (it must start with `/`). If the folder does not exist, the app creates it. If it exists, it must be empty (otherwise the app says the folder is not empty).
2. In the box labelled **New library name**, type a name.
3. Click **Create a new library in that folder**.

The library opens, showing its name as the page heading. To make your first project, click **New project** at the left. The dialog asks for a **Project name**, the **Compliance profiles** that apply (**University IRB**, **GDPR**, **HIPAA**, **Funder DMP**), whether the project holds identifiable information about people, and whether to encrypt it. If you encrypt a project you choose a passphrase, and the app then shows a recovery code once. Write the recovery code down somewhere safe before you tick **I have saved the recovery code**: without the passphrase or the recovery code, no one can open the project.

### Every time you open the app after that

The app opens the library that was open when you last closed it, by itself, and goes straight to it. You do not see **Choose a library** again unless no library was open.

- If the library's folder is slow to answer (an external or network drive can be), you see "Still opening", the library's name and "the library that was open last time", with the note "You can choose another library meanwhile." The library opens as soon as it is ready.
- If the folder is no longer where it was, you see **Library not found** at once, followed by the library's name (see "If something goes wrong").
- To work in a different library, click **Switch library** at the top of the library screen.

## Where the library lives

The library is the folder you chose. It is an ordinary folder: you can see it in Finder. Inside it:

- `library.json`: the library's name and its identity.
- `library.sqlite`: the search index. It is only a quick lookup built from your files, so it can be rebuilt. If it is missing, the app rebuilds it by itself when it opens the library; while that runs, a banner says "Index rebuilding" and that search results may be incomplete until it finishes.
- `Projects/`: one folder per project. Inside a project folder are `project.json` (the project's details), `governance.yaml` (its rules, in readable text), the audit log (a tamper-evident record of changes), and `Sources/`. Each source has its own folder with `source.json` (everything known about it), `original/` (the file exactly as you added it) and `derived/` (things the app made from it, such as transcripts or viewing copies).
- `Exports/` and `Backups/`: where exports and backups go.
- Two hidden folders, `.cache` and `.tmp`, for the app's own use.

In an encrypted project the files are stored scrambled (their names end in `.enc`) and can be opened only through the app with the passphrase or recovery code. The project's names and structure stay readable. The names of an encrypted project, its collections and its tags, and the text of a consent's scope, are not sealed: they can be read without the passphrase, so do not put a person's name in them.

In an encrypted project, the reasons you type when you set a mark aside, detach a signed consent form, or record that a source was reviewed after a consent withdrawal are sealed with the project too, and so is the reason you record when you loosen the project's rules: the audit log, which stays readable without the passphrase so that it can be checked, records only that a reason was given and a keyed fingerprint of it, which cannot be checked without the passphrase. The **Audit log** screen shows the reason while the project is unlocked, and says "A reason was given. It can be read when the project is unlocked." while it is locked. An exception to a compliance profile is different: the reason and the approver's name recorded for it are kept in the project's rules file (`governance.yaml`), which is not sealed and can be read without the passphrase, so do not put a participant's name in them. Reasons typed before this version of the app remain readable in the project's audit log.

**Backing up or moving the library.** Because it is an ordinary folder, you can back it up by copying the whole folder to another drive, but only while the app is closed. Do not drag or rename the folder while the app is open. To move the library to another place, use the app's own function: in the library, select a project, click **Governance and records**, then **Move library**. It copies the library, checks every file at the new place, switches to it, and deletes the old copy only when you confirm. If you rename or move the folder yourself while the app is closed, the app shows **Library not found** the next time you open it and offers **Locate library…** and **Search for library** to find it again. For an encrypted project, keep a copy of the passphrase or recovery code separate from the backup.

## Where the app keeps its own settings

The app's own files are not in your library. On a Mac they are in:

`~/Library/Application Support/org.alexandrineoxiana.desktop`

(`~` means your home folder. To open it from Terminal, type `open ~/Library/Application\ Support/org.alexandrineoxiana.desktop`.) Inside it:

- `settings/`: the list of your libraries and where they were last seen, your appearance choices, your researcher name, the browsers you have paired, the port the app last used (`service-port.json`, see "Pairing the browser extension"), and some safety records for the audit logs that are deliberately kept outside the library.
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

**Getting the extension.** The extension is a download on the same run page as the Mac app: under **Artifacts**, click `alexandrine-oxiana-browser-extension` (it sits next to `alexandrine-oxiana-macos-apple-silicon`). Like the Mac download, GitHub keeps it for 30 days. The run of the first build was made before this download was added and has no such artifact: use the newest run with a green tick.

1. Download it. It is a `.zip` that holds another `.zip`, `alexandrine-oxiana-browser-extension-<version>.zip`, and a `.sha256` file (Safari may already have opened the outer one into a folder).
2. Open the inner `.zip` by double-clicking it. You get a folder with `manifest.json` and a few other files directly inside it.
3. Make a folder that stays, in a place that is not cleaned up, for example **Documents > Alexandrine Oxiana extension** (not Downloads), and move the unzipped files into it so that `manifest.json` is directly inside. The browser loads the extension from this folder every time it starts, so do not move or delete it, and use the same folder for any later version.

Then load it in your browser:

- **Chrome (or Edge):** open `chrome://extensions` (in Edge, `edge://extensions`), turn on **Developer mode**, choose **Load unpacked**, and pick the extension's folder. The extension is listed as **Alexandrine Oxiana capture**.
- **Firefox (version 128 or later):** open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on…**, and pick the file `manifest.json` in the extension's folder. Firefox removes a temporary add-on when it closes, so load it again each time you start Firefox, and pair it again if the popup asks you to.

Optional check of the download: the run's **Summary** page lists the extension's SHA-256 under "Browser extension". In Terminal, type `shasum -a 256`, a space, drag the inner `.zip` into the window, press Return, and compare the long number with the one on the Summary page. They must be the same.

**Letting a project accept browser captures.** A new project does not allow browser capture. In the app, select the project, click **Governance and records**, and find the card **Capture methods**. Tick **Browser capture: pages and posts saved with the browser extension**. The app says that allowing it "loosens the project's rules, so it needs a reason" and opens a dialog **Record a reason** with the fields **Reason** and **Approved by**. Fill them in and click **Record reason**, then click **Save changes**; you should see **Saved.** The reason is kept in the audit log. Until a project allows it, the extension's popup says "No project allows browser capture. Allow it in a project's rules in the desktop app." A project that is encrypted and locked, or that holds identifiable data, can still refuse a capture (the card says what else a capture needs); use a plain project to try it.

**Pairing.** You pair a browser once. The "port" is a number the app uses to talk to the browser on this computer; the app shows it and the popup asks for it.

1. In the app's library screen, click **Browser extension**. The page has a section **Pair a browser**.
2. Click **Show a pairing code**. A code of six digits appears, with "Valid for" a countdown. The code works once, for 5 minutes, and stops after 5 wrong tries. The page also shows the **Port** number.
3. In your browser, click the extension's icon. Its popup, **Pair with the desktop app**, says to choose "Browser extension" at the top of the app's window and then "Show a pairing code", and has two boxes: **Port** and **Pairing code**. Type the port and the six digits, then click **Pair**.
4. The popup says "Pairing done. Choose a project below." and the app says "The code was used:", then the extension's address, then "was paired, and the code can't be used again." The extension is listed under **Paired browsers** by its address, which begins `chrome-extension://` or `moz-extension://`.

To undo a pairing, click **Revoke** next to the entry in **Paired browsers** and confirm with **Revoke pairing**. In the popup, **Unpair** removes it from the browser's side.

**After you quit and reopen the app.** The app keeps its port, so a paired browser goes on working and there is nothing to do: you do not pair again. The port changes only when the app cannot use its old one again, most often because another program has taken it. If that happens:

- The app's **Browser extension** page says "This app's port changed.", shows the new port, and marks each affected browser with "Old port: N. This app now uses port M."
- In that browser the popup says "The desktop app is not answering on port N." and names two causes: the app is closed (open it, then open the popup again), or its port changed. For the second, click **Use a different port** (beside **Unpair**), type the new port in **New port (as shown in the desktop app)**, and click **Check and save**. The popup says "Connected again: this browser now uses port M, and its pairing is unchanged." The pairing stays valid: there is no need to pair again.

## Quitting

Close the app's window. The app quits when its window closes, and it also stops the helper programs it started. Closing can take a few seconds, longer if an import is running. Wait until the window has gone before you open the app again or touch the library folder.

## Removing the app, and what stays on disk

To remove the app, drag **Alexandrine Oxiana** from Applications to the Trash. This leaves behind:

- your **library folders**, wherever you made them (your research data: deliberately not touched);
- the app's own folder, `~/Library/Application Support/org.alexandrineoxiana.desktop` (settings, downloaded tools and speech models). Delete it if you want everything gone. The app's web view also keeps some data of its own (for example your answer to the optional-tools banner) in a place this guide cannot name, so deleting that folder may not bring the banner back. Keep your passphrases and recovery codes: they are what opens an encrypted project.

## If something goes wrong

- **macOS will not open the app.** Follow "Opening it the first time" above. If **Open Anyway** is not there, open the app again from Applications and look again.
- **A small window titled "Alexandrine Oxiana could not start" appears.** The app's helper program did not start. The window gives a reason. Close it, try once more, and if it appears again, send a screenshot of the window.
- **The library says "Library not found".** The folder is not where it was last seen (for example, an external drive is not connected, or the folder was renamed). Connect the drive, or click **Locate library…**, then **Choose folder…** and pick the folder (or type its full path), then **Reconnect**, or click **Search for library**.
- **A banner says "Read-only (locked by …)".** The library is locked by another device. The banner goes on: "Changes are off until the library is closed there."
- **An optional tool will not download.** Check your internet connection, then click **Try again** on the tool's card. The message names the tool and the reason.
- **The extension's popup says "The desktop app is not answering on port N."** Either the app is closed (open it, then open the popup again), or its port changed: see "After you quit and reopen the app" above.
- **You forgot a passphrase.** Use the recovery code you saved. There is no other way in.
