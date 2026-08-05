-- ===================================================================
-- 004-trial-end-pushtype.sql
--
-- 体験 2 日目の夕方の勧誘を、独立した種別 trial_end として数える
-- （plan-course-onboarding §6・2026-08-06 承認 修正 2）。
--
-- 最初の設計は「残り 0 の再購入案内（upsell）と同じ種別にして
-- day_number=2 で見分ける」だった。見分けを値の演算に任せると、
-- day_number に何を入れるかが 2 か所で独立に決まり、片方を直した日に
-- もう片方の「通算 1 回だけ」が黙って壊れる ── ENUM に 1 行足す
-- 費用のほうがずっと安い。
--
-- 数える側は repo/pushlogs.mjs の countByType。ENUM の並びは
-- PUSH_TYPES と同じでなければならず、verify-server が両方を読んで
-- 突き合わせる（このファイルが最新の並びの正）。
ALTER TABLE push_logs
  MODIFY COLUMN push_type
    ENUM('learning','review','quiz','upsell','completion','onboarding',
         'expiring','resume','trial_end')
    NOT NULL DEFAULT 'learning';
