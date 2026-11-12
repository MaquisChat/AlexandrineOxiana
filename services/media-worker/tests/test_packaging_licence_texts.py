"""packaging/licence_texts.py: the licence texts that travel with the packaged worker (Task 37j)."""
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


def test_a_package_with_its_own_text():
    r = lt.collect([pkg("withtext", "MIT", [("LICENSE", mit("Ann"))])], STANDARD)
    assert r.problems == [] and r.no_text == []
    assert len(r.groups) == 1 and r.groups[0].copyrights == ["Copyright (c) 2020 Ann"]
    assert r.groups[0].used_by == ["withtext 1.0 (LICENSE)"]


def test_a_package_without_text_but_with_a_known_identifier_gets_the_standard_text_and_is_named():
    r = lt.collect([pkg("ctranslate2", "MIT")], STANDARD)
    assert r.problems == []
    assert r.no_text == [{"name": "ctranslate2", "version": "1.0", "licence": "MIT", "ids": ["MIT"], "used": "the standard text of MIT (licences/standard)"}]
    assert "standard MIT text" in r.groups[0].body


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
    r = lt.collect([pkg("tokenizers", "Apache Software License", sbom_licence="Apache-2.0")], STANDARD)
    assert r.problems == []
    assert r.no_text[0]["used"] == "the standard text of Apache-2.0 (licences/standard; identifier from the wheel's SBOM)"


def test_two_licence_files_are_both_kept():
    r = lt.collect([pkg("two", "Apache-2.0 OR BSD-3-Clause", [("LICENSE.APACHE", "Apache License\nterms\n"), ("LICENSE.BSD", "BSD terms\n")])], STANDARD)
    assert sorted(u for g in r.groups for u in g.used_by) == ["two 1.0 (LICENSE.APACHE)", "two 1.0 (LICENSE.BSD)"]


def test_identical_texts_once_with_every_distinct_copyright_line():
    r = lt.collect([pkg("a", "MIT", [("LICENSE", mit("Ann"))]), pkg("b", "MIT", [("LICENSE", mit("Bob"))]),
                    pkg("c", "MIT", [("LICENSE", mit("Ann"))]), pkg("d", "MIT", [("LICENSE", "Copyright (c) 2020 Dee\n\nOther.\n")])], STANDARD)
    assert len(r.groups) == 2
    shared = next(g for g in r.groups if len(g.used_by) == 3)
    assert shared.copyrights == ["Copyright (c) 2020 Ann", "Copyright (c) 2020 Bob"]
    assert "COPYRIGHT HOLDERS" not in "\n".join(shared.copyrights)


def test_copyright_lines_are_only_those_with_a_year_or_sign():
    c, body = lt.split_copyright("Copyright (c) 2020 Ann\n© Bob\nTHE COPYRIGHT HOLDERS AND CONTRIBUTORS\nCopyright notice text\n")
    assert c == ["Copyright (c) 2020 Ann", "© Bob"]
    assert "THE COPYRIGHT HOLDERS AND CONTRIBUTORS" in body and "Copyright notice text" in body


def test_render_names_the_packages_without_text_and_writes_each_text_once():
    packages = [pkg("a", "MIT", [("LICENSE", mit("Ann"))]), pkg("b", "MIT", [("LICENSE", mit("Bob"))]), pkg("n", "Apache-2.0")]
    out = lt.render("The media helper", "Its packages.", packages, lt.collect(packages, STANDARD), appendix=[("Python", "PSF terms")])
    assert out.startswith("The media helper\n")
    assert "No licence text shipped by the package (1)" in out and "n 1.0: Apache-2.0" in out
    assert out.count(MIT_BODY.splitlines()[0]) == 1
    assert "  Copyright (c) 2020 Ann\n  Copyright (c) 2020 Bob" in out
    assert "PSF terms" in out


def test_the_standard_texts_are_the_repository_folder_shared_with_the_other_builds():
    texts = lt.load_standard()
    assert lt.STANDARD_DIR == Path(__file__).resolve().parents[3] / "licences" / "standard"
    assert "Permission is hereby granted" in texts["MIT"] and "Apache-2.0" in texts


def test_build_fails_on_a_problem(tmp_path, capsys):
    with pytest.raises(SystemExit) as e:
        lt.fail_on([" nothing 1.0 has no licence identifier"])
    assert e.value.code == 1
    assert "nothing 1.0" in capsys.readouterr().err
