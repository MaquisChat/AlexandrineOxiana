"""The optional tools (R126): catalogue, verified installs as jobs, removal, and missing tools named.

A local file server stands in for every download host; nothing here reaches the network.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import FAKE_BIN

from ao_worker import fetch, toolpins, tools
from ao_worker.toolpins import Component, Download, Unavailable

# ---------- a local file server standing in for the download hosts ----------


class Files:
    def __init__(self):
        self.routes: dict[str, dict] = {}
        self.requests: list[dict] = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def add(self, path: str, body: bytes = b"", status: int = 200, headers: dict | None = None,
            truncate: int | None = None, slow: float = 0.0, step: int = 4096, silent: float = 0.0) -> str:
        """`slow`: pause after every `step` bytes; `silent`: send the headers, then nothing for that long."""
        self.routes[path] = {"body": body, "status": status, "headers": headers or {}, "truncate": truncate, "slow": slow, "step": step, "silent": silent}
        return self.base + path

    def _handler(self):
        files = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # noqa: ANN002
                pass

            def _serve(self, head: bool):
                files.requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers)})
                r = files.routes.get(self.path)
                if r is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = r["body"]
                self.send_response(r["status"])
                for k, v in r["headers"].items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if head:
                    return
                data = body if r["truncate"] is None else body[: r["truncate"]]
                if r["silent"]:
                    self.wfile.flush()
                    time.sleep(r["silent"])
                    return
                if r["slow"]:
                    step = r["step"]
                    for i in range(0, len(data), step):
                        try:
                            self.wfile.write(data[i:i + step])
                            self.wfile.flush()
                        except OSError:
                            return
                        time.sleep(r["slow"])
                else:
                    self.wfile.write(data)
                if r["truncate"] is not None:
                    self.close_connection = True

            def do_GET(self):  # noqa: N802
                self._serve(False)

            def do_HEAD(self):  # noqa: N802
                self._serve(True)

        return H

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def files(monkeypatch):
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(k, raising=False)
    f = Files()
    yield f
    f.close()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def zip_bytes(members: dict[str, bytes], modes: dict[str, int] | None = None, links: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members.items():
            info = zipfile.ZipInfo(name)
            info.external_attr = ((modes or {}).get(name, 0o100644)) << 16
            z.writestr(info, data)
        for name, target in (links or {}).items():
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, target)
    return buf.getvalue()


def script(line: str) -> bytes:
    return f"#!/bin/sh\necho '{line}'\n".encode()


FFMPEG_OK = script("ffmpeg version 9.0.2 fake")


def ffmpeg_component(files: Files, ffmpeg_zip: bytes | None = None, ffprobe_zip: bytes | None = None, *,
                     sha_override: str | None = None, truncate: int | None = None, slow: float = 0.0, step: int = 4096,
                     hosts=("127.0.0.1",), path_prefix="/ffmpeg") -> Component:
    a = ffmpeg_zip if ffmpeg_zip is not None else zip_bytes({"ffmpeg": FFMPEG_OK})
    b = ffprobe_zip if ffprobe_zip is not None else zip_bytes({"ffprobe": script("ffprobe version 9.0.2 fake")})
    ua = files.add(f"{path_prefix}/ffmpeg.zip", a, truncate=truncate, slow=slow, step=step)
    ub = files.add(f"{path_prefix}/ffprobe.zip", b)
    return Component(
        id="ffmpeg", name="ffmpeg and ffprobe", version="9.0.2", licence="GPL", kind="pinned", root="tools", folder="ffmpeg",
        executables=("ffmpeg", "ffprobe"), hosts=hosts,
        downloads={"any": (
            Download(ua, sha_override or sha(a), len(a), extract=(("ffmpeg", "ffmpeg"),), unpacked=1_000_000),
            Download(ub, sha(b), len(b), extract=(("ffprobe", "ffprobe"),), unpacked=1_000_000),
        )},
    )


def no_system(monkeypatch, *names: str) -> None:
    """PATH holding only the fake capture tools and the interpreter's folder: none of `names`."""
    monkeypatch.setenv("PATH", os.pathsep.join([str(FAKE_BIN), os.path.dirname(sys.executable)]))
    for n in names:
        assert tools.shutil.which(n) is None, n


def staging_left(root: Path) -> list[str]:
    return [n for n in os.listdir(root) if n.startswith((".staging.", ".old.", ".yt-dlp."))] if root.exists() else []


# ---------- the catalogue ----------


def test_catalogue_lists_every_optional_tool_with_its_facts(worker, no_network):
    status, body = worker.request("GET", "/tools")
    assert status == 200, body
    assert body["platform"] in toolpins.PLATFORMS
    ids = [t["id"] for t in body["tools"]]
    assert ids == ["speech-tiny", "speech-small", "speech-medium", "speech-large-v3", "video-downloader", "image-downloader", "ffmpeg", "ocr"]
    for t in body["tools"]:
        for key in ("name", "purpose", "without", "version", "installed", "usable", "available", "downloadSize", "components"):
            assert key in t, (t["id"], key)
        assert t["purpose"] and t["without"]
        assert isinstance(t["installed"], bool) and isinstance(t["downloadSize"], int)
    by = {t["id"]: t for t in body["tools"]}
    # the video downloader is one choice with two installs
    assert [c["id"] for c in by["video-downloader"]["components"]] == ["yt-dlp", "deno"]
    assert by["video-downloader"]["sizeApproximate"] is True
    # what going without ffmpeg means (R83, R90 c)
    assert "proxy pending" in by["ffmpeg"]["without"] and "exports" in by["ffmpeg"]["without"]
    assert by["speech-tiny"]["downloadSize"] == 75538270 + 2249 + 2203239 + 459861
    # no absolute path of this computer in the answer
    assert str(Path.home()) not in json.dumps(body)
    assert no_network.attempts == []


def test_catalogue_reports_a_platform_without_a_pin_as_unavailable_with_its_reason(worker_env, monkeypatch):
    monkeypatch.setenv("PATH", str(FAKE_BIN))
    t = {x["id"]: x for x in tools.catalogue()["tools"]}["ocr"]
    assert t["installed"] is False
    assert t["available"] is False
    assert "tesseract" in t["unavailableReason"]


def test_every_real_pin_is_https_on_an_allowed_host_with_a_sha256(worker_env):
    for c in toolpins.COMPONENTS.values():
        if c.kind == "ytdlp":
            continue
        for plat in toolpins.PLATFORMS:
            d = c.downloads.get(plat) or c.downloads.get("any")
            assert d is not None, (c.id, plat)
            if isinstance(d, Unavailable):
                assert len(d.reason) > 20, (c.id, plat)
                continue
            for x in d:
                assert x.url.startswith("https://"), x.url
                assert fetch.host_allowed(re.match(r"https://([^/]+)/", x.url).group(1), c.hosts), x.url
                assert re.fullmatch(r"[0-9a-f]{64}", x.sha256), x.url
                assert x.size > 0
                assert sum(1 for k in (x.save_as, x.extract or None, x.extract_all_under) if k) == 1
    for t in toolpins.TOOLS.values():
        assert all(cid in toolpins.COMPONENTS for cid in t.components)


# ---------- installing ----------


def test_install_downloads_verifies_unpacks_and_reports_installed(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files))
    status, body = worker.request("POST", "/tools/ffmpeg/install")
    assert status == 202, body
    job = worker.wait(body["id"])
    assert job["status"] == "done", job
    assert job["result"]["installed"] == ["ffmpeg"]
    folder = worker_env["tools"] / "ffmpeg"
    assert os.access(folder / "ffmpeg", os.X_OK) and os.access(folder / "ffprobe", os.X_OK)
    assert tools.which("ffmpeg") == str(folder / "ffmpeg")
    assert staging_left(worker_env["tools"]) == []
    t = {x["id"]: x for x in worker.request("GET", "/tools")[1]["tools"]}["ffmpeg"]
    assert t["installed"] and t["usable"] and t["managed"]
    assert t["components"][0]["source"] == "managed" and t["components"][0]["installedVersion"] == "9.0.2"
    # Only plain GETs to the pinned addresses: nothing about the researcher or a project.
    for r in files.requests:
        assert r["method"] == "GET"
        assert "?" not in r["path"]
        sent = {k.lower() for k in r["headers"]}
        assert sent <= {"host", "user-agent", "accept-encoding", "connection"}, sent
        assert r["headers"].get("User-Agent") == "ao-worker"


def test_install_reports_progress(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    big = zip_bytes({"ffmpeg": FFMPEG_OK + b"#" * 400_000})
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, big, slow=0.002))
    jid = worker.request("POST", "/tools/ffmpeg/install")[1]["id"]
    seen = set()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        j = worker.request("GET", f"/jobs/{jid}")[1]
        if j["status"] in ("done", "failed", "cancelled"):
            break
        seen.add(j["progress"])
        time.sleep(0.02)
    assert j["status"] == "done", j
    assert any(0 < p < 1 for p in seen), seen


def test_wrong_checksum_is_refused_and_nothing_is_installed(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, sha_override="0" * 64))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_CHECKSUM_MISMATCH"
    assert job["error"]["tool"] == "ffmpeg"
    assert not (worker_env["tools"] / "ffmpeg").exists()
    assert staging_left(worker_env["tools"]) == []
    assert tools.which("ffmpeg") is None


def test_truncated_download_fails_and_leaves_nothing(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, truncate=10))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_DOWNLOAD_FAILED"
    assert not (worker_env["tools"] / "ffmpeg").exists()
    assert staging_left(worker_env["tools"]) == []


def test_a_redirect_to_another_host_is_refused(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    other = Files()  # "another host": reached as localhost, not 127.0.0.1
    try:
        c = ffmpeg_component(files)
        other.add("/ffmpeg.zip", zip_bytes({"ffmpeg": FFMPEG_OK}))
        files.add("/ffmpeg/ffmpeg.zip", b"", status=302, headers={"Location": f"http://localhost:{other.server.server_address[1]}/ffmpeg.zip"})
        monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", c)
        job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
        assert job["status"] == "failed"
        assert job["error"]["code"] == "TOOL_DOWNLOAD_FAILED"
        assert "host" in job["error"]["message"]
        assert other.requests == []
        assert not (worker_env["tools"] / "ffmpeg").exists()
    finally:
        other.close()


def test_a_redirect_within_the_allowed_hosts_is_followed(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    c = ffmpeg_component(files, path_prefix="/real")
    moved = Component(**{**c.__dict__, "downloads": {"any": (
        Download(files.add("/moved/ffmpeg.zip", b"", status=302, headers={"Location": files.base + "/real/ffmpeg.zip"}),
                 c.downloads["any"][0].sha256, c.downloads["any"][0].size, extract=(("ffmpeg", "ffmpeg"),), unpacked=1_000_000),
        c.downloads["any"][1],
    )}})
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", moved)
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "done", job


@pytest.mark.parametrize("archive", [
    {"members": {"../escape": b"x", "ffmpeg": FFMPEG_OK}},
    {"members": {"/abs/ffmpeg": b"x", "ffmpeg": FFMPEG_OK}},
    {"members": {"ffmpeg": FFMPEG_OK}, "links": {"evil": "/etc/passwd"}},
    {"members": {"ffmpeg": FFMPEG_OK, "FFMPEG": b"dup"}},
])
def test_an_archive_that_tries_to_escape_is_refused(worker, worker_env, files, monkeypatch, tmp_path, archive):
    no_system(monkeypatch, "ffmpeg")
    bad = zip_bytes(archive["members"], links=archive.get("links"))
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, bad))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed", job
    assert job["error"]["code"] == "TOOL_ARCHIVE_UNSAFE"
    assert not (worker_env["tools"] / "ffmpeg").exists()
    assert not (worker_env["tools"].parent / "escape").exists()
    assert staging_left(worker_env["tools"]) == []


def test_an_archive_bigger_than_its_limit_unpacked_is_refused(worker_env, tmp_path):
    from ao_worker import unpack

    archive = tmp_path / "bomb.zip"
    archive.write_bytes(zip_bytes({"ffmpeg": b"\0" * 2_000_000}))
    (tmp_path / "out").mkdir()
    with pytest.raises(fetch.ToolInstallError) as e:
        unpack.extract_zip(archive, tmp_path / "out", members={"ffmpeg": "ffmpeg"}, max_bytes=1_000_000)
    assert e.value.code == "TOOL_ARCHIVE_UNSAFE"


def test_a_full_disk_fails_plainly_and_leaves_nothing(worker, worker_env, files, monkeypatch):
    import errno

    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files))

    class Full(io.BytesIO):
        def write(self, b):
            raise OSError(errno.ENOSPC, "No space left on device")

        def fileno(self):
            raise OSError(errno.EBADF, "no")

    real = fetch._open_for_write

    def opener(path):
        real(path).close()  # the file exists, as it would on a real disk
        return Full()

    monkeypatch.setattr(fetch, "_open_for_write", opener)
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_WRITE_FAILED"
    assert "space" in job["error"]["message"]
    assert not (worker_env["tools"] / "ffmpeg").exists()
    assert staging_left(worker_env["tools"]) == []


def test_a_cancelled_install_leaves_nothing_and_can_be_retried(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    big = zip_bytes({"ffmpeg": FFMPEG_OK + b"#" * 2_000_000})
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, big, slow=0.01))
    jid = worker.request("POST", "/tools/ffmpeg/install")[1]["id"]
    deadline = time.monotonic() + 30
    while worker.request("GET", f"/jobs/{jid}")[1]["progress"] == 0 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert worker.request("POST", f"/jobs/{jid}/cancel")[0] == 202
    job = worker.wait(jid)
    assert job["status"] == "cancelled"
    assert not (worker_env["tools"] / "ffmpeg").exists()
    assert staging_left(worker_env["tools"]) == []
    # retried with a good download: installed
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, path_prefix="/again"))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "done", job


def test_a_tool_that_does_not_run_after_download_is_not_installed(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    broken = zip_bytes({"ffmpeg": b"#!/bin/sh\nexit 3\n"})
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, broken))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_UNUSABLE"
    assert not (worker_env["tools"] / "ffmpeg").exists()


def test_an_interrupted_install_is_cleaned_up_when_the_worker_starts(worker_env):
    root = worker_env["tools"]
    (root / ".staging.abc" / "files").mkdir(parents=True)
    old = root / ".old.def.ffmpeg"
    old.mkdir()
    (old / tools.MARKER).write_text("{}")
    (root / ".old.ghi.deno").mkdir()  # its replacement arrived: the old copy goes
    (root / "deno").mkdir()
    tools.sweep()
    assert not (root / ".staging.abc").exists()
    assert (root / "ffmpeg" / tools.MARKER).is_file()  # put back: its replacement never arrived
    assert not (root / ".old.ghi.deno").exists() and (root / "deno").is_dir()


def test_reinstalling_replaces_the_old_copy_atomically(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files))
    assert worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])["status"] == "done"
    # a newer pin: update replaces it
    newer = zip_bytes({"ffmpeg": script("ffmpeg version 9.1.0 fake")})
    c = ffmpeg_component(files, newer, path_prefix="/v91")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", Component(**{**c.__dict__, "version": "9.1.0"}))
    t = {x["id"]: x for x in tools.catalogue()["tools"]}["ffmpeg"]
    assert t["updateAvailable"] is True
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/update")[1]["id"])
    assert job["status"] == "done", job
    assert job["result"]["installed"] == ["ffmpeg"]
    assert b"9.1.0" in (worker_env["tools"] / "ffmpeg" / "ffmpeg").read_bytes()
    assert staging_left(worker_env["tools"]) == []
    # already current: nothing downloaded
    n = len(files.requests)
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "done" and job["result"]["installed"] == [] and len(files.requests) == n


def test_a_platform_without_a_pin_is_refused_with_its_reason(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    c = ffmpeg_component(files)
    other = "macos-arm64" if tools.platform_key() != "macos-arm64" else "linux-x64"
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", Component(**{**c.__dict__, "downloads": {
        tools.platform_key(): Unavailable("No pinned build for this computer yet."), other: c.downloads["any"]}}))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_UNAVAILABLE"
    assert "No pinned build" in job["error"]["message"]
    assert files.requests == []


def test_unknown_tool_is_404(worker):
    status, body = worker.request("POST", "/tools/nope/install")
    assert status == 404 and body["error"]["code"] == "UNKNOWN_TOOL"
    status, body = worker.request("POST", "/tools/ffmpeg/explode")
    assert status == 404


def test_tool_jobs_cannot_be_submitted_through_jobs(worker, tmp_path):
    status, body = worker.request("POST", "/jobs", {"type": "tool.install", "input": "/x", "output": str(tmp_path)})
    assert status == 400


# ---------- removing ----------


def test_remove_deletes_the_apps_copy_only(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files))
    assert worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])["status"] == "done"
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/remove")[1]["id"])
    assert job["status"] == "done", job
    assert job["result"]["removed"] == ["ffmpeg"]
    assert not (worker_env["tools"] / "ffmpeg").exists()
    assert tools.which("ffmpeg") is None
    assert staging_left(worker_env["tools"]) == []


def test_removing_a_system_tool_is_refused(worker, worker_env):
    # yt-dlp is the fake on PATH: it belongs to the computer, not the app
    job = worker.wait(worker.request("POST", "/tools/video-downloader/remove")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_NOT_MANAGED"
    assert (FAKE_BIN / "yt-dlp").is_file()


# ---------- speech models ----------


def fake_model(files: Files, name: str = "tiny") -> tuple[Component, str]:
    rev = "0123456789abcdef0123456789abcdef01234567"
    body = {"config.json": b"{}", "model.bin": b"\x01" * 4096, "tokenizer.json": b"{}", "vocabulary.txt": b"a\nb\n"}
    downloads = tuple(Download(files.add(f"/m/{rev}/{f}", b), sha(b), len(b), save_as=f"snapshots/{rev}/{f}") for f, b in body.items())
    c = Component(id=f"model-{name}", name=f"Speech model ({name})", version=rev[:7], licence="MIT", kind="model", root="models",
                  folder=toolpins.model_folder(name), downloads={"any": downloads}, hosts=("127.0.0.1",), write=(("refs/main", rev),))
    return c, rev


def test_a_speech_model_installs_where_transcription_finds_it_offline(worker, worker_env, files, monkeypatch, tmp_path):
    from conftest import NoNetwork

    from ao_worker import transcribe

    monkeypatch.setenv("AO_MODELS_DIR", str(tmp_path / "models"))
    c, rev = fake_model(files)
    monkeypatch.setitem(toolpins.COMPONENTS, "model-tiny", c)
    monkeypatch.setitem(toolpins.MODEL_PINS, "tiny", (rev, tuple((f, d.sha256, d.size) for f, d in
                                                                  zip(("config.json", "model.bin", "tokenizer.json", "vocabulary.txt"), c.downloads["any"]))))
    job = worker.wait(worker.request("POST", "/tools/speech-tiny/install")[1]["id"])
    assert job["status"] == "done", job
    t = {x["id"]: x for x in tools.catalogue()["tools"]}["speech-tiny"]
    assert t["installed"] and t["usable"]
    nn = NoNetwork(monkeypatch)
    path = transcribe.model_path("tiny")  # faster-whisper's own local-only look-up
    assert Path(path) == tmp_path / "models" / toolpins.model_folder("tiny") / "snapshots" / rev
    assert nn.attempts == []


def test_a_missing_speech_model_is_named_and_never_downloaded(worker, worker_env, tmp_path, monkeypatch, no_network):
    from ao_worker import transcribe

    transcribe._model_cache.clear()
    monkeypatch.setenv("AO_MODELS_DIR", str(tmp_path / "no-models"))
    wav = tmp_path / "a.wav"
    import wave

    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * 16000)
    job = worker.run("audio.transcribe", str(wav), str(tmp_path / "t"), {"model": "tiny", "language": "en"}, timeout=120)
    assert job["status"] == "failed", job
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED"
    assert job["error"]["tool"] == "speech-tiny"
    assert no_network.attempts == []


# ---------- missing tools are said, not hidden ----------


def test_capture_without_the_video_downloader_names_it(worker, worker_env, tmp_path, monkeypatch, no_network):
    no_system(monkeypatch)
    monkeypatch.setenv("PATH", os.path.dirname(sys.executable))
    job = worker.run("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED" and job["error"]["tool"] == "video-downloader"
    assert no_network.attempts == []  # never downloaded on the fly any more
    assert not (worker_env["tools"] / "yt-dlp").exists()


def test_capture_without_the_image_downloader_names_it(worker, tmp_path):
    job = worker.run("capture.download", "https://www.instagram.com/p/XYZ/", str(tmp_path / "g"), {"tool": "gallery-dl"})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED" and job["error"]["tool"] == "image-downloader"


def test_video_proxy_without_ffmpeg_names_it(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", os.pathsep.join([str(FAKE_BIN), os.path.dirname(sys.executable)]))
    src = tmp_path / "clip.mov"
    src.write_bytes(b"not really a video")
    job = worker.run("video.proxy", str(src), str(tmp_path / "p.mp4"), {"location": "strip"})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED" and job["error"]["tool"] == "ffmpeg"


def test_ocr_without_tesseract_names_it(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", os.pathsep.join([str(FAKE_BIN), os.path.dirname(sys.executable)]))
    src = tmp_path / "scan.pdf"
    src.write_bytes(b"%PDF-1.4\n")
    job = worker.run("pdf.ocr", str(src), str(tmp_path / "o.pdf"))
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED" and job["error"]["tool"] == "ocr"


# ---------- the video downloader: yt-dlp (ADR 0009) and its JavaScript runtime ----------


def ytdlp_release(files: Files, monkeypatch, payload: bytes, listed_sha: str | None = None, tag: str = "2026.11.01") -> None:
    from ao_worker import download

    asset = download.ytdlp_asset_name()
    files.add("/releases/latest/download/SHA2-256SUMS", b"", status=302, headers={"Location": f"{files.base}/releases/download/{tag}/SHA2-256SUMS"})
    files.add(f"/releases/download/{tag}/SHA2-256SUMS", f"{listed_sha or sha(payload)}  {asset}\n{'1' * 64}  other\n".encode())
    files.add(f"/releases/download/{tag}/{asset}", payload)
    monkeypatch.setattr(download, "YTDLP_RELEASES", files.base + "/releases/")
    monkeypatch.setattr(download, "YTDLP_HOSTS", ("127.0.0.1",))


def deno_component(files: Files) -> Component:
    z = zip_bytes({"deno": script("deno 2.9.8 (stable, release, x86_64-unknown-linux-gnu)")})
    return Component(id="deno", name="JavaScript runtime (deno)", version="2.9.8", licence="MIT", kind="pinned", root="tools", folder="deno",
                     executables=("deno",), hosts=("127.0.0.1",),
                     downloads={"any": (Download(files.add("/deno.zip", z), sha(z), len(z), extract=(("deno", "deno"),), unpacked=1_000_000),)})


def test_video_downloader_installs_ytdlp_and_its_javascript_runtime(worker, worker_env, files, monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", os.path.dirname(sys.executable))
    payload = (FAKE_BIN / "yt-dlp").read_bytes()
    ytdlp_release(files, monkeypatch, payload)
    monkeypatch.setitem(toolpins.COMPONENTS, "deno", deno_component(files))
    job = worker.wait(worker.request("POST", "/tools/video-downloader/install")[1]["id"])
    assert job["status"] == "done", job
    assert job["result"]["installed"] == ["yt-dlp", "deno"]
    managed = worker_env["tools"] / "yt-dlp"
    assert managed.read_bytes() == payload and os.access(managed, os.X_OK)
    assert tools.deno_path() == str(worker_env["tools"] / "deno" / "deno")
    # the tag was resolved once and both files came from that tag
    gets = [r["path"] for r in files.requests if r["method"] == "GET" and r["path"].startswith("/releases/")]
    assert all("/download/2026.11.01/" in p for p in gets) and len(gets) == 2
    # a capture names the runtime to yt-dlp explicitly
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    job = worker.run("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "done", job
    args = json.loads(argv_file.read_text())
    i = args.index("--js-runtimes")
    assert args[i + 1] == f"deno:{worker_env['tools'] / 'deno' / 'deno'}"
    t = {x["id"]: x for x in tools.catalogue()["tools"]}["video-downloader"]
    assert t["installed"] and t["usable"] and t["managed"]


def test_ytdlp_not_matching_its_release_checksum_is_not_installed(worker, worker_env, files, monkeypatch):
    monkeypatch.setenv("PATH", os.path.dirname(sys.executable))
    ytdlp_release(files, monkeypatch, (FAKE_BIN / "yt-dlp").read_bytes(), listed_sha="0" * 64)
    monkeypatch.setitem(toolpins.COMPONENTS, "deno", deno_component(files))
    job = worker.wait(worker.request("POST", "/tools/video-downloader/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_CHECKSUM_MISMATCH" and job["error"]["tool"] == "video-downloader"
    assert not (worker_env["tools"] / "yt-dlp").exists()
    assert staging_left(worker_env["tools"]) == []


def test_without_a_javascript_runtime_ytdlp_is_not_told_one(worker, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", os.pathsep.join([str(FAKE_BIN), os.path.dirname(sys.executable)]))
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_ARGV_FILE", str(argv_file))
    job = worker.run("capture.download", "https://www.youtube.com/watch?v=abc123", str(tmp_path / "c"), {"tool": "yt-dlp"})
    assert job["status"] == "done", job
    assert "--js-runtimes" not in json.loads(argv_file.read_text())


def test_updating_the_video_downloader_updates_ytdlp_in_place(worker, worker_env, files, monkeypatch):
    monkeypatch.setenv("PATH", os.path.dirname(sys.executable))
    managed = worker_env["tools"] / "yt-dlp"
    managed.write_bytes((FAKE_BIN / "yt-dlp").read_bytes())
    managed.chmod(0o755)
    monkeypatch.setitem(toolpins.COMPONENTS, "deno", deno_component(files))
    job = worker.wait(worker.request("POST", "/tools/video-downloader/update")[1]["id"])
    assert job["status"] == "done", job
    assert job["result"]["updated"] == [{"component": "yt-dlp", "old": "2026.10.22", "new": "2026.11.01", "managed": True}]
    assert job["result"]["installed"] == ["deno"]


# ---------- the image downloader: gallery-dl as its own program ----------


def fake_gallerydl_wheel() -> bytes:
    main = (
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "if '--version' in args:\n"
        "    print('1.32.19')\n"
        "    sys.exit(0)\n"
        "out = Path(args[args.index('-D') + 1])\n"
        "out.mkdir(parents=True, exist_ok=True)\n"
        "(out / 'post.jpg').write_bytes(b'\\xff\\xd8fake')\n"
        "(out / 'post.jpg.json').write_text(json.dumps({'from': os.path.dirname(os.path.dirname(__file__))}))\n"
    )
    return zip_bytes({
        "gallery_dl/__init__.py": b"",
        "gallery_dl/__main__.py": main.encode(),
        "gallery_dl/version.py": b"__version__ = '1.32.19'\n",
        "gallery_dl-1.32.19.dist-info/METADATA": b"Name: gallery_dl\nVersion: 1.32.19\n",
    })


def test_image_downloader_installs_and_captures_run_it_as_its_own_program(worker, worker_env, files, monkeypatch, tmp_path):
    w = fake_gallerydl_wheel()
    monkeypatch.setitem(toolpins.COMPONENTS, "gallery-dl", Component(
        id="gallery-dl", name="Image downloader (gallery-dl)", version="1.32.19", licence="GPL-2.0-only", kind="pinned", root="tools",
        folder="gallery-dl", hosts=("127.0.0.1",),
        downloads={"any": (Download(files.add("/gallery_dl.whl", w), sha(w), len(w), extract_all_under="lib", unpacked=1_000_000),)}))
    job = worker.wait(worker.request("POST", "/tools/image-downloader/install")[1]["id"])
    assert job["status"] == "done", job
    job = worker.run("capture.download", "https://www.instagram.com/p/XYZ/", str(tmp_path / "g"), {"tool": "gallery-dl"})
    assert job["status"] == "done", job
    meta = job["result"]["meta"]
    assert meta["toolVersion"] == "1.32.19"
    info = json.loads(Path(meta["infoJson"][0]).read_text())
    assert info["from"] == str(worker_env["tools"] / "gallery-dl" / "lib")  # the app's copy, not the worker's


# ---------- slow hosts: cancel, stall limit and deadline (fix round 1, I3) ----------


def test_a_dripping_download_is_cancelled_within_about_a_second(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    # one byte every 0.1 s: never silent long enough to time out, and a 64 KiB read never fills
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, zip_bytes({"ffmpeg": FFMPEG_OK + b"#" * 5000}), slow=0.1, step=1))
    jid = worker.request("POST", "/tools/ffmpeg/install")[1]["id"]
    time.sleep(0.6)
    t = time.monotonic()
    assert worker.request("POST", f"/jobs/{jid}/cancel")[0] == 202
    job = worker.wait(jid, timeout=10)
    assert job["status"] == "cancelled"
    assert time.monotonic() - t < 2.0
    assert not (worker_env["tools"] / "ffmpeg").exists() and staging_left(worker_env["tools"]) == []


def test_a_host_that_stops_sending_is_given_up_on(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setattr(fetch, "STALL_SEC", 0.5)
    c = ffmpeg_component(files)
    files.add("/ffmpeg/ffmpeg.zip", zip_bytes({"ffmpeg": FFMPEG_OK}), silent=5.0)
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", c)
    t = time.monotonic()
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"], timeout=10)
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_DOWNLOAD_FAILED" and "stopped" in job["error"]["message"]
    assert time.monotonic() - t < 3.0
    assert staging_left(worker_env["tools"]) == []


def test_a_download_slower_than_its_deadline_is_given_up_on(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setattr(fetch, "DEADLINE_BASE_SEC", 0.5)
    monkeypatch.setattr(fetch, "DEADLINE_MIN_RATE", 10 ** 9)
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files, zip_bytes({"ffmpeg": FFMPEG_OK + b"#" * 5000}), slow=0.05, step=10))
    t = time.monotonic()
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"], timeout=10)
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_DOWNLOAD_FAILED" and "too long" in job["error"]["message"]
    assert time.monotonic() - t < 3.0


def test_the_deadline_scales_with_the_declared_size():
    assert fetch.deadline_for(3_000_000_000) > fetch.deadline_for(1_000_000) >= fetch.DEADLINE_BASE_SEC


# ---------- protections each guarded by a test (fix round 1, I4) ----------


def test_a_download_longer_than_its_pin_is_refused(worker, worker_env, files, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    c = ffmpeg_component(files)
    good = c.downloads["any"][0]
    # the server sends the pinned bytes and then more; the pin's size and hash are those of the prefix
    files.add("/ffmpeg/ffmpeg.zip", files.routes["/ffmpeg/ffmpeg.zip"]["body"] + b"MORE" * 1000)
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", c)
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_CHECKSUM_MISMATCH" and "larger" in job["error"]["message"]
    assert good.size < len(files.routes["/ffmpeg/ffmpeg.zip"]["body"])
    assert not (worker_env["tools"] / "ffmpeg").exists()


def test_an_unpinned_download_is_capped_at_its_limit(worker_env, files, tmp_path):
    files.add("/big", b"x" * 5000)
    with pytest.raises(fetch.ToolInstallError) as e:
        fetch.download(files.base + "/big", tmp_path / "f", sha256=None, size=None, hosts=("127.0.0.1",), max_bytes=1000)
    assert e.value.code == "TOOL_CHECKSUM_MISMATCH"
    assert not (tmp_path / "f").exists()


def test_a_redirect_from_https_down_to_http_is_refused():
    import urllib.request

    h = fetch._Redirects(("example.org",))
    req = urllib.request.Request("https://example.org/tool.zip")
    with pytest.raises(fetch.ToolInstallError) as e:
        h.redirect_request(req, None, 302, "Found", {}, "http://example.org/tool.zip")
    assert e.value.code == "TOOL_DOWNLOAD_FAILED"
    # the same host over https is followed
    assert h.redirect_request(req, None, 302, "Found", {}, "https://example.org/other.zip") is not None


def test_not_enough_free_space_refuses_before_downloading(worker, worker_env, files, monkeypatch):
    import collections

    no_system(monkeypatch, "ffmpeg")
    monkeypatch.setitem(toolpins.COMPONENTS, "ffmpeg", ffmpeg_component(files))
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(tools.shutil, "disk_usage", lambda p: usage(10**9, 10**9, 1000))
    job = worker.wait(worker.request("POST", "/tools/ffmpeg/install")[1]["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "TOOL_WRITE_FAILED" and "space" in job["error"]["message"]
    assert files.requests == []
    assert staging_left(worker_env["tools"]) == []


def test_a_folder_without_its_install_marker_is_not_installed(worker_env, monkeypatch):
    no_system(monkeypatch, "ffmpeg")
    folder = worker_env["tools"] / "ffmpeg"
    folder.mkdir()
    for n in ("ffmpeg", "ffprobe"):
        (folder / n).write_bytes(FFMPEG_OK)
        (folder / n).chmod(0o755)
    assert tools.which("ffmpeg") is None
    t = {x["id"]: x for x in tools.catalogue()["tools"]}["ffmpeg"]
    assert t["installed"] is False
    (folder / tools.MARKER).write_text("{}")
    assert tools.which("ffmpeg") == str(folder / "ffmpeg")
