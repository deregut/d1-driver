-- D1 Drive schema
-- Apply with:  npx wrangler d1 execute d1-drive --remote --file=schema.sql
--          or  npx wrangler d1 execute d1-drive --local  --file=schema.sql

CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY,
  path        TEXT    NOT NULL UNIQUE,      -- normalized full path, e.g. '/docs/report.pdf'
  parent_path TEXT    NOT NULL,             -- '/' for root-level items
  name        TEXT    NOT NULL,
  is_folder   INTEGER NOT NULL DEFAULT 0,   -- 1 = folder, 0 = file
  size        INTEGER NOT NULL DEFAULT 0,   -- bytes (files only)
  mime        TEXT    NOT NULL DEFAULT 'application/octet-stream',
  created_at  INTEGER NOT NULL,             -- epoch ms
  updated_at  INTEGER NOT NULL              -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_path);
CREATE INDEX IF NOT EXISTS idx_nodes_folder ON nodes(is_folder);

-- File payloads are split into fixed-size BLOB chunks so each row stays far
-- below D1 per-value limits.
CREATE TABLE IF NOT EXISTS chunks (
  node_id INTEGER NOT NULL,
  seq     INTEGER NOT NULL,      -- chunk index within the file
  data    BLOB    NOT NULL,
  PRIMARY KEY (node_id, seq)
);
