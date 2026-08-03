/* ==================================================================
   signature.mjs — LINE から来たことを確かめる

     import { verifyLineSignature } from './lib/signature.mjs';
     verifyLineSignature(rawBody, req.headers['x-line-signature'], secret);

   webhook の URL は公開されていて、誰でも POST できる。署名を見ないと
   「友だち追加されました」も「クイズに正解しました」も他人が名乗れる。
   ここが通れば以降は本物として扱うので、この 20 行がシステム全体の
   境界になる。

   間違えやすい点が 3 つある。どれも「動いてはいる」ように見える。

   1 生のバイト列で計算する
     JSON.parse したものを JSON.stringify し直して計算してはいけない。
     鍵の順番・空白・数値の書式が変われば別のバイト列になり、
     正しい要求まで弾く。逆に、たまたま一致する書き方だと
     通ってしまう ── どちらに転んでも原因が署名だと気づけない。

   2 時間の差で漏らさない
     === で比べると、先頭から何文字目で違ったかが所要時間に出る。
     1 文字ずつ総当たりすれば署名を組み立てられるので、
     timingSafeEqual を使う。長さが違うと投げるため、長さは先に見る。

   3 base64。hex ではない
     LINE は base64 で送る。hex で比べると常に不一致になり、
     「なぜか全部 401」になる。
   ================================================================== */
import crypto from "node:crypto";

export function computeLineSignature(rawBody, channelSecret) {
  return crypto.createHmac("sha256", channelSecret)
    .update(rawBody)                 // Buffer のまま。文字列に直さない
    .digest("base64");
}

export function verifyLineSignature(rawBody, headerValue, channelSecret) {
  if (!channelSecret) throw new Error("LINE_CHANNEL_SECRET が設定されていません");
  if (!headerValue || typeof headerValue !== "string") return false;
  if (!Buffer.isBuffer(rawBody)) {
    /* 文字列で渡されると、UTF-8 以外の解釈で別のバイト列になりうる。
       呼び出し側の取り違えなので、黙って通さず投げる。 */
    throw new Error("rawBody は Buffer で渡してください（再シリアライズ禁止）");
  }

  const expected = Buffer.from(computeLineSignature(rawBody, channelSecret), "utf8");
  const got = Buffer.from(headerValue, "utf8");

  /* 長さが違えば timingSafeEqual が投げる。先に見て false を返す。
     長さの違いは署名の中身を漏らさない（base64 の桁数は固定）。 */
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}
