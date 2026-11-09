import { z } from "zod";
import { Anchor } from "./anchor.js";
import { Id, Timestamp } from "./text.js";

export const Annotation = z.object({
  id: Id,
  sourceId: Id,
  kind: z.enum(["highlight", "note", "coded-segment", "clip", "screenshot"]),
  anchors: z.array(Anchor),
  body: z.string().optional(),
  codeId: Id.optional(),
  codebookVersion: z.number().int().optional(),
  author: z.string(),
  createdAt: Timestamp,
});
export type Annotation = z.infer<typeof Annotation>;
