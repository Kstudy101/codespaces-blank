#!/usr/bin/env node
/* ==================================================================
   accel-day.mjs — 朝・夕配信を暦日を進めて連続実行する（手元・検証用）

     node db/with-env.mjs db/accel-day.mjs --user=7 --to=30 \
       --reset-to=0 --ensure-entitled=30

     # 文面だけ（LINE へ送らない）
     node db/with-env.mjs db/accel-day.mjs --user=7 --to=7 --dry-run

     # 実送信（テストアカウント限定で使うこと）
     node db/with-env.mjs db/accel-day.mjs --user=7 --to=30 \
       --reset-to=0 --ensure-entitled=30 --send

   できること
     ・体験 7 日ぶん（朝＋夕。6 日目夕に trial 勧誘）
     ・続けて 30 日目の朝（節目クイズ）まで

   やらないこと
     ・本番 cron の置き換え
     ・全利用者ループ
     ・決済の偽物作成（日数は --ensure-entitled で grant のみ）

   仕組み
     push-daily / push-evening を子プロセスで呼ぶ。
     --date を 1 日ずつ進め、push_logs.sent_at もその日に揃う
     （親側の改修）。夕方は listReviewTargets が朝を見つけられる。
   ================================================================== */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../lib/db.mjs";
import { users, entitlements, learning } from "../lib/repo/index.mjs";
import { addDays, jstDate } from "../lib/jst.mjs";
import { TRIAL_UPSELL_DAY, TRIAL_DAYS } from "../lib/repo/billing.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

if (flag("help") || flag("h")) {
  console.log(`使い方:
  node db/with-env.mjs db/accel-day.mjs --user=<id> --to=30 [options]

必須:
  --user=<users.id>          テストアカウント 1 人だけ

進行:
  --to=N                     ここまで朝を進める（current_day が N になるまで）
  --reset-to=D               開始前に current_day を D にする（例: 0）
  --ensure-entitled=N        保有日数が N 未満なら不足ぶん grant
  --start-date=YYYY-MM-DD    1 通目の朝の暦日（省略時=今日 JST）
  --no-evening               朝だけ
  --dry-run                  子にも --dry-run（既定。送らない）
  --send                     実送信（--dry-run を外す）

例（7 日体験＋30 日節目まで・下見）:
  --user=7 --to=30 --reset-to=0 --ensure-entitled=30

例（実送信・テスト LINE だけ）:
  上記に --send

メモ: TRIAL_UPSELL_DAY=${TRIAL_UPSELL_DAY}（体験 ${TRIAL_DAYS} 日の前夜）`);
  process.exit(0);
}

const USER_ID = Number(value("user", 0)) || 0;
const TO = Number(value("to", 0)) || 0;
const RESET_TO = value("reset-to", null);
const ENSURE = value("ensure-entitled", null);
const START = value("start-date", jstDate());
const NO_EVENING = flag("no-evening");
const SEND = flag("send");
const DRY = !SEND || flag("dry-run");

if (!USER_ID) {
  console.error("✗ --user=<users.id> が必要です（--help）");
  process.exit(1);
}
if (!Number.isInteger(TO) || TO < 1 || TO > 101) {
  console.error("✗ --to=1〜101 が必要です");
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(START)) {
  console.error(`✗ --start-date は YYYY-MM-DD: ${START}`);
  process.exit(1);
}
if (RESET_TO !== null) {
  const r = Number(RESET_TO);
  if (!Number.isInteger(r) || r < 0 || r > 101) {
    console.error("✗ --reset-to=0〜101");
    process.exit(1);
  }
}

function runChild(script, args) {
  const nodeArgs = [
    path.join(DIR, "with-env.mjs"),
    path.join(DIR, script),
    ...args
  ];
  console.log(`\n$ node ${script} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd: path.join(DIR, ".."),
    encoding: "utf8",
    env: process.env
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`${script} が終了コード ${r.status} で落ちました`);
  }
  return r.stdout || "";
}

async function main() {
  console.log(`accel-day  user=${USER_ID} → day ${TO}`
    + `  start=${START}  ${DRY ? "DRY-RUN（送りません）" : "★ SEND（実送信）"}`);
  if (!DRY) {
    console.log("⚠ テスト用 LINE アカウント以外には使わないでください。");
  }

  const pool = await getPool();
  let u = await users.findDeliverable(pool, USER_ID);
  if (!u) {
    console.error("✗ 対象外です（status / active_track / progress / entitlement を確認）");
    await closePool();
    process.exit(1);
  }
  console.log(`  track=${u.track}  status=${u.status}`
    + `  current_day=${u.current_day}  entitled=${u.days_entitled}`
    + `  used=${u.days_used}  remaining=${u.remaining}`);

  if (RESET_TO !== null) {
    const d = Number(RESET_TO);
    await learning.resetProgress(pool, USER_ID, u.track, d);
    console.log(`  resetProgress → current_day=${d}`);
  }

  if (ENSURE !== null) {
    const need = Number(ENSURE);
    if (!Number.isInteger(need) || need < 1) {
      console.error("✗ --ensure-entitled は正の整数");
      await closePool();
      process.exit(1);
    }
    u = await users.findDeliverable(pool, USER_ID);
    const have = Number(u.days_entitled || 0);
    if (have < need) {
      const add = need - have;
      await entitlements.grant(pool, USER_ID, u.track, add);
      console.log(`  ensure-entitled: ${have} → ${need}（+${add} grant）`);
    } else {
      console.log(`  ensure-entitled: 既に ${have} ≥ ${need}`);
    }
  }

  /* ループ中は DB を閉じずとも子が別接続を開く。親は都度読み直す。 */
  let step = 0;
  const maxSteps = TO + 5; /* 膠着ガード */

  while (step < maxSteps) {
    u = await users.findDeliverable(pool, USER_ID);
    if (!u) {
      console.error("✗ 途中で対象外になりました（日数切れ・status など）");
      break;
    }
    const cur = Number(u.current_day) || 0;
    if (cur >= TO) {
      console.log(`\n✓ current_day=${cur} ≥ --to=${TO} で終了`);
      break;
    }

    /* 次の朝が消費する日 = cur+1。暦日は start + (その日番号 - 1) */
    const nextDay = cur + 1;
    const date = addDays(START, nextDay - 1);
    const dryArgs = DRY ? ["--dry-run"] : [];

    console.log(`\n════ 壁ステップ ${step + 1}  次に送る日=${nextDay}`
      + `  暦=${date}  （今 current_day=${cur}）════`);

    const morningOut = runChild("push-daily.mjs", [
      `--user=${USER_ID}`, `--date=${date}`, ...dryArgs
    ]);

    if (!NO_EVENING && !DRY) {
      runChild("push-evening.mjs", [
        `--user=${USER_ID}`, `--date=${date}`
      ]);
    } else if (!NO_EVENING && DRY) {
      /* dry-run の朝は push_logs を書かない → 夕の listReviewTargets が空。
         実送信（--send）のときだけ夕を回す。 */
      console.log("  （dry-run）夕はスキップ — 朝がログを書かないため");
    }

    const after = await users.findDeliverable(pool, USER_ID);
    const cur2 = after ? Number(after.current_day) || 0 : cur;
    if (!DRY && cur2 === cur
        && !/名前|待ち|既送|停止|予定/.test(morningOut)) {
      console.error(`✗ current_day が進みません（${cur} のまま）。中断します`);
      await closePool();
      process.exit(1);
    }
    if (DRY) {
      /* dry-run は advanceDay しない。文面めくり用に current_day だけ進める
         （days_used は触らない）。 */
      await learning.resetProgress(pool, USER_ID, u.track, nextDay);
      console.log(`  （dry-run）current_day を ${nextDay} に仮置き`);
    }

    if (nextDay === TRIAL_UPSELL_DAY) {
      console.log(`  ※ 本日は TRIAL_UPSELL_DAY=${TRIAL_UPSELL_DAY}`
        + `（体験中なら夕に勧誘が付く）`);
    }
    if (nextDay === 30 || nextDay === 50 || nextDay === 75) {
      console.log(`  ※ 本日は節目 ${nextDay} 日目（朝に節目クイズが付く想定）`);
    }

    step++;
  }

  u = await users.findDeliverable(pool, USER_ID);
  console.log(`\n終わり  current_day=${u ? u.current_day : "?"}  remaining=${u ? u.remaining : "?"}`);
  await closePool();
}

await main();
