/**
 * The missing-tool notice where the error is met (Task 48b): the capture queue's outcomes, the
 * transcript viewer and the source screen's viewing-copy state. Own file, so the screens' own test
 * files (edited by other tasks) are untouched.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProgress, linkQueue, profileQueue } from "../api/capture";
import { transcriptApi } from "../api/transcripts";
import { PATHS } from "../navigation";
import { SourceDetail } from "../screens/SourceDetail";
import { resetTranscriptionRuns } from "../screens/transcriptionRuns";
import { TranscriptViewer } from "../screens/TranscriptViewer";
import { serviceErrorBody, transcriptService } from "../test/msw-transcripts";
import { server, SOURCE_FILE, STYLES, testApi, testClient, url, useMockService } from "../test/service";
import { CaptureQueue } from "./CaptureQueue";

useMockService();

const P = "019a6f00-0000-7000-8000-000000000001";
const A = "https://www.youtube.com/watch?v=aaaaaaaa";

beforeEach(() => {
  resetTranscriptionRuns();
});

describe("the capture queue", () => {
  it("a link that failed for a missing downloader says so and links to the tools screen", () => {
    let q = linkQueue("q1", [A]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: A, status: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: "The capture failed." } });
    render(<CaptureQueue queues={[q]} />);
    const row = screen.getAllByRole("listitem")[0]!;
    expect(within(row).getByText(/downloader .* is not installed/i)).toBeTruthy();
    expect(within(row).getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(PATHS.tools);
  });

  it("a profile run stopped by a missing downloader says so too", () => {
    let q = profileQueue("q2", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q2", projectId: P, done: 0, finished: true, report: { status: "failed", created: 0, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, listComplete: false, errorCode: "TOOL_NOT_INSTALLED" } } as never);
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByRole("link", { name: /optional tools/i })).toBeTruthy();
  });

  it("other failures show no tools link", () => {
    let q = linkQueue("q1", [A]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: A, status: "failed", errorCode: "LOGIN_REQUIRED" } });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the transcript viewer", () => {
  it("a speech model that is not installed is named, with a link to install it (no raw id)", async () => {
    const svc = transcriptService();
    server.use(...svc.handlers);
    const view = render(<TranscriptViewer api={transcriptApi(testClient())} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcribe"), () =>
        serviceErrorBody(409, "TOOL_NOT_INSTALLED", "A tool this needs is not installed on this computer. It can be installed from the tools dialogue.", "speech-small"),
      ),
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Speech model"), "small");
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/speech model “small” is not installed/i);
    expect(alert.textContent).not.toMatch(/speech-small|TOOL_NOT_INSTALLED/);
    expect(within(alert).getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(`${PATHS.tools}?tool=speech-small`);
    view.unmount(); // its media ticket is revoked while the handlers are still in place
  });
});

describe("the source screen", () => {
  it("a video whose viewing copy waits for ffmpeg says it stays proxy pending and is left out of exports", async () => {
    const file = {
      ...SOURCE_FILE,
      pendingProxies: [{ id: "j1", type: "video.proxy", assetId: "a1", location: "coarsen", queuedAt: "2026-11-01T00:00:00Z", failed: { code: "TOOL_NOT_INSTALLED", at: "2026-11-01T00:01:00Z", attempts: 3 } }],
    };
    server.use(http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(file)), http.get(url("/styles"), () => HttpResponse.json(STYLES)));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const note = await screen.findByText(/proxy pending/);
    expect(note.textContent).toMatch(/left out of exports/);
    expect(screen.getByRole("link", { name: /Install ffmpeg/ }).getAttribute("href")).toBe(`${PATHS.tools}?tool=ffmpeg`);
  });
});
