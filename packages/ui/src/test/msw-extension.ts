/**
 * Fixtures for the extension pairing screen (Task 34e): MSW handlers shaped like the service's
 * pairing routes (apps/library-service/src/routes/capture.ts). Own file so no shared fixture changes.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createClient } from "../api/client";
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

/** Pairings the test can change; `pair` hands out the given codes in turn. */
export function pairingService(opts: { codes?: Array<{ code: string; ttlMs?: number }>; pairings?: PairedBrowser[] } = {}) {
  const state = { pairings: [...(opts.pairings ?? [])], issued: 0, codes: opts.codes ?? [{ code: "482916" }], deleted: [] as string[] };
  return {
    state,
    handlers: [
      http.post(url("/extension/pair"), () => {
        const c = state.codes[Math.min(state.issued, state.codes.length - 1)]!;
        state.issued++;
        return HttpResponse.json({ code: c.code, expiresAt: new Date(Date.now() + (c.ttlMs ?? 5 * 60_000)).toISOString() });
      }),
      http.get(url("/extension/pairings"), () => HttpResponse.json({ extensions: state.pairings })),
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
