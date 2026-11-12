"""capture.download: yt-dlp (managed standalone binary) and gallery-dl (an optional download).

yt-dlp resolution order (ADR 0009): `AO_YTDLP_BIN`, then the managed binary in `AO_TOOLS_DIR`,
then `yt-dlp` on PATH. A capture never downloads it: when none exists the job fails with
`TOOL_NOT_INSTALLED` (tool `video-downloader`), and the first-use tools dialogue installs it
(`install_ytdlp`: the official standalone release, verified against that release's SHA2-256SUMS).
yt-dlp is told which JavaScript runtime to use (`--js-runtimes deno:<path>`, ADR 0014) whenever
one is installed. gallery-dl is no longer inside the worker (GPL-2.0-only): `AO_GALLERYDL_BIN`, else
the app's own copy in the tools folder (tools.py), run as `python -m gallery_dl`; else the job fails
with `TOOL_NOT_INSTALLED` (tool `image-downloader`).

Comments (`includeComments`): yt-dlp `--write-comments` puts them in the info JSON; the worker moves
them to `<id>.comments.json` next to it (listed in `meta.comments`, never in `files` or `infoJson`).
gallery-dl has no comment support for the platforms used here: the option is ignored and
`meta.commentsUnsupported` is true.

An enumeration (`flatList` or `metadataOnly`) that stops with an error after writing metadata is
returned as partial (`meta.partial`, `meta.errorCode`), not failed.

Privacy: URLs are logged without query string, fragment or credentials; cookie options are never
logged; error details are redacted the same way.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from . import fetch
from .jobs import Job, JobCancelled, JobContext, JobError, child_env

log = logging.getLogger("ao_worker.download")

TOOLS = ("yt-dlp", "gallery-dl")
BROWSERS = ("chrome", "firefox", "safari", "edge", "brave")
# yt-dlp format selection per quality choice (best video+audio, falling back to the best single file).
QUALITY_FORMATS = {
    "best": "bv*+ba/b",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]/b",
    "720p": "bv*[height<=720]+ba/b[height<=720]/b",
}
DATE_RE = re.compile(r"^\d{8}$")
YTDLP_RELEASES = "https://github.com/yt-dlp/yt-dlp/releases/"
# Hosts the release files may come from (GitHub redirects downloads to its file host).
YTDLP_HOSTS = ("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")
# Largest file accepted as the yt-dlp program (it is about 38 MB) and as the checksum list.
YTDLP_MAX_BYTES = 200 * 1024 * 1024
SUMS_MAX_BYTES = 1024 * 1024
_TAG_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}(\.\d+)?$")

ERROR_CODES = ("LOGIN_REQUIRED", "RATE_LIMITED", "NOT_FOUND_OR_REMOVED", "GEO_BLOCKED", "PRIVATE", "EXTRACTOR_ERROR")

# First match wins; the order matters ("Private video. Sign in if ..." is PRIVATE, not LOGIN_REQUIRED).
_ERROR_PATTERNS = [
    ("PRIVATE", re.compile(r"private video|this (account|profile|user) is private|is private\b|private (account|profile|post)", re.I)),
    ("GEO_BLOCKED", re.compile(r"not (made this video )?available in your (country|region|location)|geo[- ]?(restrict|block)", re.I)),
    ("RATE_LIMITED", re.compile(r"\b429\b|too many requests|rate[- ]?limit", re.I)),
    ("LOGIN_REQUIRED", re.compile(
        r"sign in to confirm|log ?in required|login required|requires? (a )?log ?in|--cookies|authentication|"
        r"age[- ]?restricted|you need to log in|log in to", re.I)),
    ("NOT_FOUND_OR_REMOVED", re.compile(
        r"video unavailable|has been removed|\b404\b|not found|does not exist|no longer available|"
        r"has been deleted|account (has been )?(terminated|suspended)|unavailable", re.I)),
]


class ToolError(JobError):
    pass


# ---------- redaction ----------

_URL_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"<>]+")


def _strip_one(u: str) -> str:
    try:
        parts = urlsplit(u)
    except ValueError:
        return "<url>"
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def strip_url(text: str) -> str:
    """Every URL in `text` without credentials, query string or fragment."""
    return _URL_RE.sub(lambda m: _strip_one(m.group(0)), text)


def redact(text: str) -> str:
    """URLs stripped, the home folder shown as ~ (cookie stores and other user files live there)."""
    out = strip_url(text)
    home = str(Path.home())
    if len(home) > 1:
        out = out.replace(home, "~")
    return out


def map_error(stderr: str) -> str:
    lines = [l for l in stderr.splitlines() if "ERROR" in l]
    text = "\n".join(lines) if lines else stderr
    for code, pat in _ERROR_PATTERNS:
        if pat.search(text):
            return code
    return "EXTRACTOR_ERROR"


# ---------- yt-dlp binary management ----------


def tools_dir() -> Path:
    d = os.environ.get("AO_TOOLS_DIR")
    if d:
        return Path(d)
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "ao-worker" / "tools"


def ytdlp_asset_name() -> str:
    machine = platform.machine().lower()
    if sys.platform == "win32":
        return "yt-dlp_arm64.exe" if machine in ("arm64", "aarch64") else "yt-dlp.exe"
    if sys.platform == "darwin":
        return "yt-dlp_macos"
    return "yt-dlp_linux_aarch64" if machine in ("arm64", "aarch64") else "yt-dlp_linux"


def managed_ytdlp_path() -> Path:
    return tools_dir() / ("yt-dlp.exe" if sys.platform == "win32" else "yt-dlp")


def _fetch(url: str, cancelled=None) -> bytes:
    """A small file (the checksum list), downloaded like every tool file: the same redirect rules,
    connect and header limits, stall limit, deadline and cancel."""
    fd, tmp = tempfile.mkstemp(prefix=".yt-dlp.sums.", dir=tools_dir() if tools_dir().is_dir() else None)
    os.close(fd)
    os.unlink(tmp)  # fetch.download creates it itself (and only ever deletes what it created)
    try:
        try:
            fetch.download(url, Path(tmp), sha256=None, size=None, hosts=YTDLP_HOSTS, max_bytes=SUMS_MAX_BYTES, cancelled=cancelled)
        except fetch.ToolInstallError as e:
            if e.code == "TOOL_CHECKSUM_MISMATCH":
                raise ToolError("TOOL_DOWNLOAD_FAILED", "the yt-dlp checksum list is larger than expected") from e
            raise
        return Path(tmp).read_bytes()
    finally:
        Path(tmp).unlink(missing_ok=True)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003 - urllib's signature
        return None


def _latest_tag(cancelled=None) -> str:
    """The latest release tag, from the redirect of `releases/latest/download/SHA2-256SUMS`
    (→ `…/releases/download/<tag>/SHA2-256SUMS`)."""
    req = urllib.request.Request(YTDLP_RELEASES + "latest/download/SHA2-256SUMS", method="HEAD", headers={"User-Agent": fetch.USER_AGENT})
    location = ""
    try:
        r, _ = fetch.open_watched(lambda s: urllib.request.build_opener(_NoRedirect, *fetch.watched_handlers(s)), req, cancelled)
        r.close()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            location = e.headers.get("Location", "")
        else:
            raise
    tag = location.split("/releases/download/", 1)[-1].split("/", 1)[0] if "/releases/download/" in location else ""
    if not _TAG_RE.match(tag):
        raise ToolError("TOOL_DOWNLOAD_FAILED", "could not determine the latest yt-dlp release")
    return tag


def _download_ytdlp(dest: Path, progress=None, cancelled=None) -> None:
    """Downloads the official standalone yt-dlp release to `dest`, verified against SHA2-256SUMS
    before it is made executable; nothing is left behind on failure or cancel."""
    asset = ytdlp_asset_name()
    try:
        # One tag for both files, so a release published in between cannot mix checksums and binary.
        tag = _latest_tag(cancelled)
        base = f"{YTDLP_RELEASES}download/{tag}/"
        sums = _fetch(base + "SHA2-256SUMS", cancelled).decode("utf-8", "replace")
    except (ToolError, JobCancelled):
        raise
    except JobError as e:
        raise ToolError(e.code, e.message, e.detail) from e
    except (OSError, ValueError) as e:
        raise ToolError("TOOL_DOWNLOAD_FAILED", "yt-dlp could not be downloaded", type(e).__name__) from e
    expected = None
    for line in sums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == asset and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            expected = parts[0].lower()
    if expected is None:
        raise ToolError("TOOL_CHECKSUM_MISMATCH", "the yt-dlp release lists no checksum for this computer's program")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".yt-dlp.{os.getpid()}.{os.urandom(6).hex()}"
    try:
        try:
            fetch.download(base + asset, tmp, sha256=expected, size=None, hosts=YTDLP_HOSTS, max_bytes=YTDLP_MAX_BYTES,
                           progress=progress, cancelled=cancelled)
        except fetch.ToolInstallError as e:
            raise ToolError(e.code, e.message.replace("the download", "the yt-dlp download"), e.detail) from e
        os.chmod(tmp, 0o755)  # verified: only now is it made executable
        from .tools import _strip_quarantine

        _strip_quarantine(tmp)
        if tool_version([str(tmp)]) is None:
            raise ToolError("TOOL_UNUSABLE", "the downloaded yt-dlp does not run on this computer, so it was not installed")
        os.replace(tmp, dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    log.info("installed managed yt-dlp %s", tag)


def install_ytdlp(progress=None, cancelled=None) -> None:
    """The video downloader's first part (tools.py): the latest release into the tools folder."""
    _download_ytdlp(managed_ytdlp_path(), progress=progress, cancelled=cancelled)


def resolve_ytdlp(download: bool = False) -> tuple[str, bool] | None:
    """(path, managed). Env override, managed binary, PATH. With `download`, the latest release is
    installed when nothing else exists (only `POST /tools/update` asks for that; a capture never does)."""
    env = os.environ.get("AO_YTDLP_BIN")
    if env:
        return env, False
    managed = managed_ytdlp_path()
    if managed.is_file():
        return str(managed), True
    found = shutil.which("yt-dlp")
    if found:
        return found, False
    if not download:
        return None
    _download_ytdlp(managed)
    return str(managed), True


def gallerydl_cmd() -> tuple[list[str], dict[str, str]] | None:
    """(argv, extra environment) for gallery-dl: `AO_GALLERYDL_BIN`, else the app's own copy; None when neither."""
    env = os.environ.get("AO_GALLERYDL_BIN")
    if env:
        return [env], {}
    from .tools import gallerydl_env, gallerydl_lib

    lib = gallerydl_lib()
    if lib is None:
        return None
    return [sys.executable, "-m", "gallery_dl"], gallerydl_env(lib)


def tool_version(argv: list[str]) -> str | None:
    try:
        r = subprocess.run([*argv, "--version"], capture_output=True, text=True, timeout=30, env=child_env())
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    lines = r.stdout.strip().splitlines()
    return lines[0].strip() if lines else None


def ytdlp_version() -> str | None:
    r = resolve_ytdlp(download=False)
    return tool_version([r[0]]) if r else None


def gallerydl_version() -> str | None:
    cmd = gallerydl_cmd()
    if cmd is None:
        return None
    from .tools import run_version

    return run_version([*cmd[0], "--version"], cmd[1])


def update_tools() -> dict:
    """`POST /tools/update`: updates the managed yt-dlp; others are reported unchanged."""
    r = resolve_ytdlp(download=False)
    if r is None:
        _download_ytdlp(managed_ytdlp_path())
        r = (str(managed_ytdlp_path()), True)
        old = None
    else:
        old = tool_version([r[0]])
    path, managed = r
    if managed and old is not None:
        try:
            p = subprocess.run([path, "--update-to", "stable"], capture_output=True, text=True, timeout=600, env=child_env())
        except (OSError, subprocess.TimeoutExpired) as e:
            raise ToolError("TOOL_UPDATE_FAILED", "yt-dlp could not be updated", type(e).__name__) from e
        if p.returncode != 0:
            raise ToolError("TOOL_UPDATE_FAILED", "yt-dlp could not be updated", redact("\n".join((p.stderr or p.stdout).splitlines()[-5:])))
    new = tool_version([path])
    log.info("tools update: yt-dlp managed=%s %s -> %s", managed, old, new)
    return {
        "ytDlp": {"old": old, "new": new, "managed": managed},
        "galleryDl": {"version": gallerydl_version(), "pinned": True},
    }


# ---------- arguments ----------


def build_ytdlp_args(url: str, out: str, params: dict, js_runtime: str | None = None) -> list[str]:
    args = [
        "--ignore-config", "--newline", "--no-color",
        "-o", os.path.join(out, "%(id)s.%(ext)s"),
        "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", "all",
        "--write-thumbnail", "--no-overwrites",
        "--sleep-requests", "2", "--sleep-interval", "3", "--max-sleep-interval", "8",
        "--retries", "3",
    ]
    if params.get("archiveFile"):
        args += ["--download-archive", params["archiveFile"]]
    if params.get("flatList"):
        args.append("--flat-playlist")
    if params.get("maxItems"):
        args += ["--playlist-end", str(int(params["maxItems"]))]
    if params.get("dateAfter"):
        args += ["--dateafter", params["dateAfter"]]
    if params.get("dateBefore"):
        args += ["--datebefore", params["dateBefore"]]
    if params.get("metadataOnly"):
        args.append("--skip-download")
    if params.get("includeComments"):
        args.append("--write-comments")
    if params.get("cookiesFromBrowser"):
        args += ["--cookies-from-browser", params["cookiesFromBrowser"]]
    if params.get("quality"):
        args += ["-f", QUALITY_FORMATS[params["quality"]]]
    if js_runtime:
        # Named explicitly (ADR 0014, R133): yt-dlp needs a JavaScript runtime for YouTube.
        args += ["--js-runtimes", f"deno:{js_runtime}"]
    return [*args, "--", url]


def _gdl_date(d: str, plus_days: int = 0) -> str:
    day = datetime.date(int(d[:4]), int(d[4:6]), int(d[6:])) + datetime.timedelta(days=plus_days)
    return f"datetime({day.year}, {day.month}, {day.day})"


def build_gallerydl_args(url: str, out: str, params: dict) -> list[str]:
    args = ["--config-ignore", "--write-metadata", "--sleep", "3-8", "-D", out]
    if params.get("archiveFile"):
        args += ["--download-archive", params["archiveFile"]]
    if params.get("maxItems"):
        args += ["--range", f"1-{int(params['maxItems'])}"]
    filters = []
    if params.get("dateAfter"):
        filters.append(f"date >= {_gdl_date(params['dateAfter'])}")
    if params.get("dateBefore"):
        filters.append(f"date < {_gdl_date(params['dateBefore'], 1)}")  # inclusive, like yt-dlp --datebefore
    if filters:
        args += ["--filter", " and ".join(filters)]
    if params.get("metadataOnly"):
        args.append("--no-download")
    if params.get("cookiesFromBrowser"):
        args += ["--cookies-from-browser", params["cookiesFromBrowser"]]
    return [*args, "--", url]


def validate_params(url: str, params: dict) -> str | None:
    """An error message, or None when the request is acceptable."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "input must be an http(s) URL"
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "input must be an http(s) URL"
    if params.get("tool", "yt-dlp") not in TOOLS:
        return "params.tool must be yt-dlp or gallery-dl"
    b = params.get("cookiesFromBrowser")
    if b is not None and b not in BROWSERS:
        return "params.cookiesFromBrowser is not a supported browser"
    a = params.get("archiveFile")
    if a is not None and (not isinstance(a, str) or not os.path.isabs(a)):
        return "params.archiveFile must be an absolute path"
    for k in ("flatList", "metadataOnly", "includeComments"):
        if k in params and not isinstance(params[k], bool):
            return f"params.{k} must be a boolean"
    q = params.get("quality")
    if q is not None and (q not in QUALITY_FORMATS or params.get("tool", "yt-dlp") != "yt-dlp"):
        return "params.quality must be best, 1080p or 720p (yt-dlp only)"
    m = params.get("maxItems")
    if m is not None and (isinstance(m, bool) or not isinstance(m, int) or m < 1):
        return "params.maxItems must be a positive integer"
    for k in ("dateAfter", "dateBefore"):
        v = params.get(k)
        if v is not None:
            if not isinstance(v, str) or not DATE_RE.match(v):
                return f"params.{k} must be YYYYMMDD"
            try:
                datetime.datetime.strptime(v, "%Y%m%d")
            except ValueError:
                return f"params.{k} is not a real date"
    return None


# ---------- job ----------

_PCT = re.compile(r"^\[download\]\s+(\d+(?:\.\d+)?)%")
_ITEM = re.compile(r"Downloading (?:item|video) (\d+) of (\d+)")
_SKIP_SUFFIXES = (".part", ".ytdl", ".temp", ".tmp")


COMMENTS_SUFFIX = ".comments.json"


def _list_outputs(out: Path, tool: str, archive: str | None) -> tuple[list[str], list[str], list[str]]:
    files, infos, comments = [], [], []
    if not out.exists():
        return files, infos, comments
    for p in sorted(out.rglob("*")):
        if not p.is_file() or p.name.endswith(_SKIP_SUFFIXES) or ".part-Frag" in p.name:
            continue
        if archive and os.path.abspath(p) == os.path.abspath(archive):
            continue
        if p.name.endswith(COMMENTS_SUFFIX):
            comments.append(str(p))
            continue
        is_info = p.name.endswith(".info.json") if tool == "yt-dlp" else p.suffix == ".json"
        (infos if is_info else files).append(str(p))
    return files, infos, comments


def _split_comments(out: Path) -> None:
    """Moves yt-dlp's `comments` out of each info JSON into `<id>.comments.json` next to it."""
    for p in sorted(out.rglob("*.info.json")):
        try:
            info = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(info, dict) or "comments" not in info:
            continue
        comments = info.pop("comments")
        target = p.with_name(p.name[: -len(".info.json")] + COMMENTS_SUFFIX)
        target.write_text(json.dumps(comments if isinstance(comments, list) else [], ensure_ascii=False), encoding="utf-8")
        p.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")


def run(job: Job, ctx: JobContext) -> dict:
    params = job.params
    tool = params.get("tool", "yt-dlp")
    out = Path(job.output)
    out.mkdir(parents=True, exist_ok=True)
    log.info("capture job %s tool=%s url=%s", job.id, tool, strip_url(job.input))
    from .tools import deno_path, not_installed

    extra_env: dict[str, str] = {}
    if tool == "yt-dlp":
        resolved = resolve_ytdlp(download=False)
        if resolved is None:
            raise not_installed("video-downloader")
        cmd = [resolved[0]]
        version = tool_version(cmd)
        argv = [*cmd, *build_ytdlp_args(job.input, str(out), params, js_runtime=deno_path())]
    else:
        g = gallerydl_cmd()
        if g is None:
            raise not_installed("image-downloader")
        cmd, extra_env = g
        version = gallerydl_version()
        argv = [*cmd, *build_gallerydl_args(job.input, str(out), params)]

    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace", dir=ctx.workdir) as errf:
        proc = ctx.popen(argv, stdout=subprocess.PIPE, stderr=errf, stdin=subprocess.DEVNULL,
                         text=True, encoding="utf-8", errors="replace", bufsize=1, extra_env=extra_env)
        assert proc.stdout is not None
        item, items = 1, 1
        for line in proc.stdout:
            m = _ITEM.search(line)
            if m:
                item, items = int(m.group(1)), max(1, int(m.group(2)))
                continue
            m = _PCT.match(line.strip())
            if m:
                ctx.progress(min(0.99, ((item - 1) + float(m.group(1)) / 100) / items))
        rc = ctx.wait(proc)
        errf.seek(0)
        stderr = errf.read()

    comments_wanted = bool(params.get("includeComments"))
    if comments_wanted and tool == "yt-dlp":
        _split_comments(out)
    files, infos, comments = _list_outputs(out, tool, params.get("archiveFile"))
    meta = {"files": files, "infoJson": infos, "comments": comments, "tool": tool, "toolVersion": version, "partial": False}
    if comments_wanted and tool != "yt-dlp":
        meta["commentsUnsupported"] = True
    enumeration = bool(params.get("flatList") or params.get("metadataOnly"))
    if rc != 0:
        code = map_error(stderr)
        detail = redact("\n".join(stderr.strip().splitlines()[-20:]))
        if files or (enumeration and infos):
            log.warning("capture job %s partial code=%s", job.id, code)
            meta.update(partial=True, errorCode=code, errorDetail=detail)
        else:
            raise JobError(code, f"{tool} failed ({code})", detail)
    log.info("capture job %s finished files=%d", job.id, len(files))
    return {"output": str(out), "meta": meta}
