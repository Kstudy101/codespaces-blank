/* ==================================================================
   repo/links.mjs — pending_links

   ウェブで出した四柱を、LINE 認証から戻ってくるまで預かる表。
   他の 4 つと違って利用者に紐づかない（まだ誰か分からないので）。

   ここも conn の execute() しか使わない。ハッシュ化だけは
   node:crypto が要るので、repo の外（lib/token.mjs）に置いて
   ハッシュ済みの値を受け取る ── repo/ が node の組み込みにも
   触らない、という P1 の取り決めを崩さないため。
   ================================================================== */
import { one, run, insertNew, fromJson, toJson, nn } from "./util.mjs";

/* 預かる時間。短すぎると LINE の認証画面で手間取った人が落ち、
   長すぎると生年月日を無意味に持ち続けることになる。
   認証は数十秒で終わるものなので 30 分あれば足りる。 */
export const TTL_MINUTES = 30;

export async function create(conn, stateHash, profile, { now, expiresAt }) {
  const {
    nameKanji = null, nameReading = null, nameKr = null,
    birthDate = null, birthTime = null, gender = "U",
    ohaengMain = null, rawResult = null
  } = profile || {};

  /* insertNew を使うのは、万一 state が衝突したときに
     既存の預かりものを黙って上書きしないため。32 バイトの
     乱数なので起きないが、起きたときに壊れる方向が悪い。 */
  const ins = await insertNew(conn,
    `INSERT INTO pending_links
       (state_hash, name_kanji, name_reading, name_kr,
        birth_date, birth_time, gender, ohaeng_main, raw_result_json,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [stateHash, nn(nameKanji), nn(nameReading), nn(nameKr),
     nn(birthDate), nn(birthTime), gender || "U", nn(ohaengMain),
     toJson(rawResult), now, expiresAt]);

  if (!ins.created) throw new Error("state が衝突しました");
  return true;
}

/* 取り出しと使用済みにするのを 1 文でやる。
   「探す → 使用済みにする」の 2 文に分けると、戻るボタンを
   連打されたときに両方が「未使用」を見て、2 回とも通る。
   UPDATE の当たった行数だけが、勝ったことの証拠になる。 */
export async function consume(conn, stateHash, { now }) {
  const claimed = await run(conn,
    `UPDATE pending_links
        SET consumed_at = ?
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    [now, stateHash, now]);

  if (claimed.affectedRows === 0) return null;

  const row = await one(conn,
    `SELECT state_hash, name_kanji, name_reading, name_kr,
            birth_date, birth_time, gender, ohaeng_main, raw_result_json
       FROM pending_links WHERE state_hash = ?`, [stateHash]);
  if (!row) return null;

  return { ...row, raw_result_json: fromJson(row.raw_result_json) };
}

/* 使われなかったぶんを落とす。生年月日が入っているので、
   期限切れを持ち続ける理由が無い。cron から日次で呼ぶ想定。 */
export async function purgeExpired(conn, { now }) {
  const r = await run(conn, `DELETE FROM pending_links WHERE expires_at <= ?`, [now]);
  return r.affectedRows;
}

/* 監視用。溜まりはじめたら、認証まで進めていない人が多いということ。 */
export async function countPending(conn, { now }) {
  const row = await one(conn,
    `SELECT COUNT(*) AS n FROM pending_links
      WHERE consumed_at IS NULL AND expires_at > ?`, [now]);
  return row ? Number(row.n) : 0;
}
