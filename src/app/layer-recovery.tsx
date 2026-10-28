"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/client";
import {
  currentAdjustments,
  type LayerAdjustment,
  type LayerAdjustmentInput,
} from "@/lib/layer-recovery";
type Original = {
  id: string;
  recorded_on: string;
  mortality: number;
  eggs: number;
  cracked: number;
  feed_kg: string;
  notes: string;
};
type History = {
  unit: { id: string; stocked_on: string };
  today: string;
  timezone: string;
  originals: Original[];
  adjustments: LayerAdjustment[];
  evidenceSha256: string;
  balance: { recorded_balance: number; census_on: string | null };
};
export default function LayerRecovery({
  organizationId,
  unitId,
  canReview,
  onSaved,
}: {
  organizationId: string;
  unitId: string;
  canReview: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const [history, setHistory] = useState<History | null>(null),
    [date, setDate] = useState(""),
    [kind, setKind] = useState<"daily" | "census">("daily"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState<LayerAdjustmentInput | null>(null);
  const endpoint = `layers/recovery?organizationId=${organizationId}&unitId=${unitId}`;
  useEffect(() => {
    let active = true;
    void api<History>(endpoint)
      .then((h) => {
        if (active) {
          setHistory(h);
          setDate(h.originals.at(-1)?.recorded_on ?? h.unit.stocked_on);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  async function reload() {
    setBusy(true);
    setError("");
    try {
      const h = await api<History>(endpoint);
      await onSaved();
      setHistory(h);
      setPending(null);
      if (!date) setDate(h.unit.stocked_on);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const head = history
    ? currentAdjustments(history.adjustments).find(
        (a) => a.kind === kind && a.observed_on === date,
      )
    : undefined;
  const original = history?.originals.find((r) => r.recorded_on === date),
    daily = head?.kind === "daily" ? head : original;
  async function save(payload: LayerAdjustmentInput) {
    setBusy(true);
    setError("");
    setNotice("");
    setPending(payload);
    let committed = false;
    try {
      await api("layers/recovery", payload);
      committed = true;
      const h = await api<History>(endpoint);
      await onSaved();
      setHistory(h);
      setPending(null);
      setNotice(
        "Reviewed entry saved. Original observations and earlier reviews are preserved.",
      );
    } catch (e) {
      setError((e as Error).message);
      if (
        !committed &&
        e instanceof ApiError &&
        [400, 403, 404, 422].includes(e.status)
      )
        setPending(null);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const common = {
      organizationId,
      unitId,
      eventId: crypto.randomUUID(),
      kind,
      date,
      previousId: head?.id ?? null,
      reason: String(f.get("reason")),
      evidence: String(f.get("evidence")),
    };
    const payload: LayerAdjustmentInput =
      kind === "daily"
        ? {
            ...common,
            kind: "daily",
            baseRecordId: original?.id ?? null,
            mortality: Number(f.get("mortality")),
            eggs: Number(f.get("eggs")),
            cracked: Number(f.get("cracked")),
            feedKg: String(f.get("feed")),
            notes: String(f.get("notes")),
          }
        : { ...common, kind: "census", openingHens: Number(f.get("opening")) };
    await save(payload);
  }
  function download() {
    if (!history) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(history, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `farmstead-layer-recovery-${unitId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section
      className="panel layer-recovery"
      aria-label="Layer record recovery"
    >
      <div className="panel-heading">
        <h2>Layer record recovery</h2>
        <button
          className="text-button"
          onClick={download}
          disabled={!history || busy}
        >
          Download recovery history JSON
        </button>
      </div>
      <p>
        Review a full daily replacement, fill a genuinely observed missing day,
        or record a physical count of hens at the beginning of a day. Originals
        stay in history. A census restores population knowledge from its date
        forward; it does not fill earlier egg, feed or mortality observations.
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
      <button
        className="text-button"
        disabled={busy}
        onClick={() => void reload()}
      >
        Reload recovery history
      </button>
      {!history ? (
        <p>Load the flock history before reviewing an entry.</p>
      ) : (
        <>
          <p className="helper">
            Organization dates: {history.timezone}. Recorded population balance:{" "}
            {history.balance.recorded_balance}
            {history.balance.census_on
              ? ` · latest opening census ${history.balance.census_on}`
              : ""}
            . Missing deaths may still be unknown.
          </p>
          <div className="form-grid">
            <label>
              Recovery type
              <select
                value={kind}
                disabled={busy || !!pending}
                onChange={(e) => {
                  setKind(e.target.value as "daily" | "census");
                  setNotice("");
                }}
              >
                <option value="daily">Daily correction or backfill</option>
                <option value="census">Opening flock census</option>
              </select>
            </label>
            <label>
              Recovery observation date
              <input
                type="date"
                value={date}
                min={history.unit.stocked_on}
                max={history.today}
                disabled={busy || !!pending}
                onChange={(e) => {
                  setDate(e.target.value);
                  setNotice("");
                }}
              />
            </label>
          </div>
          <p>
            {kind === "daily"
              ? daily
                ? `Full replacement for ${date}. Original record: ${original?.id ?? "none (reviewed backfill)"}. Current review: ${head?.id ?? "none"}.`
                : `No daily observation exists for ${date}. Enter all values from genuine evidence; blank fields are unknown.`
              : `Opening-of-day physical count for ${date}, before that day's deaths. This count is not a transfer or an explanation of any population difference.`}
          </p>
          {canReview ? (
            <form
              key={`${kind}:${date}:${head?.id ?? "original"}`}
              onSubmit={(e) => void submit(e)}
            >
              <fieldset
                disabled={busy || !!pending}
                style={{ border: 0, padding: 0, margin: 0 }}
              >
                <div className="form-grid">
                  {kind === "daily" ? (
                    <>
                      <label>
                        Reviewed mortality
                        <input
                          name="mortality"
                          type="number"
                          min="0"
                          max="100000000"
                          step="1"
                          required
                          defaultValue={daily?.mortality ?? ""}
                        />
                      </label>
                      <label>
                        Reviewed gross eggs
                        <input
                          name="eggs"
                          type="number"
                          min="0"
                          max="100000000"
                          step="1"
                          required
                          defaultValue={daily?.eggs ?? ""}
                        />
                      </label>
                      <label>
                        Reviewed cracked eggs
                        <input
                          name="cracked"
                          type="number"
                          min="0"
                          max="100000000"
                          step="1"
                          required
                          defaultValue={daily?.cracked ?? ""}
                        />
                      </label>
                      <label>
                        Reviewed feed consumed (kg)
                        <input
                          name="feed"
                          type="number"
                          min="0"
                          max="100000000"
                          step="0.000001"
                          required
                          defaultValue={daily?.feed_kg ?? ""}
                        />
                      </label>
                      <label>
                        Reviewed daily notes
                        <textarea
                          name="notes"
                          maxLength={2000}
                          defaultValue={daily?.notes ?? ""}
                        />
                      </label>
                    </>
                  ) : (
                    <label>
                      Counted opening hens
                      <input
                        name="opening"
                        type="number"
                        min="0"
                        max="100000000"
                        step="1"
                        required
                        defaultValue={head?.opening_hens ?? ""}
                      />
                    </label>
                  )}
                  <label>
                    Review reason
                    <textarea
                      name="reason"
                      minLength={10}
                      maxLength={2000}
                      required
                    />
                  </label>
                  <label>
                    Observation evidence or reference
                    <textarea
                      name="evidence"
                      minLength={3}
                      maxLength={2000}
                      required
                      placeholder="e.g. dated collection sheet or physical-count reference"
                    />
                  </label>
                </div>
                <label className="field">
                  <span>
                    <input name="reviewed" type="checkbox" required /> I
                    reviewed the full values, date and source evidence.
                  </span>
                </label>
                <button className="primary" disabled={!date}>
                  Save reviewed entry
                </button>
              </fieldset>
            </form>
          ) : (
            <p className="helper">
              Owners, administrators and managers can review corrections and
              censuses. Your role can read this history.
            </p>
          )}
          {pending && (
            <div className="record-note">
              <p>
                The save response or refresh was not confirmed. Retry the same
                receipt, or reload history to check whether it was saved.
                Repeated receipts cannot create a second entry.
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void save(pending)}
              >
                Retry reviewed entry
              </button>
            </div>
          )}
          <details>
            <summary>
              Original daily observations ({history.originals.length})
            </summary>
            <div className="table-scroll">
              <table aria-label="Original layer observations">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Deaths</th>
                    <th>Eggs / cracked</th>
                    <th>Feed kg</th>
                    <th>Notes</th>
                    <th>Original UUID</th>
                  </tr>
                </thead>
                <tbody>
                  {history.originals.map((r) => (
                    <tr key={r.id}>
                      <td>{r.recorded_on}</td>
                      <td>{r.mortality}</td>
                      <td>
                        {r.eggs} / {r.cracked}
                      </td>
                      <td>{r.feed_kg}</td>
                      <td>{r.notes}</td>
                      <td>{r.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>Review history ({history.adjustments.length})</summary>
            <div className="table-scroll">
              <table aria-label="Layer recovery reviews">
                <thead>
                  <tr>
                    <th>Date / kind</th>
                    <th>Reviewed values</th>
                    <th>Reason / evidence</th>
                    <th>Reviewer / time</th>
                    <th>Lineage</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history.adjustments].reverse().map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.observed_on} · {a.kind}
                      </td>
                      <td>
                        {a.kind === "daily"
                          ? `${a.mortality} deaths · ${a.eggs} eggs / ${a.cracked} cracked · ${a.feed_kg} kg · ${a.notes}`
                          : `${a.opening_hens} opening hens`}
                      </td>
                      <td>
                        {a.reason}
                        <br />
                        {a.evidence}
                      </td>
                      <td>
                        {a.created_by}
                        <br />
                        {a.created_at}
                      </td>
                      <td>
                        {a.id}
                        <br />
                        Previous: {a.previous_id ?? "none"}
                        <br />
                        Original: {a.base_record_id ?? "none"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="helper">
            These are reviewed observations, not forecasts or egg inventory
            postings. Population differences at a census remain unattributed.
            Snapshot: {history.evidenceSha256}.
          </p>
        </>
      )}
    </section>
  );
}
