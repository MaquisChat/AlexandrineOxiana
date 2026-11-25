# Whole channels, transcribed without watching over them — design

Written 25 November 2026 for the project's owner, who asked: "how long until I can start downloading YouTube channels in full and transcribing them automatically?" and then "Yes write the design please." Nothing here is built until the owner approves this page.

## What this is for

A researcher pastes the address of a YouTube channel, confirms once, and walks away. When they come back — hours or days later, after quitting the app or after the Mac slept — every video is in the library and every one has a transcript, or the app says plainly where it stopped and why.

Most of this exists already (see "What exists today"). This design closes the gaps between "it can be done by hand" and "it can be left alone".

## Goals

1. **See before you start:** how many videos, how many hours, roughly how much disk, roughly how long.
2. **Choose the quality**, including "audio only" for people who want only the transcripts.
3. **Never fill the disk.**
4. **Carry on by itself** after a quit, a restart or a sleep, unless you paused or stopped it.
5. **Transcribe everything without being asked each time**, for a new capture and for what is already in the library.
6. **Always show where it is** and how long is left, from the speed measured on this Mac.

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
- **Gaps:** no count, size or disk check before starting; no quality choice, and the app's own ffmpeg is not handed to the downloader, so the file saved is probably a low-quality one (read from the code, not yet run); the list of what is left to do lives only in memory, so a quit ends the run until it is started again by hand; a project setting for automatic transcription exists but no screen offers it; nothing transcribes sources already in the library in bulk; transcription speed on a Mac was never measured.

## Approaches considered

**A. Patch the present run.** Keep transcription inside the capture; add the estimate, the quality choice and restarting at launch. Least work. But every download waits for the transcript before it: a channel of 300 hours would hold its last download back for days, and "transcribe what is already in my library" would still not exist.

**B. Two lists that each survive a quit: one of downloads, one of transcriptions.** A capture puts videos on the first list; each finished video goes onto the second when transcription is wanted. Downloads finish in hours; transcription follows at the Mac's own speed. "Transcribe everything in this project" is then just putting sources on the second list. **This is the one I will build.** It serves the purpose directly and reuses what exists: the app already has a sealed record of long jobs that survives a quit, and the worker already downloads and transcribes one item at a time.

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
- "Maximum number of items" stays, for trying a few first.

### 2. Quality

The four choices above. The downloader is given the app's own ffmpeg, which it needs to join the best picture and sound; without that it can only take a ready-made low-quality file. "Audio only" stores the sound and no picture. The choice is recorded with each video's details, so it is always clear what was asked for.

### 3. The disk

Before each download the app checks the free space. When less than 10 GB would be left, downloading pauses and says: "Paused: the disk is nearly full. Free some space, then press Continue." Nothing half-written is left behind; the video in hand is finished or removed.

### 4. Two lists that survive a quit

- **Downloads** for a project run one at a time, with a short wait between videos so that YouTube is asked gently. The existing waits at "slow down" stay.
- **Transcriptions** run one at a time: the Mac's processor is the limit.
- Both are written to the app's sealed record of jobs as they go. When the library is opened again, each carries on where it was — **unless you had paused or stopped it; then it stays paused or stopped.**
- Locking a project stops both lists for that project at once, and nothing more is asked of any service for it; unlocking lets them carry on.
- Each video and each transcript is recorded exactly as one captured or transcribed by hand is today.
- The same lists serve Instagram and TikTok profiles, which use the same capture; they are tried and tested on YouTube first.

### 5. Automatic transcription

- The project's settings get one switch: **"Transcribe new audio and video automatically"**. The tick on the Capture screen starts from it and can be changed for one capture.
- The project's sources list gets **"Transcribe everything without a transcript"**. It first says how many sources and how many hours, then puts them on the transcription list.

### 6. Where it is, and how long

On the Capture screen, and as one line wherever the project is open:

```
Downloading "Example Channel": 120 of 412           [ Pause ]  [ Stop ]
  waiting 2 minutes — YouTube asked to slow down
Transcribing: 14 of 412 — "Title of the video"      [ Pause ]  [ Stop ]
  about 6 days left at this Mac's speed (4 minutes of sound per minute)
```

The time left comes from what this Mac has actually done so far, never from a table. Before the first transcript is finished the line says "measuring…".

### 7. Keeping the Mac awake

While either list is running, the app asks the Mac not to go to sleep by itself (the screen may still switch off). A switch in the settings turns this off. Closing the lid still sleeps the Mac; the lists carry on when it wakes. This part can only be checked on a real Mac.

## My calls, for you to correct

- Quality starts at **Up to 720p**: a watchable copy at about half the disk of 1080p.
- One download and one transcription at a time.
- The disk floor is **10 GB**.
- Lists carry on at opening without asking, except where you paused or stopped them.
- The Mac is kept awake while a list runs, with a switch to turn that off.
- YouTube's own captions are saved but not used in place of a transcript.
- The speech model is whichever is installed (medium by default); the page names it.

## Left to the builder

The exact layout; how the two lists are stored within the existing job record; the length of the wait between downloads; how sizes are estimated from lengths; the wording of sentences not given above, on the pattern of the screens' existing ones.

## How it will be checked

- Tests for each part, written first: the estimate, each quality, the disk floor, carrying on after a quit, a pause that stays paused, a lock that stops both lists, automatic transcription, the measured time left.
- A browser scenario from pasting a channel to the last transcript, against a stand-in for YouTube.
- An independent review, then the full test run and a Mac build.
- **On your Mac:** a small real channel end to end; quitting in the middle and opening again; one video at each quality; leaving it running with the screen off.

## Size

About two days of building and review, then a Mac build (GitHub gives Mac machines in the evening). If approved on 25 November: a Mac build on the evening of Thursday 26 November at the earliest, Friday 27 November more likely.
