"""Opt-in live check of the video downloader (R133): the real yt-dlp, with the JavaScript runtime the
worker names to it, against one public address, to catch drift such as YouTube starting to need a
runtime yt-dlp is not given. NEVER run in CI and never by default: it uses the network, downloads
the latest yt-dlp and the pinned deno exactly as the tools dialogue does, and asks a real site.

    services/media-worker/.venv/bin/python services/media-worker/scripts/live_check.py --network
    ... --url https://www.youtube.com/watch?v=<id>   # another public address
    ... --tools-dir <folder>                          # reuse a tools folder (default: a new temporary one)

What it does:
1. installs the video downloader (yt-dlp: latest release, checked against its SHA2-256SUMS; deno:
   pinned address and SHA-256) into the tools folder, through the worker's own install code;
2. runs the real yt-dlp with exactly the arguments a capture uses (metadata only, into a temporary
   folder), including `--js-runtimes deno:<path>`;
3. passes when the platform's JSON names the video and lists formats, and yt-dlp printed no
   warning about a missing JavaScript runtime or an unsolved challenge.

Exit code 0 when it passed; 1 when the check failed (the output says why); 2 when it was not asked
for properly; 3 when the site refused this computer (rate limit, sign-in wall): inconclusive, try
again later or from another network. Nothing about a library or a project is involved or sent.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

# "Me at the zoo", the first video on YouTube: public, short and long-lived.
DEFAULT_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
DRIFT = re.compile(r"javascript runtime|js runtime|challenge|nsig|signature extraction failed|only images are available", re.I)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", action="store_true", help="required: confirms that this check may use the network")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--tools-dir", type=Path)
    args = ap.parse_args()
    if not args.network:
        print("This check downloads yt-dlp and deno and asks a real site. Run it again with --network to confirm.", file=sys.stderr)
        return 2
    if os.environ.get("CI"):
        print("The live check is never run in CI (R133).", file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="ao-live-check-"))
    tools_dir = args.tools_dir or work / "tools"
    tools_dir.mkdir(parents=True, exist_ok=True)
    os.environ["AO_TOOLS_DIR"] = str(tools_dir)
    os.environ.pop("AO_YTDLP_BIN", None)

    from ao_worker import tools, toolpins
    from ao_worker.download import build_ytdlp_args, managed_ytdlp_path, map_error, redact
    from ao_worker.jobs import child_env

    def yt_path() -> str:
        return str(managed_ytdlp_path())

    try:
        print(f"1. installing the video downloader into {tools_dir}", flush=True)
        progress = tools.Progress(None, 1)
        for cid in toolpins.TOOLS["video-downloader"].components:
            c = toolpins.COMPONENTS[cid]
            if c.kind == "ytdlp" and managed_ytdlp_path().is_file():
                continue
            if c.kind != "ytdlp" and tools._managed(c) is not None:
                continue
            tools.install_component(c, progress, lambda: False)
        yt = tools.component_status(toolpins.COMPONENTS["yt-dlp"])
        deno = tools.component_status(toolpins.COMPONENTS["deno"])
        print(f"   yt-dlp {yt.version} ({yt.source}), deno {deno.version} ({deno.source})")
        if not (yt.usable and deno.usable):
            print("FAILED: the video downloader is not usable after installing it", file=sys.stderr)
            return 1

        print(f"2. reading the metadata of {args.url}", flush=True)
        out = work / "capture"
        out.mkdir()
        # Exactly the arguments a capture uses (download.run), metadata only, the runtime named.
        argv = [yt_path(), *build_ytdlp_args(args.url, str(out), {"metadataOnly": True}, js_runtime=tools.deno_path())]
        r = subprocess.run(argv, capture_output=True, text=True, timeout=600, env=child_env(str(work)), stdin=subprocess.DEVNULL)
        stderr_lines = (r.stderr or "").splitlines()
        infos = sorted(out.glob("*.info.json"))
        code = map_error(r.stderr or "") if r.returncode != 0 else None
        if r.returncode != 0:
            print(f"   yt-dlp exited with {r.returncode} ({code}):\n   " + redact("\n   ".join(stderr_lines[-5:])))
        if not infos:
            if code in ("RATE_LIMITED", "LOGIN_REQUIRED"):
                print("INCONCLUSIVE: the site refused this computer; try again later or from another network.", file=sys.stderr)
                return 3
            print("FAILED: no platform JSON came back", file=sys.stderr)
            return 1
        info = json.loads(Path(infos[0]).read_text(encoding="utf-8"))
        formats = info.get("formats") or []
        print(f"   {info.get('id')}: {info.get('title')!r}, {len(formats)} formats")
        drift = [redact(l) for l in stderr_lines if DRIFT.search(l)]
        if not info.get("id") or not formats or drift:
            print("FAILED: the downloader drifted:\n" + "\n".join(drift or [f"formats: {len(formats)}"]), file=sys.stderr)
            return 1
        print("3. passed: the real yt-dlp reads a public video with the JavaScript runtime the worker names")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
