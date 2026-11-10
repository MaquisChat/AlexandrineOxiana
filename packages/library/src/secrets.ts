/**
 * Secrets (Task 26, R78): API keys such as the Zotero Web API key live only in the operating
 * system's credential store (macOS Keychain, Windows Credential Manager, the Secret Service on
 * Linux), through `@napi-rs/keyring`, under the service name `AlexandrineOxiana`. They are never
 * written to the library, to app settings, to logs, reports or audit events, and never echoed in
 * errors.
 *
 * There is no fallback: when no credential store is available (a Linux machine without a Secret
 * Service, a locked store), `setSecret`/`getSecret` throw SecretStoreUnavailableError with a plain
 * message and nothing is stored anywhere else. On Linux the entry is pinned to the Secret Service
 * (the kernel keyring forgets everything at logout/reboot, and is not a store the user can see).
 *
 * Tests use the in-memory backend from `./secrets-testing.ts` (not exported from the package).
 */
import { createRequire } from "node:module";

export const SECRET_SERVICE = "AlexandrineOxiana";

/** Names of the secrets the app keeps (anything else is refused, so a typo never creates a stray entry). */
export const SECRET_NAMES = ["zotero-api-key"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const SECRET_STORE_UNAVAILABLE =
  "No secure key store is available on this computer (the system keychain or credential manager), so the key was not saved. Keys are never kept in plain files.";

export class SecretStoreUnavailableError extends Error {
  override name = "SecretStoreUnavailableError";
  constructor() {
    super(SECRET_STORE_UNAVAILABLE);
  }
}

/** Where secrets go: the OS keyring, or (tests) an in-memory map. */
export interface SecretBackend {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(v: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type EntryCtor = new (service: string, user: string, options?: { linux?: { store?: "secret-service" | "keyutils" } }) => KeyringEntry;

let entryCtor: EntryCtor | null | undefined;
function loadKeyring(): EntryCtor | null {
  if (entryCtor === undefined) {
    try {
      entryCtor = (createRequire(import.meta.url)("@napi-rs/keyring") as { AsyncEntry: EntryCtor }).AsyncEntry;
    } catch {
      entryCtor = null; // the native module is missing for this platform
    }
  }
  return entryCtor;
}

/** The OS keyring. Every failure of the store becomes SecretStoreUnavailableError (its own message, which may name the store, is dropped). */
const keyringBackend: SecretBackend = {
  async get(name) {
    const Entry = loadKeyring();
    if (!Entry) throw new SecretStoreUnavailableError();
    try {
      return await new Entry(SECRET_SERVICE, name, { linux: { store: "secret-service" } }).getPassword();
    } catch {
      throw new SecretStoreUnavailableError();
    }
  },
  async set(name, value) {
    const Entry = loadKeyring();
    if (!Entry) throw new SecretStoreUnavailableError();
    try {
      await new Entry(SECRET_SERVICE, name, { linux: { store: "secret-service" } }).setPassword(value);
    } catch {
      throw new SecretStoreUnavailableError();
    }
  },
  async delete(name) {
    const Entry = loadKeyring();
    if (!Entry) throw new SecretStoreUnavailableError();
    try {
      return await new Entry(SECRET_SERVICE, name, { linux: { store: "secret-service" } }).deletePassword();
    } catch {
      throw new SecretStoreUnavailableError();
    }
  },
};

let backend: SecretBackend = keyringBackend;

/** Package-internal test seam (secrets-testing.ts): replaces the backend; `null` restores the OS keyring. */
export function _setSecretBackend(b: SecretBackend | null): void {
  backend = b ?? keyringBackend;
}

function checkName(name: string): asserts name is SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new TypeError(`unknown secret "${name}"`);
}

/** The secret, or null when none is saved. Throws SecretStoreUnavailableError when there is no store. */
export async function getSecret(name: SecretName): Promise<string | null> {
  checkName(name);
  const v = await backend.get(name);
  return v === null || v === undefined || v === "" ? null : v;
}

/** Saves the secret in the OS credential store (never anywhere else). */
export async function setSecret(name: SecretName, value: string): Promise<void> {
  checkName(name);
  if (typeof value !== "string" || !value.trim()) throw new TypeError("A key cannot be empty.");
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("That does not look like a key.");
  await backend.set(name, value.trim());
}

/** Removes the secret; true when one was removed. */
export async function deleteSecret(name: SecretName): Promise<boolean> {
  checkName(name);
  return backend.delete(name);
}
