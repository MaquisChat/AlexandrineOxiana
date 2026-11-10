/**
 * Optional live smoke test: real network, real yt-dlp (resolved or downloaded by the worker).
 * Runs only with AO_LIVE_CAPTURE=1 and AO_LIVE_URL=<one public test video URL>; skipped otherwise.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import { createLibrary } from "../library.js";
import { openTestRepo } from "../repo/testing.js";
import { WorkerClient, startWorker } from "../worker-client.js";
import { createLinkCapture } from "./link-capture.js";

const LIVE = process.env.AO_LIVE_CAPTURE === "1" && !!process.env.AO_LIVE_URL;

describe("live link capture", () => {
  it.skipIf(!LIVE)("captures one public video", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ao-live-capture-"));
    const ring = new KeyRing();
    const lib = await createLibrary(join(tmp, "Lib"), "Lib", {
      clock: () => new Date(), deviceId: "live", hostname: "live", pid: process.pid, isPidAlive: () => true,
      appConfigDir: join(tmp, "config"), settleMs: 0, setInterval: () => ({}), clearInterval: () => {},
    });
    const w = await startWorker({ env: { AO_TOOLS_DIR: join(tmp, "tools"), AO_MODELS_DIR: join(tmp, "models") } });
    try {
      const repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "live" });
      const { project } = await repo.createProject({
        name: "Live",
        governanceYaml: "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\ncaptureMethods: [downloader]\n",
        encryption: { enabled: false },
      });
      const capture = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w }) });
      const out = await capture.captureUrl(project.id, process.env.AO_LIVE_URL!, { transcribe: false, quality: "720p" });
      expect(["created", "needs-review"]).toContain(out.status);
      const sf = await repo.getSource(project.id, out.sourceId!);
      expect(sf.source.provenance.captureMethod).toBe("downloader");
      expect(sf.assets.some((a) => a.kind === "platform-metadata")).toBe(true);
    } finally {
      await w.stop();
      await lib.close();
      await rm(tmp, { recursive: true, force: true });
    }
  }, 600_000);
});
