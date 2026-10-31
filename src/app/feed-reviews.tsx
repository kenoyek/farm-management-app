"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson, downloadReport } from "@/lib/client";
import {
  feedReviewInput,
  feedReviewResults,
  type FeedReviewData,
  type FeedReviewInput,
  type FeedReviewWorkspace,
} from "@/lib/feed-review";
export default function FeedReviews({
  organizationId,
  actor,
  role,
  blocked,
  onPendingChange,
  onReviewed,
}: {
  organizationId: string;
  actor: string;
  role: string;
  blocked: boolean;
  onPendingChange: (pending: boolean) => void;
  onReviewed: () => void;
}) {
  const canPost = ["owner", "admin", "manager"].includes(role),
    endpoint = `inventory/feed/reviews?organizationId=${organizationId}`,
    key = `farmstead:feed-reviews:v1:${organizationId}:${actor}`;
  const [w, setW] = useState<FeedReviewWorkspace | null>(null),
    [kind, setKind] = useState<"source" | "cost">("cost"),
    [target, setTarget] = useState(""),
    [savedId, setSavedId] = useState(""),
    [date, setDate] = useState(""),
    [total, setTotal] = useState(""),
    [costEvidence, setCostEvidence] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<FeedReviewInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<ReturnType<
      typeof feedReviewResults
    > | null>(null);
  useEffect(() => {
    let active = true;
    void api<FeedReviewWorkspace>(endpoint)
      .then((v) => {
        if (active) setW(v);
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
          const p = feedReviewInput.safeParse(JSON.parse(raw));
          if (p.success && p.data.organizationId === organizationId)
            setPending(p.data);
          else
            setError(
              "Saved review receipt is unreadable. Inspect history before repeating a review.",
            );
        }
      } catch {
        setError(
          "Tab receipt storage is unavailable. Keep this page open until confirmation.",
        );
      }
    });
  }, [key, organizationId]);
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
  function edit() {
    setDirty(true);
    setAck(false);
    setPreview(null);
    setNotice("");
  }
  function remember(p: FeedReviewInput | null) {
    setPending(p);
    try {
      if (p) sessionStorage.setItem(key, JSON.stringify(p));
      else sessionStorage.removeItem(key);
    } catch {
      setError(
        "Tab receipt storage is unavailable. Keep this page open until confirmation.",
      );
    }
  }
  async function load(k = kind, t = target, id = "", propagate = false) {
    setBusy(true);
    setError("");
    try {
      const q = new URLSearchParams({ organizationId, kind: k });
      if (t) q.set("targetId", t);
      if (id) q.set("reviewId", id);
      const v = await api<FeedReviewWorkspace>("inventory/feed/reviews?" + q);
      setW(v);
      setKind(k);
      setTarget(t);
      setSavedId(v.report?.review.id ?? "");
      setAck(false);
      setPreview(null);
      setNotice(
        "Current review evidence loaded. Working inputs retained; review and confirm again.",
      );
    } catch (e) {
      setError((e as Error).message);
      if (propagate) throw e;
    } finally {
      setBusy(false);
    }
  }
  function data(): FeedReviewData {
    const common = {
      targetId: target,
      previousId: w?.selected?.latestId ?? null,
      reason,
      evidence,
    };
    return kind === "source"
      ? {
          kind,
          ...common,
          policy: "same-quantity-current-feed-evidence-v1",
          scope: "unchanged-physical-consumption",
        }
      : {
          kind,
          ...common,
          totalCost: total,
          costEvidence,
          policy: "reviewed-specific-lot-cost-v1",
          scope: "actual-purchase-cost-revision",
        };
  }
  function payload() {
    return feedReviewInput.parse({
      organizationId,
      reviewId: crypto.randomUUID(),
      date,
      expectedStockPosition: w?.expectedStockPosition,
      expectedReviewPosition: w?.expectedReviewPosition,
      expectedSourceSha256: w?.selected?.sourceSha256,
      data: data(),
    });
  }
  async function save(p: FeedReviewInput) {
    setBusy(true);
    setError("");
    remember(p);
    let committed = false;
    try {
      const r = await api<{ id: string; replayed: boolean }>(
        "inventory/feed/reviews",
        p,
      );
      committed = true;
      await load(p.data.kind, p.data.targetId, r.id, true);
      remember(null);
      setDirty(false);
      setAck(false);
      setPreview(null);
      setNotice(
        r.replayed
          ? "Original feed review confirmed; no duplicate review or audit."
          : "Feed review saved. Original stock and journal entries are unchanged.",
      );
      onReviewed();
    } catch (e) {
      setError((e as Error).message);
      if (!committed && e instanceof ApiError && e.status < 500) {
        remember(null);
        setAck(false);
        setNotice(
          "Working inputs retained. Download a copy, reload evidence and confirm again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  function working() {
    downloadJson(
      "feed-review-working-copy.json",
      pending ?? {
        organizationId,
        kind,
        targetId: target,
        date,
        totalCost: total,
        costEvidence,
        reason,
        evidence,
        loadedEvidence: w?.selected,
        expectedStockPosition: w?.expectedStockPosition,
        expectedReviewPosition: w?.expectedReviewPosition,
      },
    );
  }
  async function download(format: "json" | "csv") {
    if (!w?.report) return;
    setError("");
    try {
      await downloadReport(
        `${endpoint}&reviewId=${w.report.review.id}&format=${format}`,
        `feed-reconciliation-review.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const disabled =
    busy ||
    blocked ||
    !!pending ||
    !canPost ||
    !w?.selected?.snapshot ||
    w.selected.targetId !== target ||
    w.selected.kind !== kind;
  function result(v: ReturnType<typeof feedReviewResults>) {
    return v.kind === "source" ? (
      <p>
        Unchanged consumption {v.unchangedKg} kg · original {v.currency}{" "}
        {v.originalAmount ?? "Unknown value"}. The manager reaffirms this
        physical quantity against the captured current daily evidence.
      </p>
    ) : (
      <>
        <p>
          {v.currency} full revised cost {v.reviewedTotalCost} = consumed{" "}
          {v.reviewedConsumedValue} + lost {v.reviewedLostValue} + remaining{" "}
          {v.reviewedRemainingValue}. Original total{" "}
          {v.originalTotalCost ?? "Unknown"}; difference{" "}
          {v.totalDelta ?? "Unknown original basis"}.
        </p>
        <p className="helper">
          Consumed difference {v.consumedDelta ?? "Unknown original basis"};
          lost difference {v.lostDelta ?? "Unknown original basis"}; remaining
          difference {v.remainingDelta ?? "Unknown original basis"}. These
          compare with original stock values, not a previous review.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Original movement / date</th>
                <th>Kg</th>
                <th>Original value</th>
                <th>Reviewed value</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {v.allocations.map((a) => (
                <tr key={a.eventId}>
                  <td>
                    {a.kind} · {a.date}
                    <span className="helper">{a.eventId}</span>
                  </td>
                  <td>{a.weightKg}</td>
                  <td>{a.originalValue ?? "Unknown"}</td>
                  <td>{a.reviewedValue}</td>
                  <td>{a.delta ?? "Unknown original basis"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return (
    <section
      className="feed-review"
      aria-label="Feed source and late-cost reviews"
    >
      <div className="panel-heading">
        <h2>Feed source and late-cost reviews</h2>
        <button
          className="text-button"
          disabled={busy || blocked || !!pending}
          onClick={() => void load()}
        >
          Reload feed review evidence
        </button>
      </div>
      <p className="helper">
        A manager can reaffirm unchanged physical consumption after a corrected
        daily record, when all linked kg still fit that actual feed. Overlinked
        days require quantity reconciliation; this review cannot change
        kilograms, move feed or make a return. Revised purchase costs produce
        separate versioned lot valuations. Original stock values and journal
        entries remain preserved.
      </p>
      <p className="helper">
        A cost review is a full revised actual lot total, including explicit
        zero, in the original currency. Differences compare with original stock
        amounts; an unknown original cost does not become zero. Reviews do not
        post price differences to Finance or update later stock withdrawals
        automatically. Journal adjustments and genuine quantity/return workflows
        remain separate.
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
      {!w && (
        <p className="helper">Load review history before approving evidence.</p>
      )}
      {pending && (
        <div className="notice">
          <p>
            A review receipt is awaiting confirmation. New review and stock
            controls are locked until it is resolved.
          </p>
          <button
            disabled={busy || blocked || !canPost}
            onClick={() => void save(pending)}
          >
            Retry exact feed review receipt
          </button>
          <button className="text-button" onClick={working}>
            Download pending feed review
          </button>
          <details>
            <summary>Pending review evidence</summary>
            <pre>{JSON.stringify(pending, null, 2)}</pre>
          </details>
        </div>
      )}
      <fieldset
        className="feed-stock-fields"
        disabled={busy || blocked || !!pending}
      >
        <legend>Select review evidence</legend>
        <div className="form-grid">
          <label>
            Feed review type
            <select
              value={kind}
              onChange={(e) => {
                edit();
                setKind(e.target.value as typeof kind);
                setTarget("");
              }}
            >
              <option value="cost">Revised actual lot cost</option>
              <option value="source">Reaffirm unchanged consumption</option>
            </select>
          </label>
          <label>
            Feed review target
            <select
              value={target}
              onChange={(e) => {
                edit();
                setTarget(e.target.value);
              }}
            >
              <option value="">Choose an active original feed source</option>
              {w?.targets
                .filter((t) =>
                  kind === "cost" ? t.kind === "receipt" : t.kind === "consume",
                )
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.date} · {t.weightKg} kg · {t.id.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <button disabled={!target} onClick={() => void load()}>
          Load selected feed evidence
        </button>
        <label>
          Saved feed review
          <select value={savedId} onChange={(e) => setSavedId(e.target.value)}>
            <option value="">Choose a saved version</option>
            {w?.history.map((h) => (
              <option key={h.id} value={h.id}>
                {h.kind} · version {h.revision} · {h.reviewed_on} ·{" "}
                {h.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!savedId}
          onClick={() => {
            const h = w?.history.find((h) => h.id === savedId);
            if (h) void load(h.kind as typeof kind, h.target_id, h.id);
          }}
        >
          Load saved feed review
        </button>
      </fieldset>
      {w?.selected && (
        <p className="helper">
          Loaded source: {w.selected.targetId} · current predecessor{" "}
          {w.selected.latestId ?? "None"} · stock/review positions{" "}
          {w.expectedStockPosition}/{w.expectedReviewPosition}. Source and both
          heads are rechecked when saved. A full revised valuation needs a new
          review after later physical lot movements.
        </p>
      )}
      {canPost ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            try {
              if (!ack)
                throw Error(
                  "Confirm the unchanged quantity or revised actual cost evidence.",
                );
              void save(payload());
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <fieldset className="feed-stock-fields" disabled={disabled}>
            <legend>Approve a feed review</legend>
            <label>
              Feed review date
              <input
                type="date"
                min="1900-01-01"
                max={w?.today}
                value={date}
                onChange={(e) => {
                  edit();
                  setDate(e.target.value);
                }}
                required
              />
            </label>
            {kind === "cost" && (
              <div className="form-grid">
                <label>
                  Full revised actual lot cost
                  <input
                    value={total}
                    onChange={(e) => {
                      edit();
                      setTotal(e.target.value);
                    }}
                    placeholder="Original currency, up to four decimals"
                    required
                  />
                </label>
                <label>
                  Revised purchase cost evidence
                  <textarea
                    value={costEvidence}
                    onChange={(e) => {
                      edit();
                      setCostEvidence(e.target.value);
                    }}
                    minLength={3}
                    maxLength={2000}
                    required
                  />
                </label>
              </div>
            )}
            <div className="form-grid">
              <label>
                Feed review reason
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
                Reconciliation review evidence
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
                I confirm the actual source evidence and unchanged physical
                kilograms, or the complete revised lot-cost boundary; this is
                separate from financial posting and physical returns.
              </span>
            </label>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  try {
                    const p = payload();
                    setPreview(
                      feedReviewResults({
                        kind: p.data.kind,
                        input: p.data,
                        currency: (w!.selected!.snapshot!.receipt ??
                          w!.selected!.snapshot!.event)!.currency,
                        source_snapshot: w!.selected!.snapshot!,
                      }),
                    );
                    setError("");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Preview feed review
              </button>
              <button className="primary" disabled={!ack}>
                Save feed reconciliation review
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <p className="notice">
          Read-only review access. An owner, administrator or manager must
          approve evidence.
        </p>
      )}
      {canPost && (
        <button className="text-button" onClick={working}>
          Download feed review working copy
        </button>
      )}
      {preview && (
        <section aria-label="Unsaved feed review preview">
          <h3>Unsaved feed review preview</h3>
          {result(preview)}
          <p className="helper">
            No review, stock movement or journal entry has been saved.
          </p>
        </section>
      )}
      {w?.report && (
        <section aria-label="Saved feed reconciliation review">
          <h3>
            Saved feed reconciliation review · version{" "}
            {w.report.review.revision}
          </h3>
          <p className="notice">
            {w.sourceCurrent
              ? "Saved review matches current source."
              : "Historical review: source changed or inactive; retained as original evidence."}{" "}
            Current status is outside the immutable evidence digest.
          </p>
          {result(w.report.results)}
          <div className="button-row">
            <button
              className="text-button"
              onClick={() => void download("json")}
            >
              Download feed review JSON
            </button>
            <button
              className="text-button"
              onClick={() => void download("csv")}
            >
              Download feed review CSV
            </button>
          </div>
          <p className="helper">Evidence SHA-256: {w.report.evidenceSha256}</p>
          <details>
            <summary>Complete immutable review and source</summary>
            <pre>{JSON.stringify(w.report.review, null, 2)}</pre>
          </details>
        </section>
      )}
    </section>
  );
}
