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
