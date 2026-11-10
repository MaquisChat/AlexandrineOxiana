import { basename } from "node:path";
import type { Command } from "commander";
import { createLibrary, openLibrary } from "@ao/library";
import { rememberRoot } from "../errors.js";
import { createOut } from "../output.js";
import { makeDeps, readOnlyText, resolveUserPath } from "../session.js";
import type { GlobalOpts } from "./common.js";

export function registerLibrary(program: Command): void {
  const lib = program.command("library").description("Create or inspect a library (the folder that holds all your projects)");

  lib
    .command("create")
    .description("Create a new, empty library in a folder")
    .argument("<path>", "the folder (it must be empty or not exist yet)")
    .option("--name <name>", "a name for the library (default: the folder's name)")
    .action(async (path: string, o: { name?: string }, cmd: Command) => {
      const out = createOut((cmd.optsWithGlobals() as GlobalOpts).json === true);
      const root = resolveUserPath(path);
      rememberRoot(root);
      const library = await createLibrary(root, o.name ?? basename(root), makeDeps());
      try {
        out.data({ libraryId: library.id, name: library.name, mode: library.mode });
        out.line(`Created the library "${library.name}" at ${path}`);
        out.line("Next: create a project with  ao project create <name> --profile irb --capture downloader");
      } finally {
        await library.close();
      }
    });

  lib
    .command("open")
    .description("Check a library and show whether it can be changed")
    .argument("<path>", "the library's folder")
    .action(async (path: string, _o: unknown, cmd: Command) => {
      const out = createOut((cmd.optsWithGlobals() as GlobalOpts).json === true);
      const root = resolveUserPath(path);
      rememberRoot(root);
      const library = await openLibrary(root, makeDeps());
      try {
        const reason = library.readOnlyReason;
        out.data({ libraryId: library.id, name: library.name, mode: library.mode, ...(reason ? { readOnlyReason: reason, readOnlyExplanation: readOnlyText(reason) } : {}) });
        out.line(`Library "${library.name}"`);
        out.line(`Mode: ${library.mode}`);
        if (reason) out.line(`Read-only because ${readOnlyText(reason)}.`);
      } finally {
        await library.close();
      }
    });
}
