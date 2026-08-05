#!/usr/bin/env node
/* ==================================================================
   verify-fortune.mjs — fortune.js の点数と保存を確かめる

     使い方:  node tools/verify-fortune.mjs

   saju.js と違い、こちらには突き合わせる公表値が無い。運勢の点数に
   正解は無いからで、確かめられるのは「約束したとおりに振る舞うか」だけ。
   約束は 3 つある。

     1 決定論   同じ生年月日＋同じ日付なら必ず同じ点数。破れると
                「前回と比べて」が意味を失う（更新するたび増減が変わる）
     2 公平     6 項目の平均が揃っていること。揃っていないと
                「健康運だけ毎日低い」という表になり、項目間の比較が嘘になる
     3 保存物   入るのは日付と 6 個の整数だけ。生年月日は入らない（§4）

   2 は分布を測って確かめる。閾値はここに書いてある数字が根拠ではなく、
   偏りを直したときに実測した値を固定したもの。将来モデルをいじって
   偏りが戻れば、ここが落ちる。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

vm.runInThisContext(fs.readFileSync("saju.js", "utf8"), { filename: "saju.js" });
vm.runInThisContext(fs.readFileSync("fortune.js", "utf8"), { filename: "fortune.js" });
Saju.load(JSON.parse(fs.readFileSync("solar-terms.json", "utf8")));

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

const pillars = (y, m, d, hour, city) => Saju.pillars({ y, m, d, hour, city: city || "seoul" });
const noon = (y, m, d) => pillars(y, m, d, 12);
const IDS = Fortune.CATS.map((c) => c.id);

/* ---- 標本 ----------------------------------------------------------
   月・日・時が偏ると五行分布が偏り、モデルではなく標本のせいで
   項目の平均がずれる。実際それで一度誤診した。日付を散らして採る。   */
function sample() {
  const people = [];
  let seed = 1;
  for (let y = 1950; y <= 2010; y++) {
    for (let k = 0; k < 6; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;   // 標本の取り方だけ擬似乱数
      people.push(pillars(y, 1 + (seed >> 7) % 12, 1 + (seed >> 11) % 28, (seed >> 16) % 24));
    }
  }
  const days = [];
  for (let i = 0; i < 120; i++) {
    const t = new Date(Date.UTC(2026, 7, 1) + i * 86400000);
    days.push(noon(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
  }
  return { people, days };
}

const { people, days } = sample();

/* ---- 1. 決定論 ------------------------------------------------------ */

head("[決定論]  同じ入力なら必ず同じ点数");

check("同じ生年月日・同じ日付を 100 回", () => {
  const me = pillars(1990, 5, 17, 14), day = noon(2026, 8, 1);
  const first = JSON.stringify(Fortune.of(me, day).scores);
  for (let i = 0; i < 100; i++)
    assert(JSON.stringify(Fortune.of(me, day).scores) === first, `${i} 回目で変わりました`);
  return `${first}`;
});

check("四柱を引き直しても同じ", () => {
  // 引数のオブジェクトを使い回さず、毎回 Saju から作り直しても揃うこと。
  const a = Fortune.of(pillars(1985, 11, 3, 7), noon(2026, 9, 9)).scores;
  const b = Fortune.of(pillars(1985, 11, 3, 7), noon(2026, 9, 9)).scores;
  assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return "同一";
});

check("日辰一巡（60 日）で十分な種類が出る", () => {
  // 上限は 60 で、それ以上にはならない。日辰が六十干支で一巡するから。
  // 五行だけで十神を見ていた頃はここが 25 まで潰れていた。
  const cyc = days.slice(0, 60);
  let worst = 60;
  for (const p of people.slice(0, 40)) {
    const n = new Set(cyc.map((d) => JSON.stringify(Fortune.of(p, d).scores))).size;
    if (n < worst) worst = n;
  }
  assert(worst >= 45, `60 日で ${worst} 通りしかない人がいます`);
  return `60 日で最低 ${worst} 通り（上限 60）`;
});

check("連続した 2 日が丸ごと同点にならない", () => {
  // ここが破れると「前回と比べて」が 6 項目とも 0 になり、
  // 毎日来た人にだけ見えるはずの情報が空になる。
  let pairs = 0, same = 0;
  for (const p of people.slice(0, 40)) {
    const seq = days.map((d) => JSON.stringify(Fortune.of(p, d).scores));
    for (let i = 1; i < seq.length; i++) { pairs++; if (seq[i] === seq[i - 1]) same++; }
  }
  assert(same === 0, `${pairs} 組のうち ${same} 組が前日と丸ごと同点です`);
  return `${pairs} 組すべてどこかが動く`;
});

check("人が変われば点数も変わる（同じ日）", () => {
  const day = noon(2026, 8, 1);
  const seen = new Set(people.map((p) => JSON.stringify(Fortune.of(p, day).scores)));
  assert(seen.size > 30, `${people.length} 人で ${seen.size} 通りしかありません`);
  return `${people.length} 人で ${seen.size} 通り`;
});

/* ---- 2. 値の形 ------------------------------------------------------ */

head("[値]  0〜100 の整数・6 項目・等級との整合");

check("全標本が 0〜100 の整数で 6 項目そろう", () => {
  let n = 0;
  for (const p of people) for (const d of days.slice(0, 12)) {
    const r = Fortune.of(p, d);
    for (const id of IDS) {
      const v = r.scores[id];
      assert(Number.isInteger(v), `${id} が整数ではありません: ${v}`);
      assert(v >= 0 && v <= 100, `${id} が範囲外: ${v}`);
      assert(r.grades[id] && r.grades[id].ja, `${id} の等級がありません`);
      assert(r.grades[id].ja === Fortune.grade(v).ja,
        `${id}=${v} の等級が ${r.grades[id].ja}`);
    }
    n++;
  }
  return `${n * IDS.length} 個`;
});

check("等級の境目", () => {
  const at = (n) => Fortune.grade(n).ja;
  const want = [[100, "大吉"], [80, "大吉"], [79, "吉"], [65, "吉"], [64, "中吉"],
                [50, "中吉"], [49, "小吉"], [35, "小吉"], [34, "末吉"], [0, "末吉"]];
  for (const [n, ja] of want) assert(at(n) === ja, `${n} 点が ${at(n)}（${ja} のはず）`);
  return want.map(([n, j]) => `${n}:${j}`).join(" ");
});

check("時刻不明（3 柱）でも成立する", () => {
  const me = Saju.pillars({ y: 1990, m: 5, d: 17, hour: null, city: "seoul" });
  const r = Fortune.of(me, noon(2026, 8, 1));
  for (const id of IDS) {
    assert(Number.isInteger(r.scores[id]) && r.scores[id] >= 0 && r.scores[id] <= 100,
      `${id} が ${r.scores[id]}`);
  }
  return `総合運 ${r.scores.total}（五行 6 個で算出）`;
});

/* ---- 3. 公平さ ------------------------------------------------------ */

head("[公平]  項目ごとの平均が揃っている");

function stats() {
  const acc = {}, all = {};
  for (const id of IDS) { acc[id] = 0; all[id] = []; }
  let n = 0;
  for (const p of people) for (const d of days) {
    const r = Fortune.of(p, d);
    for (const id of IDS) { acc[id] += r.scores[id]; all[id].push(r.scores[id]); }
    n++;
  }
  const out = {};
  for (const id of IDS) {
    const s = all[id].sort((a, b) => a - b);
    out[id] = { mean: acc[id] / n, p10: s[Math.floor(n * 0.1)], p90: s[Math.floor(n * 0.9)] };
  }
  return out;
}

const ST = stats();

check("6 項目の平均がどれも 50 ± 2", () => {
  const bad = IDS.filter((id) => Math.abs(ST[id].mean - 50) > 2);
  assert(!bad.length,
    bad.map((id) => `${id} の平均が ${ST[id].mean.toFixed(1)}`).join(" / "));
  return IDS.map((id) => `${id} ${ST[id].mean.toFixed(1)}`).join(" ");
});

check("項目間で平均が離れていない（最大差 2 点以内）", () => {
  // ここが開くと「健康運だけ毎日低い」表になる。暦の偏りを引く処理
  // （fortune.js の expected()）が効いているかを見ている。
  const ms = IDS.map((id) => ST[id].mean);
  const gap = Math.max(...ms) - Math.min(...ms);
  assert(gap <= 2, `最大差が ${gap.toFixed(1)} 点`);
  return `最大差 ${gap.toFixed(1)} 点`;
});

check("点数が真ん中に固まっていない", () => {
  for (const id of IDS) {
    const w = ST[id].p90 - ST[id].p10;
    assert(w >= 20, `${id} の p10〜p90 が ${w} 点しかありません`);
  }
  return IDS.map((id) => `${id} ${ST[id].p10}〜${ST[id].p90}`).join(" ");
});

check("5 等級すべてが出る", () => {
  const c = {};
  for (const p of people) for (const d of days.slice(0, 30)) {
    const g = Fortune.of(p, d).grades.total.ja;
    c[g] = (c[g] || 0) + 1;
  }
  const tot = Object.values(c).reduce((a, b) => a + b, 0);
  for (const g of Fortune.GRADES) assert(c[g.ja] > 0, `${g.ja} が一度も出ません`);
  return Fortune.GRADES.map((g) => `${g.ja} ${(c[g.ja] / tot * 100).toFixed(0)}%`).join(" ");
});

check("五行の自然な割合（土が多い）が SHARE と合う", () => {
  // fortune.js は「土は地支 12 のうち 4 つなので多くて当たり前」という
  // 前提で過不足を測っている。その前提を実際の四柱で確かめる。
  const acc = { 목:0, 화:0, 토:0, 금:0, 수:0 };
  let n = 0;
  for (const p of people) for (const e in p.elements) { acc[e] += p.elements[e]; n += p.elements[e]; }
  const want = { 목:0.18333, 화:0.18333, 토:0.26667, 금:0.18333, 수:0.18333 };
  const got = [];
  for (const e in want) {
    const r = acc[e] / n;
    assert(Math.abs(r - want[e]) < 0.02,
      `${e} が ${(r * 100).toFixed(1)}%（想定 ${(want[e] * 100).toFixed(1)}%）`);
    got.push(`${e} ${(r * 100).toFixed(1)}%`);
  }
  return got.join(" ");
});

/* ---- 4. 保存物 ------------------------------------------------------ */

head("[保存]  日付と 6 個の整数だけ。生年月日は入らない");

/** localStorage の代わり。実装ではなく「何が入ったか」を見るために持つ。 */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => JSON.stringify([...m]),
  };
}

check("保存された中身に生年月日が現れない", () => {
  globalThis.localStorage = fakeStorage();
  Fortune.clear();
  const me = pillars(1990, 5, 17, 14);
  const r = Fortune.of(me, noon(2026, 8, 1));
  Fortune.save("2026-08-01", r.scores);

  const raw = globalThis.localStorage._dump();
  for (const bad of ["1990", "05-17", "5-17", "14:", "seoul", "임", "壬"])
    assert(!raw.includes(bad), `保存物に "${bad}" が入っています: ${raw}`);

  const o = JSON.parse(globalThis.localStorage.getItem(Fortune.KEY));
  assert(o.cur.d === "2026-08-01", `日付が ${o.cur.d}`);
  assert(Array.isArray(o.cur.s) && o.cur.s.length === 6, `点数が ${JSON.stringify(o.cur.s)}`);
  assert(o.cur.s.every(Number.isInteger), "整数以外が入っています");
  const keys = Object.keys(o).sort().join(",");
  assert(keys === "cur,prev,v", `トップレベルの鍵が ${keys}`);
  return `${raw.length} バイト / ${JSON.stringify(o.cur)}`;
});

check("初回は比較しない", () => {
  globalThis.localStorage = fakeStorage();
  Fortune.clear();
  const r = Fortune.of(pillars(1990, 5, 17, 14), noon(2026, 8, 1));
  const prev = Fortune.save("2026-08-01", r.scores);
  assert(prev === null, `初回なのに前回が ${JSON.stringify(prev)}`);
  assert(Fortune.diff(r.scores, prev) === null, "初回なのに差が出ています");
  return "比較欄なし";
});

check("翌日は前回と比べ、実際の日付を返す", () => {
  globalThis.localStorage = fakeStorage();
  Fortune.clear();
  const me = pillars(1990, 5, 17, 14);
  const r1 = Fortune.of(me, noon(2026, 8, 1));
  Fortune.save("2026-08-01", r1.scores);
  const r2 = Fortune.of(me, noon(2026, 8, 2));
  const prev = Fortune.save("2026-08-02", r2.scores);
  const d = Fortune.diff(r2.scores, prev);
  assert(d && d.date === "2026-08-01", `前回の日付が ${d && d.date}`);
  for (const id of IDS)
    assert(d.by[id] === r2.scores[id] - r1.scores[id], `${id} の差が合いません`);
  return `前回 ${d.date} / 総合 ${d.by.total > 0 ? "+" : ""}${d.by.total}`;
});

check("日を跳ばしても「昨日」と言わず実際の日付を返す", () => {
  globalThis.localStorage = fakeStorage();
  Fortune.clear();
  const me = pillars(1990, 5, 17, 14);
  Fortune.save("2026-07-28", Fortune.of(me, noon(2026, 7, 28)).scores);
  const r = Fortune.of(me, noon(2026, 8, 1));
  const prev = Fortune.save("2026-08-01", r.scores);
  assert(Fortune.diff(r.scores, prev).date === "2026-07-28",
    `4 日空いたのに前回が ${prev && prev.d}`);
  return "前回 2026-07-28（4 日前）";
});

check("同じ日に何度開いても前回が押し流されない", () => {
  globalThis.localStorage = fakeStorage();
  Fortune.clear();
  const me = pillars(1990, 5, 17, 14);
  Fortune.save("2026-07-31", Fortune.of(me, noon(2026, 7, 31)).scores);
  const r = Fortune.of(me, noon(2026, 8, 1));
  let prev = null;
  for (let i = 0; i < 5; i++) prev = Fortune.save("2026-08-01", r.scores);
  assert(prev && prev.d === "2026-07-31",
    `5 回開いたら前回が ${prev && prev.d} になりました`);
  return "5 回開いても前回は 2026-07-31";
});

check("localStorage が使えなくても点数は出る", () => {
  // 私用モードや容量超過。運勢が表示できなくなる方が困る。
  const boom = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  globalThis.localStorage = boom;
  const r = Fortune.of(pillars(1990, 5, 17, 14), noon(2026, 8, 1));
  assert(Number.isInteger(r.scores.total), "点数が出ません");
  const prev = Fortune.save("2026-08-01", r.scores);
  assert(prev === null, `保存できないのに前回が ${JSON.stringify(prev)}`);
  assert(Fortune.diff(r.scores, prev) === null, "比較が出ています");
  delete globalThis.localStorage;
  return "例外を投げるだけの localStorage でも通る";
});

check("並べ替えても中身が壊れない（pack / unpack）", () => {
  const s = {};
  IDS.forEach((id, i) => { s[id] = i * 7 + 3; });
  const back = Fortune._unpack(Fortune._pack(s));
  for (const id of IDS) assert(back[id] === s[id], `${id} が ${back[id]}`);
  return IDS.join(",");
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : "")
  + `　（標本 ${people.length} 人 × ${days.length} 日）`);
process.exit(failed ? 1 : 0);
