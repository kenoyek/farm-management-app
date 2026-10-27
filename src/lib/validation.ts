import { z } from "zod";
export const id = z.uuid();
export const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase().trim()),
  password: z.string().min(12).max(128),
});
export const orgInput = z.object({ name: z.string().trim().min(2).max(100) });
export const farmInput = z.object({
  organizationId: id,
  name: z.string().trim().min(2).max(100),
  location: z.string().trim().max(200).default(""),
  kind: z.enum(["mixed", "layers", "broilers", "catfish", "feed_mill"]),
});
