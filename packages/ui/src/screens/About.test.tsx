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
import { BASE, CURRENT_RW, libraryHandlers, server, TOKEN, testApi, url, useMockService } from "../test/service";
import ABOUT_SOURCE from "./About.tsx?raw";
import { About, BUILT_LICENCE_TEXTS, BUILT_NOTICES, parseNpmNotices } from "./About";
import { Library } from "./Library";
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

  it("lists the shell's own Rust crates (MPL-2.0 ones with where their source is) and the interface's npm packages (R159 c)", () => {
    const crates = JSON.stringify([
      { name: "cssparser", version: "0.29.6", licence: "MPL-2.0", source: "https://github.com/servo/rust-cssparser (version 0.29.6; also https://crates.io/crates/cssparser/0.29.6)" },
      { name: "tauri", version: "2.12.5", licence: "Apache-2.0 OR MIT" },
    ]);
    const npm = JSON.stringify([{ name: "react", version: "19.3.1", licence: "MIT" }]);
    render(<About notices={{ crates, interfaceNpm: npm }} />);
    const rust = screen.getByRole("table", { name: "Rust crates in the app" });
    expect(within(rust).getAllByRole("row")).toHaveLength(3);
    expect(within(rust).getByText("Apache-2.0 OR MIT")).toBeTruthy();
    expect(rust.textContent).toContain("https://github.com/servo/rust-cssparser (version 0.29.6");
    const ui = screen.getByRole("table", { name: "npm packages in the interface" });
    expect(within(ui).getByText("react")).toBeTruthy();
  });

  it("without the desktop build's data, says where the shell's lists come from", () => {
    render(<About notices={{}} />);
    expect(screen.getByRole("region", { name: "The app's own Rust crates" }).textContent).toMatch(/added by the desktop build/);
    expect(screen.getByRole("region", { name: "The interface's npm packages" }).textContent).toMatch(/added by the desktop build/);
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

describe("full licence texts (Task 37j)", () => {
  const deferred = () => {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("offers each part's texts and loads one only when asked, once, shown as text", async () => {
    const user = userEvent.setup();
    const d = deferred();
    let calls = 0;
    const crates = () => {
      calls++;
      return d.promise;
    };
    render(<About notices={{}} licenceTexts={{ "shell-crates": crates, node: () => Promise.resolve("Node.js v22") }} />);
    const region = screen.getByRole("region", { name: "Full licence texts" });
    expect(calls).toBe(0); // nothing is loaded at start
    const button = within(region).getByRole("button", { name: "Show the licence texts of the app's Rust crates" });
    expect(within(region).getByRole("button", { name: "Show the licence texts of Node.js" })).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.dblClick(button);
    expect(calls).toBe(1);
    expect(region.textContent).toMatch(/Loading/);
    d.resolve("Copyright (c) 2020 <b>Ann</b>\nterms");
    const shown = await within(region).findByText(/Copyright \(c\) 2020 <b>Ann<\/b>/);
    expect(shown.querySelector("b")).toBeNull(); // text, never markup
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(shown.closest("[id]")?.id).toBe(button.getAttribute("aria-controls"));
    await user.click(button); // hides it again; a second show does not load again
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);
    expect(calls).toBe(1);
  });

  it("a text that cannot be loaded is said so in plain words, and can be tried again", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const load = () => (++calls === 1 ? Promise.reject(new Error("chunk failed /assets/x.js")) : Promise.resolve("MIT terms"));
    render(<About notices={{}} licenceTexts={{ "interface-npm": load }} />);
    const button = screen.getByRole("button", { name: "Show the licence texts of the interface's npm packages" });
    await user.click(button);
    expect(await screen.findByText("These licence texts could not be loaded. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("/assets/x.js");
    await user.click(button); // one click tries again (review M7)
    expect(await screen.findByText("MIT terms")).toBeTruthy();
    expect(calls).toBe(2);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("an answer that arrives after the screen is gone is dropped", async () => {
    const d = deferred();
    const user = userEvent.setup();
    const { unmount } = render(<About notices={{}} licenceTexts={{ worker: () => d.promise }} />);
    await user.click(screen.getByRole("button", { name: "Show the licence texts of the media helper's Python packages" }));
    unmount();
    d.resolve("late");
    await d.promise;
    expect(document.body.textContent).not.toContain("late");
  });

  it("without the desktop build's texts, says where they come from", () => {
    render(<About notices={{}} licenceTexts={{}} />);
    expect(screen.getByRole("region", { name: "Full licence texts" }).textContent).toMatch(/added by the desktop build/);
  });

  it("the build's texts are loaded on demand, never part of the main bundle (review M2)", () => {
    for (const load of Object.values(BUILT_LICENCE_TEXTS)) expect(typeof load).toBe("function");
    for (const text of Object.values(BUILT_NOTICES)) expect(text).not.toMatch(/^=== Text 1 of/m);
    // What the bundler sees: the texts' glob is lazy, and the eager glob takes only the lists.
    const source = ABOUT_SOURCE;
    const globs = [...source.matchAll(/import\.meta\.glob\(\s*"([^"]*generated\/notices[^"]*)"\s*,\s*\{([^}]*)\}/g)].map((m) => ({ pattern: m[1], options: m[2] }));
    const texts = globs.filter((g) => g.pattern.includes("LICENCES"));
    expect(texts).toHaveLength(1);
    expect(texts[0]!.options).not.toMatch(/eager/);
    const eager = globs.filter((g) => /eager:\s*true/.test(g.options));
    expect(eager).toHaveLength(1);
    expect(eager[0]!.pattern).toMatch(/\*\.\{json,md\}$/);
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

  it("an open library's header links to it (R159 b)", async () => {
    server.use(...libraryHandlers());
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const link = await screen.findByRole("link", { name: "About and third-party notices" });
    expect(link.getAttribute("href")).toBe("/about");
  });

  it("the library chooser links to it", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })));
    render(<LibraryChooser api={testApi()} onOpened={() => {}} onNotFound={() => {}} />);
    const link = await screen.findByRole("link", { name: "About and third-party notices" });
    expect(link.getAttribute("href")).toBe("/about");
  });
});
