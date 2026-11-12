"""Voice-activity detection of the fake faster-whisper: everything is speech."""
from __future__ import annotations


class VadOptions:
    def __init__(self, **_kw):
        pass


def get_speech_timestamps(audio, options=None, **_kw):
    return [{"start": 0, "end": len(audio)}] if len(audio) else []
