/* ==================================================================
   push-evening.mjs — 夕方のふりかえり

     node db/push-evening.mjs                今日ぶんを配る
     node db/push-evening.mjs --dry-run      誰に何日目が行くかだけ出す
     node db/push-evening.mjs --date=2026-08-04   その日として動かす
     node db/push-evening.mjs --limit=10     先頭 10 人だけ
     node db/push-evening.mjs --not-before=18 日本の 18 時より前なら何もしない

   朝の便（push-daily.mjs）と対になる。違うところが 3 つある。

   【1 対象は「今朝ちゃんと届いた人」だけ】
   進捗（learning_progress.current_day）から逆算しない。朝の配信で
   current_day は既に +1 されているので、そこから引くと、その日に
   配信を受けられなかった人（保有日数切れ・送信失敗・原稿なし）まで
   混ざる。実際に送ったログを見るのが唯一正しい ── それが
   pushlogs.listReviewTargets（計画書 4-2）。

   【2 日を進めない】
   復習は「保有日数を削らないボーナス」（計画書 1-2）。
   advanceDay を呼ばない。呼ばないことは verify-push.mjs が見張る。

   【3 原稿が無くても止まらない】
   朝が送れた日なので原稿は必ずある。それでも getTemplate が空を
   返したら（入稿を消した等）、その人だけ黙って飛ばす ── 復習が
   1 日抜けることと、夕方の便が全員ぶん落ちることでは重さが違う。

   cron は朝と同じ 1 時間ごと。何時に配るかは --not-before=18 で
   こちらが決める（借りたサーバーの地方時に頼らない）。
   ================================================================== */
import { createHash } from "node:crypto";
import { getPool, closePool } from "../lib/db.mjs";
import { users, learning, pushlogs } from "../lib/repo/index.mjs";
import { pushMessage, isUnreachable } from "../lib/line.mjs";
import { jstDate, jstDateTime } from "../lib/jst.mjs";
import { renderReview, renderReviewQuestion } from "../lib/render.mjs";
import { salesAllowedFor, sellablePackages, trialUpsellNotice } from "../lib/handlers/checkout.mjs";

/* ---- 引数 --------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY   = flag("dry-run");
const NOT_BEFORE = value("not-before", null);
const DATE  = value("date", jstDate());
const LIMIT = Number(value("limit", 0)) || 0;

/* 朝と同じ非常停止。夕方だけ動き続けると、止めたつもりの日に
   復習だけが届く。 */
const DISABLED = process.env.PUSH_DISABLED === "1";

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`✗ --date は YYYY-MM-DD で渡してください: ${DATE}`);
  process.exit(1);
}

/* 朝と同じ判定。共用サーバーの cron は地方時で動くので、
   日本の 18 時かどうかはこちらで見る。「18 時以降」にしてあるのは、
   18 時の回が落ちた日に 19 時が拾えるようにするため。 */
export function tooEarly(jstHour, notBefore) {
  if (notBefore === null || notBefore === undefined || notBefore === "") return false;
  const want = Number(notBefore);
  if (!Number.isInteger(want) || want < 0 || want > 23) {
    throw new Error(`--not-before は 0〜23 で渡してください: ${notBefore}`);
  }
  return Number(jstHour) < want;
}

if (NOT_BEFORE !== null) {
  const hour = Number(jstDateTime().slice(11, 13));
  let early;
  try {
    early = tooEarly(hour, NOT_BEFORE);
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  if (early) {
    console.log(`日本時間 ${String(hour).padStart(2, "0")} 時。${NOT_BEFORE} 時前なので何もしません。`);
    process.exit(0);
  }
}

/* 朝と同じ作り方で、種別だけ違う。同じ人・同じ日・同じ種別なら
   毎回同じ UUID になるので、こちらの記録が残る前に落ちても
   LINE 側で二重配信を弾ける。 */
export function retryKey(userId, day, type) {
  const h = createHash("sha256").update(`${userId}:${day}:${type}:${DATE}`).digest("hex");
  const b = h.slice(0, 32).split("");
  b[12] = "5";
  b[16] = "89ab"[parseInt(b[16], 16) % 4];
  const s = b.join("");
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
}


/* ---- 体験 2 日目の勧誘（2026-08-06 指示書 C4）----------------------
   復習の**後ろに同封**する。別便にしないのは朝の期限予告と同じ理由 ──
   通知を二度鳴らさない。quickReply が開くのは最後の 1 通だけなので、
   末尾に置くことが条件でもある。

   対象は「今朝 2 日目が届いた体験中の人」。listReviewTargets の行には
   status も current_day も無いので、day_number = 2 のときだけ 1 人ぶん
   引き直して確かめる（findDeliverable。全員ぶん取ると、勧誘のために
   夕方の一覧へ列を足し続けることになる）。

   通算 1 回だけ。push_logs の trial_end（migrations/004）で数える ──
   残り 0 の朝の勧誘（upsell）と種別を分けるのは承認時の修正 2。
   day_number の値で見分ける形だと、入れる値が 2 か所で独立に決まり、
   片方を直した日にもう片方の「1 回だけ」が黙って壊れる。

   文面の分岐（買える/買えない）は trialUpsellNotice に書いてある。
   判定の片側 sellablePackages は価格表（priceList）と同じ関数 ──
   原稿の保有日数が売れる上限、を二か所に書かない。 */
async function trialUpsellSection(conn, u) {
  const full = await users.findDeliverable(conn, u.id);
  if (!full || full.status !== "trial" || Number(full.current_day) !== 2) return null;
  if (await pushlogs.countByType(conn, u.id, "trial_end")) return null;
  const availableDays = await learning.countTemplates(conn, full.track);
  const canBuy = salesAllowedFor(full) && sellablePackages(availableDays).length > 0;
  return trialUpsellNotice(full.track, { canBuy });
}

/* ---- 1 人ぶん ------------------------------------------------------
   朝と同じく、返すのは何をしたかの一語。

   send を差し替えられるようにしてあるのは、ここで一番間違えたく
   ないのが「日を進めない」で、それは本物へ送っても確かめられない
   ── 送ったあとに current_day を見ても、朝の +1 と区別できない。
   偽の send を渡して、呼ばれた時点の DB を覗く。 */
/* renderQ を差し替えられるのは検査のため ── Flex 組み立てが落ちたとき
   テキスト 2 通のフォールバックへ降りること（§4-3）は、本物を
   わざと壊さないと確かめられない。 */
export async function deliverOne(conn, u,
  { send = pushMessage, renderQ = renderReviewQuestion } = {}) {
  const day = Number(u.day_number) || 0;
  if (!day) return "日付なし";

  /* 既に送っていれば何もしない。cron は 1 時間ごとに来るので、
     これが無いと 18 時から日付が変わるまで毎時届く。 */
  if (await pushlogs.sentToday(conn, u.id, "review", DATE)) return "既送";

  /* コースが決まっていない人はそもそも朝が届いていないので、
     ここには来ない。来たとすれば朝の判定と食い違っているので、
     送らずに数える ── 黙って初級を引くと、その食い違いが隠れる。 */
  if (!u.track) return "コース未選択";

  const tpl = await learning.getTemplate(conn, u.track, day);
  if (!tpl) return "原稿なし";

  /* 問いは Flex 1 通（지시서⑨）。答えは「こたえを見る」が押されて
     初めて送る（handlers/postback.mjs の answer）── 2 通同時だと
     携帯の画面で答えが問いのすぐ下に並び、思い出す間が無かった。
     Flex の組み立てが落ちたら、従来のテキスト 2 通へ降りる（§4-3）
     ── 夕方が丸ごと止まるよりよい。降りたことはログに残す。 */
  let messages;
  try {
    const q = renderQ(tpl, u);
    messages = q === null ? null : [q];
  } catch (e) {
    console.error(`  ! user ${u.id}: Flex 組み立てに失敗 ── テキスト 2 通で送ります: ${e.message}`);
    messages = renderReview(tpl, u);
  }
  /* 名前が要るのに無い。朝が届いている以上ふつうは起きないが、
     間に名前を消した人（「LINEの名前にする」を選んだ）が居うる。
     復習で登録を促すと朝夕 2 回お願いすることになるので、黙る。 */
  if (messages === null) return "名前なし";

  /* 日数は消費しない ── この便が advanceDay を呼ばない不変式は
     勧誘を足しても変わらない（verify-evening がソースごと見張る）。 */
  const upsell = day === 2 ? await trialUpsellSection(conn, u) : null;
  const bundle = upsell ? [...messages, upsell] : messages;

  if (DRY || DISABLED) {
    return `${DRY ? "予定" : "停止中"}${upsell ? "（勧誘つき）" : ""}:${day}日目`;
  }

  try {
    await send(u.line_user_id, bundle, { retryKey: retryKey(u.id, day, "review") });
    await pushlogs.logSent(conn, u.id, { dayNumber: day, pushType: "review" });
    if (upsell) {
      /* 出したことを別に残す ── これが「通算 1 回」の判定そのもの。 */
      await pushlogs.logSent(conn, u.id, { dayNumber: 2, pushType: "trial_end" });
      return `送信+勧誘:${day}日目`;
    }
    return `送信:${day}日目`;
  } catch (e) {
    const gone = isUnreachable(e);
    if (gone) await users.markUnfollowed(conn, u.line_user_id);
    await pushlogs.logFailed(conn, u.id,
      { dayNumber: day, pushType: "review", error: String(e.message || e).slice(0, 500) });
    return gone ? "届かない" : "送信失敗";
  }
}


/* ---- 全員 ---------------------------------------------------------
   朝と違って頁分けしない。対象は「今朝ちゃんと届いた人」なので、
   多くても朝の配信数までにしかならない ── 朝が LIMIT / OFFSET で
   区切れている以上、ここが独立に膨らむことはない。 */
async function main() {
  const pool = await getPool();
  const tally = new Map();
  const bump = (k) => {
    const key = k.replace(/:\d+日目$/, "");
    tally.set(key, (tally.get(key) || 0) + 1);
  };

  let rows = await pushlogs.listReviewTargets(pool, DATE);
  if (LIMIT) rows = rows.slice(0, LIMIT);

  for (const u of rows) {
    try {
      bump(await deliverOne(pool, u));
    } catch (e) {
      /* 1 人で落ちても残りは配る。 */
      console.error(`  ! user ${u.id}: ${e.message}`);
      bump("処理中の異常");
    }
  }

  const label = DRY ? "（下見）" : DISABLED ? "（PUSH_DISABLED=1 で停止中）" : "";
  console.log(`\n${DATE} 夕方のふりかえり ${label}  対象 ${rows.length} 人`);
  if (!tally.size) console.log("  送る相手がいません（今朝の配信が 0 件）");
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }

  await closePool();
  const bad = (tally.get("送信失敗") || 0) + (tally.get("処理中の異常") || 0);
  if (bad) process.exitCode = 1;
}

/* 直接呼ばれたときだけ走る。検証が読み込んだだけで本番へ
   送り始める、は起こしてはいけない類い。 */
if (process.argv[1] && process.argv[1].endsWith("push-evening.mjs")) await main();
