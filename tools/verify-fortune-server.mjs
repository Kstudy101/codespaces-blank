/* ==================================================================
   verify-fortune-server.mjs — サーバーの運勢が、サイトと同じであること

   利用者は同じ日に、サイトでも LINE でも運勢を見る。片方が大吉で
   片方が小吉なら、そこで信用が終わる。しかも食い違いは静かに起きる
   ── どちらも「それらしい数字」を出すので、並べて見るまで分からない。

   食い違いの起こし方は 2 つしかない。

     1  server/ の中に saju.js / fortune.js の写しを置く
     2  今日の柱を出すとき、出生地ではなく固定の都市を使う

   1 は「直したつもりが片方だけ」になる。2 は東京生まれの人だけ
   ずれる、という一番読みにくい形で出る。両方をここで見る。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fortuneFor, engineDir, categories } from "../server/lib/fortune.mjs";

let pass = 0;
const fails = [];
function check(label, fn) {
  try {
    const note = fn();
    pass++;
    console.log(`  ✓ ${label}${note ? `　（${note}）` : ""}`);
  } catch (e) {
    fails.push(`${label} — ${e.message}`);
    console.log(`  ✗ ${label} — ${e.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m || "満たしていません"); };

const ME = { birth_date: "1995-04-12", birth_time: "09:00:00",
             raw_result_json: { city: "tokyo", zodiac: "돼지" } };

console.log("[出どころ]  写しを持たない");

check("server/ に saju.js / fortune.js の写しが無い", () => {
  /* 置いた瞬間、直したつもりが片方だけになる。 */
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "engine") continue;  /* engine は配置が写す */
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^(saju|fortune)\.js$/.test(e.name)) found.push(p);
    }
  })("server");
  assert(!found.length,
    `写しがあります: ${found.join(", ")}\n      サイトと別々に直せる状態です`);
  return "リポジトリに 1 部だけ";
});

check("エンジンを見つけて読み込める", () => {
  const d = engineDir();
  for (const f of ["saju.js", "fortune.js", "solar-terms.json"]) {
    assert(fs.existsSync(path.join(d, f)), `${f} がありません`);
  }
  return path.basename(d) || d;
});

console.log("\n[計算]  サイトと同じ引数で呼ぶ");

check("6 項目そろって出る", () => {
  const f = fortuneFor(ME, "2026-08-04");
  assert(f, "出ませんでした");
  const ids = categories().map((c) => c.id);
  for (const id of ids) {
    assert(Number.isFinite(f.scores[id]), `${id} の点が数値でありません`);
    assert(f.grades[id] && f.grades[id].ko, `${id} の等級がありません`);
  }
  return ids.join(" / ");
});

check("点は 0〜100 に収まる", () => {
  /* はみ出すと等級表の外に落ち、grades が undefined になる。 */
  let n = 0;
  for (let d = 1; d <= 28; d++) {
    const f = fortuneFor(ME, `2026-02-${String(d).padStart(2, "0")}`);
    for (const c of categories()) {
      const s = f.scores[c.id];
      assert(s >= 0 && s <= 100, `${c.id} が ${s}`);
      n++;
    }
  }
  return `${n} 通り`;
});

check("十神が出る（点の根拠がここ）", () => {
  const f = fortuneFor(ME, "2026-08-04");
  const TEN = ["비견","겁재","식신","상관","편재","정재","편관","정관","편인","정인"];
  assert(TEN.includes(f.god.stem), `stem: ${f.god.stem}`);
  assert(TEN.includes(f.god.branch), `branch: ${f.god.branch}`);
  return `${f.god.stem} / ${f.god.branch}`;
});

console.log("\n[取り違えやすい所]");

check("今日の柱は「出生地」で出す（固定の都市ではない）", () => {
  /* ソウル固定にすると、東京生まれの人だけ結果がずれる。
     ずれても数字は出るので、画面を見ていても気づけない。
     都市を変えたときに結果が動くことで、使っていることを確かめる。 */
  const days = ["2026-01-15", "2026-03-20", "2026-08-04", "2026-11-09"];
  const diff = days.filter((d) => {
    const a = fortuneFor(ME, d);
    const b = fortuneFor({ ...ME, raw_result_json: { ...ME.raw_result_json, city: "seoul" } }, d);
    return JSON.stringify(a.scores) !== JSON.stringify(b.scores);
  });
  assert(diff.length, "東京とソウルで結果が 1 日も変わりません。出生地を使っていません");
  return `${diff.length}/${days.length} 日で差が出る`;
});

check("日が変われば結果も変わる（日付を無視していない）", () => {
  const a = fortuneFor(ME, "2026-08-04");
  const b = fortuneFor(ME, "2026-08-05");
  assert(JSON.stringify(a.scores) !== JSON.stringify(b.scores),
    "翌日と同じ結果です。日付を使っていません");
  return "8/4 ≠ 8/5";
});

check("同じ人・同じ日なら、何度呼んでも同じ", () => {
  /* 朝の便と、あとで見返したときで違っては困る。 */
  const a = JSON.stringify(fortuneFor(ME, "2026-08-04").scores);
  for (let i = 0; i < 5; i++) {
    assert(JSON.stringify(fortuneFor(ME, "2026-08-04").scores) === a, "呼ぶたびに変わります");
  }
  return "5 回とも同じ";
});

check("生まれた時刻が分からない人にも出る", () => {
  const f = fortuneFor({ ...ME, birth_time: null }, "2026-08-04");
  assert(f && Number.isFinite(f.scores.total), "出ませんでした");
  return "hour = null";
});

check("四柱が無い人には出さない（既定の運勢を作らない）", () => {
  /* 作ってしまうと、全員が同じ運勢を受け取る。 */
  assert(fortuneFor({}, "2026-08-04") === null, "出してしまいました");
  assert(fortuneFor({ birth_date: null }, "2026-08-04") === null, "出してしまいました");
  return "null";
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
