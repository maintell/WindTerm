-- 隧道配置（NET-001 / NET-003 / NET-004）
--
-- 之前隧道只存在于内存里：关掉应用就没了，每次都要重填。这里落库。
-- `listen_port = 0` 表示「系统随机分配」，不要把它改写成实际端口——
-- 那会把「每次随机」悄悄变成「固定某个端口」，下次启动可能撞上占用。
CREATE TABLE IF NOT EXISTS tunnels (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL,          -- local / remote / dynamic
    listen_host    TEXT NOT NULL,
    listen_port    INTEGER NOT NULL,
    target_host    TEXT,
    target_port    INTEGER,
    via_session_id TEXT,
    auto_start     INTEGER NOT NULL DEFAULT 0,
    rev            INTEGER NOT NULL DEFAULT 1
);
