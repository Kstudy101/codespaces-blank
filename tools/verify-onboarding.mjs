#!/usr/bin/env node
/* ==================================================================
   verify-onboarding.mjs — ウェブの四柱を LINE に繋ぐ（P3）

     使い方:  node tools/verify-onboarding.mjs

   MySQL も npm install も要らない。handlers は conn を受け取るだけ。

   見張っているのは、OAuth で間違えると取り返しがつかない所:

     1 state    予測できない / DB には生で置かない / 1 回しか使えない
     2 順番     state を引き当ててから code を交換する
     3 入力     生年月日の範囲・長さ・大きさ。ウェブから来る唯一の口
     4 出口     名前をそのまま HTML に出さない
     5 CORS     どのサイトからでも投げ込める状態にしない
     6 取り違え Login と Messaging API のチャネルが別プロバイダーの検知

   6 がいちばん静か。別プロバイダーだと userId が別物になり、
   登録も保存も成功したのに配信だけが永久に届かない。
   エラーはどこにも出ないので、配信が始まる朝まで誰も気づけない。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
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

const { newState, hashState, looksLikeState } = await import("../server/lib/token.mjs");
const { normalizeProfile, startLink, completeLink } =
  await import("../server/lib/handlers/link.mjs");
const { resultPage, escapeHtml } = await import("../server/lib/pages.mjs");
const links = await import("../server/lib/repo/links.mjs");

const SCHEMA = read("server/db/schema.sql");
const APP = stripComments(read("server/app.mjs"));
const LINK_SRC = stripComments(read("server/lib/handlers/link.mjs"));

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

/* env が無いと authorizeUrl が投げる。検証用の値を入れておく。 */
process.env.LINE_LOGIN_CHANNEL_ID = "1234567890";
process.env.LINE_LOGIN_CHANNEL_SECRET = "login_secret";
process.env.LINE_LOGIN_REDIRECT_URI = "https://example.test/line/callback";


/* ================================================================== */
head("[state]  推測できたら、他人の四柱を自分の LINE に付け替えられる");

check("32 バイトの暗号乱数。Math.random ではない", () => {
  const src = stripComments(read("server/lib/token.mjs"));
  assert(/randomBytes\(32\)/.test(src), "randomBytes(32) を使っていません");
  assert(!/Math\.random/.test(src), "Math.random を使っています。予測できると state の意味が消えます");
  return "randomBytes(32)";
});

check("毎回違う値になる", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(newState());
  assert(seen.size === 2000, `2000 回中 ${seen.size} 種類しかありません`);
  return "2000 回すべて相異なる";
});

check("URL に載る形（base64url）。+ / = を含まない", () => {
  for (let i = 0; i < 500; i++) {
    const s = newState();
    assert(/^[A-Za-z0-9_-]{43}$/.test(s), `URL に載らない文字が出ました: ${s}`);
  }
  return "43 文字 base64url";
});

check("形の違う state は DB を引く前に弾く", () => {
  assert(looksLikeState(newState()), "本物を弾きました");
  for (const bad of ["", "short", "a".repeat(44), "a/b+c=", null, undefined, 12345,
                     "a".repeat(43) + "="]) {
    assert(!looksLikeState(bad), `${JSON.stringify(bad)} が通りました`);
  }
  return "8 通り拒否";
});

check("DB には生で置かない（SHA-256）", () => {
  const s = newState();
  const h = hashState(s);
  assert(/^[0-9a-f]{64}$/.test(h), `ハッシュに見えません: ${h}`);
  assert(h !== s, "生の値がそのまま入ります");
  assert(hashState(s) === h, "同じ値から同じハッシュが出ません");
  return "64 桁 16 進";
});

check("schema も state_hash という名前で持っている", () => {
  assert(/state_hash\s+CHAR\(64\)\s+PRIMARY KEY/.test(SCHEMA),
    "pending_links の主キーが state_hash ではありません");
  assert(!/\bstate\s+(VARCHAR|CHAR)/.test(SCHEMA), "生の state を持つ列があります");
  return "state_hash CHAR(64)";
});

check("1 回しか使えない（consumed_at を条件に入れた UPDATE）", () => {
  const src = stripComments(read("server/lib/repo/links.mjs"));
  const fn = src.match(/export async function consume[\s\S]*?\n}/)[0];
  assert(/UPDATE pending_links[\s\S]*?consumed_at IS NULL/.test(fn),
    "使用済みかどうかを UPDATE の条件に入れていません");
  assert(/expires_at > \?/.test(fn), "期限切れを条件に入れていません");
  assert(fn.indexOf("UPDATE") < fn.indexOf("SELECT"),
    "先に SELECT しています。戻るボタンの連打で 2 回とも通ります");
  return "UPDATE … WHERE consumed_at IS NULL";
});

await acheck("取れなかったら null（勝った側だけが進む）", async () => {
  const conn = fakeConn({ "UPDATE pending_links": { affectedRows: 0 } });
  const r = await links.consume(conn, hashState(newState()), { now: "2026-08-03 10:00:00" });
  assert(r === null, JSON.stringify(r));
  assert(!conn.calls.some((c) => /SELECT/i.test(c.sql)), "負けたのに読みに行きました");
  return "null";
});


/* ================================================================== */
head("[順番]  state を引き当ててから code を交換する");

check("consume が exchangeCode より先にある", () => {
  const fn = LINK_SRC.match(/export async function completeLink[\s\S]*?\n}/)[0];
  const c = fn.indexOf("links.consume");
  const x = fn.indexOf("exchangeCode");
  assert(c > 0 && x > 0, "どちらかを呼んでいません");
  assert(c < x,
    "先に code を交換しています。state を確かめる前に LINE を叩くと、"
    + "総当たりの相手をこちらが代わりに務めることになります");
  return "consume → exchangeCode";
});

await acheck("state の形が違えば、DB も LINE も叩かない", async () => {
  const conn = fakeConn();
  const r = await completeLink(conn, { code: "c", state: "not-a-state" });
  assert(r.ok === false && r.kind === "bad_state", JSON.stringify(r));
  assert(conn.calls.length === 0, `SQL を ${conn.calls.length} 回投げました`);
  return "SQL 0 回";
});

await acheck("code が無ければ交換しない", async () => {
  const r = await completeLink(fakeConn(), { state: newState(), code: null });
  assert(r.ok === false && r.kind === "bad_code", JSON.stringify(r));
  return "bad_code";
});

await acheck("同意画面でキャンセルされたら declined（異常にしない）", async () => {
  const conn = fakeConn();
  const r = await completeLink(conn, { error: "access_denied", errorDescription: "user denied" });
  assert(r.ok === false && r.kind === "declined", JSON.stringify(r));
  assert(conn.calls.length === 0, "キャンセルなのに DB を触りました");
  return "declined";
});

await acheck("期限切れ・使用済みは同じ返し方（どこで弾いたか教えない）", async () => {
  const conn = fakeConn({ "UPDATE pending_links": { affectedRows: 0 } });
  const r = await completeLink(conn, { code: "c", state: newState() });
  assert(r.kind === "expired", JSON.stringify(r));
  return "expired";
});


/* ================================================================== */
head("[入力]  ウェブから来る唯一の口。中身は利用者が作れる");

check("生年月日は 1930〜2030 の YYYY-MM-DD だけ", () => {
  assert(normalizeProfile({ birthDate: "1995-04-12" }).birthDate === "1995-04-12", "正常な値を弾きました");
  for (const bad of ["1929-12-31", "2031-01-01", "1995-13-01", "1995-02-30",
                     "95-04-12", "1995/04/12", "", null, "abc"]) {
    assert(normalizeProfile({ birthDate: bad }).birthDate === null,
      `${JSON.stringify(bad)} が通りました`);
  }
  return "9 通り拒否 / 範囲は birth.js と同じ";
});

/* 切り詰めてから形を見ると通ってしまう組。UTC の夜は JST では翌日なので、
   黙って受けると日柱が 1 日ずれた四柱を保存する。値は「それらしい日付」の
   ままなので、あとから見比べても気づけない。 */
check("日時つきの文字列を、日付として受け取らない", () => {
  for (const bad of ["1995-04-12T00:00:00Z", "1995-04-12T23:00:00Z",
                     "1995-04-12 09:30", "1995-04-12Z"]) {
    assert(normalizeProfile({ birthDate: bad }).birthDate === null,
      `${bad} が ${normalizeProfile({ birthDate: bad }).birthDate} として通りました`);
  }
  for (const bad of ["09:30:15+09:00", "09:30:15.123"]) {
    assert(normalizeProfile({ birthTime: bad }).birthTime === null,
      `${bad} が ${normalizeProfile({ birthTime: bad }).birthTime} として通りました`);
  }
  return "日付 4 通り / 時刻 2 通りを拒否";
});

check("存在しない日付を弾く（2 月 30 日）", () => {
  assert(normalizeProfile({ birthDate: "2026-02-30" }).birthDate === null, "2/30 が通りました");
  assert(normalizeProfile({ birthDate: "2028-02-29" }).birthDate === "2028-02-29", "閏日を弾きました");
  return "2/30 拒否 / 閏日は通す";
});

check("名前は列幅で切る（DB まで届かせない）", () => {
  const p = normalizeProfile({ nameKanji: "あ".repeat(200), nameKr: "가".repeat(200) });
  assert(p.nameKanji.length === 50, `${p.nameKanji.length} 文字`);
  assert(p.nameKr.length === 50, `${p.nameKr.length} 文字`);
  return "50 文字";
});

check("gender は 3 種以外を受けない", () => {
  assert(normalizeProfile({ gender: "F" }).gender === "F", "F を弾きました");
  for (const bad of ["X", "male", "", null, 1]) {
    assert(normalizeProfile({ gender: bad }).gender === "U", `${JSON.stringify(bad)} が通りました`);
  }
  return "M / F / U 以外は U";
});

check("時刻は HH:MM も HH:MM:SS も受け、それ以外は捨てる", () => {
  assert(normalizeProfile({ birthTime: "09:30" }).birthTime === "09:30:00", "HH:MM を弾きました");
  assert(normalizeProfile({ birthTime: "09:30:15" }).birthTime === "09:30:15", "HH:MM:SS を弾きました");
  for (const bad of ["9:30", "25時", "abc", ""]) {
    assert(normalizeProfile({ birthTime: bad }).birthTime === null, `${bad} が通りました`);
  }
  return "2 形式のみ";
});

await acheck("大きすぎる rawResult は預からない（保管庫にしない）", async () => {
  const conn = fakeConn();
  const r = await startLink(conn, {
    birthDate: "1995-04-12",
    rawResult: { pad: "x".repeat(20000) }
  });
  assert(r.ok === false && /大きすぎ/.test(r.reason), JSON.stringify(r));
  assert(conn.calls.length === 0, "却下したのに DB へ書きました");
  return "8KB 上限";
});

await acheck("生年月日が無ければ預からない", async () => {
  const conn = fakeConn();
  const r = await startLink(conn, { nameKr: "다나카" });
  assert(r.ok === false, JSON.stringify(r));
  assert(conn.calls.length === 0, "却下したのに DB へ書きました");
  return "却下";
});

await acheck("正常なら state と認証 URL を返す", async () => {
  const conn = fakeConn();
  const r = await startLink(conn, {
    nameKanji: "武田 花子", nameKr: "다케다 하나코",
    birthDate: "1995-04-12", birthTime: "09:30", gender: "F", ohaengMain: "목"
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(looksLikeState(r.state), r.state);
  const u = new URL(r.authorizeUrl);
  assert(u.host === "access.line.me", u.host);
  assert(u.searchParams.get("state") === r.state, "state が URL に載っていません");
  assert(u.searchParams.get("response_type") === "code", "response_type が code ではありません");
  assert(u.searchParams.get("client_id") === "1234567890", "client_id が違います");
  /* DB に入るのはハッシュ。生の state が SQL のパラメータに現れてはいけない。 */
  const ins = conn.calls.find((c) => /INSERT INTO pending_links/.test(c.sql));
  assert(ins, "預かっていません");
  assert(!ins.params.includes(r.state), "生の state を DB へ書いています");
  assert(ins.params.includes(hashState(r.state)), "ハッシュを書いていません");
  return "state / authorizeUrl / ハッシュのみ保存";
});

check("scope は profile だけ（要らない同意を求めない）", () => {
  const src = stripComments(read("server/lib/linelogin.mjs"));
  assert(/scope:\s*"profile"/.test(src), "scope が profile ではありません");
  return "profile";
});


/* ================================================================== */
head("[出口]  名前をそのまま HTML に出さない");

check("HTML の特殊文字を全部逃がす", () => {
  const got = escapeHtml(`<script>alert('x')&"`);
  assert(!/[<>]/.test(got), got);
  assert(got === "&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;", got);
  return "& < > \" ' の 5 つ";
});

check("名前に script を入れても、そのまま出ない", () => {
  const html = resultPage({ ok: true, nameKr: '<script>alert(1)</script>', friend: true });
  assert(!/<script>alert/.test(html), "生のまま出ました");
  assert(/&lt;script&gt;/.test(html), "エスケープされた形が見当たりません");
  return "エスケープ済み";
});

check("友だち追加リンクもエスケープして出す", () => {
  process.env.LINE_ADD_FRIEND_URL = 'https://x.test/"><script>alert(1)</script>';
  const html = resultPage({ ok: true, nameKr: "다나카", friend: false });
  assert(!/<script>alert/.test(html), "URL 経由で入りました");
  delete process.env.LINE_ADD_FRIEND_URL;
  return "属性値も逃がす";
});

check("まだ友だちでない人には、その一歩を伝える", () => {
  const html = resultPage({ ok: true, nameKr: "다나카", friend: false });
  assert(/友だち追加/.test(html), "追加を促していません");
  assert(/あと一歩/.test(html), "完了したかのように見えます");
  return "追加ボタンを出す";
});

check("失敗の画面で、どこで弾かれたかを言わない", () => {
  const a = resultPage({ ok: false, kind: "expired" });
  const b = resultPage({ ok: false, kind: "bad_state" });
  assert(a === b, "state の形違いと期限切れで別の画面を出しています");
  return "同じ文面";
});

check("結果ページは noindex", () => {
  const html = resultPage({ ok: true, nameKr: "다나카", friend: true });
  assert(/name="robots" content="noindex"/.test(html), "noindex がありません");
  return "noindex";
});

check("外部リソースを読まない（別ホストなので page.css は無い）", () => {
  const html = resultPage({ ok: true, nameKr: "다나카", friend: true });
  assert(!/<link[^>]+stylesheet/.test(html), "外部 CSS を読んでいます");
  assert(!/<script/.test(html), "スクリプトを読んでいます");
  return "自己完結";
});


/* ================================================================== */
head("[CORS]  生年月日を受ける口を、どのサイトにも開けない");

check("* で許可していない", () => {
  assert(!/Allow-Origin["']?\s*[:=]\s*["']\*/.test(APP),
    "Access-Control-Allow-Origin を * にしています");
  return "オリジンを列挙";
});

check("許可オリジンは環境変数から。既定はサイト本体だけ", () => {
  assert(/ALLOWED_ORIGINS/.test(APP), "環境変数で分けていません");
  assert(/www\.kstudy101\.jp/.test(APP), "既定にサイトのオリジンがありません");
  return "ALLOWED_ORIGINS";
});

check("Vary: Origin を返す（間に立つキャッシュ対策）", () => {
  assert(/"Vary":\s*"Origin"/.test(APP),
    "Vary がありません。1 人ぶんの応答が別オリジンの人へ配られえます");
  return "Vary: Origin";
});

check("preflight（OPTIONS）に応える", () => {
  assert(/OPTIONS/.test(APP), "OPTIONS を扱っていません。JSON の POST は preflight が飛びます");
  assert(/send\(res, 204/.test(APP), "204 を返していません");
  return "204";
});

check("許可外のオリジンからの POST は 403", () => {
  assert(/ALLOWED_ORIGINS\.includes\(origin\)[\s\S]{0,200}?403/.test(APP),
    "許可外オリジンを断っていません");
  return "403";
});

check("Cookie を使わない（credentials を許可しない）", () => {
  assert(!/Allow-Credentials/.test(APP), "credentials を許可しています");
  return "Cookie 無し";
});


/* ================================================================== */
head("[チャネルの取り違え]  別プロバイダーだと配信だけが永久に届かない");

check("リンク完了時に Messaging API 側へ問い合わせる", () => {
  const fn = LINK_SRC.match(/export async function completeLink[\s\S]*?\n}\n/)[0];
  assert(/getProfile\(lineUserId\)/.test(fn),
    "Messaging API 側で userId を確かめていません。"
    + "別プロバイダーのチャネルだと、登録は成功して配信だけが届きません");
  assert(/friend/.test(fn), "結果を返していません");
  return "getProfile で確かめる";
});

check("問い合わせに失敗しても、リンク自体は成功させる", () => {
  const fn = LINK_SRC.match(/export async function completeLink[\s\S]*?\n}\n/)[0];
  const at = fn.indexOf("getProfile(lineUserId)");
  assert(fn.slice(0, at).includes("upsertSajuProfile"),
    "確認の前に保存していません。確認が失敗すると引き継ぎごと落ちます");
  return "保存 → 確認";
});

check("届かない相手はログに残す（設置時に気づけるように）", () => {
  assert(/プロバイダー/.test(APP),
    "app.mjs に取り違えの注意がありません。設置直後に気づく手がかりが要ります");
  return "logErr に出す";
});

/* 宛先の差し替えは手元で流れを通すために入れた。残ったまま本番が
   動くと、鍵をよそのホストへ送り続けることになる ── 相手が 200 を
   返す限り、画面上は正常にしか見えない。 */
check("試験用の宛先が残っていたら起動を止める", () => {
  assert(/LINE_API_BASE/.test(APP) && /LINE_AUTH_BASE/.test(APP),
    "app.mjs が宛先の差し替えを見ていません");
  assert(/ALLOW_FAKE_LINE/.test(APP), "明示的な許可なしで通しています");
  assert(/process\.exit\(1\)/.test(APP), "止めていません");
  return "ALLOW_FAKE_LINE=1 のときだけ許す";
});

check("宛先の既定は本物の LINE", () => {
  const login = stripComments(read("server/lib/linelogin.mjs"));
  const msg = stripComments(read("server/lib/line.mjs"));
  assert(/\|\|\s*"https:\/\/access\.line\.me"/.test(login), "authorize の既定が違います");
  assert(/\|\|\s*"https:\/\/api\.line\.me"/.test(login), "token の既定が違います");
  assert(/\|\|\s*"https:\/\/api\.line\.me"/.test(msg), "Messaging API の既定が違います");
  return "access.line.me / api.line.me";
});

check("Login と Messaging API のシークレットを取り違えていない", () => {
  const login = stripComments(read("server/lib/linelogin.mjs"));
  const msg = stripComments(read("server/lib/line.mjs"));
  assert(/LINE_LOGIN_CHANNEL_SECRET/.test(login) && !/LINE_CHANNEL_SECRET\b/.test(login),
    "linelogin.mjs が Messaging API のシークレットを読んでいます");
  assert(/LINE_CHANNEL_ACCESS_TOKEN/.test(msg) && !/LINE_LOGIN/.test(msg),
    "line.mjs が Login の値を読んでいます");
  return "env が分かれている";
});


/* ================================================================== */
head("[預かりもの]  生年月日を、使われないまま持ち続けない");

check("期限つきで預かる（30 分）", () => {
  assert(links.TTL_MINUTES === 30, `${links.TTL_MINUTES} 分`);
  assert(/expires_at\s+DATETIME\s+NOT NULL/.test(SCHEMA), "期限の列がありません");
  return "30 分";
});

await acheck("期限切れを落とす手立てがある", async () => {
  const conn = fakeConn({ "DELETE FROM pending_links": { affectedRows: 12 } });
  const n = await links.purgeExpired(conn, { now: "2026-08-03 10:00:00" });
  assert(n === 12, `${n} 件`);
  assert(/expires_at <= \?/.test(conn.calls[0].sql), conn.calls[0].sql);
  return "purgeExpired";
});

check("期限の索引がある（毎日消すので）", () => {
  assert(/KEY ix_pending_expires \(expires_at\)/.test(SCHEMA), "索引がありません");
  return "ix_pending_expires";
});

check("pending_links は utf8mb4", () => {
  const c = SCHEMA.match(/CREATE TABLE IF NOT EXISTS pending_links[\s\S]*?ENGINE=\w+[^;]*/)[0];
  assert(/CHARSET=utf8mb4/.test(c), "utf8mb4 ではありません");
  return "utf8mb4";
});

check("repo/links.mjs も node の組み込みに触らない（P1 の約束）", () => {
  const src = stripComments(read("server/lib/repo/links.mjs"));
  assert(!/from\s+"node:/.test(src),
    "repo/ が node の組み込みを読んでいます。ハッシュ化は lib/token.mjs の担当です");
  return "conn だけで動く";
});


/* ================================================================== */
head("[サイト側]  このサイトで唯一、入力がサーバーへ出ていくボタン");

const INDEX = read("index.html");
const PRIVACY = read("privacy.html");

/* 「送信しない」と書いてあるうちは、送信するボタンを出してはいけない。
   人の注意ではなく、ここで順番を固定する。 */
/* 行頭に固定する。注釈の中の「例: const LINE_LINK_API = 'https://…'」を
   拾うと、設定していないのに設定済みと読んでしまう。 */
const apiSet = (() => {
  const m = INDEX.match(/^const LINE_LINK_API\s*=\s*['"]([^'"]*)['"]/m);
  assert(m, "index.html に LINE_LINK_API の宣言がありません");
  return m[1].trim();
})();

const privacyStillSaysNever =
  /サーバーに送信されず、保存もされません/.test(PRIVACY) ||
  /入力内容の送信は行いません/.test(PRIVACY);

check("privacy.html が「送信しない」と書いている間は、連携先を設定しない", () => {
  if (!apiSet) {
    assert(privacyStillSaysNever || true, "");
    return "LINE_LINK_API 未設定 → カードは出ない";
  }
  assert(!privacyStillSaysNever,
    "LINE_LINK_API が設定されているのに、privacy.html はまだ\n"
    + "      「サーバーに送信されず、保存もされません」と書いています。\n"
    + "      先に文言を直してください（順番を逆にすると、書いてあることと\n"
    + "      動きが食い違ったまま公開されます）");
  return `連携先 ${apiSet} / 文言も更新済み`;
});

check("カードは既定で伏せてある", () => {
  assert(/<div class="card" id="s-line" hidden>/.test(INDEX),
    "#s-line に hidden がありません");
  return "hidden";
});

/* linkFields() だけを取り出して動かす。使うのは state と Saju.CITIES
   だけなので、index.html 全体を読み込まなくても評価できる。 */
const linkSrc = INDEX.match(/function linkFields\(b\)\{[\s\S]*?\n\}/);
assert(linkSrc, "linkFields が見つかりません");

const STATE = {
  seiK: "武田", meiK: "花子", seiF: "たけだ", meiF: "はなこ",
  fullH: "다케다 하나코", ohaengKo: "목", zodiac: "돼지", hanjaEum: { 武: "무" }
};
const SAJU = { CITIES: [{ id: "tokyo", ja: "東京", ko: "도쿄" }] };
const BIRTH = { y: 1995, m: 4, d: 12, hour: 9, city: "tokyo" };
const BIRTH_NO_HOUR = { y: 1995, m: 4, d: 12, hour: null, city: "tokyo" };

const linkFields = new Function("state", "Saju", `${linkSrc[0]}; return linkFields;`)(STATE, SAJU);

check("送る値は、すべて画面に出す名前を持っている（gender を除く）", () => {
  for (const f of linkFields(BIRTH)) {
    if (f.value === null || f.value === undefined) continue;
    if (f.key === "gender") {
      /* 訊いていないので固定値。画面に出さない代わりに、
         中身が 'U'（未回答）であることをここで縛る。 */
      assert(f.value === "U", `gender が ${f.value} です。この画面は性別を訊いていません`);
      assert(f.label === null, "訊いていないものを画面に出しています");
      continue;
    }
    assert(f.label, `${f.key} を送るのに、画面に出す名前がありません`);
    assert(f.shown, `${f.key} を送るのに、画面に出す値がありません`);
  }
  return `${linkFields(BIRTH).length} 項目`;
});

check("生年月日は YYYY-MM-DD。日時つきの文字列を作らない", () => {
  const p = Object.fromEntries(linkFields(BIRTH).map((f) => [f.key, f.value]));
  assert(p.birthDate === "1995-04-12", p.birthDate);
  assert(!/[TZ]/.test(p.birthDate),
    `${p.birthDate} ── UTC の夜は JST では翌日なので、日柱が 1 日ずれます`);
  assert(p.birthTime === "09:00:00", p.birthTime);
  return "1995-04-12 / 09:00:00";
});

check("時刻を答えていない人は、時刻を送らない", () => {
  const p = Object.fromEntries(linkFields(BIRTH_NO_HOUR).map((f) => [f.key, f.value]));
  assert(p.birthTime === null, `${p.birthTime} を送ろうとしています`);
  const shown = linkFields(BIRTH_NO_HOUR).find((f) => f.key === "birthTime").shown;
  assert(!shown, "送らないものを画面に出しています");
  return "null";
});

check("診断結果に、画面へ出していないものが混ざっていない", () => {
  const f = linkFields(BIRTH).find((x) => x.key === "rawResult");
  const keys = Object.keys(f.value);
  /* rawResult の中身は 1 行にまとめて出している。増やすときは
     shown の文も直すこと。 */
  assert(keys.length === 4 && keys.every((k) =>
    ["zodiac", "ohaeng", "city", "hanjaEum"].includes(k)),
    `中身が変わっています: ${keys.join(", ")}`);
  assert(/出生地/.test(f.shown), "出生地を送るのに、画面に出していません");
  return keys.join(" / ");
});

check("描画は esc() を通す（名前は利用者が入れた文字）", () => {
  const fn = INDEX.match(/function describeLinkPayload\(b\)\{[\s\S]*?\n\}/)[0];
  assert(/esc\(f\.label\)/.test(fn) && /esc\(f\.shown\)/.test(fn),
    "エスケープせずに埋めています");
  return "label / shown とも esc";
});

check("送信に失敗しても、診断結果は消さない", () => {
  const fn = INDEX.match(/async function startLineLink\(\)\{[\s\S]*?\n\}/)[0];
  assert(/catch/.test(fn), "失敗を拾っていません");
  assert(/btn\.disabled = false/.test(fn), "押し直せなくなります");
  assert(!/location\.reload|innerHTML\s*=\s*['"]/.test(fn), "画面を作り直しています");
  return "やり直せる";
});

check("「別の名前で試す」で、前の人の名前が残らない", () => {
  const fn = INDEX.match(/\$\('again'\)\.addEventListener[\s\S]*?\n\}\);/)[0];
  assert(/s-line-what'\)\.innerHTML = ''/.test(fn), "送信内容の表示が残ります");
  assert(/\$\('s-line'\)\.hidden = true/.test(fn), "カードが出たままになります");
  return "消してから伏せる";
});


console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
