/* ==================================================================
   lapsed.mjs — 途中で切れて、戻って来ていない人を見る（読むだけ）

     node db/with-env.mjs db/lapsed.mjs
     node db/with-env.mjs db/lapsed.mjs --all      閉じたぶんも数える

   台帳そのものは lapse_log（migrations/002）。なぜ表を置いたのかは
   lib/repo/lapses.mjs の頭に書いてある ── 配信ログを 400 日で
   落とすので、そのあとは「いつ切れたか」を復元できないため。

   db/who.mjs と同じ決めごとで、**名前も生年月日も出さない**。
   出す先は cPanel の配置ログで、あとから誰でも読める。

   何日目で抜けたかを見るのが本題。特定の日に集中していれば、
   その日の原稿に理由がある可能性が高い ── 人ではなく原稿を
   直す話になる。
   ================================================================== */
import { getPool, closePool } from "../lib/db.mjs";
import { lapses } from "../lib/repo/index.mjs";
import { TOTAL_DAYS, TRACKS } from "../lib/repo/learning.mjs";

const ALL = process.argv.includes("--all");

const pool = await getPool();

/* ---- コース別のまとめ ------------------------------------------------ */
const rows = await lapses.summary(pool);
if (!rows.length) {
  console.log("台帳はまだ空です（切れた人がいません）");
  await closePool();
  process.exit(0);
}

console.log("コース別");
for (const r of rows) {
  console.log(`  ${String(r.track).padEnd(13)}`
    + ` 切れた ${String(r.total).padStart(4)} 件`
    + ` / まだ戻っていない ${String(r.still_open).padStart(4)} 件`
    + `　抜けた日 平均 ${r.avg_last_day} 日目（${r.min_last_day}〜${r.max_last_day}）`);
}

/* ---- どのあたりで抜けているか ----------------------------------------
   10 日ごとの帯で数える。1 日単位で並べると 101 行になって読めない。 */
const open = await lapses.listOpen(pool, { limit: 1000 });
if (open.length) {
  const bands = new Map();
  for (const l of open) {
    const b = Math.min(Math.floor(Number(l.last_day) / 10) * 10, TOTAL_DAYS - 1);
    bands.set(b, (bands.get(b) || 0) + 1);
  }
  console.log("\n抜けた日（まだ戻っていない人）");
  for (const b of [...bands.keys()].sort((a, b2) => a - b2)) {
    const n = bands.get(b);
    console.log(`  ${String(b).padStart(3)}〜${String(b + 9).padStart(3)} 日目  `
      + "█".repeat(Math.min(n, 40)) + ` ${n}`);
  }
}

/* ---- 直近 ------------------------------------------------------------ */
console.log(`\nまだ戻っていない人 ${open.length} 人（新しい順に 20 件）`);
for (const l of open.slice(0, 20)) {
  console.log(`  #${String(l.user_id).padStart(5)}`
    + `  ${String(l.track).padEnd(13)}`
    + `  ${l.last_day} 日目で停止`
    + `  買った日数 ${l.days_bought}`
    + `  ${l.lapsed_on}（${l.days_since} 日前）`);
}

if (ALL) {
  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  const still = rows.reduce((s, r) => s + Number(r.still_open), 0);
  console.log(`\n通算 ${total} 件のうち ${total - still} 件は買い直して戻っています`
    + `（${total ? Math.round(((total - still) / total) * 100) : 0}%）`);
}

await closePool();
