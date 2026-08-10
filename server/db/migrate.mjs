#!/usr/bin/env node
/* ==================================================================
   migrate.mjs — schema.sql を適用する

     node server/db/migrate.mjs           適用する
     node server/db/migrate.mjs --check   つながるか・何が在るかだけ見る

   何度流しても同じ結果になるように書いてある（CREATE TABLE IF NOT
   EXISTS と INSERT IGNORE）。列を足す・変える段になったら、
   schema.sql を書き換えるのではなく db/migrations/ を作って
   足していくこと ── 既にデータが入った表に IF NOT EXISTS は効かない。

   【migrations/ の流し方】
   schema.sql のあとに、db/migrations/*.sql を名前順で流す。
   ただし**流すのは 1 度だけ**。何を流したかは schema_migrations に
   残し、記録のあるファイルは丸ごと飛ばす。

   ここが無かったあいだ、配置のたびに 001・002・003 が頭から流れて
   いた。ALTER には IF NOT EXISTS が無い（MariaDB にはあるが MySQL に
   は無いので、どちらでも動く書き方にはできない）ので「もう当たって
   いる」ことを表すエラーだけを飲み込んでいたが、それで足りるのは
   ALTER だけ。002 の INSERT ... SELECT は同じ 002 が落とす列を読むため、
   2 周目は errno 1054（Unknown column）で throw → exit(1) →
   .cpanel.yml の set -e で配置ごと止まる。

   飲み込む番号を増やす方向では直さない。増やすほど、綴りを間違えた
   ALTER が「適用済み」として静かに素通りする方へ寄る。

   【既に本番へ当たっている 3 本をどう数えるか（bootstrap）】
   この仕組みを入れた時点の本番は、001・002・003 が**適用済みなのに
   履歴が空**。履歴だけを見て流すと、いま直そうとしている事故を
   その場で起こす。なので 001〜003 には「当たっていれば必ず在るもの」
   （PROBES）を持たせ、それが在れば**流さずに履歴だけ書く**。
   まっさらな DB では探針が全部外れるので、ふつうに順番どおり流れる。
   004 以降に探針は要らない ── 履歴が空＝まだ流していない、で正しい。

   最後に、在るはずの表と列が本当に在るかを数える。CREATE が
   1 つ失敗しても後続は流れるので、「エラーは出なかった」だけでは
   足りない。列も同じで、migrations が流れたかどうかは
   information_schema を見て確かめる。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../lib/db.mjs";
import { splitStatements } from "../lib/sqlfile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED = [
  "users", "saju_profiles", "purchases", "subscriptions",
  "learning_progress", "content_templates", "push_logs", "quiz_checkpoints",
  /* P3 で足した。ウェブの占い結果を、LINE 認証から戻るまで預かる表。 */
  "pending_links",
  "oauth_states",
  /* 002 で足した。前払いの回数券をコース別に持つ。 */
  "course_entitlements", "lapse_log",
  /* 何を流したか。無いと migrations が毎回頭から流れ直す。 */
  "schema_migrations"
];

/* migrations が入れる列。流れたかどうかを名前で確かめる。
   「エラーが出なかった」は、飲み込んだ番号があるぶん証拠にならない。 */
const EXPECTED_COLUMNS = [
  ["content_templates",  "track"],
  ["content_templates",  "fortune_bridge"],
  ["learning_progress",  "track"],
  ["users",              "name_source"],
  ["saju_profiles",      "birth_confirmed"],
  /* 002。ここが流れていないと、配信が「残り日数」を数えられない。 */
  ["learning_progress",  "days_used"],
  ["users",              "active_track"],
  ["purchases",          "track"],
  ["subscriptions",      "trial_track"],
  ["course_entitlements", "days_entitled"],
  ["lapse_log",          "lapsed_at"],
  /* 003。復習クイズの原稿。無くてもクイズが黙って抜けるだけだが、
     列ごと無いと postback の採点が「未入稿」と読み違える。 */
  ["content_templates",  "quiz"],
  /* 009。週次マイクロ（hook/formula/mission）。無いと seed しても
     クラシック📘のまま届く（isMicroFormat が常に false）。 */
  ["content_templates",  "micro"],
  /* 007。体験で貰った日数を契約の行が持つ。無いと EXPECTED が
     COALESCE で 0 に落ち、体験者が全員 drift に載る。 */
  ["subscriptions",      "trial_days"]
];

/* 「もう当たっている」を表すものだけ。
     1060 列が既にある      1061 索引が既にある
     1068 主キーが既にある  1091 消そうとしたものが無い

   ★ 1054（Unknown column）をここに足してはいけない。足すと、
   列名を綴り間違えた SQL が「適用済み」として静かに素通りする。
   2 周目の 1054 は履歴（schema_migrations）が止めるので、
   飲み込む必要そのものが無い。 */
const ALREADY_APPLIED = new Set([1060, 1061, 1068, 1091]);

/* ---- 既に当たっているかを見る目印（bootstrap 用）--------------------
   この仕組みを入れる前から本番に当たっている 3 本ぶん。
   「当たっていれば必ず在るもの」を 1 つずつ選ぶ ── どれも、その
   ファイルの中でしか作られない。

   まっさらな DB では全部外れるので、ふつうに順番どおり流れる。
   004 以降には要らない（履歴が空＝まだ流していない、で正しい）。 */
const PROBES = Object.freeze({
  "001-tracks-and-onboarding.sql": { column: ["users", "name_source"] },
  "002-per-course-billing.sql":    { table:  "course_entitlements" },
  "003-review-quiz.sql":           { column: ["content_templates", "quiz"] }
});

const probeLabel = (p) =>
  p.table ? `${p.table} テーブル` : `${p.column[0]}.${p.column[1]} 列`;

const checkOnly = process.argv.includes("--check");

async function hasTable(pool, name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [name]);
  return Number(r.n) > 0;
}

async function hasColumn(pool, table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return Number(r.n) > 0;
}

const probePassed = (pool, p) =>
  p.table ? hasTable(pool, p.table) : hasColumn(pool, p.column[0], p.column[1]);

/* 履歴。表がまだ無ければ null ── 「1 件も流していない」（空配列）と
   区別する。--check はまっさらな DB に対しても走るので、
   そこで例外にすると何も見られなくなる。 */
async function appliedMigrations(pool) {
  if (!(await hasTable(pool, "schema_migrations"))) return null;
  const [rows] = await pool.query(
    `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`);
  return rows;
}

async function markApplied(pool, file) {
  /* INSERT IGNORE。二重起動でどちらも同じファイルを流し終えたとき、
     負けた側がここで落ちる理由が無い。 */
  await pool.query(`INSERT IGNORE INTO schema_migrations (filename) VALUES (?)`, [file]);
}

async function runMigrations(pool) {
  const dir = path.join(HERE, "migrations");
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) return;

  const history = await appliedMigrations(pool);
  if (history === null) {
    /* schema.sql がこの表を作る。無いということは schema.sql が
       流れていない ── そのまま migrations を流すと、記録の残らない
       適用ができてしまう。 */
    throw new Error(
      "schema_migrations がありません（schema.sql が流れていません）");
  }
  const done = new Set(history.map((r) => r.filename));

  console.log(`\nmigrations/: ${files.length} ファイル（適用済み ${done.size}）`);
  for (const file of files) {
    if (done.has(file)) {
      console.log(`  · ${file}  （適用済み。流しません）`);
      continue;
    }

    /* 履歴は空だが、中身はもう当たっている ── この仕組みを入れる前から
       動いている DB。流すと 2 周目と同じ事故になるので、記録だけ残す。 */
    const probe = PROBES[file];
    if (probe && await probePassed(pool, probe)) {
      await markApplied(pool, file);
      console.log(`  ✓ ${file}  （${probeLabel(probe)} が既にあります。流さずに履歴だけ記録）`);
      continue;
    }

    const statements = splitStatements(fs.readFileSync(path.join(dir, file), "utf8"));
    let applied = 0, skipped = 0;
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
        applied++;
      } catch (e) {
        if (ALREADY_APPLIED.has(e.errno)) { skipped++; continue; }
        console.error(`  ✗ ${file}\n      ${stmt.slice(0, 80).replace(/\s+/g, " ")}\n      ${e.message}`);
        throw e;
      }
    }
    /* 記録は最後に。途中で落ちたファイルを「適用済み」にすると、
       次の配置がその残りを二度と流さない。 */
    await markApplied(pool, file);
    console.log(`  ✓ ${file}  （${applied} 文を適用 / ${skipped} 文は適用済み）`);
  }
}

async function main() {
  const pool = await getPool();

  const [[ver]] = await pool.query(
    "SELECT VERSION() AS v, DATABASE() AS db, @@session.time_zone AS tz, NOW() AS now");
  console.log(`接続先: ${ver.db}  (${ver.v}, time_zone=${ver.tz}, NOW()=${ver.now})`);

  /* SYSTEM を通さない。SYSTEM はサーバーの時計に従うという意味で、
     借りたサーバーがどこの時刻かはこちらから決められない。
     ここが +09:00 でないと、CURRENT_TIMESTAMP を既定値に持つ列だけが
     別の時刻で入り、あとから区別できなくなる。 */
  let tzBad = 0;
  if (ver.tz !== "+09:00") {
    console.log(`  ✗ セッションの time_zone が ${ver.tz} です（+09:00 が要ります）`);
    console.log("    lib/db.mjs の pool.on('connection') で SET time_zone を出しています。");
    console.log("    そこが効いていないと、NOW() だけサーバーの時刻で記録されます。");
    tzBad = 1;
  }

  if (!checkOnly) {
    const sql = fs.readFileSync(path.join(HERE, "schema.sql"), "utf8");
    const statements = splitStatements(sql);
    console.log(`\nschema.sql: ${statements.length} 文`);

    for (const [n, stmt] of statements.entries()) {
      const label = (stmt.match(/^(CREATE TABLE IF NOT EXISTS|CREATE TABLE|INSERT IGNORE INTO|ALTER TABLE)\s+`?(\w+)`?/i)
        || [, stmt.slice(0, 40).replace(/\s+/g, " ")]).slice(1).join(" ");
      try {
        /* query であって execute ではない。DDL は prepared statement に
           できない文があり、execute だと種類によって落ちる。 */
        await pool.query(stmt);
        console.log(`  ✓ [${n + 1}] ${label}`);
      } catch (e) {
        console.error(`  ✗ [${n + 1}] ${label}\n      ${e.message}`);
        throw e;
      }
    }

    await runMigrations(pool);
  }

  /* 在るはずのものが在るか。 */
  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_COLLATION AS collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
  const have = new Map(tables.map((t) => [t.name, t.collation]));

  console.log("\nテーブル:");
  let missing = 0, wrongCharset = 0;
  for (const t of EXPECTED) {
    const col = have.get(t);
    if (!col) { console.log(`  ✗ ${t} … ありません`); missing++; continue; }
    /* utf8mb4 でないと日本語も韓国語も入らない。作れてはいるので
       画面上は成功に見え、名前を入れた最初の 1 人で初めて分かる。 */
    if (!String(col).startsWith("utf8mb4")) {
      console.log(`  ✗ ${t} … 照合順序が ${col}（utf8mb4 が要ります）`);
      wrongCharset++;
      continue;
    }
    console.log(`  ✓ ${t}`);
  }

  /* migrations が入れる列。表が在っても列が無いことはある ──
     schema.sql だけ流して migrations を流し忘れた場合で、そのときは
     配信が「コース未選択」から一歩も進まない。 */
  const [cols] = await pool.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const haveCol = new Set(cols.map((r) => `${r.t}.${r.c}`));

  console.log("\nmigrations の列:");
  let missingCols = 0;
  for (const [t, c] of EXPECTED_COLUMNS) {
    if (haveCol.has(`${t}.${c}`)) { console.log(`  ✓ ${t}.${c}`); continue; }
    console.log(`  ✗ ${t}.${c} … ありません（db/migrations/ が流れていません）`);
    missingCols++;
  }

  /* 何を流したか。--check でも出す ── 「列が無い」を見たときに
     次に見たいのがここで、読めないと「流れていない」のか
     「流したのに当たっていない」のかを切り分けられない。 */
  const history = await appliedMigrations(pool);
  console.log("\n適用済みの migration:");
  if (history === null) {
    console.log("  ✗ schema_migrations がありません（migrate を 1 度流してください）");
  } else if (!history.length) {
    console.log("  （記録はまだ 1 件もありません）");
  } else {
    for (const r of history) console.log(`  · ${r.filename}  ${r.applied_at}`);
  }

  const [cps] = await pool.query(`SELECT day_number FROM quiz_checkpoints ORDER BY day_number`);
  const cpDays = cps.map((r) => r.day_number).join(", ");
  const cpOk = cpDays === "30, 50, 75";
  console.log(`\n  ${cpOk ? "✓" : "✗"} quiz_checkpoints: ${cpDays || "(空)"}${cpOk ? "" : "  ← 30, 50, 75 が要ります"}`);

  /* コース別に数える。track が入る前は 1 本だったので、
     合計だけ見ていると「初級 50 日」と「3 コースに 17 日ずつ」の
     区別が付かない。 */
  if (haveCol.has("content_templates.track")) {
    const [byTrack] = await pool.query(
      `SELECT track, COUNT(*) AS n FROM content_templates GROUP BY track ORDER BY track`);
    const seen = new Map(byTrack.map((r) => [r.track, Number(r.n)]));
    const line = ["beginner", "intermediate", "advanced"]
      .map((t) => `${t} ${seen.get(t) || 0}`).join(" / ");
    console.log(`  · content_templates: ${line}  （各 101 日ぶん）`);
  } else {
    const [[tpl]] = await pool.query(`SELECT COUNT(*) AS n FROM content_templates`);
    console.log(`  · content_templates: ${tpl.n} / 101 日ぶん（P4 で入稿）`);
  }

  const bad = missing + wrongCharset + missingCols + (cpOk ? 0 : 1) + tzBad;
  console.log(bad ? `\n✗ ${bad} 件の問題があります` : "\n✓ スキーマは想定どおりです");
  return bad ? 1 : 0;
}

main()
  .then(async (code) => { await closePool(); process.exit(code); })
  .catch(async (e) => {
    console.error(`\n✗ ${e.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  });
