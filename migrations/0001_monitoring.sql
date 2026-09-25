PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  product_key TEXT NOT NULL,
  device_key TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_sample_at INTEGER,
  last_error TEXT,
  auth_required INTEGER NOT NULL DEFAULT 0 CHECK (auth_required IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_monitors_due
  ON monitors(enabled, auth_required, last_sample_at, expires_at);

CREATE TABLE IF NOT EXISTS samples (
  monitor_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  soc REAL NOT NULL,
  input REAL NOT NULL,
  output REAL NOT NULL,
  ac INTEGER CHECK (ac IN (0, 1) OR ac IS NULL),
  usb INTEGER CHECK (usb IN (0, 1) OR usb IS NULL),
  dc INTEGER CHECK (dc IN (0, 1) OR dc IS NULL),
  PRIMARY KEY (monitor_id, at),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_samples_monitor_at
  ON samples(monitor_id, at);

CREATE TABLE IF NOT EXISTS login_rate (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_rate_reset
  ON login_rate(reset_at);
