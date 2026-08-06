#!/usr/bin/env node
/* ==================================================================
   verify-billing.mjs — 前払いの回数券（migrations/002）

   ここの誤りは、どれも画面に出ない。請求は通り、ログも普通に見え、
   利用者が言ってくるまで分からない:

     ・「1 日目からやり直す」で残りが復活する → 受け取ったぶんが無料
     ・webhook の再送で日数が二度積まれる    → 決済 1 件で 2 倍
     ・署名を確かめずに通す                  → 誰でも日数を積める
     ・古い署名を通す                        → 一度漏れた要求を投げ直せる
     ・data の値段を信じる                   → 100 円で 101 日分
     ・コースを変えると前のコースの残りが消える
     ・表示の義務を満たす前に売れてしまう

   DB も Stripe も要らない。repo/ は渡された接続の execute() しか
   呼ばない約束なので、偽物を渡して SQL を読む。
   ================================================================== */
import fs from "node:fs";
import crypto from "node:crypto";

let failed = 0, passed = 0;
/* 同期 check に async の検査を渡すと、失敗しても緑になる ── 実際に
   verify-onboarding で 1 件起きた（2026-08-06 指示書 §1）。Promise が
   返ってきた時点で検査そのものを失敗させる。async は acheck へ。 */
const guardSync = (d, label) => {
  if (d && typeof d.then === "function") {
    throw new Error("async の検査を同期 check に渡しています（acheck を使うこと）");
  }
};
const check = (label, fn) => {
  try { const d = fn(); guardSync(d, label); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const acheck = async (label, fn) => {
  try { const d = await fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "満たしていません"); };
const head = (s) => console.log(`\n${s}`);
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const { verifyStripeSignature, readCheckoutEvent } = await import("../server/lib/stripe.mjs");
const { entitlements, learning, billing, lapses } = await import("../server/lib/repo/index.mjs");
const checkout = await import("../server/lib/handlers/checkout.mjs");

/* 偽の接続。SQL の見た目で返すものを決め、実行された SQL は
   全部 calls に残るので順番も後から読める。 */
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
const dupErr = () => Object.assign(new Error("Duplicate entry"), { errno: 1062, code: "ER_DUP_ENTRY" });


/* ================================================================== */
head("[やり直し]  ここを外すと、受け取ったぶんが無料になる");

check("残りは days_used で数える。current_day では数えない", () => {
  const src = stripComments(read("server/lib/repo/entitlements.mjs"));
  assert(/days_entitled\s*-\s*COALESCE\(p\.days_used/.test(src),
    "残りの計算に days_used を使っていません");
  assert(!/days_entitled\s*-\s*COALESCE\(p\.current_day/.test(src),
    "残りを current_day で数えています。やり直すと残りが復活します");
  return "days_entitled - days_used";
});

await acheck("resetProgress は days_used に触らない", async () => {
  const conn = fakeConn();
  await learning.resetProgress(conn, 7, "beginner", 0);
  const sql = conn.sql().join(" ");
  assert(/UPDATE learning_progress/i.test(sql), "更新していません");
  assert(!/days_used/i.test(sql),
    `days_used を書き換えています ── やり直しで残りが復活します: ${sql}`);
  return "current_day だけ戻る";
});

await acheck("advanceDay は日を確保するのと同じ 1 文で days_used を増やす", async () => {
  const conn = fakeConn({ "UPDATE learning_progress": { affectedRows: 1 } });
  await learning.advanceDay(conn, 7, "beginner", 3);
  const stmt = conn.calls.find((c) => /UPDATE learning_progress/i.test(c.sql));
  assert(stmt, "更新していません");
  const s = stmt.sql.replace(/\s+/g, " ");
  assert(/days_used\s*=\s*days_used\s*\+\s*1/.test(s), `days_used を増やしていません: ${s}`);
  assert(/WHERE .*current_day = \?/.test(s),
    "読んだ値のままかを見ていません（二重起動で 2 日進みます）");
  return "1 文で確保と消費";
});

await acheck("確保に負けたら days_used も増えない", async () => {
  const conn = fakeConn({ "UPDATE learning_progress": { affectedRows: 0 } });
  const r = await learning.advanceDay(conn, 7, "beginner", 3);
  assert(r.claimed === false, "負けたのに勝ったと返しました");
  return "claimed=false";
});


/* ================================================================== */
head("[再送]  Stripe は同じイベントを何度も送る（仕様であって障害ではない）");

await acheck("同じ Session を二度処理しても日数は増えない", async () => {
  let insertCount = 0;
  const conn = fakeConn({
    "INSERT INTO purchases": () => {
      insertCount++;
      if (insertCount > 1) throw dupErr();          // 2 度目は一意制約に当たる
      return { affectedRows: 1, insertId: 1 };
    },
    "FROM course_entitlements": [{ track: "beginner", days_entitled: 30, days_used: 0,
                                   current_day: 0, remaining: 30 }]
  });

  const first = await billing.creditPurchase(conn, 7, "beginner", "30days",
    { paymentRef: "cs_test_ABC" });
  assert(first.created === true, "1 度目が入りませんでした");

  const second = await billing.creditPurchase(conn, 7, "beginner", "30days",
    { paymentRef: "cs_test_ABC" });
  assert(second.created === false, "2 度目も新規として扱いました（日数が二度積まれます）");
  assert(second.daysGranted === 0, `2 度目で ${second.daysGranted} 日積みました`);

  /* 積む SQL が 1 回しか出ていないこと。created の値だけ見て
     安心すると、その後ろで積んでいても気づけない。 */
  const grants = conn.sql().filter((s) => /INSERT INTO course_entitlements/i.test(s));
  assert(grants.length === 1, `日数を ${grants.length} 回積みました`);
  return "1062 で弾く / 積むのは 1 回";
});

check("再送を affectedRows で見分けていない", () => {
  const src = stripComments(read("server/lib/repo/billing.mjs"));
  /* 閉じ括弧が行頭に来る所が 2 つある ── 分割代入の引数
     「} = {}) {」も行頭の } なので、\n} だけで切ると本文の手前で
     終わってしまう。1 行に } だけがある所まで取る。 */
  const fn = src.match(/export async function creditPurchase[\s\S]*?\n}\n/)[0];
  assert(/insertNew/.test(fn), "insertNew（1062 を捕まえる形）を使っていません");
  assert(!/affectedRows/.test(fn),
    "affectedRows で見分けています。mysql2 の既定では新規も重複も 1 です");
  return "insertNew の created で見る";
});

check("台帳に入ってから積む（順番）", () => {
  const src = stripComments(read("server/lib/repo/billing.mjs"));
  /* 閉じ括弧が行頭に来る所が 2 つある ── 分割代入の引数
     「} = {}) {」も行頭の } なので、\n} だけで切ると本文の手前で
     終わってしまう。1 行に } だけがある所まで取る。 */
  const fn = src.match(/export async function creditPurchase[\s\S]*?\n}\n/)[0];
  const ins = fn.indexOf("INSERT INTO purchases");
  const grant = fn.indexOf("entitlements.grant");
  assert(ins >= 0 && grant >= 0, "どちらかがありません");
  assert(ins < grant,
    "先に日数を積んでいます。落ちると「もらったが払った記録が無い」が残ります");
  return "purchases → grant";
});


/* ================================================================== */
head("[署名]  この口が緩むと、誰でも日数を積める");

const SECRET = "whsec_test";
const sign = (body, t, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex");

check("正しい署名は通る", () => {
  const body = Buffer.from(JSON.stringify({ type: "x" }), "utf8");
  const t = Math.floor(Date.now() / 1000);
  assert(verifyStripeSignature(body, `t=${t},v1=${sign(body, t)}`, SECRET), "通りません");
  return "t + v1";
});

check("本文が 1 バイトでも違えば通らない", () => {
  const t = Math.floor(Date.now() / 1000);
  const a = Buffer.from('{"a":1}', "utf8"), b = Buffer.from('{"a":2}', "utf8");
  assert(!verifyStripeSignature(b, `t=${t},v1=${sign(a, t)}`, SECRET), "通ってしまいました");
  return "改竄を弾く";
});

check("別のシークレットで作った署名は通らない", () => {
  const body = Buffer.from("{}", "utf8");
  const t = Math.floor(Date.now() / 1000);
  assert(!verifyStripeSignature(body, `t=${t},v1=${sign(body, t, "whsec_other")}`, SECRET),
    "通ってしまいました");
  return "鍵違いを弾く";
});

check("古い要求は通らない（再生攻撃）", () => {
  const body = Buffer.from("{}", "utf8");
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert(!verifyStripeSignature(body, `t=${old},v1=${sign(body, old)}`, SECRET),
    "1 時間前の要求が通りました。一度漏れた要求を投げ直せます");
  /* 許容の内側なら通ること。厳しすぎると時計のずれで全部落ちる。 */
  const near = Math.floor(Date.now() / 1000) - 60;
  assert(verifyStripeSignature(body, `t=${near},v1=${sign(body, near)}`, SECRET),
    "1 分前が通りません。時計の誤差で全部落ちます");
  return "既定 5 分";
});

check("先の時刻も通さない", () => {
  const body = Buffer.from("{}", "utf8");
  const future = Math.floor(Date.now() / 1000) + 3600;
  assert(!verifyStripeSignature(body, `t=${future},v1=${sign(body, future)}`, SECRET),
    "1 時間先の要求が通りました");
  return "絶対値で見る";
});

check("=== ではなく timingSafeEqual で比べる", () => {
  const src = stripComments(read("server/lib/stripe.mjs"));
  assert(/timingSafeEqual/.test(src),
    "=== で比べています。先頭から何文字目で違うかが所要時間に出ます");
  return "timingSafeEqual";
});

check("hex で作る（base64 ではない）", () => {
  const src = stripComments(read("server/lib/stripe.mjs"));
  assert(/digest\("hex"\)/.test(src),
    "Stripe は hex です。LINE の base64 を写すと全部 401 になります");
  return "hex";
});

check("文字列を渡したら投げる（再シリアライズを防ぐ）", () => {
  let threw = false;
  try { verifyStripeSignature("{}", "t=1,v1=x", SECRET); } catch { threw = true; }
  assert(threw, "文字列を受け付けました。JSON を組み直すと署名が合いません");
  return "Buffer のみ";
});

check("署名を確かめてから JSON.parse する", () => {
  const src = stripComments(read("server/app.mjs"));
  const fn = src.match(/async function onStripeWebhook[\s\S]*?\n}/)[0];
  const verify = fn.indexOf("verifyStripeSignature");
  const parse = fn.indexOf("JSON.parse");
  assert(verify >= 0 && parse >= 0, "どちらかがありません");
  assert(verify < parse, "署名を確かめる前に本文を解釈しています");
  return "verify → parse";
});

check("シークレット未設定なら webhook を止める", () => {
  const src = stripComments(read("server/app.mjs"));
  const fn = src.match(/async function onStripeWebhook[\s\S]*?\n}/)[0];
  assert(/STRIPE_WEBHOOK_SECRET/.test(fn) && /500/.test(fn),
    "未設定のまま素通りします");
  return "500 で拒否";
});

check("未払いの completed は日数に替えない", () => {
  const paid = readCheckoutEvent({ type: "checkout.session.completed",
    data: { object: { id: "cs_1", payment_status: "paid",
                      metadata: { user_id: "7", track: "beginner", package: "30days" } } } });
  assert(paid && paid.sessionId === "cs_1", "払った分を落としました");
  const unpaid = readCheckoutEvent({ type: "checkout.session.completed",
    data: { object: { id: "cs_2", payment_status: "unpaid",
                      metadata: { user_id: "7", track: "beginner", package: "30days" } } } });
  assert(unpaid === null, "未払いを通しました（銀行振込などで起こります）");
  return "payment_status を見る";
});


/* ================================================================== */
head("[値段]  data は利用者の端末を通って戻る");

check("pkg から値段を引く。data の金額を使わない", () => {
  const src = stripComments(read("server/lib/handlers/postback.mjs"));
  const fn = src.match(/if \(action === "buy"\)[\s\S]*?\n  }/)[0];
  assert(/PACKAGES\[pkg\]/.test(fn), "PACKAGES で引き当てていません");
  assert(!/params\.(price|amount|yen)/.test(fn),
    "data から金額を読んでいます。書き換えれば 100 円で買えます");
  return "PACKAGES の表から";
});

check("金額の出どころは PACKAGES の 1 か所だけ", () => {
  const chk = stripComments(read("server/lib/handlers/checkout.mjs"));
  assert(/PACKAGES\[packageType\]/.test(chk), "PACKAGES を引いていません");
  /* 決済セッションを作るところに数字を直接書いていないこと。 */
  assert(!/unit_amount[^)]*\d{3,}/.test(chk), "金額を直に書いています");
  return "PACKAGES";
});

await acheck("知らない track / package は DB に届く前に弾く", async () => {
  const conn = fakeConn();
  let threw = 0;
  try { await billing.creditPurchase(conn, 7, "Beginner", "30days", {}); } catch { threw++; }
  try { await billing.creditPurchase(conn, 7, "beginner", "90days", {}); } catch { threw++; }
  assert(threw === 2, `${threw} 件しか弾きませんでした`);
  assert(!conn.calls.length, "DB を触りました");
  return "ENUM 外・表に無い package を拒否";
});


/* ================================================================== */
head("[税区分]  Managed Payments は tax_code が無いと 400（実測 2026-08-06）");

/* 実際に createCheckoutSession を呼び、飛んでいく form を受け口で
   捕まえて見る ── ソースの文字列だけを見ると、書いてはあるが
   組み立てで落ちている形（typo・別の変数）を通してしまう。
   宛先は STRIPE_API_BASE で差し替えられる（本番では設定しない）。 */
await acheck("createCheckoutSession は product_data[tax_code] を必ず載せる", async () => {
  const { createCheckoutSession, TAX_CODE } = await import("../server/lib/stripe.mjs");
  const http = await import("node:http");

  let captured = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured = body;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.example/pay" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));

  const KEYS = ["STRIPE_API_BASE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${srv.address().port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
  try {
    await createCheckoutSession({
      userId: 7, track: "beginner", packageType: "7days",
      days: 7, price: 980, productName: "初級（초급） 7日分",
      successUrl: "https://example.jp/thanks", cancelUrl: "https://example.jp/"
    });
    assert(captured, "リクエストが届いていません");
    const form = new URLSearchParams(captured);
    const sent = form.get("line_items[0][price_data][product_data][tax_code]");
    assert(sent !== null, "tax_code が form にありません（Managed Payments は 400 を返します）");
    assert(sent.trim() !== "", "tax_code が空文字列です");
    assert(sent === TAX_CODE, `定数とずれています: ${sent} ≠ ${TAX_CODE}`);
    return `tax_code=${sent}`;
  } finally {
    srv.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

check("税区分は名前のある定数（環境変数にしない）", () => {
  const src = stripComments(read("server/lib/stripe.mjs"));
  assert(/export const TAX_CODE = "txcd_[0-9]+"/.test(src), "TAX_CODE 定数がありません");
  assert(!/process\.env\.[A-Z_]*TAX/.test(src),
    "税区分を環境変数から読んでいます ── 画面から検討なしで替えられます（指示書 §1-3）");
  return "コードに固定";
});


/* ================================================================== */
head("[コース]  1 つを買っても、他のコースの残りは消えない");

check("保有日数はコース別の表に持つ", () => {
  const src = stripComments(read("server/lib/repo/entitlements.mjs"));
  assert(/PRIMARY KEY|user_id = \? AND e?\.?track = \?|e\.user_id = \? AND e\.track = \?/.test(src)
      || /WHERE e\.user_id = \? AND e\.track = \?/.test(src),
    "コース別に引いていません");
  const mig = read("server/db/migrations/002-per-course-billing.sql");
  assert(/PRIMARY KEY \(user_id, track\)/.test(mig),
    "course_entitlements の鍵が (user_id, track) ではありません");
  return "(user_id, track)";
});

check("進みもコース別（1 人が初級 → 中級 と続けられる）", () => {
  const mig = read("server/db/migrations/002-per-course-billing.sql");
  assert(/DROP INDEX uq_progress_user\b/.test(mig), "1 人 1 行のままです");
  assert(/UNIQUE KEY uq_progress_user_track \(user_id, track\)/.test(mig),
    "(user_id, track) の一意キーがありません");
  return "uq_progress_user_track";
});

check("配信は active_track の 1 コースだけを見る", () => {
  const src = stripComments(read("server/lib/repo/users.mjs"));
  assert(/p\.track = u\.active_track/.test(src) && /e\.track = u\.active_track/.test(src),
    "active_track で結んでいません。3 コース持つ人に 3 通届きます");
  return "listDeliverable";
});

check("夕方の復習も同じコースを見る", () => {
  const src = stripComments(read("server/lib/repo/pushlogs.mjs"));
  const fn = src.match(/export async function listReviewTargets[\s\S]*?\n}/)[0];
  assert(/p\.track = u\.active_track/.test(fn),
    "track で結んでいません。コースの数だけ復習が届きます");
  return "listReviewTargets";
});


/* ================================================================== */
head("[体験]  1 アカウント 1 回。コースを変えて 3 回もらえない");

await acheck("2 回目の体験は入らない", async () => {
  let n = 0;
  const conn = fakeConn({
    "INSERT INTO subscriptions": () => {
      n++;
      if (n > 1) throw dupErr();
      return { affectedRows: 1, insertId: 1 };
    },
    "FROM subscriptions": [{ user_id: 7, trial_start: "2026-08-04", trial_track: "beginner" }]
  });
  const a = await billing.startTrial(conn, 7, "beginner");
  assert(a.created === true, "1 回目が入りませんでした");
  const b = await billing.startTrial(conn, 7, "intermediate");
  assert(b.created === false, "コースを変えたら 2 回目が通りました（9 日ぶん無料になります）");

  const grants = conn.sql().filter((s) => /INSERT INTO course_entitlements/i.test(s));
  assert(grants.length === 1, `体験の日数を ${grants.length} 回積みました`);
  return "user_id の一意制約で 1 回";
});

check("体験は purchases に入れない（0 円の行で売上が狂う）", () => {
  const src = stripComments(read("server/lib/repo/billing.mjs"));
  const fn = src.match(/export async function startTrial[\s\S]*?\n}/)[0];
  assert(!/INSERT INTO purchases/i.test(fn), "体験を購入台帳に入れています");
  return "entitlements だけ";
});


/* ================================================================== */
head("[門]  表示の義務を満たす前に売らない");

check("特商法の表記と返金規定が無ければ売らない", () => {
  const keep = { t: process.env.TOKUSHOHO_URL, r: process.env.REFUND_POLICY,
                 s: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  try {
    delete process.env.TOKUSHOHO_URL;
    assert(!checkout.salesOpen(), "表記の URL が無いのに売れます");
    assert(checkout.missingLegalConfig().some((m) => /TOKUSHOHO/.test(m)),
      "何が足りないか名前で出していません");

    process.env.TOKUSHOHO_URL = "https://example/tokushoho";
    delete process.env.REFUND_POLICY;
    assert(!checkout.salesOpen(), "返金規定が無いのに売れます");

    process.env.REFUND_POLICY = "…";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    assert(checkout.salesOpen(), "全部揃っているのに売れません");
  } finally {
    for (const [k, v] of [["TOKUSHOHO_URL", keep.t], ["REFUND_POLICY", keep.r],
                          ["STRIPE_SECRET_KEY", keep.s], ["STRIPE_WEBHOOK_SECRET", keep.w]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return "4 つ揃って初めて開く";
});

check("価格表を出す前に門を通る（SALES_MODE を重ねた salesAllowedFor）", () => {
  const src = stripComments(read("server/lib/handlers/postback.mjs"));
  for (const a of ["plans", "plan", "buy"]) {
    const fn = src.match(new RegExp(`if \\(action === "${a}"\\)[\\s\\S]*?\\n  }`))[0];
    assert(/salesAllowedFor\(user\)/.test(fn), `action=${a} が門を通っていません`);
  }
  return "plans / plan / buy";
});

check("SALES_MODE ── 既定 closed / test は名簿だけ / open は全員（§1-1）", () => {
  const keep = { m: process.env.SALES_MODE, u: process.env.SALES_TEST_USERS,
                 t: process.env.TOKUSHOHO_URL, r: process.env.REFUND_POLICY,
                 s: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  try {
    /* 法定表示は全部そろえておく ── 見たいのはモードの段だけ。 */
    process.env.TOKUSHOHO_URL = "https://example/tokushoho";
    process.env.REFUND_POLICY = "…";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const me = { id: 7, line_user_id: "U_me" };
    const other = { id: 8, line_user_id: "U_other" };

    delete process.env.SALES_MODE;
    assert(!checkout.salesAllowedFor(me), "SALES_MODE 未設定なのに売れます（既定は closed のはず）");

    process.env.SALES_MODE = "こわれた値";
    assert(checkout.salesMode() === "closed", "読めない値が closed に倒れません");

    process.env.SALES_MODE = "test";
    process.env.SALES_TEST_USERS = "7, U_someone";
    assert(checkout.salesAllowedFor(me), "名簿に居るのに test で売れません");
    assert(!checkout.salesAllowedFor(other), "名簿に居ないのに test で売れます ── 実利用者に決済画面が開く事故");

    process.env.SALES_MODE = "open";
    assert(checkout.salesAllowedFor(other), "open なのに売れません");

    /* モードが open でも法定表示が欠ければ閉じる（必要条件のまま） */
    delete process.env.TOKUSHOHO_URL;
    assert(!checkout.salesAllowedFor(other), "表記なしで open が通っています");
  } finally {
    for (const [k, v] of Object.entries({ SALES_MODE: keep.m, SALES_TEST_USERS: keep.u,
        TOKUSHOHO_URL: keep.t, REFUND_POLICY: keep.r,
        STRIPE_SECRET_KEY: keep.s, STRIPE_WEBHOOK_SECRET: keep.w })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return "closed（既定・誤記も）/ test 名簿 / open、法定表示は常に必要";
});

const { PACKAGES: PKGS } = await import("../server/lib/repo/billing.mjs");

check("原稿の日数を超えるパッケージは並ばない（§1-2）", () => {
  process.env.TOKUSHOHO_URL ||= "https://example/tokushoho";
  process.env.REFUND_POLICY ||= "返金の説明";
  /* 30 日ぶんしか無いコース ── 30days までしか出ない */
  const list30 = checkout.priceList("intermediate", { availableDays: 30 });
  assert(list30, "30 日ぶんあるのに価格表が出ません");
  const days30 = (list30.text.match(/(\d+) 日分/g) || []).map((s) => parseInt(s));
  assert(days30.length && Math.max(...days30) <= 30,
    `原稿 30 日なのに ${Math.max(...days30)} 日を売っています ── 31 日目から黙って止まる`);
  const dataDays = list30.quickReply.items
    .map((i) => i.action.data.match(/pkg=(\w+)/)?.[1]).filter(Boolean);
  for (const key of dataDays) {
    assert(PKGS[key].days <= 30, `ボタンに ${key} が残っています`);
  }
  /* 1 つも売れない ── null（呼ぶ側が「準備中」を出す） */
  assert(checkout.priceList("advanced", { availableDays: 0 }) === null,
    "原稿 0 なのに価格表が出ます");
  /* 全量あれば全パッケージ */
  const listAll = checkout.priceList("beginner", { availableDays: 101 });
  const daysAll = (listAll.text.match(/(\d+) 日分/g) || []).map((s) => parseInt(s));
  assert(Math.max(...daysAll) === Math.max(...Object.values(PKGS).map((p) => p.days)),
    "全量あるのに上のパッケージが出ません");
  return "30 日 → 30days まで / 0 日 → 準備中 / 101 日 → 全部";
});

check("buy と trial も原稿の上限で止まる（data 改竄への蓋）", () => {
  const src = stripComments(read("server/lib/handlers/postback.mjs"));
  const buy = src.match(/if \(action === "buy"\)[\s\S]*?\n  }/)[0];
  assert(/countTemplates/.test(buy), "buy が原稿の日数を見ていません");
  const trial = src.match(/if \(action === "trial"\)[\s\S]*?\n  }/)[0];
  assert(/countTemplates/.test(trial) && /TRIAL_DAYS/.test(trial),
    "trial が原稿の日数を見ていません");
  return "価格表に出ないものは、名乗られても売らない";
});

check("価格表に法が求める項目が入っている", () => {
  process.env.TOKUSHOHO_URL ||= "https://example/tokushoho";
  process.env.REFUND_POLICY ||= "返金の説明";
  const m = checkout.priceList("beginner", { trialAvailable: false });
  const t = m.text;
  for (const [what, re] of [
    ["分量",     /全 101 日/],
    ["税込表示", /税込/],
    ["支払時期", /申込時|お支払い/],
    ["自動更新なし", /自動更新はありません/],
    ["提供時期", /ご入金後すぐに 1 日目/],
    ["返金",     /返金/],
    ["事業者表記", /販売者の表記/]
  ]) assert(re.test(t), `${what} がありません`);
  assert(m.quickReply.items.length <= 13, "quickReply が 13 個を超えています");
  for (const i of m.quickReply.items) {
    assert(i.action.label.length <= 20, `label が 20 字を超えています: ${i.action.label}`);
  }
  return "7 項目";
});


/* ================================================================== */
head("[入金のあと]  払ったのに何も起きない、を作らない");

check("入金したら、時刻に関係なくその場で 1 日目", () => {
  const src = stripComments(read("server/app.mjs"));
  assert(/creditFromStripe\(pool, ev, \{ deliver: deliverNow \}\)/.test(src),
    "入金から即時配信へ繋がっていません");
  const chk = stripComments(read("server/lib/handlers/checkout.mjs"));
  assert(/deliver\(conn, user\.id\)/.test(chk), "deliver を呼んでいません");
  return "webhook → deliverNow";
});

check("二重送信の判定を新しく作っていない（sentToday を使う）", () => {
  const src = stripComments(read("server/db/push-daily.mjs"));
  const fn = src.match(/export async function deliverNow[\s\S]*?\n}/)[0];
  assert(/deliverOne/.test(fn), "deliverOne を通していません");
  assert(!/sentToday/.test(fn), "独自の判定を足しています（deliverOne が既に見ています）");
  return "deliverOne の既送判定に乗る";
});

check("1 人だけ引く（一覧を絞り込まない）", () => {
  const src = stripComments(read("server/db/push-daily.mjs"));
  const fn = src.match(/export async function deliverNow[\s\S]*?\n}/)[0];
  assert(/findDeliverable/.test(fn), "findDeliverable を使っていません");
  assert(!/listDeliverable/.test(fn),
    "一覧を引いて絞っています。501 人目から見つからなくなります");
  return "findDeliverable";
});

check("送信に失敗しても入金は残す", () => {
  const src = stripComments(read("server/lib/handlers/checkout.mjs"));
  const fn = src.match(/export async function creditFromStripe[\s\S]*?\n}/)[0];
  const credit = fn.indexOf("creditPurchase");
  const send = fn.indexOf("send(user.line_user_id");
  assert(credit >= 0 && send >= 0 && credit < send,
    "送ってから積んでいます。送信が落ちると払ったのに日数が無い状態になります");
  assert(/catch/.test(fn), "送信の失敗を捕まえていません");
  return "credit → send";
});


/* ================================================================== */
head("[期限と離脱]");

check("残り 2 日で 1 度だけ予告する", () => {
  assert(checkout.EXPIRING_AT === 2, `EXPIRING_AT=${checkout.EXPIRING_AT}`);
  const src = stripComments(read("server/db/push-daily.mjs"));
  assert(/willRemain === EXPIRING_AT/.test(src), "残りで判定していません");
  assert(/countForDay\(conn, u\.id, entitledNow, "expiring"\)/.test(src),
    "二度出さない判定がありません（days_entitled を鍵にする）");
  return "countForDay で 1 回";
});

check("予告はレッスンと同じ 1 通の便に乗せる", () => {
  const src = stripComments(read("server/db/push-daily.mjs"));
  assert(/messages = \[\.\.\.messages,\s*\n?\s*expiringNotice/.test(src.replace(/\s+/g, " "))
      || /messages = \[\.\.\.messages, expiringNotice/.test(src.replace(/\s+/g, " ")),
    "別便で送っています（通知が 2 回鳴ります）");
  return "同じ push に足す";
});

await acheck("切れたことは 1 度だけ台帳に残る", async () => {
  const openRow = [{ id: 1, user_id: 7, track: "beginner", resumed_at: null }];
  const conn = fakeConn({ "FROM lapse_log": openRow });
  const r = await lapses.openIfAbsent(conn, 7, "beginner", { lastDay: 12, daysBought: 30 });
  assert(r.created === false, "開いている行があるのに、もう 1 行書きました");
  assert(!conn.sql().some((s) => /INSERT INTO lapse_log/i.test(s)), "INSERT しました");
  return "開いている行があれば書かない";
});

await acheck("同じ朝に二重起動しても 1 行（一意制約）", async () => {
  const conn = fakeConn({
    "FROM lapse_log": [],                                  // 開いている行は無い
    "INSERT INTO lapse_log": () => { throw dupErr(); }      // 先に走ったほうが入れた
  });
  const r = await lapses.openIfAbsent(conn, 7, "beginner", { lastDay: 12, daysBought: 30 });
  assert(r.created === false, "1062 を新規として扱いました");
  return "(user_id, track, lapsed_on)";
});

check("買い直したら台帳を閉じる", () => {
  const src = stripComments(read("server/lib/handlers/checkout.mjs"));
  const fn = src.match(/export async function creditFromStripe[\s\S]*?\n}/)[0];
  assert(/lapses\.markResumed/.test(fn), "台帳を閉じていません");
  return "markResumed";
});

check("台帳に名前も生年月日も出さない", () => {
  const src = read("server/db/lapsed.mjs");
  for (const bad of ["name_kr", "name_kanji", "birth_date", "display_name"]) {
    assert(!src.includes(bad), `${bad} を出しています（配置ログは誰でも読めます）`);
  }
  return "id と日数だけ";
});


/* ================================================================== */
head("[修了]  101 日目の翌朝、静かに何も来なくなる、を作らない");

check("修了の案内を送る", () => {
  const src = stripComments(read("server/db/push-daily.mjs"));
  assert(/completionNotice/.test(src), "修了の文面を送っていません");
  assert(/countByType\(conn, u\.id, "completion"\)/.test(src),
    "二度送らない判定がありません");
  return "1 度だけ";
});

check("修了の案内から次のコースへ行ける", () => {
  const m = checkout.completionNotice("beginner", { owned: ["beginner"] });
  assert(m.quickReply && m.quickReply.items.length >= 1, "次への導線がありません");
  assert(m.quickReply.items.some((i) => /action=plan&track=/.test(i.action.data)),
    "価格表へ繋がっていません");
  return "次のコース / もう一度";
});


/* ================================================================== */
head("[依存]  関門が install なしで走り続けること");

check("Stripe SDK を入れていない", () => {
  const pkg = JSON.parse(read("server/package.json"));
  const deps = Object.keys(pkg.dependencies || {});
  assert(deps.length === 1 && deps[0] === "mysql2",
    `依存が増えています: ${deps.join(", ")}`);
  const src = read("server/lib/stripe.mjs");
  assert(!/from ["']stripe["']/.test(src), "stripe を import しています");
  assert(/fetch\(/.test(src), "fetch を使っていません");
  return "mysql2 だけ";
});

check("repo/ は渡された conn しか使わない（新しい 2 つも）", () => {
  for (const f of ["server/lib/repo/entitlements.mjs", "server/lib/repo/lapses.mjs"]) {
    const src = read(f);
    assert(!/from ["']mysql2/.test(src), `${f} が mysql2 を読んでいます`);
    assert(!/from ["']node:/.test(src), `${f} が node の組み込みを読んでいます`);
  }
  return "entitlements / lapses";
});


/* ================================================================== */
head("[体験]  申込＝同意の時点が 1 日目（指示書 §2）");

const { handlePostback } = await import("../server/lib/handlers/postback.mjs");
const TRIAL_EVENT = { source: { userId: "U_t" }, replyToken: "rt",
  postback: { data: "action=trial&track=beginner" } };
const TRIAL_ROWS = {
  "FROM users": [{ id: 7, line_user_id: "U_t", display_name: "t", name_kanji: null,
    name_reading: "たろう", name_kr: "타로", name_source: "web",
    status: "active", active_track: null }],
  "COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 50 }]
};

await acheck("申込が通ったら、その場で deliverNow（creditFromStripe と同じ形）", async () => {
  const conn = fakeConn(TRIAL_ROWS);
  const delivered = [];
  const r = await handlePostback(conn, TRIAL_EVENT, {
    send: async () => ({}),
    deliver: async (_c, userId) => { delivered.push(userId); return "送信:1日目"; },
    push: async () => ({})
  });
  assert(r.started === true, JSON.stringify(r));
  assert(delivered.length === 1 && delivered[0] === 7,
    `deliverNow が ${delivered.length} 回（1 回・本人のはず）`);
  return "「このあとすぐ 1 日目」が事実になる";
});

await acheck("送れない答え（対象外）には一言そえる。体験開始は壊さない", async () => {
  const conn = fakeConn(TRIAL_ROWS);
  const pushed = [];
  const r = await handlePostback(conn, TRIAL_EVENT, {
    send: async () => ({}),
    deliver: async () => "対象外",
    push: async (_to, m) => { pushed.push(...m); return {}; }
  });
  assert(r.started === true, JSON.stringify(r));
  assert(pushed.length === 1 && /準備ができしだい/.test(pushed[0].text),
    "黙る種類の失敗に一言そえていません（「すぐ届く」と言った直後に無音になる）");
  return "対象外 → 準備ができしだい";
});

await acheck("二度目の体験は deliverNow を呼ばない", async () => {
  /* startTrial の INSERT が一意制約に当たる（1062）＝もう使った。 */
  const conn = fakeConn({ ...TRIAL_ROWS, "INSERT INTO subscriptions": () => { throw dupErr(); } });
  const delivered = [];
  const r = await handlePostback(conn, TRIAL_EVENT, {
    send: async () => ({}),
    deliver: async (_c, id) => { delivered.push(id); return "送信:1日目"; },
    push: async () => ({})
  });
  assert(r.started !== true, JSON.stringify(r));
  assert(delivered.length === 0, "使えない体験で 1 日目を送っています");
  return "used → 送らない";
});

await acheck("原稿が体験日数に満たないコースでは体験も始めない（§1-2）", async () => {
  const conn = fakeConn({ ...TRIAL_ROWS,
    "COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 0 }] });
  const delivered = [];
  const r = await handlePostback(conn, TRIAL_EVENT, {
    send: async () => ({}),
    deliver: async (_c, id) => { delivered.push(id); return "送信:1日目"; },
    push: async () => ({})
  });
  assert(r.blocked === "原稿不足", JSON.stringify(r));
  assert(delivered.length === 0, "原稿 0 のコースで体験を始めています");
  return "準備中 → 始めない";
});

/* ================================================================== */
head("[half-done]  台帳があれば日数もある（plan-outage-billing §2）");

await acheck("決済の記録と日数は 1 つのトランザクションで書く", async () => {
  /* transact を差し替えて、creditPurchase の SQL が全部 tx を
     通ることを見る ── 一部でも素の conn に流れると、くくった意味が無い。 */
  const outer = fakeConn({
    "FROM users": [{ id: 7, line_user_id: "U_t", status: "active", active_track: null }]
  });
  const tx = fakeConn({
    "FROM course_entitlements": [{ track: "beginner", days_entitled: 30, days_used: 0,
                                   current_day: 0, remaining: 30 }]
  });
  let wrapped = 0;
  const r = await checkout.creditFromStripe(outer,
    { sessionId: "cs_x", userId: 7, track: "beginner", packageType: "30days", amount: 2980 },
    { transact: async (fn) => { wrapped++; return fn(tx); },
      send: async () => ({}) });
  assert(wrapped === 1, `transact が ${wrapped} 回（1 回のはず）`);
  const writes = tx.sql().filter((s) => /INSERT INTO purchases|INSERT INTO course_entitlements|UPDATE subscriptions/i.test(s));
  assert(writes.some((s) => /INSERT INTO purchases/i.test(s))
      && writes.some((s) => /INSERT INTO course_entitlements/i.test(s)),
    "台帳と日数が同じ tx を通っていません");
  assert(!outer.sql().some((s) => /INSERT INTO purchases|INSERT INTO course_entitlements/i.test(s)),
    "tx の外（素の conn）で台帳・日数を書いています");
  return "purchases + grant + subscriptions が同じ tx";
});

await acheck("トランザクションが失敗したら、日数は 1 日も付かない", async () => {
  /* grant で死ぬ tx。withTransaction 相当のロールバックを模す ──
     transact が例外を外へ返し、呼び側が ok:false で受けること。 */
  const outer = fakeConn({
    "FROM users": [{ id: 7, line_user_id: "U_t", status: "active", active_track: null }]
  });
  const r = await checkout.creditFromStripe(outer,
    { sessionId: "cs_y", userId: 7, track: "beginner", packageType: "30days", amount: 2980 },
    { transact: async (fn) => {
        const tx = fakeConn({ "INSERT INTO course_entitlements": () => {
          throw new Error("死んだ（grant 直前）"); } });
        return fn(tx);   /* rollback の模擬: 例外はそのまま上へ */
      },
      send: async () => ({}) }).catch((e) => ({ ok: false, threw: e.message }));
  assert(r.ok === false, `失敗が握りつぶされています: ${JSON.stringify(r)}`);
  assert(!outer.sql().some((s) => /INSERT/i.test(s)), "外の conn に書き込みが漏れています");
  return "例外は外へ ── 200 を返す前に気づける形";
});

await acheck("startTrial も同じ形（半分成功が体験を永久に殺す）", async () => {
  const src = stripComments(read("server/lib/handlers/checkout.mjs"));
  const fn = src.match(/export async function startTrialFor[\s\S]*?\n}/)[0];
  assert(/transact\(\s*\(tx\)\s*=>\s*billing\.startTrial\(tx/.test(fn),
    "startTrial が transact でくくられていません");
  /* 本番配線: app → webhook → postback に withTransaction が通ること。 */
  const app = stripComments(read("server/app.mjs"));
  assert(/handleWebhookBody\(pool, body, \{ transact: withTransaction \}\)/.test(app),
    "app.mjs が withTransaction を渡していません");
  return "trial も台帳＋日数が 1 つ / 本番配線あり";
});

await acheck("逆方向の突き合わせ ── 行ごと無い half-done を拾う", async () => {
  const conn = fakeConn({
    "FROM purchases p": [{ user_id: 9, track: "beginner", bought: 30 }],
    "FROM subscriptions s": [{ user_id: 11, track: "intermediate" }]
  });
  const r = await billing.findMissingEntitlements(conn);
  assert(r.fromPurchases.length === 1 && r.fromPurchases[0].user_id === 9,
    "購入の half-done を拾えていません");
  assert(r.fromTrials.length === 1 && r.fromTrials[0].user_id === 11,
    "体験の half-done（再試行できない状態）を拾えていません");
  assert(!conn.sql().some((s) => /INSERT|UPDATE|DELETE/i.test(s)),
    "検出のはずが書き込んでいます（自動修正は禁止）");
  return "purchases 起点 + subscriptions 起点 / 読むだけ";
});

check("async_payment_succeeded を受ける（コンビニ・振込の入金）", () => {
  const base = { data: { object: { id: "cs_1", payment_status: "paid",
    metadata: { user_id: "7", track: "beginner", package: "30days" }, amount_total: 2980 } } };
  const a = readCheckoutEvent({ ...base, type: "checkout.session.async_payment_succeeded" });
  assert(a && a.sessionId === "cs_1", "async_payment_succeeded を捨てています（入金したのに日数 0）");
  /* completed(unpaid) は従来どおり捨てる ── 振込の「まだ払っていない」 */
  const unpaid = readCheckoutEvent({ type: "checkout.session.completed",
    data: { object: { ...base.data.object, payment_status: "unpaid" } } });
  assert(unpaid === null, "未払いを日数に替えています");
  /* 無関係のイベントは従来どおり */
  assert(readCheckoutEvent({ ...base, type: "charge.refunded" }) === null, "知らないイベントを受けています");
  return "async(paid) 受理 / completed(unpaid) 拒否";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
