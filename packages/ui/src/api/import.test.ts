import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { importApi, importPolicyFromYaml, isProgressFor } from "./import";
import { mockService, BASE, OPEN_GOVERNANCE, PSEUDONYMISING_GOVERNANCE, server, B1, P1 } from "../test/importService";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

describe("importPolicyFromYaml", () => {
  it("reads pseudonymisation and encryption from governance", () => {
    expect(importPolicyFromYaml(OPEN_GOVERNANCE)).toEqual({ pseudonymizeNames: false, encryptionRequired: false });
    expect(importPolicyFromYaml(PSEUDONYMISING_GOVERNANCE).pseudonymizeNames).toBe(true);
  });
  it("treats unreadable governance as the strictest reading", () => {
    expect(importPolicyFromYaml("::: not yaml [")).toEqual({ pseudonymizeNames: true, encryptionRequired: true });
  });
});

describe("importApi", () => {
  it("R397 f: an answer without `readable` is readable only if the rules read here (M6)", async () => {
    const m = mockService();
    const answer = (yaml: string) => server.use(http.get(`${BASE}/projects/:id/governance`, () => HttpResponse.json({ yaml, sha256: "0".repeat(64), violations: [] })));
    answer("encryption: {atRest: optional}\nresidencey: {allowed: [local]}\n");
    expect(await importApi(m.client).policy(P1)).toEqual({ pseudonymizeNames: true, encryptionRequired: true, readable: false });
    answer(OPEN_GOVERNANCE);
    expect(await importApi(m.client).policy(P1)).toEqual({ pseudonymizeNames: false, encryptionRequired: false, readable: true });
  });

  it("refuses '.', '..' and empty path segments and ids that are not UUIDv7", async () => {
    const m = mockService();
    const api = importApi(m.client);
    const refused = (f: () => Promise<unknown>) => expect(Promise.resolve().then(f)).rejects.toThrow();
    await refused(() => api.report(".."));
    await refused(() => api.report("."));
    await refused(() => api.report(""));
    await refused(() => api.policy(".."));
    await refused(() => api.decide("..", "r1", { action: "skip" }));
    await refused(() => api.decide(P1, "..", { action: "skip" }));
    await refused(() => api.source(P1, ".."));
    await expect(Promise.resolve().then(() => api.batches("p1"))).rejects.toThrow(/not a valid/);
    expect(m.calls).toHaveLength(0);
  });

  it("sends projectId in every review request body", async () => {
    const m = mockService();
    const api = importApi(m.client);
    await api.decide(P1, "r1", { action: "skip" });
    await api.bulkEdit(P1, ["r1", "r2"], { type: "report" });
    expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "skip" } }]);
    expect(m.bodies("POST /review/bulk-edit")).toEqual([{ projectId: P1, itemIds: ["r1", "r2"], patch: { type: "report" } }]);
  });
  it("posts the start request with adapter and options", async () => {
    const m = mockService();
    const api = importApi(m.client);
    const options = { fileHandling: "copy", structure: "collections", duplicates: "merge", ocr: true, transcribe: false } as const;
    expect(await api.start(P1, { kind: "folder", path: "/data/papers" }, options)).toEqual({ batchId: B1 });
    expect(m.bodies(`POST /projects/${P1}/import`)).toEqual([{ adapter: { kind: "folder", path: "/data/papers" }, options }]);
  });
  it("recognises progress events for one batch", () => {
    expect(isProgressFor(B1, { type: "import.progress", data: { batchId: B1 } })).toBe(true);
    expect(isProgressFor(B1, { type: "import.progress", data: { batchId: "b2" } })).toBe(false);
    expect(isProgressFor(B1, { type: "job.progress", data: { batchId: B1 } })).toBe(false);
  });
});
