import { z } from "zod";
import { Id } from "./text.js";

export const Collection = z.object({
  id: Id,
  projectId: Id,
  parentId: Id.optional(),
  name: z.string().min(1),
});
export type Collection = z.infer<typeof Collection>;

export const Tag = z.object({
  id: Id,
  /** 'workspace' or a projectId. */
  scope: z.union([z.literal("workspace"), Id]),
  name: z.string().min(1),
  color: z.string().optional(),
});
export type Tag = z.infer<typeof Tag>;
