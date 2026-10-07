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
  return calcBudgetWithReserve(watts, soc, RESERVE * 100);
}
export function usableEnergy(soc, reservePercent = 8) {
  if (soc == null || !Number.isFinite(Number(soc))) return null;
  const reserve = Math.max(0, Math.min(30, Number(reservePercent) || 0));
  return (
    calcEnergy(Math.max(0, Math.min(100, Number(soc)) - reserve)) * EFFICIENCY
  );
}
export function calcBudgetWithReserve(watts, soc, reservePercent = 8) {
  const energy = usableEnergy(soc, reservePercent);
  if (energy == null) return null;
  if (energy === 0) return 0;
  return Number(watts) > 0 ? (energy / Number(watts)) * 60 : null;
}
export function chargeEstimate(soc, input, output = 0) {
  if (soc == null || input == null || output == null) return null;
  const net = Number(input) * EFFICIENCY - Number(output);
  return net > 10 ? (calcEnergy(100 - Number(soc)) / net) * 60 : null;
}
export function emptyState() {
  return Object.fromEntries(
    [
      "soc",
      "temp",
      "remain",
      "chargingRemain",
      "input",
      "output",
      "acInput",
      "dcInput",
      "ac",
      "usb",
      "dc",
      "frequency",
      "voltage",
      "chargeLimit",
      "inverter",
      "bms",
      "updated",
      "reportedAt",
    ].map((key) => [key, null]),
  );
}
export function normalizeOnline(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return ["1", "true", "online"].includes(v)
    ? true
    : ["0", "false", "offline"].includes(v)
      ? false
      : null;
}
export function reportedTime(payload, now = Date.now()) {
  const attrs =
    payload?.data?.customizeTslInfo || payload?.customizeTslInfo || [];
  const data = payload?.data || payload || {};
  const parse = (value) => {
    if (value == null || value === "") return null;
    let t = /^\d+(\.\d+)?$/.test(String(value))
      ? Number(value)
      : Date.parse(value);
    if (t < 1e11) t *= 1000;
    return Number.isFinite(t) && t >= 1577836800000 && t <= now + 60000
      ? t
      : null;
  };
  // Never substitute HTTP receipt time for a device measurement timestamp.
  const times = attrs
    .filter((x) => [1, 4, 5].includes(Number(x.abId)))
    .map((x) => parse(x.updateTime ?? x.timestamp ?? x.resourceUpdateTime))
    .filter((x) => x != null);
  return times.length
    ? Math.min(...times)
    : parse(data.updateTime ?? data.timestamp ?? data.reportedAt);
}
export function connectionState({
  mode,
  device,
  online,
  phase,
  updated,
  reportedAt,
  now = Date.now(),
}) {
  if (mode !== "cloud") return "demo";
  if (phase === "auth-required") return phase;
  if (!device) return "select-device";
  if (phase === "error") return "cloud-error";
  if (phase === "phone-offline") return phase;
  if (phase === "connecting" && !updated) return phase;
  if (online === false) return "offline";
  if (reportedAt && now - Number(reportedAt) > 12 * 60000) return "stale";
  if (!updated) return "waiting";
  if (now - new Date(updated).getTime() > 2 * 60000) return "stale";
  return online === true ? "online" : "unknown";
}

// Integrates the output curve instead of assuming that a device draws its
// nameplate power constantly. Gaps above the sampling window are deliberately
// ignored: inventing consumption during a cloud outage would distort a forecast.
export function energyFromSamples(entries, maxGapMs = 12 * 60 * 1000) {
  const sorted = [...(Array.isArray(entries) ? entries : [])]
    .filter(
      (entry) =>
        entry?.at != null &&
        entry?.output != null &&
        Number.isFinite(Number(entry?.at)) &&
        Number.isFinite(Number(entry?.output)) &&
        Number(entry.output) >= 0,
    )
    .sort((a, b) => Number(a.at) - Number(b.at));
  const samples = [...new Map(sorted.map((x) => [Number(x.at), x])).values()];
  let wh = 0,
    coveredMs = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1],
      current = samples[index],
      gap = Number(current.at) - Number(previous.at);
    if (gap <= 0 || gap > maxGapMs) continue;
    wh +=
      ((Number(previous.output) + Number(current.output)) / 2) * (gap / 36e5);
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
  const { wh, coveredMs, samples } = energyFromSamples(
    (entries || []).filter((x) => x.at >= now - 24 * 36e5 && x.at <= now),
  );
  const measuredWatts = coveredMs ? wh / (coveredMs / 36e5) : 0;
  const span =
    samples.length > 1 ? Number(samples.at(-1).at) - Number(samples[0].at) : 0;
  const coverage = span > 0 ? Math.min(1, coveredMs / span) : 0;
  const hourly = new Map();
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i],
      gap = b.at - a.at;
    if (gap <= 0 || gap > 12 * 60000) continue;
    // Split intervals at hour boundaries so short compressor pauses aren't
    // interpreted as the consumption of an entire future discharge.
    for (let at = a.at; at < b.at; ) {
      const end = Math.min(b.at, (Math.floor(at / 36e5) + 1) * 36e5);
      const key = Math.floor(at / 36e5),
        bucket = hourly.get(key) || { wh: 0, ms: 0 };
      const value = (Number(a.output) + Number(b.output)) / 2;
      bucket.wh += (value * (end - at)) / 36e5;
      bucket.ms += end - at;
      hourly.set(key, bucket);
      at = end;
    }
  }
  const averages = [...hourly.values()]
    .filter((x) => x.ms >= 45 * 60000)
    .map((x) => x.wh / (x.ms / 36e5));
  const deviation =
    averages.length > 1
      ? Math.sqrt(
          averages.reduce((s, x) => s + (x - measuredWatts) ** 2, 0) /
            averages.length,
        )
      : measuredWatts * 0.3;
  const recentAt = samples.at(-1)?.at || 0,
    fresh = now - Number(recentAt) <= 12 * 60 * 1000,
    enough =
      samples.length >= 12 &&
      coveredMs >= 55 * 60 * 1000 &&
      fresh &&
      coverage >= 0.8,
    watts = enough ? measuredWatts : Number(fallbackWatts) || 0,
    margin = Math.min(
      0.5,
      Math.max(0.15, measuredWatts ? deviation / measuredWatts : 0.3),
    ),
    lowWatts = enough ? measuredWatts * (1 - margin) : watts,
    highWatts = enough ? measuredWatts * (1 + margin) : watts,
    confidence = !enough
      ? "low"
      : coveredMs >= 18 * 36e5 &&
          coverage >= 0.95 &&
          averages.length >= 16 &&
          margin < 0.3
        ? "high"
        : "medium";
  return {
    watts,
    measuredWatts,
    energyWh: wh,
    coveredMs,
    coverage,
    windowHours: 24,
    rangeKind: "heuristic",
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
      detail: `Вхід перевищує вихід на ${net} Вт; втрати не враховані`,
    };
  if (net < -10)
    return {
      kind: "discharging",
      net,
      title: "Станція живить прилади",
      detail: `Вихід перевищує вхід на ${Math.abs(net)} Вт; втрати не враховані`,
    };
  return {
    kind: "idle",
    net: 0,
    title: "Станція готова",
    detail: "Баланс близький до нуля",
  };
}
export function freshLabel(updated, now = Date.now()) {
  if (!updated || !Number.isFinite(new Date(updated).getTime()))
    return "ще не отримано";
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
  const number = (id) =>
    byId[id] == null || byId[id] === "" ? null : Number(byId[id]);
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
      out[key] =
        key === "soc" && (number(id) < 0 || number(id) > 100)
          ? null
          : number(id);
  if ([0, 1, 50, 60].includes(number("27")))
    out.frequency = [1, 60].includes(number("27")) ? 60 : 50;
  for (const [id, key] of Object.entries({ 43: "ac", 44: "usb", 46: "dc" }))
    if (byId[id] != null) out[key] = normalizeOnline(byId[id]);
  return out;
}
