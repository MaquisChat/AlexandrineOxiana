/**
 * Pressing a deciding control of the review queue by mouse, as a researcher does (R322, R323, R327): shared by the
 * specs of the found files (find-copies.spec.ts) and of the queue's panel (review-queue.spec.ts).
 */
import { expect, type Page } from "./fixtures.js";

/** How long the spec waits at most for the page to come to rest. */
const REST_TIMEOUT = 60_000;

/** pressGuard.ts SCROLL_SETTLE_MS (R327 b): a mouse press that begins this soon after a scroll of the page is not taken. */
export const SCROLL_SETTLE_MS = 250;

/**
 * A press by mouse as a researcher makes it (R322, R323, R327 b): the control brought into view first (a scroll forgets
 * where controls stood), then — once the page has come to rest: the control stands at the same place on two looks in a
 * row and the page's own last scroll event is more than SCROLL_SETTLE_MS behind (both read from the page, not a fixed
 * time) — the pointer moved beside it and onto it (two movements at different places), then pressed.
 */
export async function pressByMouse(page: Page, control: ReturnType<Page["getByRole"]>): Promise<{ x: number; y: number }> {
  // The page's last scroll event, as the screen sees it (window, capture phase); installed once per page.
  await page.evaluate(() => {
    const w = window as unknown as { __aoLastScroll?: number };
    if (w.__aoLastScroll !== undefined) return;
    w.__aoLastScroll = Number.NEGATIVE_INFINITY;
    window.addEventListener("scroll", () => void (w.__aoLastScroll = performance.now()), true);
  });
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  let last = "";
  await expect
    .poll(
      async () => {
        const b = await control.boundingBox();
        const at = JSON.stringify(b && [Math.round(b.x), Math.round(b.y)]);
        const sinceScroll = await page.evaluate(() => performance.now() - (window as unknown as { __aoLastScroll: number }).__aoLastScroll);
        const settled = b !== null && at === last && sinceScroll > SCROLL_SETTLE_MS + 50;
        last = at;
        return settled;
      },
      { timeout: REST_TIMEOUT, intervals: [100] },
    )
    .toBe(true);
  const box = (await control.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(Math.max(1, box.x - 30), y + 40);
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  return { x, y };
}
