"""Writes the manifest of a packaged worker: what was built, on what, and which third-party
packages (with licences) are inside. Run with the build venv's Python by build-sidecars.mjs.

    python manifest.py --bundle <folder> --target <triple> --pin-set <name> [--constraints <file>] --out <file>

Licences come from each package's metadata (PEP 639 `License-Expression`, else `License`, else the
trove classifiers). `copyleft` is "yes", "weak", "no" or "unclear"; it is a pointer for a human
review, not a legal judgement.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import sys
from importlib import metadata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dists import canonical, runtime_dists  # noqa: E402

STRONG = re.compile(r"\b(A?GPL|GNU (Affero )?General Public)", re.I)
WEAK = re.compile(r"\b(LGPL|MPL|Mozilla Public|EPL|Eclipse Public|CDDL|Lesser General Public)", re.I)
PERMISSIVE = re.compile(r"\b(MIT|BSD|Apache|ISC|PSF|Python Software Foundation|Unlicense|HPND|Zlib|CC0|0BSD|Historical Permission)", re.I)


def licence_of(meta) -> str:
    expr = meta.get("License-Expression")
    if expr:
        return expr.strip()
    classifiers = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    raw = (meta.get("License") or "").strip()
    # Some packages put the whole licence text in `License`; keep only a short name.
    if raw and len(raw) <= 80 and "\n" not in raw and raw.upper() != "UNKNOWN":
        return raw
    if classifiers:
        return " AND ".join(sorted(set(classifiers)))
    return (raw.splitlines()[0][:80] + " …") if raw else "UNKNOWN"


def copyleft(licence: str) -> str:
    # "LGPL" contains "GPL": test weak copyleft first, then strong.
    without_weak = WEAK.sub("", licence)
    if STRONG.search(without_weak):
        return "yes"
    if WEAK.search(licence):
        return "weak"
    if PERMISSIVE.search(licence):
        return "no"
    return "unclear"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True, type=Path)
    ap.add_argument("--target", required=True)
    ap.add_argument("--pin-set", required=True)
    ap.add_argument("--constraints", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    internal = args.bundle / "_internal"
    packages = []
    for name in runtime_dists():
        if name == "ao-worker":
            continue
        dist = metadata.distribution(name)
        lic = licence_of(dist.metadata)
        info_dir = f"{dist.metadata['Name'].replace('-', '_')}-{dist.version}.dist-info"
        candidates = [d for d in internal.glob("*.dist-info") if canonical(d.name.rsplit("-", 1)[0]) == name]
        files = sorted(str(p.relative_to(args.bundle)) for d in candidates for p in d.rglob("*")
                       if p.is_file() and re.search(r"(licen[cs]e|copying|notice|authors)", p.name, re.I) and p.suffix != ".pyc")
        packages.append({
            "name": dist.metadata["Name"], "version": dist.version, "licence": lic, "copyleft": copyleft(lic),
            "licenceFiles": files, "metadataDir": candidates[0].name if candidates else info_dir,
        })
    manifest = {
        "name": "ao-worker",
        "workerVersion": metadata.version("ao-worker"),
        "python": platform.python_version(),
        "platform": sys.platform,
        "arch": platform.machine(),
        "target": args.target,
        "pinSet": args.pin_set,
        "constraints": None if not args.constraints else {
            "file": args.constraints.name, "sha256": hashlib.sha256(args.constraints.read_bytes()).hexdigest(),
        },
        "pyinstaller": metadata.version("pyinstaller"),
        "notBundled": ["ffmpeg", "ffprobe", "tesseract", "ghostscript", "yt-dlp", "speech models"],
        "packages": packages,
    }
    args.out.write_text(json.dumps(manifest, indent=1) + "\n")
    flagged = [f"{p['name']} {p['version']}: {p['licence']} ({p['copyleft']})" for p in packages if p["copyleft"] != "no"]
    print(f"manifest: {len(packages)} bundled packages; licences to review: {len(flagged)}")
    for line in flagged:
        print(f"  review: {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
