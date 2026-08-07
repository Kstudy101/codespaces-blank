#!/usr/bin/env node
/* ==================================================================
   gen-review-quiz.mjs — 日別原稿から復習クイズ原稿を起こす

     node db/gen-review-quiz.mjs --track=beginner --days=1-50
     node db/gen-review-quiz.mjs --track=beginner --days=1-50 --out=quiz-beginner.json

   出力は merge-quiz.mjs に渡す形:

     { "track": "beginner",
       "quizzes": { "1": { "question": "…", "choices": ["…"], "answer": 0 } } }

   既に dayObj.quiz がある日は飛ばす（節目 30/50/75 等を壊さない）。
   正解はその日の vocab_3 / 会話から取り、merge-quiz の taughtBy が通る
   ようにする。人が merge → seed する前の下書き道具。
   ================================================================== */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = process.env.CONTENT_DIR || path.join(SERVER_DIR, "content");

const argv = process.argv.slice(2);
const trackArg = argv.find((a) => a.startsWith("--track="))?.slice(8) || "beginner";
const daysArg  = argv.find((a) => a.startsWith("--days="))?.slice(7) || "1-50";
const outArg   = argv.find((a) => a.startsWith("--out="))?.slice(6)
  || `quiz-${trackArg}-review.json`;

const m = daysArg.match(/^(\d+)(?:-(\d+))?$/);
if (!m) { console.error(`✗ --days の形が読めません: ${daysArg}`); process.exit(1); }
const dayFrom = Number(m[1]);
const dayTo   = Number(m[2] ?? m[1]);

/* ---- 原稿を読む（merge-quiz.mjs と同じ）--------------------------- */
if (!existsSync(CONTENT_DIR)) {
  console.error(`✗ ${CONTENT_DIR} がありません`);
  process.exit(1);
}

const byDay = new Map();
for (const f of readdirSync(CONTENT_DIR).filter((x) => x.endsWith(".json")).sort()) {
  let doc;
  try { doc = JSON.parse(readFileSync(path.join(CONTENT_DIR, f), "utf8")); } catch { continue; }
  const got = Array.isArray(doc) ? doc : doc.days;
  if (!Array.isArray(got)) continue;
  const track = (Array.isArray(doc) ? null : doc.track) || "beginner";
  if (track !== trackArg) continue;
  for (const d of got) byDay.set(Number(d.day_number), d);
}

function cleanKr(s) {
  return String(s).replace(/\{[A-Z_]+\}/g, "").trim();
}

function isUsableKr(s) {
  const t = cleanKr(s);
  return t.length >= 2 && !/\{[A-Z_]+\}/.test(s) && /[가-힣]/.test(t);
}

/* ---- プール（その日までに出てきた韓国語）-------------------------- */
function poolUpTo(day) {
  const out = [];
  for (let n = 1; n <= day; n++) {
    const d = byDay.get(n);
    if (!d) continue;
    for (const w of d.vocab_3 ?? []) {
      if (w?.kr && isUsableKr(w.kr)) out.push(cleanKr(w.kr));
    }
    for (const r of d.dialogue_template ?? []) {
      if (r?.kr && typeof r.kr === "string" && !/\{[A-Z_]+\}/.test(r.kr)) {
        for (const tok of cleanKr(r.kr).split(/\s+/)) {
          const t = tok.replace(/[.,?!…]/g, "").trim();
          if (t.length >= 2 && /[가-힣]/.test(t)) out.push(t);
        }
      }
    }
  }
  return [...new Set(out)];
}

/* 決定的シャッフル（日番号で seed） */
function shuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickVocab(d) {
  const cands = (d.vocab_3 ?? []).filter((w) =>
    w?.kr && w?.meaning && isUsableKr(w.kr));
  /* 文法記号より実語を優先 */
  cands.sort((a, b) => {
    const ga = /[가-힣]{2,}/.test(a.kr) ? 0 : 1;
    const gb = /[가-힣]{2,}/.test(b.kr) ? 0 : 1;
    return ga - gb || b.kr.length - a.kr.length;
  });
  return cands[0] ?? null;
}

function jaLabel(meaning) {
  return String(meaning).split("（")[0].split("(")[0].trim();
}

const quizzes = {};
const skipped = { hasQuiz: [], noVocab: [], noDay: [] };

for (let day = dayFrom; day <= dayTo; day++) {
  const d = byDay.get(day);
  if (!d) { skipped.noDay.push(day); continue; }
  if (d.quiz) { skipped.hasQuiz.push(day); continue; }

  const vocab = pickVocab(d);
  if (!vocab) { skipped.noVocab.push(day); continue; }

  const answer = cleanKr(vocab.kr);
  const pool = poolUpTo(day).filter((w) => w !== answer);
  if (pool.length < 3) { skipped.noVocab.push(day); continue; }

  const distractors = shuffle(pool, day * 17 + 3).slice(0, 3);
  const choices = shuffle([answer, ...distractors], day * 31 + 7);
  const answerIdx = choices.indexOf(answer);

  quizzes[String(day)] = {
    question: `「${jaLabel(vocab.meaning)}」の韓国語は？`,
    choices,
    answer: answerIdx
  };
}

const outDoc = { track: trackArg, quizzes };
const outPath = path.isAbsolute(outArg) ? outArg : path.join(SERVER_DIR, "content", outArg);
writeFileSync(outPath, JSON.stringify(outDoc, null, 2) + "\n", "utf8");

console.log(`✓ ${Object.keys(quizzes).length} 問を書きました: ${outPath}`);
if (skipped.hasQuiz.length) console.log(`  既存クイズで飛ばした日: ${skipped.hasQuiz.join(", ")}`);
if (skipped.noVocab.length) console.log(`  語彙不足で飛ばした日: ${skipped.noVocab.join(", ")}`);
if (skipped.noDay.length) console.log(`  原稿なし: ${skipped.noDay.join(", ")}`);
console.log(`\n次: node db/merge-quiz.mjs ${path.basename(outPath)} --days=${dayFrom}-${dayTo}`);
console.log(`    node db/merge-quiz.mjs ${path.basename(outPath)} --days=${dayFrom}-${dayTo} --write`);
