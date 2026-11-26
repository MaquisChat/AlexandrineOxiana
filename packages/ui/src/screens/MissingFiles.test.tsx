import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { MissingFiles } from "./MissingFiles";

useMsw();

const report = (missing: string[]) => ({
  report: { checked: 10, hashed: 1, hashedAssetIds: [], presenceOnly: 0, missing: missing.map((path) => ({ assetId: null, path })), mismatched: [], placeholders: [], errors: [] },
  integrityWarnings: [],
  projectWarnings: {},
});

/** The check's answer as the service streams it to this screen (R641 D3): its result line alone. */
const answered = (body: unknown) => new HttpResponse(`${JSON.stringify({ result: body })}\n`, { headers: { "content-type": "application/x-ndjson" } });

describe("Missing files", () => {
  it("lists missing files; \"Search a folder…\" warns about cloud downloads on Windows and shows the relink results", async () => {
    let missing = ["Projects/Coastal/sources/s1/original.pdf", "Projects/Coastal/sources/s2/interview.m4a"];
    let searched: any;
    server.use(
      http.get(url("/libraries/integrity"), () => answered(report(missing))),
      http.post(url("/libraries/relink"), async ({ request }) => {
        searched = await request.json();
        missing = ["Projects/Coastal/sources/s2/interview.m4a"];
        return HttpResponse.json({
          relinked: 1,
          stillMissing: 1,
          relinkedPaths: ["Projects/Coastal/sources/s1/original.pdf"],
          skipped: [{ path: "Projects/Coastal/sources/s2/interview.m4a", reason: "placeholder" }],
          placeholderCandidates: ["Audio/interview.m4a"],
          warnings: [],
        });
      }),
    );
    render(<MissingFiles api={makeApi()} isWindows />);
    const list = await screen.findByRole("list", { name: "Missing files" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search a folder…" }));
    expect(screen.getByText(/On Windows, searching a folder kept in OneDrive or another cloud-storage service can make it download files/)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Folder to search" }), "C:\\Users\\ana\\OneDrive\\Fieldwork");
    await user.click(screen.getByRole("button", { name: "Search and relink" }));
    const res = await screen.findByRole("region", { name: "Relink results" });
    expect(searched).toEqual({ searchDir: "C:\\Users\\ana\\OneDrive\\Fieldwork" });
    expect(res.textContent).toMatch(/1 file relinked; 1 still missing/);
    expect(res.textContent).toMatch(/Projects\/Coastal\/sources\/s1\/original\.pdf/);
    expect(res.textContent).toMatch(/only online-only copies were found/i);
    expect(res.textContent).toMatch(/Audio\/interview\.m4a/);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Missing files" })).getAllByRole("listitem")).toHaveLength(1));
  });

  it("shows the cloud-download warning only on Windows", async () => {
    server.use(http.get(url("/libraries/integrity"), () => answered(report(["Projects/A/x.pdf"]))));
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await screen.findByRole("list", { name: "Missing files" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Search a folder…" }));
    expect(screen.queryByText(/On Windows/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Folder to search" })).toBeTruthy();
  });

  it("says when nothing is missing", async () => {
    server.use(http.get(url("/libraries/integrity"), () => answered(report([]))));
    render(<MissingFiles api={makeApi()} />);
    expect(await screen.findByText("No files are missing.")).toBeTruthy();
  });

  it("D8: “Rebuild library from folder” rebuilds the index once (a double click sends one request) and says what it did", async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(url("/libraries/integrity"), () => answered(report([]))),
      http.post(url("/libraries/rebuild-index"), async () => {
        posts++;
        await gate;
        return HttpResponse.json({ indexed: 1284, lockedProjects: 1, errors: 0 });
      }),
    );
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    const section = await screen.findByRole("region", { name: "Search index" });
    const button = within(section).getByRole("button", { name: "Rebuild library from folder" });
    const user = userEvent.setup();
    await user.dblClick(button);
    expect(await within(section).findByRole("status")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(section.textContent).toMatch(/1,284 sources indexed/));
    expect(section.textContent).toMatch(/1 locked project.*completed when it is unlocked/);
    expect(posts).toBe(1);
  });

  it("D8: a rebuild that is refused or fails says so in plain words", async () => {
    server.use(
      http.get(url("/libraries/integrity"), () => answered(report([]))),
      http.post(url("/libraries/rebuild-index"), () => HttpResponse.json({ error: { code: "READ_ONLY", message: "This library is open read-only, so nothing can be changed.", reason: "locked-by-other-device" } }, { status: 409 })),
    );
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    const section = await screen.findByRole("region", { name: "Search index" });
    await userEvent.setup().click(within(section).getByRole("button", { name: "Rebuild library from folder" }));
    expect((await within(section).findByRole("alert")).textContent).toMatch(/read-only/);
  });
});

describe("FR-762 (review M1): under strict mode (mounted, cleaned up, mounted again) the rebuild still says what it did", () => {
  it("“Rebuild library from folder” shows its result and is usable again", async () => {
    server.use(
      http.get(url("/libraries/integrity"), () => answered(report([]))),
      http.post(url("/libraries/rebuild-index"), () => HttpResponse.json({ indexed: 1284, lockedProjects: 0, errors: 0 })),
    );
    render(
      <StrictMode>
        <MissingFiles api={makeApi()} isWindows={false} />
      </StrictMode>,
    );
    const section = await screen.findByRole("region", { name: "Search index" });
    const button = within(section).getByRole("button", { name: "Rebuild library from folder" }) as HTMLButtonElement;
    await userEvent.setup().click(button);
    await waitFor(() => expect(section.textContent).toMatch(/1,284 sources indexed/));
    expect(button.disabled).toBe(false);
  });
});

describe("Missing files: the check says how far it is, and can be stopped (R641 D3)", () => {
  /** GET /libraries/integrity answered as NDJSON lines the test writes; each request's signal and Accept are kept. */
  function ndjsonCheck() {
    const enc = new TextEncoder();
    const asks: Array<{ signal: AbortSignal; accept: string | null; send: (line: unknown) => void; end: () => void; cut: () => void }> = [];
    return {
      handler: http.get(url("/libraries/integrity"), ({ request }) => {
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
        asks.push({
          // The request is kept and its signal read when asserted (a signal kept alone can miss its abort).
          get signal() {
            return request.signal;
          },
          accept: request.headers.get("accept"),
          send: (l) => ctl.enqueue(enc.encode(`${JSON.stringify(l)}\n`)),
          end: () => ctl.close(),
          /** The connection is lost part-way (as when the service stops). */
          cut: () => ctl.error(new TypeError("terminated")),
        });
        return new HttpResponse(body, { headers: { "content-type": "application/x-ndjson" } });
      }),
      asks,
    };
  }
  const STOPPED = "The check was stopped. Nothing was changed.";
  /** The visible progress line only: the status told to a screen reader may carry the same words (review M3). */
  const SHOWN = { ignore: "script, style, .ao-visually-hidden" };

  it("while the files are listed: “Checking the library…”; while they are checked: “Checked {n} of {m} files…” with “Stop”; then the result", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    expect(screen.getByText("Checking the library…")).toBeTruthy();
    await waitFor(() => expect(check.asks).toHaveLength(1));
    expect(check.asks[0]!.accept).toBe("application/x-ndjson");
    check.asks[0]!.send({ progress: { checked: 0, total: 1500 } });
    expect(await screen.findByText("Checked 0 of 1,500 files…", SHOWN)).toBeTruthy();
    expect(screen.queryByText("Checking the library…")).toBeNull();
    check.asks[0]!.send({ progress: { checked: 1204, total: 1500 } });
    expect(await screen.findByText("Checked 1,204 of 1,500 files…", SHOWN)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    check.asks[0]!.send({ progress: { checked: 1500, total: 1500 } });
    check.asks[0]!.send({ result: report(["Projects/A/x.pdf"]) });
    check.asks[0]!.end();
    const list = await screen.findByRole("list", { name: "Missing files" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/^Checked \d/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("“Stop” ends the check (its request cancelled) and says so; focus goes to “Check again”, which checks again", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    check.asks[0]!.send({ progress: { checked: 3, total: 10 } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText(STOPPED)).toBeTruthy();
    expect(check.asks[0]!.signal.aborted).toBe(true);
    const again = screen.getByRole("button", { name: "Check again" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    // Nothing of the stopped check is shown: no list, no "No files are missing.", no progress, no alert.
    expect(screen.queryByRole("list", { name: "Missing files" })).toBeNull();
    expect(screen.queryByText("No files are missing.")).toBeNull();
    expect(screen.queryByText(/^Checked \d/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(again);
    await waitFor(() => expect(check.asks).toHaveLength(2));
    expect(screen.queryByText(STOPPED)).toBeNull();
    expect(screen.getByText("Checking the library…")).toBeTruthy();
    check.asks[1]!.send({ result: report([]) });
    check.asks[1]!.end();
    expect(await screen.findByText("No files are missing.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("leaving the screen cancels the check", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    const { unmount } = render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    unmount();
    expect(check.asks[0]!.signal.aborted).toBe(true);
  });

  it("an error line from the service is shown as the check's failure, in its own words", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    check.asks[0]!.send({ error: { code: "CONFLICT", message: "The check was stopped because the library was closed or moved. Open the library again and run the check again." } });
    check.asks[0]!.end();
    expect((await screen.findByRole("alert")).textContent).toBe("The check was stopped because the library was closed or moved. Open the library again and run the check again.");
  });

  it("a check that fails partway offers “Check again” under its failure; pressed, the failure goes and the library is checked again (review I2)", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    // The service goes away mid-check: its answer is cut off.
    check.asks[0]!.send({ progress: { checked: 3, total: 10 } });
    check.asks[0]!.cut();
    expect((await screen.findByRole("alert")).textContent).toBe("The library service's answer was cut off before it finished.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(check.asks).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Checking the library…")).toBeTruthy();
    check.asks[1]!.send({ result: report([]) });
    check.asks[1]!.end();
    expect(await screen.findByText("No files are missing.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  // R658: "Check again" goes away when the check starts; focus is handed on to the screen's heading, never dropped.
  it("R658: “Check again” after a stop, pressed, hands focus to the screen's heading as the check starts", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    check.asks[0]!.send({ progress: { checked: 3, total: 10 } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    const again = await screen.findByRole("button", { name: "Check again" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    await user.click(again);
    await waitFor(() => expect(check.asks).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Missing files" }));
  });

  it("R658: “Check again” under a failed check, pressed, hands focus to the screen's heading as the check starts", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    check.asks[0]!.send({ progress: { checked: 3, total: 10 } });
    check.asks[0]!.cut();
    await screen.findByRole("alert");
    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(check.asks).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Missing files" }));
  });

  it("R658: the screen's first check, at its opening, does not take focus to the heading", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await waitFor(() => expect(check.asks).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);
  });

  it("the progress is shown as it comes, but told to a screen reader at most every five seconds; the stopped sentence at once (review M3)", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    const said = () => screen.queryAllByRole("status").map((s) => s.textContent);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      render(<MissingFiles api={makeApi()} isWindows={false} />);
      await vi.waitFor(() => expect(check.asks).toHaveLength(1));
      check.asks[0]!.send({ progress: { checked: 0, total: 1500 } });
      // The first line is told at once.
      await vi.waitFor(() => expect(said()).toContain("Checked 0 of 1,500 files…"));
      check.asks[0]!.send({ progress: { checked: 250, total: 1500 } });
      check.asks[0]!.send({ progress: { checked: 500, total: 1500 } });
      // Shown at once, told not yet.
      await vi.waitFor(() => expect(screen.getByText("Checked 500 of 1,500 files…", SHOWN)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(4_000);
      expect(said()).toContain("Checked 0 of 1,500 files…");
      expect(said().some((t) => t?.includes("500 of"))).toBe(false);
      // Five seconds after the last telling, the line as it now is.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(said()).toContain("Checked 500 of 1,500 files…"));
      check.asks[0]!.send({ progress: { checked: 750, total: 1500 } });
      await vi.waitFor(() => expect(screen.getByText("Checked 750 of 1,500 files…", SHOWN)).toBeTruthy());
      expect(said()).toContain("Checked 500 of 1,500 files…");
      // "Stop": the stopped sentence is told at once.
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await vi.waitFor(() => expect(said()).toContain(STOPPED));
      expect(said().some((t) => t?.startsWith("Checked"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
