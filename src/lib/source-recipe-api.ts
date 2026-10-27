import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { fail, jsonBody } from "./http";
import { workbookCatalog } from "./workbook-catalog";
import {
  sourceRecipePlan,
  sourceRecipeCalculation,
  type SourceRecipeRow,
} from "./source-recipes";
import { nutrientDefinitions, nutrientRegistryVersion } from "./nutrients";
import type { Ingredient } from "./feed";

const options = z.object({
  organizationId: id,
  sheet: z.enum(["Broiler Starter", "Broiler Finisher"]),
  name: z.string().trim().min(2).max(100),
  batchKg: z
    .number()
    .finite()
    .min(0.000001)
    .max(1e8)
    .refine(
      (v) => new Decimal(v).decimalPlaces() <= 6,
      "Use at most six decimal places for batch weight.",
    ),
});
async function preview(c: PoolClient, input: z.infer<typeof options>) {
  const rows = (
    await c.query(
      "SELECT s.*,to_jsonb(r) AS alias_review FROM import_reference_rows s LEFT JOIN LATERAL (SELECT * FROM catalog_alias_reviews a WHERE a.organization_id=s.organization_id AND a.source_row_id=s.id ORDER BY revision DESC LIMIT 1) r ON true WHERE s.organization_id=$1 AND s.category='recipe' AND s.sheet=$2 ORDER BY s.source_row",
      [input.organizationId, input.sheet],
    )
  ).rows as SourceRecipeRow[];
  const canonical = workbookCatalog().filter(
    (r) => r.category === "recipe" && r.sheet === input.sheet,
  );
  if (rows.length !== 34)
    fail(
      409,
      "Stage the complete supplied workbook catalog before importing a source recipe.",
    );
  if (
    rows.some(
      (row, i) =>
        row.source_hash !== canonical[i].source_hash ||
        row.source_row !== canonical[i].source_row ||
        row.label !== canonical[i].label ||
        row.context !== canonical[i].context ||
        !isDeepStrictEqual(row.fields, canonical[i].fields) ||
        !isDeepStrictEqual(row.issues, canonical[i].issues),
    )
  )
    fail(
      409,
      "Source evidence does not match the supported original workbook.",
    );
  const ingredients = (
    await c.query(
      "SELECT * FROM ingredients WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
      [
        input.organizationId,
        rows.flatMap((r) =>
          r.alias_review?.ingredient_id ? [r.alias_review.ingredient_id] : [],
        ),
      ],
    )
  ).rows as Ingredient[];
  const plan = sourceRecipePlan(rows, ingredients);
  const calculation = sourceRecipeCalculation(plan, ingredients, input.batchKg);
  const selected = ingredients.filter((i) =>
    plan.lines.some((l) => l.ingredientId === i.id),
  );
  const previewDigest = createHash("sha256")
    .update(
      JSON.stringify({ modelVersion: 1, input, rows, ingredients: selected }),
    )
    .digest("hex");
  return {
    ...input,
    sourceHash: canonical[0].source_hash,
    rows,
    ...plan,
    calculation,
    previewDigest,
  };
}
export type SourceRecipePreview = Awaited<ReturnType<typeof preview>>;
export async function sourceRecipeApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (
    !["imports/recipes/preview", "imports/recipes/confirm"].includes(path) ||
    request.method !== "POST"
  )
    return null;
  const confirm = path.endsWith("/confirm");
  const input = (
    confirm
      ? options
          .extend({
            previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
            confirmed: z.literal(true),
            omitUnspecified: z.literal(true),
          })
          .strict()
      : options.strict()
  ).parse(await jsonBody(request));
  return NextResponse.json(
    await tenant(user.id, async (c) => {
      const role = (
        await c.query("SELECT member_role($1) AS role", [input.organizationId])
      ).rows[0].role;
      if (!role) fail(404, "Organization not found.");
      if (!confirm) return preview(c, input);
      if (!["owner", "admin", "nutritionist"].includes(role))
        fail(403, "Only feed editors can import a draft recipe.");
      const confirmed = input as z.infer<typeof options> & {
        previewDigest: string;
      };
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `source-recipe:${input.organizationId}:${confirmed.previewDigest}`,
      ]);
      const previous = (
        await c.query(
          "SELECT id,name,batch_kg,source_recipe FROM formula_versions WHERE organization_id=$1 AND source_recipe->>'previewDigest'=$2",
          [input.organizationId, confirmed.previewDigest],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.name !== input.name ||
          Number(previous.batch_kg) !== input.batchKg ||
          previous.source_recipe.sheet !== input.sheet
        )
          fail(409, "The confirmation refers to different import options.");
        return { id: previous.id, reused: true };
      }
      const sourceIds = (
        await c.query(
          "SELECT id FROM import_reference_rows WHERE organization_id=$1 AND category='recipe' AND sheet=$2 ORDER BY id",
          [input.organizationId, input.sheet],
        )
      ).rows;
      for (const row of sourceIds)
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `catalog-alias:${row.id}`,
        ]);
      const current = await preview(c, {
        organizationId: input.organizationId,
        sheet: input.sheet,
        name: input.name,
        batchKg: input.batchKg,
      });
      if (current.previewDigest !== confirmed.previewDigest)
        fail(
          409,
          "Source reviews changed after preview. Refresh the preview before confirming.",
        );
      if (current.blockers.length || !current.calculation)
        fail(409, "Resolve the source recipe blockers before confirming.");
      const ingredients = (
        await c.query(
          "SELECT * FROM ingredients WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
          [input.organizationId, current.lines.map((l) => l.ingredientId)],
        )
      ).rows;
      const sourceRecipe = {
        modelVersion: 1,
        previewDigest: current.previewDigest,
        sourceHash: current.sourceHash,
        sheet: input.sheet,
        omittedUnspecifiedConfirmed: true,
        rows: current.rows,
      };
      const result = {
        ...current.calculation,
        compliance: [],
        profileSnapshot: null,
        profileName: null,
        savedBy: user.id,
        modelVersion: 3,
        nutrientRegistryVersion,
        nutrientDefinitions,
      };
      const saved = (
        await c.query(
          "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result,status,source_recipe) VALUES($1,$2,$3,$4,$5,$6,'draft',$7) RETURNING id",
          [
            input.organizationId,
            input.name,
            input.batchKg,
            JSON.stringify(current.lines),
            JSON.stringify(ingredients),
            JSON.stringify(result),
            JSON.stringify(sourceRecipe),
          ],
        )
      ).rows[0];
      await audit(c, input.organizationId, "source_recipe.imported", saved.id);
      return { id: saved.id, reused: false };
    }),
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
