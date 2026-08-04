/* ==================================================================
   handlers/message.mjs — 利用者が何か送ってきた

   この講座は「毎朝こちらから送る」形なので、受け取ったメッセージに
   対話で応えることは想定していない。それでも人は必ず送ってくる ──
   「ありがとう」「解約したい」「今何日目？」。

   無言だと、届いていないのか無視されたのかが分からない。
   ここでは 3 つだけ返す。文面は決め打ちで、AI 応答は使わない
   （費用も、誤った韓国語を教える危険もあるため）。

     状況を訊く系   → 今何日目・残り何日
     止めたい系     → ブロックの案内（こちらから退会させない）
     それ以外       → 何もしない（既読のまま）

   「それ以外」に定型文を返さないのは、毎回同じ返事が来ると
   通知だけ増えて読まれなくなるため。朝夕 2 通が本体で、
   そこに雑音を混ぜたくない。
   ================================================================== */
import { users, billing, learning } from "../repo/index.mjs";
import { replyMessage } from "../line.mjs";
import { nextStep, messageForStep } from "../onboarding.mjs";

/* 受け取る文面は日本語。ひらがな・カタカナ・漢字が混ざるので
   単語の一致で見る（形態素解析は入れない）。 */
const ASK_STATUS = ["何日", "なんにち", "今日", "きょう", "残り", "のこり", "進捗", "ステータス"];
const ASK_STOP   = ["解約", "退会", "やめたい", "停止", "配信停止", "キャンセル"];

/* まだ始まっていない人が、始めるための言葉。

   quickReply のボタンは、次のメッセージが届くと押せなくなる。
   配信バッチは 3 回まで促して黙るので（db/push-daily.mjs の
   ONBOARD_NOTICE_MAX）、黙ったあとにボタンだけが残っていても
   押せない ── そこで手が無くなる。ここを開けておく。 */
const ASK_SETUP  = ["コース", "こーす", "初級", "中級", "上級", "設定", "はじめ", "始め", "名前", "なまえ", "生年月日"];

const hit = (text, words) => words.some((w) => text.includes(w));

export async function handleMessage(conn, event) {
  const lineUserId = event?.source?.userId;
  const replyToken = event?.replyToken;
  if (!lineUserId) return { skipped: "userId がありません" };

  /* テキスト以外（スタンプ・画像・音声）には応えない。 */
  if (event?.message?.type !== "text") {
    return { skipped: `text 以外: ${event?.message?.type}` };
  }
  const text = String(event.message.text || "");

  const user = await users.findByLineUserId(conn, lineUserId);
  if (!user) return { skipped: "未登録の利用者です", lineUserId };

  /* 始める前の 3 つ（名前・生年月日・コース）が残っていれば、
     状況を答えるより先にそれを出す。まだ 0 日目の人に
     「いま 0 日目まで進んでいます」と返しても、次にすることが
     分からない。 */
  const pending = await pendingStep(conn, user);
  if (pending && hit(text, [...ASK_SETUP, ...ASK_STATUS])) {
    if (replyToken && !isVerifyToken(replyToken)) {
      try {
        await replyMessage(replyToken, [pending]);
      } catch (e) {
        return { userId: user.id, replied: false, error: e.message };
      }
    }
    return { userId: user.id, replied: true, onboarding: true };
  }

  let reply = null;

  if (hit(text, ASK_STATUS)) {
    const [sub, prog] = await Promise.all([
      billing.getSubscription(conn, user.id),
      learning.getProgress(conn, user.id)
    ]);
    const done = prog ? Number(prog.current_day) : 0;
    const entitled = sub ? Number(sub.total_days_entitled) : 0;
    const left = Math.max(0, entitled - done);
    reply = left > 0
      ? `いま ${done} 日目まで進んでいます。残り ${left} 日ぶんお届けできます（全 ${learning.TOTAL_DAYS} 日）。`
      : `いま ${done} 日目まで進んでいます。お届けできる日数を使い切りました。続きはこちらから追加できます。`;
  } else if (hit(text, ASK_STOP)) {
    /* こちらから status を変えない。ブロックすれば unfollow が来て、
       そこで配信対象から外れる（handlers/follow.mjs）。
       文面だけで退会させると、言い回しの取り違えで
       買った人を止めてしまう。 */
    reply = "配信を止めたいときは、このトークをブロックしてください。すぐに停止します。"
          + "\n再開したいときは、もう一度友だち追加すれば続きからお届けします。";
  }

  if (!reply) return { userId: user.id, replied: false };

  /* replyToken は 1 回きり・数十秒で切れる。切れていても
     こちらの失敗ではないので、送信できなかったことだけ返す。 */
  if (replyToken && !isVerifyToken(replyToken)) {
    try {
      await replyMessage(replyToken, [{ type: "text", text: reply }]);
    } catch (e) {
      return { userId: user.id, replied: false, error: e.message };
    }
  }
  return { userId: user.id, replied: true };
}

/* 始める前に残っている 1 つ。無ければ null。
   段は lib/onboarding.mjs が中身から導く（列で持たない）ので、
   ここも handlers/postback.mjs も配信バッチも、同じものを見る。 */
async function pendingStep(conn, user) {
  const [saju, prog] = await Promise.all([
    users.getSajuProfile(conn, user.id),
    learning.getProgress(conn, user.id)
  ]);
  const state = {
    ...user,
    birth_date: saju ? saju.birth_date : null,
    birth_time: saju ? saju.birth_time : null,
    birth_confirmed: saju ? saju.birth_confirmed : false,
    track: prog ? prog.track : null
  };
  const step = nextStep(state);
  return step ? messageForStep(step, state) : null;
}

/* LINE Developers の「検証」ボタンは、返信できないダミーの
   replyToken（0 が並んだもの）で試しに 1 回叩いてくる。
   そのまま返信しようとすると 400 になる。 */
export function isVerifyToken(t) {
  return /^0+$/.test(String(t));
}
