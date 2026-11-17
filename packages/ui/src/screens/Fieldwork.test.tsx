import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { Fieldwork } from "./Fieldwork";

useMsw();

const PID = "0190f0f0-0000-7000-8000-000000000003";
const P = (path: string) => url(`/projects/${PID}${path}`);

interface Db {
  participants: any[];
  sessions: any[];
  consents: any[];
  calls: Array<{ method: string; path: string; body: any }>;
}
let db: Db;
let n = 0;
const id = () => `0190f0f0-0000-7000-8000-${String(++n).padStart(12, "0")}`;

beforeEach(() => {
  db = { participants: [], sessions: [], consents: [], calls: [] };
  const record = async (request: Request) => {
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json();
    db.calls.push({ method: request.method, path: new URL(request.url).pathname.replace(`/projects/${PID}`, ""), body });
    return body as any;
  };
  server.use(
    http.get(P("/participants"), () => HttpResponse.json({ participants: db.participants, complete: true })),
    http.get(P("/sessions"), () => HttpResponse.json({ sessions: db.sessions, complete: true })),
    http.get(P("/consents"), () => HttpResponse.json({ consents: db.consents, complete: true })),
    http.post(P("/participants"), async ({ request }) => {
      const b = await record(request);
      const p = { id: id(), code: b.code ?? `P-${String(db.participants.length + 1).padStart(3, "0")}`, consentIds: [] };
      db.participants.push(p);
      return HttpResponse.json(p);
    }),
    http.patch(P("/participants/:fid"), async ({ request, params }) => {
      const b = await record(request);
      const p = db.participants.find((x) => x.id === params.fid);
      Object.assign(p, b);
      return HttpResponse.json(p);
    }),
    http.delete(P("/participants/:fid"), async ({ request, params }) => {
      await record(request);
      if (db.consents.some((c) => c.participantId === params.fid)) {
        return HttpResponse.json({ error: { code: "CONFLICT", message: "Participant P-001 cannot be deleted: 1 consent record still link to it. Remove those links first" } }, { status: 409 });
      }
      db.participants = db.participants.filter((x) => x.id !== params.fid);
      return HttpResponse.json({ deleted: true });
    }),
    http.post(P("/sessions"), async ({ request }) => {
      const b = await record(request);
      const s = { id: id(), participantIds: [], ...b };
      db.sessions.push(s);
      return HttpResponse.json(s);
    }),
    http.post(P("/consents"), async ({ request }) => {
      const b = await record(request);
      const c = { id: id(), ...b };
      db.consents.push(c);
      return HttpResponse.json(c);
    }),
    http.post(P("/consents/:fid/withdraw"), async ({ request, params }) => {
      await record(request);
      const c = db.consents.find((x) => x.id === params.fid);
      c.withdrawn = { at: "2026-11-11T09:00:00.000Z" };
      return HttpResponse.json({ consent: c, flaggedSourceIds: ["s1", "s2"] });
    }),
    http.post(P("/consents/:fid/document"), async ({ request, params }) => {
      await record(request);
      const c = db.consents.find((x) => x.id === params.fid);
      c.documentAssetId = "0190f0f0-0000-7000-8000-0000000000aa";
      return HttpResponse.json({ consent: c, sourceId: "s9", assetId: c.documentAssetId });
    }),
  );
});

const section = (name: string) => screen.getByRole("region", { name });

async function addParticipant(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(section("Participants")).getByRole("button", { name: "Add participant" }));
  return within(section("Participants")).findByText(/^P-\d{3}$/);
}

describe("Fieldwork", () => {
  it("adds participants with automatic codes", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    expect((await addParticipant(user)).textContent).toBe("P-001");
    expect(db.calls[0]).toEqual({ method: "POST", path: "/participants", body: {} });
  });

  it("never offers to change a participant's code (R117 C1)", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    expect(within(section("Participants")).queryByRole("button", { name: /Edit P-001/ })).toBeNull();
    expect(within(section("Participants")).queryByRole("textbox", { name: "Code" })).toBeNull();
  });

  it("asks before deleting a participant", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    await user.click(within(section("Participants")).getByRole("button", { name: "Delete P-001" }));
    const dialog = screen.getByRole("dialog", { name: "Delete participant P-001" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(db.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(section("Participants")).getByRole("button", { name: "Delete P-001" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete participant P-001" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(db.calls.at(-1)).toMatchObject({ method: "DELETE" }));
    await waitFor(() => expect(within(section("Participants")).queryByText("P-001")).toBeNull());
  });

  it("a held or repeated Enter on Delete opens the dialog on its heading and deletes nothing; Tab then Enter deletes once (R376 c)", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    const opener = within(section("Participants")).getByRole("button", { name: "Delete P-001" });
    opener.focus();
    await user.keyboard("{Enter>4}{/Enter}{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Delete participant P-001" });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Delete participant P-001" }));
    expect(db.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(db.calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
  });

  it("edits a session's and a consent record's details (never the participant's code)", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    db.sessions.push({ id: id(), date: "2026-03-14", place: "Lima", participantIds: [] });
    db.consents.push({ id: id(), participantId: db.participants[0].id, scope: "audio", date: "2026-03-14" });
    server.use(
      http.patch(P("/sessions/:fid"), async ({ request, params }) => {
        const b = (await request.json()) as any;
        db.calls.push({ method: "PATCH", path: `/sessions/${params.fid}`, body: b });
        const s = db.sessions.find((x) => x.id === params.fid);
        Object.assign(s, b);
        return HttpResponse.json(s);
      }),
      http.patch(P("/consents/:fid"), async ({ request, params }) => {
        const b = (await request.json()) as any;
        db.calls.push({ method: "PATCH", path: `/consents/${params.fid}`, body: b });
        const c = db.consents.find((x) => x.id === params.fid);
        Object.assign(c, b);
        return HttpResponse.json(c);
      }),
    );
    // Reload with the new records.
    await user.click(within(section("Participants")).getByRole("button", { name: "Add participant" }));
    await user.click(await within(section("Sessions")).findByRole("button", { name: "Edit the session of 2026-03-14" }));
    const place = within(section("Sessions")).getByRole("textbox", { name: "Place of this session" });
    await user.clear(place);
    await user.type(place, "Callao");
    await user.click(within(section("Sessions")).getByRole("button", { name: "Save session" }));
    await waitFor(() => expect(db.calls.at(-1)).toMatchObject({ method: "PATCH", body: { place: "Callao" } }));
    await user.click(within(section("Consent records")).getByRole("button", { name: "Edit consent of P-001" }));
    const scope = within(section("Consent records")).getByRole("textbox", { name: "Scope of this consent" });
    await user.clear(scope);
    await user.type(scope, "audio and photos");
    await user.click(within(section("Consent records")).getByRole("button", { name: "Save consent" }));
    await waitFor(() => expect(db.calls.at(-1)).toMatchObject({ method: "PATCH", body: { scope: "audio and photos" } }));
    expect(db.calls.filter((c) => c.method === "PATCH").every((c) => !("code" in c.body) && !("documentAssetId" in c.body))).toBe(true);
  });

  it("says so when several forms are dropped on one consent record", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    db.consents.push({ id: id(), participantId: db.participants[0].id, scope: "audio", date: "2026-03-14" });
    await user.click(within(section("Participants")).getByRole("button", { name: "Add participant" }));
    const c = section("Consent records");
    const f = (n: string) => Object.assign(new File(["%PDF"], n), { path: `/Users/ana/${n}` });
    fireEvent.drop(await within(c).findByText(/Drop the signed consent form here/), { dataTransfer: { files: [f("a.pdf"), f("b.pdf")], types: ["Files"] } });
    expect((await within(c).findByRole("alert")).textContent).toMatch(/one signed form at a time/);
    expect(db.calls.some((x) => x.path.endsWith("/document"))).toBe(false);
  });

  it("refuses to delete a participant something links to, and says why", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    db.consents.push({ id: id(), participantId: db.participants[0].id, scope: "audio", date: "2026-03-14" });
    await user.click(within(section("Participants")).getByRole("button", { name: "Delete P-001" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete participant P-001" })).getByRole("button", { name: "Delete" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be deleted: 1 consent record/);
    expect(within(section("Participants")).getByText("P-001")).toBeTruthy();
  });

  it("records a session with its participants", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    const s = section("Sessions");
    fireEvent.change(within(s).getByLabelText("Date"), { target: { value: "2026-03-14" } });
    await user.type(within(s).getByRole("textbox", { name: "Place" }), "Callao fish market");
    await user.click(within(s).getByRole("checkbox", { name: "P-001" }));
    await user.click(within(s).getByRole("button", { name: "Add session" }));
    expect(await within(s).findByText("Callao fish market")).toBeTruthy();
    expect(db.calls.at(-1)).toEqual({ method: "POST", path: "/sessions", body: { date: "2026-03-14", place: "Callao fish market", participantIds: [db.participants[0].id] } });
  });

  it("records consent, attaches the signed form by drop, and withdraws it (flagging linked sources, deleting nothing)", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    const c = section("Consent records");
    await user.selectOptions(within(c).getByRole("combobox", { name: "Participant" }), "P-001");
    await user.type(within(c).getByRole("textbox", { name: "Scope" }), "Audio recording, quotes");
    fireEvent.change(within(c).getByLabelText("Consent date"), { target: { value: "2026-03-14" } });
    await user.click(within(c).getByRole("button", { name: "Add consent record" }));
    expect(await within(c).findByText("Audio recording, quotes")).toBeTruthy();
    expect(db.calls.at(-1)).toMatchObject({ method: "POST", path: "/consents", body: { participantId: db.participants[0].id, scope: "Audio recording, quotes", date: "2026-03-14" } });

    const file = Object.assign(new File(["%PDF"], "consent P-001.pdf"), { path: "/Users/ana/consent P-001.pdf" });
    fireEvent.drop(within(c).getByText(/Drop the signed consent form here/), { dataTransfer: { files: [file], types: ["Files"] } });
    expect(await within(c).findByText(/Signed form attached/)).toBeTruthy();
    expect(db.calls.at(-1)).toMatchObject({ method: "POST", body: { path: "/Users/ana/consent P-001.pdf" } });

    await user.click(within(c).getByRole("button", { name: "Withdraw consent of P-001" }));
    const dialog = screen.getByRole("dialog", { name: "Withdraw consent" });
    await user.type(within(dialog).getByRole("textbox", { name: /Reason/ }), "Asked by phone");
    await user.click(within(dialog).getByRole("button", { name: "Withdraw consent" }));
    expect((await screen.findByRole("status", { name: "Fieldwork result" })).textContent).toMatch(/2 sources were flagged for review; nothing was deleted/);
    // What was put in the review queue is found there: the project's whole queue (Task 67).
    expect(screen.getByRole("link", { name: "Open the review queue" }).getAttribute("href")).toBe(`/import/review?project=${PID}`);
    expect(db.calls.at(-1)).toMatchObject({ method: "POST", body: { reason: "Asked by phone" } });
    await waitFor(() => expect(within(c).getByText((_, el) => el?.tagName === "STRONG" && /Withdrawn on 2026-11-11/.test(el.textContent ?? ""))).toBeTruthy());
    expect(within(c).queryByRole("button", { name: "Withdraw consent of P-001" })).toBeNull();
  });

  it("a form that was detached before is offered for re-attaching, only after a confirmation (R119 carry-over)", async () => {
    const pid0 = id();
    db.participants.push({ id: pid0, code: "P-001", consentIds: [] });
    db.consents.push({ id: id(), participantId: pid0, scope: "Audio", date: "2026-03-14", detachedAssetIds: ["0190f0f0-0000-7000-8000-0000000000aa"] });
    server.use(
      http.post(P("/consents/:fid/document"), async ({ request, params }) => {
        const body = (await request.json()) as { path: string; reattach?: boolean };
        db.calls.push({ method: "POST", path: `/consents/${String(params.fid)}/document`, body });
        if (!body.reattach) {
          return HttpResponse.json(
            { error: { code: "VALIDATION", message: "This form was detached from the consent record; re-attach it explicitly if it belongs there", reason: "detached-form" } },
            { status: 400 },
          );
        }
        const c = db.consents.find((x) => x.id === params.fid);
        c.documentAssetId = "0190f0f0-0000-7000-8000-0000000000aa";
        return HttpResponse.json({ consent: c, sourceId: "s9", assetId: c.documentAssetId });
      }),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    const c = await screen.findByRole("region", { name: "Consent records" });
    const file = Object.assign(new File(["%PDF"], "consent P-001.pdf"), { path: "/Users/ana/consent P-001.pdf" });
    fireEvent.drop(await within(c).findByText(/Drop the signed consent form here/), { dataTransfer: { files: [file], types: ["Files"] } });
    const offer = await within(c).findByRole("group", { name: "Re-attach the signed form of P-001?" });
    expect(offer.textContent).toMatch(/detached from this consent record before/);
    expect(db.calls.filter((x) => x.body?.reattach)).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(within(offer).getByRole("button", { name: "Re-attach the form" }));
    await waitFor(() => expect(db.calls.at(-1)).toMatchObject({ method: "POST", body: { path: "/Users/ana/consent P-001.pdf", reattach: true } }));
    expect(await within(c).findByText(/Signed form attached/)).toBeTruthy();
  });

  it("the re-attach offer can be declined: nothing is sent", async () => {
    const pid0 = id();
    db.participants.push({ id: pid0, code: "P-001", consentIds: [] });
    db.consents.push({ id: id(), participantId: pid0, scope: "Audio", date: "2026-03-14" });
    server.use(
      http.post(P("/consents/:fid/document"), async ({ request }) => {
        db.calls.push({ method: "POST", path: "/document", body: await request.json() });
        return HttpResponse.json({ error: { code: "VALIDATION", message: "detached", reason: "detached-form" } }, { status: 400 });
      }),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    const c = await screen.findByRole("region", { name: "Consent records" });
    const file = Object.assign(new File(["%PDF"], "f.pdf"), { path: "/Users/ana/f.pdf" });
    fireEvent.drop(await within(c).findByText(/Drop the signed consent form here/), { dataTransfer: { files: [file], types: ["Files"] } });
    const offer = await within(c).findByRole("group", { name: "Re-attach the signed form of P-001?" });
    await userEvent.setup().click(within(offer).getByRole("button", { name: "Cancel" }));
    expect(within(c).queryByRole("group", { name: "Re-attach the signed form of P-001?" })).toBeNull();
    expect(db.calls).toHaveLength(1);
  });
});

describe("one request at a time (R379, I3)", () => {
  /** Holds every request through `paths` until `release()`; the rest pass to the handlers above. */
  function hold() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  }
  const count = (method: string, path: RegExp) => db.calls.filter((c) => c.method === method && path.test(c.path)).length;
  /** Re-registers a POST handler that records at once and answers only once the gate opens. */
  const heldPost = (path: string, gate: Promise<void>, answer: (b: any) => any) =>
    http.post(P(path), async ({ request }) => {
      const b = (await request.json()) as any;
      db.calls.push({ method: "POST", path, body: b });
      await gate;
      return HttpResponse.json(answer(b));
    });
  async function withParticipant() {
    db.participants.push({ id: id(), code: "P-001", consentIds: [] });
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await within(await screen.findByRole("region", { name: "Participants" })).findByText("P-001");
  }
  async function fillConsent(user: ReturnType<typeof userEvent.setup>) {
    const c = section("Consent records");
    await user.selectOptions(within(c).getByRole("combobox", { name: "Participant" }), "P-001");
    await user.type(within(c).getByRole("textbox", { name: "Scope" }), "Audio");
    fireEvent.change(within(c).getByLabelText("Consent date"), { target: { value: "2026-03-14" } });
    return within(c).getByRole("button", { name: "Add consent record" }) as HTMLButtonElement;
  }

  it("the reviewer's probe: two submits of the consent form and two clicks on \"Add participant\" send one request each", async () => {
    const h = hold();
    server.use(
      heldPost("/consents", h.gate, (b) => {
        const c = { id: id(), ...b };
        db.consents.push(c);
        return c;
      }),
      heldPost("/participants", h.gate, () => {
        const p = { id: id(), code: `P-00${db.participants.length + 1}`, consentIds: [] };
        db.participants.push(p);
        return p;
      }),
    );
    await withParticipant();
    const user = userEvent.setup();
    const add = await fillConsent(user);
    const form = add.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(count("POST", /^\/consents$/)).toBe(1));
    const addP = within(section("Participants")).getByRole("button", { name: "Add participant" }) as HTMLButtonElement;
    expect(addP.disabled).toBe(true); // a request runs: nothing else starts
    h.release();
    await waitFor(() => expect(addP.disabled).toBe(false));
    const h2 = hold();
    server.use(
      heldPost("/participants", h2.gate, () => {
        const p = { id: id(), code: `P-00${db.participants.length + 1}`, consentIds: [] };
        db.participants.push(p);
        return p;
      }),
    );
    await user.click(addP);
    await user.click(addP);
    fireEvent.click(addP);
    h2.release();
    await within(section("Participants")).findByText("P-002");
    await new Promise((r) => setTimeout(r, 30));
    expect(count("POST", /^\/consents$/)).toBe(1);
    expect(count("POST", /^\/participants$/)).toBe(1);
  });

  it("Enter held on \"Add participant\": one request; the button is disabled meanwhile, then back, with focus on it", async () => {
    const h = hold();
    server.use(
      heldPost("/participants", h.gate, () => {
        const p = { id: id(), code: "P-001", consentIds: [] };
        db.participants.push(p);
        return p;
      }),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    const addP = (await within(await screen.findByRole("region", { name: "Participants" })).findByRole("button", { name: "Add participant" })) as HTMLButtonElement;
    addP.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter>5}{/Enter}");
    expect(addP.disabled).toBe(true);
    h.release();
    await within(section("Participants")).findByText("P-001");
    await waitFor(() => expect(addP.disabled).toBe(false));
    expect(document.activeElement).toBe(addP);
    expect(count("POST", /^\/participants$/)).toBe(1);
  });

  it("Enter held on \"Add consent record\": one consent record; then focus goes back to the (emptied) form", async () => {
    const h = hold();
    server.use(
      heldPost("/consents", h.gate, (b) => {
        const c = { id: id(), ...b };
        db.consents.push(c);
        return c;
      }),
    );
    await withParticipant();
    const user = userEvent.setup();
    const add = await fillConsent(user);
    add.focus();
    await user.keyboard("{Enter>5}{/Enter}");
    expect(add.disabled).toBe(true);
    h.release();
    await within(section("Consent records")).findByText("Audio");
    expect(count("POST", /^\/consents$/)).toBe(1);
    // The form was emptied, so its button stays disabled: focus is on the form's first field.
    await waitFor(() => expect(document.activeElement).toBe(within(section("Consent records")).getByRole("combobox", { name: "Participant" })));
  });

  it("a failed consent request re-enables the form, shows its error as before, and focus is back on its button", async () => {
    const h = hold();
    server.use(http.post(P("/consents"), async ({ request }) => {
      db.calls.push({ method: "POST", path: "/consents", body: await request.json() });
      await h.gate;
      return HttpResponse.json({ error: { code: "VALIDATION", message: "The consent date is in the future." } }, { status: 400 });
    }));
    await withParticipant();
    const user = userEvent.setup();
    const add = await fillConsent(user);
    add.focus();
    await user.keyboard("{Enter>3}{/Enter}");
    expect(add.disabled).toBe(true);
    h.release();
    expect((await screen.findByRole("alert")).textContent).toBe("The consent date is in the future.");
    await waitFor(() => expect(add.disabled).toBe(false));
    expect(document.activeElement).toBe(add);
    expect(count("POST", /^\/consents$/)).toBe(1);
  });

  it("\"Add session\": two submits and a held Enter send one request", async () => {
    const h = hold();
    server.use(
      heldPost("/sessions", h.gate, (b) => {
        const s = { id: id(), participantIds: [], ...b };
        db.sessions.push(s);
        return s;
      }),
    );
    await withParticipant();
    const s = section("Sessions");
    fireEvent.change(within(s).getByLabelText("Date"), { target: { value: "2026-03-14" } });
    const add = within(s).getByRole("button", { name: "Add session" }) as HTMLButtonElement;
    fireEvent.submit(add.closest("form")!);
    fireEvent.submit(add.closest("form")!);
    add.focus();
    await userEvent.setup().keyboard("{Enter>3}{/Enter}");
    expect(add.disabled).toBe(true);
    h.release();
    await within(s).findByText("2026-03-14");
    expect(count("POST", /^\/sessions$/)).toBe(1);
  });

  it("the other controls: Save session, Save consent, a dropped form, Re-attach, Delete participant, Withdraw — one request each, disabled while one runs", async () => {
    const sid = id();
    const cid = id();
    db.participants.push({ id: id(), code: "P-001", consentIds: [] });
    db.sessions.push({ id: sid, date: "2026-03-14", place: "Lima", participantIds: [] });
    db.consents.push({ id: cid, participantId: db.participants[0].id, scope: "audio", date: "2026-03-14" });
    let h = hold();
    const held = (method: "patch" | "post" | "delete", path: string, answer: () => any) =>
      http[method](P(path), async ({ request }) => {
        const body = method === "delete" ? undefined : await request.json();
        db.calls.push({ method: method.toUpperCase(), path: new URL(request.url).pathname.replace(`/projects/${PID}`, ""), body });
        await h.gate;
        return answer();
      });
    server.use(
      held("patch", "/sessions/:fid", () => HttpResponse.json(db.sessions[0])),
      held("patch", "/consents/:fid", () => HttpResponse.json(db.consents[0])),
      held("post", "/consents/:fid/document", () => HttpResponse.json({ error: { code: "VALIDATION", message: "detached", reason: "detached-form" } }, { status: 400 })),
      held("delete", "/participants/:fid", () => HttpResponse.json({ error: { code: "CONFLICT", message: "P-001 cannot be deleted: 1 consent record still links to it." } }, { status: 409 })),
      held("post", "/consents/:fid/withdraw", () => HttpResponse.json({ consent: db.consents[0], flaggedSourceIds: [] })),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await within(await screen.findByRole("region", { name: "Participants" })).findByText("P-001");
    const user = userEvent.setup();
    const settle = async () => {
      h.release();
      await waitFor(() => expect((within(section("Participants")).getByRole("button", { name: "Add participant" }) as HTMLButtonElement).disabled).toBe(false));
      h = hold();
    };

    // Save session: two submits of the editor.
    await user.click(await within(section("Sessions")).findByRole("button", { name: "Edit the session of 2026-03-14" }));
    const saveS = within(section("Sessions")).getByRole("button", { name: "Save session" });
    const sForm = saveS.closest("form")!;
    fireEvent.submit(sForm);
    fireEvent.submit(sForm);
    await waitFor(() => expect(count("PATCH", /^\/sessions\//)).toBe(1));
    await settle();

    // Save consent: two submits of the editor.
    await user.click(within(section("Consent records")).getByRole("button", { name: "Edit consent of P-001" }));
    const cForm = within(section("Consent records")).getByRole("button", { name: "Save consent" }).closest("form")!;
    fireEvent.submit(cForm);
    fireEvent.submit(cForm);
    await waitFor(() => expect(count("PATCH", /^\/consents\//)).toBe(1));
    expect((within(section("Consent records")).getByRole("button", { name: "Withdraw consent of P-001" }) as HTMLButtonElement).disabled).toBe(true);
    await settle();

    // A dropped form, dropped twice: one request; then the re-attach offer, pressed twice: one request.
    const c = section("Consent records");
    const file = Object.assign(new File(["%PDF"], "f.pdf"), { path: "/Users/ana/f.pdf" });
    const zone = within(c).getByText(/Drop the signed consent form here/);
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(count("POST", /\/document$/)).toBe(1));
    expect((within(c).getByRole("textbox", { name: "Or add the form by its full path" }) as HTMLInputElement).disabled).toBe(true);
    await settle();
    const offer = await within(c).findByRole("group", { name: "Re-attach the signed form of P-001?" });
    const re = within(offer).getByRole("button", { name: "Re-attach the form" });
    fireEvent.click(re);
    fireEvent.click(re);
    await waitFor(() => expect(count("POST", /\/document$/)).toBe(2));
    await settle();

    // Delete participant: the dialog's confirm pressed twice.
    await user.click(within(section("Participants")).getByRole("button", { name: "Delete P-001" }));
    const del = within(screen.getByRole("dialog", { name: "Delete participant P-001" })).getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    fireEvent.click(del);
    await waitFor(() => expect(count("DELETE", /^\/participants\//)).toBe(1));
    await settle();
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be deleted/);

    // Withdraw: the dialog's form submitted twice.
    await user.click(within(section("Consent records")).getByRole("button", { name: "Withdraw consent of P-001" }));
    const wForm = within(screen.getByRole("dialog", { name: "Withdraw consent" })).getByRole("button", { name: "Withdraw consent" }).closest("form")!;
    fireEvent.submit(wForm);
    fireEvent.submit(wForm);
    await waitFor(() => expect(count("POST", /\/withdraw$/)).toBe(1));
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    expect(count("PATCH", /^\/sessions\//)).toBe(1);
    expect(count("PATCH", /^\/consents\//)).toBe(1);
    expect(count("POST", /\/document$/)).toBe(2);
    expect(count("DELETE", /^\/participants\//)).toBe(1);
    expect(count("POST", /\/withdraw$/)).toBe(1);
  });

  it("the openers of \"Delete participant\" and \"Delete session\" are disabled while a request runs, and enabled again after it (R399 f)", async () => {
    db.sessions.push({ id: id(), date: "2026-03-14", place: "Lima", participantIds: [] });
    const h = hold();
    server.use(
      heldPost("/participants", h.gate, () => {
        const p = { id: id(), code: `P-00${db.participants.length + 1}`, consentIds: [] };
        db.participants.push(p);
        return p;
      }),
    );
    await withParticipant();
    const delP = within(section("Participants")).getByRole("button", { name: "Delete P-001" }) as HTMLButtonElement;
    const delS = (await within(section("Sessions")).findByRole("button", { name: "Delete the session of 2026-03-14" })) as HTMLButtonElement;
    expect([delP.disabled, delS.disabled]).toEqual([false, false]);
    fireEvent.click(within(section("Participants")).getByRole("button", { name: "Add participant" }));
    await waitFor(() => expect(count("POST", /^\/participants$/)).toBe(1));
    expect([delP.disabled, delS.disabled]).toEqual([true, true]);
    h.release();
    await waitFor(() => expect((within(section("Participants")).getByRole("button", { name: "Delete P-001" }) as HTMLButtonElement).disabled).toBe(false));
    expect((within(section("Sessions")).getByRole("button", { name: "Delete the session of 2026-03-14" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failed \"Add participant\" re-enables it and shows its error as before", async () => {
    server.use(http.post(P("/participants"), async ({ request }) => {
      db.calls.push({ method: "POST", path: "/participants", body: await request.json() });
      return HttpResponse.json({ error: { code: "INTERNAL", message: "The participant could not be added." } }, { status: 500 });
    }));
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    const addP = (await within(await screen.findByRole("region", { name: "Participants" })).findByRole("button", { name: "Add participant" })) as HTMLButtonElement;
    await userEvent.setup().click(addP);
    expect((await screen.findByRole("alert")).textContent).toBe("The participant could not be added.");
    await waitFor(() => expect(addP.disabled).toBe(false));
    expect(document.activeElement).toBe(addP);
  });
});

describe("deleting a session asks first (R379, I4)", () => {
  const TITLE = "Delete the session of 2026-01-02, Lima";
  let linked = false;
  beforeEach(() => {
    linked = false;
    db.sessions.push({ id: id(), date: "2026-01-02", place: "Lima", notes: "Market stalls", participantIds: [] });
    server.use(
      http.delete(P("/sessions/:fid"), ({ params }) => {
        db.calls.push({ method: "DELETE", path: `/sessions/${String(params.fid)}`, body: undefined });
        if (linked) return HttpResponse.json({ error: { code: "CONFLICT", message: "The session of 2026-01-02 cannot be deleted: 1 source still links to it. Remove those links first" } }, { status: 409 });
        db.sessions = db.sessions.filter((x) => x.id !== params.fid);
        return HttpResponse.json({ deleted: true });
      }),
    );
  });
  const deletes = () => db.calls.filter((c) => c.method === "DELETE").length;
  async function opener() {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    return within(await screen.findByRole("region", { name: "Sessions" })).findByRole("button", { name: "Delete the session of 2026-01-02" });
  }

  it("one click opens the question, worded like the participant's; nothing is sent", async () => {
    const user = userEvent.setup();
    await user.click(await opener());
    const dialog = screen.getByRole("dialog", { name: TITLE });
    expect(dialog.textContent).toMatch(/The session of 2026-01-02 in Lima will be deleted, with its date, place and notes/);
    expect(within(dialog).getByRole("button", { name: "Delete session" })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: TITLE }));
    await new Promise((r) => setTimeout(r, 20));
    expect(deletes()).toBe(0);
  });

  it("Enter held on the button: the dialog, on its heading; nothing is sent", async () => {
    const btn = await opener();
    btn.focus();
    await userEvent.setup().keyboard("{Enter>5}{/Enter}{Enter}");
    const dialog = screen.getByRole("dialog", { name: TITLE });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: TITLE }));
    await new Promise((r) => setTimeout(r, 20));
    expect(deletes()).toBe(0);
  });

  it("confirm: exactly one DELETE; focus goes to the Sessions heading", async () => {
    const user = userEvent.setup();
    await user.click(await opener());
    const confirm = within(screen.getByRole("dialog", { name: TITLE })).getByRole("button", { name: "Delete session" });
    await user.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(section("Sessions")).queryByRole("button", { name: "Delete the session of 2026-01-02" })).toBeNull());
    expect(deletes()).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(within(section("Sessions")).getByRole("heading", { name: "Sessions" })));
  });

  it("Cancel or Escape: nothing is sent, focus back on the button", async () => {
    const user = userEvent.setup();
    const btn = await opener();
    await user.click(btn);
    await user.click(within(screen.getByRole("dialog", { name: TITLE })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
    await user.click(btn);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(deletes()).toBe(0);
  });

  it("the title's place goes through UserText: a right-to-left override in it stays isolated; the dialog is still named by the date and the place (R399 e)", async () => {
    const place = "Lima‮odaguh";
    db.sessions = [{ id: id(), date: "2026-01-02", place, notes: "", participantIds: [] }];
    const user = userEvent.setup();
    await user.click(await opener());
    const name = `Delete the session of 2026-01-02, ${place}`;
    const dialog = screen.getByRole("dialog", { name });
    const heading = within(dialog).getByRole("heading", { name });
    const isolated = heading.querySelector('[dir="auto"]');
    expect(isolated?.textContent).toBe(place);
    expect(heading.textContent).toBe(name);
    expect(heading.id).toBe(dialog.getAttribute("aria-labelledby"));
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  });

  it("a session something links to says why, as before; the session stays", async () => {
    linked = true;
    const user = userEvent.setup();
    await user.click(await opener());
    await user.click(within(screen.getByRole("dialog", { name: TITLE })).getByRole("button", { name: "Delete session" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be deleted: 1 source still links to it/);
    expect(within(section("Sessions")).getByRole("button", { name: "Delete the session of 2026-01-02" })).toBeTruthy();
    expect(deletes()).toBe(1);
  });
});

describe("R362 h: a consent's scope typed in an encrypted project", () => {
  const SCOPE_NOTE = "In an encrypted project this text can be read without the passphrase. Do not put a person's name in it.";
  const describedText = (el: HTMLElement) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .map((x) => document.getElementById(x)?.textContent ?? "")
      .join(" ");
  for (const encrypted of [true, false]) {
    it(`the new consent's Scope and an edited consent's scope — ${encrypted ? "encrypted: the note, tied to the field" : "not encrypted: nothing"}`, async () => {
      render(<Fieldwork api={makeApi()} projectId={PID} encrypted={encrypted} />);
      await screen.findByRole("region", { name: "Participants" });
      const user = userEvent.setup();
      await addParticipant(user);
      db.consents.push({ id: id(), participantId: db.participants[0].id, scope: "audio", date: "2026-03-14" });
      await user.click(within(section("Participants")).getByRole("button", { name: "Add participant" }));
      const c = section("Consent records");
      const fields = [within(c).getByRole("textbox", { name: "Scope" })];
      await user.click(await within(c).findByRole("button", { name: "Edit consent of P-001" }));
      fields.push(within(section("Consent records")).getByRole("textbox", { name: "Scope of this consent" }));
      for (const f of fields) {
        if (encrypted) expect(describedText(f)).toBe(SCOPE_NOTE);
        else expect(f.getAttribute("aria-describedby")).toBeNull();
      }
      expect(within(section("Consent records")).queryAllByText(SCOPE_NOTE)).toHaveLength(encrypted ? 2 : 0);
    });
  }
});
