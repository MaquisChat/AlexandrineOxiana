/**
 * The project's whole review queue (Task 67, D14, R172): every pending entry of every kind, grouped
 * so a person can tell them apart, each decided by the library's own decision for its kind.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewItem } from "../../api/import";
import { http, HttpResponse } from "msw";
import { BASE as SERVICE, B1, mockService, P1, P2, server, type ServiceSetup } from "../../test/importService";
import { ReviewQueue } from "./ReviewQueue";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const entry = (n: number, group: NonNullable<ReviewItem["group"]>, extra: Partial<ReviewItem> = {}): ReviewItem => ({
  id: `r${n}`,
  projectId: P1,
  sourceId: `s${n}`,
  kind: group === "import" || group === "attach" ? "import" : "verification",
  group,
  status: "pending",
  createdAt: `2026-11-11T10:0${n % 10}:00.000Z`,
  fields: group === "capture" ? { "/title": "conflict", "/issued": "conflict" } : {},
  ...(group === "capture" ? { cause: { kind: "capture-conflict" as const } } : group === "withdrawal" ? { cause: { kind: "consent-withdrawal" as const, consentIds: ["c1"] } } : {}),
  reasons: [
    group === "withdrawal"
      ? "Consent from participant P-001 (scope: audio) was withdrawn on 2026-11-11 (phoned). Decide whether this source may still be kept or used; nothing has been deleted."
      : group === "capture"
        ? "The title differs between the page and its metadata."
        : "Low confidence",
  ],
  title: `Entry ${n}`,
  ...(group === "import" ? { batchId: B1 } : {}),
  ...extra,
});

const titleReview = (status: string) => ({
  field: "/title",
  status,
  checks: ["lookup"],
  reason: status === "conflict" ? "The page and its metadata disagree." : "You confirmed this value.",
  values: [
    { value: { variants: [{ lang: "en", kind: "original", value: "Entry 3" }] }, from: { kind: "page-dom", label: "the web page" } },
    { value: { variants: [{ lang: "en", kind: "original", value: "Entry three, revised" }] }, from: { kind: "platform-json", label: "the platform's data" } },
  ],
  evidence: [],
});

const issuedReview = (status: string) => ({
  field: "/issued",
  status,
  checks: ["lookup"],
  values: [
    { value: "2019", from: { kind: "page-dom", label: "the web page" } },
    { value: "2020", from: { kind: "platform-json", label: "the platform's data" } },
  ],
  evidence: [],
});

const record = (n: number, title = `Entry ${n}`, fields: unknown[] = []) => ({
  source: { id: `s${n}`, type: "webpage", title: { variants: [{ lang: "en", kind: "original", value: title }] }, issued: "2019", creators: [], collectionIds: [], tagIds: [], provenance: {} },
  assets: [],
  fieldEvidence: [],
  fields,
});

const BATCH = { batchId: B1, number: 4, kind: "folder", state: "finished", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 1, merged: 0, skipped: 0, failed: 0, needsReview: 1 } };

const QUEUE = [entry(1, "import"), entry(2, "attach"), entry(3, "capture"), entry(4, "withdrawal")];
const BASE: ServiceSetup = {
  batches: [BATCH],
  projectReview: { [P1]: QUEUE },
  sources: { s1: record(1), s2: record(2), s3: record(3, "Entry 3", [issuedReview("conflict"), titleReview("conflict")]), s4: record(4) },
  // The first confirm settles the title, the second the date (the last of the entry's fields: it is resolved, R176 1).
  confirmed: {
    s3: [record(3, "Entry three, revised", [issuedReview("conflict"), titleReview("user-confirmed")]), record(3, "Entry three, revised", [issuedReview("user-confirmed"), titleReview("user-confirmed")])],
  },
};

function setup(o: ServiceSetup = BASE, props: { sourceId?: string; pageSize?: number } = {}) {
  const m = mockService(o);
  const user = userEvent.setup();
  const view = render(<ReviewQueue client={m.client} projectId={P1} {...props} />);
  return { m, user, view };
}

const list = (name: RegExp) => screen.getByRole("list", { name });

describe("the project's whole review queue (Task 67)", () => {
  it("lists every pending entry of the project, grouped: by import, added by hand, from captures, after a consent withdrawal", async () => {
    const { m } = setup();
    expect(await screen.findByRole("heading", { level: 1, name: "Review queue" })).toBeTruthy();
    await screen.findByRole("heading", { name: "Added by hand" });
    expect(screen.getByRole("heading", { name: /^Import 4/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "From captures" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "After a consent withdrawal" })).toBeTruthy();
    expect(within(list(/^Import 4/)).getByRole("button", { name: "Show Entry 1" })).toBeTruthy();
    expect(within(list(/^Added by hand/)).getByRole("button", { name: "Show Entry 2" })).toBeTruthy();
    expect(within(list(/^From captures/)).getByRole("button", { name: "Show Entry 3" })).toBeTruthy();
    expect(within(list(/^After a consent withdrawal/)).getByRole("button", { name: "Show Entry 4" })).toBeTruthy();
    expect(screen.getByText(/4 entries are waiting in this project/)).toBeTruthy();
    // Read once, a page at a time; the batch read is not used.
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/review`)).toHaveLength(1);
    expect(m.calls.filter((c) => c.path.startsWith("/imports/"))).toHaveLength(0);
  });

  it("reads every page of a long queue", async () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(i + 1, "attach"));
    const { m } = setup({ ...BASE, projectReview: { [P1]: many } }, { pageSize: 2 });
    await screen.findByRole("button", { name: "Show Entry 5" });
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/review`)).toHaveLength(3);
  });

  it("an entry added by hand (no batch) is decided as an import item is: the decision names the project, and the entry leaves the view", async () => {
    const { m, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 2" }));
    const panel = await screen.findByRole("region", { name: "Imported record" });
    await within(panel).findByText("Entry 2");
    await user.click(within(screen.getByRole("group", { name: "Decide this item" })).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(m.bodies("POST /review/r2/decide")).toEqual([{ projectId: P1, decision: { action: "accept" } }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show Entry 2" })).toBeNull());
    expect(screen.queryByRole("heading", { name: "Added by hand" })).toBeNull();
  });

  it("a double click on a decision sends one request", async () => {
    const { m, user } = setup();
    await within(await screen.findByRole("region", { name: "Imported record" })).findByText("Entry 1");
    const accept = within(screen.getByRole("group", { name: "Decide this item" })).getByRole("button", { name: "Accept" });
    await user.dblClick(accept);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show Entry 1" })).toBeNull());
    expect(m.bodies("POST /review/r1/decide")).toHaveLength(1);
  });

  it("a capture's conflict is decided by choosing a value, through the source screen's confirm: the badge turns to confirmed by you", async () => {
    const { m, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 3" }));
    const badge = await screen.findByRole("button", { name: "Title: Conflict" });
    expect(screen.queryByRole("group", { name: "Decide this item" })).toBeNull();
    await user.click(badge);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.click(within(dialog).getByRole("radio", { name: /Entry three, revised/ }));
    await user.click(within(dialog).getByRole("button", { name: "Confirm this value" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.bodies(`PATCH /projects/${P1}/sources/s3/fields`)).toEqual([{ field: "/title", value: { variants: [{ lang: "en", kind: "original", value: "Entry three, revised" }] } }]);
    const done = await screen.findByRole("button", { name: "Title: Confirmed by you" });
    await waitFor(() => expect(document.activeElement).toBe(done));
    expect(m.calls.filter((c) => c.path.startsWith("/review/"))).toHaveLength(0);
  });

  it("an import entry with a conflicting field shows its badge too, confirmed through the same confirm, and is then decided as an import item", async () => {
    const s6 = { ...record(6, "Entry 3", [titleReview("conflict")]), source: { ...record(6).source, title: { variants: [{ lang: "en", kind: "original", value: "Entry 3" }] } } };
    const after = { ...record(6, "Entry three, revised", [titleReview("user-confirmed")]) };
    const { m, user } = setup({ ...BASE, projectReview: { [P1]: [entry(6, "attach", { fields: { "/title": "conflict" } })] }, sources: { s6 }, confirmed: { s6: after } });
    await user.click(await screen.findByRole("button", { name: "Title: Conflict" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Entry three, revised/ }));
    await user.click(within(dialog).getByRole("button", { name: "Confirm this value" }));
    expect(await screen.findByRole("button", { name: "Title: Confirmed by you" })).toBeTruthy();
    expect(m.bodies(`PATCH /projects/${P1}/sources/s6/fields`)).toHaveLength(1);
    await user.click(within(screen.getByRole("group", { name: "Decide this item" })).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(m.bodies("POST /review/r6/decide")).toHaveLength(1));
  });

  it("an entry after a consent withdrawal shows why it waits, in the participant's words of the record", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    const why = await screen.findByRole("region", { name: "Why it needs review" });
    expect(within(why).getByText(/Consent from participant P-001/).getAttribute("dir")).toBe("auto");
    expect(screen.queryByRole("group", { name: "Decide this item" })).toBeNull();
  });

  it("opened for one source (from its badge), it shows that source's entries and a way to every entry", async () => {
    const { m } = setup({ ...BASE, projectReview: { [P1]: [...QUEUE, entry(5, "withdrawal", { sourceId: "s2", title: "Entry 2" })] } }, { sourceId: "s2" });
    await screen.findByRole("heading", { name: "Added by hand" });
    expect(screen.getByRole("heading", { name: "After a consent withdrawal" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "From captures" })).toBeNull();
    const call = m.calls.find((c) => c.path === `/projects/${P1}/review`)!;
    expect(call).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show every entry waiting in this project" }).getAttribute("href")).toBe(`/import/review?project=${P1}`);
  });

  it("a locked project: nothing about its entries is shown (no count, no titles); after unlock the view reads again", async () => {
    const { m, user } = setup({ ...BASE, locked: [P1] });
    const pass = await screen.findByLabelText(/passphrase/i);
    expect(screen.queryByText(/Entry \d/)).toBeNull();
    expect(screen.queryByText(/waiting in this project/)).toBeNull();
    await user.type(pass, "secret words");
    await user.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByRole("button", { name: "Show Entry 4" });
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/review`)).toHaveLength(2);
  });

  it("a decision refused because the project was locked meanwhile forgets every entry shown", async () => {
    const { user } = setup({ ...BASE, decideLocked: true });
    await within(await screen.findByRole("region", { name: "Imported record" })).findByText("Entry 1");
    await user.click(within(screen.getByRole("group", { name: "Decide this item" })).getByRole("button", { name: "Accept" }));
    await screen.findByLabelText(/passphrase/i);
    expect(screen.queryByText(/Entry \d/)).toBeNull();
  });

  it("an answer for a project no longer shown is dropped, and nothing outlives the screen", async () => {
    const m = mockService({ ...BASE, projectReview: { [P1]: QUEUE, [P2]: [entry(9, "attach", { projectId: P2, title: "Other project entry" })] }, projectReviewDelayMs: 150 });
    const view = render(<ReviewQueue client={m.client} projectId={P1} />);
    view.rerender(<ReviewQueue client={m.client} projectId={P2} />);
    expect(await screen.findByRole("button", { name: "Show Other project entry" })).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(screen.queryByRole("button", { name: "Show Entry 1" })).toBeNull();
    view.unmount();
  });

  // ---- R176: verification entries are resolved by the library's own ways ----
  it("a capture's entry stays while one of its fields is unsettled, and leaves the view once its last field is confirmed; focus moves to the next entry (R176 1)", async () => {
    const { m, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 3" }));
    const confirm = async (badge: string, choice: RegExp) => {
      await user.click(await screen.findByRole("button", { name: badge }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("radio", { name: choice }));
      await user.click(within(dialog).getByRole("button", { name: "Confirm this value" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    await confirm("Title: Conflict", /Entry three, revised/);
    expect(await screen.findByRole("button", { name: "Title: Confirmed by you" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "From captures" })).toBeTruthy();
    await confirm("Publication date: Conflict", /2020/);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "From captures" })).toBeNull());
    // The view asked the service which of that source's entries are left (the library resolved this one).
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/review`)).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Entry 4" })));
    expect(screen.getByRole("status").textContent).toMatch(/Every field is confirmed/);
  });

  it("an entry after a consent withdrawal says plainly what the decision does and does not do", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    const why = await screen.findByRole("region", { name: "Why it needs review" });
    expect(why.textContent).toMatch(/Consent from participant P-001/);
    expect(screen.getByText(/changes nothing else about the source/)).toBeTruthy();
    expect(screen.getByText(/To remove the source, destroy its files or leave it out of an export, use the tools for those/)).toBeTruthy();
  });

  it("Reviewed after the withdrawal: a dialog that keeps focus, needs a reason, sends it as typed, and the entry leaves the view (R176 2, R145)", async () => {
    const { m, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    const open = await screen.findByRole("button", { name: "Reviewed after the withdrawal…" });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Reviewed after the withdrawal" });
    const reason = within(dialog).getByRole("textbox", { name: /Your reason/ });
    expect(document.activeElement).toBe(reason);
    const submit = within(dialog).getByRole("button", { name: "Record the decision" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(reason, "   ");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.clear(reason);
    const typed = "  Spoke with P-001: the audio may be kept, not quoted.";
    await user.type(reason, typed);
    // Tab and Shift+Tab stay inside the dialog.
    cancel.focus();
    await user.tab();
    expect(document.activeElement).toBe(reason);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.bodies("POST /review/r4/reviewed-after-withdrawal")).toEqual([{ projectId: P1, reason: typed }]);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "After a consent withdrawal" })).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/Recorded as reviewed after the withdrawal/);
  });

  it("Escape closes the dialog without sending anything, and focus returns to the button that opened it", async () => {
    const { m, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    const open = await screen.findByRole("button", { name: "Reviewed after the withdrawal…" });
    await user.click(open);
    await screen.findByRole("dialog", { name: "Reviewed after the withdrawal" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(open);
    expect(m.calls.filter((c) => c.path.endsWith("/reviewed-after-withdrawal"))).toHaveLength(0);
  });

  it("a double click on Record the decision sends one request", async () => {
    const { m, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    await user.click(await screen.findByRole("button", { name: "Reviewed after the withdrawal…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reviewed after the withdrawal" });
    await user.type(within(dialog).getByRole("textbox", { name: /Your reason/ }), "Checked");
    await user.dblClick(within(dialog).getByRole("button", { name: "Record the decision" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.bodies("POST /review/r4/reviewed-after-withdrawal")).toHaveLength(1);
  });

  it("a refused decision is said in plain words in the dialog, which stays open with the reason typed", async () => {
    const refuse = http.post(`${SERVICE}/review/:itemId/reviewed-after-withdrawal`, () =>
      HttpResponse.json({ error: { code: "POLICY_DENIED", message: "This project's rules do not allow that.", reason: "A reason is required to record that this source was reviewed after the withdrawal" } }, { status: 403 }),
    );
    const { user } = setup({ ...BASE, extra: [refuse] });
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    await user.click(await screen.findByRole("button", { name: "Reviewed after the withdrawal…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reviewed after the withdrawal" });
    await user.type(within(dialog).getByRole("textbox", { name: /Your reason/ }), "Checked");
    await user.click(within(dialog).getByRole("button", { name: "Record the decision" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/was not recorded/);
    expect(alert.textContent).toMatch(/A reason is required/);
    expect((within(dialog).getByRole("textbox", { name: /Your reason/ }) as HTMLTextAreaElement).value).toBe("Checked");
  });

  it("a decision refused because the project was locked meanwhile forgets every entry shown", async () => {
    const { user } = setup({ ...BASE, decideLocked: true });
    await user.click(await screen.findByRole("button", { name: "Show Entry 4" }));
    await user.click(await screen.findByRole("button", { name: "Reviewed after the withdrawal…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reviewed after the withdrawal" });
    await user.type(within(dialog).getByRole("textbox", { name: /Your reason/ }), "Checked");
    await user.click(within(dialog).getByRole("button", { name: "Record the decision" }));
    await screen.findByLabelText(/passphrase/i);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Entry \d/)).toBeNull();
  });
});
