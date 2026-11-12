# 0009. Capture tools: yt-dlp and gallery-dl

- **Status:** Accepted (amended 2026-11-11 by Task 48a: optional tools on first use, R126, R133)
- **Date:** 2026-11-10

## Context

The downloader is a first-order capture method (spec 5.1): the researcher pastes a YouTube,
Instagram or TikTok link and gets the media, subtitles, thumbnail and the platform's metadata JSON.
yt-dlp (video) and gallery-dl (photos, carousels, highlights) do this well, but the sites change
often and the extractors break within days, so the tools must be updatable independently of app
releases. At the same time the app must not run arbitrary code it cannot verify, must not leak the
researcher's browsing data, and must leave a documented trail of which tool and version produced
each capture. Using these tools may conflict with platform terms of service.

## Decision

- **yt-dlp is a managed standalone binary**, not a Python dependency. When the first-use tools dialogue installs it,
  the media worker resolves the latest release tag once (from the redirect of `releases/latest/download/SHA2-256SUMS`),
  downloads that tag's `SHA2-256SUMS` and the platform's asset (`yt-dlp_linux`,
  `yt-dlp_linux_aarch64`, `yt-dlp_macos`, `yt-dlp.exe`) from `releases/download/<tag>/`, checks
  the SHA-256, and installs it (mode 0755) into
  `AO_TOOLS_DIR`. A mismatch is refused (`TOOL_CHECKSUM_MISMATCH`) and nothing is installed.
- **Resolution order:** `AO_YTDLP_BIN`, then the managed binary, then `yt-dlp` on PATH. A capture
  never downloads it (amended by Task 48a): with none of these, the job fails with
  `TOOL_NOT_INSTALLED` naming the tool `video-downloader`, and the first-use tools dialogue installs
  it. Tests put fake `yt-dlp`/`gallery-dl` scripts first on PATH (or name them in `AO_*_BIN`) and
  never download; the installer's tests use a local file server.
- **Updates:** `POST /tools/update` runs `yt-dlp --update-to stable` on the managed binary (yt-dlp's
  own updater verifies the release checksums) and reports old and new versions. A binary from
  `AO_YTDLP_BIN` or PATH belongs to the user or the system and is only reported. The app decides
  when to call it (for example from a "Update capture tools" button, or after an
  `EXTRACTOR_ERROR`).
- **gallery-dl is pinned, but no longer inside the worker** (amended by Task 48a: it is
  GPL-2.0-only, so until the project's licence is decided it is not shipped in the worker bundle).
  The first-use tools dialogue downloads its pinned PyPI wheel (`gallery_dl-1.32.19-py3-none-any.whl`,
  address and SHA-256 in `ao_worker/toolpins.py`) into `<tools>/gallery-dl/lib/`, and it runs as its
  own program, `python -m gallery_dl --config-ignore` on the worker's Python with that folder on its
  module path (`PYTHONPATH`, and `AO_GALLERYDL_LIB` for the packaged worker), or `AO_GALLERYDL_BIN`.
  The user's own gallery-dl configuration (which may hold credentials or post-processors) is never
  read; yt-dlp likewise runs with `--ignore-config`. Its only dependency, `requests` (Apache-2.0),
  stays in the worker. A new pin comes with an app release; it has no verified standalone update
  channel comparable to yt-dlp's. Without it, captures that need it fail with `TOOL_NOT_INSTALLED`
  naming `image-downloader`.
- **Provenance:** every capture result reports `tool` and `toolVersion`; the Node side records them
  (with the capture method) in provenance.
- **Polite defaults:** yt-dlp runs with `--sleep-requests 2 --sleep-interval 3
  --max-sleep-interval 8 --retries 3`, gallery-dl with `--sleep 3-8`, and both honour an archive
  file so repeated captures do not re-download.
- **Cookies:** only `--cookies-from-browser <browser>` for one of chrome, firefox, safari, edge,
  brave, chosen per capture by the researcher. The worker never copies, stores or exports
  cookies, never accepts a cookies file, never logs the browser choice, and redacts paths under the
  home folder from error details. Comments are not captured in Phase 1 (`includeComments` must be
  false).
- **Terms of service:** the downloader is a separate capture method that each project enables
  explicitly (governance `captureMethods`), with a one-time explanation that downloading may
  conflict with platform terms and that using a logged-in session puts that account at some risk.
  The Node side checks a `capture` policy decision before submitting a download job.
- **Link capture on the Node side** (`packages/library/src/capture/`): `captureUrl` evaluates the
  one `capture` decision (method `downloader`, platform) and audits it right then, allow or deny,
  with `{platform, cookies}` (no URL); storing the result evaluates only `store`, so every capture
  attempt has exactly one audited capture decision. A `store` pre-check (with the legal basis:
  `CaptureOptions.legalBasis`, else governance `consent.defaultLegalBasis['social-media']`) runs
  before anything is downloaded. The worker client does not evaluate `capture.download`, and never
  resumes it after a restart (marked failed `INTERRUPTED`; `.tmp/capture-*` work folders, 0700, are
  swept on open). Using the browser session needs the project's recorded acknowledgement
  (`repo.acknowledge(projectId, "cookies")`, audited); provenance records `access` but never the
  browser. The platform JSON is stored as an original `platform-metadata` asset without request
  headers, secrets (keys whose words include cookie, token, auth, session, signature …), signed or
  expiring media links (`url`, `formats`, `subtitles`, `thumbnails`, `display_url` …), local paths,
  and with every remaining URL reduced to its canonical form or to scheme, host and path. User text
  (titles, descriptions) is kept as written. `legal.status` is `public` only when the platform marks
  the post public and no session was used. Captures against one platform run one at a time.
  The secret-key rule also drops the word pairs api/access/private/secret + `key` and the words
  credential(s) and jwt, but keeps a bare `key` (`extractor_key`). Immediately before storing, the
  `capture` decision is evaluated again without auditing an allow; a deny (governance edited, a
  protocol expired during the download) stops with `POLICY_CHANGED`, nothing stored, one deny audited.
- **Profile capture** (`profile-capture.ts`, spec 5.5): one audited `capture` decision per run;
  the profile is listed with `flatList`/metadata only, then each post not yet known goes through the
  link-capture per-item path with the run's ImportBatch (kind `profile-capture`,
  `imports/batch-<NNNN>/{batch.json, journal.jsonl}`) id in provenance. State lives in
  `profiles/<platform>-<handle or P-code>/` (`profile.json` with `knownPostIds`, `archive.txt` in
  download-archive format written by the library after each stored post, dated `snapshots/` and
  `reports/`), encrypted in encrypted projects, and the folder and collection use the participant
  code when names are pseudonymized. The enumeration never gets the archive (yt-dlp would leave
  archived posts out of the list, which would break removed-post detection); the library skips
  known posts itself. `profile.json` also keeps `knownPosts` (per post: the listing/tab it was
  found in, and the availability to restore if it disappears and returns). YouTube channels are
  listed through their tabs (`/videos`, `/shorts`), never the bare channel (which lists tabs).
  Posts missing from a list are marked `unavailable-on-platform` only for listings that came back
  whole in this run: not cut short, not nested, not shorter than the platform's own count, no
  date or number limit (gallery-dl's range counts files, not posts), the run not paused, and the
  list sharing at least half of the known posts of those listings (sanity guard). Bookkeeping files
  (`profile.json`, `archive.txt`, the batch record, the report) are still written after a run stops
  (rate limit, `POLICY_CHANGED`): they record what happened, not new captured data. The batch
  record is written first (`state: running`), before the profile source; a run interrupted later
  finds its profile source again by link and `genre: profile`. Edits: YouTube compares only titles
  in listings (descriptions there are truncated); a suspected edit is confirmed by fetching the
  post's full metadata, which is what gets stored. Comments always need a legal basis. Edited captions add a dated
  platform-metadata original and a title variant; the first snapshot is never changed. Rate limits:
  waits of 60, 120 and 240 s, then the run pauses (`paused-rate-limited`) and a re-run resumes.
  Comments (`includeComments`, off by default) need a `store` decision with `identifiable: true`
  before any download; the worker's yt-dlp `--write-comments` output is moved to
  `<id>.comments.json` and stored, stripped, as a separate `platform-comments` original (gallery-dl:
  unsupported, `commentsUnsupported`).

### Optional tools on first use (Task 48a, R126, R133)

The app does not bundle its optional tools. The worker keeps a catalogue of them (`GET /tools`,
`ao_worker/toolpins.py` and `tools.py`): for each, its purpose in plain words, what stops working
without it, the download size, the version, and whether it is installed and usable (a quick local
self-check: the program runs, a model's files are all there at their pinned sizes). The service
offers it to the desktop app (`GET /tools`, `POST /tools/:id/install|update|remove`,
`GET /tools/jobs/:jobId`, `POST /tools/jobs/:jobId/cancel`; shapes in `@ao/shared`).

| Tool (choice) | Parts | From | Verified by |
|---|---|---|---|
| `speech-tiny`, `-small`, `-medium`, `-large-v3` | the faster-whisper model's files | `huggingface.co/Systran/faster-whisper-<size>/resolve/<pinned commit>/` | SHA-256 and size per file |
| `video-downloader` | yt-dlp + deno (the JavaScript runtime yt-dlp needs for YouTube) | yt-dlp: the latest release, as above; deno 2.9.8: `dl.deno.land` per platform | yt-dlp: its release's `SHA2-256SUMS`; deno: pinned SHA-256 |
| `image-downloader` | gallery-dl | the pinned PyPI wheel | pinned SHA-256 |
| `ffmpeg` | ffmpeg + ffprobe | Martin Riedl's 9.0.2 release builds (ADR 0014; until the app's own build exists) | pinned SHA-256 per platform |
| `ocr` | tesseract + English language data | language data: `tessdata_fast` 4.1.0; tesseract: no pinned build yet (ADR 0014), so a system tesseract is used | pinned SHA-256 |

- **Platforms:** macOS arm64, macOS x64 and Linux x64 (CI). A part with no pin for a platform says
  why (`unavailableReason`) and is never downloaded from anywhere else. Today: tesseract has no pin
  on any platform. exiftool stays bundled and required; ghostscript is not offered (ADR 0014).
- **Where:** tools in `AO_TOOLS_DIR` (the app's data folder; yt-dlp stays at `<tools>/yt-dlp`, the
  others in `<tools>/<part>/`), speech models in `AO_MODELS_DIR` in Hugging Face's cache layout, so
  faster-whisper's own local-only look-up finds them with no network (R144). Never in a library.
- **How it is verified:** a download is one plain GET with a fixed User-Agent, no cookies and no
  query string, so nothing about the researcher, a library or a project is sent (R7). A redirect is
  followed only to the hosts the pin lists, never from https to http. The file is hashed while it is
  streamed and refused when it is longer than pinned, cut short, or its SHA-256 differs, before
  anything is unpacked or made executable. Archives are unpacked only into the staging folder:
  regular files only, no absolute paths, no `..`, no links, no duplicate names (case-insensitively),
  a limit on files and on unpacked bytes counted while writing. On a Mac the quarantine attribute is
  removed from the verified files (ADR 0014). The staged program then runs once (its self-check);
  only then is it renamed into place, replacing any older copy in one rename.
- **Failures:** a failed, cancelled or interrupted install leaves nothing half-installed (the
  staging folder is removed; at start the worker deletes leftover staging folders and puts back a
  copy an install had moved aside) and can simply be retried. Codes: `TOOL_DOWNLOAD_FAILED`,
  `TOOL_CHECKSUM_MISMATCH`, `TOOL_ARCHIVE_UNSAFE`, `TOOL_WRITE_FAILED` (disk full or not writable),
  `TOOL_UNUSABLE`, `TOOL_UNAVAILABLE`, `TOOL_NOT_MANAGED` (removing a tool that belongs to the
  computer, which is left alone), `TOOL_UPDATE_FAILED`. The service answers a failed update with
  `502 TOOL_FAILED` and the code as `reason`, never a bare 500.
- **Updating:** the video downloader updates yt-dlp in place with its own verified updater (as
  above) and installs a newer pinned deno; the other tools are reinstalled when the app's pin is
  newer than the installed copy.
- **Missing tools are said, not hidden:** a capture, transcription, viewing copy or OCR whose tool
  is missing fails with `TOOL_NOT_INSTALLED` and the tool's id (`tool` in the worker's error; the
  service's `409 TOOL_NOT_INSTALLED` with the id as `reason`). Without ffmpeg, located media stays
  "proxy pending" and out of exports (R83, R90 c); after ffmpeg or OCR is installed the service
  retries the open library's failed viewing copies or OCR jobs. An absent speech model is no longer
  downloaded automatically (the first download R144 kept until this dialogue existed).
- **The JavaScript runtime:** yt-dlp is always told which runtime to use,
  `--js-runtimes deno:<path>` (the app's deno, else one on PATH), when one is installed (R133).
- **The live check (R133):** `services/media-worker/.venv/bin/python services/media-worker/scripts/live_check.py --network`
  installs the video downloader into a temporary folder exactly as the dialogue does and reads one
  public video's metadata with the arguments a capture uses, failing on a runtime or challenge
  warning. It is opt-in, uses the network, and refuses to run in CI.

## Consequences

- Extractor fixes reach researchers within a day without an app release, at the cost of running a
  binary that changes under the app; the checksum check and the official release channel are the
  trust anchor.
- First use needs a network connection (R126): the dialogue downloads what the researcher chose;
  offline installs can point `AO_YTDLP_BIN` / `AO_GALLERYDL_BIN` at programs they provide, or put
  ffmpeg and tesseract on PATH.
- gallery-dl breakage needs an app release with a new pin (or `AO_GALLERYDL_BIN`); revisit if that
  happens often.
- Packaged builds ship the worker as a sidecar (`AO_WORKER_BIN`) without gallery-dl; the packaged
  worker runs the downloaded gallery-dl on its own Python (`ao-worker -m gallery_dl`), which must
  carry the standard-library modules gallery-dl imports (`packaging/ao-worker.spec`; confirmed by
  the smoke test's `--gallery-dl-wheel` check on a packaged build).
