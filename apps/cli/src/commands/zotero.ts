import type { Command } from "commander";
import {
  HttpClient,
  ZOTERO_SYNC_NEWER_SENTENCE,
  appConfigDir,
  listLibraries,
  ZoteroAccountError,
  ZoteroSyncFileUnreadableError,
  checkZoteroKey,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  syncZoteroLibrary,
  zoteroHistoryBackoff,
  zoteroSyncBackoff,
  zoteroSyncRunCounts,
  type ZoteroSyncDeps,
  type ZoteroSyncLink,
  type ZoteroSyncRun,
} from "@ao/library";
import {
  ZOTERO_SYNC_REASON_TEXT,
  ZOTERO_SYNC_SENTENCES,
  zoteroKeySummary,
  zoteroSyncReasonText,
  zoteroSyncStatusLine,
  type ZoteroKeyAccess,
  type ZoteroSyncReason,
  type ZoteroSyncRun as SharedRun,
} from "@ao/shared";
import { EXIT, ExitError } from "../errors.js";
import { createOut } from "../output.js";
import { unlockIfNeeded } from "../session.js";
import type { GlobalOpts } from "./common.js";
import { withSession } from "./common.js";

/** The same shape the service checks a Zotero library reference by (`POST /zotero/sync/run`). */
const REF = /^(user|group):[1-9]\d{0,11}$/u;

/** What the group says when its input is not understood: never what was typed (it may be a key, R78). */
const NOT_UNDERSTOOD =
  "That is not a zotero command ao understands (what you typed is not shown, in case it was a key).\nUse: ao zotero check-key   or   ao zotero sync [--ref user:<id>|group:<id>]\n";
const KEY_HINT = "Save it with: ao secrets set zotero-api-key";
/** R299 b: a `--ref` that is not a Zotero library is refused without repeating what was typed (it may be a key, R78). */
const NOT_A_LIBRARY = "That is not a Zotero library. Write --ref user:<number> or --ref group:<number>.";

/**
 * R299 a: the back-off recorded by any earlier run on this computer (the app's or the command line's), folded as the
 * service folds it (`zoteroHistoryBackoff`, then the clock rule `zoteroSyncBackoff`). The service folds the history of
 * the library it has open; this command opens none, so it folds the records of every library this computer knows: a
 * back-off is Zotero's answer to this computer's requests (one key), so it is the same wait whichever library's run was
 * told it, and none the service would obey is missed. A history that cannot be read counts as none, as in the service.
 */
async function recordedBackoff(): Promise<number | undefined> {
  const dir = appConfigDir();
  const known = await listLibraries({ appConfigDir: dir, clock: () => new Date() }).catch(() => []);
  const runs: ZoteroSyncRun[] = [];
  for (const lib of known) runs.push(...(await readZoteroSyncHistory(dir, lib.libraryId).catch(() => [])));
  return zoteroSyncBackoff(zoteroHistoryBackoff(runs), Date.now());
}

/** Zotero's own refusal reasons are the sync's reasons by the same names, except that "no-key" is "key-missing". */
const sentenceOfAccount = (reason: string, backoffUntil?: number): string => {
  const r = (reason === "no-key" ? "key-missing" : reason) as ZoteroSyncReason;
  return r === "backing-off" ? zoteroSyncReasonText(r, new Date(), backoffUntil !== undefined ? new Date(backoffUntil).toISOString() : undefined) : ZOTERO_SYNC_REASON_TEXT[r];
};

/** The saved key's check failed: the service's sentence, never anything Zotero said, never the key. */
function keyCheckFailure(err: unknown): never {
  if (err instanceof ZoteroAccountError) {
    const message = sentenceOfAccount(err.reason, err.backoffUntil);
    if (err.reason === "no-key") throw new ExitError(message, EXIT.needsAction, KEY_HINT);
    if (err.reason === "no-store") throw new ExitError(message, EXIT.failure, "On Linux, a keyring service (such as GNOME Keyring or KWallet) must be running.");
    throw new ExitError(message, EXIT.failure);
  }
  throw new ExitError("The key could not be checked. Try again in a moment.", EXIT.failure);
}

/** What the researcher is told about a link that is paused (the sentences are the service's). */
function pauseSentence(paused: string): string {
  if (paused === "undone") return ZOTERO_SYNC_REASON_TEXT["sync-undone"];
  if (paused === "key-refused") return ZOTERO_SYNC_REASON_TEXT["key-refused"];
  if (paused === "library-gone") return ZOTERO_SYNC_REASON_TEXT["library-gone"];
  return "Syncing of this library is paused.";
}

/** Exit code of one run: 4 for a missing key (the researcher must save one), 1 for anything that did not end well, else 0. */
function exitForRun(r: ZoteroSyncRun): number {
  if (r.outcome === "up-to-date" || r.outcome === "finished") return EXIT.ok;
  if (r.outcome === "failed" && r.reason === "key-missing") return EXIT.needsAction;
  // R295 b / R78 d: the project's rules refused it.
  if (r.outcome === "failed" && r.reason === "rules-denied") return EXIT.denied;
  return EXIT.failure;
}
/** The worst of two exit codes, in the command line's order: denied 2, then needs-the-researcher 4, then failure 1. */
const worse = (a: number, b: number): number => {
  const rank = (c: number) => (c === EXIT.denied ? 3 : c === EXIT.needsAction ? 2 : c === EXIT.failure ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
};

interface Skipped {
  ref: string;
  projectId: string;
  reason: string;
  message: string;
}

/**
 * `ao zotero`: the Zotero account sync from the command line. The key is the one SAVED in the system's password store
 * (`ao secrets set zotero-api-key`); it is never accepted, printed, logged or put in a file here (R78).
 */
export function registerZotero(program: Command): void {
  const zotero = program
    .command("zotero")
    .description("Check your saved Zotero key, or sync your linked Zotero libraries into their projects (see the Zotero screen of the app)")
    // Commander's own errors repeat the unknown word (an unknown option or extra argument): inside this group they are
    // replaced by a fixed message, so a key typed by mistake is never echoed. Subcommands inherit this.
    .configureOutput({ outputError: (_str, write) => write(NOT_UNDERSTOOD) })
    .showHelpAfterError(false);

  zotero
    .command("check-key")
    .description("Check the saved Zotero key and say which libraries it can read (the key is never shown)")
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (_o: unknown, cmd: Command) => {
      if (cmd.args.length > 0) {
        throw new ExitError("A key is never accepted on the command line (it would stay in your shell history). Nothing was checked.", EXIT.failure, "Save it with `ao secrets set zotero-api-key` and run this again.");
      }
      const out = createOut((cmd.optsWithGlobals() as GlobalOpts).json === true);
      // R299 a: inside a recorded back-off nothing is asked of Zotero (as the service's key check refuses): the sentence
      // with its time, exit 1. (A back-off Zotero gives in answer to this check is not kept: the history holds runs.)
      const inForce = await recordedBackoff();
      if (inForce !== undefined) throw new ExitError(zoteroSyncReasonText("backing-off", new Date(), new Date(inForce).toISOString()), EXIT.failure);
      let access;
      try {
        access = await checkZoteroKey();
      } catch (err) {
        keyCheckFailure(err);
      }
      const view: ZoteroKeyAccess = {
        userId: access.userId,
        personal: { library: access.personal.library, files: access.personal.files, notes: access.personal.notes, write: access.personal.write },
        groups: access.groups.map((g) => ({ ref: g.ref, name: g.name, write: g.write })),
      };
      const summary = zoteroKeySummary(view);
      out.data({ ...view, summary });
      out.line(summary);
    });

  zotero
    .command("sync")
    .description("Sync each linked Zotero library into its project, once (the links are made on the app's Zotero screen)")
    .option("--ref <library>", "only this library: user:<id> or group:<id>")
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (o: { ref?: string }, cmd: Command) => {
      if (cmd.args.length > 0) throw new ExitError(NOT_UNDERSTOOD.trim(), EXIT.failure);
      if (o.ref !== undefined && !REF.test(o.ref)) {
        throw new ExitError(NOT_A_LIBRARY, EXIT.failure);
      }
      await withSession(cmd, true, async (s, out) => {
        // The settings are read through the library's own module: a file from a newer version is left as it is, a
        // damaged one is set aside by the module (which raises the app's notice); nothing runs on either.
        let newer = false;
        let aside = false;
        let settings;
        try {
          settings = await readZoteroSyncSettings(s.deps.appConfigDir, s.lib.id, { onNewer: () => (newer = true), onSetAside: () => (aside = true) });
        } catch (err) {
          if (err instanceof ZoteroSyncFileUnreadableError) throw new ExitError(ZOTERO_SYNC_SENTENCES.settingsUnreadable, EXIT.failure);
          throw err;
        }
        if (newer) throw new ExitError(ZOTERO_SYNC_NEWER_SENTENCE, EXIT.failure);
        if (aside) {
          throw new ExitError("This computer's Zotero sync settings were damaged, so they were set aside and no library is linked. Nothing was synced.", EXIT.failure, "The app shows a notice about it. Link your libraries again on its Zotero screen.");
        }
        // R295 a: a back-off any earlier run recorded (the app's or this command's) is obeyed before Zotero is asked anything:
        // nothing requested, nothing recorded, the sentence with its time (as the service refuses, before it looks at the links).
        let earlier: ZoteroSyncRun[];
        try {
          earlier = await readZoteroSyncHistory(s.deps.appConfigDir, s.lib.id);
        } catch (err) {
          if (err instanceof ZoteroSyncFileUnreadableError) throw new ExitError(ZOTERO_SYNC_SENTENCES.settingsUnreadable, EXIT.failure);
          throw err;
        }
        const inForce = zoteroSyncBackoff(zoteroHistoryBackoff(earlier), Date.now());
        if (inForce !== undefined) throw new ExitError(zoteroSyncReasonText("backing-off", new Date(), new Date(inForce).toISOString()), EXIT.failure);
        let targets: ZoteroSyncLink[];
        if (o.ref !== undefined) {
          const one = settings.links.find((l) => l.ref === o.ref);
          if (!one) throw new ExitError(ZOTERO_SYNC_SENTENCES.notLinked, EXIT.failure);
          targets = [one];
        } else {
          if (!settings.links.length) throw new ExitError(ZOTERO_SYNC_SENTENCES.nothingLinked, EXIT.needsAction);
          targets = settings.links;
        }

        const ac = new AbortController();
        let current: Promise<unknown> | undefined;
        // Ctrl+C: the engine's own stop (the batch is suspended at a safe point and the record says "stopped"), awaited
        // before the library is released.
        s.beforeClose(async () => {
          ac.abort("stopped-by-you");
          await current?.catch(() => undefined);
        });
        const deps: ZoteroSyncDeps = {
          repo: s.repo,
          http: new HttpClient({ libraryRoot: s.lib.root }),
          index: s.index!,
          appConfigDir: s.deps.appConfigDir,
          libraryId: s.lib.id,
          // The runner's notes name no key, title or server text (R78); shown only when asked for, like a stack trace.
          ...(process.env.AO_DEBUG ? { debug: (note: string) => void process.stderr.write(`${note}\n`) } : {}),
        };

        const runs: Array<{ run: ZoteroSyncRun; status: string }> = [];
        const skipped: Skipped[] = [];
        const notRun: Array<{ ref: string; message: string }> = [];
        let code: number = EXIT.ok;
        let kept: number | undefined;
        let stopAfter: string | undefined;

        for (const link of targets) {
          if (stopAfter !== undefined) {
            notRun.push({ ref: link.ref, message: stopAfter });
            code = worse(code, EXIT.failure);
            continue;
          }
          // A paused link is not run (nothing is requested, nothing recorded): its reason is said.
          if (link.paused) {
            skipped.push({ ref: link.ref, projectId: link.projectId, reason: link.paused, message: pauseSentence(link.paused) });
            continue;
          }
          // A locked project is unlocked the way every command unlocks one (AO_PASSPHRASE, or asked for in a terminal);
          // when that cannot be done, its link is skipped with the sentence, as `import` refuses it.
          let project;
          try {
            project = s.repo.getProject(link.projectId);
          } catch {
            project = undefined; // the runner records its own "error" for a project that is gone
          }
          if (project?.encryption.enabled && !s.repo.isUnlocked(project.id)) {
            try {
              await unlockIfNeeded(s.repo, project);
            } catch (err) {
              if (!(err instanceof ExitError)) throw err;
              skipped.push({ ref: link.ref, projectId: link.projectId, reason: "project-locked", message: `${ZOTERO_SYNC_REASON_TEXT["project-locked"]} ${err.hint ?? ""}`.trim() });
              code = worse(code, EXIT.failure);
              continue;
            }
          }
          const started = syncZoteroLibrary(deps, link, { trigger: "manual", signal: ac.signal, ...(kept !== undefined ? { backoffUntil: kept } : {}) });
          current = started;
          let run = await started;
          current = undefined;
          // An encrypted project's counts are in its batch, never in this computer's file; read while it is unlocked.
          const { recordSaved: _saved, counts: given, ...bare } = run;
          let counts = given;
          if (project?.encryption.enabled) counts = run.batchId ? await zoteroSyncRunCounts(s.repo, link.projectId, run.batchId).catch(() => undefined) : undefined;
          run = { ...bare, ...(counts ? { counts } : {}) };
          runs.push({ run, status: zoteroSyncStatusLine(run as SharedRun, new Date()) });
          code = worse(code, exitForRun(run));
          if (run.backoffUntil !== undefined) kept = Date.parse(run.backoffUntil);
          // As the service's own run: a run that was stopped, a refused key or a back-off now in force end the rest.
          const wait = zoteroSyncBackoff(kept, Date.now());
          if (run.outcome === "stopped") stopAfter = ZOTERO_SYNC_REASON_TEXT["stopped-by-you"];
          else if (run.reason === "key-refused") stopAfter = ZOTERO_SYNC_REASON_TEXT["key-refused"];
          else if (wait !== undefined) stopAfter = zoteroSyncReasonText("backing-off", new Date(), new Date(wait).toISOString());
        }

        out.data({ runs, ...(skipped.length ? { skipped } : {}), ...(notRun.length ? { notRun } : {}) });
        for (const k of skipped) out.line(`${k.ref}: ${k.message}`);
        for (const r of runs) out.line(`${r.run.ref}: ${r.status}`);
        for (const n of notRun) out.line(`${n.ref}: Not synced. ${n.message}`);
        // Nothing could run because every library asked for is paused: the researcher has to turn syncing on again.
        if (!runs.length && !notRun.length && skipped.length && skipped.every((k) => k.reason !== "project-locked")) {
          if (o.ref === undefined) out.progress(ZOTERO_SYNC_SENTENCES.allPaused);
          code = worse(code, EXIT.needsAction);
        }
        if (code !== EXIT.ok) process.exitCode = code;
      });
    });
}
