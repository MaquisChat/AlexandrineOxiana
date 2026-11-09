import { z } from "zod";
import { Id } from "./text.js";

const Point = z.object({ x: z.number(), y: z.number() });
const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** Anchors on translations link to the corresponding anchor in the original-language text. */
const base = { assetId: Id, originalAnchorId: Id.optional() };

export const Anchor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text-range"),
    ...base,
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    quote: z.string(),
    prefix: z.string().default(""),
    suffix: z.string().default(""),
    lang: z.string().optional(),
  }),
  z.object({ kind: z.literal("pdf"), ...base, page: z.number().int().min(1), rects: z.array(Rect) }),
  z.object({ kind: z.literal("epub-cfi"), ...base, cfi: z.string().min(1), quote: z.string().optional() }),
  z.object({
    kind: z.literal("time-range"),
    ...base,
    startMs: z.number().min(0),
    endMs: z.number().min(0),
  }),
  z.object({
    kind: z.literal("image-region"),
    ...base,
    shape: z.enum(["rect", "polygon"]),
    points: z.array(Point).min(2),
    page: z.number().int().min(1).optional(),
  }),
  z.object({ kind: z.literal("transcript-segment"), ...base, segmentIds: z.array(z.string()).min(1) }),
]);
export type Anchor = z.infer<typeof Anchor>;
