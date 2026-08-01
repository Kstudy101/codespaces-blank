#!/usr/bin/env node
/* ==================================================================
   verify-gilbang.mjs — 方位と、その土台になる朔の表

     使い方:  node tools/verify-gilbang.mjs

   このページで唯一「外の正解」と突き合わせられるのが朔（新月）で、
   しかもそこが崩れると손없는 날が全部ずれる。旧暦の日は
   「その日を含む朔から数えて何日目か」なので、朔が 1 日ずれれば
   방위も 1 段ずれる。だから朔を最優先で確かめる。

   国立天文台の朔は 2009〜2027 年しか出せないが、表は 2000〜2040 年
   ぶんある。範囲の外は間隔（29〜30 日）と単調増加でしか確かめられない
   ので、その旨を分けて出す。

   恵方と五行の方位は言い伝えどおりの対応表しかないので、
   確かめられるのは「表が壊れていないか」だけになる。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const REF = "data/naoj-reference.json";
if (!fs.existsSync(REF)) {
  console.error(`✗ ${REF} がありません。先に:  python3 tools/fetch-naoj-reference.py`);
  process.exit(1);
}
const ref = JSON.parse(fs.readFileSync(REF, "utf8"));

vm.runInThisContext(fs.readFileSync("saju.js", "utf8"), { filename: "saju.js" });
vm.runInThisContext(fs.readFileSync("gilbang.js", "utf8"), { filename: "gilbang.js" });
Saju.load(JSON.parse(fs.readFileSync("solar-terms.json", "utf8")));
const moonJson = JSON.parse(fs.readFileSync("new-moons.json", "utf8"));
Gilbang.load(moonJson);

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);
const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/* ---- 1. 朔 ---------------------------------------------------------- */

head("[朔]  旧暦の月初め。ここがずれると방위が丸ごとずれる");

check("国立天文台の朔と日付が一致する（韓国標準時）", () => {
  const ours = new Set(Gilbang._moons().list.map(iso));
  let n = 0, bad = [];
  for (const [year, list] of Object.entries(ref.moons)) {
    for (const m of list) {
      // 公表値は UTC。旧暦は現地の暦日で数えるので韓国標準時に直す。
      const kst = new Date(Date.parse(m.utc + ":00Z") + 9 * 3600000)
        .toISOString().slice(0, 10);
      n++;
      if (!ours.has(kst)) bad.push(`${year} ${m.utc}Z → KST ${kst}`);
    }
  }
  assert(!bad.length, `${bad.length} 件ずれています: ${bad.slice(0, 3).join(" / ")}`);
  return `${n} 件一致（2009〜2027）`;
});

check("表の範囲外も間隔が 29〜30 日で単調", () => {
  const a = Gilbang._moons().list;
  let mn = 99, mx = 0;
  for (let i = 1; i < a.length; i++) {
    const g = a[i] - a[i - 1];
    assert(g > 0, `${iso(a[i])} が前の朔より前です`);
    if (g < mn) mn = g;
    if (g > mx) mx = g;
  }
  assert(mn >= 29 && mx <= 30, `間隔が ${mn}〜${mx} 日`);
  return `${a.length} 件 / 間隔 ${mn}〜${mx} 日 / ${iso(a[0])}〜${iso(a[a.length - 1])}`;
});

check("表が今日を含んでいる", () => {
  // 使うのは「今日」なので、表が過去のものになっていたら意味がない。
  const today = new Date().toISOString().slice(0, 10);
  const r = Gilbang.son(today);
  assert(r.lunarDay >= 1 && r.lunarDay <= 30, `旧暦 ${r.lunarDay} 日`);
  const [y0, y1] = moonJson.range;
  const y = new Date().getUTCFullYear();
  assert(y >= y0 && y <= y1 - 2,
    `表は ${y0}〜${y1}。今年は ${y} で、残り ${y1 - y} 年しかありません`);
  return `今日 ${today} = 旧暦 ${r.lunarDay} 日 / 表は ${y0}〜${y1}`;
});

/* ---- 2. 손없는 날 --------------------------------------------------- */

head("[손없는 날]  旧暦の日の一の位で손の方角が決まる");

check("旧暦の日が朔から正しく数えられる", () => {
  const a = Gilbang._moons().list;
  for (let i = 5; i < 12; i++) {
    assert(Gilbang.son(iso(a[i])).lunarDay === 1, `${iso(a[i])} が 1 日になりません`);
    assert(Gilbang.son(iso(a[i] + 1)).lunarDay === 2, `朔の翌日が 2 日になりません`);
    const last = a[i + 1] - a[i];       // 29 or 30
    assert(Gilbang.son(iso(a[i + 1] - 1)).lunarDay === last,
      `月末が ${last} 日になりません`);
  }
  return "朔＝1 日 / 翌日＝2 日 / 月末＝29 か 30 日";
});

check("一の位と方角の対応", () => {
  const want = { 1:"e", 2:"e", 3:"s", 4:"s", 5:"w", 6:"w", 7:"n", 8:"n", 9:null, 0:null };
  const a = Gilbang._moons().list;
  let n = 0;
  for (let i = 6; i < 20; i++) {
    for (let d = 0; d < a[i + 1] - a[i]; d++) {
      const r = Gilbang.son(iso(a[i] + d));
      const w = want[r.lunarDay % 10];
      assert(r.key === w, `旧暦 ${r.lunarDay} 日が ${r.key}（${w} のはず）`);
      assert(r.free === (w === null), `旧暦 ${r.lunarDay} 日の free が ${r.free}`);
      n++;
    }
  }
  return `${n} 日ぶん一致`;
});

check("손없는 날は 10 日に 2 度ある", () => {
  const a = Gilbang._moons().list;
  let free = 0, total = 0;
  for (let i = 6; i < 40; i++)
    for (let d = 0; d < a[i + 1] - a[i]; d++) {
      if (Gilbang.son(iso(a[i] + d)).free) free++;
      total++;
    }
  const pct = free / total * 100;
  assert(pct > 15 && pct < 25, `손없는 날が ${pct.toFixed(1)}%`);
  return `${free}/${total} 日（${pct.toFixed(1)}%）`;
});

check("範囲外は RangeError", () => {
  for (const d of ["1990-01-01", "2099-12-31"]) {
    let threw = null;
    try { Gilbang.son(d); } catch (e) { threw = e; }
    assert(threw instanceof RangeError, `${d} が ${threw ? threw.constructor.name : "素通り"}`);
  }
  let bad = null;
  try { Gilbang.son("2026/08/01"); } catch (e) { bad = e; }
  assert(bad, "形式違いが素通りしました");
  return "範囲外・形式違いとも弾く";
});

/* ---- 3. 恵方 -------------------------------------------------------- */

head("[恵方]  年の十干で決まり、4 方向しかない");

check("十干と方角の対応（戊癸は丙と同じ）", () => {
  const want = ["東北東","西南西","南南東","北北西","南南東",
                "東北東","西南西","南南東","北北西","南南東"];
  const names = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
  for (let i = 0; i < 10; i++) {
    const got = Gilbang.eho(i).dir.ja;
    assert(got === want[i], `${names[i]} が ${got}（${want[i]} のはず）`);
  }
  const uniq = new Set(want);
  assert(uniq.size === 4, `方向が ${uniq.size} 種類（4 のはず）`);
  return [...uniq].join(" / ");
});

check("恵方は立春で切り替わる", () => {
  // 2026 年の立春前後。年柱が変われば恵方も変わる。
  const before = Saju.pillars({ y: 2026, m: 2, d: 1, hour: 12, city: "seoul" });
  const after  = Saju.pillars({ y: 2026, m: 2, d: 10, hour: 12, city: "seoul" });
  assert(before.sajuYear === 2025 && after.sajuYear === 2026,
    `사주년が ${before.sajuYear} / ${after.sajuYear}`);
  const a = Gilbang.eho(before.year.stemIdx), b = Gilbang.eho(after.year.stemIdx);
  assert(a.dir.ja !== b.dir.ja, `立春をまたいでも ${a.dir.ja} のままです`);
  return `2026 立春前 ${a.dir.ja} → 立春後 ${b.dir.ja}`;
});

check("元日では切り替わらない", () => {
  const dec = Saju.pillars({ y: 2025, m: 12, d: 31, hour: 12, city: "seoul" });
  const jan = Saju.pillars({ y: 2026, m: 1, d: 1, hour: 12, city: "seoul" });
  assert(Gilbang.eho(dec.year.stemIdx).dir.ja === Gilbang.eho(jan.year.stemIdx).dir.ja,
    "元日で恵方が動きました");
  return "12/31 と 1/1 は同じ";
});

check("十干の番号がはみ出しても落ちない", () => {
  for (const i of [-3, -1, 0, 9, 10, 25]) {
    const r = Gilbang.eho(i);
    assert(r && r.dir && r.dir.ja, `${i} で方角がありません`);
  }
  return "-3 / -1 / 0 / 9 / 10 / 25";
});

/* ---- 4. 五行の方位 -------------------------------------------------- */

head("[五行の方位]  木＝東・火＝南・土＝中央・金＝西・水＝北");

check("対応表と、5 つすべてに方位があること", () => {
  const want = { 목:"東", 화:"南", 토:"中央", 금:"西", 수:"北" };
  for (const e in want) {
    const r = Gilbang.ofElement(e);
    assert(r && r.dir.ja === want[e], `${e} が ${r ? r.dir.ja : "なし"}`);
  }
  assert(Gilbang.ofElement("なにか") === null, "知らない五行が null になりません");
  return Object.entries(want).map(([e, j]) => `${e}=${j}`).join(" ");
});

check("足りない五行の方位を返す", () => {
  const me = Saju.pillars({ y: 1990, m: 5, d: 17, hour: 14, city: "seoul" });
  const r = Gilbang.mine(me);
  assert(r.dir && r.dir.ja, "方位がありません");
  assert(r.all.length === 5, `内訳が ${r.all.length} 件`);
  // いちばん足りない五行が先頭に来ていること
  assert(r.all[0].element === r.element, "並びと結果が食い違っています");
  for (let i = 1; i < r.all.length; i++)
    assert(r.all[i - 1].lack >= r.all[i].lack, "不足の多い順に並んでいません");
  const sum = r.all.reduce((a, x) => a + x.count, 0);
  assert(sum === 8, `五行の合計が ${sum}`);
  return `${me.day.hanja} 日生まれ → ${r.element}（${r.dir.ja}）`;
});

check("土の多さで全員が同じ方位にならない", () => {
  // 5 等分を基準にすると誰でも土が過多に見え、吉方から中央が消える。
  // fortune.js と同じ比率を使っているかを、出方で確かめる。
  const seen = {};
  let seed = 1;
  for (let y = 1950; y <= 2010; y++) {
    for (let k = 0; k < 4; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const me = Saju.pillars({ y, m: 1 + (seed >> 7) % 12, d: 1 + (seed >> 11) % 28,
                                hour: (seed >> 16) % 24, city: "seoul" });
      const k2 = Gilbang.mine(me).dir.ja;
      seen[k2] = (seen[k2] || 0) + 1;
    }
  }
  const n = Object.values(seen).reduce((a, b) => a + b, 0);
  assert(Object.keys(seen).length === 5, `${Object.keys(seen).length} 方位しか出ません`);
  for (const k in seen)
    assert(seen[k] / n > 0.05, `${k} が ${(seen[k] / n * 100).toFixed(1)}% しか出ません`);
  return Object.entries(seen).map(([k, v]) => `${k} ${(v / n * 100).toFixed(0)}%`).join(" ");
});

check("今日の日辰の方位は日ごとに変わる", () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const t = new Date(Date.UTC(2026, 7, 1) + i * 86400000);
    const p = Saju.pillars({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1,
                             d: t.getUTCDate(), hour: 12, city: "seoul" });
    seen.add(Gilbang.flow(p).dir.ja);
  }
  assert(seen.size === 5, `30 日で ${seen.size} 方位しか出ません`);
  return `30 日で ${seen.size} 方位すべて`;
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : "")
  + `　（朔の基準: ${ref.source} ${ref.fetched} 取得）`);
process.exit(failed ? 1 : 0);
