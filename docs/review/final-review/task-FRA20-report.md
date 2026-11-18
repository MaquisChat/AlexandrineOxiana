# FR-A20 report
Branch fr-a20-photo-comment; commits e825a58 (image fix + tests), 47200c7 (numpy pin).

## Change
- services/media-worker/ao_worker/image_proxy.py (in run, before img.save): `img.info.clear()` with comment. Only build_exif's EXIF and icc_profile (R379) reach the proxy.
- services/media-worker/pyproject.toml line 23: numpy==2.5.5 (installed version). Remaining ranges: `setuptools>=69` (build backend, stays) and `requires-python = ">=3.12"` (not a dependency). No other dependency is a range.

## Pillow JPEG _save: im.info keys read
Only `comment` (im.info.get("comment")) is read from im.info as a fallback to encoderinfo. Everything else (dpi, quality, xmp, icc_profile, exif, extra, progressive, ...) is read from encoderinfo only (explicit args); dpi/exif have load-time fallbacks at lines ~522-547 (info["dpi"] when "exif" in info) but not in _save. info.clear() covers all anyway (xmp, photoshop, jfif, adobe, mp, GIF comment/extension, PNG text).

## Tests (test_image_proxy.py, appended)
- test_jpeg_comment_is_never_copied[strip|coarsen|keep]: FAILED before, pass after (bytes lack Jane/Elm Street/Roe, comment empty, device+capture time kept, coarse GPS kept under coarsen, none under strip).
- test_icc_profile_survives_next_to_a_comment: failed before (comment), passes after.
- test_dpi_and_jfif_extras_do_not_break_the_proxy: failed before (comment), passes after; size 120x80 ok.
- test_gif_comment_is_never_copied, test_png_text_chunk_is_never_copied: passed before the fix too (convert to RGB already drops GIF info, PNG text is not read by the JPEG writer); kept as guards.
- existing test_icc_profile_is_kept unchanged, passes.

## Video proxy (ao_worker/video_proxy.py, metadata_args, argv in run)
strip/coarsen: `-map_metadata -1 -map_metadata:s -1 -map_chapters -1` then only PERMITTED_TAGS (creation time, make, model) via -metadata, so title/comment/description/artist are dropped. keep: `-map_metadata 0` copies all container metadata including free text, by design ("keep copies container metadata"; location kept). Not a one-flag defect in strip/coarsen; changing keep is a policy decision. Changed nothing.

## Runs
- test_image_proxy.py: 17 passed, 1 skipped (DNG not downloaded)
- pnpm test:py: 195 passed, 4 skipped (DNG and 3 librispeech fixtures not downloaded)
- git status --short: empty
