import {
  CAPACITY_WH,
  calcBudgetWithReserve,
  calcEnergy,
  flowSummary,
  fmtMin,
  freshLabel,
  historyStats,
  mapAttrs,
} from "/core.mjs";
const $ = (id) => document.getElementById(id),
  KEY = {
    ui: "oukitel_ui",
    history: "oukitel_history",
    activity: "oukitel_activity",
  };
const DEMO = {
  soc: 89,
  temp: 28,
  remain: 3180,
  input: 0,
  output: 0,
  acInput: 0,
  dcInput: 0,
  ac: true,
  usb: false,
  dc: false,
  frequency: 50,
  voltage: 230,
  chargeLimit: 100,
  inverter: 106,
  bms: 115,
  updated: new Date(),
};
const DEFAULT = {
  mode: "demo",
  device: null,
  reserve: 8,
  loads: [],
  historyRange: 24,
  textSize: "normal",
  alerts: { enabled: false, threshold: 20, lastAlertAt: 0 },
};
const PRESETS = [
  ["Wi‑Fi роутер", 15, "⌁"],
  ["Ноутбук", 65, "▣"],
  ["Освітлення", 40, "✦"],
  ["Холодильник", 100, "❄"],
  ["Телевізор", 90, "▤"],
  ["Котел", 120, "♨"],
];
const PROFILES = [
  {
    name: "Ніч",
    loads: [
      ["Роутер", 15, "⌁"],
      ["Освітлення", 20, "✦"],
    ],
  },
  {
    name: "Робота",
    loads: [
      ["Роутер", 15, "⌁"],
      ["Ноутбук", 65, "▣"],
      ["Монітор", 35, "▤"],
    ],
  },
  {
    name: "Блекаут",
    loads: [
      ["Роутер", 15, "⌁"],
      ["Холодильник", 100, "❄"],
      ["Освітлення", 40, "✦"],
    ],
  },
  {
    name: "Котел",
    loads: [
      ["Котел", 120, "♨"],
      ["Роутер", 15, "⌁"],
    ],
  },
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const inRange = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : fallback;
};
function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? clone(fallback);
  } catch {
    return clone(fallback);
  }
}
function normalizeLoads(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((load) => load && typeof load === "object")
    .map((load) => ({
      name: String(load.name || "")
        .trim()
        .slice(0, 30),
      w: inRange(load.w, 1, 2400, 0),
      icon: String(load.icon || "⚡").slice(0, 4),
    }))
    .filter((load) => load.name && load.w)
    .slice(0, 48);
}
function normalizeSettings(value) {
  const raw = value && typeof value === "object" ? value : {};
  const device =
    raw.device &&
    typeof raw.device === "object" &&
    /^[A-Za-z0-9_-]{1,96}$/.test(String(raw.device.productKey || "")) &&
    /^[A-Za-z0-9_-]{1,96}$/.test(String(raw.device.deviceKey || ""))
      ? {
          productKey: String(raw.device.productKey),
          deviceKey: String(raw.device.deviceKey),
          productName: String(raw.device.productName || "").slice(0, 100),
        }
      : null;
  return {
    ...clone(DEFAULT),
    mode: raw.mode === "cloud" ? "cloud" : "demo",
    device,
    reserve: inRange(raw.reserve, 0, 30, DEFAULT.reserve),
    loads: normalizeLoads(raw.loads),
    historyRange: [1, 6, 24].includes(Number(raw.historyRange))
      ? Number(raw.historyRange)
      : DEFAULT.historyRange,
    textSize: raw.textSize === "large" ? "large" : "normal",
    alerts: {
      enabled: Boolean(raw.alerts?.enabled),
      threshold: inRange(raw.alerts?.threshold, 5, 50, 20),
      lastAlertAt: inRange(raw.alerts?.lastAlertAt, 0, Date.now(), 0),
    },
  };
}
function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const earliest = Date.now() - 86400000;
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      at: inRange(entry.at, earliest, Date.now(), 0),
      soc: inRange(entry.soc, 0, 100, 0),
      input: inRange(entry.input, 0, 10000, 0),
      output: inRange(entry.output, 0, 10000, 0),
      ac: Boolean(entry.ac),
      usb: Boolean(entry.usb),
      dc: Boolean(entry.dc),
    }))
    .filter((entry) => entry.at)
    .sort((a, b) => a.at - b.at)
    .slice(-360);
}
function normalizeActivity(value) {
  if (!Array.isArray(value)) return [];
  const earliest = Date.now() - 86400000;
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      at: inRange(entry.at, earliest, Date.now(), 0),
      text: String(entry.text || "").slice(0, 140),
    }))
    .filter((entry) => entry.at && entry.text)
    .slice(0, 32);
}
let state = { ...DEMO },
  devices = [],
  settings = normalizeSettings(read(KEY.ui, DEFAULT)),
  history = normalizeHistory(read(KEY.history, [])),
  activity = normalizeActivity(read(KEY.activity, [])),
  refreshing = null,
  lastStored = 0,
  lastDeviceCheck = 0,
  lastOnline = null,
  timer = 0;
const cloud = () => settings.mode === "cloud" && !!chosen(),
  chosen = () =>
    (settings.device &&
      devices.find(
        (d) =>
          d.productKey === settings.device.productKey &&
          d.deviceKey === settings.device.deviceKey,
      )) ||
    settings.device,
  online = () => cloud() && chosen()?.online === true;
const yes = (v) => (v ? "Увімкнено" : "Вимкнено"),
  w = (v) => Math.round(Number(v) || 0) + " W",
  safe = (v) =>
    String(v).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
function save() {
  localStorage.setItem(KEY.ui, JSON.stringify(settings));
  localStorage.setItem(KEY.history, JSON.stringify(history));
  localStorage.setItem(KEY.activity, JSON.stringify(activity));
}
function banner(v) {
  $("banner").textContent = v || "";
  $("banner").classList.toggle("hidden", !v);
}
function toast(v) {
  $("toast").textContent = v;
  $("toast").classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => $("toast").classList.remove("show"), 3000);
}
function confirmAction(message) {
  return window.confirm(message);
}
async function api(path, options = {}) {
  const ctl = new AbortController(),
    timeout = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch("/api" + path, {
        credentials: "same-origin",
        ...options,
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
      }),
      j = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(j.error || "Помилка мережі (" + r.status + ")");
    return j;
  } catch (e) {
    throw Error(
      e.name === "AbortError" ? "Хмара не відповіла за 12 секунд." : e.message,
    );
  } finally {
    clearTimeout(timeout);
  }
}
function go(name) {
  document
    .querySelectorAll(".screen")
    .forEach((x) => x.classList.toggle("active", x.id === name + "Screen"));
  document
    .querySelectorAll(".nav-item")
    .forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function record() {
  if (!online() || Date.now() - lastStored < 240000) return;
  lastStored = Date.now();
  const p = {
      at: lastStored,
      soc: state.soc,
      input: state.input,
      output: state.output,
      ac: state.ac,
      usb: state.usb,
      dc: state.dc,
    },
    old = history.at(-1);
  history = [...history.filter((x) => lastStored - x.at < 864e5), p];
  if (old) {
    const changes = ["ac", "usb", "dc"]
      .filter((k) => old[k] !== p[k])
      .map((k) => k.toUpperCase() + ": " + yes(p[k]));
    if (changes.length)
      activity = [
        { at: lastStored, text: changes.join(" · ") },
        ...activity,
      ].slice(0, 16);
  }
  save();
}
function recordAvailability() {
  if (!cloud()) return;
  const nowOnline = online();
  if (lastOnline !== null && lastOnline !== nowOnline) {
    activity = [
      {
        at: Date.now(),
        text: nowOnline ? "Станція з’явилася онлайн" : "Станція стала офлайн",
      },
      ...activity,
    ].slice(0, 32);
    save();
  }
  lastOnline = nowOnline;
}
function conn() {
  const d = chosen(),
    on = online(),
    stale = state.updated && Date.now() - new Date(state.updated) > 120000;
  for (const id of ["statusDot", "connectionDot"])
    $(id).className = "dot" + (on ? " live" : cloud() && d ? " warn" : "");
  if (!cloud()) {
    $("statusText").textContent = "Демо";
    $("connectionTitle").textContent = "Демо-режим";
    $("connectionCopy").textContent = "Підключіть Wonderfree для LIVE-даних.";
    return;
  }
  if (!d) {
    $("statusText").textContent = "Оберіть станцію";
    $("connectionTitle").textContent = "Станцію не обрано";
    $("connectionCopy").textContent = "Оберіть станцію після входу.";
    return;
  }
  $("statusText").textContent = on
    ? stale
      ? "Дані застаріли"
      : "Підключено · онлайн"
    : "Станція офлайн";
  $("connectionTitle").textContent = on
    ? "Станція підключена й онлайн"
    : "Cloud підключено, станція офлайн";
  $("connectionCopy").textContent = on
    ? "Дані синхронізуються кожні 30 секунд."
    : "Перевірте живлення, Wi‑Fi та інтернет станції.";
}
function render() {
  const d = chosen(),
    f = flowSummary(state.input, state.output),
    r = Math.max(0, Math.min(30, +settings.reserve || 8)),
    planned = settings.loads.reduce((s, x) => s + (+x.w || 0), 0),
    usable = calcEnergy(state.soc) * (1 - r / 100) * 0.88;
  $("soc").textContent = Math.round(state.soc || 0) + "%";
  $("energy").textContent = (calcEnergy(state.soc) / 1000).toFixed(2) + " kWh";
  const pct = Math.max(0, Math.min(100, state.soc || 0));
  $("batteryRing").style.background =
    "conic-gradient(var(--cyan) 0 " + pct + "%,#28415f " + pct + "% 100%)";
  $("powerHeadline").textContent = online()
    ? f.title
    : cloud()
      ? "Станція зараз не в мережі"
      : f.title;
  $("powerSubline").textContent = online()
    ? f.detail
    : cloud()
      ? "Показано останні успішно отримані дані."
      : "Підключіть Wonderfree, щоб побачити реальні дані.";
  $("updatedShort").textContent =
    cloud() && state.updated ? freshLabel(state.updated) : "демо";
  $("remaining").textContent = fmtMin(state.remain);
  $("remainingDetail").textContent =
    state.remain != null ? "за оцінкою станції" : "потрібні LIVE-дані";
  $("inputW").textContent = w(state.input);
  $("outputW").textContent = w(state.output);
  $("inputDetail").textContent =
    "AC " +
    Math.round(state.acInput || 0) +
    " · Solar " +
    Math.round(state.dcInput || 0);
  $("outputDetail").textContent = state.output
    ? "поточне навантаження"
    : "немає навантаження";
  $("netLabel").textContent =
    f.kind === "charging"
      ? "Заряджається"
      : f.kind === "discharging"
        ? "Живить прилади"
        : "Баланс";
  $("netPower").textContent = (f.net > 0 ? "+" : "") + f.net + " W";
  $("netHint").textContent = f.detail;
  $("flowArrow").textContent = f.kind === "discharging" ? "←" : "→";
  $("temperature").textContent = state.temp == null ? "—" : state.temp + "°C";
  $("chargeLimit").textContent =
    state.chargeLimit == null ? "—" : state.chargeLimit + "%";
  $("chargeEta").textContent =
    state.chargingRemain != null
      ? fmtMin(state.chargingRemain)
      : state.input
        ? fmtMin((((100 - (state.soc || 0)) * CAPACITY_WH) / state.input) * 60)
        : "—";
  $("chargeEtaHint").textContent = state.input
    ? "за поточним входом"
    : "потрібен вхід";
  $("deviceModel").textContent = d?.productName || "OUKITEL P2001E PLUS";
  $("productKey").textContent = d?.productKey || "—";
  for (const k of ["ac", "usb", "dc"]) {
    $(k + "State").textContent = yes(state[k]);
    $(k + "Tile").classList.toggle("on", !!state[k]);
    $(k + "ControlCopy").textContent =
      yes(state[k]) + " · перемикається у Wonderfree";
    $(k + "Switch").classList.toggle("on", !!state[k]);
  }
  $("controlDataState").textContent = cloud()
    ? "Остання синхронізація: " + freshLabel(state.updated)
    : "Показано демо-стан";
  $("frequency").textContent =
    state.frequency == null ? "—" : state.frequency + " Hz";
  $("voltage").textContent = state.voltage == null ? "—" : state.voltage + " V";
  $("inverter").textContent =
    state.inverter == null ? "—" : "v" + state.inverter;
  $("bms").textContent = state.bms == null ? "—" : "v" + state.bms;
  $("reserveInput").value = r;
  $("reserveLabel").textContent = r + "%";
  $("usableEnergy").textContent = (usable / 1000).toFixed(2) + " kWh";
  $("reserveCopy").textContent =
    "SOC " + Math.round(state.soc || 0) + "% · резерв " + r + "%";
  $("plannedWatts").textContent = w(planned);
  $("plannedWattsHome").textContent = planned
    ? "План: " + w(planned)
    : "Навантаження не задано";
  $("loadsCount").textContent = settings.loads.length + " приладів";
  const budget = planned
    ? fmtMin(calcBudgetWithReserve(planned, state.soc, r))
    : "Додайте прилад";
  $("budgetTime").textContent = budget;
  $("readyHours").textContent = budget;
  $("readyCopy").textContent = planned
    ? "Зараз у плані " + w(planned) + " з резервом " + r + "%."
    : "Додайте прилади, щоб оцінити ваш резерв.";
  $("planCompare").textContent = !planned
    ? "Додайте прилади, щоб порівнювати план із фактичним виходом."
    : !state.output
      ? "У плані " + w(planned) + ". Фактичного навантаження зараз немає."
      : "План " +
        w(planned) +
        " · фактично " +
        w(state.output) +
        " · різниця " +
        w(Math.abs(planned - state.output)) +
        ".";
  renderLoads();
  renderHistory();
  conn();
  document.body.classList.toggle("large-text", settings.textSize === "large");
}
function renderLoads() {
  $("profileList").innerHTML = PROFILES.map(
    (p) =>
      '<button class="profile" data-profile="' +
      safe(p.name) +
      '">' +
      safe(p.name) +
      "</button>",
  ).join("");
  $("loadsList").innerHTML = settings.loads.length
    ? settings.loads
        .map(
          (x, i) =>
            '<article class="load-row"><span class="load-icon">' +
            safe(x.icon || "⚡") +
            "</span><div><b>" +
            safe(x.name) +
            "</b><small>" +
            w(x.w) +
            '</small></div><button data-remove-load="' +
            i +
            '" aria-label="Видалити">×</button></article>',
        )
        .join("")
    : '<div class="empty-state">Додайте прилади нижче — застосунок підкаже час автономності.</div>';
  $("presetGrid").innerHTML = PRESETS.map(
    (x) =>
      '<button data-preset="' +
      safe(x[0]) +
      '" data-w="' +
      x[1] +
      '" data-icon="' +
      x[2] +
      '"><span>' +
      x[2] +
      "</span>" +
      safe(x[0]) +
      "<small>" +
      x[1] +
      " W</small></button>",
  ).join("");
}
function renderHistory() {
  const entries = history.filter(
      (x) => x.at >= Date.now() - (+settings.historyRange || 24) * 3600000,
    ),
    s = historyStats(entries);
  $("peakInput").textContent = entries.length ? w(s.peakInput) : "—";
  $("peakOutput").textContent = entries.length ? w(s.peakOutput) : "—";
  $("socChange").textContent =
    s.socChange == null
      ? "—"
      : (s.socChange > 0 ? "+" : "") + Math.round(s.socChange) + "%";
  $("historyCount").textContent = entries.length;
  $("historyLead").textContent = entries.length
    ? "Дані зберігаються лише на цьому iPhone та автоматично видаляються через 24 години."
    : "Історія почне збиратися після LIVE-підключення.";
  document
    .querySelectorAll("[data-range]")
    .forEach((x) =>
      x.classList.toggle("active", +x.dataset.range === +settings.historyRange),
    );
  $("activityList").innerHTML = activity.length
    ? activity
        .map(
          (x) =>
            "<div><span>●</span><p>" +
            safe(x.text) +
            "<small>" +
            new Date(x.at).toLocaleString("uk-UA", {
              hour: "2-digit",
              minute: "2-digit",
              day: "2-digit",
              month: "2-digit",
            }) +
            "</small></p></div>",
        )
        .join("")
    : '<div class="empty-state">Тут з’являться важливі зміни: стан виходів, заряд і доступність станції.</div>';
  draw(entries);
}
function draw(data) {
  const c = $("historyChart"),
    x = c.getContext("2d"),
    W = c.width,
    H = c.height;
  x.fillStyle = "#091629";
  x.fillRect(0, 0, W, H);
  for (let i = 1; i < 4; i++) {
    x.strokeStyle = "rgba(255,255,255,.08)";
    x.beginPath();
    x.moveTo(0, (H * i) / 4);
    x.lineTo(W, (H * i) / 4);
    x.stroke();
  }
  if (data.length < 2) {
    x.fillStyle = "#9babbe";
    x.font = "16px system-ui";
    x.textAlign = "center";
    x.fillText("Поки що немає достатньо LIVE-даних", W / 2, H / 2);
    return;
  }
  const line = (k, max, color) => {
    x.strokeStyle = color;
    x.lineWidth = 4;
    x.lineJoin = "round";
    x.beginPath();
    data.forEach((p, i) => {
      const px = (i * W) / (data.length - 1),
        py = H - 16 - (Math.max(0, p[k] || 0) / max) * (H - 32);
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.stroke();
  };
  line("soc", 100, "#23e6d1");
  const max = Math.max(
    100,
    ...data.map((p) => Math.max(p.input || 0, p.output || 0)),
  );
  line("input", max, "#79a5ff");
  line("output", max, "#ffb36a");
}
async function devicesLoad({ force = false } = {}) {
  if (!force && devices.length && Date.now() - lastDeviceCheck < 120000) return;
  const j = await api("/devices");
  devices = j.devices || [];
  lastDeviceCheck = Date.now();
  const s = $("deviceSelect");
  s.innerHTML = "";
  if (!devices.length) {
    s.add(new Option("Немає прив’язаних станцій", ""));
    s.disabled = true;
    recordAvailability();
    return;
  }
  devices.forEach((d) => {
    const o = new Option(
      (d.deviceName || d.productName) + " — " + (d.productName || d.productKey),
      d.productKey + "|" + d.deviceKey,
    );
    o.selected = settings.device?.deviceKey === d.deviceKey;
    s.add(o);
  });
  s.disabled = false;
  recordAvailability();
}
async function lowAlert() {
  const a = settings.alerts || {};
  if (
    !a.enabled ||
    !online() ||
    +state.soc > +a.threshold ||
    Date.now() - (+a.lastAlertAt || 0) < 216e5
  )
    return;
  settings.alerts.lastAlertAt = Date.now();
  save();
  const msg = "Заряд P2001E Plus: " + Math.round(state.soc) + "%";
  toast(msg);
  if ("Notification" in window && Notification.permission === "granted")
    new Notification("OUKITEL Home", { body: msg, icon: "/icon-192.png" });
}
async function refresh({ forceDevices = false } = {}) {
  if (!cloud()) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    $("refreshBtn").textContent = "Оновлення…";
    try {
      await devicesLoad({ force: forceDevices });
      if (!online()) {
        banner("Cloud підключено, але станція офлайн. Показано останні дані.");
        render();
        return;
      }
      const d = chosen(),
        j = await api(
          "/state?" +
            new URLSearchParams({ pk: d.productKey, dk: d.deviceKey }),
        );
      state = { ...mapAttrs(j, state), updated: new Date() };
      record();
      await lowAlert();
      banner("");
      render();
    } catch (e) {
      banner("LIVE недоступний: " + e.message + ". Показано останні дані.");
      render();
    } finally {
      $("refreshBtn").textContent = "Оновити";
      refreshing = null;
    }
  })();
  return refreshing;
}
async function login() {
  const email = $("email").value.trim(),
    password = $("password").value;
  $("loginStatus").textContent = "Вхід…";
  try {
    if (!email || !password) throw Error("Введіть email і пароль Wonderfree.");
    const j = await api("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    $("password").value = "";
    devices = j.devices || [];
    $("loginStatus").className = "login-status good";
    $("loginStatus").textContent =
      "Успішно. Знайдено станцій: " + devices.length + ".";
    await devicesLoad();
  } catch (e) {
    $("loginStatus").className = "login-status bad";
    $("loginStatus").textContent = e.message;
  }
}
function settingsOpen() {
  $("modeSelect").value = settings.mode;
  $("textSizeSelect").value = settings.textSize || "normal";
  $("alertEnabled").checked = !!settings.alerts?.enabled;
  $("alertThreshold").value = settings.alerts?.threshold || 20;
  $("alertThresholdValue").textContent = $("alertThreshold").value + "%";
  $("loginStatus").textContent = "";
  conn();
  if (settings.mode === "cloud")
    devicesLoad()
      .then(conn)
      .catch(() => {});
  $("settingsDialog").showModal();
}
function info(k) {
  $("infoContent").innerHTML =
    k === "flow"
      ? '<p class="eyebrow">ЯК ЧИТАТИ ЕКРАН</p><h2>Потік енергії</h2><p><b>Вхід</b> — мережа або сонячні панелі. <b>Вихід</b> — споживання приладів. Різниця показує заряджання чи розряджання.</p><p>Час роботи — оцінка, яка змінюється разом із навантаженням.</p>'
      : '<p class="eyebrow">ДІАГНОСТИКА</p><h2>Що означають цифри</h2><p><b>Частота й напруга</b> — параметри AC-виходу. <b>Inverter</b> і <b>BMS</b> — довідкові версії модулів для підтримки.</p><p>Коли станція офлайн, це останні отримані значення.</p>';
  $("infoDialog").showModal();
}
function backup() {
  const data = JSON.stringify(
      {
        version: 3,
        exportedAt: new Date().toISOString(),
        settings: { ...settings, device: null },
        history,
        activity,
      },
      null,
      2,
    ),
    url = URL.createObjectURL(new Blob([data], { type: "application/json" })),
    a = document.createElement("a");
  a.href = url;
  a.download = "oukitel-home-backup.json";
  a.click();
  URL.revokeObjectURL(url);
  toast("Експорт готовий.");
}
function restore(file) {
  if (!file) return;
  if (file.size > 1024 * 1024) {
    toast("Файл завеликий. Максимальний розмір backup — 1 MB.");
    return;
  }
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(String(r.result));
      if (!d || typeof d !== "object" || ![3, undefined].includes(d.version))
        throw Error();
      const currentDevice = settings.device;
      settings = normalizeSettings({ ...d.settings, device: currentDevice });
      history = normalizeHistory(d.history);
      activity = normalizeActivity(d.activity);
      save();
      render();
      toast("Плани та історію імпортовано.");
    } catch {
      toast("Не вдалося прочитати цей файл.");
    }
  };
  r.readAsText(file);
}
function bind() {
  $("settingsBtn").onclick = settingsOpen;
  $("refreshBtn").onclick = () => refresh({ forceDevices: true });
  document
    .querySelectorAll("[data-tab]")
    .forEach((x) => (x.onclick = () => go(x.dataset.tab)));
  document
    .querySelectorAll("[data-info]")
    .forEach((x) => (x.onclick = () => info(x.dataset.info)));
  $("loginBtn").onclick = login;
  $("saveBtn").onclick = () => {
    const [pk, dk] = $("deviceSelect").value.split("|");
    settings.mode = $("modeSelect").value;
    settings.device =
      devices.find((d) => d.productKey === pk && d.deviceKey === dk) || null;
    settings.textSize = $("textSizeSelect").value;
    settings.alerts = {
      ...settings.alerts,
      enabled: $("alertEnabled").checked,
      threshold: +$("alertThreshold").value,
    };
    settings = normalizeSettings(settings);
    save();
    $("settingsDialog").close();
    render();
    refresh();
  };
  $("alertEnabled").onchange = async (e) => {
    if (
      e.target.checked &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      const p = await Notification.requestPermission();
      if (p !== "granted") {
        e.target.checked = false;
        toast("iPhone не дозволив сповіщення.");
      }
    }
  };
  $("logoutBtn").onclick = async () => {
    if (
      !confirmAction(
        "Вийти з Cloud? Локальні плани й історія залишаться на цьому iPhone.",
      )
    )
      return;
    try {
      await api("/logout", { method: "POST", body: "{}" });
    } catch {}
    devices = [];
    settings = normalizeSettings({
      ...DEFAULT,
      reserve: settings.reserve,
      loads: settings.loads,
      textSize: settings.textSize,
    });
    state = { ...DEMO, updated: new Date() };
    save();
    $("settingsDialog").close();
    render();
    toast("Cloud-сесію завершено.");
  };
  $("reserveInput").oninput = (e) => {
    settings.reserve = +e.target.value;
    save();
    render();
  };
  $("profileList").onclick = (e) => {
    const b = e.target.closest("[data-profile]"),
      p = PROFILES.find((x) => x.name === b?.dataset.profile);
    if (!p) return;
    settings.loads = p.loads.map((x) => ({ name: x[0], w: x[1], icon: x[2] }));
    save();
    render();
    toast("Сценарій «" + p.name + "» застосовано.");
  };
  $("presetGrid").onclick = (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    settings.loads.push({
      name: b.dataset.preset,
      w: +b.dataset.w,
      icon: b.dataset.icon,
    });
    save();
    render();
  };
  $("addCustomLoad").onclick = () => {
    const n = $("customLoadName").value.trim(),
      v = +$("customLoadW").value;
    if (!n || !Number.isFinite(v) || v < 1 || v > 2400) {
      toast("Введіть назву і потужність від 1 до 2400 W.");
      return;
    }
    settings.loads.push({ name: n, w: Math.round(v), icon: "⚡" });
    $("customLoadName").value = "";
    $("customLoadW").value = "";
    save();
    render();
  };
  $("loadsList").onclick = (e) => {
    const b = e.target.closest("[data-remove-load]");
    if (!b) return;
    settings.loads.splice(+b.dataset.removeLoad, 1);
    save();
    render();
  };
  $("clearLoadsBtn").onclick = () => {
    if (!confirmAction("Стерти всі прилади з плану?")) return;
    settings.loads = [];
    save();
    render();
  };
  $("historyRange").onclick = (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    settings.historyRange = +b.dataset.range;
    save();
    renderHistory();
  };
  $("clearHistoryBtn").onclick = () => {
    if (!confirmAction("Стерти всю локальну історію та журнал подій?")) return;
    history = [];
    activity = [];
    save();
    renderHistory();
    toast("Локальну історію стерто.");
  };
  $("alertThreshold").oninput = (e) =>
    ($("alertThresholdValue").textContent = e.target.value + "%");
  $("exportBtn").onclick = backup;
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = (e) => restore(e.target.files[0]);
  $("clearDataBtn").onclick = () => {
    if (
      !confirmAction(
        "Стерти всі локальні плани, історію та журнал подій? Це неможливо скасувати.",
      )
    )
      return;
    history = [];
    activity = [];
    settings.loads = [];
    save();
    render();
    toast("Локальні плани й історію стерто.");
  };
  document.querySelector(".dialog-close").onclick = () =>
    $("infoDialog").close();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener("focus", refresh);
}
bind();
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
render();
if (settings.mode === "cloud")
  devicesLoad()
    .then(refresh)
    .catch(() => banner("Сесію завершено. Увійдіть знову."));
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
