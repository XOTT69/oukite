// D1 is optional. Existing KV data remains readable during migration.
export const hasD1 = (env) => !!env.DB && typeof env.DB.prepare === "function";
export async function getMonitor(env, id) {
  if (hasD1(env)) {
    const row = await env.DB.prepare(
      "SELECT m.*, d.body FROM monitors m LEFT JOIN monitor_details d ON d.monitor_id=m.id WHERE m.id=?1",
    )
      .bind(id)
      .first();
    if (row) {
      const extra = row.body ? JSON.parse(row.body) : {};
      return {
        ...extra,
        owner: row.account_id,
        enabled: Number(row.enabled) === 1,
        device: { productKey: row.product_key, deviceKey: row.device_key },
        token: row.token,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSampleAt: row.last_sample_at,
        lastAttemptAt: row.last_attempt_at,
        lastError: row.last_error,
        authRequired: !!row.auth_required,
      };
    }
  }
  return env.SESSIONS.get("monitor:" + id, "json");
}
export async function putMonitor(env, id, record) {
  const now = Date.now();
  // Cron must not grant itself an unlimited monitoring lease.
  if (!record.expiresAt)
    record.expiresAt = (record.createdAt || now) + 31 * 864e5;
  if (record.expiresAt <= now) {
    await env.SESSIONS.delete("monitor:" + id);
    return;
  }
  if (hasD1(env)) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO monitors (id,account_id,enabled,product_key,device_key,token,created_at,expires_at,last_sample_at,last_attempt_at,last_error,auth_required) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,enabled=excluded.enabled,product_key=excluded.product_key,device_key=excluded.device_key,token=excluded.token,created_at=excluded.created_at,expires_at=excluded.expires_at,last_sample_at=excluded.last_sample_at,last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error,auth_required=excluded.auth_required",
      ).bind(
        id,
        record.owner ?? record.accountId ?? null,
        record.enabled ? 1 : 0,
        record.device.productKey,
        record.device.deviceKey,
        record.token || "",
        record.createdAt || now,
        record.expiresAt,
        record.lastSampleAt ?? null,
        record.lastAttemptAt ?? null,
        record.lastError ?? null,
        record.authRequired ? 1 : 0,
      ),
      env.DB.prepare(
        "INSERT INTO monitor_details (monitor_id,body) VALUES (?1,?2) ON CONFLICT(monitor_id) DO UPDATE SET body=excluded.body",
      ).bind(id, JSON.stringify(record)),
    ]);
    await env.SESSIONS.delete("monitor:" + id);
  } else
    await env.SESSIONS.put("monitor:" + id, JSON.stringify(record), {
      expirationTtl: Math.max(60, Math.ceil((record.expiresAt - now) / 1000)),
    });
}
export async function storeSample(env, id, record, sample, ttl) {
  if (hasD1(env)) {
    await env.DB.prepare(
      "INSERT INTO samples (monitor_id,at,soc,input,output,ac,usb,dc,generation,time_source) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(monitor_id,at) DO UPDATE SET soc=excluded.soc,input=excluded.input,output=excluded.output,ac=excluded.ac,usb=excluded.usb,dc=excluded.dc,generation=excluded.generation,time_source=excluded.time_source",
    )
      .bind(
        id,
        sample.at,
        sample.soc,
        sample.input,
        sample.output,
        sample.ac == null ? null : sample.ac ? 1 : 0,
        sample.usb == null ? null : sample.usb ? 1 : 0,
        sample.dc == null ? null : sample.dc ? 1 : 0,
        record.generation || "",
        sample.timeSource || "cloud-poll",
      )
      .run();
  } else {
    const prefix = record.generation ? id + ":" + record.generation : id;
    await env.SESSIONS.put(
      "sample:" +
        prefix +
        ":" +
        new Date(sample.at).toISOString().slice(0, 10) +
        ":" +
        String(sample.at).padStart(13, "0"),
      JSON.stringify(sample),
      { expirationTtl: ttl },
    );
  }
}
export async function d1Samples(env, id, generation, after, now) {
  if (!hasD1(env)) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM samples WHERE monitor_id=?1 AND generation=?2 AND at>=?3 AND at<=?4 ORDER BY at ASC LIMIT 15000",
  )
    .bind(id, generation || "", after, now)
    .all();
  return (result.results || []).map((r) => ({
    at: r.at,
    soc: r.soc,
    input: r.input,
    output: r.output,
    timeSource: r.time_source,
    ...Object.fromEntries(
      ["ac", "usb", "dc"].filter((k) => r[k] != null).map((k) => [k, !!r[k]]),
    ),
  }));
}
export async function dueD1Monitors(env, now, limit) {
  if (!hasD1(env)) return [];
  const result = await env.DB.prepare(
    "SELECT id FROM monitors WHERE enabled=1 AND auth_required=0 AND expires_at>?1 AND COALESCE(last_attempt_at,last_sample_at,0)<=?2 ORDER BY COALESCE(last_attempt_at,last_sample_at,0) ASC LIMIT ?3",
  )
    .bind(now, now - 270000, limit)
    .all();
  return Promise.all(
    (result.results || []).map(async (row) => ({
      id: row.id,
      record: await getMonitor(env, row.id),
    })),
  );
}
export async function cleanupD1(env, now) {
  if (!hasD1(env)) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM samples WHERE at<?1").bind(now - 31 * 864e5),
    env.DB.prepare("DELETE FROM monitors WHERE expires_at<=?1").bind(now),
    env.DB.prepare("DELETE FROM login_rate WHERE reset_at<?1").bind(
      Math.floor(now / 1000) - 1800,
    ),
  ]);
}
export async function d1LoginAttempt(env, key, window, max) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "INSERT INTO login_rate (key,count,reset_at) VALUES (?1,1,?2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=?3 THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<=?3 THEN excluded.reset_at ELSE reset_at END RETURNING count",
  )
    .bind(key, now + window, now)
    .first();
  return Number(row.count) <= max;
}
