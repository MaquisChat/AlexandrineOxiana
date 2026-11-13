# Find and acquire — design

Status: draft for the owner's approval (2026-11-13). Nothing here is built.
Marked **(owner)** where the owner said it; everything else is the coordinator's proposal and can be changed.

## What it is, and why

The researcher often has only a reference in hand — a title and an author from a footnote, a syllabus or a conversation — or only an author's name. Today the way from there to having the work in the library is long: look it up somewhere, find a copy, download it, drag it in, check the record.

**Find and acquire** shortens that to one box. The researcher types what they have; the app works out which publication is meant, fills in the full record, and gets the document into the library where it legally can — and says plainly, per entry, what happened and what is left to do.

- **(owner)** The input is "just a reference of title and author, or perhaps an author, in which case there should be a variety of works".
- **(owner)** "There should be a separate screen in settings in which it is possible to configure where a search goes, including Elicit."
- **(owner)** "Let's integrate support for library logins."
- **(owner)** For the sign-in: the window inside the app first, the researcher's own browser plus the app's extension as the fallback.

## Goals

1. One box, one queue. Each thing typed becomes a queue entry that the researcher can watch move from "looking it up" to its outcome, and that survives the app being closed.
2. **A title and author** → the matching work. When the app is sure, the record is completed without a question; when several works or editions fit, the researcher picks.
3. **An author alone** → first the right person (several researchers share a name), then a list of that person's works to tick; each ticked work becomes its own queue entry.
4. **The record** is completed from the configured search sources, with each field's origin recorded as the app already does for imports.
5. **The document** is acquired in this order, stopping at the first that works: (a) a free legal copy; (b) the researcher's library subscription, through their own sign-in; and where neither gives a copy, (c) the record comes in without a file and says where the item can be had.
6. **A settings screen "Search sources"**: which services a search goes to, in what order, each on or off; services that need an account (Elicit) take a key; a "Test" button says whether a service answers.
7. **A settings screen "Your library"**: the researcher's institution, so that paywalled items can be opened through it.
8. Everything by keyboard and with a screen reader, in plain words, like the rest of the app.

## Not in this version

- Interlibrary-loan requests, controlled digital lending and Google Books previews (the specification's later "access chain" items).
- Pasting a whole bibliography of fifty references at once (one reference per line is accepted and each line becomes an entry, but there is no parsing of formatted citations beyond title, author and year).
- Watches ("tell me when this author publishes") and agents.
- Anything on Windows or Linux beyond not breaking them.

## What must never happen

- **No shadow libraries.** The app never looks for or fetches copies from sites that distribute works without the right to (Sci-Hub, Library Genesis and the like), and no setting can add one.
- **No bulk downloading through a library login.** Through the researcher's library, the app fetches one item at a time, each started by the researcher, with the researcher present. Library licences forbid systematic downloading, and an account can be suspended for it.
- **The app never sees or keeps the researcher's library password**, and no key or sign-in cookie is ever written into a library, a log or an audit entry.
- **No wrong paper attached in silence.** A downloaded file is checked against the record (its DOI or title in the file's own text); a file that does not match goes to the review queue with both shown, never straight into the source.
- **No second copy of a work already in the library.** An entry that matches an existing source says "Already in your library" and links to it.
- **Nothing sent that the project forbids.** A project's governance rules decide whether online lookups and each kind of acquiring are allowed; a refusal is said in plain words on the entry.

## How it works for the researcher

A new screen, **Find and acquire**, beside Capture:

```
Find and acquire                                   Project: Market study ▾   Collection: (none) ▾
[ Bourdieu, Distinction                                                          ] [ Add ]
  One reference per line: a title and author, or an author alone.

Queue
 ✓ Distinction — Pierre Bourdieu, 1984 (book)      Record complete · No open copy · Where to get it ▸
 ● The Forms of Capital — Pierre Bourdieu, 1986    Record complete · Open copy found · Fetching…
 ? "weak ties" Granovetter                         3 possible matches · Choose ▸
 ☰ Author: Arlie Hochschild                        2 people match · Choose the person ▸
 ⚑ Emotion Work… — Hochschild, 1979                Record complete · Behind a paywall · Get through my library ▸
 = The Managed Heart — Hochschild, 1983            Already in your library · Open ▸
```

Each entry shows, in words (never by colour or symbol alone): what was typed; what it was matched to; and one state — Looking it up · Choose (several matches) · Choose the person · Choose works · Record complete · Looking for a copy · Fetching · In your library · Already in your library · No open copy (with "Get through my library" and "Where to get it") · Waiting for you in the sign-in window · Needs your check (the file did not match) · Not found · Could not be done (with the reason and "Try again"). An entry can be removed from the queue at any time; removing an entry never removes a source.

**Choosing.** "Choose" lists the candidate works with authors, year, kind, where published and an identifier, the likeliest first, with "None of these". "Choose the person" lists people with their affiliation and a few titles. "Choose works" lists that person's works, newest first, with a filter by year and kind and a text filter; the researcher ticks any number and presses "Add the chosen works".

**Get through my library.** For a paywalled entry the researcher presses this; a separate window opens the item through their library. They sign in on their institution's own page (two-step codes included). When the publisher's page shows, the app looks for the PDF where publishers mark it in the standard way and fetches it in that same window; where there is no such mark, a line at the top of the window says "Open the PDF on this page and the app will add it", and the app takes the download the researcher starts. The window is used for one entry at a time and closes when the file has arrived or the researcher closes it.

**The fallback.** Where an institution's sign-in page refuses to work inside the app's window, the entry offers "Open in my browser instead". The item opens through the library in the researcher's own browser, where they are already signed in; the app's browser extension shows "Add this PDF to Find and acquire" on that page and hands the file to the waiting entry.

**Where to get it.** For an entry with no copy: the publisher's page, the researcher's library catalogue search for it (when "Your library" is set), and, for books, Open Library and WorldCat links. Links open in the researcher's browser.

**Settings → Search sources.** A list the researcher can switch on and off and reorder, in two groups: *Finding the work and its record* (Crossref, OpenAlex, Open Library, the Library of Congress — as today — and Elicit) and *Finding a free copy* (OpenAlex's open-access locations, arXiv, Europe PMC, Semantic Scholar, the Directory of Open Access Books, the Internet Archive for public-domain books, and Unpaywall). Each shows what is sent to it ("the words you type", "the work's DOI"), whether it needs an account, and "Test". Elicit asks for an API key (from the researcher's Elicit account; a Pro plan or higher) which is kept only in the Mac's password store. Unpaywall asks for an e-mail address, because that service requires one with every request; it is off until the researcher supplies it.

**Settings → Your library.** The institution's name and its access address (the "proxy" address many libraries publish, or its link resolver). The researcher can paste any link that goes through their library and the app works the address out; "Test" opens a known article through it. "Sign out of my library" ends the session in the app's sign-in window.

## How it is built (the approach)

Three ways of doing library sign-in were considered:

1. **A sign-in window inside the app** — chosen as the first path **(owner)**. One place, driven by the queue; the researcher signs in on their institution's own page; the password never passes through the app.
2. **The researcher's own browser plus the app's extension** — chosen as the fallback **(owner)**. The most reliable for sign-in, and the extension and its pairing with the app already exist; but the researcher changes to the browser for each item and the extension must be installed.
3. **Fully automatic fetching in the background after one sign-in** — rejected. Library licences forbid systematic downloading, publishers detect it, and it can get the researcher's library account suspended.

The rest builds on what exists:

- **Looking up** reuses the library's lookup machinery (`packages/library/src/lookup/`: Crossref, OpenAlex, Open Library, Library of Congress by title and author, with recorded fixtures for tests), which today is used only inside imports. It gains: a search by free text that returns ranked candidates with a confidence; people by name and a person's works (OpenAlex); and Elicit's paper search as one more source.
- **The queue** is library data in the project (like the capture queue): governed, audited (kinds, counts and ids only — never the typed text, a title or a name), crash-safe, resumed at start. Lookups and free-copy fetches run by themselves, a few at a time, politely (each service's rate rules honoured); library fetches never run by themselves.
- **A source is created when the record is complete**, without a file; the file is attached to that same source when it arrives. Duplicates are found with the existing rules (same DOI or ISBN: certain; a close title and author: the researcher is asked).
- **Free copies** are fetched by the service from a fixed list of hosts per source, with size and type limits, and only as PDF or EPUB.
- **The sign-in window** is a second window of the desktop shell that shows remote pages and has no access to the app's own commands (the launch check must prove it). Its cookies are kept apart from everything else and are dropped when the app quits, unless the researcher turns on "Stay signed in to my library". The file it downloads is handed from the shell to the service the way a chosen folder is today (a single-use grant on the existing pipe), never through the page.
- **The extension fallback** adds one action to the existing extension, using its existing pairing and token: ask the app which entries are waiting, and send a PDF for one of them.
- **Provenance** of each file records how it was got (a free copy from which service; the library; the browser), the publisher's address without any sign-in parts, the time, and the tool — like every other capture. Two new capture methods are added to the governance model so that a project can allow or forbid each: free copies, and the library.
- **Tests never reach the network**: stand-ins for each service; the sign-in window is exercised against a local stand-in for a library and a publisher; what only a real institution can show is listed for the owner.

## Constraints that bind the build

- The house rules: tests first; every library change governed, audited and crash-safe; the service on 127.0.0.1 with its token; no secret in a URL, a log or an error; colours from theme tokens; outside text only through `UserText`; request and response types declared once in `packages/shared`; dependencies pinned exactly, no GPL-family licence shipped.
- A public metadata service receives only bibliographic text (the words typed, an identifier). Elicit is a commercial service: it is off by default, receives only the words typed and nothing about the project, and a project's governance can forbid it.
- The researcher's e-mail address is sent to a service only if the researcher typed it into that service's setting for that purpose.
- One item at a time through the library; a pause between items; never while the researcher is away (the sign-in window must be open and the entry started by a press).

## Left to the builder

- The exact ranking and confidence rule for "sure enough to complete without asking".
- The exact list of hosts per free-copy source, and the limits.
- How the queue is stored, and its size limit.
- Which of Elicit's two documented search addresses the owner's account exposes (to be checked with the owner's key).
- The words of each refusal and failure, in the app's plain style.
- The order of tasks. A sensible first slice that is useful by itself: the box, the queue, title-and-author lookup with choosing, the record without a file, "Already in your library" — then authors, then free copies and the settings screen, then the library sign-in window, then the extension fallback.

## Open questions for the owner

1. **Which institution's library** will you use (so that the first test of the sign-in window is against the real thing)? Do you know its "proxy" address, or shall the app work it out from a link you paste?
2. **Staying signed in:** drop the library session when the app quits (the proposal), or keep it between sessions by default?
3. **Unpaywall** finds the most free copies but requires an e-mail address with every request. Are you content to type one into its setting, or should it stay off?
4. **Where entries land:** the box asks for a project (and optionally a collection) once and remembers it — or should each entry ask?
5. **Elicit:** which plan is your Elicit account on (its API needs Pro or higher)?
