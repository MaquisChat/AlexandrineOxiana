"""Writes the manifest of a packaged worker and its licence folder. Run with the build venv's
Python by build-sidecars.mjs, after PyInstaller:

    python manifest.py --bundle <folder> --target <triple> --pin-set <name> [--constraints <file>] --out <file>

1. `packages`: every bundled Python distribution, with its licence as its metadata states it
   (PEP 639 `License-Expression`, else `License`, else trove classifiers), its licence files, and
   a `binaryWheelStatement` when the wheel's own text states a licence for its binary wheels.
2. `nativeLibraries`: every shared library in the bundle that is not a Python extension module:
   the ones wheels vendor (`*.libs/`, `*/.dylibs/`), other non-extension libraries inside a
   package folder, and the ones PyInstaller took from the build machine. For each: the package
   (or "build machine") that carries it and its licence **as stated** by the carrying wheel's own
   files or metadata, by the library itself (FFmpeg compiles its licence in), or "unknown" when
   nothing in the bundle states it. Nothing is inferred from a library's name.
3. `licenses/` next to the executable: every bundled package's licence files, the build Python's
   licence, the GNU licence texts (GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0) the stated licences refer
   to, and `README.txt`, a table of the native libraries.

`copyleft` is "yes", "weak", "runtime-exception", "choice" (the text offers a copyleft and a
non-copyleft option), "no" or "unknown": a pointer for a human review, not a legal judgement.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import platform
import re
import shutil
import sys
import sysconfig
from importlib import metadata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from dists import canonical, runtime_dists  # noqa: E402

STRONG = re.compile(r"\b(A?GPL|GNU (Affero )?General Public|GPLv[23])", re.I)
WEAK = re.compile(r"\b(LGPL|MPL|Mozilla Public|EPL|Eclipse Public|CDDL|Lesser General Public|Library General Public)", re.I)
PERMISSIVE = re.compile(r"\b(MIT|BSD|Apache|ISC|PSF|Python Software Foundation|Unlicense|HPND|Zlib|CC0|0BSD|Historical Permission|IJG|public domain)", re.I)
GNU_TEXTS = ("GPL-2.0.txt", "GPL-3.0.txt", "LGPL-2.1.txt", "LGPL-3.0.txt")

# What a wheel's own licence files say about a library it vendors, where the wording is not one of
# the "Name: / License: / Files:" blocks parsed below. Each entry was read in the named file; at
# build time the quote must still be in that file (whitespace-normalised), or the library falls
# back to "unknown". (carrier, library stem, licence as stated, copyleft, file in the dist-info, quote)
STATED = [
    # pillow: LICENSE has one section per bundled library, each the library's licence text.
    ("pillow", "libXau", "permission notice of The Open Group (text in section XAU)", "no", "licenses/LICENSE", "Copyright 1988, 1993, 1994, 1998 The Open Group"),
    ("pillow", "libavif", "BSD-style notice (text in section LIBAVIF)", "no", "licenses/LICENSE", "Copyright 2019 Joe Drago"),
    ("pillow", "libbrotlicommon", "MIT-style notice (text in section BROTLI)", "no", "licenses/LICENSE", "by the Brotli Authors"),
    ("pillow", "libbrotlidec", "MIT-style notice (text in section BROTLI)", "no", "licenses/LICENSE", "by the Brotli Authors"),
    ("pillow", "libfreetype", "FreeType License or GPL-2.0, at the licensee's choice (section FREETYPE2)", "choice", "licenses/LICENSE", "we distribute it under two mutually exclusive open-source licenses"),
    ("pillow", "libharfbuzz", '"Old MIT" license (section HARFBUZZ)', "no", "licenses/LICENSE", 'HarfBuzz is licensed under the so-called "Old MIT" license'),
    ("pillow", "libjpeg", "IJG libjpeg terms (text in section LIBJPEG)", "no", "licenses/LICENSE", "You can use this software for whatever you want"),
    ("pillow", "liblcms2", "MIT-style notice of Little CMS (section LCMS2)", "no", "licenses/LICENSE", "Little CMS Copyright (c) 1998-2020 Marti Maria Saguer"),
    ("pillow", "liblzma", "public domain (section LIBLZMA: \"liblzma is in the public domain\")", "no", "licenses/LICENSE", "liblzma is in the public domain"),
    ("pillow", "libopenjp2", "2-clauses BSD License (section OPENJPEG)", "no", "licenses/LICENSE", "being made available under the 2-clauses"),
    ("pillow", "libpng16", "PNG Reference Library License version 2 (section LIBPNG)", "no", "licenses/LICENSE", "PNG Reference Library License version 2"),
    ("pillow", "libsharpyuv", "BSD-style notice of Google (section LIBWEBP)", "no", "licenses/LICENSE", "Copyright (c) 2010, Google Inc. All rights reserved."),
    ("pillow", "libtiff", "permission notice of Sam Leffler and SGI (section LIBTIFF)", "no", "licenses/LICENSE", "Copyright (c) 1988-1997 Sam Leffler"),
    ("pillow", "libwebp", "BSD-style notice of Google (section LIBWEBP)", "no", "licenses/LICENSE", "Copyright (c) 2010, Google Inc. All rights reserved."),
    ("pillow", "libwebpdemux", "BSD-style notice of Google (section LIBWEBP)", "no", "licenses/LICENSE", "Copyright (c) 2010, Google Inc. All rights reserved."),
    ("pillow", "libwebpmux", "BSD-style notice of Google (section LIBWEBP)", "no", "licenses/LICENSE", "Copyright (c) 2010, Google Inc. All rights reserved."),
    ("pillow", "libxcb", "MIT-style notice (section XCB)", "no", "licenses/LICENSE", "Bart Massey, Jamey Sharp, and Josh Triplett"),
    ("pillow", "libzstd", "BSD License (section ZSTD)", "no", "licenses/LICENSE", "BSD License For Zstandard software"),
    # pikepdf: third-party-licenses/README.md has a table of its vendored libraries.
    ("pikepdf", "libqpdf", "Apache-2.0 (third-party-licenses/README.md)", "no", "licenses/third-party-licenses/README.md", "| Apache-2.0 | [`qpdf.txt`](qpdf.txt) |"),
    ("pikepdf", "libjpeg", "IJG + BSD-3-Clause + Zlib (third-party-licenses/README.md)", "no", "licenses/third-party-licenses/README.md", "| IJG + BSD-3-Clause + Zlib |"),
    # rawpy: ships LibRaw's licence as LICENSE.LibRaw (the LGPL 2.1 text).
    ("rawpy", "libraw_r", "GNU LGPL version 2.1 (text shipped as LICENSE.LibRaw)", "weak", "licenses/LICENSE.LibRaw", "GNU LESSER GENERAL PUBLIC LICENSE Version 2.1"),
]
# A library that is the package's own code: its licence is the package's metadata licence.
OWN_LIBRARIES = {("ctranslate2", "libctranslate2"), ("onnxruntime", "libonnxruntime_providers_shared"), ("pypdfium2", "libpdfium")}


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def licence_of(meta) -> str:
    expr = meta.get("License-Expression")
    if expr:
        return expr.strip()
    classifiers = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    raw = (meta.get("License") or "").strip()
    if raw and len(raw) <= 80 and "\n" not in raw and raw.upper() != "UNKNOWN":
        return raw
    if classifiers:
        return " AND ".join(sorted(set(classifiers)))
    return (raw.splitlines()[0][:80] + " …") if raw else "UNKNOWN"


def copyleft(licence: str) -> str:
    if re.search(r"dependenc(y|ies)['’]? licen[cs]es?", licence, re.I):
        return "unknown"  # e.g. pypdfium2: "BSD-3-Clause, Apache-2.0, dependency licenses" (which ones is not stated)
    if re.search(r"exception", licence, re.I) and STRONG.search(licence):
        return "runtime-exception"
    without_weak = WEAK.sub("", licence)
    if STRONG.search(without_weak):
        return "yes"
    if WEAK.search(licence):
        return "weak"
    if PERMISSIVE.search(licence):
        return "no"
    return "unclear"


def lib_stem(filename: str) -> str:
    """`libx265-f5385bb8.so.216` → `libx265`; `libpng16.16.dylib` → `libpng16`."""
    stem = re.split(r"\.(?:so|dylib)(?:\.|$)", filename, maxsplit=1)[0]
    stem = re.sub(r"\.\d+(\.\d+)*$", "", stem)  # macOS: libfoo.1.2.dylib
    return re.sub(r"(-[0-9a-f]{8})+$", "", stem)


def is_shared_library(p: Path) -> bool:
    return p.is_file() and not p.is_symlink() and re.search(r"\.(so|dylib)(\.|$)", p.name) is not None


def is_extension_module(p: Path) -> bool:
    return ".cpython-" in p.name or ".abi3." in p.name or p.name.endswith(".pyd")


def name_blocks(text: str) -> list[dict]:
    """`Name: … / Files: … / License: …` blocks (numpy's LICENSE.txt, pillow-heif's LICENSES_bundled.txt)."""
    blocks, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^(Name|Files|License):\s*(.+?)\s*$", line)
        if not m:
            continue
        key, value = m.groups()
        if key == "Name":
            cur = {"name": value, "files": [], "license": None}
            blocks.append(cur)
        elif cur is not None and key == "Files":
            cur["files"] += [f.strip() for f in value.split(",") if f.strip()]
        elif cur is not None and key == "License" and cur["license"] is None:
            cur["license"] = value
    return [b for b in blocks if b["files"] and b["license"]]


def block_matches(pattern: str, filename: str, stem: str) -> bool:
    base = pattern.rsplit("/", 1)[-1]
    if "*" in base and fnmatch.fnmatch(filename, base):
        return True
    pstem = re.split(r"[.*\[]", base, maxsplit=1)[0]
    return bool(pstem) and (stem == pstem or ("*" in base and stem.startswith(pstem)))


class Dist:
    def __init__(self, name: str, internal: Path):
        self.name = name
        self.dist = metadata.distribution(name)
        dirs = [d for d in internal.glob("*.dist-info")
                if canonical(d.name.removesuffix(".dist-info").rsplit("-", 1)[0]) == name]
        self.info_dir = dirs[0] if dirs else None
        self.licence = licence_of(self.dist.metadata)

    def licence_files(self) -> list[Path]:
        if not self.info_dir:
            return []
        return sorted(p for p in self.info_dir.rglob("*") if p.is_file() and p.suffix != ".pyc" and (
            "licenses" in p.relative_to(self.info_dir).parts or "license_files" in p.relative_to(self.info_dir).parts
            or re.search(r"(licen[cs]e|copying|notice)", p.name, re.I)))

    def text(self, rel: str) -> str | None:
        p = self.info_dir / rel if self.info_dir else None
        return p.read_text(encoding="utf-8", errors="replace") if p and p.is_file() else None


def statement_for(lib: Path, carrier: Dist | None) -> dict:
    stem = lib_stem(lib.name)
    if carrier is None:
        if stem.startswith("libpython"):
            return {"licence": "PSF licence of the build machine's Python (its LICENSE.txt, copied to licenses/python/)",
                    "copyleft": "no", "statedBy": "build Python's LICENSE.txt"}
        return {"licence": "unknown", "copyleft": "unknown", "statedBy": "nothing in the bundle (collected from the build machine)"}
    if (carrier.name, stem) in OWN_LIBRARIES:
        cl = copyleft(carrier.licence)
        note = "; the dependency licences it mentions are not named there" if cl == "unknown" else ""
        return {"licence": f"{carrier.licence} (the package's own library{note})", "copyleft": cl,
                "statedBy": f"{carrier.dist.metadata['Name']} metadata"}
    for name, s, lic, cl, rel, quote in STATED:
        if name == carrier.name and s == stem:
            text = carrier.text(rel)
            if text is not None and norm(quote) in norm(text):
                return {"licence": lic, "copyleft": cl, "statedBy": f"{carrier.info_dir.name}/{rel}"}
    for f in carrier.licence_files():
        text = f.read_text(encoding="utf-8", errors="replace")
        for b in name_blocks(text):
            if any(block_matches(pat, lib.name, stem) for pat in b["files"]):
                return {"licence": f"{b['license']} ({b['name']})", "copyleft": copyleft(b["license"]),
                        "statedBy": str(f.relative_to(carrier.info_dir.parent))}
    data = lib.read_bytes()
    m = re.search(rb"\x00(lib\w+) license: ((?:L?GPL) version [23] or later|nonfree and unredistributable)\x00", data)
    if m:  # FFmpeg's libraries compile in their licence ("libavutil license: LGPL version 3 or later")
        lic = m.group(2).decode()
        return {"licence": lic, "copyleft": copyleft(lic), "statedBy": "the library itself (compiled-in licence string)"}
    return {"licence": "unknown", "copyleft": "unknown", "statedBy": f"nothing in the {carrier.dist.metadata['Name']} wheel"}


def native_library_files(internal: Path) -> list[Path]:
    """Every shared library in `_internal` that is a real file and not a Python extension module."""
    return sorted(p for p in internal.rglob("*") if is_shared_library(p) and not is_extension_module(p))


def bundled_dist_names(internal: Path) -> set[str]:
    return {canonical(d.name.removesuffix(".dist-info").rsplit("-", 1)[0]) for d in internal.glob("*.dist-info")}


RANK = {"no": 0, "runtime-exception": 1, "choice": 2, "weak": 3, "unclear": 4, "unknown": 4, "yes": 5}


def roll_up(values: list[str]) -> str:
    """The strictest of several copyleft values. "unknown" outranks every known value except "yes",
    so a package with one unknown library is never reported as permissive."""
    return max(values, key=RANK.get)


def check_complete(bundle: Path, manifest: dict) -> list[str]:
    """Differences between what the bundle contains and what the manifest lists (empty when none):
    every Python distribution (a `*.dist-info` folder) and every native library."""
    internal = bundle / "_internal"
    problems = []
    listed = {canonical(p["name"]) for p in manifest.get("packages", [])}
    present = bundled_dist_names(internal)
    problems += [f"package {n} is in the bundle but not in the manifest" for n in sorted(present - listed)]
    # gallery-dl is GPL-2.0-only and not shipped inside the worker (R152): a first-use download.
    problems += [f"package {n} must not be inside the worker (R152: gallery-dl is a first-use download)" for n in sorted((present | listed) & {"gallery-dl"})]
    problems += [f"package {n} is in the manifest but not in the bundle" for n in sorted(listed - present)]
    listed_libs = {x["path"] for x in manifest.get("nativeLibraries", [])}
    present_libs = {str(p.relative_to(bundle)) for p in native_library_files(internal)}
    problems += [f"native library {p} is in the bundle but not in the manifest" for p in sorted(present_libs - listed_libs)]
    problems += [f"native library {p} is in the manifest but not in the bundle" for p in sorted(listed_libs - present_libs)]
    return problems


def review_lines(manifest: dict) -> list[str]:
    """What a licence review should look at: every package or native library that is not plainly
    permissive, as stated."""
    lines = [f"review: {p['name']} {p['version']}: {p['licence']} ({p['copyleft']})" for p in manifest["packages"] if p["copyleft"] != "no"]
    lines += [f"review: {p['name']} with its native libraries: {p['copyleftIncludingNativeLibraries']}"
              for p in manifest["packages"] if p.get("copyleftIncludingNativeLibraries", "no") not in ("no", p["copyleft"])]
    lines += [f"native: {x['library']} ({x['carriedBy']}): {x['licence']} [{x['copyleft']}]"
              for x in manifest["nativeLibraries"] if x["copyleft"] != "no"]
    return lines


def native_libraries(bundle: Path, dists: dict[str, Dist]) -> list[dict]:
    internal = bundle / "_internal"
    owner_of_dir = {}
    for top, names in metadata.packages_distributions().items():
        for n in names:
            if canonical(n) in dists:
                owner_of_dir[top] = canonical(n)
    out = []
    for lib in native_library_files(internal):
        rel = lib.relative_to(internal)
        top = rel.parts[0]
        if len(rel.parts) == 1:
            carrier = None
        elif top.endswith(".libs"):
            carrier = dists.get(owner_of_dir.get(top.removesuffix(".libs")) or canonical(top.removesuffix(".libs")))
        else:
            carrier = dists.get(owner_of_dir.get(top, ""))
        st = statement_for(lib, carrier)
        out.append({"library": lib.name, "path": str(lib.relative_to(bundle)),
                    "carriedBy": carrier.dist.metadata["Name"] if carrier else "build machine (collected by PyInstaller)", **st})
    return out


def write_licence_folder(bundle: Path, dists: dict[str, Dist], libs: list[dict]) -> Path:
    folder = bundle / "licenses"
    shutil.rmtree(folder, ignore_errors=True)
    (folder / "gnu").mkdir(parents=True)
    for t in GNU_TEXTS:
        shutil.copyfile(HERE / "licenses" / t, folder / "gnu" / t)
    for d in dists.values():
        for f in d.licence_files():
            dest = folder / "packages" / d.dist.metadata["Name"] / f.relative_to(d.info_dir)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, dest)
    py_licence = Path(sysconfig.get_paths()["stdlib"]) / "LICENSE.txt"
    if py_licence.is_file():
        (folder / "python").mkdir()
        shutil.copyfile(py_licence, folder / "python" / "LICENSE.txt")
    lines = [
        "Native libraries in this folder's bundle, with their licence as the bundle itself states it.",
        "Written by services/media-worker/packaging/manifest.py; facts only, not a legal assessment.",
        "",
        "  packages/<name>/  each bundled Python package's own licence files (as shipped in its wheel)",
        "  gnu/              GNU GPL-2.0, GPL-3.0, LGPL-2.1 and LGPL-3.0, which the statements below refer to",
        "  python/           the licence of the Python the worker was built with",
        "",
        "library | carried by | licence as stated | copyleft | stated by",
        "--- | --- | --- | --- | ---",
        *[f"{x['library']} | {x['carriedBy']} | {x['licence']} | {x['copyleft']} | {x['statedBy']}" for x in libs],
        "",
    ]
    (folder / "README.txt").write_text("\n".join(lines), encoding="utf-8")
    return folder


def binary_wheel_statement(d: Dist) -> str | None:
    for f in d.licence_files():
        m = re.search(r"License for \W?[\w-]+\W? binary wheels?:\s*([^\n]+)", f.read_text(encoding="utf-8", errors="replace"))
        if m:
            return m.group(1).strip()
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True, type=Path)
    ap.add_argument("--target")
    ap.add_argument("--pin-set")
    ap.add_argument("--constraints", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--check", action="store_true", help="only compare an existing manifest (--out) with the bundle")
    args = ap.parse_args()

    if args.check:
        return report_completeness(args.bundle, json.loads(args.out.read_text()))
    if not args.target or not args.pin_set:
        ap.error("--target and --pin-set are required unless --check is given")
    internal = args.bundle / "_internal"
    dists = {n: Dist(n, internal) for n in runtime_dists() if n != "ao-worker"}
    libs = native_libraries(args.bundle, dists)
    folder = write_licence_folder(args.bundle, dists, libs)
    packages = []
    for d in dists.values():
        own = [x for x in libs if x["carriedBy"] == d.dist.metadata["Name"]]
        wheel = binary_wheel_statement(d)
        entry = {
            "name": d.dist.metadata["Name"], "version": d.dist.version, "licence": d.licence, "copyleft": copyleft(d.licence),
            "licenceFiles": [str(p.relative_to(args.bundle)) for p in d.licence_files()],
        }
        if wheel:
            entry["binaryWheelStatement"] = wheel
        if own or wheel:
            if own:
                entry["nativeLibraries"] = len(own)
            entry["copyleftIncludingNativeLibraries"] = roll_up(
                [entry["copyleft"], *([copyleft(wheel)] if wheel else []), *(x["copyleft"] for x in own)])
        packages.append(entry)
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
        "licenceFolder": str(folder.relative_to(args.bundle)),
        "packages": packages,
        "nativeLibraries": libs,
    }
    args.out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"manifest: {len(packages)} bundled packages, {len(libs)} native libraries")
    for line in review_lines(manifest):
        print(f"  {line}")
    nolicence = [p["name"] for p in packages if not p["licenceFiles"]]
    if nolicence:
        print(f"  packages whose wheel ships no licence file: {', '.join(nolicence)}")
    return report_completeness(args.bundle, manifest)


def report_completeness(bundle: Path, manifest: dict) -> int:
    problems = check_complete(bundle, manifest)
    if problems:
        print(f"manifest check FAILED: {len(problems)} difference(s) between the bundle and its manifest", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(f"manifest check: every package ({len(manifest['packages'])}) and native library "
          f"({len(manifest['nativeLibraries'])}) in the bundle is in the manifest, and nothing else")
    return 0


if __name__ == "__main__":
    sys.exit(main())
