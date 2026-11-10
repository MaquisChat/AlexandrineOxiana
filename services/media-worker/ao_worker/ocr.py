"""pdf.ocr: `ocrmypdf --skip-text --output-type pdf --sidecar <output>.txt` (needs tesseract and ghostscript)."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from .download import redact
from .jobs import Job, JobContext, JobError

LANG_RE = re.compile(r"^[a-z]{3}(_[a-z]{3,4})?$")
DEFAULTS = {"languages": ["eng"]}

# ocrmypdf exit codes (ocrmypdf.ExitCode)
EXIT_CODES = {
    2: ("UNSUPPORTED_INPUT", "the input is not a readable PDF"),
    3: ("MISSING_DEPENDENCY", "OCR needs tesseract and ghostscript, which were not found"),
    4: ("OCR_FAILED", "the OCR output was invalid"),
    5: ("OCR_FAILED", "the output file could not be written"),
    6: ("UNSUPPORTED_INPUT", "the PDF already has text"),
    7: ("OCR_FAILED", "a helper program failed during OCR"),
    8: ("ENCRYPTED_PDF", "the PDF is password protected"),
    9: ("OCR_FAILED", "OCR configuration error (missing language data?)"),
}


def ocrmypdf_cmd() -> list[str]:
    """`python -m ocrmypdf` from the worker's environment, or `AO_OCRMYPDF_BIN` (tests, packaged builds)."""
    env = os.environ.get("AO_OCRMYPDF_BIN")
    return [env] if env else [sys.executable, "-m", "ocrmypdf"]


def valid_languages(langs) -> bool:
    return isinstance(langs, list) and 0 < len(langs) <= 8 and all(isinstance(x, str) and LANG_RE.match(x) for x in langs)


def run(job: Job, ctx: JobContext) -> dict:
    p = {**DEFAULTS, **job.params}
    src = Path(job.input)
    out = Path(job.output)
    if not src.is_file():
        raise JobError("INPUT_NOT_FOUND", "the input file does not exist")
    sidecar = Path(str(out) + ".txt")
    out.parent.mkdir(parents=True, exist_ok=True)
    argv = [
        *ocrmypdf_cmd(),
        "--skip-text", "--output-type", "pdf", "--sidecar", str(sidecar),
        "-l", "+".join(p["languages"]),
        "--jobs", str(max(1, (os.cpu_count() or 2) // 2)),
        "--quiet",
        str(src), str(out),
    ]
    ctx.progress(0.05)
    # ocrmypdf's (and tesseract's/ghostscript's) temporary copies of the input go to the job's
    # private workdir (TMPDIR), which is removed when the job ends, cancelled or not.
    with tempfile.TemporaryFile(mode="w+", dir=ctx.workdir) as errf:
        proc = ctx.popen(argv, stdout=subprocess.DEVNULL, stderr=errf, text=True)
        rc = ctx.wait(proc)
        errf.seek(0)
        stderr = errf.read()
    if rc != 0:
        code, message = EXIT_CODES.get(rc, ("OCR_FAILED", "OCR failed"))
        detail = redact("\n".join(stderr.strip().splitlines()[-10:]).replace(str(src), "<input>"))
        raise JobError(code, message, detail or None)
    text = sidecar.read_text(encoding="utf-8", errors="replace") if sidecar.exists() else ""
    import pikepdf

    with pikepdf.open(out) as pdf:
        pages = len(pdf.pages)
    return {"output": str(out), "meta": {"sidecarText": text, "pages": pages}}
