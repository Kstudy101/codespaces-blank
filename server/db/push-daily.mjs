/* ==================================================================
   push-daily.mjs — 朝の配信バッチ

     node db/push-daily.mjs                今日ぶんを配る
     node db/push-daily.mjs --dry-run      誰に何日目が行くかだけ出す
     node db/push-daily.mjs --date=2026-08-04   その日として動かす
     node db/push-daily.mjs --limit=10     先頭 10 人だけ
     node db/push-daily.mjs --not-before=7 日本の 7 時より前なら何もしない
     node db/push-daily.mjs --not-after=9  日本の 9 時を過ぎたら何もしない

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
import { users, learning, pushlogs, entitlements, lapses } from "../lib/repo/index.mjs";
import { pushMessage, isUnreachable } from "../lib/line.mjs";
import { jstDate, jstDateTime } from "../lib/jst.mjs";
import { renderDay, renderReviewQuiz, renderCheckpointQuiz, nameMissingNotice } from "../lib/render.mjs";
import { TOTAL_DAYS } from "../lib/repo/learning.mjs";
import { blockingStep, messageForStep } from "../lib/onboarding.mjs";
import { fortuneFor } from "../lib/fortune.mjs";
import { loadLines, fortuneMessage } from "../lib/fortune-text.mjs";
import { EXPIRING_AT, expiringNotice, completionNotice, upsellNotice } from "../lib/handlers/checkout.mjs";

/* ---- 引数 --------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY   = flag("dry-run");
const NOT_BEFORE = value("not-before", null);
const NOT_AFTER  = value("not-after", null);
const DATE  = value("date", jstDate());
const LIMIT = Number(value("limit", 0)) || 0;
const PAGE  = 200;

/* 1 人だけを相手にする（本番の実動作検証・2026-08-04 指示書）。
   これが付いているあいだ、全員のループは**一度も走らない** ──
   絞り込みではなく別の道。絞り込み（listDeliverable を引いて
   filter）にすると、フィルタの書き間違いが「全員へ送った」に
   化ける。findDeliverable で 1 人ぶんだけ引く。

   cron とはぶつからない ── 実送信すればその人の sentToday が
   立つので、次の cron はその人を「既送」で飛ばす。他の人の
   状態には触れない。 */
const ONLY_USER = Number(value("user", 0)) || 0;

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

/* 「その日の配達は何時までか」を商品として明文化する（承認 C の B）。
   再照準(A)で焼却は 0 になったが、15 時に LINE が復旧すれば 15 時に
   「朝の講座」が届く ── それを許すかは商品の性格の問題で、
   ここが上限を切る。境界は含む（--not-after=9 は 9 時台まで送る）。 */
export function tooLate(jstHour, notAfter) {
  if (notAfter === null || notAfter === undefined || notAfter === "") return false;
  const want = Number(notAfter);
  if (!Number.isInteger(want) || want < 0 || want > 23) {
    throw new Error(`--not-after は 0〜23 で渡してください: ${notAfter}`);
  }
  return Number(jstHour) > want;
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

if (NOT_AFTER !== null) {
  const hour = Number(jstDateTime().slice(11, 13));
  let late;
  try {
    late = tooLate(hour, NOT_AFTER);
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  if (late) {
    console.log(`日本時間 ${String(hour).padStart(2, "0")} 時。${NOT_AFTER} 時を過ぎたので何もしません。`);
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
export async function deliverOne(conn, u, { send = pushMessage, load = loadLines, inspect = null } = {}) {
  const today = Number(u.current_day) || 0;
  const next  = today + 1;

  /* コースが無い行は listDeliverable から出て来ない（active_track で
     JOIN しているため）。それでも先に見るのは、来てしまったときに
     ここで例外にしないため ── getTemplate は未知の track で throw し、
     main() の try/catch が「処理中の異常」に数える。cron は毎朝
     失敗で終わるのに、本人には何も届かない。数えて降りるほうがよい。 */
  if (!u.track) return "コース未選択";

  /* 既に今日ぶんを送っていれば何もしない。二重起動の 1 段目。
     advanceDay だけでも防げるが、そこまで行くと送信の直前まで
     進んでしまう ── 先に分かるものは先に見る。 */
  if (await pushlogs.sentToday(conn, u.id, "learning", DATE)) return "既送";

  /* ---- 落ちた日の再照準（plan-outage-billing §1-2 A・承認 C）--------
     LINE 障害の朝はこうなっていた:
       07:00 day N 確保（＝消費）→ 500 → failed   ← N 日目が焼却
       08:00 sentToday=false → day N+1 確保 → 失敗 ← 毎時 1 日ずつ
     確保（消費）済みの current_day = N がまだ届いていなければ、
     **新しく確保せず** N 日目を組み直して送る。

     「送信の前に日を確保する」の前提は崩さない ── ここが扱うのは
     既に確保が済んだ日で、確保なしの送信ではなく送信なしの確保の
     回収。advanceDay は呼ばない（関門が見張る）。

     同じ暦日内の再送は retryKey が失敗時と同一なので、「実際は
     届いたのに logSent 前に死んだ」場合も LINE 側の重複排除が防ぐ。
     ※ LINE の X-Line-Retry-Key の保存期間は公式に明記が無い ──
     日を跨いだ再送だけキーが変わるが、その窓は従来の設計にも
     同じ形で在ったもの。

     原稿なしの failed とは混ざらない ── あちらは dayNumber = next
     （確保**前**の日付）で残り、こちらの条件は current_day（確保済み）。 */
  if (today >= 1
      && !(await pushlogs.everSent(conn, u.id, "learning", today))
      &&  (await pushlogs.everFailed(conn, u.id, "learning", today))) {
    const tpl = await learning.getTemplate(conn, u.track, today);
    if (tpl) {
      let messages = renderDay(tpl, u);
      if (messages !== null) {
        const fortune = fortuneSection(u, tpl, { load });
        if (fortune) messages = [...messages, fortune];
        if (DRY || DISABLED) return `${DRY ? "予定" : "停止中"}:再送信${today}日目`;
        try {
          await send(u.line_user_id, messages,
            { retryKey: retryKey(u.id, today, "learning") });
          await pushlogs.logSent(conn, u.id, { dayNumber: today, pushType: "learning" });
          return `再送信:${today}日目`;
        } catch (e) {
          if (isUnreachable(e)) await users.markUnfollowed(conn, u.line_user_id);
          await pushlogs.logFailed(conn, u.id,
            { dayNumber: today, pushType: "learning", error: String(e.message || e).slice(0, 500) });
          return "送信失敗";
        }
      }
    }
    /* 原稿が引けない・名前が無い ── 再照準はできないが、通常経路に
       落とすと次の日を確保してしまう。ここで降りて次の便を待つ。 */
    return `再送信待ち:${today}日目`;
  }

  /* ---- 修了 --------------------------------------------------------
     101 日を超えて進めない。ここが最後の接点で、次のコースを
     勧める唯一の場所でもある ── 今まで何も送っていなかったので、
     101 日目の翌朝から、ただ静かに何も来なくなっていた。

     1 度だけ送る。日は進めないので、送ったかどうかは push_logs の
     completion で数える。 */
  if (today >= TOTAL_DAYS) {
    if (await pushlogs.countByType(conn, u.id, "completion")) return "修了済";
    if (DRY || DISABLED) return "予定:修了";
    try {
      const owned = (await entitlements.listByUser(conn, u.id)).map((e) => e.track);
      await send(u.line_user_id, [completionNotice(u.track, { owned })],
        { retryKey: retryKey(u.id, TOTAL_DAYS, "completion") });
      await pushlogs.logSent(conn, u.id, { dayNumber: TOTAL_DAYS, pushType: "completion" });
      return "修了の案内";
    } catch (e) {
      if (isUnreachable(e)) await users.markUnfollowed(conn, u.line_user_id);
      await pushlogs.logFailed(conn, u.id,
        { dayNumber: TOTAL_DAYS, pushType: "completion", error: String(e.message || e).slice(0, 500) });
      return "送信失敗";
    }
  }

  /* ---- 残り日数 ----------------------------------------------------
     前払いの回数券（migrations/002）。買った日数（days_entitled）から
     実際に送った日数（days_used）を引く。

     ★ current_day では引かない。「1 日目からやり直す」で戻るのは
     current_day だけなので、そちらで数えるとやり直した人の残りが
     復活し、受け取ったぶんが無料になる（repo/learning.mjs）。 */
  const remaining = Number(u.days_entitled ?? 0) - Number(u.days_used ?? 0);
  if (remaining <= 0) {
    /* 切れたことを 1 度だけ台帳に残す。開いている行があれば書かない
       ので、切れているあいだ毎朝増えることはない（repo/lapses.mjs）。

       再購入のご案内も**台帳が新しく開いた回だけ**（指示書 §3）──
       残り 0 には毎朝の判定で毎日出会うので、created に載せないと
       毎日スパムになる。日数は消費しない（この分岐は advanceDay の
       ずっと手前）。送信の失敗で台帳は巻き戻さない ── 案内は 1 回
       きりの約束のほうが重い。 */
    if (!DRY && !DISABLED) {
      const opened = await lapses.openIfAbsent(conn, u.id, u.track,
        { lastDay: today, daysBought: Number(u.days_entitled ?? 0) });
      if (opened.created) {
        try {
          await send(u.line_user_id, [upsellNotice(u.track, { lastDay: today })],
            { retryKey: retryKey(u.id, today, "upsell") });
          await pushlogs.logSent(conn, u.id, { dayNumber: today, pushType: "upsell" });
        } catch (e) {
          if (isUnreachable(e)) await users.markUnfollowed(conn, u.line_user_id);
          await pushlogs.logFailed(conn, u.id, { dayNumber: today, pushType: "upsell",
            error: String(e.message || e).slice(0, 500) });
        }
      }
    }
    return "日数切れ";
  }

  /* 始める前に決まっていないといけないものを訊く。
     日は進めない ── 進めると、決まる前の日が中身の無いまま
     消費される（plan-p4-content.md 7-6 と同じ間違い）。

     見るのは nextStep ではなく blockingStep。nextStep は次に訊くこと
     1 つを順番どおりに返すので、生年月日を飛ばした人には "birth" が
     返り、コースが空のままここを素通りしていた（lib/onboarding.mjs）。 */
  const step = blockingStep(u);
  if (step) {
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
     レッスンは送れるようにしておく（fortuneSection は投げない）。

     load を差し替えられるようにしてあるのは、文面が
     server/content/ にあり、公開リポジトリには無いため。
     既定のまま検査すると、手元（文面あり）では 3 通、CI（文面なし）
     では 2 通になり、通る場所と通らない場所が生まれる。
     実際そうなって CI だけが落ちた。 */
  const fortune = fortuneSection(u, tpl, { load });
  if (fortune) messages = [...messages, fortune];

  /* ---- 期限の予告 ---------------------------------------------------
     今日ぶんを送ると残りが EXPIRING_AT になる、という日に 1 度だけ
     足す。別便にせず本文の後ろに付けるのは、通知をもう一度
     鳴らさないため ── pushMessage は配列を受けるので通知は 1 回。

     二度出さない仕組みに新しい表を作らない。push_logs の day_number へ
     「そのときの days_entitled」を入れておけば countForDay で判定できる。
     追加購入で days_entitled が変われば値も変わるので、次の期限は
     改めて予告される ── それが正しい動き。 */
  const willRemain = remaining - 1;
  const entitledNow = Number(u.days_entitled ?? 0);
  let warned = false;
  if (willRemain === EXPIRING_AT
      && !(await pushlogs.countForDay(conn, u.id, entitledNow, "expiring"))) {
    messages = [...messages,
      expiringNotice(u.track, { remaining: EXPIRING_AT, currentDay: next })];
    warned = true;
  }

  /* 節目（30/50/75）かどうかは 1 度だけ引いて、復習と節目の両方が
     同じ答えを見る ── 別々に訊くと、表を直した朝に片方だけずれる。 */
  const atCheckpoint = await learning.isCheckpoint(conn, next);

  /* ---- 3 日周期の復習クイズ（docs/plan-quiz.md）--------------------
     送る日（next）が 3 の倍数の朝だけ。current_day では数えない ──
     あれは「昨日までに送った数」で、それで割ると 1 日ずれる。

     節目（30/50/75）は休む。30 % 3 = 0 で重なるが、同じ朝に
     クイズが 2 件出ると、どの答えがどの問題か混ざる ── その朝は
     節目クイズ（下）が出る。

     期限の予告が付く朝も休む（承認時の決定④）。朝の便を常に
     最大 4 通に保つ ── LINE の上限は 5 で、予告と重ねると丁度 5 に
     なり、次に 1 通足した日に全体が 400 で落ちる。予告は日数ごとに
     1 度だけなので、クイズの空白も 1 日で済む。

     引けなければ（原稿なし・壊れ）何も足さない。本編は届く ──
     運勢（fortuneSection）と同じ態度。 */
  if (next % 3 === 0 && !warned && !atCheckpoint) {
    const quiz = await learning.pickReviewQuiz(conn, u.track, next);
    if (quiz) messages = [...messages, renderReviewQuiz(quiz)];
  }

  /* ---- 節目クイズ（30/50/75、docs/plan-quiz-checkpoint.md）---------
     本編の後ろに 1 通。原稿はその朝の tpl.quiz そのもの ── 追加の
     問い合わせは無い。無ければ・壊れていれば黙って抜く（復習と
     同じ態度で、30/50/75 日目の quiz が入稿されるまではこれが普通）。

     期限の予告と重なる朝は 5 通になるが、そのまま送る（承認時の
     決定 §4(가)：予告は残り日数ごとに 1 度、節目は学期に 1 度なので
     重なりは稀で、LINE の上限 5 は超えない）。

     必ず配列の末尾に置く。quickReply が開くのは最後の 1 通だけ ──
     予告の後ろに来ないと、答えのボタンが画面に出ない。 */
  let checkpointQuiz = false;
  if (atCheckpoint) {
    const q = learning.usableQuiz(tpl.quiz);
    if (q) {
      messages = [...messages, renderCheckpointQuiz(next, q)];
      checkpointQuiz = true;
    }
  }

  /* 下見でも、組み上がった文面は見せられるようにする（--user の
     実動作検証で「どのクイズが選ばれたか」を送らずに確かめる）。
     stdout の検収であって応答の記録ではない ── 無保存(B)にはかからない。 */
  if (inspect) inspect(messages, next);

  if (DRY || DISABLED) return `${DRY ? "予定" : "停止中"}:${next}日目`;

  /* 日を確保する。負けたら送らない。
     days_used もこの 1 文で増える ── 別の文にすると、確保したのに
     使った日数が増えていない瞬間ができ、そこで落ちると 1 日ぶんが
     無料になる（repo/learning.mjs）。 */
  const { claimed } = await learning.advanceDay(conn, u.id, u.track, today);
  if (!claimed) return "他が確保";

  try {
    await send(u.line_user_id, messages,
      { retryKey: retryKey(u.id, next, "learning") });
    await pushlogs.logSent(conn, u.id, { dayNumber: next, pushType: "learning" });
    /* 予告を出したことは別に数える。learning と同じ行にすると、
       「何日目を送ったか」と「どの残り数で予告したか」が混ざる。 */
    if (warned) {
      await pushlogs.logSent(conn, u.id,
        { dayNumber: entitledNow, pushType: "expiring" });
    }
    /* 節目クイズを同封したことも別に残す（予告と同じ形）。
       読むのは P10 の集計だけだが、送った記録が learning しか無いと
       「30 日目の朝にクイズが出たか」を後から確かめる術が無い。 */
    if (checkpointQuiz) {
      await pushlogs.logSent(conn, u.id, { dayNumber: next, pushType: "quiz" });
    }
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

/* ---- 1 人だけ、いますぐ ---------------------------------------------
   決済が終わった直後に呼ばれる（lib/handlers/checkout.mjs）。
   時刻に関係なく 1 日目を送るための入口で、cron とは別の道。

   【二重に送らない仕組みを新しく作らない】
   deliverOne の先頭に sentToday があるので、今日ぶんを既に受け取って
   いる人はそこで "既送" になる。だから:

     22:00 決済 → ここで 1 日目 + push_logs(learning, 今日)
     翌 07:00  → sentToday=true → "既送"
     翌々 07:00 → 2 日目

   追加購入で、その日の分をもう受け取っている人はここで "既送" が
   返る。1 日に 2 回レッスンは元から無いので、それでよい ──
   呼ぶ側が「明日の朝から続きます」と伝える。

   listDeliverable と同じ形の行が要る。1 人ぶんだけ引き直す
   （findDeliverable。一覧を引いて絞ると 501 人目から見つからない）。 */
export async function deliverNow(conn, userId, { send = pushMessage, load = loadLines } = {}) {
  const u = await users.findDeliverable(conn, userId);
  /* ここに居ないなら、買ったのに配信の条件が揃っていない ──
     active_track が入っていないか、進みの器が無いか、status が
     trial / active でない。呼ぶ側がログに残せるように言葉で返す。 */
  if (!u) return "対象外";
  return deliverOne(conn, u, { send, load });
}

/* ---- 全員 --------------------------------------------------------- */
async function main() {
  const pool = await getPool();
  const tally = new Map();
  const bump = (k) => tally.set(k.replace(/:\d+日目$/, ""), (tally.get(k.replace(/:\d+日目$/, "")) || 0) + 1);

  /* ---- --user: 1 人だけの別の道 ------------------------------------
     全員のループには入らない。下見（--dry-run）なら文面も並べる ──
     「どのクイズが選ばれたか」を、誰にも送らずに目で確かめるため。 */
  if (ONLY_USER) {
    console.log(`★ --user=${ONLY_USER} ── この 1 人だけ。全員のループは走りません`);
    const u = await users.findDeliverable(pool, ONLY_USER);
    if (!u) {
      console.log("  対象外です（active_track / 進みの器 / status を確認）");
      await closePool();
      return;
    }
    const inspect = (messages, next) => {
      console.log(`  ${next} 日目として組んだ ${messages.length} 通:`);
      for (const m of messages) {
        console.log(`  ── ${m.text.split("\n")[0]}`);
        for (const item of m.quickReply?.items ?? []) {
          console.log(`       [${item.action.label}] data=${item.action.data}`);
        }
      }
    };
    const r = await deliverOne(pool, u, { inspect });
    console.log(`  結果: ${r}`);
    await closePool();
    return;
  }

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
