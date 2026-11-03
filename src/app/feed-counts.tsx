"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  feedCountInput,
  feedCountPreview,
  type FeedCountInput,
  type FeedCountWorkspace,
} from "@/lib/feed-counts";
export default function FeedCounts({
  organizationId,
  actor,
  role,
  blocked,
  onPendingChange,
  onSaved,
}: {
  organizationId: string;
  actor: string;
  role: string;
  blocked: boolean;
  onPendingChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const canRecord = ["owner", "admin", "manager", "inventory"].includes(role),
    canApprove = ["owner", "admin", "manager"].includes(role),
    key = `farmstead.feed-stocktake.${actor}.${organizationId}`;
  const [w, setW] = useState<FeedCountWorkspace | null>(null),
    [lot, setLot] = useState(""),
    [view, setView] = useState(""),
    [mode, setMode] = useState<"count" | "resolve_shortage">("count"),
    [count, setCount] = useState(""),
    [date, setDate] = useState(""),
    [reference, setReference] = useState(""),
    [kg, setKg] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [base, setBase] = useState<{ stock: string; counts: string } | null>(null),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<FeedCountInput | null>(null),
    [recovered, setRecovered] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] = useState<ReturnType<
      typeof feedCountPreview
    > | null>(null);
  function path(target = lot, id = view) {
    const q = new URLSearchParams({ organizationId });
    if (target) q.set("lotId", target);
    if (id) q.set("eventId", id);
    return "inventory/feed/counts?" + q;
  }
  useEffect(() => {
    let active = true;
    void api<FeedCountWorkspace>(
      "inventory/feed/counts?organizationId=" + organizationId,
    )
      .then((v) => {
        if (active) {
          setW(v);
          setDate(v.today);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = feedCountInput.safeParse(JSON.parse(raw));
          if (p.success && p.data.organizationId === organizationId)
            setPending(p.data);
          else
            setStorageWarning(
              "The saved count receipt cannot be read. Review history before repeating the action.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until confirmation.",
        );
      } finally {
        setRecovered(true);
      }
    });
  }, [key, organizationId]);
  useEffect(() => {
    onPendingChange(!!pending || !recovered);
  }, [pending, recovered, onPendingChange]);
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
      busy || !!pending || blocked || !recovered || !w || !canRecord,
    selected = w?.counts.find((c) => c.id === count),
    changed =
      !!base &&
      !!w &&
      (base.stock !== w.expectedStockPosition ||
        base.counts !== w.expectedCountPosition);
  function edit() {
    if (!base && w)
      setBase({
        stock: w.expectedStockPosition,
        counts: w.expectedCountPosition,
      });
    setDirty(true);
    setAck(false);
    setPreview(null);
    setNotice("");
  }
  function remember(p: FeedCountInput | null) {
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
  async function load(target = lot, id = view) {
    setBusy(true);
    setError("");
    try {
      const v = await api<FeedCountWorkspace>(path(target, id));
      setW(v);
      setLot(target);
      setView(id);
      setBase({
        stock: v.expectedStockPosition,
        counts: v.expectedCountPosition,
      });
      setAck(false);
      setPreview(null);
      setNotice(
        "Current stocktakes reloaded. Working inputs retained; reweigh/review the current source and confirm again.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function payload() {
    if (!w?.selected?.sourceSha256)
      throw Error("Choose a current active lot within the count source bound.");
    if (
      mode === "resolve_shortage" &&
      (!selected?.canResolve || selected.lotId !== w.selected.lotId)
    )
      throw Error(
        "Choose a current unresolved shortage. Surplus, stale and superseded counts cannot append a loss.",
      );
    return feedCountInput.parse({
      organizationId,
      eventId: crypto.randomUUID(),
      expectedStockPosition: base?.stock ?? w.expectedStockPosition,
      expectedCountPosition: base?.counts ?? w.expectedCountPosition,
      expectedSourceSha256: w.selected.sourceSha256,
      data:
        mode === "count"
          ? {
              kind: mode,
              lotId: lot,
              date,
              previousId: w.selected.latestId,
              reference,
              countedKg: kg,
              scope: "actual-weighed-unused-feed-lot-count",
              reason,
              evidence,
            }
          : {
              kind: mode,
              countId: count,
              scope: "approve-weighed-shortage-as-feed-loss",
              reason,
              evidence,
            },
    });
  }
  function evaluate() {
    payload();
    if (!w?.selected?.source)
      throw Error("Load the full current physical source first.");
    return feedCountPreview(
      w.selected.source,
      mode === "count" ? kg : selected!.countedKg,
    );
  }
  async function submit(p: FeedCountInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    try {
      const r = await api<{ replayed: boolean }>("inventory/feed/counts", p),
        v = await api<FeedCountWorkspace>(path(lot, p.eventId));
      setW(v);
      setView(p.eventId);
      remember(null);
      setBase(null);
      setAck(false);
      setPreview(null);
      setDirty(false);
      setNotice(
        r.replayed
          ? "Original stocktake receipt confirmed; no duplicate count, loss or audit."
          : p.data.kind === "count"
            ? "Weighed count saved. Available stock and Finance are unchanged."
            : "Shortage approved; exactly one physical loss appended. Finance is unchanged.",
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && [400, 403, 404, 409, 422].includes(e.status))
        remember(null);
    } finally {
      setBusy(false);
    }
  }
  async function download(format: "json" | "csv") {
    setError("");
    try {
      await downloadReport(
        path(lot, view) + "&format=" + format,
        "feed-stocktake." + format,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section
      aria-label="Weighed feed stocktakes"
      className="feed-review feed-counts"
    >
      <div className="panel-heading">
        <h3>Weighed feed stocktakes</h3>
        <button
          type="button"
          className="text-button"
          disabled={busy || !!pending}
          onClick={() => void load()}
        >
          Reload current stocktakes
        </button>
      </div>
      <p className="helper">
        Count unused stock from one identified purchase lot. Observations
        preserve the physical source and move no stock. A manager may approve a
        current shortage as one loss; Finance separately recognizes its value.
        Surplus stays unresolved while identity, ownership and source records
        are investigated. Counts do not correct actual consumed feed.
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
            A stocktake receipt awaits confirmation. New stocktake, stock and
            review actions are locked until it is resolved.
          </p>
          <button
            type="button"
            disabled={
              busy ||
              !canRecord ||
              (pending.data.kind === "resolve_shortage" && !canApprove)
            }
            onClick={() => void submit(pending)}
          >
            Retry exact stocktake receipt
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => downloadJson("feed-stocktake-pending.json", pending)}
          >
            Download pending stocktake receipt
          </button>
        </div>
      )}
      {!w ? (
        <p>
          Stocktakes could not be loaded. Reload before entering a measurement.
        </p>
      ) : (
        <>
          <section aria-label="Current stocktake differences">
            <h4>Current stocktake differences</h4>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Count / date</th>
                    <th>Recorded / counted kg</th>
                    <th>Difference kg</th>
                    <th>Original shortage value</th>
                    <th>Status</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {w.counts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.reference}
                        <span className="helper">{c.date}</span>
                      </td>
                      <td>
                        {c.recordedKg} / {c.countedKg}
                      </td>
                      <td>{c.varianceKg}</td>
                      <td>
                        {c.classification === "shortage"
                          ? `${c.currency} ${c.shortageValue ?? "Unknown"}`
                          : "—"}
                      </td>
                      <td>
                        {c.resolutionId
                          ? c.lossActive
                            ? "Approved loss recorded"
                            : "Approved loss later voided; record a new count"
                          : !c.sourceCurrent
                            ? "Physical source changed; record a new count"
                            : c.classification === "surplus"
                              ? "Surplus · investigation required"
                              : c.classification === "match"
                                ? "Count matches recorded stock"
                                : "Shortage · manager approval required"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy || !!pending}
                          onClick={() => void load(c.lotId, c.id)}
                        >
                          View {c.reference}
                        </button>
                        {canApprove && c.canResolve && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={disabled}
                            onClick={() => {
                              edit();
                              setMode("resolve_shortage");
                              setCount(c.id);
                              void load(c.lotId, c.id);
                            }}
                          >
                            Review shortage {c.reference}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {w.counts.length === 0 && (
              <p>
                No weighed counts recorded. Available stock comes from the
                physical ledger.
              </p>
            )}
          </section>
          {canRecord ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (disabled || changed || !ack) return;
                try {
                  void submit(payload());
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <fieldset className="feed-stock-fields" disabled={disabled}>
                <legend>Review a weighed stocktake</legend>
                <label>
                  Stocktake activity
                  <select
                    value={mode}
                    onChange={(e) => {
                      edit();
                      setMode(e.target.value as typeof mode);
                    }}
                  >
                    <option value="count">Record a weighed count</option>
                    {canApprove && (
                      <option value="resolve_shortage">
                        Approve a current shortage as loss
                      </option>
                    )}
                  </select>
                </label>
                {mode === "count" ? (
                  <>
                    <label>
                      Counted purchased feed lot
                      <select
                        value={lot}
                        required
                        onChange={(e) => {
                          edit();
                          void load(e.target.value, view);
                        }}
                      >
                        <option value="">Choose an active original lot</option>
                        {w.lots.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.label} · {l.balanceKg} kg · {l.currency}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Physical count date
                      <input
                        type="date"
                        value={date}
                        min="1900-01-01"
                        max={w.today}
                        required
                        onChange={(e) => {
                          edit();
                          setDate(e.target.value);
                        }}
                      />
                    </label>
                    <label>
                      Count reference
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
                      Actually weighed unused feed kg
                      <input
                        value={kg}
                        placeholder="Measured kg, including explicit zero"
                        required
                        onChange={(e) => {
                          edit();
                          setKg(e.target.value);
                        }}
                      />
                    </label>
                  </>
                ) : (
                  <label>
                    Current shortage count
                    <select
                      value={count}
                      required
                      onChange={(e) => {
                        edit();
                        setCount(e.target.value);
                        const row = w.counts.find(
                          (c) => c.id === e.target.value,
                        );
                        if (row) void load(row.lotId, row.id);
                      }}
                    >
                      <option value="">
                        Choose a current unresolved shortage
                      </option>
                      {w.counts
                        .filter((c) => c.classification === "shortage")
                        .map((c) => (
                          <option
                            key={c.id}
                            value={c.id}
                            disabled={!c.canResolve}
                          >
                            {c.reference} · {c.date} · {c.varianceKg} kg
                            {!c.canResolve ? " · not currently approvable" : ""}
                          </option>
                        ))}
                      {count && !selected && (
                        <option value={count}>
                          Selected count is superseded or unavailable
                        </option>
                      )}
                    </select>
                  </label>
                )}
                {w.selected?.sourceTooLarge && (
                  <p role="alert">
                    Current physical source exceeds the 256 KiB count bound.
                    Saved count exports remain available.
                  </p>
                )}
                {w.selected?.source && (
                  <p className="helper">
                    Original currency {w.selected.source.receipt.currency}.{" "}
                    {mode === "count"
                      ? "A count reference is reserved for this lot, including after a later recount. Review the current recorded quantity before saving this actual measurement."
                      : "Approval uses the count date and exact captured shortage. A changed source or newer count requires a fresh observation. No financial journal is posted."}
                  </p>
                )}
                <label>
                  Stocktake review reason
                  <textarea
                    value={reason}
                    minLength={10}
                    maxLength={mode === "count" ? 2000 : 1000}
                    required
                    onChange={(e) => {
                      edit();
                      setReason(e.target.value);
                    }}
                  />
                </label>
                <label>
                  Weighing and investigation evidence
                  <textarea
                    value={evidence}
                    minLength={3}
                    maxLength={mode === "count" ? 2000 : 1500}
                    required
                    onChange={(e) => {
                      edit();
                      setEvidence(e.target.value);
                    }}
                  />
                </label>
                <label className="feed-stock-check">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  <span>
                    I confirm this weighed-stocktake decision and its evidence.
                    Recording a count does not move stock; approving a shortage
                    appends one loss and does not post Finance.
                  </span>
                </label>
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setError("");
                      try {
                        setPreview(evaluate());
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Preview stocktake decision
                  </button>
                  <button className="primary" disabled={!ack || changed}>
                    {mode === "count"
                      ? "Record weighed count"
                      : "Approve shortage as loss"}
                  </button>
                </div>
              </fieldset>
              {changed && (
                <p role="alert">
                  Stock or counts changed. Keep a working copy, reload and
                  confirm again.
                </p>
              )}
            </form>
          ) : (
            <p className="helper">
              Read-only weighed counts, shortage approvals and private source
              exports.
            </p>
          )}
          {canRecord && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                downloadJson("feed-stocktake-working.json", {
                  organizationId,
                  mode,
                  lot,
                  count,
                  date,
                  reference,
                  countedKg: kg,
                  reason,
                  evidence,
                  base,
                  selected: w.selected,
                })
              }
            >
              Download stocktake working copy
            </button>
          )}
          {preview && (
            <section aria-label="Unsaved stocktake preview">
              <h4>Unsaved stocktake preview</h4>
              <p>
                Recorded {preview.recordedKg} kg · weighed {preview.countedKg}{" "}
                kg · {preview.classification} {preview.varianceKg} kg.
              </p>
              <p>
                Original shortage value: {preview.currency}{" "}
                {preview.shortageValue ?? "Unknown / not a shortage"}.{" "}
                {preview.statement}
              </p>
            </section>
          )}
          <section aria-label="Saved stocktake evidence">
            <h4>Saved stocktake evidence</h4>
            <label>
              Saved stocktake version
              <select
                value={view}
                disabled={busy || !!pending}
                onChange={(e) => void load(lot, e.target.value)}
              >
                <option value="">
                  Choose an exact saved count or approval
                </option>
                {w.history.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.reference} ·{" "}
                    {h.kind === "count" ? "weighed count" : "shortage approval"}{" "}
                    · {h.recorded_on}
                  </option>
                ))}
                {view && !w.history.some((h) => h.id === view) && (
                  <option value={view}>{view} · exact saved version</option>
                )}
              </select>
            </label>
            {w.report && (
              <>
                <p>
                  {w.report.event.input.kind === "count"
                    ? w.report.event.input.reference
                    : "Manager shortage approval"}{" "}
                  · recorded {w.report.results.recordedKg} kg · weighed{" "}
                  {w.report.results.countedKg} kg ·{" "}
                  {w.report.results.classification}{" "}
                  {w.report.results.varianceKg} kg.
                </p>
                <p>{w.report.results.statement}</p>
                {w.report.results.appliedLossId && (
                  <p>
                    Linked physical loss: {w.report.results.appliedLossId} ·{" "}
                    {w.report.results.shortageKg} kg · {w.report.event.currency}{" "}
                    {w.report.results.shortageValue ?? "Unknown value"}.
                  </p>
                )}
                <p className="helper">
                  Evidence SHA-256: {w.report.evidenceSha256}. Current
                  source/approval status is shown separately from this immutable
                  saved version.
                </p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void download("json")}
                >
                  Download stocktake JSON
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void download("csv")}
                >
                  Download stocktake CSV
                </button>
                <details>
                  <summary>Complete saved stocktake source</summary>
                  <pre>{JSON.stringify(w.report.event, null, 2)}</pre>
                </details>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
