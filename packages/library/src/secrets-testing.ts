/**
 * Test seam for secrets.ts (never exported from the package index): an in-memory secret store, and
 * one that behaves like a computer without a credential store.
 */
import { SecretStoreUnavailableError, _setSecretBackend, type SecretBackend } from "./secrets.js";

/** Uses an in-memory store until `restore()`; returns the map it keeps. */
export function useMemorySecrets(): { values: Map<string, string>; restore(): void } {
  const values = new Map<string, string>();
  const b: SecretBackend = {
    get: async (n) => values.get(n) ?? null,
    set: async (n, v) => {
      values.set(n, v);
    },
    delete: async (n) => values.delete(n),
  };
  _setSecretBackend(b);
  return { values, restore: () => _setSecretBackend(null) };
}

/** Behaves like a computer with no credential store until `restore()`. */
export function useNoSecretStore(): { restore(): void } {
  const fail = async (): Promise<never> => {
    throw new SecretStoreUnavailableError();
  };
  _setSecretBackend({ get: fail, set: fail, delete: fail });
  return { restore: () => _setSecretBackend(null) };
}
