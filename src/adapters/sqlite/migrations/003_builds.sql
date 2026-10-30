CREATE TABLE builds (
  hash TEXT PRIMARY KEY,
  dir TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE runs ADD COLUMN build_hash TEXT REFERENCES builds(hash);
