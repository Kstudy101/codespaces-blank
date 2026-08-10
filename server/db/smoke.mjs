#!/usr/bin/env node
/* ==================================================================
   smoke.mjs — 本物の MySQL に対して repo/ を一通り動かす

     node server/db/smoke.mjs

   tools/verify-server.mjs は偽の接続を渡して「どんな SQL を投げるか」を
   見る。install も DB も要らない代わりに、その SQL が本当に通るか、
   ドライバと MySQL が想定どおりの値を返すかまでは分からない。

   ここが確かめるのはそちら。実際、最初にこれを流して 2 つ見つかった:

     ・ON DUPLICATE KEY UPDATE の affectedRows で「新規か重複か」を
       見分けていたが、mysql2 は CLIENT_FOUND_ROWS を既定で立てるため
       どちらも 1 が返っていた ── 決済の再送で保有日数が二度足される
     ・SELECT の式の先頭に置いた ? を MySQL が 1064 で撥ねる

   どちらも偽の接続では出ない。置いたサーバーの上で一度流しておく。

   本番の DB に対して流しても安全。触るのは専用の試験アカウント
   1 件だけで、始めと終わりに消す。
   ================================================================== */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../lib/db.mjs";
import { users, billing, learning, pushlogs, entitlements } from "../lib/repo/index.mjs";
import { jstDate } from "../lib/jst.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TEST_LINE_ID = "U_smoke_test_kstudy101";

/* ---- 原稿の試験に使う 1 行 ------------------------------------------
   原稿の主キーは (track, day_number)。migrations/001 が day_number 単独から
   変えたので、消すときも両方で絞る。day_number だけで消すと、1 行しか
   入れていないのに 3 コースぶんの 101 日目が消える。

   101 日目は講座の最後の日なので、消えるとその人はそこで永久に止まる ──
   push-daily は「原稿なし」で日を消費せずに降りるため、翌朝も翌々朝も
   同じ所で止まったままになる。送信失敗のログは残るが、止まっているのは
   買った人の最終日で、しかも「何も届かない」としか見えない。

   さらに、入稿済みの日には最初から触らない（下の templatesOwned）。
   .cpanel.yml は smoke を「本番でも流せる」として seed の**後ろ**に
   置いている。その保証を実際に守るには、他人の原稿を消さないことまで要る。

   前回の smoke が途中で死んで残した行は、こちらのもの。grammar_point が
   決め打ちなので、それで自分の残骸かどうかを見分ける ── 見分けずに
   「行があれば飛ばす」にすると、一度落ちたあとは永久に飛ばし続ける。 */
const TEST_TRACK   = "intermediate";
const TEST_DAY     = 101;
const TEST_GRAMMAR = "-습니다 / -습니까?";

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);

/* migrate.mjs を別プロセスで 1 回流し、終了コードと出力を返す。
   関数として読み込まないのは、あちらが process.exit で終わるため ──
   import すると smoke ごと落ちる。環境変数はそのまま引き継ぐので、
   db/with-env.mjs 経由で走らせたときは子も同じ設定で繋ぐ。 */
function runMigrate() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, "migrate.mjs")],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ code: -1, out: `${out}\n${e.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const tail = (s, n = 12) => s.trimEnd().split("\n").slice(-n).map((l) => `      ${l}`).join("\n");

const pool = await getPool();

/* 原稿を触ってよいかは、最初の cleanup より**前**に決める。
   あとで見ても、その cleanup が既に消してしまっている。 */
const existingTemplate = await learning.getTemplate(pool, TEST_TRACK, TEST_DAY);
const templatesOwned =
  existingTemplate === null || existingTemplate.grammar_point === TEST_GRAMMAR;

async function cleanup() {
  const u = await users.findByLineUserId(pool, TEST_LINE_ID);
  if (u) await users.deleteUser(pool, u.id);
  /* 入稿済みの原稿には触らない。track と day_number の両方で絞るのは、
     day_number だけだと 3 コースぶんが消えるため。 */
  if (templatesOwned) {
    await pool.execute(
      "DELETE FROM content_templates WHERE track = ? AND day_number = ?",
      [TEST_TRACK, TEST_DAY]);
  }
}

await cleanup();

try {
  /* ---- migrate の再実行 ---------------------------------------------
     配置は毎回 migrate を流す。だから「2 回目が通るか」は、
     この仕組みで一番よく踏まれる道そのものになる。

     一度そこで止まった: 002 の INSERT ... SELECT が、同じ 002 の
     最後で落とされる列を読むため、2 周目に errno 1054 で throw →
     exit(1) → .cpanel.yml の set -e で配置ごと停止。以降の
     migration は永久に流れない。

     この欠陥は DB が要る ── 偽の接続では「どんな SQL を投げるか」
     までしか分からず、その SQL が 2 周目に通るかは分からない。
     だから静的な関門 19 種では捕まえられず、ここに置く。

     本番でも安全。流すのは配置と同じ migrate で、履歴が在れば
     1 文も実行しない。 */
  head("[migrate]  2 回続けて流しても止まらない ← 配置が止まっていた所");

  const m1 = await runMigrate();
  const m2 = await runMigrate();

  check("1 回目が exit 0", () => {
    assert(m1.code === 0, `exit ${m1.code}\n${tail(m1.out)}`);
    return "0";
  });
  check("2 回目も exit 0（履歴があるので流し直さない）", () => {
    assert(m2.code === 0,
      `exit ${m2.code}。配置はここで止まります\n${tail(m2.out)}`);
    return "0";
  });
  check("2 回目は migrations を 1 文も流さない", () => {
    /* 「通った」だけでは足りない。飲み込む errno を増やして通した
       場合も 0 で終わるので、流していないこと自体を見る。 */
    assert(/適用済み。流しません/.test(m2.out),
      `履歴で飛ばしていません\n${tail(m2.out)}`);
    assert(!/文を適用/.test(m2.out.split("migrations/:")[1] || ""),
      `2 周目に SQL を流しています\n${tail(m2.out)}`);
    return "全ファイルを履歴で飛ばす";
  });

  /* ---- 友だち追加 -------------------------------------------------- */
  head("[友だち追加]");

  const first = await users.upsertOnFollow(pool, {
    lineUserId: TEST_LINE_ID, displayName: "たなか"
  });
  const uid = first.user.id;
  check("新規は created=true", () => {
    assert(first.created === true, "false でした");
    return `user_id=${uid}`;
  });

  await users.setStatus(pool, uid, "active");
  const again = await users.upsertOnFollow(pool, { lineUserId: TEST_LINE_ID });
  check("再追加で created=false、status も落ちない", () => {
    assert(again.created === false, "2 件目が入りました（UNIQUE が効いていません）");
    assert(again.user.status === "active",
      `status が ${again.user.status} に戻りました。払った人が体験に落ちます`);
    assert(again.user.display_name === "たなか",
      `表示名が ${again.user.display_name} になりました`);
    return "active のまま / 表示名も残る";
  });

  /* ---- 文字化け ---------------------------------------------------- */
  head("[utf8mb4]  日本語・韓国語・絵文字が往復するか");

  await users.updateName(pool, uid, {
    nameKanji: "武田 花子", nameReading: "タケダ ハナコ", nameKr: "다케다 하나코"
  });
  await users.upsertSajuProfile(pool, uid, {
    birthDate: "1995-04-12", birthTime: "09:30:00", gender: "F", ohaengMain: "목",
    rawResult: { pillars: ["을해", "경진", "정묘", "을사"], note: "🌸 테스트" }
  });
  const saju = await users.getSajuProfile(pool, uid);
  const named = await users.findById(pool, uid);
  check("漢字・カナ・ハングルがそのまま戻る", () => {
    assert(named.name_kanji === "武田 花子", named.name_kanji);
    assert(named.name_kr === "다케다 하나코", named.name_kr);
    assert(saju.ohaeng_main === "목", saju.ohaeng_main);
    return `${named.name_kanji} / ${named.name_kr} / ${saju.ohaeng_main}`;
  });
  check("JSON 列と絵文字も往復する", () => {
    assert(saju.raw_result_json.pillars[0] === "을해", JSON.stringify(saju.raw_result_json));
    assert(saju.raw_result_json.note === "🌸 테스트",
      `絵文字が壊れました: ${saju.raw_result_json.note}（utf8mb4 でないと 4 バイト文字が落ちます）`);
    return "配列 / 絵文字";
  });
  check("日付・時刻が文字列で返る（Date に化けない）", () => {
    assert(saju.birth_date === "1995-04-12", `${typeof saju.birth_date}: ${saju.birth_date}`);
    assert(saju.birth_time === "09:30:00", saju.birth_time);
    return "1995-04-12 09:30:00";
  });

  /* ---- 体験と購入 -------------------------------------------------- */
  head("[金額]  再送で保有日数を二度足さない ── MySQL の返し方に依存する所");

  const T = "beginner";

  const t1 = await billing.startTrial(pool, uid, T, jstDate());
  const e1 = await entitlements.get(pool, uid, T);
  check(`体験は ${billing.TRIAL_DAYS} 日。コースを選んでから始まる`, () => {
    assert(t1.created === true, "既にありました");
    assert(e1 && e1.daysEntitled === billing.TRIAL_DAYS, `${e1 && e1.daysEntitled} 日`);
    return `beginner ${billing.TRIAL_DAYS} 日`;
  });

  /* ---- 体験日数を行が持つ（migrations/007）--------------------------
     関門はソースしか読めない。列が本当にあるか・EXPECTED の SQL が
     MySQL で通るかは、本物に流さないと分からない ── ここが 007 の
     唯一の実証。drift が 0 でないなら、体験ぶんが二重に乗っているか
     まったく乗っていないかのどちらか。 */
  const s1 = await billing.getSubscription(pool, uid);
  const d0 = await billing.recountEntitledDays(pool, uid, T);
  check("体験を使った行は trial_days を持ち、drift が 0", () => {
    assert(Number(s1.trial_days) === billing.TRIAL_DAYS,
      `trial_days = ${s1.trial_days}（TRIAL_DAYS は ${billing.TRIAL_DAYS}）`);
    assert(d0.drift === 0, `${d0.stored} と ${d0.expected} がずれています`);
    return `trial_days ${s1.trial_days} / drift 0`;
  });

  /* コースを変えても 2 度目は通らない。通ると 3 コース ×7 日 = 21 日を
     無料で受け取れる。一意キーは subscriptions.user_id 1 本なので、
     1062 は「もう体験を使った」だけを意味すると確定できる。 */
  const t2 = await billing.startTrial(pool, uid, "intermediate");
  const e2 = await entitlements.get(pool, uid, "intermediate");
  check("体験は 1 アカウント 1 回（コースを変えても増えない）", () => {
    assert(t2.created === false, "2 度目が通りました");
    assert(e2 === null, `中級にも ${e2 && e2.daysEntitled} 日積みました`);
    return "1 回だけ";
  });

  const p1 = await billing.creditPurchase(pool, uid, T, "28days", { paymentRef: "pi_smoke_1" });
  check("初回の決済で +30 日", () => {
    assert(p1.created === true, "created=false でした");
    assert(p1.daysGranted === 30, `${p1.daysGranted} 日`);
    assert(p1.entitlement.daysEntitled === billing.TRIAL_DAYS + 30,
      `${p1.entitlement.daysEntitled} 日（${billing.TRIAL_DAYS}+30=${billing.TRIAL_DAYS + 30} のはず）`);
    return `${billing.TRIAL_DAYS + 30} 日`;
  });

  const p2 = await billing.creditPurchase(pool, uid, T, "28days", { paymentRef: "pi_smoke_1" });
  const e3 = await entitlements.get(pool, uid, T);
  check("同じ取引 ID の再送は加算しない ← ここが本番で効く", () => {
    assert(p2.created === false,
      "created=true でした。一意制約違反（1062）を捕まえられていません");
    assert(p2.daysGranted === 0, `${p2.daysGranted} 日足しました`);
    assert(e3.daysEntitled === billing.TRIAL_DAYS + 30,
      `${e3.daysEntitled} 日に増えました。決済 1 件で二重に付与されています`);
    return `${billing.TRIAL_DAYS + 30} 日のまま`;
  });

  const p3 = await billing.creditPurchase(pool, uid, T, "7days", { paymentRef: "pi_smoke_2" });
  check("別の取引 ID なら積み上がる", () => {
    assert(p3.created === true, "created=false でした");
    assert(p3.entitlement.daysEntitled === billing.TRIAL_DAYS + 37,
      `${p3.entitlement.daysEntitled} 日（${billing.TRIAL_DAYS + 30}+7=${billing.TRIAL_DAYS + 37} のはず）`);
    return `${billing.TRIAL_DAYS + 37} 日`;
  });

  const purchases = await billing.listPurchases(pool, uid);
  check("台帳は 2 件（再送のぶんは増えない）", () => {
    assert(purchases.length === 2, `${purchases.length} 件`);
    assert(purchases.every((x) => x.track === T), "コースが記録されていません");
    return purchases.map((p) => p.package_type).join(" + ");
  });

  const drift = await billing.recountEntitledDays(pool, uid, T);
  check("保有日数と台帳が一致する", () => {
    assert(drift.drift === 0, `${drift.stored} と ${drift.expected} がずれています`);
    return `${drift.stored} 日`;
  });

  /* ---- 進み -------------------------------------------------------- */
  head("[進み]  二重起動しても同じ日を二度送らない");

  await learning.ensureProgress(pool, uid, T);
  /* 実物の体験開始（handlers/checkout.mjs applyTrial）は ensureProgress の
     直後に active_track を入れる。ここが抜けていると、あとの
     listReviewTargets（active_track で JOIN）に**誰も入らない** ──
     この 1 行が無かったあいだ、夕方の検査は通りようが無かった。 */
  await users.setActiveTrack(pool, uid, T);
  const a1 = await learning.advanceDay(pool, uid, T, 0);
  check("0 → 1 日目を取れる", () => {
    assert(a1.claimed === true && a1.day === 1, JSON.stringify(a1));
    return "claimed";
  });

  const a2 = await learning.advanceDay(pool, uid, T, 0);
  check("同じ値で二度目は取れない ← 二重起動の防ぎ方そのもの", () => {
    assert(a2.claimed === false,
      "二度目も通りました。バッチが重なると同じ日が二度届き、次の日が飛びます");
    return "claimed=false";
  });

  const prog = await learning.getProgress(pool, uid, T);
  check("進みは 1 日ぶんだけ動いた", () => {
    assert(prog.current_day === 1, `${prog.current_day} 日目`);
    assert(prog.last_sent_at && prog.last_sent_at.startsWith(jstDate()),
      `last_sent_at が ${prog.last_sent_at}（今日の JST で入るはず）`);
    return `current_day=1 / ${prog.last_sent_at}`;
  });

  await learning.setQuizResult(pool, uid, T, 1, true);
  await learning.setQuizResult(pool, uid, T, 2, false);
  const q = await learning.getProgress(pool, uid, T);
  check("学期ごとに積める。合否は boolean で入る（前の結果を消さない）", () => {
    assert(q.quiz_pass_log.semester1 === true,
      `${JSON.stringify(q.quiz_pass_log)} ── 1/0 なら JSON の boolean になっていません`);
    assert(q.quiz_pass_log.semester2 === false, JSON.stringify(q.quiz_pass_log));
    assert(q.current_day === 1, `クイズで current_day が ${q.current_day} に動きました`);
    return JSON.stringify(q.quiz_pass_log);
  });

  /* ---- 配信ログ ---------------------------------------------------- */
  head("[配信ログ]  今日もう送ったか / 夕方の対象");

  const before = await pushlogs.sentToday(pool, uid, "learning");
  check("送る前は「今日は未送信」", () => {
    assert(before === false, "送っていないのに true でした");
    return "false";
  });

  await pushlogs.logSent(pool, uid, { dayNumber: 1, pushType: "learning" });
  const after = await pushlogs.sentToday(pool, uid, "learning");
  const otherType = await pushlogs.sentToday(pool, uid, "review");
  check("送った後は true。種類が違えば false", () => {
    assert(after === true, "記録したのに false でした（JST の境目がずれています）");
    assert(otherType === false, "review まで送信済みになりました");
    return "learning=true / review=false";
  });

  await pushlogs.logFailed(pool, uid, { dayNumber: 1, pushType: "quiz", error: new Error("429 rate limit") });
  const quizSent = await pushlogs.sentToday(pool, uid, "quiz");
  check("失敗は「送った」に数えない", () => {
    assert(quizSent === false, "失敗した配信が送信済みになりました");
    return "false";
  });

  const day = await pushlogs.todaysLearningDay(pool, uid);
  check("今朝どの日を送ったかを引ける（夕方の復習が使う）", () => {
    assert(day === 1, `${day} が返りました`);
    return "1 日目";
  });

  const targets = await pushlogs.listReviewTargets(pool);
  check("夕方の対象に入っている", () => {
    /* 列名は listDeliverable と揃えて id。復習も朝と同じ renderer に
       通すので、片方だけ違う名前だと呼ぶ側で取り違える。 */
    const me = targets.find((t) => Number(t.id) === uid);
    assert(me, `対象 ${targets.length} 件の中にいません`);
    assert(Number(me.day_number) === 1, `day_number=${me.day_number}`);
    assert(me.name_kr === "다케다 하나코", me.name_kr);
    /* renderReview が要る列。抜けていると夕方だけ名前が入らない。 */
    assert(me.name_reading !== undefined, "name_reading が取れていません");
    assert("track" in me, "track が取れていません（コース別の原稿を引けません）");
    return `${targets.length} 件中に自分あり`;
  });

  /* ---- 原稿 -------------------------------------------------------- */
  head("[原稿]");

  if (!templatesOwned) {
    /* 入稿済みの日を試験で上書きしない。ここを飛ばしても、同じ経路は
       配置のたびに seed-content.mjs が実物で通っている。 */
    console.log(`  · ${TEST_TRACK} の ${TEST_DAY} 日目に入稿済みの原稿があるため、`
      + "この節は飛ばします（上書きも削除もしません）");
  } else {
    await learning.upsertTemplate(pool, {
      track: TEST_TRACK,
      dayNumber: TEST_DAY,
      grammarPoint: TEST_GRAMMAR,
      grammarTipKr: "정중한 종결어미입니다。ていねいな文末。",
      dialogueTemplate: [{ kr: "{NAME}입니다.", ja: "{NAME_JP}です。" }],
      vocab3: [{ kr: "사랑", meaning: "愛" }, { kr: "하늘", meaning: "空" }, { kr: "바다", meaning: "海" }],
      requiresNameSlot: true
    });
    const tpl = await learning.getTemplate(pool, TEST_TRACK, TEST_DAY);
    check("原稿が往復する。学期は day_number から決まる", () => {
      assert(tpl.semester === 4, `${TEST_DAY} 日目が ${tpl.semester} 学期になりました`);
      assert(tpl.track === TEST_TRACK, `track=${tpl.track}`);
      assert(tpl.requires_name_slot === true, `${typeof tpl.requires_name_slot}`);
      assert(tpl.dialogue_template[0].kr === "{NAME}입니다.", JSON.stringify(tpl.dialogue_template));
      assert(tpl.vocab_3.length === 3, JSON.stringify(tpl.vocab_3));
      return "中級 / 4 学期 / 名前スロットあり / 単語 3 語";
    });

    /* コースは 3 本の別の 101 日。同じ日番号でも別の行になる。
       ここが 1 行に潰れると、中級を選んだ人に初級が届く。 */
    const beginnerSame = await learning.getTemplate(pool, "beginner", TEST_DAY);
    check("同じ日番号でも、コースが違えば別の原稿", () => {
      assert(beginnerSame === null || beginnerSame.track === "beginner",
        `beginner で引いたのに track=${beginnerSame && beginnerSame.track}`);
      return beginnerSame ? "初級にも入稿あり（別行）" : "初級は未入稿（別行として空）";
    });

    const missing = await learning.findMissingTemplateDays(pool);
    check("欠けている日をコース別に数えられる", () => {
      assert(!missing[TEST_TRACK].includes(TEST_DAY),
        `${TEST_DAY} が ${TEST_TRACK} で欠けている扱いです`);
      assert(Array.isArray(missing.beginner) && Array.isArray(missing.advanced),
        "コース別になっていません");
      return learning.TRACKS.map((t) => `${t} 残り${missing[t].length}`).join(" / ");
    });
  }

  /* ---- 退会 -------------------------------------------------------- */
  head("[退会]  外部キーで一緒に消えるか ── privacy の約束になる所");

  const [[b]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM saju_profiles     WHERE user_id=${uid}) s,
            (SELECT COUNT(*) FROM purchases         WHERE user_id=${uid}) p,
            (SELECT COUNT(*) FROM subscriptions     WHERE user_id=${uid}) b,
            (SELECT COUNT(*) FROM learning_progress WHERE user_id=${uid}) g,
            (SELECT COUNT(*) FROM push_logs         WHERE user_id=${uid}) l`);
  check("消す前は 5 つの表に行がある", () => {
    assert(b.s === 1 && b.p === 2 && b.b === 1 && b.g === 1 && b.l === 2,
      JSON.stringify(b));
    return `saju1 / purchases2 / subs1 / progress1 / logs2`;
  });

  await users.deleteUser(pool, uid);
  const [[a]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM saju_profiles     WHERE user_id=${uid}) s,
            (SELECT COUNT(*) FROM purchases         WHERE user_id=${uid}) p,
            (SELECT COUNT(*) FROM subscriptions     WHERE user_id=${uid}) b,
            (SELECT COUNT(*) FROM learning_progress WHERE user_id=${uid}) g,
            (SELECT COUNT(*) FROM push_logs         WHERE user_id=${uid}) l`);
  check("users を消すと 5 つとも消える", () => {
    assert(a.s + a.p + a.b + a.g + a.l === 0, `残っています: ${JSON.stringify(a)}`);
    return "全部 0";
  });

} finally {
  await cleanup();
  console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
    + (failed ? ` / ${failed} 件失敗` : "") + "（試験データは消しました）");
  await closePool();
}

process.exit(failed ? 1 : 0);
