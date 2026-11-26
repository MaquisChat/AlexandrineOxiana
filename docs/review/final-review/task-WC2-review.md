# Task WC2 review — worker (branch wc-2-worker, 04ec3bd..cbec715)

**Verdict: READY WITH FIXES.** The pinned contract is there exactly. The defects are in what the pinned rules leave open: how gallery-dl errors are named, what `platformReason` puts on a screen, and what every capture now saves once ffmpeg is handed over. Three of the findings need a coordinator ruling, not only an implementer fix.

## Important

**I1. A gallery-dl failure is named NETWORK_LOST whenever a retry warning before it mentions a timeout.** `download.py:126-135` (`map_error`). The function keeps only lines containing upper-case `ERROR`. gallery-dl writes `[instagram][error] …` in lower case, so every gallery-dl failure is matched against the WHOLE stderr, warnings included. Its urllib3 retry warnings ("…Read timed out…", "Connection reset…") are common even when the retry succeeded. They now hit the new NETWORK_LOST pattern before NOT_FOUND_OR_REMOVED. R670's guard does not apply either, because gallery-dl spells an HTTP answer `HttpError: '404 Not Found'`, not `HTTP Error`. I ran a probe on `[urllib3.connectionpool][warning] Retrying … Read timed out …` followed by `[instagram][error] HttpError: '404 Not Found' for '…'`: it gives `NETWORK_LOST`. Before this change it gave NOT_FOUND_OR_REMOVED. Instagram posts go through gallery-dl (`link-capture.ts:192`). In a profile run, two deleted posts in a row make the run wait on the slow-down schedule, which can last up to 12 hours (Task 3's rule). Smallest fix: in `map_error`, also keep lines that match `\]\[error\]`, and treat `HTTP ?Error` as an HTTP answer. Add both cases to `test_map_error`.

**I2. `platformReason` is mostly yt-dlp's and Python's words, not the platform's.** `download.py:138-155`. The code follows the pinned regex, so this is a plan-level gap. The design (line 96) promises "in plain words with the platform's own reason". A probe gives these reasons:
- the bot check: `Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See for how to manually pass cookies. Also see for tips…`
- an extractor failure: `Unable to extract initial player response; please report this issue on , filling out the appropriate issue template. Confirm you are on the latest version using yt-dlp -U`
- a lost connection (requests handler): `Unable to download webpage: HTTPSConnectionPool(host='www.youtube.com', port=443): Max retries exceeded with url: /watch?v=abc&bpctr=9999999999&has_verified=1 (Caused by NameResolutionError("<urllib3.`. This one carries a query string, because `_URL_RE` only removes text that starts with a scheme.
- the HTTP answers: `Unable to download webpage: HTTP Error 503: Service Unavailable`, and `Requested format is not available. Use --list-formats …`.

The result is also cut at 200 characters mid-word, with no ellipsis. The home folder is not redacted: a probe line with `/Users/someone/Library/Cookies` came back unchanged. Bidi and zero-width characters (U+202E, U+200B) survive. Smallest fix, which needs a ruling:
- give a reason only for PRIVATE, GEO_BLOCKED, NOT_FOUND_OR_REMOVED and LOGIN_REQUIRED;
- cut the text at the first ` Use --`, `; please report`, ` (caused by` or ` See `;
- return None when what is left contains `Errno`, `urlopen`, `ConnectionPool`, `HTTP Error` or `/` followed by `?`;
- run `redact()` before removing URLs, and also remove `​-‏‪-‮⁦-⁩`.

gallery-dl's error shape (`[x][error] …`) and errors without the `[extractor] id:` prefix give None. That is acceptable, but nothing documents it.

**I3. Every capture that asks for no quality (every single-link capture today) now saves the largest available file.** `download.py:384-386` and `run` (`:511`). The plan says to hand over ffmpeg "whatever the quality", and the code does that. With ffmpeg found and no `-f`, yt-dlp's default selector becomes `bv*+ba/b`, so it merges the best video and the best audio. Before, a YouTube link gave the ready-made format 18, a 360p H.264 MP4. Now it gives up to 2160p/4320p (several GB per hour), with no estimate, no disk floor and no `requestedQuality` recorded. The design and the plan set Up to 720p as the default only for runs, so single links are now inconsistent with them. Smallest fix, which needs a ruling: when `quality` is absent and ffmpeg is found, use the 720p selector, either in the worker or by having Tasks 3 and 5 send `DEFAULT_QUALITY` for single links.

**I4. The merged files are mostly WebM, sometimes MKV, and the app plays them in WKWebView (Tauri).** yt-dlp's default format sort prefers `av01 > vp9 > avc1` and opus over AAC. So "best", "1080p", "720p" and the no-quality default (I3) usually produce AV1 or VP9 with opus in `.webm`. Mixed codecs (vp9 with m4a) produce `.mkv`.

The library copes with both containers: `link-capture.ts:184` lists them, `io.ts` maps them to `video/webm` and `video/x-matroska`, and both are stored as kind `video`. Downloads get no viewing copy, though. `planProxies` makes copies only for located media. `MediaTicketPlayer` plays the original in WKWebView, where:
- MKV does not play;
- AV1 needs hardware decoding (M3 or later);
- VP9/opus WebM needs a recent macOS.

Before this branch, captures were H.264 MP4. A researcher on an M1 or M2 Mac may get videos that do not play in the app. Smallest fix, which needs a ruling: add `-S "vcodec:h264,acodec:m4a"`, or `--merge-output-format mp4` together with an H.264/AAC preference, to the three video selectors. YouTube offers H.264 up to 1080p, so "Best available" above that would stay VP9/AV1, and that should be said.

**I5. HTTP 5xx is named wrongly.** This mapping predates the branch, but runs make it worse. A probe of `HTTP Error 503: Service Unavailable` gives NOT_FOUND_OR_REMOVED, because the bare `unavailable` in that pattern matches it. 500 and 502 give EXTRACTOR_ERROR. During a YouTube 5xx burst, a channel run therefore fails each video as "removed", and per the design none of them is tried again by itself. YouTube's "Video unavailable. This content isn't available, try again later." (its session-level block) is also NOT_FOUND_OR_REMOVED. Smallest fix, which needs a ruling: a pattern placed before NOT_FOUND_OR_REMOVED that sends `HTTP Error 5\d\d` to EXTRACTOR_ERROR, or to RATE_LIMITED if the coordinator wants the run to wait.

## Minor

- M1. `map_error`'s HTTP guard (`:129-132`) is untested. Mutation 2 below survived: the new 404 and 403 cases never match the replacement NETWORK_LOST pattern, guard or no guard. Add a case that has both, for example `HTTP Error 504 … (caused by … timed out)`.
- M2. The refusal at `:512` also refuses metadata-only jobs that carry a quality: `link-capture.ts:483` with `refreshIfExists`, and `fetchMetadata` if a caller ever passes a quality. Skip the check when `metadataOnly` or `flatList` is set.
- M3. Real lost connections that are missed:
  - `ERROR: Did not get any data blocks` gives EXTRACTOR_ERROR.
  - `ERROR: fragment 1 not found, unable to continue` gives NOT_FOUND_OR_REMOVED.
  - With yt-dlp's default `--skip-unavailable-fragments`, a drop in the middle of an HLS/DASH download skips fragments and exits 0, so a truncated file is stored as complete. Consider `--abort-on-unavailable-fragments`.
- M4. If ffmpeg disappears after `which()` and before post-processing, the job fails with `ffprobe and ffmpeg not found`, which is named NOT_FOUND_OR_REMOVED. That calls the video "removed" instead of producing the paused-tool of Review Focus 3. This window is narrow.
- M5. "Audio only" re-encodes YouTube's opus to AAC. `ba[ext=m4a]/ba/b` would copy format 140 without re-encoding. `--write-thumbnail` still stores a picture (the thumbnail) with each audio file.
- M6. `link-capture.test.ts:485` (the real worker, `quality: "720p"`, `AO_TOOLS_DIR` empty) now passes only where `ffmpeg` is on PATH. CI and this container have it. A Mac without Homebrew ffmpeg will fail it as TOOL_NOT_INSTALLED. That file belongs to Task 3, which should put a fake `ffmpeg` in its `bin`.
- M7. The plan says platform_reason "strips URLs (strip_url)", but the code removes them entirely. Only removal satisfies the plan's own test example, so the plan is self-contradictory and the implementer's reading is right. The plan's text should be corrected.
- M8. No worker test pins the new catalogue sentences. Reverting them leaves `test_tools.py` passing, because it checks only "proxy pending" and "exports".
- M9. Catalogue wording, item 4 of the dispatch:
  - The Optional tools screen shows `t.purpose` and `t.without` from the worker's catalogue (`ToolsSetup.tsx:373-377`, through `GET /tools`), so the new sentences reach the researcher.
  - Three TypeScript copies stay old and now disagree with the card above them:
    - the group hint "Video conversion: Makes viewing copies of videos, including copies…" (`ToolsSetup.tsx:37`);
    - `MissingToolNotice.tsx:31`. It will be shown after a capture refused for want of ffmpeg, and it still speaks only of viewing copies, not of the download.
    - the "Work with recordings" hint (`FirstUseTools.tsx:69`).
  - `msw-tools.ts:120-121` is the fixture copy of the catalogue and is now stale.
  - No TypeScript test fails once this branch is joined. `ToolsSetup.test.tsx` asserts the fixture's own text, and the `/proxy pending/` check still holds because the new text keeps "proxy pending". `tools-routes.test.ts` uses its own fake catalogue.
  - Owners: Task 9, which already edits the Optional tools screen, for `ToolsSetup.tsx:37`, `msw-tools.ts` and the FirstUseTools hint. Task 8, the Capture screen's refusal, for the ffmpeg sentence in `MissingToolNotice`.

## Contract check
Compared with the plan's Task 2 text, character for character:
- `QUALITY_FORMATS` audio `ba/b` with `-x --audio-format m4a`, and ready `b`;
- `build_ytdlp_args(url, out, params, js_runtime=None, ffmpeg=None)`;
- `--ffmpeg-location` placed before `--`;
- `platform_reason(stderr) -> str | None` with the pinned regex and the 200-character limit;
- the DISK_FULL pattern, and the NETWORK_LOST pattern exactly as R670 gives it, both before NOT_FOUND_OR_REMOVED;
- the `HTTP Error` guard;
- `TOOL_NOT_INSTALLED` with tool `ffmpeg` for best, 1080p, 720p and audio, raised before yt-dlp starts;
- the failure JSON `platformReason`, omitted when empty;
- the ffmpeg purpose and without sentences, which are identical.

The only difference is M7. The existing changed test (`test_ytdlp_quality_selects_a_format`) is named in the report and its reason holds. No test was loosened, skipped or deleted.

## Mutations (tests/test_download.py, each file restored)
1. Removing the ffmpeg refusal in `run`: 4 tests failed (`test_better_qualities_need_ffmpeg` ×4).
2. Removing the `HTTP Error` guard in `map_error`: **all 47 passed** (M1).
3. Never adding `--ffmpeg-location`: 2 tests failed.

Runs: test_download.py 47 passed, test_tools.py 61 passed, test_api.py 30 passed. `git status --short` is empty.

## What I could not check
- Real yt-dlp and gallery-dl stderr on a live network. The lines above come from knowledge of their source, not from runs. That covers:
  - ffmpeg's last line on a full disk during a merge (probably "Conversion failed!" or "…Error writing trailer…", which would not be named DISK_FULL; Task 4's floor check would still catch it);
  - whether YouTube still offers a combined format for `-f b` (if it does not: "Requested format is not available", EXTRACTOR_ERROR);
  - JS-solver timeouts that might contain "timed out".
- WKWebView playback of AV1, VP9 and MKV on M1/M2 compared with M3, and on the macOS versions the app supports (I4).
- Disk use and time for "best" with no quality on real channels (I3).
