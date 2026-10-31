"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  feedStockData,
  feedStockInput,
  feedWithdrawalValue,
  type FeedStockData,
  type FeedStockInput,
  type FeedStockWorkspace,
  type FeedConsumptionSource,
} from "@/lib/feed-stock";
type Preview = {
  kind: string;
  date: string;
  kg: string;
  currency: string;
  value: string | null;
};
export default function FeedStock({
  organizationId,
  actor,
  role,
  currency: orgCurrency,
}: {
  organizationId: string;
  actor: string;
  role: string;
  currency: string;
}) {
  const canPost = ["owner", "admin", "manager", "inventory"].includes(role),
    endpoint = `inventory/feed?organizationId=${organizationId}`,
    key = `farmstead:feed-stock:v1:${organizationId}:${actor}`;
  const [w, setW] = useState<FeedStockWorkspace | null>(null),
    [base, setBase] = useState<string | null>(null),
    [mode, setMode] = useState<FeedStockData["kind"]>("receipt"),
    [fields, setFields] = useState<Record<string, string>>({
      currency: orgCurrency,
    }),
    [date, setDate] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [source, setSource] = useState<FeedConsumptionSource | null>(null),
    [known, setKnown] = useState(false),
    [asOf, setAsOf] = useState(""),
    [cutoff, setCutoff] = useState(""),
    [unitFilter, setUnitFilter] = useState(""),
    [dateFilter, setDateFilter] = useState(""),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<FeedStockInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let active = true;
    void api<FeedStockWorkspace>(endpoint)
      .then((v) => {
        if (active) {
          setW(v);
          setAsOf(v.report.asOf);
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
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = feedStockInput.safeParse(JSON.parse(raw));
          if (p.success && p.data.organizationId === organizationId)
            setPending(p.data);
          else
            setStorageWarning(
              "The saved feed receipt cannot be read. Review posted history before repeating it.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until confirmation.",
        );
      }
    });
  }, [key, organizationId]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);
  const disabled = busy || !!pending || !canPost || !w,
    changed = base !== null && !!w && base !== w.expectedPosition;
  function edit() {
    if (base === null) setBase(w?.expectedPosition ?? null);
    setDirty(true);
    setAck(false);
    setPreview(null);
    setNotice("");
  }
  function field(name: string, value: string) {
    edit();
    setFields((f) => ({ ...f, [name]: value }));
  }
  function remember(p: FeedStockInput | null) {
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
  function path(day = asOf, pos = cutoff) {
    const q = new URLSearchParams({ organizationId });
    if (day) q.set("asOf", day);
    if (pos) q.set("throughPosition", pos);
    if (unitFilter) q.set("unitId", unitFilter);
    if (dateFilter) q.set("sourceDate", dateFilter);
    return "inventory/feed?" + q;
  }
  async function reload(latest = false) {
    setBusy(true);
    setError("");
    try {
      const v = await api<FeedStockWorkspace>(path(asOf, latest ? "" : cutoff));
      setW(v);
      setAsOf(v.report.asOf);
      if (latest) setCutoff("");
      setBase(v.expectedPosition);
      setSource((s) =>
        s
          ? (v.sources.find(
              (n) => n.unitId === s.unitId && n.date === s.date,
            ) ?? null)
          : null,
      );
      setAck(false);
      setPreview(null);
      setNotice(
        "Feed stock and actual sources reloaded. Working inputs retained; review and confirm again.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function data(): FeedStockData {
    const common = { reason, evidence };
    if (mode === "receipt")
      return feedStockData.parse({
        kind: mode,
        feedName: fields.feedName ?? "",
        supplier: fields.supplier ?? "",
        reference: fields.reference ?? "",
        location: fields.location ?? "",
        weightKg: fields.weightKg ?? "",
        currency: fields.currency ?? "",
        totalCost: known ? (fields.totalCost ?? "") : null,
        costEvidence: known ? (fields.costEvidence ?? "") : null,
        scope: "actual-owned-purchase-receipt",
        ...common,
      });
    if (mode === "void")
      return feedStockData.parse({
        kind: mode,
        voidOfId: fields.voidOfId ?? "",
        ...common,
      });
    if (mode === "consume")
      return feedStockData.parse({
        kind: mode,
        lotId: fields.lotId ?? "",
        unitId: source?.unitId ?? "",
        weightKg: fields.weightKg ?? "",
        expectedSourceSha256: source?.sourceSha256 ?? "",
        scope: "actual-recorded-feed-consumption",
        ...common,
      });
    return feedStockData.parse({
      kind: mode,
      lotId: fields.lotId ?? "",
      weightKg: fields.weightKg ?? "",
      ...common,
    });
  }
  function payload() {
    return feedStockInput.parse({
      organizationId,
      eventId: crypto.randomUUID(),
      date,
      expectedPosition: base ?? w?.expectedPosition ?? "0",
      data: data(),
    });
  }
  function evaluate(p: FeedStockInput): Preview {
    const d = p.data;
    if (d.kind === "receipt")
      return {
        kind: "Purchase receipt",
        date: p.date,
        kg: d.weightKg,
        currency: d.currency,
        value: d.totalCost,
      };
    if (d.kind === "void") {
      const e = w?.reversible.find((e) => e.id === d.voidOfId);
      if (!e) throw Error("Choose an unreversed original feed movement.");
      return {
        kind: `Erroneous ${e.kind} reversal`,
        date: p.date,
        kg: e.weight_kg,
        currency: e.currency,
        value: e.amount,
      };
    }
    const lot = w?.currentLots.find(
      (l) => l.receipt.id === d.lotId && l.active,
    );
    if (!lot) throw Error("Choose an active feed purchase lot.");
    if (d.kind === "consume" && source?.date !== p.date)
      throw Error(
        "The consumption date must equal the selected actual daily feed record date.",
      );
    return {
      kind:
        d.kind === "consume" ? "Actual feed consumption" : "Measured feed loss",
      date: p.date,
      kg: d.weightKg,
      currency: lot.currency,
      value: feedWithdrawalValue(lot.balanceKg, lot.remainingValue, d.weightKg),
    };
  }
  async function submit(p: FeedStockInput) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ replayed: boolean }>("inventory/feed", p);
      remember(null);
      setDirty(false);
      setAck(false);
      setPreview(null);
      setBase(null);
      const v = await api<FeedStockWorkspace>(path(asOf, cutoff));
      setW(v);
      setAsOf(v.report.asOf);
      setNotice(
        r.replayed
          ? "Original feed receipt confirmed; no duplicate movement or audit."
          : "Feed movement saved. Production feed records and financial journals are unchanged.",
      );
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        remember(null);
        setAck(false);
        if (e.status === 409)
          setNotice(
            "Working inputs retained. Download a copy, reload stock/source and confirm again.",
          );
      } else
        setNotice(
          "The feed receipt is awaiting confirmation. Retry this exact receipt before making another movement.",
        );
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    try {
      if (!ack)
        throw Error(
          "Confirm the physical movement, purchase cost and actual-feed evidence.",
        );
      const p = payload();
      evaluate(p);
      remember(p);
      await submit(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function working() {
    downloadJson(
      "feed-stock-working-copy.json",
      pending ?? {
        organizationId,
        actor,
        date,
        expectedPosition: base,
        kind: mode,
        fields,
        knownCost: known,
        source,
        reason,
        evidence,
      },
    );
  }
  async function download(format: "json" | "csv") {
    if (!w) return;
    setError("");
    try {
      await downloadReport(
        `inventory/feed?organizationId=${organizationId}&asOf=${w.report.asOf}&throughPosition=${w.report.throughPosition}&format=${format}`,
        `feed-purchases-stock.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function input(
    name: string,
    label: string,
    options: { max?: number; placeholder?: string } = {},
  ) {
    return (
      <label>
        {label}
        <input
          value={fields[name] ?? ""}
          onChange={(e) => field(name, e.target.value)}
          maxLength={options.max ?? 200}
          placeholder={options.placeholder}
          required
        />
      </label>
    );
  }
  return (
    <section
      className="panel feed-stock"
      aria-label="Feed purchases and consumption"
    >
      <div className="panel-heading">
        <h2>Feed purchases and consumption</h2>
        <button
          className="text-button"
          disabled={busy || !!pending}
          onClick={() => void reload(true)}
        >
          Reload current feed stock
        </button>
      </div>
      <p className="helper">
        Receive actual owned feed purchase lots, link evidenced consumption to
        existing broiler daily feed, and record measured stock losses. The
        selected lot retains its original currency and supplied total cost.
        Unknown cost stays unknown; an explicit zero requires evidence.
      </p>
      <p className="helper">
        Valuation uses each identified lot’s remaining cost in proportion to
        withdrawn kilograms; the final withdrawal takes its exact rounding
        remainder. Feed names establish no ingredient mapping or nutrition
        approval. These movements do not create daily feed observations, journal
        entries, payments, formula approvals or profit.
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
        <div className="notice">
          <p>
            A feed receipt is awaiting confirmation. New movement controls are
            locked until this exact receipt is resolved.
          </p>
          <button
            disabled={busy || !canPost}
            onClick={() => void submit(pending)}
          >
            Retry exact feed receipt
          </button>
          <button className="text-button" onClick={working}>
            Download pending feed receipt
          </button>
          <details>
            <summary>Pending movement evidence</summary>
            <pre>{JSON.stringify(pending, null, 2)}</pre>
          </details>
        </div>
      )}
      <fieldset disabled={busy || !!pending} className="feed-stock-fields">
        <legend>Load reports and actual feed sources</legend>
        <div className="form-grid">
          <label>
            Feed stock as-of date
            <input
              type="date"
              min="1900-01-01"
              max={w?.today}
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
          <label>
            Append-position cutoff · blank uses latest
            <input
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            Actual feed batch filter
            <select
              value={unitFilter}
              onChange={(e) => setUnitFilter(e.target.value)}
            >
              <option value="">All broiler batches</option>
              {w?.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Actual feed date filter · optional
            <input
              type="date"
              min="1900-01-01"
              max={w?.today}
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
            />
          </label>
        </div>
        <button onClick={() => void reload()}>
          Load feed report and sources
        </button>
      </fieldset>
      {!w && (
        <p className="helper">
          {error
            ? "Feed ledger could not be loaded. Retry before entering movements."
            : "Loading feed ledger…"}
        </p>
      )}
      {w && (
        <>
          {w.changedSources.length > 0 && (
            <div>
              <p className="notice" role="status">
                {w.changedSources.length} linked daily source(s) in the current
                filter have changed or exceed current recorded feed. Saved
                quantities and costs remain historical; review original
                consumption and corrected daily evidence. An erroneous void is
                not a physical feed return.
              </p>
              <details>
                <summary>Changed daily sources requiring review</summary>
                <ul>
                  {w.changedSources.map((s) => (
                    <li key={s.unitId + s.date}>
                      {s.unitName} · {s.date} · actual {s.feedKg} kg · linked{" "}
                      {s.issuedKg} kg · overlinked {s.overlinkedKg} kg ·{" "}
                      {s.sourceChanged
                        ? "Source evidence changed"
                        : "Quantity reconciliation required"}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          <section aria-label="Current actual feed reconciliation">
            <h3>Current actual feed reconciliation</h3>
            <p className="helper">
              Showing {w.sources.length} of {w.sourceMatches} loaded source
              candidates: the most recent 200 positive feed records plus
              existing linked days, within the batch/date filter. Filter a batch
              and date to find an older observation. Unlinked feed has no lot
              valuation here. Current reconciliation is outside the frozen
              report digest.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Batch / date</th>
                    <th>Actual kg</th>
                    <th>Linked kg</th>
                    <th>Unlinked kg</th>
                    <th>Overlinked kg</th>
                    <th>Source status</th>
                  </tr>
                </thead>
                <tbody>
                  {w.sources.map((s) => (
                    <tr key={s.unitId + s.date}>
                      <td>
                        {s.unitName}
                        <span className="helper">{s.date}</span>
                      </td>
                      <td>{s.feedKg}</td>
                      <td>{s.issuedKg}</td>
                      <td>{s.unlinkedKg}</td>
                      <td>{s.overlinkedKg}</td>
                      <td>
                        {s.sourceChanged
                          ? "Changed since linking"
                          : "Current loaded source"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {canPost ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={disabled} className="feed-stock-fields">
                <legend>Review a feed stock movement</legend>
                <label>
                  Feed stock activity
                  <select
                    value={mode}
                    onChange={(e) => {
                      edit();
                      setMode(e.target.value as FeedStockData["kind"]);
                      setSource(null);
                    }}
                  >
                    <option value="receipt">
                      Receive a purchased feed lot
                    </option>
                    <option value="consume">
                      Link actual feed consumption
                    </option>
                    <option value="loss">Record measured feed loss</option>
                    <option value="void">Reverse an erroneous entry</option>
                  </select>
                </label>
                <label>
                  Feed movement date
                  <input
                    type="date"
                    min="1900-01-01"
                    max={w.today}
                    value={date}
                    onChange={(e) => {
                      edit();
                      setDate(e.target.value);
                    }}
                    required
                  />
                </label>
                {mode === "receipt" ? (
                  <>
                    <div className="form-grid">
                      {input("feedName", "Purchased feed identity")}
                      {input("supplier", "Feed supplier")}
                      {input("reference", "Unique feed purchase reference", {
                        max: 100,
                      })}
                      {input("location", "Feed stock location", { max: 100 })}
                      {input("weightKg", "Received feed kg", {
                        placeholder: "Exact kg, up to six decimals",
                      })}
                      {input("currency", "Original purchase currency", {
                        max: 3,
                      })}
                    </div>
                    <label className="feed-stock-check">
                      <input
                        type="checkbox"
                        checked={known}
                        onChange={(e) => {
                          edit();
                          setKnown(e.target.checked);
                        }}
                      />
                      <span>
                        The actual total purchase cost is known, including an
                        explicitly evidenced zero.
                      </span>
                    </label>
                    {known ? (
                      <div className="form-grid">
                        {input("totalCost", "Actual total lot cost", {
                          placeholder: "Original currency, up to four decimals",
                        })}
                        <label>
                          Purchase cost evidence
                          <textarea
                            value={fields.costEvidence ?? ""}
                            maxLength={2000}
                            onChange={(e) =>
                              field("costEvidence", e.target.value)
                            }
                            required
                          />
                        </label>
                      </div>
                    ) : (
                      <p className="helper">
                        Cost is unknown. Stock is recorded without inventing a
                        cost or a complete valuation. Specify the full actual
                        lot total with its landed-cost/tax treatment evidence
                        when known; there is no guessed price or automatic price
                        lookup.
                      </p>
                    )}
                  </>
                ) : mode === "void" ? (
                  <>
                    <label>
                      Original feed movement
                      <select
                        value={fields.voidOfId ?? ""}
                        onChange={(e) => field("voidOfId", e.target.value)}
                        required
                      >
                        <option value="">Choose an unreversed original</option>
                        {w.reversible.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.recorded_on} · {e.kind} · {e.weight_kg} kg ·{" "}
                            {e.currency} · {e.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="helper">
                      Use only when the recorded movement did not occur. A real
                      supplier/customer return, transfer, count adjustment or
                      later price change requires a separate workflow. Receipt
                      reversal requires all erroneous dependent
                      consumption/losses reversed first. Existing lot dates
                      remain chronological.
                    </p>
                  </>
                ) : (
                  <>
                    <label>
                      Purchased feed lot
                      <select
                        value={fields.lotId ?? ""}
                        onChange={(e) => field("lotId", e.target.value)}
                        required
                      >
                        <option value="">Choose an active purchased lot</option>
                        {w.currentLots
                          .filter((l) => l.active)
                          .map((l) => (
                            <option key={l.receipt.id} value={l.receipt.id}>
                              {l.feedName} ·{" "}
                              {l.receipt.input.kind === "receipt"
                                ? l.receipt.input.reference
                                : ""}{" "}
                              · {l.location} · {l.balanceKg} kg · {l.currency}
                            </option>
                          ))}
                      </select>
                    </label>
                    {input("weightKg", "Withdrawn feed kg", {
                      placeholder: "Exact kg, up to six decimals",
                    })}
                    {mode === "consume" && (
                      <>
                        <label>
                          Actual daily feed source
                          <select
                            value={
                              source ? source.unitId + ":" + source.date : ""
                            }
                            onChange={(e) => {
                              edit();
                              const s =
                                w.sources.find(
                                  (s) =>
                                    s.unitId + ":" + s.date === e.target.value,
                                ) ?? null;
                              setSource(s);
                              if (s) setDate(s.date);
                            }}
                            required
                          >
                            <option value="">
                              Choose a recorded actual broiler feed day
                            </option>
                            {w.sources
                              .filter(
                                (s) =>
                                  s.sourceSha256 && s.feedKg !== "0.000000",
                              )
                              .map((s) => (
                                <option
                                  key={s.unitId + s.date}
                                  value={s.unitId + ":" + s.date}
                                >
                                  {s.unitName} · {s.date} · {s.unlinkedKg} kg
                                  unlinked
                                </option>
                              ))}
                          </select>
                        </label>
                        <p className="helper">
                          Confirm which actual lot supplied this feed; the name
                          alone is no match. Several lots may cover one day,
                          with total linked kg capped by its current actual
                          feed. The movement date must match that daily record.
                          Later source corrections stay visible and do not
                          silently change this stock history.
                        </p>
                      </>
                    )}
                  </>
                )}
                <div className="form-grid">
                  <label>
                    Feed movement review reason
                    <textarea
                      value={reason}
                      onChange={(e) => {
                        edit();
                        setReason(e.target.value);
                      }}
                      minLength={10}
                      maxLength={2000}
                      required
                    />
                  </label>
                  <label>
                    Physical feed and source evidence
                    <textarea
                      value={evidence}
                      onChange={(e) => {
                        edit();
                        setEvidence(e.target.value);
                      }}
                      minLength={3}
                      maxLength={2000}
                      required
                    />
                  </label>
                </div>
                <label className="feed-stock-check">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  <span>
                    I confirm the actual owned feed movement, selected lot,
                    supplied cost boundary and daily source evidence; this is
                    separate from financial recognition and feed safety
                    approval.
                  </span>
                </label>
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setError("");
                      try {
                        setPreview(evaluate(payload()));
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Preview feed movement
                  </button>
                  <button className="primary" disabled={!ack || changed}>
                    Save feed movement
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p className="notice">
              Read-only feed purchase and valuation access. Your current role
              cannot post movements.
            </p>
          )}
          {changed && (
            <p className="notice">
              The loaded stock head differs from your working inputs. Download a
              copy, reload current stock/source and confirm again.
            </p>
          )}
          {canPost && (
            <button className="text-button" onClick={working}>
              Download feed working copy
            </button>
          )}
          {preview && (
            <section aria-label="Unsaved feed movement preview">
              <h3>Unsaved feed movement preview</h3>
              <p>
                {preview.kind} · {preview.date} · {preview.kg} kg ·{" "}
                {preview.currency} {preview.value ?? "Unknown value"}
              </p>
              <p className="helper">
                No movement or audit has been saved. The server rechecks stock,
                source evidence and the loaded organization head at
                confirmation.
              </p>
            </section>
          )}
          <section aria-label="Frozen feed stock report">
            <h3>Feed stock and cost reconciliation</h3>
            <p className="helper">
              As of {w.report.asOf} · append position ≤{" "}
              {w.report.throughPosition} · {w.report.events.length} events. Date
              and append cutoff freeze this exact report even after
              later/backdated records. A full consumed-feed cost requires every
              relevant observation and all its lot costs; known totals alone do
              not establish complete costs or profit.
            </p>
            <div className="button-row">
              <button
                className="text-button"
                onClick={() => void download("json")}
              >
                Download feed stock JSON
              </button>
              <button
                className="text-button"
                onClick={() => void download("csv")}
              >
                Download feed stock CSV
              </button>
            </div>
            <p className="helper">
              Evidence SHA-256: {w.report.evidenceSha256}
            </p>
            {w.report.results.currencies.map((c) => (
              <p className="notice" key={c.currency}>
                {c.currency} known received {c.knownReceivedValue} = consumed{" "}
                {c.knownConsumedValue} + lost {c.knownLostValue} + remaining{" "}
                {c.knownRemainingValue}. Unknown-value lots:{" "}
                {c.unknownValueLots}; unknown consumed {c.unknownConsumedKg} kg;
                unknown remaining {c.unknownRemainingKg} kg. Currencies stay
                separate.
              </p>
            ))}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Original feed lot</th>
                    <th>Received kg / value</th>
                    <th>Consumed kg / value</th>
                    <th>Lost kg / value</th>
                    <th>Remaining kg / value</th>
                  </tr>
                </thead>
                <tbody>
                  {w.report.results.lots.map((l) => (
                    <tr key={l.receipt.id}>
                      <td>
                        {l.feedName}
                        <span className="helper">
                          {l.location} · {l.currency} ·{" "}
                          {l.active ? "Active" : "Erroneous receipt reversed"}
                        </span>
                      </td>
                      <td>
                        {l.receivedKg}
                        <span className="helper">
                          {l.receivedValue ?? "Unknown"}
                        </span>
                      </td>
                      <td>
                        {l.consumedKg}
                        <span className="helper">
                          {l.consumedValue ?? "Unknown"}
                        </span>
                      </td>
                      <td>
                        {l.lostKg}
                        <span className="helper">
                          {l.lostValue ?? "Unknown"}
                        </span>
                      </td>
                      <td>
                        {l.balanceKg}
                        <span className="helper">
                          {l.remainingValue ?? "Unknown"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Linked actual feed by batch</h3>
            <p className="helper">
              Original-currency known subtotals for linked consumption in this
              report. Unlinked daily feed, unknown purchase costs and changed
              sources prevent treating these as complete current feed costs.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Currency</th>
                    <th>Linked consumed kg</th>
                    <th>Known consumed value</th>
                    <th>Unknown-cost kg</th>
                  </tr>
                </thead>
                <tbody>
                  {w.report.results.batches.map((b) => (
                    <tr key={b.unitId + b.currency}>
                      <td>{b.unitName}</td>
                      <td>{b.currency}</td>
                      <td>{b.consumedKg}</td>
                      <td>{b.knownConsumedValue}</td>
                      <td>{b.unknownCostKg}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Immutable feed movement history</h3>
            {w.report.events.length === 0 ? (
              <p className="helper">
                No feed purchase or stock movements recorded. Daily feed and
                forecasts do not automatically create stock.
              </p>
            ) : (
              w.report.events.map((e) => (
                <details key={e.id}>
                  <summary>
                    {e.recorded_on} · {e.kind} · {e.weight_kg} kg · {e.currency}{" "}
                    {e.amount ?? "Unknown value"}
                  </summary>
                  <p className="helper">
                    {e.input.reason} · {e.input.evidence}
                  </p>
                  <pre>{JSON.stringify(e, null, 2)}</pre>
                </details>
              ))
            )}
          </section>
        </>
      )}
    </section>
  );
}
