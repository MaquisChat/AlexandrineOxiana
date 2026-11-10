import json
import subprocess


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def tags(info):
    return {k.lower(): v for k, v in info["format"].get("tags", {}).items()}


def test_fixture_has_location(mov_with_location):
    assert "location" in tags(probe(mov_with_location))


def test_mov_to_mp4_strip_location(worker, mov_with_location, tmp_path):
    out = tmp_path / "proxy.mp4"
    job = worker.run("video.proxy", str(mov_with_location), str(out), {"location": "strip", "maxHeight": 720}, timeout=300)
    assert job["status"] == "done", job
    info = probe(out)
    streams = {s["codec_type"]: s for s in info["streams"]}
    assert streams["video"]["codec_name"] == "h264"
    assert streams["audio"]["codec_name"] == "aac"
    assert streams["video"]["height"] == 720
    assert "mp4" in info["format"]["format_name"]
    t = tags(info)
    assert not any("location" in k or "xyz" in k for k in t), t
    assert t.get("creation_time", "").startswith("2026-03-14T14:15:30")
    assert job["progress"] == 1
    meta = job["result"]["meta"]
    assert 2.5 < meta["durationSec"] < 3.5


def test_mov_to_mp4_coarsen_location(worker, mov_with_location, tmp_path):
    out = tmp_path / "proxy.mp4"
    job = worker.run("video.proxy", str(mov_with_location), str(out), {"location": "coarsen"}, timeout=300)
    assert job["status"] == "done", job
    t = tags(probe(out))
    # ffmpeg's MP4 muxer re-formats the ISO 6709 string with 4 decimals ("+40.7000-074.0000/"):
    # compare the values; the precision beyond one decimal must be gone.
    from ao_worker.location import parse_iso6709

    assert parse_iso6709(t["location"]) == (40.7, -74.0), t["location"]
    assert not any(k != "location" and ("location" in k or "xyz" in k) and parse_iso6709(v) not in (None, (40.7, -74.0)) for k, v in t.items()), t


def test_mov_to_mp4_keep_location(worker, mov_with_location, tmp_path):
    out = tmp_path / "proxy.mp4"
    job = worker.run("video.proxy", str(mov_with_location), str(out), {"location": "keep"}, timeout=300)
    assert job["status"] == "done", job
    assert tags(probe(out))["location"] == "+40.7128-074.0060/"


def test_faststart_moov_before_mdat(worker, mov_with_location, tmp_path):
    out = tmp_path / "proxy.mp4"
    worker.run("video.proxy", str(mov_with_location), str(out), {"location": "strip"}, timeout=300)
    data = out.read_bytes()
    assert data.find(b"moov") < data.find(b"mdat")
