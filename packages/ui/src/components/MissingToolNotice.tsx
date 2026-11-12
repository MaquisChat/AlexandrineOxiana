/**
 * A missing optional tool, said where it is met (Task 48b; R126). The service answers a job whose
 * tool is not installed with `409 { error: { code: "TOOL_NOT_INSTALLED", reason: <tool id> } }`; a
 * capture outcome carries `errorCode: "TOOL_NOT_INSTALLED"` with the library's own sentence naming the
 * tool in `reason` (and `tool`, which the UI's queue state does not keep yet); a source's viewing copy
 * or OCR job that waits for its tool is recorded failed with that code. Each becomes one plain
 * sentence naming the tool and a link to the Optional tools screen (only the link where the service's
 * sentence is already shown). Anything else shows the children (the screen's usual message), so a
 * hook-up is one line.
 *
 * The tool's name comes from this file's fixed words, never from the error (the raw id is not shown).
 */
import { isToolId, type ToolId } from "@ao/shared";
import { useEffect, useState, type ReactNode } from "react";
import { ApiClientError } from "../api/client";
import { speechSize, speechTool, type ToolsApi } from "../api/tools";
import { inAppLink, PATHS } from "../navigation";
import "./MissingToolNotice.css";

export const TOOL_NOT_INSTALLED = "TOOL_NOT_INSTALLED";

/** Each tool in plain words, and what cannot be done until it is installed. */
const TOOL_SENTENCE: Record<ToolId, string> = {
  "speech-tiny": "The speech model “tiny” is not installed on this computer, so nothing was transcribed with it.",
  "speech-small": "The speech model “small” is not installed on this computer, so nothing was transcribed with it.",
  "speech-medium": "The speech model “medium” is not installed on this computer, so nothing was transcribed with it.",
  "speech-large-v3": "The speech model “large-v3” is not installed on this computer, so nothing was transcribed with it.",
  "video-downloader": "The video downloader is not installed on this computer, so videos cannot be saved from the web.",
  "image-downloader": "The image downloader is not installed on this computer, so photo posts cannot be saved from the web.",
  ffmpeg:
    "The video tools (ffmpeg) are not installed on this computer. Until they are, videos get no viewing copies, and media that carries a location stays “proxy pending” and is left out of exports.",
  ocr: "Text recognition (OCR) is not installed on this computer, so scanned pages are not read.",
};

const UNNAMED = "A tool this needs is not installed on this computer.";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether `from` says an optional tool is missing, and which (when it says). Reads an ApiClientError
 * (`reason` = the tool id), a capture outcome or queue (`errorCode`, and `tool` once the service
 * sends one) or an error body (`code`, `reason`). Undefined for anything else.
 */
export function missingToolOf(from: unknown): { tool?: ToolId } | undefined {
  let code: unknown;
  let tool: unknown;
  if (from instanceof ApiClientError) {
    code = from.code;
    tool = from.reason;
  } else if (isObj(from)) {
    code = from.errorCode ?? from.code;
    tool = from.tool ?? from.reason;
  }
  if (code !== TOOL_NOT_INSTALLED) return undefined;
  return typeof tool === "string" && isToolId(tool) ? { tool } : {};
}

/** The tools screen's address, naming the tool to bring into view. */
export const toolsHref = (tool?: ToolId): string => (tool ? `${PATHS.tools}?tool=${encodeURIComponent(tool)}` : PATHS.tools);

/** The link to the tools screen. */
export function ToolsLink({ tool, children = "Install it from the Optional tools screen" }: { tool?: ToolId | undefined; children?: ReactNode }) {
  const href = toolsHref(tool);
  return (
    <a href={href} onClick={inAppLink}>
      {children}
    </a>
  );
}

/**
 * The sentence and the link when `from` is a missing tool; otherwise `children` (or nothing).
 * Inline (a span) so it fits inside a screen's existing message; `as="p"` for a paragraph of its own.
 */
export function MissingToolNotice({ from, children, as = "span" }: { from: unknown; children?: ReactNode; as?: "span" | "p" }) {
  const m = missingToolOf(from);
  if (!m) return <>{children ?? null}</>;
  const Tag = as;
  // A capture outcome or run carries the library's own sentence naming the tool (shown by the screen):
  // then only the link is added, so the same thing is not said twice.
  if (saidByService(from)) {
    return (
      <Tag className="ao-tool-missing">
        <ToolsLink tool={m.tool}>Open the Optional tools screen</ToolsLink>
      </Tag>
    );
  }
  return (
    <Tag className="ao-tool-missing">
      {m.tool ? TOOL_SENTENCE[m.tool] : UNNAMED} <ToolsLink tool={m.tool} />.
    </Tag>
  );
}

/**
 * An outcome (not a service error): the capture screen always shows a sentence for its code (the
 * library's `reason`, or the interface's own words when there is none), so only the link is added
 * (N4). Also a run whose `reason` or `stopReason` is a sentence, not a tool id.
 */
function saidByService(from: unknown): boolean {
  if (from instanceof ApiClientError || !isObj(from)) return false;
  if (typeof from.errorCode === "string") return true;
  const said = (v: unknown) => typeof v === "string" && v.trim() !== "" && !isToolId(v.trim());
  return said(from.reason) || said(from.stopReason);
}

interface WaitingJob {
  type?: unknown;
  failed?: { code?: unknown } | undefined;
}

const waitingFor = (list: unknown): WaitingJob[] => (Array.isArray(list) ? list.filter((j): j is WaitingJob => isObj(j) && isObj(j.failed) && j.failed.code === TOOL_NOT_INSTALLED) : []);

/**
 * A source whose viewing copy or OCR waits for a tool (its job recorded failed with
 * TOOL_NOT_INSTALLED): what that means for the source, and the link. Nothing otherwise.
 */
export function SourceToolNotice({ file }: { file: unknown }) {
  if (!isObj(file)) return null;
  const video = waitingFor(file.pendingProxies).some((j) => j.type === "video.proxy");
  const ocr = waitingFor(file.pendingOcr).length > 0;
  if (!video && !ocr) return null;
  return (
    <>
      {video && (
        <p className="ao-tool-missing" role="note">
          This source&apos;s viewing copy, with its location coarsened or removed, has not been made: the video tools (ffmpeg) are not installed. Until it is, the media stays “proxy pending”
          and is left out of exports. <ToolsLink tool="ffmpeg">Install ffmpeg from the Optional tools screen</ToolsLink>.
        </p>
      )}
      {ocr && (
        <p className="ao-tool-missing" role="note">
          This source&apos;s scanned pages have not been read: text recognition (OCR) is not installed on this computer. <ToolsLink tool="ocr">See the Optional tools screen</ToolsLink>.
        </p>
      )}
    </>
  );
}

/**
 * Which speech models are installed (by model name), from the catalogue; undefined while it is not
 * known (no tools api, the catalogue cannot be read, or it has not answered yet). Read once.
 */
export function useSpeechModels(api: ToolsApi | undefined): Partial<Record<string, boolean>> | undefined {
  const [installed, setInstalled] = useState<Partial<Record<string, boolean>> | undefined>();
  useEffect(() => {
    if (!api) return;
    let live = true;
    const ac = new AbortController();
    api.catalogue(ac.signal).then(
      (r) => {
        if (!live || !Array.isArray(r.tools)) return;
        const out: Partial<Record<string, boolean>> = {};
        for (const t of r.tools) {
          const size = speechSize(t.id);
          if (size) out[size] = t.installed && t.usable;
        }
        setInstalled(out);
      },
      () => {
        // Not known (a plain browser, or the media helper is not running): models are offered as they are.
      },
    );
    return () => {
      live = false;
      ac.abort();
    };
  }, [api]);
  return installed;
}

/** An option's words: "(not installed)" added when the catalogue says so. */
export const modelOptionLabel = (label: string, model: string, installed: Partial<Record<string, boolean>> | undefined): string =>
  installed?.[model] === false ? `${label} (not installed)` : label;

/** A chosen speech model that is not installed: said before anything is started, with the link. */
export function SpeechModelNotice({ model, installed }: { model: string; installed: Partial<Record<string, boolean>> | undefined }) {
  if (installed?.[model] !== false) return null;
  return (
    <p className="ao-tool-missing">
      The speech model “{model}” is not installed on this computer. <ToolsLink tool={speechTool(model)} />.
    </p>
  );
}
