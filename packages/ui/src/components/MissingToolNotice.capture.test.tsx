/**
 * The capture screen and the optional tools (Task 48b). Its own file: the capture fixtures have
 * their own mock server (test/captureService.ts).
 */
import { SPEECH_MODELS } from "@ao/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PATHS } from "../navigation";
import { Capture } from "../screens/Capture";
import { mockCapture, P1, server } from "../test/captureService";
import { catalogue } from "../test/msw-tools";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const model = () => screen.getByRole("combobox", { name: "Transcription model" }) as HTMLSelectElement;
const installed = (...ids: string[]) => catalogue().map((t) => (ids.includes(t.id) ? { ...t, installed: true, usable: true, managed: true, remainingSize: 0 } : t));

async function ready(tools?: ReturnType<typeof catalogue>) {
  const m = mockCapture(tools ? { tools } : {});
  const user = userEvent.setup();
  const view = render(<Capture client={m.client} projectId={P1} />);
  await screen.findByRole("button", { name: "Capture links" });
  await waitFor(() => expect(m.streams()).toBe(1));
  return { m, user, view };
}

describe("the capture screen and the optional tools", () => {
  it("its capture tools section links to the optional tools screen", async () => {
    const { view } = await ready();
    const tools = screen.getByRole("region", { name: "Capture tools" });
    expect(within(tools).getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(PATHS.tools);
    view.unmount();
  });

  it("says nothing downloads by itself: a missing video downloader is installed from the tools screen", async () => {
    const m = mockCapture({ versions: { yt_dlp: null, gallery_dl: null, ffmpeg: null } });
    const view = render(<Capture client={m.client} projectId={P1} />);
    const tools = await screen.findByRole("region", { name: "Capture tools" });
    // yt-dlp and gallery-dl rows: both are first-use downloads (R126, R152).
    expect(await within(tools).findAllByText(/^Not installed\. Install it from the Optional tools screen\.$/)).toHaveLength(2);
    expect(tools.textContent).not.toMatch(/downloaded the first time|comes with the app/);
    view.unmount();
  });

  it("uses the app's default speech model (R158) and offers only the models the app accepts", async () => {
    const { m, user, view } = await ready();
    expect(model().value).toBe("medium");
    expect([...model().options].map((o) => o.value)).toEqual([...SPEECH_MODELS]);
    await user.click(screen.getByRole("textbox", { name: "Links, one per line" }));
    await user.paste(YT);
    await user.click(screen.getByRole("radio", { name: "Transcribe" }));
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture`)[0]).toEqual({ urls: [YT], options: { transcribe: true, transcribeModel: "medium" } });
    view.unmount();
  });

  it("a model that is not installed is shown as such, with a link to the tools screen", async () => {
    const { user, view } = await ready(installed("speech-small"));
    await waitFor(() => expect([...model().options].find((o) => o.value === "medium")!.textContent).toMatch(/not installed/));
    expect([...model().options].find((o) => o.value === "small")!.textContent).not.toMatch(/not installed/);
    const note = screen.getByText(/speech model “medium” is not installed/i);
    expect(within(note).getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(`${PATHS.tools}?tool=speech-medium`);
    await user.selectOptions(model(), "small");
    expect(screen.queryByText(/is not installed/i)).toBeNull();
    view.unmount();
  });
});
