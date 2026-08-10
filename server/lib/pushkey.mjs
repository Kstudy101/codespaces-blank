/* ==================================================================
   pushkey.mjs — LINE の重複防止キー（retryKey）を 1 本にする

     import { makeRetryKey } from "../lib/pushkey.mjs";
     const retryKey = makeRetryKey(DATE);
     retryKey(userId, day, type)   // → 'xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx'

   無作為な UUID ではなく、誰の・何日目の・何の便かから毎回同じ値に
   なるように作る ── バッチを掛け直したとき、こちら側の記録が残る前に
   落ちていても LINE 側が弾ける。形式は UUID でなければ受け取って
   もらえないので、ハッシュを 8-4-4-4-12 に切って版とバリアントの
   ビットだけ整える。

   【なぜ日付を引数ではなく束ねるのか】
   朝（push-daily）と夕（push-evening）が同じ 8 行を 1 本ずつ持っていた。
   写しが 2 か所にあると、片方だけ直した日に一方だけ二重配信を弾けなく
   なる ── しかも「弾けなかった」はログに異常として出ない。

   ただし date を第 4 引数にすると呼び出し形が変わり、関門が
   retryKey(userId, day, type) の 3 引数で呼んでいるので関門まで
   直すことになる。「検査はそのままに、実装だけ 1 本にする」ことが
   この移動の安全弁なので、日付を束ねた関数を返す形にした。
   呼び出し側も関門も 1 文字も変わらない（plan-refactor-push.md §1.3）。
   ================================================================== */
import { createHash } from "node:crypto";

export function makeRetryKey(date) {
  return function retryKey(userId, day, type) {
    const h = createHash("sha256").update(`${userId}:${day}:${type}:${date}`).digest("hex");
    const b = h.slice(0, 32).split("");
    b[12] = "5";                                   /* 版 5（名前から作った） */
    b[16] = "89ab"[parseInt(b[16], 16) % 4];       /* バリアント */
    const s = b.join("");
    return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
  };
}
