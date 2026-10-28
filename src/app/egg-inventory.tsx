"use client";
import EggReturnFields from "./egg-return-fields";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, downloadJson, downloadCsv } from "@/lib/client";
import { useDialog } from "@/lib/use-dialog";
import {
  eggGrades,
  eggEventInput,
  eggStoreInput,
  eggSale,
  eggReversible,
  eggSheets,
  type EggSnapshot,
  type EggBatch,
  type EggCollection,
  type EggEventInput,
} from "@/lib/egg-inventory";
type Kind = "store" | EggEventInput["kind"];
type Modal = {
  kind: Kind;
  batch?: EggBatch;
  collection?: EggCollection;
  previousId?: string | null;
  position?: string;
  lastDate?: string;
};
type Pending = { path: "eggs/stores" | "eggs/events"; body: unknown };
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function GradeOptions() {
  return eggGrades.map((g) => (
    <option key={g} value={g}>
      {g}
    </option>
  ));
}
function NumberField({
  label,
  name,
  value,
  step = "1",
  max = 100000000,
}: {
  label: string;
  name: string;
  value?: number | string;
  step?: string;
  max?: number;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        type="number"
        min="0"
        max={max}
        step={step}
        required
        defaultValue={value}
      />
    </Field>
  );
}
export default function EggInventory({
  organizationId,
  role,
  farms,
  actor,
}: {
  organizationId: string;
  role: string;
  farms: { id: string; name: string }[];
  actor: string;
}) {
  const [data, setData] = useState<EggSnapshot | null>(null),
    [storeId, setStoreId] = useState(""),
    [batchId, setBatchId] = useState(""),
    [modal, setModal] = useState<Modal | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [stale, setStale] = useState(true),
    [pending, setPending] = useState<Pending | null>(null),
    [storageWarning, setStorageWarning] = useState(""),
    [grade, setGrade] = useState<(typeof eggGrades)[number]>("ungraded"),
    [mode, setMode] = useState<"per-egg" | "tray-and-loose">("per-egg"),
    [quote, setQuote] = useState(""),
    [showAll, setShowAll] = useState(false);
  const canPost = ["owner", "admin", "manager", "inventory"].includes(role),
    canReview = ["owner", "admin", "manager"].includes(role),
    endpoint = `eggs?organizationId=${organizationId}`,
    storageKey = `farmstead:egg-posting:v1:${organizationId}:${actor}`;
  useEffect(() => {
    let active = true;
    void api<EggSnapshot>(endpoint)
      .then((d) => {
        if (active) {
          setData(d);
          setStale(false);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const p = JSON.parse(raw) as Pending;
          const parsed = (
            p.path === "eggs/stores"
              ? eggStoreInput
              : p.path === "eggs/events"
                ? eggEventInput
                : null
          )?.safeParse(p.body);
          if (parsed?.success && parsed.data.organizationId === organizationId)
            setPending({ path: p.path, body: parsed.data });
          else
            setStorageWarning(
              "An invalid tab recovery copy was ignored. Check inventory history before entering another posting.",
            );
        }
      } catch {
        setStorageWarning(
          "Tab recovery storage is unavailable. Keep this page open until each posting is confirmed.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [endpoint, storageKey, organizationId]);
  useEffect(() => {
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  useDialog(!!modal, () => {
    if (!busy && !pending) setModal(null);
  });
  async function refresh() {
    const d = await api<EggSnapshot>(endpoint);
    setData(d);
    setStale(false);
    return d;
  }
  async function reload() {
    setBusy(true);
    setError("");
    try {
      await refresh();
      if (!pending) setModal(null);
    } catch (e) {
      setError((e as Error).message);
      setStale(true);
    } finally {
      setBusy(false);
    }
  }
  function keep(p: Pending | null) {
    setPending(p);
    try {
      if (p) sessionStorage.setItem(storageKey, JSON.stringify(p));
      else sessionStorage.removeItem(storageKey);
    } catch {
      setStorageWarning(
        "Tab recovery storage is unavailable. Keep this page open until each posting is confirmed.",
      );
    }
  }
  async function post(p: Pending) {
    setBusy(true);
    setError("");
    setNotice("");
    keep(p);
    let confirmed = false;
    try {
      await api(p.path, p.body);
      confirmed = true;
      keep(null);
      setModal(null);
      const b = p.body as { storeId?: string; batchId?: string };
      if (b.storeId) setStoreId(b.storeId);
      if (b.batchId) setBatchId(b.batchId);
      await refresh();
      setNotice(
        "Egg posting confirmed. Stock and recorded sale values refreshed.",
      );
    } catch (e) {
      setError(
        confirmed
          ? "The posting was confirmed, but inventory could not refresh. Reload before posting again."
          : (e as Error).message,
      );
      setStale(true);
      if (
        !confirmed &&
        e instanceof ApiError &&
        [400, 403, 404, 409, 422].includes(e.status)
      )
        keep(null);
    } finally {
      setBusy(false);
    }
  }
  const store = data?.stores.find((s) => s.id === storeId) ?? data?.stores[0],
    batches = data?.batches.filter((b) => b.store_id === store?.id) ?? [],
    batch = batches.find((b) => b.id === batchId) ?? batches.at(-1),
    blocked = busy || !!pending || stale;
  const baseline = batches
    .filter((b) => b.source_kind === "opening")
    .map((b) => b.received_on)
    .sort()[0];
  const openingAllowed = !data?.events.some(
    (e) =>
      e.kind !== "opening" &&
      batches.some(
        (b) => b.id === e.batch_id || b.id === e.destination_batch_id,
      ),
  );
  const balance = (b: string, g: string) =>
    data?.summary.balances.find((x) => x.batchId === b && x.grade === g)
      ?.eggs ?? 0;
  function open(kind: Kind, collection?: EggCollection) {
    setError("");
    setNotice("");
    setQuote("");
    setMode("per-egg");
    const r = collection
      ? data?.summary.reconciliation.find(
          (r) =>
            r.unitId === collection.unit_id &&
            r.date === collection.recorded_on,
        )
      : undefined;
    const b =
      kind === "opening" || kind === "store"
        ? undefined
        : collection
          ? data?.batches.find((b) => b.id === r?.batchId)
          : batch;
    const last = b
      ? data?.events
          .filter((e) => e.batch_id === b.id || e.destination_batch_id === b.id)
          .at(-1)
      : undefined;
    setGrade(
      b
        ? (data?.summary.balances.find((x) => x.batchId === b.id && x.eggs > 0)
            ?.grade ?? "ungraded")
        : "ungraded",
    );
    setModal({
      kind,
      batch: b,
      collection,
      previousId: r?.previousId ?? null,
      position: b ? data?.summary.lastPositions[b.id] : undefined,
      lastDate: last?.occurred_on ?? b?.received_on,
    });
  }
  function pricing(f: FormData) {
    return mode === "per-egg"
      ? {
          mode: "per-egg" as const,
          eggs: Number(f.get("eggs")),
          pricePerEgg: String(f.get("pricePerEgg")),
        }
      : {
          mode: "tray-and-loose" as const,
          trays: Number(f.get("trays")),
          looseEggs: Number(f.get("looseEggs")),
          traySize: Number(f.get("traySize")),
          pricePerTray: String(f.get("pricePerTray")),
          pricePerEgg: String(f.get("pricePerEgg")),
        };
  }
  function preview(form: HTMLFormElement) {
    try {
      const f = new FormData(form);
      const required =
        mode === "per-egg"
          ? ["eggs", "pricePerEgg"]
          : ["trays", "looseEggs", "traySize", "pricePerTray", "pricePerEgg"];
      if (required.some((k) => !f.get(k))) {
        setQuote("Complete all sale quantities and prices.");
        return;
      }
      const q = eggSale(pricing(f));
      setQuote(
        `${q.quantity.toLocaleString()} whole eggs · ${data?.organization.currency} ${q.total}`,
      );
    } catch {
      setQuote("Check whole counts, prices and tray remainder.");
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modal || !data || pending) return;
    const f = new FormData(e.currentTarget);
    try {
      if (modal.kind === "store") {
        await post({
          path: "eggs/stores",
          body: eggStoreInput.parse({
            organizationId,
            storeId: crypto.randomUUID(),
            farmId: f.get("farm"),
            name: f.get("name"),
          }),
        });
        return;
      }
      const common = {
        organizationId,
        eventId: crypto.randomUUID(),
        batchId: modal.batch?.id ?? crypto.randomUUID(),
        kind: modal.kind,
        date: String(f.get("date")),
        reason: String(f.get("reason")),
        evidence: String(f.get("evidence")),
      };
      let payload: unknown;
      switch (modal.kind) {
        case "opening":
          payload = {
            ...common,
            kind: "opening",
            storeId: store?.id,
            batchName: f.get("batchName"),
            grade,
            quantity: Number(f.get("quantity")),
          };
          break;
        case "receipt":
          payload = {
            ...common,
            kind: "receipt",
            storeId: modal.batch?.store_id ?? store?.id,
            batchName: modal.batch?.name ?? f.get("batchName"),
            unitId: modal.collection?.unit_id,
            collectionDate: modal.collection?.recorded_on,
            expectedRecordId: modal.collection?.id,
            expectedAdjustmentId: modal.collection?.adjustment_id ?? null,
            previousId: modal.previousId,
          };
          break;
        case "grade":
          payload = {
            ...common,
            kind: "grade",
            grade,
            targetGrade: f.get("targetGrade"),
            quantity: Number(f.get("quantity")),
          };
          break;
        case "loss":
          payload = {
            ...common,
            kind: "loss",
            grade,
            quantity: Number(f.get("quantity")),
          };
          break;
        case "count":
          payload = {
            ...common,
            kind: "count",
            grade,
            counted: Number(f.get("counted")),
            expectedPosition: modal.position,
          };
          break;
        case "sale":
          payload = {
            ...common,
            kind: "sale",
            grade,
            currency: data.organization.currency,
            customer: f.get("customer"),
            reference: f.get("reference"),
            pricing: pricing(f),
          };
          break;
        case "transfer":
          payload = {
            ...common,
            kind: "transfer",
            grade,
            quantity: Number(f.get("quantity")),
            destinationStoreId: f.get("destinationStoreId"),
            destinationBatchId: crypto.randomUUID(),
            destinationBatchName: f.get("destinationBatchName"),
          };
          break;
        case "return":
          payload = {
            ...common,
            kind: "return",
            saleId: f.get("saleId"),
            trayEggs: Number(f.get("trayEggs")),
            looseEggs: Number(f.get("looseEggs")),
            restockEggs: Number(f.get("restockEggs")),
            expectedReturnPosition: f.get("expectedReturnPosition"),
            reference: f.get("returnReference"),
          };
          break;
        case "reversal":
          payload = {
            ...common,
            kind: "reversal",
            reversesId: f.get("reversesId"),
          };
          break;
      }
      await post({ path: "eggs/events", body: eggEventInput.parse(payload) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const pendingCollections =
    data?.collections.filter((c) => {
      const r = data.summary.reconciliation.find(
        (r) => r.unitId === c.unit_id && r.date === c.recorded_on,
      );
      const b = data.batches.find((b) => b.id === r?.batchId);
      return (
        c.farm_id === store?.farm_id &&
        (!baseline || c.recorded_on >= baseline) &&
        (!b || b.store_id === store?.id) &&
        (showAll || r?.status !== "reconciled")
      );
    }) ?? [];
  return (
    <section
      className="module egg-inventory"
      aria-label="Egg inventory and sales"
    >
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
      {storageWarning && <p className="helper">{storageWarning}</p>}
      {pending && (
        <div className="panel egg-panel" role="status">
          <h2>Unconfirmed egg posting</h2>
          <p>
            This tab retained the original posting receipt. Retry it to confirm
            the result before entering another movement. Reloading history keeps
            the receipt available.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void post(pending)}
          >
            Retry egg posting
          </button>
          <button
            className="text-button"
            onClick={() =>
              downloadJson("farmstead-egg-posting-recovery.json", pending)
            }
          >
            Download pending receipt JSON
          </button>
        </div>
      )}
      <div className="production-toolbar">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload egg inventory
        </button>
        <button
          className="primary"
          disabled={!canPost || blocked || !farms.length}
          onClick={() => open("store")}
        >
          Add egg store
        </button>
        <button
          className="text-button"
          disabled={!data || busy}
          onClick={() =>
            data && downloadJson(`farmstead-eggs-${organizationId}.json`, data)
          }
        >
          Download egg inventory JSON
        </button>
        <button
          className="text-button"
          disabled={!data || busy}
          onClick={() => {
            if (data) {
              const {
                modelVersion: _,
                summary,
                evidenceSha256,
                generatedAt: __,
                ...source
              } = data;
              void _;
              void __;
              downloadCsv(
                `farmstead-eggs-${organizationId}.csv`,
                eggSheets(source, summary, evidenceSha256).flatMap((s) => [
                  [s.name],
                  ...s.rows,
                  [],
                ]),
              );
            }
          }}
        >
          Download egg inventory CSV
        </button>
      </div>
      {!data ? (
        <p>Load the inventory before posting stock.</p>
      ) : (
        <>
          {!data.stores.length ? (
            <div className="panel empty">
              <h2>Start with a physical egg store</h2>
              <p>
                Add a store for a farm, then receive actual collections or
                record evidenced opening stock. Production observations and
                forecasts do not enter stock automatically.
              </p>
            </div>
          ) : (
            <>
              <label className="field">
                <span>Egg store</span>
                <select
                  value={store?.id ?? ""}
                  disabled={busy || !!pending}
                  onChange={(e) => {
                    setStoreId(e.target.value);
                    setBatchId("");
                  }}
                >
                  {data.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ·{" "}
                      {farms.find((f) => f.id === s.farm_id)?.name ?? s.farm_id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="stats-grid">
                <article className="stat panel">
                  <span className="stat-label">
                    Recorded eggs in this store
                  </span>
                  <strong>
                    {data.summary.balances
                      .filter((r) => batches.some((b) => b.id === r.batchId))
                      .reduce((n, r) => n + r.eggs, 0)
                      .toLocaleString()}
                  </strong>
                </article>
                <article className="stat panel">
                  <span className="stat-label">
                    Collections needing receipt or review
                  </span>
                  <strong>
                    {
                      pendingCollections.filter(
                        (c) =>
                          data.summary.reconciliation.find(
                            (r) =>
                              r.unitId === c.unit_id &&
                              r.date === c.recorded_on,
                          )?.status !== "reconciled",
                      ).length
                    }
                  </strong>
                </article>
              </div>
              <section className="panel egg-panel">
                {baseline && (
                  <p className="helper">
                    Opening-of-day stock baseline: {baseline}. Earlier
                    collections are outside this store&apos;s stock ledger.
                  </p>
                )}
                <div className="panel-heading">
                  <h2>Receive and reconcile collections</h2>
                  <button
                    className="text-button"
                    disabled={blocked}
                    onClick={() => setShowAll((v) => !v)}
                  >
                    {showAll
                      ? "Show pending collections"
                      : "Show all collections"}
                  </button>
                </div>
                <p>
                  Receive gross eggs less the cracked count into ungraded stock.
                  Missing days have no collection to receive. A later daily
                  correction requires a new receipt review; stock history stays
                  intact.
                </p>
                {pendingCollections.length ? (
                  <div className="table-scroll">
                    <table aria-label="Egg collection reconciliation">
                      <thead>
                        <tr>
                          <th>Flock / date</th>
                          <th>Gross / cracked</th>
                          <th>Current saleable</th>
                          <th>Receipted count</th>
                          <th>Difference</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingCollections.map((c) => {
                          const r = data.summary.reconciliation.find(
                            (r) =>
                              r.unitId === c.unit_id &&
                              r.date === c.recorded_on,
                          )!;
                          return (
                            <tr key={`${c.unit_id}:${c.recorded_on}`}>
                              <td>
                                {c.unit_name}
                                <br />
                                {c.recorded_on}
                              </td>
                              <td>
                                {c.eggs} / {c.cracked}
                              </td>
                              <td>{r.saleable}</td>
                              <td>{r.received ?? "Not received"}</td>
                              <td>{r.difference}</td>
                              <td>{r.status}</td>
                              <td>
                                <button
                                  className="text-button"
                                  disabled={
                                    !canPost ||
                                    blocked ||
                                    r.status === "reconciled"
                                  }
                                  onClick={() => open("receipt", c)}
                                >
                                  {r.status === "not-received"
                                    ? "Receive collection"
                                    : "Reconcile receipt"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    No pending collection observations for this farm and store.
                  </p>
                )}
              </section>
              <section className="panel egg-panel">
                <div className="panel-heading">
                  <h2>Stock by batch and grade</h2>
                  <button
                    className="secondary"
                    disabled={!canPost || blocked || !openingAllowed}
                    onClick={() => open("opening")}
                  >
                    Record opening egg stock
                  </button>
                </div>
                <p>
                  Opening stock is an opening-of-day baseline before store
                  operations. Record all initial batches on that date; use
                  reviewed physical counts afterward. Grade labels use your
                  classifications; no size or food-safety standard is inferred.
                </p>
                <div className="table-scroll">
                  <table aria-label="Egg stock balances">
                    <thead>
                      <tr>
                        <th>Batch / source</th>
                        <th>Grade</th>
                        <th>Whole eggs</th>
                        <th>30-egg trays + loose</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.summary.balances
                        .filter((r) => batches.some((b) => b.id === r.batchId))
                        .map((r) => (
                          <tr key={`${r.batchId}:${r.grade}`}>
                            <td>
                              {batches.find((b) => b.id === r.batchId)?.name}
                              <br />
                              {
                                batches.find((b) => b.id === r.batchId)
                                  ?.source_kind
                              }
                            </td>
                            <td>{r.grade}</td>
                            <td>{r.eggs}</td>
                            <td>
                              {Math.floor(r.eggs / 30)} + {r.eggs % 30}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <label className="field">
                  <span>Egg batch for movement</span>
                  <select
                    value={batch?.id ?? ""}
                    disabled={busy || !!pending}
                    onChange={(e) => setBatchId(e.target.value)}
                  >
                    <option value="" disabled>
                      Choose a batch
                    </option>
                    {batches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} · {b.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="production-toolbar">
                  {(
                    [
                      "grade",
                      "sale",
                      "loss",
                      "transfer",
                      "return",
                      "count",
                      "reversal",
                    ] as const
                  )
                    .filter(
                      (k) =>
                        canPost &&
                        (!["count", "reversal", "return"].includes(k) ||
                          canReview),
                    )
                    .map((k) => (
                      <button
                        className="secondary"
                        key={k}
                        disabled={blocked || !batch}
                        onClick={() => open(k)}
                      >
                        {
                          {
                            grade: "Grade eggs",
                            sale: "Record egg sale",
                            transfer: "Transfer eggs",
                            return: "Review egg return",
                            loss: "Record egg loss",
                            count: "Review physical egg count",
                            reversal: "Reverse egg movement",
                          }[k]
                        }
                      </button>
                    ))}
                </div>
                {!canPost && (
                  <p>
                    Your role can read stock, reconciliation, sales and movement
                    history.
                  </p>
                )}
              </section>
            </>
          )}
          <section className="panel egg-panel">
            <h2>Recorded egg sales · all stores</h2>
            <p>
              Values retain their recorded currency and prices. Sales and
              customer returns are separate from payments, cash, costs and
              profitability.
            </p>
            {data.summary.sales.length ? (
              <div className="table-scroll">
                <table aria-label="Egg sales by currency">
                  <thead>
                    <tr>
                      <th>Currency</th>
                      <th>Net whole eggs sold</th>
                      <th>Net recorded sale value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.sales.map((s) => (
                      <tr key={s.currency}>
                        <td>{s.currency}</td>
                        <td>{s.netEggs}</td>
                        <td>{s.netValue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No egg sales recorded.</p>
            )}
          </section>
          <section className="panel egg-panel">
            <h2>Customer returns by original sale</h2>
            <p>
              Returned quantities and recorded credits include only active
              returns. Non-saleable returns are excluded from stock. Cash
              refunds remain separate.
            </p>
            <div className="table-scroll">
              <table aria-label="Egg customer return reconciliation">
                <thead>
                  <tr>
                    <th>Original sale</th>
                    <th>Returned eggs</th>
                    <th>Saleable restocked</th>
                    <th>Non-saleable</th>
                    <th>Original-currency credit</th>
                    <th>Remaining eligible eggs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.saleReturns.map((s) => (
                    <tr key={s.saleId}>
                      <td>
                        {s.reference} · {s.customer}
                      </td>
                      <td>{s.returnedTrayEggs + s.returnedLooseEggs}</td>
                      <td>{s.restockedEggs}</td>
                      <td>{s.nonSaleableEggs}</td>
                      <td>
                        {s.currency} {s.creditedValue}
                      </td>
                      <td>
                        {s.fullyReversed
                          ? "Sale reversed"
                          : s.remainingTrayEggs + s.remainingLooseEggs}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel egg-panel">
            <details>
              <summary>
                Immutable egg movement history ({data.events.length})
              </summary>
              <div className="table-scroll">
                <table aria-label="Egg movement history">
                  <thead>
                    <tr>
                      <th>Order / date</th>
                      <th>Batch / kind</th>
                      <th>Grade / quantity</th>
                      <th>Sale / return value</th>
                      <th>Reason / evidence</th>
                      <th>Traceability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.events].reverse().map((e) => (
                      <tr key={e.id}>
                        <td>
                          {e.position}
                          <br />
                          {e.occurred_on}
                        </td>
                        <td>
                          {data.batches.find((b) => b.id === e.batch_id)?.name}
                          <br />
                          {e.kind}
                        </td>
                        <td>
                          {e.target_grade
                            ? `${e.grade} → ${e.target_grade}`
                            : e.grade}
                          <br />
                          {e.quantity}
                          {e.target_grade ? " transferred" : " signed eggs"}
                        </td>
                        <td>
                          {e.amount !== null
                            ? `${e.currency} ${e.amount} · ${e.customer} · ${e.reference}`
                            : "—"}
                        </td>
                        <td>
                          {e.reason}
                          <br />
                          {e.evidence}
                        </td>
                        <td>
                          {e.id}
                          <br />
                          {e.created_by}
                          <br />
                          {e.created_at}
                          {e.destination_batch_id && (
                            <>
                              <br />
                              Destination batch: {e.destination_batch_id}
                            </>
                          )}
                          {e.return_of_id && (
                            <>
                              <br />
                              Original sale: {e.return_of_id}
                              <br />
                              {e.return_tray_eggs ?? 0} tray-priced /{" "}
                              {e.return_loose_eggs ?? 0} individually priced
                              eggs; {e.quantity} saleable stock movement.
                            </>
                          )}
                          {e.previous_id && (
                            <>Previous receipt: {e.previous_id}</>
                          )}
                          {e.reverses_id && <>Reverses: {e.reverses_id}</>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <p className="helper">
              Snapshot {data.evidenceSha256} · {data.organization.timezone}.
              Downloads preserve the displayed evidence.
            </p>
          </section>
        </>
      )}
      {modal && data && (
        <div className="modal-backdrop">
          <section
            className="modal panel wide-modal egg-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="egg-dialog-title"
          >
            <div className="panel-heading">
              <h2 id="egg-dialog-title">
                {
                  {
                    transfer: "Transfer eggs",
                    return: "Review egg return",
                    store: "Add egg store",
                    opening: "Record opening egg stock",
                    receipt: "Receive or reconcile collection",
                    grade: "Grade eggs",
                    sale: "Record egg sale",
                    loss: "Record egg loss",
                    count: "Review physical egg count",
                    reversal: "Reverse egg movement",
                  }[modal.kind]
                }
              </h2>
              <button
                className="text-button"
                disabled={busy || !!pending}
                onClick={() => setModal(null)}
              >
                Close
              </button>
            </div>
            {modal.batch && (
              <p>
                {modal.batch.name} · received {modal.batch.received_on}. Latest
                movement: {modal.lastDate}.
              </p>
            )}
            {modal.kind === "receipt" && (
              <p>
                {modal.collection?.unit_name} · {modal.collection?.recorded_on}:{" "}
                {modal.collection?.eggs} gross less {modal.collection?.cracked}{" "}
                cracked ={" "}
                {(modal.collection?.eggs ?? 0) -
                  (modal.collection?.cracked ?? 0)}{" "}
                saleable eggs. This review posts only the difference from its
                previous receipt into ungraded stock. Earlier receipts remain in
                history.
              </p>
            )}
            {modal.kind === "reversal" && (
              <p>
                For a complete sale reversal, confirm that all eggs were
                returned fit for sale or the dispatch was cancelled. Use the
                customer-return workflow if any returned eggs are non-saleable.
                The reversal restores the whole quantity and reverses its
                recorded sale value; it does not record a cash refund.
                Collection changes use receipt reconciliation. Transfers reverse
                both stores together. Customer returns must be reversed in
                latest-first order; sales with active partial returns use the
                remaining-return workflow.
              </p>
            )}
            {modal.kind === "count" && (
              <p>
                Enter the physically counted whole eggs for this batch and
                grade. This posts the difference with evidence; it does not
                change collection records or explain a discrepancy as a sale.
              </p>
            )}
            <form
              onSubmit={(e) => void submit(e)}
              onChange={(e) => {
                if (modal.kind === "sale") preview(e.currentTarget);
              }}
            >
              <fieldset disabled={blocked} className="egg-fieldset">
                <div className="form-grid">
                  {modal.kind === "store" ? (
                    <>
                      <Field label="Farm for egg store">
                        <select name="farm" required>
                          {farms.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Egg store name">
                        <input
                          name="name"
                          required
                          minLength={2}
                          maxLength={100}
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field label="Egg movement date">
                        <input
                          name="date"
                          type="date"
                          required
                          min={
                            modal.kind === "opening"
                              ? baseline
                              : (modal.lastDate ??
                                modal.collection?.recorded_on)
                          }
                          max={
                            modal.kind === "opening"
                              ? (baseline ?? data.organization.today)
                              : data.organization.today
                          }
                          defaultValue={
                            modal.kind === "opening"
                              ? (baseline ?? data.organization.today)
                              : data.organization.today
                          }
                        />
                      </Field>
                      {modal.kind === "opening" && (
                        <Field label="Opening egg batch name">
                          <input
                            name="batchName"
                            minLength={2}
                            maxLength={100}
                            required
                          />
                        </Field>
                      )}
                      {modal.kind === "receipt" && !modal.batch && (
                        <Field label="Collection batch name">
                          <input
                            name="batchName"
                            minLength={2}
                            maxLength={100}
                            required
                            defaultValue={`Collection ${modal.collection?.recorded_on} · ${modal.collection?.unit_name}`.slice(
                              0,
                              100,
                            )}
                          />
                        </Field>
                      )}
                      {!["receipt", "reversal", "return"].includes(
                        modal.kind,
                      ) && (
                        <Field label="Egg grade">
                          <select
                            value={grade}
                            onChange={(e) =>
                              setGrade(e.target.value as typeof grade)
                            }
                          >
                            <GradeOptions />
                          </select>
                        </Field>
                      )}
                      {modal.batch &&
                        !["receipt", "reversal", "return"].includes(
                          modal.kind,
                        ) && (
                          <p>
                            Recorded {grade} stock:{" "}
                            {balance(modal.batch.id, grade)} whole eggs.
                          </p>
                        )}
                      {["opening", "grade", "loss", "transfer"].includes(
                        modal.kind,
                      ) && (
                        <NumberField
                          label="Whole egg quantity"
                          name="quantity"
                        />
                      )}
                      {modal.kind === "grade" && (
                        <Field label="Target egg grade">
                          <select
                            name="targetGrade"
                            required
                            defaultValue={
                              grade === "large" ? "medium" : "large"
                            }
                          >
                            <GradeOptions />
                          </select>
                        </Field>
                      )}
                      {modal.kind === "count" && (
                        <NumberField
                          key={grade}
                          label="Physically counted eggs"
                          name="counted"
                        />
                      )}
                      {modal.kind === "sale" && (
                        <>
                          <Field label="Egg sale customer">
                            <input
                              name="customer"
                              required
                              minLength={1}
                              maxLength={200}
                            />
                          </Field>
                          <Field label="Egg sale reference">
                            <input
                              name="reference"
                              required
                              minLength={3}
                              maxLength={100}
                            />
                          </Field>
                          <Field label="Egg sale pricing">
                            <select
                              value={mode}
                              onChange={(e) => {
                                setMode(e.target.value as typeof mode);
                                setQuote("");
                              }}
                            >
                              <option value="per-egg">Price per egg</option>
                              <option value="tray-and-loose">
                                Tray price plus loose-egg price
                              </option>
                            </select>
                          </Field>
                          {mode === "per-egg" ? (
                            <NumberField label="Eggs sold" name="eggs" />
                          ) : (
                            <>
                              <NumberField
                                label="Whole trays sold"
                                name="trays"
                              />
                              <NumberField
                                label="Loose eggs sold"
                                name="looseEggs"
                              />
                              <NumberField
                                label="Eggs per sale tray"
                                name="traySize"
                                value={30}
                                max={1000}
                              />
                              <NumberField
                                label={`Price per tray (${data.organization.currency})`}
                                name="pricePerTray"
                                step="0.0001"
                              />
                            </>
                          )}
                          <NumberField
                            label={`Price per egg (${data.organization.currency})`}
                            name="pricePerEgg"
                            step="0.0001"
                          />
                          <p className="egg-quote" role="status">
                            {quote ||
                              "Complete all sale quantities and prices."}
                          </p>
                        </>
                      )}
                      {modal.kind === "reversal" && (
                        <Field label="Egg movement to reverse">
                          <select name="reversesId" required>
                            <option value="">
                              Choose the complete original movement
                            </option>
                            {data.events
                              .filter(
                                (e) =>
                                  e.batch_id === modal.batch?.id &&
                                  eggReversible(e, data.events),
                              )
                              .map((e) => (
                                <option key={e.id} value={e.id}>
                                  {e.occurred_on} · {e.kind} · {e.quantity} ·{" "}
                                  {e.reference ?? e.id.slice(0, 8)}
                                </option>
                              ))}
                          </select>
                        </Field>
                      )}
                      {modal.kind === "transfer" && (
                        <>
                          <label className="field">
                            <span>Destination egg store</span>
                            <select
                              name="destinationStoreId"
                              required
                              defaultValue=""
                            >
                              <option value="">Choose another store</option>
                              {data.stores
                                .filter((d) => d.id !== modal.batch?.store_id)
                                .map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name} ·{" "}
                                    {farms.find((f) => f.id === d.farm_id)
                                      ?.name ?? d.farm_id}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <Field label="Transferred batch name">
                            <input
                              name="destinationBatchName"
                              required
                              minLength={2}
                              maxLength={100}
                              defaultValue={`Transfer · ${modal.batch?.name}`.slice(
                                0,
                                100,
                              )}
                            />
                          </Field>
                          <p>
                            Confirm a completed physical transfer. Both stores
                            move the same whole eggs in one posting; grade and
                            batch lineage are retained. This records no sale or
                            financial value.
                          </p>
                        </>
                      )}
                      {modal.kind === "return" && (
                        <EggReturnFields
                          sales={data.summary.saleReturns.filter(
                            (s) => s.batchId === modal.batch?.id,
                          )}
                        />
                      )}
                      <Field label="Egg posting reason">
                        <textarea
                          name="reason"
                          required
                          minLength={10}
                          maxLength={2000}
                        />
                      </Field>
                      <Field label="Egg posting evidence">
                        <textarea
                          name="evidence"
                          required
                          minLength={3}
                          maxLength={2000}
                        />
                      </Field>
                    </>
                  )}
                </div>
                {modal.kind !== "store" && (
                  <label className="egg-confirm">
                    <input type="checkbox" required /> I checked the counts,
                    date, grade, prices where applicable, and source evidence.
                  </label>
                )}
                <button className="primary" disabled={blocked}>
                  {busy ? "Posting…" : "Confirm egg posting"}
                </button>
              </fieldset>
            </form>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {pending && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void post(pending)}
              >
                Retry egg posting
              </button>
            )}
            {stale && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void reload()}
              >
                Reload before posting
              </button>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
