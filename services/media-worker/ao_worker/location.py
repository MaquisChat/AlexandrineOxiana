"""Location metadata policy helpers shared by the image and video proxies.

`keep` leaves coordinates as they are, `coarsen` rounds latitude and longitude to one decimal
place (about 11 km, city level) and drops altitude and every other GPS detail, `strip` removes
location entirely.
"""
from __future__ import annotations

import re

LOCATION_MODES = ("keep", "coarsen", "strip")
COARSE_DECIMALS = 1


def coarsen(value: float) -> float:
    return round(float(value), COARSE_DECIMALS) + 0.0  # + 0.0 turns -0.0 into 0.0


def dms_to_decimal(dms, ref: str | None) -> float:
    d, m, s = (float(x) for x in dms)
    v = d + m / 60 + s / 3600
    return -v if (ref or "").upper() in ("S", "W") else v


def decimal_to_dms(value: float) -> tuple[float, float, float]:
    """Absolute value as (degrees, minutes, seconds) with whole degrees and minutes."""
    v = abs(value)
    deg = int(v)
    minutes_f = (v - deg) * 60
    minutes = int(round(minutes_f, 6))
    seconds = round((minutes_f - minutes) * 60, 4)
    if seconds < 0:
        seconds = 0.0
    return float(deg), float(minutes), seconds


_ISO6709 = re.compile(r"^\s*([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?(?:CRS[^/]*)?/?\s*$")


def parse_iso6709(s: str) -> tuple[float, float] | None:
    """Latitude/longitude from an ISO 6709 string such as "+40.7128-074.0060+010.000/" (decimal degrees only)."""
    m = _ISO6709.match(s or "")
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def format_iso6709(lat: float, lon: float, decimals: int = COARSE_DECIMALS) -> str:
    return f"{lat:+0{3 + decimals + 1}.{decimals}f}{lon:+0{4 + decimals + 1}.{decimals}f}/"


def coarsen_iso6709(s: str) -> str | None:
    """The coarsened string, or None when it cannot be parsed (then the caller drops it)."""
    p = parse_iso6709(s)
    if p is None:
        return None
    return format_iso6709(coarsen(p[0]), coarsen(p[1]))
