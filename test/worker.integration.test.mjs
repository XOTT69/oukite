import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker.js";

class MemoryKV {
  values = new Map();
  reads = 0;

  async get(key, type) {
    this.reads++;
    if (Array.isArray(key))
      return new Map(
        key.map((k) => [
          k,
          type === "json" && this.values.has(k)
            ? JSON.parse(this.values.get(k))
            : (this.values.get(k) ?? null),
        ]),
      );
    const value = this.values.get(key);
    return type === "json" && value ? JSON.parse(value) : (value ?? null);
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function request(path, options = {}) {
  return new Request("https://example.test" + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": "203.0.113.77",
      ...(options.headers || {}),
    },
  });
}

async function monitorFixture() {
  const env = {
    SESSIONS: new MemoryKV(),
    MONITOR_KEY: "test-monitor-secret-that-is-long-enough",
  };
  const sid = "s".repeat(43),
    mid = "m".repeat(43),
    owner = "c".repeat(64);
  await env.SESSIONS.put(
    "session:" + sid,
    JSON.stringify({ token: "fixture-token", owner }),
  );
  await env.SESSIONS.put(
    "monitor:" + mid,
    JSON.stringify({
      owner,
      enabled: false,
      revision: "fixture",
      createdAt: Date.now(),
      device: { productKey: "p11wN7", deviceKey: "device_test_001" },
    }),
  );
  return {
    env,
    mid,
    owner,
    headers: { Cookie: "oukitel_session=" + sid + "; oukitel_monitor=" + mid },
  };
}

test("unknown online field remains unknown and does not block state reading", async () => {
  const original = globalThis.fetch;
  const { env, headers } = await monitorFixture();
  let reads = 0;
  globalThis.fetch = async (url) =>
    String(url).includes("userDeviceList")
      ? json({
          code: 0,
          data: {
            list: [{ productKey: "p11wN7", deviceKey: "device_test_001" }],
          },
        })
      : (reads++,
        json({
          code: 0,
          data: { customizeTslInfo: [{ abId: 1, resourceValce: 70 }] },
        }));
  try {
    const devices = await worker.fetch(
      request("/api/devices", { headers }),
      env,
    );
    assert.equal((await devices.json()).devices[0].online, null);
    const state = await worker.fetch(
      request("/api/state?pk=p11wN7&dk=device_test_001", { headers }),
      env,
    );
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.connection.online, null);
    assert.equal(body.connection.reportedAt, null);
    assert.equal(reads, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("history includes all UTC dates across midnight", async () => {
  const { env, mid, headers } = await monitorFixture(),
    now = Date.now();
  // Seed every date of a 48-hour window; query uses real current time.
  for (let i = 0; i < 576; i++) {
    const at = now - i * 300000;
    await env.SESSIONS.put(
      "sample:" +
        mid +
        ":" +
        new Date(at).toISOString().slice(0, 10) +
        ":" +
        at,
      JSON.stringify({ at, soc: 70, input: 0, output: 50 }),
    );
  }
  const response = await worker.fetch(
    request("/api/monitor/history?hours=48", { headers }),
    env,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.samples.length, 576);
});
test("week history uses bulk reads below Worker per-invocation limit", async () => {
  const { env, mid, headers } = await monitorFixture(),
    now = Date.now();
  for (let i = 0; i < 2016; i++) {
    const at = now - i * 300000;
    await env.SESSIONS.put(
      "sample:" +
        mid +
        ":" +
        new Date(at).toISOString().slice(0, 10) +
        ":" +
        at,
      JSON.stringify({ at, soc: 70, input: 0, output: 50 }),
    );
  }
  env.SESSIONS.reads = 0;
  const response = await worker.fetch(
    request("/api/monitor/history?hours=168", { headers }),
    env,
  );
  assert.equal((await response.json()).samples.length, 2016);
  assert.ok(env.SESSIONS.reads < 30);
});
test("monitor data is account-bound and history clear is explicit", async () => {
  const { env, mid, headers } = await monitorFixture();
  const other = "x".repeat(43);
  await env.SESSIONS.put(
    "session:" + other,
    JSON.stringify({ token: "other-token", owner: "d".repeat(64) }),
  );
  const denied = await worker.fetch(
    request("/api/monitor", {
      headers: {
        Cookie: "oukitel_session=" + other + "; oukitel_monitor=" + mid,
      },
    }),
    env,
  );
  assert.equal((await denied.json()).monitor.enabled, false);
  const before = await env.SESSIONS.get("monitor:" + mid, "json");
  await worker.fetch(
    request("/api/monitor/clear", { method: "POST", headers, body: "{}" }),
    env,
  );
  const after = await env.SESSIONS.get("monitor:" + mid, "json");
  assert.ok(after.generation);
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.owner, before.owner);
});
test("pause and logout retain history but discard the monitor token", async () => {
  const { env, mid, headers } = await monitorFixture();
  const record = await env.SESSIONS.get("monitor:" + mid, "json");
  record.enabled = true;
  record.token = "encrypted-test-value";
  await env.SESSIONS.put("monitor:" + mid, JSON.stringify(record));
  const at = Date.now(),
    key =
      "sample:" +
      mid +
      ":" +
      new Date(at).toISOString().slice(0, 10) +
      ":" +
      at;
  await env.SESSIONS.put(
    key,
    JSON.stringify({ at, soc: 60, input: 0, output: 50 }),
  );
  const paused = await worker.fetch(
    request("/api/monitor", {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    }),
    env,
  );
  assert.equal(paused.status, 200);
  assert.ok(env.SESSIONS.values.has(key));
  assert.equal((await env.SESSIONS.get("monitor:" + mid, "json")).token, null);
  const logout = await worker.fetch(
    request("/api/logout", { method: "POST", headers, body: "{}" }),
    env,
  );
  assert.equal(logout.status, 200);
  assert.ok(env.SESSIONS.values.has(key));
});
test("vendor string auth codes produce auth-required, not offline", async () => {
  const original = globalThis.fetch,
    originalError = console.error;
  const { env, headers } = await monitorFixture();
  globalThis.fetch = async () => json({ code: "1003" });
  console.error = () => {};
  try {
    const response = await worker.fetch(
      request("/api/devices", { headers }),
      env,
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "auth-required");
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
});
test("cloud errors identify the failing read without exposing vendor text", async () => {
  const original = globalThis.fetch, originalError = console.error;
  const { env, headers } = await monitorFixture();
  globalThis.fetch = async () => json({ code: 87321, msg: "private vendor details" });
  console.error = () => {};
  try {
    const response = await worker.fetch(request("/api/devices", { headers }), env);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.stage, "devices");
    assert.equal(body.vendorStatus, 200);
    assert.equal(body.vendorCode, 87321);
    assert.doesNotMatch(JSON.stringify(body), /private vendor details/);
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
});

test("cloud integration uses a server-side session for devices and telemetry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const endpoint = String(url);
    assert.equal(options.headers["app-info"], "[Pixel][Google][raven][33]");
    if (!endpoint.includes("emailPwdLogin"))
      assert.equal(options.headers.Authorization, "test-token");
    if (endpoint.includes("emailPwdLogin")) {
      return json({ code: 0, data: { accessToken: { token: "test-token" } } });
    }
    if (endpoint.includes("userDeviceList")) {
      return json({
        code: 0,
        data: {
          list: [
            {
              productKey: "p11wN7",
              deviceKey: "device_test_001",
              deviceName: "My P2001E",
              productName: "P2001E Plus",
              online: "1",
            },
          ],
        },
      });
    }
    if (endpoint.includes("getDeviceBusinessAttributes")) {
      return json({
        code: 0,
        data: {
          customizeTslInfo: [
            { abId: 1, resourceValce: "73" },
            { abId: 4, resourceValce: "210" },
            { abId: 43, resourceValce: "true" },
          ],
        },
      });
    }
    throw Error("Unexpected vendor endpoint: " + endpoint);
  };

  try {
    const env = { SESSIONS: new MemoryKV() };
    const login = await worker.fetch(
      request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "test@example.com",
          password: "safe-test",
        }),
      }),
      env,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^oukitel_session=/);
    assert.equal(login.headers.get("cache-control"), "no-store");

    const devices = await worker.fetch(
      request("/api/devices", { headers: { Cookie: cookie } }),
      env,
    );
    const devicesBody = await devices.json();
    assert.match(devicesBody.accountId, /^[a-f0-9]{64}$/);
    assert.deepEqual(devicesBody.devices, [
      {
        productKey: "p11wN7",
        deviceKey: "device_test_001",
        deviceName: "My P2001E",
        productName: "P2001E Plus",
        online: true,
      },
    ]);

    const state = await worker.fetch(
      request("/api/state?pk=p11wN7&dk=device_test_001", {
        headers: { Cookie: cookie },
      }),
      env,
    );
    assert.equal(state.status, 200);
    assert.equal(
      (await state.json()).data.customizeTslInfo.find(
        (entry) => entry.abId === 1,
      ).resourceValce,
      "73",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed vendor logins are rate limited without exposing a session", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async () => json({ code: 401 }, 401);
  console.error = () => {};
  try {
    const env = { SESSIONS: new MemoryKV() };
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await worker.fetch(
        request("/api/login", {
          method: "POST",
          body: JSON.stringify({
            email: "test@example.com",
            password: "bad-password",
          }),
        }),
        env,
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    const blocked = await worker.fetch(
      request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "test@example.com",
          password: "bad-password",
        }),
      }),
      env,
    );
    assert.equal(blocked.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("background monitor encrypts its cloud token and records telemetry while the PWA is closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("emailPwdLogin"))
      return json({
        code: 0,
        data: { accessToken: { token: "monitor-token" } },
      });
    if (endpoint.includes("userDeviceList"))
      return json({
        code: 0,
        data: {
          list: [
            {
              productKey: "p11wN7",
              deviceKey: "device_test_001",
              productName: "P2001E Plus",
              online: 1,
            },
          ],
        },
      });
    if (endpoint.includes("getDeviceBusinessAttributes"))
      return json({
        code: 0,
        data: {
          customizeTslInfo: [
            { abId: 1, resourceValce: "75" },
            { abId: 4, resourceValce: "12" },
            { abId: 5, resourceValce: "43" },
          ],
        },
      });
    throw Error("Unexpected vendor endpoint: " + endpoint);
  };
  try {
    const env = {
      SESSIONS: new MemoryKV(),
      MONITOR_KEY: "test-monitor-secret-that-is-long-enough",
    };
    const login = await worker.fetch(
      request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "test@example.com",
          password: "safe-test",
        }),
      }),
      env,
    );
    const sessionCookie = login.headers.get("set-cookie").split(";")[0];
    const storedSession = [...env.SESSIONS.values.entries()].find(([key]) =>
      key.startsWith("session:"),
    )[1];
    assert.doesNotMatch(storedSession, /monitor-token/);
    const configured = await worker.fetch(
      request("/api/monitor", {
        method: "POST",
        headers: { Cookie: sessionCookie },
        body: JSON.stringify({
          enabled: true,
          productKey: "p11wN7",
          deviceKey: "device_test_001",
        }),
      }),
      env,
    );
    assert.equal(configured.status, 200);
    const monitorCookie = configured.headers.get("set-cookie").split(";")[0];
    assert.equal((await configured.json()).monitor.enabled, true);
    const encryptedRecord = [...env.SESSIONS.values.entries()].find(([key]) =>
      key.startsWith("monitor:"),
    )[1];
    assert.doesNotMatch(encryptedRecord, /monitor-token/);

    const waiting = [];
    await worker.scheduled({}, env, {
      waitUntil: (promise) => waiting.push(promise),
    });
    await Promise.all(waiting);
    const history = await worker.fetch(
      request("/api/monitor/history?hours=24", {
        headers: { Cookie: sessionCookie + "; " + monitorCookie },
      }),
      env,
    );
    const body = await history.json();
    assert.equal(body.samples.length, 1);
    assert.deepEqual(body.samples[0], {
      at: body.samples[0].at,
      soc: 75,
      input: 12,
      output: 43,
      timeSource: "cloud-poll",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("monitor cookies are account-bound and expired leases are removed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    if (endpoint.includes("emailPwdLogin")) {
      const email = new URLSearchParams(String(options.body || "")).get(
        "email",
      );
      return json({
        code: 0,
        data: {
          accessToken: {
            token:
              email === "owner@example.com" ? "owner-token" : "other-token",
          },
        },
      });
    }
    if (endpoint.includes("userDeviceList"))
      return json({
        code: 0,
        data: {
          list: [
            {
              productKey: "p11wN7",
              deviceKey: "device_test_001",
              productName: "P2001E Plus",
              online: 1,
            },
          ],
        },
      });
    throw Error("Unexpected vendor endpoint: " + endpoint);
  };

  try {
    const env = {
      SESSIONS: new MemoryKV(),
      MONITOR_KEY: "test-monitor-secret-that-is-long-enough",
    };

    const ownerLogin = await worker.fetch(
      request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "owner@example.com",
          password: "safe-test",
        }),
      }),
      env,
    );
    const ownerSession = ownerLogin.headers.get("set-cookie").split(";")[0];

    const configured = await worker.fetch(
      request("/api/monitor", {
        method: "POST",
        headers: { Cookie: ownerSession },
        body: JSON.stringify({
          enabled: true,
          productKey: "p11wN7",
          deviceKey: "device_test_001",
        }),
      }),
      env,
    );
    const monitorCookie = configured.headers.get("set-cookie").split(";")[0];
    assert.equal((await configured.json()).monitor.enabled, true);

    const otherLogin = await worker.fetch(
      request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "other@example.com",
          password: "safe-test",
        }),
      }),
      env,
    );
    const otherSession = otherLogin.headers.get("set-cookie").split(";")[0];

    const stolenRead = await worker.fetch(
      request("/api/monitor", {
        headers: { Cookie: otherSession + "; " + monitorCookie },
      }),
      env,
    );
    assert.equal((await stolenRead.json()).monitor.enabled, false);

    const stolenDisable = await worker.fetch(
      request("/api/monitor", {
        method: "POST",
        headers: { Cookie: otherSession + "; " + monitorCookie },
        body: JSON.stringify({ enabled: false }),
      }),
      env,
    );
    assert.equal((await stolenDisable.json()).monitor.enabled, false);

    const ownerStillHasMonitor = await worker.fetch(
      request("/api/monitor", {
        headers: { Cookie: ownerSession + "; " + monitorCookie },
      }),
      env,
    );
    assert.equal((await ownerStillHasMonitor.json()).monitor.enabled, true);

    const monitorEntry = [...env.SESSIONS.values.entries()].find(([key]) =>
      key.startsWith("monitor:"),
    );
    const expired = JSON.parse(monitorEntry[1]);
    expired.expiresAt = Date.now() - 1;
    env.SESSIONS.values.set(monitorEntry[0], JSON.stringify(expired));

    const expiredRead = await worker.fetch(
      request("/api/monitor", {
        headers: { Cookie: ownerSession + "; " + monitorCookie },
      }),
      env,
    );
    assert.equal((await expiredRead.json()).monitor.enabled, false);
    assert.equal(env.SESSIONS.values.has(monitorEntry[0]), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
