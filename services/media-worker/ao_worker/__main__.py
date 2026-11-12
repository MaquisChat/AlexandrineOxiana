"""`python -m ao_worker`: serves the API on 127.0.0.1:$AO_WORKER_PORT (0 = any free port).

Its access token arrives on standard input, as one line, written by whoever starts it (the library
service's `startWorker`; tests; the packaging smoke test) - never in the environment or on the
command line, which other processes of the same user can read (R98, R155). It refuses to start, with
a plain message that never repeats the token, when:

- a token variable (AO_WORKER_TOKEN, in any letter case) is in its environment, even with a token
  on standard input too: an old launcher must not appear to work while leaking the token;
- it is given any command-line argument (it takes none);
- standard input is a terminal (a typed token would be echoed on screen);
- standard input closes before a line arrives, or no line arrives within TOKEN_STDIN_TIMEOUT_S;
- the line is not 32-512 characters from `A-Z a-z 0-9 . _ ~ + / = -` (the service's rule);
- the token's value also appears in the environment or the arguments.

After the token line, anything more on standard input is discarded, and the END of standard input
means "shut down cleanly", as SIGTERM does (R155): the service keeps its end open while it wants the
worker, so a service that exits, crashes or is killed leaves no stray worker.

Prints `AO_WORKER_READY port=<n>` on stdout once listening. Logs go to stderr.
"""
from __future__ import annotations

import logging
import os
import re
import signal
import sys
import threading

TOKEN_ENV = "AO_WORKER_TOKEN"
TOKEN_STDIN_TIMEOUT_S = 10
TOKEN_RE = re.compile(r"[A-Za-z0-9._~+/=-]{32,512}")
MAX_LINE_BYTES = 1024


class Refused(Exception):
    """Why the worker will not start; the message never contains the token."""


class StdinToken:
    """Reads the token line from the standard input descriptor on a thread, then watches it for its end."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.got_line = threading.Event()
        self.line: bytes | None = None
        self.error: str | None = None
        self.on_end = None  # set once the server runs; called when standard input ends
        self.ended = threading.Event()

    def run(self) -> None:
        # os.read on the descriptor, not sys.stdin.buffer: a daemon thread blocked inside the
        # buffered reader holds its lock, and the interpreter aborts (SIGABRT) at shutdown.
        buf = b""
        at_end = False
        try:
            while self.line is None:
                chunk = os.read(self.fd, 4096)
                if not chunk:
                    at_end = True
                    if buf:
                        self.line = buf.rstrip(b"\r")  # a line ended by the end of input
                    else:
                        self.error = "Standard input closed before an access token arrived. The worker is started with its access token written on standard input, as one line."
                    break
                buf += chunk
                nl = buf.find(b"\n")
                if nl != -1:
                    self.line = buf[:nl].rstrip(b"\r")
                elif len(buf) > MAX_LINE_BYTES:
                    self.error = "What arrived on standard input is not a valid access token: the first line is far too long."
                    break
            self.got_line.set()
            # After the line: discard anything more until the end of input.
            while self.line is not None and not at_end:
                at_end = not os.read(self.fd, 4096)
        except (OSError, ValueError):
            if self.line is None and self.error is None:
                self.error = "Standard input could not be read, so no access token arrived."
        self.got_line.set()
        if self.line is not None:
            self._end()

    def _end(self) -> None:
        self.ended.set()
        if self.on_end is not None:
            self.on_end()


def check_launch(env: dict[str, str], argv: list[str]) -> None:
    if any(k.upper() == TOKEN_ENV for k in env):
        raise Refused(f"An access token was found in the environment ({TOKEN_ENV}). The worker takes its token only on standard input, as one line; start it without that variable.")
    if len(argv) > 1:
        raise Refused("The worker takes no command-line arguments; its access token is passed on standard input, as one line.")


def check_token(token: str, env: dict[str, str], argv: list[str]) -> None:
    if not TOKEN_RE.fullmatch(token):
        raise Refused("What arrived on standard input is not a valid access token: it must be 32 to 512 characters, using only letters, digits and . _ ~ + / = -.")
    if any(token in v for v in env.values()):
        raise Refused("The access token also appears in the environment. The worker takes it only on standard input; start it without the token in any variable.")
    if any(token in a for a in argv):
        raise Refused("The access token also appears on the command line. The worker takes it only on standard input.")


def read_token(reader: StdinToken, timeout_s: float) -> str:
    try:
        if os.isatty(reader.fd):
            raise Refused("Standard input is a terminal: a token typed there would be shown on screen. Pipe the access token in instead.")
    except OSError:
        pass
    threading.Thread(target=reader.run, daemon=True, name="stdin-token").start()
    if not reader.got_line.wait(timeout_s):
        raise Refused(f"No access token arrived on standard input within {timeout_s:g} seconds. The worker is started with its access token written on standard input, as one line.")
    if reader.line is None:
        raise Refused(reader.error or "No access token arrived on standard input.")
    try:
        return reader.line.decode("ascii")
    except UnicodeDecodeError:
        raise Refused("What arrived on standard input is not a valid access token: it must be 32 to 512 characters, using only letters, digits and . _ ~ + / = -.") from None


def main() -> int:
    env = dict(os.environ)
    argv = list(sys.argv)
    try:
        check_launch(env, argv)
        # The life line is read on a private copy of the descriptor; descriptor 0 becomes /dev/null,
        # so no tool the worker starts inherits (or reads from) the service's pipe.
        life_line = os.dup(sys.stdin.fileno())  # not inheritable (PEP 446)
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, sys.stdin.fileno())
        os.close(devnull)
        reader = StdinToken(life_line)
        token = read_token(reader, TOKEN_STDIN_TIMEOUT_S)
        check_token(token, env, argv)
    except Refused as e:
        print(f"The media worker will not start: {e}", file=sys.stderr)
        return 2
    try:
        port = int(os.environ.get("AO_WORKER_PORT", "0"))
    except ValueError:
        print("AO_WORKER_PORT must be a number", file=sys.stderr)
        return 2
    logging.basicConfig(level=os.environ.get("AO_WORKER_LOG_LEVEL", "INFO").upper(), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .app import make_server

    server = make_server(token=token, port=port)
    stopping = threading.Event()

    def stop(*_args) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # R155: the end of standard input (the service closed its end, crashed or was killed) stops it.
    reader.on_end = stop
    if reader.ended.is_set():
        stop()

    print(f"AO_WORKER_READY port={server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.manager.shutdown()  # cancels jobs and kills their process groups
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
