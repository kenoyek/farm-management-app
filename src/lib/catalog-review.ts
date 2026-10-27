import { z } from "zod";
import { id } from "./validation";

export const aliasReviewInput = z
  .object({
    organizationId: id,
    expectedRevision: z.number().int().min(0).max(2147483646),
    decision: z.enum(["mapped", "rejected", "unresolved"]),
    ingredientId: id.nullable(),
    evidence: z.string().trim().min(10).max(2000),
    confirmed: z.literal(true),
  })
  .strict()
  .refine(
    (v) => (v.decision === "mapped") === (v.ingredientId !== null),
    "Select an exact ingredient only for a mapped decision.",
  );

export type AliasReview = {
  id: string;
  source_row_id: string;
  ingredient_id: string | null;
  decision: "mapped" | "rejected" | "unresolved";
  evidence: string;
  reviewer_id: string;
  revision: number;
  parent_id: string | null;
  created_at: string;
};
