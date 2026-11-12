# -*- mode: python -*-
# PyInstaller spec: the media worker as one folder, `ao-worker/ao-worker` plus `ao-worker/_internal/`.
# Built by `node apps/desktop/scripts/build-sidecars.mjs` inside its build venv; one build per
# platform and architecture (no universal2, ADR 0014). Not inside: ffmpeg, tesseract, ghostscript,
# yt-dlp, gallery-dl and the speech models (R126, Task 48a); the worker finds them through PATH, AO_TOOLS_DIR,
# AO_YTDLP_BIN and AO_MODELS_DIR exactly as when run from source.
#
# Everything below that PyInstaller did not find by itself was found by building and running
# (`ao-worker --self-check` and packaging/smoke_test.py); each entry says what broke without it.
# Found by PyInstaller's own hooks (pyinstaller-hooks-contrib, ocrmypdf's bundled hook), with no
# entry needed here: ctranslate2, tokenizers, onnxruntime, av, numpy, pillow, pillow-heif, rawpy,
# pikepdf, pypdfium2, uharfbuzz, lxml, cryptography, pydantic, certifi's CA bundle. The worker has
# no uvicorn: it serves HTTP with the standard library.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

HERE = Path(SPECPATH)
sys.path.insert(0, str(HERE))
from dists import runtime_dists  # noqa: E402  (packaging/dists.py, shared with manifest.py)

sys.path.remove(str(HERE))  # keep the analysis's module search path to the build venv


datas = []
# Package metadata (dist-info, including each package's licence files) of every runtime dependency.
# Without it: /health reported null for faster_whisper, pillow, pillow_heif, rawpy, ocrmypdf and
# gallery_dl (importlib.metadata.PackageNotFoundError), `ocrmypdf --version` failed, and ocrmypdf's
# plugin manager could not read its entry points.
for name in runtime_dists():
    if name != "ao-worker":
        datas += copy_metadata(name)
# faster_whisper/assets/silero_vad_v6.onnx, the voice-activity model onnxruntime loads for every
# transcription. Without it: ONNXRuntimeError NO_SUCHFILE "Load model ... silero_vad_v6.onnx failed".
datas += collect_data_files("faster_whisper")
# The worker's own package data, ao_worker/known_phrases.txt (hallucination.py). Without it every
# transcription failed at the end with "FileNotFoundError in audio.transcribe".
datas += collect_data_files("ao_worker")
# ocrmypdf's fonts, ICC profiles and other files it locates at run time, and pikepdf's data files
# (PDF/A). The same as ocrmypdf 17.14's own hook, which the Intel pin set's 17.12.1 does not have.
datas += collect_data_files("ocrmypdf", excludes=["_pyinstaller"]) + collect_data_files("pikepdf")

# The standard-library modules gallery-dl 1.32.19 imports (see the gallery-dl note below).
GALLERY_DL_STDLIB = [
    "_string", "argparse", "array", "atexit", "binascii", "collections", "ctypes", "datetime", "email.utils",
    "errno", "functools", "getpass", "hashlib", "hmac", "html", "html.parser", "http.cookiejar", "itertools", "json",
    "logging", "math", "mimetypes", "netrc", "operator", "pickle", "platform", "queue", "random", "re", "shlex",
    "shutil", "signal", "socket", "sqlite3", "ssl", "string", "struct", "subprocess", "tempfile", "threading",
    "time", "tomllib", "unicodedata", "urllib.parse", "warnings", "webbrowser", "xml.etree.ElementTree", "zipfile",
]

hiddenimports = [
    # ocrmypdf runs as `sys.executable -m ocrmypdf` (ocr.py), so nothing imports it. Without it:
    # "ModuleNotFoundError: No module named 'ocrmypdf'".
    "ocrmypdf",
    # ocrmypdf's __main__, its builtin plugins (loaded by name; one of them imports pypdfium2) and
    # the rest of its submodules. ocrmypdf 17.14 ships a PyInstaller hook that does this, but the
    # Intel pin set's 17.12.1 has none. Without these (17.12.1 build): "No module named
    # ocrmypdf.__main__" and "No module named 'pypdfium2'".
    *collect_submodules("ocrmypdf", filter=lambda name: not name.startswith("ocrmypdf._pyinstaller")),
    # gallery-dl is NOT bundled (GPL-2.0-only, Task 48a): the tools dialogue downloads the pinned
    # wheel, and the worker runs it as `ao-worker -m gallery_dl` with AO_GALLERYDL_LIB (entry.py).
    # It then needs, from this bundle, its one dependency and the standard-library modules it
    # imports (listed from gallery-dl 1.32.19's sources; nothing in the worker imports them all).
    # Not yet confirmed by a packaged build: the smoke test's `--gallery-dl-wheel` check does that.
    *collect_submodules("requests"),
    *GALLERY_DL_STDLIB,
]

a = Analysis(
    [str(HERE / "entry.py")],
    # No pathex: ao_worker is imported from the build venv, where the build script installed it.
    hiddenimports=hiddenimports,
    datas=datas,
    binaries=[],
    # Never used by the worker; PyInstaller otherwise warns that the build machine's tkinter is broken.
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ao-worker",
    console=True,
    upx=False,  # compressed libraries break code signing on macOS
    strip=False,  # stripping after signing invalidates macOS signatures; signing is Task 37g
)
coll = COLLECT(exe, a.binaries, a.datas, name="ao-worker", upx=False, strip=False)
