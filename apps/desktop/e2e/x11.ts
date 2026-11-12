/**
 * Closing the app's window as its close button does (Task 37h). On a desktop, the close button
 * belongs to the window manager, which sends the window a WM_DELETE_WINDOW client message (ICCCM
 * 4.2.8.1); GTK hands it to the app as a close request, and the shell's own closing path runs (hide
 * the window, stop the helpers, exit). The test's private display has no window manager, so this
 * module sends that same message itself, over the display's Unix socket, in a few requests of the X
 * Window System Protocol (version 11): InternAtom ×2, SendEvent, then GetInputFocus as a round trip
 * so that any error is seen. No dependency.
 *
 * Why not WebDriver's "Close Window": WebKitWebDriver kills the app's process the moment its last
 * window closes (seen here: the shell a zombie within 20 ms, its service left to stop through the
 * end of its standard input), so it would test a crash, not a person closing the app.
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";

/** The connection set-up: little-endian ('l'), protocol 11.0, no authorisation (Xvfb on a local socket). */
export function encodeSetup(): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0x6c;
  b.writeUInt16LE(11, 2);
  return b;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** InternAtom (opcode 16): the atom named `name`, created if need be. */
export function encodeInternAtom(name: string): Buffer {
  const n = Buffer.from(name, "latin1");
  const b = Buffer.alloc(8 + n.length + pad4(n.length));
  b[0] = 16;
  b[1] = 0;
  b.writeUInt16LE(b.length / 4, 2);
  b.writeUInt16LE(n.length, 4);
  n.copy(b, 8);
  return b;
}

/** SendEvent (opcode 25) of a ClientMessage WM_PROTOCOLS / WM_DELETE_WINDOW to `window`, at CurrentTime. */
export function encodeDeleteWindow(window: number, wmProtocols: number, wmDeleteWindow: number): Buffer {
  const b = Buffer.alloc(44);
  b[0] = 25;
  b[1] = 0; // propagate: False
  b.writeUInt16LE(11, 2);
  b.writeUInt32LE(window, 4);
  b.writeUInt32LE(0, 8); // event mask: none, so the event goes to the client that created the window
  b[12] = 33; // ClientMessage
  b[13] = 32; // format
  b.writeUInt16LE(0, 14);
  b.writeUInt32LE(window, 16);
  b.writeUInt32LE(wmProtocols, 20);
  b.writeUInt32LE(wmDeleteWindow, 24);
  b.writeUInt32LE(0, 28); // CurrentTime
  return b;
}

/** GetInputFocus (opcode 43): any request with a reply, to know the ones before it were handled. */
export function encodeGetInputFocus(): Buffer {
  return Buffer.from([43, 0, 1, 0]);
}

/**
 * The Unix socket of a local display (":N" or ":N.S"): the file in /tmp/.X11-unix when it exists,
 * else the abstract socket of the same name, which an X server on Linux also listens on (and the
 * only one when it could not create /tmp/.X11-unix, as a non-root Xvfb on a fresh machine).
 */
export function socketPathFor(display: string, exists: (p: string) => boolean = existsSync): string {
  const m = /^:(\d+)(\.\d+)?$/.exec(display);
  if (!m) throw new Error(`${display} is not a local display`);
  const path = `/tmp/.X11-unix/X${m[1]}`;
  return exists(path) ? path : `\0${path}`;
}

/** Sends `window` the window manager's close message on the X server at `socketPath`. */
export function requestWindowClose(socketPath: string, window: number, timeoutMs = 10_000): Promise<void> {
  return new Promise((done, fail) => {
    const sock = connect(socketPath);
    let buf = Buffer.alloc(0);
    let stage: "setup" | "atoms" | "sync" = "setup";
    const atoms: number[] = [];
    const finish = (err?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) fail(err);
      else done();
    };
    const timer = setTimeout(() => finish(new Error(`the X server did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
    sock.once("error", (e) => finish(new Error(`the X server could not be reached: ${e.message}`)));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "setup") {
        if (buf.length < 8) return;
        const total = 8 + buf.readUInt16LE(6) * 4;
        if (buf.length < total) return;
        if (buf[0] !== 1) return finish(new Error(`the X server refused the connection: ${buf.subarray(8, 8 + buf[1]!).toString("latin1") || `status ${buf[0]}`}`));
        buf = buf.subarray(total);
        stage = "atoms";
        sock.write(Buffer.concat([encodeInternAtom("WM_PROTOCOLS"), encodeInternAtom("WM_DELETE_WINDOW")]));
      }
      // Every reply or error from here on is 32 bytes (no reply here carries additional data).
      while (buf.length >= 32) {
        const packet = buf.subarray(0, 32);
        buf = buf.subarray(32);
        if (packet[0] === 0) return finish(new Error(`X error ${packet[1]} on request ${packet.readUInt16LE(2)}`));
        if (packet[0] !== 1) continue; // an event: not ours to read
        if (stage === "atoms") {
          atoms.push(packet.readUInt32LE(8));
          if (atoms.length === 2) {
            stage = "sync";
            sock.write(Buffer.concat([encodeDeleteWindow(window, atoms[0]!, atoms[1]!), encodeGetInputFocus()]));
          }
        } else if (stage === "sync") {
          return finish();
        }
      }
    });
    sock.once("connect", () => sock.write(encodeSetup()));
  });
}
