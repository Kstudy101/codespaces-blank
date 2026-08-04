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
import { nextStep, messageForStep } from "../lib/onboarding.mjs";
import { fortuneFor } from "../lib/fortune.mjs";
import { loadLines, fortuneMessage } from "../lib/fortune-text.mjs";

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

/* オンボーディング（名前の選択・コース選択）を促す回数。
   同じ理由で上限を置く ── 答えない人へ毎朝ボタンを送ると
   ブロックされ、ブロックは取り消せない。

   黙っているあいだも日は進まないので、あとから答えれば
   その日から始まる。答える口は message.mjs にも開けてある
   （「コース」と送れば選び直しの案内が出る）── quickReply の
   ボタンは新しいメッセージが来ると押せなくなるため、
   黙ったあとに手が無くなるのを防ぐ。 */
const ONBOARD_NOTICE_MAX = 3;

/* 運勢を出せなかった理由。1 回だけ出す ── 全員ぶん出すと
   ログが人数ぶん埋まって、他の行が読めなくなる。 */
const fortuneSkips = new Set();

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

/* ---- 3 通目の運勢 ---------------------------------------------------
   レッスンの後ろに足す（plan-fortune-daily.md §5 の (가)）。
   pushMessage は配列を受けるので、3 通でも API 呼び出しは 1 回、
   通知も 1 回。

   出さない条件が 3 つある。どれも「黙って出さない」で正しい ──
   運勢はレッスンの付属で、これが無いことでレッスンが止まる方が損。

     ・生年月日が未確認   … 確かめていない値で 101 日ぶん占うと、
                            全部が別人のものになる。数字は出るので
                            受け取った側からは間違いだと分からない
     ・文面が未入稿       … 既定の一言を埋めると、全員に同じものが
                            「今日の運勢」として届く
     ・エンジンが読めない … 手元で engine/ が無いとき。本番では
                            .cpanel.yml が写す

   理由は 1 度だけログに出す。出さないと、運勢が丸ごと落ちた日に
   「元々そういうもの」と読めてしまう。 */
export function fortuneSection(u, template, { date = DATE, load = loadLines } = {}) {
  if (!u.birth_date) return null;

  if (!u.birth_confirmed) {
    if (!fortuneSkips.has("未確認")) {
      fortuneSkips.add("未確認");
      console.log("  · 生年月日が未確認の人には運勢を付けていません");
    }
    return null;
  }

  let lines;
  try {
    lines = load();
  } catch (e) {
    if (!fortuneSkips.has("文面")) {
      fortuneSkips.add("文面");
      console.error(`  ! 運勢の文面が読めません: ${e.message}`);
    }
    return null;
  }
  if (!lines) {
    if (!fortuneSkips.has("未入稿")) {
      fortuneSkips.add("未入稿");
      console.log("  · content/fortune-lines.json が無いので運勢は付きません");
    }
    return null;
  }

  let f;
  try {
    f = fortuneFor(u, date);
  } catch (e) {
    if (!fortuneSkips.has("エンジン")) {
      fortuneSkips.add("エンジン");
      console.error(`  ! 運勢エンジン: ${e.message}`);
    }
    return null;
  }
  if (!f) return null;

  return fortuneMessage(f, lines, { bridge: template ? template.fortune_bridge : null });
}


/* ---- 始める前に訊くこと --------------------------------------------
   名前とコースは、決まらないとその日の中身が作れない。

     名前 … どちらの名前で呼ぶかで会話文が変わる
     コース … 引く原稿そのものが変わる

   なので決まるまで日を進めない。生年月日の確認は止めない ──
   止まるのは運勢だけで、レッスンはそのまま送れる。

   促す回数に上限を置くのは名前案内（NAME_NOTICE_MAX）と同じ理由。
   日は進めないので、あとから答えればその日から始まる。 */
async function askOnboarding(conn, u, step, { send = pushMessage } = {}) {
  const asked = await pushlogs.countByType(conn, u.id, "onboarding");
  if (asked >= ONBOARD_NOTICE_MAX) return `${step} 待ち`;
  if (DRY || DISABLED) return `${DRY ? "予定" : "停止中"}:${step} の確認`;

  const message = messageForStep(step, u);
  if (!message) return `${step} 待ち`;

  try {
    await send(u.line_user_id, [message],
      { retryKey: retryKey(u.id, 0, `onboard${step}${asked}`) });
    await pushlogs.logSent(conn, u.id, { pushType: "onboarding" });
    return `${step} の確認`;
  } catch (e) {
    const gone = isUnreachable(e);
    if (gone) await users.markUnfollowed(conn, u.line_user_id);
    await pushlogs.logFailed(conn, u.id,
      { pushType: "onboarding", error: String(e.message || e).slice(0, 500) });
    return gone ? "届かない" : "送信失敗";
  }
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

  /* 始める前に決まっていないといけないものを訊く。
     日は進めない ── 進めると、決まる前の日が中身の無いまま
     消費される（plan-p4-content.md 7-6 と同じ間違い）。 */
  const step = nextStep(u);
  if (step === "name" || step === "track") {
    return askOnboarding(conn, u, step, { send });
  }

  /* 原稿。コースごとに別の 101 日なので、その人のコースで引く。
     無ければ日を消費せずに降りる。中級・上級はまだ入稿が済んで
     いないので、ここに来るのは今のところ普通のこと。
     status='failed' で残すのは、歯抜けに気づくのが利用者からの
     問い合わせでは遅いため。 */
  const tpl = await learning.getTemplate(conn, u.track, next);
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

  /* 3 通目の運勢。組むのは送る前 ── ここで落ちても
     レッスンは送れるようにしておく（fortuneSection は投げない）。 */
  const fortune = fortuneSection(u, tpl);
  if (fortune) messages = [...messages, fortune];

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
