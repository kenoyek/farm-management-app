"use client";
import { useEffect, useState } from "react";
import { api, downloadJson } from "@/lib/client";
import type { DraftContent } from "@/lib/draft-schema";
import type {
  OptimizationDetail,
  OptimizationSummary,
} from "@/lib/optimization-history";
import OptimizationEvidence from "./optimization-evidence";

export default function OptimizationHistory({
  organizationId,
  initialRunId,
  canRestore,
  restore,
}: {
  organizationId: string;
  initialRunId: string;
  canRestore: boolean;
  restore: (content: DraftContent) => void;
}) {
  const [runs, setRuns] = useState<OptimizationSummary[]>([]);
  const [selected, setSelected] = useState(initialRunId);
  const [detail, setDetail] = useState<OptimizationDetail | null>(null);
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState("all");
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true),
    [detailLoading, setDetailLoading] = useState(!!initialRunId);
  useEffect(() => {
    let active = true;
    void api<OptimizationSummary[]>(
      `optimization-runs?organizationId=${organizationId}`,
    )
      .then((r) => {
        if (active) setRuns(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organizationId, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void api<OptimizationDetail>(
      `optimization-runs/${selected}?organizationId=${organizationId}`,
    )
      .then((r) => {
        if (active) setDetail(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organizationId, selected, refresh]);
  const visible = runs.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      `${r.name} ${r.id} ${r.profileName ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Optimizer run history</h2>
          <button
            className="secondary"
            disabled={loading || detailLoading}
            onClick={() => {
              setError("");
              setLoading(true);
              setDetail(null);
              setDetailLoading(!!selected);
              setRefresh((r) => r + 1);
            }}
          >
            Refresh runs
          </button>
        </div>
        <p className="helper">
          The latest 100 runs retain their original constraints and outcomes.
          Historical quotations are not refreshed here. Loading a scenario
          creates a working draft; rerunning applies current reference and
          quotation checks.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-settings">
          <label>
            Search optimizer runs
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label>
            Run status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {[
                "all",
                "optimal",
                "infeasible",
                "limit",
                "unbounded",
                "solver-error",
                "unknown",
              ].map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All statuses" : s}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p role="status">Loading optimizer runs…</p>
        ) : visible.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Scenario / run</th>
                  <th>Saved at</th>
                  <th>Status</th>
                  <th>Profile</th>
                  <th>Historical NGN/kg</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.name}
                      <small className="recipe-version-id">{r.id}</small>
                    </td>
                    <td>{new Date(r.createdAt).toLocaleString("en-NG")}</td>
                    <td>
                      <span
                        className={`status ${r.status === "optimal" ? "good" : ""}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>{r.profileName ?? "Not recorded"}</td>
                    <td>{r.costPerKg ?? "No optimal cost"}</td>
                    <td>
                      <button
                        className="text-button"
                        aria-label={`View run ${r.id.slice(0, 8)}`}
                        onClick={() => {
                          if (selected === r.id && detail) return;
                          setError("");
                          setDetail(null);
                          setDetailLoading(true);
                          if (selected === r.id) setRefresh((r) => r + 1);
                          else setSelected(r.id);
                        }}
                      >
                        View run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            {runs.length
              ? "No runs match these filters."
              : "No optimization runs saved yet."}
          </div>
        )}
      </section>
      {detailLoading && <p role="status">Loading run evidence…</p>}
      {detail && (
        <section
          className="panel optimizer-detail"
          aria-label="Saved optimization run"
        >
          <div className="panel-heading">
            <h2>{detail.summary.name}</h2>
            <button
              className="secondary"
              onClick={() =>
                downloadJson(
                  `farmstead-optimization-${detail.record.id}.json`,
                  detail.record,
                )
              }
            >
              Download run JSON
            </button>
          </div>
          <p className="helper">
            Run {detail.record.id} ·{" "}
            {new Date(detail.summary.createdAt).toLocaleString("en-NG")}
          </p>
          <p className="helper">
            {detail.hasReferenceSnapshots
              ? "Original ingredient and specification snapshots are retained in this run."
              : "This legacy run lacks complete reference snapshots. Current references have not been substituted for the missing evidence."}
          </p>
          {detail.view ? (
            <OptimizationEvidence view={detail.view} runId={detail.record.id} />
          ) : (
            <p className="error">
              The historical outcome is not readable. Its original JSON remains
              available.
            </p>
          )}
          <details>
            <summary>Original request and reference evidence</summary>
            <pre className="optimization-json">
              {JSON.stringify(detail.record.request, null, 2)}
            </pre>
          </details>
          <p className="helper">
            {detail.restoration
              ? `Restore allocations from ${detail.restoration.allocationSource}, preserving the original scenario bounds and available-quantity inputs. Approval is reset to Draft and results require fresh calculation.`
              : "This run cannot be loaded because its scenario or same-organization references are incomplete."}
          </p>
          <button
            className="primary"
            disabled={!canRestore || !detail.restoration}
            onClick={() => {
              if (
                detail.restoration &&
                window.confirm(
                  "Replace your working formulation with this historical scenario as a draft? Download your local draft first if you want to keep both.",
                )
              )
                restore(detail.restoration.content);
            }}
          >
            Load scenario as draft
          </button>
        </section>
      )}
    </>
  );
}
