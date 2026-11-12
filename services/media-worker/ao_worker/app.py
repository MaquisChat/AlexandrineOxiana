"""HTTP API (JSON, 127.0.0.1 only, bearer token). See README for the endpoints."""
from __future__ import annotations

import hmac
import json
import logging
import os
import platform
import re
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata

from . import download, image_proxy, ocr, tools, transcribe, video_proxy
from .jobs import JOB_TYPES, TOOL_JOB_TYPES, JobError, JobManager
from .location import LOCATION_MODES

log = logging.getLogger("ao_worker.app")

MAX_BODY = 1 << 20
_JOB_PATH = re.compile(r"^/jobs/([A-Za-z0-9-]{1,64})$")
_CANCEL_PATH = re.compile(r"^/jobs/([A-Za-z0-9-]{1,64})/cancel$")
_TOOL_PATH = re.compile(r"^/tools/([a-z0-9-]{1,64})/(install|update|remove)$")

HANDLERS = {
    "audio.transcribe": transcribe.run,
    "capture.download": download.run,
    "image.proxy": image_proxy.run,
    "video.proxy": video_proxy.run,
    "pdf.ocr": ocr.run,
    **{t: tools.run for t in TOOL_JOB_TYPES},
}


class BadRequest(Exception):
    pass


def _pkg(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


@lru_cache(maxsize=1)
def _static_versions() -> dict:
    return {
        "python": platform.python_version(),
        "faster_whisper": _pkg("faster-whisper"),
        "pillow": _pkg("pillow"),
        "pillow_heif": _pkg("pillow-heif"),
        "rawpy": _pkg("rawpy"),
        "ocrmypdf": _pkg("ocrmypdf"),
    }


def _program_version(name: str, flag: str, pattern: str) -> str | None:
    """ffmpeg / tesseract as the jobs find them (the tools folder first); cached until the file changes."""
    path = tools.which(name)
    if path is None:
        return None
    m = re.search(pattern, tools.run_version([path, flag]) or "")
    return m.group(1) if m else None


def versions() -> dict:
    return {
        **_static_versions(),
        "ffmpeg": _program_version("ffmpeg", "-version", r"ffmpeg version (\S+)"),
        "tesseract": _program_version("tesseract", "--version", r"tesseract v?(\S+)"),
        "yt_dlp": download.ytdlp_version(),
        "gallery_dl": download.gallerydl_version(),
    }


# ---------- validation ----------


def _num(params: dict, key: str, lo: float, hi: float, integer: bool = True) -> None:
    if key in params:
        v = params[key]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (integer and not float(v).is_integer()) or not lo <= v <= hi:
            raise BadRequest(f"params.{key} must be a number between {lo} and {hi}")


def _enum(params: dict, key: str, values) -> None:
    if key in params and params[key] not in values:
        raise BadRequest(f"params.{key} must be one of {', '.join(map(str, values))}")


def _bool(params: dict, key: str) -> None:
    if key in params and not isinstance(params[key], bool):
        raise BadRequest(f"params.{key} must be a boolean")


def validate_job(body: object) -> tuple[str, str, str, dict]:
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    type_, input_, output, params = body.get("type"), body.get("input"), body.get("output"), body.get("params", {})
    if type_ not in JOB_TYPES:
        raise BadRequest(f"type must be one of {', '.join(JOB_TYPES)}")
    if not isinstance(input_, str) or not input_ or "\0" in input_:
        raise BadRequest("input must be a string")
    if not isinstance(output, str) or not os.path.isabs(output) or "\0" in output:
        raise BadRequest("output must be an absolute path")
    if not isinstance(params, dict):
        raise BadRequest("params must be an object")
    if type_ == "capture.download":
        err = download.validate_params(input_, params)
        if err:
            raise BadRequest(err)
    else:
        if not os.path.isabs(input_):
            raise BadRequest("input must be an absolute path")
    if type_ == "audio.transcribe":
        _enum(params, "model", transcribe.MODELS)
        _enum(params, "computeType", transcribe.COMPUTE_TYPES)
        for k in ("multilingual", "vad", "wordTimestamps"):
            _bool(params, k)
        lang = params.get("language", "auto")
        if not isinstance(lang, str) or (lang != "auto" and lang not in transcribe.language_codes()):
            raise BadRequest("params.language must be 'auto' or a language code supported by the model")
    elif type_ == "image.proxy":
        _num(params, "maxEdge", 16, 16384)
        _num(params, "quality", 1, 100)
        _enum(params, "location", LOCATION_MODES)
    elif type_ == "video.proxy":
        _num(params, "maxHeight", 16, 4320)
        _num(params, "crf", 0, 51)
        _enum(params, "location", LOCATION_MODES)
        if "maxHeight" in params and params["maxHeight"] % 2:
            raise BadRequest("params.maxHeight must be even")
    elif type_ == "pdf.ocr":
        if "languages" in params and not ocr.valid_languages(params["languages"]):
            raise BadRequest("params.languages must be a list of tesseract language codes such as 'eng'")
    return type_, input_, output, params


# ---------- server ----------


class WorkerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, token: str, port: int, manager: JobManager):
        self.token = token.encode()
        self.manager = manager
        super().__init__(("127.0.0.1", port), Handler)


class Handler(BaseHTTPRequestHandler):
    server: WorkerServer
    server_version = "ao-worker"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - signature from the base class
        log.debug("%s %s", self.command, self.path.split("?", 1)[0])

    def _send(self, status: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send(status, {"error": {"code": code, "message": message}})

    def _authorized(self) -> bool:
        h = self.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            return False
        return hmac.compare_digest(h[7:].strip().encode(), self.server.token)

    def _body(self) -> object:
        raw_len = (self.headers.get("Content-Length") or "0").strip()
        if not raw_len.isdigit():
            raise BadRequest("invalid Content-Length")
        n = int(raw_len)
        if n > MAX_BODY:
            raise BadRequest("body too large")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError as e:
            raise BadRequest("body must be JSON") from e

    def _dispatch(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        if not self._authorized():
            self.close_connection = True  # the body (if any) is not read
            return self._error(401, "UNAUTHORIZED", "missing or invalid token")
        try:
            body = self._body() if method == "POST" else None
        except BadRequest as e:
            self.close_connection = True
            return self._error(400, "INVALID_REQUEST", str(e))
        try:
            if method == "GET" and path == "/health":
                return self._send(200, {"ok": True, "versions": versions()})
            if method == "POST" and path == "/jobs":
                type_, input_, output, params = validate_job(body)
                job = self.server.manager.submit(type_, input_, output, params)
                return self._send(202, {"id": job.id})
            if method == "GET" and path == "/tools":
                return self._send(200, tools.catalogue())
            m = _TOOL_PATH.match(path)
            if method == "POST" and m:
                if m.group(1) not in tools.toolpins.TOOLS:
                    return self._error(404, "UNKNOWN_TOOL", "there is no such tool")
                job = self.server.manager.submit(f"tool.{m.group(2)}", m.group(1), str(tools.tools_dir()), {})
                return self._send(202, {"id": job.id})
            if method == "POST" and path == "/tools/update":
                try:
                    return self._send(200, download.update_tools())
                except JobError as e:
                    return self._send(502, {"error": e.to_json()})
            m = _JOB_PATH.match(path)
            if method == "GET" and m:
                job = self.server.manager.get(m.group(1))
                return self._send(200, job.to_json()) if job else self._error(404, "NOT_FOUND", "no such job")
            m = _CANCEL_PATH.match(path)
            if method == "POST" and m:
                job = self.server.manager.cancel(m.group(1))
                return self._send(202, job.to_json()) if job else self._error(404, "NOT_FOUND", "no such job")
            return self._error(404, "NOT_FOUND", "no such endpoint")
        except BadRequest as e:
            return self._error(400, "INVALID_REQUEST", str(e))
        except Exception as e:  # noqa: BLE001
            log.error("request failed with %s", type(e).__name__)
            return self._error(500, "INTERNAL", "internal error")

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")


def make_server(token: str, port: int = 0) -> WorkerServer:
    if not token:
        raise ValueError("a token is required")
    tools.sweep()  # an install interrupted by a crash leaves nothing half-installed
    return WorkerServer(token, port, JobManager(HANDLERS))
