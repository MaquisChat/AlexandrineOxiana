"""Shared fixtures: an in-process worker, fake capture tools, and generated media."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
DOWNLOADED = REPO_ROOT / "tests" / "fixtures" / "downloaded"
FAKE_BIN = HERE / "fixtures" / "bin"
SPEECH_CLIP = DOWNLOADED / "librispeech-voices-sp0307-sg0042.wav"
DNG_FILE = DOWNLOADED / "canon-eos-5d-mark-iii-14bit.dng"
TOKEN = "test-token-0123456789abcdef"


def need_download(path: Path) -> Path:
    if not path.exists():
        pytest.skip(f"{path.name} not downloaded: run `node scripts/fetch-fixtures.mjs` (needs network)")
    return path


class Client:
    def __init__(self, base: str, token: str | None = TOKEN):
        self.base = base
        self.token = token

    def request(self, method: str, path: str, body: object | None = None, token: str | None = "default"):
        tok = self.token if token == "default" else token
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if tok is not None:
            req.add_header("Authorization", f"Bearer {tok}")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def submit(self, type_: str, input_: str, output: str, params: dict | None = None) -> str:
        status, body = self.request("POST", "/jobs", {"type": type_, "input": input_, "output": output, "params": params or {}})
        assert status == 202, body
        return body["id"]

    def get(self, job_id: str) -> dict:
        status, body = self.request("GET", f"/jobs/{job_id}")
        assert status == 200, body
        return body

    def wait(self, job_id: str, timeout: float = 120, until=("done", "failed", "cancelled")) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.get(job_id)
            if job["status"] in until:
                return job
            time.sleep(0.1)
        raise AssertionError(f"job {job_id} still {job['status']} after {timeout}s")

    def run(self, type_: str, input_: str, output: str, params: dict | None = None, timeout: float = 120) -> dict:
        return self.wait(self.submit(type_, input_, output, params), timeout)


@pytest.fixture
def worker_env(tmp_path, monkeypatch):
    """Env for a worker: per-test tools dir, shared models cache, fake tools first on PATH."""
    models = Path(os.environ.get("AO_MODELS_DIR") or (Path.home() / ".cache" / "ao-worker-test-models"))
    models.mkdir(parents=True, exist_ok=True)
    tools = tmp_path / "tools"
    tools.mkdir()
    monkeypatch.setenv("AO_MODELS_DIR", str(models))
    monkeypatch.setenv("AO_TOOLS_DIR", str(tools))
    monkeypatch.setenv("PATH", f"{FAKE_BIN}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.delenv("AO_YTDLP_BIN", raising=False)
    monkeypatch.delenv("AO_GALLERYDL_BIN", raising=False)
    monkeypatch.delenv("FAKE_YTDLP_MODE", raising=False)
    # Child tools get an allowlisted environment; let the fakes' FAKE_* controls through.
    from ao_worker import jobs

    monkeypatch.setattr(jobs, "CHILD_ENV_PREFIXES", (*jobs.CHILD_ENV_PREFIXES, "FAKE_"))
    return {"models": models, "tools": tools}


@pytest.fixture
def worker(worker_env, caplog):
    from ao_worker.app import make_server

    server = make_server(token=TOKEN, port=0)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    client = Client(f"http://127.0.0.1:{server.server_address[1]}")
    client.server = server
    try:
        yield client
    finally:
        server.manager.shutdown()
        server.shutdown()
        server.server_close()


# ---------- generated media ----------


@pytest.fixture
def heic_with_gps(tmp_path) -> Path:
    import pillow_heif
    from PIL import Image

    pillow_heif.register_heif_opener()
    img = Image.new("RGB", (4032, 3024), (40, 120, 200))
    exif = Image.Exif()
    exif[0x010F] = "Apple"  # Make
    exif[0x0110] = "iPhone 15"  # Model
    exif[0x0112] = 6  # Orientation: rotate 90 CW to display
    exif.get_ifd(0x8769)[0x9003] = "2026:03:14 10:15:30"  # DateTimeOriginal
    exif.get_ifd(0x8769)[0x9011] = "-04:00"  # OffsetTimeOriginal
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (40.0, 42.0, 46.08)  # 40.7128
    gps[3] = "W"
    gps[4] = (74.0, 0.0, 21.6)  # 74.0060
    gps[6] = 10.0  # altitude
    path = tmp_path / "IMG_0001.HEIC"
    img.save(path, format="HEIF", exif=exif.tobytes(), quality=50)
    return path


@pytest.fixture
def mov_with_location(tmp_path) -> Path:
    path = tmp_path / "clip.mov"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=3",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "mpeg4", "-q:v", "5", "-c:a", "pcm_s16le",
            "-metadata", "location=+40.7128-074.0060/",
            "-metadata", "creation_time=2026-03-14T14:15:30Z",
            str(path),
        ],
        check=True,
    )
    return path


@pytest.fixture
def image_pdf(tmp_path) -> Path:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1700, 2200), "white")
    draw = ImageDraw.Draw(img)
    draw.text((200, 300), "ARCHIVE", fill="black", font=ImageFont.load_default(size=160))
    path = tmp_path / "scan.pdf"
    img.save(path, "PDF", resolution=200)
    return path


def require_binaries(*names: str) -> None:
    missing = [n for n in names if shutil.which(n) is None]
    if missing:
        reason = f"missing system binaries: {', '.join(missing)} (install with: apt-get install -y tesseract-ocr ghostscript)"
        print(f"SKIP: {reason}", file=sys.stderr)
        pytest.skip(reason)
