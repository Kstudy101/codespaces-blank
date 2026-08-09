/* ==================================================================
   verify-quiz.mjs — 3 日周期の復習クイズ（docs/plan-quiz.md）
                   ＋ 節目クイズの発信・採点の返事（docs/plan-quiz-checkpoint.md）

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
                                  （節目の朝だけは例外 ── 決定 §4(가)。
                                  学期に 1 回だけで、上限 5 の内）
     ・復習の結果を保存する     → 9 日目の誤答が semester1 の合否
                                  （修了判定の材料）を上書きする
     ・節目の採点だけして黙る   → 答えたのに何も起きていないように見える

   DB は使わない。repo/ は渡された接続の execute() しか呼ばない
   約束なので、偽物を渡して SQL を読む（verify-push と同じやり方）。
   ================================================================== */
import { deliverOne } from "../server/db/push-daily.mjs";
import { handlePostback } from "../server/lib/handlers/postback.mjs";
import { pickReviewQuiz } from "../server/lib/repo/learning.mjs";
import { renderReviewQuiz, renderCheckpointQuiz } from "../server/lib/render.mjs";
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
const hasCheckpointQuiz = (msgs) => msgs.some((m) =>
  m.quickReply?.items?.some((i) => /action=quiz&/.test(i.action?.data || "")));

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

await check("節目（30 日目）は復習を休む。原稿が無ければ節目クイズも付かない", async () => {
  const conn = fakeConn({
    ...READY(30, QUIZ_ROW),                       /* TPL(30) に quiz は無い */
    "FROM quiz_checkpoints": [{ day_number: 30 }]
  });
  let msgs = null;
  await deliverOne(conn, { ...USER, current_day: 29, days_used: 29 },
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません（本編が止まっています）");
  assert(!conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "節目なのに復習クイズを引いています");
  assert(!hasCheckpointQuiz(msgs), "原稿が無いのに節目クイズが付いています");
  return "30/50/75 の quiz が入稿されるまでは本編だけ";
});

await check("節目の朝は、その日の原稿（tpl.quiz）から節目クイズを 1 通足す", async () => {
  const conn = fakeConn({
    ...READY(30, QUIZ_ROW),
    "FROM content_templates": [{ ...TPL(30)[0], quiz: JSON.stringify(QUIZ) }],
    "FROM quiz_checkpoints": [{ day_number: 30 }]
  });
  let msgs = null;
  await deliverOne(conn, { ...USER, current_day: 29, days_used: 29 },
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません");
  assert(hasCheckpointQuiz(msgs), "節目クイズの 1 通がありません");
  assert(!hasReviewQuiz(msgs), "同じ朝に復習クイズが重なっています");
  assert(!conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "原稿は tpl にあるのに、復習の引き当てを走らせています");
  const item = msgs.flatMap((m) => m.quickReply?.items ?? [])
    .find((i) => /action=quiz&/.test(i.action.data));
  assert(/^action=quiz&day=30&choice=\d$/.test(item.action.data),
    `data の形が違います: ${item.action.data}`);
  return `本編 + 節目クイズ = ${msgs.length} 通`;
});

await check("送った後に push_type='quiz' を記録する ── 実送信だけ", async () => {
  /* dry-run は送信の手前で降りるので、ここに来ない（構造上の保証）。
     見るのは「成功で 1 件・失敗で 0 件」。 */
  const ready = () => fakeConn({
    ...READY(30, QUIZ_ROW),
    "FROM content_templates": [{ ...TPL(30)[0], quiz: JSON.stringify(QUIZ) }],
    "FROM quiz_checkpoints": [{ day_number: 30 }]
  });
  const quizLogs = (conn) => conn.calls.filter((c) =>
    /INSERT INTO push_logs/i.test(c.sql) && c.params.includes("quiz"));

  const ok = ready();
  await deliverOne(ok, { ...USER, current_day: 29, days_used: 29 },
    { send: async () => ({}), ...noFortune });
  assert(quizLogs(ok).length === 1, `記録が ${quizLogs(ok).length} 件（1 のはず）`);
  assert(Number(quizLogs(ok)[0].params[1]) === 30,
    `day_number が節目の日ではありません: ${quizLogs(ok)[0].params[1]}`);

  const bad = ready();
  await deliverOne(bad, { ...USER, current_day: 29, days_used: 29 },
    { send: async () => { throw new Error("400"); }, ...noFortune });
  assert(quizLogs(bad).length === 0, "送れていないのに quiz を記録しています");
  return "成功 1 件 / 失敗 0 件";
});

await check("節目と期限予告が重なる朝は、そのまま送る（決定 §4(가)）", async () => {
  const u = { ...USER, current_day: 29, days_used: 29,
              days_entitled: 29 + EXPIRING_AT + 1 };
  const conn = fakeConn({
    ...READY(30, QUIZ_ROW),
    "FROM content_templates": [{ ...TPL(30)[0], quiz: JSON.stringify(QUIZ) }],
    "FROM quiz_checkpoints": [{ day_number: 30 }],
    /* 予告は購入者だけ（体験中は抑制 ── plan-course-onboarding §5）。 */
    "FROM purchases": [{ id: 1 }]
  });
  let msgs = null;
  await deliverOne(conn, u,
    { send: async (_to, m) => { msgs = m; return {}; }, ...noFortune });
  assert(msgs, "送信が呼ばれていません");
  assert(msgs.some((m) => /お預かりしている日数/.test(m.text)), "予告が抜けています");
  assert(hasCheckpointQuiz(msgs), "節目クイズが抜けています（休むのは復習だけ）");
  /* quickReply が開くのは最後の 1 通だけ。クイズが末尾でないと
     答えのボタンが画面に出ない。 */
  const last = msgs[msgs.length - 1];
  assert(last.quickReply?.items?.some((i) => /action=quiz&/.test(i.action.data)),
    "節目クイズが末尾ではありません（答えのボタンが出ません）");
  return `予告 + 節目クイズ = ${msgs.length} 通（運勢を足しても上限 5 の内）`;
});

await check("期限予告の朝は休む（常に 4 通以下・決定④）", async () => {
  /* 今日を送ると残りが EXPIRING_AT になる人。6 日目 = 3 の倍数。
     予告は購入者だけなので、purchases の行を置く（§5 の抑制）。 */
  const u = { ...USER, days_entitled: USER.days_used + EXPIRING_AT + 1 };
  const conn = fakeConn({ ...READY(6, QUIZ_ROW), "FROM purchases": [{ id: 1 }] });
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

await check("節目クイズの data にも answer が載っていない", async () => {
  const m = renderCheckpointQuiz(30, QUIZ);
  for (const item of m.quickReply.items) {
    assert(!/answer/i.test(item.action.data), `data に answer: ${item.action.data}`);
    assert(item.action.data.startsWith("action=quiz&day=30&choice="),
      `data の形が違います: ${item.action.data}`);
    assert(item.action.label.length <= 20, "label が 20 字超（LINE が 400 を返す）");
  }
  assert(m.quickReply.items.length === QUIZ.choices.length, "選択肢の数が合いません");
  assert(/節目クイズ/.test(m.text), `頭の 1 行が違います: ${m.text.split("\n")[0]}`);
  return "復習と同じ組み立て、頭と action だけ違う";
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
  /* 「正解」の 2 文字を要求していた。2026-08-09 に文面が
     「⭕ よくできました！🎉」＋夕方の一言へ変わり（plan-quiz-correct-cheer C）、
     この関門だけが取り残されてサイトと配信サーバーの配置を 3 コミット止めた。
     同日、正誤共通の締め（plan-quiz-harder-distractors C）へ差し替え。
     確定した文面そのものを見る ── 次に文面を変えるときは、ここも同じ
     コミットで直すこと。 */
  assert(/よくできました/.test(replied[0].text), replied[0].text);
  assert(/今日もお疲れ様でした/.test(replied[0].text), replied[0].text);
  assert(/また明日お会いしましょう/.test(replied[0].text), replied[0].text);
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
  assert(/あなたの答え:/.test(replied[0].text), `選んだ答えがありません: ${replied[0].text}`);
  assert(/正解:/.test(replied[0].text), `正解ラベルがありません: ${replied[0].text}`);
  assert(/今日もお疲れ様でした/.test(replied[0].text), replied[0].text);
  assert(/また明日お会いしましょう/.test(replied[0].text), replied[0].text);
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

console.log("\n[節目の採点]  記録して、答えた本人にその場で返す");

const CP_READY = {
  "FROM users":             [{ id: 7, line_user_id: "U_test", active_track: "beginner",
                               name_source: "web" }],
  "FROM quiz_checkpoints":  [{ day_number: 30 }],
  "FROM content_templates": [{ ...TPL(30)[0], quiz: JSON.stringify(QUIZ) }]
};
const passLogWrites = (conn) => conn.calls.filter((c) => /JSON_MERGE_PATCH/i.test(c.sql));

await check("合格 → ⭕ の返事 1 通。合否の記録は正しく 1 回", async () => {
  const conn = fakeConn(CP_READY);
  let replied = null;
  const r = await handlePostback(conn, EVENT("action=quiz&day=30&choice=0"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.passed === true, JSON.stringify(r));
  assert(replied && replied.length === 1, "返事が 1 通ではありません");
  assert(/⭕/.test(replied[0].text) && /第1学期/.test(replied[0].text), replied[0].text);
  const w = passLogWrites(conn);
  assert(w.length === 1, `quiz_pass_log への書き込みが ${w.length} 回`);
  assert(/"semester1":true/.test(String(w[0].params[0])),
    `記録の中身が違います: ${w[0].params[0]}`);
  return "採点・記録は従来のまま、返事だけ増えた";
});

await check("不合格 → ❌ と正答を返す。false も 1 回だけ記録", async () => {
  const conn = fakeConn(CP_READY);
  let replied = null;
  const r = await handlePostback(conn, EVENT("action=quiz&day=30&choice=2"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.passed === false, JSON.stringify(r));
  assert(replied && replied.length === 1, "返事が 1 通ではありません");
  assert(/❌/.test(replied[0].text) && /네/.test(replied[0].text)
      && /あなたの答え:/.test(replied[0].text) && /正解:/.test(replied[0].text),
    `正答が入っていません: ${replied[0].text}`);
  const w = passLogWrites(conn);
  assert(w.length === 1, `quiz_pass_log への書き込みが ${w.length} 回`);
  assert(/"semester1":false/.test(String(w[0].params[0])),
    `記録の中身が違います: ${w[0].params[0]}`);
  return "黙って記録だけ、が無くなった";
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

await check("신양식（pos 있음）에서는 quiz 누락이 거부된다（지시서㉑ §2-4）", async () => {
  /* 구양식의 「無い日は自由」는 그대로 두고, 신양식만 매일 필수.
     판정은 vocab 의 pos ── render.mjs 의 isNewFormat 과 같은 문장. */
  const newDay = {
    day_number: 5, __track: "beginner",
    grammar_point: "-도（〜も）",
    grammar_tip_kr: "形　名詞 + 도\n使　同じであることを足す\n落　-은/는 と重ねない",
    dialogue_template: [
      { kr: "저는 드라마를 좋아해요.", ja: "私はドラマが好きです。" },
      { kr: "저도요.", ja: "私もです。" },
      { kr: "노래도 좋아해요?", ja: "歌も好きですか。" },
      { kr: "네, 노래도요.", ja: "はい、歌もです。" }
    ],
    vocab_3: [
      { kr: "드라마", meaning: "ドラマ", pos: "名詞" }, { kr: "노래", meaning: "歌", pos: "名詞" },
      { kr: "좋다", meaning: "よい", pos: "形容詞" }, { kr: "많다", meaning: "多い", pos: "形容詞" },
      { kr: "보다", meaning: "見る", pos: "動詞" }, { kr: "듣다", meaning: "聞く", pos: "動詞" }
    ],
    requires_name_slot: false
  };
  const bad = checkDay(newDay, new Set());
  assert(bad.some((m) => /quiz 는 필수/.test(m)), `누락이 통과했습니다: ${bad.join(" / ") || "(0건)"}`);
  assert(checkDay({ ...newDay, day_number: 6, quiz: QUIZ }, new Set()).length === 0,
    "quiz 를 넣어도 다른 것이 걸립니다");
  return "누락 거부・보완 시 통과";
});

console.log(fails.length
  ? `\n✗ ${fails.length} 件が満たされていません`
  : `\n✓ ${pass} 件、すべて満たしています`);
process.exit(fails.length ? 1 : 0);
