import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveForecast,
  calcBudget,
  calcBudgetWithReserve,
  calcEnergy,
  flowSummary,
  fmtMin,
  historyStats,
  mapAttrs,
} from "../public/core.mjs";
import worker, { md5hexCorrect } from "../worker.js";

test("formatting and energy budget are bounded", () => {
  assert.equal(fmtMin(65), "1 год 5 хв");
  assert.equal(calcEnergy(110), 2048);
  assert.equal(Math.round(calcBudget(350, 89)), 253);
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
    detail: "+320 W у батарею",
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
