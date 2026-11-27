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

---

## Second look (R671) — cbec715..4ecfc44

**Verdict: CHANGES NEEDED.** Points A1–A3, B1–B5, C1–C5 and D1 are built as pinned and are tested. The three test files pass (test_download 89, test_tools 62, test_api 30). One finding I missed in the first round decides the verdict: the new failure codes do not come back as failures in the order real yt-dlp works.

### Important (new)
**N1. A connection lost, a disk filled or ffmpeg gone in the middle of a download comes back as a "done" job, not as a failure.** `download.py:602-608` (`run`). A job counts as partial whenever `files` is non-empty. Real yt-dlp writes the info JSON, the captions (`--write-subs --write-auto-subs`) and the thumbnail (`--write-thumbnail`) BEFORE it downloads the picture and sound. After a failure during the download itself, the folder therefore holds a `.webp` and some `.vtt` files.

I ran a probe with a fake yt-dlp that writes the info JSON, a `.vtt`, a `.webp` and a `.part`, then fails with `ERROR: [Errno 54] Connection reset by peer. Giving up after 3 retries`. The result is `status done, partial True, errorCode NETWORK_LOST`, with no error. The library then stores an incomplete source holding only the thumbnail and captions (`link-capture.ts:565`, `:628`). In that case:
- Task 3's rules never see a failure. The second lost connection in a row does not wait (Review Focus 1). DISK_FULL does not pause (Review Focus 2). A vanished ffmpeg (B5) is not a missing tool, because the real yt-dlp leaves the unmerged `.fNNN` streams.
- A later retry of that video finds a duplicate, so the video is never downloaded.
- The design's "nothing half-downloaded is kept" is broken.

The new tests miss this because `FAKE_YTDLP_STDERR` fails before writing anything.

Smallest fix, in the worker, for a yt-dlp download (not `flatList` or `metadataOnly`):
- raise the JobError for NETWORK_LOST, DISK_FULL and TOOL_NOT_INSTALLED whatever was written;
- otherwise, count a job as partial only when a video or audio file other than a `.fNNN` stream was written.

Tests: a fake that writes a thumbnail and captions, then fails with each of those codes, gives `failed`. The existing `ratelimit-partial` test (an mp4 written, then 429) stays partial.

### The pinned yt-dlp arguments (point 2)
- `-S res:N`: `res` is the smaller side, and a limit prefers the largest value up to N, else the smallest above it. So an upright video is not thrown out and the sort never fails. User fields come before the defaults (only `hasvid` and `ie_pref` are forced ahead), so the size is never lowered for the codec's sake.
- `vcodec:h264` matches `[hx]264|avc` and puts H.264 first, with other codecs as fallback. `acodec:m4a` matches `mp?4a?`. avc1 with mp4a is joined into MP4 (`get_compatible_ext`). All of these flags exist in every yt-dlp recent enough for `--js-runtimes`, which the app already requires. `--abort-on-unavailable-fragments` is long-standing and not deprecated.
- `-f "bv*+ba/b"` cannot give "Requested format is not available" on YouTube. On a site with only video-only formats and no separate audio it still can, and so can `-f b` ("ready").
- With `ba[ext=m4a]` and `-x --audio-format m4a`, yt-dlp copies the AAC without re-encoding. That is right.
- **What I would add:** `--merge-output-format mp4` on the three video qualities and on the no-quality default. Above 1080p YouTube has no H.264. There, `acodec:m4a` combined with a VP9 picture (the codec ordered next after H.264 among the codecs above the limit) gives VP9 with AAC. That pair is incompatible with both MP4 and WebM, so yt-dlp writes **`.mkv`**, which WKWebView does not play at all. With `--merge-output-format mp4` the file is always `.mp4`. VP9 or AV1 inside MP4 still needs a Mac that can decode them; only a real Mac shows whether it plays. It costs nothing when the pair is already H.264/AAC.
- Smaller points:
  - `fps` before `vcodec` lets a 60 fps VP9 beat a 30 fps H.264 at the same size. YouTube usually has H.264 at 60 fps up to 1080p.
  - Audio that a site labels `aac` ranks above `mp4a` in yt-dlp's order, so it counts as "over the limit" and is ranked lower. This is rare.

### Guard and order (point 3)
- Removing the `HTTP ?Error` guard now fails 2 tests, so it is pinned.
- Removing the 5xx alternative from RATE_LIMITED fails 3 tests.
- Every case in the brief is named as the brief says (all 11 pass). The order (TOOL_NOT_INSTALLED, PRIVATE, GEO_BLOCKED, RATE_LIMITED, LOGIN_REQUIRED, DISK_FULL, NETWORK_LOST, NOT_FOUND_OR_REMOVED) is right for them. The 504 with "timed out" is RATE_LIMITED before the guard matters, so the implementer's added 404 case is the right pin.

### Mutations (each restored)
- **A2.** Removing the 720p default when ffmpeg is found and no quality is given: 1 test failed.
- **B1.** Removing the `][error]` line pick-up: **all 89 passed.** The brief's gallery-dl case is rescued by B2's `HttpError` guard. A gallery-dl failure without an HTTP answer is not pinned. A probe shows it: a retry warning with "Read timed out", followed by `[instagram][error] NotFoundError: Requested user could not be found`, gives NETWORK_LOST without B1 and EXTRACTOR_ERROR with it. Minor: add that case. gallery-dl's "could not be found" is not NOT_FOUND_OR_REMOVED either; that gap predates this round.
- **C4.** Removing the refusals: 5 tests failed.

### platform_reason (point 4)
The four codes still give their sentence. Probes:
- PRIVATE gives "This video is private…".
- GEO_BLOCKED gives "The uploader has not made this video available in your country".
- LOGIN_REQUIRED gives "Sign in to confirm your age. This video may be inappropriate for some users.", cut before " Use --".
- NOT_FOUND_OR_REMOVED gives "Video unavailable. This video is no longer available due to a copyright claim by …".
- HTTP 404 and ConnectionPool texts give None. EXTRACTOR_ERROR and RATE_LIMITED give none.

What still gets through (all Minor):
- **A home path.** `redact()` runs before the path refusal, so `<home>/Library/Cookies/x` becomes `~/Library/Cookies/x` and passes. `test_platform_reason_hides_the_home_folder` accepts this. Fix: refuse `~/` too.
- **A query with no `/` before it**, for example `token=s3cr3t&sig=AAA watch?v=1`. This shape is synthetic. Fix: refuse any `?` followed by `=`.
- **Invisible characters** U+061C (a direction mark), U+2060 and U+00AD survive. Fix: add them to `_CONTROL_RE`.
- **Program words in lower case.** "use --cookies …" passes because the cut is ` Use --` only. Fix: cut at any ` --` followed by a letter.

### Contract and tests (point 5)
- The wire is unchanged: the quality values, `platformReason`, the codes, and the refusal before yt-dlp starts for a download.
- `ERROR_CODES` gained `TOOL_NOT_INSTALLED`. The constant is internal; nothing outside `download.py` reads it.
- Three existing tests changed, each named, each for a pinned new value: the format strings (×2) and the ellipsis.
- A2 says "byte for byte what the worker sent before", and A3 adds `--abort-on-unavailable-fragments`. The implementer followed A3 and the test says so. That is right.
- No test was loosened, except the weak home-folder assertion above.
- The fake yt-dlp gained only `FAKE_YTDLP_STDERR`.
- `git status --short` is empty.

### What I could not check
- Real yt-dlp file order and output on a live network. N1 rests on yt-dlp's known order: info JSON, captions and thumbnail, then the download.
- MKV, VP9-in-MP4 and AV1-in-MP4 playback in WKWebView on M1/M2 compared with M3.

---

## Third look (R673) — 4ecfc44..c4b43b8

**Verdict: CHANGES NEEDED, one small mend.**
- B, C and D are as ruled.
- A fixes the shape of N1. But `_is_finished_media` still counts two kinds of leftover as a finished recording: yt-dlp's half-written merge output, and unjoined streams whose format id is not a number.

Runs: test_download 103 passed, test_tools 62 passed, test_api 30 passed. `git status --short` is empty.

### Important
**T1. `abc.temp.mp4` and `abc.fhls-720p.mp4` are counted as finished media.** `download.py:545-552`.

yt-dlp's merger, and its fixups, write to `prepend_extension(name, "temp")`, which gives `<id>.temp.mp4`. On an ffmpeg failure that file is left half-written. `_list_outputs` skips only names ENDING in `.temp`, and `_is_finished_media` accepts any media suffix. `_UNJOINED_RE` (`\.f\d+(-\d+)?\.`) catches only numeric ids. These all pass as finished media:
- `.f251-drc.webm` (YouTube's DRC audio);
- `.fhls-1080p.mp4` and `.fdash-…` (Vimeo, X and many generic sites);
- `.temp.mp4` and `.temp.m4a`.

I ran two probes through the worker. Both failed with `ERROR: Postprocessing: Conversion failed!`, which is EXTRACTOR_ERROR. That error is what ffmpeg most likely leaves when the disk fills during the merge (Review Focus 2).
- Files `.webp`, `.vtt`, `.f136.mp4`, `.f140.m4a`, `.temp.mp4` gave `done, partial, EXTRACTOR_ERROR`. The half-written `.temp.mp4` and both streams were listed as files.
- Files `.webp`, `.fhls-720p.mp4`, `.fdash-audio.m4a` gave the same.

The library then stores those files as an incomplete source.

Smallest fix:
- in `_is_finished_media`, refuse names containing `.temp.` or `.part`;
- make the stream pattern `\.f[^.]+\.[^.]+$`. The output template is `%(id)s.%(ext)s`, so only a stream has a second dotted segment that starts with `f`.
- add tests for `.temp.mp4`, `.f251-drc.webm` and `.fhls-720p.mp4`.

`.part`, `.part-FragN` and `.ytdl` are already never listed. yt-dlp's fragments are `.part-FragN`, not `.frag`.

### The other questions about A
- **Finished audio file plus a failed thumbnail.** No thumbnail conversion or embedding is asked for, so a failed thumbnail is only a warning, and a finished `.m4a` with a later failure is partial, which is right. I could not confirm whether ffmpeg's `-x` writes straight to `<id>.m4a`; if it does, a cut-off extraction would look finished. Only a real run shows it.
- **Multi-video jobs.** No caller sends one to yt-dlp today. Link capture canonicalises a YouTube video to `watch?v=<id>`. Channels and playlists go to profile capture, which enumerates and then sends one job per entry. gallery-dl jobs (Instagram posts and carousels) keep the old rule. Only an "unknown"-kind link on another site could hold several videos. There, "always fail" on a lost connection drops a video that had finished, but stores nothing half-done, so a retry downloads it again. That is acceptable.
- **What did not change.** The rate-limit partial (an mp4 written, then 429) is still kept. `flatList`, `metadataOnly` and gallery-dl keep `files or (enumeration and infos)`. Removing the always-fail rule fails 7 tests.

### B
`--merge-output-format mp4` is present for best, 1080p, 720p, and for the default when ffmpeg is found. It is absent for audio, ready, the default without ffmpeg, and metadata-only. All six cases were checked by a probe.

### C
- `~/…` gives None. A bare `?a=1` gives None. U+061C, U+2060 and U+00AD are removed. `USE --cookies` is cut.
- A platform dash (`private -- ask the owner`, with a space after the hyphens) is kept whole, because the cut needs a letter straight after `--`.
- Minor: the extra cut word can bite. `private --ask the owner` becomes "This video is". `Use the --cookies option` leaves a stray "Use". Both are contrived.
- Minor: a sentence with `?` and then `=` gives None. That is conservative.
- The four codes still give their sentences (Private, bot check, age, country).

### D
Removing the `][error]` pick-up now fails 1 test, so it is pinned.

### Other changes
The only test whose assertion changed is the home-folder test, and it is stronger now (it requires None). The fake yt-dlp gained only `FAKE_YTDLP_WRITE`. The wire is unchanged.

### What I could not check
- Whether real yt-dlp leaves `.temp.mp4` behind after a failed merge. Its code does not remove it.
- ffmpeg's exact last line on a full disk.
- How `-x` writes its output.
