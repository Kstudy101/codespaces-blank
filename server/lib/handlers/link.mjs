/* ==================================================================
   handlers/link.mjs — LINE Login から戻ってきたところ

   【2026-08-16 ── 預ける側（POST /line/link/start）を廃止した】
   ウェブの占い結果を預かって LINE に繋ぐ流れは、事業転換で運勢ごと
   無くなった（docs/plan-fortune-removal.md）。生年月日を受け取る口を
   閉じるのがこの変更の目的なので、startLink と生年月日の正規化
   （normalizeProfile）はここから消してある。

   残っている completeLink は GET /line/callback の受け口だが、
   pending_links を作る側がもう居ないため、実際に来るのは期限切れか
   作り物の state だけで、いずれも「もう一度やり直し」を返す
   （プロフィール編集は purpose=edit で handlers/profile.mjs へ分岐する）。

   到達しなくなった経路そのものの撤去は**別件**にしてある ── 消すと
   resultPage・greet・関門 8 項目が同時に動き、この変更（口を閉じる）
   の成否が読めなくなる。
   ================================================================== */
import { users, links, pushlogs } from "../repo/index.mjs";
import * as oauthStates from "../repo/oauth-states.mjs";
import { hashState, looksLikeState } from "../token.mjs";
import { exchangeCode, loginProfile, revoke } from "../linelogin.mjs";
import { getProfile, pushMessage, isUnreachable } from "../line.mjs";
import { jstDateTime } from "../jst.mjs";
import { serviceGuide, nextStep, messageForStep } from "../onboarding.mjs";

/* ---- LINE から戻ってくる ------------------------------------------ */

/* ---- 連携できた直後に送る 1 便 --------------------------------------
   ここまで、サイトを通ってきた人には**何も送っていなかった**。
   handlers/follow.mjs が返すのは名前の無い人だけで、名前を持って
   きた人は素通り ── 連携が成功しても LINE 側は無言のまま、
   最初のメッセージが翌朝の「1 日目」だった。何に登録したのか
   分からないまま本文が始まる。

   送るのは 2 通まで。講座の案内と、次に訊くこと 1 つ。
   pushMessage は配列を受けるので、2 通でも通知は 1 回。

   友だちでない人には送らない（送れない）。その人は友だち追加の
   ときに follow.mjs が拾う。

   送信の失敗でリンクそのものを失敗にしない。DB の書き込みは
   もう終わっていて、やり直すと state は使用済みなので通らない
   ── 「連携できたのに、できなかったと言われる」が起きる。 */
async function greet(conn, user, { send = pushMessage } = {}) {
  const saju = await users.getSajuProfile(conn, user.id);

  /* ONBOARD_COLUMNS（lib/onboarding.mjs）を全部運ぶ ── ohaeng_main を
     落とすと、連携したての本人に「直接流入の 4 段」が出る。
     この関数は状態を組む 6 番目の経路で、自動探索の関門が見張る。 */
  const state = {
    ...user,
    birth_date: saju ? saju.birth_date : null,
    birth_time: saju ? saju.birth_time : null,
    birth_confirmed: saju ? saju.birth_confirmed : false,
    gender: saju ? saju.gender : "U",
    ohaeng_main: saju ? saju.ohaeng_main : null,
    raw_result_json: saju ? saju.raw_result_json : null,
    /* 進みはコース別になったので（migrations/002）、いま受けている
       コースは users.active_track が持つ。買う前は NULL。 */
    track: user.active_track || null
  };

  const step = nextStep(state);
  const messages = [
    serviceGuide({ nameJa: user.name_reading || user.name_kanji }),
    /* async・conn 必須（track 段）。await を欠くと Promise がそのまま
       LINE へ行く ── filter(Boolean) は Promise を通す。 */
    await messageForStep(step, state, conn)
  ].filter(Boolean);

  try {
    await send(user.line_user_id, messages);
    await pushlogs.logSent(conn, user.id, { pushType: "onboarding" });
    return { sent: messages.length, step };
  } catch (e) {
    await pushlogs.logFailed(conn, user.id,
      { pushType: "onboarding", error: String(e.message || e).slice(0, 500) });
    return { sent: 0, step, error: e.message };
  }
}


export async function completeLink(conn, { code, state, error, errorDescription }) {
  /* 利用者が同意画面で「キャンセル」を押すと、code ではなく
     error が付いて戻る。異常ではないので、そう伝える。 */
  if (error) {
    return { ok: false, kind: "declined", reason: errorDescription || error };
  }
  if (!looksLikeState(state)) {
    return { ok: false, kind: "bad_state", reason: "state の形が違います" };
  }
  if (!code || typeof code !== "string") {
    return { ok: false, kind: "bad_code", reason: "code がありません" };
  }

  const now = jstDateTime();
  const purpose = await oauthStates.consume(conn, hashState(state), { now });
  if (purpose && purpose !== "link") {
    return { ok: false, kind: "expired", reason: "state の用途が一致しません" };
  }

  /* 預かりものを取り出す。取れなければ、期限切れか、二度目か、
     こちらが出したものではない。どれも「もう一度やり直し」なので
     利用者への言い方は同じにする（どれだったかは教えない ──
     教えると、state を総当たりする側に手がかりを渡すことになる）。 */
  const pending = await links.consume(conn, hashState(state), { now });
  if (!pending) {
    return { ok: false, kind: "expired", reason: "期限切れか、すでに使われた state です" };
  }

  /* ここで初めて LINE の誰かが分かる。 */
  let lineUserId, displayName = null, accessToken = null;
  try {
    const token = await exchangeCode(code);
    accessToken = token.access_token;
    const me = await loginProfile(accessToken);
    lineUserId = me.userId;
    displayName = me.displayName ? String(me.displayName).slice(0, 100) : null;
  } catch (e) {
    return { ok: false, kind: "exchange_failed", reason: e.message };
  } finally {
    if (accessToken) revoke(accessToken);   // 待たない。失敗しても実害が無い
  }

  if (!lineUserId) {
    return { ok: false, kind: "no_user_id", reason: "userId を取得できませんでした" };
  }

  /* 友だち追加が先の人も居るので upsert。既にある人の status は
     触らない（repo/users.mjs の注釈）。 */
  const { user } = await users.upsertOnFollow(conn, { lineUserId, displayName });

  await users.updateName(conn, user.id, {
    nameKanji: pending.name_kanji,
    nameReading: pending.name_reading,
    nameKr: pending.name_kr
  });

  /* 2 度目以降の連携は「選び直した結果」として扱う。
     初回は name_source が空のままにしておき、あとで
     「サイトの名前と LINE の表示名、どちらで呼ぶか」を訊く。

     一度でも答えた人がサイトへ戻って入れ直したなら、その名前が
     答えそのもの ── もう一度同じことを訊くと、直したのに
     直っていないように見える。 */
  if (user.name_source) await users.setNameSource(conn, user.id, "web");
  await users.upsertSajuProfile(conn, user.id, {
    birthDate: pending.birth_date,
    birthTime: pending.birth_time,
    gender: pending.gender,
    ohaengMain: pending.ohaeng_main,
    rawResult: pending.raw_result_json
  });

  /* 体験も進捗も、ここでは作らない（migrations/002）。
     どちらもコースが決まって初めて置ける ── 進みの鍵が
     (user_id, track) になったため。コースはリッチメニューの
     ［受講料］で選ぶ（handlers/checkout.mjs）。

     ここまでで名前と四柱は入っているので、選んだ瞬間に
     1 日目が作れる状態にはなっている。 */

  /* ---- チャネルの取り違えを、ここで見つける --------------------
     Login で得た userId を Messaging API 側に問い合わせる。

       通る   … 同じプロバイダー。かつ、もう友だちになっている
       404    … 友だちでないか、プロバイダーが別
       403    … 送れない状態（ブロック等）

     プロバイダーが別だと、登録も保存も成功したのに配信だけが
     永久に届かない。しかもエラーはどこにも出ない。ここで一度
     叩いておけば、設置の時点で気づける。 */
  let friend = null;
  try {
    await getProfile(lineUserId);
    friend = true;
  } catch (e) {
    friend = isUnreachable(e) ? false : null;   // null は判定できなかった
  }

  /* 友だちだと分かったときだけ挨拶する。false（まだ友だちでない・
     プロバイダー違い）と null（判定できなかった）には送らない ──
     送れないものを送ろうとして 404 を記録すると、あとから
     「配信が届いていない人」を数えるときの雑音になる。 */
  let greeted = null;
  if (friend === true) {
    /* 名前を書き換えたあとの行で判定する。上の user は
       upsertOnFollow が返したもので、まだ名前が入っていない。 */
    greeted = await greet(conn, await users.findById(conn, user.id));
  }

  return {
    ok: true,
    userId: user.id,
    lineUserId,
    displayName,
    nameKr: pending.name_kr,
    greeted,
    /* false = まだ友だちでない（追加を促す）。
       ただしプロバイダー違いでも false になるので、
       設置直後にこれが必ず false なら、まずそちらを疑う。 */
    friend
  };
}
