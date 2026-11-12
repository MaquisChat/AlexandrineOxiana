"""The optional tools (R126): the catalogue, finding each tool, and installing, updating and removing
them as jobs (`tool.install`, `tool.update`, `tool.remove`).

Where things go: tools in `AO_TOOLS_DIR` (the app's data folder), speech models in `AO_MODELS_DIR`;
never in a library. Each component is one folder, installed atomically:

1. its files are downloaded into `<root>/.staging.<id>/dl/` and verified (fetch.py) before anything
   is unpacked or made executable;
2. they are unpacked (unpack.py) or moved into `<root>/.staging.<id>/files/`, made executable, a
   marker `.installed.json` is written, and the staged program is run once (its self-check);
3. the old folder (if any) is renamed to `<root>/.old.<id>.<folder>`, the staged folder renamed into
   place, and the old one deleted.

A failure or a cancel at any step removes the staging folder, so nothing half-installed is ever in
place, and the install can simply be retried. A crash is cleaned up when the worker starts
(`sweep`): staging folders are deleted, and an `.old` folder is put back if its replacement never
arrived. yt-dlp keeps ADR 0009's place, `<tools>/yt-dlp`, and its own update path.
"""
from __future__ import annotations

import json
import logging
import os
import platform as _platform
import shutil
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import fetch, toolpins, unpack
from .jobs import Job, JobCancelled, JobContext, JobError, child_env
from .toolpins import Component, Download, Unavailable

log = logging.getLogger("ao_worker.tools")

MARKER = ".installed.json"
CHECK_TIMEOUT_SEC = 20
# Kept free on the disk beyond what an install needs.
SPACE_MARGIN = 64 * 1024 * 1024
ACTIONS = ("install", "update", "remove")


# ---------- where ----------


def tools_dir() -> Path:
    d = os.environ.get("AO_TOOLS_DIR")
    if d:
        return Path(d)
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "ao-worker" / "tools"


def models_dir() -> Path:
    from .transcribe import models_dir as md

    return md()


def root_of(c: Component) -> Path:
    return models_dir() if c.root == "models" else tools_dir()


def platform_key() -> str | None:
    machine = _platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if sys.platform == "darwin":
        return "macos-arm64" if arm else "macos-x64"
    if sys.platform.startswith("linux") and machine in ("x86_64", "amd64"):
        return "linux-x64"
    return None


def downloads_for(c: Component) -> tuple[Download, ...] | Unavailable:
    plat = platform_key()
    found = c.downloads.get(plat) if plat else None
    if found is None:
        found = c.downloads.get("any")
    if found is None:
        return Unavailable(f"{c.name} is not offered for this kind of computer.")
    return found


# ---------- errors ----------


def not_installed(tool_id: str) -> JobError:
    """The error a job gives when the tool it needs is missing (the interface links to the tools
    dialogue). When it cannot be downloaded for this computer, the message says why instead."""
    tool = toolpins.TOOLS.get(tool_id)
    name = tool.name if tool else tool_id
    for cid in tool.components if tool else ():
        c = toolpins.COMPONENTS[cid]
        d = downloads_for(c) if c.kind != "ytdlp" else ()
        if isinstance(d, Unavailable) and not component_status(c).installed:
            return JobError("TOOL_NOT_INSTALLED", f"{name} is not installed, and it cannot be downloaded for this computer yet. {d.reason}", tool=tool_id)
    return JobError("TOOL_NOT_INSTALLED", f"{name} is not installed. Install it from the Optional tools screen.", tool=tool_id)


def _err(code: str, message: str, detail: str | None = None) -> JobError:
    return fetch.ToolInstallError(code, message, detail)


# ---------- finding installed programs ----------


def _managed(c: Component) -> Path | None:
    folder = root_of(c) / c.folder
    return folder if (folder / MARKER).is_file() else None


def which(program: str) -> str | None:
    """ffmpeg, ffprobe or tesseract: the app's own copy in the tools folder, else the system's."""
    comp = {"ffmpeg": "ffmpeg", "ffprobe": "ffmpeg", "tesseract": "tesseract"}[program]
    m = _managed(toolpins.COMPONENTS[comp])
    if m is not None:
        p = m / ("bin/tesseract" if program == "tesseract" else program)
        if p.is_file():
            return str(p)
    return shutil.which(program)


def managed_tessdata() -> str | None:
    """TESSDATA_PREFIX for the app's own tesseract (None: a system tesseract uses its own data)."""
    t = _managed(toolpins.COMPONENTS["tesseract"])
    d = _managed(toolpins.COMPONENTS["tessdata"])
    return str(d) if t is not None and d is not None else None


def deno_path() -> str | None:
    """The JavaScript runtime yt-dlp is told to use: the app's own deno, else one on PATH."""
    m = _managed(toolpins.COMPONENTS["deno"])
    if m is not None and (m / "deno").is_file():
        return str(m / "deno")
    return shutil.which("deno")


def gallerydl_lib() -> str | None:
    """The folder holding the app's own gallery-dl package (run as `python -m gallery_dl`)."""
    m = _managed(toolpins.COMPONENTS["gallery-dl"])
    if m is not None and (m / "lib" / "gallery_dl" / "__init__.py").is_file():
        return str(m / "lib")
    return None


def gallerydl_env(lib: str) -> dict[str, str]:
    # PYTHONPATH for the worker run from source; AO_GALLERYDL_LIB for the packaged worker (entry.py).
    return {"PYTHONPATH": lib, "AO_GALLERYDL_LIB": lib}


# ---------- self-checks (cached by path and modification time) ----------

_check_lock = threading.Lock()
_check_cache: dict[tuple, str | None] = {}


def _stamp(paths: list[str]) -> tuple:
    out = []
    for p in paths:
        try:
            st = os.stat(p)
            out.append((p, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((p, None, None))
    return tuple(out)


def run_version(argv: list[str], extra_env: dict[str, str] | None = None, stamp_paths: list[str] | None = None) -> str | None:
    """First line of `argv` (a version flag included), or None when it does not run. Never touches the network."""
    key = (tuple(argv), tuple(sorted((extra_env or {}).items())), _stamp(stamp_paths or [argv[0]]))
    with _check_lock:
        if key in _check_cache:
            return _check_cache[key]
    env = child_env()
    env.update(extra_env or {})
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=CHECK_TIMEOUT_SEC, env=env, stdin=subprocess.DEVNULL)
        lines = (r.stdout or r.stderr or "").strip().splitlines()
        out = lines[0].strip() if r.returncode == 0 and lines else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        out = None
    with _check_lock:
        _check_cache[key] = out
    return out


def clear_checks() -> None:
    with _check_lock:
        _check_cache.clear()


@dataclass
class Status:
    installed: bool = False
    usable: bool = False
    # "managed" (installed by the app), "system" (found on PATH), "override" (named by an AO_*_BIN variable)
    source: str | None = None
    version: str | None = None
    outdated: bool = False


def _version_word(line: str | None) -> str | None:
    if not line:
        return None
    parts = line.split()
    # "ffmpeg version 9.0.2 ...", "deno 2.9.8 (...)", "tesseract 5.5.0", "2026.10.22"
    if len(parts) >= 3 and parts[1] == "version":
        return parts[2]
    if len(parts) >= 2 and not parts[0][0].isdigit():
        return parts[1].lstrip("v")
    return parts[0]


def component_status(c: Component, base: Path | None = None) -> Status:
    """`base`: a staged folder to check instead of the installed one (the self-check before the swap)."""
    managed = base if base is not None else _managed(c)
    if c.kind == "model":
        return _model_status(c, base)
    if c.id == "yt-dlp":
        from .download import resolve_ytdlp

        r = resolve_ytdlp(download=False)
        if r is None:
            return Status()
        line = run_version([r[0], "--version"])
        source = "managed" if r[1] else ("override" if os.environ.get("AO_YTDLP_BIN") else "system")
        return Status(True, line is not None, source, line)
    if c.id == "deno":
        p = str(managed / "deno") if managed else shutil.which("deno")
        if not p:
            return Status()
        v = _version_word(run_version([p, "--version"]))
        return Status(True, v is not None, "managed" if managed else "system", v, bool(managed) and v is not None and v != c.version)
    if c.id == "ffmpeg":
        if managed:
            ff, fp = str(managed / "ffmpeg"), str(managed / "ffprobe")
        else:
            ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
            if not ff or not fp:
                return Status()
        v = _version_word(run_version([ff, "-hide_banner", "-version"]))
        ok = v is not None and run_version([fp, "-hide_banner", "-version"]) is not None
        return Status(True, ok, "managed" if managed else "system", v, bool(managed) and ok and v != c.version)
    if c.id == "tesseract":
        p = str(managed / "bin" / "tesseract") if managed else shutil.which("tesseract")
        if not p:
            return Status()
        v = _version_word(run_version([p, "--version"]))
        return Status(True, v is not None, "managed" if managed else "system", v)
    if c.id == "tessdata":
        if managed:
            ok = (managed / "eng.traineddata").is_file()
            return Status(ok, ok, "managed", c.version)
        t = shutil.which("tesseract")
        if t and _managed(toolpins.COMPONENTS["tesseract"]) is None:
            # A system tesseract brings its own language data.
            langs = _list_langs(t)
            if langs is not None and "eng" in langs:
                return Status(True, True, "system", None)
        return Status()
    if c.id == "gallery-dl":
        env_bin = os.environ.get("AO_GALLERYDL_BIN")
        if env_bin and base is None:
            line = run_version([env_bin, "--version"])
            return Status(True, line is not None, "override", line)
        if not managed or not (managed / "lib" / "gallery_dl" / "__init__.py").is_file():
            return Status()
        lib = str(managed / "lib")
        line = run_version([sys.executable, "-m", "gallery_dl", "--version"], gallerydl_env(lib),
                           stamp_paths=[str(managed / "lib" / "gallery_dl" / "version.py")])
        return Status(True, line is not None, "managed", line, line is not None and line != c.version)
    return Status()


def _list_langs(tesseract: str) -> list[str] | None:
    env = child_env()
    try:
        r = subprocess.run([tesseract, "--list-langs"], capture_output=True, text=True, timeout=CHECK_TIMEOUT_SEC, env=env, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return [l.strip() for l in r.stdout.splitlines()[1:] if l.strip()]


def _model_status(c: Component, base: Path | None) -> Status:
    folder = base if base is not None else root_of(c) / c.folder
    try:
        rev = (folder / "refs" / "main").read_text(encoding="utf-8").strip()
    except OSError:
        return Status()
    snap = folder / "snapshots" / rev
    if not (snap / "model.bin").is_file():
        return Status()
    name = c.id[len("model-"):]
    pinned_rev, files = toolpins.MODEL_PINS[name]
    usable = all((snap / f).is_file() for f, _, _ in files)
    if usable and rev == pinned_rev:
        expected = {f: size for f, _, size in files}
        usable = all((snap / f).stat().st_size == expected[f] for f in expected)
    return Status(True, usable, "managed", rev[:7], rev != pinned_rev)


# ---------- the catalogue ----------


def _download_size(c: Component) -> tuple[int, bool]:
    """(bytes, approximate)."""
    if c.kind == "ytdlp":
        return c.approx_size, True
    d = downloads_for(c)
    if isinstance(d, Unavailable):
        return 0, False
    return sum(x.size for x in d), False


def hosts_of(c: Component) -> list[str]:
    """The host names a component's download contacts (R158), derived from its pins, never typed
    again: the pinned addresses' hosts and the exact hosts a redirect may lead to; for yt-dlp the
    release host (its checksum file comes from there too) and the hosts its files are served from.
    Only bare host names (a `.suffix` redirect allowance is not one host). Nothing for a part that
    cannot be downloaded for this computer."""
    from urllib.parse import urlsplit

    if c.kind == "ytdlp":
        from .download import YTDLP_HOSTS, YTDLP_RELEASES

        found = [urlsplit(YTDLP_RELEASES).hostname or "", *YTDLP_HOSTS]
    else:
        d = downloads_for(c)
        if isinstance(d, Unavailable):
            return []
        found = [urlsplit(x.url).hostname or "" for x in d] + list(c.hosts)
    return list(dict.fromkeys(h.lower() for h in found if h and not h.startswith(".")))


def catalogue() -> dict:
    """GET /tools: every optional tool, with what it is for, what stops working without it, its size,
    version and whether it is installed and usable. Runs only quick local checks; no network."""
    plat = platform_key()
    out = []
    for t in toolpins.TOOLS.values():
        comps = [toolpins.COMPONENTS[cid] for cid in t.components]
        parts = []
        size = remaining = 0
        approx = False
        reasons = []
        for c in comps:
            st = component_status(c)
            s, a = _download_size(c)
            d = downloads_for(c) if c.kind != "ytdlp" else ()
            available = not isinstance(d, Unavailable)
            if not available:
                reasons.append(d.reason)  # type: ignore[union-attr]
            size += s
            approx = approx or a
            if not (st.installed and st.usable and not st.outdated):
                remaining += s
            parts.append({
                "id": c.id, "name": c.name, "version": c.version, "licence": c.licence,
                "installed": st.installed, "usable": st.usable, "source": st.source,
                "installedVersion": st.version, "outdated": st.outdated,
                "available": available, **({"unavailableReason": d.reason} if not available else {}),  # type: ignore[union-attr]
                "downloadSize": s, "sizeApproximate": a,
                "hosts": hosts_of(c),
            })
        installed = all(p["installed"] for p in parts)
        usable = installed and all(p["usable"] for p in parts)
        # Installable when every missing part can be downloaded here.
        missing_unavailable = [p for p in parts if not (p["installed"] and p["usable"]) and not p["available"]]
        out.append({
            "id": t.id, "group": t.group, "name": t.name, "purpose": t.purpose, "without": t.without,
            "version": " + ".join(c.version for c in comps) if len(comps) > 1 else comps[0].version,
            # The whole download, and what is still to be downloaded (parts already in place excluded).
            "downloadSize": size, "sizeApproximate": approx, "remainingSize": remaining,
            "installed": installed, "usable": usable,
            "managed": any(p["source"] == "managed" for p in parts),
            "updateAvailable": any(p["outdated"] for p in parts),
            "available": not missing_unavailable,
            **({"unavailableReason": " ".join(dict.fromkeys(reasons))} if missing_unavailable else {}),
            **({"notice": t.notice} if t.notice else {}),
            "components": parts,
        })
    return {"platform": plat, "tools": out}


# ---------- install ----------

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(component_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(component_id, threading.Lock())


def sweep(root: Path | None = None) -> None:
    """Cleans up after an install the worker did not live to finish (call at start, before any job)."""
    roots = [root] if root is not None else [tools_dir(), models_dir()]
    for r in roots:
        try:
            names = os.listdir(r)
        except OSError:
            continue
        for n in names:
            p = r / n
            if n.startswith((".staging.", ".trash.")):
                # .trash.: a removal that did not finish; never brought back.
                shutil.rmtree(p, ignore_errors=True)
            elif n.startswith(".old."):
                parts = n.split(".", 3)  # ['', 'old', '<id>', '<folder>']
                if len(parts) == 4 and parts[3] and not os.path.lexists(r / parts[3]):
                    try:
                        os.rename(p, r / parts[3])
                        log.info("restored a tool folder an interrupted install had moved aside")
                        continue
                    except OSError:
                        pass
                shutil.rmtree(p, ignore_errors=True)
            elif n.startswith(".yt-dlp."):
                try:
                    p.unlink()
                except OSError:
                    pass


def _strip_quarantine(path: Path) -> None:
    """macOS: removes `com.apple.quarantine` from a verified file (ADR 0014, Gatekeeper step 2)."""
    if sys.platform != "darwin":
        return
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.removexattr(os.fsencode(path), b"com.apple.quarantine", 0x0001)  # XATTR_NOFOLLOW
    except Exception:  # noqa: BLE001 - best effort: absent attribute, no libc symbol
        pass


class Progress:
    """Overall progress of a job over the bytes it downloads."""

    def __init__(self, ctx: JobContext | None, total: int):
        self.ctx = ctx
        self.total = max(1, total)
        self.done = 0

    def add(self, n: int) -> None:
        self.done += n
        if self.ctx:
            self.ctx.progress(min(0.99, self.done / self.total))


def _check_space(root: Path, needed: int) -> None:
    try:
        free = shutil.disk_usage(root).free
    except OSError:
        return
    if free < needed + SPACE_MARGIN:
        raise _err("TOOL_WRITE_FAILED", "there is not enough space on the disk to install this tool")


def install_component(c: Component, progress: Progress, cancelled: Callable[[], bool]) -> None:
    if c.kind == "ytdlp":
        from .download import install_ytdlp

        install_ytdlp(progress=progress.add, cancelled=cancelled)
        return
    plan = downloads_for(c)
    if isinstance(plan, Unavailable):
        raise _err("TOOL_UNAVAILABLE", plan.reason)
    root = root_of(c)
    with _lock(c.id):
        try:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Private whatever the umask: nobody else may swap a program the worker runs.
            if os.name != "nt":
                os.chmod(root, 0o700)
        except OSError as e:
            raise fetch._write_error(e) from e
        _check_space(root, sum(d.size + d.unpacked for d in plan))
        tag = uuid.uuid4().hex
        work = root / f".staging.{tag}"
        files = work / "files"
        dl = work / "dl"
        try:
            for p in (work, files, dl):
                p.mkdir(mode=0o700)
            for i, d in enumerate(plan):
                if cancelled():
                    raise JobCancelled()
                archive = dl / str(i)
                fetch.download(d.url, archive, sha256=d.sha256, size=d.size, hosts=c.hosts, max_bytes=d.size,
                               progress=progress.add, cancelled=cancelled)
                # Verified: only now is anything unpacked.
                if d.save_as:
                    target = files / Path(*unpack.safe_relative(d.save_as).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(archive, target)
                    os.chmod(target, 0o644)
                elif d.extract:
                    unpack.extract_zip(archive, files, members=dict(d.extract), max_bytes=d.unpacked)
                else:
                    unpack.extract_zip(archive, files, under=d.extract_all_under, max_bytes=d.unpacked)
                archive.unlink(missing_ok=True)
            for rel, text in c.write:
                target = files / Path(*unpack.safe_relative(rel).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
            for rel in c.executables:
                exe = files / Path(*unpack.safe_relative(rel).parts)
                if exe.is_file():
                    os.chmod(exe, 0o755)
            for p in files.rglob("*"):
                if p.is_file():
                    _strip_quarantine(p)
            (files / MARKER).write_text(json.dumps({"component": c.id, "version": c.version}), encoding="utf-8")
            if cancelled():
                raise JobCancelled()
            st = component_status(c, base=files)
            if not (st.installed and st.usable):
                raise _err("TOOL_UNUSABLE", f"{c.name} was downloaded and verified but does not run on this computer, so it was not installed")
            _swap(root, c.folder, files, tag)
        except OSError as e:
            raise fetch._write_error(e) from e
        finally:
            shutil.rmtree(work, ignore_errors=True)
    clear_checks()
    log.info("installed %s %s", c.id, c.version)


def _swap(root: Path, folder: str, staged: Path, tag: str) -> None:
    final = root / folder
    old = root / f".old.{tag}.{folder}"
    had_old = os.path.lexists(final)
    if had_old:
        os.rename(final, old)
    try:
        os.rename(staged, final)
    except OSError:
        if had_old:
            os.rename(old, final)
        raise
    if had_old:
        shutil.rmtree(old, ignore_errors=True)


def remove_component(c: Component) -> bool:
    """Removes the app's own copy. False when there is none (a system tool is never touched)."""
    if c.kind == "ytdlp":
        from .download import managed_ytdlp_path

        p = managed_ytdlp_path()
        if p.is_file():
            p.unlink()
            clear_checks()
            return True
        return False
    root = root_of(c)
    final = root / c.folder
    with _lock(c.id):
        if not os.path.lexists(final) or (c.kind != "model" and not (final / MARKER).is_file()):
            return False
        trash = root / f".trash.{uuid.uuid4().hex}.{c.folder}"
        os.rename(final, trash)
        shutil.rmtree(trash, ignore_errors=True)
    clear_checks()
    log.info("removed %s", c.id)
    return True


# ---------- the job ----------


def _needs_install(c: Component) -> bool:
    st = component_status(c)
    if st.source in ("system", "override") and st.usable:
        return False
    return not (st.installed and st.usable) or st.outdated


def run(job: Job, ctx: JobContext) -> dict:
    """`tool.install` / `tool.update` / `tool.remove`; `job.input` is the tool id."""
    action = job.type.split(".", 1)[1]
    tool = toolpins.TOOLS.get(job.input)
    if tool is None or action not in ACTIONS:
        raise JobError("UNKNOWN_TOOL", "there is no such tool")
    comps = [toolpins.COMPONENTS[cid] for cid in tool.components]
    log.info("tool job %s: %s %s", job.id, action, tool.id)
    if action == "remove":
        removed = [c.id for c in comps if remove_component(c)]
        if not removed and any(component_status(c).installed for c in comps):
            raise JobError("TOOL_NOT_MANAGED", f"{tool.name} was not installed by the app (it belongs to this computer), so it was left alone", tool=tool.id)
        return {"tool": tool.id, "action": action, "removed": removed}

    todo = [c for c in comps if _needs_install(c)]
    for c in todo:
        d = downloads_for(c) if c.kind != "ytdlp" else ()
        if isinstance(d, Unavailable):
            raise JobError("TOOL_UNAVAILABLE", d.reason, tool=tool.id)
    updated: list[dict] = []
    if action == "update":
        # The video downloader updates in place with its own verified updater (ADR 0009).
        yt = toolpins.COMPONENTS["yt-dlp"]
        if yt in comps and yt not in todo:
            from .download import update_tools

            r = update_tools()["ytDlp"]
            updated.append({"component": "yt-dlp", "old": r["old"], "new": r["new"], "managed": r["managed"]})
            clear_checks()
    progress = Progress(ctx, sum(_download_size(c)[0] for c in todo))
    installed = []
    for c in todo:
        ctx.check_cancelled()
        try:
            install_component(c, progress, lambda: ctx.cancelled)
        except JobError as e:
            e.tool = tool.id
            raise
        installed.append(c.id)
    return {"tool": tool.id, "action": action, "installed": installed, "updated": updated,
            "skipped": [c.id for c in comps if c not in todo]}
