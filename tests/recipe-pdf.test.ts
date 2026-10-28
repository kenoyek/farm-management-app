import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFHexString } from "pdf-lib";
import { recipeReport } from "../src/lib/recipe-reports";
import { recipePdf, pdfLiteral } from "../src/lib/recipe-pdf";
import { inspectPdf } from "./pdf-inspection";
const a = "00000000-0000-4000-8000-000000000001",
  b = "00000000-0000-4000-8000-000000000002",
  profile = "00000000-0000-4000-8000-000000000003",
  recipe = "00000000-0000-4000-8000-000000000004";
const digest = "a".repeat(64),
  org = "00000000-0000-4000-8000-000000000005";
function fixture(status = "draft") {
  return recipeReport({
    id: recipe,
    name: "Synthetic Àgbẹ́ mixing recipe ₦ — =SUM(1,1)",
    status,
    batch_kg: "100.000000",
    created_at: "2026-10-28T00:00:00Z",
    profile_id: profile,
    lines: [
      { ingredientId: a, percent: 75, min: 0, max: 100, availableKg: 75 },
      { ingredientId: b, percent: 25 },
    ],
    ingredient_snapshot: [a, b].map((id, i) => ({
      id,
      name: i ? "Synthetic rich B" : "Synthetic treated A",
      price: i ? "300.0000" : "100.0000",
      source: "Synthetic recorded reference only",
      review_status: "approved",
      basis: "as-fed",
      energy_system: "ME",
      processing_method: "heat-treated",
      processing_evidence: "Synthetic recorded method evidence",
      supplier: "=Synthetic supplier",
      certificate_reference: "Synthetic COA reference",
    })),
    result: {
      totalPercent: 100,
      costPerKg: "150.0000",
      batchCost: "15000.00",
      nutrients: {
        energy: 3000,
        protein: 20,
        dryMatter: null,
        calcium: 1,
        phosphorus: 0.5,
        methionine: 0.5,
        lysine: 1,
        ash: 0,
      },
      issues: [],
      releaseEligible: false,
      compliance: [{ nutrient: "protein", min: 20, status: "pass" }],
      profileSnapshot: {
        id: profile,
        name: "Synthetic starter profile",
        revision: 1,
        species: "poultry",
        stage: "starter",
        basis: "as-fed",
        energy_system: "ME",
        phosphorus_basis: "total",
        source: "Synthetic reviewed profile evidence",
        reviewer_id: null,
        created_at: "2026-10-28T00:00:00Z",
        limits: { protein: { min: 20 } },
        ingredient_rules: [
          {
            ingredientId: a,
            min: 0,
            max: 80,
            source: "Synthetic allowed reference evidence",
          },
        ],
        processing_rules: [
          {
            name: "Synthetic aggregate cap",
            ingredientIds: [a],
            minPercent: 0,
            maxPercent: 80,
            requiredMethod: "heat-treated",
            source: "Synthetic group evidence",
          },
        ],
      },
      processingCompliance: [
        {
          name: "Synthetic aggregate cap",
          ingredientIds: [a],
          minPercent: 0,
          maxPercent: 80,
          requiredMethod: "heat-treated",
          source: "Synthetic group evidence",
          actualPercent: 75,
          status: "pass",
        },
      ],
    },
  });
}
it("prints saved quantities, Unicode, costs, own constraints and provenance with no active content and deterministic bytes", async () => {
  const report = fixture("approved"),
    bytes = await recipePdf(report, org, digest),
    parsed = await inspectPdf(bytes);
  expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  expect(parsed.pages.length).toBeGreaterThanOrEqual(4);
  expect(parsed.pages[0].text).toContain("Synthetic treated A");
  expect(parsed.pages[0].text).toContain("75.000000");
  for (const s of [
    "100.000000",
    "75.000000",
    "25.000000",
    "150.0000",
    "15000.00",
    "Synthetic aggregate cap",
    "heat-treated",
    "=Synthetic supplier",
    "Àgbẹ́",
    "₦",
  ])
    expect(parsed.text).toContain(s);
  expect(parsed.text.replaceAll(/\s/g, "")).toContain(recipe);
  expect(parsed.text.replaceAll(/\s/g, "")).toContain(digest);
  const document = await PDFDocument.load(bytes);
  expect(
    document.catalog
      .lookup(PDFName.of("FarmsteadFontLicense"), PDFHexString)
      .decodeText(),
  ).toContain("Permission is hereby granted");
  expect(parsed.actions).toBeNull();
  expect(parsed.attachments).toBeNull();
  expect(
    parsed.pages.every(
      (p) =>
        p.annotations.length === 0 &&
        p.text.includes("APPROVED SAVED VERSION") &&
        p.text.includes(
          "No current stock reservation or manufacturing release",
        ),
    ),
  ).toBe(true);
  expect(Buffer.from(await recipePdf(report, org, digest))).toEqual(
    Buffer.from(bytes),
  );
  writeFileSync(".local/pdf-approved-validation.pdf", bytes, { mode: 0o600 });
});
for (const status of ["draft", "pending-review", "rejected"])
  it(`repeats the unapproved ${status} status on every page without modifying historical evidence`, async () => {
    const report = fixture(status),
      before = structuredClone(report),
      parsed = await inspectPdf(await recipePdf(report, org, digest));
    expect(
      parsed.pages.every((p) =>
        p.text.includes(`${status.toUpperCase()} — NOT APPROVED`),
      ),
    ).toBe(true);
    expect(report).toEqual(before);
  });
it("wraps long provenance, preserves end markers and keeps every text box within printable page bounds", async () => {
  const report = fixture();
  report.allocations[0].reference.source =
    "Long synthetic source ".repeat(90) + "END-PROVENANCE";
  report.allocations[0].reference.processing_evidence =
    "Long synthetic method ".repeat(85) + "END-METHOD";
  const bytes = await recipePdf(report, org, digest),
    parsed = await inspectPdf(bytes);
  expect(parsed.text).toContain("END-PROVENANCE");
  expect(parsed.text).toContain("END-METHOD");
  expect(parsed.text).toContain("Unknown");
  for (const page of parsed.pages)
    for (const item of page.items) {
      expect(item.x).toBeGreaterThanOrEqual(31);
      expect(item.y).toBeGreaterThanOrEqual(9);
      expect(item.x + item.width).toBeLessThanOrEqual(page.width - 30);
      expect(item.y + item.height).toBeLessThanOrEqual(page.height - 19);
    }
  writeFileSync(".local/pdf-long-validation.pdf", bytes, { mode: 0o600 });
});
it("shows unsupported glyphs and invisible controls explicitly and refuses oversized work and a third concurrent generation", async () => {
  const supported = {
    getCharacterSet: () =>
      Array.from("UnknownA[U+0000]\n").map((c) => c.codePointAt(0)!),
  };
  expect(pdfLiteral("A\u0000\u202e\u{1F9D1}", supported)).toBe(
    "A[U+0000][U+202E][U+1F9D1]",
  );
  expect(pdfLiteral(null, supported)).toBe("Unknown");
  const report = fixture();
  report.allocations[0].reference.source = "x".repeat(500001);
  await expect(recipePdf(report, org, digest)).rejects.toMatchObject({
    status: 422,
  });
  const results = await Promise.allSettled([
    recipePdf(fixture(), org, digest),
    recipePdf(fixture(), org, digest),
    recipePdf(fixture(), org, digest),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 429 },
  });
});
