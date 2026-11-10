import type { Command } from "commander";
import { COOKIES_ACKNOWLEDGEMENT, type BrowserName, type CaptureOutcome } from "@ao/library";
import type { Project, SourceFile } from "@ao/core";
import { EXIT, ExitError } from "../errors.js";
import { createOut, itemView, type ItemView, type Out } from "../output.js";
import { confirm, isInteractive } from "../prompt.js";
import { openProject, openSession, type Session } from "../session.js";

export const BROWSERS: BrowserName[] = ["chrome", "firefox", "safari", "edge", "brave"];

export interface GlobalOpts {
  library?: string;
  json?: boolean;
}

/** Runs a command body with the library open (and always closed again). */
export async function withSession<T>(
  cmd: Command,
  write: boolean,
  body: (s: Session, out: Out, opts: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const opts = cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;
  const out = createOut(opts.json === true);
  const s = await openSession({ library: opts.library, write });
  try {
    return await body(s, out, opts);
  } finally {
    await s.close();
  }
}

export async function withProject<T>(
  cmd: Command,
  write: boolean,
  body: (s: Session, project: Project, out: Out, opts: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  return withSession(cmd, write, async (s, out, opts) => body(s, await openProject(s, opts.project as string | undefined), out, opts));
}

export function parseBrowser(v: unknown): BrowserName | undefined {
  if (v === undefined) return undefined;
  const b = String(v).toLowerCase() as BrowserName;
  if (!BROWSERS.includes(b)) throw new ExitError(`"${String(v)}" is not a supported browser.`, EXIT.failure, `Choose one of: ${BROWSERS.join(", ")}`);
  return b;
}

/**
 * Using the browser session needs the project's one-time acknowledgement. Interactive: show the
 * library's exact text and ask. Otherwise `--acknowledge-cookies`. Nothing about the cookies
 * themselves is ever read, printed or logged here.
 */
export async function ensureCookieAcknowledgement(s: Session, project: Project, browser: BrowserName | undefined, flag: boolean): Promise<void> {
  if (!browser || project.captureAcknowledgements?.cookies) return;
  if (flag) {
    await s.repo.acknowledge(project.id, "cookies");
    return;
  }
  if (!isInteractive()) {
    throw new ExitError(COOKIES_ACKNOWLEDGEMENT, EXIT.acknowledgement, "Run again with --acknowledge-cookies to confirm this, or run it in a terminal to be asked.");
  }
  process.stderr.write(`\n${COOKIES_ACKNOWLEDGEMENT}\n\n`);
  if (!(await confirm("Do you want to use your browser session for this project?"))) {
    throw new ExitError("Understood. Nothing was captured.", EXIT.acknowledgement);
  }
  await s.repo.acknowledge(project.id, "cookies");
}

export const LEGAL_BASIS_HINT =
  'Add --legal-basis "<text>" to this command, or give the project a default when you create it with: ao project create <name> --default-legal-basis "<text>"';

/** Exit code of a run of items: denial 2, then legal basis missing 4, then any failure 1, else 0. */
export function exitForItems(items: Array<Pick<CaptureOutcome, "status" | "errorCode">>): number {
  const failed = items.filter((i) => i.status === "failed");
  if (failed.some((i) => i.errorCode === "POLICY_DENIED")) return EXIT.denied;
  if (failed.some((i) => i.errorCode === "LEGAL_BASIS_REQUIRED")) return EXIT.needsAction;
  if (failed.length > 0) return EXIT.failure;
  return EXIT.ok;
}

export async function viewOf(s: Session, projectId: string, o: CaptureOutcome): Promise<ItemView> {
  let sf: SourceFile | undefined;
  if (o.sourceId) sf = await s.repo.getSource(projectId, o.sourceId).catch(() => undefined);
  return itemView(o, sf);
}
