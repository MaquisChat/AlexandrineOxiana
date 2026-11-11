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

Each run ends with SIGTERM while a job is running; the worker and every process it started must be
gone afterwards.

Network: every proxy variable points at a local "sentinel" that refuses and records each request.
Nothing may be requested while starting and answering /health. Then the sentinel's port is closed,
so every later request is refused as on a machine with no network. The only download is the optional
one of the `tiny` model, done before any worker starts (needs `huggingface_hub`, so run this
script with the build venv's Python; it is not used by the worker).

Exit code 0 when every required check passed. `--report` writes the results as JSON.
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
TOKEN = "smoke-" + os.urandom(16).hex()
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # our own requests never use a proxy


class Results:
    def __init__(self) -> None:
        self.checks: list[dict] = []
        self.info: dict = {}

    def check(self, name: str, ok: bool, detail: object = None, required: bool = True) -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "required": required, "detail": detail})
        mark = "PASS" if ok else ("FAIL" if required else "WARN")
        print(f"  {mark} {name}" + (f" — {detail}" if detail not in (None, "") else ""), flush=True)
        return ok

    @property
    def ok(self) -> bool:
        return all(c["ok"] for c in self.checks if c["required"])


# ---------- network sentinel ----------


class Sentinel:
    """A local HTTP proxy that refuses everything and records what was asked for."""

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

    def go_offline(self) -> None:
        """Closes the port: from now on a request is refused, as on a machine with no network
        (huggingface_hub falls back to the model on disk only for that kind of failure)."""
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
            self.proc.kill()
            raise RuntimeError(f"no ready line (got {line!r}); stderr: {' | '.join(self.stderr[-10:])}")
        self.port = int(line.strip().split("=", 1)[1])
        self.base = f"http://127.0.0.1:{self.port}"

    def _drain(self) -> None:
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

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
    # A zombie child of ours counts as gone once reaped; ps shows the state.
    r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(r.stdout.strip()) and not r.stdout.strip().startswith("Z")


# ---------- fixtures ----------


def make_fixtures(d: Path, ffmpeg: str | None) -> dict:
    """A HEIC photo, an image-only PDF and (with ffmpeg) two videos. Made with this Python's
    pillow / pillow-heif and the system ffmpeg; the worker never sees these tools."""
    import pillow_heif
    from PIL import Image, ImageDraw, ImageFont

    pillow_heif.register_heif_opener()
    out: dict = {}
    heic = d / "IMG_0001.HEIC"
    img = Image.new("RGB", (2016, 1512), (40, 120, 200))
    exif = Image.Exif()
    exif[0x010F] = "Apple"
    exif[0x0112] = 6
    img.save(heic, format="HEIF", exif=exif.tobytes(), quality=50)
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


def ensure_model(models: Path, allow_download: bool) -> tuple[bool, str]:
    """Makes sure faster-whisper's `tiny` model is in `models` (Hugging Face cache layout)."""
    try:
        from faster_whisper.utils import download_model
    except ImportError:
        return False, "faster_whisper not importable in the smoke test's Python; cannot check or fetch the model"
    try:
        path = download_model("tiny", cache_dir=str(models), local_files_only=True)
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


def run_without_tools(res: Results, exe: Path, root: Path, fx: dict, dng: Path | None) -> None:
    print("run 1: no tools, no models", flush=True)
    sentinel = Sentinel()
    empty = root / "empty-bin"
    empty.mkdir()
    models = root / "models-empty"
    tools = root / "tools-empty"
    models.mkdir()
    tools.mkdir()
    out = root / "out1"
    w = Worker(exe, clean_env(root, str(empty), models, tools, sentinel.url), cwd=root)
    res.info["startSec"] = [round(w.start_sec, 2)]
    res.check("starts and prints its ready line", True, f"{w.start_sec:.2f} s to ready line")
    status, health = w.request("GET", "/health")
    res.check("/health answers", status == 200 and health.get("ok") is True, health if status != 200 else None)
    v = health.get("versions", {}) if isinstance(health, dict) else {}
    res.info["healthVersions"] = v
    res.check("/health reports the bundled libraries",
              all(v.get(k) for k in ("python", "faster_whisper", "pillow", "pillow_heif", "rawpy", "ocrmypdf", "gallery_dl")),
              {k: v.get(k) for k in ("python", "faster_whisper", "pillow_heif", "rawpy", "ocrmypdf", "gallery_dl")})
    res.check("/health reports ffmpeg, tesseract and yt-dlp as absent",
              v.get("ffmpeg") is None and v.get("tesseract") is None and v.get("yt_dlp") is None,
              {k: v.get(k) for k in ("ffmpeg", "tesseract", "yt_dlp")})
    status, _ = w.request("GET", "/health", auth=False)
    res.check("a request without the token is refused", status == 401, status)
    net = sentinel.take()
    res.check("no network request while starting and answering /health", not net, net or None)
    sentinel.go_offline()

    j = w.run("image.proxy", fx["heic"], out / "heic.jpg", {"maxEdge": 1024})
    res.check("image proxy of a HEIC photo (pillow-heif)", j["status"] == "done" and (out / "heic.jpg").stat().st_size > 0,
              j.get("result", {}).get("meta") if j["status"] == "done" else j.get("error"))
    if dng:
        j = w.run("image.proxy", dng, out / "dng.jpg", {"maxEdge": 1024})
        res.check("image proxy of the DNG fixture (rawpy)", j["status"] == "done" and (out / "dng.jpg").stat().st_size > 0,
                  j.get("result", {}).get("meta") if j["status"] == "done" else j.get("error"))
    else:
        res.check("image proxy of the DNG fixture (rawpy)", False, "fixture missing: run `pnpm fetch-fixtures`", required=False)

    j = w.run("pdf.ocr", fx["pdf"], out / "ocr.pdf")
    res.check("OCR without tesseract fails clearly", j["status"] == "failed" and j["error"]["code"] == "MISSING_DEPENDENCY", j.get("error"))
    res.info["ocrWithoutTesseract"] = j.get("error")

    if "clip" in fx:
        j = w.run("video.proxy", fx["clip"], out / "clip.mp4")
        res.check("video proxy without ffmpeg fails (no crash)", j["status"] == "failed", j.get("error"))
        res.info["videoWithoutFfmpeg"] = j.get("error")

    clip = REPO / "tests" / "fixtures" / "downloaded" / "librispeech-voices-sp0307-sg0042.wav"
    if clip.exists():
        j = w.run("audio.transcribe", clip, out / "t", {"model": "tiny", "language": "en"})
        res.check("transcription with no model on disk fails clearly (ctranslate2 loaded)",
                  j["status"] == "failed" and j["error"]["code"] == "MODEL_UNAVAILABLE", j.get("error"))
        res.info["transcribeWithoutModel"] = j.get("error")
    sigterm_check(res, w, "run 1", None)


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
    res.info["startSec"].append(round(w.start_sec, 2))
    status, health = w.request("GET", "/health")
    v = health.get("versions", {}) if isinstance(health, dict) else {}
    res.check("/health finds the supplied tools", all(v.get(n) for n in ("ffmpeg", "tesseract") if n in linked),
              {k: v.get(k) for k in ("ffmpeg", "tesseract")})
    net = sentinel.take()
    res.check("no network request while starting and answering /health (run 2)", not net, net or None)
    sentinel.go_offline()

    if "ffmpeg" in linked and "ffprobe" in linked and "clip" in fx:
        j = w.run("video.proxy", fx["clip"], out / "clip.mp4", {"maxHeight": 240})
        res.check("video proxy with ffmpeg from the tools folder", j["status"] == "done" and j["result"]["meta"]["height"] == 240,
                  j.get("result", {}).get("meta") if j["status"] == "done" else j.get("error"))
    else:
        res.check("video proxy with ffmpeg from the tools folder", False, "ffmpeg/ffprobe not on this machine")

    if "tesseract" in linked:
        j = w.run("pdf.ocr", fx["pdf"], out / "ocr.pdf")
        text = j.get("result", {}).get("meta", {}).get("sidecarText", "") if j["status"] == "done" else ""
        words = [w for w in ("ARCHIVE", "LEDGER", "FOLIO") if w in text.upper()]
        res.check("OCR of 3 pages with tesseract from the tools folder (no ghostscript)",
                  j["status"] == "done" and j["result"]["meta"]["pages"] == 3 and len(words) == 3,
                  {"pages": j["result"]["meta"]["pages"], "words": words} if j["status"] == "done" else j.get("error"))
    else:
        res.check("OCR with tesseract from the tools folder (no ghostscript)", False, "tesseract not on this machine")

    clip = REPO / "tests" / "fixtures" / "downloaded" / "librispeech-voices-sp0307-sg0042.wav"
    if have_model and clip.exists():
        t0 = time.monotonic()
        j = w.run("audio.transcribe", clip, out / "t", {"model": "tiny", "language": "en"}, timeout=600)
        ok = j["status"] == "done" and (out / "t" / "segments.json").exists()
        segs = json.loads((out / "t" / "segments.json").read_text()) if ok else []
        res.check("transcription of the test clip with the tiny model on disk", ok and len(segs) > 0,
                  {"segments": len(segs), "sec": round(time.monotonic() - t0, 1),
                   "text": " ".join(s["text"] for s in segs)[:60]} if ok else j.get("error"))
    else:
        res.check("transcription of the test clip with the tiny model on disk", False,
                  "model or clip not available; run 1 proved ctranslate2 loads and reports MODEL_UNAVAILABLE", required=False)

    job = w.submit("video.proxy", fx["long"], out / "long.mp4") if "long" in fx and "ffmpeg" in linked else None
    sigterm_check(res, w, "run 2", job)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--worker", required=True, type=Path, help="the packaged ao-worker executable")
    ap.add_argument("--models-dir", type=Path, default=Path(os.environ.get("AO_SMOKE_MODELS_DIR") or Path.home() / ".cache" / "ao-worker-smoke-models"),
                    help="where the tiny model is kept between runs (outside the bundle)")
    ap.add_argument("--no-model-download", action="store_true")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()
    exe = args.worker.resolve()
    res = Results()

    r = subprocess.run([str(exe), "--self-check"], capture_output=True, text=True, env={"PATH": os.devnull, "HOME": tempfile.gettempdir()}, timeout=120)
    try:
        sc = json.loads(r.stdout)
    except ValueError:
        sc = {"ok": False, "stdout": r.stdout[-500:], "stderr": r.stderr[-500:]}
    res.check("self-check imports every native library (incl. pikepdf, rawpy, onnxruntime, cryptography, Silero VAD)", sc.get("ok"), sc.get("failed") or None)
    res.info["selfCheck"] = sc.get("versions")
    r = subprocess.run([str(exe), "-m", "gallery_dl", "--version"], capture_output=True, text=True, env={"PATH": os.devnull}, timeout=60)
    res.check("gallery-dl runs from the bundle (`ao-worker -m gallery_dl`)", r.returncode == 0, r.stdout.strip() or r.stderr[-300:])
    r = subprocess.run([str(exe), "-m", "gallery_dl", "--list-extractors"], capture_output=True, text=True, env={"PATH": os.devnull}, timeout=120)
    res.check("gallery-dl finds its extractors (imported by name at run time)", r.returncode == 0 and "instagram" in r.stdout.lower(),
              f"{r.stdout.count(chr(10))} lines" if r.returncode == 0 else r.stderr[-300:])
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
        dng = REPO / "tests" / "fixtures" / "downloaded" / "canon-eos-5d-mark-iii-14bit.dng"
        run_without_tools(res, exe, root, fx, dng if dng.exists() else None)
        run_with_tools(res, exe, root, fx, args.models_dir, have_model)

    res.info["ok"] = res.ok
    if args.report:
        args.report.write_text(json.dumps({"checks": res.checks, "info": res.info}, indent=1, default=str))
    failed = [c["name"] for c in res.checks if c["required"] and not c["ok"]]
    print(f"smoke test: {'PASSED' if not failed else 'FAILED'} ({sum(c['ok'] for c in res.checks)}/{len(res.checks)} checks)"
          + (f"; failed: {'; '.join(failed)}" if failed else ""), flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
