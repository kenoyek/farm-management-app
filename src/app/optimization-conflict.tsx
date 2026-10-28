"use client";
import type { ConflictAnalysis } from "@/lib/optimization-conflict";
export default function OptimizationConflict({
  analysis,
}: {
  analysis: ConflictAnalysis;
}) {
  return (
    <section className="alias-review" aria-label="Conflicting constraints">
      <h3>
        {analysis.status === "irreducible"
          ? "Verified irreducible conflict"
          : analysis.status === "partial"
            ? "Conflict search incomplete"
            : "Conflict explanation unavailable"}
      </h3>
      <p className="helper">
        The selected ingredient candidates, 100% batch total and 0–100%
        inclusion bounds stay fixed during diagnosis. The original run remains
        infeasible and all original limits remain unchanged.
      </p>
      <p>
        {analysis.status === "irreducible"
          ? "Removing any one listed constraint makes this subset feasible within solver tolerances. This is one conflict; other conflicts may exist, and the fewest possible constraints are not guaranteed."
          : analysis.status === "partial"
            ? "The listed subset remains infeasible, but the checks needed to establish irreducibility did not finish."
            : "The worker could not verify a conflict subset within its diagnostic limits."}
      </p>
      <p className="helper">
        {analysis.checks} of {analysis.maxChecks} diagnostic checks ·{" "}
        {analysis.candidateCount} candidate constraints · {analysis.termination}{" "}
        · residual tolerance {analysis.tolerance}. This explanation does not
        recommend changing any limit.
      </p>
      {analysis.constraints.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Constraint / exact reference</th>
                <th>Side</th>
                <th>Recorded limit</th>
                <th>Source / evidence</th>
              </tr>
            </thead>
            <tbody>
              {analysis.constraints.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.label}
                    <small className="recipe-version-id">
                      {c.kind} ·{" "}
                      {c.ingredientId ?? c.ingredientIds?.join(", ") ?? c.id}
                    </small>
                  </td>
                  <td>{c.side === "min" ? "Minimum" : "Maximum"}</td>
                  <td>
                    {Number(c.value.toFixed(8))} {c.unit}
                  </td>
                  <td>
                    {c.origins
                      ?.map((o) => `${o.source}: ${o.percent}%`)
                      .join(" · ") ??
                      c.evidence ??
                      "Reviewed nutrient requirement in the original specification snapshot"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
