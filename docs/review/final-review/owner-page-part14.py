#!/usr/bin/env python3
"""Adds part 14 to the owner's page from the draft and marks what earlier parts say that is no longer so.
usage: owner-page-part14.py <page.md> <draft.md> <where-it-stands.md> <head-note.txt> <heading-time> [mac14]
  head-note.txt: one line, the new "*Updated …*" note for the top of the page.
  heading-time:  e.g. "25 November, morning" — goes into part 14's heading.
  mac14:         give this word once Mac build 14 exists (part 9's install line then points to it)."""
import sys

page, draft, where, head, when = sys.argv[1:6]
mac14 = len(sys.argv) > 6 and sys.argv[6] == "mac14"
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
h = open(head, encoding="utf8").read().strip()
assert h.startswith("*Updated") and h.endswith("*") and "\n" not in h
swap("*Updated 25 November 2026, just after midnight Central:", h + "\n\n*Updated 25 November 2026, just after midnight Central:")

# Earlier parts: what is no longer so.
after_line(
    "   **What it is:** If a request never gets an answer",
    "*(They have followed: from build request 14 nearly every screen gives up after twenty seconds and offers \"Try again\" — part 14, A. A screen does not try again by itself; you press \"Try again\". If that is enough for you, this decision needs no answer.)*",
)
after_line("- [ ] Note whether any screen ever stays at \"Reading…\"", "*(Part 14, A, names the rest.)*")
after_line(
    "- [ ] **1. Install Mac build 13**",
    "*(Mac build 14 has replaced it: part 14 says where to download it.)*" if mac14 else "*(Build request 14 is on its way: when part 14 names Mac build 14, install that one instead.)*",
)
after_line(
    "- **FR-068 (added 24 November, 9:20 pm Central",
    "*(Superseded from build request 14: the app's engine now refuses that folder too, the dialog says why, and the leftover folder says what it is — part 14, B.)*",
)
after_line(
    "- **The same \"never wait for ever\" fix for the other screens (FR-756).**",
    "*(Built and in build request 14, except the missing-files check: part 14, A.)*",
)
after_line(
    "- **Moving into a stopped move's folder (FR-068).**",
    "*(In build request 14. Two things in this paragraph are not quite how it was built — when the leftover folder says it can be deleted, and what the dialog advises you to do: part 14, B, has the exact words.)*",
)
after_line("- **FR-756:** the list of libraries can show \"No libraries yet\"", "*(Mended in build request 14.)*")

d = open(draft, encoding="utf8").read().split("\n---\n")[0].rstrip() + "\n"
w = open(where, encoding="utf8").read().rstrip()


def dswap(old: str, new: str) -> None:
    global d
    assert d.count(old) == 1, f"draft, expected once: {old[:70]!r} ({d.count(old)})"
    d = d.replace(old, new)


dswap(
    "## 14. Added on 25 November: every screen gives up politely, and the move refuses a leftover folder",
    f"## 14. Added on {when}: every screen gives up politely, the move refuses a leftover folder, and a stopped download asks nothing more",
)
dswap(
    "After build request 13, two more pieces were built for the next Mac build (build request 14).",
    "After build request 13, three more pieces were built for the next Mac build (build request 14): two planned, and the mend of a small fault that one of the tests caught.",
)
dswap(
    "I read the last mends of each piece myself.",
    "I read the last mends of each piece myself. The third: a download that is stopped no longer connects to the site it was about to ask (under \"What became safer underneath\").",
)
dswap("[WHERE IT STANDS]", w)
dswap(
    "[FR-757]",
    "- **Find and acquire: a stopped download asks nothing more (FR-757).** After build request 13 was pushed, one test failed on GitHub. It had caught a small fault of the app, older than this work: when a download of a free copy was stopped at one exact moment — by stopping the search, or by locking or closing the library — the app could still connect to the site it was about to download from. The site could see that your computer connected; no request was sent, nothing about what you were looking for went out, and nothing was downloaded or kept. Now a download checks whether it was stopped right before every request. A builder reproduced it and proved the cause (my own first guess, the date and time, was wrong); a reviewer who had not built the mend measured what could go out and confirmed the mend.",
)
dswap(
    "- **FR-757:** a test of Find and acquire that fails now and then on GitHub. Being mended.\n",
    "- **FR-765 (built and reviewed since; it comes with the next build):** when you lock a project or move the library while a lookup is under way, that lookup could still send its retries. It repeats a question the service was already asked before the lock, so nothing new goes out — but nothing at all should be asked after a lock. Found by the review of FR-757.\n"
    "- **FR-764 (built with it):** the same kind of gap as FR-757 in three more places (a Zotero sync stopped while it waits to retry a file; two spots of the lookup): after a stop the app could still connect to the service once, without sending a request.\n"
    "- **FR-767 (being built now):** the fault of FR-759 below, on four more paths — bulk import, watched folders, the Zotero import and Zotero sync. Found by reading; each is being proved first, then closed.\n"
    "- **FR-768:** when one project's lookup is stopped, another project's next lookup at the same service can wait a few seconds longer than it needs to. Nothing is asked too early.\n"
    "- **FR-766:** a leftover move folder opened while the library's own drive is unplugged says the move \"could not be finished now\" and to connect the drive; with the drive back it will say, rightly, that it is a leftover that can be deleted. Rare, and nothing is lost.\n"
    "- **FR-763 (mended; it comes with the next build):** one test compared a fixed date with today's date and would have begun to fail by itself on 11 December. A fault of the test, not of the app. Every test was then run with the clock moved a year ahead; nothing else turned up.\n",
)
dswap(
    "- **FR-759:** locking an encrypted project during an attach's lookup may leave one answer in memory. You would not see it.",
    "- **FR-759 (checked, true, mended; it comes with the next build):** locking an encrypted project while a file was being attached could leave one answer about that file's source in the app's memory after the lock. Nothing was written to disk or sent anywhere, and you would not see it.",
)
s = s.rstrip() + "\n\n" + d.rstrip() + "\n"
open(page, "w", encoding="utf8").write(s)
print("ok", len(d.split()), "words in part 14")
