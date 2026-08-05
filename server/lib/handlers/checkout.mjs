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

/* ---- 販売の露出モード（2026-08-05 指示書 §1-1）----------------------
   法定表示 4 つ（salesOpen）は**必要条件のまま**で、その上にモードを
   重ねる。分ける理由: Stripe のテスト鍵を入れた瞬間に salesOpen が
   開き、実利用者に価格表と決済リンクが出てしまう ── テストモードは
   実カードを拒むので、利用者は決済失敗を経験する。「準備中」より悪い。

     closed … 全員に「準備中」（既定。値が無い・読めない時もこちら）
     test   … SALES_TEST_USERS（コンマ区切り）に載る人だけ通す。
              users.id でも line_user_id でもよい ── 画面で見える方を
              そのまま貼れるように両方で引き当てる
     open   … 全員

   既定を closed にするのは、書き忘れ・綴り間違いが「売れてしまう」
   側に倒れないため。 */
export function salesMode() {
  const m = String(process.env.SALES_MODE || "closed").trim().toLowerCase();
  return ["closed", "test", "open"].includes(m) ? m : "closed";
}

export function salesAllowedFor(user) {
  if (!salesOpen()) return false;          /* 法定表示は常に必要条件 */
  const mode = salesMode();
  if (mode === "open") return true;
  if (mode !== "test") return false;
  const list = String(process.env.SALES_TEST_USERS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(String(user?.id)) || list.includes(String(user?.line_user_id));
}

const notReady = () => ({
  type: "text",
  text: [
    "ただいま準備中です。",
    "受講のお申し込みは、もうしばらくお待ちください。"
  ].join("\n")
});

/* コースはあるが、売れるパッケージが 1 つも無い（原稿が最小の
   パッケージ日数に満たない）。全体の「準備中」と分けるのは、
   他のコースは買える状態がありうるため。 */
export const coursePreparing = (track) => ({
  type: "text",
  text: `${TRACK_LABELS[track].ja}（${TRACK_LABELS[track].kr}）は、ただいま準備中です。\nもうしばらくお待ちください。`
});

/* 露出できるパッケージ（原稿の保有日数が上限）。priceList と
   体験 2 日目の夕方の勧誘（db/push-evening.mjs）が**同じ判定**を見る ──
   別々に書くと、片方だけ直した日に「買えないのに『追加できます』」が
   出る（押した先は coursePreparing）。 */
export const sellablePackages = (availableDays) =>
  Object.entries(PACKAGES).filter(([, p]) => p.days <= availableDays);

/* ---- 体験 2 日目の夕方の勧誘（2026-08-06 指示書 C4）------------------
   体験中・current_day = 2 の人へ、復習の後ろに 1 通。
   販売が閉じていても送る ── ただし文面を分ける。「買える」は

     salesAllowedFor(user) かつ sellablePackages ≥ 1

   の**両方**。後者を落とすと、販売が開いていても原稿 3 日ぶんの
   コースで「下から追加できます」が出て、押した先で「準備中」になる。

   買えない側の文面は「どこを見ればよいか」だけを言い、
   「整いましたらお知らせします」とは**書かない** ── 販売が開いた日に
   待っている人へ知らせる機能はコードに無い。約束した瞬間、文書が
   コードより先へ出る（この置き場が 4 回踏んだ形）。 */
export function trialUpsellNotice(track, { canBuy = false } = {}) {
  const l = TRACK_LABELS[track];
  const head = [
    `無料でお試しいただける ${TRIAL_DAYS} 日分のうち、明日が最後の 1 日です。`,
    "",
    `${l.ja}（${l.kr}）は 2 日目まで進みました。`,
    ""
  ];
  if (!canBuy) {
    /* quickReply は付けない。押す所が無ければ空振りも無い。 */
    return {
      type: "text",
      text: [...head,
        "続きの受講料のご案内は、ただいま準備中です。",
        "準備が整いましたら、下のメニューの［受講料］からご確認いただけます。"
      ].join("\n")
    };
  }
  return {
    type: "text",
    text: [...head,
      "続けてお受け取りになる場合は、下から日数を追加できます。",
      "追加された日数は、いまの続きに足されます。"
    ].join("\n"),
    quickReply: { items: [{
      type: "action",
      action: { type: "postback", label: "受講料を見る",
                data: `action=plan&track=${track}`, displayText: "受講料を見る" }
    }] }
  };
}

/* ---- 残り 0 になった朝の、再購入のご案内（指示書 §3）----------------
   離脱のエピソードにつき 1 回だけ ── 毎朝の判定で残り 0 には毎日
   出会うので、条件なしに送ると毎日スパムになる。1 回だけの判定は
   lapse_log が新しく開いたかどうか（repo/lapses.mjs openIfAbsent の
   created）に載せる。呼ぶのは db/push-daily.mjs。 */
export function upsellNotice(track, { lastDay = 0 } = {}) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}）は ${lastDay} 日目まで進みました。`,
      "お持ちの日数を使い切ったため、お届けをいったんお休みしています。",
      "",
      "日数を追加されると、続きからそのままお届けします。",
      "進んだところが消えることはありません。"
    ].join("\n"),
    quickReply: { items: [{
      type: "action",
      action: { type: "postback", label: "受講料を見る",
                data: "action=plans", displayText: "受講料を見る" }
    }] }
  };
}


/* ---- ① コースを選ぶ ------------------------------------------------- */

/* pick を渡すとオンボーディングのコース選択になる（plan-course-onboarding
   §2）── 文面（コースの説明）は共有し、**ボタンの data だけ**を
   trackpick に替える。写しを持つと、説明を直した日に選択画面だけ
   古くなる。pick.tracks は原稿が体験日数ぶんあるコースだけ（§4-나）。

   「あとから変更できません」の 1 行は両方に出す（문면 §7-나 확정）──
   買うときも選ぶときも、コースを替える唯一の道は追加購入で同じ。 */
export function askCourse({ owned = [], pick = null } = {}) {
  /* 既に持っているコースには印を付ける。付けないと、買ったことを
     忘れて同じコースをもう一度買う ── 返金の手間になる。 */
  const mark = (t) => (owned.includes(t) ? "（受講中）" : "");
  const DESC = {
    beginner:     "　ハングルの読み書きから。韓国語がはじめての方",
    intermediate: "　文と文をつなぐ・敬語。あいさつができる方",
    advanced:     "　書き言葉・ニュースの韓国語。日常会話に困らない方"
  };
  const list = pick ? pick.tracks : TRACKS;
  return {
    type: "text",
    text: [
      pick ? "どのコースで始めますか？" : "どのコースの受講料をご覧になりますか？",
      "",
      ...list.flatMap((t) => [
        `${TRACK_LABELS[t].ja}（${TRACK_LABELS[t].kr}）${mark(t)}`, DESC[t]
      ]),
      "",
      "コースはそれぞれ 101 日ぶんの別の講座です。",
      "あとから変更できませんので、じっくりお選びください。"
    ].join("\n"),
    quickReply: {
      items: list.map((t) => ({
        type: "action",
        action: {
          type: "postback",
          label: `${TRACK_LABELS[t].ja}（${TRACK_LABELS[t].kr}）`.slice(0, 20),
          data: pick ? `action=trackpick&track=${t}` : `action=plan&track=${t}`,
          displayText: pick
            ? `${TRACK_LABELS[t].ja} で始めます`
            : `${TRACK_LABELS[t].ja} の受講料を見ます`
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
export function priceList(track, { trialAvailable = false, availableDays = TOTAL_DAYS } = {}) {
  const l = TRACK_LABELS[track];

  /* 原稿の保有日数を超えるパッケージは出さない（指示書 §1-2）。
     中級 30 日ぶんの原稿で 101 日を売ると、31 日目から「原稿なし」で
     **黙って**止まる ── 売った側は気づかず、買った側だけが知る。
     原稿を増やせば、この絞り込みが自動で上のパッケージを開く。 */
  const sellable = sellablePackages(availableDays);
  if (!sellable.length) return null;   /* 呼ぶ側が「準備中」を出す */

  const rows = sellable
    .map(([key, p]) => `・${String(p.days).padStart(3)} 日分　${p.price.toLocaleString()} 円（税込）`);

  const items = sellable.map(([key, p]) => ({
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
export async function startTrialFor(conn, user, track,
  { transact = (fn) => fn(conn) } = {}) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };

  /* subscriptions と grant を 1 つに（creditFromStripe と同じ理由）。
     半分だけ成功すると subscriptions.user_id UNIQUE のせいで
     体験を**永遠に再試行できない**状態が残る。 */
  const r = await transact((tx) => billing.startTrial(tx, user.id, track));
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
/* transact は注入で受ける（plan-outage-billing §2-2 B）。本番は app.mjs が
   withTransaction を渡し、関門は既定値（同じ conn でそのまま実行）で
   SQL の順序を検証する ── handlers が db.mjs(=mysql2) を直接 import
   すると、偽の conn で回る関門が壊れるため。

   くくる単位は「台帳＋日数」だけ。守る不変式は
   **「台帳があれば日数もある」** の 1 つで、ensureProgress /
   setActiveTrack は接点の自己回復（healProgress）が拾う種類なので
   トランザクションに含めない。 */
export async function creditFromStripe(conn, ev,
  { deliver = null, send = pushMessage, transact = (fn) => fn(conn) } = {}) {
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
  /* 台帳（purchases）と日数（grant）と subscriptions を 1 つの
     トランザクションで。INSERT の後・grant の前に死ぬと「決済の記録は
     あるのに日数が無い」が残り、再送は payment_ref UNIQUE の 1062 で
     **静かに無視**される ── 回復の道が無い half-done を作らない。 */
  const credited = await transact((tx) =>
    billing.creditPurchase(tx, user.id, ev.track, ev.packageType,
      { paymentRef: ev.sessionId, pricePaid: ev.amount || null }));

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
