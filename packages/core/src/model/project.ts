import { z } from "zod";
import { Id, LibraryRelativePath, Timestamp } from "./text.js";

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  folder: LibraryRelativePath,
  createdAt: Timestamp,
  targetLanguages: z.array(z.string()),
  encryption: z.object({ enabled: z.boolean(), keyId: z.string().optional() }),
});
export type Project = z.infer<typeof Project>;
