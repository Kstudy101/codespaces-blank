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
import { deliverOne, retryKey, tooEarly, tooLate, fortuneSection } from "../server/db/push-daily.mjs";
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

/* 3 日目まで進んでいて、101 日ぶん買っている人。
   始める前の 3 つ（名前・生年月日・コース）は答え終わっている ──
   答えていないと配信そのものが始まらないので、既定はこちら。
   答えていない側は、下の [始める前] でひとつずつ崩して見る。 */
const USER = {
  id: 7, line_user_id: "U_test",
  name_kanji: "田中", name_reading: "たなか", name_kr: "다나카",
  name_source: "web", track: "beginner",
  status: "active", current_day: 3, days_used: 3, current_semester: 1,
  /* 前払いの回数券（migrations/002）。残りは買った日数から
     使った日数を引く ── current_day では引かない。「1 日目から
     やり直す」で戻るのは current_day だけなので、そちらで数えると
     やり直した人の残りが復活する。 */
  days_entitled: 101,
  /* この講座は四柱で韓国語を教えるので、配信の対象を引くところから
     五行と干支が付いてくる（repo/users.mjs の listDeliverable）。 */
  ohaeng_main: "목", raw_result_json: { zodiac: "돼지" }
};

const TPL = [{
  day_number: 4, track: "beginner", semester: 1, grammar_point: "-예요 / -이에요",
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

await check("保有日数を超えたら本編は送らない。再購入の案内だけ 1 回（§3）", async () => {
  /* 台帳が新しく開く朝 ── 案内が 1 通、レッスンは 0 通。 */
  const conn = fakeConn(READY);
  let msgs = null;
  const r = await deliverOne(conn, { ...USER, days_entitled: 3, days_used: 3 },
    { send: async (_to, m) => { msgs = m; return {}; } });
  assert(r === "日数切れ", r);
  assert(msgs && msgs.length === 1, `送った数が ${msgs?.length}（案内 1 通のはず）`);
  assert(/日数/.test(msgs[0].text) && /続きから/.test(msgs[0].text),
    `案内の文面が違います: ${msgs[0].text.split("\n")[0]}`);
  assert(msgs[0].quickReply?.items?.some((i) => /action=plans/.test(i.action.data)),
    "受講料へ行くボタンがありません");
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "日を消費しています（この分岐は advanceDay の手前のはず）");
  assert(conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql) && c.params.includes("upsell")),
    "upsell の記録がありません");
  return "本編 0 / 案内 1・日数は減らない";
});

/* everSent / everFailed だけに当てる形。sentToday も
   status = 'sent' を含むので、隣接する day_number で見分ける
   （everSent の並びは day_number = ? AND status = 'sent'、
   countForDay は間に push_type が挟まるので当たらない）。 */
const EVER_SENT   = "day_number = \\? AND status = 'sent'";
const EVER_FAILED = "day_number = \\? AND status = 'failed'";

await check("落ちた日を再照準する ── 新しく確保せず、同じ日をもう一度", async () => {
  /* LINE 障害の朝: day 3 を確保（消費）→ 500 → failed。次の便は
     day 4 を確保するのではなく、day 3 を組み直して送る。 */
  const conn = fakeConn({
    "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 0 }],
    [EVER_SENT]:   [],                    /* day 3 は届いていない */
    [EVER_FAILED]: [{ id: 9 }],           /* 落ちた記録がある */
    "FROM push_logs": [],
    "FROM content_templates": [{ ...TPL[0], day_number: 3 }],
    "UPDATE learning_progress": { affectedRows: 1 }
  });
  let sentOpts = null;
  const r = await deliverOne(conn, USER,   /* current_day = 3 */
    { send: async (_to, _m, opts) => { sentOpts = opts; return {}; } });
  assert(r === "再送信:3日目", r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "再照準で日を確保しています ── 毎時 1 日の焼却が戻ってくる");
  assert(conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql) && c.params.includes(3)),
    "day 3 の sent 記録がありません");
  /* 失敗時と同じキー ── 「届いたのに記録前に死んだ」を LINE 側が弾く。 */
  assert(sentOpts && sentOpts.retryKey === retryKey(USER.id, 3, "learning"),
    "retryKey が失敗時と別物です");
  return "確保なし・消費なし・day 3 を同じキーで再送";
});

await check("届いた日は再照準しない（sent があれば通常の朝）", async () => {
  const conn = fakeConn({ [EVER_SENT]: [{ id: 5 }], ...READY });
  const r = await deliverOne(conn, USER, { send: sendOK() });
  assert(/送信:4日目/.test(r), r);
  assert(conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "通常の朝なのに日を確保していません");
  return "sent あり → 通常どおり 4 日目を確保して送る";
});

await check("原稿なしの failed では再照準しない（dayNumber が別物）", async () => {
  /* 原稿なし failed は dayNumber = next（確保**前**）で残る。
     再照準の条件は current_day（確保済み）なので当たらない。 */
  const conn = fakeConn({ [EVER_SENT]: [], [EVER_FAILED]: [], ...READY });
  const r = await deliverOne(conn, USER, { send: sendOK() });
  assert(/送信:4日目/.test(r), r);
  return "混ざらない ── 通常経路へ";
});

await check("再照準したくても原稿が引けなければ、降りる（次の日を確保しない）", async () => {
  const conn = fakeConn({
    "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 0 }],
    [EVER_SENT]:   [],
    [EVER_FAILED]: [{ id: 9 }],
    "FROM push_logs": [],
    "FROM content_templates": []          /* day 3 の原稿が消えている */
  });
  let sent = false;
  const r = await deliverOne(conn, USER, { send: async () => { sent = true; return {}; } });
  assert(!sent, "原稿が無いのに送りました");
  assert(r === "再送信待ち:3日目", r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "通常経路へ落ちて次の日を確保しています ── 届かない日が積み増される");
  return "送らない・確保しない・次の便を待つ";
});

await check("台帳が既に開いていれば、案内は二度と出ない（毎日スパム防止）", async () => {
  /* findOpen が行を返す ── openIfAbsent は created=false。 */
  const conn = fakeConn({ ...READY,
    "FROM lapse_log": [{ id: 5, user_id: 7, track: "beginner" }] });
  let sent = false;
  const r = await deliverOne(conn, { ...USER, days_entitled: 3, days_used: 3 },
    { send: async () => { sent = true; return {}; } });
  assert(!sent && r === "日数切れ", `${r} / 送信=${sent}`);
  return "エピソードにつき 1 回";
});

await check("体験の 3 日目までは送る（境界を 1 日ずらしていない）", async () => {
  const conn = fakeConn({ ...READY, "FROM content_templates": [{ ...TPL[0], day_number: 3 }] });
  let sent = false;
  await deliverOne(conn, { ...USER, current_day: 2, days_used: 2, days_entitled: 3 },
    { send: async () => { sent = true; return {}; } });
  assert(sent, "3 日ぶん持っている人の 3 日目が送られません");
  return "残り 1 → 3 日目まで";
});

await check("101 日を終えた人は進めない（修了の案内を 1 度だけ）", async () => {
  /* 前は何も送らずに数えるだけだった ── 101 日目の翌朝から、
     ただ静かに何も来なくなっていた。いまは修了を伝え、次のコースへ
     繋ぐ（lib/handlers/checkout.mjs の completionNotice）。 */
  const conn = fakeConn(READY);
  let sent = null;
  const r = await deliverOne(conn, { ...USER, current_day: 101, days_used: 101 },
    { send: async (_t, m) => { sent = m; return {}; } });
  assert(sent, "修了しても何も送っていません");
  assert(/修了/.test(r), r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)), "102 日目へ進めています");

  /* 2 度目は送らない。push_logs の completion で数える。 */
  const again = fakeConn({ ...READY,
    "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 1 }] });
  let sent2 = false;
  const r2 = await deliverOne(again, { ...USER, current_day: 101, days_used: 101 },
    { send: async () => { sent2 = true; return {}; } });
  assert(!sent2 && r2 === "修了済", `${r2} / 送信=${sent2}`);
  return "案内 1 回 → 以後は黙る";
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

console.log("\n[期限の予告]  体験中には出さない（plan-course-onboarding §5）");

await check("体験中（購入 0）の朝に「あと 2 日」を付けない", async () => {
  /* 体験 3 日は remaining 3→2 が初日に来る ── 抑制しないと、始めた
     直後の 1 通に期限の予告が付く。体験の締めは 2 日目の夕方の勧誘
     （trial_end、push-evening）が担う。 */
  const { EXPIRING_AT } = await import("../server/lib/handlers/checkout.mjs");
  const u = { ...USER, days_entitled: USER.days_used + EXPIRING_AT + 1 };
  const conn = fakeConn(READY);              /* purchases は空 ＝ 体験中 */
  let msgs = null;
  await deliverOne(conn, u, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(msgs, "送信が呼ばれていません");
  assert(!msgs.some((m) => /お預かりしている日数/.test(m.text)),
    "体験中なのに期限の予告が付いています");
  assert(!conn.calls.some((c) => /INSERT INTO push_logs/i.test(c.sql) && c.params.includes("expiring")),
    "出していない予告を記録しています");
  return "購入 0 → 予告なし";
});

await check("購入者の予告は現行のまま出る（抑制しすぎない）", async () => {
  const { EXPIRING_AT } = await import("../server/lib/handlers/checkout.mjs");
  const u = { ...USER, days_entitled: USER.days_used + EXPIRING_AT + 1 };
  const conn = fakeConn({ ...READY, "FROM purchases": [{ id: 1 }] });
  let msgs = null;
  await deliverOne(conn, u, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(msgs, "送信が呼ばれていません");
  assert(msgs.some((m) => /お預かりしている日数/.test(m.text)),
    "購入者への予告まで消えています");
  return "購入あり → 予告あり";
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

await check("日本の指定時刻を過ぎたら、何もしない（--not-after）", () => {
  /* 15 時に LINE が復旧して 15 時に「朝の講座」が届く、を商品として
     許さないための上限。境界は含む ── 9 時台までは送る。 */
  assert(tooLate(10, 9) === true,  "10 時に走ってしまいます");
  assert(tooLate(23, 9) === true,  "23 時に走ってしまいます");
  assert(tooLate(9, 9)  === false, "9 時ちょうどが送れません");
  assert(tooLate(7, 9)  === false, "7 時が送れません");
  return "10時/23時 → 止まる、9時/7時 → 走る";
});

await check("--not-after も、指定なし・不正値の扱いは --not-before と同じ", () => {
  assert(tooLate(15, null) === false && tooLate(15, undefined) === false, "指定なしで止まりました");
  for (const bad of [24, -1, "夕方", 9.5]) {
    let threw = false;
    try { tooLate(10, bad); } catch { threw = true; }
    assert(threw, `${bad} を受け取ってしまいました`);
  }
  return "なし → いつでも走る / 不正 4 通り → 通さない";
});

await check("朝の cron 行に --not-after が実際に入っている（지시서⑧ §2-2）", async () => {
  /* 재개 문면의 「あしたの朝 7 時から」를 참으로 유지하는 유일한
     장치. --not-before 만으로는 7~23시 매시 발송 ── 밤 10시 재개가
     밤 11시에 「아침 강좌」를 받는다. 고치는 곳은 push-cron.sh ──
     crontab 의 행은 .cpanel.yml 등록 루프가 존재 여부만 보므로,
     기존 서버에는 영원히 반영되지 않는다. */
  const { readFileSync } = await import("node:fs");
  const sh = readFileSync(new URL("../server/db/push-cron.sh", import.meta.url), "utf8");
  assert(/push-daily\.mjs --not-before=7 --not-after=9/.test(sh),
    "morning の行に --not-after=9 がありません");
  return "JST 7〜9 時台だけ配る";
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

console.log("\n[始める前]  名前が決まるまで、日を消費しない");

/* コースはもう段に無い（migrations/002）。買うときに選ぶので、
   バッチが止まるのは名前だけになった ── 名前が決まらないと
   会話文が作れず、その日の中身そのものが無い。 */
const NO_NAMESRC = { ...USER, name_source: null, display_name: "たなか" };

await check("コースが無い行では、例外にせず数えて降りる", async () => {
  /* listDeliverable は active_track で JOIN するので、ここに来ない
     はずの行。それでも throw すると main() が「処理中の異常」に数え、
     cron が毎朝失敗で終わる ── 本人には何も届かないのに、
     理由はどこにも出ない。 */
  const conn = fakeConn(READY);
  let sent = false;
  let r;
  try {
    r = await deliverOne(conn, { ...USER, track: null },
      { send: async () => { sent = true; return {}; } });
  } catch (e) {
    throw new Error(`例外で落ちました: ${e.message}`);
  }
  assert(r === "コース未選択", r);
  assert(!sent, "送りました");
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)), "日を進めました");
  return "数えて降りる";
});

await check("名前をどちらにするかは、選べる人にだけ訊く", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  const r = await deliverOne(conn, NO_NAMESRC, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(/name/.test(r), r);
  assert(msgs[0].text.includes("다나카") && msgs[0].text.includes("たなか"),
    `両方の名前を見せていません: ${msgs[0].text}`);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "名前が決まらないまま日を進めました");

  /* LINE の表示名が取れない人には訊かない ── 比べる相手が無く、
     答えようが無い質問になる。その人はそのまま進む。 */
  const noDisplay = fakeConn(READY);
  let sent = false;
  await deliverOne(noDisplay, { ...USER, name_source: null, display_name: null },
    { send: async () => { sent = true; return {}; } });
  assert(sent, "選択肢が無いのに止まりました");
  assert(noDisplay.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "選択肢が無いのに日を進めませんでした");
  return "表示名がある人だけ";
});

await check("生年月日の未確認では、レッスンを止めない", async () => {
  /* 止まるのは運勢だけ。ここで止めると、確かめていないというだけで
     レッスンが 1 日も届かなくなる。 */
  const conn = fakeConn(READY);
  let sent = false;
  await deliverOne(conn, { ...USER, birth_date: "1995-04-12", birth_confirmed: false },
    { send: async () => { sent = true; return {}; } });
  assert(sent, "レッスンまで止まりました");
  return "運勢だけ落ちる";
});

/* 生年月日は配信を止めない段なので、そこが返ってきたからといって
   バッチが待ってはいけない。nextStep は 1 つしか返さないので、
   止める段は別の口（blockingStep）で見ている ── そこを nextStep に
   戻すと、生年月日を飛ばした人がレッスンを受け取れなくなる。 */
await check("生年月日を飛ばした人でも、レッスンは進む", async () => {
  const conn = fakeConn(READY);
  let sent = false;
  const r = await deliverOne(conn,
    { ...USER, name_source: "web", birth_date: "1995-04-12", birth_confirmed: false },
    { send: async () => { sent = true; return {}; } });
  assert(sent, `止まりました: ${r}`);
  assert(/送信/.test(r), r);
  return "birth は止めない";
});

await check("促すのは 3 回まで（ブロックは取り消せない）", async () => {
  const conn = fakeConn({ ...READY, "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 3 }] });
  let sent = false;
  const r = await deliverOne(conn, NO_NAMESRC, { send: async () => { sent = true; return {}; } });
  assert(!sent, "4 回目を送りました");
  assert(/待ち/.test(r), r);
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)),
    "黙るときに日を進めました（あとから答えてもその日は戻りません）");
  return "n=3 → 黙る。進みは止めたまま";
});

/* 「LINEの名前で／べつの名前で」を選んで、読み仮名を送らないまま
   止まった人（name_source='line' かつ name_kr が空）。ここが
   blockingStep に掛からないあいだ、名前案内 2 回 → 沈黙で、
   誰も二度と訊かなかった ── しかも進みは止まったままなので、
   本人からは「急に何も来なくなった」としか見えない。 */
await check("読み仮名を待つ人には、読み方の質問を送り直す", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  const r = await deliverOne(conn,
    { ...USER, name_source: "line", name_kr: null, name_reading: null },
    { send: async (_t, m) => { msgs = m; return {}; } });
  assert(/reading/.test(r), `${r}（blockingStep が読み仮名待ちを見ていません）`);
  assert(msgs && /読み方/.test(msgs[0].text),
    `送った文面が読み方の質問ではありません: ${msgs ? msgs[0].text.split("\n")[0] : "（無し）"}`);
  /* 選び直しの画面を送ってはいけない ── もう選んだ人なので、
     もう一度選ばせると答えたはずの質問が戻ってくる。 */
  assert(!/お名前の確認/.test(msgs[0].text), "選び直し（askName）を送っています");
  assert(!conn.sql().some((s) => /UPDATE learning_progress/i.test(s)), "日を進めました");

  /* 促す上限は名前案内と同じ口（onboarding の回数）で数える。 */
  const capped = fakeConn({ ...READY, "SELECT COUNT\\(\\*\\) AS n FROM push_logs": [{ n: 3 }] });
  let sent = false;
  const r2 = await deliverOne(capped,
    { ...USER, name_source: "line", name_kr: null, name_reading: null },
    { send: async () => { sent = true; return {}; } });
  assert(!sent && /待ち/.test(r2), `${r2} / 送信=${sent}`);
  return "askReading を送り直す / 3 回で黙る";
});

console.log("\n[運勢]  3 通目。付かない日があっても、レッスンは止めない");

/* 生年月日まで確かめ終わっている人。 */
const WITH_SAJU = {
  ...USER,
  birth_date: "1995-04-12", birth_time: "09:30:00", birth_confirmed: true,
  raw_result_json: { zodiac: "돼지", city: "tokyo" }
};

/* 30 マス + 十神 10 の代わり。実物は server/content/ にあり
   公開リポジトリには無いので、形だけ同じものを渡す。 */
const CATS = ["total", "money", "love", "work", "health", "study"];
const GRADES = ["대길", "길", "중길", "소길", "말길"];
const SIPSIN = ["비견", "겁재", "식신", "상관", "편재", "정재", "편관", "정관", "편인", "정인"];
const FAKE_LINES = {
  cats: Object.fromEntries(CATS.map((c) => [c,
    Object.fromEntries(GRADES.map((g) => [g, { kr: `${c}-${g}-kr`, ja: `${c}-${g}-ja` }]))])),
  sipsin: Object.fromEntries(SIPSIN.map((s) => [s, { kr: `${s}-kr`, ja: `${s}-ja` }]))
};

console.log("\n[きょうの부적]  ボタンを押すまで作られない（지시서⑪）");

const { amuletSection, amuletInvite } = await import("../server/db/push-daily.mjs");
const { fortuneFor } = await import("../server/lib/fortune.mjs");
const { rankCats } = await import("../server/lib/fortune-text.mjs");
const { jstDate } = await import("../server/lib/jst.mjs");

await check("運勢の後ろに부적 Flex ── 願いはその日いちばん低い項目", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  const r = await deliverOne(conn, WITH_SAJU,
    { send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES });
  assert(/送信:4日目/.test(r), r);
  const fi = msgs.findIndex((m) => m.type === "text" && /오늘의 운세/.test(m.text));
  assert(fi >= 0, "運勢がありません");
  const am = msgs[fi + 1];
  assert(am && am.type === "flex", `運勢の次が부적ではありません: ${am && am.type}`);
  assert(am.altText === "🔮 きょうの特別なお守り", am.altText);
  /* altText に内容（どの項目か）を出さない（§4-4）。 */
  assert(!/金運|恋愛|仕事|健康|学習|money|love|work|health|study/.test(am.altText),
    `altText に내용이 새고 있습니다: ${am.altText}`);
  /* 願いは rankCats.bottom そのもの ── 本文の「いちばん低い」と同じ関数。 */
  const expected = rankCats(fortuneFor(WITH_SAJU, jstDate()).scores).bottom;
  const uri = am.contents.footer.contents[0].action.uri;
  assert(uri.endsWith(`/amulet?cat=${expected}`), `${uri}（bottom=${expected}）`);
  assert(am.contents.footer.contents[0].action.type === "uri", "1 タップで開く uri ではありません");
  return `cat=${expected}（bottom）・4 通目`;
});

await check("부적 URL には cat 以外を乗せない（생년월일・이름・id 금지）", async () => {
  const m = amuletInvite("money");
  const uri = m.contents.footer.contents[0].action.uri;
  assert(/\/amulet\?cat=money$/.test(uri), uri);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server/db/push-daily.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const fn = src.match(/export function amuletInvite[\s\S]*?\n}\n/)[0];
  assert(/\/amulet\?cat=\$\{cat\}/.test(fn), "uri の組み立てが cat だけではありません");
  assert(!/birth|name|u\.id|line_user_id/.test(fn), "부적 URL 에 개인정보가 실립니다");
  return "cat だけ ── privacy 改定不要の根拠";
});

await check("운세가 없는 아침엔 부적도 없다（맥락 없는 카드 금지）", async () => {
  /* USER 는 birth_date 없음 → fortuneSection null → 부적도 없음。 */
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, USER, { send: async (_t, m) => { msgs = m; return {}; } });
  assert(!msgs.some((m) => m.type === "flex"), "運勢なしで부적만 갔습니다");
  return "運勢が前提";
});

await check("부적 조립이 던져도 아침은 그대로 나간다（§4-5 폴백）", async () => {
  const conn = fakeConn(READY);
  let msgs = null;
  const r = await deliverOne(conn, WITH_SAJU, {
    send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES,
    amulet: () => { throw new Error("わざと壊す"); }
  });
  assert(/送信:4日目/.test(r), r);
  assert(msgs.some((m) => /오늘의 운세/.test(m.text || "")), "運勢まで消えました");
  assert(!msgs.some((m) => m.type === "flex"), "壊れた부적이 실렸습니다");
  return "운세・본문 정상、부적만 조용히 빠짐";
});

await check("예고와 절목이 겹친 아침(5통)은 부적이 쉰다 ── LINE 상한", async () => {
  /* 본문2+운세1+예고1+절목1 = 5。부적을 더하면 6 → push 전체가 400。 */
  const conn = fakeConn({ ...READY,
    "FROM content_templates": [{ ...TPL[0], day_number: 30,
      quiz: JSON.stringify({ question: "?", choices: ["a", "b", "c"], answer: 1 }) }],
    "FROM quiz_checkpoints": [{ day_number: 30 }],
    "FROM purchases": [{ id: 1 }]
  });
  const { EXPIRING_AT } = await import("../server/lib/handlers/checkout.mjs");
  const u = { ...WITH_SAJU, current_day: 29, days_used: 29,
              days_entitled: 29 + EXPIRING_AT + 1 };
  let msgs = null;
  const r = await deliverOne(conn, u,
    { send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES });
  assert(/送信:30日目/.test(r), r);
  assert(msgs.length === 5, `${msgs.length} 通（上限 5 のはず）`);
  assert(!msgs.some((m) => m.type === "flex"), "6 通目の부적이 실렸습니다");
  return "5 通のまま ── 부적은 그 아침만 쉼";
});

await check("確かめた生年月日の人には、運勢が付く", async () => {
  const m = fortuneSection(WITH_SAJU, { load: () => FAKE_LINES });
  assert(m && m.type === "text", JSON.stringify(m));
  assert(/총운/.test(m.text), m.text);
  assert(SIPSIN.some((s) => m.text.includes(`${s}-kr`)), `十神の一言がありません: ${m.text}`);
  return "総合運 + 十神";
});

await check("生年月日があれば運勢が付く（birth_confirmed は不要）", async () => {
  /* ウェブ連携で birth_date だけ入っている人にも運勢を付ける。
     LINE では生年月日を訊かないので、confirmed フラグは見ない。 */
  const m = fortuneSection({ ...WITH_SAJU, birth_confirmed: false },
    { load: () => FAKE_LINES });
  assert(m && m.type === "text", JSON.stringify(m));
  assert(/총운/.test(m.text), m.text);
  return "birth_date だけで付く";
});

await check("四柱が無い人にも付けない（既定の運勢を作らない）", async () => {
  const m = fortuneSection({ ...USER, birth_date: null }, { load: () => FAKE_LINES });
  assert(m === null, JSON.stringify(m));
  return "null";
});

await check("文面が未入稿なら、黙って落とす（レッスンは送る）", async () => {
  const m = fortuneSection(WITH_SAJU, { load: () => null });
  assert(m === null, JSON.stringify(m));

  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, WITH_SAJU,
    { send: async (_t, mm) => { msgs = mm; return {}; }, load: () => null });
  assert(msgs && msgs.length === 2, `${msgs ? msgs.length : 0} 通でした（運勢が付いています）`);
  return "レッスン 2 通だけ";
});

await check("運勢の読み込みが落ちても、レッスンは送る", async () => {
  const m = fortuneSection(WITH_SAJU,
    { load: () => { throw new Error("欠番があります"); } });
  assert(m === null, "例外が外へ出ました");
  return "例外を外へ出さない";
});

await check("運勢は 3 通目（レッスンの後ろ）", async () => {
  /* 文面は server/content/ にあり、公開リポジトリには無い。
     既定の読み込みに任せると、手元では 3 通・CI では 2 通になる
     ── 実際そうなって CI だけが落ちた。渡して固定する。 */
  const conn = fakeConn(READY);
  let msgs = null;
  await deliverOne(conn, WITH_SAJU,
    { send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES });
  assert(msgs.length === 4, `${msgs.length} 通でした（本文 2 + 運勢 + 부적）`);
  assert(/^📘 Day \d+ :/.test(msgs[0].text), `1 通目が本文ではありません: ${msgs[0].text.slice(0, 30)}`);
  assert(/총운/.test(msgs[2].text), `3 通目が運勢ではありません: ${msgs[2].text.slice(0, 30)}`);
  assert(msgs[3].type === "flex", `4 通目が부적ではありません（지시서⑪）: ${msgs[3].type}`);
  return "文法・単語・運勢・부적";
});

console.log("\n[bridge 이동（지시서㉑ §1-3）]  운세에서 빼고 레슨 최하단으로 ── 이중 출력 금지");

await check("bridge 는 운세 메시지에 더 이상 없다（fortuneSection 은 원고를 받지 않는다）", async () => {
  /* 시그니처 자체가 template 를 받지 않게 됐다 ── 어느 호출이 남아
     있어도 두 번째 인자는 옵션으로 읽혀 bridge 가 실릴 길이 없다.
     출력에서도 옛 구분선（──────────）이 사라졌는지 본다. */
  const m = fortuneSection(WITH_SAJU, { load: () => FAKE_LINES });
  assert(m && /총운/.test(m.text), "운세 자체가 사라졌습니다");
  assert(!/──────────/.test(m.text), "bridge 구분선이 남아 있습니다");
  return "운세는 운세만";
});

await check("bridge 가 있는 아침 ── 레슨 말미（🍀）에 1회만, 운세와 이중 출력 없음", async () => {
  const withBridge = [{ ...TPL[0],
    fortune_bridge: JSON.stringify({ kr: "오늘은 「예요」로 부드럽게.", ja: "今日は「예요」でやわらかく。" }) }];
  const conn = fakeConn({ ...READY, "FROM content_templates": withBridge });
  let msgs = null;
  const r = await deliverOne(conn, WITH_SAJU,
    { send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES });
  assert(/送信:4日目/.test(r), r);

  const all = msgs.map((m) => m.text || "").join("\n====\n");
  const hits = all.split("今日は「예요」でやわらかく。").length - 1;
  assert(hits === 1, `bridge.ja 가 ${hits}회 나왔습니다（1회여야 합니다）`);
  assert(all.includes("🍀 今日のひとこと"), "🍀 라벨이 없습니다");
  assert(!all.includes("오늘은 「예요」로 부드럽게"), "bridge.kr 이 화면에 나왔습니다");

  const fi = msgs.findIndex((m) => /오늘의 운세/.test(m.text || ""));
  assert(fi >= 0, "운세가 없습니다");
  assert(!/ひとこと|예요」でやわらかく/.test(msgs[fi].text), "운세 메시지에 bridge 가 실렸습니다");
  /* 구양식（pos 없음）이므로 🍀는 레슨 2통째 말미 ── 운세보다 앞. */
  const bi = msgs.findIndex((m) => (m.text || "").includes("🍀"));
  assert(bi >= 0 && bi < fi, `🍀 위치가 레슨이 아닙니다（msgs[${bi}]・운세 ${fi}）`);
  return "레슨에 1회・운세에 0회";
});

await check("신양식 평일 ── ❓ 꼬리통이 묶음 맨 끝（부적 뒤）에서 버튼을 연다", async () => {
  /* pos 있는 6어 + quiz + bridge. 4일째（3의 배수 아님）── ❓만.
     복습 뽑기는 돌지 않는다. */
  const NEWTPL = [{
    day_number: 4, track: "beginner", semester: 1,
    grammar_point: "-도（〜も）",
    grammar_tip_kr: "形　名詞 + 도\n使　「私も」— 同じであることを足す\n落　-은/는 と重ねられません",
    requires_name_slot: 1,
    dialogue_template: JSON.stringify([
      { kr: "저는 드라마를 좋아해요.", ja: "私はドラマが好きです。" },
      { kr: "{NAME_EUN} 어때요?", ja: "{NAME_JP}はどうですか。" },
      { kr: "저도 좋아해요.", ja: "私も好きです。" }
    ]),
    vocab_3: JSON.stringify([
      { kr: "드라마", meaning: "ドラマ", pos: "名詞" }, { kr: "노래", meaning: "歌", pos: "名詞" },
      { kr: "좋다", meaning: "よい", pos: "形容詞" }, { kr: "많다", meaning: "多い", pos: "形容詞" },
      { kr: "보다", meaning: "見る", pos: "動詞" }, { kr: "듣다", meaning: "聞く", pos: "動詞" }
    ]),
    quiz: JSON.stringify({ question: "「私も行きます」は？", choices: ["저는도 가요", "저도 가요"], answer: 1 }),
    fortune_bridge: JSON.stringify({ kr: "「나도」라고 말해 보세요.", ja: "「私も」と言ってみましょう。" })
  }];
  const conn = fakeConn({ ...READY, "FROM content_templates": NEWTPL });
  let msgs = null;
  const r = await deliverOne(conn, { ...WITH_SAJU, current_day: 3, days_used: 3 },
    { send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES });
  assert(/送信:4日目/.test(r), r);

  assert(msgs.length === 5, `${msgs.length} 통（1·2통+운세+부적+❓ = 5）`);
  const last = msgs[msgs.length - 1];
  assert(last.quickReply?.items?.every((i) => /^action=review&day=4&choice=\d$/.test(i.action.data)),
    `말미가 ❓ 꼬리통이 아닙니다: ${JSON.stringify(last.quickReply?.items?.[0]?.action || last.type)}`);
  assert(/❓ 今日のクイズ/.test(last.text), "❓ 헤더가 없습니다");
  assert(/🍀 今日のひとこと\n「私も」と言ってみましょう。$/.test(last.text), "🍀 가 꼬리통 말미에 없습니다");
  assert(msgs.findIndex((m) => /오늘의 운세/.test(m.text || "")) < msgs.length - 1, "운세가 꼬리통 뒤에 있습니다");
  assert(msgs.some((m) => m.type === "flex"), "부적이 빠졌습니다（5통 이내인데）");
  assert(!conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "평일 신양식에 복습 뽑기가 돌았습니다");
  return "5통・❓ 말미・복습 쉼";
});

await check("신양식 3의 배수 ── ❓를 접고 🔁 복습만（A안）", async () => {
  const NEWTPL = [{
    day_number: 6, track: "beginner", semester: 1,
    grammar_point: "-도（〜も）",
    grammar_tip_kr: "形　名詞 + 도\n使　「私も」— 同じであることを足す\n落　-은/는 と重ねられません",
    requires_name_slot: 1,
    dialogue_template: JSON.stringify([
      { kr: "저는 드라마를 좋아해요.", ja: "私はドラマが好きです。" },
      { kr: "{NAME_EUN} 어때요?", ja: "{NAME_JP}はどうですか。" },
      { kr: "저도 좋아해요.", ja: "私も好きです。" }
    ]),
    vocab_3: JSON.stringify([
      { kr: "드라마", meaning: "ドラマ", pos: "名詞" }, { kr: "노래", meaning: "歌", pos: "名詞" },
      { kr: "좋다", meaning: "よい", pos: "形容詞" }, { kr: "많다", meaning: "多い", pos: "形容詞" },
      { kr: "보다", meaning: "見る", pos: "動詞" }, { kr: "듣다", meaning: "聞く", pos: "動詞" }
    ]),
    quiz: JSON.stringify({ question: "「私も行きます」は？", choices: ["저는도 가요", "저도 가요"], answer: 1 }),
    fortune_bridge: JSON.stringify({ kr: "「나도」라고 말해 보세요.", ja: "「私も」と言ってみましょう。" })
  }];
  const conn = fakeConn({
    ...READY,
    "FROM content_templates": NEWTPL
  });
  let msgs = null;
  const r = await deliverOne(conn, { ...WITH_SAJU, current_day: 5, days_used: 5 },
    { send: async (_t, m) => { msgs = m; return {}; }, load: () => FAKE_LINES });
  assert(/送信:6日目/.test(r), r);

  assert(msgs.length === 5, `${msgs.length} 통（1·2통+운세+부적+🔁 = 5）`);
  const last = msgs[msgs.length - 1];
  assert(/🔁 復習クイズ/.test(last.text), `말미가 🔁 이 아닙니다: ${String(last.text || "").split("\n")[0]}`);
  assert(!/❓ 今日のクイズ/.test(msgs.map((m) => m.text || "").join("\n")),
    "3의 배수인데 데일리 ❓가 남았습니다");
  assert(conn.sql().some((s) => /quiz IS NOT NULL/i.test(s)),
    "복습 뽑기가 돌지 않았습니다");
  assert(last.quickReply?.items?.length >= 2, "복습 버튼이 없습니다");
  /* 🍀 는 레슨 쪽（❓ 꼬리통이 없으므로 2통 말미）. */
  assert(msgs.some((m) => /🍀 今日のひとこと/.test(m.text || "")), "🍀 가 빠졌습니다");
  return "5통・🔁 말미・❓ 접힘";
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
