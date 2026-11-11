import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { CURRENT_RW, libraryHandlers, server, SOURCES, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

function renderLibrary(current: Record<string, unknown> = CURRENT_RW) {
  return render(<Library api={testApi()} current={current as never} />);
}

function drop(zone: HTMLElement, paths: string[]) {
  const uriList = paths.map((p) => `file://${p.split("/").map(encodeURIComponent).join("/")}`).join("\r\n");
  fireEvent.drop(zone, { dataTransfer: { types: ["text/uri-list"], getData: (t: string) => (t === "text/uri-list" ? uriList : ""), files: [] } });
}

describe("Library screen", () => {
  it("lists projects with their compliance profile badges, and marks locked ones", async () => {
    server.use(...libraryHandlers());
    renderLibrary();
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    const diss = await within(nav).findByRole("button", { name: /Dissertation/ });
    await waitFor(() => expect(diss.textContent).toMatch(/IRB/));
    expect(diss.textContent).toMatch(/GDPR/);
    const clinic = within(nav).getByRole("button", { name: /Clinic interviews/ });
    await waitFor(() => expect(clinic.textContent).toMatch(/HIPAA/));
    expect(clinic.textContent).toMatch(/Locked/);
  });

  it("shows nested collections, tags and the project's sources", async () => {
    server.use(...libraryHandlers());
    renderLibrary();
    const tree = await screen.findByRole("tree", { name: "Collections" });
    const ch1 = await within(tree).findByRole("treeitem", { name: "Chapter 1" });
    expect(ch1.getAttribute("aria-level")).toBe("1");
    expect(within(tree).getByRole("treeitem", { name: "Interviews" }).getAttribute("aria-level")).toBe("2");
    expect(within(tree).getByRole("treeitem", { name: "Field notes" }).getAttribute("aria-level")).toBe("3");
    expect(within(tree).getByRole("treeitem", { name: "Chapter 2" }).getAttribute("aria-level")).toBe("1");

    const tags = screen.getByRole("region", { name: "Tags" });
    expect(await within(tags).findByText("to read")).toBeTruthy();
    expect(within(tags).getByText("methods")).toBeTruthy();

    const table = await screen.findByRole("table", { name: "Sources" });
    expect(await within(table).findByText("Ethnography at Work")).toBeTruthy();
    const arabic = within(table).getByText("دراسة ميدانية");
    expect(arabic.getAttribute("dir")).toBe("auto");
    expect(within(table).getByText(/Needs review/)).toBeTruthy();
  });

  it("typing in search asks GET …/sources?text= once, 250 ms after the last key", async () => {
    const seen: Array<{ text: string | null; at: number }> = [];
    // The first matching handler wins: the recording one goes before the fixtures.
    server.use(
      http.get(url("/projects/:id/sources"), ({ request }) => {
        seen.push({ text: new URL(request.url).searchParams.get("text"), at: Date.now() });
        return HttpResponse.json(SOURCES);
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Ethnography at Work");
    const before = seen.length;
    const box = screen.getByRole("searchbox", { name: "Search sources" });
    await user.type(box, "ethno");
    const typedAt = Date.now();
    await new Promise((r) => setTimeout(r, 150));
    expect(seen.length).toBe(before);
    await waitFor(() => expect(seen.length).toBe(before + 1));
    expect(seen.at(-1)?.text).toBe("ethno");
    expect(seen.at(-1)!.at - typedAt).toBeGreaterThanOrEqual(200);
  });

  it("dropping files attaches them and shows each file's outcome; needs review links to the review queue", async () => {
    let body: unknown;
    server.use(
      ...libraryHandlers(),
      http.post(url("/projects/:id/attach"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          items: [
            { path: "/home/r/a.pdf", outcome: "created", sourceId: "s9" },
            { path: "/home/r/b.pdf", outcome: "needs-review", sourceId: "s10" },
            { path: "/home/r/c.pdf", outcome: "failed", reason: "The file could not be read." },
          ],
        });
      }),
    );
    renderLibrary();
    await screen.findByText("Ethnography at Work");
    drop(screen.getByRole("region", { name: /attach files/i }), ["/home/r/a.pdf", "/home/r/b.pdf", "/home/r/c.pdf"]);
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(body).toEqual({ paths: ["/home/r/a.pdf", "/home/r/b.pdf", "/home/r/c.pdf"] });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toMatch(/a\.pdf.*Added as a new source/);
    expect(within(items[1]!).getByRole("link", { name: /needs review/i }).getAttribute("href")).toBe("/import/review");
    expect(items[2]!.textContent).toMatch(/c\.pdf.*The file could not be read\./);
  });

  it("a read-only library shows the banner and disables the drop zone and edit buttons", async () => {
    const ro = { libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "locked-by-other-device" };
    server.use(...libraryHandlers({ current: ro }));
    renderLibrary(ro);
    await screen.findByText("Ethnography at Work");
    expect((await screen.findByText(/Read-only — locked by another device/)).closest("[role=status]")).toBeTruthy();
    expect(screen.getByRole("region", { name: /attach files/i }).getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("button", { name: "Attach files…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New collection" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New tag" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Rename tag to read" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the library state event's warnings appear in plain language", async () => {
    server.use(...libraryHandlers({ state: { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: { p1: ["backup-failed"] } } }));
    renderLibrary();
    expect(await screen.findByText(/last automatic backup of Dissertation failed/)).toBeTruthy();
  });

  it("index rebuilding progress from job.progress events", async () => {
    server.use(...libraryHandlers({ events: [{ type: "job.progress", data: { kind: "index", done: 3, total: 10 } }] }));
    renderLibrary();
    expect(await screen.findByText(/Index rebuilding 3\/10/)).toBeTruthy();
  });

  it("a locked encrypted project shows UnlockProject; a wrong passphrase says nothing was changed", async () => {
    let tries = 0;
    server.use(
      ...libraryHandlers(),
      http.post(url("/projects/:id/unlock"), async ({ request }) => {
        tries++;
        const { secret } = (await request.json()) as { secret: string };
        if (secret !== "right horse battery") return HttpResponse.json({ error: { code: "WRONG_PASSPHRASE", message: "x" } }, { status: 401 });
        return HttpResponse.json({ unlocked: true });
      }),
    );
    const user = userEvent.setup();
    renderLibrary();
    await user.click(await screen.findByRole("button", { name: /Clinic interviews/ }));
    const field = await screen.findByLabelText("Passphrase or recovery code");
    await user.type(field, "wrong");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That passphrase didn't unlock this project. Nothing was changed.");
    await user.clear(field);
    await user.type(field, "right horse battery");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByLabelText("Passphrase or recovery code")).toBeNull());
    expect(tries).toBe(2);
    expect(await screen.findByRole("table", { name: "Sources" })).toBeTruthy();
  });

  it("opening a source shows its details", async () => {
    server.use(...libraryHandlers());
    const user = userEvent.setup();
    renderLibrary();
    await user.click(await screen.findByRole("button", { name: "Ethnography at Work" }));
    const detail = await screen.findByRole("region", { name: "Source details" });
    expect(await within(detail).findByText("University Press")).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "Copy citation" })).toBeTruthy();
  });
});
