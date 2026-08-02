#!/usr/bin/env node
/* ==================================================================
   verify-birth.mjs — 生年月日の持ち回り

     使い方:  node tools/verify-birth.mjs

   このファイルが見張っているのは、機能というより約束の方。
   privacy.html は「生年月日は localStorage に保存しない」「タブを
   閉じると消える」と書いている。birth.js が sessionStorage を
   localStorage に書き換えられても画面上は何も変わらないので、
   人間のレビューでは通ってしまう。だから機械に見張らせる。

     1 保存先        sessionStorage だけ。localStorage には一切触れない
     2 中身          年月日・時刻・都市以外を持ち出さない（名前が混ざらない）
     3 受け取る範囲   1930〜2030。saju.js に節気表がある範囲と一致
     4 壊れた値      読み出しで null にして捨てる。中途半端に読まない
     5 書けない環境   例外にせず、その場の値は返す

   3 が要るのは、保存はできたのに読み出した先で四柱が立たない、という
   ページごとに違う失敗の仕方をするため。gilbang / amulet は
   トップとは別の入口なので、そこで初めて落ちると原因が分からない。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);

function fakeStorage(limit) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (limit && String(v).length > limit) throw new Error("QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    _keys: () => [...m.keys()],
    _get: (k) => m.get(k)
  };
}

/* session と local を別々に持たせ、どちらが触られたかを見分けられるようにする。 */
let ss, ls;
function fresh(limit) {
  ss = fakeStorage(limit);
  ls = fakeStorage();
  globalThis.sessionStorage = ss;
  globalThis.localStorage = ls;
  delete globalThis.Birth;
  vm.runInThisContext(fs.readFileSync("birth.js", "utf8"), { filename: "birth.js" });
}

const OK = { y: 1995, m: 4, d: 12, hour: 9, city: "tokyo" };

/* ---- 1. 保存先 ------------------------------------------------------ */

head("[保存先]  localStorage には置かない ── privacy.html の約束そのもの");

check("保存すると sessionStorage にだけ入る", () => {
  fresh();
  Birth.save(OK);
  assert(ss._keys().includes(Birth.KEY), "sessionStorage に入っていません");
  assert(ls._keys().length === 0, `localStorage が触られました: ${ls._keys().join(" ")}`);
  return `sessionStorage: ${Birth.KEY}`;
});

check("birth.js の中に localStorage という語が無い", () => {
  const src = fs.readFileSync("birth.js", "utf8");
  const hits = [...src.matchAll(/localStorage/g)].length;
  // 説明の中では触れている（残る側との違いを書いている）ので、
  // コメントを除いた実コードだけを見る。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(!/localStorage/.test(code), "コード中で localStorage を参照しています");
  return `コメント内の言及 ${hits} 件のみ`;
});

check("clear で消える", () => {
  fresh();
  Birth.save(OK);
  Birth.clear();
  assert(Birth.load() === null, "消えていません");
  assert(!ss._keys().includes(Birth.KEY), "鍵が残っています");
  return "null";
});

/* ---- 2. 中身 -------------------------------------------------------- */

head("[中身]  年月日・時刻・都市だけ。名前が混ざらない");

check("余分な欄は持ち出さない", () => {
  fresh();
  Birth.save({ ...OK, sei: "田中", mei: "愛", memo: "x" });
  const saved = JSON.parse(ss._get(Birth.KEY));
  const keys = Object.keys(saved.b).sort().join(" ");
  assert(keys === "city d hour m y", `保存された欄: ${keys}`);
  assert(!/田中|愛|memo/.test(ss._get(Birth.KEY)), "名前が保存されています");
  return keys;
});

check("往復して同じ値が戻る", () => {
  fresh();
  Birth.save(OK);
  const got = Birth.load();
  for (const k of ["y", "m", "d", "hour", "city"])
    assert(got[k] === OK[k], `${k}: ${got[k]} ≠ ${OK[k]}`);
  return JSON.stringify(got);
});

check("時刻不明は null のまま往復する", () => {
  fresh();
  Birth.save({ ...OK, hour: null });
  assert(Birth.load().hour === null, "null が変わりました");
  // undefined で渡されても null に寄せる ── 受け取る側は 2 通り見たくない
  fresh();
  Birth.save({ y: 1995, m: 4, d: 12, city: "seoul" });
  assert(Birth.load().hour === null, "undefined が null になりません");
  return "null";
});

/* ---- 3. 受け取る範囲 ------------------------------------------------ */

head("[範囲]  saju.js の節気表と同じ 1930〜2030");

check("節気表の範囲と一致している", () => {
  const src = fs.readFileSync("solar-terms.json", "utf8");
  const j = JSON.parse(src);
  const from = j.range ? j.range[0] : null, to = j.range ? j.range[1] : null;
  assert(from !== null, "solar-terms.json に range がありません");
  assert(Birth.MIN_YEAR >= from && Birth.MAX_YEAR <= to,
    `birth.js ${Birth.MIN_YEAR}〜${Birth.MAX_YEAR} / 節気表 ${from}〜${to}`);
  return `${Birth.MIN_YEAR}〜${Birth.MAX_YEAR}（節気表 ${from}〜${to}）`;
});

check("範囲外の年は受け取らない", () => {
  fresh();
  for (const y of [1929, 2031, 1900, 2100]) {
    assert(Birth.save({ ...OK, y }) === null, `${y} が通りました`);
    assert(Birth.load() === null, `${y} が保存されました`);
  }
  return "1929 / 2031 / 1900 / 2100 とも拒否";
});

check("存在しない日付は受け取らない", () => {
  fresh();
  for (const [m, d] of [[2, 30], [4, 31], [13, 1], [6, 0]])
    assert(Birth.save({ ...OK, m, d }) === null, `${m}月${d}日 が通りました`);
  assert(Birth.save({ ...OK, m: 2, d: 29, y: 1996 }) !== null, "1996-2-29 は閏年なので通るはず");
  return "2/30・4/31・13月・0日 を拒否 / 閏日は通す";
});

check("時刻と都市の形も見る", () => {
  fresh();
  assert(Birth.save({ ...OK, hour: 24 }) === null, "hour 24 が通りました");
  assert(Birth.save({ ...OK, hour: -1 }) === null, "hour -1 が通りました");
  assert(Birth.save({ ...OK, hour: 9.5 }) === null, "hour 9.5 が通りました");
  assert(Birth.save({ ...OK, city: "" }) === null, "空の都市が通りました");
  assert(Birth.save({ ...OK, city: 3 }) === null, "数値の都市が通りました");
  return "hour 0〜23 の整数 / city は空でない文字列";
});

check("都市が saju.js の一覧にある id か", () => {
  // birth.js は id の中身までは見ない（saju.js を読み込まないため）。
  // ここで実際の一覧と突き合わせておく ── 使う側が渡すのは常にこの中の 1 つ。
  vm.runInThisContext(fs.readFileSync("saju.js", "utf8"), { filename: "saju.js" });
  const ids = Saju.CITIES.map(c => c.id);
  assert(ids.includes("tokyo") && ids.includes("seoul"), `一覧: ${ids.join(" ")}`);
  fresh();
  for (const id of ids) assert(Birth.save({ ...OK, city: id }) !== null, `${id} が通りません`);
  return ids.join(" ");
});

/* ---- 4. 壊れた値 ---------------------------------------------------- */

head("[壊れた値]  中途半端に読まず、捨てる");

check("版が違えば捨てる", () => {
  fresh();
  ss.setItem(Birth.KEY, JSON.stringify({ v: 2, b: OK }));
  assert(Birth.load() === null, "読めてしまいました");
  assert(!ss._keys().includes(Birth.KEY), "捨てていません");
  return "null にして削除";
});

check("JSON として壊れていれば捨てる", () => {
  fresh();
  ss.setItem(Birth.KEY, "{ぐちゃぐちゃ");
  assert(Birth.load() === null, "読めてしまいました");
  return "null";
});

check("範囲外の値が入っていれば捨てる", () => {
  fresh();
  ss.setItem(Birth.KEY, JSON.stringify({ v: 1, b: { ...OK, y: 1800 } }));
  assert(Birth.load() === null, "読めてしまいました");
  return "null";
});

check("何も入っていなければ null", () => {
  fresh();
  assert(Birth.load() === null, "null ではありません");
  assert(Birth.has() === false, "has が true です");
  return "null / has false";
});

/* ---- 5. 書けない環境 ------------------------------------------------ */

head("[書けない環境]  持ち回れないだけで、その場は使える");

check("sessionStorage が無くても例外にならない", () => {
  delete globalThis.sessionStorage;
  delete globalThis.localStorage;
  delete globalThis.Birth;
  vm.runInThisContext(fs.readFileSync("birth.js", "utf8"), { filename: "birth.js" });
  const got = Birth.save(OK);
  assert(got && got.y === 1995, "その場の値が返りません");
  assert(Birth.load() === null, "読めるはずがありません");
  Birth.clear();   // 投げないこと
  return "save は値を返し、load は null";
});

check("容量超過でも値は返す", () => {
  fresh(5);   // 5 文字を超えると投げる
  const got = Birth.save(OK);
  assert(got && got.city === "tokyo", "その場の値が返りません");
  assert(Birth.load() === null, "保存できていないのに読めました");
  return "save は値を返す";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
