"use client";
import type { OptimizationView } from "@/lib/optimization-history";
import { nutrientLabels } from "@/lib/recipe-reports";

const value = (n: number) => Number(n.toFixed(6)).toString();
export default function OptimizationEvidence({
  view,
  runId,
  openHistory,
}: {
  view: OptimizationView;
  runId?: string;
  openHistory?: () => void;
}) {
  return (
    <section
      className="panel optimization-evidence"
      aria-label="Optimization evidence"
    >
      <div className="panel-heading">
        <h2>Optimization evidence</h2>
        <span className={`status ${view.status === "optimal" ? "good" : ""}`}>
          {view.status}
        </span>
      </div>
      <p>{view.message}</p>
      <p className="helper">
        {view.solver}
        {runId ? ` · Run ${runId}` : ""}. This result does not approve a recipe
        or reserve stock.
      </p>
      {openHistory && (
        <button className="text-button" onClick={openHistory}>
          Open saved run
        </button>
      )}
      {view.diagnostics.length > 0 && (
        <div className="validation-issues">
          <ul>
            {view.diagnostics.map((d, i) => (
              <li key={i}>{d.message}</li>
            ))}
          </ul>
          <p>
            All constraints remain unchanged. Review the underlying evidence and
            scenario inputs before a new run.
          </p>
        </div>
      )}
      {view.effectiveBounds.length > 0 && (
        <>
          <h3>Effective ingredient bounds</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ingredient / reference</th>
                  <th>Min %</th>
                  <th>Max %</th>
                  <th>Minimum evidence</th>
                  <th>Maximum evidence</th>
                </tr>
              </thead>
              <tbody>
                {view.effectiveBounds.map((b) => (
                  <tr key={b.ingredientId}>
                    <td>
                      {b.name}
                      <small className="recipe-version-id">
                        {b.ingredientId}
                      </small>
                    </td>
                    <td>{value(b.min)}</td>
                    <td>{value(b.max)}</td>
                    <td>
                      {b.minimumSources
                        .map((s) => `${s.source}: ${value(s.percent)}%`)
                        .join(" · ")}
                    </td>
                    <td>
                      {b.maximumSources
                        .map((s) => `${s.source}: ${value(s.percent)}%`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view.reachability.length > 0 && (
        <>
          <h3>Individual nutrient ranges</h3>
          <p className="helper">
            Each range uses the ingredient bounds and 100% total, without the
            other nutrient limits. It is a necessary condition, not proof that
            all targets can be met together.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nutrient / unit</th>
                  <th>Attainable min</th>
                  <th>Attainable max</th>
                  <th>Required min</th>
                  <th>Required max</th>
                </tr>
              </thead>
              <tbody>
                {view.reachability.map((r) => (
                  <tr key={r.nutrient}>
                    <td>{nutrientLabels[r.nutrient]}</td>
                    <td>{value(r.attainableMin)}</td>
                    <td>{value(r.attainableMax)}</td>
                    <td>{r.requiredMin ?? "—"}</td>
                    <td>{r.requiredMax ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view.bindingConstraints.length > 0 && (
        <p className="helper">
          Binding constraints: {view.bindingConstraints.join("; ")}
        </p>
      )}
      {view.validation && (
        <details>
          <summary>Independent primal checks</summary>
          <dl className="optimizer-checks">
            <dt>Total inclusion error (percentage points)</dt>
            <dd>{view.validation.totalPercentError}</dd>
            <dt>Maximum bound violation (percentage points)</dt>
            <dd>{view.validation.maximumBoundViolationPercent}</dd>
            <dt>Objective error (NGN/kg)</dt>
            <dd>{view.validation.objectiveError}</dd>
            <dt>Objective tolerance (NGN/kg)</dt>
            <dd>{view.validation.objectiveTolerance}</dd>
            <dt>Nutrient comparison tolerance (declared unit)</dt>
            <dd>{view.validation.nutrientTolerance}</dd>
            <dt>Inclusion/bound tolerance (percentage points)</dt>
            <dd>{view.validation.boundTolerancePercent}</dd>
          </dl>
        </details>
      )}
      {!view.diagnosticModelVersion && (
        <p className="helper">
          This legacy run has no detailed constraint diagnostics or independent
          residual report.
        </p>
      )}
    </section>
  );
}
