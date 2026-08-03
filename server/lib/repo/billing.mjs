/* ==================================================================
   repo/billing.mjs — purchases と subscriptions

   この 2 つを 1 つのファイルに置いたのは、必ず一緒に動くから。
   購入を 1 件記録して、保有日数を足す ── 片方だけ成功した状態は
   「払ったのに日数が増えない」か「払っていないのに増える」で、
   どちらも自力では直せない。呼ぶ側が 2 回呼ぶ形にしていると
   いつか片方を忘れるので、1 つの関数にしてある（creditPurchase）。

   金額は円。整数で持つ（小数点以下が無い通貨なので、浮動小数を
   通す理由が無い）。
   ================================================================== */
import { one, all, run, insertNew, nn } from "./util.mjs";
import { jstDate, addDays } from "../jst.mjs";

/* パッケージの定義。計画書 1-1 の価格表そのもの。
   ここを唯一の出どころにする ── 決済ページと配信側で別々に
   持つと、片方だけ値上げしたときに「払った額と増えた日数が
   合わない」が起き、しかも請求は通っているので気づかない。 */
export const PACKAGES = Object.freeze({
  "7days":   { days: 7,   price:  980 },
  "14days":  { days: 14,  price: 1680 },
  "30days":  { days: 30,  price: 2980 },
  "60days":  { days: 60,  price: 4980 },
  "101days": { days: 101, price: 7480 }
});

export const TRIAL_DAYS = 3;


/* ---- 契約状態 ----------------------------------------------------- */

export async function getSubscription(conn, userId) {
  return one(conn,
    `SELECT id, user_id, trial_start, trial_end, total_days_entitled, payment_status
       FROM subscriptions WHERE user_id = ?`, [userId]);
}

/* 体験の開始。3 日間なので trial_end は +2 日（開始日を 1 日目に数える）。
   既にある人は触らない ── ブロック → 再追加のたびに体験が
   延びると、無料で 101 日ぶんを読めてしまう。 */
export async function startTrial(conn, userId, startDate = null) {
  const start = startDate || jstDate();
  const ins = await insertNew(conn,
    `INSERT INTO subscriptions
       (user_id, trial_start, trial_end, total_days_entitled, payment_status)
     VALUES (?, ?, ?, ?, 'trial')`,
    [userId, start, addDays(start, TRIAL_DAYS - 1), TRIAL_DAYS]);
  /* 既にあれば何もしない。subscriptions の一意キーは user_id 1 本なので、
     1062 は「もう体験が始まっている」だけを意味する。 */
  return { created: ins.created, subscription: await getSubscription(conn, userId) };
}

export async function setPaymentStatus(conn, userId, status) {
  const OK = ["none", "trial", "paid", "expired", "refunded"];
  if (!OK.includes(status)) throw new Error(`未知の payment_status: ${status}`);
  const r = await run(conn,
    `UPDATE subscriptions SET payment_status = ? WHERE user_id = ?`, [status, userId]);
  return r.affectedRows > 0;
}


/* ---- 購入 ---------------------------------------------------------
   決済サービスの webhook は、同じイベントを二度以上届ける。再送は
   仕様であって障害ではないので、「二度目が来ない」前提では書けない。

   ここでの止め方は 2 段。
     1 purchases.payment_ref の UNIQUE で 2 件目の行を作らせない
     2 行が実際に増えたときだけ日数を足す（下の created 判定）

   アプリ側の「先に SELECT して無ければ INSERT」では止まらない。
   webhook が同時に 2 本来ると、両方の SELECT が「無い」を見てから
   両方が INSERT へ進むため ── 一意制約だけが確実に止められる。 */
export async function creditPurchase(conn, userId, packageType, {
  paymentRef = null, pricePaid = null, purchasedAt = null
} = {}) {
  const pkg = PACKAGES[packageType];
  if (!pkg) {
    throw new Error(`未知の package_type: ${packageType}（${Object.keys(PACKAGES).join(" / ")}）`);
  }

  const price = pricePaid === null || pricePaid === undefined ? pkg.price : pricePaid;

  /* 素の INSERT を投げて 1062（一意制約違反）を捕まえる。
     purchases の一意キーは payment_ref 1 本なので、1062 は
     「この取引 ID はもう記録済み」＝再送だと確定できる。

     affectedRows では見分けられない。mysql2 の既定では新規も重複も
     1 を返すため（util.mjs の insertNew に実測を書いた）。
     ここを取り違えると、決済 1 件で日数が二度足される。 */
  const ins = await insertNew(conn,
    `INSERT INTO purchases
       (user_id, package_type, days_granted, price_paid, payment_ref, purchased_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [userId, packageType, pkg.days, price, nn(paymentRef), nn(purchasedAt)]);

  const created = ins.created;

  if (!created) {
    /* 再送。日数は足さない。呼び出し側が「無視した」と分かるように返す。 */
    return {
      created: false,
      daysGranted: 0,
      subscription: await getSubscription(conn, userId)
    };
  }

  await run(conn,
    `UPDATE subscriptions
        SET total_days_entitled = total_days_entitled + ?,
            payment_status      = 'paid'
      WHERE user_id = ?`,
    [pkg.days, userId]);

  return {
    created: true,
    daysGranted: pkg.days,
    purchaseId: ins.insertId,
    subscription: await getSubscription(conn, userId)
  };
}

export async function listPurchases(conn, userId) {
  return all(conn,
    `SELECT id, package_type, days_granted, price_paid, purchased_at, payment_ref
       FROM purchases WHERE user_id = ? ORDER BY purchased_at, id`, [userId]);
}

export async function findByPaymentRef(conn, paymentRef) {
  return one(conn,
    `SELECT id, user_id, package_type, days_granted, price_paid, purchased_at
       FROM purchases WHERE payment_ref = ?`, [paymentRef]);
}


/* ---- 合計の突き合わせ ----------------------------------------------
   total_days_entitled は purchases の合計 + 体験 3 日を写したもの。
   写しである以上ずれうるので、ずれを見つける手立てを持っておく。

   ずれ方は片側にしか起きない ── 購入は入ったが加算の前に落ちた場合、
   利用者は払ったのに日数が足りない。逆（多すぎる）は一意制約が
   止めているので、まず起きない。運営者が気づけないのは前者の方で、
   放っておくと問い合わせになる。

   P10 の監視から日次で呼ぶ想定。ここでは直さず、差だけ返す。
   自動で直すと、原因が残ったまま数字だけ合ってしまう。 */
/* 別名を stored にしない。MySQL 8.0 では STORED が予約語
   （GENERATED ALWAYS AS (…) STORED の方）なので、AS stored と書くと
   1064 で落ちる。エラーは「文法が違う」としか出ず、指す位置も
   その次の行になるので、別名が原因だとは読み取れない。
   本物の MySQL に流して初めて分かった類い（db/smoke.mjs）。

   TRIAL_DAYS を ? で渡さず埋めているのは、prepared statement が
   SELECT の式の先頭に来た ? の型を決められないため。
   埋めるのはこのファイルの const（3）なので注入の余地は無い。 */
const T = Number(TRIAL_DAYS);

export async function recountEntitledDays(conn, userId) {
  const row = await one(conn,
    `SELECT s.total_days_entitled AS stored_days,
            ${T} + COALESCE((SELECT SUM(days_granted) FROM purchases WHERE user_id = s.user_id), 0)
              AS expected_days
       FROM subscriptions s
      WHERE s.user_id = ?`, [userId]);
  if (!row) return null;
  const stored = Number(row.stored_days), expected = Number(row.expected_days);
  return { stored, expected, drift: stored - expected };
}

/* 全員ぶん。合っている人は返さない ── 毎日出る通知が
   「異常なし」ばかりだと、本当の異常も読み飛ばされる。 */
export async function findEntitlementDrift(conn) {
  return all(conn,
    `SELECT s.user_id,
            s.total_days_entitled AS stored_days,
            ${T} + COALESCE(p.total, 0) AS expected_days
       FROM subscriptions s
       LEFT JOIN (SELECT user_id, SUM(days_granted) AS total
                    FROM purchases GROUP BY user_id) p ON p.user_id = s.user_id
      WHERE s.total_days_entitled <> ${T} + COALESCE(p.total, 0)`);
}
