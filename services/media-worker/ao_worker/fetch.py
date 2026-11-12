"""Verified downloads for the optional tools (R7, R126).

A download is one plain GET of a pinned address: no cookies, no query string added, no referrer,
and a fixed User-Agent, so nothing about the researcher, a library or a project is sent. A redirect
is followed only to a host the pin allows, and never from https down to http. The body is streamed
into a file in the caller's staging folder while it is hashed; it is refused (and the file removed)
when it is longer than pinned, shorter (truncated), or its SHA-256 differs. Nothing is unpacked or
made executable here: the caller does that only after this returns.
"""
from __future__ import annotations

import errno
import hashlib
import logging
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from .jobs import JobCancelled, JobError

log = logging.getLogger("ao_worker.fetch")

USER_AGENT = "ao-worker"
CHUNK = 1 << 16
# Connecting and reading the response headers.
TIMEOUT_SEC = 30
MAX_REDIRECTS = 5
# A body that sends no byte for this long is given up on (a hung host must not hold a job slot).
STALL_SEC = 30.0
# The whole body must arrive within DEADLINE_BASE_SEC + size / DEADLINE_MIN_RATE (bytes per second),
# so a host that drips just often enough to dodge the stall limit is given up on too.
DEADLINE_BASE_SEC = 300.0
DEADLINE_MIN_RATE = 50_000
# How often the watchdog looks at cancel, stall and deadline (a cancel takes effect within about this).
WATCH_SEC = 0.2


def deadline_for(size: int) -> float:
    """Seconds the body of a `size`-byte download may take."""
    return DEADLINE_BASE_SEC + max(0, size) / DEADLINE_MIN_RATE


class _Watchdog:
    """Ends a blocked read when the job is cancelled, the host stalls or the deadline passes, by
    shutting the connection's socket down (the read then returns or raises at once)."""

    def __init__(self, resp, cancelled: Callable[[], bool] | None, deadline: float):
        self.resp = resp
        self.cancelled = cancelled
        self.deadline = time.monotonic() + deadline
        self.last = time.monotonic()
        self.reason: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="download-watchdog", daemon=True)
        self._thread.start()

    def poke(self) -> None:
        self.last = time.monotonic()

    def _run(self) -> None:
        while not self._stop.wait(WATCH_SEC):
            now = time.monotonic()
            if self.cancelled and self.cancelled():
                self.reason = "cancelled"
            elif now - self.last > STALL_SEC:
                self.reason = "stalled"
            elif now > self.deadline:
                self.reason = "deadline"
            if self.reason:
                self._shut()
                return

    def _shut(self) -> None:
        sock = getattr(getattr(getattr(self.resp, "fp", None), "raw", None), "_sock", None)
        try:
            if sock is not None:
                sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def stop(self) -> None:
        self._stop.set()

    def check(self) -> None:
        """Raises for what made the watchdog end the read (if anything)."""
        if self.reason == "cancelled":
            raise JobCancelled()
        if self.reason == "stalled":
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download stopped: the server stopped sending")
        if self.reason == "deadline":
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download took too long and was given up")


class ToolInstallError(JobError):
    pass


def host_allowed(host: str, hosts: tuple[str, ...]) -> bool:
    host = (host or "").lower().rstrip(".")
    for h in hosts:
        h = h.lower()
        if h.startswith("."):
            if host.endswith(h) and len(host) > len(h):
                return True
        elif host == h:
            return True
    return False


def _show(url: str) -> str:
    """Scheme, host and path only (for logs)."""
    p = urlsplit(url)
    return f"{p.scheme}://{p.hostname or ''}{p.path}"


class _Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = MAX_REDIRECTS

    def __init__(self, hosts: tuple[str, ...]):
        super().__init__()
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001 - urllib's signature
        old, new = urlsplit(req.full_url), urlsplit(newurl)
        if new.scheme not in ("http", "https") or (old.scheme == "https" and new.scheme != "https"):
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download was redirected to an address that is not allowed")
        if not host_allowed(new.hostname or "", self.hosts):
            log.warning("refused a redirect from %s to another host", _show(req.full_url))
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download was redirected to a host that is not allowed")
        out = super().redirect_request(req, fp, code, msg, headers, newurl)
        if out is not None:
            # Only our own fixed header goes on; nothing urllib may have copied from elsewhere.
            out.headers = {"User-agent": USER_AGENT}
            out.unredirected_hdrs = {}
        return out


def opener(hosts: tuple[str, ...]) -> urllib.request.OpenerDirector:
    """An opener with no cookie jar and no credentials handler, following redirects only to `hosts`."""
    return urllib.request.build_opener(_Redirects(hosts))


def _open_for_write(path: Path):
    """The staging file (a seam the tests use to simulate a full disk)."""
    return open(path, "xb")


def download(
    url: str,
    dest: Path,
    *,
    sha256: str | None,
    size: int | None,
    hosts: tuple[str, ...],
    max_bytes: int,
    progress: Callable[[int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> int:
    """Fetches `url` into `dest` (a new file) and verifies it. Returns the number of bytes.

    `sha256` None: the caller verifies (yt-dlp, whose checksum comes from its release's list).
    Raises ToolInstallError (TOOL_DOWNLOAD_FAILED, TOOL_CHECKSUM_MISMATCH, TOOL_WRITE_FAILED) or
    JobCancelled; `dest` never remains after a failure.
    """
    first = urlsplit(url)
    if first.scheme not in ("http", "https") or not host_allowed(first.hostname or "", hosts):
        raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download address is not one of the allowed hosts")
    limit = size if size is not None else max_bytes
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    digest = hashlib.sha256()
    n = 0
    ok = False
    created = False
    watch: _Watchdog | None = None
    try:
        try:
            resp = opener(hosts).open(req, timeout=TIMEOUT_SEC)
        except ToolInstallError:
            raise
        except urllib.error.HTTPError as e:
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", f"the download failed (the server answered {e.code})") from e
        except (OSError, ValueError) as e:  # URLError, timeouts, refused connections
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download failed (no connection)", type(e).__name__) from e
        with resp:
            try:
                f = _open_for_write(dest)
                created = True
            except OSError as e:
                raise _write_error(e) from e
            watch = _Watchdog(resp, cancelled, deadline_for(limit))
            with f:
                while True:
                    if cancelled and cancelled():
                        raise JobCancelled()
                    try:
                        # read1: whatever has arrived (one socket read), so a drip cannot hold the loop.
                        chunk = resp.read1(CHUNK)
                    except Exception as e:  # noqa: BLE001 - OSError, timeouts, http.client.IncompleteRead
                        watch.check()
                        raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download was cut off", type(e).__name__) from e
                    watch.check()
                    if not chunk:
                        break
                    watch.poke()
                    n += len(chunk)
                    if n > limit:
                        raise ToolInstallError("TOOL_CHECKSUM_MISMATCH", "the download is larger than expected, so it was not used")
                    digest.update(chunk)
                    try:
                        f.write(chunk)
                    except OSError as e:
                        raise _write_error(e) from e
                    if progress:
                        progress(len(chunk))
                try:
                    f.flush()
                    os.fsync(f.fileno())
                except OSError as e:
                    raise _write_error(e) from e
        if size is not None and n < size:
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download was cut off before it was complete")
        if sha256 is not None and digest.hexdigest() != sha256.lower():
            log.warning("checksum mismatch for %s", _show(url))
            raise ToolInstallError("TOOL_CHECKSUM_MISMATCH", "the download does not match its published checksum, so it was not used")
        ok = True
        log.info("downloaded %s (%d bytes)", _show(url), n)
        return n
    finally:
        if watch is not None:
            watch.stop()
        if not ok and created:  # never a file that was there before
            try:
                dest.unlink()
            except OSError:
                pass


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_error(e: OSError) -> ToolInstallError:
    if e.errno in (errno.ENOSPC, errno.EDQUOT):
        return ToolInstallError("TOOL_WRITE_FAILED", "there is not enough space on the disk to install this tool")
    return ToolInstallError("TOOL_WRITE_FAILED", "the tool could not be written to the tools folder", type(e).__name__)
