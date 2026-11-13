/** The largest free copy the app downloads (100 MiB). */
export const FREE_COPY_MAX_BYTES = 104_857_600;
/** The longest address read from a service or a `Location` header; a longer one is dropped. */
export const FREE_COPY_ADDRESS_MAX = 2000;

/** The only hosts a free copy is downloaded from (with `ia<digits>.us.archive.org`, see `fileHostAllowed`). */
export const FREE_COPY_FILE_HOSTS: readonly string[] = Object.freeze([
  "arxiv.org",
  "export.arxiv.org",
  "europepmc.org",
  "pmc.ncbi.nlm.nih.gov",
  "www.ncbi.nlm.nih.gov",
  "library.oapen.org",
  "directory.doabooks.org",
  "archive.org",
]);
const IA_NODE = /^ia\d{3,6}\.us\.archive\.org$/u;

/**
 * An address parsed ONCE (resolved against `base` when given, as a `Location` is against the address that
 * answered); null when it is not a string, is longer than 2,000 characters, or does not parse. The URL returned is
 * what is checked and what is fetched or shown (`href`): the original string is never used again.
 */
export function parseFreeCopyAddress(raw: unknown, base?: URL): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > FREE_COPY_ADDRESS_MAX) return null;
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    return u.href.length <= FREE_COPY_ADDRESS_MAX ? u : null;
  } catch {
    return null;
  }
}

/**
 * The one rule for a file host, on a parsed address: scheme `https:` exactly; no user name or password; no explicit
 * port (an explicit `:443` is dropped by the parser and so passes); the hostname, as the parser gives it (lower-cased,
 * IDN as `xn--…`), equal to a listed host or matching `^ia\d{3,6}\.us\.archive\.org$`. So a trailing dot, an IP
 * literal, `localhost`, a sub-domain or a look-alike of a listed host never matches.
 */
export function fileHostAllowed(u: URL): boolean {
  if (!(u instanceof URL)) return false;
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return false;
  return FREE_COPY_FILE_HOSTS.includes(u.hostname) || IA_NODE.test(u.hostname);
}
