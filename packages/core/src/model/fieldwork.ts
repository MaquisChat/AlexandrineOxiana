import { z } from "zod";
import { Id, Timestamp } from "./text.js";

export const Participant = z.object({
  id: Id,
  projectId: Id,
  code: z.string().min(1), // e.g. 'P-014'
  details: z.record(z.string(), z.string()).optional(), // identifying, governed
  consentIds: z.array(Id),
});
export type Participant = z.infer<typeof Participant>;

export const Session = z.object({
  id: Id,
  projectId: Id,
  date: z.string().min(1),
  place: z.string().optional(),
  participantIds: z.array(Id),
  notes: z.string().optional(),
});
export type Session = z.infer<typeof Session>;

export const ConsentRecord = z.object({
  id: Id,
  projectId: Id,
  participantId: Id,
  documentAssetId: Id.optional(),
  scope: z.string(),
  date: z.string().min(1),
  expires: z.string().optional(),
  withdrawn: z.object({ at: Timestamp }).optional(),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;
