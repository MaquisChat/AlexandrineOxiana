// The desktop end-to-end test's WebDriver client (webdriver.ts), against a stand-in WebDriver
// server on the loopback interface: what it sends for each command, and how it reports a refusal,
// an answer that is not WebDriver's and a server that does not answer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ELEMENT_KEY, WebDriverError, elementId, newSession } from "./webdriver.js";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let server: Server | undefined;

/** A stand-in WebDriver server: `answer` decides each reply; every request is recorded. */
async function stub(answer: (req: Seen) => { status?: number; body: unknown } | "hang" | { raw: string }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", path: req.url ?? "", body: data ? JSON.parse(data) : undefined };
      seen.push(s);
      const a = answer(s);
      if (a === "hang") return;
      if ("raw" in a) {
        res.writeHead(200, { "content-type": "text/html" }).end(a.raw);
        return;
      }
      res.writeHead(a.status ?? 200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterEach(async () => {
  const s = server;
  server = undefined;
  if (!s) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
});

const SESSION = { value: { sessionId: "s-1", capabilities: { browserName: "wry" } } };

describe("the WebDriver client", () => {
  it("starts a session with the capabilities under alwaysMatch, and keeps its id and capabilities", async () => {
    const { url, seen } = await stub(() => ({ body: SESSION }));
    const s = await newSession(url, { "tauri:options": { application: "/app" } });
    expect(seen).toEqual([{ method: "POST", path: "/session", body: { capabilities: { alwaysMatch: { "tauri:options": { application: "/app" } } } } }]);
    expect(s.id).toBe("s-1");
    expect(s.capabilities).toEqual({ browserName: "wry" });
  });

  it("finds an element and acts on it with the W3C commands", async () => {
    const { url, seen } = await stub((r) => {
      if (r.path === "/session") return { body: SESSION };
      if (r.path.endsWith("/element")) return { body: { value: { [ELEMENT_KEY]: "e-7" } } };
      if (r.path.endsWith("/text")) return { body: { value: "Choose files…" } };
      if (r.path.endsWith("/property/value")) return { body: { value: "typed" } };
      return { body: { value: null } };
    });
    const s = await newSession(url, {});
    const el = await s.findElement("css selector", "button");
    expect(el).toBe("e-7");
    await s.click(el);
    await s.sendKeys(el, "/tmp/a b");
    await s.clear(el);
    expect(await s.text(el)).toBe("Choose files…");
    expect(await s.property(el, "value")).toBe("typed");
    expect(seen.slice(1)).toEqual([
      { method: "POST", path: "/session/s-1/element", body: { using: "css selector", value: "button" } },
      { method: "POST", path: "/session/s-1/element/e-7/click", body: {} },
      { method: "POST", path: "/session/s-1/element/e-7/value", body: { text: "/tmp/a b" } },
      { method: "POST", path: "/session/s-1/element/e-7/clear", body: {} },
      { method: "GET", path: "/session/s-1/element/e-7/text", body: undefined },
      { method: "GET", path: "/session/s-1/element/e-7/property/value", body: undefined },
    ]);
  });

  it("runs a script with element arguments sent as element references, and returns elements as ids", async () => {
    const { url, seen } = await stub((r) => (r.path === "/session" ? { body: SESSION } : { body: { value: [{ [ELEMENT_KEY]: "e-1" }, 3] } }));
    const s = await newSession(url, {});
    const out = await s.execute<[unknown, number]>("return [arguments[0], 3]", [s.element("e-9"), "x"]);
    expect(seen[1]).toEqual({ method: "POST", path: "/session/s-1/execute/sync", body: { script: "return [arguments[0], 3]", args: [{ [ELEMENT_KEY]: "e-9" }, "x"] } });
    expect(elementId(out[0])).toBe("e-1");
    expect(out[1]).toBe(3);
  });

  it("closes the window and ends the session", async () => {
    const { url, seen } = await stub((r) => (r.path === "/session" ? { body: SESSION } : { body: { value: r.method === "DELETE" && r.path.endsWith("/window") ? [] : null } }));
    const s = await newSession(url, {});
    expect(await s.closeWindow()).toEqual([]);
    await s.delete();
    expect(seen.slice(1).map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /session/s-1/window", "DELETE /session/s-1"]);
  });

  it("reports a refusal with WebDriver's error code and message, naming the command", async () => {
    const { url } = await stub((r) =>
      r.path === "/session" ? { body: SESSION } : { status: 404, body: { value: { error: "no such element", message: "Unable to locate element", stacktrace: "" } } },
    );
    const s = await newSession(url, {});
    const err = await s.findElement("css selector", "nav").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebDriverError);
    expect(err).toMatchObject({ code: "no such element", status: 404 });
    expect(String((err as Error).message)).toMatch(/POST \/session\/s-1\/element.*no such element.*Unable to locate element/);
  });

  it("refuses an answer that is not WebDriver's", async () => {
    const { url } = await stub(() => ({ raw: "<html>proxy error</html>" }));
    await expect(newSession(url, {})).rejects.toThrow(/not a WebDriver answer/);
  });

  it("refuses a value that is not an element reference", () => {
    expect(() => elementId({ id: "x" })).toThrow(/not an element/);
    expect(() => elementId(null)).toThrow(/not an element/);
  });

  it("gives up on a server that does not answer, naming the command", async () => {
    const { url } = await stub((r) => (r.path === "/session" ? { body: SESSION } : "hang"));
    const s = await newSession(url, {}, { commandTimeoutMs: 300 });
    await expect(s.title()).rejects.toThrow(/GET \/session\/s-1\/title.*no answer within 0\.3 s/);
  });
});

describe("elementId", () => {
  it("reads the W3C element key", () => {
    expect(elementId({ [ELEMENT_KEY]: "abc" })).toBe("abc");
  });
});
