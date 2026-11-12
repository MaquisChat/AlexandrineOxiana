import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClientError } from "../api/client";
import { PATHS } from "../navigation";
import { MissingToolNotice, missingToolOf, SourceToolNotice } from "./MissingToolNotice";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const missing = (reason?: string) => new ApiClientError(409, { code: "TOOL_NOT_INSTALLED", message: "A tool this needs is not installed on this computer.", ...(reason ? { reason } : {}) });

describe("missingToolOf", () => {
  it("reads the service's error (409 TOOL_NOT_INSTALLED, the tool id in reason)", () => {
    expect(missingToolOf(missing("speech-small"))).toEqual({ tool: "speech-small" });
    expect(missingToolOf(missing("not-a-tool"))).toEqual({});
    expect(missingToolOf(new ApiClientError(409, { code: "CONFLICT", message: "x" }))).toBeUndefined();
  });

  it("reads a capture outcome's code (and its tool when one is given)", () => {
    expect(missingToolOf({ errorCode: "TOOL_NOT_INSTALLED" })).toEqual({});
    expect(missingToolOf({ errorCode: "TOOL_NOT_INSTALLED", tool: "video-downloader" })).toEqual({ tool: "video-downloader" });
    expect(missingToolOf({ errorCode: "NOT_FOUND_OR_REMOVED" })).toBeUndefined();
    expect(missingToolOf(undefined)).toBeUndefined();
    expect(missingToolOf("TOOL_NOT_INSTALLED")).toBeUndefined();
  });
});

describe("MissingToolNotice", () => {
  it("names the tool in a plain sentence and links to the tools screen", async () => {
    render(<MissingToolNotice from={missing("speech-small")} />);
    expect(screen.getByText(/speech model “small” is not installed/i)).toBeTruthy();
    expect(screen.queryByText(/speech-small/)).toBeNull(); // never the raw id
    const link = screen.getByRole("link", { name: /optional tools/i });
    expect(link.getAttribute("href")).toBe(`${PATHS.tools}?tool=speech-small`);
    await userEvent.setup().click(link);
    expect(window.location.pathname).toBe(PATHS.tools);
    expect(window.location.search).toBe("?tool=speech-small");
  });

  it("without a tool id it says, in neutral words, that a tool is missing and links to the screen", () => {
    render(<MissingToolNotice from={{ errorCode: "TOOL_NOT_INSTALLED" }} />);
    expect(screen.getByText(/^A tool this needs is not installed on this computer\./)).toBeTruthy();
    expect(screen.queryByText(/downloader/)).toBeNull();
    expect(screen.getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(PATHS.tools);
  });

  it("after the service's own sentence (a capture outcome's reason) it adds only the link", () => {
    const reason = "The video downloader is not installed on this computer, so nothing was saved. Install it from the tools dialogue, then capture the link again.";
    render(<MissingToolNotice from={{ errorCode: "TOOL_NOT_INSTALLED", reason, tool: "video-downloader" }} />);
    expect(screen.queryByText(/is not installed/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open the optional tools screen" }).getAttribute("href")).toBe(`${PATHS.tools}?tool=video-downloader`);
  });

  it("shows its children (the usual message) for any other failure", () => {
    render(
      <p>
        <MissingToolNotice from={new ApiClientError(500, { code: "INTERNAL", message: "x" })}>Usual message.</MissingToolNotice>
      </p>,
    );
    expect(screen.getByText("Usual message.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names ffmpeg with what going without it means", () => {
    render(<MissingToolNotice from={missing("ffmpeg")} />);
    expect(screen.getByText(/ffmpeg/)).toBeTruthy();
    expect(screen.getByText(/proxy pending/)).toBeTruthy();
  });
});

describe("SourceToolNotice (the source's viewing-copy and OCR state)", () => {
  const file = (extra: Record<string, unknown>) => ({ formatVersion: 1, source: {}, assets: [], ...extra });

  it("says a video's viewing copy waits for ffmpeg, stays proxy pending and is left out of exports", () => {
    render(
      <SourceToolNotice
        file={file({ pendingProxies: [{ id: "j1", type: "video.proxy", assetId: "a1", location: "coarsen", queuedAt: "2026-11-01T00:00:00Z", failed: { code: "TOOL_NOT_INSTALLED", at: "2026-11-01T00:01:00Z" } }] })}
      />,
    );
    expect(screen.getByText(/proxy pending/)).toBeTruthy();
    expect(screen.getByText(/left out of exports/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(`${PATHS.tools}?tool=ffmpeg`);
  });

  it("says scanned pages wait for OCR", () => {
    render(<SourceToolNotice file={file({ pendingOcr: [{ id: "o1", assetId: "a1", queuedAt: "2026-11-01T00:00:00Z", failed: { code: "TOOL_NOT_INSTALLED", at: "2026-11-01T00:01:00Z" } }] })} />);
    expect(screen.getByText(/text recognition/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(`${PATHS.tools}?tool=ocr`);
  });

  it("shows nothing for a source with no job waiting for a tool", () => {
    const { container } = render(
      <SourceToolNotice
        file={file({ pendingProxies: [{ id: "j1", type: "video.proxy", assetId: "a1", location: "coarsen", queuedAt: "2026-11-01T00:00:00Z", failed: { code: "LOCATION_MISMATCH", at: "x" } }] })}
      />,
    );
    expect(container.textContent).toBe("");
    render(<SourceToolNotice file={undefined} />);
  });
});
