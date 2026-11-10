/**
 * Renders with an imported (custom) citation style in a worker_threads worker (R88 I3): about 2 s
 * of wall time and a 256 MB heap at most, then the worker is terminated. Bundled styles render
 * in-process (@ao/core); a style someone imported is untrusted, and citeproc-js has no limits of its
 * own (a style whose macros fan out runs for hours). A failure of any kind (timeout, heap, a
 * citeproc error, a worker that exits) is a SandboxError; the library process is never affected.
 */
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { CitationFormat, CslItem } from "@ao/core";

export const SANDBOX_TIMEOUT_MS = 2000;
export const SANDBOX_MAX_HEAP_MB = 256;
const SANDBOX_MIN_HEAP_MB = 16;

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "resources" | "error",
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface SandboxRequest {
  /** The independent style's XML. */
  styleXml: string;
  /** Locale XML by tag (the requested one and en-US). */
  locales: Record<string, string>;
  lang: string;
  format: CitationFormat;
  /** "probe": a citation and the bibliography, one per line (an import check). */
  kind: "citation" | "bibliography" | "probe";
  items: CslItem[];
  /** For citations: citeproc's cite items (citeprocCitationItems). */
  cites?: Array<{ id: string; locator?: string; label?: string }>;
}

const citeprocFrom = createRequire(import.meta.url).resolve("@ao/core/package.json");

export function renderInSandbox(req: SandboxRequest, opts: { timeoutMs?: number; maxHeapMb?: number } = {}): Promise<string> {
  // Below about 4 MB a worker cannot even start, and V8 then aborts the whole process: never go there.
  const heap = Math.max(SANDBOX_MIN_HEAP_MB, opts.maxHeapMb ?? SANDBOX_MAX_HEAP_MB);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./sandbox-worker.mjs", import.meta.url), {
      workerData: { citeprocFrom },
      resourceLimits: { maxOldGenerationSizeMb: heap, maxYoungGenerationSizeMb: Math.min(32, Math.max(1, Math.floor(heap / 4))), stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new SandboxError("The citation style took too long to render.", "timeout"))),
      opts.timeoutMs ?? SANDBOX_TIMEOUT_MS,
    );
    worker.once("message", (m: { ok: boolean; out?: string; error?: string }) =>
      finish(() => (m.ok ? resolve(m.out ?? "") : reject(new SandboxError(`The citation style could not be rendered: ${m.error ?? "unknown error"}`, "error")))),
    );
    worker.once("error", (e: Error & { code?: string }) =>
      finish(() =>
        reject(
          e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new SandboxError("The citation style needed too much memory to render.", "resources")
            : new SandboxError(`The citation style could not be rendered: ${e.message.slice(0, 300)}`, "error"),
        ),
      ),
    );
    worker.once("exit", (code) => finish(() => reject(new SandboxError(`The citation style renderer stopped (exit ${code}).`, "error"))));
    worker.postMessage(structuredClone(req));
  });
}
