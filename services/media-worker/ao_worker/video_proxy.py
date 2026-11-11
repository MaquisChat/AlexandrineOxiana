"""video.proxy: any ffmpeg-readable video → H.264/AAC MP4 (faststart), at most `maxHeight` lines.

Location: `keep` copies container metadata; `strip` and `coarsen` drop all of it
(`-map_metadata -1`) and write back only permitted tags (creation time, device make/model) plus,
for `coarsen`, the coarsened ISO 6709 location. Progress comes from `-progress pipe:1`.

ffmpeg and ffprobe are the app's own copies in the tools folder, else the system's (tools.which);
with neither the job fails with TOOL_NOT_INSTALLED (tool `ffmpeg`) and the media stays "proxy
pending" (R83, R90 c) until ffmpeg is installed and the job is retried.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from .download import redact
from .jobs import Job, JobContext, JobError, child_env
from .location import coarsen_iso6709

DEFAULTS = {"maxHeight": 1080, "crf": 23, "location": "keep"}

# Container tags that may be re-written after `-map_metadata -1` (lower-case keys as ffprobe reports them).
PERMITTED_TAGS = (
    "creation_time",
    "com.apple.quicktime.creationdate",
    "com.apple.quicktime.make",
    "com.apple.quicktime.model",
    "make",
    "model",
)
LOCATION_TAGS = ("location", "com.apple.quicktime.location.iso6709")


def _program(name: str) -> str:
    from .tools import not_installed, which

    found = which(name)
    if found is None:
        raise not_installed("ffmpeg")
    return found


def probe(path: Path) -> dict:
    r = subprocess.run(
        [_program("ffprobe"), "-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, env=child_env(),
    )
    if r.returncode != 0:
        raise JobError("UNSUPPORTED_INPUT", "the input is not a readable video file")
    return json.loads(r.stdout or "{}")


def metadata_args(tags: dict, mode: str) -> list[str]:
    """ffmpeg output options for the container metadata under `mode`."""
    if mode == "keep":
        return ["-map_metadata", "0"]
    args = ["-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1"]
    lower = {k.lower(): (k, v) for k, v in tags.items()}
    for key in PERMITTED_TAGS:
        if key in lower:
            orig, value = lower[key]
            args += ["-metadata", f"{orig}={value}"]
    if mode == "coarsen":
        for key in LOCATION_TAGS:
            if key in lower:
                orig, value = lower[key]
                coarse = coarsen_iso6709(value)
                if coarse:
                    args += ["-metadata", f"{orig}={coarse}"]
    return args


def run(job: Job, ctx: JobContext) -> dict:
    p = {**DEFAULTS, **job.params}
    src = Path(job.input)
    out = Path(job.output)
    if not src.is_file():
        raise JobError("INPUT_NOT_FOUND", "the input file does not exist")
    _program("ffmpeg")
    info = probe(src)
    streams = info.get("streams", [])
    if not any(s.get("codec_type") == "video" for s in streams):
        raise JobError("UNSUPPORTED_INPUT", "the input has no video stream")
    try:
        duration = float(info.get("format", {}).get("duration") or 0)
    except ValueError:
        duration = 0.0
    tags = info.get("format", {}).get("tags", {}) or {}
    max_h = int(p["maxHeight"])

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.{os.getpid()}.part.mp4")
    movflags = "+faststart+use_metadata_tags"
    argv = [
        _program("ffmpeg"), "-nostdin", "-hide_banner", "-v", "error", "-y",
        "-protocol_whitelist", "file,pipe",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        # even height (H.264 4:2:0 needs it), never upscaled
        "-vf", f"scale=-2:'trunc(min({max_h},ih)/2)*2'",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(int(p["crf"])), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        *metadata_args(tags, p["location"]),
        "-movflags", movflags,
        "-progress", "pipe:1", "-nostats",
        str(tmp),
    ]
    errf = tempfile.TemporaryFile(mode="w+", dir=ctx.workdir)
    try:
        proc = ctx.popen(argv, stdout=subprocess.PIPE, stderr=errf, text=True)
        assert proc.stdout is not None
        for line in proc.stdout:
            key, _, val = line.strip().partition("=")
            if key in ("out_time_us", "out_time_ms") and duration > 0:
                try:
                    ctx.progress(min(0.99, int(val) / 1_000_000 / duration))
                except ValueError:
                    pass
        rc = ctx.wait(proc)
        errf.seek(0)
        stderr = errf.read()
        if rc != 0:
            raise JobError("FFMPEG_FAILED", "ffmpeg could not convert the video", _tail(stderr, src))
        os.replace(tmp, out)
    finally:
        errf.close()
        tmp.unlink(missing_ok=True)
    result = probe(out)
    vs = next((s for s in result.get("streams", []) if s.get("codec_type") == "video"), {})
    return {
        "output": str(out),
        "meta": {
            "durationSec": float(result.get("format", {}).get("duration") or 0),
            "width": vs.get("width"),
            "height": vs.get("height"),
            "location": p["location"],
        },
    }


def _tail(stderr: str, src: Path) -> str:
    """Last lines of ffmpeg's stderr without the input's path."""
    text = "\n".join(stderr.strip().splitlines()[-10:])
    return redact(text.replace(str(src), "<input>"))
