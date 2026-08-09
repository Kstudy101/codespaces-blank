-- ===================================================================
-- 007-trial-days.sql
--
-- 体験で貰った日数を、契約の行が自分で覚える。
--
-- ここまでは repo/billing.mjs の const TRIAL_DAYS を SQL に埋め込んで
-- 「期待される保有日数」を計算していた。定数を変えた瞬間、過去の契約が
-- 新しい定数で再計算される ── 既に体験を終えた人が全員 findEntitlementDrift
-- に載る。この通知は「払ったのに日数が足りない人」を放すためのもので、
-- 誤検知が常態化すると本物を読み飛ばす。
--
-- NULL 許容にしてある。DEFAULT を置くと、startTrial が書き忘れても
-- 既定値が静かに入り、7 日貰ったのに台帳は 3、が無音で生まれる。
-- NULL なら drift として即座に出る ── 黙って間違えるより、鳴って
-- 間違えるほうがよい。
ALTER TABLE subscriptions ADD COLUMN trial_days TINYINT UNSIGNED NULL;

-- 既存の体験者は全員 3 日で確定（追支給なし ── 2026-08-09 代表決定）。
UPDATE subscriptions
   SET trial_days = 3
 WHERE trial_start IS NOT NULL AND trial_days IS NULL;
