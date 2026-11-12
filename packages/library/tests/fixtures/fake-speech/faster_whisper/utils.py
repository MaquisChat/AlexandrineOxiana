"""Model lookup of the fake faster-whisper: only a folder already on disk, never a download."""
from __future__ import annotations

from pathlib import Path

_MODELS = {name: f"Systran/faster-whisper-{name}" for name in ("tiny", "small", "medium", "large-v3")}


def download_model(name: str, cache_dir: str | None = None, local_files_only: bool = True, **_kw) -> str:
    repo = Path(cache_dir or ".") / ("models--" + _MODELS[name].replace("/", "--"))
    rev = (repo / "refs" / "main").read_text(encoding="utf-8").strip()
    snap = repo / "snapshots" / rev
    if not snap.is_dir():
        raise FileNotFoundError("the fake model's snapshot folder is missing")
    return str(snap)
