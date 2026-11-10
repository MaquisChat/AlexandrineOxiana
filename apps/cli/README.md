# `ao`: capture links and profiles from a terminal

`ao` is the first usable part of Alexandrine Oxiana. It saves YouTube, Instagram and TikTok
links (or a whole profile) into a **library** on your computer, as **governed** sources: every
capture follows the rules of the project you save it into, is recorded in that project's audit
log, and keeps where it came from. Nothing is sent anywhere; the files stay in your library folder.

You do not need to be a programmer. You type a few short commands into a terminal window.

## 1. Install (once)

1. Install **Node.js 22 or newer** from <https://nodejs.org> (choose the "LTS" or "Current" download).
2. Install **pnpm**: open a terminal and type `npm install -g pnpm`.
3. Install **Python 3.12 or newer** (<https://www.python.org>). It runs the "media helper" that
   downloads and transcribes.
4. In a terminal, go into the project folder (the one that contains this `apps` folder) and type:

   ```
   pnpm install
   pnpm setup:py
   ```

   `pnpm install` fetches the program's parts. `pnpm setup:py` prepares the media helper
   (it can take a few minutes the first time).

From now on, every command starts with `pnpm ao` and is typed in that same folder:

```
pnpm ao --help
```

> Tip: write `pnpm ao -- <command>` or `pnpm ao <command>`; both work. Add `--help` after any
> command to see its options, for example `pnpm ao capture --help`.

## 2. Create a library (once)

A library is just a folder that holds all your projects. Give it a name that does not exist yet; it is created inside the folder you are in (or write a full path, such as `C:\Users\you\ResearchLibrary` on Windows or `/Users/you/ResearchLibrary` on a Mac):

```
pnpm ao library create ResearchLibrary --name "My research"
```

After this, `ao` remembers the library you used last. To use another one, add
`--library <folder>` to a command, or set the `AO_LIBRARY` environment variable.

## 3. Create a project with its rules

A project is one study. Its rules decide what may be captured. This example is an IRB
(research ethics) and GDPR project that is allowed to use the downloader, with a default legal
basis written down, and encrypted with a passphrase:

```
pnpm ao project create "Market study" --profile irb --profile gdpr --capture downloader --default-legal-basis "consent (Art. 6(1)(a))" --protocol-number "IRB-2026-014" --encrypt
```

- `--profile` picks the rules to follow: `irb`, `gdpr`, `hipaa` or `dmp`. You can repeat it.
  The `irb` profile needs your approved protocol number (`--protocol-number`) before it lets
  anything be captured; `--protocol-from` and `--protocol-until` (as `YYYY-MM-DD`) add the dates.
- `--capture downloader` allows the downloader. Without it, a capture is refused (see "If a
  capture is refused" below).
- `--default-legal-basis` is the legal basis recorded for social-media data when you do not give
  one for a single capture.
- `--encrypt` asks for a passphrase twice (what you type is hidden) and then shows a
  **recovery code once**. Write the code down and keep it away from the computer: if you forget
  the passphrase, the recovery code is the only way back in. Projects that hold identifiable
  data must be encrypted; for a project that holds none, add `--not-identifiable` instead.

Later commands ask for the passphrase when they open an encrypted project. For scripts, set the
`AO_PASSPHRASE` environment variable instead.

## 4. Capture a YouTube link, with a transcript

```
pnpm ao capture "https://www.youtube.com/watch?v=XXXXXXXXXXX" --project "Market study"
```

You get one line per link, for example:

```
created     2026-03-14 Channel Name - Market day [2f9p]  →  Projects/Market study/Sources/2026-03-14 Channel Name - Market day [2f9p]
```

The first word says what happened: `created`, `duplicate` (you already have it), `refreshed`,
`incomplete` (only part was saved), `needs-review` (saved, but see below) or `failed` (with the
reason on the next line). Whether a transcript is made follows the project's setting (off unless the project turns it on); add `--transcribe` to make one, `--no-transcribe` to skip it, and
`--model small` for a faster, rougher one (`large-v3`, `medium` or `small`). The first
transcription downloads the speech model.

Useful extras: `--refresh` adds a new dated copy of the platform's data for a link you already
have; `--legal-basis "<text>"` records a legal basis for just this capture. To transcribe a
source you saved earlier: `pnpm ao transcribe <short code> --project "Market study"`, where the
short code is the four characters in `[brackets]` at the end of its folder name.

## 5. Capture an Instagram profile (or a channel, or a TikTok profile)

```
pnpm ao capture-profile "https://www.instagram.com/some_account/" --project "Market study" --since 2026-01-01 --max-items 50
```

You see a live "Captured 12 of 40 posts" line, then a summary. Run the same command again later:
it saves only what is new and notes posts that were edited or have disappeared. Options:
`--until YYYY-MM-DD`, `--types posts,reels,videos,shorts,highlights`, `--metadata-only` (the
data without the pictures and videos), `--comments` (comments are other people's personal data,
so they always need a legal basis), `--transcribe` (with `--model`). If the platform starts limiting requests, the
run pauses, tells you, and ends with exit code 4; run it again later and it continues where it stopped.

Some posts need you to be signed in. Add `--cookies-from-browser chrome` (or `firefox`,
`safari`, `edge`, `brave`) to let the downloader use your browser's signed-in session. The first
time, `ao` shows an explanation and asks you to confirm; in a script, add `--acknowledge-cookies`.
Your cookies are never printed, copied or stored by `ao`.

## 6. Where the files land

Everything is inside the library folder, in the project's `Sources` folder, one folder per
post: `Projects/<project>/Sources/<date> <author> - <title> [code]`. In it you will find the
media, the platform's data, captions, any transcript, and a `source.json` that records where it
came from, when, how, and what was checked. `ao` prints these paths relative to the library, so
you can find them by opening the library folder. See what a project holds with:

```
pnpm ao list --project "Market study"
```

## 7. Reading "needs review"

`needs-review` does not mean something went wrong. The capture was saved, but some details of the
record (the date, the title, the creators) could not be confirmed, or two sources of evidence
disagree, so the record is waiting for you. See which and why:

```
pnpm ao list --project "Market study" --needs-review
pnpm ao recheck --all --project "Market study"
```

Each problem is listed as the detail (for example `/issued`, the date), its status
(`unverified`: nothing to confirm it; `conflict`: two sources disagree) and a sentence saying
why. `recheck` also saves the new result in the project (and records it in the audit log), so the review list stays up to date. It does not change any detail itself: decide which value is right when you review the source.

## 8. If a capture is refused

- **"failed ... rules do not allow ..." (exit code 2):** the project's rules forbid it, for
  example the downloader is not in its capture methods. Create the project with
  `--capture downloader`, or change the project's rules.
- **Needs a legal basis (exit code 4):** add `--legal-basis "<text>"` to the command, or create
  the project with `--default-legal-basis "<text>"`.
- **Needs your confirmation about cookies (exit code 3):** add `--acknowledge-cookies`.
- **"This post needs a signed-in session":** add `--cookies-from-browser <your browser>` (chrome, firefox, safari, edge or brave).
- **"The downloader could not read this page":** the platform changed; update the tools (next section).

Exit codes, if you use `ao` in a script: 0 success, 1 something failed, 2 refused by the
project's rules, 3 cookie confirmation needed, 4 you must do something and run it again (supply a
legal basis, or wait and re-run a profile capture that the platform paused).
Add `--json` to any command for machine-readable output (paths are library-relative; no tokens).

## 9. Update yt-dlp

Platforms change often and the downloader (yt-dlp) needs updating every few weeks, or whenever
captures start failing with "could not read this page":

```
pnpm ao tools update
pnpm ao tools versions
```

`update` shows the old and new version (for example `yt-dlp 2026.09.01 → 2026.10.22`).
If yt-dlp was installed by you or your system, `ao` reports its version but leaves it alone.

## A note about platform terms

Downloading content from YouTube, Instagram or TikTok, or using a signed-in account to do so,
may conflict with those platforms' terms of service, and platforms may restrict or suspend
accounts they detect using automated tools. For that reason the downloader is a separate capture
method that each project must switch on explicitly, using your browser session needs a one-time
confirmation that is recorded in the project's audit log, and you are responsible for checking
that your use is allowed by the platform, your institution and your ethics approval. See
`docs/adr/0009-capture-tools.md` for the technical decisions behind this.

## Stopping safely

Press Ctrl+C at any time. `ao` stops the downloads, closes the project and releases the library
so you can open it again straight away. A capture that was running is not saved.

## Everyday reference

| Command | What it does |
| --- | --- |
| `pnpm ao library create <folder> --name <name>` | make a library |
| `pnpm ao library open <folder>` | show whether the library can be changed |
| `pnpm ao project create <name> [--profile ...] [--capture ...] [--encrypt]` | make a project |
| `pnpm ao capture <url...> --project <name>` | capture links |
| `pnpm ao capture-profile <url> --project <name>` | capture a whole profile |
| `pnpm ao transcribe <source> --project <name>` | transcribe a saved video or audio |
| `pnpm ao recheck <source> or --all --project <name>` | list details that need checking |
| `pnpm ao list --project <name> [--needs-review]` | list sources |
| `pnpm ao tools update` / `pnpm ao tools versions` | update or show the capture tools |

Settings you can put in the environment: `AO_LIBRARY` (library folder), `AO_PASSPHRASE`
(passphrase for encrypted projects, for scripts), `AO_CONFIG_DIR` (where `ao` keeps its small
settings file), `AO_WORKER_BIN` (a packaged media helper instead of the Python one).
