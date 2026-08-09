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
import { users, entitlements } from "../repo/index.mjs";
import { getProfile, replyMessage } from "../line.mjs";
import { serviceGuide, nextStep, messageForStep } from "../onboarding.mjs";

/* 診断ページの場所。LINE から案内するのはここだけ。 */
const SITE_URL = process.env.SITE_URL || "https://www.kstudy101.jp";

/* 流入 1（サイト診断 → 連携）と 流入 2（LINE 直行）の**両方**へ、
   完全に同じ文字列で送る（지시서㉓ §0-A、2026-08-09 대표 확정）。

   名前の有無で分けていたのをやめた理由 ── 分ける限り、直す側が
   「どちらの画面を見て話しているのか」を毎回覚えていなければならず、
   一方だけ直った文面が残る。同じ 1 通なら、その心配ごと消える。

   本文が名前の登録から書き出されるのは、この講座が 1 日目から名前を
   使うから（db/push-daily.mjs ── 名前が入るまで進まない）。流入 1 の
   人には要らない案内だが、それは承知のうえで文面を 1 つに揃えている。 */
function welcomeBoard() {
  /* 代表文面（2026-08-09）+ 次の行動（お名前登録）と SITE_URL は
     関門 verify-webhook と運用上必須。体験開始は登録・コース選択のあと。 */
  return {
    type: "text",
    text: [
      "はじめまして！Kstudy101です🇰🇷",
      "友だち追加ありがとうございます✨",
      "",
      "「韓国語を勉強したいけど、なかなか続かない…」",
      "そんなあなたに、LINEで毎日1分で続く学習習慣をお届けします。",
      "",
      "🎓 Kstudy101でできること",
      "1️⃣ 毎朝7時　日刊レッスン（通勤・通学でさっと）",
      "2️⃣ 夕方6時　当日のおさらい",
      "3️⃣ 3日ごと　復習クイズ",
      "",
      "教科書の「ミンスさん」ではなく、例文の主語はあなたのお名前。",
      "朝の運勢も韓国語でついてきます。",
      "",
      "👉 まずは無料の3日間体験へ。",
      "このまま LINE の中で、お名前の登録から始められます。",
      "",
      "くわしい名前診断はサイトでもできます：",
      SITE_URL
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

  /* ---- 体験も進捗も、ここでは作らない（migrations/002）--------------
     前は友だち追加した瞬間に 3 日分を配り、進捗の器も作っていた。
     やめた理由が 2 つある。

       ・コースを選ぶ前に始まる。中級を受けたい人に初級の 3 日が届く
       ・進捗は (user_id, track) が鍵になったので、「まだコースが
         決まっていない」行が置けない

     体験はリッチメニューの［受講料］からコースを選んで始める
     （handlers/checkout.mjs）。ここでするのは users に居ることを
     確かにするところまで。 */

  /* ---- ブロックから戻ってきた人 -------------------------------------
     upsertOnFollow は再追加で status に触らない（101 日ぶん買った人が
     一律 'trial' に落ちないための線）。その約束はそのままにして、
     unfollowed だけをここで**明示的に**戻す ── 戻す所が
     creditFromStripe しか無かったので、再決済しないかぎり配信が
     再開しなかった。message.mjs は「もう一度友だち追加すれば続きから
     お届けします」と案内しており、文面と挙動が正面衝突していた。

     戻し先は残りで決める。残りがあれば active（続きから届く）、
     無ければ trial ── active にすると、日数を持たない人が配信対象の
     顔をして並ぶ。接点で器を置き直す healProgress と同じ考え方。 */
  if (user.status === "unfollowed") {
    const back = await entitlements.firstWithRemaining(conn, user.id);
    const status = back ? "active" : "trial";
    await users.setStatus(conn, user.id, status);
    user.status = status;
  }

  /* 返すものは名前の有無で分けない（지시서㉓ §0-A）。以前は分けていて、
     名前がある人（サイトで連携だけして、あとから友だち追加した人）には
     **何も返していなかった**時期すらある ── その人にとって LINE 側は
     ずっと無言で、最初のメッセージが翌朝の「1 日目」だった。

     返信に失敗しても友だち追加そのものは成立させる ── ここで
     throw すると LINE が webhook を失敗とみなして掛け直し、
     同じ人の追加処理が何度も走る。 */
  let welcomed = false;
  if (event?.replyToken) {
    /* ボードのすぐ後ろに**最初の質問**を続ける ── 案内だけで終わると
       次の行動が見えない（7-3）。質問そのものは nextStep が導く
       （PENDING.reading が「サイト名の選択肢が無い人」を拾う。
       lib/onboarding.mjs）。 */
    /* 流入 1・2 とも同じウェルカムボード（지시서㉓ §0-A）。分岐は無い。
       guide:false は 2026-08-09 のまま ── ボードのすぐ後ろに
       serviceGuide が続くと歓迎が 2 通並び、友だち追加しただけの人に
       「連携できました」という事実でない一文が出る。講座の案内は
       リッチメニュー［講座の案内］と、末尾のコース選択画面に在る。 */
    const messages = [welcomeBoard(),
                      ...(await onboardingMessages(conn, user, { guide: false }))];
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
    displayName,
    welcomed
  };
}

/* 講座の案内 ＋ 次に訊くこと 1 つ。訊くことが無ければ案内だけ。
   段は lib/onboarding.mjs が中身から導く（列で持たない）。
   コースも段の一つ（track ── 選ぶとその場で体験が始まる）。

   guide:false は「案内をもう送ってある」とき。名前の無い人には
   welcomeBoard が同じことを先に言うので、続けて serviceGuide を
   出すと歓迎が 2 通並ぶ（代表指摘 2026-08-09）── しかも友だち追加の
   時点で「連携できました」は事実でもない。 */
async function onboardingMessages(conn, user, { guide = true } = {}) {
  const saju = await users.getSajuProfile(conn, user.id);
  /* ONBOARD_COLUMNS（lib/onboarding.mjs）を全部運ぶ ── ohaeng_main を
     落とすと、サイト経由の人が「直接流入」と読まれて新 4 段の質問を
     受ける（実際この経路だけ落ちていて関門が捕まえた）。 */
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
  return [
    guide ? serviceGuide({ nameJa: user.name_reading || user.name_kanji }) : null,
    /* async・conn 必須（track 段）。await を欠くと Promise がそのまま
       LINE へ行く ── filter(Boolean) は Promise を通す。 */
    await messageForStep(nextStep(state), state, conn)
  ].filter(Boolean);
}

/* ---- 友だちなのに users に居ない人を、立て直す ----------------------

   LINE 側で友だちのままなら、follow は**二度と来ない**。だから users の
   行が無くなると（手で消した・webhook が落ちていた間に追加された）、
   その人には歓迎も質問も永久に届かない。

   それだけなら「静かなだけ」だが、実際にはリッチメニューが出ている。
   押しても打っても何も起きない画面が残る ── 出口が無い（2026-08-09
   대표 실측）。message と postback が !user を黙って返していたため。

   触ってきたこの機会に器を置き直し、follow と同じ 2 通から始める。
   返信そのものは呼ぶ側の経路に任せる ── replyToken の扱いは
   message と postback で違い、ここで持つと二重になる。 */
export async function recoverUser(conn, lineUserId) {
  const { user } = await users.upsertOnFollow(conn, { lineUserId });
  return user;
}

/* follow で送るのと**同じ 2 通**。写しを作らない ── 片方だけ直した日に
   「どちらから来たか」で文面が割れる（지시서㉓ §0-A と同じ理由）。 */
export async function welcomeMessages(conn, user) {
  return [welcomeBoard(), ...(await onboardingMessages(conn, user, { guide: false }))];
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
