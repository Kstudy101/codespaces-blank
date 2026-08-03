/* ==================================================================
   content-check.mjs — 原稿が入稿できる形かどうか

   原稿そのもの（server/content/）は公開リポジトリに置いていない。
   置くと有料で配るものが誰でも取れる状態になり、1 度 push すれば
   履歴から消せない。ただし「何を満たしていなければならないか」は
   コードなので、こちらは残す ── 原稿を持っていない人でも、
   受け入れ条件は読める。

   ここで止めたいのは、入ってしまうと直しにくい類い:

     ・{NAME}{NAME_EUN} → 아이아이는。助詞スロットは名前ごと
       置き換わるので、{NAME} と並べると名前が二重になる
     ・日本語の行に {NAME}（ハングル）が混ざる。日本語の文の中に
       いきなり 다나카 が出る
     ・requires_name_slot と中身の食い違い。true なのに名前を使って
       いない日は、名前の無い人へ無用な登録のお願いが飛ぶ
     ・単語が 3 語でない。2 通目の見た目がその日だけ崩れる

   どれも 1 日ぶんを見ている限りは気づける。101 日を通しで
   見るのが難しいだけなので、機械に数えさせる。
   ================================================================== */
import { SLOTS, findMisplacedSlot, renderDay } from "./render.mjs";

const TOTAL_DAYS = 101;

const ANY_SLOT = /\{(NAME(?:_[A-Z]+)?)\}/g;

/* パッチムのある名前と無い名前。両方で組み立ててみる ──
   片方でしか試さないと、助詞の分岐の片側が一度も動かない。 */
const PROBES = [
  { name_kr: "켄",     name_reading: "けん"   },   /* 받침あり */
  { name_kr: "사쿠라", name_reading: "さくら" }    /* 받침なし */
];

/* ハングル・ひらがな・カタカナ・漢字・記号のどれでもない文字を探す。
   原稿はコピー＆ペーストで作るので、全角の空白や別言語の
   引用符が紛れ込む。読めはするが、検索や置換のときにだけ効く。 */
const ODD_CHAR = /[^\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{ASCII}　-〿＀-￯\s]/u;

export function checkDay(d, seen = new Set()) {
  const bad = [];
  const at = (m) => bad.push(m);
  const day = Number(d?.day_number);

  if (!Number.isInteger(day) || day < 1 || day > TOTAL_DAYS) {
    return [`day_number が 1〜${TOTAL_DAYS} ではありません: ${JSON.stringify(d?.day_number)}`];
  }
  if (seen.has(day)) at(`${day} 日目が 2 回出てきます`);
  seen.add(day);

  if (!d.grammar_point) at("grammar_point がありません");
  if (!d.grammar_tip_kr) at("grammar_tip_kr がありません");

  /* --- 会話 --- */
  const dia = d.dialogue_template;
  if (!Array.isArray(dia) || dia.length < 2) {
    at("dialogue_template は 2 文以上の配列にしてください");
  } else {
    dia.forEach((row, i) => {
      const where = `会話 ${i + 1} 行目`;
      if (!row?.kr) return at(`${where}: kr がありません`);
      if (!row.ja)  at(`${where}: ja（日本語）がありません`);

      const mis = findMisplacedSlot(row.kr);
      if (mis) at(`${where}: 名前が二重になります → ${mis}`);

      /* 日本語の行にハングルの名前を出さない。逆も同じ。 */
      if (row.ja && /\{NAME\}/.test(row.ja)) {
        at(`${where}: 日本語の行は {NAME_JP} を使ってください（{NAME} はハングル）`);
      }
      if (/\{NAME_JP\}/.test(row.kr)) {
        at(`${where}: 韓国語の行に {NAME_JP}（かな）が入っています`);
      }
      if (row.who && findMisplacedSlot(row.who)) at(`${where}: who の中で名前が二重になります`);

      for (const s of unknownSlots(row.kr)) at(`${where}: 知らない差し込み口 {${s}}`);
      for (const s of unknownSlots(row.ja || "")) at(`${where}(日本語): 知らない差し込み口 {${s}}`);
      if (ODD_CHAR.test(row.kr)) at(`${where}: 見慣れない文字が混ざっています`);
    });
  }

  /* --- 単語 --- */
  const voc = d.vocab_3;
  if (!Array.isArray(voc) || voc.length !== 3) {
    at(`vocab_3 はちょうど 3 語にしてください（今 ${Array.isArray(voc) ? voc.length : "配列でない"}）`);
  } else {
    voc.forEach((w, i) => {
      if (!w?.kr) at(`単語 ${i + 1}: kr がありません`);
      if (!w?.meaning) at(`単語 ${i + 1}: meaning（日本語）がありません`);
      if (w?.kr && ANY_SLOT.test(w.kr)) at(`単語 ${i + 1}: 単語に差し込み口は使えません`);
      ANY_SLOT.lastIndex = 0;
    });
  }

  /* --- 名前を使うかどうかの申告と、中身が合っているか ---
     who（話者の札）は数えない。札は名前が無ければ「あなた」に
     なるので、その日を配れなくする理由にはならない。
     本文（kr / ja）と説明だけを見る。 */
  const bodyOnly = Array.isArray(dia)
    ? dia.map((r) => [r?.kr, r?.ja]) : [];
  const usesName = JSON.stringify([bodyOnly, d.grammar_tip_kr]).includes("{NAME");
  const declared = !!d.requires_name_slot;
  if (usesName && !declared) {
    at("名前を使っているのに requires_name_slot が false です");
  }
  if (!usesName && declared) {
    /* true のままだと、名前の無い人にこの日だけ登録のお願いが飛ぶ。
       名前を使っていないなら、その人にもふつうに届けられる。 */
    at("名前を使っていないのに requires_name_slot が true です");
  }

  /* --- 実際に組み立ててみる --- */
  for (const probe of PROBES) {
    let msgs;
    try {
      msgs = renderDay(d, probe);
    } catch (e) {
      at(`${probe.name_kr} で組み立てに失敗: ${e.message}`);
      continue;
    }
    if (!msgs) { at(`${probe.name_kr} で組み立てられませんでした`); continue; }

    const kr = probe.name_kr;
    for (const m of msgs) {
      if (m.text.includes(kr + kr)) at(`${kr} で名前が二重に出ます`);
      if (/\{[A-Z_]+\}/.test(m.text)) {
        at(`${kr} で差し込み口が残っています: ${m.text.match(/\{[A-Z_]+\}/)[0]}`);
      }
    }
  }

  return bad.map((m) => `${day}日目: ${m}`);
}

function unknownSlots(text) {
  const out = [];
  for (const m of String(text).matchAll(ANY_SLOT)) {
    if (!SLOTS.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/* まとめて見る。日の抜けも数える ── 101 日を売る以上、
   「買ったのに 87 日目が来ない」は起きてはいけない。 */
export function checkAll(days, { expect = null } = {}) {
  const seen = new Set();
  const problems = [];
  for (const d of days) problems.push(...checkDay(d, seen));

  if (expect) {
    const missing = [];
    for (let n = expect.from; n <= expect.to; n++) if (!seen.has(n)) missing.push(n);
    if (missing.length) problems.push(`抜けている日: ${missing.join(", ")}`);
  }

  /* 同じ文法が二度出ていないか。気づかずに重ねると、
     101 日ぶんに見えて中身が減る。 */
  const points = new Map();
  for (const d of days) {
    const p = String(d.grammar_point || "").trim();
    if (!p) continue;
    if (points.has(p)) problems.push(`${d.day_number}日目: ${points.get(p)}日目と同じ文法「${p}」`);
    else points.set(p, d.day_number);
  }

  return { ok: problems.length === 0, problems, count: seen.size };
}

export { PROBES, TOTAL_DAYS };
