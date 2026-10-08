PRAGMA foreign_keys = ON;
CREATE TABLE monitor_details (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  body TEXT NOT NULL
);
ALTER TABLE samples ADD COLUMN generation TEXT NOT NULL DEFAULT '';
ALTER TABLE samples ADD COLUMN time_source TEXT NOT NULL DEFAULT 'cloud-poll';
CREATE INDEX idx_samples_generation ON samples(monitor_id, generation, at);
