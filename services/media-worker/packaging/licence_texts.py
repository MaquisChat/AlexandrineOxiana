"""The licence texts that travel with the packaged worker (Task 37j, ADR 0015, R165).

The same rules as the shell's and the service's builds (scripts/notices/licence-texts.mjs):

- A package's licence and notice files are shipped verbatim: nothing inside them is extracted,
  moved or rewritten. Only whole files identical after normalising line endings and trailing
  whitespace are merged; each distinct file is shipped once, in full, under a heading naming every
  package (and file) it applies to.
- A package whose own files give no licence text (a NOTICE or third-party list is not one) gets the
  standard text of each identifier it declares, from the repository's licences/standard/ (SPDX
  texts, copied unmodified), and is named in a "no licence text shipped by the package" section.
  Never a text typed by hand or made up from an identifier.
- A package with no licence identifier, or one without a licence text whose identifier has no
  standard text, is a problem: the build fails with the package named.
- MPL-2.0 packages name where their source is; what a wheel's own SBOM lists is listed by name.

Runs in the build venv (standard library only).
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

STANDARD_DIR = Path(__file__).resolve().parents[3] / "licences" / "standard"

# Declarations some wheels write instead of an SPDX identifier, mapped only where the words name one
# licence and version exactly (the same table as licence-texts.mjs). "Apache Software License" (a
# trove classifier) names no version and is not mapped.
ALIASES = {
    "MIT License": "MIT",
    "Apache 2.0": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "3-Clause BSD License": "BSD-3-Clause",
}
UNUSABLE = re.compile(r"^\s*(UNKNOWN|UNLICENSED|SEE LICEN[CS]E|NONE|NOASSERTION)\b", re.I)
LICENCE_DIR = re.compile(r"^licen[cs]es$", re.I)
# Licence and notice files inside a package's installed folders (outside its dist-info).
PACKAGE_LICENCE_FILE = re.compile(r"^(licen[cs]e|copying|notice|thirdpartynotices|third[-_]party)|\.licen[cs]e$", re.I)
CODE = {".py", ".pyc", ".pyi", ".so", ".pyd", ".dylib", ".dll", ".h", ".c", ".js", ".json"}


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def licence_ids(declared: str | None) -> list[str]:
    """The licence and exception identifiers a declaration names."""
    if not declared or not declared.strip() or UNUSABLE.match(declared):
        return []
    declared = ALIASES.get(declared.strip(), declared)
    parts = re.split(r"\s+(?:OR|AND|WITH)\s+|\s*/\s*", declared.replace("(", " ").replace(")", " "))
    return sorted({ALIASES.get(p.strip(), p.strip()) for p in parts if p.strip()})


def is_licence_text(path: str) -> bool:
    """A LICENSE, LICENCE, COPYING or UNLICENSE file, or any file directly in a `licenses/` folder;
    not a notice or a third-party list."""
    parts = path.split("/")
    base = parts[-1]
    if re.search(r"third[-_ ]?party", path, re.I) or re.search(r"notices?\b", base, re.I):
        return False
    if len(parts) > 1 and LICENCE_DIR.match(parts[-2]):
        return True
    return re.match(r"^(licen[cs]e|copying|unlicense)", base, re.I) is not None or re.search(r"\.licen[cs]e$", base, re.I) is not None


def is_package_licence_file(rel: str) -> bool:
    """A licence or notice file among a distribution's installed files (path relative to site-packages)."""
    parts = rel.split("/")
    if parts[0].endswith(".dist-info") or Path(parts[-1]).suffix.lower() in CODE:
        return False
    return PACKAGE_LICENCE_FILE.search(parts[-1]) is not None


def _sbom_docs(info_dir: Path | None):
    if not info_dir or not (info_dir / "sboms").is_dir():
        return
    for f in sorted((info_dir / "sboms").glob("*.json")):
        try:
            yield f, json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue


def _licences(c: dict) -> str:
    found = [x.get("expression") or (x.get("license") or {}).get("id") or (x.get("license") or {}).get("name")
             for x in c.get("licenses") or []]
    return " AND ".join(x for x in found if x)


def sbom_licence(info_dir: Path | None, name: str) -> str | None:
    """The licence the wheel's own CycloneDX SBOM (dist-info/sboms/) gives for a component of this name."""
    want = canonical(name)
    for _, doc in _sbom_docs(info_dir):
        comps = list(doc.get("components") or [])
        top = (doc.get("metadata") or {}).get("component")
        if top:
            comps += [top, *(top.get("components") or [])]
        for c in comps:
            if canonical(str(c.get("name", ""))) == want and _licences(c):
                return _licences(c)
    return None


def sbom_components(info_dir: Path | None, name: str) -> dict | None:
    """What the wheel's own SBOM lists besides the package itself: {"file", "list": ["name version: licence"]}."""
    for f, doc in _sbom_docs(info_dir):
        top = ((doc.get("metadata") or {}).get("component") or {}).get("name")
        # Everything but the described package itself and plain files; a component of the package's
        # own name (tokenizers' Rust crate) is part of the program and is listed.
        out = sorted({f"{c['name']}{' ' + str(c['version']) if c.get('version') else ''}: {_licences(c) or 'no licence stated'}"
                      for c in doc.get("components") or [] if c.get("name") and c.get("name") != top and c.get("type") != "file"})
        if out:
            return {"file": str(f.relative_to(info_dir)), "list": out}
    return None


def mpl_source(name: str, version: str, meta) -> str:
    """Where an MPL-2.0 package's source is, from its own metadata (Project-URL, Home-page), and its PyPI page."""
    pypi = f"https://pypi.org/project/{name}/{version}/"
    urls = []
    for entry in meta.get("Project-URL") or []:
        label, _, url = entry.partition(",")
        urls.append((label.strip().lower(), url.strip()))
    pick = next((u for lab, u in urls if re.search(r"source|repo|code|github", lab)), None)
    pick = pick or next((u for lab, u in urls if re.search(r"home", lab)), None) or meta.get("Home-page")
    return f"{pick} (version {version}; also {pypi})" if pick else f"{pypi} (its source distribution)"


def normalise(text: str) -> str:
    """Line endings and trailing whitespace normalised (and a byte-order mark dropped); nothing else changed."""
    text = text.removeprefix("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip(" \t") for line in text.split("\n")).rstrip("\n")


def load_standard(folder: Path = STANDARD_DIR) -> dict[str, str]:
    return {p.stem: p.read_text(encoding="utf-8") for p in sorted(folder.glob("*.txt"))}


@dataclass
class Group:
    text: str
    used_by: list[str] = field(default_factory=list)


@dataclass
class Result:
    groups: list[Group]
    no_text: list[dict]
    problems: list[str]


def collect(packages: list[dict], standard: dict[str, str]) -> Result:
    """packages: {name, version, licence, files: [(path in the package, text)], sbom_licence?, components?}."""
    groups: dict[str, Group] = {}
    no_text: list[dict] = []
    problems: list[str] = []

    def add(text: str, label: str) -> None:
        key = normalise(text)
        g = groups.setdefault(key, Group(key))
        if label not in g.used_by:
            g.used_by.append(label)

    for p in packages:
        pid = f"{p['name']} {p['version']}"
        ids = licence_ids(p.get("licence"))
        sbom = licence_ids(p.get("sbom_licence"))
        if not ids and not sbom:
            problems.append(f"{pid} has no licence identifier (declared: {p.get('licence')!r})")
            continue
        for name, text in p["files"]:
            add(text, f"{pid} ({name})")
        if any(is_licence_text(name) for name, _ in p["files"]):
            continue
        note = ""
        if not ids or any(x not in standard for x in ids):
            if sbom and all(x in standard for x in sbom):
                ids, note = sbom, "; identifier from the wheel's SBOM"
            else:
                missing = [x for x in ids if x not in standard] or ids
                problems.append(f"{pid} ships no licence text, and {', '.join(missing)} (declared: {p.get('licence')!r}) "
                                "has no standard text in licences/standard")
                continue
        for x in ids:
            add(standard[x], f"{pid} (standard text of {x})")
        s = "s" if len(ids) > 1 else ""
        only = f"; ships only: {', '.join(n for n, _ in p['files'])}" if p["files"] else ""
        if p.get("components"):
            c = p["components"]
            only += f"; its SBOM ({c['file']}) lists {len(c['list'])} components whose licence texts it does not ship"
        no_text.append({"name": p["name"], "version": p["version"], "licence": p.get("licence") or "", "ids": ids,
                        "used": f"the standard text{s} of {', '.join(ids)} (licences/standard{note}){only}"})
    return Result(list(groups.values()), no_text, problems)


# Said at the top of every notices file (review N1): exactly what normalise() changes.
NORMALISATION_NOTE = 'How the texts below were normalised: a leading byte-order mark was removed, CR and CRLF line endings were converted to LF, trailing spaces and tabs were removed from each line, and trailing blank lines and the final newline were trimmed. Nothing else in any text was changed.'
# The plain statement of a known gap (R165, review N4); the same words as licence-texts.mjs.
KNOWN_GAP_NOTE = "Known gaps: each package below bundles these components, as far as its own SBOM states. No licence texts for these components are shipped, other than any among the package's own files below."


def _heading(text: str, ch: str) -> str:
    return f"{text}\n{ch * min(len(text), 100)}"


def render(title: str, intro: str, packages: list[dict], result: Result, preamble=(), appendix=()) -> str:
    """One readable file: the packages (MPL ones with their source), the ones without a licence text of
    their own, what their SBOMs list, then each distinct file once, whole, under the packages it applies
    to, then `appendix` [(title, text)] unchanged."""
    out = [_heading(title, "="), "", intro, "", NORMALISATION_NOTE, ""]
    for block in preamble:
        out += [block, ""]
    out.append(_heading(f"Packages ({len(packages)})", "-"))
    for p in packages:
        out.append(f"{p['name']} {p['version']}  {p.get('licence') or ''}")
        if p.get("source"):
            out.append(f"    source: {p['source']}")
        if p.get("note"):
            out.append(f"    {p['note']}")
    out += ["", _heading(f"No licence text shipped by the package ({len(result.no_text)})", "-")]
    if result.no_text:
        out.append("These packages carry no licence text of their own. The text used for each is named below; a person should check it.")
        out += [f"  {n['name']} {n['version']}: {n['licence']} - {n['used']}" for n in result.no_text]
    else:
        out.append("None: every package above ships its own licence text.")
    with_components = [p for p in packages if p.get("components")]
    if with_components:
        out += ["", _heading("Components bundled by a package, as its own SBOM lists them", "-"), KNOWN_GAP_NOTE]
        for p in with_components:
            c = p["components"]
            out.append(f"  {p['name']} {p['version']} ({c['file']}, {len(c['list'])} components):")
            out += [f"    {x}" for x in c["list"]]
    out += ["", _heading(f"Licence and notice files ({len(result.groups)} distinct)", "-"),
            "Each file is shown whole, as its package ships it, once, under the packages it applies to.", ""]
    for i, g in enumerate(result.groups, 1):
        out += [f"=== Text {i} of {len(result.groups)} ===", f"Applies to: {', '.join(g.used_by)}", "", g.text, ""]
    for t, text in appendix:
        out += [_heading(t, "-"), "", normalise(text), ""]
    return "\n".join(out).rstrip("\n") + "\n"


def verify_verbatim(output: str, sources: list[tuple[str, str]]) -> list[str]:
    """The labels of the sources (label, text) whose normalised text is not in the output whole."""
    whole = normalise(output)
    return [label for label, text in sources if normalise(text) not in whole]


def fail_on(problems: list[str]) -> None:
    if problems:
        print(f"licence texts: {len(problems)} problem(s); the build stops", file=sys.stderr)
        for p in problems:
            print(f"  {p.strip()}", file=sys.stderr)
        raise SystemExit(1)
