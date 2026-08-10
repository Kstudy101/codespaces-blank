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
const { TRIAL_DAYS } = await import("../server/lib/repo/billing.mjs");
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

check("gender は 4 種以外を受けない（'N' = 答えないと答えた・migrations/005）", () => {
  assert(normalizeProfile({ gender: "F" }).gender === "F", "F を弾きました");
  assert(normalizeProfile({ gender: "N" }).gender === "N",
    "'N' を弾きました ── ENUM より狭い白リストは、来た日に黙って 'U' に化けます");
  for (const bad of ["X", "male", "", null, 1]) {
    assert(normalizeProfile({ gender: bad }).gender === "U", `${JSON.stringify(bad)} が通りました`);
  }
  return "M / F / U / N 以外は U";
});

check("サイトは gender を送らない（지시서⑱で⑩の『U を送る』検査を反転）", () => {
  const html = read("index.html");
  assert(!/key:'gender'/.test(html), "index.html が gender を送っています");
  return "전송 항목에서 소멸";
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

check("連携画面はコース選択を案内する（2026-08-06 指示書 C2）", () => {
  /* 「コースを選ぶとその場で 1 日目」は §2（コース選択の再設計）が
     入って初めて真になる ── この文面と §2 は同じ配備で出すこと。 */
  for (const friend of [true, false]) {
    const html = resultPage({ ok: true, nameKr: "다나카", friend });
    assert(/コースをお選びいただけます/.test(html), `friend=${friend}: コース選択の案内が無い`);
    assert(/その場で 1 日目/.test(html), `friend=${friend}: 1 日目の約束が無い`);
  }
  return "友だち前後どちらも同じ約束";
});

check("体験の一文は「はじめての方は」の条件つき（再連携で嘘にしない）", () => {
  /* この画面は再連携でも出る。条件句なしの「無料でお試し」は、
     体験を使い終えた人への嘘になる。日数は TRIAL_DAYS と揃える。 */
  for (const friend of [true, false]) {
    const html = resultPage({ ok: true, nameKr: "다나카", friend });
    const m = html.match(/はじめての方は[^<]*/);
    assert(m, `friend=${friend}: 条件句がありません`);
    assert(m[0].includes(`${TRIAL_DAYS} 日間`), `friend=${friend}: 日数が TRIAL_DAYS とずれています: ${m[0]}`);
    assert(/無料でお試しいただけます/.test(m[0]), m[0]);
  }
  return `はじめての方は ${TRIAL_DAYS} 日間`;
});

check("名前が未確定なら、名前の行ごと出さない（「null」「あなた」を出さない）", () => {
  for (const friend of [true, false]) {
    for (const nameKr of [null, undefined, ""]) {
      const html = resultPage({ ok: true, nameKr, friend });
      assert(!/null|undefined|あなた/.test(html), `friend=${friend}: 埋め草が出ました`);
      assert(!/お名前は/.test(html), `friend=${friend}: 空の名前行が出ています`);
    }
  }
  return "行ごと消える";
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
head("[サイト側]  LP 化後 — 診断→LINE Login 連携は廃止。友だち追加 CTA のみ");

const INDEX = read("index.html");
const PRIVACY = read("privacy.html");

/* 2026-08-10: index は LP。LINE_LINK_API / linkFields / #s-line は置かない。
   流入は lin.ee 友だち追加。保存の説明は privacy 第2項が正本のまま。 */
check("診断連携フォームを置いていない（LP）", () => {
  assert(!/^const LINE_LINK_API\s*=/m.test(INDEX),
    "LINE_LINK_API が残っています ── 診断連携は廃止済みです");
  assert(!/id="s-line"/.test(INDEX), "#s-line カードが残っています");
  assert(!/function linkFields\(/.test(INDEX), "linkFields が残っています");
  assert(/lin\.ee\/SKZtS5k/.test(INDEX), "友だち追加 URL がありません");
  return "診断連携なし・友だち追加 CTA";
});

const LINE_SECTION = /<h2>\d+\.\s*LINE 配信サービスについて<\/h2>/;

check("privacy.html に LINE 配信の保存説明がある", () => {
  assert(LINE_SECTION.test(PRIVACY),
    "privacy.html に「LINE 配信サービスについて」の項がありません");
  assert(/サーバーに保存します/.test(PRIVACY),
    "LINE の項はあるのに、保存すると書いていません");
  assert(/すべて消したい場合/.test(PRIVACY) && /\/contact/.test(PRIVACY),
    "削除の求め方が書かれていません");
  return "第2項・削除経路あり";
});

check("LINE の項は、保存するものを 1 つずつ挙げている", () => {
  if (!LINE_SECTION.test(PRIVACY)) return "第2項なし";
  for (const [what, re] of [
    ["名前",       /お名前・ふりがな・韓国語表記/],
    ["生年月日",   /生年月日・生まれた時刻/],
    ["LINE の ID", /LINE の利用者 ID・表示名/],
    ["学習の進み", /学習の進み/],
    ["配信の記録", /お届けの記録/],
    ["購入の記録", /ご購入の記録/]
  ]) assert(re.test(PRIVACY), `${what} が挙がっていません`);
  assert(!/性別/.test(PRIVACY), "性別の記載が残っています（もう集めていません）");
  assert(!/大運/.test(PRIVACY), "大運の説明が残っています");
  return "7 種を名指し・性別の記載 0";
});


/* ================================================================== */
head("[部分状態]  手で消された・欠けた行があっても袋小路にならない"
  + "（docs/research-onboarding-gap.md）");

const { nextStep, blockingStep, onboardingDone } = await import("../server/lib/onboarding.mjs");
const { healProgress } = await import("../server/lib/repo/learning.mjs");
const { handlePostback } = await import("../server/lib/handlers/postback.mjs");

check("部分状態 5 種で、次の質問が正しく導かれる", () => {
  /* サイト経由の状態には ohaeng_main を必ず載せる ── 実物は連携時に
     入る判別子で、これが無い状態は「直接流入」と読まれて新 4 段へ
     入る（plan-line-onboarding §2-4 安A。それ自体が仕様）。 */
  const CASES = [
    /* [状態, 期待 nextStep] */
    [{ name_source: null, name_kr: "하나코", display_name: "h", birth_date: "1990-01-01",
       birth_confirmed: false, ohaeng_main: "목", track: null }, "name",  "新規（連携直後）"],
    [{ name_source: "web", name_kr: "하나코", display_name: "h", birth_date: "1990-01-01",
       birth_confirmed: false, ohaeng_main: "목", track: null }, "birth", "①だけ済み"],
    [{ name_source: "web", name_kr: "하나코", display_name: "h", birth_date: "1990-01-01",
       birth_confirmed: true, ohaeng_main: "목", track: "beginner" }, null, "全部済み（再連携の代表口座）"],
    /* saju 行ごと消えた人 ── 以前は袋小路（null）だったが、いまは
       トークの中で生年月日から入れ直せる。部分削除の自己回復が
       状態機械そのものに備わった形。 */
    [{ name_source: "web", name_kr: "하나코", display_name: "h", birth_date: null,
       birth_confirmed: false, ohaeng_main: null, track: "beginner" }, "bdate", "saju 行が無い（部分削除 → 訊き直せる）"],
    /* 友だち追加だけ ── 以前は訊く材料が無く沈黙だったが、いまは
       読み仮名から始められる（7-3 の解消）。 */
    [{ name_source: null, name_kr: null, name_kanji: null, display_name: "h", birth_date: null,
       birth_confirmed: false, ohaeng_main: null, track: null }, "reading", "友だち追加だけ → 読みから始まる"],
    /* 直接流入の途中経過も 1 つずつ。 */
    [{ name_source: "line", name_kr: "타로", name_kanji: null, display_name: "h",
       birth_date: null, birth_confirmed: false, ohaeng_main: null, track: null },
      "bdate", "直接流入：名前だけ済み"],
    [{ name_source: "line", name_kr: "타로", name_kanji: null, display_name: "h",
       birth_date: "1990-01-01", birth_time: null, birth_confirmed: false,
       ohaeng_main: null, raw_result_json: null, track: null },
      "btime", "直接流入：日付まで（時刻は未質問）"],
    /* 性別は訊かない（⑱）── 出生地まで済めば要約確認へ直行。 */
    [{ name_source: "line", name_kr: "타로", name_kanji: null, display_name: "h",
       birth_date: "1990-01-01", birth_time: null, birth_confirmed: false,
       ohaeng_main: null, raw_result_json: { city: "tokyo" }, gender: "U", track: null },
      "birth", "直接流入：時刻わからない＋出生地まで → 要約確認"],
    [{ name_source: "line", name_kr: "타로", name_kanji: null, display_name: "h",
       birth_date: "1990-01-01", birth_time: "09:00:00", birth_confirmed: false,
       ohaeng_main: null, raw_result_json: { city: "seoul" }, gender: "F", track: null },
      "birth", "直接流入：全部答えた → 要約確認へ"]
  ];
  for (const [st, want, label] of CASES) {
    const got = nextStep(st);
    assert(got === want, `${label}: nextStep=${got}（${want} のはず）`);
    /* どの部分状態でも throw しない ── 袋小路の別の形は例外で落ちること */
    blockingStep(st);
  }
  return `${CASES.length} 状態`;
});

await acheck("要約確認の答えに、コース選択が続く（無応答で終わらない・欠損A）", async () => {
  /* birth ok=1、他の段は済み → followUp は track 段（コース選択）を返す。
     選択肢は原稿が体験日数ぶんあるコースだけ（§4-나）── beginner だけ
     원고 50、他は 0 の状況を作る。 */
  const row = [{ id: 7, line_user_id: "U", display_name: "h", name_kanji: null,
    name_reading: "はなこ", name_kr: "하나코", name_source: "web",
    status: "active", active_track: null }];
  const conn = fakeConn({
    "FROM users": row,
    "FROM saju_profiles": [{ user_id: 7, birth_date: "1990-01-01", birth_time: null,
      birth_confirmed: 1, ohaeng_main: "목" /* サイト経由の判別子 */ }],
    "SELECT COUNT\\(\\*\\) AS n FROM content_templates":
      (sql, params) => [{ n: params[0] === "beginner" ? 50 : 0 }],
    "FROM course_entitlements": []
  });
  let sent = null;
  const r = await handlePostback(conn,
    { source: { userId: "U" }, replyToken: "rt", postback: { data: "action=birth&ok=1" } },
    { send: async (_t, m) => { sent = m; return {}; } });
  assert(r.ok === true, JSON.stringify(r));
  assert(sent && sent.length === 1, "続きの 1 通がありません（最後の答えに無応答）");
  /* 2026-08-09 に代表が「どのコースで始めますか？」から안 C の文面へ。
     文面を変えるときは、ここも同じコミットで直すこと。 */
  assert(/ご希望のコースをお選びください/.test(sent[0].text), sent[0].text);
  /* 【2026-08-09 대표 확정】選ぶ前の断り 3 行（취소 불가・무료체험 1회・
     ［내 진도］）を選択画面から外したので、それを強制していた 3 つの
     検査もここで外した。外した経緯は checkout.mjs の同じ場所に書いてある
     ── 「無かったこと」にせず、どこに残りどこに残らないかを併記した。
     戻すときは向こうの文面と一緒に戻すこと。 */
  const items = sent[0].quickReply?.items || [];
  assert(items.length === 1 && items[0].action.data === "action=trackpick&track=beginner",
    `原稿 0 のコースが選択肢に出ています: ${JSON.stringify(items.map((i) => i.action.data))}`);
  return "要約確認 → コース選択（原稿のあるコースだけ）";
});

await acheck("コースを選んだあとの答えには、本当の締めが返る", async () => {
  /* active_track が立っていれば段は残っていない → onboardingDone。 */
  const row = [{ id: 7, line_user_id: "U", display_name: "h", name_kanji: null,
    name_reading: "はなこ", name_kr: "하나코", name_source: "web",
    status: "trial", active_track: "beginner" }];
  const conn = fakeConn({
    "FROM users": row,
    "FROM saju_profiles": [{ user_id: 7, birth_date: "1990-01-01", birth_time: null,
      birth_confirmed: 1, ohaeng_main: "목" }]
  });
  let sent = null;
  const r = await handlePostback(conn,
    { source: { userId: "U" }, replyToken: "rt", postback: { data: "action=birth&ok=1" } },
    { send: async (_t, m) => { sent = m; return {}; } });
  assert(r.ok === true, JSON.stringify(r));
  assert(sent && /準備が整いました/.test(sent[0].text), sent && sent[0].text);
  assert(/明日の朝/.test(sent[0].text), "コース選択済みの人に予告がありません");
  return "track あり → 明日の朝の予告";
});

await acheck("選べるコースが 0 なら準備中の一言 ── 段は pending のまま", async () => {
  /* 원고가 전 코스 3일 미만（승인 수정 3 상황）。無限の待機画面は
     作らず、事実だけ伝える。状態は書き換えない ── 원고가 들어오면
     다음 접점에서 자연히 다시 묻는다. */
  const row = [{ id: 7, line_user_id: "U", display_name: "h", name_kanji: null,
    name_reading: "はなこ", name_kr: "하나코", name_source: "web",
    status: "active", active_track: null }];
  const conn = fakeConn({
    "FROM users": row,
    "FROM saju_profiles": [{ user_id: 7, birth_date: "1990-01-01", birth_time: null,
      birth_confirmed: 1, ohaeng_main: "목" }],
    "SELECT COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 0 }],
    "FROM course_entitlements": []
  });
  let sent = null;
  await handlePostback(conn,
    { source: { userId: "U" }, replyToken: "rt", postback: { data: "action=birth&ok=1" } },
    { send: async (_t, m) => { sent = m; return {}; } });
  assert(sent && /準備中/.test(sent[0].text), sent && sent[0].text);
  assert(!/お知らせ/.test(sent[0].text), "能動通知を約束しています");
  assert(!conn.calls.some((c) => /UPDATE users/i.test(c.sql)),
    "案内のために状態を書き換えています");
  return "準備中の一言だけ・約束なし";
});

/* ---- コース選択（action=trackpick、plan-course-onboarding §3〜§4）---- */

const PICK_ROW = [{ id: 7, line_user_id: "U", display_name: "h", name_kanji: null,
  name_reading: "はなこ", name_kr: "하나코", name_source: "web",
  status: "active", active_track: null }];
const pickConn = (over = {}) => fakeConn({
  "FROM users": PICK_ROW,
  "FROM saju_profiles": [{ user_id: 7, birth_date: "1990-01-01", birth_time: null,
    birth_confirmed: 1, ohaeng_main: "목" }],
  "SELECT COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 50 }],
  ...over
});
const dupSubs = () => {
  throw Object.assign(new Error("Duplicate entry"), { errno: 1062, code: "ER_DUP_ENTRY" });
};

await acheck("コースを選ぶと体験が始まり、その場で 1 日目が動く ── 販売が閉じていても", async () => {
  /* この検査は SALES_MODE も法定表示 env も入れずに回る（＝closed）。
     それでも通ること自体が「販売ゲートの外」の実測（§4-가）。 */
  const conn = pickConn();
  let sent = null, deliveredTo = null;
  const r = await handlePostback(conn,
    { source: { userId: "U" }, replyToken: "rt", postback: { data: "action=trackpick&track=beginner" } },
    { send: async (_t, m) => { sent = m; return {}; },
      deliver: async (_c, id) => { deliveredTo = id; return "送信:1日目"; } });
  assert(r.started === true, JSON.stringify(r));
  assert(sent && /で始めます！/.test(sent[0].text), sent && sent[0].text);
  /* 2026-08-09 に代表が「1 日目」→「1日目」へ詰めた。 */
  assert(/このあとすぐ「1日目」/.test(sent[0].text), "開始案内の文面が違います");
  assert(deliveredTo === 7, `deliverNow が呼ばれていません: ${deliveredTo}`);
  assert(conn.calls.some((c) => /UPDATE users SET active_track/i.test(c.sql)),
    "active_track が立っていません");
  return "closed のまま 개시 안내 + 즉시 1일차";
});

await acheck("体験を使い切った人がコースを選ぶと、コースだけ立てて有料の入口を案内", async () => {
  const conn = pickConn({ "INSERT INTO subscriptions": dupSubs });
  let sent = null, delivered = false;
  const r = await handlePostback(conn,
    { source: { userId: "U" }, replyToken: "rt", postback: { data: "action=trackpick&track=beginner" } },
    { send: async (_t, m) => { sent = m; return {}; },
      deliver: async () => { delivered = true; return "送信:1日目"; } });
  assert(r.kind === "used", JSON.stringify(r));
  assert(!delivered, "体験を二度あげています");
  assert(sent && /1 回まで/.test(sent[0].text), sent && sent[0].text);
  assert(conn.calls.some((c) => /UPDATE users SET active_track/i.test(c.sql)),
    "active_track が立っていません（明朝の合流先が無い）");
  return "setActiveTrack + [受講料] 案内";
});

await acheck("原稿が体験日数ぶんも無いコースは、data を書き換えて名乗っても始めない", async () => {
  const conn = pickConn({ "SELECT COUNT\\(\\*\\) AS n FROM content_templates": [{ n: 2 }] });
  let sent = null;
  const r = await handlePostback(conn,
    { source: { userId: "U" }, replyToken: "rt", postback: { data: "action=trackpick&track=advanced" } },
    { send: async (_t, m) => { sent = m; return {}; },
      deliver: async () => "送信:1日目" });
  assert(r.blocked === "原稿不足", JSON.stringify(r));
  assert(sent && /準備中/.test(sent[0].text), sent && sent[0].text);
  assert(!conn.calls.some((c) => /INSERT INTO subscriptions/i.test(c.sql)),
    "原稿が無いのに体験を開始しました");
  return "選択肢の外からも止める";
});

check("反対方向の関門 ── trackpick に salesAllowedFor が**無い**こと", () => {
  /* plans/plan/buy はゲート必須、trackpick はゲート禁止。「ある」を
     確かめる関門だけだと、無料の入口に誰かがゲートを足した日に
     「Stripe が閉じている限り誰も始められない」へ静かに戻る。 */
  const src = stripComments(read("server/lib/handlers/postback.mjs"));
  const pick = src.match(/if \(action === "trackpick"\)[\s\S]*?(?=if \(action === "trial"\))/);
  assert(pick, "trackpick の分岐が見つかりません");
  assert(!/salesAllowedFor/.test(pick[0]),
    "trackpick が販売ゲートを通っています ── 無料の入口が Stripe に縛られます");
  for (const a of ["plans", "plan", "buy"]) {
    const block = src.match(new RegExp(`if \\(action === "${a}"\\)[\\s\\S]{0,700}`))[0];
    assert(/salesAllowedFor/.test(block), `${a} からゲートが消えています`);
  }
  return "trackpick 禁止 / plans・plan・buy 必須";
});

/* ================================================================== */
head("[答えたら必ず進む]  状態遷移の不変式（지시서⑩ §3）");

/* 段階 × 選択肢の全数。答えを**本物のハンドラに通して**保存値を捕まえ、
   その状態で nextStep を再計算する ── 同じ段階がもう一度出たら失敗。
   「答えない」「わからない」のように状態を何も変えない選択肢は、
   値から導出する設計にとって沈黙と区別がつかない ── それを人の
   注意ではなく機械が捕まえる。

   STEPS に段階を足すと、ここに登録するまで失敗する（自動カバー ──
   列運搬の自動探索関門と同じ思想）。見るのは**答えた直後**だけ:
   fix（項目を選んで直す）・ok=0（入れ直す）のような明示的な
   再質問は対象外。bplace の国タップは都市一覧へ進む 2 段 UI の
   中間なので、終端の答え（都市）だけを見る。 */

const { cities: cityList } = await import("../server/lib/fortune.mjs");
const { handlePostback: chainPost } = await import("../server/lib/handlers/postback.mjs");
const { STEPS: CHAIN_STEPS, nextStep: chainNext } = await import("../server/lib/onboarding.mjs");

function chainConn(st) {
  return {
    async execute(sql, params = []) {
      const flat = sql.replace(/\s+/g, " ");
      if (/UPDATE users SET name_source/i.test(flat)) {
        st.user.name_source = params[0]; return [{ affectedRows: 1 }, []];
      }
      if (/UPDATE users SET name_kanji = \?, name_reading = \?, name_kr = \?/i.test(flat)) {
        [st.user.name_kanji, st.user.name_reading, st.user.name_kr] = params;
        return [{ affectedRows: 1 }, []];
      }
      if (/UPDATE users SET active_track/i.test(flat)) {
        st.user.active_track = params[0]; return [{ affectedRows: 1 }, []];
      }
      if (/UPDATE saju_profiles SET birth_confirmed/i.test(flat)) {
        st.saju = { ...(st.saju || {}), birth_confirmed: params[0] };
        return [{ affectedRows: 1 }, []];
      }
      if (/INSERT INTO saju_profiles/i.test(flat)) {
        const [, bd, bt, g, oh, raw] = params;
        st.saju = { ...(st.saju || {}), birth_date: bd, birth_time: bt, gender: g,
          ohaeng_main: oh,
          raw_result_json: raw == null ? null
            : (typeof raw === "string" ? JSON.parse(raw) : raw) };
        return [{ affectedRows: 1, insertId: 1 }, []];
      }
      if (/SELECT COUNT\(\*\) AS n FROM content_templates/i.test(flat)) return [[{ n: 50 }], []];
      if (/FROM saju_profiles/i.test(flat)) return [st.saju ? [{ ...st.saju }] : [], []];
      if (/FROM users/i.test(flat)) return [[{ ...st.user }], []];
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }, []];
      return [[], []];
    }
  };
}
const chainShape = (st) => ({
  ...st.user,
  birth_date: st.saju?.birth_date ?? null,
  birth_time: st.saju?.birth_time ?? null,
  birth_confirmed: !!st.saju?.birth_confirmed,
  gender: st.saju?.gender ?? "U",
  ohaeng_main: st.saju?.ohaeng_main ?? null,
  raw_result_json: st.saju?.raw_result_json ?? null,
  track: st.user.active_track || null
});

const CU = { id: 7, line_user_id: "U", status: "trial", display_name: "たなか",
  name_kanji: null, name_reading: null, name_kr: null, name_source: null,
  active_track: null };
const CITY0 = cityList()[0].id;
const pb = (data, params = null) => ({ source: { userId: "U" }, replyToken: "rt",
  postback: params ? { data, params } : { data } });

/* 段階 → { base: その段階が出る状態, answers: 終端の答え（postback）} */
const CHAIN = {
  name: {
    base: () => ({ user: { ...CU, name_kanji: "田中", name_kr: "다나카" },
      saju: { birth_date: "1990-04-12", birth_confirmed: 1, gender: "U", ohaeng_main: "목" } }),
    answers: [pb("action=name&use=web"), pb("action=name&use=line"), pb("action=name&use=other")]
  },
  reading: {
    base: () => ({ user: { ...CU, name_source: "line", name_reading: "たなか" },
      saju: { birth_date: "1990-04-12", birth_confirmed: 1, gender: "U", ohaeng_main: "목" } }),
    answers: [pb("action=name&use=confirm&ok=1")]
  },
  bdate: {
    base: () => ({ user: { ...CU, name_source: "line", name_kr: "다나카" }, saju: null }),
    answers: [pb("action=bdate", { date: "1990-04-12" })]
  },
  btime: {
    base: () => ({ user: { ...CU, name_source: "line", name_kr: "다나카" },
      saju: { birth_date: "1990-04-12", birth_time: null, gender: "U",
              birth_confirmed: 0, ohaeng_main: null, raw_result_json: null } }),
    answers: [pb("action=btime", { time: "12:00" }), pb("action=btime&unknown=1")]
  },
  bplace: {
    base: () => ({ user: { ...CU, name_source: "line", name_kr: "다나카" },
      saju: { birth_date: "1990-04-12", birth_time: "12:00:00", gender: "U",
              birth_confirmed: 0, ohaeng_main: null, raw_result_json: null } }),
    answers: [pb(`action=bcity&id=${CITY0}`)]
  },
  /* bgender 段は削除（지시서⑱）── 도시를 답하면 그대로 요약 확인
     (birth)로 간다. bplace 의 전환 검사가 그 연결을 실측한다. */
  birth: {
    base: () => ({ user: { ...CU, name_source: "web", name_kanji: "田中", name_kr: "다나카" },
      saju: { birth_date: "1990-04-12", birth_time: null, gender: "U",
              birth_confirmed: 0, ohaeng_main: "목", raw_result_json: null } }),
    answers: [pb("action=birth&ok=1")]
  },
  track: {
    base: () => ({ user: { ...CU, name_source: "web", name_kanji: "田中", name_kr: "다나카" },
      saju: { birth_date: "1990-04-12", birth_time: null, gender: "U",
              birth_confirmed: 1, ohaeng_main: "목", raw_result_json: null } }),
    answers: [pb("action=trackpick&track=beginner")]
  }
};

await acheck("STEPS の全段階が遷移検査に登録されている（未登録は失敗）", async () => {
  for (const s of CHAIN_STEPS) {
    assert(CHAIN[s], `STEPS の「${s}」が遷移検査に未登録です ── 답이 상태를 바꾸는지 아무도 안 봅니다`);
  }
  for (const s of Object.keys(CHAIN)) {
    assert(CHAIN_STEPS.includes(s), `検査にだけある段階: ${s}`);
  }
  return `${CHAIN_STEPS.length} 段階`;
});

for (const [step, def] of Object.entries(CHAIN)) {
  await acheck(`「${step}」── どの答えでも、同じ質問には戻らない`, async () => {
    const notes = [];
    for (const ev of def.answers) {
      const st = structuredClone(def.base());
      const before = chainNext(chainShape(st));
      assert(before === step, `前提が崩れています: nextStep=${before}（${step} のはず）`);
      const r = await chainPost(chainConn(st), ev,
        { send: async () => ({}), deliver: async () => "送信:1日目", push: async () => ({}) });
      assert(!r.skipped, `ハンドラが答えを捨てました: ${JSON.stringify(r)}`);
      const after = chainNext(chainShape(st));
      assert(after !== step,
        `「${ev.postback.data}」に答えたのに同じ質問が出ます（状態が変わっていません）`);
      notes.push(`${ev.postback.data.replace("action=", "")}→${after ?? "済"}`);
    }
    return notes.join(" / ");
  });
}

check("messageForStep の呼び出しは全部 await + conn（Promise を LINE へ流さない）", () => {
  /* async 化したので、await を欠くと Promise オブジェクトがそのまま
     メッセージ配列に入る ── filter(Boolean) は Promise を通す。 */
  const FILES = ["server/lib/handlers/postback.mjs", "server/lib/handlers/message.mjs",
                 "server/lib/handlers/follow.mjs", "server/lib/handlers/link.mjs",
                 "server/db/push-daily.mjs"];
  let calls = 0;
  for (const f of FILES) {
    for (const line of stripComments(read(f)).split("\n")) {
      if (!line.includes("messageForStep(")) continue;
      if (/^\s*import|from "/.test(line)) continue;
      calls++;
      assert(/await messageForStep\(/.test(line), `${f}: await がありません: ${line.trim()}`);
      assert(/,\s*conn\s*\)/.test(line), `${f}: conn を渡していません: ${line.trim()}`);
    }
  }
  assert(calls >= 5, `呼び出しが ${calls} 箇所しか見つかりません`);
  return `${calls} 箇所とも await + conn`;
});

check("締めの 1 通はコースの有無で分かれる", () => {
  /* 見るのは「コースを選ぶ場所を名指ししているか」。以前は［受講料］の
     4 文字を探していたが、2026-08-09 に代表が「下のメニューから」へ
     文面を変えた ── 名指しの語が変わっただけで、導線は在る。
     文面を変えるときは、ここも同じコミットで直すこと。 */
  assert(/下のメニュー/.test(onboardingDone({ track: null }).text), "未購入者に導線がありません");
  assert(/明日の朝/.test(onboardingDone({ track: "beginner" }).text), "購入者に予告がありません");
  return "未購入 → 導線 / 購入済 → 予告";
});

await acheck("進みの器の自己回復 ── 欠けていて持ち日数が在るときだけ作る", async () => {
  const U = { id: 7, active_track: "beginner" };

  /* 欠けている + entitlement 在り → 作る */
  const heal = fakeConn({
    "FROM learning_progress WHERE user_id": [],
    "FROM course_entitlements": [{ id: 1 }],
    "INSERT INTO learning_progress": { affectedRows: 1, insertId: 9 }
  });
  assert(await healProgress(heal, U) === true, "欠けているのに作りません");
  assert(heal.calls.some((c) => /INSERT INTO learning_progress/i.test(c.sql)),
    "INSERT が走っていません");

  /* 行が在る → 触らない */
  const ok = fakeConn({ "FROM learning_progress WHERE user_id": [{ id: 5 }] });
  assert(await healProgress(ok, U) === false, "在るのに作り直しています");
  assert(!ok.calls.some((c) => /INSERT/i.test(c.sql)), "余計な INSERT");

  /* entitlement が無い → 作らない（配信対象になれない行を残さない） */
  const noEnt = fakeConn({
    "FROM learning_progress WHERE user_id": [],
    "FROM course_entitlements": []
  });
  assert(await healProgress(noEnt, U) === false, "持ち日数が無いのに作りました");

  /* コース未選択 → 何もしない */
  assert(await healProgress(fakeConn(), { id: 7, active_track: null }) === false,
    "コースが無いのに動きました");
  return "作る 1 / 触らない 3";
});

/* ================================================================== */
head("[列の運搬]  PENDING が読む列を、状態を組むどの経路も欠かさない"
  + "（2026-08-05 リビュー修正 4）");

await acheck("ONBOARD_COLUMNS を全経路が運ぶ ── 欠けは undefined で静かに逸れる", async () => {
  const { ONBOARD_COLUMNS } = await import("../server/lib/onboarding.mjs");
  assert(ONBOARD_COLUMNS.length >= 9, `一覧が短すぎます: ${ONBOARD_COLUMNS.length}`);

  /* users 由来の列と saju 由来の列を分けて見る。track は users 側
     （active_track の別名）なので getSajuProfile には無い ── 経路ごとの
     運搬はこの下で別に見る。 */
  const USER_COLS = ["name_kr", "name_source", "display_name", "track"];
  const SAJU_COLS = ONBOARD_COLUMNS.filter((c) => !USER_COLS.includes(c));

  /* ① 配信経路（DELIVERABLE_SQL）── バッチの askOnboarding が使う。 */
  const usersSrc = stripComments(read("server/lib/repo/users.mjs"));
  const dsql = usersSrc.match(/const DELIVERABLE_SQL = `[\s\S]*?`/)[0];
  for (const c of ONBOARD_COLUMNS) {
    assert(dsql.includes(c), `DELIVERABLE_SQL に ${c} がありません（バッチ経路だけ判定が狂う）`);
  }

  /* ② getSajuProfile ── stateOf / pendingStep の素材。 */
  const gsp = usersSrc.match(/export async function getSajuProfile[\s\S]*?\n}/)[0];
  for (const c of SAJU_COLS) {
    assert(gsp.includes(c), `getSajuProfile が ${c} を引いていません`);
  }

  /* ③ 状態を組む経路は**手の一覧で持たない**（2026-08-06 追加指示 1）。
     follow が 5 番目、link.greet が 6 番目として立て続けに漏れた ──
     7 番目も同じ道をたどる。なので「saju を引き、かつ段の判定に
     触れるファイル」を全数探索し、検査済み一覧に無ければ**その場で
     失敗**させる。新しい経路を書いた人は、この一覧に載せて列の
     運搬を検査に通すまで先へ進めない。 */
  const CHECKED = {
    "server/lib/handlers/postback.mjs": "stateOf",
    "server/lib/handlers/message.mjs": "pendingStep",
    "server/lib/handlers/follow.mjs": "onboardingMessages",
    "server/lib/handlers/link.mjs": "greet"
  };
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith(".mjs") ? [path.join(dir, e.name)] : []);
  const discovered = walk("server").filter((f) => {
    const s = stripComments(read(f)).replaceAll("\\", "/");
    return /getSajuProfile\(/.test(s)
      && /nextStep|blockingStep|messageForStep/.test(s)
      && !f.replaceAll("\\", "/").includes("repo/users.mjs");
  }).map((f) => f.replaceAll("\\", "/"));

  for (const f of discovered) {
    assert(CHECKED[f],
      `${f} が新しい状態組み立て経路です ── CHECKED に載せ、`
      + `ONBOARD_COLUMNS の運搬をこの検査に通してください`);
  }
  for (const [file, fnName] of Object.entries(CHECKED)) {
    assert(discovered.includes(file),
      `${file} が探索に掛かりません（関数名や import が変わった可能性 ── 検査の方を直すこと）`);
    const src = stripComments(read(file));
    const fn = src.match(new RegExp(`function ${fnName}[\\s\\S]*?\\n}`))[0];
    for (const c of SAJU_COLS) {
      assert(fn.includes(c), `${file} の ${fnName} が ${c} を運んでいません`);
    }
    /* track（users 側の別名）も全経路が明示的に置く ── PENDING.track が
       読むので、欠けると要約確認の済んだ人にコースを二度と訊かない。 */
    assert(fn.includes("track"), `${file} の ${fnName} が track を運んでいません`);
  }
  return `${ONBOARD_COLUMNS.length} 列 × ${discovered.length} 経路（自動探索）`;
});

/* ================================================================== */
head("[直接流入の 4 段]  判別子を守る・data を信じない（리뷰 수정 5）");

check("オンボーディングはどこでも性別を訊かない（지시서⑱）", () => {
  /* privacy の目的（大運の計算に将来用いる）が消えたので、目的の
     無い個人情報を受け取らない。質問・保存の両方が無いことを見る ──
     古いボタンの bgender postback は**受けるが保存しない**（黙殺すると
     無反応になるため followUp で受け止める）。 */
  const ob = stripComments(read("server/lib/onboarding.mjs"));
  assert(!/askGender/.test(ob), "askGender が残っています");
  assert(!/"bgender"/.test(ob), "STEPS / PENDING に bgender が残っています");
  assert(!/性別を教えて/.test(read("server/lib/onboarding.mjs")), "性別の質問文面が残っています");
  const pb2 = stripComments(read("server/lib/handlers/postback.mjs"));
  const bg = pb2.match(/if \(action === "bgender"\)[\s\S]*?\n  }/)[0];
  assert(!/saveSaju|gender:/.test(bg), "bgender が保存しています ── 書く経路は 1 本も残さない");
  return "訊かない・書かない（古いボタンは followUp で受け止め）";
});

check("チェーンの途中で ohaeng_main を書く経路が無い（不変式）", () => {
  /* ohaeng_main の空白が「サイト診断を通っていない」の判別子。
     bdate〜bgender のどこかで埋めると、判別が黙って崩れて
     残りの段が止まる ── 注釈ではなく関門が守る。 */
  const src = stripComments(read("server/lib/handlers/postback.mjs"));
  const save = src.match(/const saveSaju[\s\S]*?\n  };/)[0];
  assert(!/ohaengMain/.test(save), "saveSaju が ohaengMain を渡しています");
  for (const a of ["bdate", "btime", "bplace", "bcity", "bgender"]) {
    const fn = src.match(new RegExp(`if \\(action === "${a}"\\)[\\s\\S]*?\\n  }`))[0];
    assert(!/ohaengMain|ohaeng_main/.test(fn), `${a} が ohaeng_main に触れています`);
  }
  return "saveSaju + 5 ハンドラとも不在";
});

await acheck("bcity は一覧で引き当てる ── 知らない id を黙って tokyo にしない", async () => {
  const { handlePostback } = await import("../server/lib/handlers/postback.mjs");
  const U_ROW = [{ id: 7, line_user_id: "U_d", display_name: "d", name_kanji: null,
    name_reading: "たろう", name_kr: "타로", name_source: "line",
    status: "active", active_track: null }];
  const conn = fakeConn({ "FROM users": U_ROW });
  const r = await handlePostback(conn,
    { source: { userId: "U_d" }, replyToken: "rt",
      postback: { data: "action=bcity&id=atlantis" } },
    { send: async () => ({}) });
  assert(r.skipped, `弾いていません: ${JSON.stringify(r)}`);
  assert(!conn.calls.some((c) => /INSERT INTO saju_profiles|UPDATE saju_profiles/i.test(c.sql)),
    "知らない都市を保存しています（fortune が黙って tokyo に落ちる）");
  return "atlantis → 保存なし";
});

await acheck("datetimepicker の答えは範囲を見てから保存する", async () => {
  const { handlePostback } = await import("../server/lib/handlers/postback.mjs");
  const U_ROW = [{ id: 7, line_user_id: "U_d", display_name: "d", name_kanji: null,
    name_reading: "たろう", name_kr: "타로", name_source: "line",
    status: "active", active_track: null }];
  /* 範囲外の年（picker の min/max は端末側の飾りで、postback は作れる） */
  const bad = fakeConn({ "FROM users": U_ROW });
  const r1 = await handlePostback(bad,
    { source: { userId: "U_d" }, replyToken: "rt",
      postback: { data: "action=bdate", params: { date: "1900-01-01" } } },
    { send: async () => ({}) });
  assert(r1.skipped, `範囲外が通りました: ${JSON.stringify(r1)}`);

  /* 正常値 → 保存して、次の質問（時刻）が返る。
     偽の接続は書き込みを覚えないので、INSERT を見たら以後の
     SELECT に反映する ── 反映しないと followUp が古い状態を読み、
     この検査自身が「保存後の次の段」を見られない。 */
  let saved = null;
  const ok = fakeConn({
    "FROM users": U_ROW,
    "INSERT INTO saju_profiles": (sql, params) => {
      saved = { user_id: 7, birth_date: params[1], birth_time: params[2],
                birth_confirmed: 0, gender: "U", ohaeng_main: null, raw_result_json: null };
      return { affectedRows: 1, insertId: 1 };
    },
    "FROM saju_profiles": () => saved ? [saved] : []
  });
  let sent = null;
  const r2 = await handlePostback(ok,
    { source: { userId: "U_d" }, replyToken: "rt",
      postback: { data: "action=bdate", params: { date: "1990-05-05" } } },
    { send: async (_t, m) => { sent = m; return {}; } });
  assert(r2.date === "1990-05-05", JSON.stringify(r2));
  assert(saved && saved.birth_date === "1990-05-05", "保存していません");
  assert(sent && /時刻/.test(sent[0].text), `次の質問が時刻ではありません: ${sent?.[0]?.text?.slice(0, 20)}`);
  return "1900 拒否 / 1990 保存 → 時刻へ";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
