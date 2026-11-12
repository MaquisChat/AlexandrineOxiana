import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ndjson, server, testApi, url, useMockService } from "../test/service";
import { ApiClientError } from "./client";

useMockService();

describe("library API (R113: typed methods on request())", () => {
  it("creates a project with POST /projects: name, rules and encryption; the recovery code comes back once", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(url("/projects"), async ({ request }) => {
        const b = (await request.json()) as { encryption: { enabled: boolean } };
        bodies.push(b);
        const project = { id: "p9", name: "N", folder: "Projects/N", encrypted: b.encryption.enabled, unlocked: true, profiles: [] };
        return HttpResponse.json(b.encryption.enabled ? { project, recoveryCode: "CODE" } : { project });
      }),
    );
    const open = await testApi().projects.create({ name: "N", governanceYaml: "encryption:\n  atRest: optional\n", encryption: { enabled: false } });
    expect(open).toEqual({ project: { id: "p9", name: "N", folder: "Projects/N", encrypted: false, unlocked: true, profiles: [] } });
    const enc = await testApi().projects.create({ name: "N", governanceYaml: "", encryption: { enabled: true, passphrase: "pw" } });
    expect(enc.recoveryCode).toBe("CODE");
    expect(bodies).toEqual([
      { name: "N", governanceYaml: "encryption:\n  atRest: optional\n", encryption: { enabled: false } },
      { name: "N", governanceYaml: "", encryption: { enabled: true, passphrase: "pw" } },
    ]);
  });

  it("asks for a new recovery code with POST /projects/:id/recovery-code { passphrase }; the code comes back once", async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    server.use(
      http.post(url("/projects/:id/recovery-code"), async ({ request }) => {
        seen.push({ path: new URL(request.url).pathname, body: await request.json() });
        return HttpResponse.json({ recoveryCode: "CODE" });
      }),
    );
    expect(await testApi().projects.newRecoveryCode("p 1", { passphrase: "pw" })).toEqual({ recoveryCode: "CODE" });
    expect(seen).toEqual([{ path: "/projects/p%201/recovery-code", body: { passphrase: "pw" } }]);
  });

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

  it("a locate stream that ends without done is an error (the search was cut off)", async () => {
    server.use(http.post(url("/libraries/locate"), () => ndjson([{ found: { path: "/A" } }])));
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
