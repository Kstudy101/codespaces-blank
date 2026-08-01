#!/usr/bin/env node
/* ==================================================================
   verify-name.mjs — index.html にインラインで書かれた学習データ

     使い方:  node tools/verify-name.mjs

   STEP 1〜6 が出しているものは、ほぼ全部 index.html の中の表。

     かな → ハングル   KANA1 / KANA2 + kanaToHangul()
     漢字 → 韓国漢字音 HANJA（手書き 222 字）
     漢数詞           sino()（1995 → 천구백구십오）
     十二支・五行     ZODIAC / OHAENG（saju.js 側にも同じものがある）

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

/** index.html から見出しの間を切り出す。見出しが変われば落ちる ── そのとき
    黙って検査を素通りするより、切り出せないと言って止まるほうがよい。 */
function slice(startMark, endMark) {
  const a = IDX.indexOf(startMark), b = IDX.indexOf(endMark, a + 1);
  if (a < 0 || b <= a) {
    console.error(`\u2717 index.html から切り出せません: ${startMark}`);
    process.exit(1);
  }
  let out = IDX.slice(a, b);
  // 見出しはコメントの中にあるので、切ると開いたままの /* が末尾に残る。
  // 閉じられていない分は落とす。
  while ((out.match(/\/\*/g) || []).length > (out.match(/\*\//g) || []).length)
    out = out.slice(0, out.lastIndexOf("/*"));
  return out;
}
// const 宣言は文脈オブジェクトの属性にならない（function は なる）ので、
// 表を見たい分だけ明示的に出す。
vm.runInContext(IDX.slice(from, to) + "\n;globalThis.KANA1=KANA1;globalThis.KANA2=KANA2;",
                box, { filename: "index.html<kana>" });
const conv = (s) => box.kanaToHangul(s).join("");

/* 十二支・五行と、パッチム判定・漢数詞。どれも同じ script の中の別の場所に
   あるので、同じ文脈に足して読ませる（decomp() を共有するため）。 */
vm.runInContext(slice("const OHAENG = {", "   4b."), box, { filename: "index.html<ohaeng>" });
vm.runInContext(slice("function hasJong(word){", "   6. 描画"), box, { filename: "index.html<josa>" });
vm.runInContext(slice("  const NUM = ['','일'", "  $('d-birth')") +
                "\n;globalThis.OHAENG=OHAENG;globalThis.ZODIAC=ZODIAC;globalThis.sino=sino;globalThis.MONTH=MONTH;",
                box, { filename: "index.html<num>" });

/* study.js は同じパッチム判定をもう 1 つ持っている（words.html から
   index.html のインライン関数を呼べないため）。二重に持つと必ず片方だけ
   直るので、突き合わせる相手として読み込む。 */
const S = {};
vm.createContext(S);
vm.runInContext(fs.readFileSync("study.js", "utf8"), S, { filename: "study.js" });

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

/* ---- 2. 数と暦のことば ---------------------------------------------- */

head("[漢数詞]  生年月日を韓国語で言う。1995 \u2192 천구백구십오");

check("README に書いた読みになる", () => {
  const cases = [
    [1995, "천구백구십오"], [2026, "이천이십육"], [1900, "천구백"],
    [2000, "이천"], [1000, "천"], [100, "백"], [10, "십"], [11, "십일"],
    [1, "일"], [0, "영"], [30, "삼십"], [9999, "구천구백구십구"]
  ];
  const bad = [];
  for (const [n, want] of cases) {
    const got = box.sino(n);
    if (got !== want) bad.push(`${n} \u2192 ${got}（${want} のはず）`);
  }
  assert(!bad.length, bad.join(" / "));
  // 1 の位取りは読まない（일천ではなく천）。ここを間違えると全部の年がずれる
  assert(box.sino(1000)[0] !== "\uc77c", "1000 が 일천 になっています");
  return `${cases.length} 件`;
});

check("月名の不規則は 6 月と 10 月だけ", () => {
  // 육월・십월 と読むのは誤り。画面でもそう説明しているので、
  // 表と説明が離れると自分で書いた注意書きが嘘になる。
  const bad = [];
  for (let m = 1; m <= 12; m++) {
    const want = m === 6 ? "\uc720" : m === 10 ? "\uc2dc" : box.sino(m);
    if (box.MONTH[m] !== want) bad.push(`${m} 月が ${box.MONTH[m]}（${want} のはず）`);
  }
  assert(!bad.length, bad.join(" / "));
  assert(box.MONTH[6] !== box.sino(6) && box.MONTH[10] !== box.sino(10),
    "6 月・10 月が規則形と同じになっています");
  return "6=유 / 10=시 / 他は漢数詞どおり";
});

head("[十二支・五行]  saju.js 側にも同じものがある");

check("十二支の並びが saju.js と一致する", () => {
  // ここがずれると、同じ人にトップとおみくじで違う띠が出る。
  const idx = box.ZODIAC.map(z => z.ko);
  assert(Array.isArray(idx) && idx.length === 12, `index.html 側が ${idx.length} 件`);
  // saju.js は ZODIAC を公開していない（pillars() の結果に載せるだけ）ので、
  // ソースの表そのものを読む。公開させるために saju.js を変えるより、
  // 見る側で完結させるほうが波及が無い。
  const m = /var ZODIAC = \[([^\]]+)\]/.exec(fs.readFileSync("saju.js", "utf8"));
  assert(m, "saju.js に ZODIAC が見つかりません");
  const list = m[1].split(",").map(t => t.trim().replace(/^"|"$/g, ""));
  assert(idx.join(",") === list.join(","), `index=${idx.join("")} / saju=${list.join("")}`);
  return `12 支一致（${idx.slice(0, 3).join(" ")}…）`;
});

check("五行の韓国語表記が他のファイルと同じ 5 つ", () => {
  // saju.js / fortune.js / gilbang.js / amulet.js は 목화토금수 で通している。
  // index.html だけ別の綴りになると、同じ五行が別物として並ぶ。
  const ko = Object.values(box.OHAENG).map(o => o.ko).sort().join("");
  assert(ko === "\uae08\ubaa9\uc218\ud1a0\ud654", `index.html の五行が ${ko}`);
  return Object.values(box.OHAENG).map(o => o.ko).join(" ");
});

check("初声 19 個すべてに五行が割り当たっている", () => {
  const cho = ["\u3131","\u3132","\u3134","\u3137","\u3138","\u3139","\u3141","\u3142","\u3143","\u3145",
               "\u3146","\u3147","\u3148","\u3149","\u314a","\u314b","\u314c","\u314d","\u314e"];
  const seen = {};
  for (const c of cho) {
    const e = box.choToOhaeng(c);
    assert(box.OHAENG[e], `${c} が ${e}（OHAENG に無い）`);
    seen[e] = (seen[e] || 0) + 1;
  }
  assert(Object.keys(seen).length === 5, `${Object.keys(seen).length} 種類しか出ません`);
  return Object.entries(seen).map(([e, n]) => `${e}${n}`).join(" ");
});

head("[パッチム]  同じ判定が index.html と study.js の 2 か所にある");

check("2 つの実装がハングルで同じ答えを出す", () => {
  // words.html から index.html のインライン関数を呼べないので二重に持って
  // いる。二重に持つと必ず片方だけ直るので、機械に見張らせる。
  const bad = [];
  let n = 0;
  for (let c = 0xac00; c <= 0xd7a3; c += 7) {      // 全 11,172 音節を 7 つおきに
    const ch = String.fromCharCode(c);
    if (box.hasJong(ch) !== S.Study.hasJong(ch)) bad.push(ch);
    n++;
  }
  assert(!bad.length, `${bad.length} 字で食い違い: ${bad.slice(0, 5).join(" ")}`);
  return `${n} 音節で一致`;
});

check("助詞の選び方が 2 つの実装で一致する", () => {
  const bad = [];
  for (const w of ["\ubc15", "\ud558\ub098", "\uac74", "\uc544\uc774", "\uc57c", "\uc11c\uc6b8", "\ub3c4\ucfc4"]) {
    const a = box.ega(w), b = S.Study.josa(w, "\uc774", "\uac00");
    if (a !== b) bad.push(`${w}: index=${a} study=${b}`);
    const c = box.ieyo(w);
    const want = S.Study.hasJong(w) ? "\uc774\uc5d0\uc694" : "\uc608\uc694";
    if (c !== want) bad.push(`${w}: ieyo=${c}（${want} のはず）`);
  }
  assert(!bad.length, bad.join(" / "));
  return "이/가・이에요/예요 とも一致";
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
