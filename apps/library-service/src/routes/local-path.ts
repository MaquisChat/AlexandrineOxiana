/**
 * The one test for a path a route takes in its body or query (R391 g): an absolute path of THIS
 * computer — the host's own `path.isAbsolute`, so on macOS and Linux a Windows drive path (`C:\x`,
 * `c:/x`) or a network path (`\\server\share\x`) is not one — holding no NUL. Every route that takes a
 * path refuses anything else before the library is called, each with its own sentence.
 */
import { isAbsolute } from "node:path";

export function isLocalAbsolutePath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !p.includes("\0") && isAbsolute(p);
}
