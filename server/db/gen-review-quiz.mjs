#!/usr/bin/env node
/* ==================================================================
   gen-review-quiz.mjs — 日別原稿から復習クイズ原稿を起こす

     node db/gen-review-quiz.mjs --track=beginner --days=1-50
     node db/gen-review-quiz.mjs --track=beginner --days=1-50 --out=quiz-beginner.json

   出力は merge-quiz.mjs に渡す形:

     { "track": "beginner",
       "quizzes": { "1": { "question": "…", "choices": ["…"], "answer": 0 } } }

   既に dayObj.quiz がある日は飛ばす（節目・毎日❓を壊さない）。
   2026-08-08: 오답은 같은 품사·비슷한 말을 우선（plan-quiz-harder-distractors）。
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

/* 인명·조사 조각·인용 잔해는 오답 후보에서 제외 */
function isJunk(w) {
  const t = String(w);
  if (t.length < 2) return true;
  if (/^[이가을를은는와과도만의]$/.test(t)) return true;
  if (/(민수|철수|영희)/.test(t)) return true;
  if (/다고$|라고$|냐고$|자는$/.test(t) && t.length <= 5) return true;
  return false;
}

function poolEntriesUpTo(day) {
  const out = [];
  for (let n = 1; n <= day; n++) {
    const d = byDay.get(n);
    if (!d) continue;
    for (const w of d.vocab_3 ?? []) {
      if (w?.kr && isUsableKr(w.kr) && !isJunk(cleanKr(w.kr))) {
        out.push({ kr: cleanKr(w.kr), pos: w.pos || "" });
      }
    }
  }
  /* 중복 제거（뒤에 나온 pos 우선） */
  const map = new Map();
  for (const e of out) map.set(e.kr, e);
  return [...map.values()];
}

function jaLabel(meaning) {
  return String(meaning).split("（")[0].split("(")[0].split("/")[0].trim();
}

function pickVocab(d) {
  const cands = (d.vocab_3 ?? []).filter((w) =>
    w?.kr && w?.meaning && isUsableKr(w.kr) && !isJunk(cleanKr(w.kr)));
  cands.sort((a, b) => {
    const ga = /하다$|다$/.test(a.kr) ? 0 : 1;
    const gb = /하다$|다$/.test(b.kr) ? 0 : 1;
    return ga - gb || b.kr.length - a.kr.length;
  });
  return cands[0] ?? null;
}

function scoreDistractor(answer, ansPos, cand) {
  if (cand.kr === answer || isJunk(cand.kr)) return -100;
  let s = 0;
  if (ansPos && cand.pos === ansPos) s += 5;
  if (answer.endsWith("하다") && cand.kr.endsWith("하다")) s += 3;
  if (answer.endsWith("다") && cand.kr.endsWith("다")) s += 2;
  if (Math.abs(answer.length - cand.kr.length) <= 2) s += 2;
  if (answer[0] === cand.kr[0]) s += 1;
  for (let i = 0; i + 2 <= answer.length; i++) {
    if (cand.kr.includes(answer.slice(i, i + 2))) { s += 2; break; }
  }
  return s;
}

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

const quizzes = {};
const skipped = { hasQuiz: [], noVocab: [], noDay: [] };

for (let day = dayFrom; day <= dayTo; day++) {
  const d = byDay.get(day);
  if (!d) { skipped.noDay.push(day); continue; }
  if (d.quiz) { skipped.hasQuiz.push(day); continue; }

  const vocab = pickVocab(d);
  if (!vocab) { skipped.noVocab.push(day); continue; }

  const answer = cleanKr(vocab.kr);
  const ansPos = vocab.pos || "";
  const pool = poolEntriesUpTo(day)
    .map((e) => ({ ...e, score: scoreDistractor(answer, ansPos, e) }))
    .filter((e) => e.score >= 0)
    .sort((a, b) => b.score - a.score || a.kr.localeCompare(b.kr));

  const distractors = [];
  for (const e of pool) {
    if (distractors.includes(e.kr)) continue;
    distractors.push(e.kr);
    if (distractors.length === 3) break;
  }
  if (distractors.length < 3) { skipped.noVocab.push(day); continue; }

  const choices = shuffle([answer, ...distractors], day * 31 + 7);
  const answerIdx = choices.indexOf(answer);
  const meaning = jaLabel(vocab.meaning);

  quizzes[String(day)] = {
    question: `「${meaning}」の韓国語は？`,
    choices,
    answer: answerIdx,
    explain: `「${meaning}」`
  };
}

const outDoc = { track: trackArg, quizzes };
const outPath = path.isAbsolute(outArg) ? outArg : path.join(SERVER_DIR, "content", outArg);
writeFileSync(outPath, JSON.stringify(outDoc, null, 2) + "\n", "utf8");

console.log(`✓ ${Object.keys(quizzes).length} 問を書きました: ${outPath}`);
if (skipped.hasQuiz.length) {
  console.log(`  既存クイズで飛ばした日: ${skipped.hasQuiz.length}日（신양식 매일 quiz — 정상）`);
}
if (skipped.noVocab.length) console.log(`  語彙不足で飛ばした日: ${skipped.noVocab.join(", ")}`);
if (skipped.noDay.length) console.log(`  原稿なし: ${skipped.noDay.join(", ")}`);
console.log(`\n※ 신양식은 매일 quiz 가 있어 merge 로 덮지 마십시오（데일리 ❓ 보호）.`);
console.log(`次（quiz 없는 날만）: node db/merge-quiz.mjs ${path.basename(outPath)} --days=${dayFrom}-${dayTo}`);
