#!/usr/bin/env node
/* ==================================================================
   verify-server.mjs — LINE 配信システムの土台（P1）

     使い方:  node tools/verify-server.mjs

   MySQL は要らない。repo/ の下は渡された conn の .execute() しか
   使わない約束なので、記録する偽物を渡せば「どんな SQL を、どんな
   順番で投げるか」をそのまま確かめられる。既存 9 種と同じく
   npm install なしで走る ── その性質を保つこと自体もここで見張る。

   見張っているのは、動かしてみても気づけない類いのものだけ:

     1 依存の閉じ込め  mysql2 を読むのは lib/db.mjs だけ
     2 時刻           JST。サーバーの時計が UTC でもずれない
     3 スキーマ        utf8mb4 / 'completed' / payment_ref の一意制約 / 索引
     4 .sql の分割     ENUM('7days',...) の途中で切らない
     5 金額           二重に届いた決済で日数を足さない
     6 進み           配信バッチが二重に走っても同じ日を二度送らない
     7 保有日数        復習とクイズが日数を削らない（計画書 1-2 の約束）
     8 値の検査        ENUM に無い値を DB へ通さない

   2 と 5 と 6 は、動かしても正常に見える。2 は朝 7 時だけ、5 は
   決済サービスが再送したときだけ、6 は cron が重なったときだけ
   現れるので、手で試して見つかるものではない。
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

/* 注釈を落としてからソースを検査する。このファイルの検査は
   「どの表に触っているか」を文字列で見るものが多く、注釈に表の名前が
   出てくるだけで引っかかる ── 実際 pushlogs.mjs は
   learning_progress から逆算しない理由を注釈で説明している。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

/* async 関数は throw ではなく reject する。同期の try/catch では
   捕まらないので、投げることを見る検査は必ずこちらを通す。 */
const rejects = async (fn) => {
  try { await fn(); return false; } catch { return true; }
};

/* ---- 偽の接続 -------------------------------------------------------
   handler(sql, params) が返したものを、mysql2 と同じ [結果, フィールド]
   の形で渡す。投げられた SQL は calls に溜まるので、あとから
   「何をどの順で聞いたか」を見られる。 */
function fakeConn(handler = () => []) {
  const calls = [];
  return {
    calls,
    sql: (i) => calls[i].sql.replace(/\s+/g, " ").trim(),
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return [handler(sql, params, calls.length - 1), []];
    }
  };
}

const { jstDate, jstDateTime, jstDayRange, addDays } = await import("../server/lib/jst.mjs");
const { parseEnv, requireEnv } = await import("../server/lib/env.mjs");
const { splitStatements } = await import("../server/lib/sqlfile.mjs");
const users = await import("../server/lib/repo/users.mjs");
const billing = await import("../server/lib/repo/billing.mjs");
const learning = await import("../server/lib/repo/learning.mjs");
const pushlogs = await import("../server/lib/repo/pushlogs.mjs");
const { fromJson, toJson } = await import("../server/lib/repo/util.mjs");

const SCHEMA = read("server/db/schema.sql");


/* ================================================================== */
head("[依存]  mysql2 を読むのは 1 ファイルだけ ── 検証に install を要らなくする");

const SERVER_FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".mjs")) SERVER_FILES.push(p);
  }
})("server");

/* 注釈での言及ではなく、実際の読み込みだけを見る。
   import / require / import() の 3 通り。 */
const importsOf = (file) => [
  ...stripComments(read(file)).matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)
].map((m) => m[1]);

check("server/ の .mjs で mysql2 を読むのは lib/db.mjs のみ", () => {
  const importers = SERVER_FILES.filter((f) => importsOf(f).some((s) => s.startsWith("mysql2")));
  assert(importers.length === 1 && importers[0].endsWith("db.mjs"),
    `mysql2 を読んでいるファイル: ${importers.join(", ") || "(無し)"}`);
  return `${SERVER_FILES.length} ファイル中 1`;
});

check("repo/ は node の組み込みモジュールにも触らない", () => {
  const repoFiles = SERVER_FILES.filter((f) => f.includes(`repo${path.sep}`));
  assert(repoFiles.length >= 4, `repo/ が ${repoFiles.length} ファイルしかありません`);
  for (const f of repoFiles) {
    const bad = importsOf(f).filter((s) => s.startsWith("node:"));
    assert(!bad.length, `${f} が ${bad.join(", ")} を読んでいます`);
  }
  return `${repoFiles.length} ファイルとも conn だけで動く`;
});

check("package.json の依存は mysql2 だけ", () => {
  const pkg = JSON.parse(read("server/package.json"));
  const deps = Object.keys(pkg.dependencies || {});
  assert(deps.length === 1 && deps[0] === "mysql2", `依存: ${deps.join(", ")}`);
  assert(!pkg.devDependencies, "devDependencies があります");
  return "mysql2 のみ / devDependencies 無し";
});

check("ルートに package.json は無いまま（README の前提）", () => {
  assert(!fs.existsSync("package.json"),
    "ルートに package.json ができています。既存 9 種の「install 不要」が崩れます");
  return "server/ の中だけ";
});


/* ================================================================== */
head("[時刻]  JST。借りたサーバーの時計が UTC でもずれない");

/* 2026-08-02 21:55 UTC = 2026-08-03 06:55 JST。
   朝の配信バッチが動く時刻そのもの。UTC のまま日付を取ると
   前日（08-02）になり、「今日もう送ったか」が毎朝外れる。 */
const AT_0655_JST = new Date("2026-08-02T21:55:00Z");

check("06:55 JST の日付は、その日（前日にならない）", () => {
  assert(jstDate(AT_0655_JST) === "2026-08-03",
    `${jstDate(AT_0655_JST)} になりました`);
  return "2026-08-03";
});

check("DATETIME の形。T も Z も付けない", () => {
  const s = jstDateTime(AT_0655_JST);
  assert(s === "2026-08-03 06:55:00", s);
  assert(!/[TZ]/.test(s), `MySQL の DATETIME に入らない形です: ${s}`);
  return s;
});

check("サーバーの TZ を変えても結果が変わらない", () => {
  const original = process.env.TZ;
  const seen = new Set();
  for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"]) {
    process.env.TZ = tz;
    seen.add(jstDate(AT_0655_JST) + " " + jstDateTime(AT_0655_JST));
  }
  if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  assert(seen.size === 1, `TZ ごとに違う値になりました: ${[...seen].join(" / ")}`);
  return "4 つの TZ で同一";
});

check("日の境目は半開区間。DATE() を列にかけない", () => {
  const [from, to] = jstDayRange("2026-08-03");
  assert(from === "2026-08-03 00:00:00", from);
  assert(to === "2026-08-04 00:00:00", `終端が ${to}。23:59:59 だと取りこぼします`);
  return `${from} 〜 ${to}`;
});

check("月またぎ・閏年でも日付が進む", () => {
  assert(addDays("2026-08-31", 1) === "2026-09-01", addDays("2026-08-31", 1));
  assert(addDays("2028-02-28", 1) === "2028-02-29", addDays("2028-02-28", 1));
  assert(addDays("2026-12-31", 1) === "2027-01-01", addDays("2026-12-31", 1));
  return "月末 / 閏日 / 年末";
});

check("db.mjs は SET time_zone を実際に出す（オプションだけでは効かない）", () => {
  const src = stripComments(read("server/lib/db.mjs"));
  /* mysql2 の timezone オプションはドライバの変換設定で、
     @@session.time_zone は SYSTEM のまま ── 実測で NOW() が 9 時間
     ずれることを確かめた。オプションを入れただけで安心しないよう、
     SET 文を出していること自体を見る。 */
  assert(/SET time_zone\s*=\s*'\+09:00'/.test(src),
    "SET time_zone を出していません。CURRENT_TIMESTAMP の既定値だけ UTC で入ります");
  /* プールは接続を張り直すので、作った瞬間の 1 回では足りない。 */
  assert(/\.on\(\s*["']connection["']/.test(src),
    "接続のたびに出していません。プールが張り直した接続は SYSTEM のままです");
  return "pool.on('connection') → SET time_zone";
});

check("migrate.mjs は time_zone が SYSTEM なら失敗にする", () => {
  const src = stripComments(read("server/db/migrate.mjs"));
  assert(/@@session\.time_zone/.test(src), "セッションの time_zone を見ていません");
  assert(!/tz\s*!==\s*"SYSTEM"|tz\s*===\s*"SYSTEM"/.test(src),
    "SYSTEM を通しています。借りたサーバーの時計が何時かはこちらで決められません");
  return "+09:00 以外は失敗";
});

check("体験 3 日間の終わりは開始 +2 日", () => {
  assert(addDays("2026-08-03", billing.TRIAL_DAYS - 1) === "2026-08-05",
    "3 日間なのに終わりが合いません");
  return "08-03 開始 → 08-05 終了";
});


/* ================================================================== */
head("[スキーマ]  作れてしまうが、あとで直せないもの");

check("9 つの表が全部ある", () => {
  const want = ["users", "saju_profiles", "purchases", "subscriptions",
                "learning_progress", "content_templates", "push_logs", "quiz_checkpoints",
                "pending_links"];
  const missing = want.filter((t) => !new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(SCHEMA));
  assert(!missing.length, `足りません: ${missing.join(", ")}`);
  return `${want.length} 表`;
});

/* 土台の 9 表 + 流した migration の記録（schema_migrations）。
   あちらは利用者のデータを持たないが、同じ DB に置く以上
   照合順序は揃える ── 揃っていない表が 1 つあると、そこを起点に
   JOIN したときだけ照合順序の衝突で落ちる。 */
check("全部 utf8mb4 ── 既定の latin1 では日本語も韓国語も入らない", () => {
  const creates = SCHEMA.match(/CREATE TABLE IF NOT EXISTS \w+[\s\S]*?ENGINE=\w+[^;]*/g) || [];
  assert(creates.length === 10, `CREATE が ${creates.length} 件しか読めません`);
  for (const c of creates) {
    const name = c.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1];
    assert(/CHARSET=utf8mb4/.test(c), `${name} が utf8mb4 ではありません`);
  }
  return "10 表とも";
});

check("users.status に 'completed' がある（計画書 5-5 が使う）", () => {
  const m = SCHEMA.match(/status\s+ENUM\(([^)]*)\)/);
  assert(m, "users.status の ENUM が読めません");
  for (const v of ["trial", "active", "expired", "unfollowed", "completed"]) {
    assert(m[1].includes(`'${v}'`), `'${v}' がありません`);
  }
  return m[1].replace(/'/g, "").replace(/,/g, " / ");
});

check("purchases.payment_ref が UNIQUE ── 決済の再送で日数が二重に増えない", () => {
  assert(/UNIQUE KEY \w+ \(payment_ref\)/.test(SCHEMA),
    "payment_ref に一意制約がありません。webhook の再送で保有日数が二重に増えます");
  return "uq_purchases_payment_ref";
});

check("1 人 1 枚の表に UNIQUE がある（saju / subscriptions / progress）", () => {
  for (const t of ["uq_saju_user", "uq_subscriptions_user", "uq_progress_user"]) {
    assert(SCHEMA.includes(t), `${t} がありません`);
  }
  return "3 つとも";
});

check("push_logs に索引がある。等値の列が先、範囲の列が最後", () => {
  assert(/KEY ix_push_user_type_time \(user_id, push_type, sent_at\)/.test(SCHEMA),
    "ix_push_user_type_time の列順が違います（sent_at は範囲なので最後）");
  return "(user_id, push_type, sent_at)";
});

check("外部キーが張ってある ── 退会で消す範囲を DB 側に持たせる", () => {
  const fks = SCHEMA.match(/FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/g) || [];
  assert(fks.length === 5, `${fks.length} 本しかありません（saju/purchases/subscriptions/progress/push_logs の 5 本）`);
  return "5 本 CASCADE";
});

check("節目は 30 / 50 / 75。101 は入れない（修了メッセージなので）", () => {
  const m = SCHEMA.match(/INSERT IGNORE INTO quiz_checkpoints[\s\S]*?;/);
  assert(m, "quiz_checkpoints の初期値がありません");
  assert(/\(30, 1\)/.test(m[0]) && /\(50, 2\)/.test(m[0]) && /\(75, 3\)/.test(m[0]), m[0]);
  assert(!/\(101,/.test(m[0]), "101 が入っています。計画書 1-2 では修了メッセージです");
  return "30 / 50 / 75";
});


/* ================================================================== */
head("[.sql の分割]  ENUM('7days',...) の途中で切らない");

check("schema.sql が 11 文に割れる（表 10 + 初期値 1）", () => {
  const st = splitStatements(SCHEMA);
  assert(st.length === 11, `${st.length} 文になりました:\n      ${st.map((s) => s.slice(0, 50)).join("\n      ")}`);
  return "11 文";
});

check("どの文も注釈だけで終わっていない", () => {
  for (const s of splitStatements(SCHEMA)) {
    assert(/^(CREATE|INSERT|ALTER|DROP)/i.test(s), `SQL でない断片が出ました: ${s.slice(0, 60)}`);
  }
  return "全文が DDL / DML";
});

check("文字列の中の ; と -- を素通しする", () => {
  const st = splitStatements(
    `INSERT INTO t VALUES ('a;b', 'c--d');
     -- ここは注釈; 切ってはいけない
     SELECT 1;`);
  assert(st.length === 2, `${st.length} 文になりました: ${JSON.stringify(st)}`);
  assert(st[0].includes("'a;b'"), st[0]);
  assert(st[0].includes("'c--d'"), st[0]);
  return "2 文";
});

check("エスケープされた引用符で文字列が終わらない", () => {
  const st = splitStatements(`INSERT INTO t VALUES ('it''s; ok'); SELECT 2;`);
  assert(st.length === 2, `${st.length} 文: ${JSON.stringify(st)}`);
  return "'' と \\' の両方";
});

check("末尾にセミコロンが無くても最後の 1 文を落とさない", () => {
  assert(splitStatements("SELECT 1;\nSELECT 2").length === 2, "最後が消えました");
  return "2 文";
});


/* ================================================================== */
head("[migration の履歴]  配置のたびに 001 から流し直さない");

/* 履歴が無かったあいだ、配置のたびに migrations/ が頭から流れていた。
   ALTER は「もう当たっている」errno を飲み込んで素通りするが、
   002 の INSERT ... SELECT は同じ 002 が落とす列を読むので、
   2 周目に errno 1054 で throw → exit(1) → .cpanel.yml の set -e で
   配置ごと停止する。実際に流すところは DB が要るので db/smoke.mjs が
   見る。ここでは「そういう作りになっているか」だけを見る。 */
const MIGRATE = stripComments(read("server/db/migrate.mjs"));
const MIGRATION_FILES =
  fs.readdirSync("server/db/migrations").filter((f) => f.endsWith(".sql")).sort();

check("schema.sql が履歴の表を持っている（filename が主キー）", () => {
  assert(/CREATE TABLE IF NOT EXISTS schema_migrations/.test(SCHEMA),
    "schema_migrations がありません");
  const c = SCHEMA.match(/CREATE TABLE IF NOT EXISTS schema_migrations[\s\S]*?ENGINE=\w+[^;]*/)[0];
  assert(/filename\s+VARCHAR\(255\)\s+PRIMARY KEY/.test(c),
    "filename が主キーではありません。番号で採ると、同じ 004 が 2 本できたとき片方が永久に流れません");
  assert(/applied_at\s+DATETIME/.test(c), "いつ流したかが残りません");
  return "filename VARCHAR(255) PRIMARY KEY";
});

check("migrate.mjs は履歴に在るファイルを流さない", () => {
  assert(/schema_migrations/.test(MIGRATE), "履歴の表を見ていません");
  const fn = MIGRATE.match(/async function runMigrations[\s\S]*?\n}/)[0];
  assert(/done\.has\(file\)/.test(fn),
    "ファイル名で「もう流したか」を見ていません。配置のたびに頭から流れます");
  assert(/markApplied\(pool, file\)/.test(fn), "流したことを記録していません");
  /* 記録は実行のあと。先に書くと、途中で落ちたファイルの残りが
     二度と流れない。 */
  const runAt  = fn.indexOf("splitStatements");
  const markAt = fn.lastIndexOf("markApplied");
  assert(runAt > 0 && markAt > runAt,
    "実行より先に記録しています。途中で落ちた残りが二度と流れません");
  return "履歴で飛ばす / 実行 → 記録";
});

check("1054 を飲み込む番号に足していない", () => {
  const m = MIGRATE.match(/ALREADY_APPLIED\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert(m, "ALREADY_APPLIED が読めません");
  const nums = m[1].split(",").map((s) => Number(s.trim()));
  assert(!nums.includes(1054),
    "1054（Unknown column）を飲み込んでいます。列名を綴り間違えた SQL が「適用済み」として静かに素通りします");
  assert(nums.length === 4, `飲み込む番号が ${nums.length} 個あります: ${nums.join(", ")}`);
  return nums.join(" / ");
});

/* 履歴を入れた時点で本番に当たっていた 3 本。履歴だけを見て流すと、
   いま直そうとしている事故をその場で起こす ── 「当たっていれば
   必ず在るもの」で見分けて、流さずに記録だけする。 */
check("001〜003 には、当たっているかを見る目印がある（bootstrap）", () => {
  const m = MIGRATE.match(/const PROBES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert(m, "PROBES がありません。本番の 001〜003 が流し直されます");
  for (const f of ["001-tracks-and-onboarding.sql", "002-per-course-billing.sql",
                   "003-review-quiz.sql"]) {
    assert(MIGRATION_FILES.includes(f), `migrations/ に ${f} がありません`);
    assert(m[1].includes(`"${f}"`), `${f} の目印がありません`);
  }
  /* 目印はそのファイルでしか作られないものであること。
     001 の users.name_source / 002 の course_entitlements /
     003 の content_templates.quiz を、それぞれの .sql が作っている。 */
  for (const [file, needle] of [
    ["001-tracks-and-onboarding.sql", "name_source"],
    ["002-per-course-billing.sql",    "course_entitlements"],
    ["003-review-quiz.sql",           "quiz"]
  ]) {
    assert(read(`server/db/migrations/${file}`).includes(needle),
      `${file} が ${needle} を作っていません（目印が別のファイルのものです）`);
  }
  return "001 name_source / 002 course_entitlements / 003 quiz";
});

check("smoke.mjs が migrate を 2 回続けて流す", () => {
  /* この欠陥は DB が無いと再現しない。静的な検査で捕まえられないので、
     「実物で 2 周する検査が置いてあること」までをここで見張る。 */
  const src = stripComments(read("server/db/smoke.mjs"));
  const runs = (src.match(/runMigrate\(\)/g) || []).length;
  assert(runs >= 3, `runMigrate の呼び出しが ${runs} か所です（定義 1 + 実行 2 が要ります）`);
  assert(/2 回目も exit 0/.test(read("server/db/smoke.mjs")),
    "2 回目の終了コードを見ていません");
  return "1 回目 + 2 回目";
});


/* ================================================================== */
head("[金額]  二度届いた決済で、保有日数を二度足さない");

check("価格表が計画書 1-1 と一致する", () => {
  const want = { "7days": [7, 980], "14days": [14, 1680], "30days": [30, 2980],
                 "60days": [60, 4980], "101days": [101, 7480] };
  for (const [k, [days, price]] of Object.entries(want)) {
    const p = billing.PACKAGES[k];
    assert(p, `${k} がありません`);
    assert(p.days === days && p.price === price,
      `${k}: ${p.days}日/¥${p.price}（計画書は ${days}日/¥${price}）`);
  }
  assert(Object.keys(billing.PACKAGES).length === 5, "パッケージが 5 つではありません");
  return "5 種一致";
});

check("1 日あたりの単価が長いほど安い ── 価格表の建て付けそのもの", () => {
  const per = Object.values(billing.PACKAGES).map((p) => p.price / p.days);
  for (let i = 1; i < per.length; i++) {
    assert(per[i] < per[i - 1], `${i} 番目で単価が上がっています: ${per.map((n) => n.toFixed(1)).join(" → ")}`);
  }
  return per.map((n) => "¥" + n.toFixed(0)).join(" → ");
});

/* 一意制約違反。MySQL / MariaDB とも errno 1062。 */
const dupError = () => Object.assign(new Error("Duplicate entry"), {
  code: "ER_DUP_ENTRY", errno: 1062
});

await acheck("初めての決済 → 購入を記録し、保有日数を足す", async () => {
  const conn = fakeConn((sql) => {
    if (/INSERT INTO purchases/.test(sql)) return { affectedRows: 1, insertId: 11 };
    if (/INSERT INTO course_entitlements/.test(sql)) return { affectedRows: 1 };
    if (/UPDATE subscriptions/.test(sql)) return { affectedRows: 1 };
    return [{ track: "beginner", days_entitled: 30, days_used: 0, current_day: 0, remaining: 30 }];
  });
  const r = await billing.creditPurchase(conn, 1, "beginner", "30days", { paymentRef: "pi_ABC" });
  assert(r.created === true, "created が false です");
  assert(r.daysGranted === 30, `daysGranted=${r.daysGranted}`);
  /* 日数はコース別の表へ積む（migrations/002）。subscriptions は
     体験の記録だけになったので、そちらは触らない。 */
  const grant = conn.calls.find((c) => /INSERT INTO course_entitlements/.test(c.sql));
  assert(grant, "course_entitlements に積んでいません");
  assert(grant.params[1] === "beginner", `コースが ${grant.params[1]} です`);
  assert(grant.params[2] === 30, `足した日数が ${grant.params[2]} です`);
  return "+30 日 / beginner";
});

await acheck("同じ payment_ref が再送 → 日数を足さない", async () => {
  const conn = fakeConn((sql) => {
    if (/INSERT INTO purchases/.test(sql)) throw dupError();
    return [{ track: "beginner", days_entitled: 33, days_used: 0, current_day: 0, remaining: 33 }];
  });
  const r = await billing.creditPurchase(conn, 1, "beginner", "30days", { paymentRef: "pi_ABC" });
  assert(r.created === false, "created が true です");
  assert(r.daysGranted === 0, `daysGranted=${r.daysGranted}`);
  assert(!conn.calls.some((c) => /INSERT INTO course_entitlements/.test(c.sql)),
    "再送なのに日数を積みました。決済 1 件で二重に増えます");
  return "加算なし";
});

/* 本物の MySQL に当てて分かったこと。mysql2 は CLIENT_FOUND_ROWS を
   既定で立てるので、ON DUPLICATE KEY UPDATE の affectedRows は
   新規も重複も 1 を返す ── 決済の再送を新規と取り違える。
   フラグ次第で意味が反転する値に金額を預けないよう、
   affectedRows で created を決めていないことをここで見張る。 */
check("「初めてか」を affectedRows で判定していない", () => {
  const byCount = SERVER_FILES.filter((f) => /affectedRows\s*===?\s*1/.test(stripComments(read(f))));
  assert(!byCount.length,
    `${byCount.join(", ")} ── mysql2 の既定では新規も重複も 1 を返します`);

  /* created を返すなら、その出どころは insertNew（1062 を捕まえる）でなければ
     ならない。ON DUPLICATE KEY UPDATE 自体は upsertSajuProfile のように
     「最終状態さえ合っていればよい」場面では使ってよいので、そちらは咎めない。 */
  for (const f of SERVER_FILES.filter((f) => f.includes(`repo${path.sep}`))) {
    const src = stripComments(read(f));
    if (!/\bcreated\b/.test(src) || f.endsWith("util.mjs")) continue;
    assert(/insertNew\(/.test(src),
      `${f} が created を返すのに insertNew を使っていません`);
    assert(!/created\s*[:=][^;,)]*affectedRows/.test(src),
      `${f} が created を affectedRows から作っています`);
  }
  return "created の出どころは insertNew だけ";
});

check("insertNew は 1062 だけを飲み込み、他の例外は通す", () => {
  const src = stripComments(read("server/lib/repo/util.mjs"));
  assert(/errno\s*===\s*1062|ER_DUP_ENTRY/.test(src), "一意制約違反を見分けていません");
  assert(/throw e/.test(src),
    "全部の例外を握っています。接続断や権限エラーまで「もう在る」に化けます");
  return "ER_DUP_ENTRY / 1062";
});

await acheck("接続エラーは握らずに投げる", async () => {
  const conn = fakeConn(() => { throw Object.assign(new Error("read ECONNRESET"), { errno: -104 }); });
  assert(await rejects(() => billing.creditPurchase(conn, 1, "beginner", "7days", { paymentRef: "x" })),
    "接続断が「再送」として黙って処理されました");
  return "そのまま投げる";
});

await acheck("purchases の INSERT が素の 1 文（先に SELECT しない）", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1, insertId: 1 }));
  await billing.creditPurchase(conn, 1, "beginner", "7days", { paymentRef: "x" });
  const ins = conn.calls[0].sql;
  assert(/INSERT INTO purchases/.test(ins), `最初の SQL が ${ins.slice(0, 40)} です`);
  assert(!/SELECT/i.test(ins),
    "SELECT してから INSERT する形は、webhook が同時に 2 本来ると両方が「無い」を見ます");
  return "一意制約に任せる";
});

/* insertNew は「一意キーが PK 以外に 1 本だけ」の表でしか使えない。
   2 本あると、返ってきた 1062 がどちらのものか区別できない。 */
check("insertNew を使う 4 表は、一意キーが PK 以外に 1 本だけ", () => {
  const creates = SCHEMA.match(/CREATE TABLE IF NOT EXISTS \w+[\s\S]*?ENGINE=\w+[^;]*/g) || [];
  for (const t of ["users", "subscriptions", "learning_progress", "purchases"]) {
    const c = creates.find((s) => s.includes(`IF NOT EXISTS ${t}\n`) || s.includes(`IF NOT EXISTS ${t} `));
    assert(c, `${t} の CREATE が読めません`);
    const uniques = (c.match(/UNIQUE KEY/g) || []).length;
    assert(uniques === 1, `${t} に UNIQUE KEY が ${uniques} 本あります。1062 の出どころが定まりません`);
  }
  return "4 表とも 1 本";
});

await acheck("知らないパッケージ名は投げる（日数 0 で通さない）", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  let threw = false;
  try { await billing.creditPurchase(conn, 1, "beginner", "90days", {}); } catch { threw = true; }
  assert(threw, "例外になりませんでした");
  assert(conn.calls.length === 0, "投げる前に SQL を実行しました");
  return "SQL に届く前に止まる";
});

await acheck("体験は 1 回だけ。再追加で延びない", async () => {
  const conn = fakeConn((sql) => {
    if (/INSERT INTO subscriptions/.test(sql)) throw dupError();
    return [{ user_id: 1, trial_start: "2026-08-01", trial_track: "beginner" }];
  });
  const r = await billing.startTrial(conn, 1, "beginner", "2026-08-03");
  assert(r.created === false, "既にあるのに created が true です");
  assert(!conn.calls.some((c) => /UPDATE subscriptions/.test(c.sql)),
    "既存行を上書きしています。ブロック→再追加のたびに体験が延びます");
  assert(!conn.calls.some((c) => /INSERT INTO course_entitlements/.test(c.sql)),
    "2 回目の体験で日数を積みました。コースを変えるだけで 9 日ぶん無料になります");
  return "上書きしない / 積まない";
});

await acheck("保有日数の突き合わせが ? を式の先頭に置かない", async () => {
  const conn = fakeConn(() => [{ stored_days: 33, expected_days: 33 }]);
  await billing.recountEntitledDays(conn, 1, "beginner");
  const { sql, params } = conn.calls[0];
  /* SELECT の式の先頭に来た ? は型が決まらず、MySQL が 1064 で撥ねる。
     他の ? と同じ書き方なのにここだけ落ちるので、気づきにくい。 */
  assert(!/SELECT[\s\S]*?,\s*\?\s*\+/.test(sql),
    "? を式の先頭に置いています。prepared statement が 1064 になります");
  assert(params.length === 2, `params が ${params.length} 個です（user_id と track のはず）`);
  return "定数は埋め込み";
});


/* ================================================================== */
head("[進み]  配信バッチが二重に走っても、同じ日を二度送らない");

await acheck("advanceDay は「読んだときの値」を条件に入れる", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  const r = await learning.advanceDay(conn, 1, "beginner", 5);
  const { sql, params } = conn.calls[0];
  assert(/WHERE user_id = \? AND track = \? AND current_day = \?/.test(sql.replace(/\s+/g, " ")),
    "WHERE に track と current_day の照合がありません。二重起動で同じ日が二度届きます");
  /* 使った日数も同じ 1 文で増える。別の文にすると、確保したのに
     消費していない瞬間ができ、そこで落ちると 1 日ぶんが無料になる。 */
  assert(/days_used = days_used \+ 1/.test(sql.replace(/\s+/g, " ")),
    "days_used を同じ文で増やしていません");
  assert(params[params.length - 1] === 5, `照合する値が ${params[params.length - 1]} です`);
  assert(r.claimed === true && r.day === 6, JSON.stringify(r));
  return "UPDATE … WHERE current_day = 5 → 6 日目";
});

await acheck("競り負けたら claimed=false ── 送らずに降りられる", async () => {
  const conn = fakeConn(() => ({ affectedRows: 0 }));
  const r = await learning.advanceDay(conn, 1, "beginner", 5);
  assert(r.claimed === false, "0 行なのに claimed が true です");
  return "false";
});

check("学期の切れ目が計画書 1-2 のとおり", () => {
  const want = [[1, 1], [30, 1], [31, 2], [50, 2], [51, 3], [75, 3], [76, 4], [101, 4]];
  for (const [day, sem] of want) {
    assert(learning.semesterForDay(day) === sem,
      `${day} 日目が ${learning.semesterForDay(day)} 学期になりました（正: ${sem}）`);
  }
  const covered = learning.SEMESTERS.reduce((n, s) => n + (s.to - s.from + 1), 0);
  assert(covered === 101, `4 学期で ${covered} 日ぶんしかありません`);
  return "30 / 20 / 25 / 26 = 101 日";
});

await acheck("advanceDay は学期も一緒に動かす", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  await learning.advanceDay(conn, 1, "beginner", 30);   // → 31 日目 = 2 学期
  assert(conn.calls[0].params[1] === 2,
    `31 日目の学期が ${conn.calls[0].params[1]} です`);
  return "31 日目 → 2 学期";
});

await acheck("resetProgress は 0〜101 の外を受けない", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  for (const bad of [-1, 102, 1.5, "abc"]) {
    assert(await rejects(() => learning.resetProgress(conn, 1, bad)), `${bad} が通りました`);
  }
  assert(conn.calls.length === 0, "投げる前に SQL を実行しました");
  return "-1 / 102 / 1.5 / 'abc' を拒否";
});


/* ================================================================== */
head("[保有日数]  復習とクイズは日数を削らない ── 計画書 1-2 の約束");

const LEARNING_SRC = read("server/lib/repo/learning.mjs");
const PUSH_SRC = read("server/lib/repo/pushlogs.mjs");

check("current_day を書き換える関数は 2 つだけ（進める / 運営者が戻す）", () => {
  const writers = [...LEARNING_SRC.matchAll(/export async function (\w+)[\s\S]*?\n}/g)]
    .filter((m) => /UPDATE learning_progress[\s\S]*?SET[\s\S]*?current_day\s*=/.test(m[0]))
    .map((m) => m[1]);
  assert(writers.length === 2 && writers.includes("advanceDay") && writers.includes("resetProgress"),
    `current_day を書く関数: ${writers.join(", ")}`);
  return "advanceDay / resetProgress";
});

check("pushlogs.mjs は進捗も保有日数も書き換えない", () => {
  const code = stripComments(PUSH_SRC);

  /* 「触らない」から「書き換えない」に直した。夕方の対象を出すのに
     learning_progress を読む必要ができたため（コース別の原稿を引くので
     track が要る）。読むのは問題ではない ── 動かすのが問題。

     なので INSERT / UPDATE / DELETE の宛先だけを見る。名前が出るか
     どうかで見ていたときは、JOIN を足しただけで落ちていた。 */
  const writes = [...code.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?(\w+)`?/gi)]
    .map((m) => m[2].toLowerCase());
  for (const t of writes) {
    assert(t === "push_logs", `push_logs 以外へ書いています: ${t}`);
  }
  assert(writes.length >= 2, `書き込みが ${writes.length} 件しか見つかりません（検査が空振りです）`);

  /* 注釈を落とす検査なので、落としすぎて素通しになっていないかを見る。
     この 1 行が無いと、stripComments を壊したときに全部 ✓ になる。 */
  assert(/push_logs/.test(code), "検査対象が空になっています（stripComments を確認）");
  return `書き込み ${writes.length} 件、すべて push_logs`;
});

check("保有日数を増やすのは 1 箇所だけ", () => {
  /* total_days_entitled は course_entitlements へ移した
     （migrations/002）。積む SQL が散らばると、どこかで二重に
     足しても気づけない ── 金額が絡むので、出どころを 1 つに縛る。 */
  const ENT_SRC = read("server/lib/repo/entitlements.mjs");
  const adds = [...ENT_SRC.matchAll(/days_entitled\s*=\s*days_entitled\s*\+/g)];
  assert(adds.length === 1, `加算が ${adds.length} 箇所あります`);

  for (const f of SERVER_FILES.filter((f) => !f.endsWith("entitlements.mjs"))) {
    assert(!/days_entitled\s*=\s*days_entitled/.test(read(f)),
      `${f} が保有日数を書き換えています`);
  }
  /* 移し終えたのに古い列が残っていないか。読まれない列に古い数字が
     入っていると、次に触る人はそれを信じる。 */
  for (const f of SERVER_FILES) {
    assert(!/total_days_entitled/.test(read(f)),
      `${f} に total_days_entitled が残っています（migrations/002 で落とした列）`);
  }
  return "entitlements.grant の 1 箇所";
});

await acheck("クイズの記録は quiz_pass_log だけを触る", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  await learning.setQuizResult(conn, 1, "beginner", 2, true);
  const sql = conn.calls[0].sql.replace(/\s+/g, " ");
  assert(/SET quiz_pass_log = JSON_MERGE_PATCH/.test(sql), sql);
  assert(!/current_day/.test(sql), "クイズの採点が current_day を動かしています");
  return "JSON_MERGE_PATCH";
});

await acheck("合否は JSON の boolean で入る（1 / 0 にならない）", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  await learning.setQuizResult(conn, 1, "beginner", 2, true);
  await learning.setQuizResult(conn, 1, "beginner", 3, false);
  /* ドライバは JS の true を整数 1 として送るので、? に真偽値を
     渡すと {"semester2": 1} が入る。中身ごと JSON 文字列で渡す。 */
  assert(conn.calls[0].params[0] === '{"semester2":true}', conn.calls[0].params[0]);
  assert(conn.calls[1].params[0] === '{"semester3":false}', conn.calls[1].params[0]);
  return '{"semester2":true} / {"semester3":false}';
});

check("MariaDB に無い CAST(? AS JSON) を使っていない", () => {
  for (const f of SERVER_FILES) {
    assert(!/CAST\s*\([^)]*AS\s+JSON/i.test(stripComments(read(f))),
      `${f} が CAST(… AS JSON) を使っています。MariaDB では 1064 になります`);
  }
  return "MySQL / MariaDB 両対応";
});

check("quiz_pass_log は読んで書き戻さない（同時採点で消えないように）", () => {
  const fn = LEARNING_SRC.match(/export async function setQuizResult[\s\S]*?\n}/)[0];
  assert(/JSON_MERGE_PATCH/.test(fn), "DB 側で差し替えていません");
  assert(!/getProgress|SELECT/.test(fn), "先に読んでいます。読んで書き戻すと同時実行で片方が消えます");
  return "DB 側で差し替え";
});


/* ================================================================== */
head("[配信ログ]  「今日もう送ったか」を、索引の効く形で聞く");

await acheck("sentToday は JST の半開区間で絞る", async () => {
  const conn = fakeConn(() => []);
  await pushlogs.sentToday(conn, 7, "learning", "2026-08-03");
  const { sql, params } = conn.calls[0];
  const flat = sql.replace(/\s+/g, " ");
  assert(/sent_at >= \? AND sent_at < \?/.test(flat), flat);
  assert(!/DATE\(sent_at\)/.test(flat), "列に DATE() をかけています。索引が効きません");
  assert(params.includes("2026-08-03 00:00:00") && params.includes("2026-08-04 00:00:00"),
    JSON.stringify(params));
  return "sent_at >= 00:00:00 AND < 翌 00:00:00";
});

await acheck("失敗した配信は「送った」に数えない", async () => {
  const conn = fakeConn(() => []);
  await pushlogs.sentToday(conn, 7, "learning");
  assert(/status = 'sent'/.test(conn.calls[0].sql),
    "status で絞っていません。失敗した日が「送った」になり、その人だけ配信が止まります");
  return "status = 'sent'";
});

await acheck("夕方の対象は「今朝の学習配信が届いた人」だけ", async () => {
  const conn = fakeConn(() => []);
  await pushlogs.listReviewTargets(conn, "2026-08-03");
  const flat = conn.calls[0].sql.replace(/\s+/g, " ");
  assert(/push_type = 'learning'/.test(flat), "learning で絞っていません");
  assert(/status = 'sent'/.test(flat), "sent で絞っていません");
  assert(/u\.status IN \('trial', 'active'\)/.test(flat), "退会者が混ざります");
  assert(!/'upsell'/.test(flat), "案内だけ受けた人が混ざります");
  return "learning / sent / trial・active";
});

await acheck("push_type は 8 種。ENUM に無い値を DB へ通さない", async () => {
  assert(pushlogs.PUSH_TYPES.length === 8, pushlogs.PUSH_TYPES.join(", "));

  /* ENUM は 3 か所にある。schema.sql が作るときの形、001 が
     onboarding を足した形、002 が expiring / resume を足した形。
     いちばん新しい方と突き合わせる ── 古い方だけ見ていると、
     足した種別が「コードにはあるが DB に無い」まま通る。 */
  const M002 = read("server/db/migrations/002-per-course-billing.sql");
  const inSchema = M002.match(/push_type[\s\S]*?ENUM\(([^)]*)\)/)[1];
  for (const t of pushlogs.PUSH_TYPES) {
    assert(inSchema.includes(`'${t}'`), `${t} が migrations/001 の ENUM にありません`);
  }
  /* schema.sql 側は作った直後の 5 種のまま。migrations が
     流れていないと 6 種目が入らないので、そこも見ておく。 */
  const orig = SCHEMA.match(/push_type\s+ENUM\(([^)]*)\)/)[1];
  assert(!orig.includes("'onboarding'"),
    "schema.sql を直接書き換えています（既にデータのある表には効きません）");
  const conn = fakeConn(() => ({ insertId: 1 }));
  assert(await rejects(() => pushlogs.logSent(conn, 1, { pushType: "reminder" })),
    "知らない push_type が通りました");
  assert(await rejects(() => pushlogs.logFailed(conn, 1, { pushType: "reminder" })),
    "logFailed 側が通りました");
  assert(conn.calls.length === 0, "投げる前に SQL を実行しました");
  return pushlogs.PUSH_TYPES.join(" / ");
});

await acheck("users.setStatus も ENUM の外を拒む", async () => {
  assert(await rejects(() => users.setStatus(fakeConn(), 1, "paused")),
    "'paused' が通りました。MySQL の設定次第で空文字が入り、配信対象から静かに外れます");
  assert(await rejects(() => billing.setPaymentStatus(fakeConn(), 1, "pending")),
    "payment_status も素通しです");
  return "'paused' / 'pending' を拒否";
});

await acheck("失敗の記録は長すぎるメッセージを切る", async () => {
  const conn = fakeConn(() => ({ insertId: 1 }));
  await pushlogs.logFailed(conn, 1, { error: new Error("x".repeat(5000)) });
  const msg = conn.calls[0].params[4];
  assert(msg.length === 1000, `${msg.length} 文字入ろうとしました`);
  return "1000 文字で打ち切り";
});


/* ================================================================== */
head("[友だち追加]  再追加で、払った人を体験に落とさない");

await acheck("upsertOnFollow は既存の status を書き換えない", async () => {
  const conn = fakeConn((sql) => {
    if (/INSERT INTO users/.test(sql)) throw dupError();   // 再追加
    return [{ id: 3, line_user_id: "U1", status: "active" }];
  });
  const r = await users.upsertOnFollow(conn, { lineUserId: "U1", displayName: "たなか" });
  const upd = conn.calls.find((c) => /UPDATE users/.test(c.sql));
  assert(upd, "再追加で表示名を更新していません");
  assert(!/status/.test(upd.sql),
    "再追加で status を書き換えています。101 日買った人がブロック→再追加で trial に落ちます");
  assert(r.created === false, "既存なのに created が true です");
  return "status に触れない";
});

await acheck("新規は created=true で見分けられる", async () => {
  const conn = fakeConn((sql) =>
    /INSERT INTO users/.test(sql) ? { affectedRows: 1, insertId: 9 } : [{ id: 9, status: "trial" }]);
  const r = await users.upsertOnFollow(conn, { lineUserId: "U2" });
  assert(r.created === true, "新規なのに false です");
  assert(!conn.calls.some((c) => /UPDATE users/.test(c.sql)), "新規なのに UPDATE も投げました");
  return "1062 が返らなければ新規";
});

await acheck("表示名が無いときに既存の名前を消さない", async () => {
  const conn = fakeConn((sql) => {
    if (/INSERT INTO users/.test(sql)) throw dupError();
    return [{ id: 3 }];
  });
  await users.upsertOnFollow(conn, { lineUserId: "U1" });
  const upd = conn.calls.find((c) => /UPDATE users/.test(c.sql));
  assert(/COALESCE\(\?, display_name\)/.test(upd.sql.replace(/\s+/g, " ")),
    "NULL で上書きしています");
  assert(upd.params[0] === null, `渡した値が ${upd.params[0]} です`);
  return "COALESCE で守る";
});

await acheck("配信対象の LIMIT を ? で渡さない（mysql2 が撥ねる）", async () => {
  const conn = fakeConn(() => []);
  await users.listDeliverable(conn, { limit: 100, offset: 20 });
  const { sql, params } = conn.calls[0];
  assert(/LIMIT 100 OFFSET 20/.test(sql), sql.replace(/\s+/g, " ").slice(-40));
  assert(params === undefined || params.length === 0, `params: ${JSON.stringify(params)}`);
  return "整数を検査して埋める";
});

check("LIMIT に整数以外を渡しても SQL に入らない", () => {
  const conn = fakeConn(() => []);
  users.listDeliverable(conn, { limit: "1; DROP TABLE users", offset: -5 });
  const sql = conn.calls[0].sql;
  assert(/LIMIT 500 OFFSET 0/.test(sql), sql.slice(-60));
  assert(!/DROP/.test(sql), "文字列がそのまま入りました");
  return "既定値へ落とす";
});


/* ================================================================== */
head("[原稿]  101 日ぶんが揃っているかを、数えられるようにする");

await acheck("欠けている日を、コースごとに全部返す", async () => {
  const conn = fakeConn(() => [
    { track: "beginner", day_number: 1 },
    { track: "beginner", day_number: 2 },
    { track: "beginner", day_number: 101 },
    { track: "advanced", day_number: 1 }
  ]);
  const missing = await learning.findMissingTemplateDays(conn);

  /* コース別に返らないと、初級 101 日だけ揃った状態が
     「303 日中 101 日」に見えて、中級を選んだ人には 1 日目すら
     無いことが読み取れない。 */
  assert(missing.beginner.length === 98, `beginner ${missing.beginner.length} 日ぶん`);
  assert(missing.beginner[0] === 3, JSON.stringify(missing.beginner.slice(0, 3)));
  assert(missing.intermediate.length === 101, `intermediate ${missing.intermediate.length} 日ぶん`);
  assert(missing.advanced.length === 100, `advanced ${missing.advanced.length} 日ぶん`);
  return "初級 98 / 中級 101 / 上級 100";
});

await acheck("1 コースだけ訊いたら、そのコースの配列が返る", async () => {
  const conn = fakeConn(() => [{ track: "advanced", day_number: 1 }]);
  const missing = await learning.findMissingTemplateDays(conn, "advanced");
  assert(Array.isArray(missing), `配列ではなく ${typeof missing} が返りました`);
  assert(missing.length === 100, `${missing.length} 日ぶん`);
  /* 絞ったのに全コースぶんを読んでいないか。 */
  assert(/WHERE track = \?/.test(conn.calls[0].sql), conn.calls[0].sql);
  return "上級だけ 100 日";
});

await acheck("学期は day_number から決める（人に入れさせない）", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  await learning.upsertTemplate(conn,
    { track: "beginner", dayNumber: 45, grammarPoint: "-려고 하다", semester: 1 });
  /* params は (track, day_number, semester, …) の順。 */
  assert(conn.calls[0].params[2] === 2,
    `45 日目の学期が ${conn.calls[0].params[2]} になりました（正: 2）`);
  return "45 日目 → 2 学期";
});

await acheck("コースは 3 つ。ENUM の外を DB へ通さない", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  assert(learning.TRACKS.length === 3, learning.TRACKS.join(", "));

  /* migrations の ENUM と突き合わせる。片方だけ増やすと、
     コードにはあるのに DB に無い値を書きに行く ── MySQL の設定に
     よっては例外ではなく空文字が入り、その人だけ原稿が引けなくなる。 */
  const M001 = read("server/db/migrations/001-tracks-and-onboarding.sql");
  for (const t of learning.TRACKS) {
    assert(M001.includes(`'${t}'`), `${t} が migrations/001 の ENUM にありません`);
  }

  for (const bad of ["Beginner", "初級", "", null, undefined]) {
    let threw = false;
    try { await learning.upsertTemplate(conn, { track: bad, dayNumber: 1, grammarPoint: "x" }); }
    catch { threw = true; }
    assert(threw, `track=${JSON.stringify(bad)} が通りました`);
  }
  /* 引く側も同じ。既定で初級に落ちると、中級の人に初級が届く。 */
  let getThrew = false;
  try { await learning.getTemplate(conn, undefined, 1); } catch { getThrew = true; }
  assert(getThrew, "track 無しで原稿を引けてしまいました");
  return "3 つ以外を拒否（入れる側・引く側とも）";
});

/* コースを 1 度だけ決める setTrack は廃止した（migrations/002）。
   コースは買うときに選ぶようになり、1 人が初級 101 日を終えてから
   中級へ進めるようになったので、「1 度きり」という決めごとそのものが
   無くなっている。買った側の検査は tools/verify-billing.mjs にある。 */

await acheck("原稿の範囲は 1〜101", async () => {
  const conn = fakeConn(() => ({ affectedRows: 1 }));
  for (const bad of [0, 102, -1]) {
    let threw = false;
    try { await learning.upsertTemplate(conn, { track: "beginner", dayNumber: bad, grammarPoint: "x" }); }
    catch { threw = true; }
    assert(threw, `${bad} 日目が通りました`);
  }
  return "0 / 102 / -1 を拒否";
});

check("名前を差し込む既定は false ── 入れ忘れが「出ない」で済む向き", () => {
  assert(/requires_name_slot BOOLEAN NOT NULL DEFAULT FALSE/.test(SCHEMA),
    "既定が TRUE です。「-고 싶다 다나카」のような文が配信されます");
  return "DEFAULT FALSE";
});

await acheck("TINYINT(1) の 0/1 を真偽値に直して返す", async () => {
  const conn = fakeConn(() => [{ day_number: 1, track: "beginner", requires_name_slot: 0, vocab_3: '[{"kr":"사랑"}]' }]);
  const t = await learning.getTemplate(conn, "beginner", 1);
  assert(t.requires_name_slot === false, `${typeof t.requires_name_slot}`);
  assert(Array.isArray(t.vocab_3) && t.vocab_3[0].kr === "사랑", JSON.stringify(t.vocab_3));
  return "false / 配列";
});


/* ================================================================== */
head("[小道具]  JSON と .env");

check("JSON 列は解析済みでも文字列でも同じものを返す", () => {
  assert(fromJson('{"a":1}').a === 1, "文字列を解析していません");
  assert(fromJson({ a: 1 }).a === 1, "オブジェクトをそのまま返していません");
  assert(fromJson(null) === null && fromJson(undefined) === null, "null が null になりません");
  assert(fromJson("{壊れた") === null, "壊れた JSON で投げました。1 人ぶんで朝の配信が止まります");
  return "文字列 / オブジェクト / null / 壊れた値";
});

check("書くときは必ず文字列にする", () => {
  assert(toJson({ a: 1 }) === '{"a":1}', toJson({ a: 1 }));
  assert(toJson(null) === null, "null が消えました");
  assert(toJson('{"a":1}') === '{"a":1}', "二重に囲みました");
  return "[object Object] を入れない";
});

check(".env の鍵に # が入っていても切らない", () => {
  const e = parseEnv(`
    # 注釈
    DB_PASSWORD=a#b$c
    QUOTED="  空白つき  "
    export EXPORTED=1
    WITH_COMMENT=value # ここは注釈
    BROKEN
  `);
  assert(e.DB_PASSWORD === "a#b$c", `鍵が ${e.DB_PASSWORD} に切られました`);
  assert(e.QUOTED === "  空白つき  ", `[${e.QUOTED}]`);
  assert(e.EXPORTED === "1", "export 付きを読めません");
  assert(e.WITH_COMMENT === "value", `[${e.WITH_COMMENT}]`);
  assert(!("BROKEN" in e), "= の無い行を拾いました");
  return "5 通り";
});

check("足りない環境変数を、名前を全部挙げてから止める", () => {
  let msg = "";
  try { requireEnv(["DB_HOST", "DB_USER", "DB_NAME"], { DB_HOST: "localhost" }); }
  catch (e) { msg = e.message; }
  assert(msg.includes("DB_USER") && msg.includes("DB_NAME"),
    `1 つずつしか出ていません:\n${msg}`);
  assert(!msg.includes("DB_HOST"), "在るものまで挙げています");
  return "2 つを同時に";
});

check(".env.example の「秘密」の行が全部空", () => {
  const ex = read("server/.env.example");
  /* 秘密かどうかは名前で決める。REDIRECT_URI や DB_HOST のような
     公開してよい既定値まで空にすると、写した人が全部の行を
     埋めることになり、どれが本当に要るのか分からなくなる。 */
  const SECRET = /^(\w*(SECRET|TOKEN|PASSWORD)|\w*_KEY|LINE_LOGIN_CHANNEL_ID)=(.+)$/;
  const leaked = ex.split("\n")
    .map((l, i) => [l.trim(), i + 1])
    .filter(([l]) => SECRET.test(l))
    .map(([l, i]) => `${i} 行目: ${l.split("=")[0]}`);
  assert(!leaked.length, `値が入っています ── ${leaked.join(" / ")}`);

  /* 逆に、必要な行そのものが消えていないか。 */
  for (const k of ["DB_PASSWORD", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET",
                   "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
    assert(new RegExp(`^${k}=$`, "m").test(ex), `${k} の行がありません`);
  }
  return "5 つの鍵の行が空のまま存在";
});

check("server/.env が .gitignore で除外されている", () => {
  const ig = read(".gitignore");
  assert(/^(server\/)?\.env$/m.test(ig) || /^\*\*\/\.env$/m.test(ig),
    ".gitignore に server/.env がありません。鍵をコミットします");
  /* .env.example の方は逆に、除外されてしまうと設置の手引きが
     リポジトリから消える。両方を確かめる。 */
  assert(fs.existsSync("server/.env.example"), "server/.env.example がありません");
  return "server/.env は除外 / .env.example は残す";
});


/* ================================================================== */
head("[公開範囲]  バックエンドがサイトへ紛れ込まない");

check("build-site.sh の PUBLIC に server/ が入っていない", () => {
  const sh = read("tools/build-site.sh");
  const list = sh.match(/PUBLIC=\(([\s\S]*?)\)/)[1];
  assert(!/server/.test(list), "PUBLIC に server が入っています");
  return "許可リスト方式なので既定で除外";
});

check("dist に .env や .sql を混ぜない検査がある", () => {
  const sh = read("tools/build-site.sh");
  assert(/-name '\*\.sql'/.test(sh) && /-name '\*\.env'/.test(sh),
    "build-site.sh の非公開ファイル検査に *.sql / *.env がありません");
  return "*.sql / *.env も見る";
});


/* ================================================================== */
head("[配備]  配備タスクが server/content（唯一の原稿）を消せない");

/* 原稿・クイズは公開リポジトリに無く、サーバーのここにしか無い
   （plan-p4-content 決定⑤）。配備の 3 つの経路のどれか 1 つでも
   除外が抜けると、配備が原稿を消し、気づくのは翌朝配信が止まって
   から ── 文書の約束（STATUS §5「三経路が全部同一」）を、ここで
   機械に見張らせる（2026-08-05 配備失敗の指示書 §3）。 */
const PROTECTED = ["node_modules", ".env", ".env.local", "content", "tmp", "public", "stderr.log"];

check(".cpanel.yml の rsync 分岐が 7 つ全部を除外", () => {
  const yml = read(".cpanel.yml");
  const line = yml.split("\n").find((l) => /"\$RSYNC"/.test(l));
  assert(line, ".cpanel.yml に rsync 分岐が見つかりません");
  for (const n of PROTECTED) {
    assert(line.includes(`--exclude=${n}`), `rsync 分岐に --exclude=${n} がありません`);
  }
  return PROTECTED.join(" / ");
});

check(".cpanel.yml の find 分岐（rsync の無い今の本番はこちら）も同一", () => {
  const yml = read(".cpanel.yml");
  const line = yml.split("\n").find((l) => /find "\$APP"/.test(l));
  assert(line, ".cpanel.yml に find 分岐が見つかりません");
  for (const n of PROTECTED) {
    assert(line.includes(`! -name ${n}`), `find 分岐に ! -name ${n} がありません`);
  }
  return "消してから写す側も 7 つ除外";
});

check("tools/deploy-server.sh の rsync も同一（手動経路）", () => {
  const sh = read("tools/deploy-server.sh");
  const m = sh.match(/rsync[\s\S]*?server\/ /);
  assert(m, "deploy-server.sh に rsync が見つかりません");
  for (const n of PROTECTED) {
    assert(new RegExp(`--exclude[= ]'?${n.replace(".", "\\.")}'?`).test(m[0]),
      `deploy-server.sh に --exclude ${n} がありません`);
  }
  return "自動・画面・手動の三経路が同じ 7 つを守る";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
