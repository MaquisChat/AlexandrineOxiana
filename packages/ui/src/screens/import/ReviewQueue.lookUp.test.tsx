/**
 * Decision 31 (c), "Look up again" (R566 8, R577 4): the detail of an import entry whose lookups were left out.
 *  - The button: ready ("Look up again"), off before the service's named time ("Look up again (after {time})", the time
 *    in the researcher's own time zone and format), and busy while it runs ("Looking this up again…", aria-busy, focus
 *    kept). Its place in the Tab order: after the entry's reasons, before the candidates' accept buttons.
 *  - Under the matches, where none is listed: "Not looked up yet: …" while nothing was asked, "Not looked up: …" for a
 *    lookup that failed outright, and "No candidate matches were found." only where a look-up was made and found nothing.
 *  - After "found": the new matches are listed after the earlier ones, and each is accepted by its position.
 *  - A read-only library and a locked project: not offered (no entry is shown at all).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT, lookUpAgainAfter, lookUpGaveUpText, type ReviewLookUpAgainResponse } from "@ao/shared";
import type { Candidate, ReviewItem } from "../../api/import";
import { BASE as SERVICE, mockService, P1, server, type ServiceSetup } from "../../test/importService";
import { DECIDE_SETTLE_MS, ReviewQueue } from "./ReviewQueue";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let travel = 0;
const settle = () => new Promise((r) => setTimeout(r, DECIDE_SETTLE_MS + 20));
/** A real mouse press on a panel control (the pointer travels onto it first; see ProjectReviewQueue.test.tsx). */
const pressPanel = async (user: ReturnType<typeof userEvent.setup>, el: Element) => {
  travel += 10;
  await user.pointer([
    { target: document.body, coords: { clientX: travel, clientY: travel } },
    { target: el, coords: { clientX: travel + 3, clientY: travel + 2 } },
    { keys: "[MouseLeft]", target: el },
  ]);
};

const UNIDENTIFIED = "The item could not be identified with enough confidence.";
const match = (title: string, provider = "openalex"): Candidate => ({ title, creators: [{ family: "Souza", given: "Ana", role: "author" }], type: "article-journal", provider });
/** The researcher's own time zone and format, as the page writes the service's named time. */
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const entry = (extra: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "r1",
  projectId: P1,
  sourceId: "s1",
  kind: "import",
  group: "attach",
  status: "pending",
  createdAt: "2026-11-25T10:00:00.000Z",
  fields: {},
  reasons: [LOOKUP_WAITING_TEXT, UNIDENTIFIED],
  title: "Tide-line notes",
  ...extra,
});
/** An entry of the test's own as the route's answer carries it. */
const asEntry = (i: ReviewItem) => i as unknown as ReviewLookUpAgainResponse["entry"];
const record = {
  source: { id: "s1", type: "document", title: { variants: [{ lang: "en", kind: "original", value: "Tide-line notes" }] }, creators: [], collectionIds: [], tagIds: [], provenance: {} },
  assets: [],
  fieldEvidence: [],
  fields: [],
};

/** Every body the look-up route received, in order (the route below is the test's own, so it records them itself). */
let lookUpBodies: unknown[] = [];
/** The route as routes/review.ts answers it; `held` keeps the answer back until released. */
function lookUpRoute(answer: ReviewLookUpAgainResponse | ((n: number) => ReviewLookUpAgainResponse), held?: Promise<void>) {
  let n = 0;
  return http.post(`${SERVICE}/review/:itemId/look-up-again`, async ({ request, params }) => {
    n++;
    lookUpBodies.push({ itemId: params.itemId, body: await request.json() });
    if (held) await held;
    return HttpResponse.json(typeof answer === "function" ? answer(n) : answer);
  });
}

function setup(item: ReviewItem, extra: ServiceSetup["extra"] = [], o: Partial<ServiceSetup> = {}) {
  lookUpBodies = [];
  const m = mockService({ batches: [], projectReview: { [P1]: [item] }, sources: { s1: record }, extra, ...o });
  const user = userEvent.setup();
  render(<ReviewQueue client={m.client} projectId={P1} />);
  return { m, user };
}
async function openEntry(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Show Tide-line notes" }));
  const panel = await screen.findByRole("region", { name: "Imported record" });
  await within(panel).findByRole("heading", { name: "Tide-line notes" });
}
const matches = () => screen.getByRole("region", { name: "Candidate matches" });
const lookUpButton = () => screen.queryByRole("button", { name: /^Look(ing)? (up|this up) again/ });

describe("the button (R577 i, iii)", () => {
  it("ready: \"Look up again\", in the Tab order after the entry's reasons and before the candidates' accept buttons", async () => {
    const item = entry({ reasons: [UNIDENTIFIED], candidates: [match("Rivers and memory")], lookUp: { state: "failed", tries: 0, canLookUpNow: true } });
    const { user } = setup(item);
    await openEntry(user);
    const b = await screen.findByRole("button", { name: "Look up again" });
    expect(b.textContent).toBe(LOOK_UP_AGAIN_TEXT.act);
    expect(b.getAttribute("aria-disabled")).toBeNull();
    // After the reasons …
    const why = screen.getByRole("region", { name: "Why it needs review" });
    const reasons = within(why).getByRole("list");
    expect(reasons.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // … and before the first candidate's accept button, with nothing focusable between them.
    const use = within(matches()).getByRole("button", { name: /^Use this match/ });
    b.focus();
    await user.tab();
    expect(document.activeElement).toBe(use);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(b);
  });

  it('off before the service\'s named time: "Look up again (after {time})", in the researcher\'s own time zone and format; a press sends nothing', async () => {
    const notBefore = new Date(Date.now() + 60 * 60_000).toISOString();
    const item = entry({ lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore } });
    const { m, user } = setup(item, [lookUpRoute({ outcome: { kind: "nothing" }, entry: asEntry(item) })]);
    await openEntry(user);
    const b = await screen.findByRole("button", { name: lookUpAgainAfter(when(notBefore)) });
    expect(b.textContent).toBe(`Look up again (after ${when(notBefore)})`);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    await user.click(b);
    b.focus();
    await user.keyboard("{Enter}");
    expect(lookUpBodies).toEqual([]);
    void m;
  });

  it("off until the time comes, then ready by itself", async () => {
    const notBefore = new Date(Date.now() + 300).toISOString();
    const { user } = setup(entry({ lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore } }));
    await openEntry(user);
    expect((await screen.findByRole("button", { name: lookUpAgainAfter(when(notBefore)) })).getAttribute("aria-disabled")).toBe("true");
    const b = await screen.findByRole("button", { name: "Look up again" }, { timeout: 3000 });
    expect(b.getAttribute("aria-disabled")).toBeNull();
  });

  it('busy while it runs: "Looking this up again…", aria-busy, the button off, focus kept; then the entry as answered', async () => {
    const before = entry({ reasons: [UNIDENTIFIED], lookUp: { state: "failed", tries: 0, canLookUpNow: true } });
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const after = entry({ reasons: [LOOKUP_WAITING_TEXT, UNIDENTIFIED], lookUp: { state: "waiting", tries: 1, canLookUpNow: false, notBefore: later } });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    const { m, user } = setup(before, [lookUpRoute({ outcome: { kind: "asked-to-wait", notBefore: later }, entry: asEntry(after) }, held)]);
    await openEntry(user);
    const b = await screen.findByRole("button", { name: "Look up again" });
    b.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: LOOK_UP_AGAIN_TEXT.looking });
    expect(b.textContent).toBe("Looking this up again…");
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(b);
    // The entry's decisions wait too (the usual busy state).
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
    // A second press while it runs sends nothing more.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lookUpBodies).toEqual([{ itemId: "r1", body: { projectId: P1 } }]));
    await act(async () => release());
    const off = await screen.findByRole("button", { name: lookUpAgainAfter(when(later)) });
    expect(off).toBe(b);
    expect(off.getAttribute("aria-busy")).toBeNull();
    expect(document.activeElement).toBe(off);
    // The entry as answered: its reasons (the service's sentences) and the sentence under the matches.
    const why = screen.getByRole("region", { name: "Why it needs review" });
    expect(within(why).getAllByRole("listitem").map((li) => li.textContent)).toEqual([LOOKUP_WAITING_TEXT, UNIDENTIFIED]);
    expect(within(matches()).getByText(LOOK_UP_AGAIN_TEXT.notLookedUpYet)).toBeTruthy();
    expect(lookUpBodies).toHaveLength(1);
  });

  it('"not yet" from the service: the button is off with the time the service gave', async () => {
    const item = entry({ reasons: [UNIDENTIFIED], lookUp: { state: "failed", tries: 0, canLookUpNow: true } });
    const later = new Date(Date.now() + 30 * 60_000).toISOString();
    const { user } = setup(item, [lookUpRoute({ outcome: { kind: "not-yet", notBefore: later }, entry: { ...item, lookUp: { state: "failed", tries: 0, canLookUpNow: false, notBefore: later } } as ReviewLookUpAgainResponse["entry"] })]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    expect((await screen.findByRole("button", { name: lookUpAgainAfter(when(later)) })).getAttribute("aria-disabled")).toBe("true");
    // Said in the screen's polite region too.
    await waitFor(() => expect(screen.getAllByRole("status").some((r) => r.textContent?.includes(lookUpAgainAfter(when(later))))).toBe(true));
  });
});

describe("a look-up already under way (R585 3)", () => {
  it('keeps "Looking this up again…" with no second press until the queue lists the entry changed, then shows it', async () => {
    const before = entry({ reasons: [UNIDENTIFIED], lookUp: { state: "failed", tries: 0, canLookUpNow: true } });
    const after = entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], lookUp: { state: "nothing", tries: 0, canLookUpNow: false } });
    let reads = 0;
    const queueRead = http.get(`${SERVICE}/projects/:id/review`, () => {
      reads++;
      // The opening's read, then one read still the same, then the entry as the other look-up left it.
      const item = reads <= 2 ? before : after;
      return HttpResponse.json({ items: [item], total: 1, offset: 0, limit: 500 });
    });
    const { user } = setup(before, [queueRead, lookUpRoute({ outcome: { kind: "under-way" }, entry: asEntry(before) })]);
    await openEntry(user);
    const b = await screen.findByRole("button", { name: "Look up again" });
    b.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lookUpBodies).toHaveLength(1));
    // Answered "under way": still busy, and a press sends nothing more.
    expect(b.textContent).toBe(LOOK_UP_AGAIN_TEXT.looking);
    expect(b.getAttribute("aria-busy")).toBe("true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(b.textContent).toBe(LOOK_UP_AGAIN_TEXT.looking);
    await waitFor(() => expect(within(matches()).getByText("No candidate matches were found.")).toBeTruthy(), { timeout: 4000 });
    expect(lookUpButton()).toBeNull();
    expect(lookUpBodies).toHaveLength(1);
    const why = screen.getByRole("region", { name: "Why it needs review" });
    expect(within(why).getAllByRole("listitem").map((li) => li.textContent)).toEqual([LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED]);
  });
});

describe("under the matches, where none is listed (R566 8)", () => {
  it('while nothing was asked yet: "Not looked up yet: the lookup service asked to wait." — never "No candidate matches were found."', async () => {
    const { user } = setup(entry({ lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore: new Date(Date.now() + 60_000).toISOString() } }));
    await openEntry(user);
    expect(within(matches()).getByText("Not looked up yet: the lookup service asked to wait.")).toBeTruthy();
    expect(within(matches()).queryByText("No candidate matches were found.")).toBeNull();
  });

  it('a lookup that failed outright: "Not looked up: a lookup service could not be reached. You can use Look up again."', async () => {
    const { user } = setup(entry({ reasons: [UNIDENTIFIED], lookUp: { state: "failed", tries: 0, canLookUpNow: true } }));
    await openEntry(user);
    expect(within(matches()).getByText("Not looked up: a lookup service could not be reached. You can use Look up again.")).toBeTruthy();
    expect(within(matches()).queryByText("No candidate matches were found.")).toBeNull();
    expect(within(matches()).queryByText(LOOK_UP_AGAIN_TEXT.notLookedUpYet)).toBeNull();
  });

  it('only where a look-up was made and found nothing: "No candidate matches were found."', async () => {
    const { user } = setup(entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], lookUp: { state: "nothing", tries: 1, canLookUpNow: false } }));
    await openEntry(user);
    expect(within(matches()).getByText("No candidate matches were found.")).toBeTruthy();
    expect(within(matches()).queryByText(LOOK_UP_AGAIN_TEXT.notLookedUpYet)).toBeNull();
    expect(within(matches()).queryByText(LOOK_UP_AGAIN_TEXT.notLookedUpFailed)).toBeNull();
    // Nothing is left to look up: the button is not offered.
    expect(lookUpButton()).toBeNull();
    const why = screen.getByRole("region", { name: "Why it needs review" });
    expect(within(why).getAllByRole("listitem")[0]!.textContent).toBe(LOOK_UP_AGAIN_TEXT.nothing);
  });

  it("an entry with nothing left out says it as before, and offers no look-up", async () => {
    const { user } = setup(entry({ reasons: [UNIDENTIFIED] }));
    await openEntry(user);
    expect(within(matches()).getByText("No candidate matches were found.")).toBeTruthy();
    expect(lookUpButton()).toBeNull();
  });
});

describe("after \"found\" (R566 1, R577 ii)", () => {
  it("the new matches are listed after the earlier ones, each accepted by its position in the service's answer", async () => {
    const first = match("Rivers and memory", "crossref");
    const before = entry({ candidates: [first], lookUp: { state: "waiting", tries: 0, canLookUpNow: true, notBefore: "2026-11-25T10:01:00.000Z" } });
    const answered: ReviewLookUpAgainResponse = {
      outcome: { kind: "found", found: 2 },
      entry: {
        ...before,
        status: "pending",
        reasons: [LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, UNIDENTIFIED],
        candidates: [first, match("Notes from the tide-line interviews"), match("Tide-line interviews, revisited")],
        lookUp: { state: "found", tries: 1, canLookUpNow: false },
      } as ReviewLookUpAgainResponse["entry"],
    };
    const { m, user } = setup(before, [lookUpRoute(answered)]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await waitFor(() => expect(within(matches()).getAllByRole("listitem")).toHaveLength(3));
    expect(lookUpBodies).toEqual([{ itemId: "r1", body: { projectId: P1 } }]);
    const rows = within(matches()).getAllByRole("listitem");
    expect(rows.map((li) => within(li).getAllByText(/./)[0]!.textContent)).toEqual(["Rivers and memory", "Notes from the tide-line interviews", "Tide-line interviews, revisited"]);
    // The reasons carry the service's sentences, the identifier's sentence with them.
    const why = screen.getByRole("region", { name: "Why it needs review" });
    expect(within(why).getAllByRole("listitem").map((li) => li.textContent)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOK_UP_AGAIN_TEXT.fromFile, UNIDENTIFIED]);
    // Nothing is left to look up: the button is gone, and focus is on the matches' heading (never lost to the page).
    expect(lookUpButton()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(matches()).getByRole("heading", { name: "Candidate matches" })));
    // The third shown is the third of the answer.
    await settle();
    await pressPanel(user, within(rows[2]!).getByRole("button", { name: /^Use this match/ }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "accept-candidate", index: 2 } }]));
    expect((answered.entry.candidates![2] as Candidate).title).toBe("Tide-line interviews, revisited");
  });
});

describe("not offered where nothing may be changed", () => {
  it("a read-only library: no entry is shown, so no look-up is offered", async () => {
    const readOnly = http.get(`${SERVICE}/projects/:id/review`, () => HttpResponse.json({ error: { code: "READ_ONLY", message: "This library is open read-only, so nothing can be changed." } }, { status: 409 }));
    setup(entry({ lookUp: { state: "failed", tries: 0, canLookUpNow: true } }), [readOnly]);
    expect(await screen.findByText(/This library is open read-only/)).toBeTruthy();
    expect(lookUpButton()).toBeNull();
  });

  it("a locked project: nothing of its entries is shown, so no look-up is offered", async () => {
    setup(entry({ lookUp: { state: "failed", tries: 0, canLookUpNow: true } }), [], { locked: [P1] });
    await screen.findByLabelText(/passphrase/i);
    expect(lookUpButton()).toBeNull();
  });

  it("locked while it ran: the queue is forgotten and the unlock form shown", async () => {
    const locked = http.post(`${SERVICE}/review/:itemId/look-up-again`, () => HttpResponse.json({ error: { code: "PROJECT_LOCKED", message: "This project is locked. Its passphrase is needed." } }, { status: 423 }));
    const { user } = setup(entry({ reasons: [UNIDENTIFIED], lookUp: { state: "failed", tries: 0, canLookUpNow: true } }), [locked]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await screen.findByLabelText(/passphrase/i);
    expect(screen.queryByText("Tide-line notes")).toBeNull();
  });
});

describe("joined to the fixed engine (R592)", () => {
  it("point 2 (R585 point 5): an entry whose kept time only a wrong clock could have written is offered NOW — the button's time is only the service's", async () => {
    // What the service now sends for such an entry (its `lookUpNow`): may send now, no time. The page has no other time.
    const item = entry({ lookUp: { state: "waiting", tries: 0, canLookUpNow: true } });
    const answered = entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], lookUp: { state: "nothing", tries: 0, canLookUpNow: false } });
    const { user } = setup(item, [lookUpRoute({ outcome: { kind: "nothing" }, entry: asEntry(answered) })]);
    await openEntry(user);
    const b = await screen.findByRole("button", { name: "Look up again" });
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByRole("button", { name: /\(after / })).toBeNull();
    await user.click(b);
    await waitFor(() => expect(lookUpBodies).toEqual([{ itemId: "r1", body: { projectId: P1 } }]));
  });
});

describe("every true sentence in a mix (R585 M3, R592 point 4)", () => {
  const said = () => screen.getAllByRole("status").map((r) => r.textContent ?? "");
  const reasonsShown = () => within(screen.getByRole("region", { name: "Why it needs review" })).getAllByRole("listitem").map((li) => li.textContent);

  it("one lookup answered with matches and another still waiting: both sentences, each once, and the button; the answer says both", async () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const reasons = [LOOK_UP_AGAIN_TEXT.found, LOOKUP_WAITING_TEXT, UNIDENTIFIED];
    const item = entry({ reasons, candidates: [match("Rivers and memory")], lookUp: { state: "waiting", tries: 0, canLookUpNow: true, also: ["found"] } });
    const after = entry({ reasons, candidates: [match("Rivers and memory")], lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore: later, also: ["found"] } });
    const { user } = setup(item, [lookUpRoute({ outcome: { kind: "asked-to-wait", notBefore: later }, entry: asEntry(after) })]);
    await openEntry(user);
    expect(reasonsShown()).toEqual(reasons);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await screen.findByRole("button", { name: lookUpAgainAfter(when(later)) });
    expect(reasonsShown()).toEqual(reasons);
    // The main state's sentence, then each further state's, each once.
    await waitFor(() => expect(said()).toContain(`${LOOKUP_WAITING_TEXT} ${LOOK_UP_AGAIN_TEXT.found}`));
  });

  it('one "gave up" and one "not allowed": both sentences, and the answer says both, the given-up sentence with its own tries', async () => {
    const reasons = [LOOK_UP_AGAIN_TEXT.notAllowed, lookUpGaveUpText(5), UNIDENTIFIED];
    const item = entry({ reasons, lookUp: { state: "gave-up", tries: 5, canLookUpNow: true, also: ["not-allowed"] } });
    const { user } = setup(item, [lookUpRoute({ outcome: { kind: "asked-to-wait" }, entry: asEntry(item) })]);
    await openEntry(user);
    expect(reasonsShown()).toEqual(reasons);
    expect(screen.getByRole("button", { name: "Look up again" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Look up again" }));
    await waitFor(() => expect(said()).toContain(`${lookUpGaveUpText(5)} ${LOOK_UP_AGAIN_TEXT.notAllowed}`));
  });

  it("in a mix, the given-up sentence's {n} is the given-up lookups' own tries (gaveUpTries), not the main state's", async () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const reasons = [LOOKUP_WAITING_TEXT, lookUpGaveUpText(5), UNIDENTIFIED];
    const item = entry({ reasons, lookUp: { state: "waiting", tries: 1, canLookUpNow: true, also: ["gave-up"], gaveUpTries: 5 } });
    const after = entry({ reasons, lookUp: { state: "waiting", tries: 1, canLookUpNow: false, notBefore: later, also: ["gave-up"], gaveUpTries: 5 } });
    const { user } = setup(item, [lookUpRoute({ outcome: { kind: "asked-to-wait", notBefore: later }, entry: asEntry(after) })]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await waitFor(() => expect(said()).toContain(`${LOOKUP_WAITING_TEXT} ${lookUpGaveUpText(5)}`));
  });

  it('R593: a lookup still waiting that also carries a service the rules deny ("waiting" with "not allowed"): both sentences, and the button with its time', async () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const reasons = [LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT.notAllowed, UNIDENTIFIED];
    const { user } = setup(entry({ reasons, lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore: later, also: ["not-allowed"] } }));
    await openEntry(user);
    expect(reasonsShown()).toEqual(reasons);
    const b = await screen.findByRole("button", { name: lookUpAgainAfter(when(later)) });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(within(matches()).getByText(LOOK_UP_AGAIN_TEXT.notLookedUpYet)).toBeTruthy();
    expect(lookUpBodies).toEqual([]);
  });
});

describe("a lookup that failed outright is always said (R600 I3)", () => {
  const FAILED = "Not looked up: a lookup service could not be reached. You can use Look up again.";
  it('{ state: "nothing", failed: true } with no matches: the failed sentence, never "No candidate matches were found."', async () => {
    const { user } = setup(entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], lookUp: { state: "nothing", tries: 0, canLookUpNow: true, failed: true } }));
    await openEntry(user);
    expect(within(matches()).getByText(FAILED)).toBeTruthy();
    expect(within(matches()).queryByText("No candidate matches were found.")).toBeNull();
  });

  it('{ state: "nothing", failed: true } with matches listed: the failed sentence is still said', async () => {
    const { user } = setup(entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], candidates: [match("Rivers and memory")], lookUp: { state: "nothing", tries: 0, canLookUpNow: true, failed: true } }));
    await openEntry(user);
    expect(within(matches()).getByText(FAILED)).toBeTruthy();
    expect(within(matches()).getAllByRole("listitem")).toHaveLength(1);
  });

  it('a pure "failed" state WITH matches listed: the failed sentence is said', async () => {
    const { user } = setup(entry({ reasons: [UNIDENTIFIED], candidates: [match("Rivers and memory")], lookUp: { state: "failed", tries: 0, canLookUpNow: true, failed: true } }));
    await openEntry(user);
    expect(within(matches()).getByText(FAILED)).toBeTruthy();
  });

  it("after a look-up, the failed sentence is announced after the state's sentence", async () => {
    const before = entry({ reasons: [LOOKUP_WAITING_TEXT, UNIDENTIFIED], lookUp: { state: "waiting", tries: 0, canLookUpNow: true, failed: true } });
    const after = entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], lookUp: { state: "nothing", tries: 0, canLookUpNow: true, failed: true } });
    const { user } = setup(before, [lookUpRoute({ outcome: { kind: "nothing" }, entry: asEntry(after) })]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await waitFor(() => expect(screen.getAllByRole("status").map((r) => r.textContent)).toContain(`${LOOK_UP_AGAIN_TEXT.nothing} ${FAILED}`));
    expect(within(matches()).queryByText("No candidate matches were found.")).toBeNull();
  });
});

describe("the busy state covers the entry, not the screen (R600 m2)", () => {
  it("while one entry's look-up runs, another entry's decisions stay usable; the entry looked up stays busy", async () => {
    const one = entry({ reasons: [UNIDENTIFIED], lookUp: { state: "failed", tries: 0, canLookUpNow: true, failed: true } });
    const two = entry({ id: "r2", sourceId: "s2", title: "Salt marsh survey", reasons: [UNIDENTIFIED] });
    const record2 = { ...record, source: { ...record.source, id: "s2", title: { variants: [{ lang: "en", kind: "original", value: "Salt marsh survey" }] } } };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    lookUpBodies = [];
    const m = mockService({ batches: [], projectReview: { [P1]: [one, two] }, sources: { s1: record, s2: record2 }, extra: [lookUpRoute({ outcome: { kind: "nothing" }, entry: asEntry(one) }, held)] });
    const user = userEvent.setup();
    render(<ReviewQueue client={m.client} projectId={P1} />);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await screen.findByRole("button", { name: LOOK_UP_AGAIN_TEXT.looking });
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Show Salt marsh survey" }));
    const panel = await screen.findByRole("region", { name: "Imported record" });
    await within(panel).findByRole("heading", { name: "Salt marsh survey" });
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Keep both" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(lookUpBodies).toHaveLength(1));
  });
});

describe('the "under way" re-reading (R600 m3)', () => {
  const before = entry({ reasons: [LOOKUP_WAITING_TEXT, UNIDENTIFIED], lookUp: { state: "waiting", tries: 0, canLookUpNow: true } });
  const later = () => new Date(Date.now() + 60 * 60_000).toISOString();
  /** The queue read: the opening's read, then `next(n)` for the n-th re-read (1-based). */
  function reads(next: (n: number) => ReviewItem) {
    const log = { n: 0 };
    const route = http.get(`${SERVICE}/projects/:id/review`, () => {
      log.n++;
      return HttpResponse.json({ items: [log.n === 1 ? before : next(log.n - 1)], total: 1, offset: 0, limit: 500 });
    });
    return { log, route };
  }
  function render2(extra: ServiceSetup["extra"]) {
    lookUpBodies = [];
    const m = mockService({ batches: [], projectReview: { [P1]: [before] }, sources: { s1: record }, extra });
    const user = userEvent.setup();
    const view = render(<ReviewQueue client={m.client} projectId={P1} lookUpRecheckMs={5} />);
    return { user, view };
  }

  it("a re-read where only the time changed is not an answer: still busy; the entry whose state changed is shown and said", async () => {
    const t = later();
    const { route } = reads((n) => (n < 3 ? { ...before, lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore: t } } : entry({ reasons: [LOOK_UP_AGAIN_TEXT.nothing, UNIDENTIFIED], lookUp: { state: "nothing", tries: 1, canLookUpNow: false } })));
    const { user } = render2([route, lookUpRoute({ outcome: { kind: "under-way" }, entry: asEntry(before) })]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await waitFor(() => expect(within(matches()).getByText("No candidate matches were found.")).toBeTruthy());
    expect(screen.getAllByRole("status").map((r) => r.textContent)).toContain(LOOK_UP_AGAIN_TEXT.nothing);
  });

  it("after the thirtieth re-read nothing is said, and the button is as the entry last read says", async () => {
    const t = later();
    const { log, route } = reads(() => ({ ...before, lookUp: { state: "waiting", tries: 0, canLookUpNow: false, notBefore: t } }));
    const { user } = render2([route, lookUpRoute({ outcome: { kind: "under-way" }, entry: asEntry(before) })]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    const off = await screen.findByRole("button", { name: lookUpAgainAfter(when(t)) });
    expect(off.getAttribute("aria-busy")).toBeNull();
    expect(log.n).toBe(31);
    expect(screen.getAllByRole("status").map((r) => r.textContent).filter(Boolean)).toEqual([]);
  });

  it("no re-reading outlives the screen", async () => {
    const { log, route } = reads(() => before);
    const { user, view } = render2([route, lookUpRoute({ outcome: { kind: "under-way" }, entry: asEntry(before) })]);
    await openEntry(user);
    await user.click(await screen.findByRole("button", { name: "Look up again" }));
    await waitFor(() => expect(log.n).toBeGreaterThanOrEqual(3));
    view.unmount();
    const at = log.n;
    await new Promise((r) => setTimeout(r, 100));
    expect(log.n).toBeLessThanOrEqual(at + 1);
  });
});
