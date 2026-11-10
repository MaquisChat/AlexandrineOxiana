import type { Command } from "commander";
import { createLinkCapture, type ProfileContentType } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { itemLines, profileLines } from "../output.js";
import { ensureCookieAcknowledgement, exitForItems, LEGAL_BASIS_HINT, parseBrowser, viewOf, withProject } from "./common.js";

const MODELS = ["large-v3", "medium", "small"];
const TYPES: ProfileContentType[] = ["posts", "reels", "videos", "shorts", "highlights"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(name: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!DAY.test(String(v))) throw new ExitError(`${name} must be a date written YYYY-MM-DD, for example 2026-03-14.`);
  return String(v);
}

function model(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!MODELS.includes(String(v))) throw new ExitError(`"${String(v)}" is not a transcription model.`, EXIT.failure, `Choose one of: ${MODELS.join(", ")}`);
  return String(v);
}

export function registerCapture(program: Command): void {
  program
    .command("capture")
    .description("Capture one or more YouTube, Instagram or TikTok links into a project")
    .argument("<url...>", "links to capture")
    .requiredOption("--project <name>", "the project to save into")
    .option("--cookies-from-browser <browser>", "use your signed-in browser session (chrome, firefox, safari, edge, brave)")
    .option("--acknowledge-cookies", "confirm, without being asked, the one-time notice about using your browser session")
    .option("--no-transcribe", "do not make a transcript")
    .option("--model <name>", "transcription model: large-v3, medium or small")
    .option("--refresh", "for a link already saved, add a new dated copy of the platform's data")
    .option("--legal-basis <text>", "the legal basis for saving this social-media data")
    .action(async (urls: string[], _o, cmd: Command) => {
      await withProject(cmd, true, async (s, project, out, o) => {
        const browser = parseBrowser(o.cookiesFromBrowser);
        const transcribeModel = model(o.model);
        await ensureCookieAcknowledgement(s, project, browser, o.acknowledgeCookies === true);
        const worker = await s.needWorker();
        const capture = createLinkCapture({ repo: s.repo, worker: worker.client, ...(s.index ? { index: s.index } : {}) });
        const outcomes = await capture.captureUrls(
          project.id,
          urls,
          {
            transcribe: o.transcribe !== false,
            ...(transcribeModel ? { transcribeModel } : {}),
            ...(browser ? { cookiesFromBrowser: browser } : {}),
            ...(o.refresh ? { refreshIfExists: true } : {}),
            ...(o.legalBasis ? { legalBasis: String(o.legalBasis) } : {}),
          },
          (done, total, outcome) => out.progress(`[${done}/${total}] ${outcome.status}`),
        );
        const items = [];
        for (const o2 of outcomes) items.push(await viewOf(s, project.id, o2));
        const code = exitForItems(outcomes);
        const needsBasis = outcomes.some((i) => i.errorCode === "LEGAL_BASIS_REQUIRED");
        if (out.json) {
          out.data({ project: project.name, items, ...(needsBasis ? { hint: LEGAL_BASIS_HINT } : {}) });
        } else {
          for (const v of items) for (const l of itemLines(v)) out.line(l);
          if (needsBasis) out.line(`\n${LEGAL_BASIS_HINT}`);
        }
        process.exitCode = code;
      });
    });

  program
    .command("capture-profile")
    .description("Capture a whole profile, channel or playlist (and later, only what is new)")
    .argument("<url>", "the profile link")
    .requiredOption("--project <name>", "the project to save into")
    .option("--since <date>", "only posts from this day on (YYYY-MM-DD)")
    .option("--until <date>", "only posts up to this day (YYYY-MM-DD)")
    .option("--max-items <n>", "stop after this many posts")
    .option("--types <list>", "which parts: posts, reels, videos, shorts, highlights (comma separated)")
    .option("--metadata-only", "save the posts' data without their media")
    .option("--comments", "also save comments (they are other people's personal data)")
    .option("--transcribe", "also make transcripts of videos")
    .option("--cookies-from-browser <browser>", "use your signed-in browser session")
    .option("--acknowledge-cookies", "confirm, without being asked, the one-time notice about using your browser session")
    .option("--legal-basis <text>", "the legal basis for saving this social-media data")
    .action(async (url: string, _o, cmd: Command) => {
      await withProject(cmd, true, async (s, project, out, o) => {
        const browser = parseBrowser(o.cookiesFromBrowser);
        const since = day("--since", o.since);
        const until = day("--until", o.until);
        let maxItems: number | undefined;
        if (o.maxItems !== undefined) {
          maxItems = Number(o.maxItems);
          if (!Number.isInteger(maxItems) || maxItems < 1) throw new ExitError("--max-items must be a whole number of 1 or more.");
        }
        let contentTypes: ProfileContentType[] | undefined;
        if (o.types !== undefined) {
          contentTypes = String(o.types).split(",").map((t) => t.trim()).filter(Boolean) as ProfileContentType[];
          const bad = contentTypes.find((t) => !TYPES.includes(t));
          if (bad || contentTypes.length === 0) throw new ExitError(`"${bad ?? ""}" is not a kind of content.`, EXIT.failure, `Choose from: ${TYPES.join(", ")}`);
        }
        await ensureCookieAcknowledgement(s, project, browser, o.acknowledgeCookies === true);
        const worker = await s.needWorker();
        const capture = createLinkCapture({ repo: s.repo, worker: worker.client, ...(s.index ? { index: s.index } : {}) });
        const tty = Boolean(process.stderr.isTTY);
        const report = await capture.captureProfile(
          project.id,
          url,
          {
            transcribe: o.transcribe === true,
            ...(browser ? { cookiesFromBrowser: browser } : {}),
            ...(o.legalBasis ? { legalBasis: String(o.legalBasis) } : {}),
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
            ...(maxItems ? { maxItems } : {}),
            ...(contentTypes ? { contentTypes } : {}),
            ...(o.metadataOnly ? { metadataOnly: true } : {}),
            ...(o.comments ? { includeComments: true } : {}),
          },
          (done, total) => process.stderr.write(tty ? `\rCaptured ${done} of ${total} posts   ` : `Captured ${done} of ${total} posts\n`),
        );
        if (tty) process.stderr.write("\n");
        const interesting = report.items.filter((i) => i.status === "failed" || i.status === "incomplete" || i.status === "needs-review");
        const views = [];
        for (const i of interesting) views.push(await viewOf(s, project.id, i));
        const needsBasis = report.errorCode === "LEGAL_BASIS_REQUIRED" || report.items.some((i) => i.errorCode === "LEGAL_BASIS_REQUIRED");
        if (out.json) {
          const { items: _items, ...summary } = report;
          out.data({ project: project.name, ...summary, items: await Promise.all(report.items.map((i) => viewOf(s, project.id, i))), ...(needsBasis ? { hint: LEGAL_BASIS_HINT } : {}) });
        } else {
          for (const l of profileLines(report)) out.line(l);
          if (views.length) out.line("\nNeeds a look:");
          for (const v of views) for (const l of itemLines(v)) out.line(l);
          if (needsBasis) out.line(`\n${LEGAL_BASIS_HINT}`);
        }
        let code: number = exitForItems(report.items);
        if (report.status === "failed") {
          if (report.errorCode === "LEGAL_BASIS_REQUIRED") code = EXIT.needsAction;
          else if (report.errorCode === "POLICY_DENIED") code = EXIT.denied;
          else if (code === EXIT.ok) code = EXIT.failure;
        }
        process.exitCode = code;
      });
    });
}
