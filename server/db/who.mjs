/* ==================================================================
   who.mjs — 配信対象が今どうなっているかを見る（読むだけ）

     node db/with-env.mjs db/who.mjs

   名前も生年月日も出さない。出す先は cPanel の配置ログで、
   あとから誰でも読める。知りたいのは「送れる状態か」であって
   その人が誰かではないので、有無だけを出す。
   ================================================================== */
import { getPool, closePool } from "../lib/db.mjs";
import { users, learning } from "../lib/repo/index.mjs";

const pool = await getPool();
const rows = await users.listDeliverable(pool, { limit: 50 });

console.log(`配信対象 ${rows.length} 人`);
for (const u of rows) {
  const raw = u.raw_result_json || {};
  console.log([
    `  #${u.id}`,
    `status=${u.status}`,
    `day=${u.current_day}`,
    `entitled=${u.total_days_entitled}`,
    `track=${u.track || "未選択"}`,
    `name=${u.name_kr ? "あり" : "なし"}`,
    `namesrc=${u.name_source || "未回答"}`,
    `reading=${u.name_reading ? "あり" : "なし"}`,
    `saju=${u.birth_date ? "あり" : "なし"}`,
    /* 確認済みかどうかで運勢が付くかが変わるので、有無とは別に出す。 */
    `birthok=${u.birth_confirmed ? "はい" : "いいえ"}`,
    `ohaeng=${u.ohaeng_main || "-"}`,
    `zodiac=${raw.zodiac || "-"}`,
    `city=${raw.city || "-"}`
  ].join("  "));
}

const missing = await learning.findMissingTemplateDays(pool);
console.log("\n原稿:");
for (const track of learning.TRACKS) {
  console.log(`  ${track}: ${101 - missing[track].length}/101 日`);
}
await closePool();
