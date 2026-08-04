/* ==================================================================
   app.mjs — HTTP の受け口

     node server/app.js          （cPanel も同じ入口を使う）
     PORT=3000 node server/app.js

   経路は 5 つだけ。

     POST /line/webhook      LINE からの通知
     POST /line/link/start   ウェブの占い結果を預かる（P3）
     GET  /line/callback     LINE Login の戻り先（P3）
     POST /stripe/webhook    入金の通知（migrations/002）
     GET  /health            生きているか（cPanel と外形監視から）

   フレームワークを入れないのは、経路が 5 つしか無いため。
   Express を足すと依存が 60 個ほど増え、検証に install が要る
   範囲が広がる（README「検証は設置なしで走る」）。

   【200 を先に返す】
   LINE は応答が遅いと再送してくる。ここで DB とプロフィール取得を
   待ってから返すと、朝の混雑時に間に合わず、同じ follow が
   二度三度届く。署名を確かめた時点で 200 を返し、中身は後ろで
   処理する。処理に失敗しても再送は来ないので、失敗はこちらの
   ログに残す（push_logs ではなく標準出力 ── まだ誰の分か
   分からない段階の失敗もあるため）。
   ================================================================== */
import http from "node:http";
import { loadEnv, requireEnv } from "./lib/env.mjs";
import { getPool } from "./lib/db.mjs";
import { verifyLineSignature } from "./lib/signature.mjs";
import { handleWebhookBody } from "./lib/webhook.mjs";
import { startLink, completeLink } from "./lib/handlers/link.mjs";
import { resultPage } from "./lib/pages.mjs";
import { jstDateTime } from "./lib/jst.mjs";
import { verifyStripeSignature, readCheckoutEvent } from "./lib/stripe.mjs";
import { creditFromStripe, missingLegalConfig } from "./lib/handlers/checkout.mjs";
import { deliverNow } from "./db/push-daily.mjs";

loadEnv();

const PORT = Number(process.env.PORT || 3000);

/* 経路は環境変数で動かせるようにしておく。webhook の URL を
   どのホストのどのパスに置くかがまだ決まっていない（README 参照）。 */
const PATH_WEBHOOK  = process.env.LINE_WEBHOOK_PATH  || "/line/webhook";
const PATH_CALLBACK = process.env.LINE_CALLBACK_PATH || "/line/callback";
const PATH_START    = process.env.LINE_LINK_START_PATH || "/line/link/start";
const PATH_STRIPE   = process.env.STRIPE_WEBHOOK_PATH || "/stripe/webhook";

/* ---- CORS ---------------------------------------------------------
   占いページは Xserver（www.kstudy101.jp）、この API は ChemiCloud に
   居るので、ブラウザから見ると別オリジンになる。許可しないと
   /line/link/start は preflight で止まる。

   * にはしない。この口は生年月日を受け取るので、どのサイトからでも
   投げ込める状態にする理由が無い。Cookie は使っていないので
   credentials も許可しない。 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://www.kstudy101.jp,https://kstudy101.jp")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    /* オリジンごとに応答が変わるので、間に立つキャッシュへ伝える。
       これが無いと、1 人ぶんの応答が別オリジンの人へ配られうる。 */
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600"
  };
}

/* 受け取る本文の上限。LINE の 1 通は数十 KB に収まる。
   上限が無いと、誰でも POST できる口に大きな本文を投げられる。 */
const MAX_BODY = 1024 * 1024;

const log = (...a) => console.log(`[${jstDateTime()}]`, ...a);
const logErr = (...a) => console.error(`[${jstDateTime()}]`, ...a);

/* 生のバイト列で受ける。JSON.parse したものを組み直すと
   署名が合わなくなる（lib/signature.mjs の注釈）。 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("本文が大きすぎます"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body = "", headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

async function onWebhook(req, res) {
  if (req.method !== "POST") return send(res, 405, "POST のみ");

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return send(res, e.statusCode || 400, "本文を読めません");
  }

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    /* 設定漏れ。誰でも通る状態にするより、止まっている方がよい。 */
    logErr("LINE_CHANNEL_SECRET が未設定です。webhook を拒否します");
    return send(res, 500, "設定不足");
  }

  if (!verifyLineSignature(raw, req.headers["x-line-signature"], secret)) {
    /* 本文は残さない。誰でも POST できる口なので、
       ログが他人の投げ込みで埋まる。 */
    logErr("署名が一致しません", { ip: req.socket.remoteAddress, bytes: raw.length });
    return send(res, 401, "署名が一致しません");
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return send(res, 400, "JSON ではありません");
  }

  /* ここで先に返す。以降の失敗は再送されない。 */
  send(res, 200, "OK");

  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) {
    /* LINE Developers の「検証」ボタンは空の events で叩いてくる。
       200 が返れば成功と表示される。 */
    log("webhook: events 0 件（検証またはハートビート）");
    return;
  }

  try {
    const pool = await getPool();
    const results = await handleWebhookBody(pool, body);
    for (const r of results) {
      if (r.error) logErr("event 失敗", r);
      else log("event", JSON.stringify(r));
    }
  } catch (e) {
    /* DB に繋がらない等。200 は返してしまっているので再送は来ない。
       気づけるように必ず残す。 */
    logErr("webhook の処理に失敗", e && e.stack ? e.stack : e);
  }
}

/* ---- P3: 占い結果を預かる ------------------------------------------
   ウェブ（占い結果ページ）から呼ばれる唯一の口。返すのは合言葉と
   認証画面の URL だけで、ブラウザはそこへ飛ぶ。 */
async function onLinkStart(req, res) {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return send(res, 204, "", cors);
  if (req.method !== "POST") return send(res, 405, "POST のみ", cors);

  /* 許可していないオリジンからのブラウザ経由の要求は、CORS ヘッダを
     返さないので結果を読めない。それでも要求自体は届くので、
     ここで断っておく（Origin が無い＝ブラウザ以外は通す。
     curl での動作確認と、将来のサーバー間呼び出しのため）。 */
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    logErr("許可していないオリジン", origin);
    return send(res, 403, "origin が許可されていません");
  }

  let raw;
  try { raw = await readRawBody(req); }
  catch (e) { return send(res, e.statusCode || 400, "本文を読めません", cors); }

  let input;
  try { input = JSON.parse(raw.toString("utf8")); }
  catch { return send(res, 400, JSON.stringify({ ok: false, reason: "JSON ではありません" }), cors); }

  try {
    const pool = await getPool();
    const r = await startLink(pool, input);
    if (!r.ok) {
      log("link/start 却下:", r.reason);
      return send(res, 400, JSON.stringify(r),
        { ...cors, "Content-Type": "application/json; charset=utf-8" });
    }
    log("link/start 受付");
    return send(res, 200, JSON.stringify(r),
      { ...cors, "Content-Type": "application/json; charset=utf-8" });
  } catch (e) {
    logErr("link/start 失敗", e && e.stack ? e.stack : e);
    return send(res, 500, JSON.stringify({ ok: false, reason: "内部エラー" }),
      { ...cors, "Content-Type": "application/json; charset=utf-8" });
  }
}

/* ---- P3: LINE から戻ってくる ---------------------------------------
   ここはブラウザが直接開くので、返すのは JSON ではなく画面。 */
async function onCallback(req, res, url) {
  if (req.method !== "GET") return send(res, 405, "GET のみ");

  const html = (status, page) => send(res, status, page, {
    "Content-Type": "text/html; charset=utf-8",
    /* 認証結果の画面。戻るボタンで再表示されないようにする。 */
    "Cache-Control": "no-store, must-revalidate"
  });

  try {
    const pool = await getPool();
    const r = await completeLink(pool, {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description")
    });

    if (!r.ok) {
      log("callback 失敗:", r.kind, r.reason);
      /* 400 を返すのは、やり直せば直るものだから。
         利用者にはどれだったかを言わない（token.mjs の注釈）。 */
      return html(r.kind === "declined" ? 200 : 400, resultPage(r));
    }

    log("callback 完了", JSON.stringify({
      userId: r.userId, friend: r.friend, hasName: !!r.nameKr
    }));
    if (r.friend === false) {
      /* 友だちでないだけなら追加を促せばよい。だが設置直後に
         これが必ず出るなら、Login と Messaging API のチャネルが
         別プロバイダーである可能性が高い（lib/linelogin.mjs）。 */
      logErr("push できない相手です。友だち未追加か、チャネルのプロバイダー違い:", r.lineUserId);
    }
    return html(200, resultPage(r));
  } catch (e) {
    logErr("callback 失敗", e && e.stack ? e.stack : e);
    return html(500, resultPage({ ok: false, kind: "server_error" }));
  }
}

/* ---- 入金の通知 -----------------------------------------------------
   webhook の URL は公開されていて誰でも POST できる。ここが緩むと
   「支払いました」を他人が名乗れて、日数が無料で積まれる。
   LINE の webhook と同じ扱いにする ── 署名を確かめるまで本文を
   解釈しない。

   Stripe は応答が遅いと再送してくる（それは仕様であって障害ではない）。
   LINE と同じく、署名を確かめた時点で 200 を返し、中身は後ろで処理する。
   再送で日数が二度積まれないのは purchases.payment_ref の一意制約が
   見ている（repo/billing.mjs）ので、200 を先に返して構わない。 */
async function onStripeWebhook(req, res) {
  if (req.method !== "POST") return send(res, 405, "POST のみ");

  let raw;
  try { raw = await readRawBody(req); }
  catch (e) { return send(res, e.statusCode || 400, "本文を読めません"); }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    /* 設定漏れ。誰でも通る状態にするより、止まっている方がよい。 */
    logErr("STRIPE_WEBHOOK_SECRET が未設定です。webhook を拒否します");
    return send(res, 500, "設定不足");
  }

  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], secret)) {
    /* 本文は残さない。誰でも POST できる口なので、
       ログが他人の投げ込みで埋まる。 */
    logErr("Stripe の署名が一致しません", { ip: req.socket.remoteAddress, bytes: raw.length });
    return send(res, 401, "署名が一致しません");
  }

  let event;
  try { event = JSON.parse(raw.toString("utf8")); }
  catch { return send(res, 400, "JSON ではありません"); }

  send(res, 200, "OK");                       // ここで先に返す

  const ev = readCheckoutEvent(event);
  if (!ev) {
    log(`stripe: 扱わない種類（${event?.type || "?"}）`);
    return;
  }

  try {
    const pool = await getPool();
    const r = await creditFromStripe(pool, ev, { deliver: deliverNow });
    if (!r.ok) logErr("入金の処理に失敗", JSON.stringify(r));
    else log("入金", JSON.stringify(r));
  } catch (e) {
    /* 200 は返してしまっているので再送は来ない。必ず残す ──
       ここが落ちると「払ったのに日数が無い」になる。 */
    logErr("入金の処理に失敗", e && e.stack ? e.stack : e);
  }
}

async function onHealth(req, res) {
  /* DB まで見る。プロセスが生きていても DB が落ちていれば
     配信は止まるので、「生きている」の定義に入れる。 */
  try {
    const pool = await getPool();
    await pool.query("SELECT 1");
    return send(res, 200, "ok", { "Content-Type": "application/json; charset=utf-8" });
  } catch (e) {
    logErr("health: DB に繋がりません", e.message);
    return send(res, 503, "db unavailable");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === PATH_WEBHOOK)  return void onWebhook(req, res);
  if (url.pathname === PATH_START)    return void onLinkStart(req, res);
  if (url.pathname === PATH_CALLBACK) return void onCallback(req, res, url);
  if (url.pathname === PATH_STRIPE)   return void onStripeWebhook(req, res);
  if (url.pathname === "/health")     return void onHealth(req, res);

  send(res, 404, "not found");
});

/* 想定外の例外でプロセスごと落ちると、cPanel が再起動するまで
   webhook が全部 404 になる。落とさずに残す。 */
process.on("unhandledRejection", (e) => logErr("unhandledRejection", e));
process.on("uncaughtException", (e) => logErr("uncaughtException", e && e.stack ? e.stack : e));

/* 起動前に足りない設定を名前で出す。動き出してから
   最初の webhook で初めて分かる、を避ける。 */
try {
  requireEnv(["LINE_CHANNEL_SECRET", "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]);
} catch (e) {
  logErr(e.message);
  process.exit(1);
}

/* ---- LINE の宛先が本物か --------------------------------------------
   lib/line.mjs と lib/linelogin.mjs は宛先を環境変数で差し替えられる。
   手元で流れを通すために入れたもので、本番に残ってはいけない。

   残ったまま動くと、アクセストークンとチャネルシークレットを
   よそのホストへ送り続けることになる。しかも画面上は正常に見える
   ── 相手が 200 を返す限り、こちらは何も気づかない。

   明示的に ALLOW_FAKE_LINE=1 を置いたときだけ許す。置き忘れても
   起動時に大きく出るので、本番で気づかず動き続けることはない。 */
for (const key of ["LINE_API_BASE", "LINE_AUTH_BASE", "STRIPE_API_BASE"]) {
  const v = process.env[key];
  if (!v) continue;
  if (process.env.ALLOW_FAKE_LINE === "1") {
    logErr(`! ${key}=${v}（試験用の宛先。本番では外すこと）`);
    continue;
  }
  logErr(`✗ ${key} が設定されています: ${v}`);
  logErr("  LINE への宛先を差し替えたまま起動しようとしています。");
  logErr("  鍵をよそのホストへ送ることになるため停止します。");
  logErr("  手元で試すときだけ ALLOW_FAKE_LINE=1 を併せて設定してください。");
  process.exit(1);
}

server.listen(PORT, () => {
  log(`起動しました :${PORT}`);
  log(`  webhook    ${PATH_WEBHOOK}`);
  log(`  link start ${PATH_START}`);
  log(`  callback   ${PATH_CALLBACK}`);
  log(`  stripe     ${PATH_STRIPE}`);
  log(`  health     /health`);
  log(`  許可オリジン ${ALLOWED_ORIGINS.join(" / ")}`);

  /* 売る用意が整っているか。足りなければ価格表そのものを出さない
     （lib/handlers/checkout.mjs の門）ので、起動時に名前で出しておく
     ── 「押しても準備中と返る」の理由が、ここにしか無い。 */
  const missing = missingLegalConfig();
  if (missing.length) {
    logErr("! 受講料の案内は止まっています。足りない設定:");
    for (const m of missing) logErr(`    ・${m}`);
  } else {
    log("  受講料の案内 有効");
  }
});

export default server;
