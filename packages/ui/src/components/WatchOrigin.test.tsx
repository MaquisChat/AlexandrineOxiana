import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { SourceWatchOriginResponse, WatchedFileActionRequest, WatchedSourceOrigin } from "@ao/shared";
import { server, serviceError, testApi, url, useMockService } from "../test/service";
import { WatchOrigin } from "./WatchOrigin";

useMockService();

const ORIGIN = "/projects/:id/sources/:sid/watch-origin";
const ACTION = "/projects/:id/sources/:sid/watch-origin/action";

const origin = (o: Partial<WatchedSourceOrigin> = {}): WatchedSourceOrigin => ({
  watchId: "w1",
  folderLabel: "Fieldwork",
  folderRemoved: false,
  file: "Interviews/ana.pdf",
  state: "changed",
  newBytes: 2_000_000,
  local: true,
  ...o,
});

const CHANGED = "The file in the folder has changed since it was brought in. The library's copy is unchanged.";
const BRING = "Bring in the new version as a new file of this source";
const KEEP = "Keep the library's copy as it is";

/** A scripted service: the origins it answers now, and every request it saw. */
function service(first: WatchedSourceOrigin[] | (() => WatchedSourceOrigin[])) {
  const seen = { reads: 0, acts: [] as WatchedFileActionRequest[], methods: [] as string[] };
  let current = first;
  server.use(
    http.get(url(ORIGIN), () => {
      seen.reads++;
      seen.methods.push("GET");
      const origins = typeof current === "function" ? current() : current;
      return HttpResponse.json({ origins } satisfies SourceWatchOriginResponse);
    }),
  );
  return {
    seen,
    set: (o: WatchedSourceOrigin[]) => {
      current = o;
    },
    acting(answer: () => Response | Promise<Response>) {
      server.use(
        http.post(url(ACTION), async ({ request }) => {
          seen.methods.push("POST");
          seen.acts.push((await request.json()) as WatchedFileActionRequest);
          return answer();
        }),
      );
    },
  };
}

const ui = (props: { sourceId?: string; readOnly?: boolean } = {}) => <WatchOrigin api={testApi().watchedFolders} projectId="p1" sourceId={props.sourceId ?? "s1"} readOnly={props.readOnly ?? false} />;

describe("WatchOrigin", () => {
  it("a source from no folder shows nothing at all and makes one read", async () => {
    const svc = service([]);
    const { container } = render(ui());
    await waitFor(() => expect(svc.seen.reads).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(svc.seen.reads).toBe(1);
  });

  it("says which folder and which file; the heading is \"Watched folder\"", async () => {
    service([origin({ state: "in-library" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(within(region).getByRole("heading", { name: "Watched folder" })).toBeTruthy();
    expect(region.textContent).toContain("Came from the watched folder “Fieldwork” as “Interviews/ana.pdf”.");
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("a removed folder is said in the plan's words", async () => {
    service([origin({ state: "in-library", folderRemoved: true, folderLabel: "" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain("Came from a folder that is no longer watched, as “Interviews/ana.pdf”.");
  });

  it("a changed file offers \"Bring in the new version as a new file of this source\" and adds an original, keeping the first", async () => {
    const svc = service([origin()]);
    svc.acting(() => {
      svc.set([origin({ state: "in-library" })]);
      return HttpResponse.json({ done: "attached", sourceId: "s1" });
    });
    const user = userEvent.setup();
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
    expect(region.textContent).not.toContain("not downloaded");
    const keep = within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) });
    await user.click(within(region).getByRole("button", { name: new RegExp(`^${BRING}`) }));
    await waitFor(() => expect(svc.seen.acts).toEqual([{ watchId: "w1", action: "bring-in-new-version" }]));
    // The outcome is said once, in a polite live region; the origin is read again and shown as the service now gives it.
    const live = await screen.findByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(live.textContent).toBe("The new version was added to this source."));
    await waitFor(() => expect(svc.seen.reads).toBe(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull());
    expect(region.textContent).not.toContain(CHANGED);
    expect(keep.isConnected).toBe(false);
  });

  it("\"Keep the library's copy as it is\" sends keep-as-it-is and says so", async () => {
    const svc = service([origin()]);
    svc.acting(() => {
      svc.set([origin({ state: "settled" })]);
      return HttpResponse.json({ done: "settled", sourceId: "s1" });
    });
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    await waitFor(() => expect(svc.seen.acts).toEqual([{ watchId: "w1", action: "keep-as-it-is" }]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Noted. The library's copy stays as it is."));
    await waitFor(() => expect(svc.seen.reads).toBe(2));
  });

  it("may-have-changed offers no reading: the sentence, no bring-in button", async () => {
    service([origin({ state: "may-have-changed", local: false })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(
      "The file in the folder was replaced or edited, but it is not downloaded to this Mac, so the app cannot yet tell what changed. The library's copy is unchanged.",
    );
    expect(within(region).queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull();
  });

  it("gone says the library's copy is unchanged and offers only to keep it", async () => {
    service([origin({ state: "gone" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain("The file is no longer in the watched folder. The library's copy is unchanged.");
    expect(within(region).queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull();
    expect(within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) })).toBeTruthy();
  });

  it("a changed file not on this Mac says so, keeps the button, and shows the service's 409 sentence", async () => {
    const svc = service([origin({ local: false })]);
    svc.acting(() => serviceError(409, "CONFLICT", "That file is not downloaded to this Mac, so it was not read."));
    const user = userEvent.setup();
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
    expect(region.textContent).toContain("The new version is not downloaded to this Mac (2 MB). Download it with your cloud drive's app, then bring it in here.");
    const bring = within(region).getByRole("button", { name: new RegExp(`^${BRING}`) }) as HTMLButtonElement;
    expect(bring.disabled).toBe(false);
    await user.click(bring);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That file is not downloaded to this Mac, so it was not read.");
    // Nothing changed: the origin is not read again and the button stays.
    expect(svc.seen.reads).toBe(1);
    expect(screen.getByRole("button", { name: new RegExp(`^${BRING}`) })).toBeTruthy();
    expect(screen.queryByRole("status")?.textContent ?? "").toBe("");
  });

  it("says it without a size when the size is not known", async () => {
    const { newBytes: _n, ...noSize } = origin({ local: false });
    service([noSize]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain("The new version is not downloaded to this Mac. Download it with your cloud drive's app, then bring it in here.");
    expect(region.textContent).not.toContain("()");
  });

  it("no changing request fires without a click", async () => {
    const svc = service([origin({ local: false }), origin({ watchId: "w2", state: "gone" })]);
    svc.acting(() => HttpResponse.json({ done: "settled", sourceId: "s1" }));
    render(ui());
    await screen.findByRole("region", { name: "Watched folder" });
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.seen.methods).toEqual(["GET"]);
  });

  it("two origins each have their own buttons, in the order given, and an act names its own watch", async () => {
    const svc = service([origin({ watchId: "wB", folderLabel: "Second", file: "b.pdf" }), origin({ watchId: "wA", folderLabel: "First", file: "a.pdf", state: "gone" })]);
    svc.acting(() => HttpResponse.json({ done: "settled", sourceId: "s1" }));
    const user = userEvent.setup();
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    const lines = within(region)
      .getAllByText(/Came from the watched folder/)
      .map((e) => e.textContent);
    expect(lines).toEqual(["Came from the watched folder “Second” as “b.pdf”.", "Came from the watched folder “First” as “a.pdf”."]);
    expect(within(region).getAllByRole("button", { name: /^Keep the library's copy as it is/ })).toHaveLength(2);
    expect(within(region).getAllByRole("button", { name: /^Bring in the new version/ })).toHaveLength(1);
    await user.click(within(region).getByRole("button", { name: /^Keep the library's copy as it is.*a\.pdf/ }));
    await waitFor(() => expect(svc.seen.acts).toEqual([{ watchId: "wA", action: "keep-as-it-is" }]));
  });

  it("while an act is pending both buttons of that origin are disabled, and a second click sends nothing", async () => {
    const svc = service([origin()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    svc.acting(async () => {
      await gate;
      svc.set([origin({ state: "settled" })]);
      return HttpResponse.json({ done: "settled", sourceId: "s1" });
    });
    const user = userEvent.setup();
    render(ui());
    const keep = (await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) })) as HTMLButtonElement;
    const bring = screen.getByRole("button", { name: new RegExp(`^${BRING}`) }) as HTMLButtonElement;
    await user.click(keep);
    await waitFor(() => expect(keep.disabled).toBe(true));
    expect(bring.disabled).toBe(true);
    await user.click(keep);
    await user.click(bring);
    release();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Noted. The library's copy stays as it is."));
    expect(svc.seen.acts).toHaveLength(1);
  });

  it("a refusal (503: the folder did not answer) shows the service's sentence in an alert and changes nothing", async () => {
    const svc = service([origin()]);
    svc.acting(() => serviceError(503, "UNAVAILABLE", "The folder did not answer. Try again when it is reachable."));
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    expect((await screen.findByRole("alert")).textContent).toBe("The folder did not answer. Try again when it is reachable.");
    expect(svc.seen.reads).toBe(1);
    expect((screen.getByRole("button", { name: new RegExp(`^${KEEP}`) }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refusal for a wrong state (400) is shown in the service's words", async () => {
    const svc = service([origin()]);
    svc.acting(() => serviceError(400, "VALIDATION", "There is nothing to settle for this file: it is as it came in."));
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    expect((await screen.findByRole("alert")).textContent).toBe("There is nothing to settle for this file: it is as it came in.");
  });

  it("read-only disables the actions with the reason, visible once; the sentences still show", async () => {
    service([origin(), origin({ watchId: "w2", state: "gone", file: "b.pdf" })]);
    render(ui({ readOnly: true }));
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
    for (const b of within(region).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(within(region).getAllByText("This library is read-only, so nothing can be changed now.")).toHaveLength(1);
  });

  it("a locked project (the service says so to an act) disables the buttons with the reason", async () => {
    const svc = service([origin()]);
    svc.acting(() => serviceError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed."));
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    await screen.findByRole("alert");
    const region = screen.getByRole("region", { name: "Watched folder" });
    for (const b of within(region).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(within(region).getAllByText("This project is locked. Its passphrase is needed.").length).toBeGreaterThanOrEqual(1);
  });

  it("names go through UserText: marked dir=auto, set as text, never as markup", async () => {
    service([origin({ folderLabel: "<img src=x onerror=alert(1)> مجلد", file: "<b>دراسة</b>.pdf", state: "gone" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.querySelector("img")).toBeNull();
    expect(region.querySelector("b")).toBeNull();
    const label = within(region).getByText("<img src=x onerror=alert(1)> مجلد");
    expect(label.getAttribute("dir")).toBe("auto");
    const file = within(region).getByText("<b>دراسة</b>.pdf");
    expect(file.getAttribute("dir")).toBe("auto");
  });

  it("the buttons' names include the file's name", async () => {
    service([origin({ file: "ana.pdf" })]);
    render(ui());
    expect(await screen.findByRole("button", { name: `${BRING}: “ana.pdf”` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `${KEEP}: “ana.pdf”` })).toBeTruthy();
  });

  it("a failed read shows the quiet line and Try again, and nothing else; Try again reads once more", async () => {
    let fail = true;
    let reads = 0;
    server.use(
      http.get(url(ORIGIN), () => {
        reads++;
        return fail ? serviceError(500, "INTERNAL", "boom") : HttpResponse.json({ origins: [origin({ state: "in-library" })] });
      }),
    );
    const user = userEvent.setup();
    const { container } = render(ui());
    expect(await screen.findByText("Where this source came from could not be shown.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Watched folder" });
    expect(reads).toBe(2);
    expect(screen.queryByText("Where this source came from could not be shown.")).toBeNull();
  });

  it("a late answer for another source is dropped", async () => {
    let releaseS1!: () => void;
    const gate = new Promise<void>((r) => (releaseS1 = r));
    server.use(
      http.get(url(ORIGIN), async ({ params }) => {
        if (params.sid === "s1") {
          await gate;
          return HttpResponse.json({ origins: [origin({ file: "from-s1.pdf", state: "in-library" })] });
        }
        return HttpResponse.json({ origins: [origin({ file: "from-s2.pdf", state: "in-library" })] });
      }),
    );
    const { rerender } = render(ui({ sourceId: "s1" }));
    rerender(ui({ sourceId: "s2" }));
    await screen.findByText(/from-s2\.pdf/);
    releaseS1();
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByText(/from-s1\.pdf/)).toBeNull();
    expect(screen.getByText(/from-s2\.pdf/)).toBeTruthy();
  });

  it("an act answered after the screen moved to another source is dropped (no outcome, no second read of it)", async () => {
    const svc = service([origin()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    svc.acting(async () => {
      await gate;
      return HttpResponse.json({ done: "settled", sourceId: "s1" });
    });
    const user = userEvent.setup();
    const { rerender } = render(ui({ sourceId: "s1" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    await waitFor(() => expect(svc.seen.acts).toHaveLength(1));
    svc.set([]);
    rerender(ui({ sourceId: "s2" }));
    await waitFor(() => expect(svc.seen.reads).toBe(2));
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(svc.seen.reads).toBe(2);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
