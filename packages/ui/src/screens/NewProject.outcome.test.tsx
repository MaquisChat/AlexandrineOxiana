/**
 * The new-project dialog, fix round 1 (R134): an answer lost after the service may have created the
 * project (I1), and leaving the recovery code before it is saved (I2).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { BASE, CURRENT_RW, LIBRARIES, libraryHandlers, PROJECTS, server, testApi, TOKEN, url, useMockService } from "../test/service";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { Library } from "./Library";

useMockService();

const RECOVERY = "R7QX-2M9P-KD4T-8HWN-C3VB-Y6FJ";
const NEW_OPEN = { id: "p3", name: "Tide-line interviews", folder: "Projects/Tide-line interviews", encrypted: false, unlocked: true, profiles: [] as string[] };
const NEW_ENC = { id: "p4", name: "Clinic follow-up", folder: "Projects/Clinic follow-up", encrypted: true, unlocked: true, profiles: ["hipaa"] };

interface Posted {
  name: string;
  encryption: { enabled: boolean; passphrase?: string };
}

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function Routed({ onSelected }: { onSelected: (id: string) => void }) {
  const [address, setAddress] = useState<string | undefined>();
  const api = useState(() => testApi())[0];
  return (
    <Library
      api={api}
      current={CURRENT_RW as never}
      projectFromAddress={address}
      onProjectSelected={(id) => {
        onSelected(id);
        setAddress(id);
      }}
    />
  );
}

async function openDialog(user: User) {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  return screen.findByRole("dialog", { name: "New project" });
}

async function fillOpen(dialog: HTMLElement, user: User) {
  await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), NEW_OPEN.name);
  await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
  await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
}

async function fillEncrypted(dialog: HTMLElement, user: User) {
  await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), NEW_ENC.name);
  await user.click(within(dialog).getByRole("checkbox", { name: "HIPAA" }));
  await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
  await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
}

/**
 * POST /projects whose answer is lost on the way (a network error), after `made` was created (or
 * nothing, with null). GET /projects lists `made` once it exists; `listFails` makes the reads after
 * the POST fail.
 */
function serveLost(made: typeof NEW_OPEN | typeof NEW_ENC | null) {
  const ctl = { posted: [] as Posted[], listFails: false, created: false };
  server.use(
    http.post(url("/projects"), async ({ request }) => {
      ctl.posted.push((await request.json()) as Posted);
      if (made) ctl.created = true;
      return HttpResponse.error();
    }),
    http.get(url("/projects"), () => {
      if (ctl.posted.length && ctl.listFails) return HttpResponse.error();
      return HttpResponse.json({ projects: [...PROJECTS.projects, ...(ctl.created && made ? [made] : [])] });
    }),
    ...libraryHandlers(),
  );
  return ctl;
}

describe("New project dialog: the answer is lost (R134 I1)", () => {
  it("an encrypted project that was created is not created again: its code cannot be shown, the passphrase opens it", async () => {
    const svc = serveLost(NEW_ENC);
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await fillEncrypted(dialog, user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    const found = await screen.findByRole("dialog", { name: "The project was created" });
    expect(found.textContent).toMatch(/recovery code could not be shown/i);
    expect(found.textContent).toMatch(/cannot be shown again/i);
    expect(found.textContent).toMatch(/opens with the passphrase you just chose/i);
    expect(found.textContent).toMatch(/planned/i);
    expect(within(found).queryByRole("button", { name: /recovery code/i })).toBeNull();
    expect(within(found).queryByRole("button", { name: "Create project" })).toBeNull();
    expect(svc.posted).toHaveLength(1);

    await user.click(within(found).getByRole("button", { name: "Open the project" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(svc.posted).toHaveLength(1);
    expect(selected).toHaveBeenLastCalledWith("p4");
    const nav = screen.getByRole("navigation", { name: "Projects" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Clinic follow-up/ }).getAttribute("aria-current")).toBe("true"));
  });

  it("an unencrypted project that was created is said to be created, and selected", async () => {
    const svc = serveLost(NEW_OPEN);
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await fillOpen(dialog, user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    const found = await screen.findByRole("dialog", { name: "The project was created" });
    expect(found.textContent).not.toMatch(/recovery code/i);
    await user.click(within(found).getByRole("button", { name: "Open the project" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selected).toHaveBeenLastCalledWith("p3");
    expect(svc.posted).toHaveLength(1);
  });

  it("when nothing was created, says so and allows creating it again", async () => {
    const svc = serveLost(null);
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await fillOpen(dialog, user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/was not created/i));
    const create = within(dialog).getByRole("button", { name: "Create project" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    await user.click(create);
    await waitFor(() => expect(svc.posted).toHaveLength(2));
  });

  it("when the list cannot be read again, does not resend: it cannot tell, and offers Check again", async () => {
    const svc = serveLost(NEW_OPEN);
    svc.listFails = true;
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await fillOpen(dialog, user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await within(dialog).findByRole("button", { name: "Check again" });
    expect(within(dialog).getByRole("alert").textContent).toMatch(/cannot tell whether the project was created/i);
    expect(within(dialog).getByRole("button", { name: "Create project" })).toHaveProperty("disabled", true);
    fireEvent.submit(dialog.querySelector("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.posted).toHaveLength(1);

    // Still unreadable: still cannot tell.
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/cannot tell/i));
    await within(dialog).findByRole("button", { name: "Check again" });
    expect(svc.posted).toHaveLength(1);

    svc.listFails = false;
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    const found = await screen.findByRole("dialog", { name: "The project was created" });
    await user.click(within(found).getByRole("button", { name: "Open the project" }));
    await waitFor(() => expect(selected).toHaveBeenLastCalledWith("p3"));
    expect(svc.posted).toHaveLength(1);
  });

  it("two submissions at once send one request", async () => {
    const posted: Posted[] = [];
    server.use(
      http.post(url("/projects"), async ({ request }) => {
        posted.push((await request.json()) as Posted);
        return HttpResponse.json({ project: NEW_OPEN });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await fillOpen(dialog, user);
    const form = dialog.querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toHaveLength(1);
  });
});

/** An event stream the test can add to after it opened. */
function controllableEvents() {
  const enc = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (type: string, data: unknown) => ctl?.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  const handler = http.get(url("/events"), () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
      },
    });
    return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
  });
  return { handler, send };
}

async function toRecoveryStep(user: User) {
  const dialog = await openDialog(user);
  await fillEncrypted(dialog, user);
  await user.click(within(dialog).getByRole("button", { name: "Create project" }));
  return screen.findByRole("dialog", { name: "Save the recovery code" });
}

const beforeUnloadPrevented = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

const encryptedCreate = () => http.post(url("/projects"), () => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));

async function confirmAndClose(step: HTMLElement, user: User) {
  await user.click(within(step).getByRole("checkbox", { name: "I have saved the recovery code" }));
  await user.click(within(step).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("New project dialog: the recovery code cannot be left unsaved (R134 I2)", () => {
  it("guards unloading only while the code is on screen and unconfirmed", async () => {
    server.use(encryptedCreate(), ...libraryHandlers());
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    await screen.findByRole("button", { name: "New project" });
    expect(beforeUnloadPrevented()).toBe(false);
    const step = await toRecoveryStep(user);
    expect(beforeUnloadPrevented()).toBe(true);
    await confirmAndClose(step, user);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  describe("in the app", () => {
    function appAtLibrary() {
      // The previous entry is another screen: Back would leave the library.
      window.history.replaceState(null, "", "/settings/appearance");
      window.history.pushState(null, "", "/");
      server.use(
        encryptedCreate(),
        http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW })),
        http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
        http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
        ...libraryHandlers(),
      );
      return render(<App service={{ baseUrl: BASE, token: TOKEN }} />);
    }

    it("Back keeps the dialog and the code, and says why", async () => {
      const user = userEvent.setup();
      appAtLibrary();
      const step = await toRecoveryStep(user);
      await act(async () => {
        window.history.back();
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(await within(step).findByText(/Save the recovery code first/)).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
      expect(within(step).getByText(RECOVERY)).toBeTruthy();
      expect(window.location.pathname).toBe("/");
      expect(JSON.stringify(window.history.state ?? null)).not.toContain(RECOVERY);
      await confirmAndClose(step, user);
      expect(window.location.href).not.toContain(RECOVERY);
    });

    it("an in-app link keeps the dialog and the code, and says why; once saved, links work again", async () => {
      const user = userEvent.setup();
      appAtLibrary();
      const step = await toRecoveryStep(user);
      fireEvent.click(screen.getByRole("link", { name: "Appearance", hidden: true }));
      expect(await within(step).findByText(/Save the recovery code first/)).toBeTruthy();
      expect(window.location.pathname).toBe("/");
      expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
      await confirmAndClose(step, user);
      fireEvent.click(screen.getByRole("link", { name: "Appearance" }));
      await waitFor(() => expect(window.location.pathname).toBe("/settings/appearance"));
    });
  });

  it("a library closed underneath keeps the code until it is confirmed, then goes back to the chooser", async () => {
    const events = controllableEvents();
    server.use(encryptedCreate(), events.handler, ...libraryHandlers());
    const onClosed = vi.fn();
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} onClosed={onClosed} />);
    const step = await toRecoveryStep(user);
    act(() => events.send("library.state", { open: false }));
    expect(await within(step).findByText(/library was closed/i)).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();
    expect(within(step).getByText(RECOVERY)).toBeTruthy();
    await confirmAndClose(step, user);
    expect(onClosed).toHaveBeenCalled();
  });
});

// ---- Fix round 2: the "cannot tell" state can no longer be left silently ----

/** Lost answer, then a list that cannot be read: the dialog says it cannot tell. */
async function toCannotTell(user: User, fill: (d: HTMLElement, u: User) => Promise<void>) {
  const dialog = await openDialog(user);
  await fill(dialog, user);
  await user.click(within(dialog).getByRole("button", { name: "Create project" }));
  await within(dialog).findByRole("button", { name: "Check again" });
  return dialog;
}

const notice = () => screen.getByRole("region", { name: "A project that may have been created" });

describe("New project dialog: an unknown outcome is never left behind (fix round 2)", () => {
  it("closing while it cannot tell, then reopening and submitting again, does not post without the same-name warning", async () => {
    const svc = serveLost(NEW_OPEN);
    svc.listFails = true;
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    await toCannotTell(user, fillOpen);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    svc.listFails = false;
    const again = await openDialog(user);
    await fillOpen(again, user);
    await user.click(within(again).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(within(again).getByRole("alert").textContent).toMatch(/A project named “Tide-line interviews” already exists\. Create another with the same name\?/));
    expect(svc.posted).toHaveLength(1);
  });

  it("the library re-reads its project list whenever the dialog closes", async () => {
    let lists = 0;
    let created = false;
    server.use(
      http.get(url("/projects"), () => {
        lists++;
        return HttpResponse.json({ projects: [...PROJECTS.projects, ...(created ? [NEW_OPEN] : [])] });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    const before = lists;
    // Made elsewhere meanwhile (or by an answer that was lost): shown once the dialog closes.
    created = true;
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(lists).toBe(before + 1));
    const nav = screen.getByRole("navigation", { name: "Projects" });
    expect(await within(nav).findByRole("button", { name: /Tide-line interviews/ })).toBeTruthy();
  });

  it("a name already in use asks first: confirming creates another, declining sends nothing", async () => {
    const posted: Posted[] = [];
    server.use(
      http.post(url("/projects"), async ({ request }) => {
        posted.push((await request.json()) as Posted);
        return HttpResponse.json({ project: { ...NEW_OPEN, id: "p7", name: "Dissertation" } });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Dissertation");
    await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/A project named “Dissertation” already exists\. Create another with the same name\?/));
    expect(posted).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Change the name" }));
    expect(posted).toHaveLength(0);
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Project name" }));

    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await user.click(await within(dialog).findByRole("button", { name: "Create another" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.name).toBe("Dissertation");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an encrypted project: closing leaves a notice that stays until a check succeeds and reports the outcome", async () => {
    const svc = serveLost(NEW_ENC);
    svc.listFails = true;
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    await toCannotTell(user, fillEncrypted);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(notice().textContent).toMatch(/“Clinic follow-up” may have been created/);
    expect(notice().textContent).toMatch(/recovery code was not shown and cannot be shown again/i);
    // Focus is back on New project; the next stop is the notice's Check again.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New project" }));
    await user.tab();
    expect(document.activeElement).toBe(within(notice()).getByRole("button", { name: "Check again" }));

    // Still unreadable: the notice stays.
    await user.click(within(notice()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(notice().textContent).toMatch(/still cannot tell/i));

    svc.listFails = false;
    await user.click(within(notice()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(notice().textContent).toMatch(/“Clinic follow-up” was created/));
    expect(notice().textContent).toMatch(/opens with the passphrase you chose/i);
    await user.click(within(notice()).getByRole("button", { name: "Open the project" }));
    await waitFor(() => expect(selected).toHaveBeenLastCalledWith("p4"));
    expect(screen.queryByRole("region", { name: "A project that may have been created" })).toBeNull();
    expect(svc.posted).toHaveLength(1);
  });

  it("an unencrypted project: the notice says nothing of a recovery code, and reports one that was not created", async () => {
    const svc = serveLost(null);
    svc.listFails = true;
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    await toCannotTell(user, fillOpen);
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(notice().textContent).toMatch(/“Tide-line interviews” may have been created/);
    expect(notice().textContent).not.toMatch(/recovery code/i);

    svc.listFails = false;
    await user.click(within(notice()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(notice().textContent).toMatch(/“Tide-line interviews” was not created/));
    await user.click(within(notice()).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "A project that may have been created" })).toBeNull();
    expect(svc.posted).toHaveLength(1);
  });
});
