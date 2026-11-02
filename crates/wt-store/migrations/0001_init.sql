-- 0001_init.sql
-- 初始 schema：文件夹、会话、迁移记录。
-- 设计依据：docs/design/04-data-model.md §2。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    color       TEXT,
    environment TEXT,
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT '',
    rev         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order);

CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    folder_id       TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,

    host            TEXT,
    port            INTEGER,
    username        TEXT,
    environment     TEXT,
    credential_ref  TEXT,

    options         TEXT NOT NULL DEFAULT '{}',
    settings        TEXT NOT NULL DEFAULT '{}',

    last_used_at    TEXT,
    last_cwd        TEXT,

    created_at      TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL DEFAULT '',
    rev             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_sessions_type   ON sessions(type);
CREATE INDEX IF NOT EXISTS idx_sessions_host   ON sessions(host);
CREATE INDEX IF NOT EXISTS idx_sessions_used   ON sessions(last_used_at DESC);
