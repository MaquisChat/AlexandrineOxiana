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


def test_ytdlp_quality_selects_a_format():
    from ao_worker.download import validate_params
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
])
def test_map_error(stderr, code):
    assert map_error(stderr) == code


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


def test_managed_download_verifies_sha256(worker_env, monkeypatch):
    """The managed binary is checked against SHA2-256SUMS; a mismatch is refused (no network: fetch is stubbed)."""
    payload = b"#!/bin/sh\necho 2026.11.01\n"
    sums = "0" * 64 + "  " + download.ytdlp_asset_name() + "\n"
    fetched = []

    def fetch(url):
        fetched.append(url)
        return sums.encode() if url.endswith("SHA2-256SUMS") else payload

    monkeypatch.setattr(download, "_latest_tag", lambda: "2026.11.01")
    monkeypatch.setattr(download, "_fetch", fetch)
    dest = worker_env["tools"] / "yt-dlp"
    with pytest.raises(download.ToolError) as e:
        download._download_ytdlp(dest)
    assert e.value.code == "TOOL_CHECKSUM_MISMATCH"
    assert not dest.exists()

    import hashlib

    sums = hashlib.sha256(payload).hexdigest() + "  " + download.ytdlp_asset_name() + "\n"
    download._download_ytdlp(dest)
    # both files come from the same pinned tag, not from "latest"
    assert all("/download/2026.11.01/" in u for u in fetched) and len(fetched) == 4
    assert dest.read_bytes() == payload
    assert os.access(dest, os.X_OK)


def test_gallerydl_dates_are_inclusive_and_validated():
    from ao_worker.download import build_gallerydl_args, validate_params

    args = build_gallerydl_args("https://x.test/p", "/out", {"dateAfter": "20260101", "dateBefore": "20261231"})
    assert args[args.index("--filter") + 1] == "date >= datetime(2026, 1, 1) and date < datetime(2027, 1, 1)"
    assert validate_params("https://x.test/p", {"dateBefore": "20261340"}) is not None
