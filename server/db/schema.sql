-- ===================================================================
-- schema.sql — LINE 配信システムの土台となる 9 テーブル
-- （8 つで始まり、P3 で pending_links が加わった）
--
--   適用:  node server/db/migrate.mjs
--
-- 実行計画書 v3「2. データベーススキーマ」をそのまま写したものではない。
-- 写すと壊れる箇所が 6 つあったので、理由をその場に書いて直してある。
-- 計画書と読み比べる人が「なぜ違うのか」を探さずに済むようにするため。
--
--   1 文字コード   utf8mb4。既定の latin1 では日本語も韓国語も入らない
--   2 users.status 'completed' を足す（計画書 5-5 が使うのに ENUM に無い）
--   3 一意制約     payment_ref・saju_profiles.user_id・learning_progress.user_id
--   4 索引         push_logs の「今日もう送ったか」を毎日 2 回、全員分ひく
--   5 外部キー     退会時に消す範囲を DB 側で確定させる
--   6 日時         JST で入れる。理由は下の「時刻について」
--
-- 【時刻について】
-- 借りているサーバーの時計が JST とはかぎらない（cPanel の共用環境は
-- UTC のことが多い）。DATETIME は時差を持たない型なので、入れた側と
-- 読む側で解釈がずれると「今日もう送ったか」の判定が 9 時間ぶんずれ、
-- 早朝 7 時の配信がちょうどその窓に入る ── 一番静かに壊れる場所。
--
-- そこで DATETIME には必ず JST の壁時計を入れる、と決める。
--
-- 気をつける点が 1 つ。mysql2 の timezone オプションはドライバの
-- 変換設定であって、DB のセッション時刻ではない。実際に測ると
--
--   timezone オプションだけ … @@session.time_zone=SYSTEM, NOW()=07:15（UTC）
--   SET time_zone を出した後 … +09:00,                    NOW()=16:15（JST）
--
-- と 9 時間ずれる。ずれるのは下の DEFAULT CURRENT_TIMESTAMP を持つ列
-- （users.created_at / purchases.purchased_at / push_logs.sent_at）で、
-- アプリが入れる JST と同じ表に混ざる。混ざったあとでは、どの行が
-- どちらだったのか区別できない。
--
-- なので server/lib/db.mjs は接続のたびに SET time_zone = '+09:00' を
-- 出す。migrate.mjs はそれが効いているかを毎回確かめ、SYSTEM のままなら
-- 失敗にする。tools/verify-server.mjs がこの取り決め自体を見張る。
-- ===================================================================

-- ---- 利用者 --------------------------------------------------------
--
-- line_user_id は LINE の userId（U + 英数 32 字の 33 字）。
-- 64 字あれば足りるが、これが本人を指す唯一の鍵なので UNIQUE にする。
-- 友だち追加 → ブロック → 再追加で follow イベントは二度来るため、
-- 一意でないと同じ人が二人になり、配信も課金も二重になる。
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  line_user_id    VARCHAR(64)  NOT NULL,
  display_name    VARCHAR(100) NULL,               -- LINE の表示名
  name_kanji      VARCHAR(50)  NULL,               -- 本人が入れた名前（漢字）
  name_reading    VARCHAR(50)  NULL,               -- カタカナ／ひらがな読み
  name_kr         VARCHAR(50)  NULL,               -- 韓国語表記（例: 다나카）
  followed_at     DATETIME     NOT NULL,
  -- 'completed' は計画書 5-5（101 日修了）が使う。計画書の ENUM 定義には
  -- 無く、本文だけが「追加が必要」と書いていたので、ここで足しておく。
  status          ENUM('trial','active','expired','unfollowed','completed')
                  NOT NULL DEFAULT 'trial',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_line_user_id (line_user_id),
  -- 配信バッチが毎日ひく条件。status で絞ってから join する。
  KEY ix_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- 四柱データ ----------------------------------------------------
--
-- トップページ（uranai）で計算済みのものを引き継ぐだけで、ここでは
-- 計算しない。raw_result_json に元の結果をそのまま残すのは、あとから
-- 算出ロジックを直したときに「昔の人には何を見せたのか」を辿れるように。
--
-- user_id を UNIQUE にする。1 人 1 枚。無いと LINE Login のコールバックが
-- 二度走った（利用者が戻るボタンを押した等）だけで 2 枚目ができ、
-- どちらを読むかで五行が変わる。
CREATE TABLE IF NOT EXISTS saju_profiles (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id            BIGINT NOT NULL,
  birth_date         DATE   NULL,
  birth_time         TIME   NULL,                  -- 分からない人がいるので NULL 可
  gender             ENUM('M','F','U') NOT NULL DEFAULT 'U',
  ohaeng_main        VARCHAR(10) NULL,             -- 목/화/토/금/수
  -- 実際の配信時刻ではない。文面（「기운이 맑아지는 아침 7시」）を作るためだけの値で、
  -- 計画書 1-1 で配信は全員 7 時固定と決めている。列を残すのは、
  -- あとで時間を個人化する判断に戻れるようにするため。
  lucky_hour_display TIME   NOT NULL DEFAULT '07:00:00',
  raw_result_json    JSON   NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_saju_user (user_id),
  CONSTRAINT fk_saju_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- 購入履歴 ------------------------------------------------------
--
-- 積み上げ式なので 1 人が何件でも持つ。ここは「起きたこと」の台帳で、
-- 消したり書き換えたりしない。合計は subscriptions 側に持つ（下記）。
--
-- payment_ref を UNIQUE にするのが、この表でいちばん効く 1 行。
-- 決済サービスの webhook は同じイベントを二度以上届けることがあり
-- （再送は仕様であって障害ではない）、そのたびに行が増えると
-- 保有日数が二重に増える ── 金額の絡む取り違えなので、
-- アプリ側の if 文ではなく DB の制約で止める。
-- MySQL の UNIQUE は NULL を重複と見ないので、決済を伴わない
-- 手動付与（payment_ref = NULL）は何件でも入る。
CREATE TABLE IF NOT EXISTS purchases (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT NOT NULL,
  package_type    ENUM('7days','14days','30days','60days','101days') NOT NULL,
  days_granted    INT    NOT NULL,                 -- 7/14/30/60/101
  price_paid      INT    NOT NULL,                 -- 円。小数の無い通貨なので整数
  purchased_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payment_ref     VARCHAR(100) NULL,               -- 決済サービスの取引 ID
  UNIQUE KEY uq_purchases_payment_ref (payment_ref),
  KEY ix_purchases_user (user_id, purchased_at),
  CONSTRAINT fk_purchases_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- 契約状態 ------------------------------------------------------
--
-- total_days_entitled は purchases の合計 + 体験 3 日。毎回 SUM する
-- こともできるが、配信バッチが全員分を 1 日 2 回ひくので持たせる。
-- 持たせた以上ずれうるので、ずれを検出する手立てを repo 側に置く
-- （server/lib/repo/billing.mjs の recountEntitledDays）。
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id             BIGINT NOT NULL,
  trial_start         DATE NULL,
  trial_end           DATE NULL,                   -- trial_start + 2 日（3 日間）
  total_days_entitled INT  NOT NULL DEFAULT 3,
  payment_status      ENUM('none','trial','paid','expired','refunded')
                      NOT NULL DEFAULT 'none',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_subscriptions_user (user_id),
  CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- 学習の進み ----------------------------------------------------
--
-- current_day は「何日目まで送り終えたか」。次に送るのは +1 日目。
-- 再購入しても戻さない（計画書 5-3）。
--
-- 夕方の復習とチェックポイントのクイズは、ここを動かさない。
-- 「保有日数を削らないボーナス」という取り決め（計画書 1-2）が
-- 守られているかは、この列が動かないことで確かめられる。
CREATE TABLE IF NOT EXISTS learning_progress (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id          BIGINT NOT NULL,
  current_day      INT NOT NULL DEFAULT 0,         -- 0〜101
  current_semester INT NOT NULL DEFAULT 1,         -- 1〜4
  last_sent_at     DATETIME NULL,
  quiz_pass_log    JSON NULL,                      -- {"semester1": true, ...}
  UNIQUE KEY uq_progress_user (user_id),
  CONSTRAINT fk_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- 配信内容 ------------------------------------------------------
--
-- 101 日ぶんの原稿。利用者に紐づかない共通データなので、ここだけは
-- 運営者が管理画面（P9）から書き換える対象になる。
--
-- requires_name_slot は「この日の文に名前を入れても不自然でないか」。
-- 全 101 日のうち 15〜20 日ぶんだけ true になる想定（計画書 3）。
-- 既定を FALSE にしてあるのは、入れ忘れが「名前が出ない」で済み、
-- 逆にすると「-고 싶다 다나카」のような文が配信されてしまうため。
CREATE TABLE IF NOT EXISTS content_templates (
  day_number         INT PRIMARY KEY,              -- 1〜101。連番は振らない
  semester           INT NOT NULL,                 -- 1〜4
  grammar_point      VARCHAR(100) NOT NULL,        -- 例: "-입니다 / -입니까?"
  grammar_tip_kr     TEXT NULL,                    -- 短い説明（韓／日 併記）
  dialogue_template  JSON NULL,                    -- {NAME} を含む 3〜4 文
  vocab_3            JSON NULL,                    -- [{kr, meaning, note}] ×3
  requires_name_slot BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_templates_semester (semester)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- 配信ログ ------------------------------------------------------
--
-- 「今日もう送ったか」を毎日 2 回、利用者全員ぶんひく。索引が無いと
-- 人数ぶんの全表走査になり、増えたときに朝の配信そのものが遅れる。
-- ix_push_user_type_time がその索引で、列の順番に意味がある ──
-- user_id と push_type は等値、sent_at は範囲で絞るため、
-- 範囲の列を最後に置かないと索引がそこで打ち切られる。
--
-- 失敗も残す（status='failed'）。送れなかったことが分からないと、
-- 「配信が止まっている」に気づくのが利用者の問い合わせになる。
CREATE TABLE IF NOT EXISTS push_logs (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT NOT NULL,
  day_number  INT NULL,                            -- upsell には日付が無いので NULL 可
  push_type   ENUM('learning','review','quiz','upsell','completion')
              NOT NULL DEFAULT 'learning',
  sent_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status      ENUM('sent','failed') NOT NULL DEFAULT 'sent',
  error_msg   TEXT NULL,
  KEY ix_push_user_type_time (user_id, push_type, sent_at),
  KEY ix_push_time (sent_at),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- クイズの節目 --------------------------------------------------
--
-- 30 / 50 / 75 日目。101 日目は修了メッセージなので入れない（計画書 1-2）。
-- 3 行しかない表をわざわざ作るのは、この 3 つが「学習日を置き換えない
-- ボーナス」であることを、コードの定数ではなくデータとして持つため ──
-- 節目を動かすのに配信バッチを直す必要が無くなる。
CREATE TABLE IF NOT EXISTS quiz_checkpoints (
  day_number INT PRIMARY KEY,
  semester   INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO quiz_checkpoints (day_number, semester) VALUES
  (30, 1),
  (50, 2),
  (75, 3);


-- ---- 引き継ぎ待ちの四柱 --------------------------------------------
--
-- P3（LINE Login）で足した表。順番の問題を吸収するためにある。
--
-- 占いはウェブで先に終わる。その時点で分かっているのは名前と生年月日
-- だけで、LINE の誰なのかはまだ分からない ── 分かるのは、この人が
-- LINE 認証から戻ってきた後。その間、四柱の結果を置いておく場所が要る。
--
-- 【鍵は生のまま置かない】
-- state（LINE へ渡す合言葉）はそのまま入れず、SHA-256 にして入れる。
-- 生で持つと、この表が漏れたときに「まだ引き継いでいない誰かの
-- 四柱データを、自分の LINE に付け替える」ことができてしまう。
-- 照合はハッシュ同士で行うので、生の値はブラウザと URL にしか出ない。
--
-- 【1 回しか使えない】
-- consumed_at で使用済みにする。同じ state で二度目が来ても
-- 通さない（戻るボタン・URL の使い回し）。
--
-- 【放っておくと溜まる】
-- 認証まで進まなかったぶんが残る。expires_at を過ぎたものは
-- repo/links.mjs の purgeExpired で落とす。生年月日を含むので、
-- 使われなかったものを持ち続ける理由が無い。
CREATE TABLE IF NOT EXISTS pending_links (
  state_hash      CHAR(64) PRIMARY KEY,          -- SHA-256(state) の 16 進
  name_kanji      VARCHAR(50)  NULL,
  name_reading    VARCHAR(50)  NULL,
  name_kr         VARCHAR(50)  NULL,
  birth_date      DATE         NULL,
  birth_time      TIME         NULL,
  gender          ENUM('M','F','U') NOT NULL DEFAULT 'U',
  ohaeng_main     VARCHAR(10)  NULL,
  raw_result_json JSON         NULL,
  created_at      DATETIME     NOT NULL,
  expires_at      DATETIME     NOT NULL,
  consumed_at     DATETIME     NULL,
  KEY ix_pending_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
