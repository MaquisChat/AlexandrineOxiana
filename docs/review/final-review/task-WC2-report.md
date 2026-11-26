# Task WC2 report (worker) — branch wc-2-worker

Status: DONE_WITH_CONCERNS. Commit: see `git log -1` on wc-2-worker (one commit, the plan's step 5).

## Built
- `ao_worker/download.py`: `QUALITY_FORMATS` gains `audio` ("ba/b") and `ready` ("b"); `QUALITY_EXTRA_ARGS` (`-x --audio-format m4a` for audio); `QUALITY_WITHOUT_FFMPEG = ("ready",)`; `ERROR_CODES` gains DISK_FULL, NETWORK_LOST; the two patterns sit before NOT_FOUND_OR_REMOVED; new `platform_reason(stderr)`; `build_ytdlp_args(..., ffmpeg=None)` adds `--ffmpeg-location` before `--`; `run` looks up `tools.which("ffmpeg")` once, raises `not_installed("ffmpeg")` before yt-dlp starts for best/1080p/720p/audio; failure JobError carries `platform_reason`; `validate_params` accepts the five values.
- `ao_worker/jobs.py`: `JobError(platform_reason=)`, sent as `platformReason` (omitted when empty).
- `ao_worker/toolpins.py`: ffmpeg `purpose` / `without` exactly as the plan.
## Tests (tests/test_download.py), all failed first (16 failures: missing quality values, missing function, missing key, codes)
test_ffmpeg_location_is_handed_to_ytdlp_when_found; test_audio_only_extracts_m4a; test_ready_made_selects_b; test_ffmpeg_argument_is_added_by_build_ytdlp_args (extra); test_better_qualities_need_ffmpeg (4 qualities); test_ready_made_runs_without_ffmpeg; test_map_error +4 cases (DISK_FULL, 3x NETWORK_LOST; PRIVATE case already there); test_platform_reason_is_the_platforms_words_without_links; test_failure_json_carries_platform_reason.
## Researcher-visible sentences
ffmpeg catalogue text exactly the plan's. Changed validation message (worker-internal): "params.quality must be best, 1080p, 720p, audio or ready (yt-dlp only)". The not-installed sentence is the existing one ("Video tools (ffmpeg) is not installed. Install it from the Optional tools screen.").
## Existing tests changed
test_ytdlp_quality_selects_a_format: now monkeypatches `tools.which` (as the plan said). test_tools.py unchanged (its assertions still hold).
## NEEDS A RULING
None. Observations: (1) platform_reason removes URLs entirely (the plan's example output has none); `strip_url` would leave the bare link. (2) NETWORK_LOST's "Unable to download" is placed before NOT_FOUND_OR_REMOVED as pinned, so yt-dlp's "Unable to download webpage: HTTP Error 404" now maps to NETWORK_LOST (429 is still RATE_LIMITED). Worth a look by Task 3/review. (3) Outside my Python-only scope, the old ffmpeg text is repeated in TS tests/fixtures (`packages/ui/src/test/msw-tools.ts`, `ToolsSetup.test.tsx`, `apps/library-service/src/tools-routes.test.ts`); they are not the catalogue's source, left alone.
## Runs
test_download.py: 39 passed. test_tools.py: 61 passed. git status clean.

## Fix (R670)
NETWORK_LOST pattern replaced by the ruled one (`urlopen error|timed out|Connection (reset|refused|aborted)|Network is unreachable|No route to host|Temporary failure in name resolution|Name or service not known|nodename nor servname|getaddrinfo failed|Remote end closed connection|IncompleteRead`, case-insensitive); `map_error` skips it for any text containing "HTTP Error". 8 cases added to test_map_error; at d25b6f6 two failed (the 404 -> NOT_FOUND_OR_REMOVED and the 403 -> EXTRACTOR_ERROR cases), the rest were guards. Runs: test_download.py all pass, test_tools.py 61 passed.
