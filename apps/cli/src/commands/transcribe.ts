import { basename, join } from "node:path";
import type { Command } from "commander";
import { PolicyDeniedError } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { folderLabel } from "../output.js";
import { withProject } from "./common.js";
import { resolveSource } from "./sources.js";

export function registerTranscribe(program: Command): void {
  program
    .command("transcribe")
    .description("Make a transcript of a video or audio source already in a project")
    .argument("<source>", "the source's id, its short code (the four characters in [brackets] in its folder name) or its folder name")
    .requiredOption("--project <name>", "the project")
    .option("--model <name>", "transcription model: large-v3, medium or small")
    .option("--language <code>", "spoken language: auto (default) or a code such as en")
    .action(async (ref: string, _o: unknown, cmd: Command) => {
      await withProject(cmd, true, async (s, project, out, o) => {
        const sf = await resolveSource(s.repo, project.id, ref);
        const media = sf.assets.find((a) => a.role === "original" && (a.kind === "video" || a.kind === "audio"));
        if (!media) throw new ExitError("This source has no video or audio file to transcribe.");
        const model = o.model ? String(o.model) : undefined;
        const language = o.language ? String(o.language) : "auto";
        const worker = await s.needWorker();
        const work = join(s.lib.root, ".tmp", `transcribe-${Date.now()}`);
        let r;
        try {
          out.progress("Transcribing (this can take a while)...");
          r = await worker.client.submit(project.id, {
            type: "audio.transcribe",
            input: join(s.lib.root, ...media.path.split("/")),
            inputEncrypted: media.encrypted,
            output: work,
            params: { ...(model ? { model } : {}), ...(language !== "auto" ? { language } : {}) },
            entity: { type: "asset", id: media.id },
          });
        } catch (err) {
          if (err instanceof PolicyDeniedError) throw err;
          const code = (err as { code?: string }).code;
          throw new ExitError(code === "CANCELLED" ? "Cancelled. Nothing was saved." : "The transcript could not be made.", EXIT.failure, err instanceof Error ? err.message : undefined);
        }
        const used = typeof r.meta.model === "string" ? r.meta.model : (model ?? "whisper");
        const langs = Array.isArray(r.meta.detectedLanguages) ? r.meta.detectedLanguages.filter((l): l is string => typeof l === "string") : [];
        const lang = langs.length === 1 ? langs[0]! : langs.length > 1 ? "mul" : "und";
        const flagged = typeof r.meta.flaggedCount === "number" ? r.meta.flaggedCount : undefined;
        const at = new Date().toISOString();
        const saved: string[] = [];
        for (const ext of ["vtt", "json"]) {
          const file = r.files.find((f) => basename(f) === (ext === "vtt" ? "transcript.vtt" : "segments.json"));
          if (!file) continue;
          const asset = await s.repo.addDerivedAsset(project.id, sf.source.id, {
            fromPath: file,
            kind: "transcript",
            lang,
            tool: `whisper-${used}`,
            ext,
            ...(r.encrypted ? { fromEncrypted: true } : {}),
            ...(flagged !== undefined ? { metadata: { flaggedSegments: flagged } } : {}),
            derivation: {
              parents: [media.id],
              operation: "transcribe",
              provider: "faster-whisper",
              model: used,
              ranAt: "local",
              params: { model: used, detectedLanguages: langs, language },
              at,
              triggeredBy: "cli",
            },
          });
          saved.push(asset.path);
        }
        const label = folderLabel(sf.source.folder);
        out.data({ sourceId: sf.source.id, folder: sf.source.folder, files: saved, flaggedSegments: flagged ?? 0 });
        out.line(`transcribed  ${label}  →  ${sf.source.folder}`);
        if (flagged) out.line(`${" ".repeat(13)}${flagged} passage(s) were flagged as possibly wrong; check them against the audio.`);
      });
    });
}
