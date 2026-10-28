"use client";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, downloadJson } from "@/lib/client";
import {
  broilerReviewInput,
  currentBroilerReviews,
  type BroilerReviewInput,
} from "@/lib/broiler-recovery";
import type { BroilerSnapshot } from "@/lib/broiler-lifecycle";
export default function BroilerRecovery({
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
  onSaved: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  const [kind, setKind] = useState<"daily" | "withdrawal">("withdrawal"),
    [date, setDate] = useState(snapshot.summary.asOf),
    [treatmentId, setTreatmentId] = useState(""),
    [pending, setPending] = useState<BroilerReviewInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState("");
  const organizationId = snapshot.unit.organization_id as string,
    unitId = snapshot.unit.id;
  const key = `farmstead:broiler-recovery:v1:${organizationId}:${actor}:${unitId}`;
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const p = broilerReviewInput.safeParse(JSON.parse(raw));
          if (
            p.success &&
            p.data.organizationId === organizationId &&
            p.data.unitId === unitId
          )
            setPending(p.data);
          else
            setStorageWarning(
              "The stored recovery receipt could not be read. Keep this tab open and review the source history before repeating an entry.",
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
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  function remember(p: BroilerReviewInput | null) {
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
  async function save(p: BroilerReviewInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/recovery", p);
      committed = true;
      await onSaved();
      remember(null);
      setNotice(
        "Broiler recovery review saved. Original observations and prior guidance remain in history.",
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
  const heads = currentBroilerReviews(snapshot.reviews ?? []),
    original = (snapshot.originalRecords ?? snapshot.records).find(
      (r) => r.recorded_on === date,
    ),
    effective = snapshot.records.find((r) => r.recorded_on === date),
    treatment = snapshot.summary.treatments.find((t) => t.id === treatmentId);
  const previous = heads.find((r) =>
    kind === "daily"
      ? r.kind === "daily" && r.observed_on === date
      : r.kind === "withdrawal" && r.treatment_id === treatmentId,
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (blocked || pending) return;
    const f = new FormData(e.currentTarget),
      str = (k: string) => String(f.get(k) ?? "");
    const common = {
      organizationId,
      unitId,
      eventId: crypto.randomUUID(),
      kind,
      date,
      previousId: previous?.id ?? null,
      expectedPosition: snapshot.summary.expectedPosition,
      expectedDailyId: snapshot.summary.expectedDailyId,
      reason: str("reason"),
      evidence: str("evidence"),
    };
    const p = broilerReviewInput.safeParse({
      ...common,
      ...(kind === "withdrawal"
        ? { treatmentId, earliestHarvestOn: str("earliest") || null }
        : {
            baseRecordId: original?.id ?? null,
            mortality: Number(f.get("mortality")),
            feedKg: str("feed"),
            averageWeightG: str("weight") || null,
            sampleSize: str("sample") ? Number(f.get("sample")) : null,
            notes: str("notes"),
          }),
    });
    if (!p.success) {
      setError(p.error.issues.map((i) => i.message).join(" "));
      return;
    }
    await save(p.data);
  }
  const disabled = blocked || busy || !!pending;
  return (
    <section className="broiler-recovery" aria-label="Broiler record recovery">
      <h3>Broiler record recovery</h3>
      <p>
        Review withdrawal guidance for a genuine existing administration, or
        replace a full daily observation and fill a genuinely observed missing
        day. The original treatment and daily records stay unchanged. Revised
        deaths and samples must fit every later withdrawal.
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
            Recovery receipt {pending.eventId} needs confirmation. Retry this
            exact receipt; keep this tab open until confirmed.
          </p>
          <button
            className="primary"
            disabled={blocked || busy}
            onClick={() => void save(pending)}
          >
            Retry broiler recovery receipt
          </button>
          <button
            className="text-button"
            onClick={() =>
              downloadJson("broiler-recovery-pending.json", pending)
            }
          >
            Download pending recovery receipt
          </button>
        </div>
      )}
      {canReview ? (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset
            className="broiler-fields"
            disabled={disabled}
            key={`${snapshot.summary.expectedPosition}:${snapshot.summary.expectedDailyId}`}
          >
            <legend>Review recovery evidence</legend>
            <div className="form-grid">
              <label>
                Recovery type
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as "daily" | "withdrawal");
                    setDate(snapshot.summary.asOf);
                    setNotice("");
                  }}
                >
                  <option value="withdrawal">Withdrawal guidance review</option>
                  <option value="daily">Daily correction or backfill</option>
                </select>
              </label>
              <label>
                {kind === "daily"
                  ? "Recovery observation date"
                  : "Guidance review date"}
                <input
                  type="date"
                  required
                  value={date}
                  min={
                    kind === "daily"
                      ? snapshot.unit.stocked_on
                      : snapshot.summary.asOf
                  }
                  max={snapshot.today}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              {kind === "withdrawal" ? (
                <>
                  <label>
                    Original administered treatment
                    <select
                      required
                      value={treatmentId}
                      onChange={(e) => setTreatmentId(e.target.value)}
                    >
                      <option value="">Choose a genuine administration</option>
                      {snapshot.summary.treatments.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.recorded_on} · {t.product} · {t.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reviewed earliest harvest date · blank means unknown
                    <input
                      name="earliest"
                      key={treatmentId}
                      type="date"
                      min={treatment?.recorded_on}
                      defaultValue={treatment?.earliest_harvest_on ?? ""}
                    />
                  </label>
                </>
              ) : (
                <Fragment key={date}>
                  <label>
                    Reviewed daily deaths
                    <input
                      name="mortality"
                      type="number"
                      min="0"
                      max="100000000"
                      step="1"
                      required
                      defaultValue={effective?.mortality}
                    />
                  </label>
                  <label>
                    Reviewed daily feed (kg)
                    <input
                      name="feed"
                      type="number"
                      min="0"
                      max="100000000"
                      step="0.000001"
                      required
                      defaultValue={effective?.feed_kg}
                    />
                  </label>
                  <label>
                    Reviewed average sample weight (g) · optional
                    <input
                      name="weight"
                      type="number"
                      min="0.000001"
                      max="1000000"
                      step="0.000001"
                      defaultValue={effective?.average_weight_g ?? ""}
                    />
                  </label>
                  <label>
                    Reviewed sample size · optional
                    <input
                      name="sample"
                      type="number"
                      min="1"
                      max="100000000"
                      step="1"
                      defaultValue={effective?.sample_size ?? ""}
                    />
                  </label>
                  <label>
                    Reviewed daily notes
                    <textarea
                      name="notes"
                      maxLength={2000}
                      defaultValue={
                        (effective as { notes?: string })?.notes ?? ""
                      }
                    />
                  </label>
                </Fragment>
              )}
              <label>
                Recovery review reason
                <textarea
                  name="reason"
                  required
                  minLength={10}
                  maxLength={2000}
                />
              </label>
              <label>
                Recovery source / veterinary evidence
                <textarea
                  name="evidence"
                  required
                  minLength={3}
                  maxLength={2000}
                />
              </label>
            </div>
            <p className="helper">
              {kind === "withdrawal"
                ? treatment
                  ? `Original administration: ${treatment.id} · ${treatment.administration}. Original earliest date: ${treatment.original_earliest_harvest_on ?? "unknown"}. Current guidance: ${treatment.earliest_harvest_on ?? "unknown"}. A new review changes guidance only; it does not administer, remove or re-date treatment.`
                  : "Select an existing administered treatment. Unknown guidance keeps the entire batch on hold."
                : `Original daily record: ${original?.id ?? "none — observed backfill"}. Current review: ${previous?.id ?? "none"}. Supply complete observed values, including explicit zero feed/deaths; leave both sample fields blank when unknown. This replaces full values, not a difference.`}
            </p>
            <label className="checkbox">
              <input
                key={`${kind}:${date}:${treatmentId}`}
                type="checkbox"
                required
              />
              I verified the original observations and the evidence for this
              recovery review.
            </label>
            <button className="primary">Save broiler recovery review</button>
          </fieldset>
        </form>
      ) : (
        <p className="helper">
          An owner, administrator or manager reviews recovery evidence.
        </p>
      )}
      <p className="helper">
        Withdrawal guidance is checked on the selected harvest date. Later
        guidance can flag earlier recorded harvests for veterinary review; it
        never rewrites their original postings or establishes clinical
        clearance. Exports below include complete review history and original
        daily evidence.
      </p>
      {(snapshot.reviews?.length ?? 0) > 0 && (
        <div className="table-scroll">
          <table aria-label="Broiler recovery review history">
            <thead>
              <tr>
                <th>Date / type</th>
                <th>Original source / prior review</th>
                <th>Reviewed values</th>
                <th>Reason / evidence</th>
              </tr>
            </thead>
            <tbody>
              {[...(snapshot.reviews ?? [])].reverse().map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.observed_on} · {r.kind}
                    <span className="helper">
                      {r.id} · {r.created_at} · {r.created_by}
                    </span>
                  </td>
                  <td>
                    {r.treatment_id ?? r.base_record_id ?? "Observed backfill"}
                    <span className="helper">
                      Previous:{" "}
                      {r.previous_id ?? "original guidance / first review"}
                    </span>
                  </td>
                  <td>
                    {r.kind === "withdrawal"
                      ? `Earliest harvest: ${r.earliest_harvest_on ?? "unknown — hold"}`
                      : `Deaths ${r.mortality} · Feed ${r.feed_kg} kg · Sample ${r.average_weight_g ?? "unknown"} g / ${r.sample_size ?? "unknown"} · ${r.notes}`}
                  </td>
                  <td>
                    {r.reason}
                    <p>{r.evidence}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
