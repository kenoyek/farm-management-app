import { conflictAnalysis } from "./optimization-conflict";
import { z } from "zod";
import { nutrientKeys } from "./feed";
import { id } from "./validation";
import type { DraftContent } from "./draft-schema";

const finite = z.number().finite();
const source = z.object({
  source: z.enum(["scenario", "ingredient", "profile", "availability"]),
  percent: finite,
});
const processingGroup = z.object({
  name: z.string(),
  ingredientIds: z.array(z.string()),
  minPercent: finite,
  maxPercent: finite,
  requiredMethod: z.string().nullable(),
  source: z.string(),
  actualPercent: finite.nullable(),
  status: z.enum(["pass", "fail", "not-solved"]),
  attainableMin: finite.nullable().optional(),
  attainableMax: finite.nullable().optional(),
});
const viewSchema = z.object({
  status: z.enum([
    "optimal",
    "infeasible",
    "limit",
    "unbounded",
    "solver-error",
  ]),
  solver: z.string(),
  message: z.string(),
  costPerKg: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .nullable(),
  diagnosticModelVersion: z.number().optional(),
  conflict: conflictAnalysis.nullable().optional(),
  processingGroups: z.array(processingGroup).default([]),
  effectiveBounds: z
    .array(
      z.object({
        ingredientId: z.string(),
        name: z.string(),
        min: finite,
        max: finite,
        minimumSources: z.array(source),
        maximumSources: z.array(source),
      }),
    )
    .default([]),
  reachability: z
    .array(
      z.object({
        nutrient: z.enum(nutrientKeys),
        attainableMin: finite,
        attainableMax: finite,
        requiredMin: finite.optional(),
        requiredMax: finite.optional(),
      }),
    )
    .default([]),
  diagnostics: z
    .array(
      z.object({
        kind: z.enum([
          "ingredient-bounds",
          "minimum-total",
          "maximum-total",
          "nutrient-minimum",
          "nutrient-maximum",
          "combined-constraints",
        ]),
        message: z.string(),
        ingredientId: z.string().optional(),
        nutrient: z.enum(nutrientKeys).optional(),
      }),
    )
    .default([]),
  bindingConstraints: z.array(z.string()).default([]),
  validation: z
    .object({
      totalPercentError: finite,
      maximumBoundViolationPercent: finite,
      objectiveError: finite,
      objectiveTolerance: finite,
      nutrientTolerance: finite,
      boundTolerancePercent: finite,
    })
    .optional(),
});
export type OptimizationView = z.infer<typeof viewSchema>;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function outcomeView(value: unknown): OptimizationView | null {
  const raw = object(value),
    cost = object(raw.calculation).costPerKg;
  const parsed = viewSchema.safeParse({
    ...raw,
    costPerKg: typeof cost === "string" ? cost : null,
  });
  return parsed.success ? parsed.data : null;
}
const scenarioLine = z
  .object({
    ingredientId: id,
    percent: finite.min(0).max(100),
    min: finite.min(0).max(100).optional(),
    max: finite.min(0).max(100).optional(),
    availableKg: finite.nonnegative().optional(),
  })
  .refine((l) => (l.min ?? 0) <= (l.max ?? 100));
const scenario = z.object({
  name: z.string().min(2).max(100),
  batchKg: finite.positive().max(1e8),
  profileId: id,
  parentId: id.nullable().optional(),
  lines: z
    .array(scenarioLine)
    .min(1)
    .max(100)
    .refine(
      (lines) =>
        new Set(lines.map((l) => l.ingredientId)).size === lines.length,
    ),
});

export function historicalDraft(
  request: unknown,
  result: unknown,
): {
  content: DraftContent;
  allocationSource: "saved solution" | "original inputs";
} | null {
  const input = scenario.safeParse(request);
  if (!input.success) return null;
  const solved = z
    .array(z.object({ ingredientId: id, percent: finite.min(0).max(100) }))
    .safeParse(object(result).lines);
  const usable =
    object(result).status === "optimal" &&
    solved.success &&
    solved.data.length === input.data.lines.length &&
    new Set(solved.data.map((l) => l.ingredientId)).size ===
      solved.data.length &&
    solved.data.every((l) =>
      input.data.lines.some((i) => i.ingredientId === l.ingredientId),
    ) &&
    Math.abs(solved.data.reduce((s, l) => s + l.percent, 0) - 100) <= 1e-6;
  return {
    allocationSource: usable ? "saved solution" : "original inputs",
    content: {
      modelVersion: 1,
      name: input.data.name,
      batchKg: input.data.batchKg,
      profileId: input.data.profileId,
      parentId: input.data.parentId ?? null,
      lines: input.data.lines.map((l) => ({
        ...l,
        percent:
          usable && solved.success
            ? solved.data.find((s) => s.ingredientId === l.ingredientId)!
                .percent
            : l.percent,
      })),
    },
  };
}
export type OptimizationSummary = {
  id: string;
  createdAt: string;
  name: string;
  profileName: string | null;
  status: string;
  solver: string;
  costPerKg: string | null;
};
export function runSummary(raw: {
  id: string;
  created_at: string | Date;
  request: unknown;
  result: unknown;
}): OptimizationSummary {
  const input = object(raw.request),
    profile = object(input.profileSnapshot),
    view = outcomeView(raw.result);
  return {
    id: raw.id,
    createdAt: new Date(raw.created_at).toISOString(),
    name: typeof input.name === "string" ? input.name : "Legacy unnamed run",
    profileName: typeof profile.name === "string" ? profile.name : null,
    status: view?.status ?? "unknown",
    solver: view?.solver ?? "Not recorded",
    costPerKg: view?.status === "optimal" ? view.costPerKg : null,
  };
}
export function hasReferenceSnapshots(request: unknown) {
  const raw = object(request),
    parsed = scenario.safeParse(raw),
    profile = object(raw.profileSnapshot);
  return (
    parsed.success &&
    profile.id === parsed.data.profileId &&
    Array.isArray(raw.ingredientSnapshot) &&
    parsed.data.lines.every((l) =>
      (raw.ingredientSnapshot as unknown[]).some(
        (i) => object(i).id === l.ingredientId,
      ),
    )
  );
}
export type OptimizationDetail = {
  record: {
    id: string;
    organization_id: string;
    created_at: string;
    request: unknown;
    result: unknown;
  };
  summary: OptimizationSummary;
  view: OptimizationView | null;
  hasReferenceSnapshots: boolean;
  restoration: ReturnType<typeof historicalDraft>;
};
