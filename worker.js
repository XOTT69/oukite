// Same-origin Cloudflare Worker + static PWA. It deliberately exposes no cloud
// bearer token, authKey, or write endpoint to the browser.
const EU = {
  base: "https://iot-api.quecteleu.com",
  appSecret: "3aRNUwWahjyANa7WfBK2wCCkxCexB6nXxKJwXxfePvzf",
  userDomain: "E.SP.4294967410"
};
const SESSION_TTL = 60 * 60 * 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      if (url.pathname === "/") url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, request));
    }
    if (request.method === "OPTIONS") return new Response(null, {status: 204});
    try {
      if (url.pathname === "/api/health") return json({ok: true, mode: "cloud-read-only"});
      if (url.pathname === "/api/login" && request.method === "POST") return login(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST") return logout(request, env);
      const session = await sessionFor(request, env);
      if (!session) return json({error: "Сесія завершилась. Увійдіть знову."}, 401);
      if (url.pathname === "/api/devices" && request.method === "GET") return json({devices: await accountDevices(session.token)});
      if (url.pathname === "/api/state" && request.method === "GET") return state(url, session.token);
      if (url.pathname === "/api/tsl" && request.method === "GET") return tsl(url, session.token);
      return json({error: "Не знайдено."}, 404);
    } catch (error) {
      console.error("OUKITEL Worker error", error);
      return json({error: error instanceof CloudError ? error.message : "Помилка підключення до хмари."}, error instanceof CloudError ? error.status : 502);
    }
  }
};

async function login(request, env) {
  const input = await readJson(request);
  const email = String(input.email || "").trim(), password = String(input.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 256) return json({error: "Введіть коректні email і пароль."}, 400);
  const token = await cloudLogin(email, password);
  const sessionId = randomId();
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({token}), {expirationTtl: SESSION_TTL});
  const response = json({devices: await accountDevices(token)});
  response.headers.set("Set-Cookie", `oukitel_session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${SESSION_TTL}`);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
async function logout(request, env) {
  const sessionId = cookie(request, "oukitel_session");
  if (sessionId) await env.SESSIONS.delete(`session:${sessionId}`);
  const response = json({ok: true});
  response.headers.set("Set-Cookie", "oukitel_session=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
async function sessionFor(request, env) {
  const id = cookie(request, "oukitel_session");
  if (!id || !/^[A-Za-z0-9_-]{40,}$/.test(id)) return null;
  const data = await env.SESSIONS.get(`session:${id}`, "json");
  return data?.token ? data : null;
}
async function accountDevices(token) {
  const raw = await cloudGet("/v2/binding/enduserapi/userDeviceList?pageNumber=1&pageSize=50", token);
  const list = raw?.data?.list;
  if (!Array.isArray(list)) throw new CloudError("Не вдалося отримати список станцій.", 502);
  return list.map(item => ({productKey: String(item.productKey || ""), deviceKey: String(item.deviceKey || ""), deviceName: String(item.deviceName || ""), productName: String(item.productName || ""), online: item.online === true || Number(item.online) === 1})).filter(item => item.productKey && item.deviceKey);
}
async function allowedDevice(url, token) {
  const productKey = url.searchParams.get("pk"), deviceKey = url.searchParams.get("dk");
  if (!productKey || !deviceKey) throw new CloudError("Потрібно обрати станцію.", 400);
  const device = (await accountDevices(token)).find(item => item.productKey === productKey && item.deviceKey === deviceKey);
  if (!device) throw new CloudError("Станція не знайдена у вашому акаунті.", 403);
  return device;
}
async function state(url, token) {
  const device = await allowedDevice(url, token);
  return noStore(await cloudGet(`/v2/binding/enduserapi/getDeviceBusinessAttributes?pk=${encodeURIComponent(device.productKey)}&dk=${encodeURIComponent(device.deviceKey)}`, token));
}
async function tsl(url, token) {
  const productKey = url.searchParams.get("pk");
  if (!productKey) throw new CloudError("Потрібен product key.", 400);
  const allowed = await accountDevices(token);
  if (!allowed.some(item => item.productKey === productKey)) throw new CloudError("Модель не належить вашому акаунту.", 403);
  return noStore(await cloudGet(`/v2/binding/enduserapi/productTSL?pk=${encodeURIComponent(productKey)}`, token));
}
async function cloudLogin(email, password) {
  const random = randomString(16), md5 = md5hexCorrect(random).toUpperCase(), key = md5.slice(8, 24), iv = key.slice(8) + key.slice(0, 8);
  const encryptedPassword = await aesCbcBase64(password, key, iv);
  const signature = await sha256hex(email + encryptedPassword + random + EU.appSecret);
  const body = new URLSearchParams({email, pwd: encryptedPassword, random, signature, userDomain: EU.userDomain});
  const response = await fetch(`${EU.base}/v2/enduser/enduserapi/emailPwdLogin`, {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded", ...cloudHeaders()}, body});
  const result = await parseCloud(response, "Не вдалося увійти. Перевірте email, пароль і регіон акаунта.");
  const token = result?.data?.accessToken?.token;
  if (!token) throw new CloudError("Не вдалося увійти. Перевірте email і пароль.", 401);
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}
async function cloudGet(path, token) {
  const response = await fetch(EU.base + path, {headers: cloudHeaders(token)});
  return parseCloud(response, "Помилка Quectel Cloud.");
}
function cloudHeaders(token) {
  const headers = {"X-Q-Language":"en", "quec-random-url":crypto.randomUUID(), "app-info":JSON.stringify({userDomain:EU.userDomain})};
  if (token) headers.Authorization = token;
  return headers;
}
async function parseCloud(response, fallback) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new CloudError(response.status === 401 ? "Сесія Quectel завершилась. Увійдіть знову." : fallback, response.status === 401 ? 401 : 502);
  if (body && body.code != null && ![0, 200].includes(Number(body.code))) throw new CloudError(body.code === 401 ? "Сесія Quectel завершилась. Увійдіть знову." : fallback, body.code === 401 ? 401 : 502);
  return body;
}
function noStore(body) { const response = json(body); response.headers.set("Cache-Control", "no-store"); return response; }
function json(value, status = 200) { return new Response(JSON.stringify(value), {status, headers:{"content-type":"application/json; charset=utf-8", "X-Content-Type-Options":"nosniff"}}); }
function cookie(request, name) { return request.headers.get("Cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1) || ""; }
async function readJson(request) { try { return await request.json(); } catch { throw new CloudError("Некоректний запит.", 400); } }
function randomString(length) { const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return [...bytes].map(byte => chars[byte % chars.length]).join(""); }
function randomId() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function aesCbcBase64(text, keyString, ivString) { const encoder = new TextEncoder(), key = await crypto.subtle.importKey("raw", encoder.encode(keyString), {name:"AES-CBC"}, false, ["encrypt"]), encrypted = await crypto.subtle.encrypt({name:"AES-CBC", iv:encoder.encode(ivString)}, key, encoder.encode(text)); return btoa(String.fromCharCode(...new Uint8Array(encrypted))) + "\n"; }
async function sha256hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
class CloudError extends Error { constructor(message, status) { super(message); this.status = status; } }

// Compact MD5 implementation, needed to reproduce the Wonderfree login request.
function md5cycle(x,k){let[a,b,c,d]=x;a=ff(a,b,c,d,k[0],7,-680876936);d=ff(d,a,b,c,k[1],12,-389564586);c=ff(c,d,a,b,k[2],17,606105819);b=ff(b,c,d,a,k[3],22,-1044525330);a=ff(a,b,c,d,k[4],7,1200080426);d=ff(d,a,b,c,k[5],12,-1473231341);c=ff(c,d,a,b,k[6],17,-45705983);b=ff(b,c,d,a,k[7],22,1770035416);a=ff(a,b,c,d,k[8],7,-2022574463);d=ff(d,a,b,c,k[9],12,1839030562);c=ff(c,d,a,b,k[10],17,-35309556);b=ff(b,c,d,a,k[11],22,-1530992060);a=ff(a,b,c,d,k[12],7,1236535329);d=ff(d,a,b,c,k[13],12,-165796510);c=ff(c,d,a,b,k[14],17,-1069501632);b=ff(b,c,d,a,k[15],22,-327891);a=gg(a,b,c,d,k[1],5,-701558691);d=gg(d,a,b,c,k[6],9,38016083);c=gg(c,d,a,b,k[11],14,-660478335);b=gg(b,c,d,a,k[0],20,-405537848);a=gg(a,b,c,d,k[5],5,568446438);d=gg(d,a,b,c,k[10],9,-1019803690);c=gg(c,d,a,b,k[15],14,1873313359);b=gg(b,c,d,a,k[4],20,-30611744);a=gg(a,b,c,d,k[9],5,-1560198380);d=gg(d,a,b,c,k[14],9,1309151649);c=gg(c,d,a,b,k[3],14,-145523070);b=gg(b,c,d,a,k[8],20,-1120210379);a=gg(a,b,c,d,k[13],5,718787259);d=gg(d,a,b,c,k[2],9,-343485551);c=gg(c,d,a,b,k[7],14,-57434055);b=gg(b,c,d,a,k[12],20,1700485571);a=hh(a,b,c,d,k[5],4,-1894986606);d=hh(d,a,b,c,k[8],11,-1051523);c=hh(c,d,a,b,k[11],16,1873313359);b=hh(b,c,d,a,k[14],23,-30611744);a=hh(a,b,c,d,k[1],4,-1560198380);d=hh(d,a,b,c,k[4],11,1309151649);c=hh(c,d,a,b,k[7],16,-145523070);b=hh(b,c,d,a,k[10],23,-1120210379);a=hh(a,b,c,d,k[13],4,718787259);d=hh(d,a,b,c,k[0],11,-343485551);c=hh(c,d,a,b,k[3],16,-57434055);b=hh(b,c,d,a,k[6],23,1700485571);a=hh(a,b,c,d,k[9],4,-1894986606);d=hh(d,a,b,c,k[12],11,-1051523);c=hh(c,d,a,b,k[15],16,1873313359);b=hh(b,c,d,a,k[2],23,-30611744);a=ii(a,b,c,d,k[0],6,-1560198380);d=ii(d,a,b,c,k[7],10,1309151649);c=ii(c,d,a,b,k[14],15,-145523070);b=ii(b,c,d,a,k[5],21,-1120210379);a=ii(a,b,c,d,k[12],6,718787259);d=ii(d,a,b,c,k[3],10,-343485551);c=ii(c,d,a,b,k[10],15,-57434055);b=ii(b,c,d,a,k[1],21,1700485571);a=ii(a,b,c,d,k[8],6,-1894986606);d=ii(d,a,b,c,k[15],10,-1051523);c=ii(c,d,a,b,k[6],15,1873313359);b=ii(b,c,d,a,k[13],21,-30611744);a=ii(a,b,c,d,k[4],6,-1560198380);d=ii(d,a,b,c,k[11],10,1309151649);c=ii(c,d,a,b,k[2],15,-145523070);b=ii(b,c,d,a,k[9],21,-1120210379);x[0]=add32(a,x[0]);x[1]=add32(b,x[1]);x[2]=add32(c,x[2]);x[3]=add32(d,x[3])}function cmn(q,a,b,x,s,t){a=add32(add32(a,q),add32(x,t));return add32(a<<s|a>>>32-s,b)}function ff(a,b,c,d,x,s,t){return cmn(b&c|~b&d,a,b,x,s,t)}function gg(a,b,c,d,x,s,t){return cmn(b&d|c&~d,a,b,x,s,t)}function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t)}function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t)}function md51(s){const txt=unescape(encodeURIComponent(s));let n=txt.length,state=[1732584193,-271733879,-1732584194,271733878],i;for(i=64;i<=n;i+=64)md5cycle(state,md5blk(txt.substring(i-64,i)));s=txt.substring(i-64);const tail=Array(16).fill(0);for(i=0;i<s.length;i++)tail[i>>2]|=s.charCodeAt(i)<<((i%4)<<3);tail[i>>2]|=0x80<<((i%4)<<3);if(i>55){md5cycle(state,tail);tail.fill(0)}tail[14]=n*8;md5cycle(state,tail);return state}function md5blk(s){const blocks=[];for(let i=0;i<64;i+=4)blocks[i>>2]=s.charCodeAt(i)+(s.charCodeAt(i+1)<<8)+(s.charCodeAt(i+2)<<16)+(s.charCodeAt(i+3)<<24);return blocks}function md5hex(s){return md51(s).map(n=>{let out="";for(let j=0;j<4;j++)out+=("0"+((n>>>j*8)&255).toString(16)).slice(-2);return out}).join("")}function add32(a,b){return(a+b)&0xffffffff}

// The small implementation above is retained only for provenance; use this
// independently tested MD5 implementation for the protocol login derivation.
function md5hexCorrect(input) {
  const bytes = [...new TextEncoder().encode(input)], bitLength = bytes.length * 8;
  bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(i < 4 ? (bitLength >>> (8 * i)) & 255 : 0);
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const constants = Array.from({length:64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const add = (a, b) => (a + b) | 0, rotate = (value, count) => (value << count) | (value >>> (32 - count));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = Array.from({length:16}, (_, i) => bytes[offset + i * 4] | (bytes[offset + i * 4 + 1] << 8) | (bytes[offset + i * 4 + 2] << 16) | (bytes[offset + i * 4 + 3] << 24));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = d; d = c; c = b; b = add(b, rotate(add(add(a, f), add(constants[i], words[g])), shifts[i])); a = next;
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }
  return [a0, b0, c0, d0].map(word => Array.from({length:4}, (_, i) => ((word >>> (8 * i)) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

export {md5hexCorrect};
