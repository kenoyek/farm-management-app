import type { EconomicsData } from "../src/lib/broiler-economics";
import { budgetCategories } from "../src/lib/broiler-economics";
import type { PlanRow } from "../src/lib/broiler-planning";
import { planFixture } from "./broiler-planning-fixture";
export const economicsFixture = (): EconomicsData => ({
  name: "Synthetic complete budget",
  saleBasis: "processedKg",
  salePrice: "20",
  yieldFraction: "0.75",
  priceEvidence: "Synthetic quoted processed price",
  yieldEvidence:
    "Synthetic product specification; saleable dressed kg / live kg",
  allocationEvidence:
    "Synthetic full batch to sale; all shared costs explicitly allocated; no omitted costs in this test budget",
  completeBudget: true,
  costs: budgetCategories.map((category, i) => ({
    category,
    amount: i === 0 ? "10" : "0",
    evidence: "Synthetic allocated batch total, explicit zero if not incurred",
  })),
  notes: "Synthetic planning assumptions only",
});
export const economicsPlan = (): PlanRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  unit_id: "00000000-0000-4000-8000-000000000003",
  previous_id: null,
  revision: 1,
  model_version: "broiler-daily-linear-targets-v1",
  input: planFixture(),
  unit_snapshot: {
    id: "00000000-0000-4000-8000-000000000003",
    organization_id: "00000000-0000-4000-8000-000000000002",
    farm_id: "00000000-0000-4000-8000-000000000004",
    name: "Synthetic batch",
    kind: "broilers",
    stocked_on: "2024-02-01",
    opening_count: 100,
    initial_weight_g: "1000",
  },
  recipe_snapshots: [],
  timezone: "Africa/Lagos",
  created_by: "00000000-0000-4000-8000-000000000005",
  created_at: "2024-02-01T00:00:00Z",
});
