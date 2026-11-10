import { describe, expect, it } from "vitest";
import { PatternWatchdog } from "./patterns.js";

describe("PatternWatchdog (R49d, R61)", () => {
  it("the budget clock starts once the worker is online and warmed up: a fresh worker does not time out a trivial pattern", async () => {
    const w = new PatternWatchdog([{ id: "t", regex: "^(?<title>.+)$" }], 5);
    try {
      expect(await w.match("Hello there.pdf")).toEqual({ parsed: { title: "Hello there" }, timedOut: [] });
    } finally {
      await w.close();
    }
  });

  it("after a timeout the restarted worker gets its own warm-up before the next pattern's clock starts", async () => {
    const w = new PatternWatchdog(
      [
        { id: "slow", regex: "^(?<title>(a|a)*)$" },
        { id: "fast", regex: "^(?<title>.+)$" },
      ],
      15,
    );
    try {
      const r = await w.match(`${"a".repeat(27)}!.pdf`);
      expect(r.timedOut).toEqual(["slow"]);
      expect(r.parsed).toEqual({ title: `${"a".repeat(27)}!` });
      expect([...w.disabled]).toEqual(["slow"]);
    } finally {
      await w.close();
    }
  });
});
