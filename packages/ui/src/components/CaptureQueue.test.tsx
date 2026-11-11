import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyProgress, linkQueue, profileQueue, UNKNOWN_OUTCOME_TEXT, type CaptureQueueState } from "../api/capture";
import { CaptureQueue } from "./CaptureQueue";

const P = "019a6f00-0000-7000-8000-000000000001";
const A = "https://www.youtube.com/watch?v=aaaaaaaa";
const B = "https://www.instagram.com/p/Bbbbbb/";
const C = "https://www.tiktok.com/@x/video/123";

function three(): CaptureQueueState {
  let q = linkQueue("q1", [A, B, C]);
  q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: A, status: "created", sourceId: "s1" } });
  q = applyProgress(q, { queueId: "q1", projectId: P, done: 2, total: 3, finished: false, outcome: { url: B, status: "failed", errorCode: "LOGIN_REQUIRED", reason: "service words" } });
  return q;
}

describe("CaptureQueue", () => {
  it("shows each link with its status in words and the queue's progress", () => {
    render(<CaptureQueue queues={[three()]} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Saved")).toBeTruthy();
    expect(within(rows[1]!).getByText("Failed")).toBeTruthy();
    expect(within(rows[2]!).getByText("Capturing now")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Links captured" }).getAttribute("value")).toBe("2");
    expect(screen.getByRole("progressbar", { name: "Links captured" }).getAttribute("max")).toBe("3");
    expect(screen.getByText(/2 of 3 links done/)).toBeTruthy();
  });

  it("a failed link shows the LOGIN_REQUIRED sentence", () => {
    render(<CaptureQueue queues={[three()]} />);
    const row = screen.getAllByRole("listitem")[1]!;
    expect(within(row).getByText("This post needs a signed-in session. Try again with “Use my browser session”.")).toBeTruthy();
  });

  it("links are shown as user text (dir=auto), never as live links", () => {
    render(<CaptureQueue queues={[three()]} />);
    const el = screen.getByText(A);
    expect(el.getAttribute("dir")).toBe("auto");
    expect(el.closest("a")).toBeNull();
  });

  it("an unknown outcome code gets a safe sentence and never shows the code", () => {
    let q = linkQueue("q1", [A]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: A, status: "failed", errorCode: "BRAND_NEW_CODE" } });
    const { container } = render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText(UNKNOWN_OUTCOME_TEXT)).toBeTruthy();
    expect(container.textContent).not.toMatch(/BRAND_NEW_CODE/);
  });

  it("an unknown status is still shown in words", () => {
    let q = linkQueue("q1", [A]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: A, status: "teleported" } });
    const { container } = render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(container.textContent).not.toMatch(/teleported/);
  });

  it("a queue that stopped says so in plain words; links not tried are marked", () => {
    let q = three();
    q = applyProgress(q, { queueId: "q1", projectId: P, finished: true, error: "WorkerUnavailableError: connect ECONNREFUSED 127.0.0.1:5555" });
    const { container } = render(<CaptureQueue queues={[q]} />);
    expect(screen.getByRole("alert").textContent).toMatch(/media helper is not running/);
    expect(within(screen.getAllByRole("listitem")[2]!).getByText("Not captured")).toBeTruthy();
    expect(container.textContent).not.toMatch(/ECONNREFUSED|WorkerUnavailableError/);
  });

  it("a duplicate, a refresh, a partial save and a review are each named", () => {
    let q = linkQueue("q1", [A, B, C, "https://youtu.be/dddddddd"]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 4, finished: false, outcome: { url: A, status: "duplicate" } });
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 2, total: 4, finished: false, outcome: { url: B, status: "refreshed" } });
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 3, total: 4, finished: false, outcome: { url: C, status: "incomplete", errorCode: "NO_MEDIA" } });
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 4, total: 4, finished: true, outcome: { url: "https://youtu.be/dddddddd", status: "needs-review" } });
    render(<CaptureQueue queues={[q]} />);
    for (const t of ["Already in the project", "Saved again with a new dated snapshot", "Saved in part", "Saved; needs review"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText(/no media file came back/)).toBeTruthy();
  });

  it("a profile run lists its posts and ends with a summary; removed-post detection off is said", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, done: 1, total: 2, finished: false, outcome: { url: B, status: "created" } });
    q = applyProgress(q, {
      queueId: "q9",
      projectId: P,
      finished: true,
      report: { status: "completed", listComplete: false, created: 1, duplicates: 1, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [] },
    });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText("https://www.instagram.com/someone/")).toBeTruthy();
    expect(screen.getByText(/1 new post saved, 1 already in the project/)).toBeTruthy();
    expect(screen.getByText(/Removed posts were not looked for/)).toBeTruthy();
  });

  it("a profile run refused for want of a legal basis explains it", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, {
      queueId: "q9",
      projectId: P,
      finished: true,
      report: { status: "failed", listComplete: false, created: 0, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [], errorCode: "LEGAL_BASIS_REQUIRED" },
    });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByRole("alert").textContent).toMatch(/need a legal basis/);
  });

  it("nothing queued: nothing shown", () => {
    const { container } = render(<CaptureQueue queues={[]} />);
    expect(container.textContent).toBe("");
  });
});
