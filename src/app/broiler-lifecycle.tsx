"use client";
import BroilerRecovery from "./broiler-recovery";
import BroilerLoss from "./broiler-loss";
import BroilerProcessing from "./broiler-processing";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, downloadReport, downloadJson } from "@/lib/client";
import {
  broilerEventInput,
  type BroilerInput,
  type BroilerSnapshot,
} from "@/lib/broiler-lifecycle";
export default function BroilerLifecycle({
  organizationId,
  unitId,
  actor,
  canReview,
  revision,
  onSaved,
}: {
  organizationId: string;
  unitId: string;
  actor: string;
  canReview: boolean;
  revision: string;
  onSaved: () => Promise<unknown>;
}) {
  const [data, setData] = useState<BroilerSnapshot | null>(null),
    [kind, setKind] = useState<BroilerInput["kind"]>("health"),
    [priceBasis, setPriceBasis] = useState("unpriced"),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(true),
    [recoveryPending, setRecoveryPending] = useState(false),
    [lossPending, setLossPending] = useState(false),
    [processingPending, setProcessingPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState<BroilerInput | null>(null),
    [storageWarning, setStorageWarning] = useState("");
  const endpoint = `broilers/lifecycle?organizationId=${organizationId}&unitId=${unitId}`;
  const storageKey = `farmstead:broiler-posting:v1:${organizationId}:${actor}:${unitId}`;
  useEffect(() => {
    let active = true;
    void api<BroilerSnapshot>(endpoint)
      .then((d) => {
        if (active) {
          setData(d);
          setStale(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setStale(true);
        }
      });
    return () => {
      active = false;
    };
  }, [endpoint, revision]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const parsed = broilerEventInput.safeParse(JSON.parse(raw));
          if (
            parsed.success &&
            parsed.data.organizationId === organizationId &&
            parsed.data.unitId === unitId
          )
            setPending(parsed.data);
          else
            setStorageWarning(
              "A saved receipt could not be read. Keep this tab open and contact an administrator before recording the same activity.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until the posting is confirmed.",
        );
      }
    });
  }, [storageKey, organizationId, unitId]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  function remember(p: BroilerInput | null) {
    setPending(p);
    try {
      if (p) sessionStorage.setItem(storageKey, JSON.stringify(p));
      else sessionStorage.removeItem(storageKey);
    } catch {
      setStorageWarning(
        "Tab recovery storage is unavailable. Keep this page open until the posting is confirmed.",
      );
    }
  }
  async function reload() {
    setBusy(true);
    setError("");
    try {
      const d = await api<BroilerSnapshot>(endpoint);
      await onSaved();
      setData(d);
      setStale(false);
    } catch (e) {
      setError((e as Error).message);
      setStale(true);
    } finally {
      setBusy(false);
    }
  }
  async function save(p: BroilerInput) {
    setBusy(true);
    setError("");
    setNotice("");
    remember(p);
    let committed = false;
    try {
      await api("broilers/lifecycle", p);
      committed = true;
      const d = await api<BroilerSnapshot>(endpoint);
      await onSaved();
      setData(d);
      setStale(false);
      remember(null);
      setNotice(
        "Broiler lifecycle record saved. Recorded bird counts and evidence are updated.",
      );
    } catch (e) {
      setError((e as Error).message);
      setStale(true);
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
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      !data ||
      pending ||
      stale ||
      recoveryPending ||
      lossPending ||
      processingPending
    )
      return;
    const f = new FormData(e.currentTarget),
      str = (name: string) => String(f.get(name) ?? "");
    const common = {
      organizationId,
      unitId,
      eventId: crypto.randomUUID(),
      date: str("date"),
      kind,
      expectedPosition: data.summary.expectedPosition,
      expectedDailyId: data.summary.expectedDailyId,
      description: str("description"),
      reason: str("reason"),
      evidence: str("evidence"),
    };
    const details =
      kind === "void"
        ? { voidOfId: str("voidOfId") }
        : kind === "treatment"
          ? {
              quantity: Number(f.get("quantity")),
              product: str("product"),
              administration: str("administration"),
              earliestHarvestOn: str("earliestHarvestOn") || null,
            }
          : kind === "cull"
            ? {
                quantity: Number(f.get("quantity")),
                weightKg: str("weightKg") || null,
              }
            : kind === "harvest"
              ? {
                  quantity: Number(f.get("quantity")),
                  weightKg: str("weightKg"),
                  priceBasis,
                  pricePerUnit:
                    priceBasis === "unpriced" ? null : str("pricePerUnit"),
                  reference:
                    priceBasis === "unpriced" ? null : str("reference"),
                  customer: priceBasis === "unpriced" ? null : str("customer"),
                }
              : { quantity: Number(f.get("quantity")) };
    const parsed = broilerEventInput.safeParse({ ...common, ...details });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" "));
      return;
    }
    await save(parsed.data);
  }
  const disabled =
    busy ||
    !!pending ||
    stale ||
    recoveryPending ||
    lossPending ||
    processingPending;
  return (
    <section className="panel broiler-lifecycle" aria-label="Broiler lifecycle">
      <div className="panel-heading">
        <h2>Broiler lifecycle</h2>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload lifecycle records
        </button>
      </div>
      <p>
        Record observed health and administered treatments, reviewed culls, or
        completed live-bird harvests. Enter each day’s feed, deaths and sample
        before lifecycle events for that date. Daily deaths are recorded once in
        the daily log; culls remove additional birds.
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
            Posting receipt {pending.eventId} needs confirmation. Retry the
            original receipt to prevent a duplicate. This tab retains it across
            reloads when browser storage is available.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry broiler receipt
          </button>
          <button
            className="text-button"
            onClick={() =>
              downloadJson("broiler-pending-receipt.json", pending)
            }
          >
            Download pending broiler receipt
          </button>
        </div>
      )}
      {!data ? (
        <p>Load the batch history before recording lifecycle activity.</p>
      ) : (
        <>
          <p className="helper">
            Organization dates: {data.timezone}. Recorded through{" "}
            {data.summary.asOf}. Population is a recorded balance; missing
            observations can leave actual stock unknown.
          </p>
          <div className="stats-grid">
            {[
              ["Recorded birds", data.summary.balance],
              ["Harvested birds", data.summary.harvested],
              ["Culled birds", data.summary.culled],
              ["Measured withdrawn kg", data.summary.measuredWithdrawalKg],
              [
                "Measured dead-bird kg",
                data.summary.measuredDeathKg ?? "Unknown",
              ],
            ].map(([label, value]) => (
              <article className="stat" key={label}>
                <span className="stat-label">{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <h3>Cohort feed efficiency</h3>
          <p>
            {data.summary.fcr !== null
              ? `Recorded cohort FCR: ${data.summary.fcr} kg feed/kg biomass gain.`
              : "Cohort FCR is unavailable."}
          </p>
          {data.summary.fcrUnavailableReasons.length > 0 && (
            <ul>
              {data.summary.fcrUnavailableReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className="helper">
            Feed / (estimated remaining live biomass + measured whole-bird
            death, cull and live-harvest biomass − initial biomass). Requires
            complete daily feed and current measured loss evidence. A sample
            taken before a selective harvest cannot describe the remaining
            birds. This cohort measure includes measured biomass lost to deaths
            and culls; it is not a saleable-product conversion ratio.
          </p>
          <p>
            {data.summary.latestSample
              ? `Latest sample: ${data.summary.latestSample.average_weight_g} g from ${data.summary.latestSample.sample_size} birds on ${data.summary.latestSample.recorded_on}.`
              : "No subsequent weight sample is recorded."}{" "}
            Estimated remaining biomass:{" "}
            {data.summary.estimatedClosingBiomassKg ?? "unknown"} kg.{" "}
            {data.summary.latestSample &&
            data.summary.latestSample.recorded_on !== data.summary.asOf
              ? "The sample predates the latest activity."
              : ""}
          </p>
          {data.summary.sampledAdgGPerDay !== null && (
            <p>
              Sampled average daily gain from stocking:{" "}
              {data.summary.sampledAdgGPerDay} g/day. Selective withdrawals can
              change the sampled population.
            </p>
          )}
          <p>
            Recorded live-harvest values:{" "}
            {Object.entries(data.summary.sales)
              .map(([currency, amount]) => `${currency} ${amount}`)
              .join(" · ") || "none"}
            . Unpriced harvests: {data.summary.unpricedHarvests}. These values
            do not establish cash collection, costs or profit.
          </p>
          <h3>Recorded treatment withdrawal</h3>
          {data.summary.holds.length ? (
            <ul>
              {data.summary.holds.map((e) => (
                <li key={e.id}>
                  {e.product}:{" "}
                  {e.earliest_harvest_on
                    ? `earliest harvest ${e.earliest_harvest_on}`
                    : "earliest harvest date unknown — harvest blocked"}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              No active recorded treatment currently blocks today’s harvest
              date.
            </p>
          )}
          <p className="helper">
            Record the product, actual administration and earliest harvest date
            from the label or veterinary guidance. An unknown date blocks
            harvest. The app checks recorded dates; it does not prescribe
            medication or certify veterinary clearance. Review new withdrawal
            guidance below while preserving the original administration. Void
            only an erroneous administration.
          </p>
          {data.summary.harvestGuidance.some(
            (h) => h.currentConcerns.length > 0,
          ) && (
            <p className="error" role="alert">
              Current withdrawal guidance conflicts with{" "}
              {
                data.summary.harvestGuidance.filter(
                  (h) => h.currentConcerns.length > 0,
                ).length
              }{" "}
              earlier recorded harvest(s). Their original postings remain
              preserved. Review the linked treatment and harvest evidence with a
              veterinarian.
            </p>
          )}
          {data.summary.populationEvidenceIssues.length > 0 && (
            <p className="notice">
              Revised daily evidence puts some earlier observed/treated counts
              above the recorded population:{" "}
              {data.summary.populationEvidenceIssues.join(", ")}. Original
              health/treatment counts remain unchanged; review the source
              discrepancy.
            </p>
          )}
          <BroilerProcessing
            snapshot={data}
            actor={actor}
            canReview={canReview}
            blocked={
              busy || !!pending || stale || recoveryPending || lossPending
            }
            onPendingChange={setProcessingPending}
            onSaved={async () => {
              const d = await api<BroilerSnapshot>(endpoint);
              await onSaved();
              setData(d);
              setStale(false);
              return d;
            }}
          />
          <BroilerLoss
            snapshot={data}
            actor={actor}
            canReview={canReview}
            blocked={
              busy || !!pending || stale || recoveryPending || processingPending
            }
            onPendingChange={setLossPending}
            onSaved={async () => {
              const d = await api<BroilerSnapshot>(endpoint);
              await onSaved();
              setData(d);
              setStale(false);
              return d;
            }}
          />
          <BroilerRecovery
            snapshot={data}
            actor={actor}
            canReview={canReview}
            blocked={
              busy || !!pending || stale || lossPending || processingPending
            }
            onPendingChange={setRecoveryPending}
            onSaved={async () => {
              const d = await api<BroilerSnapshot>(endpoint);
              await onSaved();
              setData(d);
              setStale(false);
            }}
          />
          {canReview ? (
            <form onSubmit={(e) => void submit(e)}>
              <fieldset
                key={`${kind}:${data.summary.expectedPosition}:${data.summary.expectedDailyId}`}
                disabled={disabled}
                className="broiler-fields"
              >
                <legend>Review lifecycle activity</legend>
                <div className="form-grid">
                  <label>
                    Lifecycle activity
                    <select
                      value={kind}
                      onChange={(e) =>
                        setKind(e.target.value as BroilerInput["kind"])
                      }
                    >
                      <option value="health">Health observation</option>
                      <option value="treatment">Administered treatment</option>
                      <option value="cull">Cull birds</option>
                      <option value="harvest">Completed live harvest</option>
                      <option value="void">Void an erroneous entry</option>
                    </select>
                  </label>
                  <label>
                    Lifecycle date
                    <input
                      name="date"
                      type="date"
                      required
                      min={data.summary.asOf}
                      max={data.today}
                      key={data.summary.asOf}
                      defaultValue={data.summary.asOf}
                    />
                  </label>
                  {kind !== "void" && (
                    <label>
                      {kind === "health" || kind === "treatment"
                        ? "Observed / treated birds"
                        : "Birds removed"}
                      <input
                        name="quantity"
                        type="number"
                        min="1"
                        max={data.summary.balance}
                        step="1"
                        required
                      />
                    </label>
                  )}
                  {(kind === "cull" || kind === "harvest") && (
                    <label>
                      Measured total live weight (kg)
                      {kind === "cull" ? " · optional" : ""}
                      <input
                        name="weightKg"
                        type="number"
                        min="0.000001"
                        max="100000000"
                        step="0.000001"
                        required={kind === "harvest"}
                      />
                    </label>
                  )}
                  {kind === "treatment" && (
                    <>
                      <label>
                        Product name
                        <input
                          name="product"
                          required
                          minLength={2}
                          maxLength={200}
                        />
                      </label>
                      <label>
                        Actual administration and route
                        <textarea
                          name="administration"
                          required
                          minLength={3}
                          maxLength={2000}
                        />
                      </label>
                      <label>
                        Earliest harvest date · leave blank if unknown
                        <input
                          name="earliestHarvestOn"
                          type="date"
                          min={data.summary.asOf}
                        />
                      </label>
                    </>
                  )}
                  {kind === "harvest" && (
                    <>
                      <label>
                        Harvest price basis
                        <select
                          value={priceBasis}
                          onChange={(e) => setPriceBasis(e.target.value)}
                        >
                          <option value="unpriced">
                            Unpriced · value unknown
                          </option>
                          <option value="bird">Price per live bird</option>
                          <option value="kg">Price per measured live kg</option>
                        </select>
                      </label>
                      {priceBasis !== "unpriced" && (
                        <>
                          <label>
                            Price per unit
                            <input
                              name="pricePerUnit"
                              type="number"
                              required
                              min="0"
                              max="100000000"
                              step="0.0001"
                            />
                          </label>
                          <label>
                            Customer
                            <input
                              name="customer"
                              required
                              minLength={2}
                              maxLength={200}
                            />
                          </label>
                          <label>
                            Unique harvest reference
                            <input
                              name="reference"
                              required
                              minLength={3}
                              maxLength={100}
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                  {kind === "void" && (
                    <label>
                      Original erroneous event
                      <select name="voidOfId" required defaultValue="">
                        <option value="">Choose an eligible entry</option>
                        {data.events
                          .filter((e) => data.summary.voidable.includes(e.id))
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.recorded_on} · {e.kind} · {e.description}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Description
                    <textarea
                      name="description"
                      required
                      minLength={3}
                      maxLength={2000}
                    />
                  </label>
                  <label>
                    Review reason
                    <textarea
                      name="reason"
                      required
                      minLength={10}
                      maxLength={2000}
                    />
                  </label>
                  <label>
                    Evidence / veterinary reference
                    <textarea
                      name="evidence"
                      required
                      minLength={3}
                      maxLength={2000}
                    />
                  </label>
                </div>
                <p className="helper">
                  Only completed withdrawals reduce stock. A void corrects an
                  erroneous entry; it records no physical return. Stock entries
                  can be voided only before subsequent activity. Harvest pricing
                  uses measured live kg or whole birds, once, with the original
                  currency.
                </p>
                <label className="checkbox">
                  <input type="checkbox" required />I checked the actual birds,
                  records and evidence for this entry.
                </label>
                <button className="primary" type="submit">
                  Save broiler lifecycle record
                </button>
              </fieldset>
            </form>
          ) : (
            <p className="helper">
              An owner, administrator or manager reviews lifecycle entries.
              Daily observations remain available to workers.
            </p>
          )}
          <div className="panel-heading">
            <h3>Immutable lifecycle history</h3>
            <div>
              <button
                className="text-button"
                disabled={busy || stale}
                onClick={() =>
                  void downloadReport(
                    endpoint + "&format=json",
                    "broiler-lifecycle.json",
                  ).catch((e) => setError(e.message))
                }
              >
                Download broiler JSON
              </button>
              <button
                className="text-button"
                disabled={busy || stale}
                onClick={() =>
                  void downloadReport(
                    endpoint + "&format=csv",
                    "broiler-lifecycle.csv",
                  ).catch((e) => setError(e.message))
                }
              >
                Download broiler CSV
              </button>
            </div>
          </div>
          {data.events.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date / event</th>
                    <th>Birds / live kg</th>
                    <th>Description / treatment</th>
                    <th>Recorded value</th>
                    <th>Review evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.events].reverse().map((e) => (
                    <tr key={e.id}>
                      <td>
                        {e.recorded_on} · {e.kind}
                        <span className="helper">
                          {e.id}
                          {data.events.some((v) => v.void_of_id === e.id)
                            ? " · voided"
                            : ""}
                          {e.void_of_id ? ` · voids ${e.void_of_id}` : ""}
                        </span>
                      </td>
                      <td>
                        {e.quantity ?? "—"} / {e.weight_kg ?? "unknown"}
                      </td>
                      <td>
                        {e.description}
                        {e.product && (
                          <p>
                            {e.product} · {e.administration} · Earliest harvest:{" "}
                            {e.earliest_harvest_on ?? "unknown"}
                          </p>
                        )}
                      </td>
                      <td>
                        {e.amount !== null
                          ? `${e.currency} ${e.amount} · ${e.price_basis} · ${e.reference} · ${e.customer}`
                          : "Not priced"}
                      </td>
                      <td>
                        {e.reason}
                        <p>{e.evidence}</p>
                        <span className="helper">
                          {e.created_by} · {e.created_at}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No lifecycle events are recorded.</p>
          )}
          <p className="helper">
            Source evidence SHA-256: {data.evidenceSha256}. JSON and CSV include
            original daily observations, exact weights, prices and review
            receipts.
          </p>
        </>
      )}
    </section>
  );
}
