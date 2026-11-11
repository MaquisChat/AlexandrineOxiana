"""The distributions the packaged worker contains: `ao-worker` and its run-time dependencies.

Shared by `ao-worker.spec` (which copies their metadata into the bundle) and `manifest.py` (which
lists them with their licences). Runs inside the build venv.
"""
from __future__ import annotations

import re
from importlib import metadata

from packaging.markers import Marker


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def runtime_dists(root: str = "ao-worker") -> list[str]:
    """`root` and every distribution it needs at run time (extras and non-matching markers skipped)."""
    seen: dict[str, None] = {}
    todo = [root]
    while todo:
        name = canonical(todo.pop())
        if name in seen:
            continue
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        seen[name] = None
        for req in dist.requires or []:
            spec, _, marker = req.partition(";")
            if marker.strip() and not Marker(marker).evaluate({"extra": ""}):
                continue
            todo.append(re.split(r"[\s<>=!~\[(;]", spec.strip(), maxsplit=1)[0])
    return sorted(seen)
