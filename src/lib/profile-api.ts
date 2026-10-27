import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { jsonBody, fail } from "./http";
import { coreNutrientKeys, type Ingredient } from "./feed";

const range = z
  .object({
    min: z.number().finite().nonnegative().optional(),
    max: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine(
    (r) =>
      (r.min !== undefined || r.max !== undefined) &&
      (r.min ?? 0) <= (r.max ?? Infinity),
    "Provide ordered explicit nutrient limits.",
  );
const limits = z
  .object({
    energy: range.optional(),
    protein: range.optional(),
    dryMatter: range.optional(),
    calcium: range.optional(),
    phosphorus: range.optional(),
    methionine: range.optional(),
    lysine: range.optional(),
    crudeFat: range.optional(),
    crudeFibre: range.optional(),
    moisture: range.optional(),
    ash: range.optional(),
  })
  .strict()
  .refine(
    (v) =>
      Object.entries(v).every(
        ([key, r]) =>
          key === "energy" ||
          !r ||
          ((r.min ?? 0) <= 100 && (r.max ?? 0) <= 100),
      ),
    "Percentage requirements cannot exceed 100%.",
  );
const rule = z
  .object({
    ingredientId: id,
    min: z.number().finite().min(0).max(100),
    max: z.number().finite().min(0).max(100),
    source: z.string().trim().min(10).max(2000),
  })
  .strict()
  .refine((r) => r.min <= r.max, "Minimum exceeds maximum.");
export const profileInput = z
  .object({
    organizationId: id,
    parentId: id.nullable().optional(),
    name: z.string().trim().min(2).max(100),
    species: z.enum(["poultry", "catfish"]),
    stage: z.string().trim().min(2).max(100),
    source: z.string().trim().min(10).max(2000),
    basis: z.enum(["as-fed", "dry-matter"]),
    energySystem: z.enum(["ME", "DE"]),
    phosphorusBasis: z.enum(["total", "available", "digestible"]),
    limits,
    ingredientRules: z.array(rule).max(100).default([]),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.ingredientRules.map((r) => r.ingredientId)).size ===
      v.ingredientRules.length,
    "Each ingredient reference can appear only once.",
  );

export async function profileApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "profiles" || request.method !== "POST") return null;
  const input = profileInput.parse(await jsonBody(request));
  for (const k of coreNutrientKeys.filter((k) => k !== "dryMatter"))
    if (!input.limits[k]) fail(400, `Provide an explicit ${k} requirement.`);
  if (input.basis !== "as-fed" && input.limits.moisture)
    fail(400, "Moisture requirements use an as-fed basis.");
  return NextResponse.json(
    await tenant(user.id, async (c) => {
      if (
        (
          await c.query("SELECT member_role($1) AS role", [
            input.organizationId,
          ])
        ).rows[0].role !== "nutritionist"
      )
        fail(
          403,
          "Only a nutritionist can register a reviewed requirement profile.",
        );
      let revision = 1;
      if (input.parentId) {
        // Lock the old version to serialize competing revisions; it stays immutable.
        // FOR UPDATE requires UPDATE privileges, so use a transaction advisory lock.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          input.parentId,
        ]);
        const previous = (
          await c.query(
            "SELECT revision FROM requirement_profiles WHERE organization_id=$1 AND id=$2",
            [input.organizationId, input.parentId],
          )
        ).rows[0];
        if (!previous) fail(404, "Requirement profile not found.");
        if (
          (
            await c.query(
              "SELECT id FROM requirement_profiles WHERE parent_id=$1",
              [input.parentId],
            )
          ).rowCount
        )
          fail(
            409,
            "This profile has a newer revision. Refresh specifications before revising.",
          );
        revision = previous.revision + 1;
      }
      const ingredients = (
        await c.query(
          "SELECT * FROM ingredients WHERE organization_id=$1 AND id=ANY($2::uuid[])",
          [
            input.organizationId,
            input.ingredientRules.map((r) => r.ingredientId),
          ],
        )
      ).rows as Ingredient[];
      let minTotal = 0,
        maxTotal = 0;
      for (const r of input.ingredientRules) {
        const i = ingredients.find((i) => i.id === r.ingredientId);
        if (!i)
          fail(404, "Ingredient reference not found in this organization.");
        if (
          i.review_status !== "approved" ||
          i.species !== input.species ||
          !i.stages?.includes(input.stage) ||
          i.basis !== input.basis ||
          i.energy_system !== input.energySystem ||
          i.phosphorus_basis !== input.phosphorusBasis
        )
          fail(
            422,
            `${i.name}: select an approved reference matching this profile's stage and nutrient bases.`,
          );
        const min = Math.max(r.min, Number(i.inclusion_min ?? 0));
        const max = Math.min(r.max, Number(i.inclusion_max ?? 100));
        if (min > max)
          fail(
            422,
            `${i.name}: profile bounds conflict with the reviewed ingredient bounds.`,
          );
        minTotal += min;
        maxTotal += max;
      }
      if (
        input.ingredientRules.length &&
        (minTotal > 100 + 1e-7 || maxTotal < 100 - 1e-7)
      )
        fail(
          422,
          "The allowed ingredient bounds cannot total 100%. Check minima, maxima and excluded references.",
        );
      const row = (
        await c.query(
          "INSERT INTO requirement_profiles(organization_id,name,species,stage,source,basis,energy_system,limits,reviewer_id,phosphorus_basis,parent_id,revision,ingredient_rules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
          [
            input.organizationId,
            input.name,
            input.species,
            input.stage,
            input.source,
            input.basis,
            input.energySystem,
            JSON.stringify(input.limits),
            user.id,
            input.phosphorusBasis,
            input.parentId ?? null,
            revision,
            JSON.stringify(input.ingredientRules),
          ],
        )
      ).rows[0];
      await audit(
        c,
        input.organizationId,
        input.parentId ? "profile.revised" : "profile.created",
        row.id,
      );
      return row;
    }),
    { status: 201 },
  );
}
