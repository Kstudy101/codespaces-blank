/* ==================================================================
   repo/pushlogs.mjs — push_logs

   送ったこと・送れなかったことを残す表。役目が 3 つある。

     1 二重配信を止める（今日もう送ったか）
     2 夕方の復習に「今朝どの日を送ったか」を渡す（計画書 4-2）
     3 失敗に気づく（計画書 P10）

   2 が要るのは、復習を進捗（learning_progress.current_day）から
   逆算できないため ── 朝の配信で current_day は既に +1 されている
   ので、そこから引き算すると、その日に配信を受けられなかった人
   （保有日数切れ・送信失敗）まで復習の対象に混ざる。
   実際に送ったログを見るのが唯一正しい。
   ================================================================== */
import { one, all, run, nn, fromJson } from "./util.mjs";
import { jstDate, jstDateTime, jstDayRange } from "../jst.mjs";

/* DB の ENUM（schema.sql + migrations/001）と同じ並び。2 か所に
   なるので、verify-server.mjs が両方を読んで突き合わせる。

   onboarding は名前・生年月日・コースの確認。数えるために種別を
   分けている ── 答えない人に毎朝送り続けるとブロックされ、
   ブロックは取り消せない。 */
/* expiring … 残り 2 日の予告（migrations/002）
   resume   … 買い直したときの「続きから / 最初から」の確認 */
export const PUSH_TYPES = Object.freeze(
  ["learning", "review", "quiz", "upsell", "completion", "onboarding",
   "expiring", "resume"]);

function assertType(t) {
  if (!PUSH_TYPES.includes(t)) {
    throw new Error(`未知の push_type: ${t}（${PUSH_TYPES.join(" / ")}）`);
  }
}

export async function logSent(conn, userId, { dayNumber = null, pushType = "learning", sentAt = null } = {}) {
  assertType(pushType);
  const r = await run(conn,
    `INSERT INTO push_logs (user_id, day_number, push_type, sent_at, status)
     VALUES (?, ?, ?, ?, 'sent')`,
    [userId, nn(dayNumber), pushType, sentAt || jstDateTime()]);
  return r.insertId;
}

/* 失敗も必ず残す。残さないと「配信が止まっている」に気づくのが
   利用者からの問い合わせになる。error_msg は原因の 1 行目だけで
   足りる ── LINE API の応答はそこに理由が入る。 */
export async function logFailed(conn, userId, { dayNumber = null, pushType = "learning", error = "" } = {}) {
  assertType(pushType);
  const msg = String(error && error.message ? error.message : error).slice(0, 1000);
  const r = await run(conn,
    `INSERT INTO push_logs (user_id, day_number, push_type, sent_at, status, error_msg)
     VALUES (?, ?, ?, ?, 'failed', ?)`,
    [userId, nn(dayNumber), pushType, jstDateTime(), msg]);
  return r.insertId;
}

/* 今日もう送ったか。日付の境目は JST（server/lib/jst.mjs）。

   DATE(sent_at) = ? と書かない。列に関数をかけると
   ix_push_user_type_time の sent_at 側が使えなくなり、
   その利用者の全ログを走査することになる ── 101 日 × 2 回ぶん
   溜まったころに、朝の配信そのものが遅れはじめる。

   status = 'sent' で絞るのは、失敗した日は「送った」に数えない
   ため。数えると、その人だけ翌日まで何も届かない。 */
export async function sentToday(conn, userId, pushType, date = null) {
  assertType(pushType);
  const [from, to] = jstDayRange(date || jstDate());
  const row = await one(conn,
    `SELECT id FROM push_logs
      WHERE user_id = ? AND push_type = ? AND status = 'sent'
        AND sent_at >= ? AND sent_at < ?
      LIMIT 1`,
    [userId, pushType, from, to]);
  return row !== null;
}

/* その人に、その日ぶんを何回送ったか。ふつうは 0 か 1 で、
   2 以上になるのは進みが止まっているときだけ。

   名前がまだ無い人がそうなる。名前を使う日に当たると、その日は
   本文の代わりに登録のお願いを送り、進みは止めたままにする ──
   進めてしまうとその日の内容が二度と届かない。止めた結果、
   翌朝も同じ日に当たるので、ここが 1 ずつ増えていく。
   何回まで促すかを決めるのに使う。毎朝送り続ければブロックされ、
   ブロックは取り消せない。 */
export async function countForDay(conn, userId, dayNumber, pushType = "learning") {
  assertType(pushType);
  const row = await one(conn,
    `SELECT COUNT(*) AS n FROM push_logs
      WHERE user_id = ? AND day_number = ? AND push_type = ? AND status = 'sent'`,
    [userId, dayNumber, pushType]);
  return row ? Number(row.n) : 0;
}

/* その人に、その種別を通算で何回送ったか。日をまたいで数える。

   オンボーディング（名前の選択・コース選択）に使う。こちらは
   countForDay では数えられない ── 日が進まないのは同じだが、
   day_number そのものが無い（何日目の話でもない）ので、
   NULL 同士の比較になって 1 件も当たらない。

   通算で数えるのは、促す上限が「その日に何回」ではなく
   「ぜんぶで何回」だから。毎朝 1 回ずつでも、3 日続けば
   3 回になる ── 答えない人にはそこで黙る。 */
export async function countByType(conn, userId, pushType) {
  assertType(pushType);
  const row = await one(conn,
    `SELECT COUNT(*) AS n FROM push_logs
      WHERE user_id = ? AND push_type = ? AND status = 'sent'`,
    [userId, pushType]);
  return row ? Number(row.n) : 0;
}

/* 今朝の学習配信で、その人に何日目を送ったか。夕方の復習が使う。
   届いていない人には null が返り、対象から外れる（計画書 5-6）。 */
export async function todaysLearningDay(conn, userId, date = null) {
  const [from, to] = jstDayRange(date || jstDate());
  const row = await one(conn,
    `SELECT day_number FROM push_logs
      WHERE user_id = ? AND push_type = 'learning' AND status = 'sent'
        AND sent_at >= ? AND sent_at < ?
      ORDER BY sent_at DESC LIMIT 1`,
    [userId, from, to]);
  return row ? Number(row.day_number) : null;
}

/* 夕方の復習バッチの対象。ここが計画書 4-2 の
   「今日の学習プッシュを受けたユーザーのみ」そのもの。

   users を join して line_user_id と名前まで取るのは、
   1 人ずつ引き直すと人数ぶんの往復になるため。
   upsell しか受けていない人（保有日数切れ）は push_type で
   外れるので、条件を足す必要は無い。

   取る列は listDeliverable と揃える。復習も朝と同じ renderer に
   通す（lib/render.mjs）ので、片方だけ列が足りないと、夕方だけ
   名前が入らない・五行が空になる ── どちらも文としては成立
   するので、読み比べるまで気づけない。

   track も要る。コースごとに別の原稿を引くため。無いと、
   中級の人に初級の復習が届く。

   【day_number は MAX を取る】
   ふつうその日の learning は 1 件だが、名前案内も learning として
   残る（進みを止めたまま同じ日を数える仕組み）。MAX にしておけば
   実際に本文が行った日が取れる。 */
export async function listReviewTargets(conn, date = null) {
  const [from, to] = jstDayRange(date || jstDate());
  /* learning_progress はコース別に 1 行ずつになった（migrations/002）。
     track で絞らずに join すると、3 コース持っている人が 3 行になり、
     夕方だけ 3 通届く ── しかも 2 通は別のコースの復習になる。
     朝が配ったのは active_track のぶんなので、そこで結ぶ。

     users も active_track で見る。朝の便が active_track を見て
     配っているので、ここが別のものを見ると朝夕で内容がずれる。 */
  return all(conn,
    `SELECT l.user_id AS id, MAX(l.day_number) AS day_number,
            u.line_user_id, u.name_kanji, u.name_reading, u.name_kr,
            u.active_track AS track,
            j.ohaeng_main, j.raw_result_json
       FROM push_logs l
       JOIN users u ON u.id = l.user_id
       JOIN learning_progress p
              ON p.user_id = u.id AND p.track = u.active_track
       LEFT JOIN saju_profiles j ON j.user_id = u.id
      WHERE l.push_type = 'learning' AND l.status = 'sent'
        AND l.sent_at >= ? AND l.sent_at < ?
        AND u.status IN ('trial', 'active')
        AND u.active_track IS NOT NULL
      GROUP BY l.user_id, u.line_user_id, u.name_kanji, u.name_reading, u.name_kr,
               u.active_track, j.ohaeng_main, j.raw_result_json
      ORDER BY l.user_id`,
    [from, to])
    .then((rows) => rows.map((r) => ({ ...r, raw_result_json: fromJson(r.raw_result_json) })));
}

/* その日の集計。P10 の通知が読む。
   件数だけでなく種類別に出すのは、「朝は出たが夕方が丸ごと
   落ちた」を合計だけ見ていると読み取れないため。 */
export async function dailySummary(conn, date = null) {
  const [from, to] = jstDayRange(date || jstDate());
  return all(conn,
    `SELECT push_type, status, COUNT(*) AS n
       FROM push_logs
      WHERE sent_at >= ? AND sent_at < ?
      GROUP BY push_type, status
      ORDER BY push_type, status`,
    [from, to]);
}

export async function listFailures(conn, date = null) {
  const [from, to] = jstDayRange(date || jstDate());
  return all(conn,
    `SELECT id, user_id, day_number, push_type, sent_at, error_msg
       FROM push_logs
      WHERE status = 'failed' AND sent_at >= ? AND sent_at < ?
      ORDER BY sent_at`,
    [from, to]);
}

/* 古いログを落とす。溜め続ける理由が無い表なので、
   db/maintain.mjs が日次で呼ぶ（削れるのは 400 日より前だけ）。
   既定を 400 日にしてあるのは、101 日を最後まで走った人の
   全期間が 1 年ぶんの中に収まるようにするため。 */
export async function purgeOlderThan(conn, days = 400) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) throw new Error(`days が不正: ${days}`);
  const r = await run(conn,
    `DELETE FROM push_logs WHERE sent_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [n]);
  return r.affectedRows;
}

/* 消さずに数えるだけ（maintain --dry-run 用）。purgeOlderThan と
   同じ WHERE を使う ── 別々に書くと、片方だけ直した日に
   「数えた件数と消えた件数が違う」が起きる。 */
export async function countOlderThan(conn, days = 400) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) throw new Error(`days が不正: ${days}`);
  const row = await one(conn,
    `SELECT COUNT(*) AS n FROM push_logs WHERE sent_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [n]);
  return row ? Number(row.n) : 0;
}
