import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
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

describe("Missing files: the check says how far it is, and can be stopped (R641 D3)", () => {
  /** GET /libraries/integrity answered as NDJSON lines the test writes; each request's signal and Accept are kept. */
  function ndjsonCheck() {
    const enc = new TextEncoder();
    const asks: Array<{ signal: AbortSignal; accept: string | null; send: (line: unknown) => void; end: () => void }> = [];
    return {
      handler: http.get(url("/libraries/integrity"), ({ request }) => {
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
        asks.push({ signal: request.signal, accept: request.headers.get("accept"), send: (l) => ctl.enqueue(enc.encode(`${JSON.stringify(l)}\n`)), end: () => ctl.close() });
        return new HttpResponse(body, { headers: { "content-type": "application/x-ndjson" } });
      }),
      asks,
    };
  }
  const STOPPED = "The check was stopped. Nothing was changed.";

  it("while the files are listed: “Checking the library…”; while they are checked: “Checked {n} of {m} files…” with “Stop”; then the result", async () => {
    const check = ndjsonCheck();
    server.use(check.handler);
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    expect(screen.getByText("Checking the library…")).toBeTruthy();
    await waitFor(() => expect(check.asks).toHaveLength(1));
    expect(check.asks[0]!.accept).toBe("application/x-ndjson");
    check.asks[0]!.send({ progress: { checked: 0, total: 1500 } });
    expect(await screen.findByText("Checked 0 of 1,500 files…")).toBeTruthy();
    expect(screen.queryByText("Checking the library…")).toBeNull();
    check.asks[0]!.send({ progress: { checked: 1204, total: 1500 } });
    expect(await screen.findByText("Checked 1,204 of 1,500 files…")).toBeTruthy();
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
});
