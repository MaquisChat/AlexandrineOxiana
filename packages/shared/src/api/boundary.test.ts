// Task 47: the constants both the service and the interface used to keep their own copy of, now
// declared once here. The shapes themselves are checked by the compiler on both sides.
import { describe, expect, it } from "vitest";
import { YOUR_LIBRARY_TEST_DOI, type YourLibraryResponse, type YourLibraryTestResponse } from "../index.js";
import { ANNOTATION_ANCHORS_MAX, ANNOTATION_NOTE_MAX_CHARS, ANNOTATION_QUOTE_MAX_CHARS, ANNOTATION_RECTS_MAX, HIGHLIGHT_COLOUR_NAMES, SOURCE_ANNOTATIONS_MAX, SOURCE_ANNOTATION_TEXT_MAX, CAPTURE_BROWSERS, CAPTURE_CONTENT_TYPES, CAPTURE_ITEM_STATUSES, CAPTURE_LINKS_MAX, REVIEW_DECISION_ACTIONS, SERVICE_ERROR_CODES, WATCH_FILE_KINDS, WATCHED_FILE_LIST_KINDS, WATCHED_FILES_LIMIT_MAX, WATCHED_FILE_ACTION_DONE, FIND_ADD_LINES_MAX, FIND_BODY_MAX_BYTES, FIND_CANDIDATES_SENT, FIND_LINE_MAX_CHARS, FIND_LINE_MIN_CHARS, FIND_QUEUE_MAX, FIND_HELD_MAX, FIND_REASON_CODES, FIND_REASON_TEXT, FIND_ROUTE_TEXT, FIND_STATES, FIND_STOPPED_CODES, FIND_STOPPED_TEXT, findLineRefusal, FIND_PEOPLE_MAX, FIND_PERSON_WORKS_MAX, FIND_CHOOSE_WORKS_MAX, FIND_MORE_PEOPLE_TEXT, FIND_MORE_WORKS_TEXT, FIND_REFUSAL_REASONS, findAlreadyAddedRefusal, findWorkIdRefusal, type FindAuthorOffer, type FindEntryView, FIND_LIBRARY_TEXT, LIBRARY_PAUSE_MS, LIBRARY_TICKET_MS, WHERE_TO_GET_IT_MAX, WHERE_TO_GET_IT_URL_MAX, YOUR_LIBRARY_DERIVE_REFUSALS, YOUR_LIBRARY_DERIVE_TEXT, YOUR_LIBRARY_LINK_MAX, YOUR_LIBRARY_NAME_MAX, YOUR_LIBRARY_TEXT, libraryReadyIn, yourLibraryAddressSentence, ZOTERO_SYNC_EVERY_MINUTES, ZOTERO_SYNC_SENTENCES, type ZoteroSyncSettingsRequest, type ZoteroSyncStateResponse, WATCHED_FILE_PRESENCES, type WatchedSourceOrigin, SEARCH_RECORD_SOURCES, SEARCH_COPY_SOURCES, SEARCH_SOURCE_GROUPS, SEARCH_SOURCE_INFO, SEARCH_KEY_SECRETS, SEARCH_SOURCE_TEST_WORDS, SEARCH_SOURCE_TEST_DOI, SEARCH_TEST_TEXT, SEARCH_SETTINGS_TEXT, searchEmailRefusal, isSearchApiKeyShape, type SearchSourcesResponse, type SearchRecordRow } from "../index.js";

describe("declarations shared by the service and the interface (Task 47)", () => {
  it("the service's error codes, each once", () => {
    expect(new Set(SERVICE_ERROR_CODES).size).toBe(SERVICE_ERROR_CODES.length);
    for (const c of ["VALIDATION", "PROJECT_LOCKED", "ACKNOWLEDGEMENT_REQUIRED", "TOOL_NOT_INSTALLED", "TOOL_FAILED", "MOVE_IN_PROGRESS"]) expect(SERVICE_ERROR_CODES).toContain(c);
  });

  it("capture: browsers, profile content types, item statuses and the links limit", () => {
    expect([...CAPTURE_BROWSERS]).toEqual(["chrome", "firefox", "safari", "edge", "brave"]);
    expect([...CAPTURE_CONTENT_TYPES]).toEqual(["posts", "reels", "videos", "shorts", "highlights"]);
    expect([...CAPTURE_ITEM_STATUSES]).toEqual(["created", "duplicate", "refreshed", "incomplete", "failed", "needs-review"]);
    expect(CAPTURE_LINKS_MAX).toBe(500);
  });

  it("review: the decisions an import entry takes", () => {
    expect([...REVIEW_DECISION_ACTIONS]).toEqual(["accept", "accept-candidate", "merge", "skip", "keep-both"]);
  });

  it("annotations: the colour names and the limits (the library package checks them against the model)", () => {
    expect([...HIGHLIGHT_COLOUR_NAMES]).toEqual(["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"]);
    expect([ANNOTATION_NOTE_MAX_CHARS, ANNOTATION_QUOTE_MAX_CHARS, ANNOTATION_ANCHORS_MAX, ANNOTATION_RECTS_MAX, SOURCE_ANNOTATIONS_MAX, SOURCE_ANNOTATION_TEXT_MAX]).toEqual([65536, 65536, 50, 1000, 10000, 16777216]);
  });

  it("watched folders: the file kinds", () => {
    expect([...WATCH_FILE_KINDS]).toEqual(["not-downloaded", "online-only-document", "not-supported", "could-not-import", "not-permitted", "could-not-download", "removed-here"]);
    expect([...WATCHED_FILE_LIST_KINDS]).toEqual([...WATCH_FILE_KINDS, "changed", "gone"]);
    expect(WATCHED_FILES_LIMIT_MAX).toBe(200);
    expect([...WATCHED_FILE_ACTION_DONE]).toEqual(["attached", "settled", "already-there"]);
  });

  it("watched folders: a source's origin says whether the new version is on this computer as one of three words (R251)", () => {
    expect([...WATCHED_FILE_PRESENCES]).toEqual(["local", "not-downloaded", "unknown"]);
    const o: WatchedSourceOrigin = { watchId: "w", folderLabel: "F", folderRemoved: false, file: "a.pdf", state: "changed", presence: "unknown" };
    // The old boolean hint is gone: it could not say "the app cannot tell".
    // @ts-expect-error `local` is no longer a field of the origin
    const old: WatchedSourceOrigin = { ...o, local: true };
    expect(WATCHED_FILE_PRESENCES).toContain(o.presence);
    expect(old.presence).toBe("unknown");
  });

  it("Zotero sync: the intervals offered (Task Z8)", () => {
    expect([...ZOTERO_SYNC_EVERY_MINUTES]).toEqual([30, 60, 240]);
  });

  it("Zotero sync: the state says when the settings were written by a newer version, with its sentence (R268 M4)", () => {
    const st: Pick<ZoteroSyncStateResponse, "readOnly" | "settingsNewer"> = { readOnly: false, settingsNewer: true };
    expect(st.settingsNewer).toBe(true);
    expect(ZOTERO_SYNC_SENTENCES.settingsNewer).toBe("These sync settings were written by a newer version of the app. Update the app to change them.");
  });

  it("Zotero sync: a settings link may say resume: true, and nothing else (R265, D26)", () => {
    type Link = ZoteroSyncSettingsRequest["links"][number];
    // Only `true` or absent, checked by the compiler (pnpm -r typecheck covers this file).
    const resumed: Link = { ref: "user:42", projectId: "p", structure: "collections", duplicates: "merge", resume: true };
    const plain: Link = { ref: "group:9", projectId: "p", structure: "none", duplicates: "skip" };
    // @ts-expect-error a resume of false is not part of the request
    const wrong: Link = { ...plain, resume: false };
    const req: ZoteroSyncSettingsRequest = { automatic: false, everyMinutes: 60, links: [resumed, plain] };
    expect(req.links.map((l) => l.resume)).toEqual([true, undefined]);
    expect(wrong.resume).toBe(false);
  });

  it("find and acquire: states, every reason code and every stop code has its one sentence, and the bounds", () => {
    expect(FIND_STATES).toHaveLength(15);
    expect([...FIND_REASON_CODES]).toEqual([
      "not-allowed",
      "no-legal-basis",
      "switched-off",
      "unreachable",
      "locked",
      "queue-full",
      "budget",
      "unexpected",
      "people-unavailable",
      // F12 (R297 a): the only record source switched on needs a key.
      "needs-key",
      // Task F11: the free copy.
      "copy-not-allowed",
      "held-full",
      "not-this-file",
      "file-other-doi",
      "file-title-absent",
      "file-no-text",
      "file-other-version",
      "file-other-kind",
      // R296 b: the check found the file looks right (advice; the file still waits for the researcher).
      "file-looks-right",
      // R282 e–g: some free-copy services could not be reached; the record removed; the rules' store part refused.
      "copy-some-unreachable",
      "record-removed",
      "copy-store-not-allowed",
      "copy-no-legal-basis",
      // F15 (R324 b): found waiting in the sign-in window at start-up with nothing kept to return to.
      "library-unfinished",
    ]);
    expect(FIND_REASON_TEXT["copy-some-unreachable"]).toBe("Some services could not be reached, so a free copy may still exist. “Try again” looks again.");
    expect(FIND_REASON_TEXT["record-removed"]).toBe("The record was removed from the library.");
    // Exhaustive by type (Record<FindReasonCode, string>) and checked here at run time: one plain sentence each.
    expect(Object.keys(FIND_REASON_TEXT).sort()).toEqual([...FIND_REASON_CODES].sort());
    // One plain sentence each (the plan's sentence for held files starts with its number).
    for (const c of FIND_REASON_CODES) expect(FIND_REASON_TEXT[c]).toMatch(/^[A-Z0-9].*\.$/);
    expect(FIND_REASON_TEXT["not-allowed"]).toBe("This project's rules do not allow this.");
    expect(FIND_REASON_TEXT["switched-off"]).toBe("Switched off in Search sources.");
    expect(FIND_REASON_TEXT.unreachable).toBe("The search services could not be reached. Try again later.");
    expect(FIND_REASON_TEXT.locked).toBe("The project is locked. Unlock it, and the queue goes on.");
    expect(FIND_REASON_TEXT["queue-full"]).toBe("The queue holds 500 entries. Remove some finished ones first.");
    expect(FIND_REASON_TEXT.budget).toBe("OpenAlex's free daily allowance is used up; searching Crossref only until tomorrow.");
    expect(FIND_REASON_TEXT.unexpected).toBe("Something went wrong while looking this up. Try again.");
    // F11: the rules' refusal in words (never the raw method name); the plan's sentence for 20 held files.
    expect(FIND_REASON_TEXT["copy-not-allowed"]).toBe("This project's rules do not allow fetching free copies of works.");
    expect(FIND_REASON_TEXT["copy-not-allowed"]).not.toContain("free_copy");
    // R296 d: at most 50 files wait; an entry that finds the limit reached waits too, and says so (built from the bound).
    expect(FIND_HELD_MAX).toBe(50);
    expect(FIND_REASON_TEXT["held-full"]).toBe("50 files are already waiting for your check. This one goes on by itself when you have decided on some of them.");
    // R296 b: the queue entry of a file the check found to look right.
    expect(FIND_REASON_TEXT["file-looks-right"]).toBe("This looks like the right file. Check it, then use it.");
    expect(FIND_REASON_TEXT["not-this-file"]).toBe("You said the file found was not this work.");
    expect(FIND_REASON_TEXT["no-legal-basis"]).toBe("This project's rules need a legal basis for records made from typed references. Record one in the project's Governance settings.");
    expect(Object.keys(FIND_STOPPED_TEXT).sort()).toEqual([...FIND_STOPPED_CODES].sort());
    for (const c of FIND_STOPPED_CODES) expect(FIND_STOPPED_TEXT[c]).toMatch(/^[A-Z].*\.$/);
    expect(FIND_ROUTE_TEXT.readOnly).toBe("This library is open read-only, so nothing can be added.");
    expect(findLineRefusal(7)).toContain("Line 7");
    expect([FIND_ADD_LINES_MAX, FIND_LINE_MIN_CHARS, FIND_LINE_MAX_CHARS, FIND_BODY_MAX_BYTES, FIND_QUEUE_MAX, FIND_CANDIDATES_SENT]).toEqual([50, 2, 500, 65536, 500, 10]);
  });

  it("find and acquire, an author alone (F8, R267): the bounds, the sentences and the refusals, none repeating what was typed", () => {
    expect([FIND_PEOPLE_MAX, FIND_PERSON_WORKS_MAX, FIND_CHOOSE_WORKS_MAX]).toEqual([20, 200, 50]);
    expect(FIND_MORE_PEOPLE_TEXT).toBe("More people have this name; add a word from a title to narrow it");
    expect(FIND_MORE_WORKS_TEXT).toMatch(/^[A-Z].*\.$/);
    for (const r of ["unknown-person", "unknown-work", "already-added", "person-id", "work-ids"] as const) expect(FIND_REFUSAL_REASONS).toContain(r);
    for (const k of ["unknownPerson", "unknownWork", "noWorks", "tooManyWorks", "personId"] as const) expect(FIND_ROUTE_TEXT[k]).toMatch(/^[A-Z].*\.$/);
    expect(FIND_ROUTE_TEXT.tooManyWorks).toBe("At most 50 works can be added at once. Nothing was added.");
    expect(findAlreadyAddedRefusal(3)).toBe("Work 3 was already added from this entry. Nothing was added.");
    expect(findWorkIdRefusal(2)).toBe("Work 2 is not a work's id that OpenAlex gives. Nothing was added.");
  });

  it("find and acquire, a name that is also a title (F8b, R279): the author offer is counts only, and its refusal has its sentence", () => {
    expect(FIND_REFUSAL_REASONS).toContain("no-author");
    expect(FIND_ROUTE_TEXT.noAuthor).toBe("This entry has no author to show.");
    // R285 b: the sentence for a request that carries a body is a shared route sentence.
    expect(FIND_ROUTE_TEXT.noBody).toBe("This request takes no body. Nothing was changed.");
    // R283 a: people of the name could not be looked up; "Try again" looks again.
    expect(FIND_REASON_CODES).toContain("people-unavailable");
    expect(FIND_REASON_TEXT["people-unavailable"]).toBe("People of this name could not be looked up just now. “Try again” looks again.");
    const offer: FindAuthorOffer = { peopleCount: 2 };
    const view: Pick<FindEntryView, "authorOffer"> = { authorOffer: { ...offer, morePeople: true } };
    expect(view.authorOffer).toEqual({ peopleCount: 2, morePeople: true });
    // @ts-expect-error the offer carries counts, never a list of people
    const wrong: FindAuthorOffer = { peopleCount: 1, people: [] };
    expect(wrong.peopleCount).toBe(1);
  });

  it("F12 round 2 (R297 a, R298 a): the reason for a source switched on alone without its key; Elicit cannot be moved", () => {
    expect(FIND_REASON_CODES).toContain("needs-key");
    expect(FIND_REASON_TEXT["needs-key"]).toBe("The only search source switched on needs a key, and none is available. Add it in Search sources, then try again.");
    expect(FIND_REASON_TEXT["needs-key"]).not.toBe(FIND_REASON_TEXT["switched-off"]);
    // The screen offers "Move up" / "Move down" only for a source that can be moved: Elicit is always last.
    expect(Object.fromEntries(SEARCH_RECORD_SOURCES.map((id) => [id, SEARCH_SOURCE_INFO.record[id].movable]))).toEqual({ crossref: true, openalex: true, elicit: false });
    expect(SEARCH_RECORD_SOURCES[SEARCH_RECORD_SOURCES.length - 1]).toBe("elicit");
  });

  it("search sources (F12, R290): the sources shown, the fixed question, and every sentence declared once", () => {
    expect([...SEARCH_RECORD_SOURCES]).toEqual(["crossref", "openalex", "elicit"]);
    expect([...SEARCH_COPY_SOURCES]).toEqual(["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"]);
    expect([...SEARCH_SOURCE_GROUPS]).toEqual(["record", "copies"]);
    expect(Object.keys(SEARCH_SOURCE_INFO.record).sort()).toEqual([...SEARCH_RECORD_SOURCES].sort());
    expect(Object.keys(SEARCH_SOURCE_INFO.copies).sort()).toEqual([...SEARCH_COPY_SOURCES].sort());
    expect(SEARCH_KEY_SECRETS).toEqual({ elicit: "elicit-api-key", openalex: "openalex-api-key" });
    expect([SEARCH_SOURCE_TEST_WORDS, SEARCH_SOURCE_TEST_DOI]).toEqual(["Distinction Bourdieu", "10.1038/171737a0"]);
    // The plan's Accept 3 and 4, word for word.
    expect(SEARCH_TEST_TEXT.answered).toBe("Answered");
    expect(SEARCH_TEST_TEXT.unreachable).toBe("Could not be reached");
    expect(SEARCH_TEST_TEXT.keyRefused).toBe("Did not accept the key");
    expect(SEARCH_TEST_TEXT.needsElicitKey).toBe("Needs your Elicit API key (Pro plan or higher)");
    expect(SEARCH_TEST_TEXT.elicitPlanCap).toBe("Your Elicit plan does not allow this many results");
    expect(SEARCH_SETTINGS_TEXT.elicitKeyRefused).toBe("Elicit did not accept the key");
    // Every sentence once: no two keys carry the same words.
    const all = [...Object.values(SEARCH_TEST_TEXT), ...Object.values(SEARCH_SETTINGS_TEXT)];
    expect(new Set(all).size).toBe(all.length);
    expect(searchEmailRefusal("crossrefEmail")).toBe('"crossrefEmail" is not an e-mail address. Nothing was changed.');
    expect(isSearchApiKeyShape("elk-made-up-0001")).toBe(true);
    for (const bad of ["short", "has a space here", "line\nbreak-0001", "x".repeat(257), 42]) expect(isSearchApiKeyShape(bad)).toBe(false);
    const view: SearchSourcesResponse = { record: [{ id: "elicit", on: false, allowedByRules: false }], copies: [] };
    expect(view.record[0]!.id).toBe("elicit");
    // @ts-expect-error Open Library is not a source the screen shows
    const wrongRow: SearchRecordRow = { id: "openlibrary", on: true };
    expect(wrongRow.on).toBe(true);
  });

  it("Your library (F15, R324): the sentences, the bounds, and the refusals' reasons", () => {
    expect(yourLibraryAddressSentence("ezproxy.lib.example.edu", "ezproxy-login")).toBe("Your library's address: ezproxy.lib.example.edu (EZproxy)");
    expect(yourLibraryAddressSentence("go.openathens.net", "openathens")).toBe("Your library's address: go.openathens.net (OpenAthens)");
    expect(yourLibraryAddressSentence("r.example.edu", "openurl")).toBe("Your library's address: r.example.edu (link resolver)");
    expect(libraryReadyIn(12)).toBe("Ready in 12 seconds.");
    expect(libraryReadyIn(1)).toBe("Ready in 1 second.");
    expect(FIND_LIBRARY_TEXT.heldFull).toBe("50 files are already waiting for your check. Decide on some of them, then try again.");
    // R328 b: the resolver's sentence names host and path; a session's key in a link's path is refused in words.
    expect(yourLibraryAddressSentence("r.example.edu/openurl", "openurl")).toBe("Your library's address: r.example.edu/openurl (link resolver)");
    expect(YOUR_LIBRARY_DERIVE_TEXT["session-key"]).toBe("That link holds what looks like a session's key in its address. Paste the link of your library's own search page instead.");
    expect(YOUR_LIBRARY_DERIVE_TEXT["not-library"]).toBe("That link does not go through a library. Paste one you reached by signing in through your library.");
    expect(Object.keys(YOUR_LIBRARY_DERIVE_TEXT).sort()).toEqual([...YOUR_LIBRARY_DERIVE_REFUSALS].sort());
    for (const t of [...Object.values(YOUR_LIBRARY_DERIVE_TEXT), ...Object.values(YOUR_LIBRARY_TEXT), ...Object.values(FIND_LIBRARY_TEXT)]) expect(t).toMatch(/^[A-Z0-9“].*\.$/u);
    for (const r of ["library-not-offered", "no-library", "library-busy", "library-pause", "library-held-full"]) expect(FIND_REFUSAL_REASONS).toContain(r);
    expect([LIBRARY_PAUSE_MS, LIBRARY_TICKET_MS, YOUR_LIBRARY_LINK_MAX, YOUR_LIBRARY_NAME_MAX, WHERE_TO_GET_IT_MAX, WHERE_TO_GET_IT_URL_MAX]).toEqual([20_000, 1_800_000, 4096, 200, 12, 2048]);
    const chance: FindEntryView["library"] = { canStart: false, reason: "no-library" };
    expect(chance.canStart).toBe(false);
  });

  it("Your library's Test (F18a, R334 b): one fixed, well-known work — the Search sources' tests' own — and its sentence", () => {
    expect(YOUR_LIBRARY_TEST_DOI).toBe("10.1038/171737a0");
    expect(YOUR_LIBRARY_TEST_DOI).toBe(SEARCH_SOURCE_TEST_DOI);
    expect(YOUR_LIBRARY_TEXT.testNoAddress).toBe("No address for the test could be made from your library's settings. Use “Work out the address” again, then save.");
    // R336 i: the settings' answers name the stored address in the derive's own words.
    const answer: YourLibraryResponse = { name: "", access: { kind: "ezproxy-login", base: "https://ezproxy.lib.example.edu/login?url=" }, staySignedIn: false, addressSentence: yourLibraryAddressSentence("ezproxy.lib.example.edu", "ezproxy-login") };
    expect(answer.addressSentence).toBe("Your library's address: ezproxy.lib.example.edu (EZproxy)");
    const r: YourLibraryTestResponse = { url: "https://ezproxy.lib.example.edu/login?url=https://doi.org/10.1038/171737a0" };
    expect(Object.keys(r)).toEqual(["url"]);
  });
});
