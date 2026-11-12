import json
import subprocess

import pytest

from conftest import SPEECH_CLIP, need_download

pytestmark = pytest.mark.slow


def test_transcribes_speech_clip(worker, tmp_path, tiny_on_disk):
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


@pytest.fixture
def tiny_on_disk(worker_env):
    """The tiny model in AO_MODELS_DIR (downloaded once if needed, before any network block)."""
    from faster_whisper.utils import download_model

    return download_model("tiny", cache_dir=str(worker_env["models"]))


def test_model_on_disk_loads_without_any_network_contact(worker, tmp_path, tiny_on_disk, no_network):
    from ao_worker import transcribe

    transcribe._model_cache.clear()  # make this job load the model, not reuse one in memory
    out = tmp_path / "t"
    job = worker.run("audio.transcribe", str(need_download(SPEECH_CLIP)), str(out), {"model": "tiny", "language": "en"}, timeout=600)
    assert job["status"] == "done", job
    assert "curiosity" in " ".join(s["text"] for s in json.loads((out / "segments.json").read_text())).lower()
    assert no_network.attempts == []


def test_missing_model_is_named_and_never_downloaded(worker, worker_env, tmp_path, monkeypatch, no_network):
    """Task 48 replaces R144's automatic first download: an absent model fails the job, naming the tool."""
    from ao_worker import transcribe

    transcribe._model_cache.clear()
    monkeypatch.setenv("AO_MODELS_DIR", str(tmp_path / "no-models"))
    job = worker.run("audio.transcribe", str(need_download(SPEECH_CLIP)), str(tmp_path / "t"), {"model": "tiny", "language": "en"}, timeout=120)
    assert job["status"] == "failed", job
    assert job["error"]["code"] == "TOOL_NOT_INSTALLED"
    assert job["error"]["tool"] == "speech-tiny"
    assert "not installed" in job["error"]["message"]
    assert no_network.attempts == []


def _damaged_copy(tiny_path: str, dest) -> None:
    """A copy of the models folder holding tiny, with the snapshot's model.bin removed."""
    import shutil
    from pathlib import Path

    snapshot = Path(tiny_path)
    cache = snapshot.parents[2]  # <cache>/models--Systran--faster-whisper-tiny/snapshots/<rev>
    shutil.copytree(cache, dest, symlinks=True)
    (dest / snapshot.relative_to(cache) / "model.bin").unlink()


def test_damaged_model_on_disk_is_reported_and_not_downloaded(worker_env, tmp_path, monkeypatch, tiny_on_disk):
    from conftest import NoNetwork

    from ao_worker import transcribe
    from ao_worker.jobs import JobError

    _damaged_copy(tiny_on_disk, tmp_path / "models")
    monkeypatch.setenv("AO_MODELS_DIR", str(tmp_path / "models"))
    nn = NoNetwork(monkeypatch)
    with pytest.raises(JobError) as e:
        transcribe.model_path("tiny")
    assert e.value.code == "MODEL_UNAVAILABLE"
    assert "incomplete or damaged" in e.value.message and "could not be downloaded" not in e.value.message
    assert nn.attempts == []


def test_unreadable_models_folder_is_reported_and_not_downloaded(worker_env, tmp_path, monkeypatch):
    from conftest import NoNetwork

    from ao_worker import transcribe
    from ao_worker.jobs import JobError

    not_a_folder = tmp_path / "models"
    not_a_folder.write_text("not a folder")
    monkeypatch.setenv("AO_MODELS_DIR", str(not_a_folder))
    nn = NoNetwork(monkeypatch)
    with pytest.raises(JobError) as e:
        transcribe.model_path("tiny")
    assert e.value.code == "MODEL_UNAVAILABLE"
    assert "could not be read" in e.value.message
    assert nn.attempts == []


def test_absent_model_is_never_downloaded(worker_env, tmp_path, monkeypatch):
    from conftest import NoNetwork

    from ao_worker import transcribe
    from ao_worker.jobs import JobError

    monkeypatch.setenv("AO_MODELS_DIR", str(tmp_path / "models"))  # does not exist yet: absent
    nn = NoNetwork(monkeypatch)
    with pytest.raises(JobError) as e:
        transcribe.model_path("tiny")
    assert e.value.code == "TOOL_NOT_INSTALLED" and e.value.tool == "speech-tiny"
    assert nn.attempts == []


def test_silence_yields_no_unflagged_segments(worker, tmp_path, tiny_on_disk):
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
