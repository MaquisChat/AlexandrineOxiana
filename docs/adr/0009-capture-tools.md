# 0009. Capture tools: yt-dlp and gallery-dl

- **Status:** Accepted
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

- **yt-dlp is a managed standalone binary**, not a Python dependency. On first use the media worker
  resolves the latest release tag once (from the redirect of `releases/latest/download/SHA2-256SUMS`),
  downloads that tag's `SHA2-256SUMS` and the platform's asset (`yt-dlp_linux`,
  `yt-dlp_linux_aarch64`, `yt-dlp_macos`, `yt-dlp.exe`) from `releases/download/<tag>/`, checks
  the SHA-256, and installs it (mode 0755) into
  `AO_TOOLS_DIR`. A mismatch is refused (`TOOL_CHECKSUM_MISMATCH`) and nothing is installed.
- **Resolution order:** `AO_YTDLP_BIN`, then the managed binary, then `yt-dlp` on PATH; it is
  downloaded only when none of these exists. Tests put fake `yt-dlp`/`gallery-dl` scripts first on
  PATH and never download.
- **Updates:** `POST /tools/update` runs `yt-dlp --update-to stable` on the managed binary (yt-dlp's
  own updater verifies the release checksums) and reports old and new versions. A binary from
  `AO_YTDLP_BIN` or PATH belongs to the user or the system and is only reported. The app decides
  when to call it (for example from a "Update capture tools" button, or after an
  `EXTRACTOR_ERROR`).
- **gallery-dl is pinned** in the worker's Python dependencies (`gallery-dl==1.32.19`) and runs as
  `python -m gallery_dl --config-ignore` from the worker's environment (or `AO_GALLERYDL_BIN`), so
  the user's own gallery-dl configuration (which may hold credentials or post-processors) is never
  read; yt-dlp likewise runs with `--ignore-config`. It updates with app
  releases. It has no verified standalone update channel comparable to yt-dlp's.
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

## Consequences

- Extractor fixes reach researchers within a day without an app release, at the cost of running a
  binary that changes under the app; the checksum check and the official release channel are the
  trust anchor.
- The first capture needs network access to GitHub; offline installs can point `AO_YTDLP_BIN` at a
  binary they provide.
- gallery-dl breakage needs an app release (or `AO_GALLERYDL_BIN`); revisit if that happens often.
- Packaged builds must ship the worker as a sidecar (`AO_WORKER_BIN`) with gallery-dl inside it.
