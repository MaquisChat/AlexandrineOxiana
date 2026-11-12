import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_RW, libraryHandlers, PROJECTS, server, SOURCES, serviceError, testApi, url, useMockService } from "../test/service";
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

  it("the library's name heading takes its direction from the text itself (D7)", async () => {
    server.use(...libraryHandlers());
    renderLibrary({ ...CURRENT_RW, name: "مكتبة الأطروحة" });
    const heading = await screen.findByRole("heading", { level: 1, name: "مكتبة الأطروحة" });
    expect(heading.getAttribute("dir")).toBe("auto");
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
    // It leads to the project's queue, at that source's entries (Task 67).
    expect(within(items[1]!).getByRole("link", { name: /needs review/i }).getAttribute("href")).toBe("/import/review?project=p1&source=s10");
    expect(items[2]!.textContent).toMatch(/c\.pdf.*The file could not be read\./);
  });

  it("links the project's review queue beside its other actions, with the count of waiting entries (Task 67)", async () => {
    const asked: Array<string | null> = [];
    server.use(
      http.get(url("/projects/:id/review"), ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("limit"));
        return HttpResponse.json({ items: [], total: 3, offset: 0, limit: 0 });
      }),
      ...libraryHandlers(),
    );
    renderLibrary();
    const header = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
    const link = await within(header).findByRole("link", { name: "Review queue (3 waiting)" });
    expect(link.getAttribute("href")).toBe("/import/review?project=p1");
    // Only the count is asked for.
    expect(asked.every((l) => l === "0")).toBe(true);
  });

  it("a row's Needs review badge leads to the project's queue at that source (Task 67)", async () => {
    server.use(...libraryHandlers());
    renderLibrary();
    const table = await screen.findByRole("table", { name: "Sources" });
    const badge = await within(table).findByRole("link", { name: /Needs review/ });
    expect(badge.getAttribute("href")).toBe("/import/review?project=p1&source=s2");
    expect(within(table).getAllByRole("link", { name: /Needs review/ })).toHaveLength(1);
  });

  it("a locked project's queue count is neither asked for nor shown (Task 67)", async () => {
    const asked: string[] = [];
    server.use(
      http.get(url("/projects/:id/review"), ({ params }) => {
        asked.push(String(params.id));
        return HttpResponse.json({ items: [], total: 5, offset: 0, limit: 0 });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    renderLibrary();
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    await screen.findByRole("link", { name: "Review queue (5 waiting)" });
    await user.click(within(nav).getByRole("button", { name: /Clinic interviews/ }));
    await screen.findByLabelText("Passphrase or recovery code");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: /Review queue/ })).toBeNull();
    expect(asked).not.toContain("p2");
  });

  it("names the device holding the lock: read-only (locked by <hostname>), from the library and its state events", async () => {
    const ro = { libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "locked-by-other-device", lockedBy: "field-laptop" };
    server.use(...libraryHandlers({ current: ro }));
    renderLibrary(ro);
    expect((await screen.findByText(/Read-only \(locked by field-laptop\)/)).closest("[role=status]")).toBeTruthy();
  });

  it("a lock taken while the library is open names the new holder from library.state", async () => {
    const st = { open: true, ...CURRENT_RW, mode: "read-only", readOnlyReason: "locked-by-other-device", lockedBy: "lab-mac", integrityWarnings: [], projectWarnings: {} };
    server.use(...libraryHandlers({ state: st }));
    renderLibrary();
    expect(await screen.findByText(/Read-only \(locked by lab-mac\)/)).toBeTruthy();
  });

  it("a read-only library offers no new project", async () => {
    server.use(...libraryHandlers({ current: { libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "not-writable" } }));
    renderLibrary({ libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "not-writable" });
    expect(await screen.findByRole("button", { name: "New project" })).toHaveProperty("disabled", true);
  });

  it("a read-only library shows the banner and disables the drop zone and edit buttons", async () => {
    const ro = { libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "locked-by-other-device" };
    server.use(...libraryHandlers({ current: ro }));
    renderLibrary(ro);
    await screen.findByText("Ethnography at Work");
    expect((await screen.findByText(/Read-only \(locked by another device\)/)).closest("[role=status]")).toBeTruthy();
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

  it("N3: when an index rebuild finishes the sources are read again, so the 'needs rebuilding' note goes", async () => {
    let calls = 0;
    let firstListed: () => void = () => {};
    const listed = new Promise<void>((r) => (firstListed = r));
    const enc = new TextEncoder();
    const frame = (type: string, data: unknown) => enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    server.use(
      http.get(url("/projects/:id/sources"), () => {
        calls++;
        if (calls === 1) setTimeout(firstListed, 0);
        return HttpResponse.json({ ...SOURCES, ...(calls === 1 ? { incomplete: true } : {}) });
      }),
      // The rebuild's last progress event arrives once the list (marked incomplete) is on screen.
      http.get(url("/events"), () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(frame("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} }));
            await listed;
            c.enqueue(frame("job.progress", { kind: "index", done: 10, total: 10 }));
          },
        });
        return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
      }),
      ...libraryHandlers(),
    );
    renderLibrary();
    expect(await screen.findByText(/needs rebuilding/)).toBeTruthy();
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText(/needs rebuilding/)).toBeNull());
  });

  it("index rebuilding progress from job.progress events", async () => {
    server.use(...libraryHandlers({ events: [{ type: "job.progress", data: { kind: "index", done: 3, total: 10 } }] }));
    renderLibrary();
    expect(await screen.findByText(/Index rebuilding 3\/10/)).toBeTruthy();
  });

  it("D8: while the index is rebuilt, the source list says so instead of showing an empty library, and fills in when it is ready", async () => {
    const rebuilding = { state: "rebuilding", done: 0, total: 0 };
    let calls = 0;
    server.use(
      http.get(url("/projects/:id/sources"), () => {
        calls++;
        return HttpResponse.json(calls === 1 ? { total: 0, items: [], index: rebuilding } : SOURCES);
      }),
      ...libraryHandlers({
        current: { ...CURRENT_RW, index: rebuilding },
        state: { open: true, ...CURRENT_RW, index: rebuilding, integrityWarnings: [], projectWarnings: {} },
        events: [
          { type: "job.progress", data: { kind: "index", done: 1, total: 4 } },
          { type: "library.state", data: { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} } },
        ],
      }),
    );
    renderLibrary({ ...CURRENT_RW, index: rebuilding });
    expect(await screen.findByText(/The library's search index is being rebuilt from its files/)).toBeTruthy();
    expect(screen.queryByText(/No sources/)).toBeNull();
    // Once it is ready the sources are read again.
    expect(await screen.findByText("Ethnography at Work", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/being rebuilt from its files/)).toBeNull();
  });

  it("D8: the rebuilding banner shows from the library's state, before any progress arrives", async () => {
    const rebuilding = { state: "rebuilding", done: 0, total: 0 };
    server.use(...libraryHandlers({ current: { ...CURRENT_RW, index: rebuilding }, state: { open: true, ...CURRENT_RW, index: rebuilding, integrityWarnings: [], projectWarnings: {} } }));
    renderLibrary({ ...CURRENT_RW, index: rebuilding });
    expect((await screen.findByText(/^Index rebuilding\./)).closest("[role=status]")).toBeTruthy();
  });

  it("D8: an index that could not be rebuilt says so plainly and points to “Rebuild library from folder”", async () => {
    const failed = { state: "failed", message: "The library's search index could not be rebuilt (disk trouble)." };
    server.use(...libraryHandlers({ current: { ...CURRENT_RW, index: failed }, state: { open: true, ...CURRENT_RW, index: failed, integrityWarnings: [], projectWarnings: {} } }));
    renderLibrary({ ...CURRENT_RW, index: failed });
    const banner = (await screen.findByText(/search index could not be rebuilt/)).closest("[role=status]") as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/Your sources are safe in the library folder/);
    expect(banner.textContent).not.toMatch(/disk trouble/);
    expect(within(banner).getByRole("link", { name: "Rebuild library from folder" }).getAttribute("href")).toBe("/missing-files");
  });

  it("D8: when the index could not be rebuilt and lists nothing, the list says so instead of “no sources”", async () => {
    const failed = { state: "failed", message: "x" };
    server.use(
      http.get(url("/projects/:id/sources"), () => HttpResponse.json({ total: 0, items: [], index: failed })),
      ...libraryHandlers({ current: { ...CURRENT_RW, index: failed }, state: { open: true, ...CURRENT_RW, index: failed, integrityWarnings: [], projectWarnings: {} } }),
    );
    renderLibrary({ ...CURRENT_RW, index: failed });
    expect(await screen.findByText(/The sources cannot be listed: the library's search index could not be rebuilt/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Sources" })).toBeNull();
  });

  it("C1: a partial index being rebuilt is never shown as a short list: “being rebuilt” in its place", async () => {
    const rebuilding = { state: "rebuilding", done: 0, total: 0, partial: true };
    server.use(
      http.get(url("/projects/:id/sources"), () => HttpResponse.json({ ...SOURCES, total: 1, items: SOURCES.items.slice(0, 1), index: rebuilding })),
      ...libraryHandlers({ current: { ...CURRENT_RW, index: rebuilding }, state: { open: true, ...CURRENT_RW, index: rebuilding, integrityWarnings: [], projectWarnings: {} } }),
    );
    renderLibrary({ ...CURRENT_RW, index: rebuilding });
    expect(await screen.findByText(/The library's search index is being rebuilt from its files/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Sources" })).toBeNull();
  });

  it("C1: a partial index whose rebuild failed is never shown as a short list: the failure in its place", async () => {
    const failed = { state: "failed", message: "x", partial: true };
    server.use(
      http.get(url("/projects/:id/sources"), () => HttpResponse.json({ ...SOURCES, total: 1, items: SOURCES.items.slice(0, 1), index: failed })),
      ...libraryHandlers({ current: { ...CURRENT_RW, index: failed }, state: { open: true, ...CURRENT_RW, index: failed, integrityWarnings: [], projectWarnings: {} } }),
    );
    renderLibrary({ ...CURRENT_RW, index: failed });
    expect(await screen.findByText(/The sources cannot be listed: the library's search index could not be rebuilt/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Sources" })).toBeNull();
  });

  it("C1: a whole index being rebuilt (not partial) keeps its list shown", async () => {
    const rebuilding = { state: "rebuilding", done: 1, total: 4 };
    server.use(
      http.get(url("/projects/:id/sources"), () => HttpResponse.json({ ...SOURCES, index: rebuilding })),
      ...libraryHandlers({ current: { ...CURRENT_RW, index: rebuilding }, state: { open: true, ...CURRENT_RW, index: rebuilding, integrityWarnings: [], projectWarnings: {} } }),
    );
    renderLibrary({ ...CURRENT_RW, index: rebuilding });
    expect(await screen.findByText("Ethnography at Work")).toBeTruthy();
  });

  it("D8: a read-only library says its index cannot be built here and search looks at titles only", async () => {
    const ro = { libraryId: "lib-1", name: "Thesis library", mode: "read-only", readOnlyReason: "locked-by-other-device", lockedBy: "field-laptop", index: { state: "unavailable", reason: "locked-by-other-device" } };
    server.use(
      http.get(url("/projects/:id/sources"), () => HttpResponse.json({ ...SOURCES, index: { state: "unavailable", reason: "locked-by-other-device" } })),
      ...libraryHandlers({ current: ro }),
    );
    renderLibrary(ro);
    expect(await screen.findByText("Ethnography at Work")).toBeTruthy();
    expect(screen.getByText(/open read-only, so its search index cannot be built here.*titles only/)).toBeTruthy();
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
    const clinic = within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", { name: /Clinic interviews/ });
    expect(clinic.textContent).not.toMatch(/Locked/);
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

  it("uses the profiles GET /projects sends, without reading governance.yaml", async () => {
    let governanceReads = 0;
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: PROJECTS.projects.map((p) => ({ ...p, profiles: p.id === "p1" ? ["dmp"] : [] })) })),
      http.get(url("/projects/:id/governance"), () => {
        governanceReads++;
        return HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] });
      }),
      ...libraryHandlers(),
    );
    renderLibrary();
    const diss = await screen.findByRole("button", { name: /Dissertation/ });
    await waitFor(() => expect(diss.textContent).toMatch(/DMP/));
    expect(diss.textContent).not.toMatch(/IRB/);
    expect(governanceReads).toBe(0);
  });

  it("badges come only from GET /projects: a project without profiles shows none and its rules are never read", async () => {
    let governanceReads = 0;
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: PROJECTS.projects.map(({ profiles: _p, ...p }) => p) })),
      http.get(url("/projects/:id/governance"), () => {
        governanceReads++;
        return HttpResponse.json({ yaml: "profiles: [irb]\n", sha256: "a".repeat(64), violations: [] });
      }),
      ...libraryHandlers(),
    );
    renderLibrary();
    const diss = await screen.findByRole("button", { name: /Dissertation/ });
    await screen.findByRole("tree", { name: "Collections" });
    expect(diss.textContent).not.toMatch(/IRB/);
    expect(governanceReads).toBe(0);
  });

  it("renames and deletes a workspace tag through /workspace-tags (R118)", async () => {
    const calls: string[] = [];
    server.use(
      http.patch(url("/workspace-tags/:tid"), async ({ params, request }) => {
        calls.push(`PATCH ${String(params.tid)} ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ id: params.tid, scope: "workspace", name: "method" });
      }),
      http.delete(url("/workspace-tags/:tid"), ({ params }) => {
        calls.push(`DELETE ${String(params.tid)}`);
        return HttpResponse.json({ deleted: true });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Ethnography at Work");
    await user.click(screen.getByRole("button", { name: "Rename workspace tag methods" }));
    const field = screen.getByLabelText("New name for methods");
    await user.clear(field);
    await user.type(field, "method{Enter}");
    await waitFor(() => expect(calls).toEqual(['PATCH w1 {"name":"method"}']));
    await user.click(screen.getByRole("button", { name: "Delete workspace tag methods" }));
    await user.click(within(screen.getByRole("group", { name: "Delete workspace tag methods?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual(['PATCH w1 {"name":"method"}', "DELETE w1"]));
  });

  it("Resolve… on an interrupted-change banner lists the changes and resolves one by the researcher's choice (R27)", async () => {
    const T1 = "019a7000-0000-7000-8000-0000000000c1";
    const T2 = "019a7000-0000-7000-8000-00000000bad1";
    let pending = [
      { txn: T1, projectId: "p1", project: "Dissertation", status: "unverifiable", canKeep: false, canRollBack: true, steps: 3 },
      { txn: T2, projectId: "*", project: "library", status: "invalid", canKeep: false, canRollBack: false, steps: 0 },
    ];
    const resolved: unknown[] = [];
    const warn = { projectId: "p1", project: "Dissertation", kind: "txn-recovery-skipped-audit-unverifiable", detail: "x" };
    server.use(
      http.get(url("/libraries/pending-writes"), () => HttpResponse.json({ pendingWrites: pending })),
      http.post(url("/libraries/pending-writes/:txn/resolve"), async ({ params, request }) => {
        resolved.push({ txn: params.txn, ...((await request.json()) as object) });
        pending = pending.filter((p) => p.txn !== params.txn);
        return HttpResponse.json({ txn: params.txn, choice: "roll-back", projectId: "p1" });
      }),
      ...libraryHandlers({ state: { open: true, ...CURRENT_RW, integrityWarnings: [warn], projectWarnings: {} } }),
    );
    const user = userEvent.setup();
    renderLibrary();
    const resolve = await screen.findByRole("button", { name: "Resolve the interrupted change in Dissertation…" });
    await user.click(resolve);
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const first = await within(dialog).findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(within(first).queryByRole("button", { name: "Keep it" })).toBeNull();
    const second = within(dialog).getByRole("group", { name: "Interrupted change in library" });
    expect(within(second).queryByRole("button", { name: "Roll it back" })).toBeNull();
    expect(second.textContent).toMatch(/restore the project from a backup/);
    await user.click(within(first).getByRole("button", { name: "Roll it back" }));
    // A confirmation first.
    expect(resolved).toEqual([]);
    // An unverifiable change: the roll-back needs an explicit acknowledgement (41b2 I3).
    await user.click(within(first).getByRole("checkbox", { name: /I understand/ }));
    await user.click(within(first).getByRole("button", { name: "Yes, roll it back" }));
    await waitFor(() => expect(resolved).toEqual([{ txn: T1, choice: "roll-back" }]));
    await waitFor(() => expect(within(dialog).queryByRole("group", { name: "Interrupted change in Dissertation" })).toBeNull());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(resolve);
  });

  it("PROJECT_LOCKED during an edit returns to UnlockProject and clears what was decrypted", async () => {
    server.use(http.patch(url("/projects/:id/tags/:tid"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked.")), ...libraryHandlers());
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Ethnography at Work");
    await user.click(screen.getByRole("button", { name: "Rename tag to read" }));
    const field = screen.getByLabelText("New name for to read");
    await user.clear(field);
    await user.type(field, "reading{Enter}");
    expect(await screen.findByLabelText("Passphrase or recovery code")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Sources" })).toBeNull();
    expect(screen.queryByText("Ethnography at Work")).toBeNull();
  });

  it("Lock project clears the decrypted sources and details and shows UnlockProject", async () => {
    let locked = 0;
    server.use(
      http.post(url("/projects/:id/unlock"), () => HttpResponse.json({ unlocked: true })),
      http.post(url("/projects/:id/lock"), () => {
        locked++;
        return HttpResponse.json({ unlocked: false });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    renderLibrary();
    await user.click(await screen.findByRole("button", { name: /Clinic interviews/ }));
    await user.type(await screen.findByLabelText("Passphrase or recovery code"), "pw");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(await screen.findByRole("button", { name: "Ethnography at Work" }));
    await screen.findByRole("region", { name: "Source details" });
    await user.click(screen.getByRole("button", { name: "Lock project" }));
    expect(await screen.findByLabelText("Passphrase or recovery code")).toBeTruthy();
    expect(locked).toBe(1);
    expect(screen.queryByRole("region", { name: "Source details" })).toBeNull();
    expect(screen.queryByText("Ethnography at Work")).toBeNull();
    expect(screen.queryByRole("tree", { name: "Collections" })).toBeNull();
    const clinic = within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", { name: /Clinic interviews/ });
    expect(clinic.textContent).toMatch(/Locked/);
  });

  it("a service refusal shows its reason; a later successful search does not hide it", async () => {
    server.use(
      http.patch(url("/projects/:id/tags/:tid"), () => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "Renaming tags is not allowed.", reason: "The project's rules are being reviewed." } }, { status: 403 })),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Ethnography at Work");
    await user.click(screen.getByRole("button", { name: "Rename tag to read" }));
    const field = screen.getByLabelText("New name for to read");
    await user.clear(field);
    await user.type(field, "reading{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The project's rules are being reviewed.");
    await user.type(screen.getByRole("searchbox", { name: "Search sources" }), "eth");
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole("alert").textContent).toContain("The project's rules are being reviewed.");
  });

  it("Load more fetches the next page by offset and appends it", async () => {
    const offsets: Array<string | null> = [];
    const row = (i: number) => ({ ...SOURCES.items[0]!, id: `s${i}`, title: `Source ${i}` });
    server.use(
      http.get(url("/projects/:id/sources"), ({ request }) => {
        const off = new URL(request.url).searchParams.get("offset");
        offsets.push(off);
        return HttpResponse.json(off === "2" ? { total: 3, items: [row(3)] } : { total: 3, items: [row(1), row(2)] });
      }),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Source 2");
    await user.click(screen.getByRole("button", { name: "Load more sources" }));
    expect(await screen.findByText("Source 3")).toBeTruthy();
    expect(screen.getByText("Source 1")).toBeTruthy();
    expect(offsets.at(-1)).toBe("2");
    expect(screen.queryByRole("button", { name: "Load more sources" })).toBeNull();
  });

  describe("a slow Load more answer is dropped when it is stale (41b1 I1)", () => {
    const row = (i: number, title = `Source ${i}`) => ({ ...SOURCES.items[0]!, id: `s${i}`, title });
    let slowFirstPage = false;
    function slowPages() {
      slowFirstPage = false;
      server.use(
        http.get(url("/projects/:id/sources"), async ({ request }) => {
          const q = new URL(request.url).searchParams;
          if (q.get("offset") === "2") {
            await new Promise((r) => setTimeout(r, 600));
            return HttpResponse.json({ total: 3, items: [row(3, "Old page three")] });
          }
          if (q.get("text") === "zebra") return HttpResponse.json({ total: 1, items: [row(9, "Zebra one")] });
          if (slowFirstPage) await new Promise((r) => setTimeout(r, 400));
          return HttpResponse.json({ total: 3, items: [row(1), row(2)] });
        }),
        http.post(url("/projects/:id/unlock"), () => HttpResponse.json({ unlocked: true })),
        http.post(url("/projects/:id/lock"), () => HttpResponse.json({ unlocked: false })),
        ...libraryHandlers(),
      );
    }

    it("after the search changed", async () => {
      slowPages();
      const user = userEvent.setup();
      renderLibrary();
      await screen.findByText("Source 2");
      await user.click(screen.getByRole("button", { name: "Load more sources" }));
      await user.type(screen.getByRole("searchbox", { name: "Search sources" }), "zebra");
      expect(await screen.findByText("Zebra one")).toBeTruthy();
      await new Promise((r) => setTimeout(r, 700));
      expect(screen.queryByText("Old page three")).toBeNull();
      expect(screen.getByText("Zebra one")).toBeTruthy();
    });

    it("after the project was locked: no decrypted rows come back", async () => {
      slowPages();
      const user = userEvent.setup();
      renderLibrary();
      await user.click(await screen.findByRole("button", { name: /Clinic interviews/ }));
      await user.type(await screen.findByLabelText("Passphrase or recovery code"), "pw");
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      await screen.findByText("Source 2");
      await user.click(screen.getByRole("button", { name: "Load more sources" }));
      await user.click(screen.getByRole("button", { name: "Lock project" }));
      expect(await screen.findByLabelText("Passphrase or recovery code")).toBeTruthy();
      await new Promise((r) => setTimeout(r, 700));
      expect(screen.queryByRole("table", { name: "Sources" })).toBeNull();
      // Unlock again: until the fresh answer arrives, nothing left over from before the lock shows.
      slowFirstPage = true;
      await user.type(screen.getByLabelText("Passphrase or recovery code"), "pw");
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      expect(await screen.findByText("Loading sources…")).toBeTruthy();
      expect(screen.queryByText("Old page three")).toBeNull();
      expect(screen.queryByText("Source 1")).toBeNull();
      expect(await screen.findByText("Source 1")).toBeTruthy();
    });
  });

  it("library.state open:false tells the shell the library closed", async () => {
    server.use(...libraryHandlers({ events: [{ type: "library.state", data: { open: false } }] }));
    const onClosed = vi.fn();
    render(<Library api={testApi()} current={CURRENT_RW as never} onClosed={onClosed} />);
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });
});
