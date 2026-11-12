// The close-button message (x11.ts): the exact X11 requests it sends, checked byte by byte against
// the X Window System Protocol, and the whole exchange against a stand-in X server on a Unix socket.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeDeleteWindow, encodeGetInputFocus, encodeInternAtom, encodeSetup, requestWindowClose, socketPathFor } from "./x11.js";

describe("the X11 requests", () => {
  it("opens a connection: little-endian, protocol 11.0, no authorisation", () => {
    expect([...encodeSetup()]).toEqual([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("asks for an atom by name (InternAtom, opcode 16), padded to four bytes", () => {
    const b = encodeInternAtom("WM_PROTOCOLS");
    // opcode, only-if-exists=0, length in 4-byte units (2 + 12/4 = 5), name length 12, unused, name.
    expect([...b.subarray(0, 8)]).toEqual([16, 0, 5, 0, 12, 0, 0, 0]);
    expect(b.subarray(8).toString("latin1")).toBe("WM_PROTOCOLS");
    expect(encodeInternAtom("WM_DELETE_WINDOW").length).toBe(8 + 16);
    expect(encodeInternAtom("ABCDE").length).toBe(16);
  });

  it("sends the window manager's close message (SendEvent, opcode 25, a ClientMessage WM_PROTOCOLS / WM_DELETE_WINDOW)", () => {
    const b = encodeDeleteWindow(0x00200003, 301, 302);
    expect(b.length).toBe(44);
    // SendEvent: propagate=0, length 11, destination, event mask 0 (the window's own client).
    expect([...b.subarray(0, 4)]).toEqual([25, 0, 11, 0]);
    expect(b.readUInt32LE(4)).toBe(0x00200003);
    expect(b.readUInt32LE(8)).toBe(0);
    // The event: ClientMessage (33), format 32, sequence 0, window, type, data[0] the protocol, data[1] CurrentTime.
    expect([b[12], b[13]]).toEqual([33, 32]);
    expect(b.readUInt16LE(14)).toBe(0);
    expect(b.readUInt32LE(16)).toBe(0x00200003);
    expect(b.readUInt32LE(20)).toBe(301);
    expect(b.readUInt32LE(24)).toBe(302);
    expect(b.readUInt32LE(28)).toBe(0);
    expect([...b.subarray(32)]).toEqual(new Array(12).fill(0));
  });

  it("makes a round trip with GetInputFocus (opcode 43)", () => {
    expect([...encodeGetInputFocus()]).toEqual([43, 0, 1, 0]);
  });

  it("finds a display's socket", () => {
    expect(socketPathFor(":42")).toBe("/tmp/.X11-unix/X42");
    expect(socketPathFor(":7.0")).toBe("/tmp/.X11-unix/X7");
    expect(() => socketPathFor("host:1")).toThrow(/local display/);
  });
});

// ---------- a stand-in X server ----------

let server: Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise((r) => s.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Answers the setup and each request; records every request after the setup. */
async function fakeX(opts: { refuse?: string; errorOnSendEvent?: boolean } = {}): Promise<{ path: string; requests: Buffer[] }> {
  dir = mkdtempSync(join(tmpdir(), "ao-x11-test-"));
  const path = join(dir, "X0");
  const requests: Buffer[] = [];
  server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let setupDone = false;
    let seq = 0;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!setupDone) {
        if (buf.length < 12) return;
        buf = buf.subarray(12);
        setupDone = true;
        if (opts.refuse) {
          const reason = Buffer.from(opts.refuse, "latin1");
          const padded = Buffer.alloc(Math.ceil(reason.length / 4) * 4);
          reason.copy(padded);
          const head = Buffer.alloc(8);
          head[0] = 0;
          head[1] = reason.length;
          head.writeUInt16LE(11, 2);
          head.writeUInt16LE(padded.length / 4, 6);
          sock.end(Buffer.concat([head, padded]));
          return;
        }
        // Success with 8 bytes of (ignored) additional data.
        const ok = Buffer.alloc(16);
        ok[0] = 1;
        ok.writeUInt16LE(11, 2);
        ok.writeUInt16LE(2, 6);
        sock.write(ok);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt16LE(2) * 4;
        if (buf.length < len) return;
        const req = buf.subarray(0, len);
        buf = buf.subarray(len);
        requests.push(Buffer.from(req));
        seq++;
        const reply = Buffer.alloc(32);
        if (req[0] === 16) {
          reply[0] = 1;
          reply.writeUInt16LE(seq, 2);
          reply.writeUInt32LE(req.subarray(8, 8 + req.readUInt16LE(4)).toString("latin1") === "WM_PROTOCOLS" ? 301 : 302, 8);
          sock.write(reply);
        } else if (req[0] === 25 && opts.errorOnSendEvent) {
          reply[0] = 0; // error
          reply[1] = 3; // BadWindow
          reply.writeUInt16LE(seq, 2);
          sock.write(reply);
        } else if (req[0] === 43) {
          reply[0] = 1;
          reply.writeUInt16LE(seq, 2);
          sock.write(reply);
        }
      }
    });
  });
  await new Promise<void>((r) => server!.listen(path, r));
  return { path, requests };
}

describe("requestWindowClose", () => {
  it("interns the two atoms, sends the close message to the window, and waits for the server to have handled it", async () => {
    const x = await fakeX();
    await requestWindowClose(x.path, 0x00200003);
    expect(x.requests.map((r) => r[0])).toEqual([16, 16, 25, 43]);
    expect(x.requests[2]).toEqual(encodeDeleteWindow(0x00200003, 301, 302));
  });

  it("reports a refused connection in the server's words", async () => {
    const x = await fakeX({ refuse: "No protocol specified" });
    await expect(requestWindowClose(x.path, 1)).rejects.toThrow(/refused the connection: No protocol specified/);
  });

  it("reports an X error (no such window)", async () => {
    const x = await fakeX({ errorOnSendEvent: true });
    await expect(requestWindowClose(x.path, 7)).rejects.toThrow(/X error 3/);
  });
});
