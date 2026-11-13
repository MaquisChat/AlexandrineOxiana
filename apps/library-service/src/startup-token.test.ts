/**
 * The service's access token arrives on standard input (R98): one line, read once, never from the
 * environment or the command line, and never repeated in a message.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { deviceDeps } from "@ao/library";
import { FolderGrants, grantLineHandler } from "./folder-grants.js";
import { createService } from "./server.js";
import { INPUT_LINE_MAX_BYTES, InputLines, onInputLines, readStartupToken, startupErrorMessage, StartupTokenError, TOKEN_STDIN_TIMEOUT_MS } from "./startup-token.js";

const TOKEN = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8._~+/=-";
const GRANT_ID = "0123456789abcdef0123456789abcdef";
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
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

describe("onInputLines (R155: end of standard input after the token line means shut down; R207: one line shape is a folder grant)", () => {
  /** The token read, then `onInputLines` attached as main.ts does, with the grants store. */
  async function attached(first = `${TOKEN}\n`) {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(first);
    expect(await p).toBe(TOKEN);
    const grants = new FolderGrants();
    const lines: string[] = [];
    let ends = 0;
    const handOver = grantLineHandler(grants);
    onInputLines(
      input,
      (l) => {
        lines.push(l);
        handOver(l);
      },
      () => ends++,
    );
    return { input, grants, lines, ends: () => ends };
  }

  it("calls back once when standard input ends after the token line, discarding anything written after it", async () => {
    const { input, grants, ends } = await attached(`${TOKEN}\nextra bytes that are never read as anything`);
    input.write("more");
    await tick();
    expect(ends()).toBe(0);
    input.end();
    await tick();
    expect(ends()).toBe(1);
    input.destroy();
    await tick();
    expect(ends()).toBe(1);
    expect(grants.size).toBe(0);
  });

  it("end of input still shuts the service down: it calls back when standard input had already ended right after the token (a launcher that closes at once)", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.end(`${TOKEN}\n`);
    expect(await p).toBe(TOKEN);
    let calls = 0;
    onInputLines(input, () => {}, () => calls++);
    await tick();
    expect(calls).toBe(1);
  });

  it("treats an error or a close of standard input as its end", async () => {
    for (const how of ["error", "close"] as const) {
      const { input, ends } = await attached();
      if (how === "error") input.destroy(new Error("EPIPE"));
      else input.destroy();
      await tick();
      expect(ends(), how).toBe(1);
    }
  });

  it("a grant line after the token is handed over; any other line is discarded", async () => {
    const { input, grants, ends } = await attached();
    const grant = JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: "/Users/r/My Drive/Fieldwork" });
    input.write("not a command\n");
    input.write(`${TOKEN}\n`);
    input.write(JSON.stringify({ type: "folder-grant", id: GRANT_ID.toUpperCase(), path: "/elsewhere" }) + "\n");
    input.write(JSON.stringify({ type: "folder-grant", id: "f".repeat(32), path: "/a", more: true }) + "\n");
    input.write(Buffer.from([0xff, 0xfe, 0x00, 0x0a]));
    // A grant split across writes, ended by CRLF.
    input.write(grant.slice(0, 20));
    input.write(grant.slice(20) + "\r\n");
    await tick();
    expect(grants.size).toBe(1);
    expect(grants.take(GRANT_ID)).toBe("/Users/r/My Drive/Fieldwork");
    expect(ends()).toBe(0);
    // A last line with no line end before the end of input is not a grant.
    input.end(JSON.stringify({ type: "folder-grant", id: "e".repeat(32), path: "/z" }));
    await tick();
    expect(grants.size).toBe(0);
    expect(ends()).toBe(1);
  });

  it("a grant line led by a byte-order mark is not a grant", async () => {
    const { input, grants } = await attached();
    const grant = JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: "/x" });
    input.write(`﻿${grant}\n`);
    input.write(`﻿${grant}\r\n`);
    await tick();
    expect(grants.size).toBe(0);
    // The same line without it is one.
    input.write(`${grant}\n`);
    await tick();
    expect(grants.take(GRANT_ID)).toBe("/x");
  });

  it("a grant line in the same write as the token is handed over too (it comes after the token)", async () => {
    const { grants } = await attached(`${TOKEN}\n${JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: "/x" })}\n`);
    await tick();
    expect(grants.take(GRANT_ID)).toBe("/x");
  });

  it("a grant line before the token is not a grant: it is refused as a token, without its path in the message", async () => {
    const input = source();
    const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
    input.write(`${JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: "/Users/r/Secret folder" })}\n${TOKEN}\n`);
    const err = await refusal(p);
    expect(err.message).toMatch(/not a valid access token/);
    expect(err.message).not.toContain("Secret");
    expect(err.message).not.toContain("/Users");
  });

  it("a line that never ends does not grow memory past the bound and later lines are still read", async () => {
    const { input, grants, lines } = await attached();
    const mb = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 32; i++) input.write(mb);
    await tick(50);
    input.write(`\n${JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: "/after" })}\n`);
    await tick();
    // The over-long line was never handed to anyone; the next line was.
    expect(lines.every((l) => Buffer.byteLength(l) <= INPUT_LINE_MAX_BYTES)).toBe(true);
    expect(grants.take(GRANT_ID)).toBe("/after");
  });

  it("the line reader holds at most the bound, however long a line runs without ending", () => {
    const r = new InputLines();
    const chunk = Buffer.alloc(64 * 1024, 0x62);
    for (let i = 0; i < 256; i++) {
      expect(r.push(chunk)).toEqual([]);
      expect(r.bufferedBytes).toBeLessThanOrEqual(INPUT_LINE_MAX_BYTES);
    }
    // The rest of the over-long line, then two good lines in one chunk.
    expect(r.push(Buffer.from("tail\nfirst\nsecond\npart"))).toEqual(["first", "second"]);
    expect(r.push(Buffer.from("ial\n"))).toEqual(["partial"]);
    // A line of exactly the bound is read; one byte more is not.
    expect(r.push(Buffer.from("c".repeat(INPUT_LINE_MAX_BYTES) + "\n"))).toEqual(["c".repeat(INPUT_LINE_MAX_BYTES)]);
    expect(r.push(Buffer.from("d".repeat(INPUT_LINE_MAX_BYTES + 1) + "\nok\n"))).toEqual(["ok"]);
    // A byte-order mark is kept, so a line it leads is not the exact text of anything.
    expect(r.push(Buffer.from("﻿bom\n"))).toEqual(["﻿bom"]);
    // Bytes that are not UTF-8 are not a line.
    expect(r.push(Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a, 0x78, 0x0a]))).toEqual(["x"]);
  });
});

describe("the service with a grant on its standard input", () => {
  it("the path never appears in a log line", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ao-grant-log-"));
    let logs = "";
    const deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
    const svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "trace", logStream: new Writable({ write: (c, _e, cb) => ((logs += c.toString()), cb()) }) });
    try {
      const secret = "/Users/r/Library/CloudStorage/Dropbox/Participant Ana Lopez";
      const input = source();
      const p = readStartupToken({ ...clean, input, timeoutMs: 1000 });
      input.write(`${TOKEN}\n`);
      await p;
      onInputLines(input, grantLineHandler(svc.folderGrants), () => {});
      input.write(`${JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: secret })}\n`);
      input.write(`${JSON.stringify({ type: "folder-grant", id: GRANT_ID, path: secret, x: 1 })}\n`);
      input.write(`{"type":"folder-grant","id":"${GRANT_ID}","path":"${secret}\n`);
      await tick();
      const port = await svc.listen(0);
      for (const path of ["/libraries", `/projects/x/watched-folders?id=${GRANT_ID}`]) await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(svc.folderGrants.take(GRANT_ID)).toBe(secret);
      expect(svc.folderGrants.take(GRANT_ID)).toBeNull();
      input.end();
      await tick();
    } finally {
      await svc.close();
      await rm(tmp, { recursive: true, force: true });
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain("Participant");
    expect(logs).not.toContain("CloudStorage");
  });
});

describe("startupErrorMessage", () => {
  it("replaces the token wherever a later start-up error carries it", () => {
    expect(startupErrorMessage(new Error(`bad ${TOKEN} and ${TOKEN}`), TOKEN)).toBe("bad [token] and [token]");
    expect(startupErrorMessage(`plain ${TOKEN}`, TOKEN)).toBe("plain [token]");
    expect(startupErrorMessage(new Error("no token read yet"), undefined)).toBe("no token read yet");
  });
});
