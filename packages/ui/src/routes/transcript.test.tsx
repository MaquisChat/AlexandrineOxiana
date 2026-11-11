import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES, routeFor } from "../App";
import { TranscriptLink, transcriptHref } from "../components/TranscriptLink";
import { PATHS, useLocation } from "../navigation";
import { transcriptService } from "../test/msw-transcripts";
import { server, testClient, useMockService } from "../test/service";
import { isTranscriptPath } from "./transcript";

useMockService();

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function Host() {
  return routeFor(useLocation(), testClient());
}

describe("transcript route (Task 34c)", () => {
  it("is in the route table on /transcript with the project and source in the query", () => {
    expect(PATHS.transcript).toBe("/transcript");
    expect(isTranscriptPath("/transcript/")).toBe(true);
    expect(ROUTES.some((r) => r.matches("/transcript"))).toBe(true);
    expect(transcriptHref("p 1", "s1")).toBe("/transcript?project=p+1&source=s1");
  });

  it("a source's link opens the viewer in place, with Back to library for its project", async () => {
    const svc = transcriptService();
    server.use(...svc.handlers);
    const assets = [{ role: "derived", kind: "transcript", mime: "text/vtt" }];
    const { unmount } = render(<TranscriptLink projectId="p1" sourceId="s1" assets={assets} />);
    await userEvent.setup().click(screen.getByRole("link", { name: "Open the transcript" }));
    expect(window.location.pathname).toBe("/transcript");
    expect(window.location.search).toBe("?project=p1&source=s1");
    unmount();
    render(<Host />);
    expect(await screen.findByText("Hello and welcome.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" }).getAttribute("href")).toBe("/?project=p1");
  });

  it("the link is absent for a source with neither a transcript nor a recording", () => {
    const { container } = render(<TranscriptLink projectId="p1" sourceId="s1" assets={[{ role: "original", kind: "document", mime: "application/pdf" }]} />);
    expect(container.textContent).toBe("");
    render(<TranscriptLink projectId="p1" sourceId="s1" assets={[{ role: "original", kind: "video", mime: "video/mp4" }]} />);
    expect(screen.getByRole("link", { name: "Play the recording and transcribe it" })).toBeTruthy();
  });

  it("an address without a source says what to do", () => {
    window.history.replaceState(null, "", "/transcript?project=p1");
    render(<Host />);
    expect(screen.getByText(/No source is named in this address/)).toBeTruthy();
  });
});
