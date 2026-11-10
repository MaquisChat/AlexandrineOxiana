import type { Command } from "commander";
import { SECRET_NAMES, SecretStoreUnavailableError, deleteSecret, setSecret, type SecretName } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { createOut } from "../output.js";
import { ask, isInteractive, zoteroKeyFromEnv } from "../prompt.js";
import type { GlobalOpts } from "./common.js";

/** What the group says when its input is not understood: never what was typed (it may be a key, R81 I1). */
const NOT_UNDERSTOOD = `That is not a secrets command ao understands (what you typed is not shown, in case it was a key).\nUse: ao secrets set ${SECRET_NAMES[0]}   or   ao secrets delete ${SECRET_NAMES[0]}\n`;

function secretName(v: string): SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(v)) throw new ExitError("That is not a key ao keeps (the name you typed is not shown, in case it was a key).", EXIT.failure, `Keys: ${SECRET_NAMES.join(", ")}`);
  return v as SecretName;
}

function storeError(err: unknown): never {
  if (err instanceof SecretStoreUnavailableError) throw new ExitError(err.message, EXIT.failure, "On Linux, a keyring service (such as GNOME Keyring or KWallet) must be running.");
  throw err;
}

/**
 * `ao secrets`: API keys go into the system keychain / credential manager only. A key is never
 * accepted on the command line (it would end up in the shell history and the process list): it is
 * typed at a hidden prompt, or given once in AO_ZOTERO_API_KEY (read and removed at startup).
 */
export function registerSecrets(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("Save or remove API keys (kept only in your system's keychain, never in files)")
    // Commander's own errors repeat the unknown word (an unknown subcommand, option or extra
    // argument): inside this group they are replaced by a fixed message. Subcommands inherit this.
    .configureOutput({ outputError: (_str, write) => write(NOT_UNDERSTOOD) })
    .showHelpAfterError(false);
  secrets
    .command("set")
    .description("Save a key: you are asked for it (what you type is hidden)")
    .argument("<name>", `which key: ${SECRET_NAMES.join(", ")}`)
    // Extra words are refused here, not by commander (whose message would repeat them: a key typed there).
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (name: string, _o: unknown, cmd: Command) => {
      if (cmd.args.length > 1 || name.startsWith("-")) {
        throw new ExitError(
          "A key is never accepted on the command line (it would stay in your shell history). Nothing was saved.",
          EXIT.failure,
          "Run `ao secrets set zotero-api-key` and type it when asked, or set AO_ZOTERO_API_KEY for that one command.",
        );
      }
      const out = createOut((cmd.optsWithGlobals() as GlobalOpts).json === true);
      const n = secretName(name);
      let value = n === "zotero-api-key" ? zoteroKeyFromEnv() : undefined;
      if (value === undefined) {
        if (!isInteractive()) throw new ExitError("Type the key in a terminal, or set AO_ZOTERO_API_KEY for this one command.", EXIT.failure);
        value = (await ask("Zotero API key (from zotero.org, Settings, Security; read-only access is enough): ", true)).trim();
      }
      if (!value) throw new ExitError("A key cannot be empty. Nothing was saved.", EXIT.failure);
      try {
        await setSecret(n, value);
      } catch (err) {
        if (err instanceof TypeError) throw new ExitError("That does not look like a key. Nothing was saved.", EXIT.failure);
        storeError(err);
      }
      out.data({ name: n, saved: true });
      out.line(`Saved the ${n} in your system's keychain.`);
    });
  secrets
    .command("delete")
    .description("Remove a saved key")
    .argument("<name>", `which key: ${SECRET_NAMES.join(", ")}`)
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (name: string, _o: unknown, cmd: Command) => {
      if (cmd.args.length > 1 || name.startsWith("-")) throw new ExitError(NOT_UNDERSTOOD.trim(), EXIT.failure);
      const out = createOut((cmd.optsWithGlobals() as GlobalOpts).json === true);
      const n = secretName(name);
      let removed = false;
      try {
        removed = await deleteSecret(n);
      } catch (err) {
        storeError(err);
      }
      out.data({ name: n, removed });
      out.line(removed ? `Removed the ${n}.` : `No ${n} was saved.`);
    });
}
