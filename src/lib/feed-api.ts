import { workbookUploadApi } from "./workbook-upload-api";
import { draftApi } from "./draft-api";
import { workbookCatalog } from "./workbook-catalog";
import { catalogApi, stageCatalog } from "./catalog-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { jsonBody, fail } from "./http";
import {
  nutrientKeys,
  calculateFormula,
  compliance,
  type Ingredient,
} from "./feed";
import { optimize } from "./optimizer";
import reference from "../../data/ingredients.json";
import workbooks from "../../data/workbook-audit.json";
const nullable = z.number().finite().nonnegative().nullable();
const nutrients = z
  .object({
    energy: nullable,
    protein: nullable,
    dryMatter: nullable,
    calcium: nullable,
    phosphorus: nullable,
    methionine: nullable,
    lysine: nullable,
  })
  .refine(
    (v) =>
      nutrientKeys.every(
        (k) => k === "energy" || v[k] === null || v[k]! <= 100,
      ),
    "Concentrations cannot exceed 100%.",
  );
const line = z
  .object({
    ingredientId: id,
    percent: z.number().min(0).max(100),
    min: z.number().min(0).max(100).optional(),
    max: z.number().min(0).max(100).optional(),
    availableKg: z.number().nonnegative().max(1e12).optional(),
  })
  .refine((l) => (l.min ?? 0) <= (l.max ?? 100), "Minimum exceeds maximum.");
const formula = z.object({
  organizationId: id,
  name: z.string().trim().min(2).max(100),
  batchKg: z.number().positive().max(1e8),
  profileId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  lines: z.array(line).min(1).max(100),
  status: z
    .enum(["draft", "pending-review", "approved", "rejected"])
    .default("draft"),
});
const range = z
  .object({
    min: z.number().finite().nonnegative().optional(),
    max: z.number().finite().nonnegative().optional(),
  })
  .refine(
    (r) =>
      (r.min !== undefined || r.max !== undefined) &&
      (r.min ?? 0) <= (r.max ?? Infinity),
  );
const limits = z.object({
  energy: range.optional(),
  protein: range.optional(),
  dryMatter: range.optional(),
  calcium: range.optional(),
  phosphorus: range.optional(),
  methionine: range.optional(),
  lysine: range.optional(),
});
export async function feedApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  const uploadResponse = await workbookUploadApi(request, user, path);
  if (uploadResponse) return uploadResponse;
  const draftResponse = await draftApi(request, user, path);
  if (draftResponse) return draftResponse;
  const catalogResponse = await catalogApi(request, user, path);
  if (catalogResponse) return catalogResponse;
  const method = request.method;
  if (path === "team" && method === "GET") {
    const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(
      await tenant(
        user.id,
        async (c) =>
          (await c.query("SELECT * FROM team_members($1)", [org])).rows,
      ),
    );
  }
  if (path === "team/change" && method === "POST") {
    const input = z
      .object({
        organizationId: id,
        userId: id,
        role: z
          .enum([
            "admin",
            "manager",
            "nutritionist",
            "inventory",
            "accounts",
            "worker",
            "auditor",
          ])
          .nullable(),
      })
      .parse(await jsonBody(request));
    await tenant(user.id, (c) =>
      c.query("SELECT change_team_member($1,$2,$3)", [
        input.organizationId,
        input.userId,
        input.role,
      ]),
    );
    return NextResponse.json({ ok: true });
  }
  if (path === "team" && method === "POST") {
    const input = z
      .object({
        organizationId: id,
        email: z.email().transform((v) => v.toLowerCase()),
        role: z.enum([
          "admin",
          "manager",
          "nutritionist",
          "inventory",
          "accounts",
          "worker",
          "auditor",
        ]),
      })
      .parse(await jsonBody(request));
    await tenant(user.id, (c) =>
      c.query("SELECT add_team_member($1,$2,$3)", [
        input.organizationId,
        input.email,
        input.role,
      ]),
    );
    return NextResponse.json({ ok: true });
  }
  if (path === "feed" && method === "GET") {
    const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(
      await tenant(user.id, async (c) => ({
        ingredients: (
          await c.query(
            "SELECT * FROM ingredients WHERE organization_id=$1 ORDER BY name",
            [org],
          )
        ).rows,
        profiles: (
          await c.query(
            "SELECT * FROM requirement_profiles WHERE organization_id=$1 ORDER BY created_at DESC",
            [org],
          )
        ).rows,
        formulas: (
          await c.query(
            "SELECT id,name,batch_kg,status,result,lines,profile_id,created_at FROM formula_versions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
            [org],
          )
        ).rows,
        imports: (
          await c.query(
            "SELECT id,created_at FROM imports WHERE organization_id=$1",
            [org],
          )
        ).rows,
      })),
    );
  }
  if (path === "imports/preview" && method === "GET") {
    return NextResponse.json({
      workbooks: workbooks.map((w) => ({
        file: w.file,
        hash: w.sha256,
        sheets: w.sheets.map((s) => ({
          name: s.name,
          formulas: s.formula_count,
          rows: s.rows,
          columns: s.columns,
        })),
      })),
      ingredients: reference,
      catalog: workbookCatalog(),
      issues: [
        "All source data is unverified. Historical prices require a new quotation.",
        "Defatted soybean methionine is missing; dry matter formulas are omitted in the source recipes.",
        "Bloodmeal amino acids, rice phosphorus and two requirement methionine values require review.",
        "Recipe aliases do not all match nutrient rows; no recipes will be silently normalized.",
        "Forecasts use opening-stock estimates; egg source periods are all 28 days.",
      ],
    });
  }
  if (path === "imports/confirm" && method === "POST") {
    const input = z
      .object({ organizationId: id, confirmed: z.literal(true) })
      .parse(await jsonBody(request));
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          input.organizationId,
        ]);
        if (
          (
            await c.query("SELECT 1 FROM imports WHERE organization_id=$1", [
              input.organizationId,
            ])
          ).rowCount
        )
          fail(409, "The reference workbooks have already been imported.");
        const job = (
          await c.query(
            "INSERT INTO imports(organization_id,source_hashes,raw_data) VALUES($1,$2,$3) RETURNING id",
            [
              input.organizationId,
              JSON.stringify(
                workbooks.map((w) => ({ file: w.file, sha256: w.sha256 })),
              ),
              JSON.stringify(workbooks),
            ],
          )
        ).rows[0];
        for (const i of reference)
          await c.query(
            "INSERT INTO ingredients(organization_id,name,source,nutrients,price) VALUES($1,$2,$3,$4,$5)",
            [
              input.organizationId,
              i.name,
              i.source,
              JSON.stringify(i.nutrients),
              i.price,
            ],
          );
        await stageCatalog(c, input.organizationId, job.id);
        await audit(c, input.organizationId, "workbooks.imported", job.id);
        return { id: job.id, count: reference.length };
      }),
      { status: 201 },
    );
  }
  if (path === "ingredients" && method === "POST") {
    const input = z
      .object({
        organizationId: id,
        name: z.string().trim().min(2).max(100),
        source: z.string().trim().min(3).max(2000),
        nutrients,
        price: z.number().nonnegative().max(1e10).nullable(),
        basis: z.enum(["as-fed", "dry-matter"]).nullable(),
        energySystem: z.enum(["ME", "DE"]).nullable(),
        reviewStatus: z.enum(["unverified", "approved"]).default("unverified"),
        species: z.enum(["unknown", "poultry", "catfish"]).default("unknown"),
        stages: z.array(z.string().trim().min(2).max(100)).max(30).default([]),
        phosphorusBasis: z
          .enum(["unknown", "total", "available", "digestible"])
          .default("unknown"),
        quotedOn: z.iso.date().nullable().default(null),
        parentId: id.nullable().optional(),
        inclusionMin: z.number().min(0).max(100).default(0),
        inclusionMax: z.number().min(0).max(100).default(100),
      })
      .parse(await jsonBody(request));
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        const role = (
          await c.query("SELECT member_role($1) AS role", [
            input.organizationId,
          ])
        ).rows[0].role;
        if (input.reviewStatus === "approved" && role !== "nutritionist")
          fail(403, "A nutritionist must approve scientific reference data.");
        let revision = 1;
        if (input.parentId) {
          const previous = (
            await c.query(
              "SELECT revision FROM ingredients WHERE organization_id=$1 AND id=$2",
              [input.organizationId, input.parentId],
            )
          ).rows[0];
          if (!previous) fail(404, "Ingredient reference not found.");
          if (
            (
              await c.query("SELECT id FROM ingredients WHERE parent_id=$1", [
                input.parentId,
              ])
            ).rowCount
          )
            fail(
              409,
              "This reference has a newer revision. Refresh the ingredient list before revising.",
            );
          revision = previous.revision + 1;
        }
        const r = await c.query(
          "INSERT INTO ingredients(organization_id,name,source,nutrients,price,basis,energy_system,review_status,verified_at,reviewer_id,species,stages,phosphorus_basis,quoted_on,inclusion_min,inclusion_max,parent_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id",
          [
            input.organizationId,
            input.name,
            input.source,
            JSON.stringify(input.nutrients),
            input.price,
            input.basis,
            input.energySystem,
            input.reviewStatus,
            input.reviewStatus === "approved" ? new Date() : null,
            input.reviewStatus === "approved" ? user.id : null,
            input.species,
            input.stages,
            input.phosphorusBasis,
            input.quotedOn,
            input.inclusionMin,
            input.inclusionMax,
            input.parentId ?? null,
            revision,
          ],
        );
        await audit(
          c,
          input.organizationId,
          input.parentId ? "ingredient.revised" : "ingredient.created",
          r.rows[0].id,
        );
        return r.rows[0];
      }),
      { status: 201 },
    );
  }
  if (path === "profiles" && method === "POST") {
    const input = z
      .object({
        organizationId: id,
        name: z.string().trim().min(2).max(100),
        species: z.enum(["poultry", "catfish"]),
        stage: z.string().min(2).max(100),
        source: z.string().trim().min(10).max(2000),
        basis: z.enum(["as-fed", "dry-matter"]),
        energySystem: z.enum(["ME", "DE"]),
        phosphorusBasis: z.enum(["total", "available", "digestible"]),
        limits,
      })
      .parse(await jsonBody(request));
    // Six critical specs must be explicit; dry matter is optional, never inferred.
    for (const k of [
      "energy",
      "protein",
      "calcium",
      "phosphorus",
      "methionine",
      "lysine",
    ] as const)
      if (!input.limits[k]) fail(400, `Provide an explicit ${k} requirement.`);
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
        const r = await c.query(
          "INSERT INTO requirement_profiles(organization_id,name,species,stage,source,basis,energy_system,limits,reviewer_id,phosphorus_basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
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
          ],
        );
        await audit(c, input.organizationId, "profile.created", r.rows[0].id);
        return r.rows[0];
      }),
      { status: 201 },
    );
  }
  if (
    ["formulas/calculate", "formulas/save", "formulas/optimize"].includes(
      path,
    ) &&
    method === "POST"
  ) {
    const input = formula.parse(await jsonBody(request));
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        const ingredients = (
          await c.query("SELECT * FROM ingredients WHERE organization_id=$1", [
            input.organizationId,
          ])
        ).rows as Ingredient[];
        const profile = input.profileId
          ? (
              await c.query(
                "SELECT * FROM requirement_profiles WHERE organization_id=$1 AND id=$2",
                [input.organizationId, input.profileId],
              )
            ).rows[0]
          : null;
        if (input.profileId && !profile)
          fail(404, "Requirement profile not found.");
        if (profile) {
          if (profile.species === "catfish")
            fail(
              422,
              "Catfish formulation requires digestible nutrient definitions and species-specific constraints; this formulation engine currently supports poultry only.",
            );
          const selected = ingredients.filter((i) =>
            input.lines.some(
              (l) =>
                l.ingredientId === i.id &&
                (path === "formulas/optimize" || l.percent > 0),
            ),
          );
          if (
            selected.some(
              (i) =>
                i.basis !== profile.basis ||
                i.energy_system !== profile.energy_system ||
                i.species !== profile.species ||
                !i.stages?.includes(profile.stage) ||
                i.phosphorus_basis !== profile.phosphorus_basis,
            )
          )
            fail(
              400,
              "Ingredient species, stage or nutrient bases do not match the requirement profile.",
            );
          if (
            selected.some(
              (i) =>
                !i.quoted_on ||
                Date.parse(i.quoted_on) < Date.now() - 90 * 86400000 ||
                Date.parse(i.quoted_on) > Date.now(),
            )
          )
            fail(
              400,
              "Selected ingredients need a price quotation within the last 90 days.",
            );
        }
        if (path === "formulas/optimize") {
          if (!profile)
            fail(
              400,
              "Choose a nutritionist-reviewed requirement profile before optimizing.",
            );
          const result = await optimize(
            ingredients,
            input.lines,
            profile.limits,
            input.batchKg,
          ).catch((e) => fail(422, (e as Error).message));
          const r = await c.query(
            "INSERT INTO optimization_runs(organization_id,request,result) VALUES($1,$2,$3) RETURNING id",
            [
              input.organizationId,
              JSON.stringify(input),
              JSON.stringify(result),
            ],
          );
          await audit(
            c,
            input.organizationId,
            "formula.optimized",
            r.rows[0].id,
          );
          return result;
        }
        const calculation = calculateFormula(
          input.lines,
          ingredients,
          input.batchKg,
        );
        const checks = profile
          ? compliance(calculation.nutrients, profile.limits)
          : [];
        const result = {
          ...calculation,
          compliance: checks,
          profileName: profile?.name ?? null,
          modelVersion: 1,
          releaseEligible:
            calculation.releaseEligible &&
            !!profile &&
            checks.every((v) => v.status === "pass"),
        };
        if (path === "formulas/calculate") return result;
        if (
          input.status === "approved" &&
          (!result.releaseEligible ||
            (
              await c.query("SELECT member_role($1) AS role", [
                input.organizationId,
              ])
            ).rows[0].role !== "nutritionist")
        )
          fail(
            400,
            "Approval needs a nutritionist and complete compliant, reviewed reference data.",
          );
        const r = await c.query(
          "INSERT INTO formula_versions(organization_id,name,batch_kg,profile_id,parent_id,lines,ingredient_snapshot,result,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
          [
            input.organizationId,
            input.name,
            input.batchKg,
            input.profileId ?? null,
            input.parentId ?? null,
            JSON.stringify(input.lines),
            JSON.stringify(
              ingredients.filter((i) =>
                input.lines.some((l) => l.ingredientId === i.id),
              ),
            ),
            JSON.stringify(result),
            input.status,
          ],
        );
        await audit(
          c,
          input.organizationId,
          `formula.${input.status}`,
          r.rows[0].id,
        );
        return { id: r.rows[0].id, ...result };
      }),
    );
  }
  return null;
}
