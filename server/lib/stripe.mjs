/* ==================================================================
   stripe.mjs — 決済。SDK は入れない

     import { createCheckoutSession, verifyStripeSignature } from './lib/stripe.mjs';

   この저장소の依存は mysql2 ひとつで、そのおかげで関門 16 種が
   npm install なしで走る（lib/db.mjs の注記）。Stripe SDK を足すと
   その性質が消える ── 依存が 20 個ほど増え、検証に install が要る
   範囲が広がる。

   ここで要るのは 2 つだけなので、fetch で足りる。

     ① 決済ページ（Checkout）を 1 つ作って URL を得る
     ② 戻ってきた webhook が本当に Stripe からか確かめる

   【カード番号はここを通らない】
   Checkout は Stripe が持つ画面なので、カード番号はこちらのサーバーに
   届かない。privacy.html が「クレジットカードの番号を当方が受け取る
   ことはありません」と既に書いているので、この方式がその文を真に保つ。
   自前のカード入力欄を作った瞬間、その文が嘘になる。

   【前払いの回数券であって、定期購読ではない】
   mode は 'payment'。'subscription' にすると自動更新が始まり、
   日本の定期購入の表示義務（更新周期・解約方法）が丸ごと乗る
   （docs/plan-billing.md §7.2）。ここを取り違えると、コードは動く
   のに表示が足りない状態で課金が走る。
   ================================================================== */
import crypto from "node:crypto";
import { loadEnv, requireEnv } from "./env.mjs";

/* 宛先を差し替えられるようにしておく。手元で流れを通すときだけ使い、
   本番では設定しない ── LINE の宛先と同じ考え方で、置き忘れたまま
   起動したら app.mjs が止める。 */
const apiBase = () => process.env.STRIPE_API_BASE || "https://api.stripe.com";

export function stripeConfig() {
  loadEnv();
  return requireEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
}

/* ---- ① 決済ページを作る ---------------------------------------------
   Stripe の API はフォーム形式（application/x-www-form-urlencoded）で、
   入れ子は line_items[0][price_data][...] のように角括弧で表す。
   JSON を投げると 400 になる。

   価格は円。unit_amount は「その通貨の最小単位」で、円は小数が無いので
   そのまま整数を渡す ── ドルの感覚で 100 倍すると 100 倍請求になる。 */
export async function createCheckoutSession({
  userId, track, packageType, days, price, productName,
  successUrl, cancelUrl, clientRef = null
}) {
  const cfg = stripeConfig();

  const form = new URLSearchParams({
    mode: "payment",                        // ← 自動更新ではない
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "jpy",
    "line_items[0][price_data][unit_amount]": String(Math.trunc(price)),
    "line_items[0][price_data][product_data][name]": productName,

    /* 誰が何を買ったかは、webhook でこれだけが頼り。セッション id から
       引き直す往復を増やさないために載せる。
       ★ ただし webhook 側では信じ切らない ── metadata は
       こちらが入れたものだが、user_id の存在は必ず引いて確かめる
       （handlers/checkout.mjs）。 */
    "metadata[user_id]": String(userId),
    "metadata[track]": track,
    "metadata[package]": packageType,
    "metadata[days]": String(days)
  });

  /* 同じボタンを連打されても Stripe 側で 1 つにまとめる。
     こちらの payment_ref の一意制約とは別の層で、こちらは
     「決済が 2 件立つ」こと自体を防ぐ。 */
  if (clientRef) form.set("client_reference_id", String(clientRef));

  const res = await fetch(`${apiBase()}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${text.slice(0, 300)}`);

  const session = JSON.parse(text);
  if (!session.url) throw new Error("Stripe が決済ページの URL を返しませんでした");
  return session;
}


/* ---- ② webhook が本物か ---------------------------------------------
   ヘッダはこの形で来る:

     Stripe-Signature: t=1699999999,v1=5257a8...,v1=...(古い鍵ぶん)

   署名の対象は `${t}.${生の本文}`。lib/signature.mjs と同じ 3 つの罠が
   そのままある:

     1 生のバイト列で計算する。JSON.parse したものを stringify し直すと
       鍵の順や空白が変わって一致しない ── 逆にたまたま一致する書き方
       だと通ってしまい、どちらに転んでも原因が署名だと気づけない
     2 === で比べない。先頭から何文字目で違ったかが所要時間に出る
     3 Stripe は **hex**。LINE は base64 なので、写すと全部落ちる

   Stripe にはもう 1 つある ── **時刻**。t が古い要求を通すと、
   一度どこかへ漏れた要求を、いつでも投げ直せる。既定は 5 分。
   ================================================================== */
export function verifyStripeSignature(rawBody, headerValue, secret, {
  toleranceSec = 300, nowSec = null
} = {}) {
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET が設定されていません");
  if (!Buffer.isBuffer(rawBody)) {
    /* 文字列で渡されると、UTF-8 以外の解釈で別のバイト列になりうる。
       呼び出し側の取り違えなので、黙って通さず投げる。 */
    throw new Error("rawBody は Buffer で渡してください（再シリアライズ禁止）");
  }
  if (!headerValue || typeof headerValue !== "string") return false;

  /* v1 は複数来ることがある（鍵の入れ替え中）。どれか 1 つ合えばよい。 */
  let t = null;
  const sigs = [];
  for (const part of headerValue.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length) return false;

  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  const now = nowSec === null ? Math.floor(Date.now() / 1000) : Number(nowSec);
  if (Math.abs(now - ts) > toleranceSec) return false;      // 古すぎる／先すぎる

  /* `${t}.` までを文字列で、本文は Buffer のまま流し込む。
     連結して 1 つの文字列にすると、そこで再エンコードが起きる。 */
  const expected = crypto.createHmac("sha256", secret)
    .update(`${t}.`, "utf8")
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  return sigs.some((s) => {
    const b = Buffer.from(s, "utf8");
    /* 長さが違えば timingSafeEqual が投げる。先に見て落とす。
       hex の桁数は固定なので、長さの違いは中身を漏らさない。 */
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/* 本文から要るものだけ取り出す。Stripe の event は大きいので、
   使うものを 1 か所に集めておくと、増やしたときに追える。 */
export function readCheckoutEvent(event) {
  /* async_payment_succeeded も受ける（plan-outage-billing §2-3 (가)）。
     コンビニ・銀行振込は completed が **unpaid** で来て（下の判定で
     捨てる）、入金の瞬間にこちらのイベントが paid で届く ── 受けないと
     「入金されたのに日数が永遠に 0」。session の形は completed と同じで、
     payment_ref（session id）も同じなので、二重に来ても 1062 が防ぐ。

     ★ 危険の在りか: この事故は Stripe のダッシュボードで決済手段を
     増やす**だけ**で発生し、コード変更を伴わない。日本の PSP へ替えると
     コンビニ払いが標準で載るので、その日が来る前にここで受けておく。 */
  const OK_TYPES = ["checkout.session.completed",
                    "checkout.session.async_payment_succeeded"];
  if (!event || !OK_TYPES.includes(event.type)) return null;
  const s = event?.data?.object;
  if (!s) return null;

  /* 未払いのまま completed が来ることがある（銀行振込など）。
     払われていないものを日数に替えない。 */
  if (s.payment_status && s.payment_status !== "paid") return null;

  const m = s.metadata || {};
  return {
    sessionId: s.id,
    userId: Number(m.user_id),
    track: m.track || null,
    packageType: m.package || null,
    amount: Number(s.amount_total ?? 0)
  };
}
