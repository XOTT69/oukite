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
  { online = true, stateError = null, attributes = null, cached = false, historySamples = [], timestamp = true } = {},
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
  let monitorEnabled = false;
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
              { abId: 1, resourceValce: 73, ...(timestamp ? { updateTime: Date.now() } : {}) },
              { abId: 4, resourceValce: 0, ...(timestamp ? { updateTime: Date.now() } : {}) },
              { abId: 5, resourceValce: 50, ...(timestamp ? { updateTime: Date.now() } : {}) },
              { abId: 43, resourceValce: true },
            ],
          },
          connection: { online, receivedAt: Date.now(), reportedAt: attributes?.find((x) => [1, 4, 5].includes(x.abId) && x.updateTime)?.updateTime ?? (attributes ? null : timestamp ? Date.now() : null) },
        },
      });
    }
    if (path === "/api/monitor" && route.request().method() === "POST") {
      monitorEnabled = route.request().postDataJSON()?.enabled === true;
      return route.fulfill({ json: { monitor: { enabled: monitorEnabled, state: monitorEnabled ? "starting" : "paused", device } } });
    }
    return route.fulfill({
      json: { monitor: { enabled: monitorEnabled, state: monitorEnabled ? "collecting" : "disabled", device: monitorEnabled ? device : null }, samples: historySamples },
    });
  });
  await page.goto("/");
  return { stateCalls: () => stateCalls, monitorEnabled: () => monitorEnabled };
}
test("unknown availability still fetches telemetry and never says offline", async ({
  page,
}) => {
  const { stateCalls: calls } = await setup(page, { online: null });
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#cachedCharge")).toContainText("73%");
  await expect(page.locator("#statusText")).toHaveText("Статус невідомий");
  expect(calls()).toBe(1);
  await expect(page.locator("#readyHours")).toHaveText("—");
});
test("activity shows measured hours and starts background collection for one station", async ({ page }) => {
  const now = Date.now();
  const points = [
    { at: now - 15*60000, soc: 80, input: 0, output: 0, timeSource: "device" },
    { at: now - 10*60000, soc: 80, input: 0, output: 100, timeSource: "device" },
    { at: now - 5*60000, soc: 79, input: 0, output: 100, timeSource: "device" },
  ];
  const access = await setup(page, { historySamples: points });
  await expect.poll(access.monitorEnabled).toBe(true);
  await page.getByRole("navigation").getByRole("button", { name: "Історія", exact: true }).click();
  await expect(page.locator("#observedHours")).toHaveText("15 хв");
  await expect(page.locator("#supplyingHours")).toHaveText("15 хв");
  await expect(page.locator("#currentSessionHours")).toHaveText("15 хв");
  await expect(page.locator("#activityList")).toContainText("Навантаження з’явилось");
  await expect(page.locator("#activityCoverageNote")).toContainText("не лічильник фактичного часу ввімкнення");
  await page.screenshot({ path: "artifacts/activity-" + test.info().project.name + ".png", fullPage: true });
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
        data: { customizeTslInfo: [{ abId: 1, resourceValce: 89 }] },
        connection: { online: false, receivedAt: Date.now(), reportedAt: null },
      },
    }),
  );
  await page.locator("#refreshBtn").click();
  await expect(page.locator("#statusText")).toHaveText("Станція офлайн");
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#energy")).toHaveText("— кВт·год");
  await expect(page.locator("#cachedCharge")).toContainText(
    "Останній хмарний знімок заряду: 89%",
  );
  await expect(page.locator("#cachedCharge")).toContainText(
    "Це не поточний заряд",
  );
  await expect(page.locator("#updatedShort")).toContainText(
    "не час вимірювання",
  );
  await expect(page.locator("#readyHours")).toHaveText("—");
  await page.screenshot({
    path: "artifacts/charge-offline-" + test.info().project.name + ".png",
    fullPage: false,
  });
});
test("expired auth prompts login without inventing battery data", async ({
  page,
}) => {
  await setup(page, { stateError: 401 });
  await expect(page.locator("#statusText")).toHaveText("Потрібен вхід");
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#connectBtn")).toBeVisible();
  await page.locator("#connectBtn").click();
  await expect(page.locator("#loginStatus")).toContainText("Введіть email і пароль Wonderfree");
});
test("re-login refreshes the dashboard without a second save step", async ({ page }) => {
  await setup(page, { stateError: 401 });
  await expect(page.locator("#statusText")).toHaveText("Потрібен вхід");
  await page.route("**/api/login", (route) => route.fulfill({ json: { accountId, devices: [device] } }));
  await page.route("**/api/state?**", (route) => route.fulfill({
    json: {
      data: { customizeTslInfo: [
        { abId: 1, resourceValce: 72, updateTime: Date.now() },
        { abId: 4, resourceValce: 0, updateTime: Date.now() },
        { abId: 5, resourceValce: 40, updateTime: Date.now() },
      ] },
      connection: { online: true, receivedAt: Date.now(), reportedAt: Date.now() },
    },
  }));
  await page.locator("#connectBtn").click();
  await page.locator("#email").fill("owner@example.com");
  await page.locator("#password").fill("example-password");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#statusText")).toHaveText("Станція онлайн");
  await expect(page.locator("#soc")).toHaveText("72%");
  await expect(page.locator("#loginStatus")).toContainText("Станцію підключено");
});
test("offline cached 89 becomes 100 only after a new online cloud reading", async ({
  page,
}) => {
  await setup(page, {
    online: false,
    attributes: [{ abId: 1, resourceValce: 89 }],
  });
  await expect(page.locator("#statusText")).toHaveText("Станція офлайн");
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#cachedCharge")).toContainText("89%");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "План", exact: true })
    .click();
  await page.locator('[data-preset="3"]').click();
  await expect(page.locator("#budgetTime")).toHaveText("—");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Зараз", exact: true })
    .click();
  await page.route("**/api/state?**", (route) =>
    route.fulfill({
      json: {
        data: {
          customizeTslInfo: [
            { abId: 1, resourceValce: 100, updateTime: Date.now() },
            { abId: 4, resourceValce: 0 },
            { abId: 5, resourceValce: 50 },
          ],
        },
        connection: {
          online: true,
          receivedAt: Date.now(),
          reportedAt: Date.now(),
        },
      },
    }),
  );
  await page.locator("#refreshBtn").click();
  await expect(page.locator("#soc")).toHaveText("100%");
  await expect(page.locator("#cachedCharge")).toBeHidden();
  await expect(page.locator("#readyHours")).not.toHaveText("—");
});
test("cloud online without measurement time is not presented as live", async ({ page }) => {
  await setup(page, { timestamp: false, historySamples: [
    { at: Date.now() - 300000, soc: 78, input: 0, output: 88, timeSource: "cloud-poll" },
  ] });
  await expect(page.locator("#statusText")).toContainText("дані не підтверджені");
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#cachedCharge")).toContainText("73%");
  await expect(page.locator("#readyHours")).toHaveText("—");
  await page.getByRole("navigation").getByRole("button", { name: "Історія", exact: true }).click();
  await expect(page.locator("#historyCount")).toHaveText("0");
  await expect(page.locator("#historyLead")).toContainText("старих хмарних точок");
});
test("old battery timestamp remains unconfirmed even when power has a fresh timestamp", async ({
  page,
}) => {
  await setup(page, {
    attributes: [
      { abId: 1, resourceValce: 89, updateTime: Date.now() - 86400000 },
      { abId: 4, resourceValce: 0, updateTime: Date.now() },
      { abId: 5, resourceValce: 50, updateTime: Date.now() },
    ],
  });
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#cachedCharge")).toContainText(
    "Час вимірювання заряду:",
  );
  await expect(page.locator("#readyHours")).toHaveText("—");
});
test("cloud failure preserves only a real scoped snapshot", async ({
  page,
}) => {
  await setup(page, { stateError: 502, cached: true });
  await expect(page.locator("#statusText")).toHaveText("Помилка хмари");
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#cachedCharge")).toContainText("61%");
  await expect(page.locator("#readyHours")).toHaveText("—");
  await page.reload();
  await expect(page.locator("#soc")).toHaveText("—");
  await expect(page.locator("#cachedCharge")).toContainText("61%");
});
test("partial telemetry leaves unknown outputs and ports blank", async ({
  page,
}) => {
  await setup(page, { attributes: [{ abId: 1, resourceValce: 73, updateTime: Date.now() }] });
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
