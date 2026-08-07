-- 006-oauth-states.sql — LINE Login state の用途（link / edit）
--
-- pending_links は四柱データの預かり。用途の判別は別表に分ける。
-- 混在すると link 用 state が profile 編集で消費される（plan-profile §2）。

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash  CHAR(64) NOT NULL PRIMARY KEY,
  purpose     ENUM('link','edit') NOT NULL,
  created_at  DATETIME NOT NULL,
  expires_at  DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  KEY ix_oauth_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
