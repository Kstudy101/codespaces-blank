/* ==================================================================
   verify-quiz.mjs — 3 日周期の復習クイズ（docs/plan-quiz.md）

   このクイズが間違えたときに起こることは、どれも画面に出ない。

     ・範囲を切らずに出す       → 3 日目の人に 40 日目の敬語が届く。
                                  「まだ習っていません」という問い合わせで
                                  初めて分かる
     ・正答を data に載せる     → 押す前に書き換えれば必ず正解。
                                  誰も気づかないまま、クイズが飾りになる
     ・節目の日に重ねる         → 30 日目の朝にクイズが 2 件。どの答えが
                                  どの問題か混ざる
     ・期限予告の朝に重ねる     → 5 通丁度になり、次に 1 通足した日に
                                  朝の配信全体が 400 で落ちる
     ・復習の結果を保存する     → 9 日目の誤答が semester1 の合否
                                  （修了判定の材料）を上書きする

   DB は使わない。repo/ は渡された接続の execute() しか呼ばない
   約束なので、偽物を渡して SQL を読む（verify-push と同じやり方）。
   ================================================================== */
import { deliverOne } from "../server/db/push-daily.mjs";
import { handlePostback } from "../server/lib/handlers/postback.mjs";
import { pickReviewQuiz } from "../server/lib/repo/learning.mjs";
import { renderReviewQuiz } from "../server/lib/render.mjs";
import { EXPIRING_AT } from "../server/lib/handlers/checkout.mjs";
import { checkDay } from "../server/lib/content-check.mjs";

let pass = 0;
const fails = [];
async function check(label, fn) {
  try {
    const note = await fn();
    pass++;
    console.log(`  ✓ ${label}${note ? `　（${note}）` : ""}`);
  } catch (e) {
    fails.push(`${label} — ${e.message}`);
    console.log(`  ✗ ${label} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "満たしていません"); }

/* 偽の接続（verify-push と同じ）。SQL の見た目で返すものを決め、
   実行された SQL は calls に残す。先に書いた pattern が勝つ。 */
function fakeConn(rows = {}) {
  const calls = [];
  return {
    calls,
    sql: () => calls.map((c) => c.sql.replace(/\s+/g, " ").trim()),
    async execute(sql, params = []) {
      calls.push({ sql, params });
      for (const [pattern, value] of Object.entries(rows)) {
        if (new RegExp(pattern, "i").test(sql)) {
          return [typeof value === "function" ? value(sql, params) : value, []];
        }
      }
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }, []];
      return [[], []];
    }
  };
}

const QUIZ = { question: "「はい」は韓国語で？", choices: ["네", "아니요", "감사합니다"], answer: 0 };

/* 5 日目まで進んだ人。次に送るのは 6 日目 ── 3 の倍数の朝。 */
const USER = {
  id: 7, line_user_id: "U_test",
  name_kanji: "田中", name_reading: "たなか", name_kr: "다나카",
  name_source: "web", track: "beginner", active_track: "beginner",
  status: "active", current_day: 5, days_used: 5, current_semester: 1,
  days_entitled: 101,
  ohaeng_main: "목", raw_result_json: { zodiac: "돼지" }
};

const TPL = (day) => [{
  day_number: day, track: "beginner", semester: 1, grammar_point: "-예요 / -이에요",
  grammar_tip_kr: "打ち解けた丁寧。", requires_name_slot: 0,
  dialogue_template: JSON.stringify([{ kr: "네, 맞아요.", ja: "はい、そうです。" }]),
  vocab_3: JSON.stringify([{ kr: "네", meaning: "はい" }])
}];

/* pattern は先勝ち。COUNT → quiz IS NOT NULL → content_templates の順 ──
   逆にすると、クイズを引く SQL が原稿 1 日ぶんとして読まれる。 */
const READY = (day, quizRows) => ({
  "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 0 }],
  "FROM push_logs":          [],
  "quiz IS NOT NULL":        quizRows,
  "FROM content_templates":  TPL(day),
  "FROM quiz_checkpoints":   [],
  "UPDATE learning_progress": { affectedRows: 1 }
});

const QUIZ_ROW = [{ day_number: 2, quiz: JSON.stringify(QUIZ) }];
const noFortune = { load: () => null };

/* クイズの 1 通かどうかは data の中身で見る。quickReply の有無では
   見ない ── 期限予告（expiringNotice）も購入ボタンの quickReply を
   持っていて、それをクイズと数えると誤検知になる（実際なった）。 */
const hasReviewQuiz = (msgs) => msgs.some((m) =>
  m.quickReply?.items?.some((i) => /action=review/.test(i.action?.data || "")));

console.log("[出す朝・出さない朝]");

await check("3 の倍数でない朝は、クイズを引きもしない", async () => {
  const conn = fakeConn(READY(5, QUIZ_ROW));
  let msgs = null;
  await deliverOne(conn, { ...USER, current_day: 4, days_used: 4 },
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません");
  assert(!conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "3 の倍数でないのにクイズを引いています");
  assert(!hasReviewQuiz(msgs), "クイズが付いています");
  return "5 日目の朝 → 本編のみ";
});

await check("3 の倍数の朝は、習った範囲から引いて 1 通足す", async () => {
  const conn = fakeConn(READY(6, QUIZ_ROW));
  let msgs = null;
  await deliverOne(conn, USER,
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません");

  const call = conn.calls.find((c) => /quiz IS NOT NULL/i.test(c.sql));
  assert(call, "クイズを引いていません");
  assert(/day_number <= \?/i.test(call.sql), "範囲を切っていません（未習が出ます）");
  assert(Number(call.params[1]) === 6,
    `範囲の上限が送る日ではありません: ${call.params[1]}（6 のはず）`);

  assert(hasReviewQuiz(msgs), "クイズの 1 通がありません");
  return `本編 + クイズ = ${msgs.length} 通`;
});

await check("節目（30 日目）は復習を休む", async () => {
  const conn = fakeConn({
    ...READY(30, QUIZ_ROW),
    "FROM quiz_checkpoints": [{ day_number: 30 }]
  });
  let msgs = null;
  await deliverOne(conn, { ...USER, current_day: 29, days_used: 29 },
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません");
  assert(!conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "節目なのにクイズを引いています");
  return "席は節目クイズのために空けてある";
});

await check("期限予告の朝は休む（常に 4 通以下・決定④）", async () => {
  /* 今日を送ると残りが EXPIRING_AT になる人。6 日目 = 3 の倍数。 */
  const u = { ...USER, days_entitled: USER.days_used + EXPIRING_AT + 1 };
  const conn = fakeConn(READY(6, QUIZ_ROW));
  let msgs = null;
  await deliverOne(conn, u,
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません");
  assert(!hasReviewQuiz(msgs), "予告とクイズが同じ朝に重なっています");
  assert(!conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "休む朝なのにクイズを引いています");
  return `予告あり → ${msgs.length} 通`;
});

await check("クイズが 1 件も無ければ、本編だけが届く", async () => {
  const conn = fakeConn(READY(6, []));
  let msgs = null;
  const r = await deliverOne(conn, USER,
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, `送信が呼ばれていません（${r}）`);
  assert(!hasReviewQuiz(msgs), "無いはずのクイズが付いています");
  return "運勢と同じ態度";
});

await check("壊れた原稿（answer が範囲外）は黙って抜く", async () => {
  const broken = [{ day_number: 2,
    quiz: JSON.stringify({ question: "?", choices: ["a", "b"], answer: 9 }) }];
  const conn = fakeConn({ "quiz IS NOT NULL": broken });
  const q = await pickReviewQuiz(conn, "beginner", 6);
  assert(q === null, `壊れた原稿が通りました: ${JSON.stringify(q)}`);
  return "本編は落とさない";
});

console.log("\n[文面]  正答が漏れないこと");

await check("data に answer が載っていない", async () => {
  const m = renderReviewQuiz({ dayNumber: 2, ...QUIZ });
  for (const item of m.quickReply.items) {
    assert(!/answer/i.test(item.action.data), `data に answer: ${item.action.data}`);
    assert(item.action.data.startsWith("action=review&day=2&choice="),
      `data の形が違います: ${item.action.data}`);
    assert(item.action.label.length <= 20, `label が 20 字超（LINE が 400 を返す）`);
  }
  assert(m.quickReply.items.length === QUIZ.choices.length, "選択肢の数が合いません");
  return m.quickReply.items.map((i) => i.action.data).join(" / ");
});

console.log("\n[採点]  保存しない・未習は答えない");

const EVENT = (data) => ({
  source: { userId: "U_test" }, replyToken: "rt",
  postback: { data }
});

const PB_READY = {
  "FROM users":             [{ id: 7, line_user_id: "U_test", active_track: "beginner",
                               name_source: "web" }],
  "FROM learning_progress": [{ id: 1, user_id: 7, track: "beginner",
                               current_day: 9, days_used: 9, current_semester: 1 }],
  "FROM content_templates": [{ ...TPL(9)[0], quiz: JSON.stringify(QUIZ) }]
};

await check("正解 → その場で返事、DB には何も書かない", async () => {
  const conn = fakeConn(PB_READY);
  let replied = null;
  const r = await handlePostback(conn, EVENT("action=review&day=9&choice=0"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.passed === true, JSON.stringify(r));
  assert(replied && replied.length === 1, "返事が 1 通ではありません");
  assert(/正解/.test(replied[0].text), replied[0].text);
  assert(!conn.sql().some((s) => /^(INSERT|UPDATE|DELETE)/i.test(s)),
    "復習クイズが DB に書いています（合否の上書き事故のもと）");
  return "無状態";
});

await check("不正解 → 正答を教える。quiz_pass_log には触らない", async () => {
  const conn = fakeConn(PB_READY);
  let replied = null;
  const r = await handlePostback(conn, EVENT("action=review&day=9&choice=2"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.passed === false, JSON.stringify(r));
  assert(/네/.test(replied[0].text), `正答が入っていません: ${replied[0].text}`);
  /* quiz_pass_log は getProgress の SELECT にも並ぶ。読むのは自由で、
     禁じるのは書くこと ── 書いた瞬間に修了判定の材料が汚れる。 */
  assert(!conn.sql().some((s) => /^(UPDATE|INSERT|DELETE)/i.test(s)),
    "復習クイズが DB に書いています（semester の合否が汚れる）");
  return "節目とは別の部屋";
});

await check("未習の日を名乗られたら、採点しない（data 改竄）", async () => {
  const conn = fakeConn(PB_READY);   /* current_day = 9 */
  let sent = false;
  const r = await handlePostback(conn, EVENT("action=review&day=40&choice=0"),
    { send: async () => { sent = true; return {}; } });
  assert(r.skipped, `弾いていません: ${JSON.stringify(r)}`);
  assert(!sent, "未習の日に返事をしています（答えの探り放題になる）");
  assert(!conn.sql().some((s) => /FROM content_templates/i.test(s)),
    "弾く前に原稿を引いています");
  return "day 40 > current_day 9";
});

await check("クイズの無い日を指されたら、静かに降りる", async () => {
  const conn = fakeConn({ ...PB_READY,
    "FROM content_templates": TPL(9) });   /* quiz なし */
  const r = await handlePostback(conn, EVENT("action=review&day=9&choice=0"),
    { send: async () => ({}) });
  assert(r.skipped, `降りていません: ${JSON.stringify(r)}`);
  return r.skipped;
});

console.log("\n[入稿]  壊れた原稿は入り口で止める");

await check("content-check が quiz の形を見る", async () => {
  const base = {
    day_number: 1, __track: "beginner",
    grammar_point: "p", grammar_tip_kr: "t",
    dialogue_template: [{ kr: "네, 맞아요.", ja: "はい。" }, { kr: "감사합니다.", ja: "ありがとう。" }],
    vocab_3: [{ kr: "네", meaning: "はい" }, { kr: "아니요", meaning: "いいえ" }, { kr: "감사", meaning: "感謝" }],
    requires_name_slot: false
  };
  assert(checkDay({ ...base, quiz: QUIZ }).length === 0, "正しい quiz が弾かれました");
  assert(checkDay({ ...base, day_number: 2, quiz: { ...QUIZ, answer: 9 } })
    .some((m) => /answer/.test(m)), "範囲外の answer が通りました");
  assert(checkDay({ ...base, day_number: 3, quiz: { ...QUIZ, choices: ["1つ"] } })
    .some((m) => /choices/.test(m)), "選択肢 1 個が通りました");
  assert(checkDay({ ...base, day_number: 4, quiz: { ...QUIZ, question: "{NAME}は？" } })
    .some((m) => /差し込み口/.test(m)), "差し込み口入りが通りました");
  return "無い日は自由、ある日は全部見る";
});

console.log(fails.length
  ? `\n✗ ${fails.length} 件が満たされていません`
  : `\n✓ ${pass} 件、すべて満たしています`);
process.exit(fails.length ? 1 : 0);
