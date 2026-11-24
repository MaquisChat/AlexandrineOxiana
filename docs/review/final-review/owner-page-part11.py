#!/usr/bin/env python3
"""Adds part 11 to the owner's page and corrects the earlier parts the known-gaps round overtook.
usage: owner-page-part11.py <page.md> <draft.md> <run-url> <run-number> <dmg-sha256> <q-result sentence> <ci sentence>"""
import sys

page, draft, url, run, sha, qres, ci = sys.argv[1:8]
s = open(page, encoding="utf8").read()


def swap(old: str, new: str) -> None:
    global s
    assert s.count(old) == 1, f"expected once: {old[:70]!r} ({s.count(old)})"
    s = s.replace(old, new)


# The head note.
swap(
    "*Updated 24 November 2026: part 10, at the end, is new",
    "*Updated 24 November 2026, later: part 11, at the end, is new — the known gaps of part 10 are built and come to you as Mac build 11. Start there.*\n\n*Updated 24 November 2026: part 10, at the end, is new",
)
# Part 4 and part 8 name the build to use.
swap("*Use Mac build 10 for these (part 10 says where to download it).", "*Use Mac build 11 for these (part 11 says where to download it).")
swap("**build 10 (part 10) now replaces it.**", "**build 11 (part 11) now replaces it** (build 10, part 10, came in between).")
# Part 9, item 1.
a = s.index("- [ ] **1. Install Mac build 10**")
b = s.index("\n", a)
s = s[:a] + f"- [ ] **1. Install Mac build 11** (part 11 says where: run {run}'s download). It replaces builds 8, 9 and 10: build 9 mended the optional tools' downloads, build 10 added the rough-edge fixes, and build 11 adds the known gaps the rough-edges round had listed." + s[b:]
# Part 10: what was overtaken.
a = s.index("- **It is in `main`** (the approved version) since 24 November")
b = s.index("\n", a)
s = s[:a] + "- **It is in `main`** (the approved version) since 24 November, shortly before 11 pm Central on the 23rd: you said \"Merge and keep building please\". GitHub's check of `main` has been red since then for a reason outside the app (a package mirror missing a file; see the end of this part and part 11)." + s[b:]
swap(
    "- **What I build next, as you asked:** the known gaps at the end of this part (FR-717 to FR-741), most serious first.",
    "- **What I built next, as you asked:** the known gaps at the end of this part (FR-717 to FR-741). They are done: part 11.",
)
swap(
    "- An interrupted change is reported once per project: \"A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back.\"",
    "- An interrupted change is reported once per project: \"A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back.\" *(Build 11 changes these words: part 11, \"When a change was interrupted\".)*",
)
swap("### Things only you can check in build 10", "### Things only you can check in build 10 (they carry over to build 11: part 11 has the list to use)")
a = s.index("### What I am building next, and GitHub's check (24 November, 2:30 am Central)")
b = s.index("### Known gaps found during the round (not fixed)")
s = s[:a] + "### What I was building next (24 November, 2:30 am Central)\n\n*This was the state in the night. All of it is now done: part 11.*\n\n" + s[b:]
swap(
    "### Known gaps found during the round (not fixed)",
    "### Known gaps found during the round (not fixed)\n\n*24 November, later: all of these but FR-722 (your decision 29) are now built — part 11 says what became of each, and what is still open. The list is kept as it was written. One line of it was wrong: FR-738 does not need \"two crashes in a row\" in any build from 11 on — it can no longer happen there at all; part 11 says what remains of it.*",
)

d = open(draft, encoding="utf8").read().split("\n---\n")[0].rstrip() + "\n"


def dswap(old: str, new: str) -> None:
    global d
    assert d.count(old) == 1, f"draft, expected once: {old[:70]!r} ({d.count(old)})"
    d = d.replace(old, new)


dswap(
    "It comes to you as **Mac build 11**, which replaces build 10: [BUILD 11 LINK], run [RUN], SHA-256 `[SHA-256]`. Nothing in it needs a decision from you before you use it, and it is not in `main` until you say so.",
    "It comes to you as **Mac build 11**, which replaces build 10, and nothing in it needs a decision from you before you use it.\n\n"
    f"- **Where:** run {run} of \"Desktop (macOS)\" on GitHub: {url} — at the bottom of that page, under \"Artifacts\", download `alexandrine-oxiana-macos-apple-silicon`, unzip it and open the `.dmg` inside. Its SHA-256 is `{sha}`.\n"
    f"- **GitHub's own check:** {ci}\n"
    "- **It is not in `main`** (the approved version). `main` has the rough-edges round (build 10) and lacks this round and the small fix to GitHub's check. **May I merge it?** A yes in the chat is enough.",
)
dswap("GitHub's Mac tested a quit sent as a system request: [Q RESULT].", f"GitHub's Mac tested a quit sent as a system request: {qres}")
dswap(
    "This corrects what I told you during the night, that such a change could be closed.",
    "This corrects what I told you in the chat during the night, that such a change could be closed.",
)
s = s.rstrip() + "\n\n" + d
open(page, "w", encoding="utf8").write(s)
print("ok", len(s.split()))
