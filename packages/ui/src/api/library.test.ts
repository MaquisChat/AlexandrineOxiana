import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ndjson, server, testApi, url, useMockService } from "../test/service";
import { ApiClientError } from "./client";
import { profilesFromGovernance } from "./library";

useMockService();

describe("library API (R113: typed methods on request())", () => {
  it("searches sources with text, collection and tag as query values", async () => {
    let seen: URL | undefined;
    server.use(
      http.get(url("/projects/:id/sources"), ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ total: 0, items: [] });
      }),
    );
    await testApi().sources.search("p1", { text: "ethno", collection: "c1", tag: "t1" });
    expect(seen?.pathname).toBe("/projects/p1/sources");
    expect(seen?.searchParams.get("text")).toBe("ethno");
    expect(seen?.searchParams.get("collection")).toBe("c1");
    expect(seen?.searchParams.get("tag")).toBe("t1");
  });

  it("encodes ids in paths", async () => {
    let path = "";
    server.use(
      http.get(url("/projects/:id/sources/:sid"), ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({});
      }),
    );
    await testApi().sources.get("p 1", "s/2");
    expect(path).toBe("/projects/p%201/sources/s%2F2");
  });

  it("posts attach with the paths and returns the per-file outcomes", async () => {
    let body: unknown;
    server.use(
      http.post(url("/projects/:id/attach"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ items: [{ path: "/a.pdf", outcome: "created", sourceId: "s9" }] });
      }),
    );
    const items = await testApi().sources.attach("p1", ["/a.pdf"]);
    expect(body).toEqual({ paths: ["/a.pdf"] });
    expect(items).toEqual([{ path: "/a.pdf", outcome: "created", sourceId: "s9" }]);
  });

  it("streams the locate search line by line and ends on done", async () => {
    let body: unknown;
    server.use(
      http.post(url("/libraries/locate"), async ({ request }) => {
        body = await request.json();
        return ndjson([{ found: { path: "/Volumes/A/Lib" } }, { found: { path: "/Old/Lib", moved: true } }, { done: true }]);
      }),
    );
    const seen: unknown[] = [];
    for await (const f of testApi().libraries.locate("lib-1")) seen.push(f);
    expect(body).toEqual({ libraryId: "lib-1" });
    expect(seen).toEqual([{ path: "/Volumes/A/Lib" }, { path: "/Old/Lib", moved: true }]);
  });

  it("an error line in the locate stream is thrown as ApiClientError", async () => {
    server.use(http.post(url("/libraries/locate"), () => ndjson([{ found: { path: "/A" } }, { error: { code: "INTERNAL", message: "The search stopped." } }])));
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const f of testApi().libraries.locate("lib-1")) seen.push(f);
      })(),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(seen).toEqual([{ path: "/A" }]);
  });

  it("cite posts project, refs, style and format and returns the service's string", async () => {
    let body: unknown;
    server.use(
      http.post(url("/cite"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ text: "(Smith, 2019)" });
      }),
    );
    await expect(testApi().citations.cite({ projectId: "p1", sourceIds: ["s1"], style: "apa", format: "text" })).resolves.toBe("(Smith, 2019)");
    expect(body).toEqual({ projectId: "p1", refs: [{ sourceId: "s1" }], style: "apa", format: "text" });
  });

  it("unlock posts the secret; a wrong one is WRONG_PASSPHRASE", async () => {
    server.use(http.post(url("/projects/:id/unlock"), () => HttpResponse.json({ error: { code: "WRONG_PASSPHRASE", message: "That passphrase is not correct." } }, { status: 401 })));
    await expect(testApi().projects.unlock("p2", "nope")).rejects.toMatchObject({ code: "WRONG_PASSPHRASE" });
  });
});

describe("profilesFromGovernance", () => {
  it("reads flow and block lists and keeps only known profiles", () => {
    expect(profilesFromGovernance("profiles: [irb, gdpr]\n")).toEqual(["irb", "gdpr"]);
    expect(profilesFromGovernance("profiles:\n  - hipaa\n  - made-up\n")).toEqual(["hipaa"]);
    expect(profilesFromGovernance("encryption: required\n")).toEqual([]);
    expect(profilesFromGovernance(": : not yaml [")).toEqual([]);
  });
});
