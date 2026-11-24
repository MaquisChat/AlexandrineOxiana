import { PICTURE_MAX_BYTES } from "@ao/shared";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server, serviceError, testApi, testClient, TOKEN, url, useMockService } from "../test/service";
import { pictureResponse, VERIFIED_SOURCE } from "../test/verification";
import { ApiClientError } from "./client";
import { verificationApi } from "./verification";

useMockService();

describe("verification API (Task 34d)", () => {
  it("confirms a field with PATCH …/fields {field, value} and returns the record with its fields", async () => {
    let seen: { path: string; body: unknown } | undefined;
    server.use(
      http.patch(url("/projects/:id/sources/:sid/fields"), async ({ request }) => {
        seen = { path: new URL(request.url).pathname, body: await request.json() };
        return HttpResponse.json(VERIFIED_SOURCE);
      }),
    );
    const r = await testApi().verification.confirmField("p 1", "s1", "issued", "2018");
    expect(seen).toEqual({ path: "/projects/p%201/sources/s1/fields", body: { field: "issued", value: "2018" } });
    expect(r.fields.map((f) => f.field)).toContain("/issued");
  });

  it("rechecks one source (POST …/recheck) and a whole project as a job (POST /projects/:id/recheck)", async () => {
    const paths: string[] = [];
    server.use(
      http.post(url("/projects/:id/sources/:sid/recheck"), ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return HttpResponse.json(VERIFIED_SOURCE);
      }),
      http.post(url("/projects/:id/recheck"), ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return HttpResponse.json({ jobId: "job-1", total: 12 });
      }),
    );
    const api = testApi().verification;
    expect((await api.recheckSource("p1", "s1")).fields.length).toBe(5);
    expect(await api.recheckProject("p1")).toEqual({ jobId: "job-1", total: 12 });
    expect(paths).toEqual(["/projects/p1/sources/s1/recheck", "/projects/p1/recheck"]);
  });

  it("FR-717: asks which recheck of a project is running (GET /projects/:id/recheck)", async () => {
    server.use(http.get(url("/projects/:id/recheck"), ({ params }) => HttpResponse.json({ running: { jobId: `job-${String(params.id)}`, done: 2, total: 5 } })));
    expect(await testApi().verification.recheckState("p 1")).toEqual({ running: { jobId: "job-p 1", done: 2, total: 5 } });
  });

  it("retries a source's failed background work with POST /jobs/retry {projectId, sourceId}", async () => {
    let body: unknown;
    server.use(
      http.post(url("/jobs/retry"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ retrying: true });
      }),
    );
    expect(await testApi().verification.retryJobs("p1", "s1")).toEqual({ retrying: true });
    expect(body).toEqual({ projectId: "p1", sourceId: "s1" });
  });

  it("reads a picture with the bearer token (never in the address) and returns it as a Blob (R135 1)", async () => {
    let auth: string | null = null;
    let address = "";
    server.use(
      http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), ({ request }) => {
        auth = request.headers.get("authorization");
        address = request.url;
        return pictureResponse("image/jpeg");
      }),
    );
    const blob = await verificationApi(testClient()).picture("p1", "s1", "a 1");
    expect(blob).toBeInstanceOf(Blob); // read under the picture limit, so built in chunks with the page's own Blob
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(8);
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(address).not.toContain(TOKEN);
    expect(new URL(address).pathname).toBe("/projects/p1/sources/s1/assets/a%201/content");
  });

  it("a picture refused by the service is an ApiClientError with its code (locked project → PROJECT_LOCKED)", async () => {
    server.use(http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked.")));
    const err = await verificationApi(testClient()).picture("p1", "s1", "a1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("PROJECT_LOCKED");
  });

  it("refuses an answer that is not a raster picture (an SVG or HTML body is never turned into a blob URL)", async () => {
    server.use(http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), () => pictureResponse("image/svg+xml")));
    await expect(verificationApi(testClient()).picture("p1", "s1", "a1")).rejects.toBeInstanceOf(ApiClientError);
    server.use(http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), () => new HttpResponse("<html></html>", { headers: { "content-type": "text/html" } })));
    await expect(verificationApi(testClient()).picture("p1", "s1", "a1")).rejects.toBeInstanceOf(ApiClientError);
  });

  it("a picture larger than the service's picture limit is refused while it is read (PAYLOAD_TOO_LARGE), never held whole", async () => {
    // A body that does not say its length, one chunk past PICTURE_MAX_BYTES.
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = 0;
    server.use(
      http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), () => {
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent > PICTURE_MAX_BYTES) return c.close();
            sent += chunk.byteLength;
            c.enqueue(chunk);
          },
        });
        return new HttpResponse(body, { headers: { "content-type": "image/jpeg" } });
      }),
    );
    const err = await verificationApi(testClient()).picture("p1", "s1", "a1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("PAYLOAD_TOO_LARGE");
  });
});
