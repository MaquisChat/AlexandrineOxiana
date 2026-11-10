import type { Command } from "commander";
import { createOut } from "../output.js";
import { startCaptureWorker } from "../worker.js";
import type { GlobalOpts } from "./common.js";

async function withWorker<T>(cmd: Command, body: (w: Awaited<ReturnType<typeof startCaptureWorker>>, out: ReturnType<typeof createOut>) => Promise<T>): Promise<T> {
  const out = createOut((cmd.optsWithGlobals() as GlobalOpts).json === true);
  const w = await startCaptureWorker();
  try {
    return await body(w, out);
  } finally {
    await w.stop().catch(() => {});
  }
}

export function registerTools(program: Command): void {
  const tools = program.command("tools").description("The capture tools (yt-dlp, gallery-dl) and what else the media helper uses");

  tools
    .command("versions")
    .description("Show the versions of the capture tools")
    .action(async (_o: unknown, cmd: Command) => {
      await withWorker(cmd, async (w, out) => {
        const v = await w.versions();
        out.data({ versions: v });
        for (const [k, val] of Object.entries(v)) out.line(`${k.padEnd(14)}${val ?? "not found"}`);
      });
    });

  tools
    .command("update")
    .description("Update yt-dlp (the downloader) to the latest release")
    .action(async (_o: unknown, cmd: Command) => {
      await withWorker(cmd, async (w, out) => {
        out.progress("Updating yt-dlp...");
        const r = await w.updateTools();
        out.data(r);
        const { old, new: now, managed } = r.ytDlp;
        if (!managed) {
          out.line(`yt-dlp ${now ?? "(not found)"}: this copy is provided by your system, so it was left alone.`);
        } else if (old === now) {
          out.line(`yt-dlp ${now}: already the latest version.`);
        } else {
          out.line(`yt-dlp ${old ?? "(not installed)"} → ${now}`);
        }
        out.line(`gallery-dl ${r.galleryDl.version ?? "(not found)"}: updated together with this program.`);
      });
    });
}
