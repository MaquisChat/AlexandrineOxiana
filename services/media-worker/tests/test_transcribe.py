import json
import subprocess

import pytest

from conftest import SPEECH_CLIP, need_download

pytestmark = pytest.mark.slow


def test_transcribes_speech_clip(worker, tmp_path):
    clip = need_download(SPEECH_CLIP)
    out = tmp_path / "t"
    job = worker.run("audio.transcribe", str(clip), str(out), {"model": "tiny", "language": "auto"}, timeout=600)
    assert job["status"] == "done", job
    vtt = (out / "transcript.vtt").read_text()
    assert vtt.startswith("WEBVTT")
    assert "-->" in vtt
    segments = json.loads((out / "segments.json").read_text())
    assert segments, "no segments"
    for s in segments:
        assert s["lang"] == "en"
        assert set(s) >= {"start", "end", "text", "lang", "avgLogprob", "noSpeechProb", "compressionRatio", "flags"}
        assert 0 <= s["start"] <= s["end"]
    text = " ".join(s["text"] for s in segments).lower()
    assert "curiosity" in text
    meta = job["result"]["meta"]
    assert meta["model"] == "tiny"
    assert meta["detectedLanguages"] == ["en"]
    assert 3.0 < meta["durationSec"] < 4.0
    assert meta["flaggedCount"] == sum(1 for s in segments if s["flags"])
    assert job["result"]["output"] == str(out)


def test_silence_yields_no_unflagged_segments(worker, tmp_path):
    silence = tmp_path / "silence.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "10", str(silence)], check=True)
    out = tmp_path / "t"
    job = worker.run("audio.transcribe", str(silence), str(out), {"model": "tiny"}, timeout=600)
    assert job["status"] == "done", job
    segments = json.loads((out / "segments.json").read_text())
    assert all(s["flags"] for s in segments)
    assert (out / "transcript.vtt").read_text().startswith("WEBVTT")


def test_rejects_unknown_model(worker, tmp_path):
    status, body = worker.request("POST", "/jobs", {"type": "audio.transcribe", "input": str(tmp_path / "a.wav"), "output": str(tmp_path), "params": {"model": "huge"}})
    assert status == 400
