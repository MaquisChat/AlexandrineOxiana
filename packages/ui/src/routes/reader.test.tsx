/**
 * The reader's route (Task R7): `/reader?project=<id>&source=<id>[&asset=<id>][&annotation=<id>]`,
 * ids only; the way in from a source ("Read the PDF"); the route reads the source and the library's
 * mode and opens the first PDF, offering a "File" choice when the source has several.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES, routeFor } from "../App";
import { isReadablePdf, ReaderLink } from "../components/ReaderLink";
import { PATHS, useLocation } from "../navigation";
import { CURRENT_RW, LIBRARIES, PROJECTS, server, serviceError, SOURCE_FILE, sse, testClient, url, useMockService } from "../test/service";
import { isReaderPath, readerHref } from "./reader";

// The screen itself is tested in screens/Reader.test.tsx; here only which document it is given.
vi.mock("../screens/Reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../screens/Reader")>()),
  ReaderScreen: (p: { projectId: string; sourceId: string; assetId?: string; annotationId?: string; readOnly: boolean }) => (
    <p data-testid="reader-screen">{`${p.projectId}|${p.sourceId}|${p.assetId ?? "-"}|${p.annotationId ?? "-"}|${p.readOnly ? "read-only" : "read-write"}`}</p>
  ),
}));

useMockService();

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
  window.history.replaceState(null, "", "/");
});

function Host() {
  return routeFor(useLocation(), testClient());
}

const pdf = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  sourceId: "s1",
  role: "original",
  kind: "pdf",
  path: `Dissertation/Sources/s1/${name}`,
  encrypted: false,
  sha256: "0".repeat(64),
  bytes: 1024,
  mime: "application/pdf",
  ...extra,
});

function serve(opts: { assets?: unknown[]; mode?: "read-write" | "read-only"; source?: () => Response } = {}) {
  const requests: string[] = [];
  server.use(
    // The reader listens for the library's state (A9); nothing is sent here.
    http.get(url("/events"), () => sse([])),
    http.get(url("/projects"), () => HttpResponse.json(PROJECTS)),
    http.get(url("/libraries"), ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json({ ...LIBRARIES, current: { ...CURRENT_RW, mode: opts.mode ?? "read-write" } });
    }),
    http.get(url("/projects/:id/sources/:sid"), ({ request }) => {
      requests.push(request.url);
      return opts.source ? opts.source() : HttpResponse.json({ ...SOURCE_FILE, assets: opts.assets ?? SOURCE_FILE.assets });
    }),
  );
  return requests;
}

describe("reader route (Task R7)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));

  it("readerHref carries ids only", () => {
    expect(PATHS.reader).toBe("/reader");
    expect(isReaderPath("/reader")).toBe(true);
    expect(isReaderPath("/reader/")).toBe(true);
    expect(isReaderPath("/transcript")).toBe(false);
    expect(ROUTES.some((r) => r.matches("/reader"))).toBe(true);
    expect(readerHref("p 1", "s/1")).toBe("/reader?project=p+1&source=s%2F1");
    expect(readerHref("p1", "s1", { assetId: "a1" })).toBe("/reader?project=p1&source=s1&asset=a1");
    expect(readerHref("p1", "s1", { assetId: "a1", annotationId: "n1" })).toBe("/reader?project=p1&source=s1&asset=a1&annotation=n1");
    expect(readerHref("p1", "s1", { annotationId: "n1" })).toBe("/reader?project=p1&source=s1&annotation=n1");
    // Nothing but these four names is ever in the address.
    const q = new URLSearchParams(readerHref("p1", "s1", { assetId: "a1", annotationId: "n1" }).split("?")[1]);
    expect([...q.keys()]).toEqual(["project", "source", "asset", "annotation"]);
  });

  it("a live original PDF offers Read the PDF, which opens the reader in place", async () => {
    expect(isReadablePdf({ role: "original", kind: "pdf", mime: "application/pdf" })).toBe(true);
    expect(isReadablePdf({ role: "original", kind: "pdf", mime: "application/pdf", status: "destroyed" })).toBe(false);
    expect(isReadablePdf({ role: "derived", kind: "ocr-text", mime: "application/pdf" })).toBe(false);
    expect(isReadablePdf({ role: "original", kind: "image", mime: "image/png" })).toBe(false);
    const none = render(<ReaderLink projectId="p1" sourceId="s1" assets={[{ role: "original", kind: "video", mime: "video/mp4" }]} />);
    expect(none.container.textContent).toBe("");
    none.unmount();

    serve();
    render(<ReaderLink projectId="p1" sourceId="s1" assets={[{ role: "original", kind: "pdf", mime: "application/pdf" }]} />);
    const link = screen.getByRole("link", { name: "Read the PDF" });
    expect(link.getAttribute("href")).toBe("/reader?project=p1&source=s1");
    await userEvent.setup().click(link);
    expect(window.location.pathname).toBe("/reader");
    expect(window.location.search).toBe("?project=p1&source=s1");
  });

  it("opens the first PDF of the source, read-write, with Back to library for its project", async () => {
    serve();
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("p1|s1|a1|-|read-write");
    expect(screen.getByRole("link", { name: "Back to library" }).getAttribute("href")).toBe("/?project=p1");
    // The source's title, through UserText.
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("Ethnography at Work");
    expect(h1.querySelector("[dir=auto]")).not.toBeNull();
    // One file: no choice offered.
    expect(screen.queryByRole("group", { name: "File" })).toBeNull();
  });

  it("a read-only library opens the reader read-only", async () => {
    serve({ mode: "read-only" });
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&annotation=n1");
    render(<Host />);
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("p1|s1|a1|n1|read-only");
  });

  it("with several PDFs it opens the first and offers a File choice by file name, which moves to the other", async () => {
    serve({ assets: [pdf("a1", "chapter-1.pdf"), pdf("a9", "gone.pdf", { status: "destroyed" }), { ...pdf("x1", "scan.png"), mime: "image/png", kind: "image" }, pdf("a2", "chapter-2.pdf")] });
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("p1|s1|a1|-|read-write");
    const group = screen.getByRole("group", { name: "File" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["chapter-1.pdf", "chapter-2.pdf"]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    await userEvent.setup().click(radios[1]!);
    expect(window.location.search).toBe("?project=p1&source=s1&asset=a2");
    await waitFor(() => expect(screen.getByTestId("reader-screen").textContent).toBe("p1|s1|a2|-|read-write"));
  });

  it("an asset named in the address that is not a readable PDF of the source opens the first one", async () => {
    serve({ assets: [pdf("a1", "chapter-1.pdf"), pdf("a2", "chapter-2.pdf")] });
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&asset=a2");
    render(<Host />);
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("p1|s1|a2|-|read-write");
    cleanup();
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&asset=zz");
    render(<Host />);
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("p1|s1|a1|-|read-write");
  });

  it("a source with no PDF says so", async () => {
    serve({ assets: [{ ...pdf("x1", "scan.png"), mime: "image/png", kind: "image" }] });
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await screen.findByText("This source has no PDF that can be shown here.")).toBeTruthy();
    expect(screen.queryByTestId("reader-screen")).toBeNull();
  });

  it("a locked project and an unreachable service each say so in plain words", async () => {
    serve({ source: () => serviceError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.") as unknown as Response });
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await screen.findByText("This project is locked. Unlock it in the library to read its files.")).toBeTruthy();
    // A locked project points to the library; trying again here cannot help (A9).
    expect(screen.getByRole("main").querySelector(".ao-reader-state a")?.getAttribute("href")).toBe("/?project=p1");
    expect(screen.getByRole("link", { name: "Go to the library" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open again" })).toBeNull();
    cleanup();
    let up = false;
    server.use(
      http.get(url("/libraries"), () => (up ? HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW }) : HttpResponse.error())),
      http.get(url("/projects/:id/sources/:sid"), () => (up ? HttpResponse.json(SOURCE_FILE) : HttpResponse.error())),
    );
    render(<Host />);
    expect(await screen.findByText("The library service could not be reached, so this PDF cannot be shown. Try again in a moment.")).toBeTruthy();
    // Out of reach: trying again can help, and it reads the source again.
    up = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "Open again" }));
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("p1|s1|a1|-|read-write");
  });

  it("an address without a source says what to do", () => {
    window.history.replaceState(null, "", "/reader?project=p1");
    render(<Host />);
    expect(screen.getByText(/No source is named in this address/)).toBeTruthy();
  });
});
