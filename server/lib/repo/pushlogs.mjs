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
import { one, all, run, nn } from "./util.mjs";
import { jstDate, jstDateTime, jstDayRange } from "../jst.mjs";

export const PUSH_TYPES = Object.freeze(
  ["learning", "review", "quiz", "upsell", "completion"]);

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
   外れるので、条件を足す必要は無い。 */
export async function listReviewTargets(conn, date = null) {
  const [from, to] = jstDayRange(date || jstDate());
  return all(conn,
    `SELECT l.user_id, MAX(l.day_number) AS day_number,
            u.line_user_id, u.name_kanji, u.name_kr
       FROM push_logs l
       JOIN users u ON u.id = l.user_id
      WHERE l.push_type = 'learning' AND l.status = 'sent'
        AND l.sent_at >= ? AND l.sent_at < ?
        AND u.status IN ('trial', 'active')
      GROUP BY l.user_id, u.line_user_id, u.name_kanji, u.name_kr
      ORDER BY l.user_id`,
    [from, to]);
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
   運用に入ったら cron から月 1 で呼ぶ想定。
   既定を 400 日にしてあるのは、101 日を最後まで走った人の
   全期間が 1 年ぶんの中に収まるようにするため。 */
export async function purgeOlderThan(conn, days = 400) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) throw new Error(`days が不正: ${days}`);
  const r = await run(conn,
    `DELETE FROM push_logs WHERE sent_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [n]);
  return r.affectedRows;
}
