"use client";
import { useState } from "react";
import { Download, FlaskConical } from "lucide-react";
import { api, downloadCsv, downloadReport } from "@/lib/client";
import { nutrientKeys, type FormulaLine } from "@/lib/feed";
import { nutrientLabels, type RecipeComparison } from "@/lib/recipe-reports";

type RecipeSummary = {
  id: string;
  name: string;
  status: string;
  batch_kg: string;
  created_at: string;
  lines: FormulaLine[];
  result: { costPerKg: string | null };
};
const money = (value: string | null) => {
  if (value === null) return "Unknown";
  const [integer, fraction] = value.split(".");
  return `₦${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
};

export default function RecipeLibrary({
  organizationId,
  recipes,
  onClone,
}: {
  organizationId: string;
  recipes: RecipeSummary[];
  onClone: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [baseline, setBaseline] = useState("");
  const [batch, setBatch] = useState("1000");
  const [comparison, setComparison] = useState<RecipeComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function download(id: string, format: "csv" | "xlsx") {
    setDownloading(id);
    setError("");
    try {
      await downloadReport(
        `formulas/${id}/export?organizationId=${organizationId}&format=${format}`,
        `farmstead-${id}.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(null);
    }
  }
  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((s) => s !== id)
      : [...selected, id];
    setSelected(next);
    setComparison(null);
    setError("");
    if (!next.includes(baseline)) setBaseline(next[0] ?? "");
  };
  async function compare() {
    setBusy(true);
    setError("");
    setComparison(null);
    try {
      setComparison(
        await api<RecipeComparison>("formulas/compare", {
          organizationId,
          recipeIds: [baseline, ...selected.filter((id) => id !== baseline)],
          batchKg: Number(batch),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Saved formula versions</h2>
          <span className="tag">HISTORY PRESERVED</span>
        </div>
        <p className="helper">
          Downloads use each saved version’s original batch, historical quotes
          and review evidence. Select two to four versions to compare. The
          latest 100 saved versions are listed.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {recipes.length ? (
          <>
            <fieldset className="draft-editor" disabled={busy}>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Compare</th>
                      <th>Recipe / version</th>
                      <th>Status</th>
                      <th>Saved batch kg</th>
                      <th>NGN / kg</th>
                      <th>Saved</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipes.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Compare ${f.name} ${f.id.slice(0, 8)}`}
                            checked={selected.includes(f.id)}
                            disabled={
                              !selected.includes(f.id) && selected.length >= 4
                            }
                            onChange={() => toggle(f.id)}
                          />
                        </td>
                        <td>
                          {f.name}
                          <small className="recipe-version-id">
                            {f.id.slice(0, 8)}
                          </small>
                        </td>
                        <td>
                          <span
                            className={`status ${f.status === "approved" ? "good" : ""}`}
                          >
                            {f.status}
                          </span>
                        </td>
                        <td>{f.batch_kg}</td>
                        <td>{money(f.result.costPerKg)}</td>
                        <td>
                          {new Date(f.created_at).toLocaleDateString("en-NG")}
                        </td>
                        <td>
                          <div className="button-row recipe-actions">
                            <button
                              className="text-button"
                              onClick={() => onClone(f.id)}
                            >
                              Clone &amp; edit
                            </button>
                            {(["xlsx", "csv"] as const).map((format) => (
                              <button
                                key={format}
                                className="text-button"
                                disabled={!!downloading}
                                aria-label={`Download ${format.toUpperCase()} for ${f.name} ${f.id.slice(0, 8)}`}
                                onClick={() => void download(f.id, format)}
                              >
                                <Download size={13} />
                                {downloading === f.id
                                  ? "Downloading…"
                                  : format.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="editor-settings">
                <label>
                  Baseline recipe
                  <select
                    value={baseline}
                    onChange={(e) => {
                      setBaseline(e.target.value);
                      setComparison(null);
                    }}
                  >
                    <option value="">Select recipes above</option>
                    {selected.map((id) => (
                      <option key={id} value={id}>
                        {recipes.find((r) => r.id === id)?.name} ·{" "}
                        {id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Comparison batch kg
                  <input
                    type="number"
                    min="0.000001"
                    max="100000000"
                    step="any"
                    value={batch}
                    onChange={(e) => {
                      setBatch(e.target.value);
                      setComparison(null);
                    }}
                  />
                </label>
              </div>
              <button
                className="primary"
                disabled={
                  selected.length < 2 ||
                  !baseline ||
                  !Number.isFinite(Number(batch)) ||
                  Number(batch) <= 0 ||
                  Number(batch) > 1e8
                }
                onClick={() => void compare()}
              >
                {busy ? "Comparing…" : "Compare saved versions"}
              </button>
            </fieldset>
          </>
        ) : (
          <div className="empty">
            <FlaskConical size={30} />
            <h3>Your recipe library starts with one formula</h3>
            <p>
              Save a formulation to retain its inputs, reference snapshot and
              calculated results.
            </p>
          </div>
        )}
      </section>
      {comparison && <Comparison value={comparison} />}
    </>
  );
}

function Comparison({ value }: { value: RecipeComparison }) {
  const versions = value.versions;
  const ingredients = Array.from(
    new Map(
      versions.flatMap((v) =>
        v.allocations.map((a) => [a.ingredientId, a.reference] as const),
      ),
    ).values(),
  );
  const exportComparison = () =>
    downloadCsv("farmstead-recipe-comparison.csv", [
      [
        "Farmstead saved recipe comparison",
        "NGN historical prices; common batch is planning only",
      ],
      ["Common batch kg", value.batchKg],
      ["Baseline UUID", value.baselineId],
      ["Nutrient context comparable", String(value.contextComparable)],
      ...value.warnings.map((w) => ["Warning", w]),
      [],
      [
        "Version UUID",
        "Recipe",
        "Status",
        "Original batch kg",
        "Own profile UUID",
        "Saved NGN/kg",
        "Common batch NGN",
        "Delta NGN/kg",
        "Delta common batch NGN",
      ],
      ...versions.map((v) => [
        v.id,
        v.name,
        v.status,
        v.batchKg,
        v.profile?.id ?? null,
        v.costPerKg,
        v.commonBatchCost,
        v.deltaPerKg,
        v.deltaCommonBatch,
      ]),
      [],
      [
        "Version UUID",
        "Nutrient / unit",
        "Saved actual",
        "Own minimum",
        "Own maximum",
        "Own saved check",
        "Delta from baseline",
      ],
      ...versions.flatMap((v) =>
        nutrientKeys.map((k) => [
          v.id,
          nutrientLabels[k],
          v.nutrients[k],
          v.profile?.limits[k]?.min ?? null,
          v.profile?.limits[k]?.max ?? null,
          v.compliance.find((c) => c.nutrient === k)?.status ??
            "No saved check",
          v.nutrientDeltas[k],
        ]),
      ),
      [],
      [
        "Version UUID",
        "Ingredient UUID",
        "Ingredient",
        "Reference revision",
        "Percent",
        "Common batch kg",
      ],
      ...versions.flatMap((v) =>
        v.allocations.map((a) => [
          v.id,
          a.ingredientId,
          a.reference.name,
          a.reference.revision,
          a.percent,
          v.scaledAllocations.find((s) => s.ingredientId === a.ingredientId)!
            .kg,
        ]),
      ),
    ]);
  return (
    <section
      className="panel recipe-comparison"
      aria-label="Saved recipe comparison"
    >
      <div className="panel-heading">
        <h2>Saved recipe comparison</h2>
        <button className="secondary" onClick={exportComparison}>
          <Download size={14} />
          Comparison CSV
        </button>
      </div>
      <p className="helper">
        Common costs use the saved four-decimal NGN/kg result; rounding can
        differ from the original batch total. The common {value.batchKg} kg
        batch is for comparison only; saved availability and approval do not
        transfer to a resized batch. Unknown values stay unknown. No prices or
        nutrients were refreshed.
      </p>
      {value.warnings.length > 0 && (
        <div className="validation-issues" role="status">
          <ul>
            {value.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              {versions.map((v) => (
                <th key={v.id}>
                  {v.name} · {v.id.slice(0, 8)}
                  {v.id === value.baselineId ? " · baseline" : ""}
                  <small className="recipe-version-id">
                    {v.status} ·{" "}
                    {v.profile
                      ? `${v.profile.stage} / ${v.profile.basis} / ${v.profile.energy_system} / ${v.profile.phosphorus_basis} P`
                      : "Scientific context not recorded"}
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Saved batch kg</th>
              {versions.map((v) => (
                <td key={v.id}>{v.batchKg}</td>
              ))}
            </tr>
            <tr>
              <th>Saved inclusion total</th>
              {versions.map((v) => (
                <td key={v.id}>{v.totalPercent}%</td>
              ))}
            </tr>
            <tr>
              <th>Saved cost / kg</th>
              {versions.map((v) => (
                <td key={v.id}>{money(v.costPerKg)}</td>
              ))}
            </tr>
            <tr>
              <th>Common batch cost</th>
              {versions.map((v) => (
                <td key={v.id}>{money(v.commonBatchCost)}</td>
              ))}
            </tr>
            <tr>
              <th>Cost delta / kg</th>
              {versions.map((v) => (
                <td key={v.id}>{money(v.deltaPerKg)}</td>
              ))}
            </tr>
            <tr>
              <th>Common batch cost delta</th>
              {versions.map((v) => (
                <td key={v.id}>{money(v.deltaCommonBatch)}</td>
              ))}
            </tr>
            {nutrientKeys.map((k) => (
              <tr key={k}>
                <th>{nutrientLabels[k]}</th>
                {versions.map((v) => {
                  const check = v.compliance.find((c) => c.nutrient === k),
                    range = v.profile?.limits[k];
                  return (
                    <td key={v.id}>
                      {v.nutrients[k] ?? "Unknown"}
                      <small className="recipe-version-id">
                        Delta: {v.nutrientDeltas[k] ?? "Unavailable"}
                      </small>
                      <small className="recipe-version-id">
                        Own limits: {range?.min ?? "—"} to {range?.max ?? "—"} ·{" "}
                        {check?.status ?? "No saved check"}
                      </small>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Ingredient allocations at the common batch weight</h3>
      <p className="helper">
        Rows match exact reference UUIDs. Different quotations or names are
        never merged.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Ingredient / reference</th>
              {versions.map((v) => (
                <th key={v.id}>
                  {v.name} · {v.id.slice(0, 8)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ingredients.map((i) => (
              <tr key={i.id}>
                <th>
                  {i.name} · v{i.revision}
                  <small className="recipe-version-id">{i.id}</small>
                </th>
                {versions.map((v) => {
                  const a = v.allocations.find((a) => a.ingredientId === i.id),
                    scaled = v.scaledAllocations.find(
                      (a) => a.ingredientId === i.id,
                    );
                  return (
                    <td key={v.id}>
                      {a ? `${a.percent}% / ${scaled!.kg} kg` : "Not included"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
