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
import { TRIAL_DAYS, TRIAL_UPSELL_DAY, DELIVERY_UNLIMITED } from "../server/lib/repo/billing.mjs";
import { trialUpsellNotice } from "../server/lib/handlers/checkout.mjs";

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


console.log("\n[中身]  問いだけ届く ── 答えは押されてから（지시서⑨）");

const flexText = (m) => m.contents.body.contents[0].text;

await check("夕方の便は問い（Flex）1 通だけ ── 答えを同封しない", async () => {
  /* 2 通同時だと、携帯の画面で答えが問いのすぐ下に並び、
     思い出す間が作られない ── 이 개편의 목적 그 자체。 */
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, TARGET, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(msgs && msgs.length === 1, `${msgs ? msgs.length : 0} 通でした`);
  assert(msgs[0].type === "flex", msgs[0].type);
  assert(/ふりかえり/.test(msgs[0].altText), msgs[0].altText);
  const btn = msgs[0].contents.footer.contents[0].action;
  assert(btn.data === "action=answer&day=4", btn.data);
  return "問い 1 通 ＋ こたえを見る";
});

await check("問いに答えを混ぜない（意味・訳は押されるまで出ない）", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, TARGET, { send: async (_t, m) => { msgs = m; return {}; } });
  const q = flexText(msgs[0]);
  assert(q.includes("네") && !q.includes("はい"), `問いに意味が出ています: ${q}`);
  assert(q.includes("다나카예요") && !q.includes("たなかです"), `問いに訳が出ています: ${q}`);
  assert(!msgs[0].altText.includes("はい") && !msgs[0].altText.includes("たなかです"),
    "altText に答えが出ています（通知プレビューで台無し）");
  return "問いはハングルだけ";
});

await check("名前は夕方も差し込まれる（받침 の規則ごと）", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, TARGET, { send: async (_t, m) => { msgs = m; return {}; } });
  /* 다나카 は母音終わりなので 예요。받침 があれば 이에요。 */
  const q = flexText(msgs[0]);
  assert(q.includes("다나카예요"), q);
  assert(!/\{[A-Z_]+\}/.test(q + msgs[0].altText), "差し込み口が残っています");
  return "다나카예요";
});

await check("Flex の組み立てが落ちたら、テキスト 2 通へ降りる（§4-3）", async () => {
  /* 夕方が丸ごと止まるより、答えが同時に見えるほうが軽い。 */
  const conn = fakeConn(READY);
  let msgs = null;
  const r = await deliverOne(conn, TARGET, {
    send: async (_t, m) => { msgs = m; return {}; },
    renderQ: () => { throw new Error("わざと壊す"); }
  });
  assert(/送信:4日目/.test(r), r);
  assert(msgs && msgs.length === 2, `${msgs ? msgs.length : 0} 通でした`);
  assert(msgs.every((m) => m.type === "text"), "フォールバックがテキストではありません");
  assert(/こたえ/.test(msgs[1].text), "答えの通がありません");
  return "폴백 = 종전 2통";
});

console.log("\n[こたえを見る]  押した人にだけ・記録も消費もしない");

const { handlePostback } = await import("../server/lib/handlers/postback.mjs");
const ANSWER_ROW = [{ id: 7, line_user_id: "U_test", status: "active",
  active_track: "beginner", name_kanji: "田中", name_reading: "たなか",
  name_kr: "다나카", name_source: "web", display_name: "田中" }];

await check("押すと答えが 1 通返る ── 進みにも日数にも記録にも触れない", async () => {
  const conn = fakeConn({ "FROM users": ANSWER_ROW, "FROM content_templates": TPL });
  let sent = null;
  const r = await handlePostback(conn,
    { source: { userId: "U_test" }, replyToken: "rt",
      postback: { data: "action=answer&day=4" } },
    { send: async (_t, m) => { sent = m; return {}; } });
  assert(r.day === 4 && r.replied === true, JSON.stringify(r));
  assert(sent && sent.length === 1 && /こたえ/.test(sent[0].text), sent && sent[0].text);
  assert(sent[0].text.includes("다나카예요") && sent[0].text.includes("たなかです"),
    "答えの中身が組まれていません");
  assert(!conn.calls.some((c) => /UPDATE learning_progress|days_used/i.test(c.sql)),
    "答えで進み・日数に触りました（ボーナスの不変式）");
  assert(!conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql)),
    "押した事実を記録しています（無測定の原則 2026-08-04）");
  return "答え 1 通・書き込み 0";
});

await check("track は data から受けない ── 書き換えても active_track の原稿", async () => {
  /* data に track を載せて他コースの原稿（有料資産）を覗く道を
     作らない。 */
  const conn = fakeConn({ "FROM users": ANSWER_ROW, "FROM content_templates": TPL });
  await handlePostback(conn,
    { source: { userId: "U_test" }, replyToken: "rt",
      postback: { data: "action=answer&day=4&track=advanced" } },
    { send: async () => ({}) });
  const q = conn.calls.find((c) => /FROM content_templates/i.test(c.sql));
  assert(q && q.params[0] === "beginner", `track=${q && q.params[0]} で引きました`);
  return "active_track だけを信じる";
});

await check("answer 分岐は advanceDay・days_used・current_day・push_logs に触れない（ソース）", async () => {
  /* verify-evening は夕方バッチのソースしか見ていなかった ── 答えは
     postback.mjs を通るので、ここで**約束を機械に移す**（§3-1・§3-2）。 */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server/lib/handlers/postback.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  /* 以前は「次の分岐が現れるまで」を切っていたので、分岐の並び順に
     頼っていた。関数になったので境界は波かっこ ── 並べ替えても
     この検査は同じものを見る（plan-refactor-handlers.md §4.2.1）。 */
  const block = src.match(/async function onAnswer\b[\s\S]*?\n}/);
  assert(block, "answer の分岐が見つかりません");
  assert(!/advanceDay|days_used|current_day/.test(block[0]),
    "answer 분기가 진도·일수를 건드립니다");
  assert(!/push_logs|pushlogs\.|logSent|logFailed/.test(block[0]),
    "answer 분기가 누른 사실을 기록합니다（무측정 원칙）");
  return "소스에 없음 ── 사람의 약속이 아니라 관문";
});


console.log(`\n[体験 ${TRIAL_UPSELL_DAY} 日目の勧誘]  閉じていても送る ── ただし嘘は送らない`);

/* findDeliverable が返す形（DELIVERABLE_SQL + shape）。
   体験中・勧誘の日（TRIAL_UPSELL_DAY）。

   ★ 数字を直に書かない。3→7 のとき、ここが「2」のままだと検査は
   緑のまま通り、本番だけ勧誘が出なくなる（plan-trial-7days §7）。 */
const TRIAL_ROW = {
  id: 7, line_user_id: "U_test", display_name: "田中",
  name_kanji: "田中", name_reading: "たなか", name_kr: "다나카", name_source: "web",
  status: "trial", track: "beginner",
  current_day: TRIAL_UPSELL_DAY, days_used: TRIAL_UPSELL_DAY, current_semester: 1,
  days_entitled: TRIAL_DAYS, remaining: TRIAL_DAYS - TRIAL_UPSELL_DAY,
  ohaeng_main: "목", raw_result_json: null, birth_confirmed: 0
};
const DAY_UPSELL = { ...TARGET, day_number: TRIAL_UPSELL_DAY };
const SENT_UPSELL = `送信+勧誘:${TRIAL_UPSELL_DAY}日目`;
const SENT_ONLY   = `送信:${TRIAL_UPSELL_DAY}日目`;

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

/* 【2026-08-10 대표 확정 ── 勧誘から予告へ】
   体験の 7 日が終わるまで決済へ進ませない（checkout.mjs の inTrialNow）
   ので、ここは誰に対しても同じ**予告**になる。買える/買えないで文面が
   分かれていた 3 検査を、下の 2 つに置き換えた。 */
/* 【2026-08-16 ── 日数制限の一時解除】
   DELIVERY_UNLIMITED のあいだ、この予告は出さない。出すと 6 日目の
   夕方に「明日で体験が終わります」と言った翌朝に 8 日目が届く。

   検査は定数を読んで**両方の道を書いたまま**にする ── 解除中の分
   だけ書いて元を消すと、制限を戻す日に予告の約束（1 通・ボタン無し・
   日数不変・trial_end の記録）を誰も見張らなくなる。 */
await check("予告の有無は DELIVERY_UNLIMITED に従う", () =>
  withSales("open", async () => {
    const conn = fakeConn(upsellReady());
    let msgs = null;
    const r = await deliverOne(conn, DAY_UPSELL, { send: async (_t, m) => { msgs = m; return {}; } });

    if (DELIVERY_UNLIMITED) {
      assert(r === SENT_ONLY, `解除中なのに予告が出ました: ${r}`);
      assert(msgs.length === 1, `${msgs.length} 通でした（問いだけのはず）`);
      assert(!conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql) && c.params.includes("trial_end")),
        "出していないのに trial_end を記録しました ── 戻した日に 1 回きりが消費済みになります");
      return "解除中: 予告 0 通・記録も残さない";
    }

    assert(r === SENT_UPSELL, r);
    assert(msgs.length === 2, `${msgs.length} 通でした（問い 1 + 予告 1 のはず）`);
    const t = msgs[1].text;
    assert(/明日が最後の 1 日/.test(t), t);
    assert(/続きのご案内をお送りします/.test(t), t);
    /* 体験中は買えないのだから、押す所を置かない ── 置くと
       trialInProgress の壁に当たる（空振りするボタンを残さない）。 */
    assert(!msgs[1].quickReply, "体験中に買えないのに quickReply が付いています");
    assert(!/日数を追加できます/.test(t), `買える文面が残っています: ${t}`);
    assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
      "予告で日数が動きました ── ボーナスの不変式が崩れています");
    assert(conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql) && c.params.includes("trial_end")),
      "trial_end の記録がありません（通算 1 回の判定が壊れます）");
    return "制限中: 予告 1 通 / days_used 不変";
  }));

await check("販売の開閉・原稿の量で文面が変わらない（判定が 1 本であること）", async () => {
  /* 以前は salesAllowedFor と sellablePackages で 2 分岐していた。
     体験中は誰も買えないので、その 2 つを見る理由が消えた ── 分岐が
     戻ってくると、通らない側が腐ったまま残る。

     2026-08-16 から、文面そのもの（trialUpsellNotice）を直に呼んで
     比べる。配信経路ごしに取っていたが、解除中は予告が出ないので
     経路からは取れない ── 見たいのは「文面が env で分かれないこと」
     なので、そもそも経路を挟む必要が無かった。 */
  const textOf = async (mode, tplN) => withSales(mode, async () => {
    const conn = fakeConn(upsellReady({
      "SELECT COUNT\\(\\*\\) AS n FROM content_templates": [{ n: tplN }] }));
    await deliverOne(conn, DAY_UPSELL, { send: async () => ({}) });
    return trialUpsellNotice("beginner", { currentDay: TRIAL_UPSELL_DAY }).text;
  });
  const [open101, closed101, open3] =
    [await textOf("open", 50), await textOf("closed", 50), await textOf("open", 3)];
  assert(open101 === closed101 && open101 === open3,
    `文面が分かれています:\n--- open/50 ---\n${open101}\n--- closed/50 ---\n${closed101}\n--- open/3 ---\n${open3}`);
  /* 「整いましたらお知らせします」は書かない ── ただし「7 日分が
     終わったら送る」は書いてよい。残り 0 の朝に upsellNotice が
     実際に出るので、コードが約束を守っている（checkout.mjs）。 */
  assert(!/お知らせします/.test(open101), `能動通知を約束しています: ${open101}`);
  return "3 通りとも同じ予告";
});

await check("勧誘は通算 1 回だけ（trial_end の記録で二度目を止める）", () =>
  withSales("open", async () => {
    const conn = fakeConn(upsellReady({
      "SELECT COUNT\\(\\*\\) AS n FROM push_logs":
        (_sql, params) => [{ n: params.includes("trial_end") ? 1 : 0 }] }));
    let msgs = null;
    const r = await deliverOne(conn, DAY_UPSELL, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === SENT_ONLY, r);
    assert(msgs.length === 1, `${msgs.length} 通でした（問いだけのはず）`);
    return "trial_end=1 → 復習だけ";
  }));

await check("残り 0 の勧誘（upsell）とは数を分ける ── 互いに干渉しない", () =>
  withSales("open", async () => {
    /* 承認時の修正 2。同じ種別を共有して day_number で見分ける形だと、
       片方の入れ方が変わった日にもう片方の「1 回だけ」が黙って壊れる。
       upsell が何件あっても、trial_end が 0 なら勧誘の日には出る。 */
    const conn = fakeConn(upsellReady({
      "SELECT COUNT\\(\\*\\) AS n FROM push_logs":
        (_sql, params) => [{ n: params.includes("trial_end") ? 0 : 5 }] }));
    let msgs = null;
    const r = await deliverOne(conn, DAY_UPSELL, { send: async (_t, m) => { msgs = m; return {}; } });
    if (DELIVERY_UNLIMITED) {
      /* 解除中は予告そのものが出ないので、干渉のしようが無い。
         種別を分けてある（upsell / trial_end）ことは検査の設定側で
         保っている ── 戻した日にこの下の行がまた効く。 */
      assert(r === SENT_ONLY, r);
      return "解除中: 予告が出ないので干渉なし";
    }
    assert(r === SENT_UPSELL, r);
    assert(msgs.length === 2, `${msgs.length} 通でした`);
    return "upsell=5 でも trial_end=0 なら出る";
  }));

await check("体験でない人（購入者）には、勧誘の日でも勧誘しない", () =>
  withSales("open", async () => {
    const conn = fakeConn(upsellReady({
      "FROM users": [{ ...TRIAL_ROW, status: "active", days_entitled: 101, remaining: 99 }] }));
    let msgs = null;
    const r = await deliverOne(conn, DAY_UPSELL, { send: async (_t, m) => { msgs = m; return {}; } });
    assert(r === SENT_ONLY, r);
    assert(msgs.length === 1, `${msgs.length} 通でした`);
    return "trial 以外 → 復習だけ";
  }));

await check("勧誘の日以外の夕方は、勧誘の判定にすら入らない", async () => {
  /* TARGET は 4 日目。体験日数を変えて 4 が勧誘の日と重なると、この
     検査は「引き直さない」を確かめられないまま緑になる ── 重なった
     ことに気づけるよう、先に言う。 */
  assert(TARGET.day_number !== TRIAL_UPSELL_DAY,
    `TARGET の day_number が勧誘の日（${TRIAL_UPSELL_DAY}）と重なりました。`
    + "この検査は無意味になっています ── TARGET の日を動かしてください");
  const conn = fakeConn(READY);
  const r = await deliverOne(conn, TARGET, { send: async () => ({}) });
  assert(r === `送信:${TARGET.day_number}日目`, r);
  assert(!conn.sql().some((s) => /FROM users/i.test(s)),
    `${TARGET.day_number} 日目なのに 1 人ぶん引き直しています`);
  return `day ≠ ${TRIAL_UPSELL_DAY} → 引き直しなし`;
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

await check("勧誘の日を「2」で判定している所が、ソースに残っていない", async () => {
  /* §3-4 の「片方だけ直す」を止める唯一の装置。
     判定は :118（引き直すか）と :172（そもそも呼ぶか）の 2 か所で
     同じ日を二度見ており、片方だけ直すと ── 呼ばれないか、
     呼ばれても null が返る。どちらも**ログに何も出ないまま**
     勧誘が消える。誰も気づかず成約率だけ落ちる。 */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server/db/push-evening.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const stale = [
    [/current_day\)?\s*!==\s*2\b/,        "current_day を 2 と比べています"],
    [/\bday\s*===\s*2\b/,                 "day === 2 で勧誘を出しています"],
    [/dayNumber:\s*2\b/,                  "trial_end の記録に 2 を書いています"]
  ].filter(([re]) => re.test(src)).map(([, m]) => m);
  assert(!stale.length,
    `体験日数を変えても動かない判定が残っています: ${stale.join(" / ")}`);
  assert(/TRIAL_UPSELL_DAY/.test(src),
    "push-evening が TRIAL_UPSELL_DAY を見ていません");
  /* 「TRIAL_DAYS - 1」を現地で計算し直すのも、二つ目の出どころ。 */
  assert(!/TRIAL_DAYS\s*-\s*1/.test(src),
    "push-evening で TRIAL_DAYS - 1 を計算し直しています（出どころが 2 つになります）");
  return "判定 3 か所とも定数から";
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
