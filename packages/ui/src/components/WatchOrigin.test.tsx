import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
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
  presence: "local",
  ...o,
});

const CHANGED = "The file in the folder has changed since it was brought in. The library's copy is unchanged.";
const BRING = "Bring in the new version as a new file of this source";
const KEEP = "Keep the library's copy as it is";
const NOT_HERE = "The new version is not downloaded to this Mac (2 MB). Download it with your cloud drive's app, then bring it in here.";
const CANNOT_TELL = "The app cannot tell at the moment whether the new version is downloaded to this Mac. Open Watched folders to see how this folder is doing.";

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

const ui = (props: { sourceId?: string; readOnly?: boolean; onChanged?: () => void } = {}) => (
  <WatchOrigin api={testApi().watchedFolders} projectId="p1" sourceId={props.sourceId ?? "s1"} readOnly={props.readOnly ?? false} {...(props.onChanged ? { onChanged: props.onChanged } : {})} />
);

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

  it("onChanged is called once after a file was added, and not after a keep, a refusal or an already-there answer (R239 a)", async () => {
    const onChanged = vi.fn();
    const svc = service([origin()]);
    svc.acting(() => {
      svc.set([origin({ state: "in-library" })]);
      return HttpResponse.json({ done: "attached", sourceId: "s1" });
    });
    const user = userEvent.setup();
    const { unmount } = render(ui({ onChanged }));
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${BRING}`) }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The new version was added to this source."));
    expect(onChanged).toHaveBeenCalledTimes(1);
    unmount();

    const other = vi.fn();
    const svc2 = service([origin()]);
    svc2.acting(() => HttpResponse.json({ done: "settled", sourceId: "s1" }));
    const r2 = render(ui({ onChanged: other }));
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    await waitFor(() => expect(svc2.seen.reads).toBe(2));
    r2.unmount();

    const svc3 = service([origin()]);
    svc3.acting(() => HttpResponse.json({ done: "already-there", sourceId: "s1" }));
    render(ui({ onChanged: other }));
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${BRING}`) }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The library already has this version of the file. Nothing was added."));
    expect(other).not.toHaveBeenCalled();
  });

  it("after an act whose buttons go away, focus is on the region's heading; after a refusal it stays on the button pressed (R145)", async () => {
    const svc = service([origin()]);
    svc.acting(() => {
      svc.set([origin({ state: "settled" })]);
      return HttpResponse.json({ done: "settled", sourceId: "s1" });
    });
    const user = userEvent.setup();
    const { unmount } = render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    const heading = await screen.findByRole("heading", { name: "Watched folder" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
    unmount();

    const svc2 = service([origin()]);
    svc2.acting(() => serviceError(503, "UNAVAILABLE", "The folder did not answer. Try again when it is reachable."));
    render(ui());
    const keep = await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) });
    await user.click(keep);
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(keep);
  });

  it("after a refusal focus is put back on the pressed button even when the browser dropped it while it was disabled (N1)", async () => {
    const svc = service([origin()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    svc.acting(async () => {
      await gate;
      return serviceError(503, "UNAVAILABLE", "The folder did not answer. Try again when it is reachable.");
    });
    const user = userEvent.setup();
    render(ui());
    const keep = await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) });
    await user.click(keep);
    await waitFor(() => expect((keep as HTMLButtonElement).disabled).toBe(true));
    // The browser dropped the focus while the button was disabled: it is somewhere else now.
    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    release();
    await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(keep));
  });

  it("when the re-read after a successful act fails, focus goes to \"Try again\", not the page body (N2)", async () => {
    let reads = 0;
    server.use(
      http.get(url(ORIGIN), () => {
        reads++;
        return reads === 1 ? HttpResponse.json({ origins: [origin()] }) : serviceError(500, "INTERNAL", "boom");
      }),
      http.post(url(ACTION), () => HttpResponse.json({ done: "settled", sourceId: "s1" })),
    );
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    const again = await screen.findByRole("button", { name: "Try again" });
    await waitFor(() => expect(document.activeElement).toBe(again));
  });

  it("a removed folder offers no bring-in and no download advice, only keeping", async () => {
    service([origin({ folderRemoved: true, folderLabel: "", presence: "unknown" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(within(region).queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull();
    expect(region.textContent).not.toContain("Download it with your cloud drive's app");
    expect(region.textContent).not.toContain(CANNOT_TELL); // no folder to look at on Watched folders
    expect(within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) })).toBeTruthy();
  });

  it("the locked sentence is visible once", async () => {
    const svc = service([origin()]);
    svc.acting(() => serviceError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed."));
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${KEEP}`) }));
    await screen.findByRole("alert");
    expect(screen.getAllByText("This project is locked. Its passphrase is needed.")).toHaveLength(1);
  });

  it("Try again is off while it reads: a double click makes one read", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(url(ORIGIN), async () => {
        reads++;
        if (reads === 1) return serviceError(500, "INTERNAL", "boom");
        await gate;
        return HttpResponse.json({ origins: [] });
      }),
    );
    const user = userEvent.setup();
    render(ui());
    const again = await screen.findByRole("button", { name: "Try again" });
    await user.click(again);
    await user.click(again);
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    expect(reads).toBe(2);
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

  it("may-have-changed offers no reading: the sentence and no button at all", async () => {
    service([origin({ state: "may-have-changed", presence: "not-downloaded" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(
      "The file in the folder was replaced or edited, but it is not downloaded to this Mac, so the app cannot yet tell what changed. The library's copy is unchanged.",
    );
    expect(region.textContent).not.toContain(NOT_HERE);
    expect(region.textContent).not.toContain(CANNOT_TELL);
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("gone says the library's copy is unchanged and offers only to keep it", async () => {
    service([origin({ state: "gone" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain("The file is no longer in the watched folder. The library's copy is unchanged.");
    expect(within(region).queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull();
    expect(within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) })).toBeTruthy();
  });

  it("R251: presence \"local\" offers the button and says nothing about downloading", async () => {
    service([origin({ presence: "local" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
    expect((within(region).getByRole("button", { name: new RegExp(`^${BRING}`) }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) })).toBeTruthy();
    expect(region.textContent).not.toContain("not downloaded to this Mac");
    expect(region.textContent).not.toContain(CANNOT_TELL);
  });

  it("R251: presence \"not-downloaded\" says R235's sentence exactly, with no bring-in button; keeping is still offered", async () => {
    service([origin({ presence: "not-downloaded" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
    expect(within(region).getByText(NOT_HERE).textContent).toBe(NOT_HERE);
    expect(within(region).queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull();
    expect(within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) })).toBeTruthy();
    expect(region.textContent).not.toContain(CANNOT_TELL);
  });

  it("R251: presence \"unknown\" says the app cannot tell, with no bring-in button; keeping is still offered", async () => {
    service([origin({ presence: "unknown" })]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
    expect(within(region).getByText(CANNOT_TELL).textContent).toBe(CANNOT_TELL);
    expect(within(region).queryByRole("button", { name: new RegExp(`^${BRING}`) })).toBeNull();
    expect(within(region).getByRole("button", { name: new RegExp(`^${KEEP}`) })).toBeTruthy();
    expect(region.textContent).not.toContain("not downloaded to this Mac (");
  });

  it("a changed file judged on this Mac whose hint is out of date: the press shows the service's 409 sentence and changes nothing", async () => {
    const svc = service([origin({ presence: "local" })]);
    svc.acting(() => serviceError(409, "CONFLICT", "That file is not downloaded to this Mac, so it was not read."));
    const user = userEvent.setup();
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain(CHANGED);
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
    const { newBytes: _n, ...noSize } = origin({ presence: "not-downloaded" });
    service([noSize]);
    render(ui());
    const region = await screen.findByRole("region", { name: "Watched folder" });
    expect(region.textContent).toContain("The new version is not downloaded to this Mac. Download it with your cloud drive's app, then bring it in here.");
    expect(region.textContent).not.toContain("()");
  });

  it("no changing request fires without a click", async () => {
    const svc = service([origin({ presence: "not-downloaded" }), origin({ watchId: "w2", state: "gone" }), origin({ watchId: "w3", presence: "unknown" })]);
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
