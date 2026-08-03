/* ==================================================================
   token.mjs — 合言葉を作る・照合する

     import { newState, hashState } from './lib/token.mjs';
     const state = newState();            // ブラウザと LINE へ渡す
     await links.create(conn, hashState(state), ...);   // DB にはハッシュ

   state は OAuth の CSRF 対策そのもの。これが無い（または推測できる）と、
   攻撃者が自分の認証途中の URL を人に踏ませて、他人の四柱データを
   自分の LINE アカウントに引き継がせられる。

   Math.random() は使わない。予測できる乱数だと state の意味が消える。
   randomBytes は暗号用の乱数で、32 バイトあれば総当たりは成り立たない。

   base64url にするのは、URL のクエリに載せるため。素の base64 は
   + / = を含み、URL エンコードの有無で値が変わって照合に失敗する
   ── 「たまに通らない」という一番調べにくい壊れ方をする。

   DB へはハッシュにして入れる。生で持つと、表が漏れたときに
   まだ引き継いでいない四柱データを付け替えられる。
   ================================================================== */
import crypto from "node:crypto";

export function newState() {
  return crypto.randomBytes(32).toString("base64url");   // 43 文字
}

export function hashState(state) {
  return crypto.createHash("sha256").update(String(state), "utf8").digest("hex");
}

/* 形だけ先に見る。DB を引く前に弾けるものは弾く ──
   長さも文字種も違うものが来た時点で、こちらが出したものではない。 */
export function looksLikeState(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
}
