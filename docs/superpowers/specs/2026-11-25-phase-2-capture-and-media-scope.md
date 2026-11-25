# Phase 2, "capture and media" — the scope

Written 25 November 2026 for the project's owner. This is a **scope**, not yet a design: it says what Phase 2 contains, what already exists, how big each piece is, what order makes sense, and what only you can decide. Nothing of Phase 2 is built until you have approved a design that follows from your answers.

The facts come from the specification (`docs/handoff/SPEC.md`, sections 5.1, 5.2 and 5.5 to 5.7), the rulings, and the code in `main` as of today. The fact-finding notes are beside this file: `2026-11-25-phase-2-recon.md`.

## What the app can already do

- **Capture a link** from YouTube, Instagram or TikTok (a post, a video, a playlist, a profile), from the Capture screen, the browser extension or the command line. It keeps the media, subtitles, thumbnail and the platform's own details, and records where each came from.
- **Re-capture a profile** later and see what is new and what was removed.
- **Capture any web page from the browser extension**: a picture of the whole page and a copy of its text and layout with every script removed.
- **Transcribe** audio and video on your own Mac, flag doubtful passages, and keep your corrections as versions.
- **Search** titles, authors, recognised text and transcripts.

**One caution before building on this.** Nothing on record shows that a real capture, a real transcription or an extension capture has been done on your Mac yet (it is on your hands-on list). Phase 2 stands on these. I recommend trying them with Mac build 14 before Phase 2 starts, so that we do not build a second storey on an untested first one.

## The pieces, and how big each is

Sizes include review and hardening, which in Phase 1 took about as long again as the first build. **Small** is about 1–2 days, **medium** 3–5 days, **large** 1–2 weeks, at the pace of the last two weeks and with usage available. They are rough.

| # | Piece | What you would get | Exists today | Size |
|---|---|---|---|---|
| 0 | Groundwork | One scheduler for everything that runs "every week"; a common way to plug in search services | A scheduler for Zotero sync; Find's search of two services | Medium |
| 1 | Web page snapshots | Paste an address in the app: a faithful copy, a PDF or picture, readable text you can search, details filled in | Only through the extension; no readable text, not searchable | Medium |
| 2 | Whole-site archive | A whole site crawled within limits you set, every page pictured, compared with an earlier crawl | Nothing | Large |
| 3 | Official platform interfaces | Capture through YouTube's, Meta's and TikTok's own research interfaces, for projects whose ethics protocol requires it | Only a label for "came from the official interface" | Medium **per platform** |
| 4 | Scheduled profile monitoring | "Check this profile every week" | Profile re-capture by hand | Small |
| 5 | Translation | Each transcript passage translated on your Mac, linked to its original | The rule "translation: local only" and a place to store translated text | Medium |
| 6 | Speaker separation | "Speaker 1 / Speaker 2" in a transcript | Nothing | Small to medium |
| 7 | Transcript editor in several languages | Original and translation side by side; edit either; name speakers | The viewer, with versions of your corrections | Medium |
| 8 | Search across languages | One search over originals and translations (and web page text) | Search over the newest transcript only | Small, after 5 |
| 9 | Research watches | A saved search that runs on a schedule and reports what is new since last time: literature, YouTube, Instagram, TikTok, websites, feeds | Find's one-off search | Medium to large |
| 10 | Research Inbox | Where watches put what they found. Nothing enters the library by itself: you accept, reject with a reason, or snooze | The review queue | Medium |
| 11 | Research agents | You write a brief; the app proposes searches for your approval, screens results, follows citations, within a budget, with a full log | Only the rule "agents: local only" | Large |

**Everything: roughly 6 to 10 weeks.** A first useful part: about 2 weeks.

## The order I recommend

1. **Capture more, and on a schedule** (pieces 0, 4, 1): about 1.5–2 weeks. The smallest step from what exists; useful by itself.
2. **Many languages** (5, 6, 7, 8): about 2–3 weeks.
3. **Finding new material** (the rest of 0, then 9 and 10): about 2–3 weeks.
4. **Agents** (11): 1–2 weeks, after 3, and only once the question about outside services is settled.
5. **Whole-site archive** (2): 1–2 weeks, once the replay question below is settled.
6. **Official platform interfaces** (3): 3–5 days each, and only for platforms where you hold the approval.

Each would get its own plan, builds and Mac checks, as Phase 1 did. The order can change: which part comes first is yours to say.

## Two places where the specification cannot be built as written

- **Replaying an archived site "exactly as it appeared".** That needs the archived site's scripts to run inside the app. A standing safety rule forbids running any archived script (it is why archived pages are shown in a locked frame). Either the rule gets a carefully fenced exception, or an archived site is shown as pictures and text. I recommend pictures and text first.
- **The translation model the specification names** may not be used commercially, and the project's licence (AGPL, which you chose) does not allow that restriction. There is a free alternative that runs on the Mac, one download of about 300 MB per language pair. So the question becomes: which languages?

## What only you can decide

Most consequential first. You do not need to answer all of these now.

1. **May anything use an outside service?** Translation, agents and speech can all run on your Mac only (the default today), or use a paid service where a project's rules allow. Agents depend on this most: on the Mac alone they need a download of several GB and will be weaker.
2. **Which part first**, and what it is for.
3. **Archived sites:** replay, or pictures and text.
4. **Which languages** to translate between.
5. **Official platform interfaces:** whether you have, or will apply for, research access at YouTube, Meta or TikTok. Without approval there is nothing to build against.
6. **Agents in Phase 2, or later.**
7. **Windows or Phase 2 first.** The plan lists the Windows app before Phase 2.
8. **Watches only while the app is open**, or also in the background when it is closed.
9. **Speaker separation:** the good models need a free account at their publisher to download. Acceptable?
10. **A browser of about 150 MB** downloaded at first use, to make faithful copies of web pages.
11. **Text recognition on the Mac** has no download yet; it is owed from Phase 1.

## Not in Phase 2

By the specification: meaning-based search (Phase 6), the connection for outside AI assistants and the sync server (Phase 5), highlights and coding (Phase 3).
