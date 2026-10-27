"use client";
import { useDialog } from "@/lib/use-dialog";
import { useEffect, useState, type FormEvent } from "react";
import { Plus, ClipboardList, Download, Activity } from "lucide-react";
import { api, downloadCsv } from "@/lib/client";
import { biomass, specificGrowthRate, fcr } from "@/lib/forecast";
type Unit = {
  id: string;
  farm_id: string;
  name: string;
  kind: "layers" | "broilers" | "catfish";
  stocked_on: string;
  opening_count: number;
  initial_weight_g: string;
};
type RecordRow = {
  id: string;
  unit_id: string;
  recorded_on: string;
  mortality: number;
  eggs: number;
  cracked: number;
  feed_kg: string;
  average_weight_g: string | null;
  sample_size: number | null;
  water_quality: {
    temperature: number | null;
    ph: number | null;
    oxygen: number | null;
    ammonia: number | null;
  } | null;
  notes: string;
};
type Farm = { id: string; name: string };
export default function Production({
  organizationId,
  role,
  farms,
}: {
  organizationId: string;
  role: string;
  farms: Farm[];
}) {
  const [units, setUnits] = useState<Unit[]>([]),
    [records, setRecords] = useState<RecordRow[]>([]),
    [unitId, setUnitId] = useState(""),
    [modal, setModal] = useState<"unit" | "record" | null>(null),
    [newKind, setNewKind] = useState("layers"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ units: Unit[]; records: RecordRow[] }>(
      `production?organizationId=${organizationId}`,
    )
      .then((r) => {
        if (active) {
          setUnits(r.units);
          setRecords(r.records);
          setUnitId(r.units[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  useDialog(!!modal, () => {
    if (!busy) setModal(null);
  });
  const refresh = async () => {
    const r = await api<{ units: Unit[]; records: RecordRow[] }>(
      `production?organizationId=${organizationId}`,
    );
    setUnits(r.units);
    setRecords(r.records);
    return r;
  };
  const unit = units.find((u) => u.id === unitId),
    rows = records.filter((r) => r.unit_id === unitId),
    mortality = rows.reduce((s, r) => s + r.mortality, 0),
    live = (unit?.opening_count ?? 0) - mortality,
    feed = rows.reduce((s, r) => s + Number(r.feed_kg), 0),
    eggs = rows.reduce((s, r) => s + r.eggs - r.cracked, 0),
    latestSample = rows.filter((r) => r.average_weight_g !== null).at(-1),
    weight = Number(
      latestSample?.average_weight_g ?? unit?.initial_weight_g ?? 0,
    ),
    initial = unit
      ? biomass(unit.opening_count, Number(unit.initial_weight_g))
      : 0,
    current = biomass(live, weight);
  const days =
    unit && latestSample
      ? Math.floor(
          (Date.parse(latestSample.recorded_on) - Date.parse(unit.stocked_on)) /
            86400000,
        )
      : 0;
  const canRecord = ["owner", "admin", "manager", "worker"].includes(role),
    canStock = ["owner", "admin", "manager"].includes(role);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (modal === "unit") {
        const r = await api<{ id: string }>("units", {
          organizationId,
          farmId: f.get("farm"),
          name: f.get("name"),
          kind: newKind,
          stockedOn: f.get("stockedOn"),
          openingCount: Number(f.get("count")),
          initialWeightG: Number(f.get("weight")),
        });
        await refresh();
        setUnitId(r.id);
        setNotice("Production unit stocked.");
      } else {
        const nullable = (k: string) =>
          f.get(k) === "" || f.get(k) === null ? null : Number(f.get(k));
        await api("records", {
          organizationId,
          unitId,
          recordedOn: f.get("date"),
          mortality: Number(f.get("mortality")),
          eggs: Number(f.get("eggs") ?? 0),
          cracked: Number(f.get("cracked") ?? 0),
          feedKg: Number(f.get("feed")),
          averageWeightG: nullable("weight"),
          sampleSize: nullable("sampleSize"),
          waterQuality:
            unit?.kind === "catfish"
              ? {
                  temperature: nullable("temperature"),
                  ph: nullable("ph"),
                  oxygen: nullable("oxygen"),
                  ammonia: nullable("ammonia"),
                }
              : null,
          notes: String(f.get("notes") ?? ""),
        });
        await refresh();
        setNotice("Daily record saved. Stock and production totals updated.");
      }
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="module">
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
      <div className="production-toolbar">
        <label>
          Production unit
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">Choose a flock, batch or pond</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.kind}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={!canStock || !farms.length}
          onClick={() => {
            setModal("unit");
            setError("");
          }}
        >
          <Plus size={15} />
          Stock a production unit
        </button>
      </div>
      {!unit ? (
        <section className="panel empty">
          <ClipboardList size={35} />
          <h2>Start with a flock, batch or pond</h2>
          <p>
            {farms.length
              ? "Record stocking details, then keep a daily record of feed, mortality, eggs and growth."
              : "Register a farm before creating production units."}
          </p>
        </section>
      ) : (
        <>
          <div className="unit-banner panel">
            <div>
              <span className="eyebrow">
                {unit.kind.toUpperCase()} ·{" "}
                {farms.find((f) => f.id === unit.farm_id)?.name}
              </span>
              <h2>{unit.name}</h2>
              <p>
                Stocked {unit.opening_count.toLocaleString()} on{" "}
                {unit.stocked_on} · Initial average {unit.initial_weight_g} g
              </p>
            </div>
            <button
              className="primary"
              disabled={!canRecord}
              onClick={() => {
                setModal("record");
                setError("");
              }}
            >
              <Plus size={15} />
              Add daily record
            </button>
          </div>
          <div className="stats-grid">
            {[
              ["Live population", live.toLocaleString()],
              ["Feed recorded", `${feed.toFixed(2)} kg`],
              unit.kind === "layers"
                ? ["Saleable eggs", eggs.toLocaleString()]
                : ["Estimated biomass", `${current.toFixed(2)} kg`],
              [
                "Mortality",
                `${mortality} (${((100 * mortality) / unit.opening_count).toFixed(2)}%)`,
              ],
            ].map(([label, value]) => (
              <article className="stat panel" key={label}>
                <span className="stat-label">{label}</span>
                <strong className="forecast-value">{value}</strong>
              </article>
            ))}
          </div>
          {unit.kind !== "layers" && (
            <div className="panel performance">
              <Activity size={22} />
              <div>
                <h3>Growth and feed efficiency</h3>
                <p>
                  Latest average: {weight.toFixed(2)} g{" "}
                  {latestSample
                    ? `from ${latestSample.sample_size} sampled animals on ${latestSample.recorded_on}`
                    : "from initial stocking weight only"}
                  .{" "}
                  {days > 0
                    ? `Average daily gain: ${((weight - Number(unit.initial_weight_g)) / days).toFixed(2)} g/day. `
                    : ""}
                  {unit.kind === "catfish" && days > 0
                    ? `Specific growth rate: ${specificGrowthRate(Number(unit.initial_weight_g), weight, days).toFixed(2)}%/day. `
                    : ""}
                </p>
                <p>
                  {latestSample &&
                  latestSample.recorded_on === rows.at(-1)?.recorded_on &&
                  current > initial &&
                  mortality === 0
                    ? `Recorded FCR: ${fcr(feed, current - initial).toFixed(3)} kg feed/kg live biomass gain. Includes recorded feed only; requires a complete feed log.`
                    : "FCR is unavailable until the latest record has a weight sample and positive biomass gain, with no deaths. Mortality-adjusted cohort FCR requires measured lost biomass."}
                </p>
                <p>
                  Biomass is an estimate from the latest sample. Feeding rates
                  and water-quality thresholds require approved species and
                  system-specific guidance.
                </p>
              </div>
            </div>
          )}
          {unit.kind === "layers" && (
            <div className="record-note">
              <span>
                {Math.floor(eggs / 30)} complete 30-egg trays + {eggs % 30} eggs
                from recorded collections. Egg sales and physical inventory must
                be reconciled separately.
              </span>
            </div>
          )}
          <section className="panel">
            <div className="panel-heading">
              <h2>Daily production records</h2>
              <button
                className="text-button"
                disabled={!rows.length}
                onClick={() =>
                  downloadCsv("production-records.csv", [
                    ["Unit", unit.name],
                    [
                      "Date",
                      "Mortality",
                      "Feed kg",
                      "Eggs",
                      "Cracked eggs",
                      "Average weight g",
                      "Sample size",
                      "Temperature C",
                      "pH",
                      "Oxygen mg/L",
                      "Ammonia mg/L",
                      "Notes",
                    ],
                    ...rows.map((r) => [
                      r.recorded_on,
                      r.mortality,
                      r.feed_kg,
                      r.eggs,
                      r.cracked,
                      r.average_weight_g,
                      r.sample_size,
                      r.water_quality?.temperature ?? null,
                      r.water_quality?.ph ?? null,
                      r.water_quality?.oxygen ?? null,
                      r.water_quality?.ammonia ?? null,
                      r.notes,
                    ]),
                  ])
                }
              >
                <Download size={14} />
                Export CSV
              </button>
            </div>
            {rows.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Feed kg</th>
                      <th>Deaths</th>
                      <th>
                        {unit.kind === "layers"
                          ? "Eggs / cracked"
                          : "Sample weight / size"}
                      </th>
                      {unit.kind === "catfish" && <th>Water quality</th>}
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].reverse().map((r) => (
                      <tr key={r.id}>
                        <td>{r.recorded_on}</td>
                        <td>{r.feed_kg}</td>
                        <td>{r.mortality}</td>
                        <td>
                          {unit.kind === "layers"
                            ? `${r.eggs} / ${r.cracked}`
                            : r.average_weight_g
                              ? `${r.average_weight_g} g / ${r.sample_size}`
                              : "Not sampled"}
                        </td>
                        {unit.kind === "catfish" && (
                          <td>
                            {r.water_quality
                              ? `pH ${r.water_quality.ph ?? "—"} · ${r.water_quality.temperature ?? "—"}°C · O₂ ${r.water_quality.oxygen ?? "—"} mg/L · NH₃ ${r.water_quality.ammonia ?? "—"} mg/L`
                              : "Not measured"}
                          </td>
                        )}
                        <td>{r.notes || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                <h3>Your first daily record</h3>
                <p>
                  Track what happened today. Future dates and mortality above
                  the live stock are rejected.
                </p>
              </div>
            )}
            <p className="helper">
              Records are append-only, one per unit per day, in date order.
              Enter older records first. No forecasts are posted here. Record
              corrections, transfers and partial harvests require a later
              reconciliation workflow.
            </p>
          </section>
        </>
      )}
      {modal && (
        <div className="modal-backdrop">
          <section
            className="modal panel wide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="production-title"
          >
            <div className="panel-heading">
              <h2 id="production-title">
                {modal === "unit"
                  ? "Stock a production unit"
                  : "Add daily production record"}
              </h2>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Close
              </button>
            </div>
            <form onSubmit={(e) => void submit(e)}>
              <div className="form-grid">
                {modal === "unit" ? (
                  <>
                    <label>
                      Farm
                      <select name="farm" required>
                        {farms.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Production type
                      <select
                        value={newKind}
                        onChange={(e) => setNewKind(e.target.value)}
                      >
                        <option value="layers">Layer flock</option>
                        <option value="broilers">Broiler batch</option>
                        <option value="catfish">Catfish pond batch</option>
                      </select>
                    </label>
                    <label>
                      Unit name
                      <input
                        name="name"
                        required
                        minLength={2}
                        maxLength={100}
                        placeholder="e.g. House A · Flock 01"
                      />
                    </label>
                    <label>
                      Stocking date
                      <input
                        name="stockedOn"
                        type="date"
                        required
                        max={new Date().toISOString().slice(0, 10)}
                        defaultValue={new Date().toISOString().slice(0, 10)}
                      />
                    </label>
                    <label>
                      Opening population
                      <input
                        name="count"
                        type="number"
                        required
                        min="1"
                        step="1"
                      />
                    </label>
                    <label>
                      Initial average weight (g)
                      <input
                        name="weight"
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      Record date
                      <input
                        name="date"
                        type="date"
                        required
                        min={unit?.stocked_on}
                        max={new Date().toISOString().slice(0, 10)}
                        defaultValue={new Date().toISOString().slice(0, 10)}
                      />
                    </label>
                    <label>
                      Mortality (whole animals)
                      <input
                        name="mortality"
                        type="number"
                        min="0"
                        max={live}
                        step="1"
                        required
                        defaultValue={0}
                      />
                    </label>
                    <label>
                      Feed consumed (kg)
                      <input
                        name="feed"
                        type="number"
                        min="0"
                        step="0.001"
                        required
                        defaultValue={0}
                      />
                    </label>
                    {unit?.kind === "layers" ? (
                      <>
                        <label>
                          Total eggs collected
                          <input
                            name="eggs"
                            type="number"
                            min="0"
                            step="1"
                            required
                            defaultValue={0}
                          />
                        </label>
                        <label>
                          Cracked eggs included in total
                          <input
                            name="cracked"
                            type="number"
                            min="0"
                            step="1"
                            required
                            defaultValue={0}
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          Sample average weight (g, optional)
                          <input
                            name="weight"
                            type="number"
                            min="0.01"
                            step="0.01"
                          />
                        </label>
                        <label>
                          Sample size (required with weight)
                          <input
                            name="sampleSize"
                            type="number"
                            min="1"
                            max={live}
                            step="1"
                          />
                        </label>
                      </>
                    )}
                    {unit?.kind === "catfish" && (
                      <>
                        <label>
                          Water temperature (°C)
                          <input
                            name="temperature"
                            type="number"
                            min="0"
                            max="60"
                            step="0.1"
                          />
                        </label>
                        <label>
                          pH
                          <input
                            name="ph"
                            type="number"
                            min="0"
                            max="14"
                            step="0.01"
                          />
                        </label>
                        <label>
                          Dissolved oxygen (mg/L)
                          <input
                            name="oxygen"
                            type="number"
                            min="0"
                            step="0.01"
                          />
                        </label>
                        <label>
                          Ammonia (mg/L)
                          <input
                            name="ammonia"
                            type="number"
                            min="0"
                            step="0.01"
                          />
                        </label>
                      </>
                    )}
                  </>
                )}
              </div>
              {modal === "record" && (
                <label className="field">
                  Observations
                  <textarea name="notes" maxLength={2000} />
                </label>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-actions">
                <button className="primary" disabled={busy}>
                  {busy ? "Saving…" : "Save record"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
