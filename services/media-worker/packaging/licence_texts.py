"""The licence texts that travel with the packaged worker (Task 37j, ADR 0015).

The same rules as the shell's and the service's builds (apps/desktop/scripts/licence-texts.mjs):

- A package's texts are its own licence files, as its wheel ships them.
- A package that ships none is named in a "no licence text shipped by the package" section and gets
  the standard text of each identifier it declares, from the repository's licences/standard/ (SPDX
  texts, copied unmodified). Never a text typed by hand or made up from an identifier.
- A package with no licence identifier, or one that ships no text and declares an identifier with no
  standard text, is a problem: the build fails with the package named.
- Identical texts are written once; the copyright lines of every copy are kept.

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
# licence and version exactly. "Apache Software License" (a trove classifier) names no version and is
# not mapped. (Seen in: onnxruntime "MIT License"; flatbuffers "Apache 2.0"; uharfbuzz "Apache License
# 2.0"; protobuf "3-Clause BSD License".)
ALIASES = {
    "MIT License": "MIT",
    "Apache 2.0": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "3-Clause BSD License": "BSD-3-Clause",
}
UNUSABLE = re.compile(r"^\s*(UNKNOWN|UNLICENSED|SEE LICEN[CS]E|NONE|NOASSERTION)\b", re.I)
COPYRIGHT_LINE = re.compile(r"^\s*(?:copyright\b(?=.*(?:\(c\)|©|\b(?:1[89]|20)\d\d\b|<year>))|\(c\)\s|©)", re.I)


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def licence_ids(declared: str | None) -> list[str]:
    """The licence and exception identifiers a declaration names."""
    if not declared or not declared.strip() or UNUSABLE.match(declared):
        return []
    declared = ALIASES.get(declared.strip(), declared)
    parts = re.split(r"\s+(?:OR|AND|WITH)\s+|\s*/\s*", declared.replace("(", " ").replace(")", " "))
    return sorted({ALIASES.get(p.strip(), p.strip()) for p in parts if p.strip()})


def sbom_licence(info_dir: Path | None, name: str) -> str | None:
    """The licence the wheel's own CycloneDX SBOM (dist-info/sboms/) gives for a component of this name."""
    if not info_dir or not (info_dir / "sboms").is_dir():
        return None
    want = canonical(name)
    for f in sorted((info_dir / "sboms").glob("*.json")):
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        comps = list(doc.get("components") or [])
        top = (doc.get("metadata") or {}).get("component")
        if top:
            comps += [top, *(top.get("components") or [])]
        for c in comps:
            if canonical(str(c.get("name", ""))) != want:
                continue
            found = [x.get("expression") or (x.get("license") or {}).get("id") for x in c.get("licenses") or []]
            found = [x for x in found if x]
            if found:
                return " AND ".join(found)
    return None


def split_copyright(text: str) -> tuple[list[str], str]:
    """A text's copyright lines (trimmed, in order) and the rest of it, unchanged except that the
    blank lines on both sides of a removed line become one."""
    copyrights: list[str] = []
    rest: list[str] = []
    after_removed = False
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if COPYRIGHT_LINE.match(line):
            copyrights.append(line.strip())
            after_removed = True
            continue
        if not (after_removed and not line.strip() and rest and not rest[-1].strip()):
            rest.append(line)
        after_removed = False
    return copyrights, "\n".join(rest).strip("\n").rstrip()


def load_standard(folder: Path = STANDARD_DIR) -> dict[str, str]:
    return {p.stem: p.read_text(encoding="utf-8") for p in sorted(folder.glob("*.txt"))}


@dataclass
class Group:
    body: str
    copyrights: list[str] = field(default_factory=list)
    used_by: list[str] = field(default_factory=list)


@dataclass
class Result:
    groups: list[Group]
    no_text: list[dict]
    problems: list[str]


def collect(packages: list[dict], standard: dict[str, str]) -> Result:
    """packages: {name, version, licence, files: [(file name, text)], sbom_licence?}."""
    groups: dict[str, Group] = {}
    no_text: list[dict] = []
    problems: list[str] = []

    def add(text: str, label: str) -> None:
        copyrights, body = split_copyright(text)
        key = " ".join(body.split())
        g = groups.setdefault(key, Group(body))
        g.copyrights += [c for c in copyrights if c not in g.copyrights]
        if label not in g.used_by:
            g.used_by.append(label)

    for p in packages:
        pid = f"{p['name']} {p['version']}"
        ids = licence_ids(p.get("licence"))
        sbom = licence_ids(p.get("sbom_licence"))
        if not ids and not sbom:
            problems.append(f"{pid} has no licence identifier (declared: {p.get('licence')!r})")
            continue
        if p["files"]:
            for name, text in p["files"]:
                add(text, f"{pid} ({name})")
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
        no_text.append({"name": p["name"], "version": p["version"], "licence": p.get("licence") or "", "ids": ids,
                        "used": f"the standard text{s} of {', '.join(ids)} (licences/standard{note})"})
    return Result(list(groups.values()), no_text, problems)


def _heading(text: str, ch: str) -> str:
    return f"{text}\n{ch * min(len(text), 100)}"


def render(title: str, intro: str, packages: list[dict], result: Result, preamble=(), appendix=()) -> str:
    """One readable file: the packages, the ones without a text of their own, each distinct text once
    with every copyright line of its copies, then `appendix` [(title, text)] unchanged."""
    out = [_heading(title, "="), "", intro, ""]
    for block in preamble:
        out += [block, ""]
    out.append(_heading(f"Packages ({len(packages)})", "-"))
    for p in packages:
        out.append(f"{p['name']} {p['version']}  {p.get('licence') or ''}")
        if p.get("note"):
            out.append(f"    {p['note']}")
    out += ["", _heading(f"No licence text shipped by the package ({len(result.no_text)})", "-")]
    if result.no_text:
        out.append("These packages carry no licence text of their own. The text used for each is named below; a person should check it.")
        out += [f"  {n['name']} {n['version']}: {n['licence']} - {n['used']}" for n in result.no_text]
    else:
        out.append("None: every package above ships its own licence text.")
    out += ["", _heading(f"Licence texts ({len(result.groups)} distinct)", "-"), ""]
    for i, g in enumerate(result.groups, 1):
        out.append(f"=== Text {i} of {len(result.groups)} ===")
        out.append(f"Used by: {', '.join(g.used_by)}")
        if g.copyrights:
            out.append("Copyright lines found in the copies of this text:")
            out += [f"  {c}" for c in g.copyrights]
        out += ["", g.body, ""]
    for t, text in appendix:
        out += [_heading(t, "-"), "", text.rstrip(), ""]
    return "\n".join(out).rstrip("\n") + "\n"


def fail_on(problems: list[str]) -> None:
    if problems:
        print(f"licence texts: {len(problems)} problem(s); the build stops", file=sys.stderr)
        for p in problems:
            print(f"  {p.strip()}", file=sys.stderr)
        raise SystemExit(1)
