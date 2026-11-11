"""Entry point of the packaged (PyInstaller) worker: `ao-worker`.

With no arguments it is `python -m ao_worker` (same environment variables, same ready line, same
token handling). The worker starts some tools as `sys.executable -m <module>`; in the packaged
build `sys.executable` is this program, so it also accepts:

- `ao-worker -m ocrmypdf ...` and `ao-worker -m gallery_dl ...` (only these two modules), and
- `ao-worker --self-check`, which imports every native library in the bundle and prints their
  versions as JSON (used by the smoke test; touches no file and no network).

Anything else is refused with exit code 2, so the program cannot be used as a general interpreter.
"""
from __future__ import annotations

import multiprocessing
import sys

# Modules the worker runs as `sys.executable -m <module>` (ocr.py, download.py).
CHILD_MODULES = ("ocrmypdf", "gallery_dl")


def self_check() -> int:
    import importlib
    import json
    from importlib import metadata

    out: dict[str, str] = {}
    failed: dict[str, str] = {}
    modules = {
        "ctranslate2": "ctranslate2", "onnxruntime": "onnxruntime", "tokenizers": "tokenizers",
        "av": "av", "numpy": "numpy", "PIL": "pillow", "pillow_heif": "pillow-heif", "rawpy": "rawpy",
        "pikepdf": "pikepdf", "pypdfium2": "pypdfium2", "lxml.etree": "lxml", "cryptography.hazmat.bindings._rust": "cryptography",
        "ocrmypdf": "ocrmypdf", "faster_whisper": "faster-whisper", "gallery_dl": "gallery-dl", "uharfbuzz": "uharfbuzz",
    }
    for mod, dist in modules.items():
        try:
            importlib.import_module(mod)
            out[dist] = metadata.version(dist)
        except Exception as e:  # noqa: BLE001 - report every failure, not just the first
            failed[dist] = f"{type(e).__name__}: {e}"
    try:
        from faster_whisper.vad import get_vad_model

        get_vad_model()  # loads the Silero model file shipped inside faster_whisper/assets via onnxruntime
        out["silero-vad"] = "loaded"
    except Exception as e:  # noqa: BLE001
        failed["silero-vad"] = f"{type(e).__name__}: {e}"
    print(json.dumps({"ok": not failed, "versions": out, "failed": failed}))
    return 0 if not failed else 1


def main() -> int:
    args = sys.argv[1:]
    if not args:
        from ao_worker.__main__ import main as worker_main

        return worker_main()
    if args == ["--self-check"]:
        return self_check()
    if len(args) >= 2 and args[0] == "-m" and args[1] in CHILD_MODULES:
        import runpy

        sys.argv = [sys.executable, *args[2:]]
        try:
            runpy.run_module(args[1], run_name="__main__", alter_sys=True)
        except SystemExit as e:
            code = e.code
            return code if isinstance(code, int) else (0 if code is None else 1)
        return 0
    print("usage: ao-worker  (or -m ocrmypdf|gallery_dl ..., --self-check)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    # A child of a multiprocessing pool re-enters here (spawn on macOS); this hands it over. ocrmypdf
    # 17 uses threads by default, so the worker's OCR starts no pool today; this is a safeguard.
    multiprocessing.freeze_support()
    sys.exit(main())
