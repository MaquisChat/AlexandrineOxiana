"""Writes synthetic iPhone-style stills for the device-import tests (Task 27).

Usage: python device_media.py '<json spec>'
Spec: {"files": [{"path": ..., "format": "HEIF" | "JPEG", "make": ..., "model": ...,
                  "date": "YYYY:MM:DD HH:MM:SS", "offset": "-04:00", "lat": 40.7128, "lon": -74.006,
                  "contentIdentifier": "..."}]}

Run with the media worker's venv (pillow and pillow_heif). Apple's Live Photo pairing id lives in
the Apple maker note (tag 0x0011, ContentIdentifier); exiftool cannot create a maker note from
nothing, so a minimal Apple maker note ("Apple iOS" header, one IFD entry) is written here.
"""
from __future__ import annotations

import json
import struct
import sys

from PIL import Image


def apple_maker_note(content_identifier: str) -> bytes:
    cid = content_identifier.encode("ascii") + b"\x00"
    header = b"Apple iOS\x00" + b"\x00\x01" + b"MM"
    entries = 1
    data_offset = len(header) + 2 + 12 * entries + 4
    ifd = struct.pack(">H", entries) + struct.pack(">HHII", 0x0011, 2, len(cid), data_offset) + struct.pack(">I", 0)
    return header + ifd + cid


def dms(value: float) -> tuple[float, float, float]:
    v = abs(value)
    d = int(v)
    m = int((v - d) * 60)
    s = round(((v - d) * 60 - m) * 60, 4)
    return (float(d), float(m), s)


def write(spec: dict) -> None:
    fmt = spec.get("format", "JPEG")
    if fmt == "HEIF":
        import pillow_heif

        pillow_heif.register_heif_opener()
    img = Image.new("RGB", (spec.get("width", 320), spec.get("height", 240)), tuple(spec.get("color", (40, 120, 200))))
    exif = Image.Exif()
    if spec.get("make"):
        exif[0x010F] = spec["make"]
    if spec.get("model"):
        exif[0x0110] = spec["model"]
    ex = exif.get_ifd(0x8769)
    if spec.get("date"):
        ex[0x9003] = spec["date"]
        ex[0x9004] = spec["date"]
    if spec.get("offset"):
        ex[0x9011] = spec["offset"]
    if spec.get("contentIdentifier"):
        ex[0x927C] = apple_maker_note(spec["contentIdentifier"])
    if spec.get("lat") is not None and spec.get("lon") is not None:
        gps = exif.get_ifd(0x8825)
        gps[1] = "S" if spec["lat"] < 0 else "N"
        gps[2] = dms(spec["lat"])
        gps[3] = "W" if spec["lon"] < 0 else "E"
        gps[4] = dms(spec["lon"])
        gps[6] = 12.5  # altitude
    img.save(spec["path"], format=fmt, exif=exif.tobytes(), quality=60)


if __name__ == "__main__":
    for f in json.loads(sys.argv[1])["files"]:
        write(f)
