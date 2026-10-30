"use client";
import { useEffect, useState } from "react";
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
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  broilerPlanInput,
  type BroilerPlanInput,
  type PlanWorkspace,
  type PlanReport,
  type BroilerPlanData,
} from "@/lib/broiler-planning";
type Stage = Record<keyof BroilerPlanData["stages"][number], string>;
type Target = { ageDays: string; weightG: string; evidence: string };
const blankStage = (): Stage => ({
  stage: "",
  startAge: "",
  endAge: "",
  rationG: "",
  mortalityDaily: "",
  pricePerKg: "",
  recipeId: "",
  tempMinC: "",
  tempMaxC: "",
  evidence: "",
});
const baseFields = [
  ["name", "Plan name"],
  ["house", "Poultry house · optional"],
  ["strain", "Breed / strain · optional"],
  ["supplier", "Chick supplier · optional"],
  ["hatchDate", "Hatch date · optional"],
  ["startingAgeDays", "Age at placement (days)"],
  ["harvestAgeDays", "Planned harvest age (days)"],
  ["currency", "Planning currency"],
  ["chickCostPerBird", "Chick price per bird · optional"],
  ["targetMarketWeightG", "Market weight goal (g) · optional"],
  ["salePrice", "Planned live sale price · optional"],
  ["sourceTitle", "Guide title"],
  ["sourceReference", "Guide version / page / source reference"],
  ["notes", "Planning notes · optional"],
] as const;
export default function BroilerPlanning({
  organizationId,
  unitId,
  actor,
  canPlan,
}: {
  organizationId: string;
  unitId: string;
  actor: string;
  canPlan: boolean;
}) {
  const [w, setW] = useState<PlanWorkspace | null>(null),
    [fields, setFields] = useState<Record<string, string>>({}),
    [stages, setStages] = useState<Stage[]>([blankStage()]),
    [targets, setTargets] = useState<Target[]>([
      { ageDays: "", weightG: "", evidence: "" },
    ]),
    [working, setWorking] = useState(false),
    [dirty, setDirty] = useState(false),
    [previous, setPrevious] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(true),
    [pending, setPending] = useState<BroilerPlanInput | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] = useState<PlanReport["forecast"] | null>(null);
  const endpoint = `broilers/plans?organizationId=${organizationId}&unitId=${unitId}`,
    storageKey = `farmstead:broiler-plan:v1:${organizationId}:${actor}:${unitId}`;
  function fill(p: BroilerPlanData | null, u: PlanWorkspace) {
    setFields(
      p
        ? {
            ...Object.fromEntries(
              baseFields.map(([k]) => [k, String(p[k] ?? "")]),
            ),
            saleBasis: p.saleBasis,
          }
        : {
            name: u.unit.name + " plan",
            currency: u.currency,
            saleBasis: "unpriced",
          },
    );
    setStages(
      p
        ? p.stages.map(
            (s) =>
              Object.fromEntries(
                Object.entries(s).map(([k, v]) => [k, String(v ?? "")]),
              ) as Stage,
          )
        : [blankStage()],
    );
    setTargets(
      p
        ? p.targets.map((t) => ({
            ageDays: String(t.ageDays),
            weightG: t.weightG,
            evidence: t.evidence,
          }))
        : [{ ageDays: "", weightG: "", evidence: "" }],
    );
    setPreview(null);
    setDirty(false);
  }
  useEffect(() => {
    let active = true;
    void api<PlanWorkspace>(endpoint)
      .then((v) => {
        if (active) {
          setW(v);
          fill(v.selected?.source.input ?? null, v);
          setPrevious(v.history[0]?.id ?? null);
          setWorking(!v.selected);
          setStale(false);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const p = broilerPlanInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === organizationId &&
            p.data.unitId === unitId
          )
            setPending(p.data);
          else
            setStorageWarning(
              "The saved planning receipt could not be read. Review history before repeating the save.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until a save is confirmed.",
        );
      }
    });
  }, [storageKey, organizationId, unitId]);
  useEffect(() => {
    if (!pending && !dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, dirty]);
  function remember(p: BroilerPlanInput | null) {
    setPending(p);
    try {
      if (p) sessionStorage.setItem(storageKey, JSON.stringify(p));
      else sessionStorage.removeItem(storageKey);
    } catch {
      setStorageWarning(
        "Tab recovery storage is unavailable. Keep this page open until the save is confirmed.",
      );
    }
  }
  async function reload(id?: string) {
    const v = await api<PlanWorkspace>(endpoint + (id ? "&planId=" + id : ""));
    setW(v);
    fill(v.selected?.source.input ?? null, v);
    setPrevious(v.history[0]?.id ?? null);
    setWorking(!v.selected);
    setStale(false);
  }
  async function load(id?: string) {
    setBusy(true);
    setError("");
    try {
      await reload(id);
    } catch (e) {
      setError((e as Error).message);
      setStale(true);
    } finally {
      setBusy(false);
    }
  }
  async function save(p: BroilerPlanInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/plans", p);
      committed = true;
      await reload(p.planId);
      remember(null);
      setNotice(
        "Broiler plan version saved. Actual production and stock are unchanged.",
      );
    } catch (e) {
      setError((e as Error).message);
      if (
        !committed &&
        e instanceof ApiError &&
        [400, 403, 404, 409, 422].includes(e.status)
      ) {
        remember(null);
        if ([403, 409].includes(e.status)) setStale(true);
      }
    } finally {
      setBusy(false);
    }
  }
  function payload() {
    const nullable = (v: string | undefined) => (v ? v : null);
    return broilerPlanInput.safeParse({
      organizationId,
      unitId,
      planId: crypto.randomUUID(),
      previousId: previous,
      data: {
        ...Object.fromEntries(baseFields.map(([k]) => [k, fields[k] ?? ""])),
        house: nullable(fields.house),
        strain: nullable(fields.strain),
        supplier: nullable(fields.supplier),
        hatchDate: nullable(fields.hatchDate),
        startingAgeDays: Number(fields.startingAgeDays),
        harvestAgeDays: Number(fields.harvestAgeDays),
        chickCostPerBird: nullable(fields.chickCostPerBird),
        targetMarketWeightG: nullable(fields.targetMarketWeightG),
        saleBasis: fields.saleBasis,
        salePrice: nullable(fields.salePrice),
        stages: stages.map((s) => ({
          ...s,
          startAge: Number(s.startAge),
          endAge: Number(s.endAge),
          rationG: nullable(s.rationG),
          mortalityDaily: nullable(s.mortalityDaily),
          pricePerKg: nullable(s.pricePerKg),
          recipeId: nullable(s.recipeId),
          tempMinC: nullable(s.tempMinC),
          tempMaxC: nullable(s.tempMaxC),
        })),
        targets: targets.map((t) => ({ ...t, ageDays: Number(t.ageDays) })),
      },
    });
  }
  async function submit(intent: string) {
    if (!w || pending || stale || !working) return;
    const p = payload();
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    if (intent === "save") {
      await save(p.data);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{ forecast: PlanReport["forecast"] }>(
        "broilers/plans/preview",
        p.data,
      );
      setPreview(r.forecast);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const disabled = !canPlan || !working || busy || stale || !!pending,
    result = preview ?? w?.selected?.forecast;
  const changed = (key: string, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setPreview(null);
  };
  const actualByDate = new Map(
    (w?.actualRecords ?? []).map((r) => [r.recorded_on, r]),
  );
  const chart = result
    ? [
        ...result.rows.map((r) => ({
          date: r.date,
          guide: Number(r.targetWeightG),
          sample: actualByDate.get(r.date)?.average_weight_g
            ? Number(actualByDate.get(r.date)!.average_weight_g)
            : null,
        })),
        {
          date: result.plannedHarvestDate,
          guide: Number(result.harvestWeightG),
          sample: actualByDate.get(result.plannedHarvestDate)?.average_weight_g
            ? Number(
                actualByDate.get(result.plannedHarvestDate)!.average_weight_g,
              )
            : null,
        },
      ]
    : [];
  return (
    <section
      className="panel broiler-planning"
      aria-label="Broiler batch planning"
    >
      <div className="panel-heading">
        <h2>Broiler batch planning</h2>
        <button
          className="text-button"
          disabled={busy || !!pending}
          onClick={() => void load()}
        >
          Reload planning and observations
        </button>
      </div>
      <p>
        Save a sourced feed, brooding and growth guide for this placed batch.
        Opening-day feed uses expected opening birds; daily mortality is an
        explicit fraction. Weight targets interpolate linearly from the original
        placement weight. No guide is supplied automatically.
      </p>
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
      {storageWarning && <p className="notice">{storageWarning}</p>}
      {working && dirty && !pending && (
        <p className="helper">
          Reloading planning history replaces unsaved inputs. Download a working
          copy first if you need to retain them.
        </p>
      )}
      {pending && (
        <div className="record-note">
          <p>
            Planning receipt {pending.planId} needs confirmation. Retry the
            original receipt to avoid a duplicate version.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry broiler plan receipt
          </button>
          <button
            className="text-button"
            onClick={() => downloadJson("broiler-plan-pending.json", pending)}
          >
            Download pending plan receipt
          </button>
        </div>
      )}
      {!w ? (
        <p>Load the batch before preparing a plan.</p>
      ) : (
        <>
          <p className="helper">
            Original placement: {w.unit.stocked_on} · {w.unit.opening_count}{" "}
            birds · {w.unit.initial_weight_g} g. Observations reflect the last
            load; reload after recording changes. Planning money uses its
            declared currency without conversion.
          </p>
          {w.history.length > 0 && (
            <label>
              Saved planning version
              <select
                disabled={busy || working || !!pending}
                value={w.selected?.source.id ?? ""}
                onChange={(e) => void load(e.target.value)}
              >
                {w.history.map((p) => (
                  <option key={p.id} value={p.id}>
                    Revision {p.revision} · {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canPlan && !working && (
            <button
              className="primary"
              disabled={busy || !!pending || stale}
              onClick={() => {
                fill(w.selected?.source.input ?? null, w);
                setPrevious(w.history[0]?.id ?? null);
                setWorking(true);
                setNotice("");
              }}
            >
              Prepare a new plan revision
            </button>
          )}
          {working && (
            <>
              <p>
                These are unsaved planning inputs. A new version supersedes the
                latest loaded revision {w.history[0]?.revision ?? "none"} and
                preserves earlier versions.
              </p>
              <button
                className="text-button"
                onClick={() => {
                  const p = payload();
                  downloadJson(
                    "broiler-planning-working-copy.json",
                    p.success ? p.data : { fields, stages, targets },
                  );
                }}
              >
                Download working planning inputs
              </button>
              {!pending && w.selected && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    fill(w.selected!.source.input, w);
                    setWorking(false);
                  }}
                >
                  Discard unsaved planning inputs
                </button>
              )}
            </>
          )}
          <form
            onChange={() => setDirty(true)}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button[type="button"]'))
                setDirty(true);
            }}
            onSubmit={(e) => {
              e.preventDefault();
              const intent =
                (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
                  "value",
                ) ?? "preview";
              void submit(intent);
            }}
          >
            <fieldset disabled={disabled} className="broiler-fields">
              <legend>Planning source and assumptions</legend>
              <div className="form-grid">
                {baseFields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      value={fields[key] ?? ""}
                      required={[
                        "name",
                        "startingAgeDays",
                        "harvestAgeDays",
                        "currency",
                        "sourceTitle",
                        "sourceReference",
                      ].includes(key)}
                      type={
                        key === "hatchDate"
                          ? "date"
                          : [
                                "startingAgeDays",
                                "harvestAgeDays",
                                "chickCostPerBird",
                                "targetMarketWeightG",
                                "salePrice",
                              ].includes(key)
                            ? "number"
                            : "text"
                      }
                      min={key === "targetMarketWeightG" ? "0.000001" : "0"}
                      step={
                        ["startingAgeDays", "harvestAgeDays"].includes(key)
                          ? "1"
                          : key === "targetMarketWeightG"
                            ? "0.000001"
                            : "0.0001"
                      }
                      maxLength={
                        key === "notes" || key === "sourceReference"
                          ? 2000
                          : key === "sourceTitle"
                            ? 300
                            : 200
                      }
                      onChange={(e) => changed(key, e.target.value)}
                    />
                  </label>
                ))}
                <label>
                  Planned live sale basis
                  <select
                    value={fields.saleBasis ?? "unpriced"}
                    onChange={(e) => {
                      changed("saleBasis", e.target.value);
                      if (e.target.value === "unpriced")
                        changed("salePrice", "");
                    }}
                  >
                    <option value="unpriced">Unpriced · value unknown</option>
                    <option value="bird">Price per live bird</option>
                    <option value="kg">Price per live kg</option>
                  </select>
                </label>
              </div>
              <h3>Age-based feed and brooding stages</h3>
              <p className="helper">
                Cover every feed age consecutively, ending the day before
                harvest age. Blank ration, mortality, price or paired
                temperature bounds remain unknown. Saved recipe links retain
                their original status/context as references; they do not approve
                a diet or supply a price.
              </p>
              <div className="table-scroll">
                <table className="feed-schedule">
                  <thead>
                    <tr>
                      {[
                        "Stage",
                        "Start age",
                        "End age",
                        "g/bird/day",
                        "Daily death fraction",
                        "Price/kg",
                        "Saved recipe reference",
                        "Guide min °C",
                        "Guide max °C",
                        "Source page / evidence",
                        "",
                      ].map((h, i) => (
                        <th key={i}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stages.map((s, i) => (
                      <tr key={i}>
                        {(Object.keys(blankStage()) as (keyof Stage)[]).map(
                          (k) => (
                            <td key={k}>
                              {k === "stage" ? (
                                <select
                                  aria-label={`Stage ${i + 1} type`}
                                  required
                                  value={s[k]}
                                  onChange={(e) => {
                                    setStages((a) =>
                                      a.map((x, n) =>
                                        n === i
                                          ? { ...x, [k]: e.target.value }
                                          : x,
                                      ),
                                    );
                                    setPreview(null);
                                  }}
                                >
                                  <option value="">Choose stage</option>
                                  {[
                                    "pre-starter",
                                    "starter",
                                    "grower",
                                    "finisher",
                                  ].map((v) => (
                                    <option key={v}>{v}</option>
                                  ))}
                                </select>
                              ) : k === "recipeId" ? (
                                <select
                                  aria-label={`Stage ${i + 1} recipe`}
                                  value={s[k]}
                                  onChange={(e) => {
                                    setStages((a) =>
                                      a.map((x, n) =>
                                        n === i
                                          ? { ...x, [k]: e.target.value }
                                          : x,
                                      ),
                                    );
                                    setPreview(null);
                                  }}
                                >
                                  <option value="">No reference</option>
                                  {w.recipes.map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {r.name} · {r.status} ·{" "}
                                      {r.species ?? "unknown context"}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  aria-label={`Stage ${i + 1} ${k}`}
                                  value={s[k]}
                                  required={[
                                    "startAge",
                                    "endAge",
                                    "evidence",
                                  ].includes(k)}
                                  type={k === "evidence" ? "text" : "number"}
                                  min="0"
                                  step={
                                    ["startAge", "endAge"].includes(k)
                                      ? "1"
                                      : k === "mortalityDaily"
                                        ? "0.00000001"
                                        : k === "pricePerKg"
                                          ? "0.0001"
                                          : "0.000001"
                                  }
                                  maxLength={1000}
                                  onChange={(e) => {
                                    setStages((a) =>
                                      a.map((x, n) =>
                                        n === i
                                          ? { ...x, [k]: e.target.value }
                                          : x,
                                      ),
                                    );
                                    setPreview(null);
                                  }}
                                />
                              )}
                            </td>
                          ),
                        )}
                        <td>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`Remove feed stage ${i + 1}`}
                            onClick={() => {
                              setStages((a) => a.filter((_, n) => n !== i));
                              setPreview(null);
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={stages.length >= 24}
                onClick={() => (
                  setDirty(true),
                  setStages((a) => [...a, blankStage()])
                )}
              >
                Add feed stage
              </button>
              <h3>Source growth targets</h3>
              <p className="helper">
                The original placement weight anchors the curve. Supply
                increasing target ages after placement and a point at harvest
                age; cite the guide/table for each point.
              </p>
              <div className="table-scroll">
                <table className="growth-targets">
                  <thead>
                    <tr>
                      <th>Age days</th>
                      <th>Guide weight g</th>
                      <th>Source evidence</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {targets.map((t, i) => (
                      <tr key={i}>
                        {(["ageDays", "weightG", "evidence"] as const).map(
                          (k) => (
                            <td key={k}>
                              <input
                                aria-label={`Target ${i + 1} ${k}`}
                                required
                                value={t[k]}
                                type={k === "evidence" ? "text" : "number"}
                                min={k === "weightG" ? "0.000001" : "1"}
                                step={k === "weightG" ? "0.000001" : "1"}
                                maxLength={1000}
                                onChange={(e) => {
                                  setTargets((a) =>
                                    a.map((x, n) =>
                                      n === i
                                        ? { ...x, [k]: e.target.value }
                                        : x,
                                    ),
                                  );
                                  setPreview(null);
                                }}
                              />
                            </td>
                          ),
                        )}
                        <td>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`Remove growth point ${i + 1}`}
                            onClick={() => {
                              setTargets((a) => a.filter((_, n) => n !== i));
                              setPreview(null);
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={targets.length >= 60}
                onClick={() =>
                  setTargets((a) => [
                    ...a,
                    { ageDays: "", weightG: "", evidence: "" },
                  ])
                }
              >
                Add growth point
              </button>
              <label className="checkbox">
                <input
                  key={`${w.selected?.source.id ?? "new"}:${working}`}
                  type="checkbox"
                  required
                />
                I checked the supplied guide, age alignment, units and planning
                assumptions.
              </label>
              <div>
                <button className="text-button" type="submit" value="preview">
                  Preview broiler forecast
                </button>
                <button className="primary" type="submit" value="save">
                  Save broiler plan version
                </button>
              </div>
            </fieldset>
          </form>
          {result && (
            <>
              <h3>
                {preview
                  ? "Unsaved planning preview"
                  : `Saved planning forecast · revision ${w.selected!.source.revision}`}
              </h3>
              <p>
                Planned harvest {result.plannedHarvestDate} · guide weight{" "}
                {result.harvestWeightG} g · average target gain{" "}
                {result.averageDailyGainG} g/day. Expected populations are
                fractional forecasts.
              </p>
              <div className="stats-grid">
                {[
                  ["Expected closing birds", result.expectedClosingBirds],
                  ["Expected live harvest kg", result.expectedHarvestBiomassKg],
                  ["Planned feed kg", result.feedKg],
                  ["Planned feed cost", result.feedCost],
                  ["Chick cost only", result.chickCost],
                  ["Gross live value", result.expectedGrossLiveValue],
                ].map(([label, value]) => (
                  <article className="stat" key={label}>
                    <span className="stat-label">{label}</span>
                    <strong>{value ?? "Unknown"}</strong>
                  </article>
                ))}
              </div>
              <p className="helper">
                Money: {result.currency}. Feed/chick estimates are separate
                components, not total production cost, profit or cash. Guide
                references and temperature ranges are supplied assumptions, not
                automatic scientific approval or alerts.
              </p>
              <div
                className="planning-chart"
                aria-label="Guide and observed sample weight comparison"
              >
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={chart}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      name="Guide weight g"
                      dataKey="guide"
                      stroke="#247854"
                      dot={false}
                    />
                    <Line
                      name="Observed sample g"
                      dataKey="sample"
                      stroke="#c28b33"
                      connectNulls={false}
                      dot
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="helper">
                Date-matched observations are compared with opening-age guide
                weights. Sample times within a day are not inferred; missing
                samples are not zero. Actuals never change the saved guide.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date / age</th>
                      <th>Expected birds</th>
                      <th>Guide / observed g</th>
                      <th>Planned / recorded feed kg</th>
                      <th>Planned feed cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.date}>
                        <td>
                          {r.date} / {r.ageDays}
                        </td>
                        <td>
                          {r.openingBirds ?? "Unknown"} →{" "}
                          {r.closingBirds ?? "Unknown"}
                        </td>
                        <td>
                          {r.targetWeightG} /{" "}
                          {actualByDate.get(r.date)?.average_weight_g ??
                            "Not sampled"}
                        </td>
                        <td>
                          {r.feedKg ?? "Unknown"} /{" "}
                          {actualByDate.get(r.date)?.feed_kg ?? "Not recorded"}
                        </td>
                        <td>{r.feedCost ?? "Unknown"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {w.selected && !preview && (
            <>
              <p className="helper">
                Saved source SHA-256: {w.selected.evidenceSha256}. These exports
                contain this exact saved version and its original recipe
                references.
              </p>
              <div>
                {(["json", "csv"] as const).map((format) => (
                  <button
                    key={format}
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void downloadReport(
                        endpoint +
                          `&planId=${w.selected!.source.id}&format=${format}`,
                        `broiler-plan-${w.selected!.source.id}.${format}`,
                      ).catch((e) => setError(e.message))
                    }
                  >
                    Download broiler plan {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
