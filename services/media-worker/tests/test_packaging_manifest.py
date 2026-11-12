"""packaging/manifest.py and packaging/dists.py: the licence manifest of the packaged worker."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING))
import manifest  # noqa: E402
from dists import runtime_dists  # noqa: E402


def make_bundle(root: Path, dists=(), libs=()) -> Path:
    internal = root / "_internal"
    internal.mkdir(parents=True)
    for name in dists:
        d = internal / f"{name}-1.0.dist-info"
        d.mkdir()
        (d / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n")
    for rel in libs:
        p = internal / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\x7fELF fake")
    return root


def entry(path: str) -> dict:
    return {"library": Path(path).name, "path": path}


# ---------- completeness (I3) ----------


def test_complete_manifest_has_no_problems(tmp_path):
    b = make_bundle(tmp_path, dists=["foo_bar"], libs=["foo_bar.libs/libz-0123abcd.so.1"])
    m = {"packages": [{"name": "Foo-Bar"}], "nativeLibraries": [entry("_internal/foo_bar.libs/libz-0123abcd.so.1")]}
    assert manifest.check_complete(b, m) == []


def test_package_in_bundle_but_not_in_manifest_fails(tmp_path):
    b = make_bundle(tmp_path, dists=["foo", "jsonschema"])
    problems = manifest.check_complete(b, {"packages": [{"name": "foo"}], "nativeLibraries": []})
    assert len(problems) == 1 and "jsonschema" in problems[0] and "not in the manifest" in problems[0]


def test_package_in_manifest_but_not_in_bundle_fails(tmp_path):
    b = make_bundle(tmp_path, dists=["foo"])
    problems = manifest.check_complete(b, {"packages": [{"name": "foo"}, {"name": "bar"}], "nativeLibraries": []})
    assert len(problems) == 1 and "bar" in problems[0] and "not in the bundle" in problems[0]


def test_native_library_mismatch_fails_both_ways(tmp_path):
    b = make_bundle(tmp_path, libs=["av.libs/libx264-d6533a8d.so.165"])
    problems = manifest.check_complete(b, {"packages": [], "nativeLibraries": [entry("_internal/av.libs/libgone-00000000.so.1")]})
    assert any("libx264" in p and "not in the manifest" in p for p in problems)
    assert any("libgone" in p and "not in the bundle" in p for p in problems)


def test_extension_modules_and_symlinks_are_not_native_libraries(tmp_path):
    b = make_bundle(tmp_path, libs=["av/_core.cpython-313-x86_64-linux-gnu.so", "pkg/thing.abi3.so", "av.libs/libvpx-11111111.so.9"])
    (b / "_internal" / "libvpx-11111111.so.9").symlink_to("av.libs/libvpx-11111111.so.9")
    assert [p.name for p in manifest.native_library_files(b / "_internal")] == ["libvpx-11111111.so.9"]


def test_runtime_dists_follow_extras_a_requirement_asks_for():
    # ocrmypdf requires pikepdf[pdfa]; that extra brings jsonschema and referencing (and attrs).
    found = runtime_dists()
    assert {"pikepdf", "jsonschema", "referencing", "attrs"} <= set(found)
    assert "pytest" not in found  # ao-worker's own `test` extra is not asked for by anyone


# ---------- what the licences say ----------


class FakeCarrier:
    def __init__(self, info_dir: Path, name="av", licence="BSD-3-Clause"):
        self.name, self.licence, self.info_dir = name, licence, info_dir
        self.dist = type("D", (), {"metadata": {"Name": name}})()

    def licence_files(self):
        return sorted(p for p in self.info_dir.rglob("*") if p.is_file())

    def text(self, rel):
        p = self.info_dir / rel
        return p.read_text() if p.is_file() else None


def test_a_library_its_wheel_says_nothing_about_stays_unknown(tmp_path):
    info = tmp_path / "av-18.1.0.dist-info"
    (info / "licenses").mkdir(parents=True)
    (info / "licenses" / "LICENSE.txt").write_text("BSD 3-Clause License\nCopyright PyAV\n")
    lib = make_bundle(tmp_path / "b", libs=["av.libs/libx264-d6533a8d.so.165"]) / "_internal" / "av.libs" / "libx264-d6533a8d.so.165"
    st = manifest.statement_for(lib, FakeCarrier(info))
    assert st["licence"] == "unknown" and st["copyleft"] == "unknown"


def test_unknown_is_never_rolled_up_into_something_more_permissive():
    assert manifest.roll_up(["no", "unknown", "no"]) == "unknown"
    assert manifest.roll_up(["no", "runtime-exception", "unknown"]) == "unknown"
    assert manifest.roll_up(["weak", "unknown"]) == "unknown"
    assert manifest.roll_up(["unknown", "yes"]) == "yes"
    assert manifest.roll_up(["no", "no"]) == "no"


def test_dependency_licences_that_are_not_named_are_unknown():
    # pypdfium2's metadata: libpdfium's own licences plus "dependency licenses" it does not name here.
    assert manifest.copyleft("BSD-3-Clause, Apache-2.0, dependency licenses") == "unknown"
    assert manifest.copyleft("BSD-3-Clause") == "no"


def test_gpl_statements_are_reported_as_gpl(tmp_path):
    info = tmp_path / "pillow_heif-1.8.1.dist-info"
    (info / "licenses").mkdir(parents=True)
    (info / "licenses" / "LICENSES_bundled.txt").write_text(
        'License for "pillow-heif" binary wheels: GPLv2, due to base library licenses.\n\n'
        "Name: libheif\nLicense: LGPLv3\nFiles: libheif.[dylib|so|dll]\n\n"
        "Name: x265\nLicense: GPLv2\nFiles: libx265.[dylib|so|dll]\n")
    internal = make_bundle(tmp_path / "b", libs=["pillow_heif.libs/libx265-4883ecb5.so.217", "pillow_heif.libs/libheif-e72ea93c.so.1.23.6"]) / "_internal"
    carrier = FakeCarrier(info, name="pillow-heif")
    x265 = manifest.statement_for(internal / "pillow_heif.libs" / "libx265-4883ecb5.so.217", carrier)
    heif = manifest.statement_for(internal / "pillow_heif.libs" / "libheif-e72ea93c.so.1.23.6", carrier)
    assert x265["copyleft"] == "yes" and "GPLv2" in x265["licence"]
    assert heif["copyleft"] == "weak"
    assert manifest.binary_wheel_statement(carrier) == "GPLv2, due to base library licenses."
    assert manifest.copyleft("GPL-2.0-only") == "yes"

    m = {
        "packages": [{"name": "some_gpl_pkg", "version": "1.0", "licence": "GPL-2.0-only", "copyleft": "yes"},
                     {"name": "pillow_heif", "version": "1.8.1", "licence": "BSD-3-Clause", "copyleft": "no",
                      "binaryWheelStatement": "GPLv2, due to base library licenses.", "copyleftIncludingNativeLibraries": "yes"}],
        "nativeLibraries": [{"library": "libx265-4883ecb5.so.217", "carriedBy": "pillow_heif", **x265}],
    }
    lines = "\n".join(manifest.review_lines(m))
    assert "some_gpl_pkg 1.0: GPL-2.0-only (yes)" in lines
    assert "pillow_heif with its native libraries: yes" in lines
    assert "libx265-4883ecb5.so.217 (pillow_heif): GPLv2" in lines


@pytest.mark.parametrize("value,expected", [("GPL-3.0-or-later WITH GCC-exception-3.1", "runtime-exception"),
                                            ("LGPL version 3 or later", "weak"), ("MPL-2.0", "weak"), ("something", "unclear")])
def test_copyleft_classes(value, expected):
    assert manifest.copyleft(value) == expected


# ---------- gallery-dl is not inside the worker (R152) ----------


def test_gallery_dl_in_the_bundle_is_a_problem(tmp_path):
    b = make_bundle(tmp_path, dists=["gallery_dl", "requests"])
    problems = manifest.check_complete(b, {"packages": [{"name": "gallery_dl"}, {"name": "requests"}], "nativeLibraries": []})
    assert any("gallery-dl" in p and "R152" in p for p in problems), problems


def test_the_worker_does_not_depend_on_gallery_dl():
    import tomllib

    deps = tomllib.loads((PACKAGING.parent / "pyproject.toml").read_text())["project"]["dependencies"]
    names = [manifest.canonical(d.split("=")[0].split("<")[0].split(">")[0].strip()) for d in deps]
    assert "gallery-dl" not in names
    assert "requests" in names  # what the downloaded gallery-dl needs from the worker's Python
