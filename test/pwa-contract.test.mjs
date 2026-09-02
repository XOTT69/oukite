import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);

test("PWA shell keeps its iPhone viewport and SVG icon contract", () => {
  assert.match(html, /maximum-scale=1/);
  assert.match(html, /user-scalable=no/);
  for (const icon of [
    "i-home",
    "i-plan",
    "i-history",
    "i-settings",
    "i-ac",
    "i-usb",
    "i-dc",
  ]) {
    assert.match(html, new RegExp('id="' + icon + '"'));
  }
});

test("PWA shell exposes the four primary screens and accessible navigation", () => {
  for (const id of [
    "homeScreen",
    "planScreen",
    "historyScreen",
    "outputsScreen",
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /<nav class="bottom-nav" aria-label="Навігація">/);
  assert.match(html, /aria-label="Налаштування"/);
});
