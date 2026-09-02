import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker.js";

class MemoryKV {
  values = new Map();

  async get(key, type) {
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

test("cloud integration uses a server-side session for devices and telemetry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
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
    assert.deepEqual(await devices.json(), {
      devices: [
        {
          productKey: "p11wN7",
          deviceKey: "device_test_001",
          deviceName: "My P2001E",
          productName: "P2001E Plus",
          online: true,
        },
      ],
    });

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
      return json({ code: 0, data: { accessToken: { token: "monitor-token" } } });
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
    const env = { SESSIONS: new MemoryKV(), MONITOR_KEY: "test-monitor-secret-that-is-long-enough" };
    const login = await worker.fetch(
      request("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: "test@example.com", password: "safe-test" }),
      }),
      env,
    );
    const sessionCookie = login.headers.get("set-cookie").split(";")[0];
    const configured = await worker.fetch(
      request("/api/monitor", {
        method: "POST",
        headers: { Cookie: sessionCookie },
        body: JSON.stringify({ enabled: true, productKey: "p11wN7", deviceKey: "device_test_001" }),
      }),
      env,
    );
    assert.equal(configured.status, 200);
    const monitorCookie = configured.headers.get("set-cookie").split(";")[0];
    assert.equal((await configured.json()).monitor.enabled, true);
    const encryptedRecord = [...env.SESSIONS.values.entries()].find(([key]) => key.startsWith("monitor:"))[1];
    assert.doesNotMatch(encryptedRecord, /monitor-token/);

    const waiting = [];
    await worker.scheduled({}, env, { waitUntil: (promise) => waiting.push(promise) });
    await Promise.all(waiting);
    const history = await worker.fetch(
      request("/api/monitor/history?hours=24", { headers: { Cookie: sessionCookie + "; " + monitorCookie } }),
      env,
    );
    const body = await history.json();
    assert.equal(body.samples.length, 1);
    assert.deepEqual(body.samples[0], {
      at: body.samples[0].at,
      soc: 75,
      input: 12,
      output: 43,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
