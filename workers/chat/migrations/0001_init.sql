-- chat-worker D1 schema (CHAT_DB)
-- Applied via `wdl d1 migrations apply chat-db --ns demo`
--
-- sessions_index: cross-DO session catalog so operator endpoints / admin queries
--                 don't need to walk every ChatSessionDO. A session mints a fresh
--                 tmp namespace + ns token at start; ns_token_id records the issued
--                 token id for diagnostics.

CREATE TABLE IF NOT EXISTS sessions_index (
  id              TEXT PRIMARY KEY,
  ns              TEXT NOT NULL,
  ns_token_id     TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  status          TEXT NOT NULL          -- active | closed
);
