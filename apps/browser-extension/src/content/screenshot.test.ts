import { describe, expect, it } from "vitest";
import { CAPTURE_INTERVAL_MS, MAX_SCREENSHOT_HEIGHT, bytesToBase64, createCaptureLimiter, memoryBudgetPixels, planCapture, waitForSlot } from "./screenshot.js";

describe("planCapture", () => {
  it("covers the whole page in viewport steps, the last one flush with the bottom", () => {
    const p = planCapture({ scrollHeight: 2500, viewportHeight: 720, viewportWidth: 1280, dpr: 1, maxPixels: 1e9 });
    expect(p.positions).toEqual([0, 720, 1440, 1780]);
    expect(p.cssHeight).toBe(2500);
    expect(p.truncated).toBe(false);
    expect(p.scale).toBe(1);
    expect(p.outWidth).toBe(1280);
    expect(p.outHeight).toBe(2500);
  });

  it("takes a single frame for a page that fits the viewport", () => {
    const p = planCapture({ scrollHeight: 500, viewportHeight: 720, viewportWidth: 1280, dpr: 1, maxPixels: 1e9 });
    expect(p.positions).toEqual([0]);
    expect(p.cssHeight).toBe(720);
  });

  it("caps the image at 30,000 pixels high and says it was cut", () => {
    const p = planCapture({ scrollHeight: 100_000, viewportHeight: 1000, viewportWidth: 1000, dpr: 1, maxPixels: 1e12 });
    expect(MAX_SCREENSHOT_HEIGHT).toBe(30_000);
    expect(p.cssHeight).toBe(30_000);
    expect(p.outHeight).toBe(30_000);
    expect(p.truncated).toBe(true);
    expect(p.positions.at(-1)).toBe(29_000);
    expect(p.positions).toHaveLength(30);
  });

  it("counts the cap in device pixels on high-density screens", () => {
    const p = planCapture({ scrollHeight: 100_000, viewportHeight: 800, viewportWidth: 600, dpr: 2, maxPixels: 1e12 });
    expect(p.cssHeight).toBe(15_000);
    expect(p.outHeight).toBe(30_000);
    expect(p.outWidth).toBe(1200);
  });

  it("scales the image down to stay inside the memory budget", () => {
    const p = planCapture({ scrollHeight: 20_000, viewportHeight: 1000, viewportWidth: 2000, dpr: 1, maxPixels: 10_000_000 });
    expect(p.outWidth * p.outHeight).toBeLessThanOrEqual(10_000_000);
    expect(p.scale).toBeLessThan(1);
    expect(p.truncated).toBe(false);
    expect(p.cssHeight).toBe(20_000);
  });
});

describe("memoryBudgetPixels", () => {
  it("stays under the canvas area limit and follows device memory", () => {
    expect(memoryBudgetPixels(undefined)).toBeLessThanOrEqual(268_435_456);
    expect(memoryBudgetPixels(1)).toBeLessThan(memoryBudgetPixels(8));
    expect(memoryBudgetPixels(64)).toBeLessThanOrEqual(268_435_456);
  });
});

describe("waitForSlot (captureVisibleTab allows two calls a second)", () => {
  it("spaces calls at least CAPTURE_INTERVAL_MS apart", async () => {
    expect(CAPTURE_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    let now = 1000;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      now += ms;
    };
    const clock = () => now;
    const last = await waitForSlot(undefined, clock, sleep);
    expect(slept).toEqual([]);
    now += 100;
    const next = await waitForSlot(last, clock, sleep);
    expect(slept).toEqual([CAPTURE_INTERVAL_MS - 100]);
    expect(next - last).toBeGreaterThanOrEqual(CAPTURE_INTERVAL_MS);
  });
});

describe("createCaptureLimiter (one limiter for every capture the background runs)", () => {
  it("spaces concurrent callers CAPTURE_INTERVAL_MS apart, in order", async () => {
    let now = 0;
    const sleep = async (ms: number) => {
      now += ms;
    };
    const slot = createCaptureLimiter(() => now, sleep);
    const times: number[] = [];
    await Promise.all([1, 2, 3, 4].map(() => slot().then(() => times.push(now))));
    expect(times).toEqual([0, CAPTURE_INTERVAL_MS, 2 * CAPTURE_INTERVAL_MS, 3 * CAPTURE_INTERVAL_MS]);
  });

  it("does not wait when the last capture was long enough ago", async () => {
    let now = 0;
    const slot = createCaptureLimiter(
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    await slot();
    now += 2000;
    await slot();
    expect(now).toBe(2000);
  });
});

describe("bytesToBase64", () => {
  it("encodes large buffers without blowing the stack", () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const b64 = bytesToBase64(bytes);
    expect(Buffer.from(b64, "base64").equals(Buffer.from(bytes))).toBe(true);
    expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });
});
