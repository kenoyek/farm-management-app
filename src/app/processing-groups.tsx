"use client";
import type { ProcessingRule, ProcessingCheck } from "@/lib/processing";
export default function ProcessingGroups({
  groups,
}: {
  groups: (ProcessingRule | ProcessingCheck)[];
}) {
  if (!groups.length) return null;
  return (
    <section className="alias-review" aria-label="Processing group constraints">
      <h3>Reviewed processing group constraints</h3>
      <p className="helper">
        Bounds apply to the sum of these exact ingredient revisions. Recorded
        processing evidence is required where a method is specified; this does
        not record a manufacturing treatment.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Group / evidence</th>
              <th>Exact references</th>
              <th>Required method</th>
              <th>Min %</th>
              <th>Max %</th>
              <th>Actual % / check</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.name}>
                <td className="source-reference">
                  {g.name}
                  <small className="recipe-version-id">{g.source}</small>
                </td>
                <td className="source-reference">
                  {g.ingredientIds.join(", ")}
                </td>
                <td>{g.requiredMethod ?? "No method requirement"}</td>
                <td>{g.minPercent}</td>
                <td>{g.maxPercent}</td>
                <td>
                  {"actualPercent" in g
                    ? `${g.actualPercent === null ? "Not solved" : Number(g.actualPercent.toFixed(6))} · ${g.status}`
                    : "Not calculated"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
