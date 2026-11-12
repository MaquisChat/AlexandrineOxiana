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

describe("Missing files", () => {
  it("lists missing files; \"Search a folder…\" warns about cloud downloads on Windows and shows the relink results", async () => {
    let missing = ["Projects/Coastal/sources/s1/original.pdf", "Projects/Coastal/sources/s2/interview.m4a"];
    let searched: any;
    server.use(
      http.get(url("/libraries/integrity"), () => HttpResponse.json(report(missing))),
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
    server.use(http.get(url("/libraries/integrity"), () => HttpResponse.json(report(["Projects/A/x.pdf"]))));
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    await screen.findByRole("list", { name: "Missing files" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Search a folder…" }));
    expect(screen.queryByText(/On Windows/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Folder to search" })).toBeTruthy();
  });

  it("says when nothing is missing", async () => {
    server.use(http.get(url("/libraries/integrity"), () => HttpResponse.json(report([]))));
    render(<MissingFiles api={makeApi()} />);
    expect(await screen.findByText("No files are missing.")).toBeTruthy();
  });

  it("D8: “Rebuild library from folder” rebuilds the index once (a double click sends one request) and says what it did", async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(url("/libraries/integrity"), () => HttpResponse.json(report([]))),
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
      http.get(url("/libraries/integrity"), () => HttpResponse.json(report([]))),
      http.post(url("/libraries/rebuild-index"), () => HttpResponse.json({ error: { code: "READ_ONLY", message: "This library is open read-only, so nothing can be changed.", reason: "locked-by-other-device" } }, { status: 409 })),
    );
    render(<MissingFiles api={makeApi()} isWindows={false} />);
    const section = await screen.findByRole("region", { name: "Search index" });
    await userEvent.setup().click(within(section).getByRole("button", { name: "Rebuild library from folder" }));
    expect((await within(section).findByRole("alert")).textContent).toMatch(/read-only/);
  });
});
