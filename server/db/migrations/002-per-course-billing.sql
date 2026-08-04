-- ===================================================================
-- 002-per-course-billing.sql
--
-- 前払いの回数券にする。月額の自動更新ではない（docs/plan-billing.md）。
--
-- 足すもの:
--   1  進みをコース別にする（1 人が初級 → 中級 と続けられるように）
--   2  「使った日数」を進みと分けて持つ
--   3  コース別の保有日数
--   4  いま受けているコース
--   5  購入をコースに結ぶ
--   6  配信の種類（期限予告・再開の確認）
--   7  離脱の台帳
--
-- 【なぜ 2 が要るのか ── ここを外すと無料で受け取れる】
-- 「1 日目からやり直す」を入れると、進み（current_day）が 0 に戻る。
-- 残りを days_entitled - current_day で数えていると、戻した瞬間に
-- 残りが買った日数まで復活する。10 日目まで受け取った人が
-- やり直しを選べば、その 10 日ぶんが無料になる。
--
-- 実際に送った日数（days_used）は減らさない、と決める。やり直しても
-- 日数は使う ── そのほうが正直で、説明もできる。
--
--   残り = days_entitled - days_used     ← current_day は使わない
-- ===================================================================

-- ---- 1. 進みをコース別に -------------------------------------------
--
-- 今は UNIQUE(user_id) なので 1 人 1 コース。101 日を終えても
-- 次のコースへ移れない。
--
-- ★ 順序が命。user_id には schema.sql の外部キー（fk_progress_user）が
--   掛かっていて、InnoDB は FK の列を先頭に持つ索引を常に 1 本
--   要求する。旧索引（uq_progress_user）を先に落とすと、その瞬間に
--   支えが無くなり 1553 で止まる ── 本番で実際に止まった
--   （2026-08-05 配備失敗、docs/plan-deploy-auto.md の初回実走）。
--   だから**代わりの索引を先に作り、旧索引は最後に落とす**。
--   新索引 (user_id, track) は先頭が user_id なので FK を支えられる。

-- track が鍵の一部になるので NULL を許せない。NULL のまま残っている
-- のは「まだ選んでいない人」で、その人は 1 日も受け取っていない
-- （db/push-daily.mjs はコース未選択で日を進めない）。
--
-- 進みを持っている行まで消さないよう current_day = 0 に限る。
-- もし 0 でない NULL 行があれば、次の MODIFY が NOT NULL で落ちる ──
-- 黙って消えるより、そこで止まったほうがよい。
DELETE FROM learning_progress WHERE track IS NULL AND current_day = 0;

ALTER TABLE learning_progress MODIFY COLUMN track
  ENUM('beginner','intermediate','advanced') NOT NULL;

-- 旧索引がまだ在っても作れる（UNIQUE(user_id) を満たす行は
-- UNIQUE(user_id, track) も満たす）。再実行では 1061「もう在る」で
-- 素通りする（migrate.mjs の ALREADY_APPLIED）。
ALTER TABLE learning_progress ADD UNIQUE KEY uq_progress_user_track (user_id, track);

-- 最後に旧索引を落とす。上の新索引が FK を支えているので通る。
-- 既に無ければ 1091「無い」で素通り ── 何度流しても同じ所に着く。
ALTER TABLE learning_progress DROP INDEX uq_progress_user;


-- ---- 2. 使った日数 --------------------------------------------------
--
-- current_day とは別物（冒頭の説明）。既存の行は、送った日数がそのまま
-- 進みなので写す。
ALTER TABLE learning_progress
  ADD COLUMN days_used INT NOT NULL DEFAULT 0 AFTER current_day;

UPDATE learning_progress SET days_used = current_day WHERE days_used = 0;


-- ---- 3. コース別の保有日数 ------------------------------------------
--
-- subscriptions.total_days_entitled は 1 人 1 つで、どのコースぶんか
-- を持てない。コースごとに買う形にしたので、こちらへ移す。
--
-- 買った日数は減らさない（使ったぶんは learning_progress.days_used）。
-- 引き算で残りを出すので、どちらも「増えるだけ」にしておくと
-- 途中で落ちたときに数が合わなくなる場面が無い。
CREATE TABLE IF NOT EXISTS course_entitlements (
  user_id       BIGINT NOT NULL,
  track         ENUM('beginner','intermediate','advanced') NOT NULL,
  days_entitled INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, track),
  CONSTRAINT fk_ent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 既にいる人ぶんを移す。total_days_entitled は「体験 3 日 + 購入」の
-- 合計で、コースの区別が無い。今いる人は初級しか受けていない
-- （コースを 1 つしか持てなかったので）ため、そのコースへ寄せる。
INSERT IGNORE INTO course_entitlements (user_id, track, days_entitled)
SELECT p.user_id, p.track, s.total_days_entitled
  FROM learning_progress p
  JOIN subscriptions s ON s.user_id = p.user_id;


-- ---- 4. いま受けているコース ----------------------------------------
--
-- 同時に進めるコースは 1 つ。配信バッチはこの列だけを見る。
-- 他のコースの残りは course_entitlements に残るので、戻って来られる。
--
-- NULL = まだ何も始めていない（買っても体験してもいない）。
ALTER TABLE users
  ADD COLUMN active_track ENUM('beginner','intermediate','advanced') NULL AFTER status;

UPDATE users u
   SET active_track = (SELECT p.track FROM learning_progress p
                        WHERE p.user_id = u.id ORDER BY p.track LIMIT 1)
 WHERE active_track IS NULL;


-- ---- 5. 購入をコースに結ぶ ------------------------------------------
--
-- どのコースぶんの日数かが無いと、コース別の残りを立てられない。
ALTER TABLE purchases
  ADD COLUMN track ENUM('beginner','intermediate','advanced') NULL AFTER user_id;

UPDATE purchases SET track = 'beginner' WHERE track IS NULL;


-- ---- 6. 体験をどのコースで使ったか -----------------------------------
--
-- 体験はコースを選んでから始める。ここを持たないと、コースを変えて
-- 3 コースぶん（9 日）受け取れてしまう。
--
-- trial_start が入っていれば「もう使った」。1 アカウント 1 回。
ALTER TABLE subscriptions
  ADD COLUMN trial_track ENUM('beginner','intermediate','advanced') NULL AFTER trial_end;

-- total_days_entitled は course_entitlements へ移した（上の 3）。
-- 残すと「どちらが本当の残りか」がコードから読めなくなる ── 読まれない
-- 列に古い数字が入っていると、次に触る人はそれを信じる。落とす。
--
-- ★ この 1 文だけは戻せない。流す前に上の INSERT ... SELECT が
--   通っていることを確かめること（migrate.mjs は course_entitlements の
--   有無を数えるので、そこで落ちていれば先へ進まない）。
ALTER TABLE subscriptions DROP COLUMN total_days_entitled;


-- ---- 7. 配信の種類を足す --------------------------------------------
--
--   expiring … 残り 2 日の予告
--   resume   … 買い直したときの「続きから / 最初から」
ALTER TABLE push_logs
  MODIFY COLUMN push_type
    ENUM('learning','review','quiz','upsell','completion','onboarding',
         'expiring','resume')
    NOT NULL DEFAULT 'learning';


-- ---- 8. 離脱の台帳 --------------------------------------------------
--
-- 「途中で切れて、そのあと何もない人」を見るための表。
--
-- ここは本来この저장소の決めごと（導けるものを保存しない、
-- lib/onboarding.mjs）に反する。残りが 0 かどうかは今の値から出せる。
--
-- それでも表を置くのは、push_logs を 400 日で落とすため
-- （repo/pushlogs.mjs の purgeOlderThan）。落ちたあとは「いつ切れたか」
-- を復元できない。これは派生ではなく消失なので、出来事だけを残す。
--
-- 現在の状態（今も切れているか）は持たない。それは今の値から出る。
-- 【二重に書かない仕組みが 2 段ある】
-- ① 開いている行（resumed_at IS NULL）があれば書かない ── これで
--    切れている間ずっと毎朝 1 行ずつ増える、を防ぐ
-- ② それでも同じ朝にバッチが二重に走れば、①は両方とも「無い」を見る。
--    そこは一意制約で止める。日付までを鍵にするので、episode が
--    変わった別の日には改めて入る
CREATE TABLE IF NOT EXISTS lapse_log (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT NOT NULL,
  track       ENUM('beginner','intermediate','advanced') NOT NULL,
  lapsed_on   DATE     NOT NULL,           -- 一意にするための日付（JST）
  lapsed_at   DATETIME NOT NULL,
  last_day    INT NOT NULL,                -- どこまで受け取って止まったか
  days_bought INT NOT NULL,                -- その時点で買っていた日数
  resumed_at  DATETIME NULL,               -- 買い直したらその時刻
  UNIQUE KEY uq_lapse_day (user_id, track, lapsed_on),
  -- まだ戻っていない人を引く。resumed_at を先に置くのは、
  -- そこが等値（IS NULL）で、lapsed_at が範囲になるため。
  KEY ix_lapse_open (resumed_at, lapsed_at),
  CONSTRAINT fk_lapse_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
