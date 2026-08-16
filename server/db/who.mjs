/* ==================================================================
   who.mjs — 配信対象が今どうなっているかを見る（読むだけ）

     node db/with-env.mjs db/who.mjs

   名前も生年月日も出さない。出す先は cPanel の配置ログで、
   あとから誰でも読める。知りたいのは「送れる状態か」であって
   その人が誰かではないので、有無だけを出す。
   ================================================================== */
import { getPool, closePool } from "../lib/db.mjs";
import { users, learning, entitlements, lapses } from "../lib/repo/index.mjs";

const pool = await getPool();
const rows = await users.listDeliverable(pool, { limit: 50 });

console.log(`配信対象 ${rows.length} 人`);
for (const u of rows) {
  const raw = u.raw_result_json || {};
  const remaining = Number(u.days_entitled ?? 0) - Number(u.days_used ?? 0);
  console.log([
    `  #${u.id}`,
    `status=${u.status}`,
    `track=${u.track}`,
    `day=${u.current_day}`,
    /* 買った日数と使った日数を両方出す。残りだけだと、やり直した人
       （current_day だけ 0 に戻る）と買い足した人を見分けられない。 */
    `bought=${u.days_entitled}`,
    `used=${u.days_used}`,
    `left=${remaining}`,
    `name=${u.name_kr ? "あり" : "なし"}`,
    `namesrc=${u.name_source || "未回答"}`,
    /* 旧サイト診断から引き継いだ値。2026-08-16 以降どの配信もこれを
       読まないが、残っている人を数えられるように表示は残す。 */
    `saju=${u.birth_date ? "あり" : "なし"}`,
    `birthok=${u.birth_confirmed ? "はい" : "いいえ"}`,
    `ohaeng=${u.ohaeng_main || "-"}`,
    `zodiac=${raw.zodiac || "-"}`,
    `city=${raw.city || "-"}`
  ].join("  "));
}

/* 買ったのに 1 日も受け取っていない人。居るなら、配信が始まらない
   理由がどこかにある（active_track が入っていない等）。 */
const unstarted = await entitlements.listUnstarted(pool);
if (unstarted.length) {
  console.log(`\n⚠ 買ったのに 1 日も届いていない: ${unstarted.length} 件`);
  for (const e of unstarted.slice(0, 20)) {
    console.log(`  #${e.user_id ?? "?"}  ${e.track}  bought=${e.daysEntitled}`);
  }
}

const open = await lapses.countOpen(pool);
if (open) console.log(`\n途中で切れたまま戻っていない人: ${open} 人（db/lapsed.mjs で詳しく）`);

const missing = await learning.findMissingTemplateDays(pool);
console.log("\n原稿:");
for (const track of learning.TRACKS) {
  console.log(`  ${track}: ${101 - missing[track].length}/101 日`);
}
await closePool();
