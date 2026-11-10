import { z } from "zod";
import { Anchor } from "./anchor.js";
import { Id, Timestamp } from "./text.js";

export const Annotation = z.object({
  id: Id,
  sourceId: Id,
  /**
   * highlight, underline, note, image (a selected area, e.g. a figure) and ink (free drawing) are the
   * reader's kinds (Zotero's among them, R72); coded-segment, clip and screenshot are the project's own.
   */
  kind: z.enum(["highlight", "underline", "note", "image", "ink", "coded-segment", "clip", "screenshot"]),
  anchors: z.array(Anchor),
  body: z.string().optional(),
  /** The text the annotation marks (a highlight's selected text). */
  quote: z.string().optional(),
  /** Display colour, e.g. "#ffd400". */
  color: z.string().max(32).optional(),
  /** The page's printed label, when it differs from its number (e.g. "iv"). */
  pageLabel: z.string().max(64).optional(),
  /** Where it was imported from (e.g. "zotero:ABCD2345"): an import never adds it twice. */
  externalKey: z.string().max(256).optional(),
  /**
   * Hash of the content as last imported (kind, body, quote, colour, page label, anchors): a
   * re-import updates the annotation only while its content still has this hash, i.e. nobody
   * edited it here (R75); undo keeps one edited since (R74 M3).
   */
  externalHash: z.string().max(128).optional(),
  codeId: Id.optional(),
  codebookVersion: z.number().int().optional(),
  author: z.string(),
  createdAt: Timestamp,
});
export type Annotation = z.infer<typeof Annotation>;
