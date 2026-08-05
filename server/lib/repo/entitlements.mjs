/* ==================================================================
   repo/entitlements.mjs — course_entitlements

   「そのコースを何日ぶん買ったか」だけを持つ表。使ったぶんは
   learning_progress.days_used が持つ。

     残り = days_entitled - days_used

   【なぜ引き算にしたか。残りを 1 つの列で持たない理由】
   残りを直に持って減らしていく形にすると、減らす所と増やす所の
   両方が正しくないと合わない。どちらかが途中で落ちた日に、
   数字だけが静かにずれる ── しかも「本当は何日ぶん買ったのか」が
   もう分からないので、直しようが無い。

   買った日数と送った日数は、どちらも**増えるだけ**にしておく。
   台帳（purchases / push_logs）と突き合わせれば、いつでも作り直せる。

   【1 日目からやり直しても、残りは戻らない】
   これが plan-billing.md §3.2 そのもの。やり直しは current_day を
   0 に戻すが、days_used には触れない。触ると、10 日目まで受け取った
   人がやり直しを選ぶだけで 10 日ぶんを無料で受け取れる。

   ここも他の repo と同じで、渡された conn の execute() しか使わない。
   ================================================================== */
import { one, all, run } from "./util.mjs";
import { TRACKS, isTrack } from "./learning.mjs";

/* コース別の残り。progress がまだ無い（買ったが 1 日も受け取っていない）
   人のために LEFT JOIN にする。INNER にすると、買った直後の人が
   「残り 0」に見えて 1 日目が届かない。 */
const REMAINING_SQL = `
  SELECT e.user_id, e.track,
         e.days_entitled,
         COALESCE(p.days_used, 0)   AS days_used,
         COALESCE(p.current_day, 0) AS current_day,
         e.days_entitled - COALESCE(p.days_used, 0) AS remaining
    FROM course_entitlements e
    LEFT JOIN learning_progress p
           ON p.user_id = e.user_id AND p.track = e.track`;

export async function get(conn, userId, track) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
  const row = await one(conn, `${REMAINING_SQL} WHERE e.user_id = ? AND e.track = ?`,
    [userId, track]);
  return row ? shape(row) : null;
}

/* その人が持っているコース全部。買っていないコースは行が無い。
   画面に「どのコースを持っているか」を出すのに使う。 */
export async function listByUser(conn, userId) {
  const rows = await all(conn, `${REMAINING_SQL} WHERE e.user_id = ? ORDER BY e.track`,
    [userId]);
  return rows.map(shape);
}

function shape(r) {
  return {
    track: r.track,
    daysEntitled: Number(r.days_entitled),
    daysUsed: Number(r.days_used),
    currentDay: Number(r.current_day),
    remaining: Number(r.remaining)
  };
}

/* ---- 足す ----------------------------------------------------------
   買った日数を積む。減らす関数は置かない ── 返金は payment_status で
   表し、日数そのものは動かさない。動かせるようにしておくと、
   台帳（purchases）と合わなくなる道が 1 本できる。

   ON DUPLICATE KEY UPDATE で足す。ここは「新規か既存か」を見分ける
   必要が無いので、util.mjs の insertNew（1062 を捕まえる形）ではなく
   こちらでよい ── 見分けが要るのは金額の絡む creditPurchase の側で、
   あちらは purchases の payment_ref が止めている。 */
export async function grant(conn, userId, track, days) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const n = Number(days);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`日数が不正: ${days}`);

  await run(conn,
    `INSERT INTO course_entitlements (user_id, track, days_entitled)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE days_entitled = days_entitled + VALUES(days_entitled)`,
    [userId, track, n]);

  return get(conn, userId, track);
}

/* 残りがあるコースを 1 つ選ぶ。買ったのに active_track が入っていない
   （体験だけで止まっていた等）ときの受け皿。
   複数あれば track の並び順で先のもの ── 初級 → 中級 → 上級。 */
export async function firstWithRemaining(conn, userId) {
  const row = await one(conn,
    `${REMAINING_SQL}
      WHERE e.user_id = ? AND e.days_entitled - COALESCE(p.days_used, 0) > 0
      ORDER BY FIELD(e.track, 'beginner','intermediate','advanced')
      LIMIT 1`, [userId]);
  return row ? shape(row) : null;
}

/* 監視用。買ったのに 1 日も受け取っていない人が居ないか。
   居るなら、配信が始まらない理由がどこかにある。

   user_id と shape() を通した形で返す。生の行のまま返していたので、
   読む側（db/who.mjs）は常に「#?  beginner  bought=undefined」──
   誰のことかも何日ぶんかも読めない監視になっていた。 */
export async function listUnstarted(conn) {
  const rows = await all(conn,
    `${REMAINING_SQL}
      WHERE e.days_entitled > 0 AND COALESCE(p.days_used, 0) = 0
      ORDER BY e.user_id`);
  return rows.map((r) => ({ user_id: Number(r.user_id), ...shape(r) }));
}
