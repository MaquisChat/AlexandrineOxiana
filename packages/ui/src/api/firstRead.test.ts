/**
 * FR-756: `answerWithin` — the time limit is on the answer BEGINNING. An answer not begun in time is given up ("did not
 * answer in time", its request cancelled); one that has begun is never cut by the limit, however long the rest takes;
 * the caller's own abort still cancels it after it began.
 */
import { describe, expect, it } from "vitest";
import { SERVICE_NO_ANSWER, SERVICE_UNREACHABLE } from "./client";
import { allOrCancel, answerWithin, isNoAnswerInTime, oneNoAnswerSentence } from "./firstRead";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("answerWithin (FR-756)", () => {
  it("an answer that never begins is given up at the limit: its request is cancelled and it says it did not answer in time", async () => {
    let seen: AbortSignal | undefined;
    const p = answerWithin((signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    }, 50);
    const err = await p.catch((e: unknown) => e);
    expect(isNoAnswerInTime(err)).toBe(true);
    expect((err as Error).message).toBe(SERVICE_NO_ANSWER);
    expect(seen?.aborted).toBe(true);
  });

  it("an answer that has begun is never cut by the limit, however long its body takes", async () => {
    let seen: AbortSignal | undefined;
    const value = await answerWithin(async (signal, answered) => {
      seen = signal;
      await sleep(10);
      answered();
      await sleep(200); // four times the limit
      return "whole";
    }, 50);
    expect(value).toBe("whole");
    expect(seen?.aborted).toBe(false);
  });

  it("the caller's abort still cancels a read whose answer has begun", async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const p = answerWithin(
      (signal, answered) =>
        new Promise<string>((_, reject) => {
          seen = signal;
          answered();
          signal.addEventListener("abort", () => reject(new DOMException("gone", "AbortError")));
        }),
      50,
      outer.signal,
    );
    await sleep(100);
    outer.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(seen?.aborted).toBe(true);
  });
});

describe("oneNoAnswerSentence (R602 M1)", () => {
  it("“could not be reached” alone where any read failed with no answer; “did not answer in time” only where every one was given up", () => {
    expect(oneNoAnswerSentence([SERVICE_NO_ANSWER, SERVICE_UNREACHABLE, SERVICE_NO_ANSWER])).toBe(SERVICE_UNREACHABLE);
    expect(oneNoAnswerSentence([SERVICE_NO_ANSWER, undefined, SERVICE_NO_ANSWER])).toBe(SERVICE_NO_ANSWER);
    expect(oneNoAnswerSentence([])).toBeUndefined();
  });
});

describe("allOrCancel (R605 M6)", () => {
  it("the first request to fail cancels the others at once, and the whole read fails with its error", async () => {
    const signals: AbortSignal[] = [];
    const held = (signal: AbortSignal) =>
      new Promise<string>((_, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new DOMException("gone", "AbortError")));
      });
    const outer = new AbortController();
    const err = await allOrCancel(outer.signal, [held, () => Promise.reject(new Error("refused")), held]).catch((e: unknown) => e);
    expect((err as Error).message).toBe("refused");
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });

  it("answers every request's answer, in order; the read's own signal cancels them all", async () => {
    expect(await allOrCancel(new AbortController().signal, [async () => 1, async () => "two"] as const)).toEqual([1, "two"]);
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const p = allOrCancel(outer.signal, [
      (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new DOMException("gone", "AbortError")));
        }),
    ]);
    outer.abort();
    expect(((await p.catch((e: unknown) => e)) as Error).name).toBe("AbortError");
    expect(seen?.aborted).toBe(true);
  });
});
