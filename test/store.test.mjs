import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  getMonitor,
  putMonitor,
  storeSample,
  d1Samples,
  d1LoginAttempt,
  cleanupD1,
} from "../monitor-store.mjs";

test("real D1 migrations preserve monitors, timestamps, ports, leases and generation isolation", async () => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "fixture",
          compatibilityDate: "2026-09-01",
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents:
                  "export default {fetch(){return new Response('test')}}",
              },
            },
          },
          env: { DB: { type: "d1", id: "test-db" } },
        },
      },
    ],
  });
  try {
    const DB = await mf.getD1Database("DB");
    for (const file of ["0001_monitoring.sql", "0002_monitor_details.sql"]) {
      const sql = await readFile(
        new URL("../migrations/" + file, import.meta.url),
        "utf8",
      );
      for (const statement of sql
        .split(";")
        .filter((s) => s.trim() && !s.trim().startsWith("PRAGMA")))
        await DB.prepare(statement).run();
    }
    const values = new Map();
    const env = {
      DB,
      SESSIONS: {
        delete: async (key) => values.delete(key),
        get: async () => null,
      },
    };
    const now = Date.now(),
      record = {
        owner: "owner",
        device: { productKey: "p11wN7", deviceKey: "fixture" },
        enabled: true,
        token: "encrypted",
        revision: "one",
        createdAt: now,
        expiresAt: now + 864e5,
        lastSampleAt: null,
      };
    await putMonitor(env, "monitor-one", record);
    assert.equal((await getMonitor(env, "monitor-one")).revision, "one");
    const sample = {
      at: now,
      soc: 70,
      input: 0,
      output: 50,
      ac: true,
      usb: false,
      timeSource: "device",
    };
    await storeSample(env, "monitor-one", record, sample, 31 * 86400);
    assert.deepEqual(
      await d1Samples(env, "monitor-one", null, now - 1000, now + 1000),
      [sample],
    );
    record.generation = "new";
    record.enabled = false;
    record.token = null;
    await putMonitor(env, "monitor-one", record);
    assert.deepEqual(
      await d1Samples(env, "monitor-one", "new", now - 1000, now + 1000),
      [],
    );
    assert.equal((await getMonitor(env, "monitor-one")).expiresAt, now + 864e5);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        d1LoginAttempt(env, "rate-fixture", 900, 5),
      ),
    );
    assert.equal(results.filter(Boolean).length, 5);
    await cleanupD1(env, now + 2 * 864e5);
    assert.equal(await getMonitor(env, "monitor-one"), null);
  } finally {
    await mf.dispose();
  }
});
