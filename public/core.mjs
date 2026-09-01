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
