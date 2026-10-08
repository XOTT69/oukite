// Same-origin Cloudflare Worker + static PWA. It deliberately exposes no cloud
// bearer token, authKey, or write endpoint to the browser.
import {
  emptyState,
  mapAttrs,
  normalizeOnline,
  reportedTime,
} from "./public/core.mjs";
import {
  hasD1,
  getMonitor,
  putMonitor,
  storeSample,
  d1Samples,
  dueD1Monitors,
  cleanupD1,
  d1LoginAttempt,
} from "./monitor-store.mjs";
const EU = {
  base: "https://iot-api.quecteleu.com",
  appSecret: "3aRNUwWahjyANa7WfBK2wCCkxCexB6nXxKJwXxfePvzf",
  userDomain: "E.SP.4294967410",
};
const SESSION_TTL = 60 * 60 * 12;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 5;
const MONITOR_TTL = 60 * 60 * 24 * 31;
const SAMPLE_TTL = 60 * 60 * 24 * 31;
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const SAMPLE_MAX_GAP_MS = 12 * 60 * 1000;
const MONITOR_BATCH_SIZE = 25;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(request.method))
        return json({ error: "Метод не підтримується." }, 405);
      const response = secure(await env.ASSETS.fetch(request));
      // Only local development may use HTTP. Production retains all headers.
      if (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ) {
        response.headers.set(
          "Content-Security-Policy",
          SECURITY_HEADERS["Content-Security-Policy"].replace(
            "; upgrade-insecure-requests",
            "",
          ),
        );
        response.headers.delete("Strict-Transport-Security");
      }
      return response;
    }
    if (request.method === "OPTIONS")
      return secure(
        new Response(null, {
          status: 204,
          headers: { Allow: "GET, POST, OPTIONS" },
        }),
      );
    try {
      if (
        request.method === "POST" &&
        request.headers.get("Origin") &&
        request.headers.get("Origin") !== url.origin
      )
        throw new CloudError("Запит з іншого сайту заборонено.", 403);
      if (url.pathname === "/api/health" && request.method === "GET")
        return json({
          ok: true,
          mode: "cloud-read-only",
          version: "3.1.1",
          storage: hasD1(env) ? "d1" : "kv-fallback",
          sessionEncryption: !!env.MONITOR_KEY,
        });
      if (url.pathname === "/api/login" && request.method === "POST")
        return await login(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST")
        return await logout(request, env);
      const session = await sessionFor(request, env);
      if (!session)
        return json(
          {
            error: "Сесія завершилась. Увійдіть знову.",
            code: "auth-required",
          },
          401,
        );
      if (url.pathname === "/api/devices" && request.method === "GET")
        return json({
          devices: await accountDevices(session.token),
          accountId: session.owner,
        });
      if (url.pathname === "/api/monitor" && request.method === "GET")
        return await monitorStatus(request, env, session);
      if (url.pathname === "/api/monitor" && request.method === "POST")
        return await configureMonitor(request, env, session);
      if (url.pathname === "/api/monitor/history" && request.method === "GET")
        return await monitorHistory(request, env, url, session);
      if (url.pathname === "/api/monitor/clear" && request.method === "POST")
        return await clearMonitorHistory(request, env, session);
      if (url.pathname === "/api/state" && request.method === "GET")
        return await state(url, session.token);
      if (url.pathname === "/api/tsl" && request.method === "GET")
        return await tsl(url, session.token);
      return json({ error: "Не знайдено." }, 404);
    } catch (error) {
      // Do not log vendor responses, request bodies, identifiers or tokens.
      console.error(
        "OUKITEL request failed",
        JSON.stringify({
          route: url.pathname,
          status: error instanceof CloudError ? error.status : 502,
          stage: error instanceof CloudError ? error.stage || null : null,
          vendorStatus:
            error instanceof CloudError ? error.vendorStatus || null : null,
          vendorCode:
            error instanceof CloudError ? error.vendorCode ?? null : null,
        }),
      );
      return json(
        {
          code:
            error instanceof CloudError && error.status === 401
              ? "auth-required"
              : "cloud-error",
          error:
            error instanceof CloudError
              ? error.message
              : "Помилка підключення до хмари.",
          ...(error instanceof CloudError && error.stage
            ? { stage: error.stage }
            : {}),
          ...(error instanceof CloudError && error.vendorStatus
            ? { vendorStatus: error.vendorStatus }
            : {}),
          ...(error instanceof CloudError && error.vendorCode != null
            ? { vendorCode: error.vendorCode }
            : {}),
        },
        error instanceof CloudError ? error.status : 502,
      );
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sampleAllMonitors(env));
  },
};

async function login(request, env) {
  const input = await readJson(request);
  const email = String(input.email || "").trim(),
    password = String(input.password || "");
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !password ||
    password.length > 256
  )
    return json({ error: "Введіть коректні email і пароль." }, 400);
  const rateKey = await takeLoginAttempt(request, env);
  const token = await cloudLogin(email, password);
  const devices = await accountDevices(token);
  const owner = await sha256hex(email.toLowerCase());
  if (hasD1(env))
    await env.DB.prepare("DELETE FROM login_rate WHERE key=?1")
      .bind(rateKey)
      .run();
  else await env.SESSIONS.delete(rateKey);
  const sessionId = randomId();
  await env.SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify({
      token: env.MONITOR_KEY
        ? "enc." + (await encryptMonitorToken(token, env))
        : token,
      owner,
    }),
    {
      expirationTtl: SESSION_TTL,
    },
  );
  let monitorWarning = null;
  try {
    await refreshMonitorToken(request, env, token, owner, devices);
  } catch {
    monitorWarning =
      "Акаунт підключено, але фоновий збір не відновлено. Перевірте налаштування сервера.";
  }
  const response = json({
    devices,
    accountId: owner,
    ...(monitorWarning ? { monitorWarning } : {}),
  });
  response.headers.set(
    "Set-Cookie",
    `oukitel_session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${SESSION_TTL}`,
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
async function logout(request, env) {
  const session = await sessionFor(request, env);
  const sessionId = cookie(request, "oukitel_session");
  if (sessionId) await env.SESSIONS.delete(`session:${sessionId}`);
  await pauseMonitor(request, env, session);
  const response = json({ ok: true });
  response.headers.set(
    "Set-Cookie",
    "oukitel_session=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0",
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
async function sessionFor(request, env) {
  const id = cookie(request, "oukitel_session");
  if (!id || !/^[A-Za-z0-9_-]{40,}$/.test(id)) return null;
  const data = await env.SESSIONS.get(`session:${id}`, "json");
  const owner = data?.owner || data?.accountId;
  if (!data?.token || !owner) return null;
  try {
    return {
      owner,
      token: String(data.token).startsWith("enc.")
        ? await decryptMonitorToken(data.token.slice(4), env)
        : data.token,
    };
  } catch {
    return null;
  }
}

function monitorCookie(request) {
  const id = cookie(request, "oukitel_monitor");
  return /^[A-Za-z0-9_-]{40,}$/.test(id) ? id : "";
}
function monitorCookieHeader(id, maxAge = MONITOR_TTL) {
  return `oukitel_monitor=${id || ""}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;
}
function publicMonitor(record) {
  if (!record)
    return {
      enabled: false,
      intervalMinutes: 5,
      retentionDays: 31,
      state: "disabled",
    };
  return {
    enabled: record.enabled === true,
    intervalMinutes: 5,
    retentionDays: 31,
    state: !record.enabled
      ? "paused"
      : record.authRequired
        ? "auth-required"
        : record.lastError
          ? "waiting"
          : record.lastSampleAt
            ? "collecting"
            : "starting",
    lastSampleAt: record.lastSampleAt || null,
    lastError: record.lastError || null,
    device: record.device
      ? {
          productKey: record.device.productKey,
          deviceKey: record.device.deviceKey,
        }
      : null,
  };
}
async function monitorFor(request, env, session) {
  const id = monitorCookie(request);
  if (!id) return { id: "", record: null };
  const record = await getMonitor(env, id);
  if (record?.expiresAt && record.expiresAt <= Date.now()) {
    if (hasD1(env))
      await env.DB.prepare("DELETE FROM monitors WHERE id=?1").bind(id).run();
    await env.SESSIONS.delete("monitor:" + id);
    return { id: "", record: null };
  }
  if (record && !record.owner && record.accountId)
    record.owner = record.accountId;
  if (!record || !session?.owner || record.owner !== session.owner)
    return { id: "", record: null };
  return { id, record };
}
async function monitorStatus(request, env, session) {
  const { record } = await monitorFor(request, env, session);
  return json({ monitor: publicMonitor(record) });
}
async function configureMonitor(request, env, session) {
  const input = await readJson(request);
  if (input.enabled !== true && input.enabled !== false)
    throw new CloudError("Вкажіть, чи має працювати фоновий моніторинг.", 400);
  const existing = await monitorFor(request, env, session);
  if (!input.enabled) {
    await pauseMonitor(request, env, session);
    return json({
      monitor: publicMonitor(
        existing.record ? { ...existing.record, enabled: false } : null,
      ),
    });
  }
  const productKey = String(input.productKey || ""),
    deviceKey = String(input.deviceKey || "");
  if (!validDeviceId(productKey) || !validDeviceId(deviceKey))
    throw new CloudError("Оберіть коректну станцію для моніторингу.", 400);
  const device = (await accountDevices(session.token)).find(
    (item) => item.productKey === productKey && item.deviceKey === deviceKey,
  );
  if (!device)
    throw new CloudError("Станція не знайдена у вашому акаунті.", 403);
  const sameDevice =
    existing.record?.device?.productKey === productKey &&
    existing.record?.device?.deviceKey === deviceKey;
  if (existing.record && !sameDevice) await pauseMonitor(request, env, session);
  const id = sameDevice ? existing.id : randomId();
  const record = {
    ...(sameDevice ? existing.record : {}),
    owner: session.owner,
    revision: randomId(),
    enabled: true,
    device: { productKey: device.productKey, deviceKey: device.deviceKey },
    token: await encryptMonitorToken(session.token, env),
    createdAt: sameDevice ? existing.record.createdAt : Date.now(),
    expiresAt: Date.now() + MONITOR_TTL * 1000,
    lastSampleAt: sameDevice ? existing.record.lastSampleAt : null,
    lastError: null,
    authRequired: false,
  };
  await putMonitor(env, id, record);
  const response = json({ monitor: publicMonitor(record) });
  response.headers.set("Set-Cookie", monitorCookieHeader(id));
  return response;
}
async function refreshMonitorToken(request, env, token, owner, devices) {
  const id = monitorCookie(request),
    record = id ? await getMonitor(env, id) : null;
  if (
    !record ||
    ((record.owner || record.accountId) &&
      (record.owner || record.accountId) !== owner)
  )
    return;
  if (
    !devices.some(
      (d) =>
        d.productKey === record.device?.productKey &&
        d.deviceKey === record.device?.deviceKey,
    )
  )
    return;
  record.owner = owner;
  record.expiresAt = Date.now() + MONITOR_TTL * 1000;
  record.revision = randomId();
  if (record.enabled) record.token = await encryptMonitorToken(token, env);
  record.authRequired = false;
  record.lastError = null;
  await putMonitor(env, id, record);
}

async function pauseMonitor(request, env, session) {
  const { id, record } = await monitorFor(request, env, session);
  if (!record) return;
  record.enabled = false;
  record.token = null;
  record.revision = randomId();
  await putMonitor(env, id, record);
}
async function clearMonitorHistory(request, env, session) {
  const { id, record } = await monitorFor(request, env, session);
  if (!record) return json({ ok: true });
  // Logical deletion switches namespace immediately; old points expire by TTL.
  record.generation = randomId();
  record.revision = randomId();
  record.lastSampleAt = null;
  record.lastReportedAt = null;
  await putMonitor(env, id, record);
  return json({ ok: true, monitor: publicMonitor(record) });
}
async function monitorHistory(request, env, url, session) {
  const { id, record } = await monitorFor(request, env, session);
  const pk = url.searchParams.get("pk"),
    dk = url.searchParams.get("dk");
  if (
    !id ||
    (pk && (pk !== record.device.productKey || dk !== record.device.deviceKey))
  )
    return json({ samples: [], monitor: publicMonitor(record) });
  const hours = Math.min(
    720,
    Math.max(1, Number(url.searchParams.get("hours")) || 24),
  );
  const legacy = await samplesForRange(
    env,
    record.generation ? `${id}:${record.generation}` : id,
    hours,
  );
  const databaseSamples = await d1Samples(
    env,
    id,
    record.generation,
    Date.now() - hours * 36e5,
    Date.now(),
  );
  const samples = [
    ...new Map([...legacy, ...databaseSamples].map((x) => [x.at, x])).values(),
  ].sort((a, b) => a.at - b.at);
  return json({ samples, monitor: publicMonitor(record) });
}
function sampleKey(id, at) {
  return `sample:${id}:${new Date(at).toISOString().slice(0, 10)}:${String(at).padStart(13, "0")}`;
}
async function samplesForRange(env, id, hours, now = Date.now()) {
  if (typeof env.SESSIONS.list !== "function") return [];
  const after = now - hours * 36e5,
    dates = new Set();
  for (let t = Math.floor(after / 864e5) * 864e5; t <= now; t += 864e5)
    dates.add(new Date(t).toISOString().slice(0, 10));
  const keys = [];
  for (const day of dates) {
    let cursor = undefined;
    do {
      const page = await env.SESSIONS.list({
        prefix: `sample:${id}:${day}:`,
        cursor,
      });
      keys.push(...(page.keys || []).map((key) => key.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  const samples = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = await env.SESSIONS.get(keys.slice(i, i + 100), "json");
    samples.push(...batch.values());
  }
  return samples
    .filter((sample) => sample && sample.at >= after && sample.at <= now)
    .sort((a, b) => a.at - b.at);
}
async function sampleAllMonitors(env) {
  const now = Date.now();
  await cleanupD1(env, now);
  const databaseQueue = await dueD1Monitors(env, now, MONITOR_BATCH_SIZE);
  const cursor = (await env.SESSIONS.get("cron:cursor")) || undefined;
  const page = await env.SESSIONS.list({
    prefix: "monitor:",
    limit: MONITOR_BATCH_SIZE,
    cursor,
  });
  const legacyQueue = await Promise.all(
    (page.keys || []).map(async (key) => ({
      id: key.name.slice(8),
      record: await getMonitor(env, key.name.slice(8)),
    })),
  );
  const used = new Set(databaseQueue.map((x) => x.id));
  const queue = [
    ...databaseQueue,
    ...legacyQueue.filter((x) => !used.has(x.id)),
  ].slice(0, MONITOR_BATCH_SIZE);
  for (let i = 0; i < queue.length; i += 5)
    await Promise.all(
      queue.slice(i, i + 5).map(async ({ id, record }) => {
        if (record?.enabled && !record.authRequired)
          await sampleMonitor(env, id, record, now);
      }),
    );
  if (page.list_complete && cursor) await env.SESSIONS.delete("cron:cursor");
  else if (!page.list_complete && page.cursor)
    await env.SESSIONS.put("cron:cursor", page.cursor);
}
async function sampleMonitor(env, id, record, now = Date.now()) {
  if (record.expiresAt && record.expiresAt <= now) return;
  if (
    now - Number(record.lastAttemptAt || record.lastSampleAt || 0) <
    SAMPLE_INTERVAL_MS - 30000
  )
    return;
  try {
    const token = await decryptMonitorToken(record.token, env);
    const device = (await accountDevices(token)).find(
      (item) =>
        item.productKey === record.device.productKey &&
        item.deviceKey === record.device.deviceKey,
    );
    if (!device)
      throw new CloudError("Станція більше не прив’язана до акаунта.", 403);
    if (device.online === false)
      throw new CloudError(
        "Станція офлайн: нові вимірювання не отримано.",
        503,
      );
    const raw = await cloudGet(
      `/v2/binding/enduserapi/getDeviceBusinessAttributes?pk=${encodeURIComponent(record.device.productKey)}&dk=${encodeURIComponent(record.device.deviceKey)}`,
      token,
    );
    const sample = telemetrySample(raw, now);
    if (!sample) throw new CloudError("Станція не передала вимірювання.", 502);
    const reportedAt = reportedTime(raw, now);
    if (reportedAt && now - reportedAt > SAMPLE_MAX_GAP_MS)
      throw new CloudError("Хмара повернула застарілі вимірювання.", 503);
    if (device.online == null && !reportedAt)
      throw new CloudError(
        "Статус станції та час вимірювання невідомі. Збір призупинено, щоб не навчатися на кешованих даних.",
        503,
      );
    const current = await getMonitor(env, id);
    if (!current?.enabled || current.revision !== record.revision) return;
    record.lastAttemptAt = now;
    if (reportedAt && reportedAt === record.lastReportedAt) {
      await putMonitor(env, id, record);
      return;
    }
    sample.timeSource = reportedAt ? "device" : "cloud-poll";
    sample.at = reportedAt || now;
    if (reportedAt) record.lastReportedAt = reportedAt;
    record.lastSampleAt = now;
    record.lastError = null;
    record.authRequired = false;
    // A legacy KV monitor must exist in D1 before its first FK-bound sample.
    if (hasD1(env)) {
      await putMonitor(env, id, record);
      await storeSample(env, id, record, sample, SAMPLE_TTL);
    } else
      await Promise.all([
        storeSample(env, id, record, sample, SAMPLE_TTL),
        putMonitor(env, id, record),
      ]);
  } catch (error) {
    const current = await getMonitor(env, id);
    if (!current?.enabled || current.revision !== record.revision) return;
    record.lastAttemptAt = now;
    record.lastError =
      error instanceof CloudError
        ? error.message
        : "Не вдалося отримати дані станції.";
    if (error instanceof CloudError && error.status === 401)
      record.authRequired = true;
    await putMonitor(env, id, record);
  }
}
function telemetrySample(payload, at) {
  const telemetry = mapAttrs(payload, emptyState());
  const { output, input, soc } = telemetry;
  if (output == null || input == null || soc == null) return null;
  return {
    at,
    soc: Math.max(0, Math.min(100, soc)),
    input: Math.max(0, input),
    output: Math.max(0, output),
    ...Object.fromEntries(
      ["ac", "usb", "dc"]
        .filter((k) => telemetry[k] != null)
        .map((k) => [k, telemetry[k]]),
    ),
  };
}
async function monitorKey(env) {
  if (!env.MONITOR_KEY || String(env.MONITOR_KEY).length < 24)
    throw new CloudError(
      "Фоновий моніторинг ще не налаштований на сервері.",
      503,
    );
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(env.MONITOR_KEY),
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function fromBase64url(value) {
  const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)),
    (char) => char.charCodeAt(0),
  );
}
async function encryptMonitorToken(token, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await monitorKey(env),
    new TextEncoder().encode(token),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
async function decryptMonitorToken(value, env) {
  const [iv, encrypted] = String(value || "").split(".");
  if (!iv || !encrypted)
    throw new CloudError("Дані моніторингу пошкоджені.", 401);
  try {
    const result = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) },
      await monitorKey(env),
      fromBase64url(encrypted),
    );
    return new TextDecoder().decode(result);
  } catch {
    throw new CloudError(
      "Не вдалося відкрити захищену сесію моніторингу.",
      401,
    );
  }
}
async function accountDevices(token) {
  const raw = await cloudGet(
    "/v2/binding/enduserapi/userDeviceList?pageNumber=1&pageSize=50",
    token,
    "devices",
  );
  const list = raw?.data?.list;
  if (!Array.isArray(list))
    throw new CloudError("Не вдалося отримати список станцій.", 502, {
      stage: "devices",
    });
  return list
    .map((item) => ({
      productKey: String(item.productKey || ""),
      deviceKey: String(item.deviceKey || ""),
      deviceName: String(item.deviceName || ""),
      productName: String(item.productName || ""),
      online: normalizeOnline(
        item.online ?? item.isOnline ?? item.onlineStatus,
      ),
    }))
    .filter((item) => item.productKey && item.deviceKey);
}
async function allowedDevice(url, token) {
  const productKey = url.searchParams.get("pk"),
    deviceKey = url.searchParams.get("dk");
  if (!validDeviceId(productKey) || !validDeviceId(deviceKey))
    throw new CloudError("Потрібно обрати коректну станцію.", 400);
  const device = (await accountDevices(token)).find(
    (item) => item.productKey === productKey && item.deviceKey === deviceKey,
  );
  if (!device)
    throw new CloudError("Станція не знайдена у вашому акаунті.", 403);
  return device;
}
async function state(url, token) {
  const device = await allowedDevice(url, token);
  const payload = await cloudGet(
    `/v2/binding/enduserapi/getDeviceBusinessAttributes?pk=${encodeURIComponent(device.productKey)}&dk=${encodeURIComponent(device.deviceKey)}`,
    token,
    "telemetry",
  );
  const telemetry = mapAttrs(payload, emptyState());
  if (
    telemetry.soc == null &&
    telemetry.input == null &&
    telemetry.output == null
  )
    throw new CloudError(
      "Хмара не повернула показників станції. Спробуйте оновити пізніше.",
      502,
      { stage: "telemetry" },
    );
  return noStore({
    ...payload,
    connection: {
      online: device.online,
      receivedAt: Date.now(),
      reportedAt: reportedTime(payload),
      source: "quectel-cloud",
    },
  });
}
async function tsl(url, token) {
  const productKey = url.searchParams.get("pk");
  if (!productKey) throw new CloudError("Потрібен product key.", 400);
  const allowed = await accountDevices(token);
  if (!allowed.some((item) => item.productKey === productKey))
    throw new CloudError("Модель не належить вашому акаунту.", 403);
  return noStore(
    await cloudGet(
      `/v2/binding/enduserapi/productTSL?pk=${encodeURIComponent(productKey)}`,
      token,
    ),
  );
}
async function cloudLogin(email, password) {
  const random = randomString(16),
    md5 = md5hexCorrect(random).toUpperCase(),
    key = md5.slice(8, 24),
    iv = key.slice(8) + key.slice(0, 8);
  const encryptedPassword = await aesCbcBase64(password, key, iv);
  const signature = await sha256hex(
    email + encryptedPassword + random + EU.appSecret,
  );
  const body = new URLSearchParams({
    email,
    pwd: encryptedPassword,
    random,
    signature,
    userDomain: EU.userDomain,
  });
  const response = await vendorFetch(
    `${EU.base}/v2/enduser/enduserapi/emailPwdLogin`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...cloudHeaders(),
      },
      body,
    },
  );
  const result = await parseCloud(
    response,
    "Не вдалося увійти. Перевірте email, пароль і регіон акаунта.",
  );
  const token = result?.data?.accessToken?.token;
  if (!token)
    throw new CloudError("Не вдалося увійти. Перевірте email і пароль.", 401);
  // Wonderfree sends the accessToken value directly in Authorization.
  return token;
}
async function cloudGet(path, token, stage = "cloud") {
  try {
    const response = await vendorFetch(EU.base + path, {
      headers: cloudHeaders(token),
    });
    return parseCloud(response, "Помилка Quectel Cloud.", stage);
  } catch (error) {
    if (error instanceof CloudError && !error.stage) error.stage = stage;
    throw error;
  }
}
async function vendorFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    throw new CloudError("Хмара не відповідає. Спробуйте ще раз.", 504);
  } finally {
    clearTimeout(timeout);
  }
}
function cloudHeaders(token) {
  const headers = {
    "X-Q-Language": "en",
    "quec-random-url": crypto.randomUUID(),
    "app-info": "[Pixel][Google][raven][33]",
  };
  // Strip the prefix from sessions issued by older releases as well.
  if (token) headers.Authorization = String(token).replace(/^Bearer\s+/i, "");
  return headers;
}
async function parseCloud(response, fallback, stage = "login") {
  const body = await response.json().catch(() => null);
  const vendorCode = body?.code == null ? null : Number(body.code);
  const details = {
    stage,
    vendorStatus: response.status,
    vendorCode: Number.isSafeInteger(vendorCode) ? vendorCode : null,
  };
  const authError =
    response.status === 401 || [401, 4001, 1003, 5032].includes(vendorCode);
  if (authError)
    throw new CloudError(
      "Сесія Quectel завершилась. Увійдіть знову.",
      401,
      details,
    );
  if (!response.ok)
    throw new CloudError(
      response.status === 429
        ? "Хмара обмежила частоту запитів. Повторіть трохи пізніше."
        : fallback,
      response.status === 429 ? 429 : 502,
      details,
    );
  if (body && body.code != null && ![0, 200].includes(Number(body.code)))
    throw new CloudError(fallback, 502, details);
  if (!body || typeof body !== "object")
    throw new CloudError("Хмара повернула некоректну відповідь.", 502, details);
  return body;
}
function noStore(body) {
  return json(body);
}
function json(value, status = 200) {
  return secure(
    new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
  );
}
function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
function cookie(request, name) {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}
async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 4096) throw new CloudError("Запит завеликий.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CloudError("Некоректний запит.", 400);
  let size = 0,
    chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new CloudError("Запит завеликий.", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    if (size > 4096) throw new CloudError("Запит завеликий.", 413);
    throw new CloudError("Некоректний запит.", 400);
  }
}
function validDeviceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
}
async function takeLoginAttempt(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = "rate:login:" + (await sha256hex(ip));
  if (hasD1(env)) {
    if (
      !(await d1LoginAttempt(
        env,
        key,
        LOGIN_WINDOW_SECONDS,
        LOGIN_MAX_ATTEMPTS,
      ))
    )
      throw new CloudError(
        "Забагато спроб входу. Спробуйте знову через 15 хвилин.",
        429,
      );
    return key;
  }
  const used = Number((await env.SESSIONS.get(key)) || 0);
  if (used >= LOGIN_MAX_ATTEMPTS)
    throw new CloudError(
      "Забагато спроб входу. Спробуйте знову через 15 хвилин.",
      429,
    );
  await env.SESSIONS.put(key, String(used + 1), {
    expirationTtl: LOGIN_WINDOW_SECONDS,
  });
  return key;
}
function randomString(length) {
  const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => chars[byte % chars.length]).join("");
}
function randomId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function aesCbcBase64(text, keyString, ivString) {
  const encoder = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(keyString),
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    ),
    encrypted = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: encoder.encode(ivString) },
      key,
      encoder.encode(text),
    );
  return btoa(String.fromCharCode(...new Uint8Array(encrypted))) + "\n";
}
async function sha256hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
class CloudError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.status = status;
    this.stage = details.stage;
    this.vendorStatus = details.vendorStatus;
    this.vendorCode = details.vendorCode;
  }
}

// Compact MD5 implementation, needed to reproduce the Wonderfree login request.
function md5cycle(x, k) {
  let [a, b, c, d] = x;
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, 1200080426);
  d = ff(d, a, b, c, k[5], 12, -1473231341);
  c = ff(c, d, a, b, k[6], 17, -45705983);
  b = ff(b, c, d, a, k[7], 22, 1770035416);
  a = ff(a, b, c, d, k[8], 7, -2022574463);
  d = ff(d, a, b, c, k[9], 12, 1839030562);
  c = ff(c, d, a, b, k[10], 17, -35309556);
  b = ff(b, c, d, a, k[11], 22, -1530992060);
  a = ff(a, b, c, d, k[12], 7, 1236535329);
  d = ff(d, a, b, c, k[13], 12, -165796510);
  c = ff(c, d, a, b, k[14], 17, -1069501632);
  b = ff(b, c, d, a, k[15], 22, -327891);
  a = gg(a, b, c, d, k[1], 5, -701558691);
  d = gg(d, a, b, c, k[6], 9, 38016083);
  c = gg(c, d, a, b, k[11], 14, -660478335);
  b = gg(b, c, d, a, k[0], 20, -405537848);
  a = gg(a, b, c, d, k[5], 5, 568446438);
  d = gg(d, a, b, c, k[10], 9, -1019803690);
  c = gg(c, d, a, b, k[15], 14, 1873313359);
  b = gg(b, c, d, a, k[4], 20, -30611744);
  a = gg(a, b, c, d, k[9], 5, -1560198380);
  d = gg(d, a, b, c, k[14], 9, 1309151649);
  c = gg(c, d, a, b, k[3], 14, -145523070);
  b = gg(b, c, d, a, k[8], 20, -1120210379);
  a = gg(a, b, c, d, k[13], 5, 718787259);
  d = gg(d, a, b, c, k[2], 9, -343485551);
  c = gg(c, d, a, b, k[7], 14, -57434055);
  b = gg(b, c, d, a, k[12], 20, 1700485571);
  a = hh(a, b, c, d, k[5], 4, -1894986606);
  d = hh(d, a, b, c, k[8], 11, -1051523);
  c = hh(c, d, a, b, k[11], 16, 1873313359);
  b = hh(b, c, d, a, k[14], 23, -30611744);
  a = hh(a, b, c, d, k[1], 4, -1560198380);
  d = hh(d, a, b, c, k[4], 11, 1309151649);
  c = hh(c, d, a, b, k[7], 16, -145523070);
  b = hh(b, c, d, a, k[10], 23, -1120210379);
  a = hh(a, b, c, d, k[13], 4, 718787259);
  d = hh(d, a, b, c, k[0], 11, -343485551);
  c = hh(c, d, a, b, k[3], 16, -57434055);
  b = hh(b, c, d, a, k[6], 23, 1700485571);
  a = hh(a, b, c, d, k[9], 4, -1894986606);
  d = hh(d, a, b, c, k[12], 11, -1051523);
  c = hh(c, d, a, b, k[15], 16, 1873313359);
  b = hh(b, c, d, a, k[2], 23, -30611744);
  a = ii(a, b, c, d, k[0], 6, -1560198380);
  d = ii(d, a, b, c, k[7], 10, 1309151649);
  c = ii(c, d, a, b, k[14], 15, -145523070);
  b = ii(b, c, d, a, k[5], 21, -1120210379);
  a = ii(a, b, c, d, k[12], 6, 718787259);
  d = ii(d, a, b, c, k[3], 10, -343485551);
  c = ii(c, d, a, b, k[10], 15, -57434055);
  b = ii(b, c, d, a, k[1], 21, 1700485571);
  a = ii(a, b, c, d, k[8], 6, -1894986606);
  d = ii(d, a, b, c, k[15], 10, -1051523);
  c = ii(c, d, a, b, k[6], 15, 1873313359);
  b = ii(b, c, d, a, k[13], 21, -30611744);
  a = ii(a, b, c, d, k[4], 6, -1560198380);
  d = ii(d, a, b, c, k[11], 10, 1309151649);
  c = ii(c, d, a, b, k[2], 15, -145523070);
  b = ii(b, c, d, a, k[9], 21, -1120210379);
  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}
function cmn(q, a, b, x, s, t) {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}
function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
function md51(s) {
  const txt = unescape(encodeURIComponent(s));
  let n = txt.length,
    state = [1732584193, -271733879, -1732584194, 271733878],
    i;
  for (i = 64; i <= n; i += 64)
    md5cycle(state, md5blk(txt.substring(i - 64, i)));
  s = txt.substring(i - 64);
  const tail = Array(16).fill(0);
  for (i = 0; i < s.length; i++)
    tail[i >> 2] |= s.charCodeAt(i) << (i % 4 << 3);
  tail[i >> 2] |= 0x80 << (i % 4 << 3);
  if (i > 55) {
    md5cycle(state, tail);
    tail.fill(0);
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}
function md5blk(s) {
  const blocks = [];
  for (let i = 0; i < 64; i += 4)
    blocks[i >> 2] =
      s.charCodeAt(i) +
      (s.charCodeAt(i + 1) << 8) +
      (s.charCodeAt(i + 2) << 16) +
      (s.charCodeAt(i + 3) << 24);
  return blocks;
}
function md5hex(s) {
  return md51(s)
    .map((n) => {
      let out = "";
      for (let j = 0; j < 4; j++)
        out += ("0" + ((n >>> (j * 8)) & 255).toString(16)).slice(-2);
      return out;
    })
    .join("");
}
function add32(a, b) {
  return (a + b) & 0xffffffff;
}

// The small implementation above is retained only for provenance; use this
// independently tested MD5 implementation for the protocol login derivation.
function md5hexCorrect(input) {
  const bytes = [...new TextEncoder().encode(input)],
    bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++)
    bytes.push(i < 4 ? (bitLength >>> (8 * i)) & 255 : 0);
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const constants = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0,
  );
  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const add = (a, b) => (a + b) | 0,
    rotate = (value, count) => (value << count) | (value >>> (32 - count));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = Array.from(
      { length: 16 },
      (_, i) =>
        bytes[offset + i * 4] |
        (bytes[offset + i * 4 + 1] << 8) |
        (bytes[offset + i * 4 + 2] << 16) |
        (bytes[offset + i * 4 + 3] << 24),
    );
    let a = a0,
      b = b0,
      c = c0,
      d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const next = d;
      d = c;
      c = b;
      b = add(
        b,
        rotate(add(add(a, f), add(constants[i], words[g])), shifts[i]),
      );
      a = next;
    }
    a0 = add(a0, a);
    b0 = add(b0, b);
    c0 = add(c0, c);
    d0 = add(d0, d);
  }
  return [a0, b0, c0, d0]
    .map((word) =>
      Array.from({ length: 4 }, (_, i) =>
        ((word >>> (8 * i)) & 255).toString(16).padStart(2, "0"),
      ).join(""),
    )
    .join("");
}

export { md5hexCorrect };
