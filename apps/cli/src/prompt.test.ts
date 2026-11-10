import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ExitError } from "./errors.js";
import { PromptCancelled, ask, readPassphrase } from "./prompt.js";

function io(lines: string[], end = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d: Buffer) => (shown += d.toString()));
  // Lines arrive one after another, as typed answers do (a prompt reads only what is there when it starts).
  lines.forEach((l, i) => setTimeout(() => input.write(`${l}\n`), 20 * (i + 1)));
  if (end) setTimeout(() => input.end(), 20 * (lines.length + 1));
  return { io: { input, output }, shown: () => shown };
}

describe("prompts", () => {
  it("ask returns the typed answer", async () => {
    const t = io(["yes"]);
    expect(await ask("Sure? ", false, t.io)).toBe("yes");
  });

  it("Ctrl+D (input ends before an answer) cancels instead of hanging", async () => {
    const t = io([]);
    await expect(ask("Sure? ", false, t.io)).rejects.toBeInstanceOf(PromptCancelled);
  });

  it("a hidden answer is not echoed", async () => {
    const t = io(["hunter2"]);
    await ask("Pass: ", true, t.io);
    expect(t.shown()).not.toContain("hunter2");
  });

  it("an empty or blank passphrase is refused", async () => {
    for (const blank of ["", "   "]) {
      const t = io([blank, blank]);
      await expect(readPassphrase("Pass: ", true, t.io)).rejects.toBeInstanceOf(ExitError);
    }
  });

  it("two different passphrases are refused; matching ones are returned", async () => {
    await expect(readPassphrase("Pass: ", true, io(["a1", "b2"]).io)).rejects.toThrow(/did not match/);
    expect(await readPassphrase("Pass: ", true, io(["same words", "same words"]).io)).toBe("same words");
  });

  it("AO_PASSPHRASE is read once and removed from the environment", async () => {
    vi.resetModules();
    const fresh = await import("./prompt.js");
    process.env.AO_PASSPHRASE = "from-env";
    expect(await fresh.readPassphrase("Pass: ", true)).toBe("from-env");
    expect(process.env.AO_PASSPHRASE).toBeUndefined();
    expect(await fresh.readPassphrase("Pass: ", true)).toBe("from-env");
  });
});
