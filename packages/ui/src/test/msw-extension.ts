/**
 * Fixtures for the extension pairing screen (Task 34e): MSW handlers shaped like the service's
 * pairing routes (apps/library-service/src/routes/capture.ts), the code-status route (Task 46c)
 * included. Own file so no shared fixture changes.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createClient } from "../api/client";
import type { PairingCodeIssued, PairingCodeStatus } from "@ao/shared";
import { extensionApi, type PairedBrowser } from "../api/extension";

export const BASE = "http://127.0.0.1:4318";
export const TOKEN = "t".repeat(40) + "-task34e";
export const url = (path: string) => `${BASE}${path}`;

export const server = setupServer();

export function useMsw(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

export const makeApi = () => extensionApi(createClient(BASE, TOKEN));

export const BROWSER_A: PairedBrowser = { id: "a1b2c3d4e5f60718", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", pairedAt: "2026-11-02T09:30:00.000Z" };
export const BROWSER_B: PairedBrowser = { id: "0918273645aabbcc", origin: "moz-extension://5b7c0f2e-1d44-4c7a-9a52-aaaaaaaaaaaa", pairedAt: "2026-11-05T14:05:00.000Z" };

export const apiError = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });

/** The id the fixture gives the n-th code it issues (0-based): 16 hex characters, like the service's. */
export const codeIdOf = (n: number) => `c0de${String(n).padStart(12, "0")}`;

/**
 * Pairings the test can change; `pair` hands out the given codes in turn. Each code's status is
 * kept as the service keeps it (a new code replaces an active one; past its time it is expired);
 * `end` sets what became of a code, `pairWith` pairs a browser with the newest code.
 */
export function pairingService(opts: { codes?: Array<{ code: string; ttlMs?: number }>; pairings?: PairedBrowser[]; port?: number; unreadable?: boolean; resetFails?: boolean } = {}) {
  const state = {
    /** The service's port now, as `GET /extension/pairings` says it (R171); absent: not said. */
    port: opts.port as number | undefined,
    listReads: 0,
    /** The pairings file cannot be read (Task 68); a reset clears it. */
    unreadable: !!opts.unreadable,
    resets: [] as unknown[],
    pairings: [...(opts.pairings ?? [])],
    issued: 0,
    codes: opts.codes ?? [{ code: "482916" }],
    deleted: [] as string[],
    /** Per issued code: its expiry (ms) and, once it ended, its final status. */
    records: [] as Array<{ codeId: string; expires: number; end?: PairingCodeStatus }>,
    statusReads: [] as string[],
  };
  const statusOf = (codeId: string): PairingCodeStatus => {
    const r = state.records.find((x) => x.codeId === codeId);
    if (!r) return { state: "none" };
    if (!r.end && Date.now() > r.expires) r.end = { state: "expired", codeId, expiredAt: new Date(r.expires).toISOString() };
    return r.end ?? { state: "active", codeId, expiresAt: new Date(r.expires).toISOString(), validForMs: Math.max(0, r.expires - Date.now()) };
  };
  const end = (n: number, status: PairingCodeStatus) => {
    state.records[n]!.end = status;
  };
  const pairWith = (b: PairedBrowser) => {
    const n = state.records.length - 1;
    const at = new Date().toISOString();
    state.pairings.push({ ...b, pairedAt: at });
    end(n, { state: "used", codeId: codeIdOf(n), usedAt: at, browser: { id: b.id, origin: b.origin } });
  };
  return {
    state,
    end,
    pairWith,
    handlers: [
      http.post(url("/extension/pair"), () => {
        const c = state.codes[Math.min(state.issued, state.codes.length - 1)]!;
        const prev = state.records.at(-1);
        if (prev && statusOf(prev.codeId).state === "active") prev.end = { state: "replaced", codeId: prev.codeId, replacedAt: new Date().toISOString() };
        const ttl = c.ttlMs ?? 5 * 60_000;
        const codeId = codeIdOf(state.issued);
        state.records.push({ codeId, expires: Date.now() + ttl });
        state.issued++;
        const body: PairingCodeIssued = { code: c.code, codeId, expiresAt: new Date(Date.now() + ttl).toISOString(), validForMs: ttl };
        return HttpResponse.json(body);
      }),
      http.get(url("/extension/pair/status/:codeId"), ({ params }) => {
        state.statusReads.push(String(params.codeId));
        return HttpResponse.json(statusOf(String(params.codeId)));
      }),
      http.get(url("/extension/pairings"), () => {
        state.listReads++;
        return HttpResponse.json({ extensions: state.pairings, ...(state.port !== undefined ? { port: state.port } : {}), ...(state.unreadable ? { unreadable: true } : {}) });
      }),
      http.post(url("/settings/reset"), async ({ request }) => {
        const body = await request.json();
        state.resets.push(body);
        if (opts.resetFails) return apiError(503, "UNAVAILABLE", "The list of paired browsers could not be set aside, so it was not reset.");
        state.unreadable = false;
        state.pairings = [];
        return HttpResponse.json({ reset: true, keptAs: "extension-pairings.json.unreadable-20261112-101530" });
      }),
      http.delete(url("/extension/pairings/:pid"), ({ params }) => {
        const i = state.pairings.findIndex((p) => p.id === params.pid);
        if (i < 0) return apiError(404, "NOT_FOUND", "That pairing was not found.");
        state.pairings.splice(i, 1);
        state.deleted.push(String(params.pid));
        return HttpResponse.json({ removed: true });
      }),
    ],
  };
}
