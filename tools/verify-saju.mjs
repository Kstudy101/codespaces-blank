#!/usr/bin/env node
/* ==================================================================
   verify-saju.mjs — saju.js を自分の計算とは無関係の値と突き合わせる

     使い方:  node tools/verify-saju.mjs

   節気の時刻と日柱の基準日は、間違っていると出力が全部そろって
   ずれる。しかも「それらしい干支」が出るので画面を見ても気づけない。
   だから公表値と突き合わせる。基準は国立天文台 暦計算室で、
   tools/fetch-naoj-reference.py が data/naoj-reference.json に置く。

   saju.js はブラウザ用の 1 ファイルをそのまま読み込む。ここで写しを
   作ると、写しの方だけ直して本体が古いままになる。

   検証項目は docs/plan-fortune-content.md §3 の 1〜6 に対応する:

     1 節気の時刻      ±2 分            → [節気]
     2 日柱の基準日     公表の干支と一致  → [日柱]
     3 節の前後で月柱   1 つ進む         → [月柱][年柱]
     4 サマータイム境界 UTC が合う       → [標準時]
     5 23 時台の日柱    翌日に送る       → [日柱境界]
     6 経度補正の符号   都市ごと         → [真太陽時]

   独立性について。標準時とサマータイムは Intl（端末の tz データ）と
   突き合わせる。saju.js が Intl を実行時に呼ばず表を焼き込んでいるので、
   これは別々の 2 つを比べたことになる。
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
Saju.load(JSON.parse(fs.readFileSync("solar-terms.json", "utf8")));

/* ---- 走らせ方 ------------------------------------------------------ */

let failed = 0, passed = 0;

function check(label, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  ✓ ${label}${detail ? "  " + detail : ""}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${label}\n      ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function head(s) { console.log(`\n${s}`); }

/* ---- Intl 側（saju.js の表とは別の出どころ） ------------------------ */

const ZONE = { seoul: "Asia/Seoul", tokyo: "Asia/Tokyo" };

const fmt = {};
function parts(zone, ms) {
  const f = fmt[zone] || (fmt[zone] = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  }));
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour % 24, minute: +p.minute };
}

/** その瞬間に効いている UTC からの分。 */
function intlOffset(zone, ms) {
  const w = parts(zone, ms);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.hour, w.minute) - ms) / 60000);
}

/** 現地の壁時計 → UTC ミリ秒。saju.js の localToUtc と同じことを Intl で。 */
function wallToUtc(zone, y, m, d, hour, minute) {
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  let ms = naive - 540 * 60000;
  for (let i = 0; i < 4; i++) {
    const next = naive - intlOffset(zone, ms) * 60000;
    if (next === ms) break;
    ms = next;
  }
  return ms;
}

const isoMin = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";

/* ---- 1. 節気の時刻 -------------------------------------------------- */

const EPOCH_MS = Date.UTC(1900, 0, 1);

/** solar-terms.json の中身を {年 → {黄経 → UTC ミリ秒}} に開く。 */
function ourTerms() {
  const t = Saju._table(), by = new Map();
  for (let i = 0; i < t.min.length; i++) {
    const ms = EPOCH_MS + t.min[i] * 60000;
    const y = new Date(ms).getUTCFullYear();
    if (!by.has(y)) by.set(y, new Map());
    by.get(y).set(((t.j0 + i) % 24) * 15, ms);
  }
  return by;
}

head("[節気]  黄経 15 度ごとの時刻を国立天文台の公表値と（許容 ±2 分）");

check("2009〜2027 の 24 節気", () => {
  const mine = ourTerms();
  let n = 0, worst = 0, worstAt = "";
  for (const [year, list] of Object.entries(ref.terms)) {
    const m = mine.get(+year);
    assert(m, `${year} 年が表にありません`);
    assert(list.length === 24, `${year} 年の基準が ${list.length} 件`);
    for (const t of list) {
      const ms = m.get(t.lon);
      assert(ms !== undefined, `${year} 年 黄経 ${t.lon}° が表にありません`);
      const diff = Math.abs(ms - Date.parse(t.utc + ":00Z")) / 60000;
      n++;
      if (diff > worst) { worst = diff; worstAt = `${t.utc}Z 黄経${t.lon}°`; }
      assert(diff <= 2,
        `黄経 ${t.lon}° ${year}: 自前 ${isoMin(ms)} / 公表 ${t.utc}Z  差 ${diff} 分`);
    }
  }
  return `${n} 件一致  最大差 ${worst} 分（${worstAt}）`;
});

check("表の範囲が 1930〜2030 の生年を覆う", () => {
  for (const [y, m, d] of [[1930, 1, 1], [2030, 12, 31]]) {
    const r = Saju.pillars({ y, m, d, hour: 12, city: "seoul" });
    assert(r.day.hanja, `${y}-${m}-${d} が出せません`);
  }
  for (const y of [1928, 2032]) {
    let threw = null;
    try { Saju.pillars({ y, m: 6, d: 1, hour: 12, city: "seoul" }); }
    catch (e) { threw = e; }
    assert(threw instanceof RangeError,
      `${y} 年は RangeError になるはずが ${threw ? threw.constructor.name : "素通り"}`);
  }
  return "1930-01-01 / 2030-12-31 可、範囲外は RangeError";
});

/* ---- 2. 日柱 -------------------------------------------------------- */

head("[日柱]  60 日周期の基準日を公表の日の干支と");

check("連続 60 日 × 9 区間", () => {
  let n = 0;
  for (const [start, w] of Object.entries(ref.ganji)) {
    for (const e of w.list) {
      const [y, m, d] = e.date.split("-").map(Number);
      // 正午なら真太陽時でも同じ日付に収まる。23 時台の送りは別項で見る。
      const r = Saju.pillars({ y, m, d, hour: 12, city: "seoul" });
      assert(r.day.hanja === e.ganji,
        `${e.date}: 自前 ${r.day.hanja} / 公表 ${e.ganji}  （${w.why}）`);
      n++;
    }
  }
  return `${n} 日一致`;
});

check("甲子日は 1984-01-31（02-02 とする通説は誤り）", () => {
  // 「1984-02-02 が甲子日」という説がよく出てくるが、公表値では 02-02 は
  // 丙寅で、甲子は 01-31。1984 年が甲子「年」であること（立春の 02-04 から）
  // と取り違えたものと思われる。同じ勘違いで基準日を 2 日ずらさないよう、
  // 誤っている側も名指しで固定しておく。
  const at = (m, d) => Saju.pillars({ y: 1984, m, d, hour: 12, city: "seoul" }).day.hanja;
  assert(at(1, 31) === "甲子", `01-31 は 甲子 のはずが ${at(1, 31)}`);
  assert(at(2, 2) === "丙寅", `02-02 は 丙寅 のはずが ${at(2, 2)}`);
  // 甲子「年」の入りも 02-04 と書かれがちだが、1984 年の立春は UTC で
  // 02-04 15:19、韓国時間では 02-05 00:19。02-04 中はまだ癸亥年。
  const yr = (d, hour) =>
    Saju.pillars({ y: 1984, m: 2, d, hour, city: "seoul" }).year.hanja;
  assert(yr(4, 23) === "癸亥", `02-04 23 時はまだ癸亥のはずが ${yr(4, 23)}`);
  assert(yr(5, 1) === "甲子", `02-05 01 時は甲子のはずが ${yr(5, 1)}`);
  return "01-31 甲子日 / 02-02 丙寅日 / 甲子年は 02-05 00:19 KST から";
});

check("日柱は出生地で変わらない（正午の場合）", () => {
  const w = ref.ganji["2026-08-01"];
  for (const e of w.list) {
    const [y, m, d] = e.date.split("-").map(Number);
    for (const city of ["seoul", "busan", "tokyo", "naha"]) {
      const r = Saju.pillars({ y, m, d, hour: 12, city });
      assert(r.day.hanja === e.ganji, `${e.date} ${city}: ${r.day.hanja} ≠ ${e.ganji}`);
    }
  }
  return `${w.days} 日 × 4 都市`;
});

/* ---- 3. 月柱・年柱の切り替わり -------------------------------------- */

head("[月柱]  節（黄経が 15 の奇数倍）の前後 10 分で月柱が 1 つ進む");

/** 公表の節気時刻の前後に置いた 2 点。壁時計への変換も Intl 側で行う。 */
function around(ms, city, gapMin) {
  const zone = ZONE[city === "tokyo" ? "tokyo" : "seoul"];
  return [-gapMin, +gapMin].map((k) =>
    Saju.pillars({ ...parts(zone, ms + k * 60000), city }));
}

check("2009〜2027 の 12 節 × 19 年", () => {
  let n = 0;
  for (const [year, list] of Object.entries(ref.terms)) {
    for (const t of list) {
      if ((t.lon / 15) % 2 === 0) continue;            // 中気では切らない
      const ms = Date.parse(t.utc + ":00Z");
      const [a, b] = around(ms, "seoul", 10);
      assert((a.month.branchIdx + 1) % 12 === b.month.branchIdx,
        `${year} 黄経${t.lon}° ${t.utc}Z: 月支 ${a.month.branch} → ${b.month.branch}`);
      assert(a.month.hanja !== b.month.hanja, `${t.utc}Z: 月柱が動いていません`);
      n++;
    }
  }
  return `${n} 箇所で 1 つ進む`;
});

check("中気（黄経が 15 の偶数倍）では月柱が動かない", () => {
  let n = 0;
  for (const list of Object.values(ref.terms)) {
    for (const t of list) {
      if ((t.lon / 15) % 2 !== 0) continue;
      const ms = Date.parse(t.utc + ":00Z");
      const [a, b] = around(ms, "seoul", 10);
      assert(a.month.hanja === b.month.hanja,
        `黄経${t.lon}° ${t.utc}Z: 月柱が ${a.month.hanja} → ${b.month.hanja} と動きました`);
      n++;
    }
  }
  return `${n} 箇所で不動`;
});

head("[年柱]  立春（黄経 315°）だけで年が切り替わる");

check("立春の前後で年柱が 1 つ進む", () => {
  let n = 0;
  for (const [year, list] of Object.entries(ref.terms)) {
    const t = list.find((x) => x.lon === 315);
    assert(t, `${year} 年に立春がありません`);
    const [a, b] = around(Date.parse(t.utc + ":00Z"), "seoul", 10);
    assert(b.sajuYear === a.sajuYear + 1,
      `${year}: 사주년 ${a.sajuYear} → ${b.sajuYear}`);
    assert((a.year.branchIdx + 1) % 12 === b.year.branchIdx,
      `${year}: 年支 ${a.year.branch} → ${b.year.branch}`);
    assert(b.month.branchIdx === 2, `${year}: 立春の直後は寅月のはずが ${b.month.branch}`);
    n++;
  }
  return `${n} 年ぶん`;
});

check("元日・旧正月では年柱が動かない", () => {
  // 立春より前に生まれた 1 月生まれは前年の干支になる。
  for (const y of [2000, 2010, 2024]) {
    const dec = Saju.pillars({ y: y - 1, m: 12, d: 31, hour: 12, city: "seoul" });
    const jan = Saju.pillars({ y, m: 1, d: 1, hour: 12, city: "seoul" });
    assert(dec.year.hanja === jan.year.hanja,
      `${y} 元日で年柱が ${dec.year.hanja} → ${jan.year.hanja} と動きました`);
    assert(jan.sajuYear === y - 1, `${y}-01-01 の사주년が ${jan.sajuYear}`);
  }
  return "2000 / 2010 / 2024";
});

/* ---- 4. 標準時とサマータイム ---------------------------------------- */

head("[標準時]  焼き込んだ表を Intl の tz データと");

check("1930〜2030 を 6 時間ごと（ソウル・東京）", () => {
  let n = 0;
  for (const [id, zone] of Object.entries(ZONE)) {
    for (let ms = Date.UTC(1930, 0, 1); ms < Date.UTC(2031, 0, 1); ms += 6 * 3600000) {
      const a = Saju.offsetAt(id, ms), b = intlOffset(zone, ms);
      assert(a === b, `${id} ${isoMin(ms)}: 表 ${a} 分 / Intl ${b} 分`);
      n++;
    }
  }
  return `${n} 点一致`;
});

check("サマータイム・UTC+8:30 の境界日で UTC が合う", () => {
  // 韓国のサマータイム施行年と、標準時が動いた 1954・1961 年。
  const days = [
    "1948-05-31", "1948-06-01", "1948-09-12", "1949-04-03", "1950-04-01",
    "1951-05-06", "1954-03-20", "1954-03-21", "1955-05-05", "1956-05-20",
    "1957-05-05", "1958-05-04", "1959-05-03", "1960-05-01", "1961-08-09",
    "1961-08-10", "1987-05-10", "1987-10-11", "1988-05-08", "1988-10-09",
  ];
  let n = 0;
  for (const day of days) {
    const [y, m, d] = day.split("-").map(Number);
    for (const hour of [0, 1, 2, 12, 23]) {
      const r = Saju.pillars({ y, m, d, hour, minute: 30, city: "seoul" });
      const want = wallToUtc("Asia/Seoul", y, m, d, hour, 30);
      assert(r.solar.utc === isoMin(want),
        `${day} ${hour}:30 KST: saju ${r.solar.utc} / Intl ${isoMin(want)}`);
      n++;
    }
  }
  return `${days.length} 日 × 5 時刻 = ${n} 件`;
});

check("サマータイム中は同じ壁時計でも真太陽時が 1 時間早い", () => {
  // 1988-05-08 は施行中、1988-11-08 は施行外。時支がずれるのはこの 1 時間。
  const on = Saju.pillars({ y: 1988, m: 5, d: 8, hour: 12, city: "seoul" });
  const off = Saju.pillars({ y: 1988, m: 12, d: 8, hour: 12, city: "seoul" });
  assert(on.solar.offsetMin === 600, `施行中の標準時が ${on.solar.offsetMin} 分`);
  assert(off.solar.offsetMin === 540, `施行外の標準時が ${off.solar.offsetMin} 分`);
  const hOn = +on.solar.trueSolar.slice(11, 13), hOff = +off.solar.trueSolar.slice(11, 13);
  assert(hOn === 10 && hOff === 11,
    `真太陽時が ${on.solar.trueSolar} / ${off.solar.trueSolar}`);
  assert(on.hour.branch === "사" && off.hour.branch === "오",
    `時支が ${on.hour.branch} / ${off.hour.branch}`);
  return "12:00 KST → 施行中 10 時台(사) / 施行外 11 時台(오)";
});

/* ---- 5. 真太陽時 ---------------------------------------------------- */

head("[真太陽時]  均時差と経度補正");

check("均時差を公表値と（許容 0.1 分）", () => {
  let n = 0, worst = 0, worstAt = "";
  for (const [year, list] of Object.entries(ref.eot)) {
    for (const p of list) {
      const mine = Saju.equationOfTime(Date.parse(p.utc + ":00Z"));
      const diff = Math.abs(mine - p.min);
      n++;
      if (diff > worst) {
        worst = diff;
        worstAt = `${p.utc}Z 自前 ${mine.toFixed(2)} / 公表 ${p.min.toFixed(2)}`;
      }
      assert(diff <= 0.1,
        `${year} ${p.utc}Z: 自前 ${mine.toFixed(3)} 分 / 公表 ${p.min.toFixed(3)} 分`);
      // 符号を取り違えても大きさは合ってしまうので、向きを名指しで見る。
      assert(mine === 0 || Math.sign(mine) === Math.sign(p.min),
        `${p.utc}Z: 符号が逆（視太陽時 − 平均太陽時 のはず）`);
    }
  }
  return `${n} 点一致  最大差 ${worst.toFixed(3)} 分（${worstAt}）`;
});

check("均時差の向き（2 月は遅れ、11 月は進み）", () => {
  const feb = Saju.equationOfTime(Date.UTC(2024, 1, 11, 12));
  const nov = Saju.equationOfTime(Date.UTC(2024, 10, 3, 12));
  assert(feb < -13 && feb > -15, `2 月中旬が ${feb.toFixed(2)} 分（−14 分前後のはず）`);
  assert(nov > 15 && nov < 17, `11 月初旬が ${nov.toFixed(2)} 分（+16 分前後のはず）`);
  return `2/11 ${feb.toFixed(1)} 分 / 11/3 +${nov.toFixed(1)} 分`;
});

check("経度補正の符号と大きさ（都市ごと）", () => {
  // 標準子午線 135°E との差。ソウルは遅れ、東京は進む。
  const want = { seoul: -32, busan: -24, tokyo: 19, naha: -29 };
  const got = [];
  for (const [city, expect] of Object.entries(want)) {
    const r = Saju.pillars({ y: 2024, m: 6, d: 1, hour: 12, city });
    assert(Math.sign(r.solar.lonMin) === Math.sign(expect),
      `${city}: 符号が逆（${r.solar.lonMin} 分、想定 ${expect} 分）`);
    assert(Math.abs(r.solar.lonMin - expect) <= 1,
      `${city}: ${r.solar.lonMin} 分（想定 ${expect} 分）`);
    got.push(`${city} ${r.solar.lonMin > 0 ? "+" : ""}${r.solar.lonMin}`);
  }
  return got.join(" / ");
});

check("真太陽時 = UTC + 経度 + 均時差", () => {
  for (const city of ["seoul", "tokyo", "naha"]) {
    for (const [y, m, d] of [[1990, 2, 11], [2024, 6, 1], [2024, 11, 3]]) {
      const r = Saju.pillars({ y, m, d, hour: 8, minute: 15, city });
      const utc = Date.parse(r.solar.utc);
      const lon = Saju.CITIES.find((c) => c.id === city).lon;
      const want = utc + (lon * 4 + Saju.equationOfTime(utc)) * 60000;
      const diff = Math.abs(Date.parse(r.solar.trueSolar + "Z") - want) / 60000;
      assert(diff < 1, `${city} ${y}-${m}-${d}: ${r.solar.trueSolar} が ${diff} 分ずれ`);
    }
  }
  return "3 都市 × 3 日";
});

/* ---- 6. 日柱の境界（早子時）----------------------------------------- */

head("[日柱境界]  真太陽時 23 時で翌日に送る");

check("22:00〜01:59 を 1 分ずつ（4 都市 × 3 日）", () => {
  let n = 0, moves = 0;
  for (const city of ["seoul", "tokyo", "naha", "busan"]) {
    for (const [y, m, d] of [[1984, 1, 20], [2026, 8, 15], [2024, 11, 3]]) {
      for (let t = 22 * 60; t < 26 * 60; t++) {
        const r = Saju.pillars({
          y, m, d: d + (t >= 1440 ? 1 : 0),
          hour: Math.floor(t / 60) % 24, minute: t % 60, city,
        });
        // 真太陽時の日付を出し、23 時以降なら翌日に送ったものと突き合わせる。
        const sh = +r.solar.trueSolar.slice(11, 13);
        const sd = new Date(Date.parse(r.solar.trueSolar.slice(0, 10) + "T00:00Z")
                            + (sh >= 23 ? 86400000 : 0));
        const base = Saju.pillars({
          y: sd.getUTCFullYear(), m: sd.getUTCMonth() + 1, d: sd.getUTCDate(),
          hour: 12, city,
        });
        assert(r.day.hanja === base.day.hanja,
          `${city} ${y}-${m}-${d} ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}: `
          + `真太陽時 ${r.solar.trueSolar} で日柱 ${r.day.hanja}（${base.day.hanja} のはず）`);
        if (sh >= 23) {
          assert(r.notes.some((s) => s.includes("23 時")), "送ったのに notes に出ていません");
          moves++;
        }
        if (sh >= 23 || sh < 1)      // 子時は真太陽時 23:00〜01:00
          assert(r.hour.branch === "자",
            `真太陽時 ${r.solar.trueSolar} の時支が ${r.hour.branch}（자 のはず）`);
        n++;
      }
    }
  }
  return `${n} 分ぶん一致（うち翌日送り ${moves} 件）`;
});

check("送りは 60 干支で 1 つだけ進む", () => {
  const before = Saju.pillars({ y: 2026, m: 8, d: 15, hour: 22, minute: 0, city: "seoul" });
  const after = Saju.pillars({ y: 2026, m: 8, d: 16, hour: 0, minute: 30, city: "seoul" });
  const step = (a, b) =>
    (b.stemIdx - a.stemIdx + 10) % 10 === 1 && (b.branchIdx - a.branchIdx + 12) % 12 === 1;
  assert(step(before.day, after.day),
    `${before.day.hanja} → ${after.day.hanja} が 1 つ進んでいません`);
  return `${before.day.hanja} → ${after.day.hanja}`;
});

/* ---- 7. 時刻不明 ---------------------------------------------------- */

head("[時刻不明]  3 柱で返す");

check("hour が null なら時柱を落とし、その旨を返す", () => {
  const r = Saju.pillars({ y: 1990, m: 5, d: 17, hour: null, city: "seoul" });
  assert(r.hour === null, "時柱が入っています");
  assert(r.notes.some((s) => s.includes("時柱を除いた")), `notes が ${JSON.stringify(r.notes)}`);
  const sum = Object.values(r.elements).reduce((a, b) => a + b, 0);
  assert(sum === 6, `五行の合計が ${sum}（3 柱なので 6 のはず）`);
  const known = Saju.pillars({ y: 1990, m: 5, d: 17, hour: 12, city: "seoul" });
  for (const k of ["year", "month", "day"]) {
    assert(r[k].hanja === known[k].hanja,
      `${k} が時刻の有無で ${r[k].hanja} / ${known[k].hanja} と割れます`);
  }
  return "年月日柱は時刻の有無で変わらない";
});

check("時柱ありなら五行は 8 個", () => {
  const r = Saju.pillars({ y: 1990, m: 5, d: 17, hour: 14, minute: 30, city: "seoul" });
  const sum = Object.values(r.elements).reduce((a, b) => a + b, 0);
  assert(sum === 8, `五行の合計が ${sum}`);
  return `${r.year.hanja} ${r.month.hanja} ${r.day.hanja} ${r.hour.hanja}`;
});

/* ---- まとめ --------------------------------------------------------- */

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : "")
  + `　（基準: ${ref.source} ${ref.fetched} 取得）`);
process.exit(failed ? 1 : 0);
