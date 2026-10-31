"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  actualCostCategories,
  actualCostLabels,
  actualCostData,
  actualCostInput,
  allocateActualCosts,
  costSnapshot,
  type ActualCostData,
  type ActualCostInput,
  type ActualCostWorkspace,
} from "@/lib/broiler-costs";
import type { BroilerSnapshot } from "@/lib/broiler-lifecycle";
const blank = (): ActualCostData => ({
  currency: "",
  costs: actualCostCategories.map((category) => ({
    category,
    amount: null,
    evidence: "",
  })),
  allocations: [],
  completeCosts: false,
  policy: "explicit-lot-totals-uniform-kg-v1",
  scope: "actual-incurred-batch-category-totals",
  reason: "",
  evidence: "",
});
export default function BroilerCosts({
  snapshot,
  actor,
  canReview,
  blocked,
  onSaved,
  onPendingChange,
}: {
  snapshot: BroilerSnapshot;
  actor: string;
  canReview: boolean;
  blocked: boolean;
  onSaved: () => Promise<BroilerSnapshot>;
  onPendingChange: (v: boolean) => void;
}) {
  const org = snapshot.unit.organization_id!,
    unit = snapshot.unit.id,
    endpoint = `broilers/costs?organizationId=${org}&unitId=${unit}`,
    key = `farmstead:broiler-costs:v1:${org}:${actor}:${unit}`;
  const [workspace, setWorkspace] = useState<ActualCostWorkspace | null>(null),
    [base, setBase] = useState<ActualCostWorkspace | null>(null),
    [data, setData] = useState(blank),
    [selectedId, setSelectedId] = useState(""),
    [dirty, setDirty] = useState(false),
    [ack, setAck] = useState(false),
    [pending, setPending] = useState<ActualCostInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] = useState<ReturnType<
      typeof allocateActualCosts
    > | null>(null);
  useEffect(() => {
    let active = true;
    void api<ActualCostWorkspace>(endpoint)
      .then((w) => {
        if (active) {
          setWorkspace(w);
          setSelectedId(w.report?.source.id ?? "");
        }
      })
      .catch((e) => {
        if (active) {
          setWorkspace(null);
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [endpoint, snapshot]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = actualCostInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === org &&
            p.data.unitId === unit
          )
            setPending(p.data);
          else
            setStorageWarning(
              "Stored cost receipt cannot be read. Review saved history before repeating the review.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until confirmation.",
        );
      }
    });
  }, [key, org, unit]);
  useEffect(() => {
    onPendingChange(!!pending);
  }, [pending, onPendingChange]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);
  const disabled =
      blocked || busy || !!pending || !canReview || !workspace?.current,
    changed =
      !!base &&
      !!workspace &&
      (base.latestId !== workspace.latestId ||
        base.sourceToken !== workspace.sourceToken);
  function edit(next: ActualCostData) {
    if (!base) setBase(workspace);
    setData(next);
    setDirty(true);
    setAck(false);
    setPreview(null);
    setNotice("");
  }
  function remember(p: ActualCostInput | null) {
    setPending(p);
    try {
      if (p) sessionStorage.setItem(key, JSON.stringify(p));
      else sessionStorage.removeItem(key);
    } catch {
      setStorageWarning(
        "Tab recovery storage is unavailable. Keep this page open until confirmation.",
      );
    }
  }
  async function load(id = selectedId, rebase = false) {
    setBusy(true);
    setError("");
    try {
      const w = await api<ActualCostWorkspace>(
        endpoint + (id ? `&reviewId=${id}` : ""),
      );
      setWorkspace(w);
      setSelectedId(w.report?.source.id ?? "");
      if (rebase) {
        setBase(w);
        setAck(false);
        setPreview(null);
        setNotice(
          "Actual cost source reloaded. Working inputs retained; review active lots and confirm again.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(p: ActualCostInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/costs", p);
      committed = true;
      await onSaved();
      const w = await api<ActualCostWorkspace>(
        endpoint + `&reviewId=${p.reviewId}`,
      );
      setWorkspace(w);
      setSelectedId(p.reviewId);
      remember(null);
      setBase(null);
      setData(blank());
      setDirty(false);
      setAck(false);
      setPreview(null);
      setNotice(
        "Actual cost review saved. Its source, category totals and allocation policy are immutable.",
      );
    } catch (e) {
      setError((e as Error).message);
      if (
        !committed &&
        e instanceof ApiError &&
        [400, 403, 404, 409, 422].includes(e.status)
      )
        remember(null);
    } finally {
      setBusy(false);
    }
  }
  function submit(saving: boolean) {
    if (disabled || changed) return;
    const context = base ?? workspace;
    if (!context?.current || !context.sourceToken) return;
    const p = actualCostData.safeParse(data);
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    try {
      const results = allocateActualCosts(
        p.data,
        costSnapshot(context.current),
      );
      if (!saving) {
        setPreview(results);
        setError("");
        return;
      }
      if (!ack) {
        setError(
          "Confirm the incurred-cost scope and explicit allocation policy before saving.",
        );
        return;
      }
      void save(
        actualCostInput.parse({
          organizationId: org,
          unitId: unit,
          reviewId: crypto.randomUUID(),
          previousId: context.latestId,
          expectedPosition: context.current.results.expectedPosition,
          expectedSourcePosition: context.current.expectedSourcePosition,
          expectedDailyId: context.current.expectedDailyId,
          expectedSourceSha256: context.sourceToken,
          data: p.data,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function download(format: "json" | "csv") {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      await downloadReport(
        endpoint + `&reviewId=${selectedId}&format=${format}`,
        `broiler-actual-costs.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function lotName(id: string) {
    const l = workspace?.current?.results.lots.find((l) => l.receipt.id === id),
      input = l?.receipt.source_snapshot?.input;
    return `${input?.kind === "record" ? input.products[l!.receipt.output_index!]?.name : "Unavailable original lot"} · ${id.slice(0, 8)}`;
  }
  function results(r: ReturnType<typeof allocateActualCosts>) {
    return (
      <>
        <dl className="cost-metrics">
          {Object.entries({
            "Cost currency": r.currency,
            "Actual source through": r.throughDate,
            "Known incurred-cost subtotal": r.knownCostSubtotal,
            "Declared complete incurred cost":
              r.totalDeclaredIncurredCost ?? "Unknown / not confirmed",
            "Explicitly allocated cost": r.allocatedCost,
            "Cost attributed to sold kg": r.soldKgCost,
            "Cost attributed to lost kg": r.lostKgCost,
            "Cost attributed to remaining kg": r.remainingKgCost,
            "Unallocated known batch cost": r.unallocatedKnownCost,
          }).map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {r.unknownCategories.length > 0 && (
          <p className="notice">
            Unknown incurred costs: {r.unknownCategories.join(", ")}. Complete
            cost is withheld; allocations draw only on the known subtotal.
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Lot / supplied allocation evidence</th>
                <th>Received / sold / lost / remaining kg</th>
                <th>Explicit cost / cost per received kg</th>
                <th>Sold / lost / remaining kg cost</th>
                <th>Recorded sale values · original currencies</th>
              </tr>
            </thead>
            <tbody>
              {r.lots.map((l) => (
                <tr key={l.lotId}>
                  <td>
                    {l.name}
                    <span className="helper">
                      {l.location} · {l.lotId}
                    </span>
                    {l.evidence}
                    {l.concerns.length > 0 && (
                      <p className="error">
                        Source harvest has current guidance concerns in this
                        saved snapshot.
                      </p>
                    )}
                  </td>
                  <td>
                    {l.receivedKg} / {l.soldKg} / {l.lostKg} / {l.remainingKg}
                  </td>
                  <td>
                    {l.allocatedCost} / {l.allocatedCostPerKg}
                  </td>
                  <td>
                    {l.soldKgCost} / {l.lostKgCost} / {l.remainingKgCost}
                  </td>
                  <td>
                    {Object.entries(l.recordedSales).map(
                      ([currency, amount]) => (
                        <span className="helper" key={currency}>
                          {currency} {amount}
                        </span>
                      ),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="helper">
          {r.unallocatedReceiptIds.length} active receipt lot(s) have no
          explicit cost allocation. Unallocated batch cost remains unattributed;
          it is not automatically assigned to live birds, losses, live sales or
          unsaved products.
        </p>
        <p className="helper">
          Recorded live sale values: {JSON.stringify(r.recordedLiveSaleValues)}.
          Recorded product sale values:{" "}
          {JSON.stringify(r.recordedProductSaleValues)}. Original currencies are
          kept separate; these values are not offset against costs to claim
          profit.
        </p>
      </>
    );
  }
  return (
    <section
      className="broiler-costs"
      aria-label="Broiler actual costs and allocations"
    >
      <div className="panel-heading">
        <h3>Broiler actual costs and allocations</h3>
        <button
          type="button"
          className="text-button"
          disabled={busy || !!pending}
          onClick={() => void load(selectedId, true)}
        >
          Reload actual cost source
        </button>
      </div>
      <p className="helper">
        Review actual batch-attributed category totals through the loaded
        operational evidence. Record consumed-feed valuation from
        issue/consumption records, not feed purchases or recipe/forecast prices.
        Exclude overlapping amounts and retain source/allocation evidence. Blank
        amounts remain unknown; zero requires evidence. This is a versioned
        managerial cost review, with no expense, inventory valuation, cash,
        journal or profit posting.
      </p>
      <p className="helper">
        Allocate a supplied cost total to each chosen receipt lot, including
        by-products and fully dispatched lots. The app distributes that explicit
        amount uniformly over original received kg. Four-place rounding assigns
        sold kg first, then cumulative sold-plus-lost kg, leaving the exact
        balance with remaining kg. No joint-cost share or sales-value weighting
        is inferred.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {storageWarning && <p className="notice">{storageWarning}</p>}
      {pending && (
        <div className="notice">
          <p>
            An actual cost receipt is awaiting confirmation. Retry this exact
            receipt before another activity.
          </p>
          <button
            type="button"
            disabled={busy || blocked || !canReview}
            onClick={() => void save(pending)}
          >
            Retry exact actual cost receipt
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              downloadJson("broiler-actual-cost-pending.json", pending)
            }
          >
            Download pending actual cost receipt
          </button>
        </div>
      )}
      {canReview ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(true);
          }}
        >
          <fieldset className="broiler-fields" disabled={disabled}>
            <legend>Review incurred costs and lot allocations</legend>
            <label>
              Original actual cost currency
              <input
                value={data.currency}
                placeholder="NGN"
                maxLength={3}
                onChange={(e) => edit({ ...data, currency: e.target.value })}
                required
              />
            </label>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Actual batch-attributed category</th>
                    <th>Amount · blank unknown · four decimals</th>
                    <th>Source / valuation / no-overlap evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {data.costs.map((c, i) => (
                    <tr key={c.category}>
                      <td>{actualCostLabels[c.category]}</td>
                      <td>
                        <input
                          aria-label={`${c.category} actual incurred amount`}
                          inputMode="decimal"
                          value={c.amount ?? ""}
                          onChange={(e) =>
                            edit({
                              ...data,
                              costs: data.costs.map((r, j) =>
                                j === i
                                  ? { ...r, amount: e.target.value || null }
                                  : r,
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <textarea
                          aria-label={`${c.category} actual cost evidence`}
                          value={c.evidence}
                          maxLength={1000}
                          onChange={(e) =>
                            edit({
                              ...data,
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
            <label className="cost-check">
              <input
                type="checkbox"
                checked={data.completeCosts}
                onChange={(e) =>
                  edit({ ...data, completeCosts: e.target.checked })
                }
              />
              <span>
                I reviewed all incurred batch costs through this loaded source,
                with no omitted or double-counted category totals. This is my
                completeness assertion, not an independent audit.
              </span>
            </label>
            <h4>Explicit product-lot cost allocations</h4>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Original receipt lot</th>
                    <th>Allocated amount · cost currency</th>
                    <th>Supplied allocation policy / evidence</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.allocations.map((a, i) => (
                    <tr key={i}>
                      <td>
                        <select
                          aria-label={`Allocation ${i + 1} receipt lot`}
                          value={a.lotId}
                          onChange={(e) =>
                            edit({
                              ...data,
                              allocations: data.allocations.map((r, j) =>
                                j === i ? { ...r, lotId: e.target.value } : r,
                              ),
                            })
                          }
                        >
                          <option value="">Choose a receipt lot</option>
                          {workspace?.current?.results.lots
                            .filter((l) => l.active)
                            .map((l) => (
                              <option
                                key={l.receipt.id}
                                value={l.receipt.id}
                                disabled={data.allocations.some(
                                  (a, j) => j !== i && a.lotId === l.receipt.id,
                                )}
                              >
                                {lotName(l.receipt.id)} · {l.receipt.weight_kg}{" "}
                                original kg
                              </option>
                            ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`Allocation ${i + 1} amount`}
                          inputMode="decimal"
                          value={a.amount}
                          onChange={(e) =>
                            edit({
                              ...data,
                              allocations: data.allocations.map((r, j) =>
                                j === i ? { ...r, amount: e.target.value } : r,
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <textarea
                          aria-label={`Allocation ${i + 1} evidence`}
                          value={a.evidence}
                          maxLength={1000}
                          onChange={(e) =>
                            edit({
                              ...data,
                              allocations: data.allocations.map((r, j) =>
                                j === i
                                  ? { ...r, evidence: e.target.value }
                                  : r,
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            edit({
                              ...data,
                              allocations: data.allocations.filter(
                                (_, j) => i !== j,
                              ),
                            })
                          }
                        >
                          Remove cost allocation {i + 1}
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
              disabled={data.allocations.length >= 40}
              onClick={() =>
                edit({
                  ...data,
                  allocations: [
                    ...data.allocations,
                    { lotId: "", amount: "", evidence: "" },
                  ],
                })
              }
            >
              Add product cost allocation
            </button>
            <div className="form-grid">
              <label>
                Actual cost review reason
                <textarea
                  value={data.reason}
                  maxLength={2000}
                  minLength={10}
                  required
                  onChange={(e) => edit({ ...data, reason: e.target.value })}
                />
              </label>
              <label>
                Incurred-cost boundary and allocation evidence
                <textarea
                  value={data.evidence}
                  maxLength={2000}
                  required
                  onChange={(e) => edit({ ...data, evidence: e.target.value })}
                />
              </label>
            </div>
            <label className="cost-check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                I confirm these are evidenced incurred batch category totals for
                this exact loaded source, with no duplicated
                purchases/consumption or forecast amounts. Each lot allocation
                is explicit; the uniform-kg and cumulative rounding policy is
                accepted. This review creates no financial journal or profit
                claim.
              </span>
            </label>
            <div className="button-row">
              <button
                type="button"
                disabled={changed}
                onClick={() => submit(false)}
              >
                Preview actual cost allocation
              </button>
              <button type="submit" disabled={changed}>
                Save actual cost review
              </button>
            </div>
          </fieldset>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              downloadJson("broiler-actual-cost-working.json", {
                organizationId: org,
                unitId: unit,
                previousId: base?.latestId,
                sourceToken: base?.sourceToken,
                data,
              })
            }
          >
            Download actual cost working copy
          </button>
          {changed && (
            <p className="notice">
              Loaded source or review head changed. Keep a working copy, reload
              the actual cost source and confirm again.
            </p>
          )}
        </form>
      ) : (
        <p className="helper">
          Read-only actual cost reviews, allocation history and exports.
        </p>
      )}
      {preview && (
        <section aria-label="Unsaved actual cost preview">
          <h4>Unsaved actual cost preview</h4>
          {results(preview)}
        </section>
      )}
      {workspace && (
        <>
          {workspace.currentError && (
            <p className="notice">
              {workspace.currentError} Saved version history and exact exports
              remain available. New reviews are disabled until current source
              can be loaded.
            </p>
          )}
          <h4>Immutable actual cost review history</h4>
          <label>
            Saved actual cost review
            <select
              value={selectedId}
              disabled={busy || !!pending}
              onChange={(e) => void load(e.target.value)}
            >
              <option value="">Choose a saved review</option>
              {workspace.history.map((h) => (
                <option key={h.id} value={h.id}>
                  Version {h.revision} · {h.currency} · {h.created_at}
                </option>
              ))}
            </select>
          </label>
          {workspace.report ? (
            <>
              <p className="notice">
                Saved version {workspace.report.source.revision} ·{" "}
                {workspace.sourceCurrent === true
                  ? "Source matches the current loaded actuals"
                  : workspace.sourceCurrent === false
                    ? "Historical source: actual records or settings have changed. This saved allocation is not current valuation."
                    : "Current source comparison unavailable. This exact saved allocation is preserved."}
              </p>
              <p className="helper">
                Reviewer: {workspace.report.source.created_by} ·{" "}
                {workspace.report.source.created_at}. Evidence SHA-256:{" "}
                {workspace.report.evidenceSha256}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void download("json")}
                >
                  Download actual cost JSON
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void download("csv")}
                >
                  Download actual cost CSV
                </button>
                {canReview && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() => {
                      setData(structuredClone(workspace.report!.source.input));
                      setBase(workspace);
                      setDirty(true);
                      setAck(false);
                      setPreview(null);
                      setNotice(
                        "Saved cost inputs copied for a new review against the latest loaded source. Recheck every category and lot allocation before confirmation.",
                      );
                    }}
                  >
                    Use saved cost inputs for a new review
                  </button>
                )}
              </div>
              {results(workspace.report.results)}
              <details>
                <summary>Complete immutable cost review and source</summary>
                <pre>{JSON.stringify(workspace.report.source, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p className="helper">
              No incurred-cost reviews saved. Plans, budgets, product receipts
              and sales never fill actual costs automatically.
            </p>
          )}
        </>
      )}
    </section>
  );
}
