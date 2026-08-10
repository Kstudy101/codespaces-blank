/* ==================================================================
   repo/users.mjs — users と saju_profiles

   この 2 つを 1 つのファイルに置いているのは、表ごとに切ると
   バラバラに見えるが、実際には必ず一緒に生まれるため ──
   友だち追加（users）と占い結果の引き継ぎ（saju_profiles）は
   計画書 5-1 の 1 本の流れで、片方だけできた状態に意味が無い。

   どの関数も第 1 引数に conn を取る。プールでも、
   トランザクション中の 1 本でも、検証用の偽物でも同じように動く。
   ================================================================== */
import { one, all, run, insertNew, fromJson, toJson, nn } from "./util.mjs";
import { jstDateTime } from "../jst.mjs";
/* コースの一覧はここでも要る（active_track）。写しを作らず、
   learning.mjs の 1 部を読む ── 2 つ持つと、片方だけ増やしたときに
   「入るのに配信対象から外れる」コースができる。 */
import { TRACKS } from "./learning.mjs";

const COLS = `id, line_user_id, display_name, name_kanji, name_reading,
              name_kr, name_source, followed_at, status, active_track,
              created_at, updated_at`;

export async function findById(conn, id) {
  return one(conn, `SELECT ${COLS} FROM users WHERE id = ?`, [id]);
}

export async function findByLineUserId(conn, lineUserId) {
  return one(conn, `SELECT ${COLS} FROM users WHERE line_user_id = ?`, [lineUserId]);
}

/* ---- 友だち追加 ---------------------------------------------------
   ブロック → 再追加で follow イベントはもう一度来る。line_user_id が
   UNIQUE なので 2 件目は入らないが、ここで大事なのは status を
   触らないこと。

   計画書 5-1 は「再추가 시 기존 유저 status를 trial로 갱신」と書いて
   いるが、そのとおりに書くと 101 日分を買った人が一度ブロックして
   戻ってきただけで trial に落ちる ── 保有日数は subscriptions 側に
   残っているのに配信が体験扱いになる、という直しにくい壊れ方をする。

   なので、ここは「居ることを確かにする」だけにして、status を
   どうするかは呼び出し側（P3 のオンボーディング）に決めさせる。
   戻り値の created で、新規か再追加かは分かる。 */
export async function upsertOnFollow(conn, { lineUserId, displayName = null, followedAt = null }) {
  const now = followedAt || jstDateTime();

  /* ON DUPLICATE KEY UPDATE で 1 文にまとめない。まとめると
     「初めてか、もう在ったか」を affectedRows で見ることになり、
     mysql2 の既定ではそれが見分けられない（util.mjs の insertNew 参照）。
     users の一意キーは line_user_id 1 本なので、1062 が返れば
     それは再追加だと確定できる。 */
  const ins = await insertNew(conn,
    `INSERT INTO users (line_user_id, display_name, followed_at, status)
     VALUES (?, ?, ?, 'trial')`,
    [lineUserId, nn(displayName), now]);

  if (!ins.created) {
    /* 再追加。status には触らない ── 上の説明のとおり。
       display_name は渡されたときだけ更新する（COALESCE の引数側）。 */
    await run(conn,
      `UPDATE users
          SET display_name = COALESCE(?, display_name),
              followed_at  = ?
        WHERE line_user_id = ?`,
      [nn(displayName), now, lineUserId]);
  }

  return { user: await findByLineUserId(conn, lineUserId), created: ins.created };
}

/* 名前の 3 つは、ウェブ側の変換結果をそのまま持ってくる。ここで
   作り直さない ── 計画書 3 のとおり、トップページの hanja_db と
   1 文字でも違うと、利用者は「自分の名前ではない」と受け取る。 */
export async function updateName(conn, id, { nameKanji, nameReading, nameKr }) {
  const r = await run(conn,
    `UPDATE users SET name_kanji = ?, name_reading = ?, name_kr = ? WHERE id = ?`,
    [nn(nameKanji), nn(nameReading), nn(nameKr), id]);
  return r.affectedRows > 0;
}

/* ---- どちらの名前で呼ぶか ------------------------------------------
   この講座は名前で進むので、どの名前を使うかが中身そのものを決める。
   ウェブの診断は「試しに入れてみる」場所でもあり、そこで入れた名前が
   本人の呼ばれたい名前とはかぎらない ── 偽名のまま 101 日呼ばれると、
   個人化した教材であることの意味が無くなる。

   line を選んだ人には name_kr が無い。LINE の表示名は日本語か英字で、
   ハングル表記はこちらでは作れない（ウェブの hanja_db が要る）。
   なので line を選ぶと「名前を使う日」は名前案内に切り替わる ──
   render.mjs が name_kr の有無だけを見る作りなので、分岐は増えない。 */
const NAME_SOURCES = ["web", "line"];

export async function setNameSource(conn, id, source) {
  if (!NAME_SOURCES.includes(source)) {
    throw new Error(`未知の name_source: ${source}（${NAME_SOURCES.join(" / ")} のどれか）`);
  }
  const r = await run(conn, `UPDATE users SET name_source = ? WHERE id = ?`, [source, id]);
  return r.affectedRows > 0;
}

const STATUSES = ["trial", "active", "expired", "unfollowed", "completed"];

export async function setStatus(conn, id, status) {
  /* ENUM に無い値を渡すと、MySQL の設定によっては例外ではなく
     空文字が入る。そうなると status IN ('trial','active') に
     二度と当たらず、その人だけ静かに配信が止まる。 */
  if (!STATUSES.includes(status)) {
    throw new Error(`未知の status: ${status}（${STATUSES.join(" / ")} のどれか）`);
  }
  const r = await run(conn, `UPDATE users SET status = ? WHERE id = ?`, [status, id]);
  return r.affectedRows > 0;
}

export async function markUnfollowed(conn, lineUserId) {
  const r = await run(conn,
    `UPDATE users SET status = 'unfollowed' WHERE line_user_id = ?`, [lineUserId]);
  return r.affectedRows > 0;
}

/* 整数であることを確かめてから文字列に埋める。
   LIMIT ? を prepared statement で渡すと、mysql2 は値を文字列として
   送るため MySQL が「Incorrect arguments to mysqld_stmt_execute」で
   撥ねる ── 他の ? と同じ書き方なのにここだけ落ちる、という
   気づきにくい失敗の仕方をする。
   埋める値は必ず自分で作った整数なので、これで注入の余地は無い。 */
function int(v, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/* 朝夕の配信バッチがひく本体。status で絞ってから join する。
   LIMIT / OFFSET を持たせているのは、人数が増えたときに
   全員ぶんを一度にメモリへ載せないため。

   四柱も一緒に取る。この講座は四柱で韓国語を教えるので、本文に
   五行と干支が出る（lib/render.mjs）。1 人ずつ引き直すと人数ぶんの
   往復になるので、ここで一度に取る。

   LEFT JOIN にしてあるのは、友だち追加だけで四柱がまだ無い人が
   いるため。INNER にすると、その人たちが対象から丸ごと消えて、
   「登録したのに何も来ない」になる ── しかも一覧に出ないので
   運営者からも見えない。

   name_reading（ふりがな）も取る。日本語の行に出すのはこちらで、
   name_kanji ではない。取っていなかったので、バッチが漢字を
   ふりがなとして渡していた。

   オンボーディングの 3 つ（name_source / birth_confirmed / track）も
   ここで取る。どれも「まだ答えていない人には送らない」の判断に使い、
   1 人ずつ引き直すと人数ぶんの往復になる。

   birth_time も取る。運勢は生まれた時刻で時柱が変わるので、
   これが抜けていると全員が同じ時柱で占われる。 */
/* ---- コース別になった（migrations/002）------------------------------
   1 人が複数のコースを持つので、「どれを配るか」を決める列が要る。
   それが u.active_track で、ここは**それ 1 つだけ**を見る。

   同時に 2 コースを配らないのは、1 日に 2 通の「今日の 1 日目」が
   届く形になるため。他のコースの残りは course_entitlements に
   そのまま残るので、あとで戻って来られる。

   active_track が NULL の人は、まだ何も始めていない（買っても
   体験もしていない）。JOIN で自然に外れる。

   subscriptions は JOIN しない。買った日数はコース別の
   course_entitlements が持つようになり、あちらは体験の記録だけに
   なったので、配信の判断には要らない ── INNER のまま残すと、
   体験を使っていない人が丸ごと対象から消える。 */
const DELIVERABLE_SQL = `
  SELECT u.id, u.line_user_id, u.display_name,
         u.name_kanji, u.name_reading, u.name_kr, u.name_source, u.status,
         u.active_track AS track,
         p.current_day, p.days_used, p.current_semester,
         e.days_entitled,
         e.days_entitled - p.days_used AS remaining,
         j.ohaeng_main, j.raw_result_json, j.birth_date, j.birth_time,
         j.birth_confirmed, j.gender, j.lucky_hour_display
    FROM users u
    JOIN learning_progress   p ON p.user_id = u.id AND p.track = u.active_track
    JOIN course_entitlements e ON e.user_id = u.id AND e.track = u.active_track
    LEFT JOIN saju_profiles  j ON j.user_id = u.id
   WHERE u.status IN ('trial', 'active') AND u.active_track IS NOT NULL`;

/* BOOLEAN は TINYINT(1) で返る。0 を falsy として使うのは効いては
   いるが、意図してそう書いたのかが読めなくなる。 */
const shapeDeliverable = (r) => ({
  ...r,
  raw_result_json: fromJson(r.raw_result_json),
  birth_confirmed: !!r.birth_confirmed
});

export async function listDeliverable(conn, { limit = 500, offset = 0 } = {}) {
  const rows = await all(conn,
    `${DELIVERABLE_SQL}
      ORDER BY u.id
      LIMIT ${int(limit, 500)} OFFSET ${int(offset, 0)}`);
  return rows.map(shapeDeliverable);
}

/* 1 人だけ。決済の直後に「いますぐ 1 日目」を送るのに使う
   （db/push-daily.mjs の deliverNow）。

   listDeliverable を引いて絞り込む形にはしない ── 501 人目から
   見つからなくなり、しかも「買ったのに何も来ない」という、
   人数が増えてから出る壊れ方をする。 */
export async function findDeliverable(conn, userId) {
  const row = await one(conn, `${DELIVERABLE_SQL} AND u.id = ?`, [userId]);
  return row ? shapeDeliverable(row) : null;
}

/* ---- いま受けているコースを切り替える --------------------------------
   購入と体験開始のときに呼ぶ。ここを通らずに配信が始まることは無い
   （listDeliverable が active_track で JOIN しているため）。

   前のコースの残りは消えない。course_entitlements に残るので、
   戻ってきて買い足せば続きから受けられる。 */
export async function setActiveTrack(conn, id, track) {
  if (track !== null && !TRACKS.includes(track)) {
    throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")} のどれか）`);
  }
  const r = await run(conn, `UPDATE users SET active_track = ? WHERE id = ?`, [track, id]);
  return r.affectedRows > 0;
}

/* 退会。外部キーが CASCADE なので、四柱・購入・進捗・ログも一緒に消える。
   消える範囲を DB 側に持たせているのは、削除の手順書が
   privacy.html の約束になるため ── 消し忘れる表が 1 つでもあると、
   「消しました」が嘘になる。 */
export async function deleteUser(conn, id) {
  const r = await run(conn, `DELETE FROM users WHERE id = ?`, [id]);
  return r.affectedRows > 0;
}


/* ---- 四柱データ --------------------------------------------------- */

export async function getSajuProfile(conn, userId) {
  const row = await one(conn,
    `SELECT id, user_id, birth_date, birth_time, birth_confirmed, gender, ohaeng_main,
            lucky_hour_display, raw_result_json
       FROM saju_profiles WHERE user_id = ?`, [userId]);
  if (!row) return null;
  return {
    ...row,
    raw_result_json: fromJson(row.raw_result_json),
    birth_confirmed: !!row.birth_confirmed
  };
}

/* 1 人 1 枚（user_id が UNIQUE）。LINE Login のコールバックが
   二度走っても 2 枚目にならない。 */
export async function upsertSajuProfile(conn, userId, {
  birthDate = null, birthTime = null, gender = "U",
  ohaengMain = null, rawResult = null
} = {}) {
  await run(conn,
    `INSERT INTO saju_profiles
       (user_id, birth_date, birth_time, gender, ohaeng_main, raw_result_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       /* 生年月日が変わったら、確認済みを外す。
          「本当の誕生日で入れ直す」を選んだ人はここを通るので、
          外さないと入れ直した値が確認済みのまま通ってしまう。

          この 1 行を birth_date の代入より**前**に置くこと。MySQL は
          左から順に評価するので、ここでの birth_date はまだ古い値。
          下に置くと新しい値どうしを比べることになり、常に一致して
          確認済みが落ちない。<=> は NULL 同士も等しいと見る。 */
       birth_confirmed = IF(birth_date <=> VALUES(birth_date), birth_confirmed, 0),
       birth_date      = VALUES(birth_date),
       birth_time      = VALUES(birth_time),
       gender          = VALUES(gender),
       ohaeng_main     = VALUES(ohaeng_main),
       raw_result_json = VALUES(raw_result_json)`,
    [userId, nn(birthDate), nn(birthTime), gender || "U",
     nn(ohaengMain), toJson(rawResult)]);
  return getSajuProfile(conn, userId);
}
