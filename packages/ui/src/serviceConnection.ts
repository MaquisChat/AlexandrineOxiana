/**
 * The desktop shell (Task 37) puts the local service's URL and the UI token on
 * `window.__AO_SERVICE__` before the app loads. The app reads it once and deletes it, so the token
 * is not left lying on a global (R105); from then on only the API client holds it.
 */
export interface ServiceConnection {
  baseUrl: string;
  token: string;
}

declare global {
  interface Window {
    __AO_SERVICE__?: ServiceConnection;
  }
}

export function takeServiceConnection(w: Window): ServiceConnection | undefined {
  const c = w.__AO_SERVICE__ as Partial<ServiceConnection> | undefined;
  try {
    delete w.__AO_SERVICE__;
  } catch {
    w.__AO_SERVICE__ = undefined;
  }
  if (c && typeof c.baseUrl === "string" && typeof c.token === "string") return { baseUrl: c.baseUrl, token: c.token };
  return undefined;
}
