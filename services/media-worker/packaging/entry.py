"""Entry point of the packaged (PyInstaller) worker: `ao-worker`.

With no arguments it is `python -m ao_worker` (same environment variables, same ready line, same
token handling). The worker starts some tools as `sys.executable -m <module>`; in the packaged
build `sys.executable` is this program, so it also accepts:

- `ao-worker -m ocrmypdf ...` and `ao-worker -m gallery_dl ...` (only these two modules); gallery-dl
  is not inside the bundle (GPL-2.0-only): it is the copy the tools dialogue downloaded, found in the
  folder `AO_GALLERYDL_LIB` names (download.py sets it), and runs on this bundle's Python, and
- `ao-worker --self-check`, which imports every native library in the bundle and prints their
  versions as JSON (used by the smoke test; touches no file and no network). Its `tls` item fails
  unless the downloads' own certificate authorities are inside the bundle and hold with the
  machine's default paths absent (R476 c).

Anything else is refused with exit code 2, so the program cannot be used as a general interpreter.
"""
from __future__ import annotations

import multiprocessing
import os
import sys

# Modules the worker runs as `sys.executable -m <module>` (ocr.py, download.py).
CHILD_MODULES = ("ocrmypdf", "gallery_dl")


# Paths that cannot exist (/dev/null is not a folder), so OpenSSL finds no default store (R476 c).
_ABSENT = {"SSL_CERT_FILE": os.devnull + "/ao-absent/cert.pem", "SSL_CERT_DIR": os.devnull + "/ao-absent/certs"}


def tls_check() -> str:
    """The `tls` item of the self-check (R476 c). Raises RuntimeError unless (1) the app's own list
    of certificate authorities is a file, inside the bundle when frozen, and (2) the context every
    download uses holds authorities with the machine's default paths absent (as on a Mac that is
    not the build machine). Returns "<n> authorities from the app's own list"."""
    from pathlib import Path

    from ao_worker import fetch

    path = fetch._ca_file()
    if not path or not Path(path).is_file():
        raise RuntimeError("the app's own list of certificate authorities is missing")
    if getattr(sys, "frozen", False):
        bundle = Path(getattr(sys, "_MEIPASS", "")).resolve()
        if not Path(path).resolve().is_relative_to(bundle):
            raise RuntimeError("the app's own list of certificate authorities is not inside the app")
    saved = {k: os.environ.get(k) for k in _ABSENT}
    try:
        os.environ.update(_ABSENT)  # OpenSSL reads them when the default store is loaded
        n = fetch.tls_context().cert_store_stats()["x509_ca"]
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    if n <= 0:
        raise RuntimeError("the downloads would trust no certificate authority on another computer")
    return f"{n} authorities from the app's own list"


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
        "ocrmypdf": "ocrmypdf", "faster_whisper": "faster-whisper", "requests": "requests", "uharfbuzz": "uharfbuzz",
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
    try:
        out["tls"] = tls_check()
    except Exception as e:  # noqa: BLE001
        failed["tls"] = f"{type(e).__name__}: {e}"
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
        import os
        import runpy

        lib = os.environ.get("AO_GALLERYDL_LIB")
        if args[1] == "gallery_dl" and lib:
            sys.path.insert(0, lib)
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
