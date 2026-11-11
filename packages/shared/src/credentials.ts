/**
 * Query-string keys that carry a credential (R96, exact names per R98). The service refuses a
 * request with any of them; the UI client refuses to build such a URL. Compared case-insensitively.
 */
export const CREDENTIAL_QUERY_KEYS: ReadonlySet<string> = new Set(["access_token", "token", "auth", "authorization", "key", "apikey", "api_key", "secret", "password", "passphrase", "code", "bearer"]);

export function isCredentialQueryKey(key: string): boolean {
  return CREDENTIAL_QUERY_KEYS.has(key.toLowerCase());
}
