import type { Command } from "commander";
import { NoMediaError, PolicyDeniedError, WorkerJobError, WorkerUnavailableError, createLinkCapture } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { folderLabel } from "../output.js";
import { parseLanguage, parseModel, withProject } from "./common.js";
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
        const model = parseModel(o.model);
        const language = parseLanguage(o.language);
        const sf = await resolveSource(s.repo, project.id, ref);
        const worker = await s.needWorker();
        const capture = createLinkCapture({ repo: s.repo, worker: worker.client, ...(s.index ? { index: s.index } : {}) });
        out.progress("Transcribing (this can take a while)...");
        let r;
        try {
          r = await capture.transcribeSource(project.id, sf.source.id, { ...(model ? { model } : {}), ...(language ? { language } : {}) });
        } catch (err) {
          if (err instanceof PolicyDeniedError || err instanceof WorkerUnavailableError) throw err;
          if (err instanceof NoMediaError) throw new ExitError(err.message, EXIT.failure);
          if (err instanceof WorkerJobError && err.code === "CANCELLED") throw new ExitError("Cancelled. Nothing was saved.", EXIT.failure);
          throw new ExitError("The transcript could not be made.", EXIT.failure, err instanceof Error ? err.message : undefined);
        }
        out.data({ sourceId: r.sourceId, folder: r.folder, files: r.files, flaggedSegments: r.flaggedSegments });
        out.line(`transcribed  ${folderLabel(r.folder)}  →  ${r.folder}`);
        if (r.flaggedSegments) out.line(`${" ".repeat(13)}${r.flaggedSegments} passage(s) were flagged as possibly wrong; check them against the audio.`);
      });
    });
}
