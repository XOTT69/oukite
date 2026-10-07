import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });

const device = {
  productKey: "p11wN7",
  deviceKey: "fixture_station",
  productName: "P2001E Plus",
  online: true,
};
const accountId = "a".repeat(64);
async function setup(
  page,
  { online = true, stateError = null, attributes = null, cached = false } = {},
) {
  const now = Date.now();
  await page.addInitScript(
    ({ device, accountId, now, cached }) => {
      localStorage.setItem(
        "oukitel_ui",
        JSON.stringify({
          mode: "cloud",
          accountId,
          device,
          reserve: 8,
          loads: [],
          alerts: { enabled: false },
        }),
      );
      if (cached)
        localStorage.setItem(
          "oukitel_data:" +
            accountId +
            ":" +
            device.productKey +
            ":" +
            device.deviceKey,
          JSON.stringify({
            snapshot: { soc: 61, input: 0, output: 40, updated: now - 3600000 },
            history: [],
          }),
        );
    },
    { device, accountId, now, cached },
  );
  let stateCalls = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/devices")
      return route.fulfill({
        json: { accountId, devices: [{ ...device, online }] },
      });
    if (path === "/api/state") {
      stateCalls++;
      if (stateError)
        return route.fulfill({
          status: stateError,
          json: {
            error:
              stateError === 401 ? "Сесія завершилась" : "Хмара недоступна",
          },
        });
      return route.fulfill({
        json: {
          data: {
            customizeTslInfo: attributes ?? [
              { abId: 1, resourceValce: 73 },
              { abId: 4, resourceValce: 0 },
              { abId: 5, resourceValce: 50 },
              { abId: 43, resourceValce: true },
            ],
          },
          connection: { online, receivedAt: Date.now(), reportedAt: null },
        },
      });
    }
    return route.fulfill({
      json: { monitor: { enabled: false, state: "disabled" }, samples: [] },
    });
  });
  await page.goto("/");
  return () => stateCalls;
}
test("unknown availability still fetches telemetry and never says offline", async ({
  page,
}) => {
  const calls = await setup(page, { online: null });
  await expect(page.locator("#soc")).toHaveText("73%");
  await expect(page.locator("#statusText")).toHaveText("Статус невідомий");
  expect(calls()).toBe(1);
  await expect(page.locator("#readyHours")).toHaveText("—");
});
test("confirmed online and offline are distinct", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#statusText")).toHaveText("Станція онлайн");
  await expect(page.locator("#soc")).toHaveText("73%");
  await expect(page.locator("#readyHours")).not.toHaveText("—");
  await page.screenshot({
    path: "artifacts/home-" + test.info().project.name + ".png",
    fullPage: false,
  });
  await page.route("**/api/state?**", (route) =>
    route.fulfill({
      json: {
        data: { customizeTslInfo: [{ abId: 1, resourceValce: 73 }] },
        connection: { online: false, receivedAt: Date.now(), reportedAt: null },
      },
    }),
  );
  await page.locator("#refreshBtn").click();
  await expect(page.locator("#statusText")).toHaveText("Станція офлайн");
  await expect(page.locator("#readyHours")).toHaveText("—");
});
test("expired auth prompts login without inventing battery data", async ({
  page,
}) => {
  await setup(page, { stateError: 401 });
  await expect(page.locator("#statusText")).toHaveText("Потрібен вхід");
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#connectBtn")).toBeVisible();
});
test("cloud failure preserves only a real scoped snapshot", async ({
  page,
}) => {
  await setup(page, { stateError: 502, cached: true });
  await expect(page.locator("#statusText")).toHaveText("Помилка хмари");
  await expect(page.locator("#soc")).toHaveText("61%");
  await expect(page.locator("#readyHours")).toHaveText("—");
  await page.reload();
  await expect(page.locator("#soc")).toHaveText("61%");
});
test("partial telemetry leaves unknown outputs and ports blank", async ({
  page,
}) => {
  await setup(page, { attributes: [{ abId: 1, resourceValce: 73 }] });
  await expect(page.locator("#soc")).toHaveText("73%");
  await expect(page.locator("#outputW")).toHaveText("—");
  await expect(page.locator("#usbState")).toHaveText("Невідомо");
});
test("plan editing, zero reserve and load toggle affect what-if duration", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("#soc")).toHaveText("73%");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "План", exact: true })
    .click();
  await page.locator('[data-preset="3"]').click();
  await expect(page.locator("#plannedWatts")).toHaveText("100 Вт");
  const before = await page.locator("#budgetTime").textContent();
  await page.locator("[data-edit-load]").click();
  await page.locator("#editLoadAverage").fill("50");
  await page.getByRole("button", { name: "Зберегти прилад" }).click();
  await expect(page.locator("#plannedWatts")).toHaveText("50 Вт");
  expect(await page.locator("#budgetTime").textContent()).not.toBe(before);
  await page.locator("#reserveInput").fill("0");
  await expect(page.locator("#reserveLabel")).toHaveText("0%");
  await page
    .getByRole("checkbox", { name: "Враховувати Холодильник у плані" })
    .uncheck();
  await expect(page.locator("#plannedWatts")).toHaveText("0 Вт");
  await expect(page.locator("#budgetTime")).toHaveText("Додайте прилад");
});
test("all screens fit narrow mobile widths and expose working help", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  for (const name of ["Зараз", "План", "Історія", "Виходи"]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator(".switch")).toHaveCount(0);
  await page.getByRole("button", { name: "Пояснити", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog [data-close]").click();
  await page.locator("#settingsBtn").click();
  await expect(
    page.getByRole("checkbox", { name: "Фоновий збір споживання" }),
  ).toBeVisible();
  await page.locator("#textSizeSelect").selectOption("large");
  await page.locator("#saveBtn").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "artifacts/mobile-" + test.info().project.name + ".png",
    fullPage: true,
  });
});
test.describe("PWA cache", () => {
  test.use({ serviceWorkers: "allow" });
  test("offline PWA handles navigation query strings without fake LIVE", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName === "webkit",
      "Playwright WebKit offline navigation aborts before service worker dispatch; validate on a physical iPhone.",
    );
    await page.goto("/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    // WebKit's offline emulation aborts navigation before dispatching the SW.
    // Abort network requests there; Chromium also exercises actual offline mode.
    await context.setOffline(true);
    await page.goto("/?v=2");
    await expect(page.locator("#statusText")).toHaveText("Демо");
    await expect(page.locator("#connectBtn")).toBeVisible();
  });
});
