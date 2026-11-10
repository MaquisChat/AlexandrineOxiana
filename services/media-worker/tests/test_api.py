import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import FAKE_BIN, TOKEN, Client


def test_rejects_missing_token(worker):
    status, body = worker.request("GET", "/health", token=None)
    assert status == 401
    assert body["error"]["code"] == "UNAUTHORIZED"


def test_rejects_invalid_token(worker):
    for path, method in (("/health", "GET"), ("/jobs", "POST"), ("/jobs/x", "GET"), ("/tools/update", "POST")):
        status, _ = worker.request(method, path, {"type": "image.proxy"} if method == "POST" else None, token="wrong")
        assert status == 401, path


def test_health_reports_versions(worker):
    status, body = worker.request("GET", "/health")
    assert status == 200
    assert body["ok"] is True
    v = body["versions"]
    for key in ("python", "faster_whisper", "yt_dlp", "gallery_dl", "pillow", "pillow_heif", "rawpy", "ffmpeg", "ocrmypdf", "tesseract"):
        assert key in v
    assert v["python"].startswith(f"{sys.version_info.major}.{sys.version_info.minor}")
    assert v["yt_dlp"] == "2026.10.22"  # the fake on PATH; nothing is downloaded


def test_rejects_bad_job_bodies(worker, tmp_path):
    cases = [
        {"type": "nope", "input": "/x", "output": str(tmp_path)},
        {"type": "image.proxy", "input": "relative.jpg", "output": str(tmp_path / "o.jpg")},
        {"type": "image.proxy", "input": "/x.jpg", "output": "rel"},
        {"type": "capture.download", "input": "file:///etc/passwd", "output": str(tmp_path)},
        {"type": "capture.download", "input": "https://example.com/v", "output": str(tmp_path), "params": {"tool": "curl"}},
    ]
    for body in cases:
        status, resp = worker.request("POST", "/jobs", body)
        assert status == 400, body
        assert resp["error"]["code"] == "INVALID_REQUEST"


def test_unknown_job_is_404(worker):
    status, _ = worker.request("GET", "/jobs/does-not-exist")
    assert status == 404


def _hang(worker, tmp_path, name, monkeypatch):
    out = tmp_path / name
    pidfile = tmp_path / f"{name}.pid"
    monkeypatch.setenv("FAKE_CHILD_PID_FILE", str(pidfile))
    job_id = worker.submit("capture.download", "https://www.youtube.com/watch?v=abc123", str(out), {"tool": "yt-dlp"})
    return job_id, pidfile


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # a zombie still answers kill(0); check its state
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except FileNotFoundError:
        return False


def test_cancel_moves_running_job_to_cancelled_and_kills_children(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "hang")
    job_id, pidfile = _hang(worker, tmp_path, "a", monkeypatch)
    worker.wait(job_id, 15, until=("running",))
    deadline = time.monotonic() + 15
    while not pidfile.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    grandchild = int(pidfile.read_text())
    assert _alive(grandchild)

    status, _ = worker.request("POST", f"/jobs/{job_id}/cancel")
    assert status == 202
    job = worker.wait(job_id, 15)
    assert job["status"] == "cancelled"
    deadline = time.monotonic() + 10
    while _alive(grandchild) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(grandchild), "the tool's child process survived cancellation"


def test_cancel_queued_job(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "hang")
    ids = [_hang(worker, tmp_path, n, monkeypatch)[0] for n in ("a", "b", "c")]
    time.sleep(0.5)
    assert worker.get(ids[2])["status"] == "queued"
    worker.request("POST", f"/jobs/{ids[2]}/cancel")
    assert worker.wait(ids[2], 5)["status"] == "cancelled"
    for i in ids[:2]:
        worker.request("POST", f"/jobs/{i}/cancel")


def test_at_most_two_jobs_run_at_once(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_YTDLP_MODE", "hang")
    ids = [_hang(worker, tmp_path, n, monkeypatch)[0] for n in ("a", "b", "c")]
    for i in ids[:2]:
        worker.wait(i, 15, until=("running",))
    time.sleep(0.5)
    assert [worker.get(i)["status"] for i in ids] == ["running", "running", "queued"]
    worker.request("POST", f"/jobs/{ids[0]}/cancel")
    assert worker.wait(ids[0], 15)["status"] == "cancelled"
    assert worker.wait(ids[2], 15, until=("running",))["status"] == "running"
    for i in ids[1:]:
        worker.request("POST", f"/jobs/{i}/cancel")
        assert worker.wait(i, 15)["status"] == "cancelled"


def test_logs_strip_url_queries_and_user_paths(worker, tmp_path, caplog):
    caplog.set_level(logging.DEBUG, logger="ao_worker")
    url = "https://www.instagram.com/reel/XYZ/?igsh=SECRET123&utm_source=ig"
    out = tmp_path / "private-folder"
    job = worker.run("capture.download", url, str(out), {"tool": "yt-dlp", "cookiesFromBrowser": "firefox"})
    assert job["status"] == "done"
    text = caplog.text
    assert "instagram.com/reel/XYZ/" in text
    assert "SECRET123" not in text and "igsh" not in text
    assert "private-folder" not in text and str(tmp_path) not in text
    assert "firefox" not in text and "cookies" not in text.lower()


def test_python_m_ao_worker_prints_ready_and_binds_localhost(worker_env):
    env = {**os.environ, "AO_WORKER_TOKEN": TOKEN, "AO_WORKER_PORT": "0"}
    p = subprocess.Popen([sys.executable, "-m", "ao_worker"], cwd=Path(__file__).parents[1], env=env, stdout=subprocess.PIPE, text=True)
    try:
        line = p.stdout.readline()
        m = re.fullmatch(r"AO_WORKER_READY port=(\d+)\n", line)
        assert m, line
        status, body = Client(f"http://127.0.0.1:{m.group(1)}").request("GET", "/health")
        assert status == 200 and body["ok"] is True
    finally:
        p.terminate()
        p.wait(10)


def test_refuses_to_start_without_token(worker_env):
    env = {k: v for k, v in os.environ.items() if k != "AO_WORKER_TOKEN"}
    p = subprocess.run([sys.executable, "-m", "ao_worker"], cwd=Path(__file__).parents[1], env=env, capture_output=True, text=True, timeout=30)
    assert p.returncode != 0
    assert "AO_WORKER_TOKEN" in p.stderr


def test_tools_update_updates_managed_yt_dlp(worker, worker_env, monkeypatch):
    managed = worker_env["tools"] / "yt-dlp"
    managed.write_bytes((FAKE_BIN / "yt-dlp").read_bytes())
    managed.chmod(0o755)
    status, body = worker.request("POST", "/tools/update")
    assert status == 200, body
    assert body["ytDlp"] == {"old": "2026.10.22", "new": "2026.11.01", "managed": True}
    assert body["galleryDl"]["pinned"] is True


def test_tools_update_does_not_touch_unmanaged_binary(worker):
    status, body = worker.request("POST", "/tools/update")
    assert status == 200
    assert body["ytDlp"]["managed"] is False
    assert body["ytDlp"]["old"] == body["ytDlp"]["new"] == "2026.10.22"
    assert not (FAKE_BIN / "yt-dlp.version").exists()


def test_child_tools_do_not_inherit_the_token(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("AO_WORKER_TOKEN", TOKEN)
    monkeypatch.setenv("FAKE_YTDLP_MODE", "env")
    env_file = tmp_path / "env.json"
    monkeypatch.setenv("FAKE_ENV_FILE", str(env_file))
    job = worker.run("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "done", job
    import json

    env = json.loads(env_file.read_text())
    assert "AO_WORKER_TOKEN" not in env and env.get("FAKE_YTDLP_MODE") == "env"
