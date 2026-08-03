/* ==================================================================
   verify-push.mjs — 朝の配信バッチ（db/push-daily.mjs）

   このバッチが間違えたときに起こることは、どれも画面に出ない。

     ・日を確保する前に送る   → 送信は成功、確保は失敗、という日に
                                翌朝もう一度同じ内容が届く
     ・原稿の無い日で確保する → 誰も読まないまま 1 日が消える
     ・二重に走る             → 同じ日が二度、次の日が誰にも
     ・保有日数を見ない       → 払っていない人に配り続ける

   どれも「送った」という記録だけは正常に残るので、運営者にも
   利用者にも普通に見える。だから機械に見張らせる。

   DB は使わない。repo/ は渡された接続の execute() しか呼ばない
   約束なので、偽物を渡して SQL を読む。LINE も偽物を渡し、
   呼ばれた瞬間に DB が何をされていたかを覗く。
   ================================================================== */
import { deliverOne, retryKey, tooEarly } from "../server/db/push-daily.mjs";
import { LineApiError } from "../server/lib/line.mjs";

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

/* 偽の接続。SQL の見た目で返すものを決める。
   実行された SQL は全部 calls に残るので、順番も後から読める。 */
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

/* 3 日目まで進んでいて、101 日ぶん買っている人 */
const USER = {
  id: 7, line_user_id: "U_test",
  name_kanji: "田中", name_reading: "たなか", name_kr: "다나카",
  status: "active", total_days_entitled: 101, current_day: 3, current_semester: 1,
  /* この講座は四柱で韓国語を教えるので、配信の対象を引くところから
     五行と干支が付いてくる（repo/users.mjs の listDeliverable）。 */
  ohaeng_main: "목", raw_result_json: { zodiac: "돼지" }
};

const TPL = [{
  day_number: 4, semester: 1, grammar_point: "-예요 / -이에요",
  grammar_tip_kr: "打ち解けた丁寧。", requires_name_slot: 1,
  dialogue_template: JSON.stringify([{ kr: "{NAME_IEYO}.", ja: "{NAME_JP}です。" }]),
  vocab_3: JSON.stringify([{ kr: "네", meaning: "はい" }])
}];

/* 「まだ送っていない・原稿はある」を既定にする。
   個々の検査は、そこから 1 つだけ崩して違いを見る。 */
const READY = {
  /* sentToday は SELECT id、countForDay は SELECT COUNT(*)。
     同じ表を引くので、SQL の形で見分ける。並び順が先勝ちなので
     COUNT を先に置く。 */
  "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 0 }],
  "FROM push_logs":         [],   /* sentToday → 未送信 */
  "FROM content_templates": TPL,
  "UPDATE learning_progress": { affectedRows: 1 }
};

const sendOK = () => async () => ({});

console.log("[順番]  ここが逆だと、同じ日が二度届く");

await check("送る前に、日が確保されている", async () => {
  const conn = fakeConn(READY);
  let sqlAtSend = null;
  await deliverOne(conn, USER, { send: async () => { sqlAtSend = conn.sql(); return {}; } });
  assert(sqlAtSend, "送信が呼ばれていません");
  assert(sqlAtSend.some((s) => /UPDATE learning_progress/i.test(s)),
    "送信の時点で advanceDay が走っていません（送ってから進めています）");
  return "advanceDay → send";
});

await check("記録は、送ったあとに残る", async () => {
  const conn = fakeConn(READY);
  let sqlAtSend = null;
  await deliverOne(conn, USER, { send: async () => { sqlAtSend = conn.sql(); return {}; } });
  assert(!sqlAtSend.some((s) => /INSERT INTO push_logs/i.test(s)),
    "送る前に「送った」と記録しています");
  assert(conn.sql().some((s) => /INSERT INTO push_logs/i.test(s)), "記録が残っていません");
  return "send → logSent";
});

await check("確保に負けたら、送らない（二重起動）", async () => {
  const conn = fakeConn({ ...READY, "UPDATE learning_progress": { affectedRows: 0 } });
  let sent = false;
  const r = await deliverOne(conn, USER, { send: async () => { sent = true; return {}; } });
  assert(!sent, "負けたのに送りました");
  assert(r === "他が確保", r);
  return "claimed=false → 送らない";
});

console.log("\n[送らない相手]");

await check("今日ぶんを既に送っていれば、何もしない", async () => {
  const conn = fakeConn({ ...READY, "FROM push_logs": [{ n: 1 }] });
  let sent = false;
  const r = await deliverOne(conn, USER, { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "既送", `${r} / 送信=${sent}`);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "送らないのに日を進めています");
  return "確保もしない";
});

await check("保有日数を超えたら送らない", async () => {
  const conn = fakeConn(READY);
  let sent = false;
  const r = await deliverOne(conn, { ...USER, total_days_entitled: 3 },
    { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "日数切れ", `${r} / 送信=${sent}`);
  return "3 日ぶんで 4 日目は送らない";
});

await check("体験の 3 日目までは送る（境界を 1 日ずらしていない）", async () => {
  const conn = fakeConn({ ...READY, "FROM content_templates": [{ ...TPL[0], day_number: 3 }] });
  let sent = false;
  await deliverOne(conn, { ...USER, current_day: 2, total_days_entitled: 3 },
    { send: async () => { sent = true; return {}; } });
  assert(sent, "3 日ぶん持っている人の 3 日目が送られません");
  return "entitled=3 → 3 日目まで";
});

await check("101 日を終えた人は進めない", async () => {
  const conn = fakeConn(READY);
  let sent = false;
  const r = await deliverOne(conn, { ...USER, current_day: 101 },
    { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "修了済", `${r} / 送信=${sent}`);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)), "102 日目へ進めています");
  return "101 で止まる";
});

console.log("\n[原稿が無い日]  P4-c が終わるまで、実際に起こる");

await check("原稿が無ければ、日を消費しない", async () => {
  const conn = fakeConn({ ...READY, "FROM content_templates": [] });
  let sent = false;
  const r = await deliverOne(conn, USER, { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "原稿なし", `${r} / 送信=${sent}`);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "原稿が無いのに日を進めました（その日は誰にも届かず消えます）");
  return "advanceDay を呼ばない";
});

await check("原稿が無いことは failed で残る", async () => {
  const conn = fakeConn({ ...READY, "FROM content_templates": [] });
  await deliverOne(conn, USER, { send: sendOK() });
  const log = conn.calls.find((c) => /INSERT INTO push_logs/i.test(c.sql));
  assert(log, "記録が残っていません");
  /* status は SQL に直接書かれている（列の並びも一緒に見る）。 */
  assert(/'failed'/.test(log.sql), `sent 扱いで残っています: ${log.sql.replace(/\s+/g," ")}`);
  assert(log.params.some((x) => typeof x === "string" && /未入稿/.test(x)),
    "理由が残っていません");
  return "問い合わせより先に気づける";
});

console.log("\n[四柱]  講座の中身が四柱に依っている");

await check("五行と干支が本文まで届く", async () => {
  const tpl = [{ ...TPL[0],
    dialogue_template: JSON.stringify([
      { kr: "{NAME_EUN} {OHAENG_IEYO}.", ja: "{NAME_JP}は{OHAENG_JP}です。" },
      { kr: "{ZODIAC_GA} 좋아요.", ja: "{ZODIAC_JP}がいいです。" }]) }];
  const conn = fakeConn({ ...READY, "FROM content_templates": tpl });
  let msgs = null;
  await deliverOne(conn, USER, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(msgs, "送信が呼ばれていません");
  const t = msgs[0].text;
  assert(t.includes("다나카는 목이에요"), t);
  assert(t.includes("돼지가 좋아요"), t);
  assert(t.includes("たなかは木です"), t);
  assert(t.includes("いのししがいいです"), t);
  return "다나카는 목이에요 / 돼지가 좋아요";
});

await check("ふりがなの列を渡している（漢字ではない）", async () => {
  /* 以前は name_reading を引いておらず、日本語の行に漢字が出ていた。 */
  const tpl = [{ ...TPL[0],
    dialogue_template: JSON.stringify([{ kr: "{NAME}입니다.", ja: "{NAME_JP}です。" }]) }];
  const conn = fakeConn({ ...READY, "FROM content_templates": tpl });
  let msgs = null;
  await deliverOne(conn, USER, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(msgs[0].text.includes("たなかです"), msgs[0].text);
  assert(!msgs[0].text.includes("田中です"), `漢字が出ました: ${msgs[0].text}`);
  return "たなか（name_reading）";
});

await check("四柱が無い人は、その日を待つ（既定の五行を入れない）", async () => {
  const tpl = [{ ...TPL[0], requires_name_slot: 1,
    dialogue_template: JSON.stringify([{ kr: "{OHAENG_IEYO}.", ja: "{OHAENG_JP}です。" }]) }];
  const conn = fakeConn({ ...READY, "FROM content_templates": tpl });
  let msgs = null;
  const r = await deliverOne(conn, { ...USER, ohaeng_main: null, raw_result_json: null },
    { send: async (_t, m) => { msgs = m; return {}; } });
  assert(r === "名前の案内", r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)), "日が進みました");
  return "名前と四柱は同時にしか入らない";
});

console.log("\n[名前が無い人]");

await check("名前が要る日に名前が無ければ、登録のお願いに差し替える", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, { ...USER, name_kr: null, name_kanji: null },
    { send: async (to, m) => { msgs = m; return {}; } });
  assert(msgs, "送信が呼ばれていません");
  assert(msgs.length === 1 && /お名前/.test(msgs[0].text), JSON.stringify(msgs));
  return "本文の代わりに登録のお願い";
});

await check("名前が無い日は、日を進めない", async () => {
  /* 進めると、その日の内容が二度と届かない。1〜5 日目は全部
     名前を使うので、サイトを通らずに友だち追加だけした人は
     体験の 3 日間で本文を 1 度も見ないまま終わっていた。 */
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, { ...USER, name_kr: null, name_kanji: null },
    { send: sendOK() });
  assert(r === "名前の案内", r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "日を進めました（その日の内容が届かなくなります）");
  return "同じ日に留まる";
});

await check("案内は日付つきで残る（それが促した回数になる）", async () => {
  const conn = fakeConn(READY);
  await deliverOne(conn, { ...USER, name_kr: null, name_kanji: null }, { send: sendOK() });
  const log = conn.calls.find((c) => /INSERT INTO push_logs/i.test(c.sql));
  assert(log, "記録が残っていません");
  assert(log.params.includes(4), `day_number が入っていません: ${JSON.stringify(log.params)}`);
  return "day_number=4";
});

await check("3 回目からは黙る（ブロックは取り消せない）", async () => {
  const conn = fakeConn({ ...READY,
    "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 2 }] });
  let sent = false;
  const r = await deliverOne(conn, { ...USER, name_kr: null, name_kanji: null },
    { send: async () => { sent = true; return {}; } });
  assert(!sent, "3 回目を送りました");
  assert(r === "名前待ち", r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)), "日が進みました");
  return "2 回で止める / 進みは止めたまま";
});

await check("2 回目までは送る（1 回で諦めない）", async () => {
  const conn = fakeConn({ ...READY,
    "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 1 }] });
  let sent = false;
  await deliverOne(conn, { ...USER, name_kr: null, name_kanji: null },
    { send: async () => { sent = true; return {}; } });
  assert(sent, "2 回目が送られません");
  return "n=1 → 送る";
});

console.log("\n[届かなかったとき]");

await check("送信に失敗したら failed で残す", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, USER,
    { send: async () => { throw new Error("接続できません"); } });
  assert(r === "送信失敗", r);
  const log = conn.calls.find((c) => /INSERT INTO push_logs/i.test(c.sql));
  assert(log, "記録が残っていません");
  assert(/'failed'/.test(log.sql), `sent 扱いで残っています: ${log.sql.replace(/\s+/g," ")}`);
  assert(log.params.some((p) => typeof p === "string" && /接続できません/.test(p)),
    "理由が残っていません");
  return "理由つきで残る";
});

await check("失敗しても他の人へ進む（例外を投げない）", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, USER,
    { send: async () => { throw new Error("落ちました"); } });
  assert(typeof r === "string", "例外が外へ出ました");
  return "1 人の失敗で全員が止まらない";
});

await check("ブロックされた人は配信対象から外す", async () => {
  /* 403 / 404 は障害ではなく「もういない」。外さないと、
     毎朝ここで失敗し続け、失敗の記録に埋もれて
     本当の障害が見えなくなる。 */
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, USER,
    { send: async () => { throw new LineApiError(403, "blocked", "/message/push"); } });
  assert(r === "届かない", r);
  assert(conn.sql().some((s) => /UPDATE users/i.test(s) && /unfollowed/.test(s)),
    "配信対象から外していません");
  return "403 → unfollowed";
});

await check("ふつうの障害では、対象から外さない", async () => {
  /* 500 で外してしまうと、LINE 側の一時的な不調で
     利用者が黙って消える。 */
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, USER,
    { send: async () => { throw new LineApiError(500, "oops", "/message/push"); } });
  assert(r === "送信失敗", r);
  assert(!conn.sql().some((s) => /UPDATE users/i.test(s) && /unfollowed/.test(s)),
    "500 で配信対象から外しました");
  return "500 → 残す";
});

console.log("\n[配る時刻]  cron ではなく、こちらで日本時間を見る");

await check("日本の指定時刻より前なら、何もしない", () => {
  assert(tooEarly(6, 7) === true,  "6 時に走ってしまいます");
  assert(tooEarly(0, 7) === true,  "0 時に走ってしまいます");
  return "6時 / 0時 → 走らない";
});

await check("指定時刻ちょうど、およびそれ以降は走る", () => {
  /* 「7 時ちょうどだけ」にすると、7 時の回が落ちた日は
     その日ぶんが誰にも届かない。以降なら 8 時が拾える。
     二度送らないのは sentToday が見ている。 */
  assert(tooEarly(7, 7)  === false, "7 時ちょうどに走りません");
  assert(tooEarly(8, 7)  === false, "8 時に拾えません");
  assert(tooEarly(23, 7) === false, "23 時に拾えません");
  return "7時 / 8時 / 23時 → 走る";
});

await check("指定が無ければ、いつでも走る", () => {
  assert(tooEarly(3, null) === false && tooEarly(3, undefined) === false, "止まりました");
  return "--not-before なし";
});

await check("0〜23 でない指定は、黙って通さない", () => {
  for (const bad of [24, -1, "朝", 7.5]) {
    let threw = false;
    try { tooEarly(10, bad); } catch { threw = true; }
    assert(threw, `${bad} を受け取ってしまいました`);
  }
  return "4 通り";
});

console.log("\n[重複防止キー]");

await check("同じ人・同じ日なら、毎回同じ鍵になる", () => {
  assert(retryKey(7, 4, "learning") === retryKey(7, 4, "learning"), "毎回変わります");
  return "掛け直しても LINE 側で弾ける";
});

await check("人か日が違えば、違う鍵になる", () => {
  const a = retryKey(7, 4, "learning");
  assert(a !== retryKey(8, 4, "learning"), "人が違うのに同じ鍵");
  assert(a !== retryKey(7, 5, "learning"), "日が違うのに同じ鍵");
  assert(a !== retryKey(7, 4, "review"),   "種類が違うのに同じ鍵");
  return "3 通りで別";
});

await check("LINE が受け取る UUID の形をしている", () => {
  const k = retryKey(7, 4, "learning");
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(k), k);
  return k;
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
