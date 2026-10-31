"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  productInput,
  productAmount,
  type ProductInput,
  type ProductReport,
} from "@/lib/broiler-products";
import type { BroilerSnapshot } from "@/lib/broiler-lifecycle";
export default function BroilerProducts({
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
    endpoint = `broilers/products?organizationId=${org}&unitId=${unit}`,
    key = `farmstead:broiler-products:v1:${org}:${actor}:${unit}`;
  const [report, setReport] = useState<ProductReport | null>(null),
    [base, setBase] = useState<ProductReport | null>(null),
    [kind, setKind] = useState<ProductInput["data"]["kind"]>("receipt"),
    [selected, setSelected] = useState(""),
    [date, setDate] = useState(""),
    [location, setLocation] = useState(""),
    [weight, setWeight] = useState(""),
    [price, setPrice] = useState(""),
    [reference, setReference] = useState(""),
    [customer, setCustomer] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<ProductInput | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState("");
  useEffect(() => {
    let active = true;
    void api<ProductReport>(endpoint)
      .then((r) => {
        if (active) setReport(r);
      })
      .catch((e) => {
        if (active) {
          setReport(null);
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [endpoint, snapshot.evidenceSha256]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = productInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === org &&
            p.data.unitId === unit
          )
            setPending(p.data);
          else
            setStorageWarning(
              "The stored product receipt cannot be read. Review history before repeating this activity.",
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
  const disabled = blocked || busy || !!pending || !canReview || !report,
    changed =
      !!base && !!report && base.evidenceSha256 !== report.evidenceSha256;
  function remember(p: ProductInput | null) {
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
    setNotice("");
  }
  function data() {
    const common = { kind, reason, evidence };
    if (kind === "receipt") {
      const output = base?.results.outputs.find(
        (o) => `${o.reviewId}:${o.index}` === selected,
      );
      return {
        ...common,
        sourceReviewId: output?.reviewId,
        outputIndex: output?.index,
        location,
        scope: "whole-output-owned-available",
      };
    }
    if (kind === "void") return { ...common, voidOfId: selected };
    return kind === "sale"
      ? {
          ...common,
          lotId: selected,
          weightKg: weight,
          pricePerKg: price,
          reference,
          customer,
        }
      : { ...common, lotId: selected, weightKg: weight };
  }
  async function reload() {
    setBusy(true);
    setError("");
    try {
      await onSaved();
      const r = await api<ProductReport>(endpoint);
      setReport(r);
      setBase(r);
      setAck(false);
      setNotice(
        "Product source reloaded. Inputs retained; confirm the current lot and evidence again.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(p: ProductInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/products", p);
      committed = true;
      await onSaved();
      setReport(await api<ProductReport>(endpoint));
      remember(null);
      setBase(null);
      setSelected("");
      setDirty(false);
      setAck(false);
      setNotice(
        "Product movement saved. Stock and recorded sale values updated.",
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
  function submit() {
    if (disabled || !base || changed) return;
    if (!ack) {
      setError("Confirm the physical source and scope before saving.");
      return;
    }
    const p = productInput.safeParse({
      organizationId: org,
      unitId: unit,
      eventId: crypto.randomUUID(),
      date,
      expectedPosition: base.results.expectedPosition,
      expectedSourcePosition: base.expectedSourcePosition,
      expectedDailyId: base.expectedDailyId,
      data: data(),
    });
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    void save(p.data);
  }
  async function download(format: "json" | "csv") {
    setBusy(true);
    setError("");
    try {
      await downloadReport(
        `${endpoint}&format=${format}`,
        `broiler-product-stock.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active =
    report?.events.filter(
      (e) =>
        e.kind !== "void" && !report.events.some((v) => v.void_of_id === e.id),
    ) ?? [];
  const lotName = (id: string) => {
    const l = report?.results.lots.find((l) => l.receipt.id === id),
      p = l?.receipt.source_snapshot?.input;
    return `${p?.kind === "record" ? p.products[l!.receipt.output_index!]?.name : "Product"} · ${l?.receipt.input.kind === "receipt" ? l.receipt.input.location : ""} · ${id.slice(0, 8)}`;
  };
  return (
    <section
      className="broiler-products"
      aria-label="Broiler product stock and sales"
    >
      <div className="panel-heading">
        <h3>Broiler product stock and sales</h3>
        <button
          className="text-button"
          type="button"
          disabled={busy || !!pending}
          onClick={() => void reload()}
        >
          Reload product source
        </button>
      </div>
      <p className="helper">
        Receive one entire measured, intended-for-sale output only after
        confirming it is owned, physically available and has no earlier stock
        receipt or disposal outside this ledger. Unknown weights and intended
        use alone do not establish stock. Location is a supplied lot label.
      </p>
      <p className="helper">
        Sales withdraw measured kilograms at one explicit price per kg. Values
        record dispatch, not cash collection, cost or profit. Current guidance
        conflicts with the original harvest hold new receipts and sales for
        source review; this is not release certification. Processing
        measurements stay locked while any dependent receipt is active.
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
            A product movement is awaiting confirmation. Retry this exact
            receipt before recording another activity.
          </p>
          <button
            type="button"
            disabled={busy || blocked || !canReview}
            onClick={() => void save(pending)}
          >
            Retry exact product receipt
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              downloadJson("broiler-product-pending.json", pending)
            }
          >
            Download pending product receipt
          </button>
        </div>
      )}
      {canReview ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={disabled} className="broiler-fields">
            <legend>Review a product movement</legend>
            <div className="form-grid">
              <label>
                Product activity
                <select
                  value={kind}
                  onChange={(e) => {
                    edit();
                    setKind(e.target.value as typeof kind);
                    setSelected("");
                    setBase(report);
                  }}
                >
                  <option value="receipt">Receive whole measured output</option>
                  <option value="sale">Record kg sale</option>
                  <option value="loss">Record measured product loss</option>
                  <option value="void">Void an erroneous entry</option>
                </select>
              </label>
              <label>
                {kind === "receipt"
                  ? "Measured output to receive"
                  : kind === "void"
                    ? "Erroneous product entry"
                    : "Product lot"}
                <select
                  value={selected}
                  onChange={(e) => {
                    edit();
                    setSelected(e.target.value);
                    setBase(report);
                  }}
                  required
                >
                  <option value="">Select a source</option>
                  {kind === "receipt"
                    ? report?.results.outputs.map((o) => (
                        <option
                          key={`${o.reviewId}:${o.index}`}
                          value={`${o.reviewId}:${o.index}`}
                          disabled={o.concerns.length > 0}
                        >
                          {o.name} · {o.weightKg} kg · {o.reviewId.slice(0, 8)}
                          {o.concerns.length ? " · guidance conflict" : ""}
                        </option>
                      ))
                    : kind === "void"
                      ? active
                          .filter(
                            (e) =>
                              e.kind !== "receipt" ||
                              !active.some(
                                (a) => a.lot_id === e.id && a.id !== e.id,
                              ),
                          )
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.kind} · {e.recorded_on} · {e.weight_kg} kg ·{" "}
                              {e.id.slice(0, 8)}
                            </option>
                          ))
                      : report?.results.lots
                          .filter((l) => l.active)
                          .map((l) => (
                            <option key={l.receipt.id} value={l.receipt.id}>
                              {lotName(l.receipt.id)} · {l.balanceKg} kg
                              available
                            </option>
                          ))}
                </select>
              </label>
              <label>
                Product movement date
                <input
                  type="date"
                  value={date}
                  max={report?.today}
                  required
                  onChange={(e) => {
                    edit();
                    setDate(e.target.value);
                  }}
                />
              </label>
              {kind === "receipt" && (
                <label>
                  Product location label
                  <input
                    value={location}
                    maxLength={100}
                    required
                    onChange={(e) => {
                      edit();
                      setLocation(e.target.value);
                    }}
                  />
                </label>
              )}
              {(kind === "sale" || kind === "loss") && (
                <label>
                  Measured product kg
                  <input
                    inputMode="decimal"
                    value={weight}
                    required
                    onChange={(e) => {
                      edit();
                      setWeight(e.target.value);
                    }}
                  />
                </label>
              )}
              {kind === "sale" && (
                <>
                  <label>
                    Price per product kg
                    <input
                      inputMode="decimal"
                      value={price}
                      required
                      onChange={(e) => {
                        edit();
                        setPrice(e.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Product sale reference
                    <input
                      value={reference}
                      maxLength={100}
                      required
                      onChange={(e) => {
                        edit();
                        setReference(e.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Product customer
                    <input
                      value={customer}
                      maxLength={200}
                      required
                      onChange={(e) => {
                        edit();
                        setCustomer(e.target.value);
                      }}
                    />
                  </label>
                </>
              )}
              <label>
                Product review reason
                <textarea
                  value={reason}
                  minLength={10}
                  maxLength={2000}
                  required
                  onChange={(e) => {
                    edit();
                    setReason(e.target.value);
                  }}
                />
              </label>
              <label>
                Physical stock and source evidence
                <textarea
                  value={evidence}
                  maxLength={2000}
                  required
                  onChange={(e) => {
                    edit();
                    setEvidence(e.target.value);
                  }}
                />
              </label>
            </div>
            {kind === "sale" &&
              /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(weight) &&
              /^(0|[1-9]\d{0,8})(\.\d{1,4})?$/.test(price) && (
                <p className="notice">
                  Unsaved sale value: {productAmount(weight, price)} · currency
                  is captured from organization settings when saved.
                </p>
              )}
            <label className="product-ack">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                {kind === "receipt"
                  ? "I confirm this whole output is owned and physically available now, with no earlier receipt, sale, loss or other disposition outside this ledger. Evidence supports this stock assertion."
                  : kind === "void"
                    ? "This entry was erroneous; its physical receipt or withdrawal did not occur. This correction is not a customer return, cash refund or physical stock return."
                    : "I confirm the measured quantity and physical dispatch or loss against this lot. This records supplied evidence without release or financial certification."}
              </span>
            </label>
            <button type="submit" disabled={!selected || !base || changed}>
              Save product movement
            </button>
          </fieldset>
          <button
            className="text-button"
            type="button"
            onClick={() =>
              downloadJson("broiler-product-working.json", {
                organizationId: org,
                unitId: unit,
                date,
                baseEvidenceSha256: base?.evidenceSha256,
                data: data(),
              })
            }
          >
            Download product working copy
          </button>
          {changed && (
            <p className="notice">
              Product source changed. Keep a working copy, reload the source and
              confirm again.
            </p>
          )}
        </form>
      ) : (
        <p className="helper">
          Read-only product stock, sales and source history.
        </p>
      )}
      {report && (
        <>
          <div className="button-row">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void download("json")}
            >
              Download product JSON
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void download("csv")}
            >
              Download product CSV
            </button>
          </div>
          <p className="helper">Source SHA-256: {report.evidenceSha256}</p>
          <h4>Measured product lots</h4>
          {report.results.lots.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Product / location</th>
                    <th>State</th>
                    <th>Received kg</th>
                    <th>Available kg</th>
                    <th>Sold kg</th>
                    <th>Lost kg</th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.lots.map((l) => (
                    <tr key={l.receipt.id}>
                      <td>
                        {lotName(l.receipt.id)}
                        <details>
                          <summary>Original measurement evidence</summary>
                          <pre>
                            {JSON.stringify(l.receipt.source_snapshot, null, 2)}
                          </pre>
                        </details>
                      </td>
                      <td>
                        {l.active ? "Active" : "Erroneous receipt voided"}
                        {l.concerns.length > 0 && (
                          <p className="error">
                            Current source harvest guidance conflict. New
                            receipts and sales held for review.
                          </p>
                        )}
                      </td>
                      <td>{l.receipt.weight_kg}</td>
                      <td>{l.balanceKg}</td>
                      <td>{l.soldKg}</td>
                      <td>{l.lostKg}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="helper">
              No product receipts recorded for this batch.
            </p>
          )}
          <h4>Recorded sale values by original currency</h4>
          {Object.entries(report.results.salesByCurrency).map(
            ([currency, amount]) => (
              <p key={currency}>
                {currency} {amount}
              </p>
            ),
          )}
          <p className="helper">
            Active recorded sales only. No conversion, cash, cost of goods sold
            or realized margin is inferred.
          </p>
          <h4>Immutable product movement history</h4>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date / activity</th>
                  <th>Measured kg</th>
                  <th>Recorded sale</th>
                  <th>Reason / evidence</th>
                </tr>
              </thead>
              <tbody>
                {[...report.events].reverse().map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.recorded_on} · {e.kind}
                      <br />
                      {e.id}
                      <details>
                        <summary>Complete movement source</summary>
                        <pre>{JSON.stringify(e, null, 2)}</pre>
                      </details>
                    </td>
                    <td>{e.weight_kg}</td>
                    <td>
                      {e.currency
                        ? `${e.currency} ${e.amount} · ${e.price_per_kg}/kg`
                        : "Not a sale"}
                      {e.reference && (
                        <span className="helper">{e.reference}</span>
                      )}
                    </td>
                    <td>
                      {e.input.reason}
                      <span className="helper">{e.input.evidence}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
