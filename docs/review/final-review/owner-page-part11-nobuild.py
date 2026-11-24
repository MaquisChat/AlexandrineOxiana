#!/usr/bin/env python3
"""Adds part 11 to the owner's page when the round is green on GitHub but NO Mac build of it exists yet.
usage: owner-page-part11-nobuild.py <page.md> <draft.md> <additions.md> <ci-run-url> <mac-run-url>"""
import sys

page, draft, additions, ci_url, mac_url = sys.argv[1:6]
s = open(page, encoding="utf8").read()


def swap(old: str, new: str) -> None:
    global s
    assert s.count(old) == 1, f"expected once: {old[:70]!r} ({s.count(old)})"
    s = s.replace(old, new)


# The head note.
swap(
    "*Updated 24 November 2026: part 10, at the end, is new",
    "*Updated 24 November 2026, later: part 11, at the end, is new — the known gaps of part 10 are built and pass GitHub's check, but there is no Mac build of them yet: GitHub has not given the build a Mac. Build 10 stays the build to use. Start at part 11; it also has a new decision (31).*\n\n*Updated 24 November 2026: part 10, at the end, is new",
)
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
    "- An interrupted change is reported once per project: \"A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back.\" *(The next build changes these words: part 11, \"When a change was interrupted\".)*",
)
swap("### Things only you can check in build 10", "### Things only you can check in build 10 (still the build to use; part 11 has the list for the next one)")
a = s.index("### What I am building next, and GitHub's check (24 November, 2:30 am Central)")
b = s.index("### Known gaps found during the round (not fixed)")
s = s[:a] + "### What I was building next (24 November, 2:30 am Central)\n\n*This was the state in the night. All of it is now done: part 11.*\n\n" + s[b:]
swap(
    "### Known gaps found during the round (not fixed)",
    "### Known gaps found during the round (not fixed)\n\n*24 November, later: all of these but FR-722 (your decision 29) are now built — part 11 says what became of each, and what is still open. The list is kept as it was written. One line of it was wrong: FR-738 does not need \"two crashes in a row\" in any build after build 10 — it can no longer happen there at all; part 11 says what remains of it.*",
)

d = open(draft, encoding="utf8").read().split("\n---\n")[0].rstrip() + "\n"


def dswap(old: str, new: str) -> None:
    global d
    assert d.count(old) == 1, f"draft, expected once: {old[:70]!r} ({d.count(old)})"
    d = d.replace(old, new)


dswap(
    "It comes to you as **Mac build 11**, which replaces build 10: [BUILD 11 LINK], run [RUN], SHA-256 `[SHA-256]`. Nothing in it needs a decision from you before you use it, and it is not in `main` until you say so.",
    "Nothing in it needs a decision from you before you use it.\n\n"
    "- **Where it stands:** built, tested together on my side, and green in GitHub's own check: " + ci_url + "\n"
    "- **There is no Mac build of it yet.** I asked for Mac build 11 twice. GitHub cancelled the Mac job four times, each time about fifteen minutes after it was queued, without ever giving it a Mac; nothing of the build ran, so this says nothing about the app. The last time a Mac was given was for build 10, the night before. I cannot see GitHub's reason from here; the cancelled job's page may show it: " + mac_url + " (the job \"apple-silicon (macos-15)\"). I will ask again with the next change (FR-749, below) and put the download here when it exists.\n"
    "- **Until then, build 10 is the build to use** (part 10 says where). What follows describes the next build.\n"
    "- **It is not in `main`** (the approved version). `main` has the rough-edges round (build 10) and lacks this round and the small fix to GitHub's check. **May I merge it?** A yes in the chat is enough.",
)
dswap("### What you will notice", "### What you will notice (in the next Mac build)")
dswap("### Things only you can check in build 11", "### Things only you can check in the next Mac build (build 11)")
dswap(
    "GitHub's Mac tested a quit sent as a system request: [Q RESULT].",
    "GitHub's Mac has not yet run its test of a quit sent as a system request, because no Mac build has run.",
)
dswap(
    "This corrects what I told you during the night, that such a change could be closed.",
    "This corrects what I told you in the chat during the night, that such a change could be closed.",
)
dswap(
    "- 30, logging out or shutting down: I recommend (a) now; (c) later if you ever see a \"the last change was not finished\" notice after a shutdown.",
    "- 30, logging out or shutting down: I recommend (a) now; (c) later if you ever see a \"the last change was not finished\" notice after a shutdown.\n"
    "- **31 (new, below), attaching a file when a metadata service says \"too many requests\": I recommend (b) now and (c) next.**",
)
dswap(
    "**Listed in this round, not built (most serious first):**",
    "**Listed in this round, not built (most serious first):**\n"
    "- **FR-749:** a library closed while a file is still \"Attaching…\" is written into after its lock is released. Being fixed and reviewed now; it comes with the next build (see \"What GitHub's own check found\", below).",
)
dswap(
    "- **Small points:** FR-717, FR-725, FR-729, FR-734 and FR-740 each keep a small leftover of wording, timing or a rare join.",
    "- **Small points:** FR-717, FR-725, FR-729, FR-734 and FR-740 each keep a small leftover of wording, timing or a rare join.\n"
    "- **Tests only:** FR-747 and FR-750 are three tests that failed once on a heavily loaded machine and pass alone; they are watched, not changed.",
)
add = open(additions, encoding="utf8").read().rstrip() + "\n"
s = s.rstrip() + "\n\n" + d.rstrip() + "\n\n" + add
open(page, "w", encoding="utf8").write(s)
print("ok", len(d.split()) + len(add.split()), "words in part 11")
