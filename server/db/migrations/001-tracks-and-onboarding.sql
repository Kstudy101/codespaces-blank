-- ===================================================================
-- 001-tracks-and-onboarding.sql
--
-- 足すもの:
--   1  コース（初級・中級・上級）を 3 本の独立した講座にする
--   2  どちらの名前で呼ぶか（ウェブで入れた名前 / LINE の表示名）
--   3  生年月日が本人のものとして確かめられているか
--
-- schema.sql は書き換えない。あちらは CREATE TABLE IF NOT EXISTS で
-- できているので、既にデータが入っている表には効かない（migrate.mjs
-- の冒頭にそう書いてある）。本番には利用者と 50 日ぶんの原稿が
-- 入っているので、足すのはこちら側。
--
-- 【なぜ ENUM で、なぜ NULL 可なのか】
-- track は 3 つしか無く、増えるとしたら講座そのものを作り直す
-- ときなので ENUM にする。文字列にすると 'Beginner' と 'beginner' が
-- 別物として入り、どちらでも配信対象から静かに外れる。
--
-- learning_progress.track だけ NULL を許す。これが「まだ選んでいない」
-- を表す。既定値を 'beginner' にすると、選んでいない人が初級を
-- 受け取り始める ── 選ばせる前に始まってしまい、あとから
-- 「中級にしたい」と言われても既に日を消費している。
-- ===================================================================

-- ---- 1. 原稿をコース別にする ---------------------------------------
--
-- day_number だけが主キーだと、初級 1 日目と中級 1 日目が同じ行に
-- なる。track を主キーに含めて 3 本に分ける。
--
-- 既存の 50 行には DEFAULT が入る（初級）。1〜50 日目は
-- 「サイトから続く順序」で書いてあり（plan-p4-content.md 7-4）、
-- それは初級そのものなので、移し替える必要が無い。
ALTER TABLE content_templates
  ADD COLUMN track ENUM('beginner','intermediate','advanced')
             NOT NULL DEFAULT 'beginner' AFTER day_number;

ALTER TABLE content_templates DROP PRIMARY KEY;
ALTER TABLE content_templates ADD PRIMARY KEY (track, day_number);

-- 学期の索引もコース別に引く。track を先に置くのは、
-- 配信が必ず track で絞ってから学期を見るため。
ALTER TABLE content_templates DROP INDEX ix_templates_semester;
ALTER TABLE content_templates ADD KEY ix_templates_track_semester (track, semester);

-- その日の運勢に添える一言。原稿が用意する。
--
-- 「運勢をその日の文法で言う」ための場所。ここを機械に作らせない
-- ── 文法と運勢の取り合わせは人が読んで決めるもので、自動で
-- 当てはめると「-고 싶다」で財運を語るような文が出る。
-- 無ければ運勢だけを送る（NULL 可にしてあるのはそのため）。
ALTER TABLE content_templates
  ADD COLUMN fortune_bridge JSON NULL AFTER vocab_3;


-- ---- 2. どのコースを受けているか -------------------------------------
--
-- NULL = まだ選んでいない。配信バッチはこの人に日を送らず、
-- コース選択の案内を出す（db/push-daily.mjs）。日は進めない。
ALTER TABLE learning_progress
  ADD COLUMN track ENUM('beginner','intermediate','advanced') NULL AFTER user_id;


-- ---- 3. どちらの名前で呼ぶか -----------------------------------------
--
-- この講座は名前で進むので、どの名前を使うかが中身を決める。
--
--   web  … ウェブの診断で入れた名前（漢字・読み・ハングル表記が揃う）
--   line … LINE の表示名（ハングル表記はこちらで作れないので、
--          ニックネームをそのまま韓国語の行に出すことになる）
--
-- NULL = まだ訊いていない。既定を 'web' にしない ── ウェブで
-- 偽名を入れた人がそのまま偽名で 101 日呼ばれる。それを避けるのが
-- この列の目的なので、既定を置くと目的が消える。
ALTER TABLE users
  ADD COLUMN name_source ENUM('web','line') NULL AFTER name_kr;


-- ---- 4. 生年月日が確かめられているか ---------------------------------
--
-- ウェブの診断は「試しに入れてみる」場所でもあるので、生年月日が
-- 本人のものとはかぎらない。四柱と運勢はこれを土台にするので、
-- 確かめないまま 101 日ぶんの運勢を出すと、全部が別人のものになる。
--
-- 0 = 未確認。運勢は付けない（レッスンは送る）。
ALTER TABLE saju_profiles
  ADD COLUMN birth_confirmed BOOLEAN NOT NULL DEFAULT 0 AFTER birth_time;


-- ---- 5. 配信の種類に「案内」を足す -----------------------------------
--
-- 名前・生年月日・コースの確認は、送った回数を数えたい。数えないと
-- 答えない人へ毎朝送り続けることになり、ブロックされる。
-- ブロックは取り消せない（db/push-daily.mjs の NAME_NOTICE_MAX と
-- 同じ考え方）。
ALTER TABLE push_logs
  MODIFY COLUMN push_type
    ENUM('learning','review','quiz','upsell','completion','onboarding')
    NOT NULL DEFAULT 'learning';
