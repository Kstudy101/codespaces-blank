#!/usr/bin/env node
/* ==================================================================
   merge-quiz.mjs — クイズ原稿を日別原稿へ差し込む

     node db/merge-quiz.mjs quiz.json                下見（何も書かない）
     node db/merge-quiz.mjs quiz.json --days=1-3     範囲を切って下見
     node db/merge-quiz.mjs quiz.json --write        書き込む

   クイズ原稿の形（day 番号 → 1 問）:

     { "track": "beginner",
       "quizzes": { "1": { "question": "…", "choices": ["…"], "answer": 0 } } }

   なぜ seed に直接食わせず、この道具を挟むのか。

   ① 原稿は server/content/ にしか無い（公開リポジトリに置かない ──
      plan-p4-content.md 決定⑤）。quiz だけのファイルを seed に渡すと
      grammar_point が無いと言って全部落ちる。既存の日別原稿へ
      **quiz 欄だけ**を差し込む必要がある。

   ② 復習クイズは「その日までに習った言葉」しか出せない
      （docs/plan-quiz.md ── 範囲を外すと 3 日目の人に 40 日目の
      敬語が届く）。習ったかどうかは実物の原稿でしか確かめられない
      ので、検査は原稿のある場所で走らせる。ここで見る:

        正解の文字列が、その日までの vocab_3 / 会話 / 文法に
        出てくるか。出てこなければ**差し込まずに**名指しで報告する
        ── どの日へ回すかは人が決める（勝手に動かさない）。

   ③ 差し込む以外は 1 文字も触らない。既存の欄はそのまま、
      quiz だけ足す（あれば上書き）。

   DB は使わない。fs だけ。書くのは --write のときだけで、
   既定は下見 ── 何がどうなるかを全部並べて、何も書かない。
   ================================================================== */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = process.env.CONTENT_DIR || path.join(SERVER_DIR, "content");

const argv  = process.argv.slice(2);
const WRITE = argv.includes("--write");
const files = argv.filter((a) => !a.startsWith("--"));

/* --days=4-15 / --days=7 の両方を受ける。 */
let dayFrom = 1, dayTo = 101;
const daysArg = argv.find((a) => a.startsWith("--days="));
if (daysArg) {
  const m = daysArg.slice(7).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) { console.error(`✗ --days の形が読めません: ${daysArg}`); process.exit(1); }
  dayFrom = Number(m[1]);
  dayTo   = Number(m[2] ?? m[1]);
}

if (files.length !== 1) {
  console.error("使い方: node db/merge-quiz.mjs <quiz.json> [--days=A-B] [--write]");
  process.exit(1);
}

/* ---- クイズ原稿を読む --------------------------------------------- */
let quizDoc;
try {
  quizDoc = JSON.parse(readFileSync(files[0], "utf8"));
} catch (e) {
  console.error(`✗ ${files[0]} が JSON として読めません: ${e.message}`);
  process.exit(1);
}
const TRACK = quizDoc.track || "beginner";
const quizzes = quizDoc.quizzes;
if (!quizzes || typeof quizzes !== "object" || Array.isArray(quizzes)) {
  console.error("✗ quizzes（day 番号 → 1 問の表）がありません");
  process.exit(1);
}

/* ---- 形を全部見てから進む（seed と同じ態度）------------------------
   1 件ずつ差し込みながら検査すると、途中で落ちたときに
   半分だけ入った状態が残る。 */
const ANY_SLOT = /\{[A-Z_]+\}/;
const formBad = [];
for (const [dayStr, q] of Object.entries(quizzes)) {
  const day = Number(dayStr);
  const at = (m) => formBad.push(`day ${dayStr}: ${m}`);
  if (!Number.isInteger(day) || day < 1 || day > 101) { at("day が 1〜101 ではありません"); continue; }
  if (!q || typeof q !== "object") { at("中身がありません"); continue; }
  if (typeof q.question !== "string" || !q.question.trim()) at("question がありません");
  if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 4) {
    at(`choices は 2〜4 個です（今 ${Array.isArray(q.choices) ? q.choices.length : "配列でない"}）`);
  } else if (q.choices.some((c) => typeof c !== "string" || !c.trim())) {
    at("空の選択肢があります");
  } else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
    at(`answer が範囲外です: ${JSON.stringify(q.answer)}（0〜${q.choices.length - 1}）`);
  }
  if (ANY_SLOT.test(JSON.stringify(q))) at("差し込み口（{NAME} 等）は使えません");
}
if (formBad.length) {
  console.error(`✗ 形の問題が ${formBad.length} 件。1 件も差し込んでいません。\n`);
  for (const m of formBad) console.error(`  ・${m}`);
  process.exit(1);
}

/* ---- 日別原稿を読む ----------------------------------------------- */
if (!existsSync(CONTENT_DIR)) {
  console.error(`✗ ${CONTENT_DIR} がありません。`);
  console.error("  原稿は公開リポジトリに無いので、原稿のあるサーバー上で走らせてください。");
  process.exit(1);
}

/* seed-content.mjs の load() と同じ「形で見る」。days 配列を持つ
   JSON だけが原稿で、それ以外（fortune-lines.json やクイズ原稿
   そのもの）は黙って飛ばす。 */
const contentFiles = [];   /* { file, doc, track, dirty } */
for (const f of readdirSync(CONTENT_DIR).filter((x) => x.endsWith(".json")).sort()) {
  const full = path.join(CONTENT_DIR, f);
  let doc;
  try { doc = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
  const got = Array.isArray(doc) ? doc : doc.days;
  if (!Array.isArray(got)) continue;
  contentFiles.push({ file: full, doc, days: got,
    track: (Array.isArray(doc) ? null : doc.track) || "beginner", dirty: false });
}
if (!contentFiles.length) {
  console.error(`✗ ${CONTENT_DIR} に原稿（days 配列を持つ JSON）がありません`);
  process.exit(1);
}

/* day 番号 → { entry, dayObj }。同じコースだけ。 */
const byDay = new Map();
for (const entry of contentFiles) {
  if (entry.track !== TRACK) continue;
  for (const d of entry.days) byDay.set(Number(d.day_number), { entry, dayObj: d });
}

/* ---- 習った言葉か（docs/plan-quiz.md の範囲則を原稿で確かめる）----
   正解の文字列が、その日**まで**の原稿のどこかに出てくるか。
   vocab_3 の kr / 会話の kr / 文法名・説明を通しで見る。

   出てこない ＝ まだ習っていない可能性。差し込まずに名指しで
   報告する。どの日へ回すかは原稿を書いた人が決める ── ここで
   勝手に動かすと、「なぜ 7 日目のクイズが 20 日目に居るのか」を
   誰も説明できなくなる。 */
function taughtBy(day, answerText) {
  for (let n = 1; n <= day; n++) {
    const hit = byDay.get(n);
    if (!hit) continue;
    const d = hit.dayObj;
    const hay = [
      d.grammar_point, d.grammar_tip_kr,
      ...(Array.isArray(d.vocab_3) ? d.vocab_3.map((w) => w?.kr) : []),
      ...(Array.isArray(d.dialogue_template) ? d.dialogue_template.map((r) => r?.kr) : [])
    ].filter(Boolean).join("\n");
    if (hay.includes(answerText)) return n;
  }
  return null;
}

/* ---- 突き合わせ ---------------------------------------------------- */
const applied = [], held = [], missing = [], skipped = [];
const CIRCLED = ["①", "②", "③", "④"];

for (const [dayStr, q] of Object.entries(quizzes)) {
  const day = Number(dayStr);
  if (day < dayFrom || day > dayTo) { skipped.push(day); continue; }

  const hit = byDay.get(day);
  if (!hit) { missing.push(day); continue; }

  const answerText = q.choices[q.answer];
  const learnedAt = taughtBy(day, answerText);
  if (learnedAt === null) {
    held.push({ day, q, answerText });
    continue;
  }

  hit.dayObj.quiz = { question: q.question, choices: q.choices, answer: q.answer };
  hit.entry.dirty = true;
  applied.push({ day, q, answerText, learnedAt, file: path.basename(hit.entry.file) });
}

/* ---- 報告 ---------------------------------------------------------- */
console.log(`クイズ原稿: ${path.basename(files[0])} → ${TRACK}`
  + (daysArg ? `（day ${dayFrom}〜${dayTo} だけ）` : ""));

if (applied.length) {
  console.log(`\n差し込む ${applied.length} 問（正解は添字を解いた文字列で確かめてください）`);
  for (const a of applied) {
    console.log(`  [day ${a.day}] ${a.q.question} → answer:${a.q.answer}`
      + ` = ${CIRCLED[a.q.answer] || a.q.answer}「${a.answerText}」`
      + `　（${a.learnedAt} 日目で学習・${a.file}）`);
  }
}
if (held.length) {
  console.log(`\n★ 差し込まなかった ${held.length} 問 ── 正解がその日までの原稿に見つかりません`);
  console.log("   （まだ習っていない可能性。どの日へ回すかは人が決めてください）");
  for (const h of held) {
    console.log(`  [day ${h.day}] ${h.q.question} → 正解「${h.answerText}」が day 1〜${h.day} に無い`);
  }
}
if (missing.length) console.log(`\n・原稿そのものが無い日: ${missing.join(", ")}（先に本編を入稿）`);
if (skipped.length) console.log(`・--days の範囲外で見送った日: ${skipped.join(", ")}`);

/* ---- 書く（--write のときだけ）------------------------------------ */
if (!WRITE) {
  console.log(`\n下見だけです。書き込むには --write を付けてください。`);
  process.exit(held.length ? 2 : 0);   /* 保留があれば 2 ── 見逃させない */
}
let wrote = 0;
for (const entry of contentFiles) {
  if (!entry.dirty) continue;
  writeFileSync(entry.file, JSON.stringify(entry.doc, null, 2) + "\n", "utf8");
  console.log(`\n✓ 書きました: ${entry.file}`);
  wrote++;
}
if (!wrote) console.log("\n書くものがありませんでした");
console.log("次: node db/with-env.mjs db/seed-content.mjs --check で答え合わせを目視");
process.exit(held.length ? 2 : 0);
