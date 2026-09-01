import {calcBudget, calcEnergy, fmtMin, mapAttrs} from "/core.mjs";

const $ = id => document.getElementById(id);
const DEMO = {soc: 89, temp: 28, remain: 3180, input: 0, output: 0, acInput: 0, dcInput: 0, ac: true, usb: false, dc: false, frequency: 50, voltage: 230, chargeLimit: 100, inverter: 106, bms: 115, updated: new Date()};
let state = {...DEMO};
let settings = JSON.parse(localStorage.getItem("oukitel_ui") || '{"mode":"demo","device":null}');
let devices = [];

function saveUi() { localStorage.setItem("oukitel_ui", JSON.stringify(settings)); }
function setBanner(message = "") { $("banner").textContent = message; $("banner").classList.toggle("hidden", !message); }
function selectedDevice() { return settings.device && devices.find(d => d.productKey === settings.device.productKey && d.deviceKey === settings.device.deviceKey) || settings.device; }
function render() {
  const device = selectedDevice();
  $("soc").textContent = `${Math.round(state.soc ?? 0)}%`;
  $("energy").textContent = `≈ ${(calcEnergy(state.soc) / 1000).toFixed(2)} kWh`;
  $("temperature").textContent = state.temp == null ? "—" : `${state.temp}°C`;
  $("remaining").textContent = fmtMin(state.remain);
  for (const [element, value] of Object.entries({inputW: state.input, outputW: state.output, acInputW: state.acInput, dcInputW: state.dcInput})) $(element).textContent = Math.round(value || 0);
  $("frequency").textContent = state.frequency == null ? "—" : `${state.frequency} Hz`;
  $("voltage").textContent = state.voltage == null ? "—" : `${state.voltage} V`;
  $("chargeLimit").textContent = state.chargeLimit == null ? "—" : `${state.chargeLimit}%`;
  $("inverter").textContent = state.inverter ?? "—"; $("bms").textContent = state.bms ?? "—";
  $("productKey").textContent = device?.productKey || "—";
  $("deviceName").textContent = device?.deviceName || "Не вибрано";
  $("batteryRing").style.background = `conic-gradient(var(--cyan) 0 ${Math.max(0, Math.min(100, state.soc || 0))}%, #26314a ${Math.max(0, Math.min(100, state.soc || 0))}% 100%)`;
  const live = settings.mode === "cloud" && !!device;
  $("controlMode").textContent = live ? "LIVE / read" : "демо";
  $("statusText").textContent = live ? "Acceleronix Cloud" : "Демо";
  $("statusDot").classList.toggle("live", live);
  $("updated").textContent = `Оновлено: ${(state.updated || new Date()).toLocaleTimeString("uk-UA", {hour:"2-digit", minute:"2-digit"})}`;
  const watts = Number($("budgetW").value); $("budgetWLabel").textContent = watts; $("budgetTime").textContent = fmtMin(calcBudget(watts, state.soc));
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {credentials: "same-origin", ...options, headers: {"content-type": "application/json", ...(options.headers || {})}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function populateDevices() {
  const select = $("deviceSelect");
  select.innerHTML = "";
  if (!devices.length) { select.add(new Option("Немає прив’язаних станцій", "")); select.disabled = true; return; }
  for (const device of devices) {
    const option = new Option(`${device.deviceName || device.productName || device.deviceKey} — ${device.productName || device.productKey}`, `${device.productKey}|${device.deviceKey}`);
    option.selected = settings.device?.productKey === device.productKey && settings.device?.deviceKey === device.deviceKey;
    select.add(option);
  }
  select.disabled = false;
}
async function loadDevices() {
  const result = await api("/devices"); devices = result.devices || []; populateDevices(); return devices;
}
async function refreshCloud() {
  if (settings.mode !== "cloud" || !settings.device) return;
  try {
    const params = new URLSearchParams({pk: settings.device.productKey, dk: settings.device.deviceKey});
    const payload = await api(`/state?${params}`);
    state = {...mapAttrs(payload, state), updated: new Date()}; setBanner(""); render();
  } catch (error) {
    setBanner(`LIVE недоступний: ${error.message}. Показано останні дані.`);
  }
}
async function login() {
  const email = $("email").value.trim(), password = $("password").value;
  $("loginStatus").className = "login-status"; $("loginStatus").textContent = "Вхід…";
  try {
    if (!email || !password) throw new Error("Введіть email і пароль Wonderfree.");
    const result = await api("/login", {method: "POST", body: JSON.stringify({email, password})});
    $("password").value = ""; devices = result.devices || []; populateDevices();
    $("loginStatus").classList.add("good"); $("loginStatus").textContent = `Успішно. Знайдено станцій: ${devices.length}.`;
  } catch (error) { $("loginStatus").classList.add("bad"); $("loginStatus").textContent = error.message; }
}
function saveSettings() {
  const choice = $("deviceSelect").value.split("|");
  settings.mode = $("modeSelect").value;
  settings.device = choice.length === 2 ? devices.find(d => d.productKey === choice[0] && d.deviceKey === choice[1]) || null : null;
  saveUi(); $("settingsDialog").close(); render(); refreshCloud();
}
async function logout() {
  try { await api("/logout", {method:"POST", body:"{}"}); } catch (_) { /* local state must still be cleared */ }
  devices = []; settings = {mode:"demo", device:null}; saveUi(); state = {...DEMO, updated:new Date()}; $("loginStatus").textContent = "Сесію стерто."; render();
}
$("settingsBtn").addEventListener("click", async () => {
  $("modeSelect").value = settings.mode; $("password").value = ""; $("loginStatus").textContent = "";
  try { await loadDevices(); } catch (_) { populateDevices(); }
  $("settingsDialog").showModal();
});
$("loginBtn").addEventListener("click", login); $("saveBtn").addEventListener("click", saveSettings); $("logoutBtn").addEventListener("click", logout);
$("refreshBtn").addEventListener("click", () => settings.mode === "cloud" ? refreshCloud() : (state.updated = new Date(), render()));
$("budgetW").addEventListener("input", render);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render(); if (settings.mode === "cloud") { loadDevices().then(refreshCloud).catch(() => setBanner("Сесію завершено. Увійдіть знову.")); }
setInterval(refreshCloud, 30000);

