#!/usr/bin/env python3
"""Adds part 13 to the owner's page from the draft and marks what earlier parts say that is no longer so.
usage: owner-page-part13.py <page.md> <draft.md> <where-it-stands.md>"""
import sys

page, draft, where = sys.argv[1:4]
s = open(page, encoding="utf8").read()


def swap(old: str, new: str) -> None:
    global s
    assert s.count(old) == 1, f"expected once: {old[:70]!r} ({s.count(old)})"
    s = s.replace(old, new)


def after_line(start: str, note: str) -> None:
    """Appends `note` to the one line that begins with `start`."""
    global s
    lines = s.split("\n")
    hits = [k for k, l in enumerate(lines) if l.startswith(start)]
    assert len(hits) == 1, f"expected one line: {start[:60]!r} ({len(hits)})"
    lines[hits[0]] = lines[hits[0]] + " " + note
    s = "\n".join(lines)


# The head note.
swap(
    "*Updated 24 November 2026, evening:",
    "*Updated 25 November 2026, just after midnight Central: part 13, at the end, is new — the move fix, the screens that no longer wait for ever (the first five), and \"Look up again\" are built, reviewed, tested together and pushed as build request 13. It asks whether I may merge. Start there.*\n\n*Updated 24 November 2026, evening:",
)
# Earlier parts: what is no longer so.
swap(
    "This was seen once in the web view the Mac uses. The app has no give-up.",
    "This was seen once in the web view the Mac uses. The app has no give-up. *(From build request 13 it has one on Find and acquire, Watched folders, Zotero sync, the opening screen and the library screen: part 13. The other screens follow.)*",
)
swap(
    "- [ ] Note whether any screen ever stays at \"Reading…\". (FR-575, FR-595)",
    "- [ ] Note whether any screen ever stays at \"Reading…\". (FR-575, FR-595) *(Part 13 says which screens now give up after twenty seconds and offer \"Try again\".)*",
)
swap(
    "(b) is being built now; (c), \"look up again\", is the piece after it.**",
    "(b) is being built now; (c), \"look up again\", is the piece after it.** *(Both are built: (b) in build 12, (c) in build request 13 — part 13.)*",
)
swap(
    "- **Tests only:** FR-747 and FR-750 are three tests that failed once on a heavily loaded machine and pass alone; they are watched, not changed.",
    "- **Tests only:** FR-747 and FR-750 are three tests that failed once on a heavily loaded machine and pass alone; they are watched, not changed. *(Corrected since: FR-750 was a real weakness of the screen, not only of its test — a first reading that never got an answer left it waiting for ever. Mended: part 13.)*",
)
swap(
    "One thing to know until (c) is built: nothing looks such a record up again by itself yet,",
    "One thing to know until (c) is built *(it is now: part 13)*: nothing looks such a record up again by itself yet,",
)
swap(
    "I build my recommendation for each unless you say otherwise before the build starts.",
    "I build my recommendation for each unless you say otherwise before the build starts. *(Built so: part 13, \"the four choices, as built\", which also says how each can still be changed.)*",
)
after_line("- **FR-755 (the first thing I build next)", "*(Built, with three reviews: part 13, A. The advice above — stop and tell me — is for build 12 only.)*")
swap(
    "- **FR-750 (built with it):** the Find and acquire screen can sit at \"Reading the projects…\" with no error and no \"Try again\" when its very first requests fail. Seen three times in the test browser, never on a Mac so far; the cause is found.",
    "- **FR-750 (built with it):** the Find and acquire screen can sit at \"Reading the projects…\" with no error and no \"Try again\" when its very first requests fail. Seen three times in the test browser, never on a Mac so far; the cause is found. *(Corrected and built: the cause was a request that never got an answer, not one that failed — part 13, B.)*",
)
swap(
    "- **Decision 31 (b):** the hold on a service is kept in memory, so after the library is closed and reopened one request can go early. Until (c) is built, nothing looks a waiting record up again by itself.",
    "- **Decision 31 (b):** the hold on a service is kept in memory, so after the library is closed and reopened one request can go early. Until (c) is built, nothing looks a waiting record up again by itself. *(Both closed by build request 13: part 13.)*",
)

d = open(draft, encoding="utf8").read().split("\n---\n")[0].rstrip() + "\n"
w = open(where, encoding="utf8").read().rstrip()


def dswap(old: str, new: str) -> None:
    global d
    assert d.count(old) == 1, f"draft, expected once: {old[:70]!r} ({d.count(old)})"
    d = d.replace(old, new)


dswap(
    "## 13. Added on 24 November, late evening: the move finished safely, screens that no longer wait for ever, and \"Look up again\"",
    "## 13. Added on 25 November, just after midnight: the move finished safely, screens that no longer wait for ever, and \"Look up again\"",
)
dswap("[WHERE IT STANDS]", w)
dswap(
    "- [ ] Turn Wi-Fi off and attach a PDF. Its entry should say, under the matches: \"Not looked up: a lookup service could not be reached. You can use Look up again.\"",
    "- [ ] Turn Wi-Fi off and attach a PDF. Its entry should say, under the matches: \"Not looked up: a lookup service could not be reached. You can use Look up again.\" (I could not try this on a Mac; if it says something else, tell me the words.)",
)
dswap(
    "   **To switch later to \"one request at once, as your own act\":** small, two edits.",
    "   **To switch later to \"one request at once, as your own act\":** small, a few edits and one review (the press would have to pass the hold that is now kept across reopenings).",
)
dswap(
    "- **The same \"never wait for ever\" fix for the other screens (FR-756).** Built for the governance screens, \"Your library\", search sources, tools, the extension's pairing, the researcher's name, the transcript viewer, the reader, capture and the import; a review sent it back and it is being mended.",
    "- **The same \"never wait for ever\" fix for the other screens (FR-756).** Built for the governance screens, \"Your library\", search sources, tools, the extension's pairing, the researcher's name, the transcript viewer, the reader, capture and the import; a review sent it back, it has been mended, and it is at its second review.",
)
dswap(
    "- **Moving into a stopped move's folder (FR-068).** What will be built:",
    "- **Moving into a stopped move's folder (FR-068).** Built, and approved at its second review with small points that are being mended; it comes with the build after this one. What it does:",
)
dswap(
    "- **FR-754:** the \"automatic backup failed\" warning says \"make one now from the project's settings\", but no screen offers that. You would meet it only if an automatic backup fails.",
    "- **FR-754:** the \"automatic backup failed\" warning says \"make one now from the project's settings\", but no screen offers that. You would meet it only if an automatic backup fails.\n"
    "- **FR-760:** two small points of the move that are older than this work: moving the library that stayed behind after a move of some projects into that move's new place answers \"done\" although nothing moved; and one check after an upgrade from an older build rests on the later checks. Nothing is lost in either.",
)
s = s.rstrip() + "\n\n" + d.rstrip() + "\n"
open(page, "w", encoding="utf8").write(s)
print("ok", len(d.split()), "words in part 13")
