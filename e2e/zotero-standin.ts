/**
 * A stand-in for Zotero's servers on this computer (Task Z11, Ruling R289 c): the library tests' own fake Zotero
 * (`FakeZotero`, packages/library/tests/zotero/fake-zotero.ts; Task Z1) behind a Node `http` server on 127.0.0.1, any
 * free port, in the spec's own process. NOT a product file.
 *
 * The service reaches it through its test-only switch `AO_ZOTERO_API_ORIGIN=http://127.0.0.1:<port>` (honoured
 * only under NODE_ENV=test): with it, this one origin is Zotero's API AND the only origin a file may be fetched from.
 * So file redirects point here too: `z.redirectBase` is set to `<origin>/zoterofilestorage/` (the fake tells its
 * storage paths from its API paths by that prefix).
 *
 *  - It answers only a request whose Host is its own (`127.0.0.1:<port>`); any other gets 421 and nothing from the fake.
 *  - It keeps a log of every request: when it came (ms since the epoch), the method, the path with its query, the
 *    status answered, and whether a key was sent and whether it was the expected one — never the key's value (a
 *    `key=` in a query is replaced by "[key]", and the key's value anywhere in the path too).
 *  - An answer the fake marks `drop` destroys the connection without answering; `cut` sends the headers and half the
 *    body, then destroys it.
 *  - `hold()` keeps every new request waiting, unanswered, until `release()`; `backoffOn(path, s)` puts `Backoff: s`
 *    on the first API answer whose path matches (the fake's own `backoffOnce` puts it on the very next one).
 *  - `close()` makes it unreachable: the listening socket is closed and every open connection destroyed, so the next
 *    request is refused. `reopen()` listens again on the SAME port (the service keeps the origin it started with).
 *
 * It never makes a request of its own: nothing in it contacts any host.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { FakeZotero } from "../packages/library/tests/zotero/fake-zotero.js";
import { fakeZoteroHandler } from "../packages/library/tests/zotero/fake-zotero.js";

export interface StandInRequest {
  /** When the request arrived (ms since the epoch). */
  at: number;
  method: string;
  /** Path and query, the key redacted. */
  path: string;
  /** The status answered; "dropped" for a connection broken on purpose; 421 for a request to another host. */
  status: number | "dropped";
  /** Whether a key was sent (header `Zotero-API-Key`, `Authorization: Bearer`, or `key=`). */
  keySent: boolean;
  /** Whether the key sent was the stand-in's own (false when none was sent). */
  keyExpected: boolean;
  /** Whether it was a file download from the storage path (not the API). */
  storage: boolean;
}

export interface ZoteroStandIn {
  /** http://127.0.0.1:<port> */
  readonly origin: string;
  readonly port: number;
  /** Every request so far, oldest first (a copy). */
  requests(): StandInRequest[];
  /** Unreachable from now on: connections are refused. */
  close(): Promise<void>;
  /** Listens again on the same port. */
  reopen(): Promise<void>;
  /**
   * From now on each request is held, unanswered, until `release()` (a slow Zotero: a run that lasts long enough for
   * the screen to show it going). Requests already being answered are not affected.
   */
  hold(): void;
  release(): void;
  /** Requests waiting at the hold now. */
  held(): number;
  /**
   * The first API answer whose path (with its query) matches `path` from now on carries `Backoff: <seconds>` (Zotero
   * may send it with any answer, [basics]). Lets a test choose which answer of a run asks for the pause.
   */
  backoffOn(path: RegExp, seconds: number): void;
}

const STORAGE_PREFIX = "/zoterofilestorage/";

export async function startZoteroStandIn(z: FakeZotero): Promise<ZoteroStandIn> {
  const handler = fakeZoteroHandler(z);
  const log: StandInRequest[] = [];
  const sockets = new Set<Socket>();
  let port = 0;
  let server: Server | undefined;
  let gate: { promise: Promise<void>; open: () => void } | undefined;
  let waiting = 0;
  let backoff: { path: RegExp; seconds: number } | undefined;

  const redact = (path: string): string => path.replace(/([?&]key=)[^&#]*/giu, "$1[key]").split(z.key).join("[key]");

  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const at = Date.now();
    const path = req.url ?? "/";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? (v[0] ?? "") : v;
    const bearer = /^bearer\s+(.+)$/iu.exec(headers["authorization"] ?? "")?.[1];
    let queryKey: string | null = null;
    try {
      queryKey = new URL(path, "http://127.0.0.1").searchParams.get("key");
    } catch {
      queryKey = null;
    }
    const given = headers["zotero-api-key"] ?? bearer ?? queryKey ?? undefined;
    const entry: StandInRequest = {
      at,
      method: req.method ?? "",
      path: redact(path),
      status: 0,
      keySent: given !== undefined,
      keyExpected: given === z.key,
      storage: path.startsWith(STORAGE_PREFIX),
    };
    log.push(entry);
    // Only requests addressed to this server by its own name and port.
    if (headers["host"] !== `127.0.0.1:${port}`) {
      entry.status = 421;
      res.writeHead(421, { "content-type": "text/plain" });
      res.end("This stand-in answers only for its own address.");
      return;
    }
    // The fake reads no body (only GET is served); a body sent anyway is drained.
    req.resume();
    if (gate) {
      waiting++;
      await gate.promise;
      waiting--;
      if (req.socket.destroyed) {
        entry.status = "dropped";
        return;
      }
    }
    const r = handler({ method: entry.method, path, headers });
    if (backoff && !entry.storage && backoff.path.test(path) && !r.drop) {
      r.headers["backoff"] = String(backoff.seconds);
      backoff = undefined;
    }
    if (r.drop) {
      entry.status = "dropped";
      req.socket.destroy();
      return;
    }
    entry.status = r.status;
    const body = typeof r.body === "string" ? Buffer.from(r.body) : Buffer.from(r.body);
    res.writeHead(r.status, { ...r.headers, "content-length": String(body.length) });
    if (r.cut) {
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => req.socket.destroy());
      return;
    }
    res.end(body);
  };

  const listen = async (wanted: number): Promise<void> => {
    const s = createServer((req, res) => void answer(req, res));
    s.keepAliveTimeout = 5_000;
    s.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((done, fail) => {
      s.once("error", fail);
      s.listen(wanted, "127.0.0.1", () => {
        s.off("error", fail);
        done();
      });
    });
    server = s;
    port = (s.address() as AddressInfo).port;
  };

  await listen(0);
  const origin = `http://127.0.0.1:${port}`;
  // Files are served from here too: the service's switch allows no other file origin.
  z.redirectBase = `${origin}${STORAGE_PREFIX}`;

  return {
    origin,
    port,
    requests: () => log.map((e) => ({ ...e })),
    async close() {
      const s = server;
      server = undefined;
      if (!s) return;
      const closed = new Promise<void>((done) => s.close(() => done()));
      // Held requests are let go first; their connections are gone, so they are not answered.
      for (const socket of sockets) socket.destroy();
      const g = gate;
      gate = undefined;
      g?.open();
      sockets.clear();
      await closed;
    },
    async reopen() {
      if (server) return;
      await listen(port);
    },
    hold() {
      if (gate) return;
      let open = () => {};
      const promise = new Promise<void>((done) => (open = done));
      gate = { promise, open };
    },
    release() {
      const g = gate;
      gate = undefined;
      g?.open();
    },
    held: () => waiting,
    backoffOn(path, seconds) {
      backoff = { path, seconds };
    },
  };
}
