/**
 * MSW (pinned exact, R113) for the Task 36 screens: a Node request interceptor in front of the real
 * client (createClient), so tests exercise the same URLs, headers and bodies the service sees.
 */
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createClient } from "../api/client";
import { governanceApi } from "../api/governance";

export const BASE = "http://127.0.0.1:4317";
export const TOKEN = "t".repeat(40) + "-task36";
export const url = (path: string) => `${BASE}${path}`;

export const server = setupServer();

/** Installs the interceptor for the calling test file; unhandled requests fail the test. */
export function useMsw(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

export const makeApi = () => governanceApi(createClient(BASE, TOKEN));
