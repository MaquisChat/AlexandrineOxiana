/**
 * The service's access token arrives on standard input (R98): one line, read once, never from the
 * environment or the command line, and never repeated in a message.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { onEndOfInput, readStartupToken, startupErrorMessage, StartupTokenError, TOKEN_STDIN_TIMEOUT_MS } from "./startup-token.js";

const TOKEN = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8._~+/=-";
const clean = { env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv, argv: ["/usr/bin/node", "/x/main.ts"], execArgv: ["--max-old-space-size=512", "--import", "tsx"] };

function source(): PassThrough {
  return new PassThrough();
}

async function refusal(p: Promise<unknown>): Promise<StartupTokenError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StartupTokenError);
  return err as StartupTokenError;
}

describe("readStartupToken", () => {
  it("takes one line from standard input and then stops reading it (the stream stays open)", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(`${TOKEN}\nsomething after the line`);
    expect(await p).toBe(TOKEN);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.isPaused()).toBe(true);
    expect(input.destroyed).toBe(false);
  });

  it("accepts a line ending in CRLF, a line split across writes, and a line ended by the end of input", async () => {
    let input = source();
    let p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(`${TOKEN}\r\n`);
    expect(await p).toBe(TOKEN);

    input = source();
    p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(TOKEN.slice(0, 10));
    input.write(TOKEN.slice(10, 30));
    input.write(`${TOKEN.slice(30)}\n`);
    expect(await p).toBe(TOKEN);

    input = source();
    p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.end(TOKEN);
    expect(await p).toBe(TOKEN);
  });

  it("refuses when standard input closes without a token", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.end();
    expect((await refusal(p)).message).toMatch(/standard input closed before an access token arrived/i);
  });

  it("refuses when no token arrives within the time limit", async () => {
    const input = source();
    const t0 = Date.now();
    const err = await refusal(readStartupToken({ ...clean, input, timeoutMs: 100 }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err.message).toMatch(/no access token arrived on standard input within/i);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("has a short default time limit", () => {
    expect(TOKEN_STDIN_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(TOKEN_STDIN_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it.each([
    ["too short (31 characters)", "x".repeat(31)],
    ["a space inside", `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`],
    ["a character outside the accepted set", `${TOKEN}%`],
    ["non-ASCII", `${TOKEN}é`],
    ["too long (513 characters)", "y".repeat(513)],
  ])("refuses a malformed token: %s, without repeating it", async (_what, bad) => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(`${bad}\n`);
    const err = await refusal(p);
    expect(err.message).toMatch(/not a valid access token/i);
    expect(err.message).not.toContain(bad);
  });

  it("refuses an over-long first line at once, without waiting for the time limit", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 60_000 });
    const t0 = Date.now();
    input.write("z".repeat(5000));
    const err = await refusal(p);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err.message).not.toContain("zzzz");
  });

  it("refuses when the environment also names a token, whatever its case, before reading standard input", async () => {
    for (const env of [{ AO_SERVICE_TOKEN: TOKEN }, { ao_service_token: TOKEN }, { AO_SERVICE_TOKEN: "" }]) {
      const input = source();
      input.write(`${TOKEN}\n`);
      const err = await refusal(readStartupToken({ ...clean, env, input, timeoutMs: 1000 }));
      expect(err.message).toMatch(/environment/i);
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("refuses when the token's value is also in another environment variable", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, env: { PATH: "/usr/bin", SOMETHING: `x${TOKEN}y` }, input, timeoutMs: 1000 });
    input.write(`${TOKEN}\n`);
    const err = await refusal(p);
    expect(err.message).toMatch(/environment/i);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("SOMETHING");
  });

  it("refuses command-line arguments (the service takes none) and a token among the runtime's own arguments", async () => {
    for (const over of [
      { argv: [...clean.argv, "--token", TOKEN] },
      { argv: [...clean.argv, "anything"] },
      { execArgv: [...clean.execArgv, `--title=${TOKEN}`] },
      { execArgv: [...clean.execArgv, "--service-token=abc"] },
    ]) {
      const input = source();
      const p = readStartupToken({ ...clean, ...over, input, timeoutMs: 1000 });
      input.write(`${TOKEN}\n`);
      const err = await refusal(p);
      expect(err.message).toMatch(/command line|argument/i);
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("refuses a terminal on standard input (a typed token would be echoed on screen) without reading it", async () => {
    const input = Object.assign(source(), { isTTY: true });
    input.write(`${TOKEN}\n`);
    const err = await refusal(readStartupToken({ ...clean, input, timeoutMs: 1000 }));
    expect(err.message).toMatch(/terminal/i);
    expect(err.message).not.toContain(TOKEN);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("an error on standard input after the token line does not throw (it is no longer read)", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(`${TOKEN}\n`);
    expect(await p).toBe(TOKEN);
    expect(() => input.emit("error", new Error("EPIPE"))).not.toThrow();
  });
});

describe("onEndOfInput (R155: end of standard input after the token line means shut down)", () => {
  it("calls back once when standard input ends after the token line, discarding anything written after it", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(`${TOKEN}\nextra bytes that are never read as anything`);
    expect(await p).toBe(TOKEN);
    let calls = 0;
    onEndOfInput(input, () => calls++);
    input.write("more");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
    input.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    input.destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it("calls back when standard input had already ended right after the token (a launcher that closes at once)", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.end(`${TOKEN}\n`);
    expect(await p).toBe(TOKEN);
    let calls = 0;
    onEndOfInput(input, () => calls++);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it("treats an error or a close of standard input as its end", async () => {
    for (const how of ["error", "close"] as const) {
      const input = source();
      const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
      input.write(`${TOKEN}\n`);
      expect(await p).toBe(TOKEN);
      let calls = 0;
      onEndOfInput(input, () => calls++);
      if (how === "error") input.destroy(new Error("EPIPE"));
      else input.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls, how).toBe(1);
    }
  });
});

describe("startupErrorMessage", () => {
  it("replaces the token wherever a later start-up error carries it", () => {
    expect(startupErrorMessage(new Error(`bad ${TOKEN} and ${TOKEN}`), TOKEN)).toBe("bad [token] and [token]");
    expect(startupErrorMessage(`plain ${TOKEN}`, TOKEN)).toBe("plain [token]");
    expect(startupErrorMessage(new Error("no token read yet"), undefined)).toBe("no token read yet");
  });
});
