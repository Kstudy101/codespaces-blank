/* ==================================================================
   verify-evening.mjs — 夕方のふりかえり（db/push-evening.mjs）

   朝の便と同じくらい静かに壊れる。しかも壊れ方が朝と違う。

     ・日を進めてしまう   → 復習が「おまけ」ではなくなり、
                            買った 101 日が半分の日数で終わる
     ・朝と同じものを送る → 通知だけ増えて読まれなくなる
     ・対象を進捗から出す → 今朝届かなかった人にも復習が届く。
                            受け取った側は「習っていないものの復習」
     ・コースを見ない     → 中級の人に初級の復習が届く

   どれも送信そのものは成功するので、記録を見ても異常が無い。
   計画書 1-2 の「復習は保有日数を削らないボーナス」が守られて
   いるかは、current_day が動かないことでしか確かめられない。

   DB は使わない。偽の接続を渡して SQL を読み、LINE も偽物を
   渡して、呼ばれた瞬間に DB が何をされていたかを覗く。
   ================================================================== */
import { deliverOne, retryKey, tooEarly } from "../server/db/push-evening.mjs";
import { retryKey as morningKey } from "../server/db/push-daily.mjs";
import { listReviewTargets } from "../server/lib/repo/pushlogs.mjs";
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

/* listReviewTargets が返す 1 行。列名は listDeliverable と揃っている
   （id であって user_id ではない）── 揃っていないと、朝と夕方で
   同じ renderer に違うものを渡すことになる。 */
const TARGET = {
  id: 7, line_user_id: "U_test", day_number: 4, track: "beginner",
  name_kanji: "田中", name_reading: "たなか", name_kr: "다나카",
  ohaeng_main: "목", raw_result_json: { zodiac: "돼지" }
};

const TPL = [{
  day_number: 4, track: "beginner", semester: 1, grammar_point: "-예요 / -이에요",
  grammar_tip_kr: "打ち解けた丁寧。ていねいな言い方です。", requires_name_slot: 1,
  dialogue_template: JSON.stringify([
    { kr: "{NAME_IEYO}.", ja: "{NAME_JP}です。" },
    { kr: "반가워요.", ja: "はじめまして。" }]),
  vocab_3: JSON.stringify([
    { kr: "네", meaning: "はい" },
    { kr: "아니요", meaning: "いいえ" },
    { kr: "고마워요", meaning: "ありがとう" }])
}];

const READY = {
  "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 0 }],
  "FROM push_logs":         [],   /* sentToday → 未送信 */
  "FROM content_templates": TPL
};


console.log("[ボーナスであること]  ここが崩れると、買った日数が減る");

await check("復習では日を進めない", async () => {
  /* 計画書 1-2。current_day を動かすのは朝の学習配信だけ。
     動かすと 101 日が半分の日数で終わり、買った人が損をする。 */
  const conn = fakeConn(READY);
  await deliverOne(conn, TARGET, { send: async () => ({}) });
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "復習で進みを動かしました（保有日数を削らない約束が崩れます）");
  return "advanceDay を呼ばない";
});

await check("進みを書き換える SQL が、そもそも入っていない", async () => {
  /* 呼ばないことを 1 例で確かめるだけだと、別の道で呼ぶ形に
     なったときに気づけない。ソースそのものを見る。 */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server/db/push-evening.mjs", import.meta.url), "utf8");
  assert(!/advanceDay|resetProgress/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "進みを動かす関数を呼んでいます");
  return "ソースにも無い";
});


console.log("\n[誰に送るか]  今朝ちゃんと届いた人だけ");

await check("対象は進捗ではなく、送信ログから出す", async () => {
  /* 朝の配信で current_day は既に +1 されているので、そこから
     引き算すると、その日に届かなかった人（日数切れ・送信失敗・
     原稿なし）まで混ざる。受け取った側は「習っていないものの復習」。 */
  const conn = fakeConn({ "FROM push_logs": [] });
  await listReviewTargets(conn, "2026-08-04");
  const flat = conn.calls[0].sql.replace(/\s+/g, " ");
  assert(/FROM push_logs/.test(flat), "送信ログを見ていません");
  assert(/push_type = 'learning'/.test(flat), "learning で絞っていません");
  assert(/status = 'sent'/.test(flat), "失敗した日まで対象にしています");
  assert(/u\.status IN \('trial', 'active'\)/.test(flat), "退会者が混ざります");
  return "learning / sent / trial・active";
});

await check("復習に要る列が、対象の一覧で取れている", async () => {
  /* 取れていないと、夕方だけ名前が入らない・五行が空になる。
     どちらも文としては成立するので、読み比べるまで気づけない。 */
  const conn = fakeConn({ "FROM push_logs": [] });
  await listReviewTargets(conn, "2026-08-04");
  const flat = conn.calls[0].sql.replace(/\s+/g, " ");
  for (const col of ["u.name_reading", "u.name_kr", "p.track", "j.ohaeng_main", "j.raw_result_json"]) {
    assert(flat.includes(col), `${col} を取っていません`);
  }
  assert(/l\.user_id AS id/.test(flat), "列名が listDeliverable と揃っていません（id）");
  return "name_reading / track / 四柱";
});

await check("今日ぶんを既に送っていれば、何もしない", async () => {
  /* cron は 1 時間ごとに来る。これが無いと 18 時から日付が
     変わるまで毎時届く。 */
  const conn = fakeConn({ ...READY, "FROM push_logs": [{ id: 1 }] });
  let sent = false;
  const r = await deliverOne(conn, TARGET, { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "既送", `${r} / 送信=${sent}`);
  return "毎時こない";
});

await check("コースが決まっていない人には送らない", async () => {
  /* 朝が届いていない以上ここには来ないはずで、来たなら
     朝の判定と食い違っている。黙って初級を引くと、
     その食い違いが隠れる。 */
  const conn = fakeConn(READY);
  let sent = false;
  const r = await deliverOne(conn, { ...TARGET, track: null },
    { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "コース未選択", `${r} / 送信=${sent}`);
  return "初級に落とさない";
});

await check("原稿はその人のコースから引く", async () => {
  const conn = fakeConn(READY);
  await deliverOne(conn, { ...TARGET, track: "advanced" }, { send: async () => ({}) });
  const q = conn.calls.find((c) => /FROM content_templates/i.test(c.sql));
  assert(q, "原稿を引いていません");
  assert(q.params[0] === "advanced", `track=${q.params[0]} で引きました`);
  assert(q.params[1] === 4, `day=${q.params[1]} で引きました`);
  return "advanced の 4 日目";
});

await check("原稿が消えていても、夕方の便ごと落とさない", async () => {
  const conn = fakeConn({ ...READY, "FROM content_templates": [] });
  const r = await deliverOne(conn, TARGET, { send: async () => ({}) });
  assert(r === "原稿なし", r);
  return "その人だけ飛ばす";
});

await check("名前が消えた人には黙る（朝夕 2 回お願いしない）", async () => {
  const conn = fakeConn(READY);
  let sent = false;
  const r = await deliverOne(conn, { ...TARGET, name_kr: null, name_reading: null },
    { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "名前なし", `${r} / 送信=${sent}`);
  return "促すのは朝だけ";
});


console.log("\n[中身]  朝の再送にしない");

await check("問いと答えの 2 通に分かれる", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, TARGET, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(msgs && msgs.length === 2, `${msgs ? msgs.length : 0} 通でした`);
  assert(/ふりかえり/.test(msgs[0].text), msgs[0].text.slice(0, 30));
  assert(/こたえ/.test(msgs[1].text), msgs[1].text.slice(0, 30));
  return "問い → 答え";
});

await check("問いの側に答えを混ぜない", async () => {
  /* 同じ画面に答えが出ていると、思い出す間が無い。
     単語は 1 通目でハングルだけ、意味は 2 通目。 */
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, TARGET, { send: async (_t, m) => { msgs = m; return {}; } });
  const [q, a] = msgs.map((m) => m.text);
  assert(q.includes("네") && !q.includes("はい"), `1 通目に意味が出ています: ${q}`);
  assert(a.includes("네") && a.includes("はい"), `2 通目に意味がありません: ${a}`);
  assert(q.includes("다나카예요") && !q.includes("たなかです"),
    `1 通目に訳が出ています: ${q}`);
  assert(a.includes("たなかです"), `2 通目に訳がありません: ${a}`);
  return "意味と訳は 2 通目だけ";
});

await check("名前は夕方も差し込まれる（받침 の規則ごと）", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, TARGET, { send: async (_t, m) => { msgs = m; return {}; } });
  /* 다나카 は母音終わりなので 예요。받침 があれば 이에요。 */
  assert(msgs[0].text.includes("다나카예요"), msgs[0].text);
  assert(!/\{[A-Z_]+\}/.test(msgs[0].text + msgs[1].text), "差し込み口が残っています");
  return "다나카예요";
});


console.log("\n[体験 2 日目の勧誘]  閉じていても送る ── ただし嘘は送らない");

/* findDeliverable が返す形（DELIVERABLE_SQL + shape）。体験中・2 日目。 */
const TRIAL_ROW = {
  id: 7, line_user_id: "U_test", display_name: "田中",
  name_kanji: "田中", name_reading: "たなか", name_kr: "다나카", name_source: "web",
  status: "trial", track: "beginner",
  current_day: 2, days_used: 2, current_semester: 1,
  days_entitled: 3, remaining: 1,
  ohaeng_main: "목", raw_result_json: null, birth_confirmed: 0
};
const DAY2 = { ...TARGET, day_number: 2 };

/* 勧誘の分岐まで届く既定の偽 DB。COUNT 系は形の違いで先に取る
   （並び順が先勝ち）。 */
const upsellReady = (over = {}) => ({
  "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 0 }],
  "FROM push_logs": [],
  "SELECT COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 50 }],
  "FROM content_templates": TPL,
  "FROM users": [TRIAL_ROW],
  ...over
});

/* salesAllowedFor は env を読む。検査ごとに開閉して、終わったら消す。 */
const SALES_ENV = ["TOKUSHOHO_URL", "REFUND_POLICY",
                   "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SALES_MODE"];
function withSales(mode, fn) {
  process.env.TOKUSHOHO_URL = "https://x.test/tokushoho";
  process.env.REFUND_POLICY = "テスト";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
  process.env.SALES_MODE = mode;
  return Promise.resolve(fn()).finally(() => SALES_ENV.forEach((k) => delete process.env[k]));
}

await check("買える人には文面 A ── 復習の後ろに 1 通、日数は消費しない", () =>
  withSales("open", async () => {
    const conn = fakeConn(upsellReady());
    let msgs = null;
    const r = await deliverOne(conn, DAY2, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === "送信+勧誘:2日目", r);
    assert(msgs.length === 3, `${msgs.length} 通でした（復習 2 + 勧誘 1 のはず）`);
    const t = msgs[2].text;
    assert(/明日が最後の 1 日/.test(t), t);
    assert(/日数を追加できます/.test(t), t);
    const qr = msgs[2].quickReply?.items?.[0]?.action;
    assert(qr && qr.data === "action=plan&track=beginner", JSON.stringify(qr));
    assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
      "勧誘で日数が動きました ── ボーナスの不変式が崩れています");
    assert(conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql) && c.params.includes("upsell")),
      "upsell の記録がありません（通算 1 回の判定が壊れます）");
    return "A + 受講料を見る / days_used 不変";
  }));

await check("販売が閉じていれば文面 B ── quickReply 無し・約束もしない", () =>
  withSales("closed", async () => {
    const conn = fakeConn(upsellReady());
    let msgs = null;
    const r = await deliverOne(conn, DAY2, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === "送信+勧誘:2日目", r);
    const t = msgs[2].text;
    assert(/ただいま準備中です/.test(t), t);
    assert(/［受講料］/.test(t), "どこを見ればよいかが無い");
    assert(!msgs[2].quickReply, "押しても準備中の quickReply が付いています");
    /* 「整いましたらお知らせします」は書かない ── 知らせる機能が
       コードに無い。文書がコードより先に出るのを関門で止める。 */
    assert(!/お知らせ/.test(t), `能動通知を約束しています: ${t}`);
    return "B / 通知の約束なし";
  }));

await check("販売が開いていても、原稿が最小パッケージ未満なら文面 B", () =>
  withSales("open", async () => {
    /* 原稿 3 日ぶん ← 最小 7 日が売れない。A を送ると、押した先で
       「準備中」が出る ── 価格表と同じ sellablePackages で判定する。 */
    const conn = fakeConn(upsellReady({
      "SELECT COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 3 }] }));
    let msgs = null;
    const r = await deliverOne(conn, DAY2, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === "送信+勧誘:2日目", r);
    assert(/ただいま準備中です/.test(msgs[2].text), msgs[2].text);
    assert(!msgs[2].quickReply, "買えないのに quickReply が付いています");
    return "sellablePackages = 0 → B";
  }));

await check("勧誘は通算 1 回だけ（upsell の記録で二度目を止める）", () =>
  withSales("open", async () => {
    const conn = fakeConn(upsellReady({
      "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 1 }] }));
    let msgs = null;
    const r = await deliverOne(conn, DAY2, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === "送信:2日目", r);
    assert(msgs.length === 2, `${msgs.length} 通でした（復習だけのはず）`);
    return "n=1 → 復習だけ";
  }));

await check("体験でない人（購入者）の 2 日目には勧誘しない", () =>
  withSales("open", async () => {
    const conn = fakeConn(upsellReady({
      "FROM users": [{ ...TRIAL_ROW, status: "active", days_entitled: 101, remaining: 99 }] }));
    let msgs = null;
    const r = await deliverOne(conn, DAY2, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === "送信:2日目", r);
    assert(msgs.length === 2, `${msgs.length} 通でした`);
    return "trial 以外 → 復習だけ";
  }));

await check("2 日目以外の夕方は、勧誘の判定にすら入らない", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, TARGET, { send: async () => ({}) });   /* day 4 */
  assert(/送信:4日目/.test(r), r);
  assert(!conn.sql().some((s) => /FROM users/i.test(s)),
    "4 日目なのに 1 人ぶん引き直しています");
  return "day ≠ 2 → 引き直しなし";
});

console.log("\n[配る時刻]  cron ではなく、こちらで日本時間を見る");

await check("日本の 18 時より前なら、何もしない", () => {
  assert(tooEarly(17, 18) === true, "17 時に走ってしまいます");
  assert(tooEarly(7, 18)  === true, "朝の時間に走ってしまいます");
  return "17時 / 7時 → 走らない";
});

await check("18 時ちょうど、およびそれ以降は走る", () => {
  assert(tooEarly(18, 18) === false, "18 時ちょうどに走りません");
  assert(tooEarly(19, 18) === false, "19 時に拾えません");
  return "18時 / 19時 → 走る";
});

await check("cron の行がどちらの便かを取り違えない", async () => {
  const { readFileSync } = await import("node:fs");
  const sh = readFileSync(new URL("../server/db/push-cron.sh", import.meta.url), "utf8");
  assert(/push-evening\.mjs --not-before=18/.test(sh), "夕方の呼び出しがありません");
  assert(/push-daily\.mjs --not-before=7/.test(sh), "朝の呼び出しが消えています");
  /* 引数が無いときは朝。配置と cron の変更は同時にできないので、
     行を書き換える前に置いても朝が止まらないようにしてある。 */
  assert(/WHICH="morning"/.test(sh), "既定が朝になっていません");
  /* 綴り違いを黙って朝として走らせない。 */
  assert(/使い方: push-cron\.sh/.test(sh), "知らない引数で止まりません");
  return "morning / evening";
});


console.log("\n[重複防止キー]  朝の鍵とぶつからない");

await check("同じ人・同じ日でも、朝と夕方で違う鍵になる", () => {
  /* ぶつかると、LINE 側が「もう送った」と見なして夕方が届かない。
     しかもこちらの記録には成功として残る。 */
  assert(retryKey(7, 4, "review") !== morningKey(7, 4, "learning"),
    "朝と夕方で同じ鍵になりました");
  return "learning ≠ review";
});

await check("同じ便なら、掛け直しても同じ鍵", () => {
  assert(retryKey(7, 4, "review") === retryKey(7, 4, "review"), "毎回変わります");
  const k = retryKey(7, 4, "review");
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(k), k);
  return k;
});


console.log("\n[届かなかったとき]");

await check("送信に失敗したら review として failed で残す", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, TARGET,
    { send: async () => { throw new Error("接続できません"); } });
  assert(r === "送信失敗", r);
  const log = conn.calls.find((c) => /INSERT INTO push_logs/i.test(c.sql));
  assert(log, "記録が残っていません");
  assert(/'failed'/.test(log.sql), log.sql.replace(/\s+/g, " "));
  assert(log.params.includes("review"), `種別: ${JSON.stringify(log.params)}`);
  return "review / failed";
});

await check("ブロックされた人は配信対象から外す", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, TARGET,
    { send: async () => { throw new LineApiError(403, "blocked", "/message/push"); } });
  assert(r === "届かない", r);
  assert(conn.sql().some((s) => /UPDATE users/i.test(s) && /unfollowed/.test(s)),
    "配信対象から外していません");
  return "403 → unfollowed";
});

await check("ふつうの障害では、対象から外さない", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, TARGET,
    { send: async () => { throw new LineApiError(500, "oops", "/message/push"); } });
  assert(r === "送信失敗", r);
  assert(!conn.sql().some((s) => /UPDATE users/i.test(s) && /unfollowed/.test(s)),
    "500 で配信対象から外しました");
  return "500 → 残す";
});

await check("1 人で落ちても例外を外へ出さない", async () => {
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, TARGET, { send: async () => { throw new Error("落ちました"); } });
  assert(typeof r === "string", "例外が外へ出ました");
  return "残りは配れる";
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
