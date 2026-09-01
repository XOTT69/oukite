import assert from "node:assert/strict";
import test from "node:test";
import {calcBudget, calcBudgetWithReserve, calcEnergy, flowSummary, fmtMin, historyStats, mapAttrs} from "../public/core.mjs";
import {md5hexCorrect} from "../worker.js";

test("formatting and energy budget are bounded", () => {
  assert.equal(fmtMin(65), "1 год 5 хв");
  assert.equal(calcEnergy(110), 2048);
  assert.equal(Math.round(calcBudget(350, 89)), 253);
});
test("Quectel attributes map to P2001E Plus dashboard values", () => {
  const state = mapAttrs({data:{customizeTslInfo:[
    {abId:1,resourceValce:"72"}, {abId:4,resourceValce:"321"}, {abId:14,resourceValce:"26"},
    {abId:27,resourceValce:"1"}, {abId:43,resourceValce:"true"}, {abId:44,resourceValce:"false"}
  ]}}, {});
  assert.deepEqual(state, {soc:72,input:321,temp:26,frequency:60,ac:true,usb:false});
});
test("Wonderfree-compatible MD5 derivation is correct", () => {
  assert.equal(md5hexCorrect("abc"), "900150983cd24fb0d6963f7d28e17f72");
});
test("planner reserve and flow state remain understandable", () => {
  assert.ok(calcBudgetWithReserve(100, 50, 20) < calcBudgetWithReserve(100, 50, 5));
  assert.deepEqual(flowSummary(400, 80), {kind:"charging",net:320,title:"Станція заряджається",detail:"+320 W у батарею"});
  assert.equal(historyStats([{soc:80,input:50,output:10},{soc:75,input:100,output:300}]).socChange, -5);
});
