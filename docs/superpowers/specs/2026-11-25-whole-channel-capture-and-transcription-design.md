# Whole channels, transcribed without watching over them — design

Written 25 November 2026 for the project's owner, who asked: "how long until I can start downloading YouTube channels in full and transcribing them automatically?" and then "Yes write the design please." **Approved by the owner on 26 November 2026**, with two directions that are worked in below: "For the whole channel design just throw an error on any that don't download and continue down the line. Leave a button to resume any downloads that didn't complete". Where the page changed because of them, it says "(owner, 26 November)".

A fresh reader checked this page against the code before it was handed over. That check corrected four statements about what exists today, and raised one question that only the owner could answer; the owner has answered it (see "The owner's answer").

## What this is for

A researcher pastes the address of a YouTube channel, confirms once, and walks away. When they come back — hours or days later, after quitting the app or after the Mac slept — every video is in the library and every one has a transcript, or the app says plainly where it stopped and why.

Most of this exists already (see "What exists today"). This design closes the gaps between "it can be done by hand" and "it can be left alone".

## Goals

1. **See before you start:** how many videos, how many hours, roughly how much disk, roughly how long.
2. **Choose the quality**, including "audio only" for people who want only the transcripts.
3. **Never fill the disk.**
4. **Lose nothing to a quit, a restart or a sleep.** Transcription carries on by itself. Downloading carries on by itself after a sleep, and with one click on "Resume downloads" after a quit (owner, 26 November).
5. **One video that cannot be downloaded never stops the rest** (owner, 26 November): it gets an error on its own line, the run goes on down the list, and one button tries again whatever did not complete.
6. **Transcribe everything without being asked each time**, for a new capture and for what is already in the library.
7. **Always show where it is** and how long is left, from the speed measured on this Mac.

## Not in this piece

- Checking a channel again every week (Phase 2, "scheduled monitoring").
- Translation, speaker names, an editor for several languages (Phase 2).
- Using YouTube's own captions in place of transcribing. They are still saved beside each video, as today.
- Anything running while the app is closed.
- Windows.

## What would make it a failure even if it "works"

- A full disk, or a library left half-written.
- YouTube blocking the researcher's connection because the app asked too fast.
- Something the researcher stopped starting again by itself.
- Any capture or transcript that is not recorded and governed as each one is today. The project's rules still decide what may be captured at all; this piece changes how much is done at once, not what is allowed.

## What exists today (read from the code in `main`)

- A channel address on the Capture screen downloads every video, one after another, with no limit unless "Maximum number of items" is set. A later run takes only new videos. Progress is saved after each video.
- Each video is stored with the platform's details, every subtitle language and the thumbnail.
- With "Transcribe" ticked, each video is transcribed right after its download, inside the same run, before the next download begins.
- When YouTube says "slow down" the app waits 60, 120, then 240 seconds, then pauses.
- Unfinished transcriptions are already written to the app's sealed record of jobs and carry on when the library is opened or a project is unlocked.
- The engine already understands "best", "up to 1080p" and "up to 720p"; the screen offers no such choice.
- ffmpeg, the tool that joins the best picture and sound into one file, is not part of the app: the researcher installs it from the Optional tools screen ("Video tools").
- **Gaps:** no count, size or disk check before starting; no quality choice on the screen, no "audio only", and ffmpeg is not handed to the downloader even when it is installed, so the file saved is probably a low-quality one (read from the code, not yet run); the list of downloads still to do lives only in memory, and a standing rule marks a download cut by a quit as failed, never to be resumed (amended by the owner's answer below); the Capture screen can follow "the project's setting" for transcription, but no screen lets you set it; nothing transcribes sources already in the library in bulk; transcription speed on a Mac was never measured.

## Approaches considered

**A. Patch the present run.** Keep transcription inside the capture; add the estimate, the quality choice and restarting at launch. Least work. But every download waits for the transcript before it: a channel of 300 hours would hold its last download back for days, and "transcribe what is already in my library" would still not exist.

**B. Two lists that each survive a quit: one of downloads, one of transcriptions.** A capture puts videos on the first list; each finished video goes onto the second when transcription is wanted. Downloads finish in hours; transcription follows at the Mac's own speed. "Transcribe everything in this project" is then just putting sources on the second list. **This is the one I will build.** It serves the purpose directly and reuses what exists: the app already keeps a sealed record of long jobs, unfinished transcriptions already carry on from it, and the worker already downloads and transcribes one item at a time. What is new is that the downloads of a run are written down too.

**C. One general scheduler for all background work** (also weekly checks, translation and the rest of Phase 2). The right end state, and too much for this piece. B's two lists are built as the first two users of the existing job record so that C can grow out of them.

The owner asked for an outcome and left the how to me; A, B and C and the choice of B are my calls.

## The design

### 1. Before it starts

Pasting a channel (or playlist, or profile) first asks the platform only for the list, which takes seconds, then shows:

```
Capture channel: "Example Channel"
412 videos, about 310 hours.

Quality     ( ) Best available   (•) Up to 720p   ( ) Up to 1080p   ( ) Audio only
Transcribe  [x] Transcribe each video on this Mac (speech model: medium)

Disk        Roughly 150–250 GB at this quality. 380 GB are free on "Macintosh HD".
Time        Downloading: some hours; it depends on YouTube.
            Transcribing: days rather than hours. The app will say more
            exactly once it has transcribed the first video on this Mac.

            [ Start ]   [ Cancel ]
```

- The sizes are estimates from the videos' lengths and are labelled as rough. Where the platform gives no lengths, the page says "size unknown" and does not guess.
- If the estimate is larger than the free space, the page says so and **Start** is replaced by "Start anyway — it will pause when the disk is nearly full".
- If "Video tools" (ffmpeg) is not installed, the three better qualities and "Audio only" cannot be chosen; the page says "These need Video tools" with a button to install them, and offers what is possible without: "Ready-made file (lower quality)". It does not refuse to start.
- "Maximum number of items" stays, for trying a few first.

### 2. Quality

The four choices above. The downloader is given the installed ffmpeg, which it needs to join the best picture and sound; without that it can only take a ready-made low-quality file. "Audio only" stores the sound and no picture. The choice is recorded with each video's details, so it is always clear what was asked for.

### 3. The disk

Before each download the app checks the free space. When less than 10 GB would be left, downloading pauses and says: "Paused: the disk is nearly full. Free some space, then press Resume downloads." Nothing half-written is left behind; the video in hand is finished or removed.

### 4. Two lists that survive a quit

- **Downloads** for a project run one at a time, with a short wait between videos so that YouTube is asked gently. A second channel started while one is downloading is not refused: it waits its turn ("…is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.") and begins by itself in the same sitting. After a quit it waits for "Resume downloads" like everything else.
- **A video that cannot be downloaded** (owner, 26 November) — removed, private, not available in your country, needing a sign-in the app does not have, or a failure that is still there after the downloader's own few tries: its line gets the error, in plain words with the platform's own reason where there is one, and the run goes straight on to the next video. It is not tried again by itself. Nothing half-downloaded is kept for it.
- **"Resume downloads"** (owner, 26 November): one button on the run's line, there for as long as anything in the run did not complete. It does both things at once: it carries on with the videos not yet reached (after a quit, a Stop or a pause), and it tries again the ones that ended in an error. It says how many: "Resume downloads (14 did not complete)". Videos that fail again keep their error and the button stays. Each press is recorded as your decision, and the project's rules are asked again as they stand at that moment.
- **When YouTube says "slow down"** this is not a failure of one video — it is the whole connection, and going on down the list would only make YouTube block harder. So the run waits instead: the existing waits of 1, 2 and 4 minutes stay, and after them the run no longer simply pauses for good: it waits longer and tries again by itself — 15 minutes, 30 minutes, 1 hour, then every 2 hours — and says so on its line. After 12 hours without success it pauses until you press Resume downloads.
- **Transcriptions** run one at a time: the Mac's processor is the limit.
- Both lists are written to the app's sealed record of jobs as they go.
- **After a sleep** the app is still running: both lists carry on by themselves when the Mac wakes.
- **After a quit or a restart:** transcriptions carry on by themselves, as they already do today (nothing leaves the Mac). Downloads do not start by themselves (owner, 26 November): the app shows "The capture of 'Example Channel' was interrupted: 120 of 412 done." with **Resume downloads** and **Discard**. One click carries on where it stopped, and tries again any that had failed; the click is recorded as your decision, and the project's rules are asked again as they stand now. **Discard** takes the run off the screen; what was downloaded stays in the library.
- **Pause** (either list) finishes the item in hand and waits; it stays paused across a quit until you press Resume downloads (for the transcriptions: Continue). **Stop** on the downloads ends the run: what was downloaded stays in the library, and its transcriptions stay on their list; capturing the same channel again later takes what is missing. **Stop** on the transcriptions empties that list; the sources stay, without transcripts, and "Transcribe everything without a transcript" can fill it again.
- A single pasted link is captured and transcribed as today, at once; the lists are for runs of many.
- Locking a project stops both lists for that project at once, and nothing more is asked of any service for it. After unlocking, the transcriptions carry on by themselves; the downloads wait for "Resume downloads", exactly as after a quit (amended on 26 November after the owner's answer: nothing goes out that was not just asked for).
- Each video and each transcript is recorded exactly as one captured or transcribed by hand is today.
- The same lists serve Instagram and TikTok profiles, which use the same capture; they are tried and tested on YouTube first.

### 5. Automatic transcription

- The project's settings get one switch: **"Transcribe captured audio and video automatically"**. It applies to captures from links, channels, playlists and profiles. The Capture screen's choice starts from it and can be changed for one capture. (Files you import or drop in are not transcribed by this switch; the next point covers them.)
- The project's sources list gets **"Transcribe everything without a transcript"**. It first says how many sources and how many hours, then puts them on the transcription list.

### 6. Where it is, and how long

On the Capture screen, and as one line wherever the project is open:

```
Downloading "Example Channel": 120 of 412           [ Pause ]  [ Stop ]
  waiting 2 minutes — YouTube asked to slow down
  3 could not be downloaded                          [ Show them ]
Transcribing: 14 of 412 — "Title of the video"      [ Pause ]  [ Stop ]
  about 6 days left at this Mac's speed (4 minutes of sound per minute)
```

The time left comes from what this Mac has actually done so far, never from a table. Before the first transcript is finished the line says "measuring…".

When the run has gone down the whole list (owner, 26 November):

```
"Example Channel": 398 of 412 downloaded. 14 could not be downloaded.
                              [ Show them ]  [ Resume downloads (14 did not complete) ]
```

"Show them" lists each one with its title, its address and its reason, for example "This video is private." or "The connection was lost three times." The list can be copied. A run in which everything completed says so and has no button.

### 7. Keeping the Mac awake

While either list is running, the app asks the Mac not to go to sleep by itself (the screen may still switch off). A switch in the settings turns this off. Closing the lid still sleeps the Mac; the lists carry on when it wakes. This part can only be checked on a real Mac.

## The owner's answer (26 November 2026)

The question was: after the app was quit in the middle of a channel, may it start downloading again by itself, or should it wait for one click?

The owner's words: "For the whole channel design just throw an error on any that don't download and continue down the line. Leave a button to resume any downloads that didn't complete".

So:

- **One click, not by itself.** Nothing goes out to YouTube that the researcher did not just ask for. The button is "Resume downloads".
- **The same button covers every download that did not complete**, whatever the reason: a quit, a Stop, a pause, a full disk, a video that ended in an error.
- **A failed video never holds up the rest.**

A standing rule of the project (ruling R41, point I3) said a download cut by a quit is never resumed. It is amended by this answer (ruling R668): it is never resumed *by itself*; a person's press of "Resume downloads" continues it, recorded as a new decision, with the project's rules asked again. Continuing by itself across a restart is not built; it can be added later as a switch that is off until turned on.

## My calls, for you to correct

- Quality starts at **Up to 720p**: a watchable copy at about half the disk of 1080p.
- One download and one transcription at a time.
- The disk floor is **10 GB**.
- After a quit, transcriptions carry on by themselves and downloads wait for one click (the owner's answer above).
- A "slow down" from YouTube is treated as the connection's problem, not one video's: the run waits, as described, and does not go on down the list failing every video. If you would rather it simply paused at once and left the rest to the button, say so.
- A video that ends in an error is not tried again by itself, not even once at the end of the run; only the button does that.
- "Resume downloads" stays on the run's line across quits, until everything completed or you press Discard.
- After a project was locked and unlocked, its downloads wait for "Resume downloads" too (the page first said they would carry on by themselves; your answer made one click the rule).
- Several channels can be started one after another; they are downloaded in the order you started them.
- A single pasted link is captured at once even while a channel is downloading or waiting.
- The wait between two videos is 10 seconds, on top of the downloader's own short pauses.
- The switch "Transcribe captured audio and video automatically" is on the project's Governance screen (the app has no other per-project settings screen); the switch for keeping the Mac awake is on the Optional tools screen.
- When YouTube says "slow down", the run keeps trying by itself at growing intervals for 12 hours before it pauses for good.
- Without "Video tools" the capture still starts, at the lower quality, and says so.
- The automatic-transcription switch covers captures, not imported files; "Transcribe everything without a transcript" covers those by hand.
- A single pasted link behaves as today.
- The Mac is kept awake while a list runs, with a switch to turn that off.
- YouTube's own captions are saved but not used in place of a transcript.
- The speech model is whichever is installed (medium by default); the page names it.

## Left to the builder

The exact layout; how the two lists are stored within the existing job record; the length of the wait between downloads; how sizes are estimated from lengths; the wording of sentences not given above, on the pattern of the screens' existing ones.

## How it will be checked

- Tests for each part, written first: the estimate, each quality with and without Video tools, the disk floor, the growing waits, a video that fails and the run going on past it, "Resume downloads" for the ones that failed and for the ones not reached, carrying on after a quit (transcriptions by themselves, downloads at one click), a pause that stays paused, both Stops, a lock that stops both lists, automatic transcription, the measured time left.
- A browser scenario from pasting a channel to the last transcript, against a stand-in for YouTube.
- An independent review, then the full test run and a Mac build.
- **On your Mac:** a small real channel end to end; quitting in the middle, opening again and pressing "Resume downloads"; a list with one address that does not exist, to see its error and the run going on; one video at each quality; leaving it running with the screen off.

## Size

About two days of building and review, then a Mac build (GitHub gives Mac machines in the evening). Approved early on the morning of Thursday 26 November: a Mac build on the evening of Friday 27 November at the earliest, Saturday 28 November more likely.
