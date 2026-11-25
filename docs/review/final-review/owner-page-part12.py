#!/usr/bin/env python3
"""Adds part 12 to the owner's page from the draft and corrects what part 11 says that is no longer so.
usage: owner-page-part12.py <page.md> <draft.md> <ci-run-url> <mac-run-url>"""
import sys

page, draft, ci_url, mac_url = sys.argv[1:5]
s = open(page, encoding="utf8").read()


def swap(old: str, new: str) -> None:
    global s
    assert s.count(old) == 1, f"expected once: {old[:70]!r} ({s.count(old)})"
    s = s.replace(old, new)


# The head note.
swap(
    "*Updated 24 November 2026, mid-afternoon:",
    "*Updated 24 November 2026, evening: part 12, at the end, is new — closing the library safely (FR-749) and your decision 31 (b) are built, reviewed, tested together and pushed as build request 12; it has four small choices for \"Look up again\" and asks whether I may merge. Start there.*\n\n*Updated 24 November 2026, mid-afternoon:",
)
# Part 11: what is no longer so.
swap(
    "Being fixed and reviewed now; it comes with the next build (see \"What GitHub's own check found\", below).",
    "Being fixed and reviewed now; it comes with the next build (see \"What GitHub's own check found\", below). *(Built since: part 12.)*",
)
swap(
    "### Things only you can check in the next Mac build (build 11)",
    "### Things only you can check in the next Mac build (no build 11 was ever made; part 12's list is the one to use)",
)
swap(
    "I will ask again with the next change (FR-749, below) and put the download here when it exists.",
    "I will ask again with the next change (FR-749, below) and put the download here when it exists. *(Asked again as build request 12: part 12.)*",
)

d = open(draft, encoding="utf8").read().split("\n---\n")[0].rstrip() + "\n"


def dswap(old: str, new: str) -> None:
    global d
    assert d.count(old) == 1, f"draft, expected once: {old[:70]!r} ({d.count(old)})"
    d = d.replace(old, new)


dswap(
    "They are being tested together and go out as build request 12.\n\n[WHERE IT STANDS]\n\nIt is not in `main` until you say so. **May I merge it?** A yes in the chat is enough.",
    "They were tested together and are pushed as build request 12.\n\n"
    "- **Tested together on my side:** every step passes. The first full run caught two faults of the close work, and both were mended before anything was pushed (they are in the list of what was caught, below); the second full run passed everything except one of 224 browser scenarios, which failed once in one browser for a cause that is older than this work and is now understood (FR-750, under \"Still open\").\n"
    "- **GitHub's own check** runs on the push: " + ci_url + " — I will say here and in the chat when it is in.\n"
    "- **A Mac build** is asked for again: " + mac_url + " — GitHub has cancelled the Mac job five times so far without giving it a machine; if it builds this time, the download goes here. Until then build 10 stays the build to use.\n"
    "- **It is not in `main`** until you say so. **May I merge it?** A yes in the chat is enough. (I would wait for GitHub's check to be green before merging.)",
)
dswap(
    "- the first build of the \"do not wait\" rule still asked a service again when files overlapped, and slowed Bulk Import down.",
    "- the first build of the \"do not wait\" rule still asked a service again when files overlapped, and slowed Bulk Import down.\n\n"
    "And the full test run, after all the reviews, caught two more, both mended before the push:\n"
    "- \"Move library\" left the old copy's search index open, so the old copy was not the exact copy the move checks for (the index can be rebuilt; nothing of yours was touched);\n"
    "- an integrity check that was waiting when the library was moved said the library was \"closed\" where it should say it was moved.",
)
dswap(
    "### Still open\n\n",
    "### Still open\n\n"
    "- **FR-755 (the first thing I build next):** if \"Move library\" fails at its very last steps, after it has closed the old copy, the app is left working on the closed library: changes are refused and a search shows an error until you start the app again; the move then finishes when the library is opened, and nothing is lost. Found by reading the code, not by a test. Rare: it needs a failure such as a full disk at that moment. In `main` today the same failure is worse (changes would still be written into the old copy), so this build is safer there, not less safe.\n"
    "- **FR-750 (built with it):** the Find and acquire screen can sit at \"Reading the projects…\" with no error and no \"Try again\" when its very first requests fail. Seen three times in the test browser, never on a Mac so far; the cause is found.\n",
)
dswap(
    "- **FR-747, FR-750:** tests only.",
    "- **FR-754:** the \"automatic backup failed\" warning says \"make one now from the project's settings\", but no screen offers a backup by hand. A sentence to correct, or a button to add.\n"
    "- **FR-747:** a test only.",
)
s = s.rstrip() + "\n\n" + d.rstrip() + "\n"
open(page, "w", encoding="utf8").write(s)
print("ok", len(d.split()), "words in part 12")
