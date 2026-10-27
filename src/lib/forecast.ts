import Decimal from "decimal.js";
export type FeedWeek = { ration: number; price: number; mortality: number };
export function feedForecast(opening: number, weeks: FeedWeek[]) {
  if (!Number.isFinite(opening) || opening < 0 || !weeks.length)
    throw Error("A starting population and ration schedule are required.");
  let birds = new Decimal(opening),
    feedTotal = new Decimal(0),
    costTotal = new Decimal(0);
  const rows = weeks.map((w, i) => {
    if (
      ![w.ration, w.price, w.mortality].every(Number.isFinite) ||
      w.ration < 0 ||
      w.price < 0 ||
      w.mortality < 0 ||
      w.mortality > 1
    )
      throw Error("Invalid feed assumptions.");
    const feed = birds.mul(w.ration).mul(7).div(1000),
      cost = feed.mul(w.price),
      deaths = birds.mul(w.mortality),
      closing = birds.minus(deaths);
    const row = {
      week: i + 1,
      opening: birds.toNumber(),
      ration: w.ration,
      feedKg: feed.toNumber(),
      price: w.price,
      cost: cost.toFixed(4),
      mortality: w.mortality,
      deaths: deaths.toNumber(),
      closing: closing.toNumber(),
    };
    birds = closing;
    feedTotal = feedTotal.plus(feed);
    costTotal = costTotal.plus(cost);
    return row;
  });
  return {
    modelVersion: "opening-stock-weekly-v1",
    rows,
    feedKg: feedTotal.toNumber(),
    cost: costTotal.toFixed(2),
    closing: birds.toNumber(),
    deaths: new Decimal(opening).minus(birds).toNumber(),
  };
}
export const workbookWeeks: FeedWeek[] = Array.from({ length: 24 }, (_, i) => ({
  ration: Math.min(10 + i * 5, 115),
  price: i < 8 ? 288 : i < 18 ? 260 : 290,
  mortality: i < 8 ? 0.005 : 0.001,
}));
export type EggPeriod = { lay: number; mortality: number; cracks: number };
export function eggForecast(
  opening: number,
  startMonth: string,
  periods: EggPeriod[],
  traySize: number,
  legacy28 = false,
) {
  if (
    !Number.isFinite(opening) ||
    opening < 0 ||
    !/^\d{4}-\d{2}$/.test(startMonth) ||
    !Number.isInteger(traySize) ||
    traySize < 1 ||
    !periods.length
  )
    throw Error("Invalid egg forecast parameters.");
  const [y, m] = startMonth.split("-").map(Number);
  if (m < 1 || m > 12 || y < 1900 || y > 2200)
    throw Error("Invalid calendar month.");
  let birds = new Decimal(opening),
    eggs = new Decimal(0),
    saleable = new Decimal(0),
    cracked = new Decimal(0);
  const rows = periods.map((p, i) => {
    if (
      ![p.lay, p.mortality, p.cracks].every(
        (n) => Number.isFinite(n) && n >= 0 && n <= 1,
      )
    )
      throw Error("Rates must be fractions between zero and one.");
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const days = legacy28
      ? 28
      : new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
        ).getUTCDate();
    const gross = birds.mul(p.lay).mul(days),
      broken = gross.mul(p.cracks),
      normal = gross.minus(broken),
      deaths = birds.mul(p.mortality),
      closing = birds.minus(deaths);
    const row = {
      period: i + 1,
      month: d.toISOString().slice(0, 7),
      days,
      opening: birds.toNumber(),
      lay: p.lay,
      gross: gross.toNumber(),
      cracked: broken.toNumber(),
      saleable: normal.toNumber(),
      trays: normal.div(traySize).toNumber(),
      deaths: deaths.toNumber(),
      closing: closing.toNumber(),
    };
    birds = closing;
    eggs = eggs.plus(gross);
    saleable = saleable.plus(normal);
    cracked = cracked.plus(broken);
    return row;
  });
  return {
    modelVersion: legacy28
      ? "opening-stock-28day-v1"
      : "opening-stock-calendar-v1",
    rows,
    eggs: eggs.toNumber(),
    saleable: saleable.toNumber(),
    cracked: cracked.toNumber(),
    trays: saleable.div(traySize).toNumber(),
    closing: birds.toNumber(),
  };
}
export const workbookEggPeriods: EggPeriod[] = Array.from(
  { length: 18 },
  (_, i) => ({
    lay: i === 0 ? 0.45 : i === 17 ? 0.75 : 0.8,
    mortality: 0.005,
    cracks: i === 17 ? 0.01 : 0.005,
  }),
);
export function biomass(count: number, grams: number) {
  if (![count, grams].every((n) => Number.isFinite(n) && n >= 0))
    throw Error("Population and weight must be nonnegative.");
  return new Decimal(count).mul(grams).div(1000).toNumber();
}
export function fishFeed(count: number, grams: number, ratePercent: number) {
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100)
    throw Error("Invalid feed rate.");
  return new Decimal(biomass(count, grams))
    .mul(ratePercent)
    .div(100)
    .toNumber();
}
export function specificGrowthRate(
  initial: number,
  final: number,
  days: number,
) {
  if (![initial, final, days].every((n) => Number.isFinite(n) && n > 0))
    throw Error("Positive weights and duration are required.");
  return (100 * (Math.log(final) - Math.log(initial))) / days;
}
export function fcr(feedKg: number, gainKg: number) {
  if (
    !Number.isFinite(feedKg) ||
    feedKg < 0 ||
    !Number.isFinite(gainKg) ||
    gainKg <= 0
  )
    throw Error("Positive biomass gain is required.");
  return new Decimal(feedKg).div(gainKg).toNumber();
}
