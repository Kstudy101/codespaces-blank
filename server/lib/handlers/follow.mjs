/* ==================================================================
   handlers/follow.mjs — 友だち追加 / ブロック

   計画書 5-1 のうち、LINE 側だけで完結する範囲をここで受け持つ。

     ・友だち追加  → users に居ることを確かにし、体験と進捗の器を作る
     ・ブロック    → status を 'unfollowed' にして配信対象から外す

   四柱データの引き継ぎ（LINE Login で web の結果と繋ぐ）は P3。
   ここでは「誰が来たか」までしか分からないので、名前も生年月日も
   まだ入らない。入れる場所（users.name_kr / saju_profiles）は
   空のまま用意されている。

   ハンドラは repo の関数しか呼ばない。表を直接触ると、
   「保有日数を削らない」「status を落とさない」といった取り決めが
   repo とここの 2 箇所に散る。
   ================================================================== */
import { users, billing, learning } from "../repo/index.mjs";
import { getProfile, replyMessage } from "../line.mjs";
import { serviceGuide, nextStep, messageForStep } from "../onboarding.mjs";

/* 診断ページの場所。LINE から案内するのはここだけ。 */
const SITE_URL = process.env.SITE_URL || "https://www.kstudy101.jp";

/* 友だち追加しただけの人には、名前がまだ無い。
   この講座は名前で進むので、1 日目から名前を使う ── 名前が
   入るまで進まない（db/push-daily.mjs）。黙っていると、
   翌朝いきなり「お名前を登録してください」だけが届いて、
   何のことか分からないまま終わる。ここで先に伝える。

   サイトを通ってきた人には送らない。その人はもう名前がある。 */
function welcomeForNameless() {
  return {
    type: "text",
    text: [
      "ご登録ありがとうございます。",
      "101日間の韓国語レッスンを、毎日おとどけします。",
      "",
      "──────────",
      "📖 どんな講座か",
      "──────────",
      "韓国語を、あなたの**名前**と**四柱**で学びます。",
      "教科書の「ミンスさん」ではなく、例文の主語があなたです。",
      "",
      "・会話文はあなたが「私」として登場します",
      "　場面（買い物・道をたずねる・自己紹介…）ごとに、",
      "　ご自身の名前で言えるようになります",
      "　たとえば「다나카는 일본에서 왔어요」のように",
      "・韓国式の占い（사주・운세・기운）が毎朝つきます",
      "",
      "朝 7時　運勢 ＋ 文法 ＋ 会話 ＋ 単語3語",
      "夕 6時　その文法をもう一度（復習）",
      "",
      "コースは 初級・中級・上級 の3つ。",
      "それぞれ101日ぶんの別の講座です。",
      "",
      "──────────",
      "▼ はじめに、こちらでお名前を入れてください（1分ほど）",
      SITE_URL,
      "診断のあと「LINEで受け取る」を押すと、ここに繋がります。",
      "",
      "お名前が登録できたら、コースをお訊きします。"
    ].join("\n")
  };
}

/* 表示名は LINE から取れるが、取れなくても止めない。
   プロフィール取得は追加の 1 往復で、ここが 5xx を返しただけで
   友だち追加そのものが失敗するのは割に合わない。 */
async function displayNameOf(lineUserId, profile) {
  try {
    const p = await profile(lineUserId);
    return p && p.displayName ? String(p.displayName).slice(0, 100) : null;
  } catch {
    return null;
  }
}

/* reply / profile を差し替えられるようにしてある。この関数で
   一番間違えたくないのが「名前がある人に案内を送らない」で、
   それは本物の LINE へ送ってみても、送ってしまったあとにしか
   分からない。偽物を渡して、呼ばれたかどうかを見る。 */
export async function handleFollow(conn, event,
  { reply = replyMessage, profile = getProfile } = {}) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };

  const displayName = await displayNameOf(lineUserId, profile);
  const { user, created } = await users.upsertOnFollow(conn, { lineUserId, displayName });

  /* 体験と進捗の器を用意する。どちらも既にあれば何もしない。
     ここを friendly に「作り直す」と、ブロック→再追加のたびに
     体験が延び、進捗が 0 に戻る。 */
  const trial = await billing.startTrial(conn, user.id);
  await learning.ensureProgress(conn, user.id);

  /* 再追加のときの status。upsertOnFollow は触らないので、ここで決める。

     'unfollowed' のまま放置すると配信対象（trial / active）に戻らず、
     戻ってきた人に何も届かない。かといって一律 'trial' にすると
     101 日買った人が体験に落ちる（repo/users.mjs の注釈）。
     払った履歴があるかで決める。 */
  if (!created && user.status === "unfollowed") {
    const sub = trial.subscription;
    const paid = sub && sub.payment_status === "paid";
    await users.setStatus(conn, user.id, paid ? "active" : "trial");
  }

  /* 何を返すかは、名前があるかで分かれる。

     名前が無い  … 診断への案内（この講座は名前で進むので、
                    先に名前を入れてもらわないと 1 日目が作れない）
     名前がある  … 先にサイトで連携した人が、あとから友だち追加した。
                    講座の案内と、次に訊くこと（コースなど）を返す

     以前は後者に**何も返していなかった**。連携も友だち追加も
     済んでいるのに LINE 側は無言で、最初のメッセージが翌朝の
     「1 日目」だった。

     返信に失敗しても友だち追加そのものは成立させる ── ここで
     throw すると LINE が webhook を失敗とみなして掛け直し、
     同じ人の追加処理が何度も走る。 */
  let welcomed = false;
  if (event?.replyToken) {
    const messages = user.name_kr
      ? await onboardingMessages(conn, user)
      : [welcomeForNameless()];
    if (messages.length) {
      try {
        await reply(event.replyToken, messages);
        welcomed = true;
      } catch {
        /* 返信できなくても、翌朝の案内で拾える。 */
      }
    }
  }

  return {
    userId: user.id,
    created,
    trialStarted: trial.created,
    displayName,
    welcomed
  };
}

/* 講座の案内 ＋ 次に訊くこと 1 つ。訊くことが無ければ案内だけ。
   段は lib/onboarding.mjs が中身から導く（列で持たない）。 */
async function onboardingMessages(conn, user) {
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
  return [
    serviceGuide({ nameJa: user.name_reading || user.name_kanji }),
    messageForStep(nextStep(state), state)
  ].filter(Boolean);
}

/* ブロック。消さない ── 消すと再追加が新規に見え、
   買った日数も進捗も無かったことになる。
   実際の削除は退会要求のときだけ（users.deleteUser）。 */
export async function handleUnfollow(conn, event) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };
  const changed = await users.markUnfollowed(conn, lineUserId);
  return { lineUserId, changed };
}
