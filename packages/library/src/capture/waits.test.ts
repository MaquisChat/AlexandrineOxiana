import { describe, expect, it } from "vitest";
import { RATE_LIMIT_GIVE_UP_MS, RATE_LIMIT_REPEAT_MS, RATE_LIMIT_WAITS_MS, nextWaitMs } from "./waits.js";

describe("the growing waits of a slowed-down run", () => {
  it("the waits are 1, 2, 4, 15, 30, 60 minutes, then 2 hours, the last one cut at 12 hours", () => {
    expect(RATE_LIMIT_WAITS_MS).toEqual([60_000, 120_000, 240_000, 900_000, 1_800_000, 3_600_000]);
    expect(RATE_LIMIT_REPEAT_MS).toBe(7_200_000);
    expect(RATE_LIMIT_GIVE_UP_MS).toBe(43_200_000);
    const seen: number[] = [];
    let waited = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const ms = nextWaitMs(attempt, waited);
      if (ms === undefined) break;
      seen.push(ms);
      waited += ms;
    }
    expect(seen.map((ms) => ms / 1000)).toEqual([60, 120, 240, 900, 1_800, 3_600, 7_200, 7_200, 7_200, 7_200, 7_200, 480]);
    expect(waited).toBe(RATE_LIMIT_GIVE_UP_MS);
    expect(nextWaitMs(seen.length, waited)).toBeUndefined();
    expect(nextWaitMs(0, 0)).toBe(60_000);
  });
});
