#!/usr/bin/env node
/* ==================================================================
   verify-webhook.mjs — LINE Webhook 受け口（P2）

     使い方:  node tools/verify-webhook.mjs

   verify-server.mjs と同じく、MySQL も npm install も要らない。
   ハンドラは conn を受け取るだけなので偽物を渡せる。

   見張っているのは、通ってしまうと取り返しがつかないもの:

     1 署名     生のバイト列で計算する / 時間差で漏らさない /
                合わない要求を通さない ── ここが唯一の境界
     2 順番     署名を確かめる前に本文を解釈しない
     3 落ちない 1 件のイベントが失敗しても、同じ便の他を巻き込まない
     4 再送     同じイベントが二度来ても結果が変わらない
     5 postback data の中身を信じない（正答を data から読まない）
     6 退会     文面では止めない。ブロックされたときだけ外す

   5 は静かに壊れる。data はいったん利用者の端末を通って戻るので、
   正答番号を入れておくと押す前に書き換えれば必ず正解になる。
   画面上は「正解しました」としか見えない。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const acheck = async (label, fn) => {
  try { const d = await fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const { verifyLineSignature, computeLineSignature } =
  await import("../server/lib/signature.mjs");
const { handleWebhookBody, handleEvent, HANDLED_TYPES } =
  await import("../server/lib/webhook.mjs");
const { parsePostbackData, handlePostback } =
  await import("../server/lib/handlers/postback.mjs");
const { isVerifyToken } = await import("../server/lib/handlers/message.mjs");

const SECRET = "test_channel_secret";
const sign = (body) => computeLineSignature(Buffer.from(body, "utf8"), SECRET);

/* repo を通らない偽の接続。handlers は repo 経由でしか DB に触らない
   ので、SQL の種類で必要な行だけ返す。 */
function fakeConn(rows = {}) {
  const calls = [];
  return {
    calls,
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

const USER_ROW = [{ id: 7, line_user_id: "U_test", status: "active", name_kr: "다나카" }];


/* ================================================================== */
head("[署名]  ここが唯一の境界。通ってしまえば以降は本物として扱う");

check("正しい署名は通る", () => {
  const body = JSON.stringify({ events: [] });
  assert(verifyLineSignature(Buffer.from(body, "utf8"), sign(body), SECRET), "通りませんでした");
  return "OK";
});

check("本文が 1 バイトでも違えば通らない", () => {
  const body = JSON.stringify({ events: [] });
  const s = sign(body);
  assert(!verifyLineSignature(Buffer.from(body + " ", "utf8"), s, SECRET), "空白 1 つで通りました");
  return "拒否";
});

check("別のシークレットで作った署名は通らない", () => {
  const body = JSON.stringify({ events: [{ type: "follow" }] });
  const other = crypto.createHmac("sha256", "wrong").update(body).digest("base64");
  assert(!verifyLineSignature(Buffer.from(body, "utf8"), other, SECRET), "通りました");
  return "拒否";
});

check("署名が無い・空・型違いは通らない", () => {
  const raw = Buffer.from("{}", "utf8");
  for (const v of [undefined, null, "", 0, {}, []]) {
    assert(!verifyLineSignature(raw, v, SECRET), `${JSON.stringify(v)} が通りました`);
  }
  return "6 通りとも拒否";
});

check("長さの違う署名で例外にならない（timingSafeEqual は投げる）", () => {
  const raw = Buffer.from("{}", "utf8");
  let threw = false;
  try {
    assert(!verifyLineSignature(raw, "short", SECRET), "短い署名が通りました");
  } catch (e) { threw = /length/i.test(e.message); }
  assert(!threw, "長さ違いで例外になりました。500 を返すと攻撃者に情報が出ます");
  return "false を返す";
});

check("=== ではなく timingSafeEqual で比べる", () => {
  const src = stripComments(read("server/lib/signature.mjs"));
  assert(/timingSafeEqual/.test(src),
    "文字列比較です。何文字目で違ったかが所要時間に出るので、総当たりで署名を組み立てられます");
  assert(!/===\s*headerValue|headerValue\s*===/.test(src), "=== で比べている箇所があります");
  return "crypto.timingSafeEqual";
});

check("base64 で作る（hex ではない）", () => {
  const s = computeLineSignature(Buffer.from("{}", "utf8"), SECRET);
  assert(/^[A-Za-z0-9+/]+=*$/.test(s), `base64 に見えません: ${s}`);
  assert(s.length === 44, `${s.length} 文字（SHA-256 の base64 は 44 文字）`);
  return `44 文字 base64`;
});

check("文字列を渡したら投げる（再シリアライズを防ぐ）", () => {
  let threw = false;
  try { verifyLineSignature('{"a":1}', "x", SECRET); } catch { threw = true; }
  assert(threw, "文字列を受け付けました。JSON を組み直すと署名が合わなくなります");
  return "Buffer のみ";
});

check("シークレット未設定なら投げる（素通ししない）", () => {
  let threw = false;
  try { verifyLineSignature(Buffer.from("{}"), "x", ""); } catch { threw = true; }
  assert(threw, "シークレット無しで判定しました");
  return "例外";
});


/* ================================================================== */
head("[順番]  署名を確かめる前に本文を解釈しない");

const APP = stripComments(read("server/app.mjs"));

check("JSON.parse は verifyLineSignature より後にある", () => {
  const v = APP.indexOf("verifyLineSignature");
  const p = APP.indexOf("JSON.parse");
  assert(v > 0, "署名検証を呼んでいません");
  assert(p > v, "署名を確かめる前に JSON を解釈しています");
  return "verify → parse";
});

check("生のバイト列で読む（Buffer.concat）", () => {
  assert(/Buffer\.concat/.test(APP), "本文を文字列で組み立てています");
  assert(!/setEncoding/.test(APP), "setEncoding を使うと Buffer で受け取れません");
  return "Buffer のまま";
});

check("本文に上限がある", () => {
  assert(/MAX_BODY/.test(APP), "上限がありません。誰でも POST できる口です");
  assert(/413/.test(APP), "上限超過の応答がありません");
  return "1MB / 413";
});

check("シークレット未設定なら webhook を止める", () => {
  assert(/LINE_CHANNEL_SECRET[\s\S]{0,200}?return send\(res, 500/.test(APP),
    "未設定でも処理を続けています。誰でも通る状態になります");
  return "500 で拒否";
});

/* import 行や別の関数を拾わないよう、onWebhook の中だけを見る。
   ここを緩く見ると「順番が正しい」が import の位置で成立してしまう。 */
const ON_WEBHOOK = (() => {
  const at = APP.indexOf("async function onWebhook");
  assert(at > 0, "onWebhook が見つかりません");
  const end = APP.indexOf("\nasync function onHealth", at);
  return APP.slice(at, end > 0 ? end : undefined);
})();

check("署名不一致のときに本文をログへ出さない", () => {
  const call = ON_WEBHOOK.match(/logErr\("署名が一致しません"[^;]*;/);
  assert(call, "署名不一致を記録していません");
  assert(!/raw\.toString|JSON\.stringify|\braw\b(?!\.length)/.test(call[0]),
    `本文をログに出しています ── ${call[0]}`);
  return "IP とバイト数のみ";
});

check("署名を確かめてから 200 を返し、処理は後ろに回す", () => {
  const verifyAt = ON_WEBHOOK.indexOf("verifyLineSignature");
  const okAt = ON_WEBHOOK.indexOf('send(res, 200, "OK")');
  const handleAt = ON_WEBHOOK.indexOf("handleWebhookBody(");
  assert(verifyAt > 0 && okAt > verifyAt, "署名を確かめる前に 200 を返しています");
  assert(handleAt > okAt,
    "処理を待ってから返しています。混雑時に間に合わず、同じイベントが再送されます");
  return "verify → 200 → 処理";
});


/* ================================================================== */
head("[振り分け]  4 種を受ける。1 件の失敗で便ごと落とさない");

check("受ける種類は follow / unfollow / message / postback", () => {
  assert(HANDLED_TYPES.length === 4, HANDLED_TYPES.join(", "));
  return HANDLED_TYPES.join(" / ");
});

await acheck("知らない種類は捨てるが、捨てたことは残す", async () => {
  const r = await handleEvent(fakeConn(), { type: "memberJoined" });
  assert(r.skipped, "黙って捨てました");
  assert(r.type === "memberJoined", r.type);
  return "skipped で返す";
});

await acheck("1 件が投げても、同じ便の残りは処理される", async () => {
  const conn = fakeConn({ "FROM users": USER_ROW });
  const results = await handleWebhookBody(conn, {
    events: [
      { type: "postback" },                                    // userId 無し → skipped
      { type: "message", source: { userId: "U_test" }, message: { type: "sticker" } },
      { type: "unfollow", source: { userId: "U_test" } }
    ]
  });
  assert(results.length === 3, `${results.length} 件しか返りませんでした`);
  assert(results[2].type === "unfollow", "最後まで届いていません");
  return "3 件とも結果あり";
});

await acheck("ハンドラの例外は結果に混ぜて返す（throw で止めない）", async () => {
  const conn = {
    async execute() { throw new Error("DB が落ちています"); }
  };
  const results = await handleWebhookBody(conn, {
    events: [{ type: "unfollow", source: { userId: "U_test" } },
             { type: "unfollow", source: { userId: "U_other" } }]
  });
  assert(results.length === 2, `${results.length} 件`);
  assert(results.every((r) => r.error), JSON.stringify(results));
  return "2 件とも error として返る";
});

await acheck("events が無い・配列でない本文でも落ちない", async () => {
  for (const body of [{}, { events: null }, { events: "x" }, null]) {
    const r = await handleWebhookBody(fakeConn(), body);
    assert(Array.isArray(r) && r.length === 0, JSON.stringify(body));
  }
  return "4 通りとも空配列";
});

check("イベントは直列に処理する（順番が入れ替わらない）", () => {
  const src = stripComments(read("server/lib/webhook.mjs"));
  assert(!/Promise\.all/.test(src),
    "並列にしています。同じ人の follow と message の順が入れ替わりえます");
  assert(/for\s*\(const event of events\)/.test(src), "直列のループがありません");
  return "for … of";
});


/* ================================================================== */
head("[再送]  同じイベントが二度来ても結果が変わらない");

await acheck("follow を 2 回処理しても体験は 1 回だけ", async () => {
  let inserted = 0;
  const conn = fakeConn({
    "INSERT INTO users": () => {
      if (inserted++ === 0) return { affectedRows: 1, insertId: 7 };
      throw Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY", errno: 1062 });
    },
    "INSERT INTO subscriptions": () => {
      throw Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY", errno: 1062 });
    },
    "FROM users": USER_ROW,
    "FROM subscriptions": [{ user_id: 7, total_days_entitled: 3, payment_status: "trial" }]
  });
  const ev = { type: "follow", source: { userId: "U_test" } };
  const a = await handleEvent(conn, ev);
  const b = await handleEvent(conn, ev);
  assert(a.trialStarted === false && b.trialStarted === false,
    `体験が始まりました: ${a.trialStarted} / ${b.trialStarted}`);
  return "2 回とも延びない";
});

check("再送を弾く表を作っていない（何度でも同じ結果で足りる）", () => {
  const src = stripComments(read("server/lib/webhook.mjs"));
  assert(!/webhook_events|processed_events/.test(src),
    "処理済み表を足しています。貯めたものを消す仕組みまで要ります");
  return "冪等なハンドラで済ませる";
});


/* ================================================================== */
head("[postback]  data は利用者の端末を通って戻る ── 中身を信じない");

check("data を URLSearchParams で読む（自前 split ではない）", () => {
  const r = parsePostbackData("action=quiz&day=30&choice=2");
  assert(r.action === "quiz", r.action);
  assert(r.params.day === "30" && r.params.choice === "2", JSON.stringify(r.params));
  const r2 = parsePostbackData("quiz&day=50&choice=1");
  assert(r2.action === "quiz", `キー無しの書き方が読めません: ${r2.action}`);
  return "両方の書き方に対応";
});

check("空・null の data で落ちない", () => {
  for (const v of [null, undefined, "", 123, {}]) {
    const r = parsePostbackData(v);
    assert(r.action === null, `${JSON.stringify(v)} → ${r.action}`);
  }
  return "5 通りとも null";
});

check("正答を data から読まない ── 読むと必ず正解にできる", () => {
  const src = stripComments(read("server/lib/handlers/postback.mjs"));
  const fn = src.match(/export async function handlePostback[\s\S]*?\n}/)[0];
  assert(!/params\.(answer|correct)/.test(fn),
    "data から正答を読んでいます。押す前に書き換えれば必ず正解になります");
  assert(/lookupAnswer/.test(fn), "サーバー側から正答を引いていません");
  return "サーバー側だけが正答を知る";
});

await acheck("節目でない日を名乗られても採点しない", async () => {
  const conn = fakeConn({
    "FROM users": USER_ROW,
    "FROM quiz_checkpoints": []          // 31 日目は節目でない
  });
  const r = await handlePostback(conn, {
    source: { userId: "U_test" },
    postback: { data: "action=quiz&day=31&choice=1" }
  });
  assert(r.skipped && /節目/.test(r.skipped), JSON.stringify(r));
  assert(!conn.calls.some((c) => /UPDATE learning_progress/.test(c.sql)),
    "採点してしまいました");
  return "採点しない";
});

await acheck("正答が未入稿なら「不正解」にせず pending で返す", async () => {
  const conn = fakeConn({
    "FROM users": USER_ROW,
    "FROM quiz_checkpoints": [{ day_number: 30 }],
    "FROM content_templates": [{ day_number: 30, semester: 1 }]
  });
  const r = await handlePostback(conn, {
    source: { userId: "U_test" },
    postback: { data: "action=quiz&day=30&choice=2" }
  });
  assert(r.pending, JSON.stringify(r));
  assert(!conn.calls.some((c) => /UPDATE learning_progress/.test(c.sql)),
    "採点していません、と言いながら書き込みました");
  return "pending";
});

await acheck("未登録の利用者は採点しない", async () => {
  const conn = fakeConn({ "FROM users": [] });
  const r = await handlePostback(conn, {
    source: { userId: "U_unknown" },
    postback: { data: "action=quiz&day=30&choice=1" }
  });
  assert(r.skipped && /未登録/.test(r.skipped), JSON.stringify(r));
  return "skipped";
});


/* ================================================================== */
head("[メッセージ]  文面で退会させない / ダミーの replyToken に返さない");

check("「検証」ボタンのダミー replyToken を見分ける", () => {
  assert(isVerifyToken("00000000000000000000000000000000"), "見分けられません");
  assert(!isVerifyToken("abcdef0123456789"), "本物を弾きました");
  return "0 が並んだもの";
});

check("解約の文面で status を変えない", () => {
  const src = stripComments(read("server/lib/handlers/message.mjs"));
  assert(!/setStatus|markUnfollowed|deleteUser/.test(src),
    "文面から退会させています。言い回しの取り違えで、買った人を止めます");
  return "案内するだけ";
});

await acheck("スタンプ・画像には応えない", async () => {
  const conn = fakeConn({ "FROM users": USER_ROW });
  const { handleMessage } = await import("../server/lib/handlers/message.mjs");
  const r = await handleMessage(conn, {
    source: { userId: "U_test" }, message: { type: "sticker" }, replyToken: "t"
  });
  assert(r.skipped, JSON.stringify(r));
  return "skipped";
});

await acheck("心当たりの無い文面には返さない（通知を増やさない）", async () => {
  const conn = fakeConn({ "FROM users": USER_ROW });
  const { handleMessage } = await import("../server/lib/handlers/message.mjs");
  const r = await handleMessage(conn, {
    source: { userId: "U_test" }, message: { type: "text", text: "ありがとう" }, replyToken: "t"
  });
  assert(r.replied === false, JSON.stringify(r));
  return "既読のまま";
});


/* ================================================================== */
head("[友だち追加]  名前が無い人を、そのまま放り出さない");

const NAMELESS = [{ id: 7, line_user_id: "U_new", status: "trial", name_kr: null }];
const NAMED    = [{ id: 8, line_user_id: "U_old", status: "active", name_kr: "다나카" }];

async function follow(rows, extra = {}) {
  const conn = fakeConn({ "FROM users": rows });
  const { handleFollow } = await import("../server/lib/handlers/follow.mjs");
  let sent = null;
  const r = await handleFollow(conn,
    { source: { userId: rows[0].line_user_id }, replyToken: "t" },
    { reply: async (_t, m) => { sent = m; return {}; },
      profile: async () => ({ displayName: "テスト" }), ...extra });
  return { r, sent, conn };
}

await acheck("名前が無い人には、診断への案内を返す", async () => {
  /* 1 日目から名前を使うので、名前が入るまで講座は進まない。
     黙っていると、翌朝いきなり「お名前を登録してください」だけが
     届いて、何のことか分からないまま体験が終わる。 */
  const { r, sent } = await follow(NAMELESS);
  assert(sent, "何も返していません");
  assert(/kstudy101/.test(sent[0].text), "診断ページの場所が入っていません");
  assert(/お名前/.test(sent[0].text), "名前のことに触れていません");
  assert(r.welcomed === true, JSON.stringify(r));
  return "サイトへ案内";
});

await acheck("名前がある人には返さない（サイトから来た人）", async () => {
  const { r, sent } = await follow(NAMED);
  assert(sent === null, `送ってしまいました: ${JSON.stringify(sent)}`);
  assert(r.welcomed === false, JSON.stringify(r));
  return "重ねて案内しない";
});

await acheck("返信できなくても、友だち追加は成立する", async () => {
  /* ここで throw すると LINE が webhook を失敗とみなして掛け直し、
     同じ人の追加処理が何度も走る。 */
  const { r } = await follow(NAMELESS, { reply: async () => { throw new Error("落ちた"); } });
  assert(r.userId, "利用者が作られていません");
  assert(r.welcomed === false, JSON.stringify(r));
  return "体験と進捗は用意される";
});


/* ================================================================== */
head("[依存]  P1 の約束を崩していない");

check("外部パッケージを読むのは lib/db.mjs だけのまま", () => {
  /* node_modules は見ない。見たいのは「自分で書いた分」であって、
     依存の中身ではない。ここを除いていなかったため、npm ci を
     走らせた環境でだけ mysql2 の内部ファイルを違反として挙げていた ──
     本番（ChemiCloud）では必ず入るので、CI が通って本番だけ落ちる形。 */
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
    }
  })("server");

  const imports = (f) => [
    ...stripComments(read(f)).matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)
  ].map((m) => m[1]).filter((s) => !s.startsWith(".") && !s.startsWith("node:"));

  const offenders = files.filter((f) => imports(f).length && !f.endsWith("db.mjs"));
  assert(!offenders.length, `${offenders.join(", ")} が外部パッケージを読んでいます`);
  return `${files.length} ファイル中 1`;
});

check("HTTP は node:http。フレームワークを入れていない", () => {
  assert(/from "node:http"/.test(APP), "node:http を使っていません");
  return "依存 0";
});

check("LINE API は fetch で叩く（SDK 無し）", () => {
  const src = stripComments(read("server/lib/line.mjs"));
  assert(/fetch\(/.test(src), "fetch を使っていません");
  assert(!/@line\/bot-sdk/.test(src), "SDK を読んでいます");
  assert(/AbortSignal\.timeout/.test(src),
    "タイムアウトがありません。応答が返らないと配信バッチが止まります");
  return "fetch + 10 秒で打ち切り";
});

check("4xx は掛け直さない（5xx / 429 だけ）", () => {
  const src = stripComments(read("server/lib/line.mjs"));
  assert(/RETRIABLE/.test(src), "再試行の対象を分けていません");
  assert(/429/.test(src) && /503/.test(src), "429 / 503 が対象に入っていません");
  assert(!/RETRIABLE[\s\S]{0,80}400/.test(src),
    "400 を掛け直しています。文面の作り間違いでレート制限を使い切ります");
  return "429 / 5xx のみ";
});

check("cPanel の起動ファイルは CommonJS のまま", () => {
  const pkg = JSON.parse(read("server/package.json"));
  assert(pkg.type !== "module",
    '"type": "module" があると app.js が ESM になり、require で読む Passenger が起動に失敗します');
  assert(pkg.main === "app.js", `main が ${pkg.main} です`);
  assert(/import\(/.test(read("server/app.js")), "app.js が動的 import を使っていません");
  return "app.js (CJS) → app.mjs (ESM)";
});


console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
