export const CAPACITY_WH = 2048;
export const RESERVE = 0.08;
export const EFFICIENCY = 0.88;

export function fmtMin(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const min = Math.max(0, Math.round(Number(value)));
  const days = Math.floor(min / 1440),
    hours = Math.floor((min % 1440) / 60),
    minutes = min % 60;
  if (days) return `${days} д ${hours} год`;
  if (hours) return `${hours} год ${minutes} хв`;
  return `${minutes} хв`;
}
export function calcEnergy(soc) {
  return (CAPACITY_WH * Math.max(0, Math.min(100, Number(soc) || 0))) / 100;
}
export function calcBudget(watts, soc) {
  return (
    ((calcEnergy(soc) * (1 - RESERVE) * EFFICIENCY) /
      Math.max(1, Number(watts) || 1)) *
    60
  );
}
export function calcBudgetWithReserve(watts, soc, reservePercent = 8) {
  return (
    ((calcEnergy(soc) *
      (1 - Math.max(0, Math.min(30, reservePercent)) / 100) *
      EFFICIENCY) /
      Math.max(1, Number(watts) || 1)) *
    60
  );
}

// Integrates the output curve instead of assuming that a device draws its
// nameplate power constantly. Gaps above the sampling window are deliberately
// ignored: inventing consumption during a cloud outage would distort a forecast.
export function energyFromSamples(entries, maxGapMs = 12 * 60 * 1000) {
  const samples = [...(Array.isArray(entries) ? entries : [])]
    .filter(
      (entry) =>
        Number.isFinite(Number(entry?.at)) &&
        Number.isFinite(Number(entry?.output)) &&
        Number(entry.output) >= 0,
    )
    .sort((a, b) => Number(a.at) - Number(b.at));
  let wh = 0,
    coveredMs = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1],
      current = samples[index],
      gap = Number(current.at) - Number(previous.at);
    if (gap <= 0 || gap > maxGapMs) continue;
    wh += ((Number(previous.output) + Number(current.output)) / 2) * (gap / 36e5);
    coveredMs += gap;
  }
  return { wh, coveredMs, samples };
}

export function adaptiveForecast(
  entries,
  soc,
  reservePercent = 8,
  fallbackWatts = 0,
  now = Date.now(),
) {
  const { wh, coveredMs, samples } = energyFromSamples(entries);
  const measuredWatts = coveredMs ? wh / (coveredMs / 36e5) : 0;
  const outputs = samples.map((entry) => Number(entry.output));
  const quantile = (ratio) => {
    if (!outputs.length) return 0;
    const sorted = [...outputs].sort((a, b) => a - b),
      position = (sorted.length - 1) * ratio,
      lower = Math.floor(position),
      upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  const recentAt = samples.at(-1)?.at || 0,
    fresh = now - Number(recentAt) <= 12 * 60 * 1000,
    enough = samples.length >= 12 && coveredMs >= 55 * 60 * 1000 && fresh,
    watts = enough && measuredWatts >= 1 ? measuredWatts : Number(fallbackWatts) || 0,
    lowWatts = Math.max(1, enough ? Math.min(measuredWatts, quantile(0.25)) : watts),
    highWatts = Math.max(1, enough ? Math.max(measuredWatts, quantile(0.9)) : watts),
    confidence = !enough
      ? "low"
      : coveredMs >= 18 * 36e5 && samples.length >= 180
        ? "high"
        : "medium";
  return {
    watts,
    measuredWatts,
    energyWh: wh,
    coveredMs,
    samples: samples.length,
    fresh,
    confidence,
    source: enough ? "measured" : "plan",
    minutes: watts ? calcBudgetWithReserve(watts, soc, reservePercent) : null,
    conservativeMinutes: watts
      ? calcBudgetWithReserve(highWatts, soc, reservePercent)
      : null,
    optimisticMinutes: watts
      ? calcBudgetWithReserve(lowWatts, soc, reservePercent)
      : null,
  };
}
export function flowSummary(input, output) {
  const net = Math.round((Number(input) || 0) - (Number(output) || 0));
  if (net > 10)
    return {
      kind: "charging",
      net,
      title: "Станція заряджається",
      detail: `+${net} W у батарею`,
    };
  if (net < -10)
    return {
      kind: "discharging",
      net,
      title: "Станція живить прилади",
      detail: `${Math.abs(net)} W з батареї`,
    };
  return {
    kind: "idle",
    net: 0,
    title: "Станція готова",
    detail: "Баланс близький до нуля",
  };
}
export function freshLabel(updated, now = Date.now()) {
  const min = Math.max(
    0,
    Math.floor((now - new Date(updated).getTime()) / 60000),
  );
  return min < 1 ? "щойно" : min === 1 ? "1 хв тому" : `${min} хв тому`;
}
export function historyStats(entries) {
  if (!entries.length) return { peakInput: 0, peakOutput: 0, socChange: null };
  return {
    peakInput: Math.max(...entries.map((x) => x.input || 0)),
    peakOutput: Math.max(...entries.map((x) => x.output || 0)),
    socChange: (entries.at(-1).soc ?? 0) - (entries[0].soc ?? 0),
  };
}
export function mapAttrs(payload, previous) {
  const out = { ...previous };
  const attrs =
    payload?.data?.customizeTslInfo || payload?.customizeTslInfo || [];
  const byId = Object.fromEntries(
    attrs.map((item) => [String(item.abId), item.resourceValce]),
  );
  const number = (id) => (byId[id] == null ? null : Number(byId[id]));
  const bool = (id) => [true, 1, "1", "true"].includes(byId[id]);
  const scalar = {
    1: "soc",
    2: "remain",
    3: "chargingRemain",
    4: "input",
    5: "output",
    11: "acInput",
    12: "dcInput",
    14: "temp",
    20: "chargeLimit",
    28: "voltage",
    31: "inverter",
    34: "bms",
  };
  for (const [id, key] of Object.entries(scalar))
    if (number(id) != null && Number.isFinite(number(id)))
      out[key] = number(id);
  if (number("27") != null) out.frequency = number("27") === 1 ? 60 : 50;
  for (const [id, key] of Object.entries({ 43: "ac", 44: "usb", 46: "dc" }))
    if (byId[id] != null) out[key] = bool(id);
  return out;
}
