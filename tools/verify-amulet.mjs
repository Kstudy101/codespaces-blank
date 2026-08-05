#!/usr/bin/env node
/* ==================================================================
   verify-amulet.mjs — 부적に書かれるもの

     使い方:  node tools/verify-amulet.mjs

   부적は占いと違って「正解の数値」が無い。恵方の対応表と同じで、
   確かめられるのは「書いてあることが正しいか」だけになる。ただし
   このページに限っては、確かめられる相手が 1 つある ── kanji.json。

   このサイトは漢字の韓国音を教えるサイトなので、부적の中央に置いた字の
   読みが間違っていれば、それは飾りの間違いではなく教材の間違いになる。
   2,136 字ぶんの한국 한자음と훈음を既に持っているので、そこへ 1 字ずつ
   突き合わせる。

   もう 1 つは他のファイルとの食い違い。五行と項目の対応は fortune.js が、
   五行と方位の対応は gilbang.js が既に決めている。ここで別に決めると
   「金運の부적が水の五行」になるので、両方と突き合わせる。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

vm.runInThisContext(fs.readFileSync("saju.js", "utf8"),     { filename: "saju.js" });
vm.runInThisContext(fs.readFileSync("gilbang.js", "utf8"),  { filename: "gilbang.js" });
vm.runInThisContext(fs.readFileSync("fortune.js", "utf8"),  { filename: "fortune.js" });
vm.runInThisContext(fs.readFileSync("study.js", "utf8"),    { filename: "study.js" });
vm.runInThisContext(fs.readFileSync("amulet.js", "utf8"),   { filename: "amulet.js" });
Saju.load(JSON.parse(fs.readFileSync("solar-terms.json", "utf8")));

const KANJI = JSON.parse(fs.readFileSync("kanji.json", "utf8"));
const SRC   = fs.readFileSync("amulet.js", "utf8");
const HTML  = fs.readFileSync("amulet.html", "utf8");

let failed = 0, passed = 0;
/* 同期 check に async の検査を渡すと、失敗しても緑になる ── 実際に
   verify-onboarding で 1 件起きた（2026-08-06 指示書 §1）。Promise が
   返ってきた時点で検査そのものを失敗させる。async は acheck へ。 */
const guardSync = (d, label) => {
  if (d && typeof d.then === "function") {
    throw new Error("async の検査を同期 check に渡しています（acheck を使うこと）");
  }
};
const check = (label, fn) => {
  try { const d = fn(); guardSync(d, label); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);

/* ---- 1. 漢字と韓国漢字音 --------------------------------------------- */

head("[漢字]  kanji.json（2,136 字）と突き合わせる。ここが違えば教材の誤り");

check("中央の 1 字の한국 한자음が kanji.json と一致する", () => {
  const bad = [];
  for (const k of Amulet.KINDS) {
    const e = KANJI.k[k.hanja];
    if (!e) { bad.push(`${k.hanja} が kanji.json にありません`); continue; }
    if (e[0] !== k.eum) bad.push(`${k.hanja} = ${k.eum}（DB は ${e[0]}）`);
  }
  assert(!bad.length, bad.join(" / "));
  return Amulet.KINDS.map(k => `${k.hanja}=${k.eum}`).join(" ");
});

check("훈음も一致する（DB が複数持つ字は、そのどれか）", () => {
  const bad = [];
  for (const k of Amulet.KINDS) {
    // 「편안 강/들 강」のように複数ある字があるので、区切って照合する。
    const list = (KANJI.k[k.hanja][1] || "").split("/").map(s => s.trim()).filter(Boolean);
    if (!list.includes(k.hun)) bad.push(`${k.hanja}「${k.hun}」（DB は「${list.join("／")}」）`);
  }
  assert(!bad.length, bad.join(" / "));
  return Amulet.KINDS.map(k => `${k.hanja}「${k.hun}」`).join(" ");
});

check("書き出しの勅令、五行の字、五方色の字も一致する", () => {
  const want = [];
  // 勅令は 2 字なので 1 字ずつに割って照合する（칙 + 령 = 칙령）。
  const h = Amulet.HEADER;
  h.hanja.split("").forEach((c, i) => want.push([c, h.eum[i]]));
  for (const el in Amulet.ELEMENT_HANJA) want.push([Amulet.ELEMENT_HANJA[el], el]);
  for (const el in Amulet.COLORS) want.push([Amulet.COLORS[el].hanja, Amulet.COLORS[el].eum]);

  const bad = [];
  for (const [c, eum] of want) {
    const e = KANJI.k[c];
    if (!e) { bad.push(`${c} が kanji.json にありません`); continue; }
    if (e[0] !== eum) bad.push(`${c} = ${eum}（DB は ${e[0]}）`);
  }
  assert(!bad.length, bad.join(" / "));
  return `${want.length} 字（勅令 2 / 五行 5 / 五方色 5）`;
});

check("中央の 1 字は정자と新字体で形が割れない", () => {
  // kanji.json の구자체 표は「その字に別の旧字体が立っているか」を持つ。
  // 学（學 U+5B78）のように別の統合漢字が立っている字を中央に置くと、
  // 韓国で書かれる形と画面の形が別の字になる。
  //
  // ただし互換漢字（U+F900〜U+FAFF）は字形の分かれではなく符号化の都合
  // なので、そちらは通す。福（U+FA1B）がこれにあたる。
  const bad = [], compat = [];
  for (const [old, now] of Object.entries(KANJI.kyu)) {
    if (!Amulet.KINDS.some(k => k.hanja === now)) continue;
    const cp = old.codePointAt(0);
    if (cp >= 0xf900 && cp <= 0xfaff) compat.push(`${now}←${old}(U+${cp.toString(16).toUpperCase()})`);
    else bad.push(`${now} には旧字体 ${old}（U+${cp.toString(16).toUpperCase()}）があります`);
  }
  assert(!bad.length, bad.join(" / "));
  // 反対側も確かめる。この規則が本当に効いているか（何も弾かない規則に
  // なっていないか）を、実際に弾かれるはずの字で見る。
  assert(KANJI.kyu["學"] === "学" && KANJI.kyu["緣"] === "縁",
    "學→学 / 緣→縁 が kanji.json にありません。規則が空回りしています");
  return `別字体なし${compat.length ? "（互換漢字のみ: " + compat.join(" ") + "）" : ""}`;
});

check("勅の古い形 敕 が kanji.json の구자체 표にある", () => {
  // 敕令と書かれた부적もある。amulet.js がその旨を持っているので、
  // 対応が DB にあることを確かめる。
  assert(KANJI.kyu["敕"] === "勅", `敕 → ${KANJI.kyu["敕"] || "なし"}`);
  assert(Amulet.HEADER.old === "敕令", `HEADER.old が ${Amulet.HEADER.old}`);
  return "敕 → 勅";
});

/* ---- 2. 他のファイルとの対応 ----------------------------------------- */

head("[対応]  五行と項目・方位は他のファイルが決めている。そちらと合うか");

check("6 種が fortune.js の CATS と 1 対 1 で対応する", () => {
  assert(Amulet.KINDS.length === Fortune.CATS.length,
    `부적 ${Amulet.KINDS.length} 種 / 項目 ${Fortune.CATS.length} 個`);
  const bad = [];
  Fortune.CATS.forEach((c, i) => {
    const k = Amulet.KINDS[i];
    if (k.cat !== c.id) bad.push(`${i} 番目が ${k.cat}（${c.id} のはず）`);
    if (k.el !== c.el)  bad.push(`${c.id} の五行が ${k.el}（${c.el} のはず）`);
    if (k.ja !== c.ja && c.id !== "total") bad.push(`${c.id} の名前が ${k.ja}（${c.ja}）`);
    if (k.ko !== c.ko && c.id !== "total") bad.push(`${c.id} の韓国語名が ${k.ko}（${c.ko}）`);
  });
  assert(!bad.length, bad.join(" / "));
  return Amulet.KINDS.map(k => `${k.cat}=${k.el || "—"}`).join(" ");
});

check("方位は gilbang.js の対応表から取っている", () => {
  const bad = [];
  for (const k of Amulet.KINDS) {
    const r = Amulet.of({ cat: k.cat });
    if (!k.el) { if (r.dir !== null) bad.push(`総合運に方位 ${r.dir.ja} が付いています`); continue; }
    const want = Gilbang.ofElement(k.el).dir;
    if (r.dir !== want) bad.push(`${k.cat} が ${r.dir && r.dir.ja}（${want.ja} のはず）`);
  }
  assert(!bad.length, bad.join(" / "));
  return Amulet.KINDS.filter(k => k.el)
    .map(k => `${k.el}=${Gilbang.ofElement(k.el).dir.ja}`).join(" ");
});

check("五方色が 5 つそろい、色が重複しない", () => {
  const els = Object.keys(Amulet.COLORS);
  assert(els.length === 5, `${els.length} 色`);
  const fills = new Set(els.map(e => Amulet.COLORS[e].fill));
  assert(fills.size === 5, "同じ色が 2 つ以上あります");
  for (const e of els) {
    assert(Gilbang.BY_ELEMENT[e], `${e} が gilbang.js に無い五行です`);
    assert(Amulet.ELEMENT_HANJA[e], `${e} に漢字がありません`);
  }
  return els.map(e => `${e}=${Amulet.COLORS[e].ja}`).join(" ");
});

/* ---- 3. 願いの文 ----------------------------------------------------- */

head("[願いの文]  「-소서」の祈願文。助詞はパッチムで形が変わる");

check("6 つとも -소서 で終わり、ハングルだけでできている", () => {
  for (const k of Amulet.KINDS) {
    const w = k.wish.k;
    assert(/소서$/.test(w), `「${w}」が -소서 で終わっていません`);
    assert(/^[가-힣 ]+$/.test(w), `「${w}」にハングル以外が混じっています`);
    assert(w.length <= 16, `「${w}」は ${w.length} 字。부적に収まりません`);
  }
  return Amulet.KINDS.map(k => k.wish.k).join(" / ");
});

check("助詞がパッチムと合っている（study.js の判定で照合）", () => {
  // 「재물이」なら재물＋이。study.js の josa() は同じ語から이/가を選ぶので、
  // 選び直した結果が文の中の形と一致しなければならない。ここを間違えると
  // 学習コンテンツとして誤りを教えることになる。
  const PAIRS = { "을":["을","를"], "를":["을","를"], "이":["이","가"], "가":["이","가"],
                  "은":["은","는"], "는":["은","는"], "과":["과","와"], "와":["과","와"] };
  let n = 0;
  for (const k of Amulet.KINDS) {
    for (const [word] of k.wish.p) {
      if (word[0] !== "-") continue;
      const j = word.slice(1);
      if (!PAIRS[j]) continue;                       // -소서 のような語尾は対象外
      const tok = k.wish.k.split(" ").find(t => t.endsWith(j));
      assert(tok, `「${k.wish.k}」に ${j} で終わる語がありません`);
      const stem = tok.slice(0, -1);
      const want = Study.josa(stem, PAIRS[j][0], PAIRS[j][1]);
      assert(want === j, `${stem}${j} は ${stem}${want} のはずです`);
      n++;
    }
  }
  assert(n >= 6, `助詞を ${n} 件しか確かめていません`);
  return `${n} 件一致`;
});

check("語の分解が文と対応している", () => {
  for (const k of Amulet.KINDS) {
    const p = k.wish.p;
    assert(p.length >= 2, `${k.cat} の分解が ${p.length} 件`);
    for (const [w, m] of p) {
      assert(w && m, `${k.cat} に空の項目があります`);
    }
    // 助詞と語尾以外は、括弧を落とした形が文の中に現れること
    for (const [w] of p) {
      if (w[0] === "-") continue;
      const bare = w.replace(/\(.*?\)/g, "");
      if (/다$/.test(bare)) continue;                // 用言は原形で書く
      assert(k.wish.k.includes(bare), `「${k.wish.k}」に「${bare}」がありません`);
    }
    assert(/소서/.test(k.wish.g) || /-어지다|-히|연体形/.test(k.wish.g) || k.wish.g.length > 20,
      `${k.cat} の文法説明が短すぎます`);
  }
  return `6 種 × ${Amulet.KINDS.reduce((a, k) => a + k.wish.p.length, 0)} 語`;
});

check("ローマ字が改訂式の書き方になっている", () => {
  for (const k of Amulet.KINDS) {
    const r = k.wish.r;
    assert(/^[a-z][a-z \-]*$/.test(r), `「${r}」に使えない文字があります`);
    assert(r.split(" ").length === k.wish.k.split(" ").length,
      `「${r}」の語数が「${k.wish.k}」と違います`);
    assert(/soseo$/.test(r), `「${r}」が soseo で終わっていません`);
  }
  return Amulet.KINDS.map(k => k.wish.r.split(" ").pop()).join(" ");
});

/* ---- 4. 選び方 ------------------------------------------------------- */

head("[選び方]  命式からのおすすめと、願いの優先");

check("生年月日が無くても 1 枚できる", () => {
  const r = Amulet.of({ cat: "money" });
  assert(r.kind.cat === "money", `${r.kind.cat} が返りました`);
  assert(r.lack === null && r.suggested === null, "四柱なしで命式の情報が付いています");
  assert(r.chosen === "wish", `chosen が ${r.chosen}`);
  const d = Amulet.of({});
  assert(d.kind.cat === "total" && d.chosen === "default", `既定が ${d.kind.cat}/${d.chosen}`);
  return "願いのみ / 既定は厄除け";
});

check("命式のおすすめは gilbang.js の不足判定と一致する", () => {
  let n = 0;
  for (let y = 1950; y <= 2010; y += 3) {
    const me = Saju.pillars({ y, m: 4, d: 12, hour: 9, city: "seoul" });
    const r = Amulet.of({ cat: null, saju: me });
    const want = Gilbang.mine(me).element;
    assert(r.kind.el === want, `${y} 年生まれが ${r.kind.el}（${want} のはず）`);
    assert(r.chosen === "saju", `chosen が ${r.chosen}`);
    n++;
  }
  return `${n} 件一致`;
});

check("願いを選んだら命式で上書きされない", () => {
  const me = Saju.pillars({ y: 1990, m: 5, d: 17, hour: 14, city: "seoul" });
  const want = Gilbang.mine(me).element;
  const other = Amulet.KINDS.find(k => k.el && k.el !== want);
  const r = Amulet.of({ cat: other.cat, saju: me });
  assert(r.kind.cat === other.cat, `${r.kind.cat} に変えられました`);
  assert(r.recommended === false, "おすすめ扱いになっています");
  assert(r.suggested.el === want, `おすすめが ${r.suggested.el}`);
  const same = Amulet.of({ cat: Amulet.byElement(want).cat, saju: me });
  assert(same.recommended === true, "一致しているのに recommended が false です");
  return `不足 ${want} でも ${other.cat} を選べる`;
});

check("おすすめが 5 種に散る", () => {
  // 5 等分を基準に不足を測ると誰でも土が過多になり、健康運の부적だけが
  // 出なくなる。gilbang.js 側で直した比率がここでも効いているかを出方で見る。
  const seen = {};
  let seed = 7;
  for (let y = 1950; y <= 2010; y++) {
    for (let k = 0; k < 3; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const me = Saju.pillars({ y, m: 1 + (seed >> 7) % 12, d: 1 + (seed >> 11) % 28,
                                hour: (seed >> 16) % 24, city: "seoul" });
      const c = Amulet.of({ cat: null, saju: me }).kind.cat;
      seen[c] = (seen[c] || 0) + 1;
    }
  }
  const n = Object.values(seen).reduce((a, b) => a + b, 0);
  assert(Object.keys(seen).length === 5, `${Object.keys(seen).length} 種しか出ません`);
  for (const c in seen) assert(seen[c] / n > 0.05, `${c} が ${(seen[c] / n * 100).toFixed(1)}%`);
  return Object.entries(seen).map(([c, v]) => `${c} ${(v / n * 100).toFixed(0)}%`).join(" ");
});

check("知らない願いは弾く", () => {
  for (const bad of ["kinun", "", "TOTAL", "健康運"]) {
    let threw = null;
    try { Amulet.of({ cat: bad }); } catch (e) { threw = e; }
    // "" と null は「指定なし」なので既定に落ちる。それ以外は例外。
    if (bad === "") { assert(!threw, "空文字が例外になりました"); continue; }
    assert(threw, `「${bad}」が素通りしました`);
  }
  return "kinun / TOTAL / 健康運 を拒否";
});

/* ---- 5. 変わらないこと ----------------------------------------------- */

head("[不変]  부적は 1 年持つもの。日付でも回数でも変わらない");

check("何度呼んでも同じ 1 枚になる", () => {
  const me = Saju.pillars({ y: 1988, m: 11, d: 3, hour: 20, city: "tokyo" });
  const key = (r) => [r.kind.cat, r.kind.hanja, r.kind.wish.k,
                      r.color && r.color.fill, r.dir && r.dir.ja, r.recommended].join("|");
  for (const cat of [null, "total", "money", "study"]) {
    const first = key(Amulet.of({ cat, saju: me }));
    for (let i = 0; i < 50; i++)
      assert(key(Amulet.of({ cat, saju: me })) === first, `${cat} が呼ぶたびに変わります`);
  }
  return "4 通り × 50 回";
});

check("日付にも乱数にも触れていない", () => {
  // 「今日の부적」にすると毎日作り直すものになり、1 年持つという
  // 性格が変わる。ソースに日付と乱数が出てこないことで担保する。
  const body = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["Date", "Math.random", "now()"])
    assert(!body.includes(bad), `amulet.js に ${bad} があります`);
  return "Date / Math.random なし";
});

check("何も保存しない", () => {
  // 保存しないので privacy.html の保存 4 種に足すものが無い。
  // 足す必要が生まれたら、ここが先に落ちる。
  const body = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"])
    assert(!body.includes(bad), `amulet.js に ${bad} があります`);
  assert(!/localStorage|sessionStorage|document\.cookie/.test(
    HTML.slice(HTML.indexOf("<script>", HTML.indexOf("/amulet.js")))),
    "amulet.html のスクリプトに保存があります");
  return "localStorage / cookie に触れない";
});

/* ---- 6. ページ ------------------------------------------------------- */

head("[ページ]  クロール対策の静的解説と、配信の取りこぼし");

check("JS を実行しなくても読める本文がある", () => {
  // このサイトは AdSense の審査で「空のページ」に見える問題を一度出して
  // いる。中身が JS で作られるページは、入力前に読める解説が要る。
  const body = HTML
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
  assert(body.length > 1200, `本文が ${body.length} 字しかありません`);
  return `${body.length} 字`;
});

check("表に書いた対応が amulet.js と一致する", () => {
  // 解説の表は手書きなので、コードを直したときに置いていかれる。
  for (const k of Amulet.KINDS) {
    assert(HTML.includes(`<td>${k.hanja}</td>`), `表に ${k.hanja} の行がありません`);
    assert(HTML.includes(`>${k.eum}</span>（${k.hun}）`),
      `表の ${k.hanja} の読みが「${k.eum}（${k.hun}）」になっていません`);
  }
  return `6 行とも一致`;
});

check("canonical・OG・広告の 3 種がそろっている", () => {
  for (const [name, re] of [
    ["canonical",  /<link rel="canonical" href="https:\/\/[^"]+\/amulet">/],
    ["og:url",     /<meta property="og:url" content="https:\/\/[^"]+\/amulet">/],
    ["AdSense",    /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/],
    ["GA4",        /www\.googletagmanager\.com\/gtag\/js/],
    ["Clarity",    /clarity\.ms\/tag\//]
  ]) assert(re.test(HTML), `${name} がありません`);
  return "canonical / og:url / AdSense / GA4 / Clarity";
});

check("配信と URL 置換の一覧に入っている", () => {
  // ここを忘れると、ページは動くのにデプロイされない（PUBLIC）か、
  // ドメイン移転でこのページだけ古いホストを指す（TARGETS）。
  const sh = fs.readFileSync("tools/build-site.sh", "utf8");
  const py = fs.readFileSync("tools/set-site-url.py", "utf8");
  const sm = fs.readFileSync("sitemap.xml", "utf8");
  const yml = fs.readFileSync(".github/workflows/deploy.yml", "utf8");
  assert(/^\s+amulet\.html$/m.test(sh), "build-site.sh の PUBLIC に amulet.html がありません");
  assert(/^\s+amulet\.js$/m.test(sh),   "build-site.sh の PUBLIC に amulet.js がありません");
  assert(sh.includes('"$OUT"/amulet.html'),
    "build-site.sh の canonical 検査に amulet.html がありません");
  assert(py.includes('"amulet.html"'),  "set-site-url.py の TARGETS に amulet.html がありません");
  assert(sm.includes("/amulet<"),       "sitemap.xml に /amulet がありません");
  assert(yml.includes("verify-amulet.mjs"), "deploy.yml に検証の呼び出しがありません");
  assert(/\/amulet\b/.test(yml),        "deploy.yml のスモークテストに /amulet がありません");
  return "PUBLIC / TARGETS / sitemap / workflow";
});

check("トップから부적への導線がある", () => {
  const idx = fs.readFileSync("index.html", "utf8");
  assert(idx.includes('href="/amulet"'), "index.html に /amulet へのリンクがありません");
  return "index.html → /amulet";
});

/* ---- 7. 札の組み方 --------------------------------------------------- */

head("[札]  枠からはみ出していないか。画像なので目視でしか気づけない部分");

/* amulet.html の中の draw() を、記録するだけの canvas で実際に走らせる。
   このプロジェクトに jsdom は無い（package.json 自体が無い）ので、
   必要な分だけの stub を置く。

   文字幅は概算（CJK・ハングル 1em / ラテン 0.55em）。本物の字幅は
   端末のフォントで変わるので、ここで確かめているのは「実測値に対して
   fit() が枠内に収める組み方になっているか」であって、特定の端末での
   ピクセル位置ではない。字が長くなったときに縮める処理を外すと、
   この検査が落ちる。                                                   */
function makeCanvasProbe() {
  const texts = [];
  const px = (f) => { const m = /(\d+)px/.exec(f); return m ? +m[1] : 16; };
  const charW = (ch, p) => {
    if (ch === " ") return p * 0.33;
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) ||
                 (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
                 (c >= 0xff00 && c <= 0xff60);
    return wide ? p : p * 0.55;
  };
  const width = (t, p) => [...String(t)].reduce((a, ch) => a + charW(ch, p), 0);

  const ctx = {
    font: "400 16px sans", textAlign: "start", textBaseline: "alphabetic",
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    measureText(t) { return { width: width(t, px(this.font)) }; },
    fillText(t, x, y) {
      const p = px(this.font), w = width(t, p);
      const x0 = this.textAlign === "center" ? x - w / 2
               : this.textAlign === "right"  ? x - w : x;
      const y0 = this.textBaseline === "top"    ? y
               : this.textBaseline === "middle" ? y - p / 2 : y - p * 0.8;
      texts.push({ t: String(t), x0, y0, x1: x0 + w, y1: y0 + p,
                   align: this.textAlign });
    },
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, save() {}, restore() {}, roundRect() {},
    quadraticCurveTo() {}
  };
  return { ctx, texts };
}

function runPage() {
  const probe = makeCanvasProbe();
  const listeners = {};
  const el = (id) => ({
    id, value: "", innerHTML: "", textContent: "", hidden: false, style: {},
    width: 760, height: 1200,
    getContext: () => probe.ctx,
    addEventListener: (ev, fn) => { (listeners[id] = listeners[id] || {})[ev] = fn; },
    classList: { add() {}, remove() {}, toggle() {} },
    scrollIntoView() {}, closest: () => null, querySelector: () => null
  });
  const cache = {};
  const sandbox = {
    console, setTimeout, clearTimeout, Math, JSON, Date, Promise, Array, Object,
    document: {
      getElementById: (id) => (cache[id] = cache[id] || el(id)),
      createElement: () => el("tmp"),
      body: { appendChild() {}, removeChild() {} }
    },
    navigator: {}, fetch: () => Promise.reject(new Error("no network")),
    URL: { createObjectURL: () => "blob:", revokeObjectURL() {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["saju.js", "gilbang.js", "study.js", "amulet.js"])
    vm.runInContext(fs.readFileSync(f, "utf8"), sandbox, { filename: f });

  // ページ末尾のインライン script を取り出す（/amulet.js の読み込みより後）。
  const after = HTML.slice(HTML.indexOf("/amulet.js"));
  const m = /<script>\n([\s\S]*?)\n<\/script>/.exec(after);
  if (!m) throw new Error("amulet.html のインライン script が見つかりません");
  vm.runInContext(m[1], sandbox, { filename: "amulet.html<script>" });

  return { probe, listeners, sandbox };
}

check("6 種とも文字が朱の内枠に収まる", () => {
  const { probe, listeners } = runPage();
  // 内枠は strokeRect(44,44,W-88,H-88)。線幅ぶん少し内側を境にする。
  const W = 760, H = 1200, PAD = 50;
  const bad = [];
  let n = 0;

  const click = (cat) => listeners["am-kinds"].click({
    target: { closest: (s) => s === ".am-kind" ? { dataset: { cat } } : null }
  });

  for (const k of Amulet.KINDS) {
    probe.texts.length = 0;
    click(k.cat);
    assert(probe.texts.length > 0, `${k.cat} で何も描かれていません`);
    for (const t of probe.texts) {
      if (t.x0 < PAD || t.x1 > W - PAD || t.y0 < PAD || t.y1 > H - PAD)
        bad.push(`${k.cat}「${t.t}」が枠外（x ${Math.round(t.x0)}〜${Math.round(t.x1)} / ` +
                 `y ${Math.round(t.y0)}〜${Math.round(t.y1)}）`);
      n++;
    }
  }
  assert(!bad.length, bad.slice(0, 3).join(" / "));
  return `6 種 / 文字 ${n} 件すべて内枠の中`;
});

check("中央に積んだ行どうしが重ならない", () => {
  const { probe, listeners } = runPage();
  const bad = [];
  for (const k of Amulet.KINDS) {
    probe.texts.length = 0;
    listeners["am-kinds"].click({
      target: { closest: (s) => s === ".am-kind" ? { dataset: { cat: k.cat } } : null }
    });
    // 中央揃えのものだけが縦に積まれている。左右揃え（印の説明と署名）は
    // 同じ高さに並べてあるので、ここでは見ない。
    const col = probe.texts.filter(t => t.align === "center")
                           .sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < col.length; i++)
      if (col[i].y0 < col[i - 1].y1)
        bad.push(`${k.cat}「${col[i - 1].t}」と「${col[i].t}」が重なります`);
  }
  assert(!bad.length, bad.slice(0, 3).join(" / "));
  return "6 種とも重なりなし";
});

check("長い願いの文でも縮めて収める", () => {
  // fit() を外すと枠を突き抜ける。実際に長い文を差し込んで確かめる。
  const { probe, listeners, sandbox } = runPage();
  const kind = sandbox.Amulet.byCat("love");
  const orig = kind.wish.k;
  kind.wish.k = "아주 아주 길고 긴 소원을 여기에 적어 보소서";
  try {
    probe.texts.length = 0;
    listeners["am-kinds"].click({
      target: { closest: (s) => s === ".am-kind" ? { dataset: { cat: "love" } } : null }
    });
    const t = probe.texts.find(x => x.t === kind.wish.k);
    assert(t, "長い文が描かれていません");
    assert(t.x0 >= 50 && t.x1 <= 710,
      `長い文が枠外（x ${Math.round(t.x0)}〜${Math.round(t.x1)}）`);
    return `${kind.wish.k.length} 字でも内枠の中`;
  } finally { kind.wish.k = orig; }
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : "")
  + `　（漢字の基準: kanji.json ${KANJI.n} 字）`);
process.exit(failed ? 1 : 0);
