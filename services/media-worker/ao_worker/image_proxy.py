"""image.proxy: HEIC/HEIF, camera RAW, JPEG and PNG (and other Pillow formats) → JPEG proxy.

The proxy is oriented (EXIF orientation applied), at most `maxEdge` px on its long edge, and keeps
capture time and device EXIF. GPS follows `location` (see location.py).
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .jobs import Job, JobContext, JobError
from .location import coarsen, decimal_to_dms, dms_to_decimal

RAW_EXTS = {".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf"}
HEIF_EXTS = {".heic", ".heif", ".hif"}

IFD_EXIF = 0x8769
IFD_GPS = 0x8825
ORIENTATION = 0x0112

# Tags carried over: device and capture time only (no serial numbers, owner names or maker notes).
KEEP_IFD0 = (0x010F, 0x0110, 0x0131, 0x0132)  # Make, Model, Software, DateTime
KEEP_EXIF = (
    0x9003, 0x9004,  # DateTimeOriginal, DateTimeDigitized
    0x9010, 0x9011, 0x9012,  # OffsetTime, OffsetTimeOriginal, OffsetTimeDigitized
    0x9290, 0x9291, 0x9292,  # SubSecTime*
    0xA433, 0xA434,  # LensMake, LensModel
)

DEFAULTS = {"maxEdge": 2560, "quality": 85, "location": "keep"}

_heif_registered = False


def _register_heif() -> None:
    global _heif_registered
    if not _heif_registered:
        import pillow_heif

        pillow_heif.register_heif_opener()
        _heif_registered = True


def _open(path: Path) -> tuple[Image.Image, Image.Exif, str]:
    """(RGB-ish image with orientation still unapplied, source EXIF, source format)."""
    ext = path.suffix.lower()
    if ext in RAW_EXTS:
        import rawpy

        try:
            with rawpy.imread(str(path)) as raw:
                rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        except Exception as e:  # rawpy raises LibRawError subclasses and OSErrors
            raise JobError("UNSUPPORTED_INPUT", "the input is not a readable camera raw file") from e
        img = Image.fromarray(rgb)
        exif = Image.Exif()
        try:  # DNG and most RAWs are TIFF-based: read their EXIF with Pillow when it can
            with Image.open(path) as tiff:
                exif = tiff.getexif()
        except Exception:
            pass
        # rawpy already rotates the pixels by the raw orientation flag
        if ORIENTATION in exif:
            del exif[ORIENTATION]
        return img, exif, "RAW"
    _register_heif()
    try:
        img = Image.open(path)
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise JobError("UNSUPPORTED_INPUT", "the input is not a supported image") from e
    return img, img.getexif(), img.format or "UNKNOWN"


def _gps_out(src: dict, mode: str) -> dict | None:
    if mode == "strip" or not src:
        return None
    if mode == "keep":
        return dict(src)
    try:
        lat = dms_to_decimal(src[2], src.get(1))
        lon = dms_to_decimal(src[4], src.get(3))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None  # cannot coarsen what cannot be read: drop it
    lat, lon = coarsen(lat), coarsen(lon)
    return {
        0: b"\x02\x02\x00\x00",  # GPSVersionID 2.2
        1: "S" if lat < 0 else "N",
        2: decimal_to_dms(lat),
        3: "W" if lon < 0 else "E",
        4: decimal_to_dms(lon),
    }


def build_exif(src: Image.Exif, mode: str) -> Image.Exif:
    out = Image.Exif()
    for tag in KEEP_IFD0:
        if tag in src:
            out[tag] = src[tag]
    src_exif = src.get_ifd(IFD_EXIF)
    dst_exif = {t: src_exif[t] for t in KEEP_EXIF if t in src_exif}
    if dst_exif:
        ifd = out.get_ifd(IFD_EXIF)
        ifd.update(dst_exif)
    gps = _gps_out(dict(src.get_ifd(IFD_GPS)), mode)
    if gps:
        out.get_ifd(IFD_GPS).update(gps)
    return out


def run(job: Job, ctx: JobContext) -> dict:
    p = {**DEFAULTS, **job.params}
    src = Path(job.input)
    out = Path(job.output)
    if not src.is_file():
        raise JobError("INPUT_NOT_FOUND", "the input file does not exist")
    img, exif, fmt = _open(src)
    ctx.check_cancelled()
    ctx.progress(0.3)
    orig = img
    icc = img.info.get("icc_profile")
    try:
        if fmt != "RAW":
            img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.getchannel("A"))
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
        edge = int(p["maxEdge"])
        if max(img.size) > edge:
            img.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        ctx.check_cancelled()
        ctx.progress(0.7)
        new_exif = build_exif(exif, p["location"])
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f".{out.name}.{os.getpid()}.part")
        try:
            extra = {"icc_profile": icc} if icc else {}
            # Pillow's JPEG writer falls back to `im.info` for comment, dpi, jfif, adobe, photoshop, xmp ...
            # (copied from the source by exif_transpose/convert). Empty it so that only the EXIF built above
            # and the colour profile passed here (kept on purpose, R379) reach the proxy.
            img.info.clear()
            img.save(tmp, "JPEG", quality=int(p["quality"]), exif=new_exif.tobytes(), optimize=True, **extra)
            os.replace(tmp, out)
        finally:
            tmp.unlink(missing_ok=True)
        width, height = img.size
    finally:
        img.close()
        orig.close()
    return {
        "output": str(out),
        "meta": {"width": width, "height": height, "sourceFormat": fmt, "location": p["location"]},
    }
