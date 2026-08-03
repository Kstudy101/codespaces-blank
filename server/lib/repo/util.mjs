/* ==================================================================
   repo/util.mjs — repo の 4 つが共有する小道具

   ここから下（repo/*.mjs）は mysql2 を読まない。受け取った conn の
   .execute(sql, params) しか使わないので、偽物を渡せば DB 無しで
   確かめられる。tools/verify-server.mjs がそうしている。
   ================================================================== */

/* 1 件だけ取る。無ければ null。undefined を返さないのは、
   「行が無い」と「列が無い」を呼び出し側で見分けられるようにするため。 */
export async function one(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows && rows.length ? rows[0] : null;
}

export async function all(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows || [];
}

/* 何行動いたか。UPDATE が本当に当たったかを見るのに要る。
   当たらなかったことを黙って通すと、進捗が進まないまま
   「送った」ログだけが残る。 */
export async function run(conn, sql, params = []) {
  const [res] = await conn.execute(sql, params);
  return {
    affectedRows: res?.affectedRows ?? 0,
    insertId: res?.insertId ?? null,
    changedRows: res?.changedRows ?? 0
  };
}

/* ---- 「初めて入ったのか、もう在ったのか」 --------------------------
   ここは affectedRows で判定してはいけない。

   MySQL の資料には ON DUPLICATE KEY UPDATE の affectedRows は
   「新規 1 / 更新 2 / 変化なし 0」とある。それを前提に書いていたが、
   本物の MySQL に当てて測ると新規も重複も 1 が返った:

     mysql2 の既定           新規 1  重複 1   ← 見分けられない
     flags: '-FOUND_ROWS'    新規 1  重複 0

   mysql2 が CLIENT_FOUND_ROWS を既定で立てるため、「見つかった行数」に
   変わっていた。この既定のままだと、再送された決済が新規と同じ 1 を
   返す ── つまり保有日数が二度足される。請求は通っているので、
   利用者から言われるまで分からない。

   接続フラグを外して直すこともできるが、その場合は「値が同じ UPDATE」が
   全部 0 行扱いになり、updateName などが成功を失敗と報告しはじめる。
   フラグの設定ひとつで意味が反転する判定に金額を預けたくないので、
   素の INSERT を投げて一意制約の違反（1062）を捕まえる形にする。
   これはフラグにもドライバの版にも依存しない。

   使ってよいのは「PK 以外の一意キーが 1 本だけ」の表に限る。
   2 本あるとどちらに当たったのか区別できない。
   tools/verify-server.mjs がその条件を見張っている。 */
export function isDuplicateKey(e) {
  return !!e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062);
}

export async function insertNew(conn, sql, params = []) {
  try {
    const [res] = await conn.execute(sql, params);
    return { created: true, insertId: res?.insertId ?? null };
  } catch (e) {
    if (isDuplicateKey(e)) return { created: false, insertId: null };
    throw e;
  }
}

/* JSON 列。ドライバの版によって、解析済みの値が来ることも
   文字列のまま来ることもある。どちらでも同じものを返す。
   壊れた JSON は null にして捨てる ── 1 人ぶんの壊れたデータで
   その朝の配信全体を止めないため。 */
export function fromJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
}

/* 書くときは必ず文字列にする。オブジェクトのまま渡すと、
   ドライバによっては [object Object] が入る。 */
export function toJson(v) {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/* undefined を null に均す。渡し忘れた引数がそのまま SQL に届くと
   mysql2 は「Bind parameters must not contain undefined」で落ちる。
   落ちる場所が SQL なので、どの引数かは分からない。 */
export function nn(v) {
  return v === undefined ? null : v;
}
