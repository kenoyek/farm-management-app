"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  budgetCategories,
  budgetLabels,
  economicsInput,
  type EconomicsData,
  type EconomicsInput,
  type EconomicsReport,
  type EconomicsWorkspace,
  type EconomicsComparison,
} from "@/lib/broiler-economics";
const blank = (): EconomicsData => ({
  name: "",
  saleBasis: "bird",
  salePrice: null,
  yieldFraction: null,
  priceEvidence: "",
  yieldEvidence: "",
  allocationEvidence: "",
  completeBudget: false,
  costs: budgetCategories.map((category) => ({
    category,
    amount: null,
    evidence: "",
  })),
  notes: "",
});
const money = (v: string | null) => v ?? "Unknown";
export default function BroilerEconomics({
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
  const [w, setW] = useState<EconomicsWorkspace | null>(null),
    [data, setData] = useState<EconomicsData>(blank),
    [planId, setPlanId] = useState(""),
    [previous, setPrevious] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [dirty, setDirty] = useState(false),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(true),
    [pending, setPending] = useState<EconomicsInput | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] = useState<EconomicsReport["economics"] | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [baseline, setBaseline] = useState(""),
    [comparison, setComparison] = useState<EconomicsComparison | null>(null);
  const endpoint = `broilers/economics?organizationId=${organizationId}&unitId=${unitId}`,
    storageKey = `farmstead:broiler-budget:v1:${organizationId}:${actor}:${unitId}`;
  function fill(v: EconomicsWorkspace) {
    setW(v);
    setData(v.selected?.source.input ?? blank());
    setPlanId(v.selected?.source.plan_id ?? v.plans[0]?.id ?? "");
    setPrevious(v.history[0]?.id ?? null);
    setWorking(!v.selected);
    setDirty(false);
    setAck(false);
    setPreview(null);
    setStale(false);
  }
  useEffect(() => {
    let active = true;
    void api<EconomicsWorkspace>(endpoint)
      .then((v) => {
        if (active) fill(v);
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
          const p = economicsInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === organizationId &&
            p.data.unitId === unitId
          )
            setPending(p.data);
          else
            setStorageWarning(
              "The saved budget receipt cannot be read. Review history before repeating a save.",
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
    if (!dirty && !pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);
  function remember(p: EconomicsInput | null) {
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
    fill(
      await api<EconomicsWorkspace>(endpoint + (id ? "&scenarioId=" + id : "")),
    );
  }
  async function load(id?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await reload(id);
    } catch (e) {
      setError((e as Error).message);
      setStale(true);
    } finally {
      setBusy(false);
    }
  }
  async function save(p: EconomicsInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/economics", p);
      committed = true;
      await reload(p.scenarioId);
      remember(null);
      setNotice(
        "Budget scenario saved. This is a forecast; no actual costs or sales were posted.",
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
  function change(p: Partial<EconomicsData>) {
    setData((d) => ({ ...d, ...p }));
    setDirty(true);
    setPreview(null);
    setNotice("");
  }
  function raw() {
    return {
      organizationId,
      unitId,
      scenarioId: crypto.randomUUID(),
      previousId: previous,
      planId,
      data,
    };
  }
  async function submit(saving: boolean) {
    if (!working || pending || stale) return;
    const p = economicsInput.safeParse(raw());
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    if (saving) {
      if (!ack) {
        setError("Confirm that these are planning assumptions before saving.");
        return;
      }
      await save(p.data);
      return;
    }
    setBusy(true);
    setError("");
    try {
      setPreview(
        (
          await api<{ economics: EconomicsReport["economics"] }>(
            "broilers/economics/preview",
            p.data,
          )
        ).economics,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const comparePath = `broilers/economics/compare?organizationId=${organizationId}&unitId=${unitId}&baselineId=${baseline}${selected.map((id) => "&scenarioId=" + id).join("")}`;
  async function compare() {
    setBusy(true);
    setError("");
    try {
      setComparison(await api<EconomicsComparison>(comparePath));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download(format: "json" | "csv", comparing = false) {
    setBusy(true);
    setError("");
    try {
      await downloadReport(
        (comparing
          ? comparePath
          : endpoint + "&scenarioId=" + w!.selected!.source.id) +
          "&format=" +
          format,
        `broiler-budget${comparing ? "-comparison" : ""}.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const result = working ? preview : w?.selected?.economics;
  const disabled = busy || !!pending || !working || !canPlan || stale;
  return (
    <section
      className="panel broiler-economics"
      aria-label="Broiler cost and yield planning"
    >
      <div className="panel-heading">
        <h2>Broiler cost and yield planning</h2>
        <button
          className="text-button"
          disabled={busy || !!pending}
          onClick={() => void load()}
        >
          Reload budget history and plans
        </button>
      </div>
      <p>
        Budget all expected surviving birds from one saved batch plan at its
        harvest date. Feed and chick costs come from that exact plan in its
        original currency. Choose one live or processed sale basis; there is no
        partial-sale or by-product revenue allocation.
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
      {dirty && !pending && (
        <p className="helper">
          Reloading replaces unsaved inputs. Download a working copy before
          reloading if you need to retain them.
        </p>
      )}
      {pending && (
        <div className="record-note">
          <p>
            Budget receipt {pending.scenarioId} needs confirmation. Retry this
            exact receipt to avoid a duplicate version.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry budget receipt
          </button>
          <button
            className="text-button"
            onClick={() => downloadJson("broiler-budget-pending.json", pending)}
          >
            Download pending budget receipt
          </button>
        </div>
      )}
      {!w ? (
        <p>Loading saved batch plans and budgets…</p>
      ) : (
        <>
          {!w.plans.length ? (
            <p>
              Save a broiler batch plan above, then reload budget history to
              prepare a scenario.
            </p>
          ) : (
            <>
              {!!w.history.length && (
                <label>
                  Saved budget scenario
                  <select
                    value={w.selected?.source.id ?? ""}
                    disabled={busy || working || !!pending}
                    onChange={(e) => void load(e.target.value)}
                  >
                    {w.history.map((h) => (
                      <option key={h.id} value={h.id}>
                        Revision {h.revision} · {h.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!working && canPlan && (
                <button
                  className="secondary"
                  disabled={busy || !!pending}
                  onClick={() => {
                    setWorking(true);
                    setDirty(false);
                    setPreview(null);
                    setAck(false);
                    setNotice("");
                  }}
                >
                  Prepare a new budget scenario
                </button>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(true);
                }}
              >
                <fieldset disabled={disabled}>
                  <legend>
                    {working
                      ? "Working budget assumptions"
                      : "Saved budget assumptions"}
                  </legend>
                  <div className="form-grid">
                    <label>
                      Scenario name
                      <input
                        value={data.name}
                        maxLength={100}
                        onChange={(e) => change({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      Exact saved batch plan
                      <select
                        value={planId}
                        onChange={(e) => {
                          setPlanId(e.target.value);
                          setDirty(true);
                          setPreview(null);
                        }}
                      >
                        {w.plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            Revision {p.revision} · {p.name} · {p.currency}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Budget sale basis
                      <select
                        value={data.saleBasis}
                        onChange={(e) =>
                          change({
                            saleBasis: e.target
                              .value as EconomicsData["saleBasis"],
                            yieldFraction: null,
                            yieldEvidence: "",
                          })
                        }
                      >
                        <option value="bird">Per surviving live bird</option>
                        <option value="liveKg">Per live kg</option>
                        <option value="processedKg">
                          Per saleable processed kg
                        </option>
                      </select>
                    </label>
                    <label>
                      Budget sale price · blank is unknown
                      <input
                        inputMode="decimal"
                        value={data.salePrice ?? ""}
                        onChange={(e) =>
                          change({ salePrice: e.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      Sale price source
                      <input
                        maxLength={1000}
                        value={data.priceEvidence}
                        onChange={(e) =>
                          change({ priceEvidence: e.target.value })
                        }
                      />
                    </label>
                    {data.saleBasis === "processedKg" && (
                      <>
                        <label>
                          Saleable processed yield fraction · 0 to 1
                          <input
                            inputMode="decimal"
                            value={data.yieldFraction ?? ""}
                            onChange={(e) =>
                              change({ yieldFraction: e.target.value || null })
                            }
                          />
                        </label>
                        <label>
                          Processed yield source and product definition
                          <input
                            maxLength={1000}
                            value={data.yieldEvidence}
                            onChange={(e) =>
                              change({ yieldEvidence: e.target.value })
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                  <label>
                    Cost allocation boundary and evidence
                    <textarea
                      maxLength={2000}
                      value={data.allocationEvidence}
                      onChange={(e) =>
                        change({ allocationEvidence: e.target.value })
                      }
                    />
                  </label>
                  <p className="helper">
                    State which full-cycle costs, shared-cost allocations and
                    taxes are included. Chick and feed budgets are included once
                    from the linked plan. Enter additional batch totals below;
                    do not repeat chick or feed costs. Blank is unknown; an
                    explicit zero needs evidence.
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Additional batch cost</th>
                          <th>Amount in linked plan currency</th>
                          <th>Source / allocation evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.costs.map((c, i) => (
                          <tr key={c.category}>
                            <th scope="row">{budgetLabels[c.category]}</th>
                            <td>
                              <input
                                aria-label={`${budgetLabels[c.category]} amount`}
                                inputMode="decimal"
                                value={c.amount ?? ""}
                                onChange={(e) =>
                                  change({
                                    costs: data.costs.map((r, j) =>
                                      j === i
                                        ? {
                                            ...r,
                                            amount: e.target.value || null,
                                          }
                                        : r,
                                    ),
                                  })
                                }
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${budgetLabels[c.category]} evidence`}
                                maxLength={1000}
                                value={c.evidence}
                                onChange={(e) =>
                                  change({
                                    costs: data.costs.map((r, j) =>
                                      j === i
                                        ? { ...r, evidence: e.target.value }
                                        : r,
                                    ),
                                  })
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={data.completeBudget}
                      onChange={(e) =>
                        change({ completeBudget: e.target.checked })
                      }
                    />
                    I have included all attributable costs for the stated
                    allocation boundary, including explicit zeros.
                  </label>
                  <label>
                    Budget notes · optional
                    <textarea
                      maxLength={2000}
                      value={data.notes}
                      onChange={(e) => change({ notes: e.target.value })}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    These are supplied planning assumptions. Saving does not
                    post actual stock, sales, costs or cash.
                  </label>
                  {working && canPlan && (
                    <div className="button-row">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void submit(false)}
                      >
                        Preview budget
                      </button>
                      <button className="primary" type="submit">
                        Save budget scenario
                      </button>
                    </div>
                  )}
                </fieldset>
              </form>
              {working && canPlan && (
                <div className="button-row">
                  <button
                    className="text-button"
                    disabled={busy || !!pending}
                    onClick={() =>
                      downloadJson("broiler-budget-working-copy.json", raw())
                    }
                  >
                    Download budget working copy
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || !!pending}
                    onClick={() => void load()}
                  >
                    Discard budget edits and reload
                  </button>
                </div>
              )}
              {result && (
                <div className="budget-results">
                  <h3>
                    {working
                      ? "Unsaved budget preview"
                      : `Saved budget forecast · revision ${w.selected!.source.revision}`}
                  </h3>
                  <p>
                    {result.currency} · Harvest {result.plannedHarvestDate} ·
                    Sale basis {result.saleBasis}. Yield is saleable processed
                    kg / expected live kg. No yield or scientific suitability is
                    inferred.
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Budget component</th>
                          <th>{result.currency}</th>
                          <th>Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.costs.map((c) => (
                          <tr key={c.category}>
                            <th scope="row">{c.label}</th>
                            <td>{money(c.amount)}</td>
                            <td>{c.evidence}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <dl className="budget-metrics">
                    {(
                      [
                        ["Known cost subtotal", result.knownCostSubtotal],
                        ["Total planned cost", result.totalPlannedCost],
                        ["Expected sale quantity", result.saleQuantity],
                        ["Expected revenue", result.expectedRevenue],
                        [
                          "Projected margin within declared budget",
                          result.projectedMargin,
                        ],
                        ["Margin % of revenue", result.marginPercent],
                        [
                          "Cost per surviving bird",
                          result.costPerSurvivingBird,
                        ],
                        ["Cost per live kg", result.costPerLiveKg],
                        ["Cost per processed kg", result.costPerProcessedKg],
                        [
                          "Break-even price on selected sale basis",
                          result.breakEvenSalePrice,
                        ],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{money(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  {result.issues.length > 0 && (
                    <ul>
                      {result.issues.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  )}
                  <p className="helper">
                    Margin is revenue less the confirmed declared budget, before
                    any omitted costs. It is not recorded profit or cash. All
                    survivors are assumed sold; non-saleable processing mass
                    earns no revenue in this model.
                  </p>
                </div>
              )}
              {w.selected && !working && (
                <>
                  <p className="helper">
                    Scenario {w.selected.source.id} · Plan{" "}
                    {w.selected.source.plan_id} · Saved by{" "}
                    {w.selected.source.created_by} ·{" "}
                    {w.selected.source.created_at}
                  </p>
                  <p className="evidence-hash">
                    Evidence SHA-256: {w.selected.evidenceSha256}
                  </p>
                  <div className="button-row">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void download("json")}
                    >
                      Download budget JSON
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void download("csv")}
                    >
                      Download budget CSV
                    </button>
                  </div>
                </>
              )}
              {w.history.length >= 2 && (
                <div className="budget-comparison">
                  <h3>Compare saved budget scenarios</h3>
                  <p>
                    Choose two to four versions and a baseline. Compare the
                    whole batch in the same original currency; review each
                    version’s plan, costs, product and time horizon.
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Select</th>
                          <th>Saved scenario</th>
                          <th>Linked plan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {w.history.map((h) => (
                          <tr key={h.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Compare budget revision ${h.revision}`}
                                checked={selected.includes(h.id)}
                                disabled={
                                  busy ||
                                  (!selected.includes(h.id) &&
                                    selected.length >= 4)
                                }
                                onChange={(e) => {
                                  const ids = e.target.checked
                                    ? [...selected, h.id]
                                    : selected.filter((id) => id !== h.id);
                                  setSelected(ids);
                                  setComparison(null);
                                  if (!ids.includes(baseline)) setBaseline("");
                                }}
                              />
                            </td>
                            <th scope="row">
                              Revision {h.revision} · {h.name}
                            </th>
                            <td>{h.plan_id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label>
                    Budget comparison baseline
                    <select
                      value={baseline}
                      disabled={busy}
                      onChange={(e) => {
                        setBaseline(e.target.value);
                        setComparison(null);
                      }}
                    >
                      <option value="">Choose a selected version</option>
                      {selected.map((id) => {
                        const h = w.history.find((h) => h.id === id)!;
                        return (
                          <option key={id} value={id}>
                            Revision {h.revision} · {h.name}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    disabled={busy || selected.length < 2 || !baseline}
                    onClick={() => void compare()}
                  >
                    Compare budget scenarios
                  </button>
                  {comparison && (
                    <>
                      <p>{comparison.scope}</p>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Scenario</th>
                              <th>Basis / currency</th>
                              <th>Total cost</th>
                              <th>Revenue</th>
                              <th>Margin</th>
                              <th>Margin delta to baseline</th>
                              <th>Source differences</th>
                            </tr>
                          </thead>
                          <tbody>
                            {comparison.reports.map((r) => {
                              const c = comparison.comparisons.find(
                                (c) => c.id === r.source.id,
                              )!;
                              return (
                                <tr key={r.source.id}>
                                  <th scope="row">
                                    {r.source.input.name} · revision{" "}
                                    {r.source.revision}
                                  </th>
                                  <td>
                                    {r.economics.saleBasis} /{" "}
                                    {r.economics.currency}
                                  </td>
                                  <td>{money(r.economics.totalPlannedCost)}</td>
                                  <td>{money(r.economics.expectedRevenue)}</td>
                                  <td>{money(r.economics.projectedMargin)}</td>
                                  <td>{money(c.deltas.projectedMargin)}</td>
                                  <td>
                                    {c.samePlan
                                      ? "Same plan"
                                      : "Different plan"}{" "}
                                    ·{" "}
                                    {c.sameSaleBasis
                                      ? "Same sale basis"
                                      : "Different sale basis"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="button-row">
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => void download("json", true)}
                        >
                          Download budget comparison JSON
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => void download("csv", true)}
                        >
                          Download budget comparison CSV
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
