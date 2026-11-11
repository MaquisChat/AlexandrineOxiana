import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server, serviceError, SOURCE_FILE, STYLES, testApi, TOKEN, url, useMockService } from "../test/service";
import {
  FIELD_CREATORS_UNVERIFIED,
  FIELD_DOI_CONFIRMED,
  FIELD_ISSUED_CONFLICT,
  FIELD_PUBLISHER_SINGLE,
  FIELD_TITLE_VERIFIED,
  FIELDS,
  installBlobUrls,
  PICTURE_SOURCE,
  pictureResponse,
  PROXY_FAILED_SOURCE,
  sourceHandlers,
  TRANSCRIPT_SOURCE,
  VERIFIED_SOURCE,
  withFields,
} from "../test/verification";
import { SourceDetail } from "./SourceDetail";

useMockService();

const handlers = () => [http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(SOURCE_FILE)), http.get(url("/styles"), () => HttpResponse.json(STYLES))];

describe("SourceDetail", () => {
  it("shows the source's details and files, with user text marked dir=auto", async () => {
    server.use(...handlers());
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Source details" });
    const title = await within(region).findByRole("heading", { name: "Ethnography at Work" });
    expect(title.querySelector("[dir=auto]") ?? title.closest("[dir=auto]")).toBeTruthy();
    expect(within(region).getByText("Smith, Jane")).toBeTruthy();
    expect(within(region).getByText("10.1000/xyz")).toBeTruthy();
    expect(within(region).getByText("smith-2019.pdf")).toBeTruthy();
  });

  it("edits the title through PATCH, keeping the other title variants", async () => {
    let body: { title?: { variants: Array<{ value: string }> } } = {};
    server.use(
      ...handlers(),
      http.patch(url("/projects/:id/sources/:sid"), async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json({ ...SOURCE_FILE, source: { ...SOURCE_FILE.source, title: body.title } });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} onChanged={onChanged} />);
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    const field = screen.getByLabelText("Title");
    await user.clear(field);
    await user.type(field, "Ethnography at Work, revised");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(body.title?.variants[0]).toEqual({ lang: "en", kind: "original", value: "Ethnography at Work, revised" });
    expect(await screen.findByRole("heading", { name: "Ethnography at Work, revised" })).toBeTruthy();
  });

  it("read-only: editing is off", async () => {
    server.use(...handlers());
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly onClose={vi.fn()} />);
    expect(((await screen.findByRole("button", { name: "Edit details" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the library turning read-only mid-edit disables Save", async () => {
    server.use(...handlers());
    const user = userEvent.setup();
    const { rerender } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    rerender(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly onClose={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("citation key and date are user text (dir=auto)", async () => {
    server.use(...handlers());
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    expect((await screen.findByText("smith2019")).closest("[dir=auto]")).toBeTruthy();
    expect(screen.getByText("2019").closest("[dir=auto]")).toBeTruthy();
  });
});

// ---- Task 34d: verification badges, recheck, pictures, background work, transcript link ----

const second = (fields = [FIELD_PUBLISHER_SINGLE]) => withFields(fields, { source: { ...SOURCE_FILE.source, id: "s2", title: { variants: [{ value: "Second source" }] } } });

describe("SourceDetail: verification (Task 34d)", () => {
  it("shows a badge beside each checked field, with the field and status in its name", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Source details" });
    expect(await within(region).findByRole("button", { name: "Title: Verified" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Creators: Unverified" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Publication date: Conflict" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Publisher: Single source" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "DOI: Confirmed by you" })).toBeTruthy();
    // The heading keeps its own name (the badge sits beside it, not inside it).
    expect(within(region).getByRole("heading", { level: 2, name: "Ethnography at Work" })).toBeTruthy();
  });

  it("a checked field the details do not list (here a missing container) is listed with its badge", async () => {
    const container = { field: "/container", status: "unverified" as const, checks: ["present"], reason: "Container (journal or site name) is missing.", evidence: [] };
    server.use(...sourceHandlers(withFields([...FIELDS, container])));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Container (journal or site name): Unverified" })).toBeTruthy();
  });

  it("choosing a conflicting value posts the researcher's confirmation and the badge then says Confirmed by you", async () => {
    let body: unknown;
    server.use(
      ...sourceHandlers(VERIFIED_SOURCE),
      http.patch(url("/projects/:id/sources/:sid/fields"), async ({ request }) => {
        body = await request.json();
        const issued = { field: "/issued", status: "user-confirmed" as const, checks: ["user"], evidence: FIELD_ISSUED_CONFLICT.evidence };
        return HttpResponse.json(withFields([FIELD_CREATORS_UNVERIFIED, FIELD_DOI_CONFIRMED, issued, FIELD_PUBLISHER_SINGLE, FIELD_TITLE_VERIFIED], { source: { ...SOURCE_FILE.source, issued: "2018" } }));
      }),
    );
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Publication date: Conflict" }));
    await user.click(screen.getByRole("radio", { name: /2018/ }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    const confirmed = await screen.findByRole("button", { name: "Publication date: Confirmed by you" });
    expect(body).toEqual({ field: "/issued", value: "2018" });
    // R145: focus is back on the badge (re-rendered with its new status), and the page is no longer inert.
    await waitFor(() => expect(document.activeElement).toBe(confirmed));
    expect(document.querySelector("[inert]")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a DOI is confirmed through the field route under its own key (R149), and its badge then says Confirmed by you", async () => {
    let body: unknown;
    const doiUnverified = { ...FIELD_DOI_CONFIRMED, status: "unverified" as const, reason: "The DOI could not be checked." };
    server.use(
      ...sourceHandlers(withFields([doiUnverified])),
      http.patch(url("/projects/:id/sources/:sid/fields"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(withFields([FIELD_DOI_CONFIRMED]));
      }),
    );
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "DOI: Unverified" }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(await screen.findByRole("button", { name: "DOI: Confirmed by you" })).toBeTruthy();
    expect(body).toEqual({ field: "/identifiers/doi", value: "10.1000/xyz" });
  });

  it("a confirm the service refuses is explained in plain words; the popover and the choice stay", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE), http.patch(url("/projects/:id/sources/:sid/fields"), () => serviceError(409, "READ_ONLY", "The library is read-only.")));
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Publication date: Conflict" }));
    await user.click(screen.getByRole("radio", { name: /2018/ }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert.textContent).toContain("This library is read-only, so nothing was changed.");
    expect(alert.textContent).not.toContain("{");
    expect((screen.getByRole("radio", { name: /2018/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Publication date: Conflict" })).toBeTruthy();
  });

  it("a confirm refused because the project was locked returns to the unlock screen", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE), http.patch(url("/projects/:id/sources/:sid/fields"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked.")));
    const onLocked = vi.fn();
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} onLocked={onLocked} />);
    await user.click(await screen.findByRole("button", { name: "Publisher: Single source" }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    await waitFor(() => expect(onLocked).toHaveBeenCalled());
  });

  it("Recheck calls the route and re-renders the badges; the button is off while it runs", async () => {
    let calls = 0;
    let release: () => void = () => {};
    server.use(
      ...sourceHandlers(VERIFIED_SOURCE),
      http.post(url("/projects/:id/sources/:sid/recheck"), async () => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json(withFields([{ ...FIELD_TITLE_VERIFIED, status: "conflict", reason: "The DOI resolves to a different work." }]));
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByRole("button", { name: "Title: Verified" });
    await user.click(screen.getByRole("button", { name: "Recheck" }));
    const busy = await screen.findByRole("button", { name: "Rechecking…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await user.click(busy);
    release();
    expect(await screen.findByRole("button", { name: "Title: Conflict" })).toBeTruthy();
    expect(calls).toBe(1);
    expect(screen.getByText(/Rechecked\./)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("Recheck is off in a read-only library", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly onClose={vi.fn()} />);
    expect(((await screen.findByRole("button", { name: "Recheck" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed recheck says why and keeps the badges", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE), http.post(url("/projects/:id/sources/:sid/recheck"), () => serviceError(503, "UNAVAILABLE", "x")));
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Recheck" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The library service could not be reached.");
    expect(screen.getByRole("button", { name: "Title: Verified" })).toBeTruthy();
  });

  it("a recheck result that arrives after another source was opened is dropped", async () => {
    let release: () => void = () => {};
    server.use(
      http.get(url("/projects/:id/sources/:sid"), ({ params }) => HttpResponse.json(params.sid === "s2" ? second() : VERIFIED_SOURCE)),
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
      http.post(url("/projects/:id/sources/:sid/recheck"), async () => {
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json(withFields([{ ...FIELD_TITLE_VERIFIED, status: "conflict" }]));
      }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Recheck" }));
    rerender(<SourceDetail api={testApi()} projectId="p1" sourceId="s2" readOnly={false} onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Second source" });
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("heading", { name: "Second source" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Title: Conflict" })).toBeNull();
    expect(screen.queryByText(/Rechecked\./)).toBeNull();
    expect((screen.getByRole("button", { name: "Recheck" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("evidence read for a source that is no longer shown is dropped", async () => {
    let releaseS1: (() => void) | undefined;
    server.use(
      http.get(url("/projects/:id/sources/:sid"), async ({ params }) => {
        if (params.sid === "s1") await new Promise<void>((r) => (releaseS1 = r));
        return HttpResponse.json(params.sid === "s2" ? second() : VERIFIED_SOURCE);
      }),
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
    );
    const { rerender } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await waitFor(() => expect(releaseS1).toBeDefined());
    rerender(<SourceDetail api={testApi()} projectId="p1" sourceId="s2" readOnly={false} onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Second source" });
    releaseS1!();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("heading", { name: "Second source" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Title: Verified" })).toBeNull();
  });

  it("reads the source again when refreshKey changes (a project recheck finished), and the badges follow", async () => {
    let reads = 0;
    server.use(
      http.get(url("/projects/:id/sources/:sid"), () => {
        reads++;
        return HttpResponse.json(reads === 1 ? VERIFIED_SOURCE : withFields([{ ...FIELD_TITLE_VERIFIED, status: "unverified" }]));
      }),
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
    );
    const { rerender } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} refreshKey={0} />);
    await screen.findByRole("button", { name: "Title: Verified" });
    rerender(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} refreshKey={1} />);
    expect(await screen.findByRole("button", { name: "Title: Unverified" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ethnography at Work" })).toBeTruthy();
  });

  it("R137: the badges come from the record's field checks only; a source with no review item waiting still shows its conflict, never 'confirmed by you'", async () => {
    // The library row of s1 says no review is waiting (SOURCES: needsReview false); its date still conflicts.
    server.use(...sourceHandlers(withFields([FIELD_ISSUED_CONFLICT])));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Publication date: Conflict" })).toBeTruthy();
    expect(screen.queryByText("Confirmed by you")).toBeNull();
  });
});

describe("SourceDetail: pictures (R135: read with the token, shown as blobs)", () => {
  let blobs: ReturnType<typeof installBlobUrls>;
  beforeEach(() => {
    blobs = installBlobUrls();
  });
  afterEach(() => blobs.restore());

  it("shows the viewing copy and the screenshot as blob pictures read with the token; not the HEIC original, the videos or an SVG", async () => {
    const asked: Array<{ aid: string; auth: string | null }> = [];
    server.use(
      http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), ({ params, request }) => {
        asked.push({ aid: String(params.aid), auth: request.headers.get("authorization") });
        return pictureResponse(params.aid === "a-shot" ? "image/png" : "image/jpeg");
      }),
      ...sourceHandlers(PICTURE_SOURCE),
    );
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Source details" });
    await waitFor(() => expect(within(region).getAllByRole("img")).toHaveLength(2));
    const imgs = within(region).getAllByRole("img");
    for (const img of imgs) expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(imgs.map((i) => i.getAttribute("alt"))).toEqual(["Viewing copy: IMG_0001.proxy.jpg", "Page screenshot: page.png"]);
    expect(asked.map((a) => a.aid).sort()).toEqual(["a-proxy", "a-shot"]);
    for (const a of asked) expect(a.auth).toBe(`Bearer ${TOKEN}`);
    expect(blobs.live()).toHaveLength(2);
  });

  it("revokes the blob URLs when another source is opened and when the screen closes", async () => {
    server.use(...sourceHandlers(PICTURE_SOURCE));
    const { rerender, unmount } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    const first = blobs.live();
    rerender(<SourceDetail api={testApi()} projectId="p1" sourceId="s2" readOnly={false} onClose={vi.fn()} />);
    await waitFor(() => expect(first.every((u) => blobs.revoked.has(u))).toBe(true));
    await waitFor(() => expect(blobs.live()).toHaveLength(2));
    unmount();
    expect(blobs.live()).toEqual([]);
  });

  it("a picture that arrives after the screen closed is never turned into a blob URL", async () => {
    let release: (() => void) | undefined;
    server.use(
      http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), async () => {
        await new Promise<void>((r) => (release = r));
        return pictureResponse();
      }),
      ...sourceHandlers(PICTURE_SOURCE),
    );
    const { unmount } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await waitFor(() => expect(release).toBeDefined());
    unmount();
    release!();
    await new Promise((r) => setTimeout(r, 50));
    expect(blobs.created).toEqual([]);
  });

  it("a picture that cannot be read says so in words in its place", async () => {
    server.use(http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), () => serviceError(409, "CONFLICT", "This file is damaged and could not be read.")), ...sourceHandlers(PICTURE_SOURCE));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const msgs = await screen.findAllByText(/could not be shown/);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.textContent).toContain("damaged");
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("a locked project: the picture read is refused and the screen returns to unlocking", async () => {
    server.use(http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked.")), ...sourceHandlers(PICTURE_SOURCE));
    const onLocked = vi.fn();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} onLocked={onLocked} />);
    await waitFor(() => expect(onLocked).toHaveBeenCalled());
    expect(blobs.live()).toEqual([]);
  });

  it("a locked project: the source itself is refused, the screen returns to unlocking, and Recheck is not offered", async () => {
    server.use(http.get(url("/projects/:id/sources/:sid"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked.")), http.get(url("/styles"), () => HttpResponse.json(STYLES)));
    const onLocked = vi.fn();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} onLocked={onLocked} />);
    await waitFor(() => expect(onLocked).toHaveBeenCalled());
    const recheck = screen.queryByRole("button", { name: "Recheck" }) as HTMLButtonElement | null;
    expect(recheck === null || recheck.disabled).toBe(true);
  });
});

describe("SourceDetail: background work for the source (R84)", () => {
  it("a failed viewing copy is shown with its plain reason and a retry; a waiting one says why it waits", async () => {
    let reads = 0;
    let retried: unknown;
    server.use(
      http.get(url("/projects/:id/sources/:sid"), () => {
        reads++;
        return HttpResponse.json(reads === 1 ? PROXY_FAILED_SOURCE : { ...PROXY_FAILED_SOURCE, pendingProxies: PROXY_FAILED_SOURCE.pendingProxies.map(({ failed: _f, ...j }) => j) });
      }),
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
      http.post(url("/jobs/retry"), async ({ request }) => {
        retried = await request.json();
        return HttpResponse.json({ retrying: true });
      }),
    );
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const work = await screen.findByRole("region", { name: "Viewing copies and text recognition" });
    const items = within(work).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/viewing copy of IMG_0001\.heic could not be made/i);
    expect(items[0]!.textContent).toContain("still carried a location");
    expect(items[0]!.textContent).toContain("3 attempts");
    expect(items[1]!.textContent).toMatch(/viewing copy of IMG_0001\.mov has not been made yet/i);
    await user.click(within(work).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(retried).toEqual({ projectId: "p1", sourceId: "s1" }));
    await waitFor(() => expect(within(work).queryByText(/could not be made/)).toBeNull());
    expect(within(work).getAllByRole("listitem")).toHaveLength(2);
    expect(within(work).getByRole("status").textContent).toContain("Trying again");
  });

  it("a retry the service refuses is explained, and the failure stays listed", async () => {
    server.use(...sourceHandlers(PROXY_FAILED_SOURCE), http.post(url("/jobs/retry"), () => serviceError(409, "READ_ONLY", "read only")));
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const work = await screen.findByRole("region", { name: "Viewing copies and text recognition" });
    await user.click(within(work).getByRole("button", { name: "Try again" }));
    expect((await within(work).findByRole("alert")).textContent).toContain("This library is read-only");
    expect(within(work).getByText(/could not be made/)).toBeTruthy();
  });

  it("text recognition that did not finish is listed too, with the same retry", async () => {
    const ocr = { ...SOURCE_FILE, fields: [], pendingOcr: [{ id: "o1", assetId: "a1", queuedAt: "2026-11-01T10:00:00Z", failed: { code: "SOMETHING_NEW", at: "2026-11-01T10:01:00Z" } }] };
    server.use(...sourceHandlers(ocr));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const work = await screen.findByRole("region", { name: "Viewing copies and text recognition" });
    expect(within(work).getByRole("listitem").textContent).toBe("Text recognition of smith-2019.pdf did not finish: the media helper could not finish it (1 attempt).");
    expect(within(work).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("no background work: no such section", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Ethnography at Work" });
    expect(screen.queryByRole("region", { name: "Viewing copies and text recognition" })).toBeNull();
  });
});

describe("SourceDetail: the transcript entry point", () => {
  it("a source with a transcript links to the transcript viewer for this project and source", async () => {
    server.use(...sourceHandlers(TRANSCRIPT_SOURCE));
    const user = userEvent.setup();
    const before = window.location.pathname + window.location.search;
    render(<SourceDetail api={testApi()} projectId="p 1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Open the transcript" });
    expect(link.getAttribute("href")).toBe("/transcript?project=p+1&source=s1");
    await user.click(link);
    expect(window.location.pathname).toBe("/transcript");
    expect(new URLSearchParams(window.location.search).get("project")).toBe("p 1");
    window.history.replaceState(null, "", before);
  });

  it("no transcript, no link", async () => {
    server.use(...sourceHandlers(VERIFIED_SOURCE));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Ethnography at Work" });
    expect(screen.queryByRole("link", { name: "Open the transcript" })).toBeNull();
  });
});
