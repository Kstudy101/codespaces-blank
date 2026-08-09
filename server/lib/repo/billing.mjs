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
import { isTrack, TRACKS } from "./learning.mjs";
import * as entitlements from "./entitlements.mjs";

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

export const TRIAL_DAYS = 7;

/* 体験の終わり前日の夕方に 1 度だけ勧める。「2」を push-evening と
   文面に別々に書くと、体験日数を変えた日に片方だけ古くなる ──
   3→7 の実測で、その形が 4 か所出た（plan-trial-7days §2）。 */
export const TRIAL_UPSELL_DAY = TRIAL_DAYS - 1;


/* ---- 契約状態 ----------------------------------------------------- */

export async function getSubscription(conn, userId) {
  return one(conn,
    `SELECT id, user_id, trial_start, trial_end, trial_track, trial_days, payment_status
       FROM subscriptions WHERE user_id = ?`, [userId]);
}

/* ---- 体験は「コースを選んでから」始める ------------------------------
   友だち追加した瞬間に配る形をやめた。コースを選ぶ前に始めると、
   中級を受けたい人に初級の 3 日が届く（計画書 §2）。

   ★ 1 アカウント 1 回だけ。コース別にすると、コースを変えるだけで
   3 コース ×3 日 = 9 日を無料で受け取れる。trial_start が入って
   いれば「もう使った」と見る ── subscriptions の一意キーは
   user_id 1 本なので、1062 はそれだけを意味すると確定できる。

   trial_end は日付で持つが、配信を止めているのは日数（残り）の方。
   ここは「いつ使ったか」の記録として残す。 */
export async function startTrial(conn, userId, track, startDate = null) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const start = startDate || jstDate();

  /* 台帳に書く日数と、実際に贈る日数を 1 つの値から取る（007）。
     2 か所で別々に TRIAL_DAYS を読むと、片方だけ直した日に
     「貰った日数と台帳」が黙ってずれる。 */
  const days = TRIAL_DAYS;

  const ins = await insertNew(conn,
    `INSERT INTO subscriptions
       (user_id, trial_start, trial_end, trial_track, trial_days, payment_status)
     VALUES (?, ?, ?, ?, ?, 'trial')`,
    [userId, start, addDays(start, days - 1), track, days]);

  if (!ins.created) {
    /* もう使っている。どのコースで使ったかを返して、呼ぶ側が
       「体験は 1 回だけです」と言えるようにする。 */
    return { created: false, subscription: await getSubscription(conn, userId) };
  }

  /* 体験ぶんの日数は購入と同じ入れ物に積む。別枠にすると、残りを
     数えるのに 2 か所を足し合わせることになり、片方を忘れる。
     purchases には入れない ── あちらは「払った」台帳なので、
     0 円の行が混ざると売上の集計が狂う。 */
  await entitlements.grant(conn, userId, track, days);

  return { created: true, subscription: await getSubscription(conn, userId) };
}

/* 体験を使ったか。使っていれば trial_start が入っている。 */
export async function trialUsed(conn, userId) {
  const s = await getSubscription(conn, userId);
  return !!(s && s.trial_start);
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
export async function creditPurchase(conn, userId, track, packageType, {
  paymentRef = null, pricePaid = null, purchasedAt = null
} = {}) {
  if (!isTrack(track)) {
    throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  }
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
     ここを取り違えると、決済 1 件で日数が二度足される。

     Stripe の webhook は同じイベントを何度も送ってくる。再送は仕様で
     あって障害ではないので、「二度目が来ない」前提では書けない。 */
  const ins = await insertNew(conn,
    `INSERT INTO purchases
       (user_id, track, package_type, days_granted, price_paid, payment_ref, purchased_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [userId, track, packageType, pkg.days, price, nn(paymentRef), nn(purchasedAt)]);

  if (!ins.created) {
    /* 再送。日数は足さない。呼び出し側が「無視した」と分かるように返す。 */
    return { created: false, daysGranted: 0, track, entitlement: await entitlements.get(conn, userId, track) };
  }

  /* 行が実際に増えたときだけ積む。この順番が要る ── 先に積んで
     から台帳に書くと、途中で落ちた日に「もらったが払った記録が無い」
     が残り、あとから区別できない。 */
  const entitlement = await entitlements.grant(conn, userId, track, pkg.days);
  await run(conn,
    `UPDATE subscriptions SET payment_status = 'paid' WHERE user_id = ?`, [userId]);

  return {
    created: true,
    daysGranted: pkg.days,
    track,
    purchaseId: ins.insertId,
    entitlement
  };
}

export async function listPurchases(conn, userId) {
  return all(conn,
    `SELECT id, track, package_type, days_granted, price_paid, purchased_at, payment_ref
       FROM purchases WHERE user_id = ? ORDER BY purchased_at, id`, [userId]);
}

/* 1 度でも買ったことがあるか。「体験中（購入 0）」の判別に使う ──
   体験中の朝の便に期限の予告を付けない（plan-course-onboarding §5。
   始めた直後の 1 通に「あと 2 日」が付くのを止める）。
   listPurchases で数えないのは、判別に全行は要らないため。 */
export async function hasPurchases(conn, userId) {
  const row = await one(conn,
    `SELECT id FROM purchases WHERE user_id = ? LIMIT 1`, [userId]);
  return row !== null;
}

export async function findByPaymentRef(conn, paymentRef) {
  return one(conn,
    `SELECT id, user_id, track, package_type, days_granted, price_paid, purchased_at
       FROM purchases WHERE payment_ref = ?`, [paymentRef]);
}


/* ---- 合計の突き合わせ ----------------------------------------------
   course_entitlements.days_entitled は
     purchases の合計（そのコースぶん）＋ 体験 3 日（使ったコースだけ）
   を写したもの。写しである以上ずれうるので、見つける手立てを持つ。

   ずれ方は片側にしか起きない ── 購入は入ったが加算の前に落ちた場合、
   利用者は払ったのに日数が足りない。逆（多すぎる）は payment_ref の
   一意制約が止めているので、まず起きない。運営者が気づけないのは
   前者の方で、放っておくと問い合わせになる。

   P10 の監視から日次で呼ぶ想定。ここでは直さず、差だけ返す。
   自動で直すと、原因が残ったまま数字だけ合ってしまう。

   コース別に見る。合計で数えると、初級が 3 日多くて中級が 3 日
   少ない状態が「差 0」に見える。 */
/* 別名を stored にしない。MySQL 8.0 では STORED が予約語
   （GENERATED ALWAYS AS (…) STORED の方）なので、AS stored と書くと
   1064 で落ちる。エラーは「文法が違う」としか出ず、指す位置も
   その次の行になるので、別名が原因だとは読み取れない。
   本物の MySQL に流して初めて分かった類い（db/smoke.mjs）。 */

/* 体験ぶんは「体験を使ったコース」にだけ乗る。s が無い（体験を
   使っていない）人は s.trial_track が NULL なので、比較が NULL に
   なり IF は 0 を返す ── 別に IS NULL を書かなくてよい。

   日数は定数ではなく行が持つ（007）。TRIAL_DAYS を変えても過去の
   契約が再計算されない ── これが無いと、体験日数を変えた翌朝に
   既存の体験者が全員この通知に載る。

   trial_track はあるのに trial_days が NULL なら、それは startTrial の
   書き忘れの証拠。COALESCE で 0 に落として drift として鳴らす ──
   静かに 3 を補うと、間違いが見えないまま残る。 */
const EXPECTED =
  `COALESCE(p.total, 0) + IF(s.trial_track = e.track, COALESCE(s.trial_days, 0), 0)`;

const DRIFT_SQL = `
  SELECT e.user_id, e.track,
         e.days_entitled AS stored_days,
         ${EXPECTED}     AS expected_days
    FROM course_entitlements e
    LEFT JOIN (SELECT user_id, track, SUM(days_granted) AS total
                 FROM purchases GROUP BY user_id, track) p
           ON p.user_id = e.user_id AND p.track = e.track
    LEFT JOIN subscriptions s ON s.user_id = e.user_id`;

export async function recountEntitledDays(conn, userId, track) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
  const row = await one(conn, `${DRIFT_SQL} WHERE e.user_id = ? AND e.track = ?`,
    [userId, track]);
  if (!row) return null;
  const stored = Number(row.stored_days), expected = Number(row.expected_days);
  return { track, stored, expected, drift: stored - expected };
}

/* 全員ぶん。合っている人は返さない ── 毎日出る通知が
   「異常なし」ばかりだと、本当の異常も読み飛ばされる。 */
export async function findEntitlementDrift(conn) {
  return all(conn, `${DRIFT_SQL} WHERE e.days_entitled <> ${EXPECTED}`);
}

/* ---- 逆方向の突き合わせ（plan-outage-billing §2-2 C）----------------
   上の DRIFT_SQL は course_entitlements を起点にするので、
   **e 行そのものが生まれなかった** half-done を見られない:
     (i)  初回購入が INSERT purchases の後・grant の前に死んだ
     (ii) startTrial が subscriptions の後・grant の前に死んだ
          ── (ii) は user_id UNIQUE のせいで体験を永遠に再試行できない
   台帳の側から引き直して、行ごと無い欠けを拾う。
   **検出・報告だけ。自動修正はしない**（直すのは人 ── 消えた原因を
   見ずに埋めると、同じ穴に何度でも落ちる）。 */
export async function findMissingEntitlements(conn) {
  /* 台帳（purchases）はあるのに、そのコースの e 行が無い */
  const fromPurchases = await all(conn, `
    SELECT p.user_id, p.track, SUM(p.days_granted) AS bought
      FROM purchases p
      LEFT JOIN course_entitlements e
        ON e.user_id = p.user_id AND e.track = p.track
     WHERE e.user_id IS NULL
     GROUP BY p.user_id, p.track`);

  /* 体験の記録（subscriptions.trial_track）はあるのに e 行が無い */
  const fromTrials = await all(conn, `
    SELECT s.user_id, s.trial_track AS track
      FROM subscriptions s
      LEFT JOIN course_entitlements e
        ON e.user_id = s.user_id AND e.track = s.trial_track
     WHERE s.trial_track IS NOT NULL AND e.user_id IS NULL`);

  return { fromPurchases, fromTrials };
}
