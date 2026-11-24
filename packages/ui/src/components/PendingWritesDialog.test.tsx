import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { PendingWrite } from "../api/library";
import { server, testApi, url, useMockService } from "../test/service";
import { PendingWritesDialog } from "./PendingWritesDialog";

useMockService();

const T1 = "019a7000-0000-7000-8000-0000000000c1";
const pw = (o: Partial<PendingWrite>): PendingWrite => ({ txn: T1, projectId: "p1", project: "Dissertation", status: "uncommitted", canKeep: false, canRollBack: true, steps: 3, ...o });

function serve(lists: PendingWrite[][], resolve?: () => Response) {
  let calls = 0;
  const posted: unknown[] = [];
  server.use(
    http.get(url("/libraries/pending-writes"), () => HttpResponse.json({ pendingWrites: lists[Math.min(calls++, lists.length - 1)] })),
    http.post(url("/libraries/pending-writes/:txn/resolve"), async ({ request }) => {
      posted.push(await request.json());
      return resolve ? resolve() : HttpResponse.json({ txn: T1, choice: "roll-back", projectId: "p1" });
    }),
  );
  return { lists: () => calls, posted };
}

function show(props: Partial<Parameters<typeof PendingWritesDialog>[0]> = {}) {
  return render(<PendingWritesDialog api={testApi()} readOnly={false} onClose={() => {}} {...props} />);
}

describe("PendingWritesDialog", () => {
  it("after the service refuses a choice, reloads what it now allows and says so in plain words (41b2 I2)", async () => {
    const svc = serve([[pw({})], [pw({ status: "unverifiable", canRollBack: false })]], () =>
      HttpResponse.json({ error: { code: "CONFLICT", message: "That choice is not allowed for this change.", reason: "allowed: none" } }, { status: 409 }),
    );
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Roll it back" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, roll it back" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).not.toMatch(/allowed:/);
    expect(alert.textContent).toMatch(/no longer possible/);
    await waitFor(() => expect(svc.lists()).toBe(2));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Roll it back" })).toBeNull());
    expect(within(dialog).queryByRole("button", { name: "Keep it" })).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("if the list cannot be read again after a refusal, the old choices are taken away and the alert says so (FR-153)", async () => {
    let calls = 0;
    server.use(
      http.get(url("/libraries/pending-writes"), () =>
        calls++ === 0 ? HttpResponse.json({ pendingWrites: [pw({})] }) : HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The library service is not answering." } }, { status: 503 }),
      ),
      http.post(url("/libraries/pending-writes/:txn/resolve"), () =>
        HttpResponse.json({ error: { code: "CONFLICT", message: "That choice is not allowed for this change.", reason: "allowed: none" } }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Roll it back" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, roll it back" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/could not be listed again/));
    const alert = within(dialog).getByRole("alert");
    expect(alert.textContent).toMatch(/no longer possible/);
    expect(alert.textContent).not.toMatch(/The list now shows/);
    expect(within(dialog).queryByRole("button", { name: "Roll it back" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: /Interrupted change in/ })).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("a held or repeated Enter on \"Roll it back\" opens the question and rolls nothing back; Tab then Enter rolls back once (R376 c)", async () => {
    const svc = serve([[pw({})], []]);
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const open = await within(dialog).findByRole("button", { name: "Roll it back" });
    open.focus();
    await user.keyboard("{Enter>4}{/Enter}{Enter}");
    const yes = within(dialog).getByRole("button", { name: "Yes, roll it back" });
    expect(svc.posted).toHaveLength(0);
    expect(document.activeElement).not.toBe(yes);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toMatch(/Roll this change back\?/);
    await user.tab();
    expect(document.activeElement).toBe(yes);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(svc.posted).toHaveLength(1));
  });

  it("an unconfirmable change: the question has focus first, then the acknowledgement; nothing is acknowledged by the key that opened it (R376 c)", async () => {
    serve([[pw({ status: "unverifiable", canRollBack: true, canKeep: false })], []]);
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const open = await within(dialog).findByRole("button", { name: "Roll it back" });
    open.focus();
    await user.keyboard("[Space]{Enter>3}{/Enter}[Space]");
    const box = within(dialog).getByRole("checkbox", { name: /I understand/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.activeElement).not.toBe(box);
    await user.tab();
    expect(document.activeElement).toBe(box);
  });

  it("reloads the list when the library's state changes while it is open", async () => {
    const svc = serve([[pw({})], []]);
    const api = testApi();
    const onClose = () => {};
    const { rerender } = render(<PendingWritesDialog api={api} readOnly={false} onClose={onClose} changed={0} />);
    await screen.findByRole("button", { name: "Roll it back" });
    rerender(<PendingWritesDialog api={api} readOnly={false} onClose={onClose} changed={1} />);
    expect(await screen.findByText(/Nothing is waiting/)).toBeTruthy();
    expect(svc.lists()).toBe(2);
  });

  // R468 (M2): a reload that fails after a resolve that SUCCEEDED (or after the library's state
  // changed) does not leave the old list's choices on offer.
  it("if the list cannot be read again after a successful resolve, the old choices are taken away and the alert says so (FR-153, R468)", async () => {
    let calls = 0;
    server.use(
      http.get(url("/libraries/pending-writes"), () =>
        calls++ === 0 ? HttpResponse.json({ pendingWrites: [pw({})] }) : HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The library service is not answering." } }, { status: 503 }),
      ),
      http.post(url("/libraries/pending-writes/:txn/resolve"), () => HttpResponse.json({ txn: T1, choice: "roll-back", projectId: "p1" })),
    );
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Roll it back" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, roll it back" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/could not be listed again/));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Close this and open it again/);
    expect(within(dialog).queryByRole("button", { name: "Roll it back" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: /Interrupted change in/ })).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("if the list cannot be read again when the library's state changes, the old choices are taken away (FR-153, R468)", async () => {
    let calls = 0;
    server.use(
      http.get(url("/libraries/pending-writes"), () =>
        calls++ === 0 ? HttpResponse.json({ pendingWrites: [pw({})] }) : HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The library service is not answering." } }, { status: 503 }),
      ),
    );
    const api = testApi();
    const onClose = () => {};
    const { rerender } = render(<PendingWritesDialog api={api} readOnly={false} onClose={onClose} changed={0} />);
    await screen.findByRole("button", { name: "Roll it back" });
    rerender(<PendingWritesDialog api={api} readOnly={false} onClose={onClose} changed={1} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be listed again/));
    expect(screen.queryByRole("button", { name: "Roll it back" })).toBeNull();
  });

  it("an item with no allowed choices offers no buttons, never says it was not finished, and points to a backup (R131, 41b2 I3)", async () => {
    serve([[pw({ status: "unverifiable", canRollBack: false, canKeep: false, steps: 4, detail: "audit tail unreadable" }), pw({ txn: "019a7000-0000-7000-8000-00000000bad1", project: "library", status: "invalid", canRollBack: false, steps: 0 })]]);
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const first = await within(dialog).findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(first.textContent).not.toMatch(/was not finished/);
    expect(first.textContent).toMatch(/cannot confirm whether this change was finished/);
    expect(first.textContent).toMatch(/will not change anything itself/);
    expect(first.textContent).toMatch(/restore the project from a backup/);
    expect(within(first).getByText("audit tail unreadable").getAttribute("dir")).toBe("auto");
    expect(within(first).queryByRole("button")).toBeNull();
    const second = within(dialog).getByRole("group", { name: "Interrupted change in library" });
    expect(second.textContent).toMatch(/restore the project from a backup/);
    expect(within(second).queryByRole("button")).toBeNull();
  });

  it("if the service does offer roll-back for an unverifiable change, warns that it may undo a finished change and needs an explicit confirmation (41b2 I3)", async () => {
    const svc = serve([[pw({ status: "unverifiable", canRollBack: true, canKeep: false })], []]);
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const item = await within(dialog).findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(item.textContent).not.toMatch(/was not finished/);
    expect(within(item).queryByRole("button", { name: "Keep it" })).toBeNull();
    await user.click(within(item).getByRole("button", { name: "Roll it back" }));
    expect(item.textContent).toMatch(/may undo a change that was finished/);
    const yes = within(item).getByRole("button", { name: "Yes, roll it back" }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    await user.click(yes);
    expect(svc.posted).toEqual([]);
    await user.click(within(item).getByRole("checkbox", { name: /I understand/ }));
    expect(yes.disabled).toBe(false);
    await user.click(yes);
    await waitFor(() => expect(svc.posted).toEqual([{ choice: "roll-back" }]));
  });

  it("offers only the choices the service lists: no Keep for a change that cannot be kept (41b2 M4)", async () => {
    serve([[pw({ status: "uncommitted", canRollBack: true, canKeep: false }), pw({ txn: "019a7000-0000-7000-8000-0000000000c2", project: "Second", status: "committed", canKeep: true, canRollBack: false })]]);
    show();
    const first = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(within(first).queryByRole("button", { name: "Keep it" })).toBeNull();
    expect(within(first).getByRole("button", { name: "Roll it back" })).toBeTruthy();
    const second = screen.getByRole("group", { name: "Interrupted change in Second" });
    expect(within(second).getByRole("button", { name: "Keep it" })).toBeTruthy();
    expect(within(second).queryByRole("button", { name: "Roll it back" })).toBeNull();
  });

  it("is modal: the page behind it is inert while it is open (41b2 M5)", async () => {
    serve([[]]);
    const page = document.createElement("div");
    page.id = "page";
    document.body.appendChild(page);
    const onClose = vi.fn();
    const { unmount } = show({ onClose });
    await screen.findByText(/Nothing is waiting/);
    expect(page.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    unmount();
    expect(page.hasAttribute("inert")).toBe(false);
    page.remove();
  });
});

describe("FR-736: what is in the way of an undo that is not complete", () => {
  const F = "Projects/Dissertation/sources/Smith <b>2020</b>/kept.txt";
  const SAYS: Record<string, string> = {
    "hand-changed-file": `${F} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”.`,
    "path-occupied": `A file this change removed cannot be put back at ${F}, because another file is there now. Move that file somewhere outside the library, then choose “Roll it back” to put the removed file back.`,
    "kept-copy-gone": `The file this change removed from ${F} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
    "could-not-look": `The app could not read ${F}, so it left it as it is. Make sure the file can be read, then choose “Roll it back”.`,
  };
  for (const [kind, said] of Object.entries(SAYS)) {
    it(`${kind}: said with the file's place in the library, shown as text`, async () => {
      serve([[pw({ rollback: kind === "kept-copy-gone" ? "lost" : kind === "could-not-look" ? "could-not-read" : "in-the-way", causes: [{ kind, path: F }] })]]);
      show();
      const group = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
      const item = within(group).getByText((_, el) => el?.tagName === "P" && el.textContent === said);
      expect(item.querySelector("b")).toBeNull();
      expect(item.querySelector("bdi, [dir]")?.textContent).toBe(F);
    });
  }

  it("R527: kept-copy-gone where something stands at the place: the app cannot confirm it, never \"it is lost\"", async () => {
    const said = `The file this change removed from ${F} cannot be put back: the copy the app kept of it is gone. Something is at that place now, which may be that file, but the app cannot confirm it, so it left it as it is.`;
    serve([[pw({ rollback: "unconfirmed", causes: [{ kind: "kept-copy-gone", path: F, somethingThere: true }] })]]);
    show();
    const group = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    const item = within(group).getByText((_, el) => el?.tagName === "P" && el.textContent === said);
    expect(item.querySelector("b")).toBeNull();
    expect(item.textContent).not.toMatch(/lost/u);
  });

  it("R533 (1): could-not-look where what could not be read is the kept copy: the list says so, with the place as text", async () => {
    const said = `The app could not read the copy it kept of the file this change removed from ${F}, so it left ${F} as it is. Make sure the library's work folder can be read, then choose “Roll it back”.`;
    serve([[pw({ rollback: "could-not-read", causes: [{ kind: "could-not-look", path: F, copyUnread: true }] })]]);
    show();
    const group = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    const item = within(group).getByText((_, el) => el?.tagName === "P" && el.textContent === said);
    expect(item.querySelector("b")).toBeNull();
    expect([...item.querySelectorAll("bdi, [dir]")].map((e) => e.textContent)).toEqual([F, F]);
  });

  it("\"Roll it back\" answered with the undo's state: the library's own sentence, not \"something changed meanwhile\"", async () => {
    const said = "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again.";
    serve([[pw({ rollback: "in-the-way", causes: [{ kind: "hand-changed-file", path: F }] })]], () =>
      HttpResponse.json({ error: { code: "CONFLICT", message: said, reason: "rollback-incomplete" } }, { status: 409 }),
    );
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Roll it back" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, roll it back" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(said);
  });
});

describe("R528 I1, M2: a copy gone together with something else: the words lead in order", () => {
  const A = "Projects/Dissertation/sources/Smith 2020/a.txt";
  const B = "Projects/Dissertation/sources/Smith 2020/b.txt";
  const D = "Projects/Dissertation/sources/Smith 2020/D";
  /** The list's lines of the item, in order, as the researcher reads them (its title, status and step count left out). */
  const lines = (group: HTMLElement) => Array.from(group.querySelectorAll("p")).slice(3).map((p) => p.textContent);

  it("probe P1 (a lost file and a file changed by hand): each cause with its place, then what to do first and the close after it; no close yet", async () => {
    serve([[pw({ rollback: "lost-and-blocked", causes: [{ kind: "kept-copy-gone", path: A }, { kind: "hand-changed-file", path: B }], canClose: false })]]);
    show();
    const group = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(lines(group)).toEqual([
      `The file this change removed from ${A} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
      `${B} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”.`,
      "Deal with what is named above first, then choose “Roll it back” again. After that, this list says whether the change can be closed as it is.",
    ]);
    expect(within(group).getByRole("button", { name: "Roll it back" })).toBeTruthy();
    expect(within(group).queryByRole("button", { name: "Close this change as it is" })).toBeNull();
  });

  it("R532 M2 (probe P2: a lost file and a step that failed): the lost file, then \"try again\", never a file the list does not name; no close yet", async () => {
    serve([[pw({ rollback: "lost-and-try-again", causes: [{ kind: "kept-copy-gone", path: A }], canClose: false })]]);
    show();
    const group = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(lines(group)).toEqual([
      `The file this change removed from ${A} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
      "A step of the undo also failed: first choose “Roll it back” again. After that, this list says whether the change can be closed as it is.",
    ]);
    expect(within(group).getByRole("button", { name: "Roll it back" })).toBeTruthy();
    expect(within(group).queryByRole("button", { name: "Close this change as it is" })).toBeNull();
  });

  it("probe P5 (a lost folder, a copy kept inside it that cannot be put back): a backup is the way; no close, and no hint of one", async () => {
    serve([[pw({ rollback: "lost-copy-stuck", causes: [{ kind: "kept-copy-gone", path: D }], canClose: false })]]);
    show();
    const group = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(lines(group)).toEqual([
      `The file this change removed from ${D} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
      "The app still keeps a copy of another file of this change, which it cannot put back either, and closing would let that copy go, so this change cannot be closed. The way forward is to restore the project from a backup made before this change.",
    ]);
    expect(within(group).queryByRole("button", { name: "Close this change as it is" })).toBeNull();
    expect(within(group).queryByText("You can close this change as it is.")).toBeNull();
  });
});

describe("R509: closing, as it is, a change whose undo can never complete", () => {
  const F = "Projects/Dissertation/sources/Smith 2020/kept <i>1</i>.txt";
  const LOST = pw({ rollback: "lost", causes: [{ kind: "kept-copy-gone", path: F }], canClose: true, lost: [{ path: F, now: "a file", source: "Smith <b>2020</b>" }] });
  const QUESTION = `Close this change as it is? What it removed from ${F} cannot be put back. It belonged to the source Smith <b>2020</b>. A file is at that place now; it stays as it is. Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it.`;
  function serveClose(answer?: () => Response) {
    const posted: unknown[] = [];
    let calls = 0;
    server.use(
      http.get(url("/libraries/pending-writes"), () => HttpResponse.json({ pendingWrites: calls++ === 0 ? [LOST] : [] })),
      http.post(url("/libraries/pending-writes/:txn/close"), async ({ request, params }) => {
        posted.push({ txn: params.txn, body: await request.json() });
        return answer ? answer() : HttpResponse.json({ txn: T1, projectId: "p1" });
      }),
    );
    return posted;
  }

  it("R528 M8: where the app could not look at the place, the question says so (never \"Nothing is at that place now.\")", async () => {
    server.use(
      http.get(url("/libraries/pending-writes"), () =>
        HttpResponse.json({ pendingWrites: [pw({ rollback: "lost", causes: [{ kind: "kept-copy-gone", path: F }], canClose: true, lost: [{ path: F, now: "could-not-look" }] })] }),
      ),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Close this change as it is" }));
    expect((document.activeElement as HTMLElement).textContent).toBe(
      `Close this change as it is? What it removed from ${F} cannot be put back. The app could not look at that place, so it cannot say what is there now; whatever is there stays as it is. Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it.`,
    );
  });

  it("is offered only where the service allows it, after \"Roll it back\" in the Tab order, and said beside what is lost", async () => {
    serve([[pw({ rollback: "in-the-way", causes: [{ kind: "hand-changed-file", path: F }], canClose: false })]]);
    const { unmount } = show();
    await screen.findByRole("button", { name: "Roll it back" });
    expect(screen.queryByRole("button", { name: "Close this change as it is" })).toBeNull();
    unmount();
    serveClose();
    const user = userEvent.setup();
    show();
    const back = await screen.findByRole("button", { name: "Roll it back" });
    back.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close this change as it is" }));
    expect(screen.getByText("You can close this change as it is.")).toBeTruthy();
  });

  it("the confirmation takes the focus on its question, says what is lost and that nothing is deleted; Escape and Cancel give the focus back", async () => {
    const posted = serveClose();
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const open = await within(dialog).findByRole("button", { name: "Close this change as it is" });
    await user.click(open);
    const question = document.activeElement as HTMLElement;
    expect(question.textContent).toBe(QUESTION);
    expect(question.querySelector("b, i")).toBeNull();
    await user.keyboard("{Escape}");
    // Escape takes back the question only: the dialog stays, the focus on the button that asked it.
    expect(screen.getByRole("dialog", { name: "Interrupted changes" })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close this change as it is" }));
    await user.click(within(dialog).getByRole("button", { name: "Close this change as it is" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close this change as it is" }));
    expect(posted).toEqual([]);
  });

  it("confirmed: one request naming the project, busy meanwhile, then the sentence after closing and the list read again", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const posted = serveClose(() => HttpResponse.json({ txn: T1, projectId: "p1" }));
    server.use(
      http.post(url("/libraries/pending-writes/:txn/close"), async ({ request, params }) => {
        posted.push({ txn: params.txn, body: await request.json() });
        await held;
        return HttpResponse.json({ txn: T1, projectId: "p1" });
      }),
    );
    const onResolved = vi.fn();
    const user = userEvent.setup();
    show({ onResolved });
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Close this change as it is" }));
    const yes = within(dialog).getByRole("button", { name: "Yes, close it as it is" });
    await user.click(yes);
    await user.click(yes);
    expect(await within(dialog).findByText("Closing the change…")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Yes, close it as it is" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    const said = await within(dialog).findByText("The change was closed as it is. Nothing was deleted, and the project takes changes again.");
    expect(said.getAttribute("role")).toBe("status");
    expect(posted).toEqual([{ txn: T1, body: { projectId: "p1" } }]);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByText(/Nothing is waiting/)).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("refused: the service's reason as an alert, which takes the focus; the list read again", async () => {
    serveClose(() => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "This project's rules do not allow that." } }, { status: 403 }));
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Close this change as it is" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, close it as it is" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/rules do not allow that/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});
