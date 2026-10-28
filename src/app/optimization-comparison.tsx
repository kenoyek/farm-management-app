"use client";
import { useRef, useState } from "react";
import { api, downloadJson, downloadReport } from "@/lib/client";
import type { OptimizationSummary } from "@/lib/optimization-history";
import type { OptimizationComparison } from "@/lib/optimization-comparison";
import OptimizationEvidence from "./optimization-evidence";

type Compared = OptimizationComparison & { evidenceSha256: string };
const value = (v: string | number | null | undefined) =>
  v === null || v === undefined
    ? "Unavailable"
    : typeof v === "number"
      ? Number(v.toFixed(6))
      : v;
export default function OptimizationComparisonPanel({
  organizationId,
  runs,
}: {
  organizationId: string;
  runs: OptimizationSummary[];
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [baseline, setBaseline] = useState(""),
    [batch, setBatch] = useState("1000");
  const [comparison, setComparison] = useState<Compared | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  function invalidate() {
    generation.current++;
    setComparison(null);
    setError("");
  }
  function toggle(id: string) {
    invalidate();
    const next = selected.includes(id)
      ? selected.filter((v) => v !== id)
      : [...selected, id];
    setSelected(next);
    if (!next.includes(baseline)) setBaseline(next[0] ?? "");
  }
  async function compare() {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setComparison(null);
    try {
      const response = await api<Compared>("optimization-runs/compare", {
        organizationId,
        runIds: [baseline, ...selected.filter((v) => v !== baseline)],
        batchKg: Number(batch),
      });
      if (current === generation.current) setComparison(response);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download(format: "csv" | "xlsx") {
    if (!comparison) return;
    setBusy(true);
    setError("");
    const query = new URLSearchParams({
      organizationId,
      batchKg: String(comparison.batchKg),
      format,
    });
    for (const run of comparison.runs) query.append("runId", run.id);
    try {
      await downloadReport(
        `optimization-runs/compare?${query}`,
        `farmstead-optimizer-comparison.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const references = [
    ...new Map(
      (comparison?.runs ?? []).flatMap((r) =>
        r.allocations.map((a) => [a.reference.id, a.reference] as const),
      ),
    ).values(),
  ];
  return (
    <section className="panel" aria-label="Optimizer scenario comparison">
      <h2>Compare optimizer scenarios</h2>
      <p className="helper">
        Select two to four saved runs. The first baseline is editable. Costs use
        historical NGN quotations; each run keeps its own reviewed limits.
        Filtered history does not remove your selection.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <fieldset className="draft-editor" disabled={busy}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Compare</th>
                <th>Scenario / run</th>
                <th>Status</th>
                <th>Profile</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Compare run ${r.id.slice(0, 8)}`}
                      checked={selected.includes(r.id)}
                      disabled={
                        !selected.includes(r.id) && selected.length >= 4
                      }
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                  <td>
                    {r.name}
                    <small className="recipe-version-id">{r.id}</small>
                  </td>
                  <td>{r.status}</td>
                  <td>{r.profileName ?? "Not recorded"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="editor-settings">
          <label>
            Baseline optimizer run
            <select
              value={baseline}
              onChange={(e) => {
                invalidate();
                setBaseline(e.target.value);
              }}
            >
              <option value="">Select runs above</option>
              {selected.map((id) => (
                <option key={id} value={id}>
                  {runs.find((r) => r.id === id)?.name} · {id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Optimizer comparison batch kg
            <input
              type="number"
              min="0.000001"
              max="100000000"
              step="any"
              value={batch}
              onChange={(e) => {
                invalidate();
                setBatch(e.target.value);
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
          Compare selected runs
        </button>
      </fieldset>
      {busy && <p role="status">Preparing comparison…</p>}
      {comparison && (
        <section aria-label="Optimizer comparison results">
          <p className="helper">{comparison.notice}</p>
          <p>
            Baseline: {comparison.runs[0].name} · {comparison.baselineId}.
            Planning batch: {comparison.batchKg} kg.
          </p>
          <div className="button-row">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                downloadJson("farmstead-optimizer-comparison.json", comparison)
              }
            >
              Download comparison JSON
            </button>
            {(["csv", "xlsx"] as const).map((format) => (
              <button
                key={format}
                className="secondary"
                disabled={busy}
                onClick={() => void download(format)}
              >
                Download comparison {format.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="table-scroll">
            <table aria-label="Scenario outcomes">
              <thead>
                <tr>
                  <th>Run / profile</th>
                  <th>Status</th>
                  <th>Original batch kg</th>
                  <th>Historical NGN/kg</th>
                  <th>Planning NGN</th>
                  <th>Delta NGN/kg</th>
                  <th>Delta planning NGN</th>
                </tr>
              </thead>
              <tbody>
                {comparison.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.name}
                      <small className="recipe-version-id">
                        {r.id} · {r.profile?.name ?? "Unknown profile"} · v
                        {r.profile?.revision ?? "?"}
                      </small>
                      {r.evidenceIssue && <small>{r.evidenceIssue}</small>}
                    </td>
                    <td>{r.status}</td>
                    <td>{value(r.originalBatchKg)}</td>
                    <td>{value(r.costPerKg)}</td>
                    <td>{value(r.batchCost)}</td>
                    <td>{value(r.deltaCostPerKg)}</td>
                    <td>{value(r.deltaBatchCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Allocations by exact reference</h3>
          <p className="helper">
            Not offered differs from a solved zero. Deltas use only the same
            reference UUID in both runs. Quantities below scale the saved
            solution for planning.
          </p>
          <div className="table-scroll">
            <table aria-label="Scenario allocations">
              <thead>
                <tr>
                  <th>Reference / revision</th>
                  {comparison.runs.map((r) => (
                    <th key={r.id}>
                      {r.name} · {r.id.slice(0, 8)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {references.map((ref) => (
                  <tr key={ref.id}>
                    <td>
                      {ref.name}
                      <small className="recipe-version-id">
                        {ref.id} · v{ref.revision ?? "?"}
                      </small>
                    </td>
                    {comparison.runs.map((r) => {
                      const a = r.allocations.find(
                        (a) => a.reference.id === ref.id,
                      );
                      return (
                        <td key={r.id}>
                          {!a ? (
                            "Not offered"
                          ) : a.percent === null ? (
                            "No saved solution"
                          ) : (
                            <>
                              {value(a.percent)}% · {a.planningKg} kg
                              <small className="recipe-version-id">
                                Delta {value(a.deltaPercent)} pp
                              </small>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Nutrients and each run’s own limits</h3>
          <div className="table-scroll">
            <table aria-label="Scenario nutrients">
              <thead>
                <tr>
                  <th>Measurement</th>
                  {comparison.runs.map((r) => (
                    <th key={r.id}>
                      {r.name} · {r.id.slice(0, 8)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.nutrients.map((n) => (
                  <tr key={n.key}>
                    <td>{n.label}</td>
                    {n.values.map((v) => (
                      <td key={v.runId}>
                        {value(v.actual)} · {v.check}
                        <small className="recipe-version-id">
                          Min {value(v.limit?.min)} / max {value(v.limit?.max)}
                        </small>
                        <small className="recipe-version-id">
                          Delta {value(v.delta)}
                          {v.deltaReason ? ` · ${v.deltaReason}` : ""}
                        </small>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison.runs.map((r) => (
            <details key={r.id}>
              <summary>
                Constraints and evidence · {r.name} · {r.id.slice(0, 8)}
              </summary>
              <p>
                {r.profile
                  ? [
                      r.profile.species,
                      r.profile.stage,
                      r.profile.basis,
                      r.profile.energy_system,
                      r.profile.phosphorus_basis,
                    ].join(" · ")
                  : "Scientific context not recorded"}
              </p>
              {r.view && <OptimizationEvidence view={r.view} />}
              <details>
                <summary>
                  Original candidate inputs and reference evidence
                </summary>
                <pre className="optimization-json">
                  {JSON.stringify(
                    r.allocations.map((a) => ({
                      input: a.input,
                      reference: a.reference,
                    })),
                    null,
                    2,
                  )}
                </pre>
              </details>
              <details>
                <summary>Original reviewed specification</summary>
                <pre className="optimization-json">
                  {JSON.stringify(r.profile, null, 2)}
                </pre>
              </details>
            </details>
          ))}
          <p className="helper">
            Evidence SHA-256:{" "}
            <span className="recipe-version-id">
              {comparison.evidenceSha256}
            </span>
          </p>
        </section>
      )}
    </section>
  );
}
