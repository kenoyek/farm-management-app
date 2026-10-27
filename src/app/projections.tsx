"use client";
import { useEffect, useState } from "react";
import { Download, Save, RotateCcw } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { api, downloadCsv } from "@/lib/client";
import {
  workbookWeeks,
  workbookEggPeriods,
  type FeedWeek,
  type EggPeriod,
  type feedForecast,
  type eggForecast,
} from "@/lib/forecast";
type FeedResult = ReturnType<typeof feedForecast>;
type EggResult = ReturnType<typeof eggForecast>;
type Scenario = {
  id: string;
  name: string;
  kind: "layer-feed" | "layer-eggs";
  input: Record<string, unknown>;
  result: FeedResult | EggResult;
  created_at: string;
};
export default function Projections({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const [kind, setKind] = useState<"layer-feed" | "layer-eggs">("layer-feed"),
    [name, setName] = useState("Workbook feed baseline"),
    [opening, setOpening] = useState(500),
    [weeks, setWeeks] = useState<FeedWeek[]>(workbookWeeks),
    [periods, setPeriods] = useState<EggPeriod[]>(workbookEggPeriods),
    [startMonth, setStartMonth] = useState(
      new Date().toISOString().slice(0, 7),
    ),
    [traySize, setTraySize] = useState(30),
    [legacy, setLegacy] = useState(false),
    [result, setResult] = useState<FeedResult | EggResult | null>(null),
    [saved, setSaved] = useState<Scenario[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [compare, setCompare] = useState("");
  useEffect(() => {
    let active = true;
    void api<Scenario[]>(`forecasts?organizationId=${organizationId}`)
      .then((r) => {
        if (active) setSaved(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  const payload =
    kind === "layer-feed"
      ? { organizationId, name, kind, opening, weeks }
      : {
          organizationId,
          name,
          kind,
          opening,
          startMonth,
          traySize,
          legacy28: legacy,
          periods,
        };
  async function calculate(save = false) {
    setError("");
    setBusy(true);
    setNotice("");
    try {
      const r = await api<FeedResult | EggResult>(
        `forecasts/${save ? "save" : "calculate"}`,
        payload,
      );
      setResult(r);
      if (save) {
        setSaved(await api(`forecasts?organizationId=${organizationId}`));
        setNotice(
          "New scenario version saved. Historical records were not changed.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const feed = result && "feedKg" in result ? result : null,
    eggs = result && "eggs" in result ? result : null;
  const second = saved.find((s) => s.id === compare && s.kind === kind)?.result;
  const summary = result
    ? feed
      ? [
          ["Feed required", `${feed.feedKg.toFixed(2)} kg`],
          ["Feed cost", `₦${Number(feed.cost).toLocaleString("en-NG")}`],
          ["Closing population", feed.closing.toFixed(2)],
          ["Expected mortality", feed.deaths.toFixed(2)],
        ]
      : eggs
        ? [
            ["Gross eggs", eggs.eggs.toFixed(1)],
            ["Saleable eggs", eggs.saleable.toFixed(1)],
            ["Tray equivalents", eggs.trays.toFixed(2)],
            ["Closing birds", eggs.closing.toFixed(2)],
          ]
        : []
    : [];
  return (
    <section className="module">
      <div className="module-tabs">
        {[
          ["layer-feed", "Layer feed"],
          ["layer-eggs", "Egg production"],
        ].map(([k, label]) => (
          <button
            key={k}
            className={kind === k ? "selected" : ""}
            onClick={() => {
              setKind(k as typeof kind);
              setOpening(k === "layer-feed" ? 500 : 1418);
              setName(
                k === "layer-feed"
                  ? "Workbook feed baseline"
                  : "Egg production forecast",
              );
              setResult(null);
              setCompare("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="panel module-panel">
        <div className="panel-heading">
          <h2>Scenario assumptions</h2>
          <span className="tag">FORECAST · NOT ACTUALS</span>
        </div>
        <div className="editor-settings">
          <label>
            Scenario name
            <input
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
                setResult(null);
              }}
            />
          </label>
          <label>
            Opening birds
            <input
              type="number"
              min="1"
              value={opening}
              onChange={(e) => {
                setOpening(Number(e.target.value));
                setResult(null);
              }}
            />
          </label>
          <label>
            Projection length ({kind === "layer-feed" ? "weeks" : "months"})
            <input
              type="number"
              min="1"
              max={kind === "layer-feed" ? 104 : 60}
              value={kind === "layer-feed" ? weeks.length : periods.length}
              onChange={(e) => {
                const n = Math.max(
                  1,
                  Math.min(
                    kind === "layer-feed" ? 104 : 60,
                    Number(e.target.value),
                  ),
                );
                if (kind === "layer-feed")
                  setWeeks(
                    Array.from(
                      { length: n },
                      (_, i) =>
                        weeks[i] ?? {
                          ration: 115,
                          price: 290,
                          mortality: 0.001,
                        },
                    ),
                  );
                else
                  setPeriods(
                    Array.from(
                      { length: n },
                      (_, i) =>
                        periods[i] ?? {
                          lay: 0.8,
                          mortality: 0.005,
                          cracks: 0.005,
                        },
                    ),
                  );
                setResult(null);
              }}
            />
          </label>
        </div>
        {kind === "layer-eggs" && (
          <div className="editor-settings">
            <label>
              Starting month
              <input
                type="month"
                value={startMonth}
                onChange={(e) => {
                  setStartMonth(e.target.value);
                  setResult(null);
                }}
              />
            </label>
            <label>
              Eggs per tray
              <input
                type="number"
                min="1"
                value={traySize}
                onChange={(e) => {
                  setTraySize(Number(e.target.value));
                  setResult(null);
                }}
              />
            </label>
            <label>
              Period model
              <select
                value={legacy ? "legacy" : "calendar"}
                onChange={(e) => {
                  setLegacy(e.target.value === "legacy");
                  setResult(null);
                }}
              >
                <option value="calendar">Actual calendar months</option>
                <option value="legacy">
                  Workbook baseline · 28-day periods
                </option>
              </select>
            </label>
          </div>
        )}
        <div className="table-scroll schedule-table">
          <table>
            <thead>
              <tr>
                <th>{kind === "layer-feed" ? "Week" : "Month"}</th>
                <th>
                  {kind === "layer-feed"
                    ? "Ration (g/bird/day)"
                    : "Laying rate %"}
                </th>
                <th>
                  {kind === "layer-feed"
                    ? "Feed price (₦/kg)"
                    : "Cracked eggs %"}
                </th>
                <th>Mortality % / period</th>
              </tr>
            </thead>
            <tbody>
              {kind === "layer-feed"
                ? weeks.map((w, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      {(["ration", "price", "mortality"] as const).map((k) => (
                        <td key={k}>
                          <input
                            aria-label={`Week ${i + 1} ${k}`}
                            type="number"
                            step="0.01"
                            min="0"
                            value={
                              k === "mortality"
                                ? Number((w[k] * 100).toFixed(5))
                                : w[k]
                            }
                            onChange={(e) => {
                              setWeeks(
                                weeks.map((row, j) =>
                                  j === i
                                    ? {
                                        ...row,
                                        [k]:
                                          Number(e.target.value) /
                                          (k === "mortality" ? 100 : 1),
                                      }
                                    : row,
                                ),
                              );
                              setResult(null);
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))
                : periods.map((p, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      {(["lay", "cracks", "mortality"] as const).map((k) => (
                        <td key={k}>
                          <input
                            aria-label={`Month ${i + 1} ${k}`}
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={Number((p[k] * 100).toFixed(5))}
                            onChange={(e) => {
                              setPeriods(
                                periods.map((row, j) =>
                                  j === i
                                    ? {
                                        ...row,
                                        [k]: Number(e.target.value) / 100,
                                      }
                                    : row,
                                ),
                              );
                              setResult(null);
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        <div className="editor-actions">
          <button
            className="secondary"
            onClick={() => {
              setWeeks(workbookWeeks);
              setPeriods(workbookEggPeriods);
              setOpening(kind === "layer-feed" ? 500 : 1418);
              setLegacy(true);
              setResult(null);
            }}
          >
            <RotateCcw size={14} />
            Restore workbook assumptions
          </button>
          <div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void calculate()}
            >
              Calculate
            </button>
            <button
              className="primary"
              disabled={
                busy || !["owner", "admin", "manager", "worker"].includes(role)
              }
              onClick={() => void calculate(true)}
            >
              <Save size={14} />
              Save scenario
            </button>
          </div>
        </div>
        <p className="helper">
          Mortality uses opening population; feed and egg output use an
          opening-stock approximation. Decimal birds and eggs are expected
          values, not physical counts. These assumptions are editable and are
          not scientific recommendations.
        </p>
      </div>
      {result && (
        <>
          <div className="stats-grid">
            {summary.map(([label, value]) => (
              <article className="stat panel" key={label}>
                <span className="stat-label">{label}</span>
                <strong className="forecast-value">{value}</strong>
              </article>
            ))}
          </div>
          <div className="panel module-panel">
            <div className="panel-heading">
              <h2>{feed ? "Weekly feed demand" : "Expected saleable eggs"}</h2>
              <button
                className="text-button"
                onClick={() => {
                  const rows = result.rows as unknown as Record<
                    string,
                    string | number
                  >[];
                  const keys = Object.keys(rows[0]);
                  downloadCsv("farmstead-forecast.csv", [
                    ["Scenario", name],
                    ["Model", result.modelVersion],
                    keys,
                    ...rows.map((r) => keys.map((k) => r[k])),
                  ]);
                }}
              >
                <Download size={14} />
                Export CSV
              </button>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart
                  data={
                    feed
                      ? feed.rows.map((r) => ({
                          period: r.week,
                          value: r.feedKg,
                        }))
                      : eggs!.rows.map((r) => ({
                          period: r.period,
                          value: r.saleable,
                        }))
                  }
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="period" fontSize={10} />
                  <YAxis fontSize={10} />
                  <Tooltip />
                  <Area
                    dataKey="value"
                    name={feed ? "Feed (kg)" : "Saleable eggs"}
                    stroke="#47764d"
                    fill="#c6d8af"
                    fillOpacity={0.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="helper">
              Model: {result.modelVersion}. Projected values only.
            </p>
          </div>
        </>
      )}
      <div className="panel">
        <div className="panel-heading">
          <h2>Saved scenarios</h2>
          {result && (
            <select
              aria-label="Compare scenario"
              className="compact-select"
              value={compare}
              onChange={(e) => setCompare(e.target.value)}
            >
              <option value="">Compare with a saved scenario</option>
              {saved
                .filter((s) => s.kind === kind)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          )}
        </div>
        {result && second && (
          <div className="comparison">
            <strong>
              Current vs. {saved.find((s) => s.id === compare)?.name}
            </strong>
            {"feedKg" in result && "feedKg" in second ? (
              <p>
                Feed: {result.feedKg.toFixed(2)} vs {second.feedKg.toFixed(2)}{" "}
                kg · Cost: ₦{result.cost} vs ₦{second.cost}
              </p>
            ) : "eggs" in result && "eggs" in second ? (
              <p>
                Saleable: {result.saleable.toFixed(1)} vs{" "}
                {second.saleable.toFixed(1)} eggs · Trays:{" "}
                {result.trays.toFixed(2)} vs {second.trays.toFixed(2)}
              </p>
            ) : null}
          </div>
        )}
        {saved.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Type</th>
                  <th>Model version</th>
                  <th>Saved</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.kind}</td>
                    <td>{s.result.modelVersion}</td>
                    <td>
                      {new Date(s.created_at).toLocaleDateString("en-NG")}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => {
                          setKind(s.kind);
                          setName(s.name + " · copy");
                          setOpening(s.input.opening as number);
                          if (s.kind === "layer-feed")
                            setWeeks(s.input.weeks as FeedWeek[]);
                          else {
                            setPeriods(s.input.periods as EggPeriod[]);
                            setStartMonth(s.input.startMonth as string);
                            setTraySize(s.input.traySize as number);
                            setLegacy(s.input.legacy28 as boolean);
                          }
                          setResult(s.result);
                          setCompare("");
                        }}
                      >
                        Load as new scenario
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            Save a scenario to preserve its assumptions and results.
          </div>
        )}
      </div>
    </section>
  );
}
