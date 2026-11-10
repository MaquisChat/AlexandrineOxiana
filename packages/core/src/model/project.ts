import { z } from "zod";
import { Id, LibraryRelativePath, Timestamp } from "./text.js";

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  folder: LibraryRelativePath,
  createdAt: Timestamp,
  targetLanguages: z.array(z.string()),
  encryption: z.object({ enabled: z.boolean(), keyId: z.string().optional() }),
  /** One-time explanations the researcher has acknowledged (spec 5.1), e.g. using their browser session. */
  captureAcknowledgements: z
    .object({ cookies: z.object({ at: Timestamp, by: z.string() }).optional() })
    .optional(),
  /** Per-project automation (spec 5.2); everything is manual (off) by default. */
  automation: z.object({ transcribeNewMedia: z.boolean().optional() }).optional(),
});
export type Project = z.infer<typeof Project>;
