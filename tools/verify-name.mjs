#!/usr/bin/env node
/* ==================================================================
   verify-name.mjs — index.html の「名前の変換」

     使い方:  node tools/verify-name.mjs

   このサイトの STEP 1 は「あなたの名前は韓国語でどう書くか」で、
   それを出しているのは index.html にインラインで書かれた 2 つの表。

     かな → ハングル   KANA1 / KANA2 + kanaToHangul()
     漢字 → 韓国漢字音 HANJA（手書き 222 字）

   どちらもこの저장소の中では何とも突き合わせていなかった。README に
   「jsdom で 53 ケース」と書いてあるが、それはここに無く、二度と走らない。

   かなの変換関数は DOM に触らない純関数なので、index.html から
   その範囲だけ切り出して動かす。切り出す目印は「1. ハングル 組み立て」の
   先頭（const CHO）から「3. 漢字 →」の HANJA まで。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  \u2713 ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  \u2717 ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);

const IDX = fs.readFileSync("index.html", "utf8");
const KANJI = JSON.parse(fs.readFileSync("kanji.json", "utf8"));

/* ---- 変換関数を切り出す --------------------------------------------- */
const from = IDX.indexOf("const CHO = [");
const to   = IDX.indexOf("const HANJA = {");
if (from < 0 || to < 0 || to <= from) {
  console.error("\u2717 index.html から変換部を切り出せません（節の見出しが変わった可能性）");
  process.exit(1);
}
const box = {};
vm.createContext(box);
// const 宣言は文脈オブジェクトの属性にならない（function は なる）ので、
// 表を見たい分だけ明示的に出す。
vm.runInContext(IDX.slice(from, to) + "\n;globalThis.KANA1=KANA1;globalThis.KANA2=KANA2;",
                box, { filename: "index.html<kana>" });
const conv = (s) => box.kanaToHangul(s).join("");

/* ---- 1. かな → ハングル ---------------------------------------------- */

head("[かな]  STEP 1 そのもの。ここが違えば名前が違う名前になる");

check("README に書いた規則が、書いたとおりに動く", () => {
  // README「구현된 가나 규칙」の表と、設計判断「発音そのまま（有気音）」。
  // 文書と実装が離れると、どちらが正なのか誰にも分からなくなる。
  const cases = [
    ["たなか",     "타나카",   "有気音。規範表記の 다나카 は採らない"],
    ["しゅん",     "슌",       "拗音は 2 かなで 1 音節"],
    ["しんばし",   "신바시",   "撥音 ん → 終声 \u3134"],
    ["さっぽろ",   "삿포로",   "促音 っ → 終声 \u3145"],
    ["けんたろー", "켄타로",   "長音記号は省く"],
    ["とうきょう", "토쿄",     "長母音 おう は縮める"],
    ["いのうえ",   "이노우에", "ただし次が母音なら縮めない"]
  ];
  const bad = [];
  for (const [i, want] of cases) {
    const got = conv(i);
    if (got !== want) bad.push(`${i} → ${got}（${want} のはず）`);
  }
  assert(!bad.length, bad.join(" / "));
  return cases.map(c => `${c[0]}=${c[1]}`).join(" ");
});

check("カタカナで入れても同じ結果になる", () => {
  // 入力欄は「ふりがな」だが、カタカナの名前・ニックネームも受ける。
  const kata = (s) => s.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const bad = [];
  for (const w of ["たなか", "しゅんすけ", "さっぽろ", "とうきょう", "みょうじ", "ゔぃくとる"]) {
    const a = conv(w), b = conv(kata(w));
    if (a !== b) bad.push(`${w}: ${a} / ${kata(w)}: ${b}`);
  }
  assert(!bad.length, bad.join(" / "));
  return "ひらがな = カタカナ";
});

/* isKana() が受け付ける文字は、変換しても消えてはいけない。
   消えると名前から字が 1 つ減るが、画面には何も出ない ── 実際
   ヶ（ヵ・ヮ も）がこれで消えていた。toHira() が ヶ を ゖ に送るのに
   KANA1 に ゖ が無かった。                                            */
const PROBE = "\u304d";          // き。長音規則のどれにも当たらない母音
const KNOWN_UNHANDLED = ["\u30f7", "\u30f8", "\u30f9", "\u30fa"];   // ヷヸヹヺ

check("受け付けたかなが、変換で消えない", () => {
  // 「音節が増えるか」では測れない。小書きの ゃゅょ は前の音節に溶けて
  // き→캬 になるし、ん・っ は終声として吸われる。どれも消えてはいない。
  //
  // 見たいのは「その字が結果に効いたか」なので、前に 1 音節置いたものと
  // 置かないものを比べる。長音記号 ー だけは、効かないのが仕様。
  const base = conv(PROBE);
  const gone = [];
  for (const [lo, hi] of [[0x3041, 0x3096], [0x30a1, 0x30fa]]) {
    for (let c = lo; c <= hi; c++) {
      const ch = String.fromCharCode(c);
      if (!box.isKana(ch) || ch === "\u30fc") continue;
      if (KNOWN_UNHANDLED.includes(ch)) continue;
      if (conv(PROBE + ch) === base) gone.push(`${ch}(U+${c.toString(16).toUpperCase()})`);
    }
  }
  assert(!gone.length, `結果に出ない文字: ${gone.join(" ")}（KANA1 か KANA2 に足してください）`);
  return `${PROBE} の後ろに置いて全字が結果を変える`;
});

check("変換できない文字の一覧が、一覧のとおり", () => {
  // 減らせたら外す、増えたら気づく。ヷヸヹヺ は現代日本語では使われず
  // （ヴァ〜ヴォ を使う）、toHira() の範囲外でもあるので手当てしていない。
  const base = conv(PROBE), gone = [];
  for (let c = 0x30a1; c <= 0x30fa; c++) {
    const ch = String.fromCharCode(c);
    if (!box.isKana(ch) || ch === "\u30fc") continue;
    if (conv(PROBE + ch) === base) gone.push(ch);
  }
  const want = KNOWN_UNHANDLED.slice().sort().join("");
  assert(gone.sort().join("") === want,
    `実際に効かないのは ${gone.join("")}、一覧は ${want}`);
  return `${gone.join(" ")}（現代語では使わない字）`;
});

check("拗音などの 2 かなが 1 音節に収まる", () => {
  // ふぁ があって ゔぁ が無い、のような取りこぼしを出す。2 かなが
  // 2 音節に割れると、그 사람の名前が 1 文字長くなる。
  const bad = [];
  for (const k in box.KANA2) {
    const got = conv(k);
    if ([...got].length !== 1) bad.push(`${k} → ${got}`);
  }
  assert(!bad.length, bad.join(" / "));
  return `${Object.keys(box.KANA2).length} 組すべて 1 音節`;
});

check("出力がハングル音節だけでできている", () => {
  const bad = [];
  for (const k in box.KANA1) {
    const got = conv(k);
    if (!/^[\uac00-\ud7a3]+$/.test(got)) bad.push(`${k} → ${got}`);
  }
  for (const k in box.KANA2) {
    const got = conv(k);
    if (!/^[\uac00-\ud7a3]+$/.test(got)) bad.push(`${k} → ${got}`);
  }
  assert(!bad.length, bad.join(" / "));
  return `KANA1 ${Object.keys(box.KANA1).length} + KANA2 ${Object.keys(box.KANA2).length} 字`;
});

check("終声は前の音節に付き、音節を増やさない", () => {
  // ん・っ を抜いたものと音節数が同じなら、終声として吸われている。
  // 数を直接書くと、書いたこちらが間違える（実際 1 度間違えた）。
  const bad = [];
  for (const w of ["さん", "さっ", "しんばし", "はっとり", "けんいち", "はっぴょうかい"]) {
    const bare = w.replace(/[んっ]/g, "");
    const a = [...conv(w)].length, b = [...conv(bare)].length;
    if (a !== b) bad.push(`${w} → ${conv(w)}（${a} 音節）／ ${bare} → ${conv(bare)}（${b} 音節）`);
  }
  assert(!bad.length, bad.join(" / "));
  return "ん・っ を足しても音節数が変わらない";
});

/* ---- 2. 手書きの漢字音 -----------------------------------
   このサイトの中心は「漢字を韓国語でどう読むか」で、その表は
   index.html にインラインで手書きしてある（222 字）。読みが違えば
   飾りではなく教材の誤りになるのに、ここだけ何とも突き合わせて
   いなかった ── kanji.json（2,136 字）を持っているのに。

   手書きが DB より優先されるのは意図した設計で、名前の文脈に合う
   読みを選んであるから（楽＝락 であって 악 ではない）。だから
   「食い違ってはいけない」ではなく「食い違いは申告済みのものだけ」
   を確かめる。                                                       */

head("[手書きの漢字音]  index.html の 222 字。教材の中身そのもの");


/* DB とわざと変えてある字。名前の文脈で選んだ読みなので、DB の
   代表音とは違っていてよい。増やすときはここに理由ごと足す。 */
const OVERRIDE = {
  "楽": { app: "락", db: "악", why: "名前では「たのしい」の락。악は音楽の악" },
  "奈": { app: "나", db: "내", why: "奈良・加奈など名前は나で読ませる" }
};

/* 常用漢字表の外にあり、DB にも旧字体表にも無い字。名前によく出るので
   手書きで持っているが、突き合わせる相手がいない ── そのことを
   隠さずに一覧にしておく。減らすには .db へ人名用漢字を足すことになる。 */
const UNVERIFIED = ["伊", "﨑", "阿", "嶋", "菅", "柴", "翔", "智", "楓"];

function curated() {
  const from = IDX.indexOf("const HANJA = {");
  assert(from >= 0, "index.html に HANJA 表が見つかりません");
  const to = IDX.indexOf("4. 五行", from);
  assert(to > from, "HANJA 表の終わりが見つかりません");
  const out = {};
  for (const m of IDX.slice(from, to).matchAll(/^'(.)':\{k:'([^']+)'/gm))
    out[m[1]] = m[2];
  return out;
}

check("手書きの表を読み出せる", () => {
  const c = curated();
  const n = Object.keys(c).length;
  assert(n > 200, `${n} 字しか読み出せません（表の書き方が変わった可能性）`);
  return `${n} 字`;
});

check("DB にある字は、申告した 2 字を除いて読みが一致する", () => {
  const c = curated(), bad = [];
  let same = 0;
  for (const ch in c) {
    const e = KANJI.k[ch];
    if (!e) continue;
    if (e[0] === c[ch]) { same++; continue; }
    const o = OVERRIDE[ch];
    if (!o) { bad.push(`${ch}: 手書き='${c[ch]}' DB='${e[0]}'（申告がありません）`); continue; }
    if (o.app !== c[ch] || o.db !== e[0])
      bad.push(`${ch}: 申告は ${o.app}/${o.db} ですが実際は ${c[ch]}/${e[0]}`);
  }
  assert(!bad.length, bad.join(" / "));
  return `${same} 字一致 + 申告済み ${Object.keys(OVERRIDE).length} 字`;
});

check("申告した違いが、いま本当に存在する", () => {
  // 直したのに申告だけ残る、を防ぐ。残っていると「意図した違い」の
  // 一覧が信用できなくなる。
  const c = curated();
  for (const ch in OVERRIDE) {
    assert(ch in c, `${ch} が手書きの表にありません`);
    assert(KANJI.k[ch], `${ch} が kanji.json にありません`);
    assert(c[ch] === OVERRIDE[ch].app && KANJI.k[ch][0] === OVERRIDE[ch].db,
      `${ch} の食い違いが解消しています。OVERRIDE から外してください`);
  }
  return Object.entries(OVERRIDE).map(([c2, o]) => `${c2} ${o.app}≠${o.db}`).join(" / ");
});

check("旧字体は、対応する新字体と同じ読みになっている", () => {
  // 邊→辺、學→学 のように新字体が DB にある字は、そちら経由で確かめられる。
  const c = curated(), bad = [];
  let n = 0;
  for (const ch in c) {
    if (KANJI.k[ch]) continue;
    const now = KANJI.kyu[ch];
    if (!now || !KANJI.k[now]) continue;
    n++;
    if (KANJI.k[now][0] !== c[ch])
      bad.push(`${ch}(→${now}): 手書き='${c[ch]}' DB='${KANJI.k[now][0]}'`);
  }
  assert(!bad.length, bad.join(" / "));
  assert(n >= 10, `旧字体を ${n} 字しか確かめていません`);
  return `${n} 字一致`;
});

check("突き合わせる相手がいない字は、一覧のとおり", () => {
  // 増えたときに気づけるようにする。読みそのものは確かめようがないので、
  // 「確かめられていない字がこれだけある」ことを見えるようにしておく。
  const c = curated();
  const orphan = Object.keys(c)
    .filter(ch => !KANJI.k[ch] && !(KANJI.kyu[ch] && KANJI.k[KANJI.kyu[ch]]))
    .sort();
  const listed = UNVERIFIED.slice().sort();
  const added = orphan.filter(ch => !listed.includes(ch));
  const gone  = listed.filter(ch => !orphan.includes(ch));
  assert(!added.length,
    `突き合わせられない字が増えました: ${added.join(" ")}（UNVERIFIED に理由ごと足すか、.db に入れてください）`);
  assert(!gone.length, `${gone.join(" ")} は確かめられるようになりました。UNVERIFIED から外してください`);
  return `${orphan.length} 字（人名用漢字。.db に入れれば減ります）`;
});

console.log(`\n${failed ? "\u2717" : "\u2713"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : "") + `　（漢字の基準: kanji.json ${KANJI.n} 字）`);
process.exit(failed ? 1 : 0);
