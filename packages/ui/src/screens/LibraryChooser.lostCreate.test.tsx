/**
 * FR-194 (R461 b): a library closed while a project's creation could not be told made or not leaves, on the chooser,
 * a notice for this session only: one per such project, through UserText, with "Got it". Nothing is written anywhere.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryRoutes } from "../routes/library";
import { CURRENT_RW, LIBRARIES, libraryHandlers, PROJECTS, server, serviceError, testClient, url, useMockService } from "../test/service";
import { clearLostCreates } from "./lostCreates";

useMockService();
beforeEach(() => server.use(http.get(url("/tools"), () => serviceError(403, "FORBIDDEN", "The tools are managed from the desktop app."))));
afterEach(() => {
  clearLostCreates();
  window.history.replaceState(null, "", "/");
});

type User = ReturnType<typeof userEvent.setup>;

/** The library open, an event stream the test adds to, a create whose answer is lost and a list that then cannot be read. */
function serve() {
  const enc = new TextEncoder();
  const ctl = { stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined, posted: 0, listFails: false, open: true, writes: [] as string[] };
  const send = (type: string, data: unknown) => ctl.stream?.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  server.events.on("request:start", ({ request }) => {
    if (request.method !== "GET") ctl.writes.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  server.use(...libraryHandlers());
  server.use(
    http.get(url("/zotero/sync"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "No sync." } }, { status: 404 })),
    http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, ...(ctl.open ? { current: CURRENT_RW } : {}) })),
    http.post(url("/libraries/open"), () => {
      ctl.open = true;
      return HttpResponse.json(CURRENT_RW);
    }),
    http.post(url("/libraries/close"), () => HttpResponse.json({})),
    http.get(url("/libraries/suggested-folder"), () => HttpResponse.json({})),
    http.post(url("/projects"), () => {
      ctl.posted++;
      // The service stops answering just after the create: the list read to check it fails.
      ctl.listFails = true;
      return HttpResponse.error();
    }),
    http.get(url("/projects"), () => (ctl.listFails ? HttpResponse.error() : HttpResponse.json(PROJECTS))),
    http.get(url("/events"), () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl.stream = c;
          send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
        },
      });
      return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
    }),
  );
  const close = () => {
    ctl.open = false;
    act(() => send("library.state", { open: false }));
  };
  return { ctl, close };
}

async function createLost(user: User, name: string) {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), name);
  await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
  await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
  await user.click(within(dialog).getByRole("button", { name: "Create project" }));
  await within(dialog).findByRole("button", { name: "Check again" });
  return dialog;
}

const sentence = (project: string) =>
  `When “${project}” was being created in “Thesis library”, the app could not tell whether it was made. When you open that library again, look for “${project}” in its list of projects before creating it again.`;

const lostNotices = () => screen.queryAllByRole("status").filter((el) => /could not tell whether it was made/.test(el.textContent ?? ""));

afterEach(() => server.events.removeAllListeners());

describe("FR-194: “cannot tell” and a library's close", () => {
  it("in the dialog: the chooser says which project to look for, in which library; nothing is written; focus is not taken; “Got it” removes it and focus goes to the heading", async () => {
    const svc = serve();
    const user = userEvent.setup();
    render(<LibraryRoutes client={testClient()} />);
    await createLost(user, "Tide-line interviews");
    svc.close();
    await screen.findByRole("heading", { name: "Choose a library" });
    await waitFor(() => expect(lostNotices()).toHaveLength(1));
    const notice = lostNotices()[0]!;
    expect(notice.textContent).toBe(`${sentence("Tide-line interviews")} Got it`);
    expect([...notice.querySelectorAll("[dir=auto]")].map((el) => el.textContent)).toEqual(["Tide-line interviews", "Thesis library", "Tide-line interviews"]);
    expect(notice.contains(document.activeElement)).toBe(false);
    expect(svc.ctl.writes).toEqual(["POST /projects"]);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);

    await user.click(within(notice).getByRole("button", { name: "Got it" }));
    expect(lostNotices()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a library" })));
    expect(svc.ctl.writes).toEqual(["POST /projects"]);
  });

  it("one notice per project, from the library screen's notice and from the dialog; opening the library again keeps them; “Got it” moves focus to the next", async () => {
    const svc = serve();
    const user = userEvent.setup();
    render(<LibraryRoutes client={testClient()} />);
    const first = await createLost(user, "Tide-line interviews");
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("region", { name: "A project that may have been created" }).textContent).toMatch(/may have been created/));
    // The service answers again for a moment: the second create is sent, and its answer is lost too.
    svc.ctl.listFails = false;
    await createLost(user, "مقابلات هرات");
    svc.close();
    await screen.findByRole("heading", { name: "Choose a library" });
    await waitFor(() => expect(lostNotices()).toHaveLength(2));
    expect(lostNotices().map((n) => n.textContent)).toEqual([`${sentence("Tide-line interviews")} Got it`, `${sentence("مقابلات هرات")} Got it`]);
    // A right-to-left name is isolated on its own; the sentence keeps the interface's direction.
    expect([...lostNotices()[1]!.querySelectorAll("[dir=auto]")].map((el) => el.textContent)).toEqual(["مقابلات هرات", "Thesis library", "مقابلات هرات"]);

    // Opening the library again (the service answers again) does not remove them: the researcher still has to look.
    svc.ctl.listFails = false;
    await user.click(screen.getByRole("button", { name: "Open Thesis library" }));
    await screen.findByRole("navigation", { name: "Projects" });
    await user.click(screen.getByRole("button", { name: "Switch library" }));
    await screen.findByRole("heading", { name: "Choose a library" });
    expect(lostNotices()).toHaveLength(2);

    await user.click(within(lostNotices()[0]!).getByRole("button", { name: "Got it" }));
    expect(lostNotices()).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(within(lostNotices()[0]!).getByRole("button", { name: "Got it" })));
    await user.click(within(lostNotices()[0]!).getByRole("button", { name: "Got it" }));
    expect(lostNotices()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a library" })));
  });
});
