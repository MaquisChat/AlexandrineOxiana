import tempfile
import time
from pathlib import Path

from conftest import FAKE_BIN, require_binaries


def test_image_only_pdf_gets_sidecar_text(worker, image_pdf, tmp_path):
    require_binaries("tesseract", "gs")
    out = tmp_path / "ocr.pdf"
    job = worker.run("pdf.ocr", str(image_pdf), str(out), {"languages": ["eng"]}, timeout=300)
    assert job["status"] == "done", job
    assert out.exists() and out.read_bytes().startswith(b"%PDF")
    sidecar = Path(str(out) + ".txt")
    assert "ARCHIVE" in sidecar.read_text()
    meta = job["result"]["meta"]
    assert meta["pages"] == 1
    assert "ARCHIVE" in meta["sidecarText"]


def test_rejects_bad_language_code(worker, image_pdf, tmp_path):
    status, body = worker.request("POST", "/jobs", {"type": "pdf.ocr", "input": str(image_pdf), "output": str(tmp_path / "o.pdf"), "params": {"languages": ["eng; rm -rf /"]}})
    assert status == 400


def test_cancelled_ocr_leaves_no_temp_copies(worker, image_pdf, tmp_path, monkeypatch):
    """Child tools write their temporary copies (here: of the input) into the job's private workdir, never the system temp, and it is removed on cancel."""
    record = tmp_path / "record.txt"
    monkeypatch.setenv("AO_OCRMYPDF_BIN", str(FAKE_BIN / "fake-ocrmypdf"))
    monkeypatch.setenv("FAKE_OCR_RECORD", str(record))
    out_dir = tmp_path / "out"
    job_id = worker.submit("pdf.ocr", str(image_pdf), str(out_dir / "ocr.pdf"), {})
    deadline = time.monotonic() + 15
    while not record.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    copy = Path(record.read_text())
    assert copy.exists()
    workdir = copy.parent.parent
    assert workdir.parent == out_dir and workdir.name == f".work-{job_id}"
    assert (workdir.stat().st_mode & 0o777) == 0o700
    assert Path(tempfile.gettempdir()) not in (copy.parent, copy.parent.parent)

    worker.request("POST", f"/jobs/{job_id}/cancel")
    assert worker.wait(job_id, 15)["status"] == "cancelled"
    assert not copy.exists() and not workdir.exists()
    assert not (Path(tempfile.gettempdir()) / "ocrmypdf.io.fake").exists()
    assert list(out_dir.iterdir()) == []
