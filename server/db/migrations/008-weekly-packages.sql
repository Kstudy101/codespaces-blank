-- 008-weekly-packages.sql
-- 1〜4週パッケージ（21days / 28days）を ENUM に足す。
-- 販売停止した 30days・60days・101days も ENUM に残す ── 過去購入行が
-- その値を持っているため。PACKAGES から外すことと ENUM から消すことは別。

ALTER TABLE purchases
  MODIFY COLUMN package_type
    ENUM('7days','14days','21days','28days','30days','60days','101days') NOT NULL;
