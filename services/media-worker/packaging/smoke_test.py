"""Smoke test of the packaged worker (run by `node apps/desktop/scripts/build-sidecars.mjs --smoke`).

Starts the packaged `ao-worker` the way the desktop shell will (one executable, a clean
environment, token and port in the environment, ready line on stdout) from a temporary folder,
twice:

1. **No tools**: PATH is an empty folder, the models folder is empty. The worker must start,
   answer /health, make image proxies (HEIC via pillow-heif, DNG via rawpy), and report OCR,
   video proxies and transcription as clear failures instead of crashing.
2. **Tools supplied**: ffmpeg, ffprobe and tesseract from this machine are linked into
   `$AO_TOOLS_DIR/bin`, which is put first on PATH (what the tools manager will do), and the
   `tiny` speech model is in `$AO_MODELS_DIR`. Video proxy, OCR and transcription must work.

Outputs are checked independently of what the worker reports about them: image proxies are
decoded with Pillow (format, size, not blank), the video proxy is probed and fully decoded with
the supplied ffprobe/ffmpeg, the transcript must contain words of the clip with valid timings.

Each run ends with SIGTERM (in run 2 while a job is running); the worker and every process it
started must be gone afterwards. A worker is also stopped if the test itself fails.

Network: every proxy variable points at a local "sentinel" that refuses (HTTP 403) and records
each request. Nothing may be requested while starting and answering /health, nor while
transcribing with the model on disk. The only download is that of the `tiny` model, done before
any worker starts (needs `huggingface_hub`, so run this script with the build venv's Python).

Every acceptance check is required: a missing fixture, model or tool FAILS the run, unless it is
named in `--allow-missing` (model, clip, dng, ffmpeg, tesseract), which turns that absence into a
reported skip. Exit code 0 when every required check passed. `--report` writes the results as JSON.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DOWNLOADED = REPO / "tests" / "fixtures" / "downloaded"
SPEECH_CLIP = DOWNLOADED / "librispeech-voices-sp0307-sg0042.wav"
DNG_FILE = DOWNLOADED / "canon-eos-5d-mark-iii-14bit.dng"
# The clip says "I had that curiosity beside me at this moment." The tiny model must get at least
# two of these words right.
CLIP_WORDS = ("curiosity", "beside", "moment")
TOKEN = "smoke-" + os.urandom(16).hex()
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # our own requests never use a proxy
ABSENCES = ("model", "clip", "dng", "ffmpeg", "tesseract", "gallery-dl")


class Results:
    def __init__(self, allow_missing: set[str]) -> None:
        self.checks: list[dict] = []
        self.info: dict = {}
        self.allow_missing = allow_missing

    def check(self, name: str, ok: bool, detail: object = None) -> bool:
        self.checks.append({"name": name, "status": "pass" if ok else "fail", "detail": detail})
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail not in (None, "") else ""), flush=True)
        return ok

    def missing(self, name: str, what: str, reason: str) -> None:
        """A check that could not run because `what` is absent: a failure unless allowed."""
        if what in self.allow_missing:
            self.checks.append({"name": name, "status": "skipped", "detail": f"{reason} (allowed by --allow-missing {what})"})
            print(f"  SKIP {name} — {reason} (allowed by --allow-missing {what})", flush=True)
        else:
            self.check(name, False, f"{reason}; name it in --allow-missing to skip this check")

    @property
    def failed(self) -> list[str]:
        return [c["name"] for c in self.checks if c["status"] == "fail"]


# ---------- network sentinel ----------


class Sentinel:
    """A local HTTP proxy that refuses everything (403) and records what was asked for."""

    def __init__(self) -> None:
        self.requests: list[str] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def _refuse(self) -> None:
                outer.requests.append(f"{self.command} {self.path}")
                self.send_response(403, "blocked by smoke test")
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

            do_CONNECT = do_GET = do_HEAD = do_POST = _refuse  # noqa: N815

            def log_message(self, *a) -> None:  # noqa: ANN002
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def take(self) -> list[str]:
        out, self.requests = self.requests, []
        return out

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


# ---------- the worker ----------


class Worker:
    def __init__(self, exe: Path, env: dict, cwd: Path):
        t0 = time.monotonic()
        self.proc = subprocess.Popen([str(exe)], cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
        self.stderr: list[str] = []
        threading.Thread(target=self._drain, daemon=True).start()
        line = self.proc.stdout.readline()  # the ready line
        self.start_sec = time.monotonic() - t0
        if not line.startswith("AO_WORKER_READY port="):
            self.kill()
            raise RuntimeError(f"no ready line (got {line!r}); stderr: {' | '.join(self.stderr[-10:])}")
        self.port = int(line.strip().split("=", 1)[1])
        self.base = f"http://127.0.0.1:{self.port}"

    def _drain(self) -> None:
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

    def kill(self) -> None:
        """Stops the worker however the test ended (SIGTERM, then SIGKILL)."""
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(10)

    def request(self, method: str, path: str, body: object | None = None, auth: bool = True):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if auth:
            req.add_header("Authorization", f"Bearer {TOKEN}")
        try:
            with DIRECT.open(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def submit(self, type_: str, input_: Path, output: Path, params: dict | None = None) -> str:
        status, body = self.request("POST", "/jobs", {"type": type_, "input": str(input_), "output": str(output), "params": params or {}})
        if status != 202:
            raise RuntimeError(f"submit {type_}: {status} {body}")
        return body["id"]

    def wait(self, job_id: str, timeout: float, until=("done", "failed", "cancelled")) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, job = self.request("GET", f"/jobs/{job_id}")
            if status != 200:
                raise RuntimeError(f"job {job_id}: {status} {job}")
            if job["status"] in until:
                return job
            time.sleep(0.1)
        raise RuntimeError(f"job {job_id} not finished after {timeout} s")

    def run(self, type_: str, input_: Path, output: Path, params: dict | None = None, timeout: float = 300) -> dict:
        return self.wait(self.submit(type_, input_, output, params), timeout)


def descendants(pid: int) -> set[int]:
    """Every process below `pid` (via `ps`, which works the same on Linux and macOS)."""
    r = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, check=True)
    children: dict[int, list[int]] = {}
    for line in r.stdout.split("\n"):
        parts = line.split()
        if len(parts) == 2:
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    out, todo = set(), [pid]
    while todo:
        for c in children.get(todo.pop(), []):
            if c not in out:
                out.add(c)
                todo.append(c)
    return out


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(r.stdout.strip()) and not r.stdout.strip().startswith("Z")


# ---------- fixtures and independent checks of outputs ----------


def make_fixtures(d: Path, ffmpeg: str | None) -> dict:
    """A HEIC photo (with content, rotated by EXIF), an image-only PDF and (with ffmpeg) two videos.
    Made with this Python's pillow / pillow-heif and the system ffmpeg; the worker never sees them."""
    import pillow_heif
    from PIL import Image, ImageDraw, ImageFont

    pillow_heif.register_heif_opener()
    out: dict = {}
    heic = d / "IMG_0001.HEIC"
    img = Image.linear_gradient("L").resize((2016, 1512)).convert("RGB")
    draw = ImageDraw.Draw(img)
    draw.rectangle((200, 200, 900, 700), fill=(200, 40, 40))
    draw.ellipse((1100, 600, 1800, 1300), fill=(40, 160, 60))
    exif = Image.Exif()
    exif[0x010F] = "Apple"
    exif[0x0112] = 6  # display rotated 90°: the 2016×1512 photo shows as 1512×2016
    img.save(heic, format="HEIF", exif=exif.tobytes(), quality=60)
    out["heic"] = heic

    # Three pages, so ocrmypdf (--jobs 2) works on pages in parallel and runs tesseract per page.
    # (ocrmypdf 17 uses threads by default, so no process pool is started; entry.py still calls
    # multiprocessing.freeze_support() in case one ever is.)
    pages = []
    for word in ("ARCHIVE", "LEDGER", "FOLIO"):
        page = Image.new("RGB", (1700, 2200), "white")
        ImageDraw.Draw(page).text((200, 300), word, fill="black", font=ImageFont.load_default(size=160))
        pages.append(page)
    pdf = d / "scan.pdf"
    pages[0].save(pdf, "PDF", resolution=200, save_all=True, append_images=pages[1:])
    out["pdf"] = pdf

    if ffmpeg:
        for name, dur, size in (("clip.mov", 2, "640x480"), ("long.mov", 120, "1920x1080")):
            p = d / name
            subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30:duration={dur}",
                            "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
                            "-c:v", "mpeg4", "-q:v", "5", "-c:a", "pcm_s16le", str(p)], check=True)
            out[name.split(".")[0]] = p
    return out


def inspect_jpeg(path: Path, max_edge: int, portrait: bool | None) -> tuple[bool, dict]:
    """Decodes the proxy with Pillow (not the worker): JPEG, longest edge `max_edge`, orientation,
    and not blank (pixel values vary)."""
    from PIL import Image, ImageStat

    if not path.is_file():
        return False, {"error": "no output file"}
    with Image.open(path) as im:
        im.load()
        fmt, (w, h) = im.format, im.size
        spread = max(ImageStat.Stat(im.convert("L")).stddev)
    facts = {"format": fmt, "width": w, "height": h, "stddev": round(spread, 1)}
    ok = fmt == "JPEG" and max(w, h) == max_edge and spread > 10
    if portrait is not None:
        ok = ok and (h > w) == portrait
    return ok, facts


def probe(ffprobe: Path, path: Path) -> dict:
    r = subprocess.run([str(ffprobe), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                       capture_output=True, text=True)
    return json.loads(r.stdout or "{}") if r.returncode == 0 else {}


def inspect_video(bin_: Path, src: Path, out: Path, height: int) -> tuple[bool, dict]:
    """Probes the proxy with the supplied ffprobe and decodes every frame with the supplied ffmpeg."""
    if not out.is_file():
        return False, {"error": "no output file"}
    info, src_info = probe(bin_ / "ffprobe", out), probe(bin_ / "ffprobe", src)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), {})
    dur, src_dur = float(info.get("format", {}).get("duration") or 0), float(src_info.get("format", {}).get("duration") or 0)
    decode = subprocess.run([str(bin_ / "ffmpeg"), "-v", "error", "-i", str(out), "-f", "null", "-"], capture_output=True, text=True)
    facts = {"container": info.get("format", {}).get("format_name"), "video": v.get("codec_name"), "audio": a.get("codec_name"),
             "height": v.get("height"), "duration": round(dur, 2), "inputDuration": round(src_dur, 2),
             "decodes": decode.returncode == 0 and not decode.stderr.strip()}
    ok = ("mp4" in (facts["container"] or "") and facts["video"] == "h264" and facts["audio"] == "aac"
          and facts["height"] == height and src_dur > 0 and abs(dur - src_dur) <= 0.25 and facts["decodes"])
    return ok, facts


def inspect_transcript(out: Path, duration: float) -> tuple[bool, dict]:
    seg_file, vtt_file = out / "segments.json", out / "transcript.vtt"
    if not seg_file.is_file() or not vtt_file.is_file():
        return False, {"error": "no transcript files"}
    segs = json.loads(seg_file.read_text(encoding="utf-8"))
    text = " ".join(s.get("text", "") for s in segs)
    found = [w for w in CLIP_WORDS if w in text.lower()]
    timed = [s for s in segs if 0 <= s.get("start", -1) < s.get("end", -1) <= duration + 0.5]
    vtt = vtt_file.read_text(encoding="utf-8")
    facts = {"segments": len(segs), "timedSegments": len(timed), "wordsFound": found, "text": text.strip()[:80]}
    return len(found) >= 2 and bool(timed) and vtt.startswith("WEBVTT") and "-->" in vtt, facts


def wav_duration(path: Path) -> float:
    import wave

    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def ensure_model(models: Path, allow_download: bool) -> tuple[bool, str]:
    """Makes sure faster-whisper's `tiny` model is in `models` (Hugging Face cache layout)."""
    try:
        from faster_whisper.utils import download_model
    except ImportError:
        return False, "faster_whisper not importable in the smoke test's Python; cannot check or fetch the model"
    try:
        path = download_model("tiny", cache_dir=str(models), local_files_only=True)
        if (Path(path) / "model.bin").is_file():
            return True, f"tiny model already on disk ({Path(path).name})"
    except Exception:  # noqa: BLE001 - not cached
        pass
    if not allow_download:
        return False, "tiny model not on disk and --no-model-download given"
    try:
        path = download_model("tiny", cache_dir=str(models))
        return True, f"tiny model downloaded before the worker started ({Path(path).name})"
    except Exception as e:  # noqa: BLE001
        return False, f"tiny model could not be downloaded: {type(e).__name__}"


# ---------- the runs ----------


def clean_env(root: Path, path: str, models: Path, tools: Path, proxy: str) -> dict:
    """What the shell will pass (startWorker's allowlist), with nothing from this machine's Python."""
    home = root / "home"
    tmp = root / "tmp"
    home.mkdir(exist_ok=True)
    tmp.mkdir(exist_ok=True)
    env = {
        "PATH": path, "HOME": str(home), "TMPDIR": str(tmp), "LANG": "C.UTF-8",
        "AO_WORKER_TOKEN": TOKEN, "AO_WORKER_PORT": "0", "AO_WORKER_EXIT_ON_STDIN_EOF": "1",
        "AO_MODELS_DIR": str(models), "AO_TOOLS_DIR": str(tools), "PYTHONUNBUFFERED": "1",
    }
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env[k] = proxy
    env["NO_PROXY"] = env["no_proxy"] = ""
    return env


def sigterm_check(res: Results, w: Worker, label: str, job_id: str | None) -> None:
    if job_id:
        w.wait(job_id, 60, until=("running", "done", "failed", "cancelled"))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not descendants(w.proc.pid):
            time.sleep(0.1)
    before = descendants(w.proc.pid)
    if job_id:
        res.check(f"{label}: a job's child process is running before SIGTERM", bool(before), f"{len(before)} process(es)")
    t0 = time.monotonic()
    w.proc.send_signal(signal.SIGTERM)
    try:
        rc = w.proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        w.proc.kill()
        rc = None
    elapsed = time.monotonic() - t0
    res.check(f"{label}: SIGTERM ends the worker", rc == 0, f"exit {rc} after {elapsed:.1f} s")
    deadline = time.monotonic() + 6  # the worker's kill grace is 3 s
    left = {p for p in before if alive(p)}
    while left and time.monotonic() < deadline:
        time.sleep(0.2)
        left = {p for p in left if alive(p)}
    res.check(f"{label}: no child process left behind", not left, f"left: {sorted(left)}" if left else None)


def run_without_tools(res: Results, exe: Path, root: Path, fx: dict) -> None:
    print("run 1: no tools, no models", flush=True)
    sentinel = Sentinel()
    empty, models, tools, out = root / "empty-bin", root / "models-empty", root / "tools-empty", root / "out1"
    for d in (empty, models, tools):
        d.mkdir()
    w = Worker(exe, clean_env(root, str(empty), models, tools, sentinel.url), cwd=root)
    try:
        res.info["startSec"] = [round(w.start_sec, 2)]
        res.check("starts and prints its ready line", True, f"{w.start_sec:.2f} s to ready line")
        status, health = w.request("GET", "/health")
        res.check("/health answers", status == 200 and health.get("ok") is True, health if status != 200 else None)
        v = health.get("versions", {}) if isinstance(health, dict) else {}
        res.info["healthVersions"] = v
        res.check("/health reports the bundled libraries",
                  all(v.get(k) for k in ("python", "faster_whisper", "pillow", "pillow_heif", "rawpy", "ocrmypdf")),
                  {k: v.get(k) for k in ("python", "faster_whisper", "pillow_heif", "rawpy", "ocrmypdf")})
        # gallery-dl is not inside the worker any more (GPL-2.0-only): a first-use download (Task 48a).
        res.check("/health reports ffmpeg, tesseract, yt-dlp and gallery-dl as absent",
                  all(v.get(k) is None for k in ("ffmpeg", "tesseract", "yt_dlp", "gallery_dl")),
                  {k: v.get(k) for k in ("ffmpeg", "tesseract", "yt_dlp", "gallery_dl")})
        status, cat = w.request("GET", "/tools")
        res.check("/tools lists the optional tools with nothing downloaded",
                  status == 200 and {t["id"] for t in cat.get("tools", [])} >= {"ffmpeg", "ocr", "video-downloader", "image-downloader", "speech-tiny"},
                  cat if status != 200 else None)
        status, _ = w.request("GET", "/health", auth=False)
        res.check("a request without the token is refused", status == 401, status)
        net = sentinel.take()
        res.check("no network request while starting and answering /health", not net, net or None)

        j = w.run("image.proxy", fx["heic"], out / "heic.jpg", {"maxEdge": 1024})
        ok, facts = inspect_jpeg(out / "heic.jpg", 1024, portrait=True) if j["status"] == "done" else (False, j.get("error"))
        res.check("HEIC photo → JPEG proxy (pillow-heif): decoded by Pillow, 1024 px, EXIF rotation applied, not blank", ok, facts)
        name = "DNG fixture → JPEG proxy (rawpy): decoded by Pillow, 1024 px, not blank"
        if DNG_FILE.exists():
            j = w.run("image.proxy", DNG_FILE, out / "dng.jpg", {"maxEdge": 1024})
            ok, facts = inspect_jpeg(out / "dng.jpg", 1024, portrait=None) if j["status"] == "done" else (False, j.get("error"))
            res.check(name, ok, facts)
        else:
            res.missing(name, "dng", "fixture missing: run `pnpm fetch-fixtures`")

        j = w.run("pdf.ocr", fx["pdf"], out / "ocr.pdf")
        res.check("OCR without tesseract fails clearly, naming the tool (TOOL_NOT_INSTALLED, ocr)",
                  j["status"] == "failed" and j["error"]["code"] == "TOOL_NOT_INSTALLED" and j["error"].get("tool") == "ocr", j.get("error"))
        res.info["ocrWithoutTesseract"] = j.get("error")

        name = "video proxy without ffmpeg fails (no crash)"
        if "clip" in fx:
            j = w.run("video.proxy", fx["clip"], out / "clip.mp4")
            res.check(name, j["status"] == "failed" and (j.get("error") or {}).get("tool") == "ffmpeg", j.get("error"))
            res.info["videoWithoutFfmpeg"] = j.get("error")
        else:
            res.missing(name, "ffmpeg", "no test video: this machine has no ffmpeg to make one")

        if SPEECH_CLIP.exists():
            j = w.run("audio.transcribe", SPEECH_CLIP, out / "t", {"model": "tiny", "language": "en"})
            err = j.get("error") or {}
            res.check("transcription with no model on disk: TOOL_NOT_INSTALLED naming speech-tiny, nothing downloaded",
                      j["status"] == "failed" and err.get("code") == "TOOL_NOT_INSTALLED" and err.get("tool") == "speech-tiny", err)
            res.info["transcribeWithoutModel"] = err
            res.info["networkTranscriptionWithoutModel"] = sentinel.take()
        sigterm_check(res, w, "run 1", None)
    finally:
        w.kill()
        sentinel.close()


def run_with_tools(res: Results, exe: Path, root: Path, fx: dict, models: Path, have_model: bool) -> None:
    print("run 2: ffmpeg, ffprobe and tesseract in the tools folder; tiny model on disk", flush=True)
    sentinel = Sentinel()
    tools = root / "tools"
    bin_ = tools / "bin"
    bin_.mkdir(parents=True)
    linked = []
    for name in ("ffmpeg", "ffprobe", "tesseract"):
        found = shutil.which(name)
        if found:
            os.symlink(found, bin_ / name)
            linked.append(name)
    res.info["toolsLinked"] = linked
    out = root / "out2"
    w = Worker(exe, clean_env(root, str(bin_), models, tools, sentinel.url), cwd=root)
    try:
        res.info["startSec"].append(round(w.start_sec, 2))
        status, health = w.request("GET", "/health")
        v = health.get("versions", {}) if isinstance(health, dict) else {}
        res.check("/health finds the supplied tools", all(v.get(n) for n in ("ffmpeg", "tesseract") if n in linked),
                  {k: v.get(k) for k in ("ffmpeg", "tesseract")})
        net = sentinel.take()
        res.check("no network request while starting and answering /health (run 2)", not net, net or None)

        name = "video proxy with ffmpeg from the tools folder: probed and decoded (MP4, H.264/AAC, 240 lines, input's duration)"
        if "ffmpeg" in linked and "ffprobe" in linked and "clip" in fx:
            j = w.run("video.proxy", fx["clip"], out / "clip.mp4", {"maxHeight": 240})
            ok, facts = inspect_video(bin_, fx["clip"], out / "clip.mp4", 240) if j["status"] == "done" else (False, j.get("error"))
            res.check(name, ok, facts)
        else:
            res.missing(name, "ffmpeg", "ffmpeg/ffprobe not on this machine")

        name = "OCR of 3 pages with tesseract from the tools folder (no ghostscript)"
        if "tesseract" in linked:
            j = w.run("pdf.ocr", fx["pdf"], out / "ocr.pdf")
            text = j.get("result", {}).get("meta", {}).get("sidecarText", "") if j["status"] == "done" else ""
            words = [x for x in ("ARCHIVE", "LEDGER", "FOLIO") if x in text.upper()]
            res.check(name, j["status"] == "done" and j["result"]["meta"]["pages"] == 3 and len(words) == 3,
                      {"pages": j["result"]["meta"]["pages"], "words": words} if j["status"] == "done" else j.get("error"))
        else:
            res.missing(name, "tesseract", "tesseract not on this machine")

        name = (f"transcription of the test clip with the tiny model on disk: at least 2 of {list(CLIP_WORDS)}, "
                "a timed segment, a VTT file")
        if not SPEECH_CLIP.exists():
            res.missing(name, "clip", "speech clip missing: run `pnpm fetch-fixtures`")
        elif not have_model:
            res.missing(name, "model", res.info.get("model", "tiny model not available"))
        else:
            sentinel.take()
            t0 = time.monotonic()
            j = w.run("audio.transcribe", SPEECH_CLIP, out / "t", {"model": "tiny", "language": "en"}, timeout=600)
            ok, facts = inspect_transcript(out / "t", wav_duration(SPEECH_CLIP)) if j["status"] == "done" else (False, j.get("error"))
            if isinstance(facts, dict):
                facts["sec"] = round(time.monotonic() - t0, 1)
            res.check(name, ok, facts)
            net = sentinel.take()
            res.check("no network request while transcribing with the model on disk (the proxy refuses everything)", not net, net or None)

        job = w.submit("video.proxy", fx["long"], out / "long.mp4") if "long" in fx and "ffmpeg" in linked else None
        sigterm_check(res, w, "run 2", job)
    finally:
        w.kill()
        sentinel.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--worker", required=True, type=Path, help="the packaged ao-worker executable")
    ap.add_argument("--models-dir", type=Path, default=Path(os.environ.get("AO_SMOKE_MODELS_DIR") or Path.home() / ".cache" / "ao-worker-smoke-models"),
                    help="where the tiny model is kept between runs (outside the bundle)")
    ap.add_argument("--no-model-download", action="store_true")
    ap.add_argument("--allow-missing", default="", help=f"comma-separated absences reported as skips instead of failures: {', '.join(ABSENCES)}")
    ap.add_argument("--report", type=Path)
    ap.add_argument("--gallery-dl-wheel", type=Path, help="the pinned gallery-dl wheel (ao_worker/toolpins.py), to check the bundle runs it")
    args = ap.parse_args()
    allow = {x.strip() for x in args.allow_missing.split(",") if x.strip()}
    if allow - set(ABSENCES):
        ap.error(f"--allow-missing takes {', '.join(ABSENCES)}; not {', '.join(sorted(allow - set(ABSENCES)))}")
    exe = args.worker.resolve()
    res = Results(allow)

    r = subprocess.run([str(exe), "--self-check"], capture_output=True, text=True, env={"PATH": os.devnull, "HOME": tempfile.gettempdir()}, timeout=120)
    try:
        sc = json.loads(r.stdout)
    except ValueError:
        sc = {"ok": False, "stdout": r.stdout[-500:], "stderr": r.stderr[-500:]}
    res.check("self-check imports every native library (incl. pikepdf, rawpy, onnxruntime, cryptography, Silero VAD)", sc.get("ok"), sc.get("failed") or None)
    res.info["selfCheck"] = sc.get("versions")
    r = subprocess.run([str(exe), "-m", "gallery_dl", "--version"], capture_output=True, text=True, env={"PATH": os.devnull}, timeout=60)
    res.check("gallery-dl is not inside the bundle (GPL-2.0-only; a first-use download)", r.returncode != 0, r.stdout.strip() or r.stderr[-300:])
    name = "a downloaded gallery-dl runs with the bundle's Python (`ao-worker -m gallery_dl`, AO_GALLERYDL_LIB)"
    if args.gallery_dl_wheel:
        lib = Path(tempfile.mkdtemp(prefix="ao-smoke-gdl-")) / "lib"
        import zipfile

        with zipfile.ZipFile(args.gallery_dl_wheel) as z:
            z.extractall(lib)  # our own pinned wheel, checked by the caller
        env = {"PATH": os.devnull, "AO_GALLERYDL_LIB": str(lib)}
        r = subprocess.run([str(exe), "-m", "gallery_dl", "--version"], capture_output=True, text=True, env=env, timeout=60)
        res.check(name, r.returncode == 0, r.stdout.strip() or r.stderr[-300:])
        r = subprocess.run([str(exe), "-m", "gallery_dl", "--list-extractors"], capture_output=True, text=True, env=env, timeout=120)
        res.check("the downloaded gallery-dl finds its extractors and the standard library it needs", r.returncode == 0 and "instagram" in r.stdout.lower(),
                  f"{r.stdout.count(chr(10))} lines" if r.returncode == 0 else r.stderr[-300:])
    else:
        res.missing(name, "gallery-dl", "pass --gallery-dl-wheel <the pinned gallery_dl-1.32.19-py3-none-any.whl>")
    r = subprocess.run([str(exe), "--version"], capture_output=True, text=True, env={"PATH": os.devnull}, timeout=60)
    res.check("anything else is refused (not a general interpreter)", r.returncode == 2, r.returncode)

    args.models_dir.mkdir(parents=True, exist_ok=True)
    have_model, how = ensure_model(args.models_dir, not args.no_model_download)
    res.info["model"] = how
    print(f"model: {how}", flush=True)

    with tempfile.TemporaryDirectory(prefix="ao-worker-smoke-") as tmp:
        root = Path(tmp)
        fxdir = root / "fixtures"
        fxdir.mkdir()
        fx = make_fixtures(fxdir, shutil.which("ffmpeg"))
        run_without_tools(res, exe, root, fx)
        run_with_tools(res, exe, root, fx, args.models_dir, have_model)

    failed = res.failed
    skipped = [c["name"] for c in res.checks if c["status"] == "skipped"]
    res.info["ok"] = not failed
    if args.report:
        args.report.write_text(json.dumps({"checks": res.checks, "info": res.info}, indent=1, default=str))
    passed = sum(c["status"] == "pass" for c in res.checks)
    print(f"smoke test: {'PASSED' if not failed else 'FAILED'} ({passed}/{len(res.checks)} checks passed"
          + (f", {len(skipped)} SKIPPED: {'; '.join(skipped)}" if skipped else "") + ")"
          + (f"; failed: {'; '.join(failed)}" if failed else ""), flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
