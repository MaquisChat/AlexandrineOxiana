/**
 * "New recovery code…" (Task 61, R134 c): for an unlocked encrypted project, the passphrase again,
 * then the new code shown once exactly as at creation (RecoveryCodeStep).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEAVE_REFUSED } from "../components/RecoveryCodeStep";
import { navigate } from "../navigation";
import { CURRENT_RW, libraryHandlers, server, serviceError, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

const CODE = "K7QX-2M9P-KD4T-8HWN-C3VB-Y6FJ-0A1B-2C3D";
const PASS = "correct horse battery";
const ENC = { id: "p4", name: "Clinic follow-up", folder: "Projects/Clinic follow-up", encrypted: true, unlocked: true, profiles: ["hipaa"] };
const OPEN = { id: "p1", name: "Dissertation", folder: "Dissertation", encrypted: false, unlocked: true, profiles: [] as string[] };
const LOCKED = { id: "p2", name: "Clinic interviews", folder: "Clinic interviews", encrypted: true, unlocked: false, profiles: ["hipaa"] };

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  window.history.replaceState(null, "", "/");
});

/** The project list (first one selected) and POST /projects/:id/recovery-code answered by `answer`. */
function serve(answer: () => Response, projects: unknown[] = [ENC, OPEN], extra: Parameters<typeof libraryHandlers>[0] = {}) {
  const posted: Array<{ id: string; body: unknown }> = [];
  server.use(
    http.get(url("/projects"), () => HttpResponse.json({ projects })),
    http.post(url("/projects/:id/recovery-code"), async ({ request, params }) => {
      posted.push({ id: String(params.id), body: await request.json() });
      return answer();
    }),
    ...libraryHandlers(extra),
  );
  return posted;
}

const issued = () => HttpResponse.json({ recoveryCode: CODE });

async function openDialog(user: User) {
  await user.click(await screen.findByRole("button", { name: "New recovery code…" }));
  return screen.findByRole("dialog", { name: "New recovery code" });
}

async function ask(dialog: HTMLElement, user: User, pass = PASS) {
  await user.type(within(dialog).getByLabelText("Passphrase"), pass);
  await user.click(within(dialog).getByRole("button", { name: "Issue new recovery code" }));
}

async function confirmAndClose(step: HTMLElement, user: User) {
  await user.click(within(step).getByRole("checkbox", { name: "I have saved the recovery code" }));
  await user.click(within(step).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const beforeUnloadPrevented = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe("New recovery code dialog", () => {
  it("explains, asks for the passphrase, then shows the new code once with the same saved-it step", async () => {
    const posted = serve(issued);
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const log = vi.spyOn(console, "log");
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const opener = await screen.findByRole("button", { name: "New recovery code…" });
    const dialog = await openDialog(user);
    expect(dialog.textContent).toMatch(/current recovery code stops working/i);
    expect(dialog.textContent).toMatch(/backups made before now/i);
    expect(dialog.textContent).toMatch(/passphrase keeps working/i);
    expect(within(dialog).getByText("Clinic follow-up").getAttribute("dir")).toBe("auto");
    await ask(dialog, user);

    const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
    expect(document.activeElement).toBe(within(step).getByRole("heading", { name: "Save the recovery code" }));
    expect(posted).toEqual([{ id: "p4", body: { passphrase: PASS } }]);
    const code = within(step).getByText(CODE);
    expect(code.getAttribute("dir")).toBe("auto");
    expect(step.textContent).toMatch(/only time/i);
    expect(step.textContent).toMatch(/old recovery code no longer works/i);
    expect(step.textContent).toMatch(/backups made before now/i);
    // Not skippable: no Cancel, Escape does nothing, Done is off until confirmed.
    expect(within(step).queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
    expect(within(step).getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);
    await user.click(within(step).getByRole("button", { name: "Copy recovery code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));
    await confirmAndClose(step, user);
    // Focus goes back to the button that opened it; the code is gone and never kept.
    expect(document.activeElement).toBe(opener);
    expect(document.body.textContent).not.toContain(CODE);
    expect(window.location.href).not.toContain(CODE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PASS);
    log.mockRestore();
  });

  it("a wrong passphrase is said plainly; the field is marked and cleared, and nothing else changes", async () => {
    let n = 0;
    const posted = serve(() => (n++ === 0 ? serviceError(401, "WRONG_PASSPHRASE", "That passphrase is not correct.") : issued()));
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dialog = await openDialog(user);
    await ask(dialog, user, "not it");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/passphrase is not correct/i);
    const field = within(dialog).getByLabelText("Passphrase") as HTMLInputElement;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(alert.textContent).toMatch(/still works/i);
    await ask(dialog, user);
    expect(await screen.findByRole("dialog", { name: "Save the recovery code" })).toBeTruthy();
    expect(posted).toHaveLength(2);
  });

  it("asks for the passphrase before asking the service", async () => {
    const posted = serve(issued);
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Issue new recovery code" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/enter the project's passphrase/i);
    expect(posted).toHaveLength(0);
  });

  it("a lost answer says a new code may have been issued and could not be shown, the old one may no longer work, and to ask again; it never resends by itself", async () => {
    let n = 0;
    const posted = serve(() => (n++ === 0 ? HttpResponse.error() : issued()));
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dialog = await openDialog(user);
    await ask(dialog, user);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/could not be shown/i);
    expect(alert.textContent).toMatch(/old recovery code no longer works/i);
    expect(alert.textContent).toMatch(/ask again/i);
    expect(alert.textContent).toMatch(/safe/i);
    await new Promise((r) => setTimeout(r, 30));
    expect(posted).toHaveLength(1);
    // Asking again is the same request, and shows the newest code.
    await ask(dialog, user);
    expect(await screen.findByRole("dialog", { name: "Save the recovery code" })).toBeTruthy();
    expect(posted).toHaveLength(2);
  });

  it("a 5xx is treated like a lost answer", async () => {
    serve(() => serviceError(500, "INTERNAL", "Something went wrong."));
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dialog = await openDialog(user);
    await ask(dialog, user);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/could not be shown/i);
  });

  it("other refusals are shown in plain words (too many tries, read-only, a policy denial)", async () => {
    serve(() => serviceError(429, "RATE_LIMITED", "Too many wrong passphrases for this project. Wait a minute, then try again."));
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dialog = await openDialog(user);
    await ask(dialog, user);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/wait a minute/i);
  });

  it("guards leaving while the new code is on screen and unconfirmed: unload asks, in-app navigation is refused", async () => {
    serve(issued);
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dialog = await openDialog(user);
    expect(beforeUnloadPrevented()).toBe(false);
    await ask(dialog, user);
    const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
    expect(beforeUnloadPrevented()).toBe(true);
    act(() => navigate("/settings/appearance"));
    expect(await within(step).findByText(LEAVE_REFUSED)).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    await confirmAndClose(step, user);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("works from the keyboard alone: focus starts in the passphrase, stays inside, Enter sends, Escape cancels and focus returns", async () => {
    const posted = serve(issued);
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const opener = await screen.findByRole("button", { name: "New recovery code…" });
    opener.focus();
    await user.keyboard("{Enter}");
    let dialog = await screen.findByRole("dialog", { name: "New recovery code" });
    const field = within(dialog).getByLabelText("Passphrase");
    expect(document.activeElement).toBe(field);
    expect(dialog.closest("[inert]")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Projects", hidden: true }).closest("[inert]")).not.toBeNull();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.tab();
    expect(document.activeElement).toBe(field);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(posted).toHaveLength(0);

    await user.keyboard("{Enter}");
    dialog = await screen.findByRole("dialog", { name: "New recovery code" });
    await user.keyboard(`${PASS}{Enter}`);
    const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
    const box = within(step).getByRole("checkbox", { name: "I have saved the recovery code" });
    while (document.activeElement !== box) await user.tab();
    await user.keyboard(" ");
    await user.tab();
    expect(document.activeElement).toBe(within(step).getByRole("button", { name: "Done" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(posted).toHaveLength(1);
  });

  it("a library closed underneath keeps the new code until it is confirmed, then leaves the library", async () => {
    const enc = new TextEncoder();
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const send = (type: string, data: unknown) => ctl?.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    serve(issued);
    // Added last, so it answers before the default event stream.
    server.use(
      http.get(url("/events"), () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c;
            send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
          },
        });
        return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    const onClosed = vi.fn();
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} onClosed={onClosed} />);
    const dialog = await openDialog(user);
    await ask(dialog, user);
    const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
    act(() => send("library.state", { open: false }));
    expect(await within(step).findByText(/library was closed/i)).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();
    expect(within(step).getByText(CODE)).toBeTruthy();
    await confirmAndClose(step, user);
    expect(onClosed).toHaveBeenCalled();
  });

  it("is offered only for an unlocked encrypted project, and is off in a read-only library", async () => {
    serve(issued, [OPEN, ENC]);
    const user = userEvent.setup();
    const { unmount } = render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await screen.findByRole("button", { name: "New project" });
    await screen.findByText("Dissertation");
    expect(screen.queryByRole("button", { name: "New recovery code…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Clinic follow-up/ }));
    expect(await screen.findByRole("button", { name: "New recovery code…" })).toBeTruthy();
    unmount();

    serve(issued, [LOCKED]);
    const locked = render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await screen.findByLabelText(/passphrase or recovery code/i);
    expect(screen.queryByRole("button", { name: "New recovery code…" })).toBeNull();
    locked.unmount();

    const ro = { libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "locked-by-other-device" };
    serve(issued, [ENC], { current: ro });
    render(<Library api={testApi()} current={ro as never} />);
    const button = await screen.findByRole("button", { name: "New recovery code…" });
    expect(button).toHaveProperty("disabled", true);
  });
});
