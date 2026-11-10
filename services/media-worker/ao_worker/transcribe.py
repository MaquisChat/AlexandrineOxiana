"""audio.transcribe: faster-whisper with VAD, per-segment language and hallucination flags.

Output (in the `output` dir): `transcript.vtt` and `segments.json` (see README). Models are cached
in `AO_MODELS_DIR` and downloaded on first use. A transcription uses every CPU core.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

from .hallucination import flag_segments
from .jobs import Job, JobContext, JobError

log = logging.getLogger("ao_worker.transcribe")

MODELS = ("large-v3", "medium", "small", "tiny")
COMPUTE_TYPES = ("int8", "float16")
DEFAULTS = {
    "model": "large-v3", "language": "auto", "multilingual": True, "vad": True, "computeType": "int8",
    "wordTimestamps": True,
}
SAMPLE_RATE = 16000
WINDOW_SEC = 30
MIN_WINDOW_SPEECH_SEC = 1.0

_model_lock = threading.Lock()
_model_cache: dict = {}


def models_dir() -> Path:
    d = os.environ.get("AO_MODELS_DIR")
    if d:
        return Path(d)
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "ao-worker" / "models"


def _load_model(name: str, compute_type: str):
    """One model kept in memory (the last one used); large models are too big to keep several."""
    from faster_whisper import WhisperModel

    key = (name, compute_type)
    with _model_lock:
        if key not in _model_cache:
            _model_cache.clear()
            try:
                _model_cache[key] = WhisperModel(
                    name, device="auto", compute_type=compute_type, cpu_threads=os.cpu_count() or 4,
                    download_root=str(models_dir()),
                )
            except ValueError as e:  # e.g. float16 on a CPU without support
                raise JobError("INVALID_PARAMS", f"compute type {compute_type} is not supported on this device") from e
            except OSError as e:
                raise JobError("MODEL_UNAVAILABLE", f"the {name} model could not be loaded or downloaded", type(e).__name__) from e
        return _model_cache[key]


def speech_regions(audio) -> list[tuple[float, float]]:
    """Speech regions in seconds from faster-whisper's Silero VAD."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    return [(c["start"] / SAMPLE_RATE, c["end"] / SAMPLE_RATE) for c in get_speech_timestamps(audio, VadOptions())]


def window_languages(model, audio, regions, fallback: str) -> list[str]:
    """Language per 30 s window, detected on that window's speech (fallback when it has too little)."""
    import numpy as np

    n_windows = max(1, -(-len(audio) // (WINDOW_SEC * SAMPLE_RATE)))
    out = []
    for w in range(n_windows):
        ws, we = w * WINDOW_SEC, (w + 1) * WINDOW_SEC
        chunks = [audio[int(max(a, ws) * SAMPLE_RATE): int(min(b, we) * SAMPLE_RATE)] for a, b in regions if b > ws and a < we]
        speech = np.concatenate(chunks) if chunks else np.zeros(0, dtype=audio.dtype)
        if len(speech) < MIN_WINDOW_SPEECH_SEC * SAMPLE_RATE:
            out.append(fallback)
            continue
        lang, _prob, _all = model.detect_language(speech)
        out.append(lang)
    return out


def _ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def to_vtt(segments: list[dict]) -> str:
    parts = ["WEBVTT", ""]
    for s in segments:
        if s["flags"]:
            parts += [f"NOTE flags: {', '.join(s['flags'])}", ""]
        text = s["text"].replace("-->", "->").strip() or "…"
        parts += [f"{_ts(s['start'])} --> {_ts(s['end'])}", text, ""]
    return "\n".join(parts)


def run(job: Job, ctx: JobContext) -> dict:
    from faster_whisper import decode_audio

    p = {**DEFAULTS, **job.params}
    src = Path(job.input)
    out = Path(job.output)
    if not src.is_file():
        raise JobError("INPUT_NOT_FOUND", "the input file does not exist")
    try:
        audio = decode_audio(str(src), sampling_rate=SAMPLE_RATE)
    except Exception as e:  # PyAV raises its own error types for undecodable input
        raise JobError("UNSUPPORTED_INPUT", "the input has no decodable audio") from e
    duration = len(audio) / SAMPLE_RATE
    ctx.check_cancelled()
    regions = speech_regions(audio)
    ctx.progress(0.02)
    model = _load_model(p["model"], p["computeType"])
    ctx.check_cancelled()
    ctx.progress(0.05)

    language = None if p["language"] == "auto" else p["language"]
    multilingual = bool(p["multilingual"]) and language is None
    seg_iter, info = model.transcribe(
        audio,
        language=language,
        multilingual=multilingual,
        vad_filter=bool(p["vad"]),
        word_timestamps=bool(p["wordTimestamps"]),
    )
    raw = []
    for s in seg_iter:
        ctx.check_cancelled()
        item = {
            "start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(),
            "avgLogprob": s.avg_logprob, "noSpeechProb": s.no_speech_prob, "compressionRatio": s.compression_ratio,
        }
        if p["wordTimestamps"] and s.words:
            item["words"] = [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word, "probability": w.probability} for w in s.words]
        raw.append(item)
        if duration > 0:
            ctx.progress(0.05 + 0.9 * min(1.0, s.end / duration))

    if language is not None:
        langs = [language] * max(1, len(raw))
        seg_lang = lambda s: language  # noqa: E731
    else:
        langs = window_languages(model, audio, regions, info.language) if raw else []
        seg_lang = lambda s: langs[min(len(langs) - 1, int(((s["start"] + s["end"]) / 2) // WINDOW_SEC))]  # noqa: E731
    for s in raw:
        s["lang"] = seg_lang(s)

    flagged = flag_segments(raw, regions)
    ordered = [
        {k: s[k] for k in ("start", "end", "text", "lang", "avgLogprob", "noSpeechProb", "compressionRatio", "flags")}
        | ({"words": s["words"]} if "words" in s else {})
        for s in flagged
    ]
    detected: list[str] = []
    for s in ordered:
        if s["lang"] not in detected:
            detected.append(s["lang"])

    out.mkdir(parents=True, exist_ok=True)
    (out / "segments.json").write_text(json.dumps(ordered, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "transcript.vtt").write_text(to_vtt(ordered), encoding="utf-8")
    flagged_count = sum(1 for s in ordered if s["flags"])
    log.info("transcription job %s: %d segments, %d flagged", job.id, len(ordered), flagged_count)
    return {
        "output": str(out),
        "meta": {"model": p["model"], "detectedLanguages": detected, "durationSec": round(duration, 3), "flaggedCount": flagged_count},
    }
