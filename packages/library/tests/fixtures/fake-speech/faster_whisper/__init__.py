"""A fake faster-whisper for the end-to-end tests (no model, no network, no audio decoding).

The real media worker imports `faster_whisper` lazily; the harness (e2e/fixtures.ts, `fakeControl`)
starts the worker with this folder first on PYTHONPATH (through ./ao-worker), so the worker's own
code runs end to end while speech recognition answers from here:

- `decode_audio` returns 20 s of silence for any file (the captured "videos" are a few fake bytes);
- `vad.get_speech_timestamps` says the whole 20 s is speech;
- `WhisperModel.transcribe` gives three English segments, the second with a low average
  log-probability, so the worker's own checks flag it "low-confidence" (hallucination.py);
- while the file `hold-speech` exists in the folder named by AO_FAKE_SPEECH_CONTROL (the harness's
  fake-control folder, `holdSpeech()` / `releaseSpeech()`), `WhisperModel.transcribe` waits before it
  answers, with a marker `held-speech-<worker pid>-<thread>` there for as long as it waits; a held
  transcription stops waiting once its job is cancelled (a quit), as the real one stops between segments;
- `utils.download_model` finds a model folder the test planted (`models--Systran--faster-whisper-<name>`,
  `refs/main` naming its snapshot) and never downloads anything.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np

__version__ = "0.0.0-fake"

SAMPLE_RATE = 16000
DURATION_SEC = 20

SEGMENTS = (
    (0.0, 6.0, "Welcome to the market in Kumasi.", -0.2),
    (6.0, 13.0, "The traders open their stalls before sunrise.", -1.6),
    (13.0, 20.0, "Prices are agreed by talking, never written down.", -0.3),
)


def decode_audio(path, sampling_rate: int = SAMPLE_RATE, **_kw):
    with open(path, "rb"):
        pass  # the file must exist and be readable, as for the real one
    return np.zeros(DURATION_SEC * sampling_rate, dtype=np.float32)


def _job_cancelled():
    """The `cancelled` test of the worker job this call runs in (its JobContext `ctx`, up the stack), or None."""
    frame = sys._getframe(1)
    while frame is not None:
        ctx = frame.f_locals.get("ctx")
        if ctx is not None and hasattr(ctx, "cancelled") and hasattr(ctx, "job"):
            return lambda: bool(ctx.cancelled)
        frame = frame.f_back
    return None


def _wait_while_held() -> None:
    control = os.environ.get("AO_FAKE_SPEECH_CONTROL")
    if not control:
        return
    hold = Path(control) / "hold-speech"
    if not hold.exists():
        return
    cancelled = _job_cancelled() or (lambda: False)
    marker = Path(control) / f"held-speech-{os.getpid()}-{threading.get_ident()}"
    marker.write_text("held")
    try:
        # The worker checks for a cancel after this returns, and ends the job cancelled.
        while hold.exists() and not cancelled():
            time.sleep(0.05)
    finally:
        marker.unlink(missing_ok=True)


class WhisperModel:
    def __init__(self, path, device: str = "auto", compute_type: str = "int8", cpu_threads: int = 0, **_kw):
        self.path = path

    def detect_language(self, audio):
        return "en", 0.99, [("en", 0.99)]

    def transcribe(self, audio, language=None, multilingual=False, vad_filter=True, word_timestamps=False, **_kw):
        _wait_while_held()
        segs = [
            SimpleNamespace(start=a, end=b, text=f" {t}", avg_logprob=lp, no_speech_prob=0.02, compression_ratio=1.2, words=[])
            for a, b, t, lp in SEGMENTS
        ]
        info = SimpleNamespace(language=language or "en", language_probability=0.99, duration=float(DURATION_SEC))
        return iter(segs), info
