/* ==================================================================
   handlers/message.mjs — 利用者が何か送ってきた

   この講座は「毎朝こちらから送る」形なので、受け取ったメッセージに
   対話で応えることは想定していない。それでも人は必ず送ってくる ──
   「ありがとう」「解約したい」「今何日目？」。

   無言だと、届いていないのか無視されたのかが分からない。
   ここでは 4 つだけ返す。文面は決め打ちで、AI 応答は使わない
   （費用も、誤った韓国語を教える危険もあるため）。

     状況を訊く系   → 今何日目・残り何日
     受講料を訊く系 → リッチメニューの［受講料］と同じ応答・同じ門
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
import { profileEligible, profileStartUrl } from "./profile.mjs";
import { recoverUser, welcomeMessages } from "./follow.mjs";
import { askCourse, notReady, salesAllowedFor, salesMode, missingLegalConfig,
         sellableTracks, statusMessage, inTrialNow, trialInProgress } from "./checkout.mjs";

/* 受け取る文面は日本語。ひらがな・カタカナ・漢字が混ざるので
   単語の一致で見る（形態素解析は入れない）。 */
/* 「進み具合」はリッチメニューの displayText と同じ語 ── 押した
   吹き出しを見て、そのまま打つ人が出る（richmenu.mjs）。 */
const ASK_STATUS = ["何日", "なんにち", "今日", "きょう", "残り", "のこり", "進捗", "ステータス", "進み具合"];
const ASK_STOP   = ["解約", "退会", "やめたい", "停止", "配信停止", "キャンセル"];

/* まだ始まっていない人が、始めるための言葉。

   quickReply のボタンは、次のメッセージが届くと押せなくなる。
   配信バッチは 3 回まで促して黙るので（db/push-daily.mjs の
   ONBOARD_NOTICE_MAX）、黙ったあとにボタンだけが残っていても
   押せない ── そこで手が無くなる。ここを開けておく。 */
const ASK_SETUP  = ["コース", "こーす", "初級", "中級", "上級", "設定", "はじめ", "始め", "名前", "なまえ"];

/* 受講料を言葉で訊いてくる語。下の案内文（ASK_STATUS の返事）が
   「下のメニューの［受講料］」と書いているので、その語をそのまま
   打つ人が必ず出る ── リッチメニューが未登録の間は、ここだけが
   入口になる（2026-08-06 指示書 §0 の実測）。 */
export const ASK_PLANS = ["受講料", "じゅこうりょう", "料金", "値段", "いくら",
                          "購入", "買い", "買いたい", "申し込", "支払"];

/* 登録情報の変更（plan-profile §2 — リッチメニューに載せない入口） */
export const ASK_PROFILE = ["情報を変更", "情報変更", "登録情報", "プロフィール", "変更したい"];

const hit = (text, words) => words.some((w) => text.includes(w));

/* send は差し替えられる（handlers/postback.mjs の { send } と同じ形）。
   既定は本物の replyMessage ── 検査だけが応答の中身を受け取るために
   差し替える。replyToken の扱い（isVerifyToken・try/catch・失敗時の
   { replied: false, error }）はどの分岐でも同じ。 */
export async function handleMessage(conn, event, { send = replyMessage } = {}) {
  const lineUserId = event?.source?.userId;
  const replyToken = event?.replyToken;
  if (!lineUserId) return { skipped: "userId がありません" };

  /* テキスト以外（スタンプ・画像・音声）には応えない。 */
  if (event?.message?.type !== "text") {
    return { skipped: `text 以外: ${event?.message?.type}` };
  }
  const text = String(event.message.text || "");

  let user = await users.findByLineUserId(conn, lineUserId);
  if (!user) {
    /* 黙って返していた所。友だちのままなら follow は二度と来ないので、
       ここで返さないとその人は永久に何も受け取れない ── リッチメニューは
       出ているので、押しても打っても無反応な画面だけが残る
       （handlers/follow.mjs の recoverUser 参照）。 */
    user = await recoverUser(conn, lineUserId);
    const back = await welcomeMessages(conn, user);
    if (replyToken && !isVerifyToken(replyToken) && back.length) {
      try {
        await send(replyToken, back);
      } catch (e) {
        return { userId: user.id, recovered: true, replied: false, error: e.message };
      }
    }
    return { userId: user.id, recovered: true, replied: true };
  }

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
  if (!user.name_kr
      /* 「LINEの名前で／べつの名前で」を選んだ人（name_source='line'）と、
         サイト名の選択肢がそもそも無い直接流入（name_source も
         name_kanji も無い）── PENDING.reading と同じ区分け。
         ウェブ名がある未選択の人（name_kr あり）はここに来ない。 */
      && (user.name_source === "line" || (!user.name_source && !user.name_kanji))
      /* 解約の言葉だけは素通しする。「やめたい」を名前の候補として
         「야메타이 で OK?」と返すのは、いちばん悪いタイミングの冗談になる。
         状況系（きょう 等）は素通しにしない ── きょう は実在の名前。 */
      && !hit(text, ASK_STOP)
      && !hit(text, ASK_PROFILE)) {
    /* name_reading は VARCHAR(50)。トークの自由入力に上限は無いので、
       切らずに入れると errno 1406 で throw し、本人には何も返らない。
       link.mjs の str(v, 50) と同じ切り方。 */
    const reading = text.trim().slice(0, 50);
    const kr = kanaNameToHangul(reading);
    const out = kr ? confirmName({ reading, kr }) : readingRetry();
    if (kr) {
      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: reading, nameKr: null });
    }
    if (replyToken && !isVerifyToken(replyToken)) {
      try {
        await send(replyToken, [out]);
      } catch (e) {
        return { userId: user.id, replied: false, error: e.message };
      }
    }
    return { userId: user.id, replied: true, reading: kr ? "candidate" : "retry" };
  }

  /* ---- 受講料を言葉で訊いてきた --------------------------------------
     応答はリッチメニューの action=plans（handlers/postback.mjs）と
     **同じ関数**で組む。似た応答を別に作ると、後で片方だけ直す日が来る。

     順番の決めごと（上から強い順）:
       1 ASK_STOP の語が混ざる文（「購入をキャンセルしたい」）は取らない
         ── やめたい人に価格表を返すのは最悪の売り込みになる。従来どおり
         下の ASK_STOP の分岐が受ける（既存動作を変えない）
       2 pending（始める前の確認）より先に見る ── postback の plans は
         pending を見ずに答えるので、ここだけ pending で止めると
         同じ意図に違う応答が出る（指示書 §3-3）
       3 ASK_SETUP と重なる文（「コースの受講料はいくら」）はこちらが
         取る ── 価格の語が入る方が意図が具体的。素の「コース」は
         従来どおり下の pending の分岐が受ける */
  if (hit(text, ASK_PLANS) && !hit(text, ASK_STOP)) {
    /* 販売の門。postback.mjs の plans と同じ判定・同じ応答・同じログ ──
       plans / plan / buy / ここ の 4 か所とも salesAllowedFor を通す。
       1 か所でも素通りすると、テスト鍵を入れた日に実利用者へ決済リンクが
       出る（handlers/checkout.mjs の門）。自前の判定は書かない。 */
    if (!salesAllowedFor(user)) {
      console.error("[checkout] 販売停止中:", `mode=${salesMode()}`,
        missingLegalConfig().join(" / ") || "(法定表示は充足)");
      if (replyToken && !isVerifyToken(replyToken)) {
        try {
          await send(replyToken, [notReady()]);
        } catch (e) {
          return { userId: user.id, replied: false, error: e.message };
        }
      }
      return { userId: user.id, replied: true, blocked: "販売停止" };
    }

    /* 体験の 7 日が終わるまでは価格表を出さない（대표 지시 2026-08-10）。
       押して来た道（postback の plans）と**同じ関数**で判定する ──
       打って来た人だけが買える抜け道を作らない。 */
    if (await inTrialNow(conn, user)) {
      if (replyToken && !isVerifyToken(replyToken)) {
        try {
          await send(replyToken, [trialInProgress()]);
        } catch (e) {
          return { userId: user.id, replied: false, error: e.message };
        }
      }
      return { userId: user.id, replied: true, blocked: "体験中" };
    }

    const owned = (await entitlements.listByUser(conn, user.id)).map((e) => e.track);
    /* 売れるコースだけ。postback の plans と同じ関数を通る ──
       打って来た人と押して来た人で一覧が違う、を作らない（지시서⑯ §4）。 */
    const tracks = await sellableTracks(conn);
    if (replyToken && !isVerifyToken(replyToken)) {
      try {
        await send(replyToken, tracks.length ? [askCourse({ owned, only: tracks })]
                                             : [notReady()]);
      } catch (e) {
        return { userId: user.id, replied: false, error: e.message };
      }
    }
    if (!tracks.length) return { userId: user.id, replied: true, blocked: "原稿不足" };
    return { userId: user.id, replied: true, plans: true, tracks };
  }

  /* ---- 登録情報の変更 -----------------------------------------------
     オンボーディング完了者だけ Web フォームへ。未完了は LINE の段で
     直す（plan-profile §0）。 */
  if (hit(text, ASK_PROFILE) && !hit(text, ASK_STOP)) {
    const saju = await users.getSajuProfile(conn, user.id);
    const replyMsg = profileEligible(user, saju)
      ? { type: "text",
          text: "登録情報の変更は、下のボタンから行えます。",
          quickReply: { items: [{
            type: "action",
            action: { type: "uri", label: "情報を変更", uri: profileStartUrl() }
          }] } }
      : { type: "text",
          text: "まだ登録が完了していません。上の案内に従って、コース選択まで進めてください。" };
    if (replyToken && !isVerifyToken(replyToken)) {
      try {
        await send(replyToken, [replyMsg]);
      } catch (e) {
        return { userId: user.id, replied: false, error: e.message };
      }
    }
    return { userId: user.id, replied: true, profile: profileEligible(user, saju) };
  }

  /* 始める前の 3 つ（名前・生年月日・コース）が残っていれば、
     状況を答えるより先にそれを出す。まだ 0 日目の人に
     「いま 0 日目まで進んでいます」と返しても、次にすることが
     分からない。 */
  const pending = await pendingStep(conn, user);
  if (pending && hit(text, [...ASK_SETUP, ...ASK_STATUS])) {
    if (replyToken && !isVerifyToken(replyToken)) {
      try {
        await send(replyToken, [pending]);
      } catch (e) {
        return { userId: user.id, replied: false, error: e.message };
      }
    }
    return { userId: user.id, replied: true, onboarding: true };
  }

  /* string か LINE メッセージオブジェクト。進み具合は statusMessage と
     同じ文面・同じ quickReply にする（リッチメニュー［何日目？］と揃える）。 */
  let reply = null;

  if (hit(text, ASK_STATUS)) {
    reply = await statusMessage(conn, user);
  } else if (hit(text, ASK_STOP)) {
    /* こちらから status を変えない。ブロックすれば unfollow が来て、
       そこで配信対象から外れる（handlers/follow.mjs）。
       文面だけで退会させると、言い回しの取り違えで
       買った人を止めてしまう。 */
    /* 「友だち追加すれば続きから」とは言わない ── 再追加だけでは
       再開されない（再開ロジックは保留中）。嘘の約束を置くより、
       再開の道は人に渡す（2026-08-05 指示書 §1-A①）。
       「進んだところは消えません」は事実で、安心を与えるので残す。 */
    reply = "配信を止めたいときは、このトークをブロックしてください。すぐに止まります。"
          + "\n進んだところは消えません。"
          + "\n再開をご希望のときは、下のメニューの［お問い合わせ］からご連絡ください。";
  }

  if (!reply) return { userId: user.id, replied: false };

  /* replyToken は 1 回きり・数十秒で切れる。切れていても
     こちらの失敗ではないので、送信できなかったことだけ返す。 */
  if (replyToken && !isVerifyToken(replyToken)) {
    try {
      const msgs = typeof reply === "string" ? [{ type: "text", text: reply }] : [reply];
      await send(replyToken, msgs);
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
  /* ONBOARD_COLUMNS（lib/onboarding.mjs）を全部運ぶ ── stateOf
     （handlers/postback.mjs）と同じ形。verify-onboarding が見張る。 */
  const state = {
    ...user,
    birth_date: saju ? saju.birth_date : null,
    birth_time: saju ? saju.birth_time : null,
    birth_confirmed: saju ? saju.birth_confirmed : false,
    gender: saju ? saju.gender : "U",
    ohaeng_main: saju ? saju.ohaeng_main : null,
    raw_result_json: saju ? saju.raw_result_json : null,
    track: user.active_track || null
  };
  const step = nextStep(state);
  /* messageForStep は async・conn 必須（track 段が原稿の日数を引く）。 */
  return step ? await messageForStep(step, state, conn) : null;
}

/* LINE Developers の「検証」ボタンは、返信できないダミーの
   replyToken（0 が並んだもの）で試しに 1 回叩いてくる。
   そのまま返信しようとすると 400 になる。 */
export function isVerifyToken(t) {
  return /^0+$/.test(String(t));
}
