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
import { users, learning, entitlements } from "../repo/index.mjs";
import { replyMessage } from "../line.mjs";
import { nextStep, messageForStep, confirmName, readingRetry } from "../onboarding.mjs";
import { kanaNameToHangul } from "../kana2hangul.mjs";

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

  /* 進みの器が欠けていれば、触ってきたこの機会に置き直す
     （repo/learning.mjs healProgress）。失敗しても返事は続ける。 */
  try { await learning.healProgress(conn, user); } catch { /* 本処理を止めない */ }

  /* ---- ① で読み仮名を待っている人 ----------------------------------
     「LINE の名前で／べつの名前で」を選んで韓国語表記がまだ無い、が
     待っている印（name_source='line' かつ name_kr が空）。段の列は
     持たない方針のまま、中身から導く（lib/onboarding.mjs）。

     かなで読めたら候補を DB に置いて「〇〇 で OK?」を返す。確定は
     handlers/postback.mjs が DB の候補から作り直す ── ここで
     name_kr まで書かないのは、確認前の名前で配信が始まらないため。

     読めなければ案内をもう一度。サイトのリンクは readingRetry の
     末尾に**最後の手段**として載るだけで、主導線はあくまでトーク
     （元の「必ずサイトへ戻す」が離脱のもとだった）。 */
  if (user.name_source === "line" && !user.name_kr
      /* 解約の言葉だけは素通しする。「やめたい」を名前の候補として
         「야메타이 で OK?」と返すのは、いちばん悪いタイミングの冗談になる。
         状況系（きょう 等）は素通しにしない ── きょう は実在の名前。 */
      && !hit(text, ASK_STOP)) {
    const reading = text.trim();
    const kr = kanaNameToHangul(reading);
    const out = kr ? confirmName({ reading, kr }) : readingRetry();
    if (kr) {
      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: reading, nameKr: null });
    }
    if (replyToken && !isVerifyToken(replyToken)) {
      try {
        await replyMessage(replyToken, [out]);
      } catch (e) {
        return { userId: user.id, replied: false, error: e.message };
      }
    }
    return { userId: user.id, replied: true, reading: kr ? "candidate" : "retry" };
  }

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
    /* 残りは course_entitlements と days_used の引き算で出る
       （migrations/002）。current_day では出せない ──
       「1 日目からやり直す」で戻るのは current_day だけなので、
       そちらで数えるとやり直した人の残りが増えて見える。 */
    const track = user.active_track;
    const ent = track ? await entitlements.get(conn, user.id, track) : null;

    if (!ent) {
      reply = "まだ受講が始まっていません。"
            + "\n下のメニューの［受講料］からコースをお選びください。";
    } else {
      const left = Math.max(0, ent.remaining);
      reply = left > 0
        ? `いま ${ent.currentDay} 日目まで進んでいます。残り ${left} 日ぶんお届けできます（全 ${learning.TOTAL_DAYS} 日）。`
        : `いま ${ent.currentDay} 日目まで進んでいます。お届けできる日数を使い切りました。`
          + `\n下のメニューの［受講料］から追加できます。`;
    }
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
  const saju = await users.getSajuProfile(conn, user.id);
  const state = {
    ...user,
    birth_date: saju ? saju.birth_date : null,
    birth_time: saju ? saju.birth_time : null,
    birth_confirmed: saju ? saju.birth_confirmed : false,
    track: user.active_track || null
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
