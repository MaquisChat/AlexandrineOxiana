/**
 * The About screen (Task 37c): the third-party notices, as the builds produce them. The citeproc-js
 * notice CPAL-1.0 section 3.6 calls for comes from packages/core/csl/NOTICE.md (R103, R124, R129);
 * the typefaces' licences from packages/ui/public/fonts; the service's npm packages and the worker's
 * licence manifest from the desktop build, when it is that build.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createClient } from "../api/client";
import { ROUTES, routeFor } from "../App";
import type { AppLocation } from "../navigation";
import { BASE, server, TOKEN, testApi, url, useMockService } from "../test/service";
import { About, BUILT_NOTICES, parseNpmNotices } from "./About";
import { LibraryChooser } from "./LibraryChooser";

useMockService();

const NPM = `# Third-party notices

The library service folder contains the following npm packages.

| Package | Version | Licence | How | Licence files |
| --- | --- | --- | --- | --- |
| @fastify/error | 4.2.1 | MIT | bundled | LICENSE |
| citeproc | 2.4.63 | CPAL-1.0 OR AGPL-3.0-or-later | copied | LICENSE |
`;

const WORKER = JSON.stringify({
  name: "ao-worker",
  workerVersion: "0.1.0",
  python: "3.13.9",
  packages: [{ name: "pillow", version: "13.0.0", licence: "MIT-CMU", copyleft: "no" }],
  nativeLibraries: [{ path: "_internal/av.libs/libavcodec.so", carriedBy: "av", licence: "LGPL-2.1-or-later", copyleft: "weak" }],
  notBundled: ["ffmpeg"],
});

describe("About", () => {
  it("shows the citeproc-js notice with what CPAL-1.0 section 3.6 calls for, from the CSL NOTICE", () => {
    render(<About />);
    expect(screen.getByRole("heading", { level: 1, name: "About and third-party notices" })).toBeTruthy();
    const cite = screen.getByRole("region", { name: "Citation processor and styles" });
    const text = cite.textContent ?? "";
    expect(text).toContain("Copyright (c) 2009-2019 Frank Bennett");
    expect(text).toContain("https://github.com/juris-m/citeproc-js");
    expect(text).toContain("Common Public Attribution License 1.0");
    expect(text).toContain("2.4.63"); // the pinned version
    expect(text).toMatch(/source of citeproc-js is available/i);
    expect(text).toMatch(/no Modifications/);
    // The notice itself first, as NOTICE.md quotes it.
    expect(cite.querySelector("blockquote")?.textContent).toBe(
      "Copyright (c) 2009-2019 Frank Bennett. citeproc-js, <https://github.com/juris-m/citeproc-js>, used under the Common Public Attribution License 1.0.",
    );
    // The licence texts themselves, one keyboard step away.
    expect(within(cite).getByText("The CPAL-1.0 licence text")).toBeTruthy();
    expect(within(cite).getByText("The CC BY-SA 3.0 licence text")).toBeTruthy();
  });

  it("shows each bundled typeface's licence", () => {
    render(<About />);
    const fonts = screen.getByRole("region", { name: "Typefaces" });
    for (const name of ["Atkinson Hyperlegible", "OpenDyslexic", "Sorts Mill Goudy"]) expect(within(fonts).getByText(`${name}: SIL Open Font License 1.1`)).toBeTruthy();
    expect(fonts.textContent).toContain("SIL OPEN FONT LICENSE");
  });

  it("without the desktop build's data, says where the package lists come from", () => {
    render(<About notices={{}} />);
    expect(screen.getByRole("region", { name: "The library service's npm packages" }).textContent).toMatch(/added by the desktop build/);
    expect(screen.getByRole("region", { name: "The media helper's packages" }).textContent).toMatch(/added by the desktop build/);
  });

  it("lists the service's npm packages and the worker's licence manifest from the desktop build", () => {
    render(<About notices={{ npm: NPM, worker: WORKER }} />);
    const npm = screen.getByRole("table", { name: "npm packages in the library service" });
    const rows = within(npm).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[2]!.textContent).toContain("citeproc");
    expect(rows[2]!.textContent).toContain("CPAL-1.0 OR AGPL-3.0-or-later");
    const py = screen.getByRole("table", { name: "Python packages in the media helper" });
    expect(within(py).getByText("pillow")).toBeTruthy();
    const native = screen.getByRole("table", { name: "Native libraries in the media helper" });
    expect(within(native).getByText("LGPL-2.1-or-later")).toBeTruthy();
    expect(screen.getByRole("region", { name: "The media helper's packages" }).textContent).toContain("ffmpeg");
  });

  it("a damaged worker manifest is said to be unreadable, not shown half", () => {
    render(<About notices={{ worker: "{not json" }} />);
    expect(screen.getByRole("region", { name: "The media helper's packages" }).textContent).toMatch(/could not be read/);
  });

  it("each licence text is a native disclosure (keyboard: Tab to its summary, Enter or Space opens it)", async () => {
    const user = userEvent.setup();
    render(<About />);
    const summaries = [...document.querySelectorAll("summary")];
    expect(summaries.length).toBeGreaterThanOrEqual(5);
    for (const s of summaries) expect(s.parentElement?.tagName).toBe("DETAILS");
    const summary = screen.getByText("The CPAL-1.0 licence text");
    await user.click(summary);
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("reads the npm table from the service build's notices file", () => {
    expect(parseNpmNotices(NPM)).toEqual([
      { name: "@fastify/error", version: "4.2.1", licence: "MIT", how: "bundled" },
      { name: "citeproc", version: "2.4.63", licence: "CPAL-1.0 OR AGPL-3.0-or-later", how: "copied" },
    ]);
    expect(parseNpmNotices("no table")).toEqual([]);
    // In this checkout the desktop build's data is either absent or a list that parses.
    if (BUILT_NOTICES.npm) expect(parseNpmNotices(BUILT_NOTICES.npm).length).toBeGreaterThan(0);
  });
});

describe("reaching the About screen", () => {
  it("is registered at /about, with the link back to the library", () => {
    const owners = ROUTES.filter((r) => r.matches("/about"));
    expect(owners).toHaveLength(1);
    expect(owners[0]!.back).toBe(true);
    render(<>{routeFor({ pathname: "/about", search: "" } satisfies AppLocation, createClient(BASE, TOKEN))}</>);
    expect(screen.getByRole("heading", { level: 1, name: "About and third-party notices" })).toBeTruthy();
  });

  it("the library chooser links to it", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })));
    render(<LibraryChooser api={testApi()} onOpened={() => {}} onNotFound={() => {}} />);
    const link = await screen.findByRole("link", { name: "About and third-party notices" });
    expect(link.getAttribute("href")).toBe("/about");
  });
});
