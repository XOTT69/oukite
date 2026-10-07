import {
  adaptiveForecast,
  calcBudgetWithReserve,
  calcEnergy,
  chargeEstimate,
  connectionState,
  emptyState,
  energyFromSamples,
  flowSummary,
  fmtMin,
  freshLabel,
  historyStats,
  mapAttrs,
  usableEnergy,
} from "/core.mjs?v=3.0.0";
const $ = (id) => document.getElementById(id),
  KEY = "oukitel_ui",
  VERSION = "3.0.0";
const clone = (x) => JSON.parse(JSON.stringify(x));
const safe = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const finite = (v, lo, hi, fallback = null) =>
  v != null &&
  v !== "" &&
  Number.isFinite(Number(v)) &&
  Number(v) >= lo &&
  Number(v) <= hi
    ? Number(v)
    : fallback;
const uid = () => crypto.randomUUID();
const w = (v) => (v == null ? "—" : Math.round(v) + " Вт");
const wh = (v) =>
  v == null
    ? "—"
    : (v / 1000).toLocaleString("uk-UA", { maximumFractionDigits: 2 }) +
      " кВт·год";
const yes = (v) => (v == null ? "Невідомо" : v ? "Увімкнено" : "Вимкнено");
const icon = (name) =>
  '<svg class="icon" aria-hidden="true"><use href="#i-' +
  ([
    "bolt",
    "router",
    "laptop",
    "light",
    "fridge",
    "tv",
    "heat",
    "trash",
  ].includes(name)
    ? name
    : "bolt") +
  '"/></svg>';
const PRESETS = [
  ["Wi‑Fi роутер", 15, "router"],
  ["Ноутбук", 65, "laptop"],
  ["Освітлення", 40, "light"],
  ["Холодильник", 100, "fridge"],
  ["Телевізор", 90, "tv"],
  ["Котел", 120, "heat"],
];
const PROFILES = [
  {
    name: "Ніч",
    loads: [
      ["Роутер", 15, "router"],
      ["Освітлення", 20, "light"],
    ],
  },
  {
    name: "Робота",
    loads: [
      ["Роутер", 15, "router"],
      ["Ноутбук", 65, "laptop"],
    ],
  },
  {
    name: "Блекаут",
    loads: [
      ["Роутер", 15, "router"],
      ["Холодильник", 100, "fridge"],
      ["Освітлення", 40, "light"],
    ],
  },
  {
    name: "Котел",
    loads: [
      ["Котел", 120, "heat"],
      ["Роутер", 15, "router"],
    ],
  },
];
const DEFAULT = {
  mode: "demo",
  device: null,
  accountId: null,
  reserve: 8,
  loads: [],
  profiles: [],
  historyRange: 24,
  textSize: "normal",
  alerts: { enabled: false, threshold: 20, lastAlertAt: 0 },
  calibration: null,
};
const DEMO = {
  ...emptyState(),
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
};
function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? clone(fallback);
  } catch {
    return clone(fallback);
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    banner("Не вдалося зберегти дані на пристрої. Експортуйте важливі плани.");
  }
}
function normalizeLoads(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && typeof x === "object")
    .slice(0, 48)
    .map((x) => ({
      id: typeof x.id === "string" ? x.id.slice(0, 64) : uid(),
      name: String(x.name || "")
        .trim()
        .slice(0, 40),
      w: finite(x.w, 1, 2400, 0),
      averageW: finite(x.averageW, 0, 2400),
      icon: ["router", "laptop", "light", "fridge", "tv", "heat"].includes(
        x.icon,
      )
        ? x.icon
        : "bolt",
      active: x.active !== false,
      calibratedAt: finite(x.calibratedAt, 0, Date.now()),
    }))
    .filter((x) => x.name && x.w);
}
function normalizeSettings(raw = {}) {
  const d = raw.device,
    valid =
      d &&
      /^[A-Za-z0-9_-]{1,96}$/.test(d.productKey || "") &&
      /^[A-Za-z0-9_-]{1,96}$/.test(d.deviceKey || ""),
    loads = normalizeLoads(raw.loads);
  const c = raw.calibration,
    cal =
      c &&
      loads.some((x) => x.id === c.loadId) &&
      finite(c.startedAt, Date.now() - 7 * 864e5, Date.now());
  return {
    ...clone(DEFAULT),
    mode: raw.mode === "cloud" ? "cloud" : "demo",
    device: valid
      ? {
          productKey: d.productKey,
          deviceKey: d.deviceKey,
          productName: String(d.productName || "").slice(0, 100),
        }
      : null,
    accountId: /^[a-f0-9]{64}$/.test(raw.accountId || "")
      ? raw.accountId
      : null,
    reserve: finite(raw.reserve, 0, 30, 8),
    loads,
    profiles: (Array.isArray(raw.profiles) ? raw.profiles : [])
      .slice(0, 12)
      .map((p) => ({
        name: String(p.name || "").slice(0, 30),
        loads: normalizeLoads(p.loads),
      }))
      .filter((p) => p.name),
    historyRange: [1, 6, 24, 168, 720].includes(Number(raw.historyRange))
      ? Number(raw.historyRange)
      : 24,
    textSize: raw.textSize === "large" ? "large" : "normal",
    alerts: {
      enabled: raw.alerts?.enabled === true,
      threshold: finite(raw.alerts?.threshold, 5, 50, 20),
      lastAlertAt: finite(raw.alerts?.lastAlertAt, 0, Date.now(), 0),
    },
    calibration: cal
      ? { loadId: c.loadId, startedAt: Number(c.startedAt) }
      : null,
  };
}
function normalizeHistory(raw) {
  return [
    ...new Map(
      (Array.isArray(raw) ? raw : [])
        .filter(
          (x) =>
            x &&
            finite(x.at, Date.now() - 31 * 864e5, Date.now() + 60000) &&
            finite(x.soc, 0, 100) != null &&
            finite(x.input, 0, 10000) != null &&
            finite(x.output, 0, 10000) != null,
        )
        .map((x) => [
          Number(x.at),
          {
            at: Number(x.at),
            soc: Number(x.soc),
            input: Number(x.input),
            output: Number(x.output),
            ...Object.fromEntries(
              ["ac", "usb", "dc"]
                .filter((k) => typeof x[k] === "boolean")
                .map((k) => [k, x[k]]),
            ),
          },
        ]),
    ).values(),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-20000);
}
let settings = normalizeSettings(read(KEY, DEFAULT)),
  devices = [],
  history = [],
  activity = [],
  state = emptyState(),
  phase = settings.mode === "cloud" ? "connecting" : "idle",
  monitor = { enabled: false, state: "disabled" },
  refreshing = null,
  monitorLoadedAt = 0,
  toastTimer,
  currentTab = "home",
  editId = null,
  waitingWorker = null,
  updateRequested = false;
const cloud = () => settings.mode === "cloud";
const chosen = () =>
  devices.find(
    (d) =>
      d.productKey === settings.device?.productKey &&
      d.deviceKey === settings.device?.deviceKey,
  ) || settings.device;
const scope = () =>
  settings.accountId && settings.device
    ? "oukitel_data:" +
      settings.accountId +
      ":" +
      settings.device.productKey +
      ":" +
      settings.device.deviceKey
    : null;
function loadData() {
  const data = scope() ? read(scope(), {}) : {};
  history = normalizeHistory(data.history);
  activity = (Array.isArray(data.activity) ? data.activity : [])
    .filter((x) => x && Number.isFinite(x.at) && typeof x.text === "string")
    .slice(0, 32);
  const s = data.snapshot;
  state =
    cloud() && s?.updated && finite(s.soc, 0, 100) != null
      ? { ...emptyState(), ...s }
      : cloud()
        ? emptyState()
        : { ...DEMO };
}
loadData();
function save() {
  write(KEY, settings);
  if (scope() && cloud())
    write(scope(), { history, activity, snapshot: state });
}
function banner(v) {
  $("banner").textContent = v || "";
  $("banner").classList.toggle("hidden", !v);
}
function toast(v) {
  $("toast").textContent = v;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 4000);
}
const status = () =>
  connectionState({
    mode: settings.mode,
    device: chosen(),
    online: chosen()?.online ?? null,
    phase,
    updated: state.updated,
    reportedAt: state.reportedAt,
  });
const canMeasure = () =>
  cloud() &&
  phase === "ready" &&
  state.updated != null &&
  Date.now() - Number(state.updated) <= 2 * 60000 &&
  chosen()?.online !== false &&
  (chosen()?.online === true ||
    (state.reportedAt && Date.now() - state.reportedAt <= 12 * 60000)) &&
  (!state.reportedAt || Date.now() - state.reportedAt <= 12 * 60000);
async function api(path, options = {}) {
  const ctl = new AbortController(),
    timeout = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch("/api" + path, {
        credentials: "same-origin",
        ...options,
        signal: ctl.signal,
        headers: { "content-type": "application/json", ...options.headers },
      }),
      j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error || "Помилка сервера (" + r.status + ")");
      e.status = r.status;
      throw e;
    }
    return j;
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error("Хмара не відповіла за 25 секунд.");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
function go(name) {
  currentTab = name;
  document
    .querySelectorAll(".screen")
    .forEach((x) => x.classList.toggle("active", x.id === name + "Screen"));
  document.querySelectorAll(".nav-item").forEach((x) => {
    const a = x.dataset.tab === name;
    x.classList.toggle("active", a);
    a
      ? x.setAttribute("aria-current", "page")
      : x.removeAttribute("aria-current");
  });
  window.scrollTo({
    top: 0,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
  if (name === "history") renderHistory();
}
const STATUS = {
  demo: [
    "Демо",
    "Демонстраційні показники",
    "Підключіть Wonderfree, щоб отримати дані своєї станції.",
  ],
  "auth-required": [
    "Потрібен вхід",
    "Сесія завершилась",
    "Увійдіть знову. Це не означає, що станція офлайн.",
  ],
  "select-device": [
    "Оберіть станцію",
    "Підключення станції",
    "Увійдіть і виберіть прив’язану до акаунта станцію.",
  ],
  connecting: [
    "Перевіряємо",
    "Підключаємося до хмари",
    "Чекаємо відповідь. Попередні показники не є LIVE-даними.",
  ],
  waiting: [
    "Чекаємо дані",
    "Ще немає вимірювань",
    "Оновіть показники або перевірте Wonderfree.",
  ],
  offline: [
    "Станція офлайн",
    "Хмара повідомляє: офлайн",
    "Останні показники можуть бути збереженими. Перевірте станцію у Wonderfree.",
  ],
  online: [
    "Станція онлайн",
    "Станція доступна у хмарі",
    "Статус перевірено під час останньої синхронізації.",
  ],
  unknown: [
    "Статус невідомий",
    "Показники отримано з хмари",
    "Хмара не передала однозначного статусу. Це не підтверджений офлайн.",
  ],
  stale: [
    "Дані застаріли",
    "Потрібне оновлення",
    "Це останні отримані показники, а не поточний стан.",
  ],
  "cloud-error": [
    "Помилка хмари",
    "Не вдалося синхронізувати",
    "Станція може бути онлайн. Повторіть перевірку.",
  ],
  "phone-offline": [
    "Телефон без інтернету",
    "Показано збережені дані",
    "Доступність станції перевірити неможливо. Серверний збір може продовжуватися.",
  ],
};
function renderConnection() {
  const key = status(),
    [label, title, copy] = STATUS[key];
  $("statusText").textContent = label;
  $("connectionTitle").textContent = title;
  $("connectionCopy").textContent = copy;
  ["statusDot", "connectionDot"].forEach(
    (id) =>
      ($(id).className =
        "dot" +
        (key === "online"
          ? " live"
          : ["demo", "connecting"].includes(key)
            ? ""
            : " warn")),
  );
  $("powerHeadline").textContent =
    key === "online" && state.input != null && state.output != null
      ? flowSummary(state.input, state.output).title
      : title;
  $("powerSubline").textContent =
    key === "online"
      ? state.reportedAt
        ? "Виміряно: " + freshLabel(state.reportedAt)
        : "Час вимірювання хмара не передає."
      : copy;
  $("updatedShort").textContent = cloud()
    ? "Отримано: " + freshLabel(state.updated)
    : "Приклад · не ваша станція";
  $("connectBtn").classList.toggle(
    "hidden",
    cloud() && !["auth-required", "select-device"].includes(key),
  );
  $("refreshBtn").disabled = !!refreshing || !cloud() || !chosen();
  $("refreshBtn").textContent = refreshing ? "Перевіряємо…" : "Оновити";
  $("monitorHome").textContent =
    monitor.state === "auth-required"
      ? "Фоновий збір: потрібен повторний вхід"
      : monitor.enabled
        ? monitor.lastError
          ? "Фоновий збір призупинено: " + monitor.lastError
          : "Фоновий збір · кожні 5 хв · " + freshLabel(monitor.lastSampleAt)
        : "Фоновий збір не активний";
}
const forecastNow = () =>
  adaptiveForecast(canMeasure() ? history : [], state.soc, settings.reserve, 0);
const plannedWatts = () =>
  settings.loads
    .filter((x) => x.active)
    .reduce((s, x) => s + (x.averageW ?? x.w), 0);
function render() {
  document.body.classList.toggle("large-text", settings.textSize === "large");
  const f =
      state.input != null && state.output != null
        ? flowSummary(state.input, state.output)
        : null,
    planned = plannedWatts(),
    forecast = forecastNow(),
    planMinutes = calcBudgetWithReserve(planned, state.soc, settings.reserve);
  const minutes =
    forecast.source === "measured"
      ? forecast.minutes
      : canMeasure()
        ? calcBudgetWithReserve(state.output, state.soc, settings.reserve)
        : null;
  $("soc").textContent = state.soc == null ? "—" : Math.round(state.soc) + "%";
  $("energy").textContent =
    state.soc == null ? "Ще немає даних" : wh(calcEnergy(state.soc));
  const pct = state.soc == null ? 0 : Math.max(0, Math.min(100, state.soc));
  $("batteryRing").style.background =
    "conic-gradient(var(--cyan) 0 " + pct + "%,var(--line) " + pct + "% 100%)";
  $("readyHours").textContent = fmtMin(minutes);
  $("readyCopy").textContent = cloud()
    ? minutes != null
      ? (forecast.source === "measured"
          ? "За середнім " + w(forecast.watts)
          : "За поточними " + w(state.output) + " · цикли ще не враховано") +
        " · без подальшого заряджання · до резерву " +
        settings.reserve +
        "%."
      : "Для актуального прогнозу потрібні доступна станція та вимірювання."
    : "Підключіть станцію для фактичного прогнозу.";
  $("homeForecastEta").textContent =
    minutes != null && minutes > 0 && minutes < 525600
      ? "Орієнтовно до " +
        new Date(Date.now() + minutes * 60000).toLocaleString("uk-UA", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : minutes === 0
        ? "Досягнуто обраного резерву"
        : "";
  $("inputW").textContent = w(state.input);
  $("outputW").textContent = w(state.output);
  $("inputDetail").textContent =
    "AC " + w(state.acInput) + " · сонце/DC " + w(state.dcInput);
  $("outputDetail").textContent =
    state.output == null
      ? "Ще немає вимірювання"
      : state.output
        ? "Сумарне споживання приладів"
        : "Зараз без навантаження";
  $("netLabel").textContent = "Баланс входу / виходу";
  $("netPower").textContent = f ? (f.net > 0 ? "+" : "") + w(f.net) : "—";
  $("netHint").textContent = f
    ? f.detail
    : "Потрібні показники входу та виходу";
  $("flowArrow").textContent = f?.kind === "discharging" ? "←" : "→";
  $("remaining").textContent = fmtMin(state.remain);
  $("remainingDetail").textContent =
    "Окрема оцінка станції · може відрізнятися";
  $("temperature").textContent = state.temp == null ? "—" : state.temp + " °C";
  $("chargeLimit").textContent =
    state.chargeLimit == null ? "—" : state.chargeLimit + "%";
  const charge =
    state.chargingRemain ??
    chargeEstimate(state.soc, state.input, state.output);
  $("chargeEta").textContent = fmtMin(charge);
  $("chargeEtaHint").textContent =
    state.chargingRemain != null
      ? "Оцінка станції"
      : charge != null
        ? "Приблизно · з урахуванням виходу"
        : "Немає заряджання або даних";
  $("deviceModel").textContent = chosen()?.productName || "OUKITEL P2001E PLUS";
  $("productKey").textContent = chosen()?.productKey || "—";
  for (const k of ["ac", "usb", "dc"]) {
    $(k + "State").textContent = yes(state[k]);
    $(k + "Tile").classList.toggle("on", state[k] === true);
    $(k + "ControlCopy").textContent = "Перемикання — у Wonderfree";
    $(k + "Switch").textContent = yes(state[k]);
    $(k + "Switch").classList.toggle("on", state[k] === true);
  }
  $("controlDataState").textContent = cloud()
    ? "Отримано: " + freshLabel(state.updated) + " · " + STATUS[status()][0]
    : "Приклад · не ваша станція";
  for (const [k, suffix] of [
    ["frequency", " Гц"],
    ["voltage", " В"],
    ["inverter", ""],
    ["bms", ""],
  ])
    $(k).textContent =
      state[k] == null
        ? "—"
        : (["inverter", "bms"].includes(k) ? "v" : "") + state[k] + suffix;
  $("reserveInput").value = settings.reserve;
  $("reserveLabel").textContent = settings.reserve + "%";
  $("usableEnergy").textContent = wh(usableEnergy(state.soc, settings.reserve));
  $("reserveCopy").textContent =
    "Заряд " + (state.soc ?? "—") + "% · резерв " + settings.reserve + "%";
  $("plannedWatts").textContent = w(planned);
  $("plannedWattsHome").textContent = planned
    ? "Ваш сценарій: " + w(planned)
    : "Сплануйте навантаження";
  $("loadsCount").textContent =
    "Активних приладів: " + settings.loads.filter((x) => x.active).length;
  $("budgetTime").textContent = !planned
    ? "Додайте прилад"
    : fmtMin(planMinutes);
  $("forecastLabel").textContent = "Якщо працює ваш план";
  $("forecastRange").textContent =
    state.soc == null
      ? "Спершу підключіть станцію для реального заряду."
      : cloud() && !canMeasure()
        ? "За останнім зарядом; актуальність не підтверджена."
        : "План незалежний від фактичного навантаження.";
  $("planCompare").textContent = planned
    ? "За сценарієм " +
      fmtMin(planMinutes) +
      " · зараз на виході " +
      w(state.output) +
      "."
    : "Додайте прилади, виміряйте середнє й збережіть власний сценарій.";
  renderAdaptive(forecast);
  renderLoads();
  renderHistory();
  renderConnection();
}
function renderLoads() {
  const profiles = [...PROFILES, ...settings.profiles],
    pm = profiles
      .map(
        (p, i) =>
          '<button class="profile" data-profile="' +
          i +
          '">' +
          safe(p.name) +
          "</button>",
      )
      .join("");
  if ($("profileList").innerHTML !== pm) $("profileList").innerHTML = pm;
  const markup =
    settings.loads
      .map(
        (x) =>
          '<article class="load-row ' +
          (x.active ? "" : "inactive") +
          '"><label class="load-enabled"><input type="checkbox" data-active-load="' +
          safe(x.id) +
          '" ' +
          (x.active ? "checked" : "") +
          ' aria-label="Враховувати ' +
          safe(x.name) +
          ' у плані"/>' +
          icon(x.icon) +
          "</label><div><b>" +
          safe(x.name) +
          "</b><small>" +
          (x.averageW != null ? "Середнє " + w(x.averageW) + " · " : "") +
          "Номінал " +
          w(x.w) +
          '</small><div class="load-actions"><button data-calibrate-load="' +
          safe(x.id) +
          '">Виміряти</button><button data-edit-load="' +
          safe(x.id) +
          '">Редагувати</button></div></div><button class="remove-load" data-remove-load="' +
          safe(x.id) +
          '" aria-label="Видалити ' +
          safe(x.name) +
          '">' +
          icon("trash") +
          "</button></article>",
      )
      .join("") ||
    '<div class="empty-state">Додайте перший прилад. Паспортні Вт можна замінити виміряним середнім.</div>';
  const fingerprint = JSON.stringify(settings.loads);
  if ($("loadsList").dataset.fingerprint !== fingerprint) {
    $("loadsList").innerHTML = markup;
    $("loadsList").dataset.fingerprint = fingerprint;
  }
  if (!$("presetGrid").children.length)
    $("presetGrid").innerHTML = PRESETS.map(
      (x, i) =>
        '<button data-preset="' +
        i +
        '">' +
        icon(x[2]) +
        "<span>" +
        safe(x[0]) +
        "</span><small>" +
        w(x[1]) +
        "</small></button>",
    ).join("");
}
function calibrationForecast() {
  const c = settings.calibration;
  return c
    ? adaptiveForecast(
        history.filter((x) => x.at >= c.startedAt),
        state.soc,
        settings.reserve,
        0,
      )
    : null;
}
function renderAdaptive(forecast) {
  const labels = {
    low: "Мало даних",
    medium: "Попередня оцінка",
    high: "Добова база",
  };
  $("confidenceBadge").textContent = labels[forecast.confidence];
  $("confidenceBadge").className =
    "confidence-badge " +
    (forecast.confidence === "high"
      ? "good"
      : forecast.confidence === "medium"
        ? "medium"
        : "");
  $("adaptiveTitle").textContent =
    forecast.source === "measured"
      ? "Середнє споживання: " + w(forecast.watts)
      : monitor.enabled
        ? "Збираємо вимірювання"
        : "Навчання споживання";
  $("adaptiveCopy").textContent =
    forecast.source === "measured"
      ? "За останні 24 год: " +
        fmtMin(forecast.coveredMs / 60000) +
        " вимірювань, орієнтовно " +
        Math.round(forecast.energyWh) +
        " Вт·год. Покриття " +
        Math.round(forecast.coverage * 100) +
        "%. Нульові проміжки враховані."
      : monitor.lastError ||
        (monitor.enabled
          ? "Потрібна година достатньо повних даних. Для холодильника краще 6–24 години."
          : "Увімкніть фоновий збір. Сервер читає загальне навантаження кожні 5 хвилин, навіть коли застосунок закритий.");
  $("adaptiveTime").textContent =
    forecast.source === "measured" ? fmtMin(forecast.minutes) : "—";
  $("adaptiveRange").textContent =
    forecast.source === "measured" && forecast.minutes != null
      ? "Орієнтовний діапазон: " +
        fmtMin(forecast.conservativeMinutes) +
        " — " +
        fmtMin(forecast.optimisticMinutes) +
        ". Це сценарна оцінка, не гарантія."
      : "П’ятихвилинні точки можуть пропускати короткі цикли. Оцінка не замінює окремий лічильник.";
  const c = settings.calibration,
    target = c && settings.loads.find((x) => x.id === c.loadId),
    cf = calibrationForecast();
  if (!target) {
    $("calibrationBox").innerHTML =
      "<p>Для вимірювання одного приладу залиште на станції лише його. Натисніть «Виміряти» біля приладу.</p>";
    return;
  }
  const ready = cf.coveredMs >= 6 * 36e5 && cf.coverage >= 0.8 && cf.fresh,
    html =
      "<p><b>" +
      safe(target.name) +
      "</b> · покрито " +
      fmtMin(cf.coveredMs / 60000) +
      " із потрібних 6 год. Інші прилади та власні втрати станції впливають на результат.</p>" +
      (ready
        ? '<button id="applyCalibrationBtn" class="secondary-button">Зберегти середнє ' +
          w(cf.measuredWatts) +
          "</button>"
        : "") +
      '<button id="cancelCalibrationBtn" class="text-button">Скасувати вимірювання</button>';
  if ($("calibrationBox").innerHTML !== html)
    $("calibrationBox").innerHTML = html;
}
function renderHistory() {
  const entries = history.filter(
      (x) => x.at >= Date.now() - settings.historyRange * 36e5,
    ),
    s = historyStats(entries),
    energy = energyFromSamples(entries);
  $("peakInput").textContent = entries.length ? w(s.peakInput) : "—";
  $("peakOutput").textContent = entries.length ? w(s.peakOutput) : "—";
  $("socChange").textContent =
    s.socChange == null
      ? "—"
      : (s.socChange > 0 ? "+" : "") + Math.round(s.socChange) + "%";
  $("historyCount").textContent = entries.length;
  $("historyLead").textContent = entries.length
    ? "Історія лише обраної станції. Пропуски не заповнюються вигаданими даними."
    : monitor.enabled
      ? "Фоновий збір активний. Чекаємо перші вимірювання."
      : "Підключіть станцію та увімкніть фоновий збір.";
  $("historyEnergy").textContent = entries.length ? wh(energy.wh) : "—";
  $("historyCoverage").textContent =
    "Покрито " + fmtMin(energy.coveredMs / 60000) + " · енергія приблизна";
  document.querySelectorAll("[data-range]").forEach((x) => {
    const a = +x.dataset.range === settings.historyRange;
    x.classList.toggle("active", a);
    x.setAttribute("aria-pressed", String(a));
  });
  $("graphSummary").textContent = entries.length
    ? entries.length +
      " вимірювань. Пік виходу " +
      w(s.peakOutput) +
      ". Останній заряд " +
      entries.at(-1).soc +
      "%."
    : "Немає вимірювань для графіка.";
  $("activityList").innerHTML =
    activity
      .map(
        (x) =>
          '<div><span aria-hidden="true">●</span><p>' +
          safe(x.text) +
          "<small>" +
          new Date(x.at).toLocaleString("uk-UA", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }) +
          "</small></p></div>",
      )
      .join("") ||
    '<div class="empty-state">Тут з’являться зміни портів. Невідомі значення не вважаються вимкненими.</div>';
  const groups = new Map();
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1],
      b = entries[i];
    if (b.at - a.at > 12 * 60000) continue;
    for (let at = a.at; at < b.at; ) {
      const d = new Date(at),
        next = new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate() + 1,
        ).getTime(),
        end = Math.min(next, b.at),
        key = d.toLocaleDateString("uk-UA"),
        v = groups.get(key) || { wh: 0, ms: 0 };
      v.wh += (((a.output + b.output) / 2) * (end - at)) / 36e5;
      v.ms += end - at;
      groups.set(key, v);
      at = end;
    }
  }
  $("dailyReport").innerHTML =
    [...groups]
      .slice(-31)
      .reverse()
      .map(
        ([day, v]) =>
          "<div><span>" +
          day +
          "</span><b>" +
          wh(v.wh) +
          "</b><small>" +
          fmtMin(v.ms / 60000) +
          " покриття</small></div>",
      )
      .join("") ||
    '<p class="empty-state">Добові підсумки з’являться після накопичення історії.</p>';
  if (currentTab === "history") draw(entries);
}
function draw(data) {
  const c = $("historyChart"),
    x = c.getContext("2d"),
    W = c.width,
    H = c.height,
    L = 44,
    R = 48,
    T = 18,
    B = 32;
  x.clearRect(0, 0, W, H);
  x.fillStyle = "#0b1728";
  x.fillRect(0, 0, W, H);
  x.font = "16px system-ui";
  x.fillStyle = "#a7b9cb";
  x.textAlign = "center";
  if (data.length < 2) {
    x.fillText("Потрібні хоча б два вимірювання", W / 2, H / 2);
    return;
  }
  const max = Math.max(100, ...data.map((p) => Math.max(p.input, p.output))),
    begin = Date.now() - settings.historyRange * 36e5,
    end = Date.now();
  for (let i = 0; i <= 4; i++) {
    const y = T + ((H - T - B) * i) / 4;
    x.strokeStyle = "#25364a";
    x.beginPath();
    x.moveTo(L, y);
    x.lineTo(W - R, y);
    x.stroke();
    x.textAlign = "right";
    x.fillText(Math.round(100 - i * 25) + "%", L - 6, y + 5);
    x.textAlign = "left";
    x.fillText(Math.round(max * (1 - i / 4)), W - R + 6, y + 5);
  }
  const line = (key, maxVal, color) => {
    x.strokeStyle = color;
    x.lineWidth = 3;
    x.beginPath();
    data.forEach((p, i) => {
      const px = L + ((p.at - begin) / (end - begin)) * (W - L - R),
        py = T + (1 - p[key] / maxVal) * (H - T - B);
      if (!i || p.at - data[i - 1].at > 12 * 60000) x.moveTo(px, py);
      else x.lineTo(px, py);
    });
    x.stroke();
  };
  line("soc", 100, "#46e0c6");
  line("input", max, "#83b2ff");
  line("output", max, "#ffc184");
  x.fillStyle = "#a7b9cb";
  for (let i = 0; i < 3; i++) {
    x.textAlign = i === 0 ? "left" : i === 2 ? "right" : "center";
    const at = begin + ((end - begin) * i) / 2;
    x.fillText(
      new Date(at).toLocaleString(
        "uk-UA",
        settings.historyRange > 24
          ? { day: "numeric", month: "short" }
          : { hour: "2-digit", minute: "2-digit" },
      ),
      L + ((W - L - R) * i) / 2,
      H - 6,
    );
  }
}
async function devicesLoad() {
  const j = await api("/devices");
  devices = Array.isArray(j.devices) ? j.devices : [];
  if (j.accountId && j.accountId !== settings.accountId) {
    settings.accountId = j.accountId;
    settings.calibration = null;
    loadData();
  }
  const select = $("deviceSelect");
  const pending = $("settingsDialog").open ? select.value : null;
  select.innerHTML = "";
  devices.forEach((d) =>
    select.add(
      new Option(
        d.deviceName || d.productName || "OUKITEL",
        d.productKey + "|" + d.deviceKey,
      ),
    ),
  );
  select.disabled = !devices.length;
  if (!devices.length) select.add(new Option("Немає прив’язаних станцій", ""));
  if (
    settings.device &&
    !devices.some(
      (d) =>
        d.productKey === settings.device.productKey &&
        d.deviceKey === settings.device.deviceKey,
    )
  ) {
    settings.device = null;
    loadData();
  }
  if (!settings.device && devices.length === 1) {
    settings.device = devices[0];
    loadData();
  }
  if (settings.device)
    select.value = settings.device.productKey + "|" + settings.device.deviceKey;
  if (
    pending &&
    devices.some((d) => d.productKey + "|" + d.deviceKey === pending)
  )
    select.value = pending;
  save();
}
async function loadMonitor(force = false) {
  if (!cloud() || !chosen()) return;
  const j = await api("/monitor");
  monitor = j.monitor || { enabled: false, state: "disabled" };
  if (
    monitor.device &&
    (monitor.device.productKey !== chosen().productKey ||
      monitor.device.deviceKey !== chosen().deviceKey)
  ) {
    monitor = { enabled: false, state: "other-device" };
    return;
  }
  if (
    (monitor.enabled || monitor.device) &&
    (force || Date.now() - monitorLoadedAt > 120000)
  ) {
    const d = chosen(),
      j = await api(
        "/monitor/history?" +
          new URLSearchParams({
            hours: Math.max(24, settings.historyRange),
            pk: d.productKey,
            dk: d.deviceKey,
          }),
      );
    history = normalizeHistory([...history, ...(j.samples || [])]);
    monitor = j.monitor || monitor;
    monitorLoadedAt = Date.now();
    save();
  }
}
function record() {
  if (
    !canMeasure() ||
    state.soc == null ||
    state.input == null ||
    state.output == null
  )
    return;
  const at = state.reportedAt || Date.now(),
    old = history.at(-1);
  if (old && at - old.at < 240000) return;
  const p = {
    at,
    soc: state.soc,
    input: state.input,
    output: state.output,
    ...Object.fromEntries(
      ["ac", "usb", "dc"]
        .filter((k) => typeof state[k] === "boolean")
        .map((k) => [k, state[k]]),
    ),
  };
  if (old) {
    const changes = ["ac", "usb", "dc"]
      .filter(
        (k) =>
          typeof old[k] === "boolean" &&
          typeof p[k] === "boolean" &&
          old[k] !== p[k],
      )
      .map((k) => k.toUpperCase() + ": " + yes(p[k]));
    if (changes.length)
      activity = [{ at, text: changes.join(" · ") }, ...activity].slice(0, 32);
  }
  history = normalizeHistory([...history, p]);
  save();
}
async function lowAlert() {
  if (
    !settings.alerts.enabled ||
    !canMeasure() ||
    state.soc == null ||
    state.soc > settings.alerts.threshold ||
    Date.now() - settings.alerts.lastAlertAt < 6 * 36e5
  )
    return;
  settings.alerts.lastAlertAt = Date.now();
  save();
  toast("Заряд станції: " + Math.round(state.soc) + "%. Перевірте план.");
}
async function refresh() {
  if (!cloud() || refreshing || phase === "auth-required") return refreshing;
  // Defer the body to ensure the in-flight promise exists even when offline.
  refreshing = Promise.resolve().then(async () => {
    phase = "connecting";
    renderConnection();
    try {
      if (navigator.onLine === false) {
        phase = "phone-offline";
        return;
      }
      await devicesLoad();
      if (!chosen()) {
        phase = "ready";
        return;
      }
      const d = chosen(),
        j = await api(
          "/state?" +
            new URLSearchParams({ pk: d.productKey, dk: d.deviceKey }),
        ),
        fresh = mapAttrs(j, emptyState());
      if (fresh.soc == null && fresh.input == null && fresh.output == null)
        throw new Error("Хмара не повернула показників.");
      state = {
        ...fresh,
        updated: j.connection?.receivedAt || Date.now(),
        reportedAt: j.connection?.reportedAt || null,
      };
      const entry = devices.find(
        (x) => x.productKey === d.productKey && x.deviceKey === d.deviceKey,
      );
      if (entry) entry.online = j.connection?.online ?? entry.online ?? null;
      phase = "ready";
      banner("");
      record();
      save();
      try {
        await loadMonitor();
      } catch (e) {
        if (e.status === 401) throw e;
        monitor = {
          ...monitor,
          lastError: "Фонову історію не вдалося оновити. Повторіть перевірку.",
        };
      }
      await lowAlert();
    } catch (e) {
      phase =
        e.status === 401
          ? "auth-required"
          : navigator.onLine === false
            ? "phone-offline"
            : "error";
      banner(e.message + " Попередні показники не є поточними.");
    } finally {
      refreshing = null;
      render();
    }
  });
  return refreshing;
}
function settingsOpen() {
  $("modeSelect").value = settings.mode;
  $("textSizeSelect").value = settings.textSize;
  $("alertEnabled").checked = settings.alerts.enabled;
  $("alertThreshold").value = settings.alerts.threshold;
  $("alertThresholdValue").textContent = settings.alerts.threshold + "%";
  $("monitorEnabled").checked = monitor.enabled === true;
  $("monitorSettingsCopy").textContent =
    monitor.state === "auth-required"
      ? "Потрібен повторний вхід для фонового збору."
      : monitor.enabled
        ? "Активний · раз на 5 хвилин · історія до 31 дня."
        : "Працює при закритій PWA, якщо станція має інтернет. Після завершення хмарної сесії потрібен повторний вхід.";
  $("loginStatus").textContent = "";
  renderConnection();
  $("settingsDialog").showModal();
  if (cloud() && phase !== "auth-required")
    devicesLoad()
      .then(() => loadMonitor())
      .then(() => {
        $("monitorEnabled").checked = monitor.enabled;
        renderConnection();
      })
      .catch(() => {});
}
async function login() {
  const email = $("email").value.trim(),
    password = $("password").value;
  $("loginBtn").disabled = true;
  $("loginStatus").textContent = "Підключаємо акаунт…";
  try {
    if (!email || !password)
      throw new Error("Введіть email і пароль Wonderfree.");
    const j = await api("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    settings.accountId = j.accountId || null;
    settings.mode = "cloud";
    devices = j.devices || [];
    settings.device =
      devices.length === 1
        ? devices[0]
        : devices.find((d) => d.deviceKey === settings.device?.deviceKey) ||
          null;
    settings.calibration = null;
    phase = "ready";
    loadData();
    save();
    $("modeSelect").value = "cloud";
    $("loginStatus").className = "login-status good";
    $("loginStatus").textContent = "Акаунт підключено. Перевіряємо станцію…";
    await devicesLoad();
    await refresh();
    $("loginStatus").textContent =
      j.monitorWarning ||
      (devices.length === 1
        ? "Станцію підключено. Фоновий збір можна ввімкнути нижче."
        : devices.length
          ? "Оберіть станцію нижче та збережіть."
          : "У цьому акаунті немає прив’язаних станцій.");
    $("monitorEnabled").checked = monitor.enabled;
  } catch (e) {
    $("loginStatus").className = "login-status bad";
    $("loginStatus").textContent = e.message;
  } finally {
    $("password").value = "";
    $("loginBtn").disabled = false;
    render();
  }
}
async function saveSettings() {
  $("saveBtn").disabled = true;
  try {
    const mode = $("modeSelect").value,
      [pk, dk] = $("deviceSelect").value.split("|"),
      device =
        devices.find((d) => d.productKey === pk && d.deviceKey === dk) ||
        settings.device;
    if (mode === "cloud" && !device)
      throw new Error("Спершу увійдіть та оберіть станцію.");
    if (mode === "demo" && cloud() && monitor.enabled) {
      await api("/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      });
      monitor = { ...monitor, enabled: false, state: "paused" };
    }
    const switched =
      device?.deviceKey !== settings.device?.deviceKey ||
      mode !== settings.mode;
    settings = normalizeSettings({
      ...settings,
      mode,
      device,
      textSize: $("textSizeSelect").value,
      alerts: {
        ...settings.alerts,
        enabled: $("alertEnabled").checked,
        threshold: +$("alertThreshold").value,
      },
      calibration: switched ? null : settings.calibration,
    });
    if (switched) {
      loadData();
      monitorLoadedAt = 0;
    }
    save();
    phase = "ready";
    if (cloud() && device) {
      const enabled = $("monitorEnabled").checked,
        same =
          monitor.device?.productKey === device.productKey &&
          monitor.device?.deviceKey === device.deviceKey;
      if (enabled !== monitor.enabled || (enabled && !same)) {
        const j = await api("/monitor", {
          method: "POST",
          body: JSON.stringify({
            enabled,
            productKey: device.productKey,
            deviceKey: device.deviceKey,
          }),
        });
        monitor = j.monitor;
      }
    }
    $("settingsDialog").close();
    render();
    await refresh();
  } catch (e) {
    $("loginStatus").className = "login-status bad";
    $("loginStatus").textContent = e.message;
    render();
  } finally {
    $("saveBtn").disabled = false;
  }
}
function info(kind) {
  const content = {
    flow: [
      "Потік енергії",
      "Вхід — потужність від мережі або сонця. Вихід — сумарна потужність приладів. Різниця не є точним вимірюванням заряджання батареї: є втрати та власне споживання станції.",
    ],
    forecast: [
      "Як рахуємо автономність",
      "Енергія до резерву = 2048 Вт·год × (заряд − резерв) / 100 × 0,88. Коефіцієнт 0,88 — приблизні втрати, а не виміряна ефективність. Ділимо енергію на середні Вт. Для фактичного прогнозу беремо останні 24 години; пропуски понад 12 хвилин не заповнюємо. Діапазон побудовано за годинними середніми, це не статистична гарантія.",
    ],
    diagnostics: [
      "Доступність і актуальність",
      "Онлайн — статус хмари під час останньої перевірки. Отримано — коли сервер прочитав хмарні дані. Час вимірювання — окрема позначка станції, якщо її передала хмара. Невідомий статус не означає офлайн. Напруга й частота — параметри AC; BMS та інвертор — версії модулів.",
    ],
    install: [
      "Встановити на iPhone",
      "Відкрийте в Safari → «Поділитися» → «На Початковий екран». Підписка App Store не потрібна. Без інтернету доступні збережені плани й останні дані, але станцію перевірити неможливо.",
    ],
  }[kind] || ["Довідка", "Керування AC/USB/DC — у Wonderfree."];
  $("infoContent").innerHTML =
    '<p class="eyebrow">ДОВІДКА</p><h2>' +
    content[0] +
    "</h2><p>" +
    content[1] +
    "</p>";
  $("infoDialog").showModal();
}
function download(name, data, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function backup() {
  download(
    "oukitel-plan.json",
    JSON.stringify(
      {
        version: 4,
        exportedAt: new Date().toISOString(),
        settings: {
          ...settings,
          device: null,
          accountId: null,
          mode: "demo",
          calibration: null,
        },
        history,
        activity,
      },
      null,
      2,
    ),
  );
  toast("Експорт готовий. Файл історії містить приватні показники споживання.");
}
function exportCsv() {
  download(
    "oukitel-energy.csv",
    "\uFEFFЧас ISO;Заряд %;Вхід Вт;Вихід Вт\n" +
      history
        .map((x) =>
          [new Date(x.at).toISOString(), x.soc, x.input, x.output].join(";"),
        )
        .join("\n"),
    "text/csv;charset=utf-8",
  );
}
function restore(file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    toast("Максимальний розмір — 3 МБ.");
    return;
  }
  file.text().then((text) => {
    try {
      const d = JSON.parse(text);
      if (![3, 4, undefined].includes(d.version)) throw new Error();
      if (
        !confirm(
          "Імпортувати плани? Історію з іншого пристрою не використовуємо для прогнозу цієї станції.",
        )
      )
        return;
      settings = normalizeSettings({
        ...settings,
        ...d.settings,
        device: settings.device,
        accountId: settings.accountId,
        mode: settings.mode,
        calibration: null,
      });
      save();
      render();
      toast("Плани імпортовано. Поточна історія збережена.");
    } catch {
      toast("Не вдалося прочитати файл.");
    }
  });
}
function editLoad(load) {
  editId = load.id;
  $("editLoadName").value = load.name;
  $("editLoadW").value = load.w;
  $("editLoadAverage").value = load.averageW ?? "";
  $("editLoadDialog").showModal();
}
function bind() {
  $("settingsBtn").onclick = settingsOpen;
  $("connectBtn").onclick = settingsOpen;
  $("refreshBtn").onclick = refresh;
  document
    .querySelectorAll("[data-tab]")
    .forEach((x) => (x.onclick = () => go(x.dataset.tab)));
  document
    .querySelectorAll("[data-info]")
    .forEach((x) => (x.onclick = () => info(x.dataset.info)));
  document
    .querySelectorAll("[data-close]")
    .forEach((x) => (x.onclick = () => $(x.dataset.close).close()));
  $("settingsForm").onsubmit = (e) => {
    e.preventDefault();
    if ($("loginFields").contains(document.activeElement)) login();
    else saveSettings();
  };
  $("loginBtn").onclick = login;
  $("saveBtn").onclick = saveSettings;
  $("logoutBtn").onclick = async () => {
    if (!confirm("Вийти? Фоновий збір зупиниться. Плани й історія залишаться."))
      return;
    try {
      await api("/logout", { method: "POST", body: "{}" });
    } catch {
      toast("Вихід не підтверджено сервером. Перевірте інтернет і повторіть.");
      return;
    }
    devices = [];
    settings.mode = "demo";
    settings.device = null;
    settings.accountId = null;
    settings.calibration = null;
    monitor = { enabled: false, state: "disabled" };
    history = [];
    activity = [];
    state = { ...DEMO };
    phase = "idle";
    save();
    $("settingsDialog").close();
    banner("");
    render();
  };
  $("reserveInput").oninput = (e) => {
    settings.reserve = +e.target.value;
    save();
    render();
  };
  $("profileList").onclick = (e) => {
    const b = e.target.closest("[data-profile]");
    if (!b) return;
    const p = [...PROFILES, ...settings.profiles][+b.dataset.profile];
    if (!p) return;
    if (
      settings.loads.length &&
      !confirm(
        "Замінити план сценарієм «" +
          p.name +
          "»? Збережіть поточний сценарій, якщо він потрібен.",
      )
    )
      return;
    settings.loads = Array.isArray(p.loads[0])
      ? p.loads.map((x) => ({
          id: uid(),
          name: x[0],
          w: x[1],
          icon: x[2],
          averageW: null,
          active: true,
        }))
      : normalizeLoads(p.loads.map((x) => ({ ...x, id: uid() })));
    settings.calibration = null;
    save();
    render();
  };
  $("saveProfileBtn").onclick = () => {
    if (!settings.loads.length) {
      toast("Спершу додайте прилади.");
      return;
    }
    const name = prompt("Назва власного сценарію");
    if (!name?.trim()) return;
    const n = name.trim().slice(0, 30),
      i = settings.profiles.findIndex((p) => p.name === n);
    if (i >= 0) {
      if (!confirm("Оновити сценарій «" + n + "»?")) return;
      settings.profiles[i] = { name: n, loads: clone(settings.loads) };
    } else if (settings.profiles.length < 12)
      settings.profiles.push({ name: n, loads: clone(settings.loads) });
    else {
      toast("Максимум 12 власних сценаріїв.");
      return;
    }
    save();
    render();
  };
  $("presetGrid").onclick = (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    const x = PRESETS[+b.dataset.preset];
    if (settings.loads.length >= 48) {
      toast("Максимум 48 приладів.");
      return;
    }
    settings.loads.push({
      id: uid(),
      name: x[0],
      w: x[1],
      icon: x[2],
      active: true,
      averageW: null,
    });
    save();
    render();
  };
  $("addCustomLoad").onclick = () => {
    const name = $("customLoadName").value.trim(),
      watts = finite($("customLoadW").value, 1, 2400);
    if (!name || watts == null) {
      toast("Введіть назву й потужність від 1 до 2400 Вт.");
      return;
    }
    if (settings.loads.length >= 48) {
      toast("Максимум 48 приладів.");
      return;
    }
    settings.loads.push({
      id: uid(),
      name: name.slice(0, 40),
      w: watts,
      icon: "bolt",
      averageW: null,
      active: true,
    });
    $("customLoadName").value = "";
    $("customLoadW").value = "";
    save();
    render();
  };
  $("loadsList").onchange = (e) => {
    const load = settings.loads.find(
      (x) => x.id === e.target.dataset.activeLoad,
    );
    if (load) {
      load.active = e.target.checked;
      save();
      render();
    }
  };
  $("loadsList").onclick = (e) => {
    const edit = e.target.closest("[data-edit-load]"),
      remove = e.target.closest("[data-remove-load]"),
      cal = e.target.closest("[data-calibrate-load]");
    if (edit) {
      const load = settings.loads.find((x) => x.id === edit.dataset.editLoad);
      if (load) editLoad(load);
    }
    if (remove) {
      const id = remove.dataset.removeLoad;
      settings.loads = settings.loads.filter((x) => x.id !== id);
      if (settings.calibration?.loadId === id) settings.calibration = null;
      save();
      render();
    }
    if (cal) {
      if (!canMeasure() || !monitor.enabled) {
        toast("Підключіть доступну станцію та ввімкніть фоновий збір.");
        return;
      }
      const load = settings.loads.find(
        (x) => x.id === cal.dataset.calibrateLoad,
      );
      if (
        load &&
        confirm(
          "Залиште активним лише «" +
            load.name +
            "» на 6–24 години. Вимірюється сумарне споживання, не окремий лічильник. Почати?",
        )
      ) {
        settings.calibration = { loadId: load.id, startedAt: Date.now() };
        save();
        render();
      }
    }
  };
  $("editLoadForm").onsubmit = (e) => {
    e.preventDefault();
    const load = settings.loads.find((x) => x.id === editId),
      name = $("editLoadName").value.trim(),
      watts = finite($("editLoadW").value, 1, 2400),
      average = $("editLoadAverage").value.trim();
    if (
      !load ||
      !name ||
      watts == null ||
      (average !== "" && finite(average, 0, 2400) == null)
    )
      return;
    load.name = name.slice(0, 40);
    load.w = watts;
    load.averageW = average === "" ? null : Number(average);
    save();
    $("editLoadDialog").close();
    render();
  };
  $("clearLoadsBtn").onclick = () => {
    if (!confirm("Очистити поточний план? Збережені сценарії залишаться."))
      return;
    settings.loads = [];
    settings.calibration = null;
    save();
    render();
  };
  $("calibrationBox").onclick = (e) => {
    if (e.target.id === "cancelCalibrationBtn") {
      settings.calibration = null;
      save();
      render();
    }
    if (e.target.id === "applyCalibrationBtn") {
      const c = settings.calibration,
        load = settings.loads.find((x) => x.id === c?.loadId),
        cf = calibrationForecast();
      if (
        !load ||
        !cf ||
        cf.coveredMs < 6 * 36e5 ||
        cf.coverage < 0.8 ||
        !cf.fresh
      )
        return;
      load.averageW = Math.round(cf.measuredWatts * 10) / 10;
      load.calibratedAt = Date.now();
      settings.calibration = null;
      save();
      render();
      toast("Середнє збережено лише за цією сесією.");
    }
  };
  $("historyRange").onclick = async (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    settings.historyRange = +b.dataset.range;
    save();
    renderHistory();
    try {
      await loadMonitor(true);
      renderHistory();
    } catch (e) {
      toast(e.message);
    }
  };
  $("clearHistoryBtn").onclick = async () => {
    if (
      !confirm(
        "Очистити історію обраної станції на пристрої та сервері? Плани залишаться.",
      )
    )
      return;
    try {
      if (cloud() && monitor.device) {
        const j = await api("/monitor/clear", { method: "POST", body: "{}" });
        monitor = j.monitor || monitor;
      }
      history = [];
      activity = [];
      monitorLoadedAt = 0;
      settings.calibration = null;
      save();
      render();
      toast("Історію очищено. Активний збір почне нові записи.");
    } catch (e) {
      toast("Історію не очищено: " + e.message);
    }
  };
  $("alertThreshold").oninput = (e) =>
    ($("alertThresholdValue").textContent = e.target.value + "%");
  $("exportBtn").onclick = backup;
  $("exportCsvBtn").onclick = exportCsv;
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = (e) => restore(e.target.files[0]);
  $("clearDataBtn").onclick = () => {
    if (
      !confirm(
        "Очистити локальні плани й кеш? Серверна історія залишиться й може синхронізуватися знову.",
      )
    )
      return;
    history = [];
    activity = [];
    settings.loads = [];
    settings.profiles = [];
    settings.calibration = null;
    state = cloud() ? emptyState() : { ...DEMO };
    save();
    render();
    toast("Локальні дані очищено.");
  };
  $("updateBtn").onclick = () => {
    updateRequested = true;
    waitingWorker?.postMessage({ type: "SKIP_WAITING" });
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener("online", () => {
    if (phase === "phone-offline") phase = "ready";
    refresh();
  });
  window.addEventListener("offline", () => {
    if (cloud()) {
      phase = "phone-offline";
      render();
    }
  });
}
bind();
$("appVersion").textContent = "OUKITEL Home " + VERSION;
render();
if ("serviceWorker" in navigator) {
  let reload = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateRequested && !reload) {
      reload = true;
      location.reload();
    }
  });
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      const update = () => {
        if (reg.waiting && navigator.serviceWorker.controller) {
          waitingWorker = reg.waiting;
          $("updateBtn").classList.remove("hidden");
        }
      };
      update();
      reg.addEventListener("updatefound", () =>
        reg.installing?.addEventListener("statechange", update),
      );
    })
    .catch(() => {});
}
if (cloud()) refresh();
setInterval(() => {
  if (!document.hidden) {
    if (
      cloud() &&
      phase !== "auth-required" &&
      !$("settingsDialog").open &&
      !$("editLoadDialog").open
    )
      refresh();
    else render();
  }
}, 30000);
