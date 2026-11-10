from PIL import Image

from conftest import DNG_FILE, need_download

GPS = 0x8825
EXIF_IFD = 0x8769


def _gps_decimal(gps):
    def dec(v, ref):
        d, m, s = (float(x) for x in v)
        val = d + m / 60 + s / 3600
        return -val if ref in ("S", "W") else val

    return round(dec(gps[2], gps[1]), 6), round(dec(gps[4], gps[3]), 6)


def test_heic_keep_location_resized_and_oriented(worker, heic_with_gps, tmp_path):
    out = tmp_path / "proxy.jpg"
    job = worker.run("image.proxy", str(heic_with_gps), str(out), {"location": "keep"})
    assert job["status"] == "done", job
    assert job["result"]["output"] == str(out)
    with Image.open(out) as im:
        assert im.format == "JPEG"
        assert max(im.size) <= 2560
        # orientation 6 applied: the 4032x3024 landscape becomes portrait
        assert im.size[1] > im.size[0]
        exif = im.getexif()
        assert exif.get(0x0112, 1) == 1
        assert exif[0x010F] == "Apple" and exif[0x0110] == "iPhone 15"
        assert exif.get_ifd(EXIF_IFD)[0x9003] == "2026:03:14 10:15:30"
        lat, lon = _gps_decimal(exif.get_ifd(GPS))
        assert abs(lat - 40.7128) < 1e-4 and abs(lon + 74.0060) < 1e-4
    meta = job["result"]["meta"]
    assert meta["width"] <= 2560 and meta["sourceFormat"] == "HEIF"


def test_heic_coarsen_location(worker, heic_with_gps, tmp_path):
    out = tmp_path / "proxy.jpg"
    job = worker.run("image.proxy", str(heic_with_gps), str(out), {"location": "coarsen", "maxEdge": 1000})
    assert job["status"] == "done", job
    with Image.open(out) as im:
        assert max(im.size) == 1000
        exif = im.getexif()
        gps = exif.get_ifd(GPS)
        assert _gps_decimal(gps) == (40.7, -74.0)
        assert 6 not in gps  # altitude dropped
        assert exif.get_ifd(EXIF_IFD)[0x9003] == "2026:03:14 10:15:30"


def test_heic_strip_location(worker, heic_with_gps, tmp_path):
    out = tmp_path / "proxy.jpg"
    job = worker.run("image.proxy", str(heic_with_gps), str(out), {"location": "strip"})
    assert job["status"] == "done", job
    with Image.open(out) as im:
        exif = im.getexif()
        assert GPS not in exif
        assert not exif.get_ifd(GPS)
        assert exif[0x0110] == "iPhone 15"


def test_dng_to_jpeg(worker, tmp_path):
    dng = need_download(DNG_FILE)
    out = tmp_path / "proxy.jpg"
    job = worker.run("image.proxy", str(dng), str(out), {"location": "strip"}, timeout=300)
    assert job["status"] == "done", job
    with Image.open(out) as im:
        assert im.format == "JPEG"
        assert max(im.size) <= 2560
        assert im.size[0] > 100


def test_png_to_jpeg(worker, tmp_path):
    src = tmp_path / "a.png"
    Image.new("RGBA", (300, 200), (10, 20, 30, 128)).save(src)
    out = tmp_path / "o.jpg"
    job = worker.run("image.proxy", str(src), str(out), {})
    assert job["status"] == "done", job
    with Image.open(out) as im:
        assert im.format == "JPEG" and im.size == (300, 200)


def test_unreadable_image_fails(worker, tmp_path):
    src = tmp_path / "bad.jpg"
    src.write_bytes(b"not an image")
    job = worker.run("image.proxy", str(src), str(tmp_path / "o.jpg"), {})
    assert job["status"] == "failed"
    assert job["error"]["code"] == "UNSUPPORTED_INPUT"
    assert str(tmp_path) not in job["error"]["message"]


def test_icc_profile_is_kept(worker, tmp_path):
    from PIL import ImageCms

    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    src = tmp_path / "a.jpg"
    Image.new("RGB", (64, 48), (200, 10, 10)).save(src, icc_profile=icc)
    out = tmp_path / "o.jpg"
    assert worker.run("image.proxy", str(src), str(out), {})["status"] == "done"
    with Image.open(out) as im:
        assert im.info.get("icc_profile") == icc
    assert not any(p.name.startswith(".work-") for p in tmp_path.iterdir())
