import { z } from "zod";
// Incomplete editing states are valid drafts, but cannot be approved or released.
export const draftContent = z
  .object({
    modelVersion: z.literal(1),
    name: z.string().max(100),
    batchKg: z.number().finite(),
    profileId: z.uuid().nullable(),
    parentId: z.uuid().nullable(),
    lines: z
      .array(
        z
          .object({
            ingredientId: z.union([z.uuid(), z.literal("")]),
            percent: z.number().finite(),
            min: z.number().finite().optional(),
            max: z.number().finite().optional(),
            availableKg: z.number().finite().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type DraftContent = z.infer<typeof draftContent>;
export type SavedDraft = {
  id: string;
  content: DraftContent;
  revision: number;
  updated_at: string;
};
export type DraftResponse = { actorId: string; draft: SavedDraft | null };
