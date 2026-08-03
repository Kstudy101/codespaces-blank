/* ==================================================================
   check-line.mjs — LINE 側の設定を、LINE に訊く

     node db/with-env.mjs db/check-line.mjs

   webhook の URL を登録したかどうかは、こちら側からは分からない。
   届いていないとき、原因は 3 つに分かれる:

     ・URL がまだ登録されていない
     ・登録されているが「Use webhook」が切れている
     ・登録も有効も済んでいて、こちらが弾いている

   3 つ目だけがこちらの問題で、前の 2 つは LINE Developers の
   画面の話。ログを眺めても区別がつかない ── どれも「何も来ない」
   としか見えないため。LINE の API に直接訊いて分ける。

   /channel/webhook/test は LINE から実際に 1 回叩かせる。
   自分で curl しても分からないこと（LINE から見て到達するか）が
   ここで分かる。テスト用のイベントなので、利用者には何も届かない。

   【cPanel の配置手順からは呼べない】
   .cpanel.yml のタスクとして走らせると fetch がこう言って落ちる:

     RangeError: WebAssembly.Instance(): Out of memory:
                 Cannot allocate Wasm memory for new instance

   Node の fetch（undici）は HTTP の解析に WebAssembly を使う。
   その割り当てぶんが、cPanel のタスク実行が置かれている枠に
   収まらない。cron から走らせれば同じコードが通るので、
   コードではなく走らせる場所の問題。

   配信バッチが動くのは cron の側なので、発信そのものには影響しない。
   ただし「配置のついでに外の API を叩く」は、この環境ではできない。
   ================================================================== */
const BASE = process.env.LINE_API_BASE || "https://api.line.me/v2/bot";
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!token) {
  console.error("✗ LINE_CHANNEL_ACCESS_TOKEN がありません。");
  console.error("  cPanel → Setup Node.js App → Environment variables で確認してください。");
  process.exit(1);
}

async function ask(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* そのまま出す */ }
  return { status: res.status, json, text };
}

let bad = 0;

/* ---- どのアカウントの話か ---------------------------------------- */
const info = await ask("/info");
if (info.status === 200) {
  console.log(`アカウント : ${info.json.displayName ?? "?"}  (${info.json.basicId ?? "?"})`);
  console.log(`種別       : ${info.json.chatMode ?? "?"} / 自動応答 ${info.json.markAsReadMode ?? "?"}`);
} else {
  console.log(`✗ /info が ${info.status}: ${info.text.slice(0, 200)}`);
  console.log("  トークンが違うか、期限切れです。");
  process.exit(1);
}

/* ---- webhook の登録 ----------------------------------------------- */
const ep = await ask("/channel/webhook/endpoint");
console.log("");
if (ep.status === 404) {
  console.log("✗ webhook の URL がまだ登録されていません。");
  console.log("  LINE Developers → Messaging API → Webhook URL に入れてください:");
  console.log("    https://api.kstudy101.jp/line/webhook");
  bad++;
} else if (ep.status !== 200) {
  console.log(`✗ 登録の確認に失敗 (${ep.status}): ${ep.text.slice(0, 200)}`);
  bad++;
} else {
  console.log(`webhook URL : ${ep.json.endpoint}`);
  console.log(`Use webhook : ${ep.json.active ? "オン" : "オフ"}`);

  if (!ep.json.active) {
    /* ここが切れていると、URL は合っているのに 1 件も来ない。
       画面上は URL が入っているので、登録し忘れと見分けにくい。 */
    console.log("✗ URL は入っていますが「Use webhook」が切れています。");
    console.log("  同じ画面のトグルをオンにしてください。");
    bad++;
  }
  if (ep.json.endpoint && !ep.json.endpoint.startsWith("https://")) {
    console.log("✗ https ではありません。LINE は http を受け付けません。");
    bad++;
  }
}

/* ---- LINE から実際に叩いてもらう ----------------------------------- */
if (!bad) {
  const t = await ask("/channel/webhook/test", { method: "POST" });
  console.log("");
  if (t.status === 200 && t.json?.success) {
    console.log(`✓ LINE から届きました (HTTP ${t.json.statusCode})`);
  } else {
    /* 200 でも success:false があり得る。reason と detail に
       「こちらが何を返したか」が入っているので、そのまま出す。 */
    console.log(`✗ LINE から届きませんでした`);
    console.log(`  status  : ${t.json?.statusCode ?? t.status}`);
    console.log(`  reason  : ${t.json?.reason ?? "-"}`);
    console.log(`  detail  : ${t.json?.detail ?? t.text.slice(0, 200)}`);
    bad++;
  }
}

console.log("");
console.log(bad ? `✗ ${bad} 件、直すところがあります` : "✓ LINE 側の設定は揃っています");
process.exit(bad ? 1 : 0);
