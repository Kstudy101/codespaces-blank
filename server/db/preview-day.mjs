#!/usr/bin/env node
/* ==================================================================
   preview-day.mjs — レソン文面をその場で目視する（副作用ゼロ）

     bash db/run.sh db/preview-day.mjs --track=beginner --day=2
     node db/with-env.mjs db/preview-day.mjs --track=beginner --day=2
     node db/preview-day.mjs --file=content/beginner-01-15.json --day=2

   ★ やらないこと（他システムへ波及させない）
     ・LINE 送信
     ・advanceDay / days_used / current_day
     ・push_logs 書き込み
     ・HTTP 公開
     ・cron / app.mjs 変更

   シード直後に「朝まで待てない」確認用。本番配信とは別の道。
   ================================================================== */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool, closePool } from "../lib/db.mjs";
import { learning } from "../lib/repo/index.mjs";
import { isTrack, TRACKS } from "../lib/repo/learning.mjs";
import { renderDay } from "../lib/render.mjs";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

if (flag("help") || flag("h")) {
  console.log(`使い方:
  bash db/run.sh db/preview-day.mjs --track=beginner --day=2
  node db/preview-day.mjs --file=content/beginner-01-15.json --day=2

  --track=beginner|intermediate|advanced   DB から引く（--file と排他）
  --day=N                                  1〜101（必須）
  --file=path.json                         ローカル原稿（DB 不要）
  --name-kr=다나카 --name-ja=たなか         差し込み名（省略時は下の既定）
  --no-quiz                                ❓ 꼬리통을 빼서 1·2통만`);
  process.exit(0);
}

const DAY = Number(value("day", 0));
const TRACK = value("track", null);
const FILE = value("file", null);
const NAME_KR = value("name-kr", "카나코");
const NAME_JA = value("name-ja", "かなこ");
const QUIZ = !flag("no-quiz");

if (!Number.isInteger(DAY) || DAY < 1 || DAY > 101) {
  console.error("✗ --day=1〜101 が必要です");
  process.exit(1);
}
if (!!FILE === !!TRACK) {
  console.error("✗ --track=… か --file=… のどちらか一方だけ指定してください");
  process.exit(1);
}
if (TRACK && !isTrack(TRACK)) {
  console.error(`✗ --track は ${TRACKS.join(" / ")} のどれかです`);
  process.exit(1);
}

const user = {
  name_kr: NAME_KR,
  name_reading: NAME_JA,
  name_kanji: null
};

function loadFromFile(file, day) {
  const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const alt = path.resolve(SERVER, file);
  const use = existsSync(p) ? p : (existsSync(alt) ? alt : null);
  if (!use) throw new Error(`ファイルがありません: ${file}`);
  const raw = JSON.parse(readFileSync(use, "utf8"));
  const days = Array.isArray(raw) ? raw : raw.days;
  if (!Array.isArray(days)) throw new Error("JSON に days 配列がありません");
  const hit = days.find((d) => Number(d.day_number) === day);
  if (!hit) throw new Error(`${path.basename(use)} に day ${day} がありません`);
  return hit;
}

async function loadFromDb(track, day) {
  const pool = await getPool();
  try {
    const tpl = await learning.getTemplate(pool, track, day);
    if (!tpl) throw new Error(`DB に ${track} day ${day} がありません（シード済みか確認）`);
    return tpl;
  } finally {
    await closePool();
  }
}

const tpl = FILE
  ? loadFromFile(FILE, DAY)
  : await loadFromDb(TRACK, DAY);

const msgs = renderDay(tpl, user, { quizSection: QUIZ });
if (!msgs) {
  console.error("✗ renderDay が null です（名前差し込みが足りない可能性）");
  process.exit(1);
}

const trackLabel = TRACK || tpl.track || (FILE ? path.basename(FILE) : "?");
console.log(`── preview（送信なし・日数消費なし） ${trackLabel} day ${DAY}  name=${NAME_KR}/${NAME_JA} ──`);
console.log(`   ${msgs.length} 通\n`);

msgs.forEach((m, i) => {
  console.log(`======== 通 ${i + 1} (${m.type}) ========`);
  if (m.text) console.log(m.text);
  else console.log(JSON.stringify(m, null, 2));
  if (m.quickReply?.items?.length) {
    console.log("\n[quickReply]");
    for (const it of m.quickReply.items) {
      console.log(`  · ${it.action.label}  data=${it.action.data}`);
    }
  }
  console.log("");
});

console.log("── 以上（LINE には送っていません）──");
