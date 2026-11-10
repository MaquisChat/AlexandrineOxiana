"""`python -m ao_worker`: serves the API on 127.0.0.1:$AO_WORKER_PORT (0 = any free port).

Needs AO_WORKER_TOKEN. Prints `AO_WORKER_READY port=<n>` on stdout once listening. Logs go to
stderr. With AO_WORKER_EXIT_ON_STDIN_EOF=1 it exits when its stdin closes (the parent died).
"""
from __future__ import annotations

import logging
import os
import signal
import sys
import threading


def main() -> int:
    token = os.environ.pop("AO_WORKER_TOKEN", "")  # removed so no child process inherits it
    if len(token) < 16:
        print("AO_WORKER_TOKEN must be set (at least 16 characters)", file=sys.stderr)
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
    if os.environ.get("AO_WORKER_EXIT_ON_STDIN_EOF") == "1":
        def watch_stdin() -> None:
            try:
                while sys.stdin.buffer.read(4096):
                    pass
            except (OSError, ValueError):
                pass
            stop()

        threading.Thread(target=watch_stdin, daemon=True).start()

    print(f"AO_WORKER_READY port={server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.manager.shutdown()  # cancels jobs and kills their process groups
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
