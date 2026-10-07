import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveForecast,
  calcBudget,
  calcBudgetWithReserve,
  calcEnergy,
  currentCharge,
  flowSummary,
  fmtMin,
  historyStats,
  mapAttrs,
  chargeEstimate,
  connectionState,
  normalizeOnline,
  reportedTime,
  emptyState,
  energyFromSamples,
} from "../public/core.mjs";
import worker, { md5hexCorrect } from "../worker.js";

test("formatting and energy budget are bounded", () => {
  assert.equal(fmtMin(65), "1 год 5 хв");
  assert.equal(calcEnergy(110), 2048);
  assert.equal(Math.round(calcBudget(350, 89)), 250);
});
test("unconfirmed cached charge is not current SOC or usable energy", () => {
  for (const available of [false, null, undefined]) {
    const soc = currentCharge(89, { mode: "cloud", available });
    assert.equal(soc, null);
    assert.equal(calcBudgetWithReserve(100, soc, 8), null);
  }
  assert.equal(currentCharge(100, { mode: "cloud", available: true }), 100);
  assert.equal(currentCharge(0, { mode: "cloud", available: true }), 0);
  assert.equal(currentCharge(null, { mode: "cloud", available: true }), null);
  assert.equal(currentCharge(101, { mode: "cloud", available: true }), null);
  assert.equal(currentCharge(89, { mode: "demo", available: false }), 89);
});
test("a power timestamp cannot masquerade as a battery timestamp", () => {
  const now = Date.now();
  const payload = {
    data: {
      customizeTslInfo: [
        { abId: 1, resourceValce: 89 },
        { abId: 5, resourceValce: 50, updateTime: now },
      ],
    },
  };
  assert.equal(reportedTime(payload, now), now);
  assert.equal(reportedTime(payload, now, [1]), null);
});
test("Quectel attributes map to P2001E Plus dashboard values", () => {
  const state = mapAttrs(
    {
      data: {
        customizeTslInfo: [
          { abId: 1, resourceValce: "72" },
          { abId: 4, resourceValce: "321" },
          { abId: 14, resourceValce: "26" },
          { abId: 27, resourceValce: "1" },
          { abId: 43, resourceValce: "true" },
          { abId: 44, resourceValce: "false" },
        ],
      },
    },
    {},
  );
  assert.deepEqual(state, {
    soc: 72,
    input: 321,
    temp: 26,
    frequency: 60,
    ac: true,
    usb: false,
  });
});
test("Wonderfree-compatible MD5 derivation is correct", () => {
  assert.equal(md5hexCorrect("abc"), "900150983cd24fb0d6963f7d28e17f72");
});
test("planner reserve and flow state remain understandable", () => {
  assert.ok(
    calcBudgetWithReserve(100, 50, 20) < calcBudgetWithReserve(100, 50, 5),
  );
  assert.deepEqual(flowSummary(400, 80), {
    kind: "charging",
    net: 320,
    title: "Станція заряджається",
    detail: "Вхід перевищує вихід на 320 Вт; втрати не враховані",
  });
  assert.equal(
    historyStats([
      { soc: 80, input: 50, output: 10 },
      { soc: 75, input: 100, output: 300 },
    ]).socChange,
    -5,
  );
});

test("telemetry preserves false output states and chart statistics handle empty data", () => {
  const state = mapAttrs(
    {
      data: {
        customizeTslInfo: [
          { abId: 43, resourceValce: "0" },
          { abId: 44, resourceValce: 1 },
          { abId: 46, resourceValce: "false" },
        ],
      },
    },
    { ac: true, usb: false, dc: true },
  );
  assert.deepEqual(state, { ac: false, usb: true, dc: false });
  assert.deepEqual(historyStats([]), {
    peakInput: 0,
    peakOutput: 0,
    socChange: null,
  });
});

test("adaptive forecast learns refrigerator duty cycles instead of nameplate watts", () => {
  const start = 1_700_000_000_000;
  const samples = Array.from({ length: 25 }, (_, index) => ({
    at: start + index * 5 * 60 * 1000,
    input: 0,
    output: index % 2 ? 100 : 0,
    soc: 80,
  }));
  const forecast = adaptiveForecast(samples, 80, 8, 100, samples.at(-1).at);
  assert.equal(forecast.source, "measured");
  assert.equal(Math.round(forecast.measuredWatts), 50);
  assert.ok(forecast.minutes > calcBudgetWithReserve(100, 80, 8) * 1.9);
  assert.equal(forecast.confidence, "medium");
  assert.ok(forecast.optimisticMinutes < forecast.minutes * 2);
  assert.ok(forecast.conservativeMinutes <= forecast.minutes);
});

test("reserve is an absolute SOC floor; zero reserve remains zero", () => {
  assert.equal(calcBudgetWithReserve(100, 5, 8), 0);
  assert.equal(calcBudgetWithReserve(100, 8, 8), 0);
  assert.equal(calcBudgetWithReserve(100, null, 8), null);
  assert.equal(calcBudgetWithReserve(0, 80, 8), null);
  assert.equal(
    calcBudgetWithReserve(100, 50, 0),
    ((2048 * 0.5 * 0.88) / 100) * 60,
  );
});
test("charge estimate converts percent and accounts for simultaneous load", () => {
  assert.ok(chargeEstimate(50, 1000, 0) < 80);
  assert.ok(chargeEstimate(50, 1000, 200) > chargeEstimate(50, 1000, 0));
  assert.equal(chargeEstimate(50, 100, 200), null);
  assert.equal(chargeEstimate(null, 1000, 0), null);
});
test("availability separates unknown, confirmed offline, expired auth and errors", () => {
  const now = Date.now(),
    base = {
      mode: "cloud",
      device: {},
      online: null,
      phase: "ready",
      updated: now,
      now,
    };
  assert.equal(normalizeOnline("true"), true);
  assert.equal(normalizeOnline("FALSE"), false);
  assert.equal(normalizeOnline(undefined), null);
  assert.equal(normalizeOnline(2), null);
  assert.equal(connectionState(base), "unknown");
  assert.equal(connectionState({ ...base, online: false }), "offline");
  assert.equal(connectionState({ ...base, online: true }), "online");
  assert.equal(
    connectionState({ ...base, online: true, phase: "auth-required" }),
    "auth-required",
  );
  assert.equal(
    connectionState({ ...base, online: true, phase: "error" }),
    "cloud-error",
  );
  assert.equal(
    connectionState({ ...base, online: true, reportedAt: now - 3600000 }),
    "stale",
  );
  assert.equal(
    connectionState({ ...base, phase: "phone-offline" }),
    "phone-offline",
  );
});
test("missing attributes never synthesize measurements or port OFF states", () => {
  const s = mapAttrs(
    { data: { customizeTslInfo: [{ abId: 1, resourceValce: 73 }] } },
    emptyState(),
  );
  assert.equal(s.soc, 73);
  assert.equal(s.output, null);
  assert.equal(s.ac, null);
  assert.equal(reportedTime({ data: { customizeTslInfo: [] } }), null);
  assert.equal(
    mapAttrs(
      { customizeTslInfo: [{ abId: 1, resourceValce: 200 }] },
      emptyState(),
    ).soc,
    null,
  );
});
test("gaps, duplicate timestamps and old load profiles do not inflate coverage", () => {
  const now = Date.now(),
    data = [
      { at: now - 36e5, output: 100 },
      { at: now - 36e5, output: 50 },
      { at: now, output: 0 },
    ];
  assert.equal(energyFromSamples(data).coveredMs, 0);
  assert.equal(adaptiveForecast(data, 80, 8, 100, now).source, "plan");
  const recent = Array.from({ length: 25 }, (_, i) => ({
    at: now - (24 - i) * 300000,
    output: 50,
  }));
  const forecast = adaptiveForecast(
    [{ at: now - 3 * 864e5, output: 2400 }, ...recent],
    80,
    8,
    100,
    now,
  );
  assert.ok(Math.abs(forecast.measuredWatts - 50) < 1e-6);
  assert.equal(forecast.samples, 25);
});

test("worker health response has strict browser security headers", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/health"),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
});

test("worker applies security headers to static assets and rejects static writes", async () => {
  const env = {
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>OUKITEL Home</title>", {
          headers: { "content-type": "text/html" },
        }),
    },
  };
  const staticResponse = await worker.fetch(
    new Request("https://example.test/"),
    env,
  );
  assert.equal(staticResponse.status, 200);
  assert.equal(staticResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    staticResponse.headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  const writeResponse = await worker.fetch(
    new Request("https://example.test/", { method: "POST" }),
    env,
  );
  assert.equal(writeResponse.status, 405);
});
