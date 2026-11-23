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
import http.client
import logging
import os
import socket
import ssl
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
# Connecting: each socket operation while connecting (and the TLS handshake) may take this long.
CONNECT_SEC = 15
# Connecting and reading the response headers, redirects included, must end within this; a cancel
# is honoured meanwhile (within about WATCH_SEC).
HEADER_SEC = 30.0
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

    def __init__(self, sockets: "Sockets", cancelled: Callable[[], bool] | None, deadline: float):
        self.sockets = sockets
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
        self.sockets.kill()

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


UNTRUSTED_MESSAGE = "the download was refused: the server's certificate could not be verified"


def _inner(e: BaseException) -> BaseException | None:
    reason = getattr(e, "reason", None) if isinstance(e, urllib.error.URLError) else None
    return reason if isinstance(reason, BaseException) else None


def failure_detail(e: BaseException) -> str:
    """Class names only, never an address: `URLError/gaierror`, `URLError/SSLCertVerificationError`."""
    inner = _inner(e)
    return f"{type(e).__name__}/{type(inner).__name__}" if inner is not None else type(e).__name__


def untrusted(e: BaseException) -> bool:
    """Whether a failure is a certificate that could not be verified (directly or as a URLError's reason)."""
    return isinstance(e, ssl.SSLCertVerificationError) or isinstance(_inner(e), ssl.SSLCertVerificationError)


def opening_error(e: BaseException) -> "ToolInstallError":
    """The error for a connection that could not be opened (R476 b): TOOL_DOWNLOAD_UNTRUSTED for a
    certificate that could not be verified, else TOOL_DOWNLOAD_FAILED "no connection"; the detail
    names the classes so that a log tells a name lookup, a timeout and a refusal apart."""
    if untrusted(e):
        return ToolInstallError("TOOL_DOWNLOAD_UNTRUSTED", UNTRUSTED_MESSAGE, failure_detail(e))
    return ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download failed (no connection)", failure_detail(e))


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


class Sockets:
    """The sockets an opener connects (redirects open new ones), so a watchdog can end a blocked
    connect, header read or body read by shutting them down."""

    def __init__(self):
        self._lock = threading.Lock()
        self._socks: list = []
        self.abandoned = False

    def add(self, sock) -> None:
        with self._lock:
            self._socks.append(sock)
            dead = self.abandoned
        if dead:
            _shutdown(sock)

    def kill(self) -> None:
        with self._lock:
            self.abandoned = True
            socks = list(self._socks)
        for s in socks:
            _shutdown(s)


def _shutdown(sock) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def _watched(base, sockets: Sockets):
    class Conn(base):  # type: ignore[valid-type, misc]
        def connect(self):
            super().connect()
            sockets.add(self.sock)

    return Conn


class _WatchedHTTP(urllib.request.HTTPHandler):
    def __init__(self, sockets: Sockets):
        super().__init__()
        self._sockets = sockets

    def http_open(self, req):
        return self.do_open(_watched(http.client.HTTPConnection, self._sockets), req)


def _ca_file() -> str | None:
    """The app's own list of certificate authorities (certifi's file, inside the bundle)."""
    try:
        import certifi
    except ImportError:
        return None
    return certifi.where()


def tls_context() -> ssl.SSLContext:
    """The TLS context of every download the worker makes itself (R476).

    The standard library's default context trusts only the OpenSSL default paths compiled into the
    Python of the BUILD machine, which do not exist on another Mac. So the app's own list (certifi's
    file) is loaded, and the machine's default store IN ADDITION (`load_default_certs` honours
    SSL_CERT_FILE / SSL_CERT_DIR and skips paths that do not exist), so whatever works today still
    works. Certificates and host names are verified as by the default context. Without the app's
    list (it cannot be found or read) the default context is used, with one warning; the packaged
    worker's self-check fails the build in that case."""
    path = _ca_file()
    try:
        if path is None:
            raise FileNotFoundError("certifi is not installed")
        ctx = ssl.create_default_context(cafile=path)
    except (OSError, ssl.SSLError) as e:
        log.warning("the app's own list of certificate authorities could not be read (%s); using the system's only", type(e).__name__)
        return ssl.create_default_context()
    ctx.load_default_certs()
    return ctx


class _WatchedHTTPS(urllib.request.HTTPSHandler):
    def __init__(self, sockets: Sockets):
        super().__init__(context=tls_context())  # certificates and host names verified (R476)
        self._sockets = sockets

    def https_open(self, req):
        return self.do_open(_watched(http.client.HTTPSConnection, self._sockets), req, context=self._context)


def watched_handlers(sockets: Sockets) -> list:
    return [_WatchedHTTP(sockets), _WatchedHTTPS(sockets)]


def opener(hosts: tuple[str, ...], sockets: Sockets | None = None) -> urllib.request.OpenerDirector:
    """An opener with no cookie jar and no credentials handler, following redirects only to `hosts`."""
    return urllib.request.build_opener(_Redirects(hosts), *watched_handlers(sockets or Sockets()))


def open_watched(build: Callable[[Sockets], urllib.request.OpenerDirector], req, cancelled: Callable[[], bool] | None = None):
    """Opens `req` (connect, request, response headers, redirects) in a helper thread, so that a
    cancel or HEADER_SEC ends the wait whatever the host does: its sockets are shut down and the
    helper thread ends on its own. Returns (response, sockets); raises what opening raised,
    JobCancelled, or TOOL_DOWNLOAD_FAILED when the host did not answer in time."""
    sockets = Sockets()
    op = build(sockets)
    box: dict = {}

    def run() -> None:
        try:
            r = op.open(req, timeout=CONNECT_SEC)
        except BaseException as e:  # noqa: BLE001 - handed to the caller
            box["err"] = e
            return
        if sockets.abandoned:
            r.close()
        else:
            box["resp"] = r

    th = threading.Thread(target=run, name="download-open", daemon=True)
    th.start()
    end = time.monotonic() + HEADER_SEC
    while True:
        th.join(WATCH_SEC)
        if not th.is_alive():
            break
        if cancelled and cancelled():
            sockets.kill()
            raise JobCancelled()
        if time.monotonic() > end:
            sockets.kill()
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", "the download failed: the server did not answer in time")
    if "err" in box:
        raise box["err"]
    return box["resp"], sockets


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
    Raises ToolInstallError (TOOL_DOWNLOAD_FAILED, TOOL_DOWNLOAD_UNTRUSTED, TOOL_CHECKSUM_MISMATCH,
    TOOL_WRITE_FAILED) or
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
            resp, sockets = open_watched(lambda s: opener(hosts, s), req, cancelled)
        except (ToolInstallError, JobCancelled):
            raise
        except urllib.error.HTTPError as e:
            raise ToolInstallError("TOOL_DOWNLOAD_FAILED", f"the download failed (the server answered {e.code})") from e
        except (OSError, ValueError) as e:  # URLError, timeouts, refused connections, untrusted certificates
            raise opening_error(e) from e
        with resp:
            try:
                f = _open_for_write(dest)
                created = True
            except OSError as e:
                raise _write_error(e) from e
            watch = _Watchdog(sockets, cancelled, deadline_for(limit))
            with f:
                while True:
                    if cancelled and cancelled():
                        raise JobCancelled()
                    try:
                        # read1: whatever has arrived (one socket read), so a drip cannot hold the loop.
                        chunk = resp.read1(CHUNK)
                    except Exception as e:  # noqa: BLE001 - OSError, timeouts, http.client.IncompleteRead
                        watch.check()
                        if untrusted(e):
                            raise ToolInstallError("TOOL_DOWNLOAD_UNTRUSTED", UNTRUSTED_MESSAGE, failure_detail(e)) from e
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
