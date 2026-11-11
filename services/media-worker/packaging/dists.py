"""The distributions the packaged worker contains: `ao-worker` and its run-time dependencies.

Shared by `ao-worker.spec` (which copies their metadata into the bundle) and `manifest.py` (which
lists them with their licences). Runs inside the build venv.
"""
from __future__ import annotations

import re
from importlib import metadata

from packaging.requirements import Requirement


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def runtime_dists(root: str = "ao-worker") -> list[str]:
    """`root` and every distribution it needs at run time.

    Follows the extras a requirement asks for (ocrmypdf requires `pikepdf[pdfa]`, which brings
    jsonschema and referencing); skips the extras nobody asks for and non-matching markers."""
    done: dict[str, set[str]] = {}
    todo: list[tuple[str, frozenset[str]]] = [(root, frozenset())]
    while todo:
        raw, extras = todo.pop()
        name = canonical(raw)
        if name in done and extras <= done[name]:
            continue
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        done.setdefault(name, set()).update(extras)
        for req_text in dist.requires or []:
            req = Requirement(req_text)
            if req.marker is not None and not any(req.marker.evaluate({"extra": e}) for e in ("", *extras)):
                continue
            todo.append((req.name, frozenset(canonical(e) for e in req.extras)))
    return sorted(done)
