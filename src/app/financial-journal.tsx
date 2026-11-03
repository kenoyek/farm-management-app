"use client";
import { useEffect, useState } from "react";
import type { FeedCostBasis } from "@/lib/feed-cost-posting-api";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  chart,
  journalData,
  journalInput,
  journalPurposes,
  recognitionLines,
  feedRecognitionLines,
  type FinancialFeedSource,
  reverseLines,
  type JournalInput,
  type JournalData,
  type JournalLine,
  type JournalWorkspace,
  type FinancialSource,
} from "@/lib/financial-journal";
type WorkingLine = {
  account: string;
  side: "debit" | "credit";
  amount: string;
};
type Original = JournalWorkspace["reversible"][number];
const blankLines = (): WorkingLine[] => [
  { account: "", side: "debit", amount: "" },
  { account: "", side: "credit", amount: "" },
];
export default function FinancialJournal({
  organizationId,
  actor,
  role,
}: {
  organizationId: string;
  actor: string;
  role: string;
}) {
  const canPost = ["owner", "admin", "manager"].includes(role),
    endpoint = `finance/journal?organizationId=${organizationId}`,
    key = `farmstead:financial-journal:v1:${organizationId}:${actor}`;
  const [workspace, setWorkspace] = useState<JournalWorkspace | null>(null),
    [base, setBase] = useState<string | null>(null),
    [mode, setMode] = useState<JournalData["kind"]>("manual"),
    [date, setDate] = useState(""),
    [currency, setCurrency] = useState(""),
    [unit, setUnit] = useState(""),
    [purpose, setPurpose] = useState(""),
    [reference, setReference] = useState(""),
    [description, setDescription] = useState(""),
    [lines, setLines] = useState(blankLines),
    [source, setSource] = useState<FinancialSource | null>(null),
    [feedSource, setFeedSource] = useState<FinancialFeedSource | null>(null),
    [purchaseSettlement, setPurchaseSettlement] = useState<
      "payables" | "cash_bank" | ""
    >(""),
    [consumptionTreatment, setConsumptionTreatment] = useState<
      "expense" | "work_in_progress" | ""
    >(""),
    [paymentEvidence, setPaymentEvidence] = useState(""),
    [costReview, setCostReview] = useState(""),
    [costSettlement, setCostSettlement] = useState<
      "payables" | "cash_bank" | ""
    >(""),
    [costTreatment, setCostTreatment] = useState<
      "expense" | "work_in_progress" | ""
    >(""),
    [costPayment, setCostPayment] = useState(""),
    [costPreview, setCostPreview] = useState<FeedCostBasis | null>(null),
    [original, setOriginal] = useState<Original | null>(null),
    [settlement, setSettlement] = useState(""),
    [cashEvidence, setCashEvidence] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [asOf, setAsOf] = useState(""),
    [cutoff, setCutoff] = useState(""),
    [search, setSearch] = useState(""),
    [sourceStatus, setSourceStatus] = useState("unrecognized"),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<JournalInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(""),
    [preview, setPreview] = useState<{
      currency: string;
      date: string;
      lines: JournalLine[];
    } | null>(null);
  function path(day = asOf, pos = cutoff) {
    const q = new URLSearchParams({ organizationId, sourceStatus, search });
    if (day) q.set("asOf", day);
    if (pos) q.set("throughPosition", pos);
    return "finance/journal?" + q;
  }
  useEffect(() => {
    let active = true;
    void api<JournalWorkspace>(endpoint)
      .then((w) => {
        if (active) {
          setWorkspace(w);
          setAsOf(w.report.asOf);
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
  }, [endpoint]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = journalInput.safeParse(JSON.parse(raw));
          if (p.success && p.data.organizationId === organizationId)
            setPending(p.data);
          else
            setStorageWarning(
              "The saved journal receipt cannot be read. Review posted history before repeating it.",
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
  const disabled = busy || !!pending || !canPost || !workspace,
    changed =
      base !== null && !!workspace && base !== workspace.expectedPosition;
  function edit() {
    if (base === null) setBase(workspace?.expectedPosition ?? null);
    setDirty(true);
    setAck(false);
    setPreview(null);
    setCostPreview(null);
    setNotice("");
  }
  function remember(p: JournalInput | null) {
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
  async function load(rebase = false, latest = false) {
    setBusy(true);
    setError("");
    try {
      const w = await api<JournalWorkspace>(path(asOf, latest ? "" : cutoff));
      setWorkspace(w);
      setAsOf(w.report.asOf);
      if (latest) setCutoff("");
      if (rebase) {
        setBase(w.expectedPosition);
        setAck(false);
        setPreview(null);
        setNotice(
          "Current journal reloaded. Working inputs retained; review sources and confirm again.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function data() {
    const common = { reason, evidence };
    if (mode === "manual")
      return {
        kind: mode,
        date,
        currency,
        unitId: unit || null,
        purpose,
        reference,
        description,
        lines,
        scope: "evidenced-manual-book-entry",
        ...common,
      };
    if (mode === "recognize_sale")
      return {
        kind: mode,
        sourceKind: source?.source_kind,
        sourceId: source?.source_id,
        settlement,
        cashEvidence: settlement === "cash_bank" ? cashEvidence : null,
        policy: "recorded-dispatch-value-v1",
        ...common,
      };
    if (mode === "recognize_feed")
      return {
        kind: mode,
        sourceId: feedSource?.source_id,
        purchaseSettlement:
          feedSource?.kind === "receipt" ? purchaseSettlement || null : null,
        consumptionTreatment:
          feedSource?.kind === "consume" ? consumptionTreatment || null : null,
        paymentEvidence:
          feedSource?.kind === "receipt" && purchaseSettlement === "cash_bank"
            ? paymentEvidence
            : null,
        policy: "recorded-feed-lot-value-v1",
        ...common,
      };
    if (mode === "recognize_feed_cost")
      return {
        kind: mode,
        reviewId: costReview,
        settlement: costSettlement,
        consumptionTreatment: costTreatment,
        paymentEvidence: costSettlement === "cash_bank" ? costPayment : null,
        policy: "reviewed-feed-cost-ledger-v1",
        ...common,
      };
    return { kind: mode, originalId: original?.id, date, ...common };
  }
  async function save(p: JournalInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("finance/journal", p);
      committed = true;
      const w = await api<JournalWorkspace>(path());
      setWorkspace(w);
      setAsOf(w.report.asOf);
      remember(null);
      setBase(null);
      setLines(blankLines());
      setSource(null);
      setFeedSource(null);
      setPurchaseSettlement("");
      setConsumptionTreatment("");
      setPaymentEvidence("");
      setOriginal(null);
      setReference("");
      setDescription("");
      setReason("");
      setEvidence("");
      setCashEvidence("");
      setAck(false);
      setDirty(false);
      setPreview(null);
      setCostPreview(null);
      setCostReview("");
      setCostSettlement("");
      setCostTreatment("");
      setCostPayment("");
      setNotice(
        "Journal entry posted with balanced debits and credits. Physical stock and external cash movements are unchanged.",
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
    if (
      mode === "recognize_feed" &&
      (!feedSource ||
        !feedSource.eligible ||
        feedSource.amount === null ||
        (feedSource.kind === "receipt" && !purchaseSettlement) ||
        (feedSource.kind === "consume" && !consumptionTreatment))
    ) {
      setError(
        "Choose an eligible known-value feed movement and its explicit accounting treatment. Recognize the purchase first; changed actual-feed sources require reconciliation.",
      );
      return;
    }
    const p = journalData.safeParse(data());
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    if (!saving && p.data.kind === "recognize_feed_cost") {
      setBusy(true);
      setError("");
      void api<FeedCostBasis>(
        "finance/feed-costs/preview",
        journalInput.parse({
          organizationId,
          entryId: crypto.randomUUID(),
          expectedPosition: base ?? workspace!.expectedPosition,
          data: p.data,
        }),
      )
        .then((v) => {
          setPreview({
            currency: v.currency,
            date: v.postedOn,
            lines: v.lines,
          });
          setCostPreview(v);
        })
        .catch((e) => setError(e.message))
        .finally(() => setBusy(false));
      return;
    }
    if (!saving) {
      if (p.data.kind === "manual")
        setPreview({
          currency: p.data.currency,
          date: p.data.date,
          lines: p.data.lines,
        });
      else if (p.data.kind === "recognize_sale" && source)
        setPreview({
          currency: source.currency,
          date: source.recorded_on,
          lines: recognitionLines(
            source.amount,
            source.source_kind,
            p.data.settlement,
          ),
        });
      else if (
        p.data.kind === "recognize_feed" &&
        feedSource &&
        feedSource.amount !== null
      )
        setPreview({
          currency: feedSource.currency,
          date: feedSource.recorded_on,
          lines: feedRecognitionLines(
            feedSource.amount,
            feedSource.kind,
            p.data.purchaseSettlement,
            p.data.consumptionTreatment,
          ),
        });
      else if (p.data.kind === "reverse" && original)
        setPreview({
          currency: original.currency,
          date: p.data.date,
          lines: reverseLines(original.lines),
        });
      setError("");
      return;
    }
    if (!ack) {
      setError(
        "Confirm the accounting evidence and posting scope before posting.",
      );
      return;
    }
    void save(
      journalInput.parse({
        organizationId,
        entryId: crypto.randomUUID(),
        expectedPosition: base ?? workspace!.expectedPosition,
        data: p.data,
      }),
    );
  }
  async function download(format: "json" | "csv") {
    if (!workspace) return;
    setBusy(true);
    setError("");
    try {
      await downloadReport(
        `${endpoint}&asOf=${workspace.report.asOf}&throughPosition=${workspace.report.throughPosition}&format=${format}`,
        `financial-journal.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function lineTable(rows: JournalLine[]) {
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Side</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.account} · {chart.find((a) => a.code === l.account)?.name}
                </td>
                <td>{l.side}</td>
                <td>{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section
      className="module financial-journal"
      aria-label="Financial journal and trial balance"
    >
      <div className="panel-heading">
        <h2>Financial journal and trial balance</h2>
        <button
          type="button"
          className="text-button"
          disabled={busy || !!pending}
          onClick={() => void load(true, true)}
        >
          Reload current journal
        </button>
      </div>
      <p className="helper">
        Post evidenced, balanced book entries in one original currency. Source
        recognition covers recorded broiler sales and feed purchases,
        consumption and losses; it preserves original dates, currencies and
        values with explicit accounting treatments. It does not dispatch stock
        or move bank funds. Managerial cost reviews, recipes and forecasts never
        post accounts automatically.
      </p>
      <p className="helper">
        Manual entries can record purchases, consumption, expenses, cost
        transfers and cash records using your accounting/valuation evidence.
        Enter inventory receipt and consumption separately; use supported actual
        valuation records. A balanced trial balance shows posted entries, not
        complete books, verified cash, automated inventory valuation or farm
        profit.
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
            A journal receipt is awaiting confirmation. Retry this exact receipt
            before another financial entry.
          </p>
          <button
            type="button"
            disabled={busy || !canPost}
            onClick={() => void save(pending)}
          >
            Retry exact journal receipt
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              downloadJson("financial-journal-pending.json", pending)
            }
          >
            Download pending journal receipt
          </button>
        </div>
      )}
      <fieldset className="finance-fields" disabled={busy || !!pending}>
        <legend>Load trial balance and recorded sources</legend>
        <div className="form-grid">
          <label>
            Journal as-of date
            <input
              type="date"
              min="1900-01-01"
              max={workspace?.today}
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
          <label>
            Append-position cutoff · blank uses latest
            <input
              inputMode="numeric"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              placeholder="Latest journal position"
            />
          </label>
          <label>
            Search sale or feed sources
            <input
              value={search}
              maxLength={80}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            Recorded source filter
            <select
              value={sourceStatus}
              onChange={(e) => setSourceStatus(e.target.value)}
            >
              <option value="unrecognized">Unrecognized sources</option>
              <option value="all">All active sources</option>
            </select>
          </label>
        </div>
        <button type="button" onClick={() => void load()}>
          Load journal view
        </button>
      </fieldset>
      {workspace && (
        <>
          <p className="notice">
            {workspace.unrecognizedSales} of {workspace.activeSales} active
            recorded broiler sales are not financially recognized. Search shows{" "}
            {workspace.sources.length} of {workspace.sourceMatches} matching
            sources. Coverage is current loaded state; it is separate from the
            trial-balance date/position limits.
          </p>
          <p className="notice">
            Feed recognition: {workspace.feedCoverage.recognized} of{" "}
            {workspace.feedCoverage.active} active movements recognized;{" "}
            {workspace.feedCoverage.unknown} unknown-value and{" "}
            {workspace.feedCoverage.changed} changed-source movements. Showing{" "}
            {workspace.feedSources.length} of {workspace.feedSourceMatches} feed
            matches using the same reference/feed-name search and recognition
            filter above. Current coverage is outside frozen report evidence; it
            does not establish complete inventory books.
          </p>
          {canPost ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(true);
              }}
            >
              <fieldset className="finance-fields" disabled={disabled}>
                <legend>Review a financial entry</legend>
                <label>
                  Journal activity
                  <select
                    value={mode}
                    onChange={(e) => {
                      edit();
                      setMode(e.target.value as typeof mode);
                      setBase(workspace.expectedPosition);
                    }}
                  >
                    <option value="manual">Manual balanced entry</option>
                    <option value="recognize_feed_cost">
                      Post a reviewed feed cost
                    </option>
                    <option value="recognize_feed">
                      Recognize a recorded feed movement
                    </option>
                    <option value="recognize_sale">
                      Recognize a recorded broiler sale
                    </option>
                    <option value="reverse">Reverse an accounting entry</option>
                  </select>
                </label>
                {mode === "manual" && (
                  <>
                    <div className="form-grid">
                      <label>
                        Accounting date
                        <input
                          type="date"
                          min="1900-01-01"
                          max={workspace.today}
                          value={date}
                          onChange={(e) => {
                            edit();
                            setDate(e.target.value);
                          }}
                          required
                        />
                      </label>
                      <label>
                        Original journal currency
                        <input
                          value={currency}
                          maxLength={3}
                          placeholder="NGN"
                          onChange={(e) => {
                            edit();
                            setCurrency(e.target.value);
                          }}
                          required
                        />
                      </label>
                      <label>
                        Journal purpose
                        <select
                          value={purpose}
                          onChange={(e) => {
                            edit();
                            setPurpose(e.target.value);
                          }}
                          required
                        >
                          <option value="">Choose a purpose</option>
                          {journalPurposes.map((p) => (
                            <option key={p} value={p}>
                              {p.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Broiler batch cost center · optional
                        <select
                          value={unit}
                          onChange={(e) => {
                            edit();
                            setUnit(e.target.value);
                          }}
                        >
                          <option value="">Organization general entry</option>
                          {workspace.units.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Unique manual book reference
                        <input
                          value={reference}
                          maxLength={100}
                          onChange={(e) => {
                            edit();
                            setReference(e.target.value);
                          }}
                          required
                        />
                      </label>
                      <label>
                        Journal description
                        <textarea
                          value={description}
                          maxLength={1000}
                          onChange={(e) => {
                            edit();
                            setDescription(e.target.value);
                          }}
                          required
                        />
                      </label>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Account</th>
                            <th>Debit / credit</th>
                            <th>Amount · four decimals</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l, i) => (
                            <tr key={i}>
                              <td>
                                <select
                                  aria-label={`Journal line ${i + 1} account`}
                                  value={l.account}
                                  onChange={(e) => {
                                    edit();
                                    setLines(
                                      lines.map((r, j) =>
                                        j === i
                                          ? { ...r, account: e.target.value }
                                          : r,
                                      ),
                                    );
                                  }}
                                >
                                  <option value="">Choose an account</option>
                                  {chart
                                    .filter(
                                      (a) => !["4000", "4100"].includes(a.code),
                                    )
                                    .map((a) => (
                                      <option key={a.code} value={a.code}>
                                        {a.code} · {a.name}
                                      </option>
                                    ))}
                                </select>
                              </td>
                              <td>
                                <select
                                  aria-label={`Journal line ${i + 1} side`}
                                  value={l.side}
                                  onChange={(e) => {
                                    edit();
                                    setLines(
                                      lines.map((r, j) =>
                                        j === i
                                          ? {
                                              ...r,
                                              side: e.target
                                                .value as typeof r.side,
                                            }
                                          : r,
                                      ),
                                    );
                                  }}
                                >
                                  <option value="debit">Debit</option>
                                  <option value="credit">Credit</option>
                                </select>
                              </td>
                              <td>
                                <input
                                  aria-label={`Journal line ${i + 1} amount`}
                                  inputMode="decimal"
                                  value={l.amount}
                                  onChange={(e) => {
                                    edit();
                                    setLines(
                                      lines.map((r, j) =>
                                        j === i
                                          ? { ...r, amount: e.target.value }
                                          : r,
                                      ),
                                    );
                                  }}
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="text-button"
                                  disabled={lines.length <= 2}
                                  onClick={() => {
                                    edit();
                                    setLines(lines.filter((_, j) => i !== j));
                                  }}
                                >
                                  Remove journal line {i + 1}
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
                      disabled={lines.length >= 20}
                      onClick={() => {
                        edit();
                        setLines([
                          ...lines,
                          { account: "", side: "debit", amount: "" },
                        ]);
                      }}
                    >
                      Add journal line
                    </button>
                  </>
                )}
                {mode === "recognize_sale" && (
                  <>
                    <label>
                      Recorded broiler sale
                      <select
                        value={
                          source
                            ? `${source.source_kind}:${source.source_id}`
                            : ""
                        }
                        onChange={(e) => {
                          edit();
                          setSource(
                            workspace.sources.find(
                              (s) =>
                                `${s.source_kind}:${s.source_id}` ===
                                e.target.value,
                            ) ?? null,
                          );
                          setBase(workspace.expectedPosition);
                        }}
                        required
                      >
                        <option value="">Choose a recorded sale</option>
                        {source &&
                          !workspace.sources.some(
                            (s) =>
                              s.source_id === source.source_id &&
                              s.source_kind === source.source_kind,
                          ) && (
                            <option
                              value={`${source.source_kind}:${source.source_id}`}
                            >
                              {source.reference} · previously selected source;
                              reload/review
                            </option>
                          )}
                        {workspace.sources.map((s) => (
                          <option
                            key={`${s.source_kind}:${s.source_id}`}
                            value={`${s.source_kind}:${s.source_id}`}
                            disabled={!!s.recognized_id}
                          >
                            {s.source_kind} · {s.unit_name} · {s.reference} ·{" "}
                            {s.currency} {s.amount}
                            {s.recognized_id ? " · recognized" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {source && (
                      <p className="notice">
                        Original dispatch: {source.recorded_on} ·{" "}
                        {source.reference} · {source.customer} ·{" "}
                        {source.currency} {source.amount}. Value and date are
                        derived again from the immutable source when posted;
                        zero-priced sales remain explicit.
                      </p>
                    )}
                    <label>
                      Sale settlement evidence
                      <select
                        value={settlement}
                        onChange={(e) => {
                          edit();
                          setSettlement(e.target.value);
                        }}
                        required
                      >
                        <option value="">
                          Choose the supported settlement
                        </option>
                        <option value="receivables">
                          Trade receivable · cash not claimed
                        </option>
                        <option value="cash_bank">
                          Cash/bank received · receipt evidence required
                        </option>
                      </select>
                    </label>
                    {settlement === "cash_bank" && (
                      <label>
                        Cash or bank receipt evidence
                        <textarea
                          value={cashEvidence}
                          maxLength={1000}
                          onChange={(e) => {
                            edit();
                            setCashEvidence(e.target.value);
                          }}
                          required
                        />
                      </label>
                    )}
                    <p className="helper">
                      You are explicitly recognizing recorded dispatch value
                      under the v1 policy. Confirm that revenue-recognition
                      criteria are supported by your evidence and that this sale
                      has not already been booked elsewhere. This records book
                      evidence, not collection through the app or release
                      certification.
                    </p>
                  </>
                )}
                {mode === "recognize_feed" && (
                  <>
                    <label>
                      Recorded feed movement
                      <select
                        value={feedSource?.source_id ?? ""}
                        onChange={(e) => {
                          edit();
                          setFeedSource(
                            workspace.feedSources.find(
                              (s) => s.source_id === e.target.value,
                            ) ?? null,
                          );
                          setPurchaseSettlement("");
                          setConsumptionTreatment("");
                          setPaymentEvidence("");
                          setBase(workspace.expectedPosition);
                        }}
                        required
                      >
                        <option value="">
                          Choose an eligible feed movement
                        </option>
                        {feedSource &&
                          !workspace.feedSources.some(
                            (s) => s.source_id === feedSource.source_id,
                          ) && (
                            <option value={feedSource.source_id}>
                              {feedSource.reference} · previously selected;
                              reload/review
                            </option>
                          )}
                        {workspace.feedSources.map((s) => (
                          <option
                            key={s.source_id}
                            value={s.source_id}
                            disabled={!s.eligible}
                          >
                            {s.kind} · {s.feed_name} · {s.reference} ·{" "}
                            {s.recorded_on} · {s.weight_kg} kg · {s.currency}{" "}
                            {s.amount ?? "Unknown value"}
                            {s.recognized_id
                              ? " · recognized"
                              : s.amount === null
                                ? " · unknown cost"
                                : !s.source_current
                                  ? " · source changed"
                                  : s.kind !== "receipt" &&
                                      !s.receipt_recognized_id
                                    ? " · recognize purchase first"
                                    : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {feedSource && (
                      <p className="notice">
                        Original feed {feedSource.kind}:{" "}
                        {feedSource.recorded_on} · {feedSource.currency}{" "}
                        {feedSource.amount ?? "Unknown value"} ·{" "}
                        {feedSource.weight_kg} kg. Date, value, original
                        currency and source evidence are derived again when
                        posted.
                      </p>
                    )}
                    {feedSource?.kind === "receipt" && (
                      <>
                        <label>
                          Feed purchase settlement
                          <select
                            value={purchaseSettlement}
                            onChange={(e) => {
                              edit();
                              setPurchaseSettlement(
                                e.target.value as typeof purchaseSettlement,
                              );
                            }}
                            required
                          >
                            <option value="">
                              Choose evidenced settlement
                            </option>
                            <option value="payables">
                              Trade payable · payment not claimed
                            </option>
                            <option value="cash_bank">
                              Cash/bank paid · payment evidence required
                            </option>
                          </select>
                        </label>
                        {purchaseSettlement === "cash_bank" && (
                          <label>
                            Feed purchase payment evidence
                            <textarea
                              value={paymentEvidence}
                              onChange={(e) => {
                                edit();
                                setPaymentEvidence(e.target.value);
                              }}
                              maxLength={1000}
                              required
                            />
                          </label>
                        )}
                      </>
                    )}
                    {feedSource?.kind === "consume" && (
                      <label>
                        Consumed-feed accounting treatment
                        <select
                          value={consumptionTreatment}
                          onChange={(e) => {
                            edit();
                            setConsumptionTreatment(
                              e.target.value as typeof consumptionTreatment,
                            );
                          }}
                          required
                        >
                          <option value="">
                            Choose the evidenced cost policy
                          </option>
                          <option value="expense">
                            Production expense · debit 5000
                          </option>
                          <option value="work_in_progress">
                            Production work in progress · debit 1300
                          </option>
                        </select>
                      </label>
                    )}
                    {feedSource?.kind === "loss" && (
                      <p className="helper">
                        Recorded feed losses debit stock-loss expense and credit
                        feed inventory at the original selected-lot value.
                      </p>
                    )}
                    <p className="helper">
                      Recognize each original purchase before its
                      consumption/loss. Review prior manual book entries to
                      avoid double recognition. Unknown costs and
                      changed/overlinked daily consumption are ineligible. No
                      payment is executed, physical stock moved or cost
                      review/COGS/profit inferred. Purchase accounting reversals
                      require dependent consumption/loss recognition reversed
                      first, with a date no earlier than those reversals.
                    </p>
                  </>
                )}
                {mode === "recognize_feed_cost" && (
                  <>
                    <label>
                      Reviewed feed cost authority
                      <select
                        value={costReview}
                        onChange={(e) => {
                          edit();
                          setCostReview(e.target.value);
                          setBase(workspace.expectedPosition);
                        }}
                        required
                      >
                        <option value="">
                          Choose a current unposted cost review
                        </option>
                        {workspace.feedCostReviews.map((r) => (
                          <option
                            key={r.id}
                            value={r.id}
                            disabled={!r.sourceCurrent || r.posted}
                          >
                            {r.feedName} · version {r.revision} ·{" "}
                            {r.reviewed_on} · {r.currency} {r.totalCost}
                            {r.posted
                              ? " · posted"
                              : !r.sourceCurrent
                                ? " · physical source changed"
                                : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Cost difference settlement
                      <select
                        value={costSettlement}
                        onChange={(e) => {
                          edit();
                          setCostSettlement(
                            e.target.value as typeof costSettlement,
                          );
                        }}
                        required
                      >
                        <option value="">
                          Choose evidenced adjustment settlement
                        </option>
                        <option value="payables">
                          Payable / supplier credit adjustment
                        </option>
                        <option value="cash_bank">
                          Recorded cash/bank payment or refund · evidence
                          required
                        </option>
                      </select>
                    </label>
                    {costSettlement === "cash_bank" && (
                      <label>
                        Cost payment or refund evidence
                        <textarea
                          value={costPayment}
                          onChange={(e) => {
                            edit();
                            setCostPayment(e.target.value);
                          }}
                          maxLength={1000}
                          required
                        />
                      </label>
                    )}
                    <label>
                      Previously unbooked consumption treatment
                      <select
                        value={costTreatment}
                        onChange={(e) => {
                          edit();
                          setCostTreatment(
                            e.target.value as typeof costTreatment,
                          );
                        }}
                        required
                      >
                        <option value="">
                          Choose the policy for unbooked consumed feed
                        </option>
                        <option value="expense">Production expense</option>
                        <option value="work_in_progress">
                          Production work in progress
                        </option>
                      </select>
                    </label>
                    <p className="helper">
                      The server compares full reviewed values with already
                      linked book entries and earlier active cost postings. Only
                      the remaining difference is posted. Existing expense/WIP
                      choices are preserved; this choice applies to unbooked
                      consumption. Unknown original costs may be booked
                      initially from an evidenced review without rewriting
                      original stock values. Review prior manual entries to
                      avoid duplicate booking. All actual sources must be
                      current. The accounting date is the review date, no
                      earlier than prior lot accounting/reversals. Payments are
                      recorded evidence; no bank transaction executes. Reverse
                      newer cost postings first before changing original linked
                      feed accounting or physical sources.
                    </p>
                  </>
                )}
                {mode === "reverse" && (
                  <>
                    <label>
                      Original accounting entry
                      <select
                        value={original?.id ?? ""}
                        onChange={(e) => {
                          edit();
                          setOriginal(
                            workspace.reversible.find(
                              (r) => r.id === e.target.value,
                            ) ?? null,
                          );
                          setBase(workspace.expectedPosition);
                        }}
                        required
                      >
                        <option value="">Choose an unreversed original</option>
                        {workspace.reversible.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.posted_on} · {r.currency} · {r.reference} ·{" "}
                            {r.id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Reversal accounting date
                      <input
                        type="date"
                        min={original?.posted_on ?? "1900-01-01"}
                        max={workspace.today}
                        value={date}
                        onChange={(e) => {
                          edit();
                          setDate(e.target.value);
                        }}
                        required
                      />
                    </label>
                    <p className="helper">
                      A reversal appends opposite original lines in the original
                      currency. It does not refund cash, return stock, delete a
                      sale or correct related entries automatically. Review
                      related book and physical records separately. Reverse
                      financial recognition before voiding an erroneous
                      operational sale; an active source can be explicitly
                      recognized again later.
                    </p>
                  </>
                )}
                <div className="form-grid">
                  <label>
                    Accounting review reason
                    <textarea
                      value={reason}
                      minLength={10}
                      maxLength={2000}
                      onChange={(e) => {
                        edit();
                        setReason(e.target.value);
                      }}
                      required
                    />
                  </label>
                  <label>
                    Accounting source and recognition evidence
                    <textarea
                      value={evidence}
                      maxLength={2000}
                      onChange={(e) => {
                        edit();
                        setEvidence(e.target.value);
                      }}
                      required
                    />
                  </label>
                </div>
                <label className="finance-check">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  <span>
                    I confirm the accounting evidence, original currency and
                    date, and that this entry does not duplicate other postings.
                    These are explicit book records; no physical movement, bank
                    transaction, automatic valuation or complete-profit claim is
                    created.
                  </span>
                </label>
                <div className="button-row">
                  <button
                    type="button"
                    disabled={changed}
                    onClick={() => submit(false)}
                  >
                    Preview journal entry
                  </button>
                  <button type="submit" disabled={changed}>
                    Post balanced journal entry
                  </button>
                </div>
              </fieldset>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  downloadJson("financial-journal-working.json", {
                    organizationId,
                    expectedPosition: base,
                    data: data(),
                    source,
                    feedSource,
                    purchaseSettlement,
                    consumptionTreatment,
                    paymentEvidence,
                    costReview,
                    costSettlement,
                    costTreatment,
                    costPayment,
                    original,
                  })
                }
              >
                Download journal working copy
              </button>
              {changed && (
                <p className="notice">
                  Journal changed. Keep a working copy, reload the current
                  journal and confirm again.
                </p>
              )}
            </form>
          ) : (
            <p className="helper">
              Read-only financial journal, source coverage, trial balance and
              exports.
            </p>
          )}
          {preview && (
            <section aria-label="Unsaved journal preview">
              <h3>Unsaved journal preview</h3>
              <p>
                {preview.date} · {preview.currency}. No entry has been posted by
                this preview.
              </p>
              {lineTable(preview.lines)}
            </section>
          )}
          {costPreview && (
            <section aria-label="Unsaved reviewed-cost basis">
              <h3>Reviewed cost versus already linked books</h3>
              <p>
                {costPreview.currency} reviewed purchase{" "}
                {costPreview.reviewedPurchaseValue} − already booked{" "}
                {costPreview.bookedPurchaseValue} = purchase difference{" "}
                {costPreview.purchaseDelta}. Accounting date{" "}
                {costPreview.postedOn}. This is an unsaved preview.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Source / account</th>
                      <th>Kg</th>
                      <th>Already booked</th>
                      <th>Reviewed value</th>
                      <th>Posting difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costPreview.components.map((c) => (
                      <tr key={c.eventId}>
                        <td>
                          {c.kind} · {c.account}
                          <span className="helper">{c.eventId}</span>
                        </td>
                        <td>{c.weightKg}</td>
                        <td>{c.bookedValue}</td>
                        <td>{c.reviewedValue}</td>
                        <td>{c.delta}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section aria-label="Posted trial balance">
            <h3>Posted trial balance</h3>
            <p className="helper">
              As of {workspace.report.asOf} · append position ≤{" "}
              {workspace.report.throughPosition} ·{" "}
              {workspace.report.entries.length} included entries. Exact
              date/position downloads retain their evidence after later or
              backdated posts. Current source coverage above is outside that
              frozen digest.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void download("json")}
              >
                Download journal JSON
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void download("csv")}
              >
                Download journal CSV
              </button>
            </div>
            <p className="helper">
              Evidence SHA-256: {workspace.report.evidenceSha256}
            </p>
            {workspace.report.trialBalance.length ? (
              workspace.report.trialBalance.map((c) => (
                <section key={c.currency}>
                  <h4>
                    {c.currency} · debits {c.debits} / credits {c.credits}
                  </h4>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Type</th>
                          <th>Debit movements</th>
                          <th>Credit movements</th>
                          <th>Debit balance</th>
                          <th>Credit balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.accounts.map((a) => (
                          <tr key={a.code}>
                            <td>
                              {a.code} · {a.name}
                            </td>
                            <td>{a.type}</td>
                            <td>{a.debits}</td>
                            <td>{a.credits}</td>
                            <td>{a.debitBalance}</td>
                            <td>{a.creditBalance}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="helper">
                    Debit balances {c.debitBalances} · credit balances{" "}
                    {c.creditBalances}. Currencies stay separate. Contra
                    balances and omitted opening/cost postings require
                    accounting review; this is not verified cash or a profit
                    statement.
                  </p>
                </section>
              ))
            ) : (
              <p className="helper">
                No posted entries in this date/position view. No opening
                balances are assumed.
              </p>
            )}
          </section>
          <h3>Immutable financial entry history</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date / entry</th>
                  <th>Reference / kind / currency</th>
                  <th>Canonical lines</th>
                  <th>Review evidence</th>
                </tr>
              </thead>
              <tbody>
                {[...workspace.report.entries].reverse().map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.posted_on}
                      <span className="helper">
                        Position {e.position} · {e.id}
                      </span>
                      {e.reversal_of_id && (
                        <span className="helper">
                          Reverses {e.reversal_of_id}
                        </span>
                      )}
                    </td>
                    <td>
                      {e.reference} · {e.kind} · {e.currency}
                      <span className="helper">{e.description}</span>
                      {e.source_kind && (
                        <span className="helper">
                          Original {e.source_kind} sale {e.source_id}
                        </span>
                      )}
                    </td>
                    <td>
                      {e.lines.map((l, i) => (
                        <span className="helper" key={i}>
                          {l.account} {l.side} {l.amount}
                        </span>
                      ))}
                      <details>
                        <summary>Complete journal/source evidence</summary>
                        <pre>{JSON.stringify(e, null, 2)}</pre>
                      </details>
                    </td>
                    <td>
                      {e.input.reason}
                      <span className="helper">{e.input.evidence}</span>
                      <span className="helper">
                        {e.created_by} · {e.created_at}
                      </span>
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
