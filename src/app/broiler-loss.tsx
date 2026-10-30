"use client";
import { useEffect, useState } from "react";
import { api, ApiError, downloadJson } from "@/lib/client";
import { broilerLossInput, type BroilerLossInput } from "@/lib/broiler-loss";
import type { BroilerSnapshot } from "@/lib/broiler-lifecycle";
type Selection = {
  key: string;
  kind: "daily" | "cull";
  date: string;
  targetEventId: string | null;
  sourceId: string;
  sourceCount: number;
  previousId: string | null;
  expectedPosition: string;
  expectedDailyId: string | null;
  sha: string;
};
export default function BroilerLoss({
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
  const [selectedKey, setSelectedKey] = useState(""),
    [selection, setSelection] = useState<Selection | null>(null),
    [weight, setWeight] = useState(""),
    [unknown, setUnknown] = useState(false),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [ack, setAck] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<BroilerLossInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState("");
  const organizationId = snapshot.unit.organization_id!,
    unitId = snapshot.unit.id,
    key = `farmstead:broiler-loss:v1:${organizationId}:${actor}:${unitId}`,
    targets = snapshot.summary.lossEvidence.targets;
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = broilerLossInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === organizationId &&
            p.data.unitId === unitId
          )
            setPending(p.data);
          else
            setStorageWarning(
              "The stored loss-weight receipt cannot be read. Review history before repeating a weight review.",
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
  function remember(p: BroilerLossInput | null) {
    setPending(p);
    try {
      if (p) sessionStorage.setItem(key, JSON.stringify(p));
      else sessionStorage.removeItem(key);
    } catch {
      setStorageWarning(
        "Tab recovery storage is unavailable. Keep this page open until the review is confirmed.",
      );
    }
  }
  function choose(key: string, keep = false, current = snapshot) {
    setSelectedKey(key);
    const t = current.summary.lossEvidence.targets.find((t) => t.key === key);
    if (!t && keep) {
      setAck(false);
      setNotice(
        "This loss is no longer active. Its previous evidence and your working inputs remain available for review.",
      );
      return;
    }
    setSelection(
      t
        ? {
            key: t.key,
            kind: t.kind,
            date: t.date,
            targetEventId: t.targetEventId,
            sourceId: t.sourceId,
            sourceCount: t.sourceCount,
            previousId: t.reviewId,
            expectedPosition: current.summary.expectedPosition,
            expectedDailyId: current.summary.expectedDailyId,
            sha: current.evidenceSha256,
          }
        : null,
    );
    setAck(false);
    setError("");
    setNotice(
      keep
        ? "Evidence reloaded. Review the full bird count and measured total before saving."
        : "",
    );
    if (!keep) {
      setWeight("");
      setUnknown(false);
      setReason("");
      setEvidence("");
      setDirty(false);
    }
  }
  async function loadSource() {
    setBusy(true);
    setError("");
    try {
      choose(selectedKey, true, await onSaved());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function workingCopy() {
    return {
      organizationId,
      unitId,
      selection,
      weightKg: unknown ? null : weight,
      measurementBasis: "whole-bird-at-loss",
      reason,
      evidence,
    };
  }
  async function save(p: BroilerLossInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/loss-biomass", p);
      committed = true;
      await onSaved();
      remember(null);
      setSelection(null);
      setSelectedKey("");
      setWeight("");
      setReason("");
      setEvidence("");
      setAck(false);
      setDirty(false);
      setNotice(
        "Loss biomass review saved. Original bird counts, feed and lifecycle events remain unchanged.",
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
  const changed = !!selection && selection.sha !== snapshot.evidenceSha256,
    disabled = blocked || busy || !!pending || !canReview;
  function submit() {
    if (!selection || !ack || changed || disabled) return;
    const { key: unusedKey, sha: unusedSha, ...selected } = selection;
    void unusedKey;
    void unusedSha;
    const p = broilerLossInput.safeParse({
      ...selected,
      organizationId,
      unitId,
      reviewId: crypto.randomUUID(),
      weightKg: unknown ? null : weight,
      measurementBasis: "whole-bird-at-loss",
      reason,
      evidence,
    });
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    void save(p.data);
  }
  return (
    <section
      className="broiler-loss"
      aria-label="Measured broiler loss biomass"
    >
      <h3>Measured broiler loss biomass</h3>
      <p>
        Attach the measured whole-bird kg total for every bird in an existing
        daily death count or cull. Use source measurements at the time of loss.
        A sample average, forecast, dressed product or later carcass estimate
        cannot supply this mass. This review changes weight evidence only.
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
            Loss-weight receipt {pending.reviewId} needs confirmation. Retry
            this exact receipt before another review.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry loss biomass receipt
          </button>
          <button
            className="text-button"
            onClick={() => downloadJson("broiler-loss-pending.json", pending)}
          >
            Download pending loss receipt
          </button>
        </div>
      )}
      {targets.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Loss source</th>
                <th>Whole birds</th>
                <th>Original cull kg</th>
                <th>Current measured kg</th>
                <th>Evidence state</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.key}>
                  <th scope="row">
                    {t.date} · {t.kind}
                    <span className="helper">{t.sourceId}</span>
                  </th>
                  <td>{t.sourceCount}</td>
                  <td>{t.originalWeightKg ?? "Unknown"}</td>
                  <td>{t.weightKg ?? "Unknown"}</td>
                  <td>
                    {t.state}
                    {t.reviewId && (
                      <span className="helper">Review {t.reviewId}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No positive daily deaths or active culls need weight evidence.</p>
      )}
      {canReview && targets.length > 0 && (
        <>
          <label>
            Loss to review
            <select
              aria-label="Loss to review"
              value={selectedKey}
              disabled={disabled}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">Choose recorded losses</option>
              {targets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.date} · {t.kind} · {t.sourceCount} birds · {t.state}
                </option>
              ))}
            </select>
          </label>
          {selection && (
            <>
              <p className="helper">
                Loaded loss: {selection.date} · {selection.kind} ·{" "}
                {selection.sourceCount} whole birds · source{" "}
                {selection.sourceId}. A changed effective daily revision
                invalidates its earlier weight, even when the count is
                unchanged.
              </p>
              {changed && (
                <p className="notice">
                  Batch evidence changed. Your weight inputs are retained.
                  Download a working copy, then load the selected loss evidence
                  and review it again.
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <fieldset disabled={disabled || changed}>
                  <legend>Review measured loss biomass</legend>
                  <label>
                    Measured whole-bird loss kg
                    <input
                      inputMode="decimal"
                      value={weight}
                      disabled={unknown}
                      onChange={(e) => {
                        setWeight(e.target.value);
                        setDirty(true);
                        setAck(false);
                      }}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={unknown}
                      onChange={(e) => {
                        setUnknown(e.target.checked);
                        setDirty(true);
                        setAck(false);
                      }}
                    />
                    Weight is explicitly unknown; withdraw any previous weight
                    claim.
                  </label>
                  <label>
                    Loss weight review reason
                    <textarea
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label>
                    Measurement record and source evidence
                    <textarea
                      maxLength={2000}
                      value={evidence}
                      onChange={(e) => {
                        setEvidence(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I reviewed this exact loss count. Its weight is a measured
                    whole-bird total for all these birds, or explicitly unknown;
                    no sampled or forecast weight is substituted.
                  </label>
                  <button className="primary" disabled={!ack} type="submit">
                    Save loss biomass review
                  </button>
                </fieldset>
              </form>
              <div className="button-row">
                <button
                  className="text-button"
                  disabled={busy || !!pending}
                  onClick={() =>
                    downloadJson(
                      "broiler-loss-working-copy.json",
                      workingCopy(),
                    )
                  }
                >
                  Download loss weight working copy
                </button>
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => void loadSource()}
                >
                  Load selected loss evidence
                </button>
              </div>
            </>
          )}
        </>
      )}
      <h4>Immutable loss-weight review history</h4>
      {(snapshot.lossReviews ?? []).length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Loss / revision</th>
                <th>Birds / measured kg</th>
                <th>Reason and measurement evidence</th>
                <th>Reviewer</th>
              </tr>
            </thead>
            <tbody>
              {[...(snapshot.lossReviews ?? [])].reverse().map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    {r.observed_on} · {r.kind}
                    <span className="helper">
                      {r.id} · previous {r.previous_id ?? "none"} ·{" "}
                      {snapshot.summary.lossEvidence.history.find(
                        (h) => h.id === r.id,
                      )?.status ?? "superseded"}
                    </span>
                  </th>
                  <td>
                    {r.source_count} / {r.weight_kg ?? "Unknown"}
                    <span className="helper">Source {r.source_id}</span>
                  </td>
                  <td>
                    {r.reason}
                    <p>{r.evidence}</p>
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
      ) : (
        <p>No measured-loss reviews have been recorded.</p>
      )}
      <p className="helper">
        Unknown or stale loss weights withhold FCR. Culls may retain an original
        measured total until an explicit weight review supersedes it. Voiding an
        erroneous cull leaves its weight history visible and inactive. Lifecycle
        JSON/CSV below include every source snapshot and review.
      </p>
    </section>
  );
}
