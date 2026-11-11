import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importApi, importPolicyFromYaml, isProgressFor } from "./import";
import { mockService, OPEN_GOVERNANCE, PSEUDONYMISING_GOVERNANCE, server } from "../test/importService";

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
  it("sends projectId in every review request body", async () => {
    const m = mockService();
    const api = importApi(m.client);
    await api.decide("p1", "r1", { action: "skip" });
    await api.bulkEdit("p1", ["r1", "r2"], { type: "report" });
    expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: "p1", decision: { action: "skip" } }]);
    expect(m.bodies("POST /review/bulk-edit")).toEqual([{ projectId: "p1", itemIds: ["r1", "r2"], patch: { type: "report" } }]);
  });
  it("posts the start request with adapter and options", async () => {
    const m = mockService();
    const api = importApi(m.client);
    const options = { fileHandling: "copy", structure: "collections", duplicates: "merge", ocr: true, transcribe: false } as const;
    expect(await api.start("p1", { kind: "folder", path: "/data/papers" }, options)).toEqual({ batchId: "b1" });
    expect(m.bodies("POST /projects/p1/import")).toEqual([{ adapter: { kind: "folder", path: "/data/papers" }, options }]);
  });
  it("recognises progress events for one batch", () => {
    expect(isProgressFor("b1", { type: "import.progress", data: { batchId: "b1" } })).toBe(true);
    expect(isProgressFor("b1", { type: "import.progress", data: { batchId: "b2" } })).toBe(false);
    expect(isProgressFor("b1", { type: "job.progress", data: { batchId: "b1" } })).toBe(false);
  });
});
