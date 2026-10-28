import { z } from "zod";
import { nutrientLabels } from "./nutrients";
import type { Nutrient } from "./feed";
import type { EffectiveBound } from "./optimization-diagnostics";
const finite = z.number().finite();
export const workerConflict = z
  .object({
    version: z.literal(1),
    status: z.enum(["irreducible", "partial", "unavailable"]),
    termination: z.enum([
      "complete",
      "check-budget",
      "time-budget",
      "numerical-uncertainty",
    ]),
    members: z
      .array(
        z
          .object({
            kind: z.enum(["bound", "row"]),
            index: z.number().int().min(0).max(99),
            side: z.enum(["min", "max"]),
          })
          .strict(),
      )
      .max(262),
    checks: z.number().int().min(0).max(48),
    maxChecks: z.literal(48),
    candidateCount: z.number().int().min(0).max(262),
    tolerance: z.literal(1e-7),
  })
  .strict()
  .refine(
    (c) =>
      c.members.length <= c.candidateCount &&
      new Set(c.members.map((m) => `${m.kind}:${m.index}:${m.side}`)).size ===
        c.members.length &&
      (c.status === "irreducible"
        ? c.termination === "complete" &&
          c.members.length > 0 &&
          c.checks === c.candidateCount + 1
        : c.termination !== "complete") &&
      (c.status !== "unavailable" || c.members.length === 0) &&
      (c.status !== "partial" || c.members.length > 0),
  );
export const conflictConstraint = z.object({
  id: z.string(),
  kind: z.enum(["bound", "nutrient", "processing"]),
  label: z.string(),
  side: z.enum(["min", "max"]),
  value: finite,
  unit: z.enum(["%", "kcal/kg"]),
  ingredientId: z.string().optional(),
  ingredientIds: z.array(z.string()).optional(),
  origins: z
    .array(
      z.object({
        source: z.enum(["scenario", "ingredient", "profile", "availability"]),
        percent: finite,
      }),
    )
    .optional(),
  evidence: z.string().nullable().optional(),
});
export const conflictAnalysis = z.object({
  version: z.literal(1),
  status: z.enum(["irreducible", "partial", "unavailable"]),
  termination: z.enum([
    "complete",
    "check-budget",
    "time-budget",
    "numerical-uncertainty",
  ]),
  checks: z.number().int().min(0).max(48),
  maxChecks: z.literal(48),
  candidateCount: z.number().int().min(0).max(262),
  tolerance: z.literal(1e-7),
  constraints: z.array(conflictConstraint).max(262),
});
export type ConflictAnalysis = z.infer<typeof conflictAnalysis>;
export type ConflictRow =
  | { kind: "nutrient"; nutrient: Nutrient; min?: number; max?: number }
  | {
      kind: "processing";
      name: string;
      ingredientIds: string[];
      min: number;
      max: number;
      source: string;
    };
export function describeConflict(
  raw: z.infer<typeof workerConflict>,
  bounds: EffectiveBound[],
  rows: ConflictRow[],
): ConflictAnalysis {
  const constraints = raw.members.map((member) => {
    const id = `${member.kind}:${member.index}:${member.side}`;
    if (member.kind === "bound") {
      const bound = bounds[member.index];
      if (!bound) throw Error("Invalid conflict reference.");
      const value = bound[member.side];
      return {
        id,
        kind: "bound" as const,
        label: bound.name,
        ingredientId: bound.ingredientId,
        side: member.side,
        value,
        unit: "%" as const,
        origins: (member.side === "min"
          ? bound.minimumSources
          : bound.maximumSources
        ).filter((s) => s.percent === value),
      };
    }
    const row = rows[member.index];
    if (!row || row[member.side] === undefined)
      throw Error("Invalid conflict constraint.");
    return {
      id,
      kind: row.kind,
      label: row.kind === "nutrient" ? nutrientLabels[row.nutrient] : row.name,
      side: member.side,
      value: row[member.side]!,
      unit:
        row.kind === "nutrient" && row.nutrient === "energy"
          ? ("kcal/kg" as const)
          : ("%" as const),
      ...(row.kind === "processing"
        ? { ingredientIds: row.ingredientIds, evidence: row.source }
        : {}),
    };
  });
  const { members, ...rest } = raw;
  void members;
  return { ...rest, constraints };
}
