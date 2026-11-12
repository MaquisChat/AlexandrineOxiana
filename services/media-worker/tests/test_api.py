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


WORKER_DIR = Path(__file__).parents[1]
# A token as the service makes them (64 hex characters); conftest's TOKEN is for the in-process worker.
STDIN_TOKEN = "0123456789abcdef" * 4


def _env(**extra: str) -> dict:
    """The test's environment without any worker token variable, plus `extra`."""
    env = {k: v for k, v in os.environ.items() if k.upper() != "AO_WORKER_TOKEN"}
    env.update(AO_WORKER_PORT="0", PYTHONUNBUFFERED="1", **extra)
    return env


def _start(args=(), env=None, stdin=subprocess.PIPE, write: str | None = STDIN_TOKEN + "\n"):
    """`python -m ao_worker` as the library service starts it: the token as one line on stdin, which stays open."""
    p = subprocess.Popen([sys.executable, "-m", "ao_worker", *args], cwd=WORKER_DIR, env=env or _env(), stdin=stdin,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if write is not None and p.stdin:
        p.stdin.write(write)
        p.stdin.flush()
    return p


def _stop(p) -> None:
    if p.poll() is None:
        p.kill()
        p.wait(10)


def _refused(p, timeout=30) -> tuple[int, str, str]:
    try:
        out, err = p.communicate(timeout=timeout)
    finally:
        _stop(p)
    return p.returncode, out, err


def test_python_m_ao_worker_reads_its_token_on_stdin_prints_ready_and_binds_localhost(worker_env):
    p = _start()
    try:
        line = p.stdout.readline()
        m = re.fullmatch(r"AO_WORKER_READY port=(\d+)\n", line)
        assert m, line
        client = Client(f"http://127.0.0.1:{m.group(1)}", token=STDIN_TOKEN)
        status, body = client.request("GET", "/health")
        assert status == 200 and body["ok"] is True
        status, _ = client.request("GET", "/health", token="0" * 64)
        assert status == 401
        if sys.platform.startswith("linux"):
            environ = Path(f"/proc/{p.pid}/environ").read_bytes()
            cmdline = Path(f"/proc/{p.pid}/cmdline").read_bytes()
            assert STDIN_TOKEN.encode() not in environ and STDIN_TOKEN.encode() not in cmdline
    finally:
        p.terminate()
        p.wait(10)
    assert STDIN_TOKEN not in p.stdout.read() + p.stderr.read()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc")
def test_its_own_stdin_is_not_handed_to_the_tools_it_runs(worker_env):
    # The life line stays with the worker: what it starts (version probes, jobs) gets /dev/null.
    p = _start()
    try:
        assert p.stdout.readline().startswith("AO_WORKER_READY port=")
        assert os.readlink(f"/proc/{p.pid}/fd/0") == "/dev/null"
    finally:
        p.terminate()
        p.wait(10)


def test_exits_cleanly_when_its_stdin_closes(worker_env):
    # R155: the service's end of the pipe is gone (closed, crashed, killed): the worker stops.
    p = _start()
    try:
        assert p.stdout.readline().startswith("AO_WORKER_READY port=")
        time.sleep(0.3)
        p.stdin.close()
        assert p.wait(15) == 0, p.stderr.read()[-500:]
    finally:
        _stop(p)


def test_sigterm_exits_cleanly_while_watching_stdin(worker_env):
    # As startWorker runs it: stdin is a pipe that stays open, and the app stops it with SIGTERM.
    p = _start()
    try:
        assert p.stdout.readline().startswith("AO_WORKER_READY port=")
        time.sleep(0.3)  # the stdin watcher is blocked in its read
        p.terminate()
        assert p.wait(15) == 0, p.stderr.read()[-500:]
    finally:
        _stop(p)


@pytest.mark.parametrize("name", ["AO_WORKER_TOKEN", "ao_worker_token"])
def test_refuses_a_token_in_its_environment_even_with_one_on_stdin(worker_env, name):
    code, out, err = _refused(_start(env=_env(**{name: STDIN_TOKEN})))
    assert code != 0
    assert "AO_WORKER_READY" not in out
    assert "environment" in err and STDIN_TOKEN not in err


def test_refuses_command_line_arguments(worker_env):
    code, out, err = _refused(_start(args=["--token", STDIN_TOKEN]))
    assert code != 0 and "AO_WORKER_READY" not in out
    assert "argument" in err and STDIN_TOKEN not in err


def test_refuses_the_tokens_value_in_another_variable(worker_env):
    code, out, err = _refused(_start(env=_env(SOMETHING_ELSE=f"x{STDIN_TOKEN}x")))
    assert code != 0 and "AO_WORKER_READY" not in out
    assert "environment" in err and STDIN_TOKEN not in err


@pytest.mark.parametrize("bad", ["short-token", STDIN_TOKEN + " with spaces"])
def test_refuses_a_malformed_token_without_printing_it(worker_env, bad):
    code, out, err = _refused(_start(write=bad + "\n"))
    assert code != 0 and "AO_WORKER_READY" not in out
    assert "not a valid access token" in err and bad not in err


def test_refuses_at_once_when_stdin_is_closed_or_not_connected(worker_env):
    t0 = time.monotonic()
    code, out, err = _refused(_start(stdin=subprocess.DEVNULL, write=None))
    assert code != 0 and "AO_WORKER_READY" not in out
    assert "standard input closed before an access token arrived" in err.lower()
    assert time.monotonic() - t0 < 10


@pytest.mark.skipif(sys.platform == "win32", reason="pseudo-terminals are POSIX")
def test_refuses_a_terminal_on_stdin(worker_env):
    import pty

    master, slave = pty.openpty()
    try:
        code, out, err = _refused(_start(stdin=slave, write=None))
    finally:
        os.close(master)
        os.close(slave)
    assert code != 0 and "AO_WORKER_READY" not in out
    assert "terminal" in err


def test_refuses_when_no_token_arrives_in_time(worker_env):
    t0 = time.monotonic()
    p = _start(write=None)  # stdin stays open and silent (communicate() would close it)
    try:
        code = p.wait(timeout=60)
        elapsed = time.monotonic() - t0
        out, err = p.stdout.read(), p.stderr.read()
    finally:
        p.stdin.close()
        _stop(p)
    assert code != 0 and "AO_WORKER_READY" not in out
    assert "no access token arrived on standard input within" in err.lower()
    assert 10 <= elapsed < 50


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


def test_child_tools_get_an_allowlisted_env_with_a_private_tmpdir(worker, tmp_path, monkeypatch):
    import json

    monkeypatch.setenv("SOME_APP_SECRET", "s3cret")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")
    monkeypatch.setenv("LC_ALL", "C.UTF-8")
    monkeypatch.setenv("FAKE_YTDLP_MODE", "env")
    env_file = tmp_path / "env.json"
    monkeypatch.setenv("FAKE_ENV_FILE", str(env_file))
    out = tmp_path / "c"
    job = worker.run("capture.download", "https://www.youtube.com/watch?v=abc123", str(out), {"tool": "yt-dlp"})
    assert job["status"] == "done", job
    env = json.loads(env_file.read_text())
    assert "SOME_APP_SECRET" not in env
    assert env["HTTPS_PROXY"] == "http://proxy.test:3128" and env["LC_ALL"] == "C.UTF-8" and "PATH" in env
    assert env["TMPDIR"] == env["TEMP"] == env["TMP"] == str(tmp_path / f".work-{job['id']}")
    assert not Path(env["TMPDIR"]).exists()  # removed when the job ended


def test_bad_content_length_is_400(worker):
    import http.client
    from urllib.parse import urlsplit

    host = urlsplit(worker.base)
    for value in ("-5", "abc"):
        c = http.client.HTTPConnection(host.hostname, host.port, timeout=10)
        c.putrequest("POST", "/jobs")
        c.putheader("Authorization", f"Bearer {TOKEN}")
        c.putheader("Content-Length", value)
        c.endheaders()
        r = c.getresponse()
        assert r.status == 400, value
        c.close()


def test_transcription_language_must_be_known(worker, tmp_path):
    for lang in ("xx", "english", ["en"], "EN"):
        status, _ = worker.request("POST", "/jobs", {"type": "audio.transcribe", "input": str(tmp_path / "a.wav"), "output": str(tmp_path), "params": {"language": lang}})
        assert status == 400, lang
    status, _ = worker.request("POST", "/jobs", {"type": "audio.transcribe", "input": str(tmp_path / "a.wav"), "output": str(tmp_path / "t"), "params": {"language": "de"}})
    assert status == 202


def test_finished_jobs_are_forgotten_after_their_state_was_fetched(worker, tmp_path):
    job = worker.run("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "done"
    status, _ = worker.request("GET", f"/jobs/{job['id']}")
    assert status == 404


def test_unfetched_finished_jobs_expire(worker, tmp_path, monkeypatch):
    from ao_worker import jobs

    job_id = worker.submit("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "c"), {"tool": "yt-dlp"})
    deadline = time.monotonic() + 15
    while worker.server.manager.jobs[job_id].status != "done" and time.monotonic() < deadline:
        time.sleep(0.05)
    monkeypatch.setattr(jobs, "RETAIN_FINISHED_SEC", 0.0)
    time.sleep(0.01)
    worker.submit("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "d"), {"tool": "yt-dlp"})
    assert job_id not in worker.server.manager.jobs
