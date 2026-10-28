"use client";
import { useEffect, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { api, downloadCsv, downloadJson } from "@/lib/client";
import {
  layerReportSheets,
  dateOrdinal,
  dateString,
  type LayerReport,
  type LayerSource,
} from "@/lib/layer-report";
type Document = LayerReport & {
  evidenceSha256: string;
  generatedAt: string;
  sourceSnapshot: LayerSource;
};
type Scenario = {
  id: string;
  name: string;
  kind: string;
  result: { modelVersion: string };
};
const v = (n: number | string | null | undefined) =>
  n === null || n === undefined
    ? "Unknown"
    : typeof n === "number"
      ? Number(n.toFixed(6))
      : n;
export default function LayerReporting({
  organizationId,
  unit,
  lastDate,
}: {
  organizationId: string;
  unit: { id: string; stocked_on: string };
  lastDate: string;
}) {
  const end = lastDate || unit.stocked_on;
  const [from, setFrom] = useState(
      dateString(Math.max(dateOrdinal(unit.stocked_on), dateOrdinal(end) - 29)),
    ),
    [to, setTo] = useState(end),
    [tray, setTray] = useState("30"),
    [forecastId, setForecastId] = useState("");
  const [forecasts, setForecasts] = useState<Scenario[]>([]),
    [report, setReport] = useState<Document | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef({ value: 0 });
  useEffect(() => {
    let active = true;
    const counter = generation.current;
    void api<Scenario[]>(`forecasts?organizationId=${organizationId}`)
      .then((data) => {
        if (active) setForecasts(data.filter((f) => f.kind === "layer-eggs"));
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      counter.value++;
    };
  }, [organizationId]);
  function invalidate() {
    generation.current.value++;
    setReport(null);
    setError("");
  }
  async function calculate() {
    const current = ++generation.current.value;
    setReport(null);
    setError("");
    setBusy(true);
    try {
      const result = await api<Document>("layers/report", {
        organizationId,
        unitId: unit.id,
        from,
        to,
        traySize: Number(tray),
        forecastId: forecastId || null,
      });
      if (current === generation.current.value) setReport(result);
    } catch (e) {
      if (current === generation.current.value) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Layer hen-day reporting">
      <h2>Hen-day report and forecast reconciliation</h2>
      <p className="helper">
        Use opening-of-day hens before recorded same-day deaths. Missing history
        makes later flock denominators unknown. Download JSON to preserve the
        full source snapshot; refreshing includes newly saved records.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <fieldset className="draft-editor" disabled={busy}>
        <div className="editor-settings">
          <label>
            Layer report from
            <input
              type="date"
              min={unit.stocked_on}
              value={from}
              onChange={(e) => {
                invalidate();
                setFrom(e.target.value);
              }}
            />
          </label>
          <label>
            Layer report through
            <input
              type="date"
              min={from}
              value={to}
              onChange={(e) => {
                invalidate();
                setTo(e.target.value);
              }}
            />
          </label>
          <label>
            Reporting tray size
            <input
              type="number"
              min="1"
              max="1000"
              value={tray}
              onChange={(e) => {
                invalidate();
                setTray(e.target.value);
              }}
            />
          </label>
          <label>
            Saved egg forecast baseline
            <select
              value={forecastId}
              onChange={(e) => {
                invalidate();
                setForecastId(e.target.value);
              }}
            >
              <option value="">Actual observations only</option>
              {forecasts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} · {f.id.slice(0, 8)} · {f.result.modelVersion}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="primary"
          disabled={!from || !to || Number(tray) < 1 || Number(tray) > 1000}
          onClick={() => void calculate()}
        >
          Generate layer report
        </button>
      </fieldset>
      {busy && <p role="status">Calculating daily coverage and hen-days…</p>}
      {report && (
        <section aria-label="Layer report results">
          <div className="button-row">
            <button
              className="secondary"
              onClick={() =>
                downloadJson(`farmstead-layer-${unit.id}.json`, report)
              }
            >
              Download layer report JSON
            </button>
            <button
              className="secondary"
              onClick={() =>
                downloadCsv(
                  `farmstead-layer-${unit.id}.csv`,
                  layerReportSheets(
                    report,
                    report.evidenceSha256,
                    report.sourceSnapshot,
                  ).flatMap((s) => [[s.name], ...s.rows, []]),
                )
              }
            >
              Download layer report CSV
            </button>
          </div>
          <p className="helper">
            {report.basis} {report.scope}
          </p>
          <p>
            Recorded days: {report.coverage.recordedDays} /{" "}
            {report.coverage.days} · Hen-days: {v(report.henDays)} · Weighted
            hen-day: {v(report.henDayPercent)}%
          </p>
          <p>
            Complete-window gross eggs: {v(report.actualTotals?.eggs)} ·
            Recorded subtotal: {report.recordedTotals.eggs} · Saleable:{" "}
            {v(report.actualTotals?.saleable)} · Complete{" "}
            {report.input.traySize}-egg trays: {v(report.wholeTrays)} +{" "}
            {v(report.remainderEggs)} eggs
          </p>
          {report.issues.length > 0 && (
            <ul className="validation-issues">
              {report.issues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          {report.forecast && (
            <div className="alias-review">
              <h3>Original forecast baseline</h3>
              <p>
                {report.forecast.name} · {report.forecast.id} ·{" "}
                {report.forecast.modelVersion}
              </p>
              <p>
                Scenario opening: {report.forecast.opening} · Recorded flock
                opening at scenario start:{" "}
                {v(report.forecast.flockOpeningAtForecastStart)} · Original tray
                size: {report.forecast.originalTraySize}
              </p>
              <p>
                {report.forecast.reason ??
                  "Opening population aligned with the recorded flock history. Forecast assumptions remain unchanged."}
              </p>
              <p>
                Expected gross eggs: {v(report.expectedTotals?.gross)} · Gross
                egg variance: {v(report.deltas?.gross)}
              </p>
            </div>
          )}
          {report.forecast?.modelVersion === "opening-stock-calendar-v1" && (
            <div
              className="chart-wrap"
              aria-label="Actual and expected daily eggs"
            >
              <ResponsiveContainer width="100%" height={260}>
                <LineChart
                  data={report.rows.map((r) => ({
                    date: r.date,
                    actual: r.eggs,
                    expected: r.forecast?.gross ?? null,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line
                    name="Recorded gross eggs"
                    type="linear"
                    dataKey="actual"
                    stroke="#23754b"
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    name="Scenario expected eggs"
                    type="linear"
                    dataKey="expected"
                    stroke="#ac701a"
                    dot={false}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="table-scroll">
            <table aria-label="Daily layer hen-days">
              <thead>
                <tr>
                  <th>Date / record</th>
                  <th>Opening hens</th>
                  <th>Deaths</th>
                  <th>Closing hens</th>
                  <th>Eggs / cracked / saleable</th>
                  <th>Feed kg</th>
                  <th>Hen-day %</th>
                  <th>Expected eggs</th>
                  <th>Gross variance</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.date}>
                    <td>
                      {r.date}
                      <small className="recipe-version-id">
                        {r.recordId ?? "Missing daily record"}
                      </small>
                    </td>
                    <td>{v(r.openingHens)}</td>
                    <td>{v(r.mortality)}</td>
                    <td>{v(r.closingHens)}</td>
                    <td>
                      {v(r.eggs)} / {v(r.cracked)} / {v(r.saleable)}
                    </td>
                    <td>{v(r.feedKg)}</td>
                    <td>{v(r.henDayPercent)}</td>
                    <td>{v(r.forecast?.gross)}</td>
                    <td>{v(r.grossDelta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Source coverage and traceability</summary>
            <p>
              Generated {report.generatedAt} · {report.timezone} ·{" "}
              {report.modelVersion}
            </p>
            <p className="recipe-version-id">
              Snapshot SHA-256: {report.evidenceSha256}
            </p>
            <p>
              Missing selected dates:{" "}
              {report.coverage.missingDates.join(", ") || "None"}. First missing
              history: {report.coverage.firstMissingHistory ?? "None"}.
            </p>
          </details>
        </section>
      )}
    </section>
  );
}
