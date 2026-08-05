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
      /* サイトへは戻さない ── 名前も生年月日も、このトークの中で
         そのまま登録できる（plan-line-onboarding.md）。サイトの診断は
         案内の末尾に「もっと詳しく」として残すだけ。
         このあと handlers/follow.mjs が最初の質問（読み仮名）を
         続けて送る ── 次の行動が必ず見える（7-3 の解消）。 */
      "このまま LINE の中で、お名前から順にご登録いただけます。",
      "",
      /* ボタンの文字列はサイトの実物（index.html #line-go）と同一に
         保つ ── 違う名前で案内すると、その名前のボタンを探して
         見つからない（指示書 §1-A④）。 */
      `くわしい名前診断はサイトでもできます（診断のあと`,
      `「LINE で続きを受け取る」を押すと、ここに繋がります）：`,
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
    /* 名前の無い人にも、案内のすぐ後に**最初の質問**（読み仮名）を
       続ける ── 案内だけで終わると次の行動が見えない（7-3）。
       質問そのものは nextStep が導く（PENDING.reading が
       「サイト名の選択肢が無い人」を拾う。lib/onboarding.mjs）。 */
    const messages = user.name_kr
      ? await onboardingMessages(conn, user)
      : [welcomeForNameless(), ...(await onboardingMessages(conn, user))];
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

   コースはここで訊かない ── 買うときに選ぶので、まだ何も持って
   いない人に「初級 / 中級 / 上級」だけ出しても進む先が無い。
   代わりにリッチメニューが常に画面下に出ている。 */
async function onboardingMessages(conn, user) {
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
