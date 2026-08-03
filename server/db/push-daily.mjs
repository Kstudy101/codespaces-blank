/* ==================================================================
   push-daily.mjs — 朝の配信バッチ

     node db/push-daily.mjs                今日ぶんを配る
     node db/push-daily.mjs --dry-run      誰に何日目が行くかだけ出す
     node db/push-daily.mjs --date=2026-08-04   その日として動かす
     node db/push-daily.mjs --limit=10     先頭 10 人だけ
     node db/push-daily.mjs --not-before=7 日本の 7 時より前なら何もしない

   cron が呼ぶ。app.mjs の経路にはしない ── HTTP に出すと外から
   配信を起こせてしまい、そのための認証をもう一つ作ることになる。

   【順番がすべて】
   この処理には正しい順番が 1 つしか無い。

     1  原稿があるか見る      無ければ、まだ日を消費しない
     2  日を確保する          advanceDay。取れなければ降りる
     3  送る
     4  記録する

   2 を 3 より先にするのは learning.mjs の advanceDay に書いてある
   通りで、送ってから進めると、送信は成功したのに進められなかった日に
   同じ内容が翌朝もう一度届く。逆に確保してから送信に失敗した場合は
   その日が届かないが、二度届くよりは軽い ── 失敗は push_logs に
   残るので後から追える。

   1 を 2 より先にするのは、原稿が入っていない日で確保だけ進めると、
   誰も読んでいない日が黙って消えるため。P4-c が終わるまで
   content_templates は歯抜けなので、これは今まさに起こる。

   【二重起動】
   cron の重複登録や手作業の再実行で二重に走ることがある。
   防ぐのは advanceDay の「読んだ値のままなら書き換える」で、
   負けた側は claimed=false を受け取って送らずに降りる。
   バッチ側でロックを持たない ── 持つと、落ちたときに
   ロックだけが残る。
   ================================================================== */
import { createHash } from "node:crypto";
import { getPool, closePool } from "../lib/db.mjs";
import { users, learning, pushlogs } from "../lib/repo/index.mjs";
import { pushMessage, isUnreachable } from "../lib/line.mjs";
import { jstDate, jstDateTime } from "../lib/jst.mjs";
import { renderDay, nameMissingNotice } from "../lib/render.mjs";
import { TOTAL_DAYS } from "../lib/repo/learning.mjs";

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
const PAGE  = 200;

/* 止めるときは、日を消費しない。
   .env の PUSH_DISABLED は原稿の入れ替えや障害対応のための非常停止で、
   止めているあいだに日だけ進んでいたら、直したあとに何日ぶんか
   誰も読まないまま飛んでいることになる。送信だけ止める、を
   「確保もしない」と読む。 */
const DISABLED = process.env.PUSH_DISABLED === "1";

/* 名前の登録を促す回数。3 回目からは黙る。 */
const NAME_NOTICE_MAX = 2;

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`✗ --date は YYYY-MM-DD で渡してください: ${DATE}`);
  process.exit(1);
}

/* 何時に配るかを、cron ではなくこちらで決める。
   共用サーバーの cron はサーバーの地方時で動くが、その地方時が
   何かは借りている側から確かめにくく、移設や夏時間で黙って
   ずれる。日本の 7 時に配りたいのであって、この機械の 7 時に
   配りたいのではない。
   cron は 1 時間ごとに呼び、日本の時刻はここで見る。

   「7 時ちょうどだけ」ではなく「7 時以降」にしてあるのは、
   7 時の回が落ちたときに 8 時の回が拾えるようにするため。
   二度送らないのは push_logs の sentToday が見ている。 */
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

/* LINE の重複防止キー。無作為な UUID ではなく、誰の何日目かから
   毎回同じ値になるように作る ── バッチごと掛け直したとき、
   こちら側の記録が残る前に落ちていても LINE 側で弾ける。
   形式は UUID でなければ受け取ってもらえないので、ハッシュを
   8-4-4-4-12 に切って版とバリアントのビットだけ整える。 */
export function retryKey(userId, day, type) {
  const h = createHash("sha256").update(`${userId}:${day}:${type}:${DATE}`).digest("hex");
  const b = h.slice(0, 32).split("");
  b[12] = "5";                                   /* 版 5（名前から作った） */
  b[16] = "89ab"[parseInt(b[16], 16) % 4];       /* バリアント */
  const s = b.join("");
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
}

/* ---- 1 人ぶん ------------------------------------------------------
   返すのは何をしたかの一語。数えるのは呼ぶ側の仕事にして、
   ここは「1 人について何が起きたか」だけを見る。

   send を差し替えられるようにしてあるのは、このバッチで一番
   間違えたくないのが「確保してから送る」の順番だからで、
   それは本物の LINE に送ってみても確かめられない ── 送る前に
   日が確保されているかどうかは、送る側から見えない。
   偽の send を渡して、呼ばれた時点の DB を覗く。 */
export async function deliverOne(conn, u, { send = pushMessage } = {}) {
  const today = Number(u.current_day) || 0;
  const next  = today + 1;

  /* 既に今日ぶんを送っていれば何もしない。二重起動の 1 段目。
     advanceDay だけでも防げるが、そこまで行くと送信の直前まで
     進んでしまう ── 先に分かるものは先に見る。 */
  if (await pushlogs.sentToday(conn, u.id, "learning", DATE)) return "既送";

  /* 修了。101 日を超えて進めない。
     completion の文面は P4-c で決める。ここでは進めずに数える ──
     数えていないと「終わった人がいる」ことに気づけない。 */
  if (today >= TOTAL_DAYS) return "修了済";

  /* 保有日数。体験は 3 日、購入で伸びる。切れた人は upsell の対象で、
     このバッチの担当ではない（別の便で送る）。 */
  const entitled = Number(u.total_days_entitled) || 0;
  if (next > entitled) return "日数切れ";

  /* 原稿。無ければ日を消費せずに降りる。
     status='failed' で残すのは、歯抜けに気づくのが利用者からの
     問い合わせでは遅いため。 */
  const tpl = await learning.getTemplate(conn, next);
  if (!tpl) {
    if (!DRY && !DISABLED) {
      await pushlogs.logFailed(conn, u.id,
        { dayNumber: next, pushType: "learning", error: "原稿が未入稿" });
    }
    return "原稿なし";
  }

  /* 文面を先に組む。利用者の行をそのまま渡す ── 名前も四柱も
     render 側が要るものだけ拾う。既定は入れない（全員が同じ名前・
     同じ五行で占われる）。 */
  let messages = renderDay(tpl, u);

  /* ---- 名前が要る日に、名前が無い人 -------------------------------
     はじめは「登録のお願いに差し替えて、日は進める」にしていた。
     101 日の数は保てるが、進めた日の内容は二度と届かない。
     1〜5 日目はどれも名前を使うので、サイトを通らずに友だち追加
     だけした人は、体験の 3 日間で本文を 1 度も見ないまま終わる。

     進めない。同じ日に留めて、名前が入った日にその日から始める。

     ただし毎朝お願いを送るとブロックされる。ブロックは取り消せず、
     あとで直しても届かない。2 回まで送って、あとは黙る ──
     黙っているあいだも進みは止まったままなので、名前が入れば
     翌朝そこから続く。 */
  if (messages === null) {
    const asked = await pushlogs.countForDay(conn, u.id, next, "learning");
    if (asked >= NAME_NOTICE_MAX) return "名前待ち";
    if (DRY || DISABLED) return `名前の案内:${next}日目`;

    try {
      await send(u.line_user_id, [nameMissingNotice(next)],
        { retryKey: retryKey(u.id, next, `name${asked}`) });
      /* 日は進めないので、この記録が「何回促したか」になる。 */
      await pushlogs.logSent(conn, u.id, { dayNumber: next, pushType: "learning" });
      return "名前の案内";
    } catch (e) {
      const gone = isUnreachable(e);
      if (gone) await users.markUnfollowed(conn, u.line_user_id);
      await pushlogs.logFailed(conn, u.id,
        { dayNumber: next, pushType: "learning", error: String(e.message || e).slice(0, 500) });
      return gone ? "届かない" : "送信失敗";
    }
  }

  if (DRY || DISABLED) return `${DRY ? "予定" : "停止中"}:${next}日目`;

  /* 日を確保する。負けたら送らない。 */
  const { claimed } = await learning.advanceDay(conn, u.id, today);
  if (!claimed) return "他が確保";

  try {
    await send(u.line_user_id, messages,
      { retryKey: retryKey(u.id, next, "learning") });
    await pushlogs.logSent(conn, u.id, { dayNumber: next, pushType: "learning" });
    return `送信:${next}日目`;
  } catch (e) {
    /* ブロック・退会は障害ではない。配信対象から外して、次から引かない。
       失敗として残すのは同じ ── 「その日は届いていない」は事実。 */
    const gone = isUnreachable(e);
    if (gone) await users.markUnfollowed(conn, u.line_user_id);
    await pushlogs.logFailed(conn, u.id,
      { dayNumber: next, pushType: "learning", error: String(e.message || e).slice(0, 500) });
    return gone ? "届かない" : "送信失敗";
  }
}

/* ---- 全員 --------------------------------------------------------- */
async function main() {
  const pool = await getPool();
  const tally = new Map();
  const bump = (k) => tally.set(k.replace(/:\d+日目$/, ""), (tally.get(k.replace(/:\d+日目$/, "")) || 0) + 1);

  let offset = 0, seen = 0;
  for (;;) {
    const limit = LIMIT ? Math.min(PAGE, LIMIT - seen) : PAGE;
    if (limit <= 0) break;

    const rows = await users.listDeliverable(pool, { limit, offset });
    if (!rows.length) break;

    for (const u of rows) {
      try {
        bump(await deliverOne(pool, u));
      } catch (e) {
        /* 1 人で落ちても残りは配る。ここで throw すると、
           先頭の 1 人の異常で全員が受け取れなくなる。 */
        console.error(`  ! user ${u.id}: ${e.message}`);
        bump("処理中の異常");
      }
    }
    seen += rows.length;
    offset += rows.length;
    if (rows.length < limit) break;
  }

  const label = DRY ? "（下見）" : DISABLED ? "（PUSH_DISABLED=1 で停止中）" : "";
  console.log(`\n${DATE} 朝の配信 ${label}  対象 ${seen} 人`);
  if (!tally.size) console.log("  送る相手がいません");
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }

  await closePool();
  /* 送信失敗が出た日は 0 で終わらない。cron の失敗通知に出す。 */
  const bad = (tally.get("送信失敗") || 0) + (tally.get("処理中の異常") || 0);
  if (bad) process.exitCode = 1;
}

/* 直接呼ばれたときだけ走る。検証が読み込んだだけで本番へ
   送り始める、は起こしてはいけない類い。 */
if (process.argv[1] && process.argv[1].endsWith("push-daily.mjs")) await main();
