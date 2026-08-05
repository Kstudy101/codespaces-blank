/* ==================================================================
   webhook.mjs — LINE から来た 1 通を、種類ごとに配る

     import { handleWebhookBody } from './lib/webhook.mjs';
     const results = await handleWebhookBody(conn, parsedBody);

   署名の確認は signature.mjs、HTTP の受け口は app.mjs にあり、
   ここは「確かに LINE から来た JSON」を受け取ってからの担当。
   分けているのは、この振り分けを DB と偽の conn だけで
   確かめられるようにするため（tools/verify-webhook.mjs）。

   【1 通に複数のイベントが入る】
   events は配列で、別々の利用者のものが混ざる。1 つが失敗しても
   残りは処理する ── 1 人ぶんの取りこぼしで、同じ便に乗っていた
   他の人まで落とさない。失敗は結果に混ぜて返し、呼ぶ側が記録する。

   【再送について】
   LINE は同じイベントを再送することがある（こちらが 200 を返せ
   なかったとき）。deliveryContext.isRedelivery で分かるが、
   それを見て弾く作りにはしていない。理由は、ここのハンドラが
   どれも何度呼んでも同じ結果になるように書いてあるから:

     follow    … insertNew（1062 を捨てる）
     unfollow  … status を代入するだけ
     postback  … その学期の合否を代入するだけ
     message   … replyToken が 1 回きりなので 2 度目は届かない

   処理済みイベント ID を貯める表を足す手もあるが、貯めたものを
   消す仕組みまで要る。「何度やっても同じ」で足りるうちは、
   そちらの方が壊れる部品が少ない。
   ================================================================== */
import { handleFollow, handleUnfollow } from "./handlers/follow.mjs";
import { handleMessage } from "./handlers/message.mjs";
import { handlePostback } from "./handlers/postback.mjs";

export const HANDLED_TYPES = Object.freeze(["follow", "unfollow", "message", "postback"]);

/* opts は postback へそのまま渡す（transact 注入・plan-outage-billing §2-2）。
   本番は app.mjs が withTransaction を渡し、関門は渡さない（既定＝
   同じ conn でそのまま）── handlers が db.mjs を直接読むと偽の conn の
   関門が壊れる、の同じ理由。 */
export async function handleEvent(conn, event, opts = {}) {
  switch (event?.type) {
    case "follow":   return { type: "follow",   ...(await handleFollow(conn, event)) };
    case "unfollow": return { type: "unfollow", ...(await handleUnfollow(conn, event)) };
    case "message":  return { type: "message",  ...(await handleMessage(conn, event)) };
    case "postback": return { type: "postback", ...(await handlePostback(conn, event, opts)) };
    default:
      /* join / leave / memberJoined など。使っていないだけで
         異常ではないので、記録に残して先へ進む。 */
      return { type: event?.type || "(不明)", skipped: "未対応の種類" };
  }
}

export async function handleWebhookBody(conn, body, opts = {}) {
  const events = Array.isArray(body?.events) ? body.events : [];

  /* 直列に回す。並列にすると、同じ人の follow と message が
     同じ便に入っていたときに順番が入れ替わりうる ──
     まだ users に居ない人へ message が先に届く。
     1 通に入るイベントは高々数件なので、直列で足りる。 */
  const results = [];
  for (const event of events) {
    try {
      results.push(await handleEvent(conn, event, opts));
    } catch (e) {
      results.push({
        type: event?.type || "(不明)",
        error: e && e.message ? e.message : String(e)
      });
    }
  }
  return results;
}
