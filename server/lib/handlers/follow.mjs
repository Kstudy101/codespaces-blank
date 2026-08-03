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
      "101日間の韓国語レッスンを、毎朝おとどけします。",
      "",
      "このレッスンは、あなたのお名前を使って進みます。",
      "たとえば「다나카는 일본에서 왔어요」のように、",
      "ご自身の名前で例文が出てきます。",
      "",
      "▼ はじめに、こちらでお名前を入れてください（1分ほど）",
      SITE_URL,
      "診断のあと「LINEで受け取る」を押すと、ここに繋がります。",
      "",
      "お名前が登録された翌朝から、1日目をおとどけします。"
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

  /* 名前がまだ無い人にだけ、診断への案内を返す。
     返信に失敗しても友だち追加そのものは成立させる ── ここで
     throw すると LINE が webhook を失敗とみなして掛け直し、
     同じ人の追加処理が何度も走る。 */
  let welcomed = false;
  if (!user.name_kr && event?.replyToken) {
    try {
      await reply(event.replyToken, [welcomeForNameless()]);
      welcomed = true;
    } catch {
      /* 返信できなくても、翌朝の案内で拾える。 */
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

/* ブロック。消さない ── 消すと再追加が新規に見え、
   買った日数も進捗も無かったことになる。
   実際の削除は退会要求のときだけ（users.deleteUser）。 */
export async function handleUnfollow(conn, event) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };
  const changed = await users.markUnfollowed(conn, lineUserId);
  return { lineUserId, changed };
}
