#!/usr/bin/env node
/* ==================================================================
   migrate.mjs — schema.sql を適用する

     node server/db/migrate.mjs           適用する
     node server/db/migrate.mjs --check   つながるか・何が在るかだけ見る

   何度流しても同じ結果になるように書いてある（CREATE TABLE IF NOT
   EXISTS と INSERT IGNORE）。列を足す・変える段になったら、
   schema.sql を書き換えるのではなく db/migrations/ を作って
   足していくこと ── 既にデータが入った表に IF NOT EXISTS は効かない。

   最後に、在るはずの 8 つが本当に在るかを数える。CREATE が
   1 つ失敗しても後続は流れるので、「エラーは出なかった」だけでは
   足りない。
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
  "pending_links"
];

const checkOnly = process.argv.includes("--check");

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

  const [cps] = await pool.query(`SELECT day_number FROM quiz_checkpoints ORDER BY day_number`);
  const cpDays = cps.map((r) => r.day_number).join(", ");
  const cpOk = cpDays === "30, 50, 75";
  console.log(`\n  ${cpOk ? "✓" : "✗"} quiz_checkpoints: ${cpDays || "(空)"}${cpOk ? "" : "  ← 30, 50, 75 が要ります"}`);

  const [[tpl]] = await pool.query(`SELECT COUNT(*) AS n FROM content_templates`);
  console.log(`  · content_templates: ${tpl.n} / 101 日ぶん（P4 で入稿）`);

  const bad = missing + wrongCharset + (cpOk ? 0 : 1) + tzBad;
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
