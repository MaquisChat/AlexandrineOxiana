from pathlib import Path

from conftest import require_binaries


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
