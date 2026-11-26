# Task 2 (worker) — fix round after the review (Ruling R671)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-2`, branch `wc-2-worker`, head cbec715. The review: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC2-review.md` — read it in full first; the finding numbers below are its numbers. Tests first for every point (each new test must fail before its mend, unless it is a guard and you say so). One commit per group A–E below, same two trailers as before. Python only. Where this brief pins a value, it replaces the plan's.

## A. What is asked of yt-dlp (I3, I4, M3, M5, M2)

A1. **The format arguments, per quality** (replace `QUALITY_FORMATS` / `QUALITY_EXTRA_ARGS` as needed; keep the names if you can):

| quality | arguments |
|---|---|
| `best` | `-f "bv*+ba/b" -S "res,fps,vcodec:h264,acodec:m4a"` |
| `1080p` | `-f "bv*+ba/b" -S "res:1080,fps,vcodec:h264,acodec:m4a"` |
| `720p` | `-f "bv*+ba/b" -S "res:720,fps,vcodec:h264,acodec:m4a"` |
| `audio` | `-f "ba[ext=m4a]/ba/b" -x --audio-format m4a` |
| `ready` | `-f "b"` |

Why: `-S res:N` takes the best picture whose SMALLER side is at most N (so an upright 1080×1920 video is not thrown out by a height filter) and never fails for lack of a match; `vcodec:h264,acodec:m4a` after the size prefers the H.264/AAC pair, which yt-dlp joins into an MP4 that plays in the app on every Mac, and falls back to whatever exists at that size. The size always comes first: the codec never lowers the size.

A2. **No quality given** (every single pasted link today): when ffmpeg is found, use exactly the `720p` arguments; when ffmpeg is not found, pass no `-f`, no `-S` and no `--ffmpeg-location` — byte for byte what the worker sent before this branch. A job with `metadataOnly` or `flatList` gets no format arguments at all and is never refused for want of ffmpeg, whatever its quality (M2).

A3. Add `--abort-on-unavailable-fragments` to every yt-dlp download (not to `flatList` / `metadataOnly`): a video whose pieces could not all be fetched must fail, never be stored cut short (M3).

Tests: one per row of A1 (the exact argument list); A2's three cases (ffmpeg found and no quality → the 720p arguments; no ffmpeg and no quality → the argument list equals the pre-branch one — assert the absence of `-f`, `-S`, `--ffmpeg-location`; `metadataOnly` with quality `720p` and no ffmpeg → runs, not refused); A3 present for a download, absent for a flat list.

## B. Naming a failure (I1, I5, M1, M3, M4)

B1. `map_error` looks at the lines that contain `ERROR` (as now) OR match `\]\[error\]` (gallery-dl writes `[instagram][error] …`); only when there is no such line does it look at the whole text.
B2. "An HTTP answer is never a lost connection": the guard matches `HTTP ?Error` case-insensitively (so gallery-dl's `HttpError` too).
B3. `RATE_LIMITED` also matches `HTTP ?Error:? '?5\d\d` (a server that answers 500–599 is asking to be tried later: the run waits and tries the same video again, which is right) and `content isn'?t available, try again later`.
B4. `NETWORK_LOST` also matches `Did not get any data blocks` and `fragment \d+ not found`.
B5. A failure whose text says `ffprobe and ffmpeg not found` or `ffmpeg not found` is `TOOL_NOT_INSTALLED` with tool `ffmpeg` (the tool went away mid-job), not "removed".

Tests (in `test_map_error` or beside it), each asserting the code:
- `[urllib3.connectionpool][warning] Retrying (Retry(total=3…)) after connection broken by 'ReadTimeoutError("…Read timed out. (read timeout=30)")'` + newline + `[instagram][error] HttpError: '404 Not Found' for 'https://www.instagram.com/p/abc/'` → NOT_FOUND_OR_REMOVED (fails before B1/B2)
- `[instagram][error] HttpError: '429 Too Many Requests' for '…'` → RATE_LIMITED
- `ERROR: [youtube] abc: Unable to download webpage: HTTP Error 504: Gateway Time-out (caused by <HTTPError 504: Gateway Time-out>); the read operation timed out` → RATE_LIMITED, and it must FAIL when the HTTP guard is removed or B3 is missing (this is M1's missing test: check by breaking the guard locally, then restore)
- `ERROR: [youtube] abc: Unable to download webpage: HTTP Error 503: Service Unavailable` → RATE_LIMITED (was NOT_FOUND_OR_REMOVED)
- `ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later.` → RATE_LIMITED
- `ERROR: [youtube] abc: Video unavailable` → NOT_FOUND_OR_REMOVED (still)
- `ERROR: Did not get any data blocks` → NETWORK_LOST; `ERROR: fragment 3 not found, unable to continue` → NETWORK_LOST
- a job whose yt-dlp stderr ends `ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location` fails `TOOL_NOT_INSTALLED` with `tool == "ffmpeg"`

## C. The platform's own words (I2, M7)

`platform_reason` gives words to a researcher's screen, so it must give only the platform's own sentence, or nothing:
C1. It is given ONLY when the failure's code is PRIVATE, GEO_BLOCKED, NOT_FOUND_OR_REMOVED or LOGIN_REQUIRED; for every other code the failure JSON has no `platformReason`.
C2. Run the worker's existing `redact()` over the text first; then remove links entirely (as now); remove control characters and the invisible direction and zero-width characters U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF.
C3. Cut at the first of: ` Use --`, `; please report`, ` (caused by`, ` See ` — everything from there on goes.
C4. Return None when what is left is empty or contains any of `Errno`, `urlopen`, `ConnectionPool`, `HTTP Error`, `Traceback`, or a `/` followed later by `?` (a path with a query), or a path that starts with `/Users/`, `/home/`, `/var/`, `/tmp/` or a drive letter.
C5. At most 200 characters: when longer, cut at the last space before 200 and end with `…`.

Tests: `ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See https://… for how to manually pass cookies` → `Sign in to confirm you’re not a bot.`; `ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video` → that sentence unchanged; `…Unable to extract initial player response; please report this issue on https://…` → no `platformReason` (code EXTRACTOR_ERROR: C1); a NOT_FOUND text carrying `HTTPSConnectionPool(host='www.youtube.com', port=443): Max retries exceeded with url: /watch?v=abc&bpctr=1` → None; a text with `/Users/someone/Library/Cookies` → None; a text with U+202E inside → the character is gone; a 400-character reason → at most 200, ends with `…`, does not end mid-word; the failure JSON of a NETWORK_LOST job has no `platformReason` key.

## D. Small points
D1. (M8) A test pins the ffmpeg catalogue's `purpose` and `without` sentences exactly (the two sentences of the plan's Task 2).
D2. Your earlier validation message stays.

## E. Nothing else changes
The wire stays as the plan pins it (quality values, `platformReason`, the codes, `TOOL_NOT_INSTALLED` with tool `ffmpeg` before yt-dlp starts for best / 1080p / 720p / audio when ffmpeg is missing and the job downloads).

## Runs and report
`nice -n 10 node scripts/run-pytest.mjs tests/test_download.py`, `tests/test_tools.py`, `tests/test_api.py`; `git status --short` empty. Append "Fix round (R671)" to `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC2-report.md`: per point what changed (file:line), its tests and whether each failed first, anything you could not do as written and why. Final message at most 120 words: status, head commit, the counts, anything uncertain. If a pinned yt-dlp argument looks wrong to you from your own knowledge of yt-dlp, build it as pinned and say so under "uncertain" with your reason.
