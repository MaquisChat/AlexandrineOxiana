# 0014. How the external tools and the worker reach a Mac

- **Status:** Proposed — for the coordinator's ruling and the owner's confirmation of the minimum macOS version
- **Date:** 2026-11-11

## Context

The first release is a macOS app: a Tauri 2 shell that starts the Node library service and the
Python media worker (PyInstaller, one folder). It must run on Apple Silicon and Intel Macs (R122).
Builds run on GitHub's hosted Macs; only the owner (M3) can test on a real Mac.

R126 says optional tools are not bundled: on first use the app asks which ones the researcher needs
and downloads only those. ADR 0009 stays in force: yt-dlp is the latest release, checksum-checked,
kept in the tools folder (`AO_TOOLS_DIR`) and updated in place; gallery-dl is pinned inside the
worker; exiftool is bundled and required.

What the code needs today (read 2026-11-11):

- `video_proxy.py` runs `ffmpeg` and `ffprobe` from `PATH` and encodes with `-c:v libx264`, so the
  ffmpeg build must include libx264 (a GPL build).
- `ocr.py` runs `python -m ocrmypdf --output-type pdf` (or `AO_OCRMYPDF_BIN`). ocrmypdf finds
  `tesseract` (and, if present, `gs`) on `PATH`. `TESSDATA_PREFIX` is passed to child tools
  (`jobs.py`). After OCR the worker opens the result with pikepdf.
- `download.py` maps every Mac to the `yt-dlp_macos` release asset and checks it against
  `SHA2-256SUMS`; gallery-dl runs as `python -m gallery_dl` from the worker.
- `transcribe.py` loads faster-whisper models `large-v3`, `medium`, `small`, `tiny` with
  `WhisperModel(name, device="auto", compute_type="int8", download_root=AO_MODELS_DIR)`. It does
  not pass a `revision`, so it downloads whatever is current on Hugging Face. Voice-activity
  detection uses the Silero model that ships inside the faster-whisper wheel and runs on
  onnxruntime.
- `packages/library` pins `better-sqlite3` ^12.11.1 (lock: 12.11.1), `@napi-rs/keyring` 2.1.2 and
  `exiftool-vendored` 39.0.1 (which pulls `exiftool-vendored.pl` 13.59.3 on macOS).
- CI installs `tesseract-ocr ghostscript ffmpeg` with apt on Ubuntu, Node 22, Python 3.12 and 3.13.

Every fact below has a source and the date it was checked. All checks are from 2026-11-11 unless
marked otherwise. "Not verified" means it could not be checked from a Linux machine and needs a
Mac or another source. The list of sources is at the end.

## Decision

### 1. The tools

| Tool | Recommended source | Licence | Apple Silicon / Intel | Download size | Bundled or offered | Pinned and verified by | What the app must do for Gatekeeper |
|---|---|---|---|---|---|---|---|
| **ffmpeg + ffprobe** | Built in our own CI from the pinned FFmpeg release source, with `--enable-gpl --enable-libx264`, static, one build per architecture. Published as an asset on our own GitHub release, together with the matching source archives. Until that exists (development, the owner's first tests): Martin Riedl's 9.0.2 release builds [S1]. | GPL (the libx264 build is GPL-2.0+; Riedl's build is GPLv3, using `--enable-gpl --enable-version3` [S2]) | Riedl: both, 9.0.2 (Intel *release* builds end January 2027 [S1]). evermeet.cx: Intel only [S3]. osxexperts: Apple Silicon 9.0.2, Intel only 8.0, "for educational purposes only" [S4]. conda-forge 9.0.2: both, but the Apple Silicon build is the LGPL variant with no libx264, and it links shared conda libraries [S5]. | Riedl zips: ffmpeg 28.4 MB + ffprobe 28.3 MB (Apple Silicon); 33.8 + 33.7 MB (Intel) [S1]. Our own build: not measured. | Offered in the dialogue (R126). Without it, media stays "proxy pending" (R83, R90 c). | URL and SHA-256 fixed in the app's source. Riedl publishes a `.sha256` file per file. For example, the Apple Silicon `ffmpeg.zip` has `c8ed4c4e…d924` and the Intel one has `7c6b4125…acd4` [S1]. | Our build: Developer ID signature, hardened runtime, and a notarised zip. Riedl's zips are signed (his installers are notarised) [S1]. See "Gatekeeper" below. |
| **tesseract** | Built in our own CI (tesseract 5.5.x + leptonica + image libraries), one build per architecture, signed and published like ffmpeg. The project publishes no Mac binaries and points to Homebrew or MacPorts [S6]. Alternatives: conda-forge `tesseract` 5.5.4 (both architectures, a 171 MB package that links other conda libraries [S5]); the `tesserocr` wheels carry libtesseract for both architectures (macOS 15+) but no command-line program, which ocrmypdf needs [S7]. | Apache-2.0 [S6] (leptonica: BSD-style, not verified) | Both, by building it ourselves | Our build: not measured | Offered (the "OCR" choice) | Our release URL + SHA-256 in the app | As for ffmpeg |
| **tesseract language data** | `tessdata_fast` from GitHub, a pinned commit, per language. `tessdata_best` could be offered for accuracy later. | Apache-2.0 | Data files, the same on both architectures | Fast: eng 3.9 MB, deu 1.5, fra 1.1, chi_sim 2.4, ara 1.4, osd 10.1. Best: eng 14.7, deu 8.2, chi_sim 12.5 [S8] | Offered per language inside the OCR choice. English is the default. `osd` only if page rotation is ever turned on. | Pinned commit URL + SHA-256 per file, kept in the app. Point `TESSDATA_PREFIX` at the tools folder. | None (data, not code) |
| **ghostscript** | **Not needed. Do not offer it.** ocrmypdf 17 made Ghostscript optional: "pypdfium2 can be used for PDF rasterization" and is preferred when present [S9][S10]. pypdfium2 is already a required dependency of the pinned ocrmypdf, with wheels for both architectures (macOS 13+). Ghostscript is only for PDF/A edge cases, and the worker writes `--output-type pdf`. | AGPL-3.0 (conda-forge [S5]); Artifex sells a commercial licence instead [S11] | No official Mac binaries [S12]. conda-forge 10.08.0 has both (≈57 MB) [S5]. | — | Not offered | — | — |
| **yt-dlp** | Official `yt-dlp_macos`, which is one **universal** file: its header is a fat Mach-O with x86_64 and arm64 slices (checked on release 2026.10.26). "Universal MacOS (10.15+) standalone executable" [S13]. | Unlicense for the code, but the PyInstaller executables include GPLv3+ code, "the combined work is licensed under GPLv3+" [S13] | Both, in one file | 37.5 MB (2026.10.26) | Offered (the "download from platforms" choice); latest release, updated in place (ADR 0009) | `SHA2-256SUMS` from the same tag (already implemented). `SHA2-256SUMS.sig` (GPG) also exists [S13]. | The binary carries no Developer ID certificate (checked: no "Developer ID" string in the file), so it is not notarised. Its signature is presumably ad hoc (PyInstaller default); this needs checking on a Mac. |
| **gallery-dl** | Pinned in the worker (`gallery-dl==1.32.19`, pure Python) | GPL-2.0-only [S7] | Both (inside each worker build) | Inside the worker | Bundled in the worker (ADR 0009) | The worker's dependency pin | Signed with the worker |
| **exiftool** | `exiftool-vendored.pl` 13.59.3 (Perl ExifTool + MIT wrapper), run by the system's `/usr/bin/perl` | Wrapper MIT [S14]; ExifTool itself is under the Perl licence (not verified) | Both (Perl script) | 21.6 MB unpacked [S14] | Bundled, required | npm lockfile integrity hash | Nothing is executed except a script under the system Perl, so nothing to sign. See risk R5. |
| **speech models** | Hugging Face `Systran/faster-whisper-{tiny,small,medium,large-v3}`, which is where faster-whisper 1.2.1 resolves these names (`faster_whisper/utils.py`) | MIT (model cards) [S15] | Data, the same on both | tiny 75 MB, small 464 MB, medium 1,460 MB, large-v3 2,948 MB [S15] | Offered by size | Today: not pinned. Recommended: pass `revision=<commit>` (supported by `WhisperModel` 1.2.1) using today's commits (tiny `d90ca5fe…`, small `536b0662…`, medium `08e178d4…`, large-v3 `edaa852e…` [S15]), and check the SHA-256 of `model.bin`. | None (data) |

**Gatekeeper.** On Apple Silicon "any executable must be signed before it's allowed to run…a simple
ad-hoc signature is sufficient" [S16]. Gatekeeper's notarisation check is aimed at downloaded
software on first open [S17]. The worker downloads tools with its own HTTP code, so the files
should not get the `com.apple.quarantine` flag. As far as known, that flag is added by apps that ask
for it (browsers, `LSFileQuarantineEnabled`, sandboxed apps); this is not verified on a Mac. The app
must therefore:

1. Check the SHA-256 before installing (already done for yt-dlp). The checksum is the trust anchor.
2. After the check, remove `com.apple.quarantine` from the installed file if it is present. Use the
   `removexattr` call; never ask the researcher to run `xattr` themselves.
3. Refuse a tool that has no valid signature (on Apple Silicon it would not start anyway), and
   report it as `TOOL_UNUSABLE` instead of an obscure exec error.
4. Prefer tools we build, sign and notarise ourselves (ffmpeg, tesseract). XProtect still scans
   every program the first time it runs [S17]. A program signed and notarised with our Team ID is
   the case Apple supports.
5. Verify the whole path on the owner's M3 before 37f: download → `xattr -l` → run.

**Ghostscript and the AGPL, for the record.** The AGPL says that placing a covered work in an
"aggregate" with "separate and independent works…does not cause this License to apply to the other
parts of the aggregate" [S18]. Running `gs` as a separate program is generally treated as
aggregation. Artifex states that the AGPL may bring "further obligations" when its software is
combined with other software, and offers a commercial licence for anyone who cannot meet them
[S11]. If the app downloads Ghostscript from a third party at the user's request, we are not
conveying it. If we host the binary, we convey it and must offer its corresponding source. Because
ocrmypdf no longer needs it, the question does not have to be settled.

**Simpler OCR route, recorded for later.** Apple's Vision framework recognises text with
`VNRecognizeTextRequest` (macOS 10.15+). On macOS 26, `RecognizeDocumentsRequest` also reads
document structure [S19]. Benefits: nothing to download, and it uses Apple's on-device models.
Costs:

- the set of languages is fixed by Apple and smaller than Tesseract's (the list is only available
  at run time, so it could not be counted here);
- it needs native code (a Swift helper, or `pyobjc` with a wrapper such as `ocrmac`);
- ocrmypdf has no built-in Vision engine, so producing a searchable PDF would need our own plugin;
- it does not exist on Windows, and results would differ from CI.

Recommendation: keep Tesseract through ocrmypdf for the first release.

**ffmpeg could disappear later.** The PyAV wheel the worker already pins (av 18.1.0) contains
FFmpeg 8 libraries built with `--enable-libx264 --enable-libx265 --enable-videotoolbox` (checked by
listing the macOS arm64 wheel). The worker could make proxies through PyAV and never download
ffmpeg. That is a code change and outside 37e. It is recorded here because it would remove a
download, a licence question and a signing step.

**yt-dlp needs a JavaScript runtime.** The yt-dlp README now says a JavaScript runtime (deno
recommended; node, quickjs and bun also work) "is also required" for full YouTube support, and only
deno is enabled by default [S13]. The worker passes no `--js-runtimes` today. ADR 0009 otherwise
works unchanged on macOS: `yt-dlp_macos` is right for both architectures, `--update-to stable`
replaces it in place, and it runs on macOS 10.15+.

### 2. Speech: CTranslate2 on a Mac

- The Intel wheels are built with Intel MKL and oneDNN [S20].
- For Apple Silicon, the CTranslate2 hardware page says an experimental MPS (Metal) backend "is
  included in the prebuilt Apple Silicon Python wheels", with FP16 recommended and INT8 only
  experimental [S20]. The installation page says Metal needs a source build [S21]. The two pages
  disagree, and it is not verified which backend `device="auto"` picks in the 4.9.0 wheel.
- Without Metal, transcription runs on the CPU. large-v3 at int8 on the CPU will be slow. Not
  measured here; the owner's M3 should time the test clip with `small` and `large-v3`.
- For later, not a recommendation: whisper.cpp (Metal / Core ML) and MLX Whisper (Apple Silicon
  only) are the Mac-native alternatives. Neither was verified here.

### 3. The Python worker on Intel Macs: wheel table

The versions are those the pins resolve to today. Transitive dependencies are not pinned in
`pyproject.toml`; their newest release was used. The data comes from
`https://pypi.org/pypi/<name>/<version>/json`, read 2026-11-11, for CPython 3.12 including `abi3`
wheels. "Min" is the macOS version in the wheel tag.

| Package (version) | Needed by | arm64 wheel (min macOS) | x86_64 wheel (min macOS) |
|---|---|---|---|
| faster-whisper 1.2.1 | pin | pure Python | pure Python |
| ctranslate2 4.9.0 | faster-whisper | yes (11.0) | yes (11.0) |
| onnxruntime 1.31.1 | faster-whisper (VAD) | yes (14.0) | **no** |
| tokenizers 0.23.3 | faster-whisper | yes (11.0) | yes (10.12) |
| huggingface-hub 2.4.0 / hf-xet 1.8.0 | faster-whisper | pure / yes (11.0) | pure / yes (10.12) |
| av 18.1.0 | pin | yes (**14.0**) | yes (11.0) |
| numpy 2.5.4 | pin, rawpy, ctranslate2 | yes (11.0; 14.0 Accelerate build) | yes (10.13; 14.0) |
| pillow 13.0.0 | pin | yes (11.0) | yes (10.13) |
| pillow-heif 1.8.1 | pin | yes (11.0) | yes (10.15) |
| rawpy 0.28.0 | pin | yes (11.0) | **no** |
| ocrmypdf 17.14.1 | pin | pure Python | pure Python |
| pikepdf 10.18.0 | ocrmypdf (`>=10.18`) | yes (**15.0**) | **no** |
| lxml 6.1.3 | pikepdf | universal2 (10.9+) | yes |
| pypdfium2 5.15.2 | ocrmypdf | yes (13.0) | yes (13.0) |
| uharfbuzz 0.57.0 | ocrmypdf | universal2 (10.9) | universal2 (10.9) |
| pydantic-core 2.50.4 | ocrmypdf (pydantic) | yes (11.0) | yes (10.12) |
| fonttools 4.68.0, charset-normalizer 3.5.2, pyyaml 6.0.3 | ocrmypdf, pdfminer, ctranslate2 | yes | yes |
| cryptography 50.0.2 | pdfminer-six | yes (11.0) | **no** |
| gallery-dl, requests, fpdf2, img2pdf, pdfminer-six, rich, protobuf, flatbuffers, tqdm | various | pure Python | pure Python |

**No Intel wheel at the pinned or newest version:**

| Package | Last version with an x86_64 wheel | What pinning to it costs |
|---|---|---|
| onnxruntime | **1.23.2** (2025-10-27, macOS 13.0). 1.24 dropped Intel Macs and raised the minimum to 14.0 (release notes, via [S22]). | A year behind. It is used only for the Silero VAD, and faster-whisper allows `>=1.14,<2`. Low risk. |
| pikepdf | **10.13.0.post1** (2026-09-05). Its x86_64 wheel already needs **macOS 15.0**. 10.14 "Dropped macOS Intel (x86_64) wheels… Intel Mac users can build from source or stay on pikepdf 10.13" [S23]. | Forces **ocrmypdf ≤ 17.12.1** on Intel (17.13 needs pikepdf ≥ 10.15; 17.14 needs ≥ 10.18). This loses two months of OCR fixes on Intel, or on both architectures if one pin set is kept. |
| rawpy | **0.25.1** (2025-08-03). No x86_64 wheel since 0.26.0 (2026-01-29). | The older LibRaw cannot read RAW files from cameras released since then. Alternative: build rawpy (with LibRaw) from source on the Intel runner. |
| cryptography | **48.0.1** (2026-06-09, universal2). 49.0.0: "Support for x86_64 macOS has been removed" [S24]. | Misses security fixes since June. pdfminer.six needs it only for encrypted PDFs. Building from source needs Rust and OpenSSL on the runner. |

**Conclusion.** An Intel worker is **practical today, with a second pin set**. Use environment
markers (`; platform_machine == "x86_64" and sys_platform == "darwin"`) in a lock file, or a
separate constraints file for the Intel build. Every package then has a wheel, and nothing needs a
source build. On Apple Silicon, the current pins need macOS 15 (pikepdf 10.18) and at least macOS
14 (av, onnxruntime).

The direction is clearly against Intel:

- four libraries dropped it in 2026;
- Apple says macOS 26 is the last Intel release, with Rosetta 2 through macOS 27 [S25];
- CPython is discussing moving Intel macOS to tier 2 [S26].

Treat the Intel build as time-limited. When the next dependency drops Intel and an older pin is not
acceptable, the choice is to build from source on `macos-15-intel` or to stop Intel releases. That
needs an owner ruling then, not now.

### 4. PyInstaller on macOS

- PyInstaller ad-hoc signs everything by default. With `--codesign-identity` it signs every
  collected binary with that identity and turns on the hardened runtime (`--options=runtime`).
  `--osx-entitlements-file` sets entitlements [S27].
- **Universal2 is not realistic.** PyInstaller's `--target-arch universal2` needs fat binaries for
  every extension module and stops with `IncompatibleBinaryArchError` otherwise. "Lipo-merging"
  two single-architecture PyInstaller builds does not produce a working program [S27].
- Most of the worker's native wheels come as separate arm64 and x86_64 files, not universal2
  (numpy, av, ctranslate2, tokenizers, pillow, pikepdf). Four have no x86_64 file at all at their
  pins.
- **Two builds, one per architecture, each on its own runner, is the practical route.**

### 5. Native Node modules

- **better-sqlite3 12.11.1:** prebuilt `darwin-arm64` and `darwin-x64` archives exist for Node 22
  (ABI 127) and Node 24 (ABI 137). Checked by requesting
  `better-sqlite3-v12.11.1-node-v{127,137}-darwin-{arm64,x64}.tar.gz` from its GitHub release:
  HTTP 200 for each. The prebuild must match the Node version the service ships with (ADR 0013).
- **@napi-rs/keyring 2.1.2:** `@napi-rs/keyring-darwin-arm64` and `-darwin-x64` are published at
  2.1.2 (npm registry) [S28].
- **exiftool-vendored 39.0.1** uses `exiftool-vendored.pl` on every OS except Windows. That is the
  Perl ExifTool, run by the system Perl. Apple's position since macOS 10.15: "Scripting language
  runtimes such as Python, Ruby, and Perl are included in macOS for compatibility with legacy
  software. Future versions of macOS won't include scripting language runtimes by default… it's
  recommended that you bundle the runtime within the app" [S29]. `/usr/bin/perl` was still present
  in macOS 14 and 15 (5.34; third-party list, December 2024). Not verified for macOS 26 or 27.

### 6. GitHub's hosted Macs (question 7)

From GitHub's runner documentation and the runner-images README [S30][S31]:

- **Apple Silicon (M1, 3 cores, 7 GB):** `macos-15`, `macos-26`, `macos-latest` (= macOS 26).
- **Intel (4 cores, 14 GB):** `macos-15-intel`, `macos-26-intel`. Larger runners: `macos-15-large`,
  `macos-26-large`.
- `macos-14` was retired from GitHub Actions on 2 November 2026 [S31]. No end date is published
  for the Intel labels. macOS 26 runners "run natively on Apple Silicon (arm64) and also support
  Intel (x64)" [S32].
- **Billing:** standard macOS runners cost $0.062 per minute, against $0.006 for Linux 2-core
  (about 10×). Usage is charged against the account's included amount on private repositories.
  Standard runners are free on public repositories [S33][S34].

**Recommendation:** build Apple Silicon on `macos-15` and Intel on `macos-15-intel`, so each build
runs on the oldest macOS we support and pip cannot pick a wheel that needs a newer one. Run 37f
only by hand or on a version tag (as planned). Cost: about 10× Linux minutes on a private
repository. The Intel label may be withdrawn with little notice; `macos-26-intel` is the next step.

### 7. Minimum macOS version (question 8): **macOS 15 Sequoia**

- Tauri 2 supports macOS 10.13+ by default and is raised with
  `bundle > macOS > minimumSystemVersion` [S35]. Tauri is not the limit.
- WKWebView is the system WebKit, updated with Safari. On macOS 15 that is at least Safari 18.
  Whether Safari 26 is offered on macOS 15 was not verified. Safari 18-level WebKit is not a known
  constraint for our UI.
- The Python wheels set the floor:
  - pikepdf 10.18 (Apple Silicon) → 15.0;
  - pikepdf 10.13 (Intel) → 15.0;
  - av 18.1.0 and onnxruntime → 14.0;
  - pypdfium2 → 13.0.
- macOS 12 (the plan's starting point) is not possible with these pins. macOS 14 would be possible
  on Apple Silicon only by holding ocrmypdf at 17.12.1 and pikepdf at 10.13 there too, and Intel
  still needs 15.
- The newest macOS an Intel Mac can run is **macOS 26 Tahoe**, on the 16-inch MacBook Pro (2019),
  the 13-inch MacBook Pro (2020, four Thunderbolt 3 ports), the iMac (2020) and the Mac Pro (2019)
  [S36]. Apple says Tahoe is the last Intel release [S25].

**Recommend macOS 15.0** for both downloads. Set `minimumSystemVersion: "15.0"` and
`MACOSX_DEPLOYMENT_TARGET=15.0`.

**Who it leaves out:** Macs that cannot run Sequoia [S37]:

- every Intel MacBook Air before the 2020 Retina model (that is, 2018–2019);
- every Mac older than 2018 except the iMac Pro (2017);
- anyone who has chosen to stay on macOS 14 or older.

All Apple Silicon Macs can run 15.

### 8. One app or two downloads (question 9): **two downloads**

Ship "Apple Silicon" and "Intel" downloads for the first release. Reasons:

- a universal worker is not buildable (section 4);
- the Intel worker needs a different pin set;
- a universal app would make every Apple Silicon user download the Intel worker as well.

Costs:

- two CI jobs and two artefacts to sign and notarise;
- two sets of smoke tests;
- the download page must say clearly which is which.

The Intel app would also run on Apple Silicon under Rosetta, slowly and only until Rosetta is
removed (macOS 28 [S25]). At start-up the app should check `sysctl.proc_translated` and tell the
researcher to use the Apple Silicon download.

## Consequences

### Open questions and risks

1. **R1 — The Intel worker depends on four held-back packages** (onnxruntime 1.23.2, pikepdf
   10.13.0.post1, rawpy 0.25.1, cryptography 48.0.1). The next Intel drop (for example ctranslate2,
   av or numpy) could force source builds or end Intel support. *This is what could sink the Intel
   build.* Review the list at each dependency update.
2. **R2 — GitHub Intel runners.** No retirement date is published, but GitHub keeps only a few
   images, and `macos-14` already went. Losing `macos-*-intel` ends Intel builds unless we
   cross-compile, which PyInstaller does not support for these wheels.
3. **R3 — Gatekeeper on downloaded tools** (not verified). Whether files the worker downloads get
   the quarantine flag or a provenance check on macOS 15/26 has to be tested on the M3 before 37f.
   The unsigned (non-Developer ID) yt-dlp binary is the most exposed case.
4. **R4 — ffmpeg source.** Riedl's Intel release builds end January 2027 and depend on one person.
   Our own build must exist before the first public release. Its configuration (GPL, libx264) makes
   us a GPL distributor, so we must ship the source archives and build scripts with it.
5. **R5 — exiftool needs system Perl.** Apple has said scripting runtimes will go. Not verified for
   macOS 26/27. If `/usr/bin/perl` disappears, exiftool (required) breaks; the fallback is to
   bundle a Perl. Check `/usr/bin/perl -v` on the owner's Mac now.
6. **R6 — yt-dlp's JavaScript runtime.** Full YouTube support needs deno or node, which no task
   covers yet. The app ships Node for the library service, but a Node single-executable build
   cannot act as a general `node`. ADR 0013 / Task 48 must decide: offer deno in the dialogue, or
   ship node as a plain program.
7. **R7 — CTranslate2 on Apple Silicon.** The docs disagree about Metal in the wheels, and speed is
   not measured. If large-v3 on the CPU is too slow, the dialogue should steer researchers to
   `small` or `medium` on a Mac.
8. **Licences for the owner or a lawyer:**
   - the worker already contains GPL code: gallery-dl (GPL-2.0-only), and libx264/libx265 inside
     PyAV's FFmpeg, which reports itself as LGPLv3 while linking GPL encoders;
   - distributing the worker therefore brings GPL obligations (source offer, notices);
   - check that GPL-2.0-only gallery-dl and the GPLv3-or-later parts can be shipped together, and
     what "corresponding source" we must publish for our own ffmpeg build;
   - Ghostscript (AGPL) is avoided.
9. **Not verified from here:**
   - Gatekeeper behaviour (R3);
   - yt-dlp's signature type;
   - Perl on macOS 26/27;
   - the WebKit version on macOS 15;
   - Metal in the CTranslate2 wheel;
   - the leptonica and ExifTool licence texts;
   - the size of our own ffmpeg and tesseract builds;
   - the size of the packaged worker;
   - which entitlements the hardened worker needs.

   The GitHub REST API for other repositories was blocked in this session; release pages and
   documentation were reachable.

### What this means for the tasks

**Task 48 (first-use tools dialogue).** The catalogue has:

- **Speech models:** tiny 75 MB, small 464 MB, medium 1.46 GB, large-v3 2.95 GB.
  - Pin each by Hugging Face revision and `model.bin` SHA-256.
  - Download into `AO_MODELS_DIR` with progress.
  - On a Mac, do not default to large-v3 until R7 is measured.
- **Video downloader:** yt-dlp `yt-dlp_macos` (37.5 MB), as in ADR 0009, plus the JavaScript
  runtime (R6).
- **Video proxies:** ffmpeg + ffprobe.
  - Our release asset, per architecture, with URL and SHA-256 in the source.
  - Show the GPL notice and a link to the source.
- **OCR:** tesseract plus chosen `tessdata_fast` languages (English by default).
  - Install into the tools folder and set `TESSDATA_PREFIX`.
  - **No Ghostscript entry.** Change the worker's `MISSING_DEPENDENCY` message so it no longer
    names Ghostscript. Test that ocrmypdf 17 with pypdfium2 and no `gs` works on Linux CI: remove
    `ghostscript` from the apt line in one job.
- After each install, apply the Gatekeeper steps above (checksum → strip quarantine → signature
  check), and put the tools folder first on the worker's `PATH`.
- A local file server stands in for every host in tests, as planned.

**37d (worker packaging).**

- One-folder PyInstaller build per architecture. No universal2.
- Add a per-platform lock: the Intel pins from section 3, applied by environment markers.
- Smoke-test `import pikepdf, rawpy, onnxruntime, cryptography` in the packaged worker, not only
  the four acceptance checks.
- The worker folder must contain the licence texts of the GPL parts.

**37f (Mac build workflow).**

- Jobs on `macos-15` (arm64) and `macos-15-intel` (x86_64). Run by hand or on a tag.
- Set `MACOSX_DEPLOYMENT_TARGET=15.0` and Tauri `minimumSystemVersion: "15.0"`.
- Fail the build if any Mach-O file in the app has a minimum OS above 15.0. Read it from
  `LC_BUILD_VERSION`, with `vtool -show-build` or `otool -l`.
- Node: use the darwin prebuilds of better-sqlite3 and keyring for the shipped Node version.
- Add a separate "tools" workflow that builds, signs and publishes ffmpeg and tesseract (and their
  source archives) for both architectures. Run it rarely, by hand.
- Sidecar names follow Tauri's `-<target triple>` rule (`-aarch64-apple-darwin`,
  `-x86_64-apple-darwin`) [S38].
- Smoke test on each runner: start the app, both helpers answer, run one tiny-model transcription.

**37g (signing).**

- Sign from the inside out:
  1. every `.dylib` and `.so` in the worker folder;
  2. the worker executable, with Developer ID, hardened runtime and secure timestamp;
  3. the Node service;
  4. the app.
- Do not rely on `--deep`.
- Notarisation requires the hardened runtime and a secure timestamp on every program [S39].
- Entitlements: start with none for the worker. Add
  `com.apple.security.cs.allow-unsigned-executable-memory` only if a ctypes or cffi callback fails
  under the hardened runtime. Do not add `disable-library-validation` while every library is
  signed with our Team ID.
- Downloaded tools run as separate processes and are judged by their own signatures, not the
  worker's entitlements (not verified; covered by R3).
- Our own ffmpeg and tesseract are signed and notarised as zips in the tools workflow.
- Expect more than one attempt, as the plan already says.

### Established in Task 37f (2026-11-12; on Linux, before any Mac run)

- **The page's plain-http calls to 127.0.0.1 need an App Transport Security setting.** Apple's
  documentation of `NSAllowsLocalNetworking`: "In iOS 17, iPadOS 17, and macOS 14, ATS no longer
  allows connections to IP addresses by default"; the key enables "access to unqualified domains,
  .local domains, and IP addresses" [S40]. The app sets only that key (`src-tauri/Info.plist`,
  merged by tauri-cli on macOS); not `NSAllowsArbitraryLoads`. Not verified: whether WKWebView also
  treats a `fetch` from the `tauri://localhost` page to `http://127.0.0.1` as mixed content. WebKit
  landed "Allow WKWebView embedders to load mixed content from localhost" in April 2024 [S41], but a
  request to stop treating loopback addresses as mixed content in general is still open [S42]. The
  first Mac run's launch check (scenario A, the in-page probe) answers it; if it is blocked, the fix
  must not loosen the content-security policy or the capabilities (stop and rule).
- **The minimum-macOS check** reads `LC_BUILD_VERSION` (or `LC_VERSION_MIN_MACOSX`) from every Mach-O
  file in the app directly (`apps/desktop/scripts/build-macos.mjs`, tested on Linux), instead of
  `vtool`/`otool`. Node.js v22.23.4's `darwin-arm64` binary states 11.0.
- **Tauri's bundler** is tauri-cli 2.12.4 (published with tauri 2.12.5; it uses tauri-bundler 2.10.4
  and tauri-macos-sign 2.4.3, whose sources were read for this task). The disk image is made with
  `hdiutil create` directly, not with the bundler's `bundle_dmg.sh` (which drives Finder through
  AppleScript; it skips that step when `CI` is set).
- **Minutes.** Estimated, not measured: a cold run about 55–75 minutes on Apple Silicon and 65–90 on
  Intel; warm about 30–45 each; billed at 10× [S33].
- **tesseract** (R133) is still to be built in our CI: a separate, rarely run workflow per
  architecture building leptonica (and libpng, libjpeg-turbo, libtiff, zlib, libwebp/openjpeg as
  chosen) and tesseract 5.5.x from pinned, checksummed source archives with
  `MACOSX_DEPLOYMENT_TARGET=15.0`, relocatable (`@loader_path` install names), signed, and published
  with its source archives and licence texts; then a catalogue entry in the tools dialogue.

## Sources (all checked 2026-11-11 unless stated)

- [S1] https://ffmpeg.martin-riedl.de/ and its `/download/macos/{arm64,amd64}/…_9.0.2/` files
  (`ffmpeg.zip.sha256`; sizes from HTTP `Content-Length`)
- [S2] https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt
- [S3] https://evermeet.cx/ffmpeg/
- [S4] https://www.osxexperts.net/
- [S5] https://api.anaconda.org/package/conda-forge/ffmpeg (likewise `/tesseract` and `/ghostscript`)
- [S6] https://raw.githubusercontent.com/tesseract-ocr/tessdoc/main/Installation.md
- [S7] https://pypi.org/pypi/tesserocr/json, https://pypi.org/pypi/gallery-dl/1.32.19/json
- [S8] https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/ (and `tessdata_best`):
  `<lang>.traineddata` sizes
- [S9] https://ocrmypdf.readthedocs.io/en/latest/installation.html
- [S10] https://ocrmypdf.readthedocs.io/en/latest/releasenotes/version17.html
- [S11] https://ghostscript.com/licensing and https://artifex.com/licensing (the latter returned
  HTTP 500; Artifex's wording is quoted from search results, not verified on the page)
- [S12] https://ghostscript.com/releases/gsdnld.html
- [S13] https://github.com/yt-dlp/yt-dlp (README),
  https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS and `yt-dlp_macos`
  (fat header `cafebabe`, two slices)
- [S14] https://registry.npmjs.org/exiftool-vendored.pl/13.59.3
- [S15] https://huggingface.co/api/models/Systran/faster-whisper-{tiny,small,medium,large-v3}?blobs=true
- [S16] https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes
- [S17] https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web
- [S18] https://www.gnu.org/licenses/agpl-3.0.txt (section 5, "aggregate")
- [S19] https://developer.apple.com/documentation/vision/vnrecognizetextrequest,
  https://developer.apple.com/documentation/vision/recognizedocumentsrequest
- [S20] https://opennmt.net/CTranslate2/hardware_support.html
- [S21] https://opennmt.net/CTranslate2/installation.html
- [S22] https://pypi.org/pypi/onnxruntime/json (file lists); release-note wording via
  https://newreleases.io/project/pypi/onnxruntime/release/1.24.1 (mirror, not the GitHub page)
- [S23] https://pikepdf.readthedocs.io/en/latest/releasenotes/version10.html
- [S24] https://cryptography.io/en/latest/changelog/
- [S25] Apple WWDC25 Platforms State of the Union, as reported by
  https://www.tomshardware.com/software/macos/macos-tahoe-is-the-last-release-for-intel-macs-apple-silicon-exclusivity-will-mark-end-of-hackintoshes
  (Apple's own wording not verified)
- [S26] https://discuss.python.org/t/dropping-intel-mac-to-tier-2/102100 (discussion, not a decision)
- [S27] https://pyinstaller.org/en/stable/feature-notes.html
- [S28] https://registry.npmjs.org/@napi-rs/keyring-darwin-arm64/2.1.2 and `…-darwin-x64/2.1.2`
- [S29] https://developer.apple.com/documentation/macos-release-notes/macos-catalina-10_15-release-notes
- [S30] https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- [S31] https://github.com/actions/runner-images (README)
- [S32] https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/
- [S33] https://docs.github.com/en/billing/reference/actions-minute-multipliers
- [S34] https://docs.github.com/en/billing/concepts/product-billing/github-actions
- [S35] https://v2.tauri.app/distribute/macos-application-bundle/
- [S36] https://support.apple.com/en-us/122867 (macOS Tahoe 26 compatible computers)
- [S37] https://support.apple.com/en-us/120282 (macOS Sequoia compatible computers)
- [S38] https://v2.tauri.app/develop/sidecar/
- [S39] https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- PyPI file lists for every package in section 3: `https://pypi.org/pypi/<name>/<version>/json`
- PyAV build flags: read from `av/.dylibs/libavcodec.62.28.102.dylib` in
  `av-18.1.0-cp311-abi3-macosx_14_0_arm64.whl`
- better-sqlite3 prebuilds:
  `https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v{127,137}-darwin-{arm64,x64}.tar.gz`
  (HTTP 200)
- [S40] https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking (read 2026-11-12)
- [S41] https://bugs.webkit.org/show_bug.cgi?id=272461 (RESOLVED FIXED, 2024-04-18; read 2026-11-12)
- [S42] https://bugs.webkit.org/show_bug.cgi?id=171934 (status NEW; read 2026-11-12, via the page of S41)
