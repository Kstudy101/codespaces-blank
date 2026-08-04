/* ==================================================================
   repo/lapses.mjs — lapse_log（離脱の台帳）

   「途中で日数が切れて、そのあと何もない人」を見るための表。

   【この表は、本当は置かないほうが筋が通る】
   この저장소は「導けるものを保存しない」を明示的に守っている
   （lib/onboarding.mjs の段の話）。保存すると実際の値と 2 つの真実が
   でき、食い違ったときにどちらを信じるか決められなくなるため。

   「いま切れているか」は今の値から出る ── course_entitlements と
   learning_progress.days_used を引き算すればよい。だから状態は
   持たない。ここに置くのは**出来事**だけにする。

   【それでも置く理由は 1 つだけ】
   repo/pushlogs.mjs の purgeOlderThan が配信ログを 400 日で落とす。
   落ちたあとは「いつ切れたのか」「どこまで受け取っていたのか」を
   復元できない。これは派生ではなく消失なので、残す値打ちがある。

   だから列は 5 つしかない ── いつ・どのコースで・何日目まで・
   その時いくら買っていたか・戻って来たか。それ以外は今の値から出る。
   ================================================================== */
import { one, all, run, insertNew } from "./util.mjs";
import { isTrack } from "./learning.mjs";
import { jstDate, jstDateTime } from "../jst.mjs";

/* ---- 切れたことを 1 度だけ書く --------------------------------------
   二重に書かない仕組みが 2 段ある。

   ① 開いている行（resumed_at IS NULL）があれば書かない
      これが無いと、切れているあいだ毎朝 1 行ずつ増える
   ② それでも同じ朝にバッチが二重起動すれば、①は両方とも「無い」を
      見る。そこは一意制約（user_id, track, lapsed_on）で止める

   ②を affectedRows ではなく 1062 で見るのは util.mjs の insertNew に
   書いた理由と同じ。lapse_log の一意キーは 1 本なので、1062 は
   「同じ日にもう書いた」だけを意味すると確定できる。 */
export async function openIfAbsent(conn, userId, track, {
  lastDay = 0, daysBought = 0, now = null, on = null
} = {}) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);

  const open = await findOpen(conn, userId, track);
  if (open) return { created: false, lapse: open };

  const ins = await insertNew(conn,
    `INSERT INTO lapse_log (user_id, track, lapsed_on, lapsed_at, last_day, days_bought)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, track, on || jstDate(), now || jstDateTime(),
     Number(lastDay) || 0, Number(daysBought) || 0]);

  return { created: ins.created, lapse: await findOpen(conn, userId, track) };
}

export async function findOpen(conn, userId, track) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
  return one(conn,
    `SELECT id, user_id, track, lapsed_on, lapsed_at, last_day, days_bought, resumed_at
       FROM lapse_log
      WHERE user_id = ? AND track = ? AND resumed_at IS NULL
      ORDER BY lapsed_at DESC LIMIT 1`, [userId, track]);
}

/* ---- 戻って来た ----------------------------------------------------
   買い直したときに閉じる。閉じるのは開いている行だけ ── 過去に
   閉じた行の resumed_at を書き換えると、何度目の離脱だったのかが
   分からなくなる。

   買い直しても戻って来なかった（買ったが受け取らない）人は、
   ここでは扱わない。それは entitlements.listUnstarted の担当。 */
export async function markResumed(conn, userId, track, { now = null } = {}) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
  const r = await run(conn,
    `UPDATE lapse_log SET resumed_at = ?
      WHERE user_id = ? AND track = ? AND resumed_at IS NULL`,
    [now || jstDateTime(), userId, track]);
  return r.affectedRows > 0;
}

/* ---- 見る ----------------------------------------------------------
   まだ戻っていない人。運営者が読む唯一の入口なので、ここで
   名前も生年月日も引かない ── 出す先が配置ログで、あとから
   誰でも読める（db/who.mjs と同じ決めごと）。 */
function int(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export async function listOpen(conn, { limit = 200, offset = 0 } = {}) {
  /* LIMIT / OFFSET は ? で渡せない（mysql2 が文字列で送るため
     MySQL が撥ねる）。repo/users.mjs の int() と同じ理由。 */
  return all(conn,
    `SELECT l.id, l.user_id, l.track, l.lapsed_on, l.last_day, l.days_bought,
            TIMESTAMPDIFF(DAY, l.lapsed_at, NOW()) AS days_since
       FROM lapse_log l
      WHERE l.resumed_at IS NULL
      ORDER BY l.lapsed_at DESC
      LIMIT ${int(limit, 200)} OFFSET ${int(offset, 0)}`);
}

export async function countOpen(conn) {
  const row = await one(conn,
    `SELECT COUNT(*) AS n FROM lapse_log WHERE resumed_at IS NULL`);
  return row ? Number(row.n) : 0;
}

/* どこで抜けているか。コース×日目で数える ── 特定の日に集中して
   いれば、その日の原稿に原因がある可能性が高い。 */
export async function summary(conn) {
  return all(conn,
    `SELECT track,
            COUNT(*)                                   AS total,
            SUM(resumed_at IS NULL)                    AS still_open,
            ROUND(AVG(last_day), 1)                    AS avg_last_day,
            MIN(last_day)                              AS min_last_day,
            MAX(last_day)                              AS max_last_day
       FROM lapse_log
      GROUP BY track
      ORDER BY track`);
}

export async function listByUser(conn, userId) {
  return all(conn,
    `SELECT id, track, lapsed_on, lapsed_at, last_day, days_bought, resumed_at
       FROM lapse_log WHERE user_id = ? ORDER BY lapsed_at`, [userId]);
}
