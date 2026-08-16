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
import { getPool, closePool } from "../lib/db.mjs";
import { users, learning, pushlogs, entitlements, lapses, billing } from "../lib/repo/index.mjs";
import { pushMessage, isUnreachable } from "../lib/line.mjs";
import { jstDate, jstDateTime, tooEarly } from "../lib/jst.mjs";
import { makeRetryKey } from "../lib/pushkey.mjs";
import { renderDay, renderReviewQuiz, renderCheckpointQuiz, nameMissingNotice } from "../lib/render.mjs";
import { TOTAL_DAYS } from "../lib/repo/learning.mjs";
import { DELIVERY_UNLIMITED } from "../lib/repo/billing.mjs";
import { blockingStep, messageForStep } from "../lib/onboarding.mjs";
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

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`✗ --date は YYYY-MM-DD で渡してください: ${DATE}`);
  process.exit(1);
}

/* push_logs.sent_at を --date の朝に揃える。壁時計の「今」だと、
   --date=別日 で朝を連続実行したあと夕方（listReviewTargets が
   sent_at の暦日で絞る）が朝を見つけられない。accel-day と
   --date 下見の両方のため。本番 cron は DATE=今日なので 07:00 台に
   残るだけで、sentToday の半開区間には入ったまま。 */
const LOG_AT = `${DATE} 07:00:00`;

/* 何時に配るかを、cron ではなくこちらで決める。
   共用サーバーの cron はサーバーの地方時で動くが、その地方時が
   何かは借りている側から確かめにくく、移設や夏時間で黙って
   ずれる。日本の 7 時に配りたいのであって、この機械の 7 時に
   配りたいのではない。--not-before=7 がその 7 で、判定そのものは
   夕の便と同じなので lib/jst.mjs にある（写しを持たない）。
   ここから出しているのは、関門が push-daily 側から取るため。 */
export { tooEarly } from "../lib/jst.mjs";

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

/* LINE の重複防止キー。作り方は lib/pushkey.mjs にある ── 夕の便と
   同じものなので、写しを 2 本持たない。--date をここで束ねるので、
   呼び出しは今までどおり retryKey(userId, day, type) の 3 引数。 */
export const retryKey = makeRetryKey(DATE);

/* ---- 朝の便は「レッスン 1 通」だけになった（2026-08-16）-------------
   ここには運勢（3 通目）と부적（Flex）が在った。2026-08-16 の事業転換で
   両方とも廃止した ── Stripe の審査基準で占い・鑑定は扱えず、それを
   商品説明に持ったままでは決済そのものが開けない
   （docs/plan-fortune-removal.md）。

   消したのは文面だけではない。運勢は lib/fortune.mjs が node:vm で
   サイトの saju.js / fortune.js を実行して出していたので、engine の
   写し（.cpanel.yml）ごと無くなっている。

   ★ 戻さないこと。戻すなら決済を閉じる覚悟が要る。
     再発は tools/verify-no-fortune.mjs が止める。 */


/* ---- 始める前に訊くこと --------------------------------------------
   名前とコースは、決まらないとその日の中身が作れない。

     名前 … どちらの名前で呼ぶかで会話文が変わる
     コース … 引く原稿そのものが変わる

   なので決まるまで日を進めない。訊くのはこの 2 つだけ ──
   生年月日はもう訊かない（2026-08-10 に온보딩から外し、
   2026-08-16 に使い道そのものが無くなった）。

   促す回数に上限を置くのは名前案内（NAME_NOTICE_MAX）と同じ理由。
   日は進めないので、あとから答えればその日から始まる。 */
async function askOnboarding(conn, u, step, { send = pushMessage } = {}) {
  const asked = await pushlogs.countByType(conn, u.id, "onboarding");
  if (asked >= ONBOARD_NOTICE_MAX) return `${step} 待ち`;
  if (DRY || DISABLED) return `${DRY ? "予定" : "停止中"}:${step} の確認`;

  const message = await messageForStep(step, u, conn);
  if (!message) return `${step} 待ち`;

  try {
    await send(u.line_user_id, [message],
      { retryKey: retryKey(u.id, 0, `onboard${step}${asked}`) });
    await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, pushType: "onboarding" });
    return `${step} の確認`;
  } catch (e) {
    const gone = isUnreachable(e);
    if (gone) await users.markUnfollowed(conn, u.line_user_id);
    await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, pushType: "onboarding", error: String(e.message || e).slice(0, 500) });
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
/* load / amulet の差し替え口は 2026-08-16 に無くなった ── 運勢の文面
   （server/content/fortune-lines.json）も부적も廃止したため。 */
export async function deliverOne(conn, u,
  { send = pushMessage, inspect = null } = {}) {
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
      /* 절목의 재송신도 통상의 아침과 같이 데일리 ❓를 접는다（㉑）──
         절목 퀴즈 자체는 재송신에 원래 실리지 않는다（현행 유지）. */
      const atCp = await learning.isCheckpoint(conn, today);
      let messages = renderDay(tpl, u, { quizSection: !atCp });
      if (messages !== null) {
        /* 꼬리통（quickReply）은 묶음 맨 끝에서만 열린다. 예전에는
           여기서 뽑아 두고 운세·부적을 그 앞에 끼웠다 ── 둘 다
           2026-08-16 에 폐지되어, 지금 재송신은 레슨 그대로다.
           뽑았다 되돌리는 형태만 남긴다（앞으로 사이에 끼울 것이
           생겨도 꼬리통이 맨 끝이라는 불변식이 유지되도록）. */
        const quizTail = messages[messages.length - 1]?.quickReply
          ? messages.pop() : null;
        if (quizTail) messages = [...messages, quizTail];
        if (DRY || DISABLED) return `${DRY ? "予定" : "停止中"}:再送信${today}日目`;
        try {
          await send(u.line_user_id, messages,
            { retryKey: retryKey(u.id, today, "learning") });
          await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, dayNumber: today, pushType: "learning" });
          return `再送信:${today}日目`;
        } catch (e) {
          if (isUnreachable(e)) await users.markUnfollowed(conn, u.line_user_id);
          await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, dayNumber: today, pushType: "learning", error: String(e.message || e).slice(0, 500) });
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
      await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, dayNumber: TOTAL_DAYS, pushType: "completion" });
      return "修了の案内";
    } catch (e) {
      if (isUnreachable(e)) await users.markUnfollowed(conn, u.line_user_id);
      await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, dayNumber: TOTAL_DAYS, pushType: "completion", error: String(e.message || e).slice(0, 500) });
      return "送信失敗";
    }
  }

  /* ---- 残り日数 ----------------------------------------------------
     前払いの回数券（migrations/002）。買った日数（days_entitled）から
     実際に送った日数（days_used）を引く。

     ★ current_day では引かない。「1 日目からやり直す」で戻るのは
     current_day だけなので、そちらで数えるとやり直した人の残りが
     復活し、受け取ったぶんが無料になる（repo/learning.mjs）。

     ★ 2026-08-16 から DELIVERY_UNLIMITED のあいだは、ここで降りない。
     決済が開けない（Stripe 審査待ち）ので、止まった人には買う手段が
     無いため（repo/billing.mjs に理由と戻し方）。判定そのものは残す
     ── 消すと、戻す日に「どこで止めていたか」を探し直すことになる。 */
  const remaining = Number(u.days_entitled ?? 0) - Number(u.days_used ?? 0);
  if (remaining <= 0 && !DELIVERY_UNLIMITED) {
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
          await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, dayNumber: today, pushType: "upsell" });
        } catch (e) {
          if (isUnreachable(e)) await users.markUnfollowed(conn, u.line_user_id);
          await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, dayNumber: today, pushType: "upsell",
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
      await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, dayNumber: next, pushType: "learning", error: "原稿が未入稿" });
    }
    return "原稿なし";
  }

  /* 節目（30/50/75）かどうかは 1 度だけ引いて、レッスンの 꼬리통・
     復習・節目クイズの三方が同じ答えを見る ── 別々に訊くと、
     表を直した朝に片方だけずれる。renderDay より先に引くのは、
     절목·복습 아침에 데일리 ❓（무보존）를 접기 위해 ──
     그날의 채점은 절목（기록）또는 복습（무보존）이 맡는다.
     （A안 2026-08-10: 3의 배수엔 ❓ 대신 🔁 — plan-quiz-review-on-multiple） */
  const atCheckpoint = await learning.isCheckpoint(conn, next);

  /* 期限予告の朝も 꼬리통을 접는다（복습 뽑기의 결정④와 같은 이유,
     한 가지가 더 있다）: 예고（expiringNotice）는 구매 버튼의
     quickReply 를 나르고, quickReply 는 마지막 1통에서만 열린다.
     꼬리통이 말미를 차지하면 재구매 버튼이 화면에 안 나온다 ──
     퀴즈의 공백은 하루, 놓친 결제 도선은 돌아오지 않는다.
     판정을 renderDay 앞으로 옮겼을 뿐, 문면과 기록은 아래
     기존 블록 그대로다. */
  const willRemain = remaining - 1;
  const entitledNow = Number(u.days_entitled ?? 0);
  const warned = willRemain === EXPIRING_AT
      && (await billing.hasPurchases(conn, u.id))
      && !(await pushlogs.countForDay(conn, u.id, entitledNow, "expiring"));

  /* 3 の倍数（節目・予告以外）は復習の朝。デイリー ❓ を畳んで
     下の pickReviewQuiz に 1 席を空ける（クイズ 2 件禁止は維持）。 */
  const reviewMorning = next % 3 === 0 && !atCheckpoint && !warned;

  /* 文面を先に組む。利用者の行をそのまま渡す ── 名前も四柱も
     render 側が要るものだけ拾う。既定は入れない（全員が同じ名前・
     同じ五行で占われる）。 */
  let messages = renderDay(tpl, u,
    { quizSection: !atCheckpoint && !warned && !reviewMorning });

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
      await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, dayNumber: next, pushType: "learning" });
      return "名前の案内";
    } catch (e) {
      const gone = isUnreachable(e);
      if (gone) await users.markUnfollowed(conn, u.line_user_id);
      await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, dayNumber: next, pushType: "learning", error: String(e.message || e).slice(0, 500) });
      return gone ? "届かない" : "送信失敗";
    }
  }

  /* 신양식 레슨의 꼬리통（❓+🍀, quickReply）은 묶음의 맨 끝에서만
     버튼이 열린다（LINE 사양 ── 절목 퀴즈가 말미로 가는 이유와 동일）.
     여기서 뽑아 두고, 예고·복습·절목을 끼운 뒤에 다시 붙인다.
     1·2통째에는 quickReply 가 없으므로 이 판별로 충분하다.
     （운세·부적도 여기 사이에 들어갔었다 ── 2026-08-16 폐지） */
  const quizTail = messages[messages.length - 1]?.quickReply
    ? messages.pop() : null;

  /* ---- 期限の予告 ---------------------------------------------------
     今日ぶんを送ると残りが EXPIRING_AT になる、という日に 1 度だけ
     足す。別便にせず本文の後ろに付けるのは、通知をもう一度
     鳴らさないため ── pushMessage は配列を受けるので通知は 1 回。

     二度出さない仕組みに新しい表を作らない。push_logs の day_number へ
     「そのときの days_entitled」を入れておけば countForDay で判定できる。
     追加購入で days_entitled が変われば値も変わるので、次の期限は
     改めて予告される ── それが正しい動き。

     体験中（購入 0）には予告を付けない。3 日体験の頃は remaining 3→2 が
     初日に来るからだったが、7 日では 5 日目の朝に当たるので、その理由は
     もう無い（2026-08-09）。それでも付けないのは、体験の締めを
     「TRIAL_UPSELL_DAY の夕方の勧誘（trial_end）」1 回に絞るため ──
     5 日目の朝にも出すと、催促が 2 回になって鬱陶しさが増す。
     購入者の予告は現行のまま。
     판정（willRemain === EXPIRING_AT ほか）は renderDay 앞으로 옮겼다
     （꼬리통을 접기 위해 ── 위 주석）. 붙이는 위치는 여기 그대로. */
  if (warned) {
    messages = [...messages,
      expiringNotice(u.track, { remaining: EXPIRING_AT, currentDay: next })];
  }

  /* ---- 3 日周期の復習クイズ（docs/plan-quiz.md）--------------------
     reviewMorning（上）の朝だけ。current_day では数えない ──
     あれは「昨日までに送った数」で、それで割ると 1 日ずれる。

     節目（30/50/75）は休む。30 % 3 = 0 で重なるが、同じ朝に
     クイズが 2 件出ると、どの答えがどの問題か混ざる ── その朝は
     節目クイズ（下）が出る。

     신양식도 복습 아침엔 데일리 ❓를 접는다（A안）── quizTail 이
     비어 있어야 여기가 탄다. 평일 신양식은 ❓만（아래 !quizTail 은
     평일에 복습이 겹치지 않게 하는 안전망）.

     期限の予告が付く朝も休む（承認時の決定④）。朝の便を常に
     最大 4 通に保つ ── LINE の上限は 5 で、予告と重ねると丁度 5 に
     なり、次に 1 通足した日に全体が 400 で落ちる。予告は日数ごとに
     1 度だけなので、クイズの空白も 1 日で済む。

     引けなければ（原稿なし・壊れ）何も足さない。本編は届く ──
     付属のものでレッスンを止めない、という一貫した態度。 */
  if (reviewMorning && !quizTail) {
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

  /* ---- 通数の上限について（부적 폐지 후에도 남는 약속）----------------
     LINE の 1 push は 5 通まで。超えると全体が 400 で落ち、その朝は
     **何も届かない**。ここに 부적 を差し込む分岐が在ったが、
     2026-08-16 に운세・부적ごと廃止した。

     今の組み合わせ（레슨 ＋ 예고 ＋ 복습か절목 ＋ 꼬리통）では上限に
     届かない。将来ここに 1 通足すときは、**꼬리통（まだ配列の外）も
     数に入れて**数えること ── 外したまま数える癖が付くと、
     次の 1 通が 6 通目になって全部が落ちる。 */

  /* 꼬리통을 묶음 맨 끝에 되돌린다 ── quickReply 는 마지막 1통에서만
     열린다. 이 뒤로는 아무것도 더 붙이지 않을 것. */
  if (quizTail) messages = [...messages, quizTail];

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
    await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, dayNumber: next, pushType: "learning" });
    /* 予告を出したことは別に数える。learning と同じ行にすると、
       「何日目を送ったか」と「どの残り数で予告したか」が混ざる。 */
    if (warned) {
      await pushlogs.logSent(conn, u.id,
        { sentAt: LOG_AT, dayNumber: entitledNow, pushType: "expiring" });
    }
    /* 節目クイズを同封したことも別に残す（予告と同じ形）。
       読むのは P10 の集計だけだが、送った記録が learning しか無いと
       「30 日目の朝にクイズが出たか」を後から確かめる術が無い。 */
    if (checkpointQuiz) {
      await pushlogs.logSent(conn, u.id, { sentAt: LOG_AT, dayNumber: next, pushType: "quiz" });
    }
    return `送信:${next}日目`;
  } catch (e) {
    /* ブロック・退会は障害ではない。配信対象から外して、次から引かない。
       失敗として残すのは同じ ── 「その日は届いていない」は事実。 */
    const gone = isUnreachable(e);
    if (gone) await users.markUnfollowed(conn, u.line_user_id);
    await pushlogs.logFailed(conn, u.id, { sentAt: LOG_AT, dayNumber: next, pushType: "learning", error: String(e.message || e).slice(0, 500) });
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
export async function deliverNow(conn, userId, { send = pushMessage } = {}) {
  const u = await users.findDeliverable(conn, userId);
  /* ここに居ないなら、買ったのに配信の条件が揃っていない ──
     active_track が入っていないか、進みの器が無いか、status が
     trial / active でない。呼ぶ側がログに残せるように言葉で返す。 */
  if (!u) return "対象外";
  return deliverOne(conn, u, { send });
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
        /* Flex は text が無い ── altText で見せる。 */
        console.log(`  ── ${String(m.text || m.altText || m.type).split("\n")[0]}`);
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
