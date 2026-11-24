# Media worker (`ao_worker`)

A local Python service that does the media work the TypeScript side cannot: transcription
(faster-whisper) with hallucination flags, capture downloads (yt-dlp, gallery-dl), image and video
viewing proxies, and PDF OCR (ocrmypdf). The app starts it, talks to it over HTTP on
`127.0.0.1`, and owns all persistence: jobs live in memory only, and a restarted worker starts
empty (the Node side resubmits pending jobs from the index's `jobs` table).

The Node client is `packages/library/src/worker-client.ts` (`startWorker`, `WorkerClient`).

## Setup

Needs Python 3.12+. The optional tools (ffmpeg/ffprobe for video proxies, tesseract for OCR,
yt-dlp with deno and gallery-dl for capture, the speech models) are installed by the first-use
tools dialogue (`GET /tools`, below) or found on the system's PATH; in development and CI they
come from the system (`tesseract-ocr ghostscript ffmpeg` from apt). Audio decoding for
transcription uses the bundled PyAV, not ffmpeg.

```sh
pnpm setup:py          # creates services/media-worker/.venv and installs the worker + test deps
pnpm fetch-fixtures    # downloads the pinned third-party test fixtures (needs network)
pnpm test:py           # runs pytest inside services/media-worker with that venv
```

`pnpm setup:py` uses `$PYTHON` if set, otherwise `python3.13`, `python3.12` or `python3`.
`pnpm test:py` skips with a message (exit 0) when the venv does not exist yet, and passes extra
arguments to pytest (`pnpm test:py -m "not slow"` skips the transcription tests, which download
the `tiny` model on first run into `$AO_MODELS_DIR` or `~/.cache/ao-worker-test-models`). Tests
that need a downloaded fixture skip with the reason when it is missing; the OCR tests skip with
the reason when `tesseract` or `gs` is missing. With `CI=true`, a missing venv makes `pnpm test:py`
fail and a fixture that cannot be fetched makes `pnpm fetch-fixtures` fail; CI installs
`tesseract-ocr ghostscript ffmpeg`, runs `pnpm setup:py` and `pnpm fetch-fixtures`, then `pnpm test:py`
(`.github/workflows/ci.yml`).

## Running

```sh
{ printf '%s\n' "$TOKEN"; cat; } | AO_WORKER_PORT=0 .venv/bin/python -m ao_worker
# prints: AO_WORKER_READY port=<n>
```

| Variable | Meaning |
| --- | --- |
| `AO_WORKER_PORT` | port on 127.0.0.1 (`0` = any free port; the chosen one is printed) |
| `AO_MODELS_DIR` | faster-whisper models (Hugging Face cache layout), installed by `POST /tools/speech-<size>/install`. A model there is loaded with no network contact; an absent one fails the job with `TOOL_NOT_INSTALLED` (tool `speech-<size>`) and is never downloaded on the fly |
| `AO_TOOLS_DIR` | the optional tools the worker installs: `yt-dlp` (ADR 0009), `deno/`, `ffmpeg/`, `gallery-dl/`, `tessdata/` |
| `AO_YTDLP_BIN` / `AO_GALLERYDL_BIN` | use this executable instead |
| `AO_WORKER_LOG_LEVEL` | default `INFO`; logs go to stderr |

The access token arrives on **standard input**, as one line (R98, R155): 32–512 characters from
`A–Z a–z 0–9 . _ ~ + / = -`; every request needs `Authorization: Bearer <token>`. The worker refuses
to start if `AO_WORKER_TOKEN` is in its environment, if it is given any argument, if standard input
is a terminal, or if no line arrives within 10 seconds. After the line, standard input stays open:
its **end** stops the worker cleanly (the service that started it is gone), so a crashed or killed
parent leaves no stray worker. SIGTERM does the same: it cancels all jobs (killing their process
groups) and exits.

`startWorker` passes the worker only an allowlisted environment (PATH, HOME, locale, temp, proxy and
CA-bundle variables, `XDG_*`, `AO_*`, Windows system folders); the worker passes child tools
(yt-dlp, gallery-dl, ffmpeg, ocrmypdf) the same kind of allowlist, never the token. Each job gets a
private scratch folder `<dirname(output)>/.work-<job id>` (0700) that its child tools use as
`TMPDIR`/`TEMP`/`TMP`, so temporary copies of (possibly decrypted) inputs never reach the system
temp folder; it is removed when the job ends, including after a cancel.

## API

All bodies are JSON. Errors are `{ error: { code, message, detail? } }`; a missing or wrong token
is `401 UNAUTHORIZED`, an invalid request `400 INVALID_REQUEST`.

- `GET /health` → `{ ok: true, versions: { python, faster_whisper, yt_dlp, gallery_dl, pillow, pillow_heif, rawpy, ffmpeg, ocrmypdf, tesseract } }` (missing tools are `null`; health never downloads anything).
- `POST /jobs` `{ type, input, output, params }` → `202 { id }`. `input` is an absolute path (a URL for `capture.download`), `output` an absolute path.
- `GET /jobs/{id}` → `{ id, type, status: queued|running|done|failed|cancelled, progress: 0..1, result?: { output, meta }, error? }`. A finished job is forgotten once this has returned its terminal state (or 10 minutes after it ended); later requests get 404.
- `POST /jobs/{id}/cancel` → `202` with the job. A queued job is cancelled at once; a running job's child processes are killed as a process group (SIGTERM, SIGKILL after 3 s).
- `POST /tools/update` → `{ ytDlp: { old, new, managed }, galleryDl: { version, pinned: true } }`. Runs `yt-dlp --update-to stable` on the managed binary only; a binary from `AO_YTDLP_BIN` or PATH is reported, not touched. Failure: `502 { error: { code: TOOL_UPDATE_FAILED | TOOL_DOWNLOAD_FAILED | TOOL_CHECKSUM_MISMATCH, message, tool } }`.
- `GET /tools` → `{ platform, tools: [{ id, group, name, purpose, without, version, downloadSize, remainingSize, sizeApproximate, installed, usable, managed, updateAvailable, available, unavailableReason?, notice?, components: [...] }] }`: the optional tools (`speech-tiny|small|medium|large-v3`, `video-downloader` = yt-dlp + deno, `image-downloader` = gallery-dl, `ffmpeg`, `ocr` = tesseract + English data). Quick local checks only; no network.
- `POST /tools/{id}/install|update|remove` → `202 { id }`: a job (`tool.install` …) polled and cancelled like any other. Pins, verification and the atomic install are described in `ao_worker/tools.py` and ADR 0009. Its result: `{ tool, action, installed, updated, skipped }` or `{ tool, action, removed }`; its error carries `tool`.

A job whose optional tool is missing fails with `TOOL_NOT_INSTALLED` and `error.tool` naming it
(`video-downloader`, `image-downloader`, `ffmpeg`, `ocr`, `speech-<size>`).

At most 2 jobs run at once; more are queued. A transcription counts as one job and uses every CPU core. Tool installs (`tool.*`) run in a lane of their own, one at a time, so a large download never holds up the media jobs. Every tool download has a stall limit (no byte for 30 s), a deadline scaled to its size, and ends within about a second of a cancel.

### Job types

| Type | Params (defaults) | Output | `meta` |
| --- | --- | --- | --- |
| `audio.transcribe` | `model: large-v3\|medium\|small\|tiny` (`large-v3`), `language: 'auto'\|one of faster-whisper's codes`, `multilingual` (true), `vad` (true), `computeType: int8\|float16` (`int8`), `wordTimestamps` (true) | dir with `transcript.vtt`, `segments.json` | `{ model, detectedLanguages, durationSec, flaggedCount }` |
| `capture.download` | `tool: yt-dlp\|gallery-dl`, `cookiesFromBrowser?`, `archiveFile?`, `flatList?`, `maxItems?`, `dateAfter?`/`dateBefore?` (`YYYYMMDD`), `metadataOnly?`, `quality?: best\|1080p\|720p` (yt-dlp `-f`), `includeComments?` (yt-dlp `--write-comments`, moved to `<id>.comments.json`; gallery-dl: ignored, `commentsUnsupported: true`) | dir | `{ files, infoJson, comments, commentsUnsupported?, tool, toolVersion, partial, errorCode?, errorDetail? }` (an enumeration — `flatList`/`metadataOnly` — cut short after writing metadata is `partial`, not failed) |
| `image.proxy` | `maxEdge` (2560), `quality` (85), `location: keep\|coarsen\|strip` (`keep`) | JPEG file | `{ width, height, sourceFormat, location }` |
| `video.proxy` | `maxHeight` (1080), `crf` (23), `location` (`keep`) | MP4 file | `{ durationSec, width, height, location }` |
| `pdf.ocr` | `languages` (`['eng']`) | PDF file, plus `<output>.txt` | `{ sidecarText, pages }` |

`segments.json` is `Array<{ start, end, text, lang, avgLogprob, noSpeechProb, compressionRatio, flags, words? }>`.
Language is detected per 30 s window of VAD speech (faster-whisper's `multilingual` mode decodes
each window in its own language). `flags` (see `hallucination.py`): `low-confidence`
(avgLogprob < -1.0), `no-speech` (noSpeechProb > 0.6 with text), `repetition` (compression ratio
> 2.4, or the same text in ≥ 3 consecutive segments), `outside-speech` (< 20 % overlap with
Silero VAD speech), `known-phrase` (a stock phrase from `ao_worker/known_phrases.txt`, only when
also `no-speech` or `outside-speech`). Flagged segments also carry a `NOTE flags:` line in the VTT.

Capture errors map to `LOGIN_REQUIRED`, `RATE_LIMITED`, `NOT_FOUND_OR_REMOVED`, `GEO_BLOCKED`,
`PRIVATE` or `EXTRACTOR_ERROR` with the tool's stderr tail (redacted) in `detail`. A run that
fails after downloading some media is `done` with `partial: true` and the code in `errorCode`.

Image proxies keep the source's ICC profile. Capture metadata (time, device) of RAW files comes
from Pillow reading them as TIFF, which works for DNG, CR2, NEF and ARW; **CR3, RAF and ORF
proxies carry no capture metadata** (rawpy exposes none).

Location: `coarsen` rounds GPS to one decimal (≈ city level) and drops altitude and the other GPS
fields; `strip` removes them. Video `strip`/`coarsen` drop all container metadata and rewrite
only creation time and device make/model (and, for `coarsen`, the rounded ISO 6709 location; the
MP4 muxer writes it with four decimals, e.g. `+40.7000-074.0000/`).

## Privacy rules

- Logs never contain user file paths, cookie options, or URLs with query strings, credentials or
  fragments (`download.strip_url`); error details are redacted the same way and show the home
  folder as `~`.
- Responses contain no absolute paths except under the caller's own `output`.

## Packaging

The desktop app ships the worker as a self-contained folder built with PyInstaller (one folder,
one build per platform and architecture; no universal2 build, ADR 0014). The user's machine needs
no Python.

```sh
node apps/desktop/scripts/build-sidecars.mjs           # build for this machine
node apps/desktop/scripts/build-sidecars.mjs --smoke   # build, then run the smoke test
node apps/desktop/scripts/build-sidecars.mjs --skip-build --smoke
node apps/desktop/scripts/build-sidecars.mjs --resolve-for macos-x86_64   # check a pin set, no build
```

It needs Python 3.12+ (`$PYTHON`, else `python3.13`/`python3.12`/`python3`) and PyPI. It makes a
build venv per pin set under `apps/desktop/.build/` and writes
`apps/desktop/sidecars/ao-worker-<target triple>/` (both git-ignored): the executable `ao-worker`,
its `_internal/` folder and `sidecar-manifest.json` (worker and Python version, platform,
architecture, pin set, and every bundled package with its version, licence and licence files).
PyInstaller is a build-time dependency only (the `packaging` extra). The spec, the frozen entry
point and the smoke test are in `packaging/`; the spec says, for each hidden import and data
file, what broke without it.

**Inside:** the worker and its Python dependencies (with `requests`, which the downloaded gallery-dl
uses). **Not inside** (R126, Task 48a): ffmpeg, ffprobe, tesseract, ghostscript, yt-dlp, deno,
gallery-dl (GPL-2.0-only) and the speech models. The packaged worker finds them the same way as
from source: the copies it installed in `AO_TOOLS_DIR` / `AO_MODELS_DIR` first, else ffmpeg,
ffprobe, tesseract and deno on `PATH`, yt-dlp through `AO_YTDLP_BIN`. It starts and answers
`/health` and `/tools` with none of them present. The downloaded gallery-dl runs as
`ao-worker -m gallery_dl` with `AO_GALLERYDL_LIB` naming its folder; the smoke test checks that
with `--gallery-dl-wheel <the pinned wheel>`.

**Live check (R133, opt-in, never in CI):**
`.venv/bin/python scripts/live_check.py --network` installs the video downloader into a
temporary folder as the tools dialogue does and reads one public video's metadata with the real
yt-dlp and the arguments a capture uses (`--js-runtimes deno:<path>` included). Exit 0 passed,
1 drift or failure, 3 inconclusive (the site refused this computer).

**How the shell starts it:** exactly like the source worker, with the executable as the whole
command: `AO_WORKER_BIN=<folder>/ao-worker` for `startWorker`, which writes the token as one line on its
standard input (kept open for the worker's life), passes `AO_WORKER_PORT=0` in the environment and
reads `AO_WORKER_READY port=<n>` from stdout. SIGTERM ends it (exit 0) and its job processes. The
executable also runs `ao-worker -m ocrmypdf …` and `ao-worker -m gallery_dl …`, because the worker
starts those as `sys.executable -m`, and `ao-worker --self-check`; it refuses anything else.

**Pin sets (R133, FR-730):** the default pins in `pyproject.toml` (direct dependencies only; what
they bring with them takes the newest version of the day), the Apple-silicon set in
`packaging/constraints-macos-arm64.txt` (every package of the bundle at an exact version), and the
Intel-Mac set in `packaging/constraints-macos-x86_64.txt` (older onnxruntime, pikepdf, ocrmypdf,
rawpy and cryptography, which no longer publish Intel-Mac wheels). On each Mac the build script
uses that Mac's set by default (`--constraints none` to override); `--constraints <file>` selects
one elsewhere. A package named in the Intel file is pinned by it even where `pyproject.toml` pins
it directly. The Apple-silicon file is complete: `pyproject.toml`'s direct pins stay in force (a
direct pin that differs from its line stops pip), and after the build `manifest.py --pins-complete`
fails it when a package in the bundle is not named in the file or has another version there. Every
dependency must be a wheel. `--resolve-for macos-arm64` (or `macos-x86_64`) checks on any machine
that a pin set resolves to wheels for that Mac. Linux builds (CI's `worker-bundle` job,
`pnpm setup:py`) use the default pins.

**Changing a pin** (Apple Silicon; a deliberate act, never a side effect of a rebuild):

1. Edit `packaging/constraints-macos-arm64.txt`: change the package's version (for a direct
   dependency, change it in `pyproject.toml` too, to the same version); add a line for a package
   a new version brings with it, remove the line of one no longer in the bundle.
2. Check on any machine that the set still resolves to wheels for the Mac:
   `node apps/desktop/scripts/build-sidecars.mjs --resolve-for macos-arm64`.
3. Run the Mac build. A changed file makes a new build venv. The log's `pin set: macos-arm64` line
   names the file, and the `constraints check:` line says every package of the bundle is pinned
   by it; a package the file misses, or another version, fails the build and names it.
4. The build's `sidecar-manifest.json` (the artefact `worker-bundle-report-macos-apple-silicon`)
   shows the result: each package with its version, and `constraints` with the file's SHA-256.

**Smoke test** (`packaging/smoke_test.py`, run with `--smoke`): from a temporary folder with a
clean environment (no venv, no `PYTHONPATH`/`PYTHONHOME`) it checks the self-check, the ready
line, `/health`, and clear failures for OCR, video proxies and transcription with no tools or
models; then, with this machine's ffmpeg, ffprobe and tesseract linked into `$AO_TOOLS_DIR/bin`
and the `tiny` model in `AO_MODELS_DIR`, the outputs themselves, checked independently of what
the worker reports: HEIC and DNG proxies decoded with Pillow (JPEG, 1024 px, EXIF rotation
applied, not blank), the video proxy probed and fully decoded with the supplied ffprobe/ffmpeg
(MP4, H.264/AAC, 240 lines, the input's duration), a three-page OCR, and a transcript containing
at least two of "curiosity", "beside", "moment" with a timed segment. SIGTERM must leave no
process behind. Every proxy variable points at a local sentinel that refuses and records
requests: none may be made while starting, answering `/health`, or transcribing with the model on
disk. The only download is the `tiny` model, once, before any worker starts (kept in
`~/.cache/ao-worker-smoke-models` or `$AO_SMOKE_MODELS_DIR`; `--no-model-download` skips it). A
missing fixture, model or tool **fails** the run; `--allow-missing model,clip,dng,ffmpeg,tesseract`
turns the named absences into reported skips, for local experiments only (CI and the commands
above do not use it). CI runs the smoke test on `main` and on manual runs.

**Licences:** the build writes `licenses/` next to the executable: each bundled package's own
licence files (`packages/<name>/`), the build Python's licence, the GNU GPL-2.0, GPL-3.0, LGPL-2.1
and LGPL-3.0 texts (`gnu/`, copied from `packaging/licenses/`), and `README.txt`, a table of every
native library in the bundle with the package that carries it and its licence *as stated* by
that wheel's files, by the library itself (FFmpeg) or "unknown". The same facts are in
`sidecar-manifest.json` (`packages[].binaryWheelStatement`,
`packages[].copyleftIncludingNativeLibraries`, `nativeLibraries`). Facts only, no legal
assessment. The manifest must match the bundle exactly: every `*.dist-info` folder and every
native library in `_internal/` must be listed, and everything listed must be there. Writing the
manifest fails the build otherwise, and `--smoke` checks it again
(`manifest.py --bundle <folder> --out <folder>/sidecar-manifest.json --check`). The package list
follows the extras a requirement asks for (ocrmypdf needs `pikepdf[pdfa]`, which brings
jsonschema and referencing). Unit tests: `services/media-worker/tests/test_packaging_manifest.py`.

**Symbolic links (for the Mac build):** PyInstaller links every shared library that a wheel keeps
in `<package>.libs/` (or `.dylibs/` on macOS) into the top of `_internal/` (64 links in the Linux
build); its macOS library-path rewriting expects them there. `--skip-build --list-symlinks` lists
them. PyInstaller has no spec or command-line option to turn them off; a hook can suppress them
for matching paths (`bindepend_symlink_suppression` in a hook, or
`hook_api.add_bindepend_symlink_suppression_pattern()`). Untested on macOS, where suppressing them
may break library loading; signing and copying them into the app is for Tasks 37f/37g.

**Speech models:** a model already in `AO_MODELS_DIR` is loaded from disk with no network
contact. Only an absent model is downloaded (logged); a failed download is `MODEL_UNAVAILABLE`.
