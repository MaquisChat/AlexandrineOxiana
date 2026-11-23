/**
 * Storing a finished machine transcription (link-capture.ts `runTranscription`, and the
 * transcription job of Task 62): the worker's `transcript.vtt` and `segments.json` become derived
 * assets of kind `transcript` of the source, derived from its recording, both in ONE governed,
 * audited, crash-safe change (R26; FR-393, R464 c): never one without the other.
 */
import { basename } from "node:path";
import type { Asset } from "@ao/core";
import type { DerivedAssetInput } from "./repo/assets.js";
import type { Repo } from "./repo/repo.js";
import type { JobResult } from "./worker-client.js";

export interface StoredTranscript {
  /** Library-relative paths of the stored files. */
  files: string[];
  flaggedSegments: number;
}

export interface TranscriptionParams {
  model?: string | undefined;
  language?: string | undefined;
}

/** Stores a finished transcription's files as derived assets of the source, derived from `media`. */
export async function storeTranscript(
  repo: Repo,
  projectId: string,
  sourceId: string,
  media: Asset,
  r: JobResult,
  params: TranscriptionParams,
  triggeredBy: string,
): Promise<StoredTranscript> {
  const meta = r.meta;
  const model = typeof meta.model === "string" ? meta.model : (params.model ?? "whisper");
  const langs = Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages.filter((l): l is string => typeof l === "string") : [];
  const lang = langs.length === 1 ? langs[0]! : langs.length > 1 ? "mul" : "und";
  const flagged = typeof meta.flaggedCount === "number" ? meta.flaggedCount : undefined;
  const at = new Date().toISOString();
  const inputs: DerivedAssetInput[] = [];
  for (const ext of ["vtt", "json"]) {
    const file = r.files.find((f) => basename(f) === (ext === "vtt" ? "transcript.vtt" : "segments.json"));
    if (!file) continue;
    inputs.push({
      fromPath: file,
      kind: "transcript",
      lang,
      tool: `whisper-${model}`,
      ext,
      ...(r.encrypted ? { fromEncrypted: true } : {}),
      ...(flagged !== undefined ? { metadata: { flaggedSegments: flagged } } : {}),
      derivation: {
        parents: [media.id],
        operation: "transcribe",
        provider: "faster-whisper",
        model,
        ranAt: "local",
        params: { model, detectedLanguages: langs, ...(params.language ? { language: params.language } : {}) },
        at,
        triggeredBy,
      },
    });
  }
  // Both files in one governed change (FR-393, R464 c): a lock or a crash leaves both or neither.
  const files = (await repo.addDerivedAssets(projectId, sourceId, inputs)).map((a) => a.path);
  return { files, flaggedSegments: flagged ?? 0 };
}
