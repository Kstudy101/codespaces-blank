#!/usr/bin/env node
/* ==================================================================
   verify-omikuji.mjs — おみくじの抽選と 1 日 1 回の制限

     使い方:  node tools/verify-omikuji.mjs

   運勢（verify-fortune.mjs）と裏返しの検証になる。あちらは「引き直しても
   同じ数字か」を確かめるが、こちらは「引くたびに違うか」と「同じ日には
   引き直せないか」を確かめる。どちらが欠けてもおみくじとして壊れる。

     ・毎回同じ結果しか出ない  → 抽選ではなくなる
     ・同じ日に引き直せる      → 良いのが出るまで引けてしまう（§7）

   ことわざの本文も見る。等級の調子と組が合っていないと、大吉に
   「後の祭り」が出るような取り合わせが起きる。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
vm.runInThisContext(fs.readFileSync("omikuji.js", "utf8"), { filename: "omikuji.js" });

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

function fakeStorage(limit) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (limit && String(v).length > limit) throw new Error("QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    _dump: () => JSON.stringify([...m]),
    _keys: () => [...m.keys()],
  };
}
const fresh = (limit) => { globalThis.localStorage = fakeStorage(limit); };

/** 決まった並びを返す「乱数」。抽選の道筋を狙って通すために使う。 */
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

/* ---- 1. 抽選 -------------------------------------------------------- */

head("[抽選]  引くたびに変わる");

check("同じ日でなければ結果がばらける", () => {
  fresh();
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    Omikuji.clear();
    const r = Omikuji.draw("2026-08-" + String((i % 28) + 1).padStart(2, "0"));
    seen.add(r.grade.ja + "/" + r.saying.k);
  }
  assert(seen.size > 20, `400 回引いて ${seen.size} 通りしかありません`);
  return `${seen.size} 通り`;
});

check("等級の配分がおおむね重みどおり", () => {
  // 乱数そのものではなく、重みつき抽選の組み立てを見ている。
  fresh();
  const n = 60000, count = {};
  for (let i = 0; i < n; i++) {
    const gi = Omikuji._pickGrade(Math.random);
    count[gi] = (count[gi] || 0) + 1;
  }
  const total = Omikuji.GRADES.reduce((a, g) => a + g.w, 0);
  const out = [];
  Omikuji.GRADES.forEach((g, i) => {
    const got = (count[i] || 0) / n * 100, want = g.w / total * 100;
    assert(Math.abs(got - want) < 1.5,
      `${g.ja} が ${got.toFixed(1)}%（想定 ${want.toFixed(1)}%）`);
    out.push(`${g.ja} ${got.toFixed(0)}%`);
  });
  return out.join(" ");
});

check("大凶は滅多に出ず、大吉も出すぎない", () => {
  const total = Omikuji.GRADES.reduce((a, g) => a + g.w, 0);
  const by = {};
  Omikuji.GRADES.forEach((g) => { by[g.ja] = g.w / total * 100; });
  assert(by["大凶"] <= 7, `大凶が ${by["大凶"]}%`);
  assert(by["大吉"] <= 15, `大吉が ${by["大吉"]}%`);
  assert(by["凶"] + by["大凶"] <= 25, `凶と大凶で ${by["凶"] + by["大凶"]}%`);
  return `大吉 ${by["大吉"]}% / 凶 ${by["凶"]}% / 大凶 ${by["大凶"]}%`;
});

check("抽選の端（0 と 1 の直前）でも範囲に収まる", () => {
  assert(Omikuji._pickGrade(() => 0) === 0, "0 で先頭が出ません");
  const last = Omikuji._pickGrade(() => 0.999999);
  assert(last === Omikuji.GRADES.length - 1, `0.999999 で ${last} 番`);
  for (const v of [0, 0.5, 0.999999, 1]) {
    const gi = Omikuji._pickGrade(() => v);
    assert(gi >= 0 && gi < Omikuji.GRADES.length, `${v} で ${gi} 番`);
  }
  return "0 / 0.5 / 0.999999 / 1";
});

/* ---- 2. 1 日 1 回 --------------------------------------------------- */

head("[1 日 1 回]  同じ日は引き直せない");

check("2 回目は同じ結果を返す", () => {
  fresh();
  const a = Omikuji.draw("2026-08-01");
  assert(a.fresh === true, "1 回目が fresh ではありません");
  for (let i = 0; i < 20; i++) {
    const b = Omikuji.draw("2026-08-01");
    assert(b.grade.ja === a.grade.ja && b.saying.k === a.saying.k,
      `${i + 2} 回目が ${b.grade.ja}/${b.saying.k}（${a.grade.ja}/${a.saying.k} のはず）`);
    assert(b.fresh === false, `${i + 2} 回目が fresh になっています`);
  }
  return `${a.grade.ja} を 21 回とも同じで返す`;
});

check("引いたかどうかを日付で答える", () => {
  fresh();
  assert(Omikuji.drawn("2026-08-01") === false, "引く前が true");
  assert(Omikuji.today("2026-08-01") === null, "引く前に結果があります");
  Omikuji.draw("2026-08-01");
  assert(Omikuji.drawn("2026-08-01") === true, "引いた後が false");
  assert(Omikuji.drawn("2026-08-02") === false, "翌日が true になっています");
  assert(Omikuji.today("2026-08-02") === null, "翌日に前日の結果が出ます");
  return "当日 true / 翌日 false";
});

check("日付が変われば引き直せる", () => {
  fresh();
  const a = Omikuji.draw("2026-08-01");
  const b = Omikuji.draw("2026-08-02");
  assert(b.fresh === true, "翌日が fresh ではありません");
  assert(Omikuji.drawn("2026-08-01") === false, "前日の記録が残っています");
  assert(Omikuji.today("2026-08-02").saying.k === b.saying.k, "翌日ぶんが保存されていません");
  return `${a.grade.ja} → ${b.grade.ja}`;
});

check("保存が壊れていたら引き直せる（黙って固まらない）", () => {
  for (const bad of ['{"v":9,"d":"2026-08-01","gi":0,"si":0}',
                     '{"v":1,"d":"2026-08-01","gi":99,"si":0}',
                     '{"v":1,"gi":0,"si":0}', "not json", ""]) {
    fresh();
    globalThis.localStorage.setItem(Omikuji.KEY, bad);
    assert(Omikuji.drawn("2026-08-01") === false, `${bad} で drawn が true`);
    const r = Omikuji.draw("2026-08-01");
    assert(r && r.grade && r.saying, `${bad} のあと引けません`);
  }
  return "版違い・範囲外・欠け・壊れた JSON・空";
});

check("localStorage が使えなくても引ける（制限はかからない）", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  const r = Omikuji.draw("2026-08-01");
  assert(r && r.grade && r.saying, "引けません");
  assert(r.saved === false, "保存できていないのに saved が true");
  delete globalThis.localStorage;
  return "結果は出す / saved=false で呼び出し側に伝える";
});

check("容量超過でも結果は見せる", () => {
  fresh(10);
  const r = Omikuji.draw("2026-08-01");
  assert(r.grade && r.saying, "引けません");
  assert(r.fresh === true && r.saved === false, `fresh=${r.fresh} saved=${r.saved}`);
  return "引けるが保存はされない";
});

/* ---- 3. ことわざ ---------------------------------------------------- */

head("[本文]  等級の調子と取り合わせが合う");

check("3 組すべてに必要な欄がそろう", () => {
  let n = 0;
  const seen = new Set();
  for (const tone of Object.keys(Omikuji.SAYINGS)) {
    const a = Omikuji.SAYINGS[tone];
    assert(Array.isArray(a) && a.length >= 4, `${tone} が ${a ? a.length : 0} 件`);
    for (const s of a) {
      for (const f of ["k", "r", "j", "n"])
        assert(typeof s[f] === "string" && s[f].length, `${tone}/${s.k}: ${f} が空`);
      assert(/[가-힣]/.test(s.k), `${tone}/${s.k}: ハングルが入っていません`);
      assert(!/[가-힣]/.test(s.j), `${tone}/${s.k}: 訳にハングルが混ざっています`);
      assert(!seen.has(s.k), `${s.k} が重複しています`);
      seen.add(s.k);
      n++;
    }
  }
  return `${n} 件 / 重複なし`;
});

check("等級ごとに正しい組から引く", () => {
  const tones = {};
  Omikuji.GRADES.forEach((g) => { tones[g.ja] = g.tone; });
  for (let gi = 0; gi < Omikuji.GRADES.length; gi++) {
    const g = Omikuji.GRADES[gi];
    for (let si = 0; si < 8; si++) {
      const r = Omikuji._result(gi, si);
      assert(Omikuji.SAYINGS[g.tone].indexOf(r.saying) >= 0,
        `${g.ja} に ${g.tone} 以外のことわざが出ました: ${r.saying.k}`);
    }
  }
  // 大吉に「後の祭り」が出ないことを名指しで確かめる
  const warnOnly = Omikuji.SAYINGS.warn.map((s) => s.k);
  for (let si = 0; si < 20; si++) {
    const r = Omikuji._result(0, si);
    assert(warnOnly.indexOf(r.saying.k) < 0, `大吉に ${r.saying.k} が出ました`);
  }
  return "大吉〜中吉=good / 小吉・末吉=mid / 凶・大凶=warn";
});

check("番号がはみ出しても本文が出る", () => {
  for (const si of [0, 4, 5, 99, 1000]) {
    const r = Omikuji._result(3, si);
    assert(r.saying && r.saying.k, `si=${si} で本文がありません`);
  }
  return "剰余で丸める";
});

/* ---- 4. 保存物 ------------------------------------------------------ */

head("[保存]  日付と番号 2 つだけ");

check("保存物に本文も個人情報も入らない", () => {
  fresh();
  Omikuji.draw("2026-08-01", seq(0.05, 0.1));
  const raw = globalThis.localStorage._dump();
  for (const bad of ["시작이", "大吉", "1990", "田中", "seoul"])
    assert(!raw.includes(bad), `保存物に "${bad}" が入っています: ${raw}`);
  const o = JSON.parse(globalThis.localStorage.getItem(Omikuji.KEY));
  assert(Object.keys(o).sort().join(",") === "d,gi,si,v", `鍵が ${Object.keys(o)}`);
  assert(o.d === "2026-08-01" && Number.isInteger(o.gi) && Number.isInteger(o.si),
    `中身が ${JSON.stringify(o)}`);
  return `${raw.length} バイト / ${JSON.stringify(o)}`;
});

check("消したら引き直せる", () => {
  fresh();
  Omikuji.draw("2026-08-01");
  Omikuji.clear();
  assert(globalThis.localStorage._keys().length === 0, "鍵が残っています");
  assert(Omikuji.drawn("2026-08-01") === false, "消したのに引いたことになっています");
  return "鍵ごと消える";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
