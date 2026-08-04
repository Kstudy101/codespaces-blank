/* ==================================================================
   handlers/checkout.mjs — 受講料を見せる・買う・受け取る

   リッチメニューの［受講料］から、決済が終わって 1 日目が届くまで。

     ① action=plans                 コースを選ぶ
     ② action=plan&track=…          価格表（＝最終確認画面）
     ③ action=buy&track=…&pkg=…     Stripe の決済ページへ
     ④ action=trial&track=…         体験 3 日（1 アカウント 1 回）
     ⑤ POST /stripe/webhook         入金 → 日数を積む → 即 1 日目
     ⑥ action=resume&track=…&mode=… 買い直した人の「続き / 最初から」

   【★ 表示が足りないまま売らないための門】
   有料で売るには、特定商取引法に基づく表記のページと、決済直前に
   読める価格・提供時期・返金の記載が要る（docs/plan-billing.md §7）。
   これはコードでは埋められない ── 事業者名・住所・電話番号は
   こちらが知らないし、返金規定も決めごとだから。

   なので **設定が揃うまで決済の口を開けない**。index.html の
   LINE_LINK_API が空のあいだカードを出さなかったのと同じやり方で、
   ここは環境変数が欠けていれば価格表そのものを出さない。

     TOKUSHOHO_URL   特定商取引法に基づく表記の URL
     REFUND_POLICY   返金の 1 行（価格表に出す）

   埋まっていなければ、押した人には「準備中」と返し、こちらの
   ログには何が足りないかを名前で出す。黙って売れてしまうより、
   売れないほうがよい。
   ================================================================== */
import { users, billing, learning, pushlogs, entitlements, lapses } from "../repo/index.mjs";
import { PACKAGES, TRIAL_DAYS } from "../repo/billing.mjs";
import { TRACKS, TRACK_LABELS, TOTAL_DAYS, isTrack } from "../repo/learning.mjs";
import { createCheckoutSession } from "../stripe.mjs";
import { pushMessage, replyMessage, isUnreachable } from "../line.mjs";
import { jstDateTime } from "../jst.mjs";

const SITE_URL = () => process.env.SITE_URL || "https://www.kstudy101.jp";

/* ---- 門 ------------------------------------------------------------
   足りないものを名前で返す。1 つ目で止めないのは env.mjs と同じ理由 ──
   直して走らせて次で止まる、を繰り返すことになる。 */
export function missingLegalConfig() {
  const missing = [];
  if (!process.env.TOKUSHOHO_URL) missing.push("TOKUSHOHO_URL（特定商取引法に基づく表記の URL）");
  if (!process.env.REFUND_POLICY) missing.push("REFUND_POLICY（返金規定の 1 行）");
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  return missing;
}

export function salesOpen() {
  return missingLegalConfig().length === 0;
}

const notReady = () => ({
  type: "text",
  text: [
    "ただいま準備中です。",
    "受講のお申し込みは、もうしばらくお待ちください。"
  ].join("\n")
});


/* ---- ① コースを選ぶ ------------------------------------------------- */

export function askCourse({ owned = [] } = {}) {
  /* 既に持っているコースには印を付ける。付けないと、買ったことを
     忘れて同じコースをもう一度買う ── 返金の手間になる。 */
  const mark = (t) => (owned.includes(t) ? "（受講中）" : "");
  return {
    type: "text",
    text: [
      "どのコースの受講料をご覧になりますか？",
      "",
      `初級（초급）${mark("beginner")}`,
      "　ハングルの読み書きから。韓国語がはじめての方",
      `中級（중급）${mark("intermediate")}`,
      "　文と文をつなぐ・敬語。あいさつができる方",
      `上級（고급）${mark("advanced")}`,
      "　書き言葉・ニュースの韓国語。日常会話に困らない方",
      "",
      "コースはそれぞれ 101 日ぶんの別の講座です。"
    ].join("\n"),
    quickReply: {
      items: TRACKS.map((t) => ({
        type: "action",
        action: {
          type: "postback",
          label: `${TRACK_LABELS[t].ja}（${TRACK_LABELS[t].kr}）`.slice(0, 20),
          data: `action=plan&track=${t}`,
          displayText: `${TRACK_LABELS[t].ja} の受講料を見ます`
        }
      }))
    }
  };
}


/* ---- ② 価格表 ＝ 最終確認画面 ---------------------------------------
   決済の直前に読める所へ、法が求める項目を置く。前払いの回数券なので
   「更新周期」「解約方法」は無い（自動更新しないため）。要るのは:

     分量・総額（税込）・支払時期・提供時期・返金・事業者の表記

   これを別のウェブページに置く案もあったが、LINE の中で完結する
   ほうが取りこぼしが無い ── 押す直前の画面がこれになる。

   体験を使っていない人には、価格表と一緒に体験の入口も出す。
   出さないと、試さずに払うか、払わずに去るかの二択になる。 */
export function priceList(track, { trialAvailable = false } = {}) {
  const l = TRACK_LABELS[track];
  const rows = Object.entries(PACKAGES)
    .map(([key, p]) => `・${String(p.days).padStart(3)} 日分　${p.price.toLocaleString()} 円（税込）`);

  const items = Object.entries(PACKAGES).map(([key, p]) => ({
    type: "action",
    action: {
      type: "postback",
      label: `${p.days}日 ${p.price.toLocaleString()}円`.slice(0, 20),
      data: `action=buy&track=${track}&pkg=${key}`,
      displayText: `${TRACK_LABELS[track].ja} ${p.days}日分を申し込みます`
    }
  }));

  /* quickReply は 13 個まで。パッケージ 5 + 体験 1 で収まる。 */
  if (trialAvailable) {
    items.unshift({
      type: "action",
      action: {
        type: "postback",
        label: `まず${TRIAL_DAYS}日ためす（無料）`.slice(0, 20),
        data: `action=trial&track=${track}`,
        displayText: `${TRACK_LABELS[track].ja} を無料でためします`
      }
    });
  }

  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}） 受講料`,
      "",
      ...rows,
      "",
      `全 ${TOTAL_DAYS} 日で 1 つの講座です。`,
      "",
      "──────────",
      "お支払い　クレジットカード（申込時に 1 回）",
      "　　　　　自動更新はありません",
      "お届け　　ご入金後すぐに 1 日目",
      "　　　　　翌日から 毎朝 7 時 ＋ 毎夕 6 時",
      `返金　　　${process.env.REFUND_POLICY || ""}`,
      "",
      `販売者の表記　${process.env.TOKUSHOHO_URL || ""}`
    ].join("\n"),
    quickReply: { items: items.slice(0, 13) }
  };
}


/* ---- ③ 買う --------------------------------------------------------- */

export async function startCheckout(conn, user, { track, packageType }) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };
  const pkg = PACKAGES[packageType];
  if (!pkg) return { ok: false, reason: `未知の package: ${packageType}` };

  const session = await createCheckoutSession({
    userId: user.id,
    track, packageType,
    days: pkg.days, price: pkg.price,
    productName: `${TRACK_LABELS[track].ja}（${TRACK_LABELS[track].kr}） ${pkg.days}日分`,
    successUrl: `${SITE_URL()}/thanks`,
    cancelUrl: `${SITE_URL()}/`,
    /* 同じ人・同じコース・同じ数量なら Stripe 側でもまとまる。 */
    clientRef: `u${user.id}-${track}-${packageType}`
  });

  return { ok: true, url: session.url, sessionId: session.id };
}

export function checkoutLink(track, packageType, url) {
  const l = TRACK_LABELS[track], p = PACKAGES[packageType];
  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}） ${p.days}日分　${p.price.toLocaleString()} 円（税込）`,
      "",
      "下のリンクからお支払いください。",
      "カード番号は決済会社の画面で入力され、当方には届きません。",
      "",
      url,
      "",
      "※ このリンクは一定時間で使えなくなります。",
      "　 切れていたら、もう一度［受講料］からお試しください。"
    ].join("\n")
  };
}


/* ---- ④ 体験 ---------------------------------------------------------
   1 アカウント 1 回だけ。コース別にすると、コースを変えるだけで
   3 コース ×3 日 = 9 日を無料で受け取れる（repo/billing.mjs）。 */
export async function startTrialFor(conn, user, track) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };

  const r = await billing.startTrial(conn, user.id, track);
  if (!r.created) {
    return { ok: false, kind: "used", reason: "体験は 1 回だけです" };
  }
  await learning.ensureProgress(conn, user.id, track);
  await users.setActiveTrack(conn, user.id, track);
  return { ok: true, track, days: TRIAL_DAYS };
}


/* ---- ⑤ 入金した ------------------------------------------------------
   Stripe の webhook から呼ばれる。ここが日数を積む唯一の場所。

   【metadata を信じ切らない】
   user_id はこちらが入れた値だが、その行がまだ在るとは限らない
   （退会・削除）。引いて確かめる ── 無い相手に積むと、
   誰のものでもない日数が残る。

   【順番】
     1 台帳に記録して日数を積む（creditPurchase。再送はここで無効）
     2 進みの器を用意する
     3 受けているコースをこれにする
     4 離脱の台帳を閉じる
     5 「続き / 最初から」を訊く、または即 1 日目

   1 を先にするのは、送信で落ちても入金が消えないため。逆にすると
   「払ったのに日数が無い」が残る。 */
export async function creditFromStripe(conn, ev, { deliver = null, send = pushMessage } = {}) {
  if (!ev) return { ok: false, reason: "対象外のイベント" };
  if (!Number.isInteger(ev.userId) || ev.userId <= 0) {
    return { ok: false, reason: `metadata の user_id が読めません: ${ev.userId}` };
  }
  if (!isTrack(ev.track)) return { ok: false, reason: `metadata の track が読めません: ${ev.track}` };
  if (!PACKAGES[ev.packageType]) return { ok: false, reason: `metadata の package が読めません: ${ev.packageType}` };

  const user = await users.findById(conn, ev.userId);
  if (!user) return { ok: false, reason: `利用者が見つかりません: ${ev.userId}` };

  /* 1. 台帳と日数。payment_ref に Checkout Session の id を入れる。
        同じセッションが二度届いても 1062 で弾かれ、日数は増えない。 */
  const credited = await billing.creditPurchase(conn, user.id, ev.track, ev.packageType,
    { paymentRef: ev.sessionId, pricePaid: ev.amount || null });

  if (!credited.created) {
    return { ok: true, duplicate: true, userId: user.id, track: ev.track };
  }

  /* 2〜4 */
  const { progress } = await learning.ensureProgress(conn, user.id, ev.track);
  await users.setActiveTrack(conn, user.id, ev.track);
  /* ブロックで unfollowed になっていた人が買い直すこともある。
     配信対象（trial / active）に戻す ── 戻さないと、払ったのに
     listDeliverable から外れたままになる。 */
  if (user.status === "unfollowed" || user.status === "expired") {
    await users.setStatus(conn, user.id, "active");
  }
  await lapses.markResumed(conn, user.id, ev.track, { now: jstDateTime() });

  /* 5. 進みがあれば訊く。無ければ（初めて買うコース）そのまま 1 日目。 */
  const resumeNeeded = progress && Number(progress.current_day) > 0;

  try {
    if (resumeNeeded) {
      await send(user.line_user_id, [
        boughtNotice(ev.track, credited.daysGranted),
        askResume(ev.track, Number(progress.current_day))
      ]);
      await pushlogs.logSent(conn, user.id, { pushType: "resume" });
      return { ok: true, userId: user.id, track: ev.track,
               daysGranted: credited.daysGranted, asked: "resume" };
    }

    await send(user.line_user_id, [boughtNotice(ev.track, credited.daysGranted)]);
  } catch (e) {
    /* 送信の失敗で入金を無かったことにしない。日数はもう積んである。 */
    await pushlogs.logFailed(conn, user.id,
      { pushType: "upsell", error: String(e.message || e).slice(0, 500) });
    if (isUnreachable(e)) await users.markUnfollowed(conn, user.line_user_id);
    return { ok: true, userId: user.id, track: ev.track,
             daysGranted: credited.daysGranted, delivered: false, error: e.message };
  }

  /* 時刻に関係なく、その場で 1 日目を送る。翌朝まで何も来ないと、
     払ったのに何も起きていないように見える。
     二重送信は deliverOne 側の sentToday が見ている。 */
  let delivered = null;
  if (deliver) {
    try { delivered = await deliver(conn, user.id); }
    catch (e) { delivered = `失敗: ${e.message}`; }
  }

  return { ok: true, userId: user.id, track: ev.track,
           daysGranted: credited.daysGranted, delivered };
}


/* ---- ⑥ 続きから / 最初から ------------------------------------------- */

export function boughtNotice(track, days) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      "お手続きが完了しました。ありがとうございます。",
      "",
      `${l.ja}（${l.kr}） ${days} 日分をお預かりしました。`
    ].join("\n")
  };
}

export function askResume(track, lastDay) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      `前回は ${l.ja} の ${lastDay} 日目まで進んでいます。`,
      "",
      "どちらにされますか？",
      "",
      `※ 1 日目からやり直す場合も、お預かりした日数は同じように使います。`
    ].join("\n"),
    quickReply: {
      items: [
        { type: "action", action: { type: "postback",
          label: `${lastDay + 1}日目から続ける`.slice(0, 20),
          data: `action=resume&track=${track}&mode=continue`,
          displayText: `${lastDay + 1} 日目から続けます` } },
        { type: "action", action: { type: "postback",
          label: "1日目からやり直す",
          data: `action=resume&track=${track}&mode=restart`,
          displayText: "1 日目からやり直します" } }
      ]
    }
  };
}

/* 答えた瞬間に反映する。restart でも days_used は動かさない ──
   動かすと、受け取った日数が無かったことになる（repo/learning.mjs）。 */
export async function applyResume(conn, user, { track, mode }) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };
  if (mode !== "continue" && mode !== "restart") {
    return { ok: false, reason: `mode が読めません: ${mode}` };
  }
  await users.setActiveTrack(conn, user.id, track);
  if (mode === "restart") await learning.resetProgress(conn, user.id, track, 0);
  const prog = await learning.getProgress(conn, user.id, track);
  return { ok: true, track, mode, currentDay: prog ? Number(prog.current_day) : 0 };
}

export function resumeDone(track, mode, currentDay) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: mode === "restart"
      ? `${l.ja}（${l.kr}）を 1 日目からお届けします。`
      : `${l.ja}（${l.kr}）の ${currentDay + 1} 日目から続けます。`
  };
}


/* ---- 期限の予告 ------------------------------------------------------
   残り 2 日で 1 度だけ。毎日出すと通知が増えるだけで読まれなくなる。 */
export const EXPIRING_AT = 2;

export function expiringNotice(track, { remaining, currentDay }) {
  const l = TRACK_LABELS[track];
  const done = currentDay >= TOTAL_DAYS;
  return {
    type: "text",
    text: [
      `お預かりしている日数が、あと ${remaining} 日です。`,
      "",
      done
        ? `${l.ja}（${l.kr}）は ${TOTAL_DAYS} 日すべて終わります。`
        : `${l.ja}（${l.kr}）は ${currentDay} 日目まで進んでいます。`,
      "",
      "続けてお受け取りになる場合は、下から追加できます。",
      "追加された日数は、いまの続きに足されます。"
    ].join("\n"),
    quickReply: {
      items: [{ type: "action", action: { type: "postback",
        label: "受講料を見る", data: `action=plan&track=${track}`,
        displayText: "受講料を見ます" } }]
    }
  };
}


/* ---- 修了 ------------------------------------------------------------
   101 日目まで届いた人へ。ここが最後の接点で、次のコースを勧める
   唯一の場所でもある（今まで何も送っていなかった）。 */
export function completionNotice(track, { owned = [] } = {}) {
  const l = TRACK_LABELS[track];
  const next = TRACKS.find((t) => t !== track && !owned.includes(t))
            || TRACKS.find((t) => t !== track);

  const items = [];
  if (next) {
    items.push({ type: "action", action: { type: "postback",
      label: `${TRACK_LABELS[next].ja}を見る`.slice(0, 20),
      data: `action=plan&track=${next}`,
      displayText: `${TRACK_LABELS[next].ja} の受講料を見ます` } });
  }
  items.push({ type: "action", action: { type: "postback",
    label: `${l.ja}をもう一度`.slice(0, 20),
    data: `action=plan&track=${track}`,
    displayText: `${l.ja} をもう一度受けます` } });

  return {
    type: "text",
    text: [
      `${TOTAL_DAYS} 日間、おつかれさまでした。`,
      "",
      `${l.ja}（${l.kr}）はこれで修了です。`,
      "",
      next
        ? `続けて ${TRACK_LABELS[next].ja}（${TRACK_LABELS[next].kr}）に進めます。`
          + `\n${TRACK_LABELS[next].ja}も 1 日目からの ${TOTAL_DAYS} 日間です。`
        : "同じコースをもう一度受けることもできます。",
      "",
      "もう一度受ける場合は 1 日目からお届けします。"
    ].join("\n"),
    quickReply: { items }
  };
}


/* ---- 進み具合（リッチメニューの［内 진도］） -------------------------- */

export async function statusMessage(conn, user) {
  const owned = await entitlements.listByUser(conn, user.id);
  if (!owned.length) {
    return {
      type: "text",
      text: ["まだ受講が始まっていません。",
             "［受講料］からコースをお選びください。"].join("\n"),
      quickReply: { items: [{ type: "action", action: { type: "postback",
        label: "受講料を見る", data: "action=plans", displayText: "受講料を見ます" } }] }
    };
  }

  const lines = owned.map((e) => {
    const l = TRACK_LABELS[e.track];
    const here = e.track === user.active_track ? "▶ " : "　";
    return `${here}${l.ja}（${l.kr}）　${e.currentDay} / ${TOTAL_DAYS} 日目　残り ${Math.max(0, e.remaining)} 日`;
  });

  return {
    type: "text",
    text: ["いまの進み具合です。", "", ...lines,
           "", "▶ が、いまお届けしているコースです。"].join("\n")
  };
}

export { notReady };
