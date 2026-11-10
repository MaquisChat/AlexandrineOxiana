"""Transcript hallucination flags (spec 5.8).

Rules, applied per segment (flags are reported in this order):
- low-confidence: avgLogprob < -1.0
- no-speech: noSpeechProb > 0.6 and the text is not empty
- repetition: compressionRatio > 2.4, or the same normalized text in >= 3 consecutive segments
- outside-speech: < 20% of the segment overlaps voice-activity (VAD) speech regions
- known-phrase: the normalized text is a stock phrase from known_phrases.txt, only when the
  segment is also no-speech or outside-speech (the same words inside real speech are fine)
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Sequence

LOW_LOGPROB = -1.0
NO_SPEECH_PROB = 0.6
COMPRESSION_RATIO = 2.4
REPEAT_RUN = 3
MIN_SPEECH_OVERLAP = 0.2

FLAG_ORDER = ("low-confidence", "no-speech", "repetition", "outside-speech", "known-phrase")


def normalize(text: str) -> str:
    """Lowercase, drop punctuation and symbols, collapse whitespace."""
    t = unicodedata.normalize("NFKC", text).lower()
    t = "".join(ch for ch in t if not unicodedata.category(ch).startswith(("P", "S")))
    return re.sub(r"\s+", " ", t).strip()


@lru_cache(maxsize=1)
def load_known_phrases() -> frozenset[str]:
    path = Path(__file__).with_name("known_phrases.txt")
    out = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(normalize(line))
    return frozenset(out)


def _regions(speech_regions: Iterable) -> list[tuple[float, float]]:
    out = []
    for r in speech_regions:
        if isinstance(r, dict):
            out.append((float(r["start"]), float(r["end"])))
        else:
            out.append((float(r[0]), float(r[1])))
    return out


def speech_overlap(start: float, end: float, regions: Sequence[tuple[float, float]]) -> float:
    """Fraction of [start, end] covered by speech regions (a zero-length segment: 1 if inside one)."""
    if end <= start:
        return 1.0 if any(a <= start <= b for a, b in regions) else 0.0
    covered = sum(max(0.0, min(end, b) - max(start, a)) for a, b in regions)
    return min(1.0, covered / (end - start))


def flag_segments(segments: Sequence[dict], speech_regions: Iterable) -> list[dict]:
    """Returns copies of `segments`, each with a `flags` list."""
    regions = _regions(speech_regions)
    phrases = load_known_phrases()
    norms = [normalize(s.get("text", "")) for s in segments]

    repeated = [False] * len(segments)
    i = 0
    while i < len(segments):
        j = i
        while j + 1 < len(segments) and norms[j + 1] == norms[i]:
            j += 1
        if norms[i] and j - i + 1 >= REPEAT_RUN:
            for k in range(i, j + 1):
                repeated[k] = True
        i = j + 1

    out = []
    for idx, s in enumerate(segments):
        flags: set[str] = set()
        if s["avgLogprob"] < LOW_LOGPROB:
            flags.add("low-confidence")
        if s["noSpeechProb"] > NO_SPEECH_PROB and norms[idx]:
            flags.add("no-speech")
        if s["compressionRatio"] > COMPRESSION_RATIO or repeated[idx]:
            flags.add("repetition")
        if speech_overlap(float(s["start"]), float(s["end"]), regions) < MIN_SPEECH_OVERLAP:
            flags.add("outside-speech")
        if norms[idx] in phrases and flags & {"no-speech", "outside-speech"}:
            flags.add("known-phrase")
        out.append({**s, "flags": [f for f in FLAG_ORDER if f in flags]})
    return out
