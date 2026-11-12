"""packaging/licence_texts.py: the licence texts that travel with the packaged worker (Task 37j, R165)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING))
import licence_texts as lt  # noqa: E402

MIT_BODY = ("Permission is hereby granted, free of charge, to any person obtaining a copy\n"
            "of this software, to deal in the Software without restriction.\n\n"
            'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.')
STANDARD = {"MIT": "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nstandard MIT text\n",
            "Apache-2.0": "Apache License\nVersion 2.0, January 2004\nstandard Apache text\n"}
# Texts the earlier version altered (review C1, I1).
APACHE_4 = ("4. Redistribution.\n\n   (a) You must give any other recipients of the Work a copy of this License; and\n\n"
            "   (c) You must retain, in the Source form of any Derivative Works\n       that You distribute, all copyright notices; and\n")
MPL_23 = "2.3. Limitations on Grant Scope\n\n(c) under Patent Claims infringed by Covered Software in the absence of\n    its Contributions.\n"
LAPACK = ("Copyright (c) 1992-2013 The University of Tennessee and The University\n"
          "                        of Tennessee Research Foundation.  All rights\n"
          "                        reserved.\n"
          "Copyright (c) 2000-2013 The University of California Berkeley. All\n"
          "                        rights reserved.\n\n$COPYRIGHT$\n\nAdditional copyrights may follow\n")
GPL = (" Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>\n Everyone is permitted to copy and distribute verbatim copies\n"
       " of this license document, but changing it is not allowed.\n\n    Copyright (C) <year>  <name of author>\n")


def mit(holder: str) -> str:
    return f"MIT License\n\nCopyright (c) 2020 {holder}\n\n{MIT_BODY}\n"


def pkg(name, licence, files=(), **extra):
    return {"name": name, "version": "1.0", "licence": licence, "files": list(files), **extra}


def test_identifiers_of_expressions_and_of_the_declarations_packages_write():
    assert lt.licence_ids("MIT OR Apache-2.0") == ["Apache-2.0", "MIT"]
    assert lt.licence_ids("Apache-2.0 OR BSD-2-Clause") == ["Apache-2.0", "BSD-2-Clause"]
    assert lt.licence_ids("MIT License") == ["MIT"]  # onnxruntime's License field
    assert lt.licence_ids("Apache 2.0") == ["Apache-2.0"]  # flatbuffers'
    assert lt.licence_ids("UNKNOWN") == [] and lt.licence_ids("") == []
    # A classifier that names no version is not turned into an identifier.
    assert lt.licence_ids("Apache Software License") == ["Apache Software License"]


def test_licence_texts_and_notices_are_told_apart():
    for f in ["licenses/LICENSE", "LICENSE.txt", "licenses/LICENSES/Apache-2.0.txt", "COPYING", "onnxruntime/LICENSE", "numpy/ma/LICENSE"]:
        assert lt.is_licence_text(f), f
    for f in ["NOTICE", "onnxruntime/ThirdPartyNotices.txt", "licenses/BUILD_LICENSES/abseil.txt", "AUTHORS.rst"]:
        assert not lt.is_licence_text(f), f


def test_a_package_with_its_own_text_whole():
    r = lt.collect([pkg("withtext", "MIT", [("LICENSE", mit("Ann"))])], STANDARD)
    assert r.problems == [] and r.no_text == []
    assert len(r.groups) == 1 and r.groups[0].text == lt.normalise(mit("Ann"))
    assert r.groups[0].used_by == ["withtext 1.0 (LICENSE)"]


def test_a_package_without_text_but_with_a_known_identifier_gets_the_standard_text_and_is_named():
    r = lt.collect([pkg("ctranslate2", "MIT")], STANDARD)
    assert r.problems == []
    assert r.no_text == [{"name": "ctranslate2", "version": "1.0", "licence": "MIT", "ids": ["MIT"], "used": "the standard text of MIT (licences/standard)"}]
    assert "standard MIT text" in r.groups[0].text


def test_a_package_with_only_a_notice_also_gets_the_standard_text_and_is_named():
    r = lt.collect([pkg("noticeonly", "Apache-2.0", [("ThirdPartyNotices.txt", "Others' notices\n")])], STANDARD)
    assert r.problems == [] and len(r.groups) == 2
    assert r.no_text[0]["used"] == "the standard text of Apache-2.0 (licences/standard); ships only: ThirdPartyNotices.txt"


def test_a_package_with_neither_fails_naming_it():
    r = lt.collect([pkg("nothing", ""), pkg("vague", "Apache Software License")], STANDARD)
    assert len(r.problems) == 2
    assert "nothing 1.0" in r.problems[0] and "no licence identifier" in r.problems[0]
    assert "vague 1.0" in r.problems[1] and "Apache Software License" in r.problems[1]


def test_an_identifier_from_the_wheels_own_sbom_is_used_when_the_metadata_names_none_usable(tmp_path):
    info = tmp_path / "tokenizers-0.23.3.dist-info"
    (info / "sboms").mkdir(parents=True)
    (info / "sboms" / "tokenizers-python.cyclonedx.json").write_text(json.dumps({
        "metadata": {"component": {"name": "tokenizers-python", "version": "0.23.3"}},
        "components": [{"name": "serde", "version": "1.0", "licenses": [{"expression": "MIT OR Apache-2.0"}]},
                       {"name": "tokenizers", "version": "0.23.2", "licenses": [{"expression": "Apache-2.0"}]}]}))
    assert lt.sbom_licence(info, "tokenizers") == "Apache-2.0"
    assert lt.sbom_licence(info, "other") is None
    assert lt.sbom_components(info, "tokenizers") == {"file": "sboms/tokenizers-python.cyclonedx.json",
                                                       "list": ["serde 1.0: MIT OR Apache-2.0", "tokenizers 0.23.2: Apache-2.0"]}
    r = lt.collect([pkg("tokenizers", "Apache Software License", sbom_licence="Apache-2.0")], STANDARD)
    assert r.problems == []
    assert r.no_text[0]["used"] == "the standard text of Apache-2.0 (licences/standard; identifier from the wheel's SBOM)"


def test_two_licence_files_are_both_kept():
    r = lt.collect([pkg("two", "Apache-2.0 OR BSD-3-Clause", [("LICENSE.APACHE", "Apache License\nterms\n"), ("LICENSE.BSD", "BSD terms\n")])], STANDARD)
    assert sorted(u for g in r.groups for u in g.used_by) == ["two 1.0 (LICENSE.APACHE)", "two 1.0 (LICENSE.BSD)"]


def test_only_whole_identical_files_are_merged():
    r = lt.collect([pkg("a", "MIT", [("LICENSE", mit("Ann"))]), pkg("b", "MIT", [("LICENSE", mit("Bob"))]),
                    pkg("c", "MIT", [("LICENSE", mit("Ann").replace("\n", "\r\n").replace("MIT License", "MIT License  "))])], STANDARD)
    assert [g.used_by for g in r.groups] == [["a 1.0 (LICENSE)", "c 1.0 (LICENSE)"], ["b 1.0 (LICENSE)"]]


def test_render_ships_every_file_verbatim_and_names_packages_sources_and_components():
    packages = [pkg("a", "Apache-2.0", [("LICENSE", APACHE_4), ("lapack/LICENSE.txt", LAPACK)]),
                pkg("m", "MPL-2.0", [("LICENSE", MPL_23)], source="https://example.org/m (version 1.0)"),
                pkg("g", "GPL-3.0-only", [("COPYING", GPL)]), pkg("n", "Apache-2.0", components={"file": "sboms/x.json", "list": ["x 1: MIT"]})]
    result = lt.collect(packages, STANDARD)
    out = lt.render("The media helper", "Its packages.", packages, result, appendix=[("Python", "PSF terms")])
    for t in (APACHE_4, MPL_23, LAPACK, GPL):
        assert lt.normalise(t) in out
    assert lt.verify_verbatim(out, [(f"{p['name']} {n}", t) for p in packages for n, t in p["files"]]) == []
    assert "=== Text 1 of 5 ===\nApplies to: a 1.0 (LICENSE)\n\n4. Redistribution." in out
    assert "m 1.0  MPL-2.0\n    source: https://example.org/m (version 1.0)" in out
    assert "No licence text shipped by the package (1)" in out and "n 1.0: Apache-2.0" in out
    assert "n 1.0 (sboms/x.json, 1 components):\n    x 1: MIT" in out
    # Review N4: the same plain wording as the other generators, and the gap on the package's "no text" line.
    assert "Components bundled by a package, as its own SBOM lists them\n" in out
    assert "Known gaps: each package below bundles these components, as far as its own SBOM states. No licence texts for these components are shipped, other than any among the package's own files below." in out
    assert "n 1.0: Apache-2.0 - the standard text of Apache-2.0 (licences/standard); its SBOM (sboms/x.json) lists 1 components whose licence texts it does not ship" in out
    # Review N1: what was normalised, at the top.
    assert 'How the texts below were normalised: a leading byte-order mark was removed, CR and CRLF line endings were converted to LF, trailing spaces and tabs were removed from each line, and trailing blank lines and the final newline were trimmed. Nothing else in any text was changed.' in out[:out.index("Packages (")]
    assert "PSF terms" in out


def test_verify_verbatim_names_what_is_not_whole():
    assert lt.verify_verbatim("abc\n(c) one\n", [("x", "(c) one\n(d) two\n")]) == ["x"]


def test_mpl_source_from_the_package_metadata():
    meta = {"Project-URL": ["Documentation, https://docs.example.org", "Source, https://github.com/x/pikepdf"], "Home-page": None}
    assert lt.mpl_source("pikepdf", "10.18.0", meta) == "https://github.com/x/pikepdf (version 10.18.0; also https://pypi.org/project/pikepdf/10.18.0/)"
    assert lt.mpl_source("certifi", "1", {"Project-URL": [], "Home-page": "https://github.com/certifi"}) == "https://github.com/certifi (version 1; also https://pypi.org/project/certifi/1/)"
    assert lt.mpl_source("tqdm", "4", {"Project-URL": [], "Home-page": None}) == "https://pypi.org/project/tqdm/4/ (its source distribution)"


def test_the_standard_texts_are_the_repository_folder_shared_with_the_other_builds():
    texts = lt.load_standard()
    assert lt.STANDARD_DIR == Path(__file__).resolve().parents[3] / "licences" / "standard"
    assert "Permission is hereby granted" in texts["MIT"] and "Apache-2.0" in texts


def test_build_fails_on_a_problem(capsys):
    with pytest.raises(SystemExit) as e:
        lt.fail_on([" nothing 1.0 has no licence identifier"])
    assert e.value.code == 1
    assert "nothing 1.0" in capsys.readouterr().err
