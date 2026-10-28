"use client";
import { useState } from "react";
import { eggReturnCredit, type EggReturnState } from "@/lib/egg-inventory";
export default function EggReturnFields({
  sales,
}: {
  sales: EggReturnState[];
}) {
  const eligible = sales.filter(
    (s) => !s.fullyReversed && s.remainingTrayEggs + s.remainingLooseEggs > 0,
  );
  const [saleId, setSaleId] = useState(eligible[0]?.saleId ?? ""),
    [tray, setTray] = useState(""),
    [loose, setLoose] = useState(""),
    [restock, setRestock] = useState("");
  const s = eligible.find((s) => s.saleId === saleId);
  const t = s?.remainingTrayEggs === 0 ? "0" : tray,
    l = s?.remainingLooseEggs === 0 ? "0" : loose;
  let quote =
    "Enter the actual returned counts and the inspected saleable restock count.";
  if (s && t !== "" && l !== "" && restock !== "") {
    try {
      const n = Number(t) + Number(l),
        r = Number(restock);
      if (!Number.isInteger(r) || r < 0 || r > n) throw Error();
      quote = `Original-currency sales credit: ${s.currency} ${eggReturnCredit(s, Number(t), Number(l))} · ${n} returned · ${r} restock · ${n - r} non-saleable.`;
    } catch {
      quote =
        "Check returned counts against the remaining original sale and its saleable restock count.";
    }
  }
  return (
    <>
      <label className="field">
        <span>Original egg sale for return</span>
        <select
          name="saleId"
          required
          value={saleId}
          onChange={(e) => {
            setSaleId(e.target.value);
            setTray("");
            setLoose("");
            setRestock("");
          }}
        >
          <option value="">Choose the original sale</option>
          {eligible.map((s) => (
            <option key={s.saleId} value={s.saleId}>
              {s.reference} · {s.customer} · {s.currency}
            </option>
          ))}
        </select>
      </label>
      {!s ? (
        <p>No remaining eligible sale is selected for this batch.</p>
      ) : (
        <>
          <input
            type="hidden"
            name="expectedReturnPosition"
            value={s.expectedPosition}
          />
          <p>
            Original grade: {s.grade}. Remaining tray-priced eggs:{" "}
            {s.remainingTrayEggs}; individually priced eggs:{" "}
            {s.remainingLooseEggs}. Credit uses the saved prices and currency,
            with cumulative half-up rounding to four decimal places for eggs
            from trays.
          </p>
          {s.remainingTrayEggs > 0 ? (
            <label className="field">
              <span>Returned tray-priced eggs</span>
              <input
                name="trayEggs"
                type="number"
                required
                min="0"
                max={s.remainingTrayEggs}
                step="1"
                value={tray}
                onChange={(e) => setTray(e.target.value)}
              />
            </label>
          ) : (
            <input type="hidden" name="trayEggs" value="0" />
          )}
          {s.remainingLooseEggs > 0 ? (
            <label className="field">
              <span>Returned individually priced eggs</span>
              <input
                name="looseEggs"
                type="number"
                required
                min="0"
                max={s.remainingLooseEggs}
                step="1"
                value={loose}
                onChange={(e) => setLoose(e.target.value)}
              />
            </label>
          ) : (
            <input type="hidden" name="looseEggs" value="0" />
          )}
          <label className="field">
            <span>Saleable eggs to restock</span>
            <input
              name="restockEggs"
              type="number"
              required
              min="0"
              max="100000000"
              step="1"
              value={restock}
              onChange={(e) => setRestock(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Egg return reference</span>
            <input
              name="returnReference"
              required
              minLength={3}
              maxLength={100}
            />
          </label>
          <p className="egg-quote" role="status">
            {quote}
          </p>
          <label className="egg-confirm">
            <input type="checkbox" required /> I confirmed the goods returned
            and inspected their saleable condition.
          </label>
        </>
      )}
    </>
  );
}
