/**
 * Full-page screenshot: scroll the page one viewport at a time, take `tabs.captureVisibleTab` of
 * each step (at most two calls a second, the browser's limit) and stitch the frames into one PNG on
 * an OffscreenCanvas in the background.
 *
 *  - The image is at most 30,000 pixels high (longer pages are cut, and the reply says so).
 *  - Its area stays inside a budget derived from the device's memory and the canvas area limit; a
 *    larger page is scaled down rather than failing.
 *  - The scroll position, smooth-scrolling setting and anything hidden while capturing (fixed and
 *    sticky bars, which would otherwise repeat on every frame) are restored afterwards, also on error.
 */

export const MAX_SCREENSHOT_HEIGHT = 30_000;
/** chrome.tabs.captureVisibleTab allows two calls per second. */
export const CAPTURE_INTERVAL_MS = 550;
/** Chromium's canvas area limit (16,384²). */
export const MAX_CANVAS_AREA = 268_435_456;
/** Keep the PNG well inside the service's 25 MB screenshot limit and 32 MB request limit. */
export const MAX_PNG_BYTES = 18 * 1024 * 1024;

export interface PageMetrics {
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  dpr: number;
}

export interface CapturePlan {
  /** Scroll offsets (CSS px) to capture, in order. */
  positions: number[];
  /** Height of the page area captured (CSS px). */
  cssHeight: number;
  outWidth: number;
  outHeight: number;
  /** Output pixels per device pixel (1 unless the memory budget forced a smaller image). */
  scale: number;
  truncated: boolean;
}

/** How many pixels the stitched image may have on this device (4 bytes each). */
export function memoryBudgetPixels(deviceMemoryGb: number | undefined): number {
  const gb = typeof deviceMemoryGb === "number" && deviceMemoryGb > 0 ? deviceMemoryGb : 4;
  return Math.min(MAX_CANVAS_AREA, Math.max(8_000_000, Math.floor((gb * 2 ** 30) / 64)));
}

export function planCapture(m: PageMetrics & { maxPixels: number }): CapturePlan {
  const vh = Math.max(1, Math.floor(m.viewportHeight));
  const dpr = m.dpr > 0 ? m.dpr : 1;
  const maxCss = Math.floor(MAX_SCREENSHOT_HEIGHT / dpr);
  const full = Math.max(Math.ceil(m.scrollHeight), vh);
  const cssHeight = Math.min(full, maxCss);
  const positions: number[] = [];
  const last = Math.max(0, cssHeight - vh);
  for (let y = 0; y < last; y += vh) positions.push(y);
  positions.push(last);
  let outWidth = Math.round(m.viewportWidth * dpr);
  let outHeight = Math.round(cssHeight * dpr);
  let scale = 1;
  if (outWidth * outHeight > m.maxPixels) {
    scale = Math.sqrt(m.maxPixels / (outWidth * outHeight));
    outWidth = Math.max(1, Math.floor(outWidth * scale));
    outHeight = Math.max(1, Math.floor(outHeight * scale));
  }
  return { positions, cssHeight, outWidth, outHeight, scale, truncated: full > cssHeight };
}

/** Waits until the next captureVisibleTab call is allowed; returns the time of that call. */
export async function waitForSlot(lastAt: number | undefined, clock: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  if (lastAt !== undefined) {
    const wait = lastAt + CAPTURE_INTERVAL_MS - clock();
    if (wait > 0) await sleep(wait);
  }
  return clock();
}

/**
 * One limiter shared by every capture the background runs (R112): callers queue in order, and each
 * call to `slot()` returns when the next captureVisibleTab call is allowed.
 */
export function createCaptureLimiter(clock: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): () => Promise<void> {
  let last: number | undefined;
  let queue: Promise<void> = Promise.resolve();
  return () => {
    const turn = queue.then(async () => {
      last = await waitForSlot(last, clock, sleep);
    });
    queue = turn.catch(() => {});
    return turn;
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- in the page (run by the content script) ----

interface Hidden {
  el: HTMLElement;
  value: string;
  priority: string;
}

/** Page-side steps of a screenshot; one instance per capture. */
export class PageScroller {
  private readonly startX: number;
  private readonly startY: number;
  private readonly behaviour: string;
  private hidden: Hidden[] = [];

  constructor(private readonly win: Window) {
    this.startX = win.scrollX;
    this.startY = win.scrollY;
    const root = win.document.documentElement;
    this.behaviour = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
  }

  metrics(): PageMetrics {
    const d = this.win.document;
    return {
      scrollHeight: Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0),
      viewportHeight: this.win.innerHeight,
      viewportWidth: this.win.innerWidth,
      dpr: this.win.devicePixelRatio || 1,
    };
  }

  /** Scrolls to `y` and waits for the page to paint; returns where the page actually is. */
  async scrollTo(y: number): Promise<number> {
    this.win.scrollTo(0, y);
    await new Promise<void>((r) => this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(() => r())));
    await new Promise((r) => setTimeout(r, 60));
    return this.win.scrollY;
  }

  /** Hides fixed and sticky elements (after the first frame, so they appear once, at the top). */
  hideFixed(): void {
    for (const el of Array.from(this.win.document.querySelectorAll<HTMLElement>("body *"))) {
      const pos = this.win.getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      this.hidden.push({ el, value: el.style.getPropertyValue("visibility"), priority: el.style.getPropertyPriority("visibility") });
      el.style.setProperty("visibility", "hidden", "important");
    }
  }

  restore(): void {
    for (const h of this.hidden) {
      if (h.value) h.el.style.setProperty("visibility", h.value, h.priority);
      else h.el.style.removeProperty("visibility");
    }
    this.hidden = [];
    this.win.scrollTo(this.startX, this.startY);
    this.win.document.documentElement.style.scrollBehavior = this.behaviour;
  }
}

// ---- in the background ----

export interface ScreenshotDeps {
  /** Runs the page-side steps in the tab. */
  page: {
    metrics(): Promise<PageMetrics>;
    scrollTo(y: number): Promise<number>;
    hideFixed(): Promise<void>;
    restore(): Promise<void>;
  };
  /** tabs.captureVisibleTab as a PNG data: URL. */
  captureVisible(): Promise<string>;
  /** Waits for the shared captureVisibleTab rate limit (createCaptureLimiter). */
  slot(): Promise<void>;
  deviceMemoryGb?: number;
}

export interface Screenshot {
  png: Uint8Array;
  width: number;
  height: number;
  truncated: boolean;
  scaled: boolean;
}

async function encode(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

export async function captureFullPage(deps: ScreenshotDeps): Promise<Screenshot> {
  try {
    const m = await deps.page.metrics();
    const plan = planCapture({ ...m, maxPixels: memoryBudgetPixels(deps.deviceMemoryGb) });
    let canvas = new OffscreenCanvas(plan.outWidth, plan.outHeight);
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This browser cannot draw the screenshot.");
    const pxPerCss = plan.outWidth / m.viewportWidth;
    for (const [i, y] of plan.positions.entries()) {
      const at = await deps.page.scrollTo(y);
      if (i === 1) await deps.page.hideFixed();
      await deps.slot();
      const dataUrl = await deps.captureVisible();
      const bmp = await createImageBitmap(new Blob([base64ToBytes(dataUrl.slice(dataUrl.indexOf(",") + 1)) as BlobPart], { type: "image/png" }));
      try {
        g.drawImage(bmp, 0, Math.round(at * pxPerCss), plan.outWidth, Math.round((bmp.height * plan.outWidth) / bmp.width));
      } finally {
        bmp.close();
      }
    }
    let png = await encode(canvas);
    let scaled = plan.scale < 1;
    // Too big for the service: shrink until it fits.
    for (let tries = 0; png.length > MAX_PNG_BYTES && tries < 5; tries++) {
      const smaller = new OffscreenCanvas(Math.max(1, Math.floor(canvas.width * 0.7)), Math.max(1, Math.floor(canvas.height * 0.7)));
      smaller.getContext("2d")!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      canvas = smaller;
      png = await encode(canvas);
      scaled = true;
    }
    if (png.length > MAX_PNG_BYTES) throw new Error("The screenshot is too large to send.");
    return { png, width: canvas.width, height: canvas.height, truncated: plan.truncated, scaled };
  } finally {
    await deps.page.restore();
  }
}
