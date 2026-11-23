import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyProgress, linkQueue, markGap, profileQueue, UNKNOWN_OUTCOME_TEXT, type CaptureQueueState } from "../api/capture";
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
    expect(screen.getByText("Of 3 links: 1 done, 1 failed, 1 still to come.")).toBeTruthy();
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

  it("FR-106: posts that look edited but could not be checked are counted in the summary", () => {
    let q = profileQueue("q8", "https://www.instagram.com/someone/");
    q = applyProgress(q, {
      queueId: "q8",
      projectId: P,
      finished: true,
      report: { status: "completed", listComplete: true, created: 0, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, editsNotChecked: 2, items: [] },
    });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText(/2 possible edits not checked \(capture the profile again later to check them\)/)).toBeTruthy();
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

  it("the reviewer's gap: a link whose outcome was missed is 'Not known', and the summary claims only what was seen", () => {
    let q = linkQueue("q1", [A, B, C]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: A, status: "created" } });
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 3, total: 3, finished: true, outcome: { url: C, status: "created" } });
    const { container } = render(<CaptureQueue queues={[q]} />);
    const row = screen.getAllByRole("listitem")[1]!;
    expect(within(row).getByText("Not known")).toBeTruthy();
    expect(within(row).getByText(/progress was missed/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/not tried|3 of 3/);
    expect(screen.getByText("Finished. Of 3 links: 2 done, 1 not known.")).toBeTruthy();
    expect(screen.getByText(/look for its sources in the library/)).toBeTruthy();
  });

  it("a queue with a gap in its progress says so and what to do", () => {
    let q = linkQueue("q1", [A, B]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 2, finished: false, outcome: { url: A, status: "created" } });
    q = markGap(q);
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText(/Progress was missed while the connection to the library service was down/)).toBeTruthy();
    // Task 63: the screen reads the queue again once it can.
    expect(screen.getByText(/updated as soon as the library service can be reached again/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/cannot re-read/);
  });

  it("a queue sent from the browser extension says so (Task 63)", () => {
    render(<CaptureQueue queues={[{ ...linkQueue("q1", [A]), startedBy: "extension" }]} />);
    expect(screen.getByText("Sent from the browser extension.")).toBeTruthy();
  });

  it("a long profile run whose later posts the service did not keep says so (Task 63)", () => {
    const q = { ...profileQueue("qp", "https://www.instagram.com/someone/"), items: [{ url: A, state: "created" }], done: 3, total: 3, itemsOmitted: 2 };
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText(/kept only the first 1 posts of this run; 2 later posts are counted above but not listed/)).toBeTruthy();
  });

  it("a profile run stopped by a missing tool links to the Optional tools screen for that tool (Task 63 carries the tool id)", () => {
    const q = { ...profileQueue("qp", "https://www.instagram.com/someone/"), finished: true, errorCode: "TOOL_NOT_INSTALLED", tool: "image-downloader", stopReason: "The image downloader is not installed on this computer, so nothing was saved." };
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByRole("link", { name: /Optional tools/ }).getAttribute("href")).toMatch(/tool=image-downloader/);
  });

  it("the reviewer's profile scenario: posts saved, then stopped by a rules change — the library's sentence and the counts, together", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, done: 1, total: 3, finished: false, outcome: { url: B, status: "created" } });
    const sentence = "This project's rules changed during the capture. Posts saved before the change are kept; nothing else was saved.";
    q = applyProgress(q, {
      queueId: "q9",
      projectId: P,
      finished: true,
      report: { status: "failed", listComplete: false, created: 1, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [], errorCode: "POLICY_CHANGED", reason: sentence },
    });
    const { container } = render(<CaptureQueue queues={[q]} />);
    const said = screen.getByText(sentence);
    expect(said.getAttribute("dir")).toBe("auto");
    expect(screen.getByText(/1 new post saved/)).toBeTruthy();
    expect(within(screen.getAllByRole("listitem")[0]!).getByText("Saved")).toBeTruthy();
    expect(container.textContent).not.toMatch(/during the download, so nothing was saved/);
  });

  it("a rate-limit pause shows the library's sentence and what was saved", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    const sentence = "The platform is limiting requests, so the profile capture was paused. Run it again later; it continues where it stopped.";
    q = applyProgress(q, {
      queueId: "q9",
      projectId: P,
      finished: true,
      report: { status: "paused-rate-limited", listComplete: false, created: 4, duplicates: 2, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [], reason: sentence },
    });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.getByText(/4 new posts saved, 2 already in the project/)).toBeTruthy();
  });

  it("the library's note on a saved link is shown (review M1)", () => {
    let q = linkQueue("q1", [A]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: A, status: "created", reason: "The source was saved, but the transcript could not be made." } });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText("The source was saved, but the transcript could not be made.").getAttribute("dir")).toBe("auto");
  });

  it("a rule's reason is shown as user text (review M6)", () => {
    let q = linkQueue("q1", [A]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: A, status: "failed", errorCode: "POLICY_DENIED", reason: "لا يسمح بالتنزيل" } });
    render(<CaptureQueue queues={[q]} />);
    expect(screen.getByText("لا يسمح بالتنزيل").getAttribute("dir")).toBe("auto");
  });

  it("announces a queue when it ends, not on every link (review M5)", () => {
    const running = three();
    const { rerender } = render(<CaptureQueue queues={[running]} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Of 3 links: 1 done, 1 failed, 1 still to come.").getAttribute("role")).toBeNull();
    const ended = applyProgress(running, { queueId: "q1", projectId: P, done: 3, total: 3, finished: true, outcome: { url: C, status: "created" } });
    rerender(<CaptureQueue queues={[ended]} />);
    expect(screen.getByRole("status").textContent).toBe("Finished. Of 3 links: 2 done, 1 failed.");
  });

  it("after the stream is lost, unfinished links are not known and nothing claims a capture is running (review N1)", () => {
    const q = markGap(three());
    render(<CaptureQueue queues={[q]} />);
    expect(screen.queryByText(/Capturing now|Waiting/)).toBeNull();
    expect(screen.getByText("Of 3 links: 1 done, 1 failed, 1 not known.")).toBeTruthy();
  });

  it("nothing queued: nothing shown", () => {
    const { container } = render(<CaptureQueue queues={[]} />);
    expect(container.textContent).toBe("");
  });
});
