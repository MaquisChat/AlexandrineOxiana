# Media worker (`ao_worker`)

A local Python service that does the media work the TypeScript side cannot: transcription
(faster-whisper) with hallucination flags, capture downloads (yt-dlp, gallery-dl), image and video
viewing proxies, and PDF OCR (ocrmypdf). The app starts it, talks to it over HTTP on
`127.0.0.1`, and owns all persistence: jobs live in memory only, and a restarted worker starts
empty (the Node side resubmits pending jobs from the index's `jobs` table).

The Node client is `packages/library/src/worker-client.ts` (`startWorker`, `WorkerClient`).

## Setup

Needs Python 3.12+ and, on the system, `ffmpeg`/`ffprobe` (proxies, audio decoding),
`tesseract` and `ghostscript` (OCR).

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
AO_WORKER_TOKEN=<random, ≥16 chars> AO_WORKER_PORT=0 .venv/bin/python -m ao_worker
# prints: AO_WORKER_READY port=<n>
```

| Variable | Meaning |
| --- | --- |
| `AO_WORKER_TOKEN` | required; every request needs `Authorization: Bearer <token>` |
| `AO_WORKER_PORT` | port on 127.0.0.1 (`0` = any free port; the chosen one is printed) |
| `AO_MODELS_DIR` | faster-whisper model cache (downloaded on first use) |
| `AO_TOOLS_DIR` | managed standalone yt-dlp binary (ADR 0009) |
| `AO_YTDLP_BIN` / `AO_GALLERYDL_BIN` | use this executable instead |
| `AO_WORKER_EXIT_ON_STDIN_EOF=1` | exit when stdin closes (set by `startWorker`, so the worker dies with the app) |
| `AO_WORKER_LOG_LEVEL` | default `INFO`; logs go to stderr |

SIGTERM cancels all jobs (killing their process groups) and exits.

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
- `POST /tools/update` → `{ ytDlp: { old, new, managed }, galleryDl: { version, pinned: true } }`. Runs `yt-dlp --update-to stable` on the managed binary only; a binary from `AO_YTDLP_BIN` or PATH is reported, not touched.

At most 2 jobs run at once; more are queued. A transcription counts as one job and uses every CPU core.

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

**Inside:** the worker, its Python dependencies and gallery-dl. **Not inside** (R126): ffmpeg,
ffprobe, tesseract, ghostscript, yt-dlp and the speech models. The packaged worker finds them the
same way as from source: ffmpeg, ffprobe and tesseract on `PATH` (the shell puts the tools
folder's `bin` first on `PATH`), yt-dlp through `AO_YTDLP_BIN` or `AO_TOOLS_DIR`, models in
`AO_MODELS_DIR`. It starts and answers `/health` with none of them present.

**How the shell starts it:** exactly like the source worker, with the executable as the whole
command: `AO_WORKER_BIN=<folder>/ao-worker` for `startWorker`, which passes `AO_WORKER_TOKEN`,
`AO_WORKER_PORT=0` and `AO_WORKER_EXIT_ON_STDIN_EOF=1` in the environment and reads
`AO_WORKER_READY port=<n>` from stdout. SIGTERM ends it (exit 0) and its job processes. The
executable also runs `ao-worker -m ocrmypdf …` and `ao-worker -m gallery_dl …`, because the worker
starts those as `sys.executable -m`, and `ao-worker --self-check`; it refuses anything else.

**Two pin sets (R133):** the default pins in `pyproject.toml`, and the Intel-Mac set in
`packaging/constraints-macos-x86_64.txt` (older onnxruntime, pikepdf, ocrmypdf, rawpy and
cryptography, which no longer publish Intel-Mac wheels). On an Intel Mac the build script uses
the Intel set by default (`--constraints none` to override); `--constraints <file>` selects one
elsewhere. A package named in a constraints file is pinned by it even where `pyproject.toml` pins
it directly. Every dependency must be a wheel. `--resolve-for macos-x86_64` (or `macos-arm64`)
checks on any machine that a pin set resolves to wheels for that Mac.

**Smoke test** (`packaging/smoke_test.py`, run with `--smoke`): from a temporary folder with a
clean environment (no venv, no `PYTHONPATH`/`PYTHONHOME`), it checks the self-check, the ready
line, `/health`, HEIC and DNG image proxies, and clear failures for OCR, video proxies and
transcription with no tools or models; then, with this machine's ffmpeg, ffprobe and tesseract
linked into `$AO_TOOLS_DIR/bin` and the `tiny` model in `AO_MODELS_DIR`, a video proxy, a
three-page OCR and a transcription; and that SIGTERM leaves no process behind. Every proxy
variable points at a local sentinel: nothing may be requested while starting and answering
`/health`, and later requests are refused as on a machine with no network. The only download is
the `tiny` model, once, before any worker starts (kept in `~/.cache/ao-worker-smoke-models` or
`$AO_SMOKE_MODELS_DIR`; `--no-model-download` skips it). CI runs it on `main` and on manual runs.
