import { z } from "zod";
import { Id } from "./text.js";

const Point = z.object({ x: z.number(), y: z.number() });
const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** Anchors on translations link to the corresponding anchor in the original-language text. */
const base = { id: Id, assetId: Id, originalAnchorId: Id.optional() };

const AnchorShape = z.discriminatedUnion("kind", [
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
  z.object({
    kind: z.literal("pdf"),
    ...base,
    page: z.number().int().min(1),
    /**
     * Rectangles in PDF user space, in points: origin at the bottom-left of the page, y up, in the
     * page's unrotated orientation (its /Rotate is not applied), as Zotero stores them (x, y the
     * bottom-left corner; w, h the size).
     */
    rects: z.array(Rect).min(1),
    /** Zotero's sort index "PPPPP|OOOOOO|TTTTT" (page from 0, character offset, distance from page top); absent on annotations made here. */
    sortIndex: z.string().regex(/^\d{5}\|\d{6}\|\d{5}$/).optional(),
  }),
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
    // rect: exactly 2 points (opposite corners); polygon: >= 3 points (checked below).
    points: z.array(Point),
    page: z.number().int().min(1).optional(),
  }),
  z.object({ kind: z.literal("transcript-segment"), ...base, segmentIds: z.array(z.string()).min(1) }),
]);
export const Anchor = AnchorShape.superRefine((a, ctx) => {
  const bad = (message: string, path: string[]) => ctx.addIssue({ code: "custom", message, path });
  if (a.kind === "text-range" && a.start > a.end) bad("start must be <= end", ["end"]);
  if (a.kind === "time-range" && a.endMs < a.startMs) bad("endMs must be >= startMs", ["endMs"]);
  if (a.kind === "image-region") {
    if (a.shape === "rect" && a.points.length !== 2) bad("rect needs exactly 2 points", ["points"]);
    if (a.shape === "polygon" && a.points.length < 3) bad("polygon needs >= 3 points", ["points"]);
  }
});
export type Anchor = z.infer<typeof Anchor>;
export type PdfAnchor = Extract<Anchor, { kind: "pdf" }>;
