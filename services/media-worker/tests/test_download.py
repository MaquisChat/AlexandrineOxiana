import json
import os
from pathlib import Path

import pytest

from ao_worker import download
from ao_worker.download import build_ytdlp_args, map_error, strip_url

URL = "https://www.youtube.com/watch?v=abc123"


def test_capture_download_with_fake_ytdlp_lists_files(worker, tmp_path, monkeypatch):
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    out = tmp_path / "capture"
    job = worker.run("capture.download", URL, str(out), {"tool": "yt-dlp", "maxItems": 5, "dateAfter": "20260101"})
    assert job["status"] == "done", job
    meta = job["result"]["meta"]
    assert job["result"]["output"] == str(out)
    assert meta["tool"] == "yt-dlp" and meta["toolVersion"] == "2026.10.22" and meta["partial"] is False
    assert sorted(Path(f).name for f in meta["infoJson"]) == ["abc123.info.json"]
    assert sorted(Path(f).name for f in meta["files"]) == ["abc123.en.vtt", "abc123.mp4", "abc123.webp"]
    assert all(Path(f).parent == out for f in meta["files"])
    assert job["progress"] == 1
    args = json.loads(argv_file.read_text())
    for flag in ("--write-info-json", "--write-subs", "--write-auto-subs", "--write-thumbnail", "--no-overwrites"):
        assert flag in args
    assert args[args.index("--sub-langs") + 1] == "all"
    assert args[args.index("--sleep-requests") + 1] == "2"
    assert args[args.index("--playlist-end") + 1] == "5"
    assert args[args.index("--dateafter") + 1] == "20260101"
    assert args[-1] == URL


def test_login_required_is_mapped(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "login")
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "LOGIN_REQUIRED"
    assert "Sign in to confirm" in job["error"]["detail"]


def test_partial_capture_is_kept_and_labeled(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "ratelimit-partial")
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "done"
    meta = job["result"]["meta"]
    assert meta["partial"] is True
    assert meta["errorCode"] == "RATE_LIMITED"
    assert [Path(f).name for f in meta["files"]] == ["abc123.mp4"]


def test_gallery_dl_via_env_binary(worker, tmp_path, monkeypatch):
    from conftest import FAKE_BIN

    monkeypatch.setenv("AO_GALLERYDL_BIN", str(FAKE_BIN / "gallery-dl"))
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    archive = tmp_path / "archive.sqlite3"
    job = worker.run("capture.download", "https://www.instagram.com/someone/", str(tmp_path / "g"),
                     {"tool": "gallery-dl", "archiveFile": str(archive)})
    assert job["status"] == "done", job
    meta = job["result"]["meta"]
    assert meta["toolVersion"] == "1.32.19"
    assert [Path(f).name for f in meta["files"]] == ["post_1.jpg"]
    assert [Path(f).name for f in meta["infoJson"]] == ["post_1.jpg.json"]
    args = json.loads(argv_file.read_text())
    assert "--config-ignore" in args  # never the user's own gallery-dl config
    assert "--write-metadata" in args
    assert args[args.index("--sleep") + 1] == "3-8"
    assert args[args.index("--download-archive") + 1] == str(archive)


def test_build_ytdlp_args_params():
    args = build_ytdlp_args("https://x.test/p", "/out", {
        "cookiesFromBrowser": "firefox", "archiveFile": "/a.txt", "flatList": True, "dateBefore": "20261231", "metadataOnly": True,
    })
    assert args[args.index("--cookies-from-browser") + 1] == "firefox"
    assert args[args.index("--download-archive") + 1] == "/a.txt"
    assert "--flat-playlist" in args and "--skip-download" in args
    assert args[args.index("--datebefore") + 1] == "20261231"
    assert args[args.index("--retries") + 1] == "3"
    assert args[args.index("--sleep-interval") + 1] == "3" and args[args.index("--max-sleep-interval") + 1] == "8"


def test_ytdlp_quality_selects_a_format(monkeypatch):
    from ao_worker import tools
    from ao_worker.download import validate_params
    # The four better choices need ffmpeg, so the job's lookup finds a fake one here.
    monkeypatch.setattr(tools, "which", lambda program: "/fake/ffmpeg")
    assert "-f" not in build_ytdlp_args("https://x.test/p", "/out", {})
    best = build_ytdlp_args("https://x.test/p", "/out", {"quality": "best"})
    assert best[best.index("-f") + 1] == "bv*+ba/b"
    hd = build_ytdlp_args("https://x.test/p", "/out", {"quality": "720p"})
    assert hd[hd.index("-f") + 1] == "bv*[height<=720]+ba/b[height<=720]/b"
    assert hd.index("-f") < hd.index("--")
    assert validate_params("https://x.test/p", {"quality": "1080p"}) is None
    assert validate_params("https://x.test/p", {"quality": "4k"}) is not None
    assert validate_params("https://x.test/p", {"quality": "720p", "tool": "gallery-dl"}) is not None


@pytest.mark.parametrize("stderr,code", [
    ("ERROR: [youtube] x: Sign in to confirm you're not a bot", "LOGIN_REQUIRED"),
    ("ERROR: [instagram] x: login required to access this", "LOGIN_REQUIRED"),
    ("ERROR: unable to download webpage: HTTP Error 429: Too Many Requests", "RATE_LIMITED"),
    ("ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader", "NOT_FOUND_OR_REMOVED"),
    ("ERROR: HTTP Error 404: Not Found", "NOT_FOUND_OR_REMOVED"),
    ("ERROR: [youtube] x: The uploader has not made this video available in your country", "GEO_BLOCKED"),
    ("ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", "PRIVATE"),
    ("ERROR: [tiktok] x: Unable to extract universal data for rehydration", "EXTRACTOR_ERROR"),
    ("ERROR: unable to write data: [Errno 28] No space left on device", "DISK_FULL"),
    ("ERROR: [youtube] x: Unable to download webpage: <urlopen error timed out>", "NETWORK_LOST"),
    ("ERROR: [youtube] x: Read timed out.", "NETWORK_LOST"),
    ("ERROR: unable to download video data: Connection reset by peer", "NETWORK_LOST"),
    ("ERROR: [youtube] x: Temporary failure in name resolution", "NETWORK_LOST"),
    ("ERROR: [youtube] abc: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)", "NOT_FOUND_OR_REMOVED"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "EXTRACTOR_ERROR"),
    ("ERROR: [youtube] abc: Unable to download webpage: HTTP Error 429: Too Many Requests", "RATE_LIMITED"),
    ("ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution> (caused by URLError(...))", "NETWORK_LOST"),
    ("ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>", "NETWORK_LOST"),
    ("ERROR: unable to download video data: [Errno 104] Connection reset by peer", "NETWORK_LOST"),
    ("ERROR: [youtube] abc: Unable to download webpage: The read operation timed out", "NETWORK_LOST"),
    ("ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "NOT_FOUND_OR_REMOVED"),
])
def test_map_error(stderr, code):
    assert map_error(stderr) == code


def test_ffmpeg_location_is_handed_to_ytdlp_when_found(worker, tmp_path, monkeypatch):
    from ao_worker import tools
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    monkeypatch.setattr(tools, "which", lambda program: "/fake/bin/ffmpeg")
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "done", job
    args = json.loads(argv_file.read_text())
    assert args[args.index("--ffmpeg-location") + 1] == "/fake/bin/ffmpeg"
    assert args.index("--ffmpeg-location") < args.index("--")
    monkeypatch.setattr(tools, "which", lambda program: None)
    job = worker.run("capture.download", URL, str(tmp_path / "d"), {"tool": "yt-dlp"})
    assert job["status"] == "done", job
    assert "--ffmpeg-location" not in json.loads(argv_file.read_text())


def test_audio_only_extracts_m4a():
    from ao_worker.download import validate_params
    args = build_ytdlp_args("https://x.test/p", "/out", {"quality": "audio"})
    assert args[args.index("-f") + 1] == "ba/b"
    assert args[args.index("-x") + 1] == "--audio-format" and args[args.index("--audio-format") + 1] == "m4a"
    assert args.index("-x") < args.index("--")
    assert validate_params("https://x.test/p", {"quality": "audio"}) is None


def test_ready_made_selects_b():
    from ao_worker.download import validate_params
    args = build_ytdlp_args("https://x.test/p", "/out", {"quality": "ready"})
    assert args[args.index("-f") + 1] == "b"
    assert "-x" not in args
    assert validate_params("https://x.test/p", {"quality": "ready"}) is None


def test_ffmpeg_argument_is_added_by_build_ytdlp_args():
    args = build_ytdlp_args("https://x.test/p", "/out", {}, ffmpeg="/fake/ffmpeg")
    assert args[args.index("--ffmpeg-location") + 1] == "/fake/ffmpeg"
    assert "--ffmpeg-location" not in build_ytdlp_args("https://x.test/p", "/out", {})


@pytest.mark.parametrize("quality", ["best", "1080p", "720p", "audio"])
def test_better_qualities_need_ffmpeg(worker, tmp_path, monkeypatch, quality):
    from ao_worker import tools
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    monkeypatch.setattr(tools, "which", lambda program: None)
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp", "quality": quality})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED"
    assert job["error"]["tool"] == "ffmpeg"
    assert not argv_file.exists()  # yt-dlp was never run


def test_ready_made_runs_without_ffmpeg(worker, tmp_path, monkeypatch):
    from ao_worker import tools
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    monkeypatch.setattr(tools, "which", lambda program: None)
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp", "quality": "ready"})
    assert job["status"] == "done", job
    args = json.loads(argv_file.read_text())
    assert args[args.index("-f") + 1] == "b" and "--ffmpeg-location" not in args


def test_platform_reason_is_the_platforms_words_without_links():
    from ao_worker.download import platform_reason
    assert platform_reason("ERROR: [youtube] abc: Video unavailable. https://x.example/?t=1") == "Video unavailable."
    assert platform_reason("x\nERROR: [youtube] a: First reason\nERROR: [tiktok] b: Second\x07 reason\n") == "Second reason"
    assert platform_reason("ERROR: [youtube] a: " + "w" * 300) == "w" * 200
    assert platform_reason("ERROR: something without a platform tag") is None
    assert platform_reason("") is None


def test_failure_json_carries_platform_reason(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "login")
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "failed"
    assert job["error"]["platformReason"].startswith("Sign in to confirm you're not a bot.")
    assert "://" not in job["error"]["platformReason"]
    # a job that fails for another reason carries no such key
    from ao_worker.jobs import JobError
    assert "platformReason" not in JobError("X", "m").to_json()
    assert JobError("X", "m", platform_reason="why").to_json()["platformReason"] == "why"


def test_strip_url():
    assert strip_url("https://www.instagram.com/reel/XYZ/?igsh=abc#frag") == "https://www.instagram.com/reel/XYZ/"
    assert strip_url("see https://a.test/x?token=1 and http://b.test/?q=2 now") == "see https://a.test/x and http://b.test/ now"
    assert strip_url("https://user:pw@a.test/x") == "https://a.test/x"


def test_prefers_env_then_path_and_never_downloads(worker_env, monkeypatch, tmp_path):
    from conftest import FAKE_BIN

    called = []
    monkeypatch.setattr(download, "_download_ytdlp", lambda dest: called.append(dest))
    assert download.resolve_ytdlp() == (str(FAKE_BIN / "yt-dlp"), False)
    other = tmp_path / "my-yt-dlp"
    other.write_text("#!/bin/sh\n")
    other.chmod(0o755)
    monkeypatch.setenv("AO_YTDLP_BIN", str(other))
    assert download.resolve_ytdlp() == (str(other), False)
    assert called == []


# The managed yt-dlp download (latest tag, SHA2-256SUMS, refused on mismatch) is tested against a
# local file server in test_tools.py (test_video_downloader_installs_..., test_ytdlp_not_matching_...).


def test_gallerydl_dates_are_inclusive_and_validated():
    from ao_worker.download import build_gallerydl_args, validate_params

    args = build_gallerydl_args("https://x.test/p", "/out", {"dateAfter": "20260101", "dateBefore": "20261231"})
    assert args[args.index("--filter") + 1] == "date >= datetime(2026, 1, 1) and date < datetime(2027, 1, 1)"
    assert validate_params("https://x.test/p", {"dateBefore": "20261340"}) is not None


# ---------- R36: comments; partial enumerations ----------


def test_include_comments_is_accepted_and_validated():
    from ao_worker.download import validate_params

    assert validate_params("https://x.test/p", {"includeComments": True}) is None
    assert validate_params("https://x.test/p", {"includeComments": False}) is None
    assert validate_params("https://x.test/p", {"includeComments": "yes"}) is not None
    assert "--write-comments" in build_ytdlp_args("https://x.test/p", "/out", {"includeComments": True})
    assert "--write-comments" not in build_ytdlp_args("https://x.test/p", "/out", {})


def test_ytdlp_comments_go_to_a_separate_json_file(worker, tmp_path):
    out = tmp_path / "c"
    job = worker.run("capture.download", URL, str(out), {"tool": "yt-dlp", "includeComments": True})
    assert job["status"] == "done", job
    meta = job["result"]["meta"]
    assert [Path(f).name for f in meta["comments"]] == ["abc123.comments.json"]
    assert "abc123.comments.json" not in [Path(f).name for f in meta["files"] + meta["infoJson"]]
    comments = json.loads((out / "abc123.comments.json").read_text())
    assert comments == [{"id": "c1", "author": "someone", "text": "Nice video"}]
    info = json.loads((out / "abc123.info.json").read_text())
    assert "comments" not in info and info["comment_count"] == 1
    assert "commentsUnsupported" not in meta


def test_ytdlp_without_comments_writes_no_comments_file(worker, tmp_path):
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp"})
    meta = job["result"]["meta"]
    assert meta.get("comments", []) == []
    assert not list((tmp_path / "c").glob("*.comments.json"))


def test_gallerydl_comments_are_unsupported_and_flagged(worker, tmp_path, monkeypatch):
    from conftest import FAKE_BIN

    monkeypatch.setenv("AO_GALLERYDL_BIN", str(FAKE_BIN / "gallery-dl"))
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    job = worker.run("capture.download", "https://www.instagram.com/p/XYZ/", str(tmp_path / "g"), {"tool": "gallery-dl", "includeComments": True})
    assert job["status"] == "done", job
    meta = job["result"]["meta"]
    assert meta["commentsUnsupported"] is True
    assert meta.get("comments", []) == []
    assert not any(a.startswith("-") and "comment" in a for a in json.loads(argv_file.read_text()))


def test_an_enumeration_cut_short_is_partial_not_failed(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "ratelimit-flat")
    job = worker.run("capture.download", "https://www.youtube.com/@someone", str(tmp_path / "c"), {"tool": "yt-dlp", "flatList": True})
    assert job["status"] == "done", job
    meta = job["result"]["meta"]
    assert meta["partial"] is True and meta["errorCode"] == "RATE_LIMITED"
    assert [Path(f).name for f in meta["infoJson"]] == ["abc123.info.json"]
    assert meta["files"] == []


def test_a_single_item_with_only_its_info_json_still_fails(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "ratelimit-flat")
    job = worker.run("capture.download", URL, str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "RATE_LIMITED"
