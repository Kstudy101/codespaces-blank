/* ==================================================================
   maintain.mjs — 日次の掃除と見張り（cron から呼ぶ）

     node db/with-env.mjs db/maintain.mjs             実行する
     node db/with-env.mjs db/maintain.mjs --dry-run   数えるだけ

   やることは 4 つ。前半 2 つが掃除、後半 2 つが見張り。

     1 pending_links の期限切れを消す
       ここには**四柱の生年月日**が最大 8KB の JSON で入っている。
       privacy.html 第 2 項は「認証を中断した場合、預かった内容は
       30 分後に自動的に削除されます」と約束しているが、
       purgeExpired() は書かれただけで**どこからも呼ばれていなかった**
       ── 期限切れの行が無期限に積もり、ポリシーと実装が
       食い違っていた。/line/link/start が無認証の書き込み口である
       （Origin だけで通る）ことも、積もる速さを他人が決められる
       という意味でここに効く。

     2 push_logs の 400 日より古い行を消す（repo の既定のまま）

     3 保有日数と台帳のずれ（findEntitlementDrift）
       決済の二重付与・付与漏れが起きていないか。ずれた人**だけ**
       出す ── 毎日「異常なし」が並ぶと、本当の異常も読み飛ばされる
       （repo/billing.mjs の設計のまま）。直しはしない。ずれは
       原因を見てから直すもので、自動で合わせると原因ごと消える。

     4 買ったのに 1 日も届いていない人（listUnstarted）
       居るなら、配信が始まらない理由がどこかにある。

   --dry-run は 1 行も消さない。cron が実際に通る道（nodevenv を
   探す・DB に繋ぐ・対象を数える）を、誰の行も消さずに確かめる ──
   配信の下見（push-daily --dry-run）と同じ考え方。
   ================================================================== */
import { getPool, closePool } from "../lib/db.mjs";
import { links, pushlogs, billing, entitlements } from "../lib/repo/index.mjs";
import { jstDateTime } from "../lib/jst.mjs";

const DRY = process.argv.includes("--dry-run");
const now = jstDateTime();

const pool = await getPool();

console.log(`maintain ${DRY ? "（dry-run: 消しません）" : ""} now=${now}`);

/* ---- 1. 期限切れの預かり所 ------------------------------------------
   件数は必ず出す。privacy の約束をこの 1 行が守っているので、
   「動いているか」を cron のログから読めるようにしておく。 */
const expired = DRY
  ? await links.countExpired(pool, { now })
  : await links.purgeExpired(pool, { now });
console.log(`  pending_links: 期限切れ ${expired} 件${DRY ? "（対象のみ）" : "を削除"}`);

/* ---- 2. 古い配信ログ ------------------------------------------------ */
const oldLogs = DRY
  ? await pushlogs.countOlderThan(pool)
  : await pushlogs.purgeOlderThan(pool);
console.log(`  push_logs: 400 日より古い ${oldLogs} 件${DRY ? "（対象のみ）" : "を削除"}`);

/* ---- 3. 保有日数と台帳のずれ ---------------------------------------- */
const drift = await billing.findEntitlementDrift(pool);
if (drift.length) {
  console.log(`  ⚠ 保有日数と台帳がずれている: ${drift.length} 件`);
  for (const d of drift) {
    console.log(`    #${d.user_id}  ${d.track}  持っている=${d.stored_days} / 台帳=${d.expected_days}`);
  }
} else {
  console.log("  台帳とのずれ: なし");
}

/* ---- 3.5 逆方向 ── 台帳はあるのに保有の行が無い --------------------
   上の 3 は e 行を起点に数えるので、行ごと無い half-done
   （初回購入・体験の反쯤 실패）を見られない。台帳の側から引く。
   検出だけ ── 直すのは人（plan-outage-billing §2-2 C）。 */
const missing = await billing.findMissingEntitlements(pool);
if (missing.fromPurchases.length || missing.fromTrials.length) {
  for (const m of missing.fromPurchases) {
    console.log(`  ⚠ 決済の記録はあるのに保有の行が無い: #${m.user_id} ${m.track} bought=${m.bought}`);
  }
  for (const m of missing.fromTrials) {
    console.log(`  ⚠ 体験の記録はあるのに保有の行が無い: #${m.user_id} ${m.track}（体験を再試行できない状態）`);
  }
} else {
  console.log("  逆方向のずれ: なし");
}

/* ---- 4. 買ったのに始まっていない人 ---------------------------------- */
const unstarted = await entitlements.listUnstarted(pool);
if (unstarted.length) {
  console.log(`  ⚠ 買ったのに 1 日も届いていない: ${unstarted.length} 件`);
  for (const e of unstarted.slice(0, 20)) {
    console.log(`    #${e.user_id}  ${e.track}  bought=${e.daysEntitled}`);
  }
} else {
  console.log("  買ったのに未開始: なし");
}

await closePool();
