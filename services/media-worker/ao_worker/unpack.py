"""Unpacking a verified zip archive safely (R126): only into the staging folder given, only regular
files, no absolute paths, no `..`, no links, no duplicate names, at most MAX_FILES files and at most
`max_bytes` once unpacked (counted while writing, whatever the archive's headers claim). Anything
else refuses the whole archive (TOOL_ARCHIVE_UNSAFE); the caller removes the staging folder.
"""
from __future__ import annotations

import os
import stat
import zipfile
from pathlib import Path, PurePosixPath

from .fetch import ToolInstallError, _write_error

MAX_FILES = 20_000
CHUNK = 1 << 16


def _unsafe(message: str) -> ToolInstallError:
    return ToolInstallError("TOOL_ARCHIVE_UNSAFE", f"the downloaded archive was refused: {message}")


def safe_relative(name: str) -> PurePosixPath:
    """`name` as a relative path that stays inside its folder, or TOOL_ARCHIVE_UNSAFE."""
    if not name or "\0" in name or "\\" in name:
        raise _unsafe("a file name is not allowed")
    p = PurePosixPath(name)
    if p.is_absolute() or (p.parts and p.parts[0].endswith(":")):
        raise _unsafe("a file has an absolute path")
    if any(part in ("..", "") for part in p.parts):
        raise _unsafe("a file would be written outside its folder")
    return p


def _is_link_or_special(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    if not stat.S_IFMT(mode):
        return False  # permission bits only (or none): written as a plain file
    return not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))


def extract_zip(archive: Path, dest: Path, *, max_bytes: int, members: dict[str, str] | None = None, under: str | None = None) -> list[Path]:
    """Unpacks `archive` into `dest`.

    `members`: only these archive names, each written to the relative path it maps to (every one
    must be present). Otherwise every file is unpacked under `dest/<under>`. Returns the files written.
    """
    dest = Path(dest)
    try:
        zf = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError) as e:
        raise _unsafe("it is not a readable zip archive") from e
    written: list[Path] = []
    total = 0
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_FILES:
            raise _unsafe("it holds too many files")
        seen: set[str] = set()
        plan: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
        for info in infos:
            rel = safe_relative(info.filename.rstrip("/") if info.is_dir() else info.filename)
            if _is_link_or_special(info):
                raise _unsafe("it contains a link or a special file")
            key = str(rel).lower()  # macOS and Windows file systems ignore case
            if key in seen:
                raise _unsafe("it contains the same file twice")
            seen.add(key)
            if info.flag_bits & 0x1:
                raise _unsafe("it is encrypted")
            if info.is_dir():
                continue
            if members is not None:
                if info.filename not in members:
                    continue
                target = safe_relative(members[info.filename])
            else:
                target = PurePosixPath(under) / rel if under else rel
            plan.append((info, target))
        if members is not None:
            missing = set(members) - {i.filename for i, _ in plan}
            if missing:
                raise _unsafe("an expected file is missing from it")
        root = os.path.realpath(dest)
        for info, target in plan:
            out = dest / Path(*target.parts)
            if not os.path.realpath(out).startswith(root + os.sep):
                raise _unsafe("a file would be written outside its folder")
            try:
                out.parent.mkdir(parents=True, exist_ok=True)
                if os.path.lexists(out):
                    raise _unsafe("it contains the same file twice")
                with zf.open(info) as src, open(out, "xb") as f:
                    while True:
                        chunk = src.read(CHUNK)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_bytes:
                            raise _unsafe("it unpacks to more than expected")
                        f.write(chunk)
                os.chmod(out, 0o644)
            except ToolInstallError:
                raise
            except OSError as e:
                raise _write_error(e) from e
            except (zipfile.BadZipFile, EOFError, ValueError, RuntimeError) as e:
                raise _unsafe("it is damaged") from e
            written.append(out)
    return written
