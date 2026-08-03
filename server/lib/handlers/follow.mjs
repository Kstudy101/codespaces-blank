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
import { getProfile } from "../line.mjs";

/* 表示名は LINE から取れるが、取れなくても止めない。
   プロフィール取得は追加の 1 往復で、ここが 5xx を返しただけで
   友だち追加そのものが失敗するのは割に合わない。 */
async function displayNameOf(lineUserId) {
  try {
    const p = await getProfile(lineUserId);
    return p && p.displayName ? String(p.displayName).slice(0, 100) : null;
  } catch {
    return null;
  }
}

export async function handleFollow(conn, event) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };

  const displayName = await displayNameOf(lineUserId);
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

  return {
    userId: user.id,
    created,
    trialStarted: trial.created,
    displayName
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
