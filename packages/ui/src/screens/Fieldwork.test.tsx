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

  it("edits a participant's code", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    await user.click(within(section("Participants")).getByRole("button", { name: "Edit P-001" }));
    const code = within(section("Participants")).getByRole("textbox", { name: "Code" });
    await user.clear(code);
    await user.type(code, "P-014");
    await user.click(within(section("Participants")).getByRole("button", { name: "Save" }));
    expect(await within(section("Participants")).findByText("P-014")).toBeTruthy();
    expect(db.calls.at(-1)).toMatchObject({ method: "PATCH", body: { code: "P-014" } });
  });

  it("refuses to delete a participant something links to, and says why", async () => {
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("region", { name: "Participants" });
    const user = userEvent.setup();
    await addParticipant(user);
    db.consents.push({ id: id(), participantId: db.participants[0].id, scope: "audio", date: "2026-03-14" });
    await user.click(within(section("Participants")).getByRole("button", { name: "Delete P-001" }));
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
    expect(db.calls.at(-1)).toMatchObject({ method: "POST", body: { reason: "Asked by phone" } });
    await waitFor(() => expect(within(c).getByText(/Withdrawn on 2026-11-11/)).toBeTruthy());
    expect(within(c).queryByRole("button", { name: "Withdraw consent of P-001" })).toBeNull();
  });
});
