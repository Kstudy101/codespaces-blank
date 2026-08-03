/* ==================================================================
   jst.mjs — 日本時間の壁時計を作る

     import { jstDate, jstDateTime, jstDayRange, addDays } from './jst.mjs';
     jstDate(new Date())        // → '2026-08-03'
     jstDateTime(new Date())    // → '2026-08-03 06:55:00'
     jstDayRange('2026-08-03')  // → ['2026-08-03 00:00:00', '2026-08-04 00:00:00']

   なぜ独立したファイルなのか。

   借りているサーバーの時計が JST とはかぎらない。cPanel の共用環境は
   UTC のことが多く、そこで new Date().toISOString().slice(0,10) を
   「今日」として使うと、日付が変わるのは JST の朝 9 時になる。
   朝 7 時の配信はその手前 ── つまり「今日もう送ったか」の判定が
   毎朝きっかり外れる。前日ぶんとして数えられるので、二重配信になる。

   直し方は 2 つある。サーバーの TZ 設定に合わせる（環境に依存する）か、
   時差を自分で足す（依存しない）か。後者を採る。日本は 1951 年を最後に
   夏時間が無く、以後ずっと UTC+9 の一定なので、足し算で正しく出る。
   utc + 9h してから getUTC* で読む、という形にしてあるのはそのため ──
   ローカル時刻を読む get* を使うと、結局サーバーの TZ が混ざる。

   四柱の方（saju.js）は 1954〜1961 の UTC+8:30 やサマータイムまで
   見ているが、あれは過去の生年月日を扱うから。こちらが見るのは
   「いま」と「配信した時刻」だけなので、その表は要らない。
   ================================================================== */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/* Date → JST の壁時計を持った Date（読み出しは必ず getUTC*）。
   ここで返るものは「UTC として読むと JST に見える」値なので、
   そのまま toISOString() して外へ出してはいけない。 */
function shifted(d) {
  return new Date(d.getTime() + JST_OFFSET_MS);
}

/* 'YYYY-MM-DD' */
export function jstDate(d = new Date()) {
  const j = shifted(d);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`;
}

/* 'YYYY-MM-DD HH:MM:SS' ── MySQL の DATETIME にそのまま入る形。
   T も Z も付けない。付けると型が合わず、ドライバによっては
   黙って別の時刻に変換される。 */
export function jstDateTime(d = new Date()) {
  const j = shifted(d);
  return `${jstDate(d)} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}`;
}

/* 日付文字列の足し算。Date を経由するので月末・閏年も正しい。
   trial_end = trial_start + 2 日（3 日間の体験）に使う。 */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/* その日の範囲。sent_at >= 開始 AND sent_at < 終了 で使う。
   BETWEEN や DATE(sent_at) = ? ではなく半開区間にするのは、
   前者が 23:59:59.4 を取りこぼし、後者が sent_at の索引を
   使えなくするため（列に関数をかけると索引が効かない）。 */
export function jstDayRange(dateStr) {
  return [`${dateStr} 00:00:00`, `${addDays(dateStr, 1)} 00:00:00`];
}
