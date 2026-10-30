"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  processingInput,
  processingData,
  processingWorkspace,
  measuredProcessing,
  processingHeads,
  type ProcessingInput,
  type ProcessingRecord,
} from "@/lib/broiler-processing";
import type { BroilerSnapshot, BroilerEvent } from "@/lib/broiler-lifecycle";
type Selection = {
  harvest: BroilerEvent;
  previousId: string | null;
  expectedPosition: string;
  expectedDailyId: string | null;
  sha: string;
  canWithdraw: boolean;
};
const blankProduct = (): ProcessingRecord["products"][number] => ({
  name: "",
  role: "primary",
  disposition: "unassessed",
  weightKg: null,
});
export default function BroilerProcessing({
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
  onPendingChange: (pending: boolean) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null),
    [selectedId, setSelectedId] = useState(""),
    [kind, setKind] = useState<"record" | "withdraw">("record"),
    [date, setDate] = useState(""),
    [form, setForm] = useState(""),
    [products, setProducts] = useState([blankProduct()]),
    [residual, setResidual] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<ProcessingInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] =
      useState<ReturnType<typeof measuredProcessing>>(null);
  const organizationId = snapshot.unit.organization_id!,
    unitId = snapshot.unit.id,
    key = `farmstead:broiler-processing:v1:${organizationId}:${actor}:${unitId}`,
    workspace = processingWorkspace(snapshot),
    changed = !!selection && selection.sha !== snapshot.evidenceSha256,
    disabled = blocked || busy || !!pending || !canReview;
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = processingInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === organizationId &&
            p.data.unitId === unitId
          )
            setPending(p.data);
          else
            setStorageWarning(
              "The stored processing receipt cannot be read. Review history before repeating this entry.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until the review is confirmed.",
        );
      }
    });
  }, [key, organizationId, unitId]);
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
  function remember(p: ProcessingInput | null) {
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
  function edit() {
    setDirty(true);
    setAck(false);
    setPreview(null);
    setNotice("");
  }
  function choose(id: string, keep = false, current = snapshot) {
    const w = processingWorkspace(current),
      harvest = w.harvests.find((h) => h.id === id),
      head = processingHeads(current.processingReviews ?? []).find(
        (h) => h.harvest_id === id,
      );
    setError("");
    setAck(false);
    setPreview(null);
    if (!harvest && keep) {
      setNotice(
        "The selected harvest is no longer eligible. Keep a working copy and review its original history.",
      );
      return;
    }
    setSelectedId(id);
    setSelection(
      harvest
        ? {
            harvest,
            previousId: head?.id ?? null,
            expectedPosition: current.summary.expectedPosition,
            expectedDailyId: current.summary.expectedDailyId,
            sha: current.evidenceSha256,
            canWithdraw: head?.input.kind === "record",
          }
        : null,
    );
    if (!keep) {
      const p = head?.input.kind === "record" ? head.input : null;
      setKind("record");
      setDate(p?.processedOn ?? "");
      setForm(p?.productForm ?? "");
      setProducts(p?.products ?? [blankProduct()]);
      setResidual(p?.residualKg ?? "");
      setReason("");
      setEvidence("");
      setDirty(false);
    }
    setNotice(
      keep
        ? "Harvest evidence reloaded. Review the full measurements and confirm again."
        : "",
    );
  }
  function data() {
    return kind === "withdraw"
      ? { kind, reason, evidence }
      : {
          kind,
          processedOn: date,
          productForm: form,
          products,
          residualKg: residual || null,
          scope: "whole-harvest-no-added-mass",
          reason,
          evidence,
        };
  }
  function copy() {
    return { organizationId, unitId, selection, data: data() };
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      choose(selectedId, true, await onSaved());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(p: ProcessingInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/processing", p);
      committed = true;
      await onSaved();
      remember(null);
      setSelection(null);
      setSelectedId("");
      setDirty(false);
      setAck(false);
      setPreview(null);
      setNotice(
        "Processing review saved. Original bird counts, live-harvest weights and prices remain unchanged.",
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
    if (!selection || disabled || changed) return;
    const parsed = processingData.safeParse(data());
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" "));
      return;
    }
    if (
      parsed.data.kind === "record" &&
      parsed.data.processedOn > snapshot.today
    ) {
      setError("The observed processing date cannot be in the future.");
      return;
    }
    try {
      const result = measuredProcessing(parsed.data, selection.harvest);
      if (!saving) {
        setPreview(result);
        setError("");
        return;
      }
      if (!ack) {
        setError("Confirm the full-harvest scope before saving.");
        return;
      }
      const p = processingInput.parse({
        organizationId,
        unitId,
        reviewId: crypto.randomUUID(),
        harvestId: selection.harvest.id,
        previousId: selection.previousId,
        expectedPosition: selection.expectedPosition,
        expectedDailyId: selection.expectedDailyId,
        data: parsed.data,
      });
      void save(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function download(format: "json" | "csv") {
    setBusy(true);
    setError("");
    try {
      await downloadReport(
        `broilers/processing?organizationId=${organizationId}&unitId=${unitId}&format=${format}`,
        `broiler-processing.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function metrics(m: NonNullable<ReturnType<typeof measuredProcessing>>) {
    return (
      <dl className="processing-metrics">
        {Object.entries({
          "Original birds": m.inputBirds,
          "Original live kg": m.inputLiveKg,
          "Known output kg subtotal": m.knownOutputKg,
          "Complete output kg": m.totalOutputKg,
          "Primary product kg": m.primaryOutputKg,
          "Primary yield fraction": m.primaryYieldFraction,
          "Dressing yield fraction": m.dressingYieldFraction,
          "Known intended-sale kg subtotal": m.knownIntendedSaleKg,
          "Intended-sale kg": m.intendedSaleKg,
          "Intended-sale yield fraction": m.intendedYieldFraction,
          "Measured residual kg": m.measuredResidualKg,
          "Unreconciled kg": m.unreconciledKg,
          "Mass reconciliation": m.massState,
        }).map(([label, v]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{v ?? "Unknown / not applicable"}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <section
      className="broiler-processing"
      aria-label="Broiler processing and measured yields"
    >
      <h3>Broiler processing and measured yields</h3>
      <p>
        Record measured outputs from one entire unsold, weighed harvest. Product
        lines must be distinct: use whole dressed birds or their cut parts,
        without counting both. This workflow excludes added mass and mixing
        harvests. It records measurements; product stock, sales and costs are
        separate.
      </p>
      <p className="helper">
        An unpriced harvest does not prove ownership or unsold status. Confirm
        that the whole group was owned and unsold when processed, using your
        source records. This is a supplied assertion, not an inventory check.
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
      {pending && (
        <div className="record-note">
          <p>
            Processing receipt {pending.reviewId} needs confirmation. Retry the
            exact receipt before another activity.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry processing receipt
          </button>
          <button
            className="text-button"
            onClick={() =>
              downloadJson("broiler-processing-pending.json", pending)
            }
          >
            Download pending processing receipt
          </button>
        </div>
      )}
      {!workspace.harvests.length && (
        <p>
          No active unpriced harvest is available. Record a weighed unpriced
          harvest above before attaching processing measurements. A priced live
          sale cannot also supply processed products.
        </p>
      )}
      {canReview && workspace.harvests.length > 0 && (
        <>
          <label>
            Whole harvest to process
            <select
              aria-label="Whole harvest to process"
              value={selectedId}
              disabled={disabled}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">Choose an unsold weighed harvest</option>
              {workspace.harvests.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.recorded_on} · {h.quantity} birds · {h.weight_kg} live kg ·{" "}
                  {h.id}
                </option>
              ))}
            </select>
          </label>
          {selection && (
            <>
              <p className="helper">
                Original source: {selection.harvest.id} ·{" "}
                {selection.harvest.quantity} birds ·{" "}
                {selection.harvest.weight_kg} live kg. Each save appends a full
                version for this whole harvest.
              </p>
              {dirty && (
                <p className="helper">
                  Download a working copy before choosing another harvest.
                  Unsaved measurements are not automatically stored.
                </p>
              )}
              {changed && (
                <p className="notice">
                  Batch evidence changed. Working inputs are retained; reload
                  the selected harvest and review them before saving.
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(true);
                }}
              >
                <fieldset disabled={disabled || changed}>
                  <legend>Review processing measurements</legend>
                  <label>
                    Processing review action
                    <select
                      aria-label="Processing review action"
                      value={kind}
                      onChange={(e) => {
                        setKind(e.target.value as typeof kind);
                        edit();
                      }}
                    >
                      <option value="record">
                        Record or correct full measurements
                      </option>
                      <option
                        value="withdraw"
                        disabled={!selection.canWithdraw}
                      >
                        Withdraw erroneous processing evidence
                      </option>
                    </select>
                  </label>
                  {kind === "record" ? (
                    <>
                      <div className="form-grid">
                        <label>
                          Observed processing date
                          <input
                            type="date"
                            min={selection.harvest.recorded_on}
                            max={snapshot.today}
                            value={date}
                            onChange={(e) => {
                              setDate(e.target.value);
                              edit();
                            }}
                          />
                        </label>
                        <label>
                          Primary product form
                          <select
                            aria-label="Primary product form"
                            value={form}
                            onChange={(e) => {
                              setForm(e.target.value);
                              edit();
                            }}
                          >
                            <option value="">Choose the measured form</option>
                            <option value="dressed_whole">
                              Whole dressed birds
                            </option>
                            <option value="cut_parts">Cut parts</option>
                            <option value="other">
                              Other · define in evidence
                            </option>
                          </select>
                        </label>
                        <label>
                          Measured residual / waste kg · blank is unknown
                          <input
                            inputMode="decimal"
                            value={residual}
                            onChange={(e) => {
                              setResidual(e.target.value);
                              edit();
                            }}
                          />
                        </label>
                      </div>
                      <p className="helper">
                        Output weights are measured kg; blank means unknown.
                        Residual is separately measured, including an explicit
                        zero when observed. Do not repeat output mass in
                        residual. Yields use the original live-harvest weight;
                        explain any holding or scale differences in the source
                        evidence. A remaining difference is unreconciled mass,
                        never automatically recorded as waste. Intended-for-sale
                        is your classification, not food-safety clearance.
                      </p>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Distinct output name</th>
                              <th>Role</th>
                              <th>Intended use</th>
                              <th>Measured kg · blank unknown</th>
                              <th>Remove</th>
                            </tr>
                          </thead>
                          <tbody>
                            {products.map((p, i) => (
                              <tr key={i}>
                                <td>
                                  <input
                                    aria-label={`Output ${i + 1} name`}
                                    maxLength={100}
                                    value={p.name}
                                    onChange={(e) => {
                                      setProducts(
                                        products.map((r, j) =>
                                          i === j
                                            ? { ...r, name: e.target.value }
                                            : r,
                                        ),
                                      );
                                      edit();
                                    }}
                                  />
                                </td>
                                <td>
                                  <select
                                    aria-label={`Output ${i + 1} role`}
                                    value={p.role}
                                    onChange={(e) => {
                                      setProducts(
                                        products.map((r, j) =>
                                          i === j
                                            ? {
                                                ...r,
                                                role: e.target
                                                  .value as typeof p.role,
                                              }
                                            : r,
                                        ),
                                      );
                                      edit();
                                    }}
                                  >
                                    <option value="primary">
                                      Primary product
                                    </option>
                                    <option value="by_product">
                                      By-product
                                    </option>
                                    <option value="other">Other output</option>
                                  </select>
                                </td>
                                <td>
                                  <select
                                    aria-label={`Output ${i + 1} intended use`}
                                    value={p.disposition}
                                    onChange={(e) => {
                                      setProducts(
                                        products.map((r, j) =>
                                          i === j
                                            ? {
                                                ...r,
                                                disposition: e.target
                                                  .value as typeof p.disposition,
                                              }
                                            : r,
                                        ),
                                      );
                                      edit();
                                    }}
                                  >
                                    <option value="unassessed">
                                      Unassessed
                                    </option>
                                    <option value="intended">
                                      Intended for sale
                                    </option>
                                    <option value="not_intended">
                                      Not intended for sale
                                    </option>
                                  </select>
                                </td>
                                <td>
                                  <input
                                    aria-label={`Output ${i + 1} measured kg`}
                                    inputMode="decimal"
                                    value={p.weightKg ?? ""}
                                    onChange={(e) => {
                                      setProducts(
                                        products.map((r, j) =>
                                          i === j
                                            ? {
                                                ...r,
                                                weightKg:
                                                  e.target.value || null,
                                              }
                                            : r,
                                        ),
                                      );
                                      edit();
                                    }}
                                  />
                                </td>
                                <td>
                                  <button
                                    className="text-button"
                                    type="button"
                                    disabled={products.length === 1}
                                    onClick={() => {
                                      setProducts(
                                        products.filter((_, j) => j !== i),
                                      );
                                      edit();
                                    }}
                                  >
                                    Remove output {i + 1}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        className="secondary"
                        type="button"
                        disabled={products.length >= 12}
                        onClick={() => {
                          setProducts([...products, blankProduct()]);
                          edit();
                        }}
                      >
                        Add measured output
                      </button>
                    </>
                  ) : (
                    <p>
                      Withdrawal corrects erroneous evidence. It does not undo
                      physical processing, return live birds or move product
                      stock. The full earlier measurements remain in history.
                    </p>
                  )}
                  <label>
                    Processing review reason
                    <textarea
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        edit();
                      }}
                    />
                  </label>
                  <label>
                    Scale records, ownership and product evidence
                    <textarea
                      maxLength={2000}
                      value={evidence}
                      onChange={(e) => {
                        setEvidence(e.target.value);
                        edit();
                      }}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    {kind === "record"
                      ? "I reviewed this exact whole harvest and confirm that the whole group was owned and unsold when processed. Measurements are distinct, with no added mass, nested carcass/cut weights or other harvest included."
                      : "I reviewed this exact whole harvest's erroneous processing evidence. Withdrawal preserves its history and does not return physical birds or product stock."}
                  </label>
                  <div className="button-row">
                    {kind === "record" && (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => submit(false)}
                      >
                        Preview measured yields
                      </button>
                    )}
                    <button className="primary" disabled={!ack} type="submit">
                      Save processing version
                    </button>
                  </div>
                </fieldset>
              </form>
              {preview && (
                <div>
                  <h4>Unsaved measured-yield preview</h4>
                  {metrics(preview)}
                </div>
              )}
              <div className="button-row">
                <button
                  className="text-button"
                  disabled={busy || !!pending}
                  onClick={() =>
                    downloadJson("broiler-processing-working-copy.json", copy())
                  }
                >
                  Download processing working copy
                </button>
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => void load()}
                >
                  Reload selected harvest evidence
                </button>
              </div>
            </>
          )}
        </>
      )}
      <h4>Current processing versions</h4>
      {workspace.lots.length ? (
        workspace.lots.map((lot) => (
          <details key={lot.review.id}>
            <summary>
              Harvest {lot.review.harvest_id} · revision {lot.review.revision} ·{" "}
              {lot.sourceState}
            </summary>
            <p>
              {lot.review.input.reason} · {lot.review.input.evidence}
            </p>
            <p className="helper">
              Review {lot.review.id} · {lot.review.created_by} ·{" "}
              {lot.review.created_at} · original timezone {lot.review.timezone}
            </p>
            {lot.metrics && metrics(lot.metrics)}
            {lot.guidance?.currentConcerns.length ? (
              <p className="notice">
                Current treatment guidance conflicts with the original harvest
                date. Measurements remain recorded; review the original clinical
                and harvest evidence. This report gives no release clearance.
              </p>
            ) : null}
            {lot.review.input.kind === "record" && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Output</th>
                      <th>Role</th>
                      <th>Intended use</th>
                      <th>Measured kg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lot.review.input.products.map((p) => (
                      <tr key={p.name}>
                        <th scope="row">{p.name}</th>
                        <td>{p.role}</td>
                        <td>{p.disposition}</td>
                        <td>{p.weightKg ?? "Unknown"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        ))
      ) : (
        <p>No processing measurements have been recorded.</p>
      )}
      <h4>Immutable processing history</h4>
      {(snapshot.processingReviews ?? []).length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Review / predecessor</th>
                <th>Harvest / revision</th>
                <th>Action and evidence</th>
                <th>Reviewer</th>
              </tr>
            </thead>
            <tbody>
              {[...(snapshot.processingReviews ?? [])].reverse().map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    {r.id}
                    <span className="helper">
                      Previous {r.previous_id ?? "none"}
                    </span>
                  </th>
                  <td>
                    {r.harvest_id}
                    <span className="helper">Revision {r.revision}</span>
                  </td>
                  <td>
                    {r.input.kind} · {r.input.reason}
                    <p>{r.input.evidence}</p>
                    {r.input.kind === "record" && (
                      <details>
                        <summary>Original measurements</summary>
                        <p>
                          {r.input.processedOn} · {r.input.productForm} ·{" "}
                          {r.timezone}
                        </p>
                        <ul>
                          {r.input.products.map((p) => (
                            <li key={p.name}>
                              {p.name} · {p.role} · {p.disposition} ·{" "}
                              {p.weightKg ?? "Unknown"} kg
                            </li>
                          ))}
                        </ul>
                        <p>
                          Measured residual: {r.input.residualKg ?? "Unknown"}{" "}
                          kg.
                        </p>
                      </details>
                    )}
                  </td>
                  <td>
                    {r.created_by}
                    <span className="helper">{r.created_at}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void download("json")}
        >
          Download processing JSON
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void download("csv")}
        >
          Download processing CSV
        </button>
      </div>
      <p className="helper">
        Reports are current full-history snapshots. Revisions preserve earlier
        measurements. Processing does not replace live-harvest biomass in cohort
        FCR or extend its feed window.
      </p>
    </section>
  );
}
