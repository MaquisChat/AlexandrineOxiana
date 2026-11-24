"""packaging/manifest.py and packaging/dists.py: the licence manifest of the packaged worker."""
from __future__ import annotations

import sys
from pathlib import Path

import json

import pytest

PACKAGING = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING))
import licence_texts  # noqa: E402
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


# ---------- every bundled package pinned by a complete pin set (FR-730, R503 j) ----------


def test_every_bundled_package_pinned_at_its_version_has_no_problems():
    packages = [{"name": "PyYAML", "version": "6.0.4"}, {"name": "pillow_heif", "version": "1.8.1"},
                {"name": "pikepdf", "version": "10.13.0.post1"}]
    # Names compare as pip compares them; a pin for a package that is not in the bundle is harmless.
    text = "# head\n\npyyaml==6.0.4\nPillow-HEIF == 1.8.1  # why\npikepdf==10.13.0post1\nsetuptools==80.9.0\n"
    assert manifest.check_pinned(packages, text) == []


def test_a_bundled_version_that_differs_from_its_pin_is_a_problem_naming_both_versions():
    problems = manifest.check_pinned([{"name": "ctranslate2", "version": "4.9.2"}], "ctranslate2==4.9.1\n")
    assert problems == ["ctranslate2 4.9.2 is in the bundle, but the constraints file pins it at 4.9.1"]


def test_a_bundled_package_the_constraints_do_not_name_is_a_problem():
    problems = manifest.check_pinned([{"name": "filelock", "version": "4.3.1"}, {"name": "rawpy", "version": "0.28.0"}],
                                     "rawpy==0.28.0\n")
    assert problems == ["filelock 4.3.1 is in the bundle, but the constraints file does not name it"]


def test_the_pin_check_fails_the_build_and_says_which_package(tmp_path, capsys):
    c = tmp_path / "constraints-macos-arm64.txt"
    c.write_text("packaging==26.3\n")
    assert manifest.report_pins([{"name": "packaging", "version": "26.4"}], c) == 1
    err = capsys.readouterr().err
    assert "packaging 26.4 is in the bundle, but the constraints file pins it at 26.3" in err
    c.write_text("packaging==26.4\n")
    assert manifest.report_pins([{"name": "packaging", "version": "26.4"}], c) == 0
    assert "every package in the bundle (1) is pinned by constraints-macos-arm64.txt at the version installed" in capsys.readouterr().out


def test_pins_complete_needs_a_constraints_file(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["manifest.py", "--bundle", str(tmp_path), "--target", "t", "--pin-set", "p",
                                      "--out", str(tmp_path / "m.json"), "--pins-complete"])
    with pytest.raises(SystemExit) as e:
        manifest.main()
    assert e.value.code == 2
    assert "--pins-complete needs --constraints" in capsys.readouterr().err


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


# ---------- the licence texts (Task 37j) ----------


class FakeDist(FakeCarrier):
    def __init__(self, info_dir: Path, name: str, licence: str, package_files=(), urls=(), home=None):
        super().__init__(info_dir, name=name, licence=licence)
        self.dist = type("D", (), {"metadata": {"Name": name, "Project-URL": list(urls), "Home-page": home}, "version": "1.0"})()
        self._package_files = list(package_files)

    def package_licence_files(self):
        return self._package_files


def test_licence_entries_read_each_wheels_files_and_its_sbom(tmp_path):
    with_text = tmp_path / "rich-1.0.dist-info"
    (with_text / "licenses").mkdir(parents=True)
    (with_text / "licenses" / "LICENSE").write_text("Copyright (c) 2020 Will\n\nterms\n")
    tok = tmp_path / "tokenizers-1.0.dist-info"
    (tok / "sboms").mkdir(parents=True)
    (tok / "sboms" / "x.cyclonedx.json").write_text('{"components": [{"name": "tokenizers", "licenses": [{"expression": "Apache-2.0"}]}]}')
    tok_dist = FakeDist(tok, "tokenizers", "Apache Software License")
    tok_dist.licence_files = lambda: []  # its sbom is not a licence file
    rich, tokenizers = manifest.licence_entries({"rich": FakeDist(with_text, "rich", "MIT"), "tokenizers": tok_dist})
    assert rich["files"] == [("licenses/LICENSE", "Copyright (c) 2020 Will\n\nterms\n")]
    assert tokenizers["files"] == [] and tokenizers["sbom_licence"] == "Apache-2.0"


def test_the_licence_folder_fails_the_build_for_a_package_with_neither_text_nor_known_licence(tmp_path):
    info = tmp_path / "odd-1.0.dist-info"
    info.mkdir()
    bundle = make_bundle(tmp_path / "bundle")
    with pytest.raises(SystemExit):
        manifest.write_licence_folder(bundle, {"odd": FakeDist(info, "odd", "Apache Software License")}, [])


def test_the_licence_folder_has_one_file_with_every_text(tmp_path):
    info = tmp_path / "ctranslate2-1.0.dist-info"
    info.mkdir()
    rich = tmp_path / "rich-1.0.dist-info"
    (rich / "licenses").mkdir(parents=True)
    (rich / "licenses" / "LICENSE").write_text("Copyright (c) 2020 Will\n\nrich terms\n")
    bundle = make_bundle(tmp_path / "bundle")
    folder = manifest.write_licence_folder(bundle, {"ctranslate2": FakeDist(info, "ctranslate2", "MIT"), "rich": FakeDist(rich, "rich", "MIT")}, [])
    text = (folder / "THIRD-PARTY-LICENCES.txt").read_text()
    assert "ctranslate2 1.0: MIT - the standard text of MIT" in text
    assert "rich terms" in text and "Copyright (c) 2020 Will" in text
    assert "GNU LESSER GENERAL PUBLIC LICENSE" in text  # the GNU texts the native libraries' statements refer to


def test_licence_files_beside_the_package_are_read_and_a_notice_is_not_a_licence_text(tmp_path):
    # onnxruntime: no licence file in its dist-info; LICENSE and ThirdPartyNotices.txt in onnxruntime/ (review I2).
    info = tmp_path / "onnxruntime-1.0.dist-info"
    info.mkdir()
    pkg_dir = tmp_path / "site" / "onnxruntime"
    pkg_dir.mkdir(parents=True)
    (pkg_dir / "LICENSE").write_text("MIT License\n\nCopyright (c) Microsoft Corporation\n")
    (pkg_dir / "ThirdPartyNotices.txt").write_text("THIRD PARTY SOFTWARE NOTICES\n(c) clause stays\n")
    files = [("onnxruntime/LICENSE", pkg_dir / "LICENSE"), ("onnxruntime/ThirdPartyNotices.txt", pkg_dir / "ThirdPartyNotices.txt")]
    ort = FakeDist(info, "onnxruntime", "MIT License", package_files=files)
    [entry] = manifest.licence_entries({"onnxruntime": ort})
    assert [n for n, _ in entry["files"]] == ["onnxruntime/LICENSE", "onnxruntime/ThirdPartyNotices.txt"]
    bundle = make_bundle(tmp_path / "bundle")
    folder = manifest.write_licence_folder(bundle, {"onnxruntime": ort}, [])
    text = (folder / "THIRD-PARTY-LICENCES.txt").read_text()
    assert "No licence text shipped by the package (0)" in text
    assert "THIRD PARTY SOFTWARE NOTICES\n(c) clause stays" in text
    assert (folder / "packages" / "onnxruntime" / "onnxruntime" / "ThirdPartyNotices.txt").is_file()


def test_a_package_folder_licence_file_pattern():
    for rel in ["onnxruntime/LICENSE", "onnxruntime/ThirdPartyNotices.txt", "numpy/ma/LICENSE", "fpdf/data/color_profiles/sRGB2014.icc.LICENSE"]:
        assert licence_texts.is_package_licence_file(rel), rel
    for rel in ["x-1.0.dist-info/LICENSE", "pip/_vendor/license.py", "pkg/licensing.json", "pkg/README.md"]:
        assert not licence_texts.is_package_licence_file(rel), rel


def test_mpl_packages_name_their_source(tmp_path):
    info = tmp_path / "pikepdf-1.0.dist-info"
    (info / "licenses").mkdir(parents=True)
    (info / "licenses" / "LICENSE.txt").write_text("Mozilla Public License Version 2.0\n")
    pike = FakeDist(info, "pikepdf", "MPL-2.0", urls=["Source, https://github.com/pikepdf/pikepdf"])
    [entry] = manifest.licence_entries({"pikepdf": pike})
    assert entry["source"] == "https://github.com/pikepdf/pikepdf (version 1.0; also https://pypi.org/project/pikepdf/1.0/)"
    folder = manifest.write_licence_folder(make_bundle(tmp_path / "bundle"), {"pikepdf": pike}, [])
    assert "pikepdf 1.0  MPL-2.0\n    source: https://github.com/pikepdf/pikepdf" in (folder / "THIRD-PARTY-LICENCES.txt").read_text()


def test_every_shipped_file_is_whole_in_the_combined_file_and_its_sources_are_listed_beside_the_bundle(tmp_path):
    info = tmp_path / "numpy-1.0.dist-info"
    (info / "licenses" / "lapack_lite").mkdir(parents=True)
    lapack = ("Copyright (c) 1992-2013 The University of Tennessee and The University\n"
              "                        of Tennessee Research Foundation.  All rights\n                        reserved.\n")
    (info / "licenses" / "lapack_lite" / "LICENSE.txt").write_text(lapack)
    (info / "licenses" / "LICENSE.txt").write_text("   (c) You must retain notices; and\n")
    bundle = make_bundle(tmp_path / "bundle")
    folder = manifest.write_licence_folder(bundle, {"numpy": FakeDist(info, "numpy", "BSD-3-Clause")}, [])
    text = (folder / "THIRD-PARTY-LICENCES.txt").read_text()
    assert lapack.rstrip("\n") in text and "   (c) You must retain notices; and" in text
    sources = json.loads((tmp_path / "bundle.licence-sources.json").read_text())
    labels = [s["label"] for s in sources]
    assert "numpy 1.0 licenses/LICENSE.txt" in labels and any(lab.startswith("GNU ") for lab in labels)
    for s in sources:
        assert licence_texts.normalise(Path(s["path"]).read_text()) in licence_texts.normalise(text), s["label"]
